import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv, Bindings } from '../app-types';
import { generateToken, hashPassword, sha256Text, timingSafeTextEqual, toBase64Url, verifyPassword } from '../lib/crypto';

type ShareRouteDependencies = {
  serveTelegramImage(env: Bindings, fileId: string, cacheControl: string): Promise<Response>;
};

export function registerShareRoutes(app: Hono<AppEnv>, dependencies: ShareRouteDependencies): void {
  const serveTelegramImage = dependencies.serveTelegramImage;
  async function shareAccessSignature(secret: string, token: string, expires: number, nonce = ''): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const payload=nonce?`${token}.${expires}.${nonce}`:`${token}.${expires}`;
    return toBase64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  }

  async function readShareAccessCookie(secret: string, token: string, cookie: string | undefined): Promise<{nonce:string}|null> {
    if (!cookie) return null;
    const parts=cookie.split('.');
    const [cookieToken,expiresText]=parts;
    const nonce=parts.length===4?parts[2]:'';
    const signature=parts.length===4?parts[3]:parts[2];
    const expires = Number(expiresText);
    if (cookieToken !== token || !Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000) || !signature) return null;
    return await timingSafeTextEqual(signature,await shareAccessSignature(secret,token,expires,nonce))?{nonce}:null;
  }

  // ===================== 图片上传 API（R2 + Telegram） =====================


  // ===================== 图片 / 文件夹 / 脑图统一分享 =====================

  type ShareTargetType='image'|'folder'|'mindmap';
  type ShareRecord={id:number;token:string;target_type:ShareTargetType;target_id:number;title:string;password_hash:string|null;password_salt:string|null;expires_at:string|null;burn_after_read:number;burned_at:string|null;burn_access_hash:string|null;access_count:number;last_accessed_at:string|null;revoked_at:string|null;created_at:string};

  async function shareTargetTitle(db:D1Database,type:ShareTargetType,id:number):Promise<string|null>{
    if(type==='image'){
      const row=await db.prepare("SELECT COALESCE(NULLIF(display_name,''),NULLIF(filename,''),'未命名图片') AS title FROM images WHERE id=?").bind(id).first<{title:string}>();
      return row?.title||null;
    }
    if(type==='folder')return (await db.prepare('SELECT name AS title FROM image_folders WHERE id=?').bind(id).first<{title:string}>())?.title||null;
    return (await db.prepare('SELECT name AS title FROM trading_systems WHERE id=? AND is_template=0').bind(id).first<{title:string}>())?.title||null;
  }

  function normalizeShareExpiry(raw:string|null|undefined):string|null{
    if(!raw)return null;
    const date=new Date(raw);
    if(!Number.isFinite(date.getTime())||date.getTime()<=Date.now()+30_000)throw new Error('到期时间必须晚于当前时间');
    return date.toISOString().replace('T',' ').slice(0,19);
  }

  app.get('/api/shares',async(c)=>{
    const type=c.req.query('target_type') as ShareTargetType|undefined,id=Number(c.req.query('target_id'));
    if(!type||!['image','folder','mindmap'].includes(type)||!Number.isInteger(id)||id<=0)return c.json({error:'分享目标无效'},400);
    const rows=await c.env.DB.prepare(`SELECT id,token,target_type,target_id,title,expires_at,burn_after_read,burned_at,access_count,last_accessed_at,revoked_at,created_at,
      CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password
      FROM share_links WHERE target_type=? AND target_id=? ORDER BY created_at DESC LIMIT 50`).bind(type,id).all<any>();
    const origin=new URL(c.req.url).origin,now=Date.now();
    return c.json(rows.results.map(row=>({...row,url:`${origin}/share/${row.token}`,status:row.revoked_at?'revoked':row.burned_at?'burned':row.expires_at&&Date.parse(`${String(row.expires_at).replace(' ','T')}Z`)<=now?'expired':'active'})));
  });

  app.post('/api/shares',async(c)=>{
    const parsed=z.object({
      target_type:z.enum(['image','folder','mindmap']),target_id:z.number().int().positive(),
      title:z.string().trim().max(120).optional(),password:z.string().max(128).optional(),expires_at:z.string().nullable().optional(),
      burn_after_read:z.boolean().optional().default(false)
    }).safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:'分享参数无效'},400);
    const targetTitle=await shareTargetTitle(c.env.DB,parsed.data.target_type,parsed.data.target_id);
    if(!targetTitle)return c.json({error:'分享目标不存在'},404);
    let expiresAt:string|null;
    try{expiresAt=normalizeShareExpiry(parsed.data.expires_at);}catch(error){return c.json({error:error instanceof Error?error.message:'到期时间无效'},400);}
    const password=String(parsed.data.password||'');
    if(password&&password.length<8)return c.json({error:'分享密码至少 8 位'},400);
    const salt=password?generateToken(16):null,hash=password&&salt?await hashPassword(password,salt):null;
    const token=generateToken(24),title=parsed.data.title||targetTitle;
    const result=await c.env.DB.prepare(`INSERT INTO share_links(token,target_type,target_id,title,password_hash,password_salt,expires_at,burn_after_read)
      VALUES(?,?,?,?,?,?,?,?)`).bind(token,parsed.data.target_type,parsed.data.target_id,title,hash,salt,expiresAt,parsed.data.burn_after_read?1:0).run();
    return c.json({success:true,id:result.meta.last_row_id,token,url:`${new URL(c.req.url).origin}/share/${token}`,title,expires_at:expiresAt,has_password:Boolean(hash),burn_after_read:parsed.data.burn_after_read},201);
  });

  app.post('/api/shares/:id/revoke',async(c)=>{
    const id=Number(c.req.param('id'));
    if(!Number.isInteger(id)||id<=0)return c.json({error:'无效的分享 ID'},400);
    const result=await c.env.DB.prepare("UPDATE share_links SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").bind(id).run();
    if(!result.meta.changes)return c.json({error:'分享不存在或已取消'},404);
    return c.json({success:true});
  });

  app.delete('/api/shares/:id',async(c)=>{
    const id=Number(c.req.param('id'));
    if(!Number.isInteger(id)||id<=0)return c.json({error:'无效的分享 ID'},400);
    const result=await c.env.DB.prepare('DELETE FROM share_links WHERE id=?').bind(id).run();
    if(!result.meta.changes)return c.json({error:'分享链接不存在'},404);
    return c.json({success:true});
  });

  function shareExpired(record:ShareRecord):boolean{
    return Boolean(record.expires_at&&Date.parse(`${record.expires_at.replace(' ','T')}Z`)<=Date.now());
  }

  async function getUsableShare(db:D1Database,token:string):Promise<ShareRecord|null>{
    if(!/^[a-f0-9]{48}$/i.test(token))return null;
    return db.prepare('SELECT * FROM share_links WHERE token=?').bind(token).first<ShareRecord>();
  }

  function shareAccessCookieName(token:string):string{
    return `share_access_${token.slice(0,16)}`;
  }

  async function getShareViewerAccess(c:any,record:ShareRecord):Promise<{nonce:string}|null>{
    const cookie=getCookie(c,shareAccessCookieName(record.token))||getCookie(c,'share_access');
    const access=await readShareAccessCookie(c.env.CONFIG_ENCRYPTION_KEY,record.token,cookie);
    if(!access)return null;
    if(record.burned_at){
      if(!record.burn_access_hash||!access.nonce)return null;
      if(!await timingSafeTextEqual(record.burn_access_hash,await sha256Text(access.nonce)))return null;
    }
    return access;
  }

  async function shareUnlocked(c:any,record:ShareRecord):Promise<boolean>{
    return !record.password_hash||Boolean(await getShareViewerAccess(c,record));
  }

  async function setShareAccessCookie(c:any,record:ShareRecord,maxAgeMs=12*3600_000,nonce=generateToken(16)):Promise<string>{
    const shareExpiry=record.expires_at?Date.parse(`${record.expires_at.replace(' ','T')}Z`):Number.POSITIVE_INFINITY;
    const expires=Math.floor(Math.min(Date.now()+maxAgeMs,shareExpiry)/1000);
    const signature=await shareAccessSignature(c.env.CONFIG_ENCRYPTION_KEY,record.token,expires,nonce);
    const cookie=`${record.token}.${expires}.${nonce}.${signature}`;
    const seconds=Math.max(60,expires-Math.floor(Date.now()/1000));
    setCookie(c,shareAccessCookieName(record.token),cookie,{httpOnly:true,secure:new URL(c.req.url).protocol==='https:',sameSite:'Lax',path:'/',maxAge:seconds});
    return nonce;
  }

  function sharedImageJson(token:string,row:any){
    return {id:row.id,name:row.display_name||row.filename||'未命名图片',caption:row.caption||'',category:row.category||'',tags:row.tags||'',resource_url:row.resource_url||null,size:Number(row.size||0),mime_type:row.mime_type||'',created_at:row.created_at,url:`/api/public/shares/${token}/images/${row.id}`};
  }

  app.get('/api/public/shares/:token',async(c)=>{
    const record=await getUsableShare(c.env.DB,c.req.param('token'));
    if(!record)return c.json({error:'分享不存在'},404);
    if(record.revoked_at)return c.json({error:'分享已取消'},410);
    if(shareExpired(record))return c.json({error:'分享已过期'},410);
    const viewerAccess=await getShareViewerAccess(c,record);
    if(record.burned_at&&!viewerAccess)return c.json({error:'分享已阅后焚毁'},410);
    const base={title:record.title,target_type:record.target_type,expires_at:record.expires_at,has_password:Boolean(record.password_hash),burn_after_read:Boolean(record.burn_after_read)};
    if(record.password_hash&&!viewerAccess)return c.json({...base,locked:true},401);
    let content:unknown;
    if(record.target_type==='image'){
      const row=await c.env.DB.prepare('SELECT id,filename,display_name,mime_type,size,caption,category,tags,resource_url,created_at FROM images WHERE id=?').bind(record.target_id).first<any>();
      if(!row)return c.json({error:'分享的图片已不存在'},404);
      content={image:sharedImageJson(record.token,row)};
    }else if(record.target_type==='folder'){
      const folder=await c.env.DB.prepare('SELECT id,name,color FROM image_folders WHERE id=?').bind(record.target_id).first<any>();
      if(!folder)return c.json({error:'分享的文件夹已不存在'},404);
      const rows=await c.env.DB.prepare('SELECT id,filename,display_name,mime_type,size,caption,category,tags,resource_url,created_at FROM images WHERE folder_id=? ORDER BY created_at DESC').bind(record.target_id).all<any>();
      content={folder,images:rows.results.map(row=>sharedImageJson(record.token,row))};
    }else{
      const system=await c.env.DB.prepare(`SELECT id,name,category,description,resource_url,markets,timeframes,status,color,updated_at FROM trading_systems WHERE id=? AND is_template=0`).bind(record.target_id).first<any>();
      if(!system)return c.json({error:'分享的脑图已不存在'},404);
      const nodes=await c.env.DB.prepare(`SELECT n.id,n.parent_id,n.title,n.content,n.node_type,n.sort_order,n.is_collapsed,r.title AS rule_title,r.category AS rule_category
        FROM trading_system_nodes n LEFT JOIN trading_rules r ON r.id=n.rule_id WHERE n.system_id=? ORDER BY n.sort_order,n.id`).bind(record.target_id).all<any>();
      content={system,nodes:nodes.results};
    }
    if(record.burn_after_read&&!record.burned_at){
      const nonce=viewerAccess?.nonce||generateToken(16),accessHash=await sha256Text(nonce);
      const claim=await c.env.DB.prepare("UPDATE share_links SET burned_at=datetime('now'),burn_access_hash=?,access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=? AND burned_at IS NULL AND revoked_at IS NULL").bind(accessHash,record.id).run();
      if(!claim.meta.changes){
        const claimedRecord=await getUsableShare(c.env.DB,record.token);
        if(!claimedRecord||!await getShareViewerAccess(c,claimedRecord))return c.json({error:'分享已被其他访问者阅后焚毁'},410);
      }else await setShareAccessCookie(c,record,30*60_000,nonce);
    }else if(!record.burn_after_read){
      await c.env.DB.prepare("UPDATE share_links SET access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=?").bind(record.id).run();
    }
    return c.json({...base,locked:false,content});
  });

  app.post('/api/public/shares/:token/unlock',async(c)=>{
    const record=await getUsableShare(c.env.DB,c.req.param('token'));
    if(!record)return c.json({error:'分享不存在'},404);
    if(record.revoked_at||shareExpired(record))return c.json({error:record.revoked_at?'分享已取消':'分享已过期'},410);
    if(record.burned_at&&!await getShareViewerAccess(c,record))return c.json({error:'分享已阅后焚毁'},410);
    if(!record.password_hash||!record.password_salt)return c.json({success:true});
    const clientAddress=c.req.header('CF-Connecting-IP')||c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()||'unknown';
    const ipHash=await sha256Text(clientAddress);
    const [perClient,globalAttempts]=await c.env.DB.batch([
      c.env.DB.prepare("SELECT COUNT(*) AS count FROM share_unlock_attempts WHERE share_id=? AND ip_hash=? AND attempted_at>=datetime('now','-15 minutes')").bind(record.id,ipHash),
      c.env.DB.prepare("SELECT COUNT(*) AS count FROM share_unlock_attempts WHERE share_id=? AND attempted_at>=datetime('now','-15 minutes')").bind(record.id),
      c.env.DB.prepare("DELETE FROM share_unlock_attempts WHERE attempted_at < datetime('now','-1 day')")
    ]);
    const clientCount=Number((perClient.results?.[0] as any)?.count||0),globalCount=Number((globalAttempts.results?.[0] as any)?.count||0);
    if(clientCount>=8||globalCount>=60){
      return c.json({error:'尝试次数过多，请 15 分钟后再试'},429,{'Retry-After':'900'});
    }
    const body=await c.req.json<any>().catch(()=>null),password=String(body?.password||'');
    if(!await verifyPassword(password,record.password_salt,record.password_hash)){
      await c.env.DB.prepare('INSERT INTO share_unlock_attempts(share_id,ip_hash) VALUES(?,?)').bind(record.id,ipHash).run();
      return c.json({error:'分享密码错误'},403);
    }
    await c.env.DB.prepare('DELETE FROM share_unlock_attempts WHERE share_id=? AND ip_hash=?').bind(record.id,ipHash).run();
    await setShareAccessCookie(c,record,record.burn_after_read?30*60_000:12*3600_000);
    return c.json({success:true});
  });

  async function serveSharedImage(env:Bindings,image:any,cacheControl:string):Promise<Response>{
    let response:Response;
    if(image.storage==='r2'){
      const object=await env.BUCKET.get(image.key);
      if(!object)return Response.json({error:'图片已从存储中删除'},{status:404});
      const headers=new Headers();object.writeHttpMetadata(headers);headers.set('ETag',object.httpEtag);
      response=new Response(object.body,{headers});
    }else response=await serveTelegramImage(env,image.tg_file_id||image.key,cacheControl);
    if(!response.ok)return response;
    const headers=new Headers(response.headers),baseName=String(image.display_name||image.filename||'image');
    const ext=String(image.filename||'').match(/\.[a-z0-9]+$/i)?.[0]||(image.mime_type==='image/jpeg'?'.jpg':`.${String(image.mime_type||'image/png').split('/')[1]||'png'}`);
    const viewName=/\.[a-z0-9]+$/i.test(baseName)?baseName:`${baseName}${ext}`;
    headers.set('Content-Type',image.mime_type||headers.get('Content-Type')||'application/octet-stream');
    headers.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(viewName)}`);
    headers.set('Cache-Control',cacheControl);headers.set('X-Content-Type-Options','nosniff');
    return new Response(response.body,{status:response.status,headers});
  }

  app.get('/api/public/shares/:token/images/:imageId',async(c)=>{
    const record=await getUsableShare(c.env.DB,c.req.param('token'));
    if(!record||record.revoked_at||shareExpired(record))return c.json({error:'分享不存在或已失效'},410);
    if(record.burned_at&&!await getShareViewerAccess(c,record))return c.json({error:'分享已阅后焚毁'},410);
    if(!await shareUnlocked(c,record))return c.json({error:'请先输入分享密码'},401);
    const imageId=Number(c.req.param('imageId'));
    if(!Number.isInteger(imageId)||imageId<=0)return c.json({error:'无效的图片 ID'},400);
    const clause=record.target_type==='image'?'id=? AND id=?':record.target_type==='folder'?'id=? AND folder_id=?':'';
    if(!clause)return c.json({error:'该分享不包含图片'},404);
    const image=await c.env.DB.prepare(`SELECT * FROM images WHERE ${clause}`).bind(imageId,record.target_id).first<any>();
    if(!image)return c.json({error:'图片不在此分享中'},404);
    return serveSharedImage(c.env,image,record.password_hash||record.burn_after_read?'private, no-store':'public, max-age=3600');
  });


}
