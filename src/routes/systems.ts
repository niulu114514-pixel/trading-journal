import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import type { MindmapSnapshot } from '../domain/mindmap';
import { aiErrorMessage } from '../services/ai-protocol';
import { createAiJob, updateAiJob } from '../services/ai-jobs';
import {
  calculateMindmapQuality,
  cloneMindmap,
  isAvailableSystemNodeType,
  loadMindmapSnapshot,
  replaceMindmapFromSnapshot,
  resolveActiveMindmapCategory,
  saveMindmapVersion
} from '../services/mindmaps';

export function registerSystemRoutes(app: Hono<AppEnv>): void {
  // ===================== 交易系统 API（脑图） =====================

  const systemSchema = z.object({
    name: z.string().trim().min(1).max(100),
    category: z.string().trim().min(1).max(60).optional(),
    description: z.string().max(2000).nullable().optional(),
    original_prompt: z.string().max(12000).nullable().optional(),
    resource_url: z.union([z.literal(''), z.string().url().max(2048)]).nullable().optional(),
    markets: z.string().max(255).nullable().optional(),
    timeframes: z.string().max(255).nullable().optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    template: z.boolean().optional()
  });

  const systemNodeSchema = z.object({
    parent_id: z.number().int().positive().nullable().optional(),
    rule_id: z.number().int().positive().nullable().optional(),
    title: z.string().trim().min(1).max(120),
    content: z.string().max(2000).nullable().optional(),
    node_type: z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
    sort_order: z.number().int().min(-100000).max(100000).optional(),
    is_collapsed: z.boolean().optional()
  });

  function validationError(c: Context<AppEnv>, error: z.ZodError) {
    return c.json({
      error: '参数校验失败',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), msg: i.message }))
    }, 400);
  }

  app.get('/api/systems', async (c) => {
    const status = c.req.query('status');
    const category = (c.req.query('category') || '').trim();
    const query = (c.req.query('q') || '').trim();
    const minNodes = Math.max(0,parseInt(c.req.query('min_nodes') || '0'));
    const maxNodes = Math.max(0,parseInt(c.req.query('max_nodes') || '0'));
    const whereParts: string[] = [];
    const args: unknown[] = [];
    whereParts.push('s.is_template = 0');
    if (status && ['draft', 'active', 'archived'].includes(status)) { whereParts.push('s.status = ?'); args.push(status); }
    if (category) { whereParts.push('s.category = ?'); args.push(category); }
    if (query) { whereParts.push('(s.name LIKE ? OR s.description LIKE ? OR s.original_prompt LIKE ?)'); args.push(`%${query}%`,`%${query}%`,`%${query}%`); }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const havingParts:string[]=[];
    if(minNodes>0){havingParts.push('COUNT(DISTINCT n.id) >= ?');args.push(minNodes);}
    if(maxNodes>0){havingParts.push('COUNT(DISTINCT n.id) <= ?');args.push(maxNodes);}
    const having=havingParts.length?`HAVING ${havingParts.join(' AND ')}`:'';
    const result = await c.env.DB.prepare(
      `SELECT s.*,
         COUNT(DISTINCT n.id) AS node_count,
         COUNT(DISTINCT t.id) AS trade_count
       FROM trading_systems s
       LEFT JOIN trading_system_nodes n ON n.system_id = s.id
       LEFT JOIN trades t ON t.trading_system_id = s.id
       ${where}
       GROUP BY s.id
       ${having}
       ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                s.updated_at DESC, s.id DESC`
    ).bind(...args).all();
    return c.json(result.results);
  });

  // 脑图分类与脑图数量。脑图必须属于一个分类，因此不提供“未分类”入口。
  app.get('/api/systems/categories', async (c) => {
    const db = c.env.DB;
    const [categoryRows, totals] = await Promise.all([
      db.prepare(
        `SELECT s.id, s.category, s.label, s.value, s.color, s.sort_order, s.is_active,
          COUNT(CASE WHEN m.is_template = 0 THEN m.id END) AS mindmap_count,
          COUNT(CASE WHEN m.is_template = 1 THEN m.id END) AS template_count
         FROM settings s
         LEFT JOIN trading_systems m ON m.category = s.value
         WHERE s.category = 'mindmap_category'
         GROUP BY s.id, s.category, s.label, s.value, s.color, s.sort_order, s.is_active
         ORDER BY s.sort_order ASC, s.id ASC`
      ).all(),
      db.prepare('SELECT COUNT(*) AS total FROM trading_systems WHERE is_template = 0').first<{ total: number }>()
    ]);
    return c.json({ categories: categoryRows.results, total: totals?.total || 0 });
  });

  app.get('/api/systems/templates', async (c) => {
    const rows = await c.env.DB.prepare(`SELECT s.*,COUNT(n.id) AS node_count FROM trading_systems s LEFT JOIN trading_system_nodes n ON n.system_id=s.id WHERE s.is_template=1 GROUP BY s.id ORDER BY s.updated_at DESC,s.id DESC`).all();
    return c.json(rows.results);
  });

  app.get('/api/systems/:id', async (c) => {
    const id = c.req.param('id');
    const db = c.env.DB;
    const system = await db.prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM trades t WHERE t.trading_system_id = s.id) AS trade_count
       FROM trading_systems s WHERE s.id = ?`
    ).bind(id).first();
    if (!system) return c.json({ error: '交易系统不存在' }, 404);

    const nodes = await db.prepare(
      `SELECT n.*, r.title AS rule_title, r.category AS rule_category, r.is_active AS rule_is_active
       FROM trading_system_nodes n
       LEFT JOIN trading_rules r ON r.id = n.rule_id
       WHERE n.system_id = ?
       ORDER BY n.sort_order ASC, n.id ASC`
    ).bind(id).all();
    return c.json({ system, nodes: nodes.results, quality:calculateMindmapQuality(nodes.results as Record<string,any>[]) });
  });

  app.post('/api/systems', async (c) => {
    const parsed = systemSchema.safeParse(await c.req.json());
    if (!parsed.success) return validationError(c, parsed.error);
    const p = parsed.data;
    const db = c.env.DB;
    const category = await resolveActiveMindmapCategory(db, p.category);
    if (!category) return c.json({ error: '脑图分类不存在或已停用，请先创建或启用分类' }, 400);
    const created = await db.prepare(
      `INSERT INTO trading_systems (name, category, description, original_prompt, resource_url, markets, timeframes, status, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      p.name, category, p.description || null, p.original_prompt || p.description || p.name, p.resource_url || null, p.markets || null, p.timeframes || null,
      p.status || 'draft', p.color || '#3ec9c5'
    ).run();
    const systemId = Number(created.meta.last_row_id);
    const root = await db.prepare(
      `INSERT INTO trading_system_nodes (system_id, title, content, node_type, sort_order)
       VALUES (?, ?, ?, 'root', 0)`
    ).bind(systemId, p.name, p.description || '完整交易决策流程').run();
    const rootId = Number(root.meta.last_row_id);

    if (p.template !== false) {
      const branches = [
        ['市场环境', '先确认当前市场结构与允许交易的时段', 'setup'],
        ['入场确认', '所有入场条件满足后才执行', 'entry'],
        ['风险管理', '明确仓位、止损和单笔风险上限', 'risk'],
        ['出场计划', '入场前确定止盈、移动止损与失效条件', 'exit'],
        ['复盘清单', '记录执行偏差并更新系统', 'review']
      ];
      await db.batch(branches.map((branch, index) => db.prepare(
        `INSERT INTO trading_system_nodes (system_id, parent_id, title, content, node_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(systemId, rootId, branch[0], branch[1], branch[2], index)));
    }

    return c.json({ id: systemId, root_id: rootId, success: true }, 201);
  });

  app.put('/api/systems/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = systemSchema.partial().omit({ template: true }).safeParse(await c.req.json());
    if (!parsed.success) return validationError(c, parsed.error);
    if (parsed.data.category !== undefined) {
      const category = await resolveActiveMindmapCategory(c.env.DB, parsed.data.category);
      if (!category) return c.json({ error: '脑图分类不存在或已停用，请先创建或启用分类' }, 400);
      parsed.data.category = category;
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const field of ['name', 'category', 'description', 'original_prompt', 'resource_url', 'markets', 'timeframes', 'status', 'color'] as const) {
      if (parsed.data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(parsed.data[field]);
      }
    }
    if (!fields.length) return c.json({ error: '没有可更新字段' }, 400);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    const result = await c.env.DB.prepare(`UPDATE trading_systems SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    if (!result.meta.changes) return c.json({ error: '交易系统不存在' }, 404);
    if (parsed.data.name) {
      await c.env.DB.prepare(
        `UPDATE trading_system_nodes SET title = ?, updated_at = datetime('now')
         WHERE system_id = ? AND parent_id IS NULL`
      ).bind(parsed.data.name, id).run();
    }
    return c.json({ success: true });
  });

  app.delete('/api/systems/:id', async (c) => {
    const id = c.req.param('id');
    const db = c.env.DB;
    await db.prepare("UPDATE share_links SET revoked_at=datetime('now') WHERE target_type='mindmap' AND target_id=? AND revoked_at IS NULL").bind(id).run();
    await db.prepare('UPDATE trades SET trading_system_id = NULL WHERE trading_system_id = ?').bind(id).run();
    await db.prepare('DELETE FROM trading_system_nodes WHERE system_id = ?').bind(id).run();
    const result = await db.prepare('DELETE FROM trading_systems WHERE id = ?').bind(id).run();
    if (!result.meta.changes) return c.json({ error: '交易系统不存在' }, 404);
    return c.json({ success: true });
  });

  app.post('/api/systems/:id/duplicate', async (c) => {
    const id=Number(c.req.param('id'));
    const body=await c.req.json<any>().catch(()=>({}));
    try {
      const newId=await cloneMindmap(c.env.DB,id,{name:String(body?.name || '').trim() || undefined});
      return c.json({success:true,id:newId},201);
    } catch(error) { return c.json({error:error instanceof Error?error.message:'复制脑图失败'},400); }
  });

  app.post('/api/systems/:id/template', async (c) => {
    const id=Number(c.req.param('id'));
    const body=await c.req.json<any>().catch(()=>({}));
    try {
      const newId=await cloneMindmap(c.env.DB,id,{name:String(body?.name || '').trim() || undefined,isTemplate:true});
      return c.json({success:true,id:newId},201);
    } catch(error) { return c.json({error:error instanceof Error?error.message:'保存模板失败'},400); }
  });

  app.post('/api/systems/templates/:id/create', async (c) => {
    const templateId=Number(c.req.param('id'));
    const body=await c.req.json<any>().catch(()=>({}));
    const template=await c.env.DB.prepare('SELECT * FROM trading_systems WHERE id=? AND is_template=1').bind(templateId).first<Record<string,any>>();
    if(!template)return c.json({error:'脑图模板不存在'},404);
    const category=await resolveActiveMindmapCategory(c.env.DB,body?.category || template.category);
    if(!category)return c.json({error:'脑图分类不存在或已停用'},400);
    try {
      const id=await cloneMindmap(c.env.DB,templateId,{name:String(body?.name || '').trim() || String(template.name).replace(/\s*模板$/,'') || '新脑图',category});
      return c.json({success:true,id},201);
    } catch(error) { return c.json({error:error instanceof Error?error.message:'从模板创建失败'},400); }
  });

  app.get('/api/systems/:id/versions', async (c) => {
    const id=Number(c.req.param('id'));
    const rows=await c.env.DB.prepare(`SELECT id,system_id,action,label,created_at,length(snapshot_json) AS snapshot_size FROM mindmap_versions WHERE system_id=? ORDER BY id DESC LIMIT 30`).bind(id).all();
    return c.json(rows.results);
  });

  app.post('/api/systems/:id/versions', async (c) => {
    const id=Number(c.req.param('id'));
    const body=await c.req.json<any>().catch(()=>({}));
    try { const versionId=await saveMindmapVersion(c.env.DB,id,'manual',String(body?.label || '').trim().slice(0,100) || '手动保存'); return c.json({success:true,id:versionId},201); }
    catch(error){return c.json({error:error instanceof Error?error.message:'保存版本失败'},400);}
  });

  app.post('/api/systems/:id/versions/:versionId/restore', async (c) => {
    const systemId=Number(c.req.param('id')),versionId=Number(c.req.param('versionId'));
    const row=await c.env.DB.prepare('SELECT snapshot_json FROM mindmap_versions WHERE id=? AND system_id=?').bind(versionId,systemId).first<{snapshot_json:string}>();
    if(!row)return c.json({error:'脑图版本不存在'},404);
    try {
      const snapshot=JSON.parse(row.snapshot_json) as MindmapSnapshot;
      await saveMindmapVersion(c.env.DB,systemId,'before_restore','回撤前自动版本');
      await replaceMindmapFromSnapshot(c.env.DB,systemId,snapshot);
      return c.json({success:true});
    } catch(error){return c.json({error:error instanceof Error?error.message:'回撤失败'},400);}
  });

  app.delete('/api/systems/:id/versions/:versionId',async(c)=>{
    const systemId=Number(c.req.param('id')),versionId=Number(c.req.param('versionId'));
    if(!Number.isInteger(systemId)||!Number.isInteger(versionId))return c.json({error:'版本参数无效'},400);
    const version=await c.env.DB.prepare('SELECT id FROM mindmap_versions WHERE id=? AND system_id=?').bind(versionId,systemId).first();
    if(!version)return c.json({error:'脑图版本不存在'},404);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE trade_strategy_snapshots SET version_id=NULL WHERE version_id=?').bind(versionId),
      c.env.DB.prepare('DELETE FROM mindmap_versions WHERE id=? AND system_id=?').bind(versionId,systemId)
    ]);
    return c.json({success:true});
  });

  app.post('/api/systems/:id/refinements', async (c) => {
    const systemId=Number(c.req.param('id'));
    const body=await c.req.json<any>().catch(()=>({}));
    const instructions=String(body?.instructions || '').trim().slice(0,4000);
    if(!Number.isInteger(systemId)||!await c.env.DB.prepare('SELECT id FROM trading_systems WHERE id=?').bind(systemId).first())return c.json({error:'脑图不存在'},404);
    const jobId=await createAiJob(c.env,'mindmap_refinement',String(systemId));
    try{
      await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'mindmap_refinement',jobId,systemId,instructions},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});
      return c.json({success:true,status:'queued',job_id:jobId},202);
    }catch(error){await updateAiJob(c.env,jobId,'failed',{error:aiErrorMessage(error)});return c.json({error:'无法启动 AI 精修后台任务'},500);}
  });

  // 兼容旧客户端：现在只生成草稿，不再未经确认直接覆盖脑图。
  app.post('/api/systems/:id/refine', async (c) => {
    const systemId=Number(c.req.param('id'));
    const body=await c.req.json<any>().catch(()=>({}));
    const instructions=String(body?.instructions||'').trim().slice(0,4000);
    if(!Number.isInteger(systemId)||!await c.env.DB.prepare('SELECT id FROM trading_systems WHERE id=?').bind(systemId).first())return c.json({error:'脑图不存在'},404);
    const jobId=await createAiJob(c.env,'mindmap_refinement',String(systemId));
    try{await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'mindmap_refinement',jobId,systemId,instructions},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});return c.json({success:true,status:'queued',job_id:jobId},202);}
    catch(error){await updateAiJob(c.env,jobId,'failed',{error:aiErrorMessage(error)});return c.json({error:'无法启动 AI 精修后台任务'},500);}
  });

  app.get('/api/ai/jobs/:id',async(c)=>{
    const row=await c.env.DB.prepare('SELECT * FROM ai_jobs WHERE id=?').bind(c.req.param('id')).first<any>();
    if(!row)return c.json({error:'AI 后台任务不存在'},404);
    return c.json({...row,result:row.result_json?JSON.parse(row.result_json):null,result_json:undefined});
  });

  app.get('/api/systems/:id/refinements/:draftId',async(c)=>{
    const row=await c.env.DB.prepare('SELECT * FROM mindmap_refinement_drafts WHERE id=? AND system_id=?').bind(c.req.param('draftId'),Number(c.req.param('id'))).first<any>();
    if(!row)return c.json({error:'精修草稿不存在'},404);
    const proposed=JSON.parse(row.proposed_snapshot_json) as MindmapSnapshot;
    return c.json({...row,draft_id:row.id,node_count:proposed.nodes.length,quality:calculateMindmapQuality(proposed.nodes as Record<string,any>[]),base:JSON.parse(row.base_snapshot_json),proposed,diff:JSON.parse(row.diff_json),usage:JSON.parse(row.usage_json||'null')});
  });

  app.post('/api/systems/:id/refinements/:draftId/apply',async(c)=>{
    const systemId=Number(c.req.param('id')),draftId=c.req.param('draftId');
    const body=await c.req.json<any>().catch(()=>({}));
    const row=await c.env.DB.prepare("SELECT * FROM mindmap_refinement_drafts WHERE id=? AND system_id=? AND status='draft'").bind(draftId,systemId).first<any>();
    if(!row)return c.json({error:'精修草稿不存在或已处理'},404);
    const system=await c.env.DB.prepare('SELECT updated_at FROM trading_systems WHERE id=?').bind(systemId).first<{updated_at:string}>();
    if(!system)return c.json({error:'脑图不存在'},404);
    if(system.updated_at!==row.base_updated_at && body?.force!==true)return c.json({error:'脑图在草稿生成后已被修改，请重新生成精修草稿',code:'MINDMAP_CHANGED'},409);
    try{
      const proposed=JSON.parse(row.proposed_snapshot_json) as MindmapSnapshot;
      const base=JSON.parse(row.base_snapshot_json) as MindmapSnapshot;
      const excluded=new Set((Array.isArray(body?.excluded_node_ids)?body.excluded_node_ids:[]).map(Number));
      let changed=true;
      while(changed){changed=false;for(const node of proposed.nodes)if(node.parent_id!==null&&excluded.has(Number(node.parent_id))&&!excluded.has(Number(node.id))){excluded.add(Number(node.id));changed=true;}}
      const selectedNodes=proposed.nodes.filter(node=>node.parent_id===null||!excluded.has(Number(node.id))).map(node=>({...node}));
      const preserve=new Set((Array.isArray(body?.preserve_removed_node_ids)?body.preserve_removed_node_ids:[]).map(Number));
      let expanded=true;while(expanded){expanded=false;for(const node of base.nodes)if(node.parent_id!==null&&preserve.has(Number(node.parent_id))&&!preserve.has(Number(node.id))){preserve.add(Number(node.id));expanded=true;}}
      const maxId=Math.max(...selectedNodes.map(node=>Number(node.id)),1);let nextId=maxId+1;const oldToNew=new Map<number,number>();
      for(const node of base.nodes.filter(item=>item.parent_id!==null&&preserve.has(Number(item.id)))){const newId=nextId++;oldToNew.set(Number(node.id),newId);selectedNodes.push({...node,id:newId,parent_id:oldToNew.get(Number(node.parent_id))||selectedNodes[0].id,sort_order:999});}
      if(selectedNodes.length<2)return c.json({error:'至少需要保留一个非根节点'},400);
      const versionId=await saveMindmapVersion(c.env.DB,systemId,'before_refine_apply','应用 AI 精修草稿前');
      await replaceMindmapFromSnapshot(c.env.DB,systemId,{...proposed,nodes:selectedNodes});
      await c.env.DB.prepare("UPDATE mindmap_refinement_drafts SET status='applied',applied_at=datetime('now') WHERE id=?").bind(draftId).run();
      const next=await loadMindmapSnapshot(c.env.DB,systemId);
      return c.json({success:true,version_id:versionId,node_count:next.nodes.length,quality:calculateMindmapQuality(next.nodes as Record<string,any>[])});
    }catch(error){return c.json({error:error instanceof Error?error.message:'应用精修草稿失败'},400);}
  });

  app.delete('/api/systems/:id/refinements/:draftId',async(c)=>{
    const result=await c.env.DB.prepare("UPDATE mindmap_refinement_drafts SET status='discarded' WHERE id=? AND system_id=? AND status='draft'").bind(c.req.param('draftId'),Number(c.req.param('id'))).run();
    if(!result.meta.changes)return c.json({error:'精修草稿不存在或已处理'},404);
    return c.json({success:true});
  });

  app.post('/api/systems/:id/nodes', async (c) => {
    const systemId = Number(c.req.param('id'));
    const parsed = systemNodeSchema.safeParse(await c.req.json());
    if (!parsed.success) return validationError(c, parsed.error);
    const p = parsed.data;
    const db = c.env.DB;
    const system = await db.prepare('SELECT id FROM trading_systems WHERE id = ?').bind(systemId).first();
    if (!system) return c.json({ error: '交易系统不存在' }, 404);
    if (p.parent_id) {
      const parent = await db.prepare('SELECT id FROM trading_system_nodes WHERE id = ? AND system_id = ?')
        .bind(p.parent_id, systemId).first();
      if (!parent) return c.json({ error: '父节点不属于当前交易系统' }, 400);
    }
    const nodeType = p.node_type || 'condition';
    if (!await isAvailableSystemNodeType(db, nodeType)) {
      return c.json({ error: '节点类型不存在或未启用，请先到设置页维护脑图节点类型' }, 400);
    }
    const result = await db.prepare(
      `INSERT INTO trading_system_nodes
         (system_id, parent_id, rule_id, title, content, node_type, sort_order, is_collapsed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      systemId, p.parent_id || null, p.rule_id || null, p.title, p.content || null,
      nodeType, p.sort_order || 0, p.is_collapsed ? 1 : 0
    ).run();
    await db.prepare("UPDATE trading_systems SET updated_at = datetime('now') WHERE id = ?").bind(systemId).run();
    return c.json({ id: result.meta.last_row_id, success: true }, 201);
  });

  app.put('/api/systems/:systemId/nodes/:nodeId', async (c) => {
    const systemId = Number(c.req.param('systemId'));
    const nodeId = Number(c.req.param('nodeId'));
    const parsed = systemNodeSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return validationError(c, parsed.error);
    const db = c.env.DB;
    const current = await db.prepare('SELECT id, parent_id, node_type FROM trading_system_nodes WHERE id = ? AND system_id = ?')
      .bind(nodeId, systemId).first<{ id: number; parent_id: number | null; node_type: string }>();
    if (!current) return c.json({ error: '节点不存在' }, 404);

    if (parsed.data.parent_id !== undefined) {
      if (current.parent_id === null) return c.json({ error: '根节点不能移动' }, 400);
      if (parsed.data.parent_id === nodeId) return c.json({ error: '节点不能成为自己的父节点' }, 400);
      if (parsed.data.parent_id) {
        const descendant = await db.prepare(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id FROM trading_system_nodes WHERE parent_id = ?
             UNION ALL
             SELECT n.id FROM trading_system_nodes n JOIN descendants d ON n.parent_id = d.id
           ) SELECT id FROM descendants WHERE id = ? LIMIT 1`
        ).bind(nodeId, parsed.data.parent_id).first();
        const parent = await db.prepare('SELECT id FROM trading_system_nodes WHERE id = ? AND system_id = ?')
          .bind(parsed.data.parent_id, systemId).first();
        if (!parent || descendant) return c.json({ error: '父节点无效或会形成循环' }, 400);
      }
    }

    if (parsed.data.node_type !== undefined) {
      if (current.parent_id === null && parsed.data.node_type !== 'root') {
        return c.json({ error: '根节点类型不能修改' }, 400);
      }
      if (current.parent_id !== null && parsed.data.node_type !== current.node_type && !await isAvailableSystemNodeType(db, parsed.data.node_type)) {
        return c.json({ error: '节点类型不存在或未启用，请先到设置页维护脑图节点类型' }, 400);
      }
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const field of ['parent_id', 'rule_id', 'title', 'content', 'node_type', 'sort_order', 'is_collapsed'] as const) {
      if (parsed.data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(field === 'is_collapsed' ? (parsed.data[field] ? 1 : 0) : parsed.data[field]);
      }
    }
    if (!fields.length) return c.json({ error: '没有可更新字段' }, 400);
    fields.push("updated_at = datetime('now')");
    values.push(nodeId, systemId);
    await db.prepare(`UPDATE trading_system_nodes SET ${fields.join(', ')} WHERE id = ? AND system_id = ?`).bind(...values).run();
    await db.prepare("UPDATE trading_systems SET updated_at = datetime('now') WHERE id = ?").bind(systemId).run();
    return c.json({ success: true });
  });

  app.delete('/api/systems/:systemId/nodes/:nodeId', async (c) => {
    const systemId = Number(c.req.param('systemId'));
    const nodeId = Number(c.req.param('nodeId'));
    const db = c.env.DB;
    const node = await db.prepare('SELECT parent_id FROM trading_system_nodes WHERE id = ? AND system_id = ?')
      .bind(nodeId, systemId).first<{ parent_id: number | null }>();
    if (!node) return c.json({ error: '节点不存在' }, 404);
    if (node.parent_id === null) return c.json({ error: '根节点不能删除，请删除整个交易系统' }, 400);
    await db.prepare('DELETE FROM trading_system_nodes WHERE id = ? AND system_id = ?').bind(nodeId, systemId).run();
    await db.prepare("UPDATE trading_systems SET updated_at = datetime('now') WHERE id = ?").bind(systemId).run();
    return c.json({ success: true });
  });


}
