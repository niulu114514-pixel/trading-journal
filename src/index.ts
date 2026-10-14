import { Hono } from 'hono';
import { z } from 'zod';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { AppEnv, Bindings } from './app-types';
import type { MindmapSnapshot } from './domain/mindmap';
import { generateToken, sha256Text } from './lib/crypto';
import { d1SessionConstraint, sessionBackedDatabase } from './lib/d1-session';
import { monthBounds, statsPeriodSql } from './lib/stats';
import { normalizeTradeTimeframes } from './lib/trades';
import { MCP_TOOLS, MCP_WRITE_METHODS } from './mcp/catalog';
import { authenticateMcpRequest } from './mcp/auth';
import {
  jsonRpcError,
  jsonRpcResult,
  MCP_INSTRUCTIONS,
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSION,
  MCP_SERVER_INFO,
  MCP_SUPPORTED_VERSIONS,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './mcp/protocol';
import { registerSecurityMiddleware } from './middleware/security';
import { registerAuthRoutes } from './routes/auth';
import { registerRuleRoutes } from './routes/rules';
import { registerSettingsRoutes } from './routes/settings';
import { registerStatsRoutes } from './routes/stats';
import { registerTradeRoutes } from './routes/trades';
import { registerMcpTokenRoutes } from './routes/mcp-tokens';
import { registerSystemRoutes } from './routes/systems';
import { registerShareRoutes } from './routes/shares';
import { ensureSensitiveConfigEncrypted, encryptConfigValue, getAllConfig } from './services/config';
import { createMaintenanceJob, updateMaintenanceJob } from './services/maintenance-jobs';
import {
  parseMindmapBatchNodes,
  type MindmapBatchNode
} from './services/mindmap-nodes';
import {
  calculateMindmapQuality,
  captureTradeStrategySnapshot,
  cloneMindmap,
  isAvailableSystemNodeType,
  loadMindmapSnapshot,
  replaceMindmapFromSnapshot,
  resolveActiveMindmapCategory,
  saveMindmapVersion
} from './services/mindmaps';
import type { BackupWorkflowParams } from './workflows/types';

export { hashSessionToken } from './routes/auth';
export { normalizeMindmapNodeType } from './services/mindmap-nodes';
export { orderMindmapNodesParentFirst } from './services/mindmaps';

const app = new Hono<AppEnv>();
registerSecurityMiddleware(app);
registerAuthRoutes(app);
registerRuleRoutes(app);
registerSettingsRoutes(app);
registerStatsRoutes(app);
registerTradeRoutes(app, { captureTradeStrategySnapshot, updateMonthlyStats, rebuildMonth });
registerMcpTokenRoutes(app);
registerSystemRoutes(app);
registerShareRoutes(app, { serveTelegramImage });

// ===================== 分享与 MCP 密钥辅助函数 =====================

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function imageBytesMatchMime(buffer: ArrayBuffer, mimeType: string): boolean {
  const bytes = new Uint8Array(buffer);
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && hasBytes(bytes, 0, [0xff, 0xd8, 0xff]);
  if (mimeType === 'image/png') return bytes.length >= 8 && hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === 'image/gif') {
    return bytes.length >= 6 && (hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
  }
  return mimeType === 'image/webp' && bytes.length >= 12
    && hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50]);
}

// 上传图片到 Telegram（参考 Telegraph-Image 等开源项目方案）
// 流程：sendPhoto 发送到频道 → 获取 file_id → 记录 file_id 用于后续代理访问
async function uploadToTelegram(
  botToken: string,
  chatId: string,
  fileData: ArrayBuffer,
  filename: string,
  mimeType: string,
  caption: string
): Promise<{ fileId: string; messageId: string | null }> {
  const makeForm = (field: 'photo' | 'document') => {
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption.substring(0, 1024));
    form.append(field, new File([fileData], filename, { type: mimeType }));
    return form;
  };

  const photoResp = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: makeForm('photo')
  });
  const photoData = await photoResp.json() as any;
  if (photoData.ok) {
    const photos = photoData.result?.photo;
    if (photos?.length) {
      return {
        fileId: photos[photos.length - 1].file_id,
        messageId: photoData.result?.message_id ? String(photoData.result.message_id) : null
      };
    }
  }

  // Telegram 会拒绝部分无法重编码的图片；按原文件发送可保留后缀和 MIME。
  const documentResp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    body: makeForm('document')
  });
  const documentData = await documentResp.json() as any;
  if (!documentData.ok || !documentData.result?.document?.file_id) {
    throw new Error(documentData.description || photoData.description || 'Telegram 上传失败');
  }
  return {
    fileId: documentData.result.document.file_id,
    messageId: documentData.result?.message_id ? String(documentData.result.message_id) : null
  };
}

// 统一的图片存储函数（Web 上传与 MCP 上传共用）
// 返回 { ok, error?, key?, url?, storage?, tg_uploaded?, tg_error? }
async function storeImageBuffer(
  env: Bindings,
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string,
  size: number,
  caption: string,
  metadata: { displayName?: string; category?: string; tags?: string; resourceUrl?: string; folderId?: number | null } = {}
): Promise<{ ok: boolean; error?: string; id?: number; key?: string; url?: string; public_id?: string; storage?: string; tg_uploaded?: boolean; tg_error?: string }> {
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    return { ok: false, error: '仅支持 JPG / PNG / GIF / WebP 格式图片' };
  }
  if (size > MAX_IMAGE_SIZE || buffer.byteLength > MAX_IMAGE_SIZE) {
    return { ok: false, error: '图片不能超过 10MB' };
  }
  if (!imageBytesMatchMime(buffer, mimeType)) {
    return { ok: false, error: '图片内容与声明格式不一致或文件已损坏' };
  }

  const config = await getAllConfig(env.DB,env.CONFIG_ENCRYPTION_KEY);
  let r2Key: string | null = null;
  let tgFileId: string | null = null;
  let tgMessageId: string | null = null;
  let tgError: string | null = null;

  // 存储策略：r2 / tg / both；若 tg 未配置凭据则自动回退 R2（R2 始终可用）
  let storageMode = config.image_storage || 'r2';
  const tgConfigured = !!(config.tg_bot_token && config.tg_chat_id);
  if ((storageMode === 'tg' || storageMode === 'both') && !tgConfigured) {
    tgError = 'Telegram 未配置，已回退 R2 存储';
    storageMode = 'r2';
  }

  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mimeType];
  const key = `charts/${new Date().toISOString().substring(0, 10)}/${generateToken(16)}.${ext}`;

  // R2 存储
  if (storageMode === 'r2' || storageMode === 'both') {
    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata: { contentType: mimeType }
      });
      r2Key = key;
    } catch (err: any) {
      if (storageMode === 'r2') {
        return { ok: false, error: `R2 上传失败: ${err.message}` };
      }
      tgError = `R2 上传失败: ${err.message}`;
    }
  }

  // Telegram 存储
  if (storageMode === 'tg' || storageMode === 'both') {
    if (!config.tg_bot_token || !config.tg_chat_id) {
      if (storageMode === 'tg') {
        return { ok: false, error: '未配置 Telegram Bot Token 或 Chat ID，请到设置页配置' };
      }
      tgError = 'Telegram 未配置';
    } else {
      try {
        const telegram = await uploadToTelegram(
          config.tg_bot_token, config.tg_chat_id,
          buffer, filename, mimeType, caption
        );
        tgFileId = telegram.fileId;
        tgMessageId = telegram.messageId;
      } catch (err: any) {
        if (storageMode === 'tg') {
          return { ok: false, error: `Telegram 上传失败: ${err.message}` };
        }
        tgError = `Telegram 上传失败: ${err.message}`;
      }
    }
  }

  if (!r2Key && !tgFileId) {
    return { ok: false, error: tgError || '上传失败：未配置有效的存储方式' };
  }

  // 保存图片记录
  const primaryStorage = r2Key ? 'r2' : 'tg';
  const primaryKey = r2Key || tgFileId!;
  const publicId = generateToken(16);
  const inserted = await env.DB.prepare(
    'INSERT INTO images (key, storage, filename, mime_type, size, tg_file_id, tg_message_id, public_id, caption, display_name, category, tags, resource_url, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(primaryKey, primaryStorage, filename, mimeType, size, tgFileId, tgMessageId, publicId, caption || null, metadata.displayName || null, metadata.category || null, metadata.tags || null, metadata.resourceUrl || null, metadata.folderId || null).run();

  const url = `/i/${publicId}`;

  return {
    ok: true, id: inserted.meta.last_row_id as number, key: primaryKey, url, public_id: publicId, storage: primaryStorage,
    tg_uploaded: !!tgFileId, tg_error: tgError || undefined
  };
}

function absoluteUrl(requestUrl: string, pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  try {
    return new URL(pathOrUrl, requestUrl).toString();
  } catch {
    return pathOrUrl;
  }
}

async function imageCategoryExists(db: D1Database, rawCategory: unknown): Promise<boolean> {
  const category = String(rawCategory || '').trim();
  if (!category) return true;
  const found = await db.prepare(
    "SELECT id FROM settings WHERE category = 'image_category' AND value = ? LIMIT 1"
  ).bind(category).first();
  return Boolean(found);
}

async function imageFolderExists(db: D1Database, rawFolderId: unknown): Promise<boolean> {
  if (rawFolderId === null || rawFolderId === undefined || rawFolderId === '') return true;
  const folderId = Number(rawFolderId);
  if (!Number.isInteger(folderId) || folderId <= 0) return false;
  return Boolean(await db.prepare('SELECT id FROM image_folders WHERE id = ?').bind(folderId).first());
}

function normalizeExternalUrl(rawUrl: unknown): string | null {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  if (value.length > 2048) throw new Error('资料链接不能超过 2048 个字符');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('资料链接仅支持 http 或 https');
  return parsed.toString();
}

// 上传图片（multipart/form-data: file, caption）
// 存储策略由 app_config.image_storage 决定：r2 / tg / both
app.post('/api/upload', async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: '无效的表单数据' }, 400);
  }

  const file = formData.get('file') as any;
  const caption = (formData.get('caption') as string) || '';
  const displayName = (formData.get('display_name') as string) || '';
  const category = ((formData.get('category') as string) || '').trim();
  const tags = (formData.get('tags') as string) || '';
  const folderValue = formData.get('folder_id');
  const folderId = folderValue === null || folderValue === '' ? null : Number(folderValue);
  let resourceUrl: string | null;
  try {
    resourceUrl = normalizeExternalUrl(formData.get('resource_url'));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '资料链接无效' }, 400);
  }

  if (!file || typeof file === 'string' || !file.arrayBuffer) {
    return c.json({ error: '未提供文件' }, 400);
  }
  if (!(await imageCategoryExists(c.env.DB, category))) {
    return c.json({ error: '图片分类不存在，请先创建分类' }, 400);
  }
  if (!(await imageFolderExists(c.env.DB, folderId))) {
    return c.json({ error: '目标文件夹不存在' }, 400);
  }

  const buffer = await file.arrayBuffer();

  const result = await storeImageBuffer(c.env, buffer, file.name, file.type, file.size, caption, { displayName, category, tags, resourceUrl: resourceUrl || undefined, folderId });
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    success: true,
    id: result.id,
    key: result.key,
    url: absoluteUrl(c.req.url, result.url),
    share_url: absoluteUrl(c.req.url, result.url),
    public_id: result.public_id,
    storage: result.storage,
    tg_uploaded: result.tg_uploaded,
    tg_error: result.tg_error
  }, 201);
});

// 从 R2 读取图片（需登录）
app.get('/api/image/r2/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace('/api/image/r2/', ''));
  if (!key) return c.json({ error: '无效的图片路径' }, 400);

  const object = await c.env.BUCKET.get(key);
  if (!object) return c.json({ error: '图片不存在' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=86400');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
});

// 内存缓存 file_id -> file_path（file_path 约 1 小时有效，缓存 45 分钟减少 getFile 往返）
const tgPathCache = new Map<string, { path: string; expires: number }>();
const TG_PATH_TTL = 45 * 60 * 1000;
const TG_PATH_CACHE_MAX = 256;

function cacheTelegramPath(fileId: string, path: string): void {
  const now = Date.now();
  for (const [key, entry] of tgPathCache) {
    if (entry.expires <= now) tgPathCache.delete(key);
  }
  while (tgPathCache.size >= TG_PATH_CACHE_MAX) {
    const oldestKey = tgPathCache.keys().next().value;
    if (!oldestKey) break;
    tgPathCache.delete(oldestKey);
  }
  tgPathCache.set(fileId, { path, expires: now + TG_PATH_TTL });
}

async function serveTelegramImage(env: Bindings, fileId: string, cacheControl: string): Promise<Response> {
  const config = await getAllConfig(env.DB,env.CONFIG_ENCRYPTION_KEY);

  if (!config.tg_bot_token) {
    return Response.json({ error: 'Telegram 未配置' }, { status: 400 });
  }

  let filePath: string | undefined = tgPathCache.get(fileId)?.path;
  const expiresAt = tgPathCache.get(fileId)?.expires || 0;
  if (!filePath || expiresAt < Date.now()) {
    try {
      const fileResp = await fetch(`https://api.telegram.org/bot${config.tg_bot_token}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId })
      });
      const fileData = await fileResp.json() as any;
      if (!fileData.ok) {
        return Response.json({ error: `获取文件信息失败: ${fileData.description}` }, { status: 404 });
      }
      const pathStr: string = fileData.result.file_path;
      filePath = pathStr;
      cacheTelegramPath(fileId, pathStr);
    } catch (err: any) {
      return Response.json({ error: `无法连接 Telegram API: ${err.message || '网络错误'}` }, { status: 502 });
    }
  }

  let imageResp: Response;
  try {
    imageResp = await fetch(
      `https://api.telegram.org/file/bot${config.tg_bot_token}/${filePath}`
    );
  } catch (err: any) {
    return Response.json({ error: `下载图片失败: ${err.message || '网络错误'}` }, { status: 502 });
  }
  if (!imageResp.ok) {
    return Response.json({ error: '下载图片失败' }, { status: 502 });
  }

  return new Response(imageResp.body, {
    headers: {
      'Content-Type': imageResp.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': cacheControl,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

// 从 Telegram 代理读取图片（需登录，token 不暴露给前端）
app.get('/api/image/tg/:fileId', async (c) => {
  return serveTelegramImage(c.env, c.req.param('fileId'), 'private, max-age=3600');
});

// 图床公开链接：随机 public_id 不可枚举，无需登录即可在线查看/嵌入。
app.get('/i/:publicId', async (c) => {
  const publicId = c.req.param('publicId');
  if (!/^[a-f0-9]{32}$/i.test(publicId)) return c.json({ error: '无效的图片链接' }, 400);

  const image = await c.env.DB.prepare(
    'SELECT id, key, storage, filename, display_name, mime_type, tg_file_id FROM images WHERE public_id = ?'
  ).bind(publicId).first<any>();
  if (!image) return c.json({ error: '图片不存在或已删除' }, 404);

  if (image.storage === 'r2') {
    const object = await c.env.BUCKET.get(image.key);
    if (!object) {
      await c.env.DB.prepare('DELETE FROM images WHERE id = ?').bind(image.id).run();
      return c.json({ error: '图片已从存储中删除' }, 404);
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=86400');
    const baseName = image.display_name || image.filename || 'image';
    const originalExt = String(image.filename || '').match(/\.[a-z0-9]+$/i)?.[0];
    const mimeExt = image.mime_type === 'image/jpeg' ? '.jpg' : `.${String(image.mime_type || 'image/png').split('/')[1] || 'png'}`;
    const viewName = /\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}${originalExt || mimeExt}`;
    headers.set('Content-Type', image.mime_type || headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(viewName)}`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  }

  const response = await serveTelegramImage(c.env, image.tg_file_id || image.key, 'public, max-age=3600');
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  const baseName = image.display_name || image.filename || 'image';
  const originalExt = String(image.filename || '').match(/\.[a-z0-9]+$/i)?.[0];
  const mimeExt = image.mime_type === 'image/jpeg' ? '.jpg' : `.${String(image.mime_type || 'image/jpeg').split('/')[1] || 'jpg'}`;
  const viewName = /\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}${originalExt || mimeExt}`;
  headers.set('Content-Type', image.mime_type || 'image/jpeg');
  headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(viewName)}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
});

// 测试 Telegram 配置
app.post('/api/tg/test', async (c) => {
  const config = await getAllConfig(c.env.DB,c.env.CONFIG_ENCRYPTION_KEY);

  if (!config.tg_bot_token) {
    return c.json({ error: '未配置 Telegram Bot Token' }, 400);
  }

  // 1. 验证 Bot Token
  let meData: any;
  try {
    const meResp = await fetch(`https://api.telegram.org/bot${config.tg_bot_token}/getMe`);
    meData = await meResp.json() as any;
  } catch (err: any) {
    return c.json({ error: `无法连接 Telegram API: ${err.message || '网络错误'}` }, 502);
  }

  if (!meData.ok) {
    return c.json({ error: `Bot Token 无效: ${meData.description}` }, 400);
  }

  // 2. 验证 Chat ID（尝试发送测试消息）
  if (config.tg_chat_id) {
    let sendData: any;
    try {
      const sendResp = await fetch(`https://api.telegram.org/bot${config.tg_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.tg_chat_id,
          text: '✅ 交易日志系统 Telegram 配置测试成功'
        })
      });
      sendData = await sendResp.json() as any;
    } catch (err: any) {
      return c.json({ error: `无法连接 Telegram API: ${err.message || '网络错误'}` }, 502);
    }

    if (!sendData.ok) {
      return c.json({
        error: `Bot 有效（@${meData.result.username}），但发送消息失败: ${sendData.description}。请确认 Chat ID 正确且 Bot 已加入该聊天。`
      }, 400);
    }

    return c.json({
      success: true,
      bot_name: meData.result.username,
      message: `Bot @${meData.result.username} 配置正确，测试消息已发送`
    });
  }

  return c.json({
    success: true,
    bot_name: meData.result.username,
    message: `Bot @${meData.result.username} 有效，但未配置 Chat ID`
  });
});

async function deleteStoredImage(env: Bindings, record: any): Promise<{ tg_error?: string }> {
  let tgError: string | undefined;
  if (record.storage === 'r2') {
    await env.BUCKET.delete(record.key);
  }

  // 新上传的 TG 图片保存了 message_id，可同步删除频道/聊天中的原消息。
  if (record.tg_message_id) {
    const config = await getAllConfig(env.DB,env.CONFIG_ENCRYPTION_KEY);
    if (config.tg_bot_token && config.tg_chat_id) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${config.tg_bot_token}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: config.tg_chat_id, message_id: Number(record.tg_message_id) })
        });
        const data = await resp.json() as any;
        if (!data.ok) tgError = data.description || 'Telegram 消息删除失败';
      } catch (e: any) {
        tgError = e?.message || 'Telegram 消息删除失败';
      }
    }
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE share_links SET revoked_at=datetime('now') WHERE target_type='image' AND target_id=? AND revoked_at IS NULL").bind(record.id),
    env.DB.prepare('DELETE FROM images WHERE id = ?').bind(record.id)
  ]);
  return { tg_error: tgError };
}

// 图床文件夹与“分类”相互独立：文件夹负责整理位置，分类负责多维检索。
app.get('/api/image-folders', async (c) => {
  const [folders, totals] = await Promise.all([
    c.env.DB.prepare(
      `SELECT f.id,f.name,f.color,f.sort_order,f.created_at,f.updated_at,
        COUNT(i.id) AS image_count,COALESCE(SUM(i.size),0) AS total_bytes
       FROM image_folders f LEFT JOIN images i ON i.folder_id=f.id
       GROUP BY f.id ORDER BY f.sort_order ASC,f.id ASC`
    ).all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN folder_id IS NULL THEN 1 ELSE 0 END) AS root_count
       FROM images`
    ).first<{ total:number; root_count:number }>()
  ]);
  return c.json({ folders:folders.results,total:Number(totals?.total||0),root_count:Number(totals?.root_count||0) });
});

app.post('/api/image-folders', async (c) => {
  const parsed=z.object({name:z.string().trim().min(1).max(60),color:z.string().regex(/^#[0-9a-f]{6}$/i).default('#3ec9c5')}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'文件夹名称或颜色无效'},400);
  const duplicate=await c.env.DB.prepare('SELECT id FROM image_folders WHERE name=?').bind(parsed.data.name).first();
  if(duplicate)return c.json({error:'已存在同名文件夹'},409);
  const order=await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM image_folders').first<{next:number}>();
  const result=await c.env.DB.prepare('INSERT INTO image_folders(name,color,sort_order) VALUES(?,?,?)').bind(parsed.data.name,parsed.data.color,Number(order?.next||0)).run();
  return c.json({success:true,id:result.meta.last_row_id,name:parsed.data.name,color:parsed.data.color},201);
});

app.put('/api/image-folders/:id', async (c) => {
  const id=Number(c.req.param('id'));
  if(!Number.isInteger(id)||id<=0)return c.json({error:'无效的文件夹 ID'},400);
  const parsed=z.object({name:z.string().trim().min(1).max(60).optional(),color:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),sort_order:z.number().int().min(0).max(10000).optional()}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success||!Object.keys(parsed.data).length)return c.json({error:'没有可更新的文件夹信息'},400);
  const fields:string[]=[],values:unknown[]=[];
  for(const field of ['name','color','sort_order'] as const)if(parsed.data[field]!==undefined){fields.push(`${field}=?`);values.push(parsed.data[field]);}
  try{const result=await c.env.DB.prepare(`UPDATE image_folders SET ${fields.join(',')},updated_at=datetime('now') WHERE id=?`).bind(...values,id).run();if(!result.meta.changes)return c.json({error:'文件夹不存在'},404);}
  catch(error){return c.json({error:String(error).includes('UNIQUE')?'已存在同名文件夹':'文件夹更新失败'},409);}
  return c.json({success:true});
});

app.delete('/api/image-folders/:id', async (c) => {
  const id=Number(c.req.param('id'));
  if(!Number.isInteger(id)||id<=0)return c.json({error:'无效的文件夹 ID'},400);
  const folder=await c.env.DB.prepare('SELECT id FROM image_folders WHERE id=?').bind(id).first();
  if(!folder)return c.json({error:'文件夹不存在'},404);
  const mode=c.req.query('mode')||'delete';
  if(mode!=='delete'&&mode!=='keep')return c.json({error:'删除模式无效'},400);
  if(mode==='delete'){
    const jobId=await createMaintenanceJob(c.env,'delete_folder',String(id));
    try{
      await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'delete_folder',jobId,folderId:id},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});
      return c.json({success:true,mode,status:'queued',job_id:jobId},202);
    }catch(error){
      await updateMaintenanceJob(c.env,jobId,'failed',{error:error instanceof Error?error.message:String(error)});
      return c.json({error:'无法启动文件夹删除任务'},500);
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE images SET folder_id=NULL WHERE folder_id=?').bind(id),
    c.env.DB.prepare("UPDATE share_links SET revoked_at=datetime('now') WHERE target_type='folder' AND target_id=? AND revoked_at IS NULL").bind(id),
    c.env.DB.prepare('DELETE FROM image_folders WHERE id=?').bind(id)
  ]);
  return c.json({success:true,mode});
});

// 获取图片列表（独立图床管理用）
app.get('/api/images', async (c) => {
  const db = c.env.DB;
  const page = Math.max(parseInt(c.req.query('page') || '1'), 1);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20'), 1), 100);
  const offset = (page - 1) * limit;
  const query = (c.req.query('q') || '').trim();
  const category = (c.req.query('category') || '').trim();
  const folder = (c.req.query('folder') || '').trim();
  const where: string[] = [];
  const params: any[] = [];
  if (category === '__uncategorized__') {
    where.push("(category IS NULL OR TRIM(category) = '')");
  } else if (category) {
    where.push('category = ?'); params.push(category);
  }
  if (folder === '__root__') {
    where.push('folder_id IS NULL');
  } else if (folder) {
    const folderId = Number(folder);
    if (!Number.isInteger(folderId) || folderId <= 0) return c.json({ error:'无效的文件夹筛选' },400);
    where.push('folder_id = ?'); params.push(folderId);
  }
  if (query) { where.push('(filename LIKE ? OR display_name LIKE ? OR caption LIKE ? OR tags LIKE ?)'); const like = `%${query}%`; params.push(like, like, like, like); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await db.prepare(`SELECT COUNT(*) as total FROM images ${whereSql}`).bind(...params).first<{ total: number }>();
  const total = countResult?.total || 0;

  const images = await db.prepare(
    `SELECT id, filename, display_name, storage, key, tg_file_id, size, mime_type,
      caption, public_id, category, tags, resource_url, folder_id, created_at
     FROM images ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  const results = (images.results as any[]).map(img => ({
    id: img.id,
    filename: img.filename,
    display_name: img.display_name,
    storage: img.storage,
    size: img.size,
    mime_type: img.mime_type,
    caption: img.caption,
    public_id: img.public_id,
    category: img.category,
    tags: img.tags,
    resource_url: img.resource_url,
    folder_id: img.folder_id,
    created_at: img.created_at,
    url: img.public_id ? `/i/${img.public_id}` : (img.storage === 'r2'
      ? `/api/image/r2/${encodeURIComponent(img.key)}`
      : `/api/image/tg/${encodeURIComponent(img.tg_file_id || img.key)}`),
    share_url: img.public_id ? `${new URL(c.req.url).origin}/i/${img.public_id}` : null
  }));

  const usage = await db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM images').first<{ bytes: number }>();
  return c.json({ images: results, total, total_bytes: usage?.bytes || 0, page, limit });
});

app.put('/api/images/move', async (c) => {
  const parsed=z.object({image_ids:z.array(z.number().int().positive()).min(1).max(200),folder_id:z.number().int().positive().nullable()}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'移动参数无效'},400);
  if(!(await imageFolderExists(c.env.DB,parsed.data.folder_id)))return c.json({error:'目标文件夹不存在'},404);
  const placeholders=parsed.data.image_ids.map(()=>'?').join(',');
  const result=await c.env.DB.prepare(`UPDATE images SET folder_id=? WHERE id IN (${placeholders})`).bind(parsed.data.folder_id,...parsed.data.image_ids).run();
  return c.json({success:true,moved:Number(result.meta.changes||0)});
});

app.put('/api/images/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '无效的图片 ID' }, 400);
  const body = await c.req.json<any>();
  const exists = await c.env.DB.prepare('SELECT id FROM images WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: '图片不存在' }, 404);
  const category = String(body.category || '').trim();
  if (!(await imageCategoryExists(c.env.DB, category))) {
    return c.json({ error: '图片分类不存在，请先创建分类' }, 400);
  }
  const folderId=body.folder_id===null||body.folder_id===''||body.folder_id===undefined?null:Number(body.folder_id);
  if(!(await imageFolderExists(c.env.DB,folderId)))return c.json({error:'目标文件夹不存在'},400);
  let resourceUrl: string | null;
  try {
    resourceUrl = normalizeExternalUrl(body.resource_url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '资料链接无效' }, 400);
  }
  await c.env.DB.prepare(
    "UPDATE images SET display_name = ?, category = ?, caption = ?, tags = ?, resource_url = ?, folder_id = ? WHERE id = ?"
  ).bind(body.display_name || null, category || null, body.caption || null, body.tags || null, resourceUrl, folderId, id).run();
  return c.json({ success: true });
});

// 对账 R2 与 D1：修复用户直接在 R2 控制台删除后网页仍显示的问题。
app.post('/api/images/reconcile', async (c) => {
  const jobId=await createMaintenanceJob(c.env,'reconcile_images');
  try{
    await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'reconcile_images',jobId},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});
    return c.json({success:true,status:'queued',job_id:jobId},202);
  }catch(error){
    await updateMaintenanceJob(c.env,jobId,'failed',{error:error instanceof Error?error.message:String(error)});
    return c.json({error:'无法启动图片对账任务'},500);
  }
});

app.get('/api/maintenance-jobs/:id',async(c)=>{
  const row=await c.env.DB.prepare('SELECT * FROM maintenance_jobs WHERE id=?').bind(c.req.param('id')).first<any>();
  if(!row)return c.json({error:'后台任务不存在'},404);
  return c.json({...row,result:row.result_json?JSON.parse(row.result_json):null,result_json:undefined});
});

// 按数据库 ID 删除图片（同时删除 R2、TG 消息、D1 元数据和交易引用）
app.delete('/api/images/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: '无效的图片 ID' }, 400);
  const record = await c.env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(id).first<any>();
  if (!record) return c.json({ error: '图片记录不存在' }, 404);
  try {
    const result = await deleteStoredImage(c.env, record);
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ error: `删除失败: ${e?.message || String(e)}` }, 502);
  }
});

// 兼容旧版按路径删除接口
app.delete('/api/image/*', async (c) => {
  const db = c.env.DB;
  const fullPath = c.req.path.replace('/api/image/', '');
  const [storage, ...keyParts] = fullPath.split('/');
  const key = decodeURIComponent(keyParts.join('/'));

  if (storage !== 'r2' && storage !== 'tg') {
    return c.json({ error: '无效的存储类型' }, 400);
  }

  const record = await db.prepare('SELECT * FROM images WHERE key = ?').bind(key).first<any>();
  if (!record) return c.json({ error: '图片记录不存在' }, 404);

  try {
    const result = await deleteStoredImage(c.env, record);
    return c.json({ success: true, ...result });
  } catch (e: any) {
    return c.json({ error: `删除失败: ${e?.message || String(e)}` }, 502);
  }
});

const BACKUP_PREFIX = '__backups/';
const BACKUP_TABLES = [
  'users','app_config','settings','trading_rules','trading_systems','trading_system_nodes','mindmap_versions',
  'trades','trade_strategy_snapshots','trade_rule_checks','monthly_stats','image_folders','images','daily_chart_images','share_links','mcp_tokens'
] as const;
const BACKUP_DELETE_ORDER = [...BACKUP_TABLES].reverse();
type BackupTable = typeof BACKUP_TABLES[number];
type BackupObject = { key:string; backup_key:string; size:number; etag:string; uploaded:string };
type LegacyBackupManifest = {
  format:'trading-journal-full-backup';
  version:1|2|3;
  id:string;
  label:string;
  created_at:string;
  tables:Record<BackupTable,Record<string,unknown>[]>;
  objects:BackupObject[];
};
type BackupTableChunk={table:BackupTable;key:string;row_count:number;byte_size:number};
type BackupObjectChunk={key:string;object_count:number;total_size:number;reused_object_count:number};
type ChunkedBackupManifest={
  format:'trading-journal-full-backup';version:4;id:string;label:string;created_at:string;
  table_chunks:BackupTableChunk[];object_chunks:BackupObjectChunk[];
  table_count:number;row_count:number;object_count:number;reused_object_count:number;total_size:number;
};
type BackupManifest=LegacyBackupManifest|ChunkedBackupManifest;

function isChunkedBackup(manifest:BackupManifest):manifest is ChunkedBackupManifest{return manifest.version===4;}

async function runChunkedBackup(env:Bindings,step:WorkflowStep,id:string,labelValue:string,stepPrefix:string){
  const label=labelValue.trim().slice(0,80)||`完整备份 ${new Date().toLocaleDateString('zh-CN')}`;
  const tableChunks:BackupTableChunk[]=[],objectChunks:BackupObjectChunk[]=[];
  let rowCount=0,databaseBytes=0;
  await step.do(`${stepPrefix}-加密敏感配置`,{retries:{limit:3,delay:'2 seconds'},timeout:'2 minutes'},()=>ensureSensitiveConfigEncrypted(env));
  for(const table of BACKUP_TABLES){
    let offset=0,page=0;
    while(true){
      const chunk=await step.do(`${stepPrefix}-数据表-${table}-${page}`,{retries:{limit:3,delay:'2 seconds'},timeout:'2 minutes'},async()=>{
        const rows=await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 250 OFFSET ?`).bind(offset).all<Record<string,unknown>>();
        if(!rows.results.length)return {key:'',row_count:0,byte_size:0};
        const body=JSON.stringify(rows.results),key=`${BACKUP_PREFIX}${id}/tables/${table}-${page}.json`;
        await env.BUCKET.put(key,body,{httpMetadata:{contentType:'application/json; charset=utf-8'}});
        return {key,row_count:rows.results.length,byte_size:new TextEncoder().encode(body).byteLength};
      });
      if(!chunk.row_count)break;
      tableChunks.push({table,...chunk});rowCount+=chunk.row_count;databaseBytes+=chunk.byte_size;
      if(databaseBytes>24*1024*1024)throw new Error('数据库快照超过 24 MB，请改用 D1 离线导出');
      offset+=chunk.row_count;page++;
    }
  }

  let cursor:string|null=null,page=0,objectCount=0,reusedObjectCount=0,totalSize=0;
  do{
    const chunk=await step.do(`${stepPrefix}-R2-${page}`,{retries:{limit:3,delay:'5 seconds',backoff:'exponential'},timeout:'10 minutes'},async()=>{
      const listed=await env.BUCKET.list({prefix:'charts/',cursor:cursor||undefined,limit:50});
      const metadata:BackupObject[]=[];let reused=0,size=0;
      for(const object of listed.objects){
        const fingerprint=String(object.etag||'').replace(/[^a-z0-9]/gi,'').toLowerCase()||await sha256Text(`${object.key}:${object.size}:${object.uploaded.toISOString()}`);
        const backupKey=`${BACKUP_PREFIX}objects/${fingerprint}-${object.size}`;
        if(await env.BUCKET.head(backupKey))reused++;
        else{
          const source=await env.BUCKET.get(object.key);
          if(!source||!('body' in source))throw new Error(`备份对象读取失败：${object.key}`);
          await env.BUCKET.put(backupKey,source.body,{httpMetadata:source.httpMetadata,customMetadata:source.customMetadata});
        }
        metadata.push({key:object.key,backup_key:backupKey,size:object.size,etag:object.etag,uploaded:object.uploaded.toISOString()});size+=object.size;
      }
      const key=`${BACKUP_PREFIX}${id}/object-pages/${page}.json`;
      if(metadata.length)await env.BUCKET.put(key,JSON.stringify(metadata),{httpMetadata:{contentType:'application/json; charset=utf-8'}});
      return {key:metadata.length?key:'',object_count:metadata.length,total_size:size,reused_object_count:reused,cursor:listed.truncated?listed.cursor:null};
    });
    if(chunk.object_count){objectChunks.push({key:chunk.key,object_count:chunk.object_count,total_size:chunk.total_size,reused_object_count:chunk.reused_object_count});objectCount+=chunk.object_count;totalSize+=chunk.total_size;reusedObjectCount+=chunk.reused_object_count;}
    cursor=chunk.cursor;page++;
  }while(cursor);

  const manifest:ChunkedBackupManifest={format:'trading-journal-full-backup',version:4,id,label,created_at:new Date().toISOString(),table_chunks:tableChunks,object_chunks:objectChunks,table_count:BACKUP_TABLES.length,row_count:rowCount,object_count:objectCount,reused_object_count:reusedObjectCount,total_size:totalSize};
  await step.do(`${stepPrefix}-写入清单`,{retries:{limit:3,delay:'2 seconds'},timeout:'2 minutes'},async()=>{
    await env.BUCKET.put(`${BACKUP_PREFIX}${id}/manifest.json`,JSON.stringify(manifest),{httpMetadata:{contentType:'application/json; charset=utf-8'}});
    await env.DB.prepare(`UPDATE backups SET status='completed',table_count=?,row_count=?,object_count=?,reused_object_count=?,total_size=?,error=NULL,completed_at=datetime('now') WHERE id=?`).bind(BACKUP_TABLES.length,rowCount,objectCount,reusedObjectCount,totalSize,id).run();
  });
  return {id,label,table_count:BACKUP_TABLES.length,row_count:rowCount,object_count:objectCount,reused_object_count:reusedObjectCount,total_size:totalSize};
}

async function verifyFullBackup(env:Bindings,backupId:string){
  const record=await env.DB.prepare("SELECT manifest_key FROM backups WHERE id=? AND status='completed'").bind(backupId).first<{manifest_key:string}>();
  if(!record?.manifest_key)throw new Error('备份不存在或尚未完成');
  const object=await env.BUCKET.get(record.manifest_key);if(!object)throw new Error('备份清单不存在');
  const manifest=await object.json<BackupManifest>();
  if(manifest.format!=='trading-journal-full-backup'||![1,2,3,4].includes(manifest.version)||manifest.id!==backupId)throw new Error('备份清单格式无效');
  const missing:string[]=[];
  if(isChunkedBackup(manifest)){
    for(const chunk of manifest.table_chunks)if(!await env.BUCKET.head(chunk.key))missing.push(chunk.key);
    for(const chunk of manifest.object_chunks){
      const page=await env.BUCKET.get(chunk.key);if(!page){missing.push(chunk.key);continue;}
      const items=await page.json<BackupObject[]>();
      for(const item of items)if(!await env.BUCKET.head(item.backup_key))missing.push(item.key);
    }
  }else for(const item of manifest.objects)if(!await env.BUCKET.head(item.backup_key))missing.push(item.key);
  if(missing.length)throw new Error(`备份缺少 ${missing.length} 个对象：${missing.slice(0,3).join('、')}`);
  await env.DB.prepare("UPDATE backups SET verified_at=datetime('now') WHERE id=?").bind(backupId).run();
  return isChunkedBackup(manifest)
    ?{valid:true,table_count:manifest.table_count,row_count:manifest.row_count,object_count:manifest.object_count}
    :{valid:true,table_count:Object.keys(manifest.tables).length,row_count:Object.values(manifest.tables).reduce((sum,rows)=>sum+rows.length,0),object_count:manifest.objects.length};
}

async function verifyBackupWithSteps(env:Bindings,step:WorkflowStep,backupId:string,stepPrefix:string){
  const manifestText=await step.do(`${stepPrefix}-读取校验清单`,async()=>{
    const record=await env.DB.prepare("SELECT manifest_key FROM backups WHERE id=? AND status='completed'").bind(backupId).first<{manifest_key:string}>();
    if(!record?.manifest_key)throw new Error('备份不存在或尚未完成');
    const object=await env.BUCKET.get(record.manifest_key);if(!object)throw new Error('备份清单不存在');
    const value=await object.json<BackupManifest>();
    if(value.format!=='trading-journal-full-backup'||![1,2,3,4].includes(value.version)||value.id!==backupId)throw new Error('备份清单格式无效');
    return JSON.stringify(value);
  });
  const manifest=JSON.parse(manifestText) as BackupManifest;
  if(!isChunkedBackup(manifest))return step.do(`${stepPrefix}-校验旧版备份`,{retries:{limit:2,delay:'5 seconds'},timeout:'15 minutes'},()=>verifyFullBackup(env,backupId));
  for(let index=0;index<manifest.table_chunks.length;index++)await step.do(`${stepPrefix}-校验数据块-${index}`,async()=>{
    if(!await env.BUCKET.head(manifest.table_chunks[index].key))throw new Error(`备份数据块缺失：${manifest.table_chunks[index].key}`);
  });
  for(let index=0;index<manifest.object_chunks.length;index++)await step.do(`${stepPrefix}-校验对象块-${index}`,{retries:{limit:3,delay:'3 seconds'},timeout:'5 minutes'},async()=>{
    const chunk=manifest.object_chunks[index],page=await env.BUCKET.get(chunk.key);if(!page)throw new Error(`备份对象清单缺失：${chunk.key}`);
    const objects=await page.json<BackupObject[]>(),missing:string[]=[];
    for(const item of objects)if(!await env.BUCKET.head(item.backup_key))missing.push(item.key);
    if(missing.length)throw new Error(`备份缺少 ${missing.length} 个对象：${missing.slice(0,3).join('、')}`);
  });
  await step.do(`${stepPrefix}-登记校验结果`,async()=>{await env.DB.prepare("UPDATE backups SET verified_at=datetime('now') WHERE id=?").bind(backupId).run();return {verified:true};});
  return {valid:true,table_count:manifest.table_count,row_count:manifest.row_count,object_count:manifest.object_count};
}

async function pruneBackups(env:Bindings,keep:number){
  const rows=await env.DB.prepare("SELECT id FROM backups WHERE status='completed' ORDER BY created_at DESC").all<{id:string}>();
  const stale=rows.results.slice(Math.max(1,Math.min(30,keep)));
  for(const item of stale){await deleteR2Prefix(env.BUCKET,`${BACKUP_PREFIX}${item.id}/`);await env.DB.prepare('DELETE FROM backups WHERE id=?').bind(item.id).run();}
  // 内容寻址对象可能被多个分块备份复用。这里不再把所有引用加载进一个 Set，
  // 避免数据量大时触发 Worker 128 MB 限制；共享对象由独立、可分页的 GC 任务处理。
  return {deleted:stale.length,reclaimed_objects:0};
}

async function runDeleteFolderWorkflow(env:Bindings,step:WorkflowStep,jobId:string,folderId:number){
  const total=await step.do('统计待删除图片',async()=>{
    const row=await env.DB.prepare('SELECT COUNT(*) AS count FROM images WHERE folder_id=?').bind(folderId).first<{count:number}>();
    await updateMaintenanceJob(env,jobId,'running',{progress:0,total:Number(row?.count||0)});
    return Number(row?.count||0);
  });
  let lastId=0,deleted=0,page=0;
  while(true){
    const images=await step.do(`读取文件夹图片-${page}`,async()=>{
      const rows=await env.DB.prepare('SELECT id FROM images WHERE folder_id=? AND id>? ORDER BY id LIMIT 50').bind(folderId,lastId).all<{id:number}>();
      return rows.results;
    });
    if(!images.length)break;
    for(const item of images){
      await step.do(`删除文件夹图片-${item.id}`,{retries:{limit:4,delay:'3 seconds',backoff:'exponential'},timeout:'2 minutes'},async()=>{
        const record=await env.DB.prepare('SELECT * FROM images WHERE id=? AND folder_id=?').bind(item.id,folderId).first<any>();
        if(record)await deleteStoredImage(env,record);
        return {id:item.id,deleted:Boolean(record)};
      });
      deleted++;
      lastId=item.id;
    }
    await step.do(`更新文件夹删除进度-${page}`,()=>updateMaintenanceJob(env,jobId,'running',{progress:Math.min(deleted,total),total}));
    page++;
  }
  await step.do('完成文件夹删除',async()=>{
    await env.DB.batch([
      env.DB.prepare("UPDATE share_links SET revoked_at=datetime('now') WHERE target_type='folder' AND target_id=? AND revoked_at IS NULL").bind(folderId),
      env.DB.prepare('DELETE FROM image_folders WHERE id=?').bind(folderId)
    ]);
    await updateMaintenanceJob(env,jobId,'completed',{progress:total,total,result:{deleted}});
  });
  return {deleted};
}

async function runReconcileImagesWorkflow(env:Bindings,step:WorkflowStep,jobId:string){
  const total=await step.do('统计待对账图片',async()=>{
    const row=await env.DB.prepare("SELECT COUNT(*) AS count FROM images WHERE storage='r2'").first<{count:number}>();
    await updateMaintenanceJob(env,jobId,'running',{progress:0,total:Number(row?.count||0)});
    return Number(row?.count||0);
  });
  let lastId=0,checked=0,removed=0,page=0;
  while(true){
    const rows=await step.do(`读取对账图片-${page}`,async()=>{
      const result=await env.DB.prepare("SELECT id,key FROM images WHERE storage='r2' AND id>? ORDER BY id LIMIT 50").bind(lastId).all<{id:number;key:string}>();
      return result.results;
    });
    if(!rows.length)break;
    for(const row of rows){
      const result=await step.do(`对账图片-${row.id}`,{retries:{limit:3,delay:'2 seconds'},timeout:'1 minute'},async()=>{
        if(await env.BUCKET.head(row.key))return {removed:false};
        const record=await env.DB.prepare('SELECT * FROM images WHERE id=?').bind(row.id).first<any>();
        if(record)await deleteStoredImage(env,record);
        return {removed:Boolean(record)};
      });
      if(result.removed)removed++;
      checked++;
      lastId=row.id;
    }
    await step.do(`更新图片对账进度-${page}`,()=>updateMaintenanceJob(env,jobId,'running',{progress:checked,total}));
    page++;
  }

  let cursor:string|null=null,orphanCount=0,r2Page=0;
  do{
    const result=await step.do(`检查孤立对象-${r2Page}`,async()=>{
      const listed=await env.BUCKET.list({prefix:'charts/',cursor:cursor||undefined,limit:100});
      const checks=listed.objects.length?await env.DB.batch(listed.objects.map(object=>env.DB.prepare('SELECT id FROM images WHERE key=? LIMIT 1').bind(object.key))):[];
      const orphans=listed.objects.reduce((count,_object,index)=>count+(checks[index]?.results?.length?0:1),0);
      return {orphans,cursor:listed.truncated?listed.cursor:null};
    });
    orphanCount+=result.orphans;
    cursor=result.cursor;
    r2Page++;
  }while(cursor);

  const final={removed_stale_records:removed,orphan_r2_objects:orphanCount};
  await step.do('完成图片对账',()=>updateMaintenanceJob(env,jobId,'completed',{progress:total,total,result:final}));
  return final;
}

export class BackupWorkflow extends WorkflowEntrypoint<Bindings,BackupWorkflowParams>{
  async run(event:Readonly<WorkflowEvent<BackupWorkflowParams>>,step:WorkflowStep){
    const params=event.payload||{},id=params.backupId||event.instanceId;
    const action=params.action||'backup';
    if(action==='delete_folder'){
      if(!params.jobId||!Number.isInteger(params.folderId)||Number(params.folderId)<=0)throw new Error('文件夹删除任务参数无效');
      try{return await runDeleteFolderWorkflow(this.env,step,params.jobId,Number(params.folderId));}
      catch(error){await updateMaintenanceJob(this.env,params.jobId,'failed',{error:String(error instanceof Error?error.message:error).slice(0,500)});throw error;}
    }
    if(action==='reconcile_images'){
      if(!params.jobId)throw new Error('图片对账任务参数无效');
      try{return await runReconcileImagesWorkflow(this.env,step,params.jobId);}
      catch(error){await updateMaintenanceJob(this.env,params.jobId,'failed',{error:String(error instanceof Error?error.message:error).slice(0,500)});throw error;}
    }
    if(action==='verify_backup'){
      if(!params.jobId||!params.backupId)throw new Error('备份校验任务参数无效');
      try{
        await step.do('登记备份校验任务',()=>updateMaintenanceJob(this.env,params.jobId!,'running',{progress:0,total:1}));
        const result=await verifyBackupWithSteps(this.env,step,params.backupId,'手动校验');
        await step.do('完成备份校验',()=>updateMaintenanceJob(this.env,params.jobId!,'completed',{progress:1,total:1,result}));
        return result;
      }catch(error){
        await updateMaintenanceJob(this.env,params.jobId,'failed',{error:String(error instanceof Error?error.message:error).slice(0,500)});
        throw error;
      }
    }
    if(action==='restore_backup'){
      if(!params.jobId||!params.backupId)throw new Error('备份恢复任务参数无效');
      try{
        await step.do('登记恢复任务',()=>updateMaintenanceJob(this.env,params.jobId!,'running',{progress:0,total:3}));
        await verifyBackupWithSteps(this.env,step,params.backupId,'恢复目标');
        await step.do('更新恢复校验进度',()=>updateMaintenanceJob(this.env,params.jobId!,'running',{progress:1,total:3}));
        const safetyMeta=await step.do('登记恢复前安全备份',async()=>{
          const target=await this.env.DB.prepare('SELECT label FROM backups WHERE id=?').bind(params.backupId).first<{label:string}>();
          const safetyId=crypto.randomUUID(),safetyLabel=`恢复前自动备份 · ${target?.label||params.backupId}`.slice(0,80);
          await this.env.DB.prepare('INSERT OR IGNORE INTO backups(id,label,status,manifest_key,backup_mode) VALUES(?,?,?,?,?)').bind(safetyId,safetyLabel,'running',`${BACKUP_PREFIX}${safetyId}/manifest.json`,'incremental').run();
          return {id:safetyId,label:safetyLabel};
        });
        const safety=await runChunkedBackup(this.env,step,safetyMeta.id,safetyMeta.label,'恢复前备份');
        await step.do('更新安全备份进度',()=>updateMaintenanceJob(this.env,params.jobId!,'running',{progress:2,total:3}));
        const targetManifestText=await step.do('读取恢复清单',async()=>{
          const object=await this.env.BUCKET.get(`${BACKUP_PREFIX}${params.backupId}/manifest.json`);if(!object)throw new Error('备份清单不存在');
          return object.text();
        });
        const targetManifest=JSON.parse(targetManifestText) as BackupManifest;
        const result=isChunkedBackup(targetManifest)
          ?await restoreChunkedBackupWithSteps(this.env,step,targetManifest,safety.id)
          :await step.do('应用旧版完整备份',{retries:{limit:2,delay:'10 seconds',backoff:'exponential'},timeout:'30 minutes'},()=>restoreFullBackup(this.env,params.backupId!,safety));
        await step.do('完成备份恢复',()=>updateMaintenanceJob(this.env,params.jobId!,'completed',{progress:3,total:3,result}));
        return result;
      }catch(error){
        await updateMaintenanceJob(this.env,params.jobId,'failed',{error:String(error instanceof Error?error.message:error).slice(0,500)});
        throw error;
      }
    }
    const label=(params.label||`${event.schedule?'自动定时备份':'完整备份'} ${new Date(event.timestamp).toLocaleDateString('zh-CN')}`).slice(0,80);
    try{
      await step.do('登记备份任务',{retries:{limit:3,delay:'2 seconds'},timeout:'1 minute'},async()=>{
        await this.env.DB.prepare('INSERT OR IGNORE INTO backups(id,label,status,manifest_key,workflow_instance_id,backup_mode) VALUES(?,?,?,?,?,?)').bind(id,label,'running',`${BACKUP_PREFIX}${id}/manifest.json`,event.instanceId,'incremental').run();
        return {id};
      });
      const result=await runChunkedBackup(this.env,step,id,label,'主备份');
      const verification=await verifyBackupWithSteps(this.env,step,id,'主备份');
      const retention=await step.do('执行保留策略',{retries:{limit:2,delay:'5 seconds'},timeout:'10 minutes'},async()=>{
        const config=await getAllConfig(this.env.DB,this.env.CONFIG_ENCRYPTION_KEY);
        const keep=Math.max(1,Math.min(30,Number(params.retention)||Number(config.backup_retention)||7));
        return pruneBackups(this.env,keep);
      });
      return {result,verification,retention};
    }catch(error){
      await this.env.DB.prepare("UPDATE backups SET status='failed',error=?,completed_at=datetime('now') WHERE id=?").bind(String(error instanceof Error?error.message:error).slice(0,500),id).run();
      throw error;
    }
  }
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function restoreBackupTables(db: D1Database, tables: Record<BackupTable,Record<string,unknown>[]>): Promise<void> {
  const addedLater=new Set<BackupTable>(['trade_strategy_snapshots','trade_rule_checks','image_folders','daily_chart_images','share_links']);
  for (const table of BACKUP_TABLES) if (!Array.isArray(tables[table])) {
    if(addedLater.has(table))tables[table]=[];
    else throw new Error(`备份缺少数据表：${table}`);
  }
  await db.batch([
    db.prepare('DELETE FROM sessions'),
    db.prepare('DELETE FROM login_attempts'),
    ...BACKUP_DELETE_ORDER.map(table => db.prepare(`DELETE FROM ${table}`))
  ]);
  for (const table of BACKUP_TABLES) {
    const rows = tables[table];
    for (let offset = 0; offset < rows.length; offset += 50) {
      const statements = rows.slice(offset, offset + 50).map(row => {
        const columns = Object.keys(row).filter(column => /^[a-z_]+$/.test(column));
        if (!columns.length) throw new Error(`数据表 ${table} 包含无效记录`);
        return db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
          .bind(...columns.map(column => row[column] ?? null));
      });
      if (statements.length) await db.batch(statements);
    }
  }
}

async function restoreChunkedBackupWithSteps(env:Bindings,step:WorkflowStep,manifest:ChunkedBackupManifest,safetyId:string){
  await step.do('恢复-清空当前数据库',{retries:{limit:3,delay:'3 seconds'},timeout:'5 minutes'},async()=>{
    await env.DB.batch([env.DB.prepare('DELETE FROM sessions'),env.DB.prepare('DELETE FROM login_attempts'),...BACKUP_DELETE_ORDER.map(table=>env.DB.prepare(`DELETE FROM ${table}`))]);
    return {cleared:true};
  });
  let restoredRows=0;
  for(let index=0;index<manifest.table_chunks.length;index++){
    const chunk=manifest.table_chunks[index];
    const result=await step.do(`恢复-数据块-${index}`,{retries:{limit:4,delay:'3 seconds',backoff:'exponential'},timeout:'5 minutes'},async()=>{
      const object=await env.BUCKET.get(chunk.key);if(!object)throw new Error(`备份数据块缺失：${chunk.key}`);
      const rows=await object.json<Record<string,unknown>[]>();
      for(let offset=0;offset<rows.length;offset+=50){
        const statements=rows.slice(offset,offset+50).map(row=>{
          const columns=Object.keys(row).filter(column=>/^[a-z_]+$/.test(column));
          if(!columns.length)throw new Error(`数据表 ${chunk.table} 包含无效记录`);
          return env.DB.prepare(`INSERT OR REPLACE INTO ${chunk.table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>row[column]??null));
        });
        if(statements.length)await env.DB.batch(statements);
      }
      return {rows:rows.length};
    });
    restoredRows+=result.rows;
  }

  let deletePage=0;
  while(true){
    const removed=await step.do(`恢复-清理当前图片-${deletePage}`,{retries:{limit:4,delay:'3 seconds'},timeout:'5 minutes'},async()=>{
      const page=await env.BUCKET.list({prefix:'charts/',limit:500});
      if(page.objects.length)await env.BUCKET.delete(page.objects.map(object=>object.key));
      return page.objects.length;
    });
    if(!removed)break;
    deletePage++;
  }

  let restoredObjects=0;
  for(let index=0;index<manifest.object_chunks.length;index++){
    const chunk=manifest.object_chunks[index];
    const result=await step.do(`恢复-对象块-${index}`,{retries:{limit:4,delay:'5 seconds',backoff:'exponential'},timeout:'10 minutes'},async()=>{
      const page=await env.BUCKET.get(chunk.key);if(!page)throw new Error(`备份对象清单缺失：${chunk.key}`);
      const objects=await page.json<BackupObject[]>();
      for(const item of objects){
        const source=await env.BUCKET.get(item.backup_key);if(!source||!('body' in source))throw new Error(`备份文件缺失：${item.key}`);
        await env.BUCKET.put(item.key,source.body,{httpMetadata:source.httpMetadata,customMetadata:source.customMetadata});
      }
      return {objects:objects.length};
    });
    restoredObjects+=result.objects;
  }
  return {success:true,safety_backup_id:safetyId,restored_rows:restoredRows,restored_objects:restoredObjects};
}

async function restoreFullBackup(env: Bindings, backupId: string, safety:{id:string}) {
  const record = await env.DB.prepare("SELECT * FROM backups WHERE id=? AND status='completed'").bind(backupId).first<any>();
  if (!record?.manifest_key) throw new Error('备份不存在或尚未完成');
  const manifestObject = await env.BUCKET.get(String(record.manifest_key));
  if (!manifestObject || !('body' in manifestObject)) throw new Error('备份清单不存在');
  const manifest = await manifestObject.json<BackupManifest>();
  if (manifest.format !== 'trading-journal-full-backup' || ![1,2,3].includes(manifest.version) || manifest.id !== backupId || isChunkedBackup(manifest)) throw new Error('备份格式或校验信息无效');

  await verifyFullBackup(env,backupId);

  try {
    await restoreBackupTables(env.DB, manifest.tables);
    while(true){
      const current=await env.BUCKET.list({prefix:'charts/',limit:1000});
      if(!current.objects.length)break;
      await env.BUCKET.delete(current.objects.map(object=>object.key));
    }
    for (const item of manifest.objects) {
      const source = await env.BUCKET.get(item.backup_key);
      if (!source || !('body' in source)) throw new Error(`备份文件缺失：${item.key}`);
      await env.BUCKET.put(item.key, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}。恢复可能只完成了一部分，请使用恢复前安全备份 ${safety.id} 重试`);
  }
  return { success:true,safety_backup_id:safety.id,restored_rows:Object.values(manifest.tables).reduce((sum,rows)=>sum+rows.length,0),restored_objects:manifest.objects.length };
}

app.get('/api/backups', async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id,label,status,table_count,row_count,object_count,reused_object_count,total_size,error,workflow_instance_id,verified_at,created_at,completed_at FROM backups ORDER BY created_at DESC LIMIT 100`).all();
  return c.json(rows.results);
});

app.post('/api/backups', async (c) => {
  await c.env.DB.prepare("UPDATE backups SET status='failed',error='任务超时，请删除后重试',completed_at=datetime('now') WHERE status='running' AND created_at < datetime('now','-30 minutes')").run();
  const running = await c.env.DB.prepare("SELECT id FROM backups WHERE status='running' LIMIT 1").first();
  if (running) return c.json({ error:'已有备份任务正在运行' },409);
  const body = await c.req.json<any>().catch(() => ({}));
  const id=crypto.randomUUID(),label=String(body?.label||'').trim().slice(0,80)||`完整备份 ${new Date().toLocaleDateString('zh-CN')}`,manifestKey=`${BACKUP_PREFIX}${id}/manifest.json`;
  try {
    await c.env.DB.prepare('INSERT INTO backups(id,label,status,manifest_key,workflow_instance_id,backup_mode) VALUES(?,?,?,?,?,?)').bind(id,label,'running',manifestKey,id,'incremental').run();
    await c.env.BACKUP_WORKFLOW.create({id,params:{backupId:id,label,retention:Math.max(1,Math.min(30,Number(body?.retention)||7))},retention:{successRetention:'14 days',errorRetention:'30 days'},locationHint:'apac'});
    return c.json({id,label,status:'running',workflow_instance_id:id},202);
  }
  catch (error) { const reason=error instanceof Error?error.message:String(error);await c.env.DB.prepare("UPDATE backups SET status='failed',error=?,completed_at=datetime('now') WHERE id=?").bind(reason.slice(0,500),id).run();return c.json({ error:`完整备份失败：${reason}` },500); }
});

app.post('/api/backups/:id/verify',async(c)=>{
  const backupId=c.req.param('id');
  const backup=await c.env.DB.prepare("SELECT id FROM backups WHERE id=? AND status='completed'").bind(backupId).first();
  if(!backup)return c.json({error:'备份不存在或尚未完成'},404);
  const jobId=await createMaintenanceJob(c.env,'verify_backup',backupId);
  try{
    await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'verify_backup',jobId,backupId},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});
    return c.json({success:true,status:'queued',job_id:jobId},202);
  }catch(error){
    await updateMaintenanceJob(c.env,jobId,'failed',{error:error instanceof Error?error.message:String(error)});
    return c.json({error:'无法启动备份校验任务'},500);
  }
});

app.post('/api/backups/:id/restore', async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  if (body?.confirm !== 'RESTORE') return c.json({ error:'恢复确认无效' },400);
  const backupId=c.req.param('id');
  const backup=await c.env.DB.prepare("SELECT id FROM backups WHERE id=? AND status='completed'").bind(backupId).first();
  if(!backup)return c.json({error:'备份不存在或尚未完成'},404);
  const jobId=await createMaintenanceJob(c.env,'restore_backup',backupId);
  try{
    await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'restore_backup',jobId,backupId},retention:{successRetention:'14 days',errorRetention:'30 days'},locationHint:'apac'});
    return c.json({success:true,status:'queued',job_id:jobId,requires_relogin:true},202);
  }catch(error){
    await updateMaintenanceJob(c.env,jobId,'failed',{error:error instanceof Error?error.message:String(error)});
    return c.json({error:'无法启动备份恢复任务'},500);
  }
});

app.delete('/api/backups/:id', async (c) => {
  const id = c.req.param('id');
  const record = await c.env.DB.prepare('SELECT id FROM backups WHERE id=?').bind(id).first();
  if (!record) return c.json({ error:'备份不存在' },404);
  await deleteR2Prefix(c.env.BUCKET,`${BACKUP_PREFIX}${id}/`);
  await c.env.DB.prepare('DELETE FROM backups WHERE id=?').bind(id).run();
  return c.json({ success:true });
});

// ===================== MCP JSON-RPC 端点 =====================

async function deleteMindmapNodesById(db: D1Database, ids: number[]): Promise<void> {
  for (let offset = ids.length; offset > 0; offset -= 50) {
    const chunk = ids.slice(Math.max(0,offset - 50),offset).reverse();
    if (chunk.length) await db.batch(chunk.map(nodeId => db.prepare('DELETE FROM trading_system_nodes WHERE id=?').bind(nodeId)));
  }
}

async function insertMindmapBatchNodes(db: D1Database, systemId: number, anchorId: number, nodes: MindmapBatchNode[]) {
  const typeRows = await db.prepare("SELECT value FROM settings WHERE category='system_node_type' AND is_active=1").all<{value:string}>();
  const availableTypes = new Set(typeRows.results.map(row => row.value));
  for (const node of nodes) if (!availableTypes.has(node.nodeType)) throw new Error(`节点 ${node.ref} 使用了不存在或未启用的类型：${node.nodeType}`);
  const idsByRef = new Map<string,number>();
  const createdIds: number[] = [];
  const maxDepth = Math.max(...nodes.map(node => node.depth));
  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      const layer = nodes.filter(node => node.depth === depth);
      const statements = layer.map(node => db.prepare(
        `INSERT INTO trading_system_nodes(system_id,parent_id,rule_id,title,content,node_type,sort_order) VALUES(?,?,?,?,?,?,?)`
      ).bind(systemId,node.parentRef ? idsByRef.get(node.parentRef)! : anchorId,node.ruleId,node.title,node.content,node.nodeType,node.sortOrder));
      const results = await db.batch(statements);
      results.forEach((result,index) => {
        const nodeId = Number(result.meta.last_row_id);
        idsByRef.set(layer[index].ref,nodeId);
        createdIds.push(nodeId);
      });
    }
    await db.prepare("UPDATE trading_systems SET updated_at=datetime('now') WHERE id=?").bind(systemId).run();
    return {
      created: createdIds.length,
      node_ids: Object.fromEntries(idsByRef),
      max_depth: maxDepth,
      top_level_count: nodes.filter(node => node.depth === 1).length
    };
  } catch (error) {
    await deleteMindmapNodesById(db,createdIds);
    throw error;
  }
}

// base64 → ArrayBuffer
export function base64ToArrayBuffer(base64: string, maxBytes = MAX_IMAGE_SIZE): ArrayBuffer {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new Error('Base64 格式无效');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(clean.length * 3 / 4) - padding;
  if (estimatedBytes > maxBytes) throw new Error('图片不能超过 10MB');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// 从 MIME 或文件名推断类型
function inferMime(filename: string, provided?: string): string {
  if (provided && ALLOWED_IMAGE_TYPES.includes(provided)) return provided;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  return map[ext] || 'image/png';
}

app.get('/api/mcp', (c) => c.json({
  error: 'MCP 端点仅接受 POST JSON-RPC 请求'
}, 405, { Allow: 'POST, OPTIONS' }));

app.post('/api/mcp', async (c) => {
  const db = c.env.DB;

  const enabled = await db.prepare("SELECT config_value FROM app_config WHERE config_key = 'mcp_enabled'")
    .first<{ config_value: string | null }>();
  if (enabled?.config_value === 'false') {
    return c.json(jsonRpcError(-32004, 'MCP service is disabled', null), 503);
  }

  // 验证身份
  const auth = await authenticateMcpRequest(c);
  if (!auth.authorized) {
    return c.json(auth.error, 401);
  }

  // 写权限校验
  let body: JsonRpcRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(-32700, 'Parse error: invalid JSON', null), 400);
  }

  // 校验 JSON-RPC 2.0
  if (body.jsonrpc !== '2.0' || !body.method) {
    return c.json(jsonRpcError(-32600, 'Invalid Request: must be valid JSON-RPC 2.0', body.id ?? null), 400);
  }

  const { method: rawMethod, params, id } = body;
  if (id === undefined || id === null) {
    // 通知类请求，无需响应
    return new Response(null, { status: 204 });
  }

  const headerVersion = c.req.header('MCP-Protocol-Version');
  const metaVersion = params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const requestedProtocolVersion = String(metaVersion || headerVersion || '');
  if (requestedProtocolVersion && !MCP_SUPPORTED_VERSIONS.includes(requestedProtocolVersion)) {
    return c.json(jsonRpcError(-32022, `Unsupported protocol version: ${requestedProtocolVersion}`, id, {
      supportedVersions: MCP_SUPPORTED_VERSIONS
    }), 400);
  }
  if (headerVersion && metaVersion && headerVersion !== metaVersion) {
    return c.json(jsonRpcError(-32020, 'MCP protocol version header does not match request metadata', id), 400);
  }

  // 标准 MCP 协议方法名兼容（斜杠风格 → 下划线风格）
  const METHOD_ALIASES: Record<string, string> = {
    'tools/list': 'tools_list'
  };
  const method = METHOD_ALIASES[rawMethod] || rawMethod;

  // 2026-07-28 无状态发现；旧客户端继续使用 initialize。
  if (method === 'server/discover') {
    return c.json(jsonRpcResult({
      supportedVersions: [MCP_MODERN_VERSION],
      capabilities: { tools: { listChanged: false } },
      instructions: MCP_INSTRUCTIONS,
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO }
    }, id));
  }

  // 标准 MCP 协议方法（initialize / ping / tools/call）
  if (method === 'initialize') {
    const requestedVersion = String(params?.protocolVersion || '');
    const protocolVersion = MCP_LEGACY_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : MCP_LEGACY_VERSIONS[0];
    return c.json(jsonRpcResult({
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
      instructions: MCP_INSTRUCTIONS
    }, id));
  }
  if (method === 'ping') {
    return c.json(jsonRpcResult({ resultType: 'complete' }, id));
  }
  if (method === 'tools/call') {
    const toolName = String(params?.name || '');
    const toolArgs = params?.arguments || {};
    if (!toolName || !MCP_TOOLS.some(tool => tool.name === toolName)) {
      return c.json(jsonRpcError(-32602, `Invalid params: unknown tool "${toolName}"`, id), 400);
    }
    // 内部转发：复用完整处理器（含权限校验与 base64 附图逻辑）
    const innerReq = new Request(new URL('/api/mcp', c.req.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': c.req.header('Authorization') || '',
        ...(headerVersion ? { 'MCP-Protocol-Version': headerVersion } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `inner-${Date.now()}`, method: toolName, params: toolArgs })
    });
    const innerRes = await app.request(innerReq, undefined, c.env);
    let inner: JsonRpcResponse;
    try {
      inner = await innerRes.json() as JsonRpcResponse;
    } catch {
      return c.json(jsonRpcError(-32000, `Tool execution failed with status ${innerRes.status}`, id), 500);
    }
    if (inner.error) {
      return c.json(jsonRpcResult({
        content: [{ type: 'text', text: `Error: ${inner.error.message}` }],
        isError: true,
        resultType: 'complete'
      }, id));
    }
    return c.json(jsonRpcResult({
      content: [{ type: 'text', text: JSON.stringify(inner.result, null, 2) }],
      structuredContent: inner.result,
      isError: false,
      resultType: 'complete'
    }, id));
  }

  if (method !== 'tools_list' && !MCP_TOOLS.some(tool => tool.name === method)) {
    return c.json(jsonRpcError(-32601, `Method not found: ${method}`, id), 404);
  }

  // 写方法需要 write / admin 权限
  if (MCP_WRITE_METHODS.has(method) && auth.permissions === 'read') {
    return c.json(jsonRpcError(-32002, 'Forbidden: this method requires write permission (token is read-only)', id), 403);
  }

  try {
    switch (method) {
      // ---------- meta ----------
      case 'tools_list': {
        // 同时提供 description（标准 MCP）与 desc（兼容旧客户端），附 inputSchema
        const tools = MCP_TOOLS.map(t => ({
          name: t.name,
          description: t.desc,
          desc: t.desc,
          inputSchema: t.inputSchema || { type: 'object', properties: {} }
        }));
        return c.json(jsonRpcResult({ tools, permissions: auth.permissions, resultType: 'complete' }, id));
      }

      // ---------- trades ----------
      case 'list_trades': {
        const p = params || {};
        const page = parseInt(p.page) || 1;
        const limit = Math.min(parseInt(p.limit) || 50, 200);
        const offset = (page - 1) * limit;

        let where = 'WHERE 1=1';
        const queryParams: any[] = [];

        if (p.symbol) { where += ' AND symbol = ?'; queryParams.push(p.symbol); }
        if (p.result) { where += ' AND result = ?'; queryParams.push(p.result); }
        if (p.month) {
          const b = monthBounds(p.month);
          where += ' AND entry_time >= ? AND entry_time < ?';
          queryParams.push(b.start, b.end);
        }

        const countSql = `SELECT COUNT(*) as total FROM trades ${where}`;
        const countResult = await db.prepare(countSql).bind(...queryParams).first<{ total: number }>();
        const total = countResult?.total || 0;

        const sql = `SELECT t.*, s.name AS trading_system_name,dc.image_url AS daily_chart_image
          FROM trades t LEFT JOIN trading_systems s ON s.id = t.trading_system_id
          LEFT JOIN daily_chart_images dc ON dc.trade_date=substr(t.entry_time,1,10)
          ${where} ORDER BY t.entry_time DESC LIMIT ? OFFSET ?`;
        const trades = await db.prepare(sql).bind(...queryParams, limit, offset).all();

        const tradeRows = (trades.results as any[]).map(trade => ({
          ...trade,
          daily_chart_image: absoluteUrl(c.req.url, trade.daily_chart_image)
        }));
        return c.json(jsonRpcResult({ trades: tradeRows, total, page, limit }, id));
      }

      case 'get_trade': {
        if (!params || !params.id) {
          return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        }
        const trade = await db.prepare(
          `SELECT t.*,COALESCE(ss.system_name,s.name) AS trading_system_name,dc.image_url AS daily_chart_image,ss.version_id AS strategy_version_id,ss.created_at AS strategy_snapshot_at,CASE WHEN ss.id IS NULL THEN 0 ELSE 1 END AS strategy_snapshot_locked
           FROM trades t LEFT JOIN trading_systems s ON s.id = t.trading_system_id LEFT JOIN trade_strategy_snapshots ss ON ss.trade_id=t.id LEFT JOIN daily_chart_images dc ON dc.trade_date=substr(t.entry_time,1,10) WHERE t.id = ?`
        ).bind(String(params.id)).first();
        if (!trade) {
          return c.json(jsonRpcError(-32000, 'Trade not found', id), 404);
        }
        return c.json(jsonRpcResult({
          ...trade as any,
          daily_chart_image: absoluteUrl(c.req.url, (trade as any).daily_chart_image)
        }, id));
      }

      case 'add_trade': {
        if (!params || !params.symbol || !params.entry_time) {
          return c.json(jsonRpcError(-32602, 'Invalid params: symbol and entry_time are required', id), 400);
        }
        const { symbol, code, lots, entry_price, exit_price, direction, timeframe, entry_time, trading_system_id, trade_type,
          market_cycle, patterns, trade_logic, exit_type, return_amount,
          risk_reward_ratio, result } = params;
        const review = params.notes ?? params.review ?? null;

        const sql = `INSERT INTO trades (symbol, code, entry_time, lots, entry_price, exit_price, direction, timeframe, trading_system_id,
          trade_type, market_cycle, patterns, trade_logic, exit_type, return_amount,
          risk_reward_ratio, result, review)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const res = await db.prepare(sql).bind(
          symbol || 'XAUUSD', code || null, entry_time || null,
          lots || 1, entry_price ?? null, exit_price ?? null,
          direction || '多', normalizeTradeTimeframes(timeframe, '5M'),
          trading_system_id || null,
          trade_type || null, market_cycle || null, patterns || null,
          trade_logic || null, exit_type || null, return_amount ?? null,
          risk_reward_ratio ?? null, result || null, review || null
        ).run();

        const tradeId=Number(res.meta.last_row_id);
        await captureTradeStrategySnapshot(db,tradeId,trading_system_id?Number(trading_system_id):null);
        await updateMonthlyStats(db, entry_time);

        return c.json(jsonRpcResult({ id: tradeId, success: true }, id));
      }

      case 'update_trade': {
        if (!params || !params.id) {
          return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        }
        const tradeId = params.id;
        const fields: string[] = [];
        const values: any[] = [];

        const updatable = ['symbol', 'code', 'entry_time', 'lots', 'entry_price', 'exit_price', 'direction', 'timeframe', 'trading_system_id',
          'trade_type', 'market_cycle', 'patterns', 'trade_logic', 'exit_type',
          'return_amount', 'risk_reward_ratio', 'result', 'review'];

        for (const field of updatable) {
          if (params[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(field === 'timeframe' ? normalizeTradeTimeframes(params[field], '5M') : params[field]);
          }
        }
        if (params.notes !== undefined) {
          const idx = fields.indexOf('review = ?');
          if (idx >= 0) values[idx] = params.notes;
          else { fields.push('review = ?'); values.push(params.notes); }
        }

        if (fields.length === 0) {
          return c.json(jsonRpcError(-32602, 'No fields to update', id), 400);
        }

        // 记录更新前的 entry_time，跨月时重建正确月份统计
        const beforeT = await db.prepare('SELECT entry_time,trading_system_id FROM trades WHERE id = ?').bind(String(tradeId)).first<{ entry_time: string;trading_system_id:number|null }>();

        if(fields.length){
          fields.push("updated_at = datetime('now')");
          values.push(tradeId);
          const sql = `UPDATE trades SET ${fields.join(', ')} WHERE id = ?`;
          await db.prepare(sql).bind(...values).run();
        }
        if(params.trading_system_id!==undefined)await captureTradeStrategySnapshot(db,Number(tradeId),params.trading_system_id?Number(params.trading_system_id):null);
        const afterT = await db.prepare('SELECT entry_time FROM trades WHERE id = ?').bind(String(tradeId)).first<{ entry_time: string }>();
        const mSet = new Set<string>();
        if (beforeT?.entry_time) mSet.add(String(beforeT.entry_time).substring(0, 7));
        if (afterT?.entry_time) mSet.add(String(afterT.entry_time).substring(0, 7));
        for (const m of mSet) await rebuildMonth(db, m);

        return c.json(jsonRpcResult({ success: true }, id));
      }

      case 'delete_trade': {
        if (!params || !params.id) {
          return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        }
        const tradeDel = await db.prepare('SELECT entry_time FROM trades WHERE id = ?').bind(String(params.id)).first<{ entry_time: string }>();
        if (!tradeDel) {
          return c.json(jsonRpcError(-32000, 'Trade not found', id), 404);
        }
        await db.prepare('DELETE FROM trades WHERE id = ?').bind(String(params.id)).run();
        if (tradeDel.entry_time) {
          await updateMonthlyStats(db, tradeDel.entry_time);
        }
        return c.json(jsonRpcResult({ success: true }, id));
      }

      // ---------- images ----------
      case 'upload_chart_image': {
        if (!params || !params.image_base64 || !params.trade_date) {
          return c.json(jsonRpcError(-32602, 'Invalid params: image_base64 and trade_date are required', id), 400);
        }
        const tradeDate = String(params.trade_date);
        const validDate = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(tradeDate)
          && new Date(`${tradeDate}T00:00:00.000Z`).toISOString().slice(0, 10) === tradeDate;
        if (!validDate) return c.json(jsonRpcError(-32602, 'Invalid params: trade_date must be a valid YYYY-MM-DD date', id), 400);
        const filename = params.filename || `mcp-chart-${Date.now()}.png`;
        const mime = inferMime(filename, params.mime_type);

        let buffer: ArrayBuffer;
        try {
          buffer = base64ToArrayBuffer(String(params.image_base64));
        } catch (err: any) {
          return c.json(jsonRpcError(-32000, `Invalid base64: ${err.message}`, id), 400);
        }

        const imageCategory = String(params.category || '').trim();
        if (!(await imageCategoryExists(db, imageCategory))) {
          return c.json(jsonRpcError(-32602, 'Invalid params: image category does not exist', id), 400);
        }
        let imageResourceUrl: string | null;
        try {
          imageResourceUrl = normalizeExternalUrl(params.resource_url);
        } catch (error) {
          return c.json(jsonRpcError(-32602, error instanceof Error ? error.message : 'Invalid resource URL', id), 400);
        }

        const stored = await storeImageBuffer(
          c.env,
          buffer,
          filename,
          mime,
          buffer.byteLength,
          params.caption || 'MCP K线图',
          {
            displayName: params.display_name ? String(params.display_name).trim() : undefined,
            category: imageCategory || undefined,
            tags: params.tags ? String(params.tags).trim() : undefined,
            resourceUrl: imageResourceUrl || undefined
          }
        );
        if (!stored.ok) {
          return c.json(jsonRpcError(-32000, `Upload failed: ${stored.error}`, id), 400);
        }
        await db.prepare(
          `INSERT INTO daily_chart_images (trade_date,image_id,image_url) VALUES (?,?,?)
           ON CONFLICT(trade_date) DO UPDATE SET image_id=excluded.image_id,image_url=excluded.image_url,updated_at=datetime('now')`
        ).bind(tradeDate, stored.id, stored.url).run();

        return c.json(jsonRpcResult({
          success: true,
          id: stored.id,
          key: stored.key,
          url: absoluteUrl(c.req.url, stored.url),
          public_id: stored.public_id,
          storage: stored.storage,
          tg_uploaded: stored.tg_uploaded || false,
          tg_error: stored.tg_error || null,
          trade_date: tradeDate,
          note: '该日期的全部交易会共用此图；url 可在线查看、分享或嵌入'
        }, id));
      }

      case 'list_images': {
        const p = params || {};
        const page = parseInt(p.page) || 1;
        const limit = Math.min(parseInt(p.limit) || 20, 100);
        const offset = (page - 1) * limit;

        const where: string[] = [];
        const values: any[] = [];
        if (p.uncategorized === true) {
          where.push("(category IS NULL OR TRIM(category) = '')");
        } else if (p.category) {
          where.push('category = ?'); values.push(String(p.category));
        }
        if (p.q) { where.push('(filename LIKE ? OR display_name LIKE ? OR caption LIKE ? OR tags LIKE ?)'); const like=`%${String(p.q)}%`; values.push(like,like,like,like); }
        const whereSql=where.length?`WHERE ${where.join(' AND ')}`:'';
        const countResult = await db.prepare(`SELECT COUNT(*) as total FROM images ${whereSql}`).bind(...values).first<{ total: number }>();
        const total = countResult?.total || 0;
        const images = await db.prepare(
          `SELECT id, key, public_id, storage, filename, display_name, category, tags, caption, resource_url, mime_type, size, tg_file_id, created_at FROM images ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).bind(...values, limit, offset).all();

        const results = (images.results as any[]).map(img => ({
          ...img,
          url: absoluteUrl(c.req.url, img.public_id ? `/i/${img.public_id}` : (img.storage === 'r2'
            ? `/api/image/r2/${encodeURIComponent(img.key)}`
            : `/api/image/tg/${encodeURIComponent(img.tg_file_id || img.key)}`))
        }));

        return c.json(jsonRpcResult({ images: results, total, page, limit }, id));
      }

      case 'get_image': {
        if (!params || (!params.id && !params.key)) {
          return c.json(jsonRpcError(-32602, 'Invalid params: id or key is required', id), 400);
        }
        const img = params.id
          ? await db.prepare('SELECT id, key, public_id, storage, filename, display_name, category, tags, caption, resource_url, mime_type, size, tg_file_id, created_at FROM images WHERE id = ?').bind(String(params.id)).first<any>()
          : await db.prepare('SELECT id, key, public_id, storage, filename, display_name, category, tags, caption, resource_url, mime_type, size, tg_file_id, created_at FROM images WHERE key = ?').bind(String(params.key)).first<any>();
        if (!img) {
          return c.json(jsonRpcError(-32000, 'Image not found', id), 404);
        }
        const url = absoluteUrl(c.req.url, img.public_id ? `/i/${img.public_id}` : (img.storage === 'r2'
          ? `/api/image/r2/${encodeURIComponent(img.key)}`
          : `/api/image/tg/${encodeURIComponent(img.tg_file_id || img.key)}`));
        return c.json(jsonRpcResult({ ...img, url }, id));
      }

      case 'get_stats': {
        const p = params || {};
        const period = p.period; // day | week | month | year | undefined(全部)
        let where = '';
        const sParams: any[] = [];

        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth() + 1;
        const pad = (n: number) => String(n).padStart(2, '0');
        const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const dayStart = (wkOffset = 0) => { const d = new Date(now); d.setDate(now.getDate() + wkOffset); return iso(d); };

        if (period === 'day') {
          where = 'WHERE entry_time >= ? AND entry_time < ?';
          sParams.push(dayStart(0), dayStart(1));
        } else if (period === 'week') {
          const dow = (now.getDay() + 6) % 7; // 周一=0
          where = 'WHERE entry_time >= ? AND entry_time < ?';
          sParams.push(dayStart(-dow), dayStart(7 - dow));
        } else if (period === 'month') {
          where = 'WHERE entry_time >= ? AND entry_time < ?';
          const ns = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
          sParams.push(`${y}-${pad(m)}-01`, ns);
        } else if (period === 'year') {
          where = 'WHERE entry_time >= ? AND entry_time < ?';
          sParams.push(`${y}-01-01`, `${y + 1}-01-01`);
        }

        const stats = await db.prepare(
          `SELECT COUNT(*) as total,
           SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN result = '败' THEN 1 ELSE 0 END) as losses,
           SUM(CASE WHEN result = '平' THEN 1 ELSE 0 END) as breakevens,
           COALESCE(SUM(return_amount), 0) as total_return,
           COALESCE(AVG(risk_reward_ratio), 0) as avg_rr
           FROM trades ${where}`
        ).bind(...sParams).first();
        return c.json(jsonRpcResult({ ...stats as any, period: period || 'all' }, id));
      }

      case 'get_trend': {
        const p = params || {};
        const granularity = p.granularity || 'month';
        const limit = Math.min(parseInt(p.limit) || 30, 120);
        const period = statsPeriodSql(granularity);
        if (!period) {
          return c.json(jsonRpcError(-32602, 'Invalid params: granularity must be day/week/month/year', id), 400);
        }
        const statement = db.prepare(
          `SELECT ${period.expression} as period,
            COUNT(*) as trades,
            SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result = '败' THEN 1 ELSE 0 END) as losses,
            COALESCE(SUM(return_amount), 0) as total_return,
            ROUND(AVG(risk_reward_ratio), 2) as avg_rr
           FROM trades
           WHERE entry_time IS NOT NULL AND entry_time != ''
           GROUP BY period ORDER BY period DESC LIMIT ?`
        );
        const series = period.format
          ? await statement.bind(period.format, limit).all()
          : await statement.bind(limit).all();
        return c.json(jsonRpcResult({ granularity, series: series.results }, id));
      }

      // ---------- rules ----------
      case 'list_rules': {
        const p = params || {};
        let where = 'WHERE 1=1';
        const ruleParams: any[] = [];
        if (p.category) { where += ' AND category = ?'; ruleParams.push(p.category); }
        if (typeof p.active === 'boolean') { where += ' AND is_active = ?'; ruleParams.push(p.active ? 1 : 0); }
        const sql = `SELECT * FROM trading_rules ${where} ORDER BY priority DESC, created_at DESC`;
        const rules = await db.prepare(sql).bind(...ruleParams).all();
        return c.json(jsonRpcResult(rules.results, id));
      }

      case 'add_rule': {
        const p = params || {};
        if (!String(p.title || '').trim() || !String(p.content || '').trim()) {
          return c.json(jsonRpcError(-32602, 'Invalid params: title and content are required', id), 400);
        }
        const res = await db.prepare(
          `INSERT INTO trading_rules (title, category, content, tags, is_active, priority)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          String(p.title).trim(), String(p.category || '入场规则').trim(), String(p.content).trim(),
          p.tags ? String(p.tags) : null, p.is_active === false ? 0 : 1, Number.isFinite(Number(p.priority)) ? Number(p.priority) : 0
        ).run();
        return c.json(jsonRpcResult({ id: res.meta.last_row_id, success: true }, id));
      }

      case 'update_rule': {
        const p = params || {};
        if (!p.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const fields: string[] = [];
        const values: any[] = [];
        for (const field of ['title', 'category', 'content', 'tags', 'priority', 'is_active']) {
          if (p[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(field === 'is_active' ? (p[field] ? 1 : 0) : p[field]);
          }
        }
        if (!fields.length) return c.json(jsonRpcError(-32602, 'No fields to update', id), 400);
        fields.push("updated_at = datetime('now')");
        values.push(String(p.id));
        const res = await db.prepare(`UPDATE trading_rules SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
        if (!res.meta.changes) return c.json(jsonRpcError(-32000, 'Rule not found', id), 404);
        return c.json(jsonRpcResult({ success: true, id: p.id }, id));
      }

      case 'list_systems': {
        const p = params || {};
        const validStatus = ['draft', 'active', 'archived'].includes(String(p.status || ''));
        const whereParts: string[] = ['s.is_template=0'];
        const values: string[] = [];
        if (validStatus) { whereParts.push('s.status = ?'); values.push(String(p.status)); }
        if (p.category) { whereParts.push('s.category = ?'); values.push(String(p.category)); }
        const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
        const systems = await db.prepare(
          `SELECT s.*, COUNT(DISTINCT n.id) AS node_count, COUNT(DISTINCT t.id) AS trade_count
           FROM trading_systems s
           LEFT JOIN trading_system_nodes n ON n.system_id = s.id
           LEFT JOIN trades t ON t.trading_system_id = s.id
           ${where} GROUP BY s.id
           ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, s.updated_at DESC`
        ).bind(...values).all();
        return c.json(jsonRpcResult(systems.results, id));
      }

      case 'get_system': {
        if (!params?.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const system = await db.prepare('SELECT * FROM trading_systems WHERE id = ?').bind(String(params.id)).first();
        if (!system) return c.json(jsonRpcError(-32000, 'Trading system not found', id), 404);
        const nodes = await db.prepare(
          `SELECT n.*, r.title AS rule_title, r.category AS rule_category, r.is_active AS rule_is_active
           FROM trading_system_nodes n LEFT JOIN trading_rules r ON r.id = n.rule_id
           WHERE n.system_id = ? ORDER BY n.sort_order ASC, n.id ASC`
        ).bind(String(params.id)).all();
        return c.json(jsonRpcResult({ system, nodes: nodes.results, quality:calculateMindmapQuality(nodes.results as Record<string,any>[]) }, id));
      }

      case 'create_detailed_mindmap': {
        const p = params || {};
        const name = String(p.name || '').trim();
        if (!name || name.length > 100) return c.json(jsonRpcError(-32602, 'Invalid params: name is required and must be <= 100 characters', id), 400);
        let nodes: MindmapBatchNode[];
        try { nodes = parseMindmapBatchNodes(p.nodes); }
        catch (error) { return c.json(jsonRpcError(-32602, `Detailed mind map validation failed: ${error instanceof Error ? error.message : String(error)}`, id),400); }
        const status = ['draft','active','archived'].includes(String(p.status)) ? String(p.status) : 'draft';
        const color = /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? String(p.color) : '#3ec9c5';
        const category = await resolveActiveMindmapCategory(db, p.category);
        if (!category) return c.json(jsonRpcError(-32602, 'Invalid params: mind map category does not exist or is disabled', id),400);
        let resourceUrl: string | null;
        try { resourceUrl = normalizeExternalUrl(p.resource_url); }
        catch (error) { return c.json(jsonRpcError(-32602,error instanceof Error ? error.message : 'Invalid resource URL',id),400); }
        const created = await db.prepare(
          `INSERT INTO trading_systems(name,category,description,resource_url,markets,timeframes,status,color) VALUES(?,?,?,?,?,?,?,?)`
        ).bind(name,category,p.description ? String(p.description) : null,resourceUrl,p.markets ? String(p.markets) : null,p.timeframes ? String(p.timeframes) : null,status,color).run();
        const systemId = Number(created.meta.last_row_id);
        const root = await db.prepare(`INSERT INTO trading_system_nodes(system_id,title,content,node_type,sort_order) VALUES(?,?,?,'root',0)`)
          .bind(systemId,name,p.description ? String(p.description) : '详细脑图根节点').run();
        const rootId = Number(root.meta.last_row_id);
        try {
          const report = await insertMindmapBatchNodes(db,systemId,rootId,nodes);
          return c.json(jsonRpcResult({
            success:true,id:systemId,system_id:systemId,root_id:rootId,
            node_count:report.created + 1,created_nodes:report.created,
            max_depth:report.max_depth + 1,top_level_count:report.top_level_count,
            node_ids:report.node_ids,
            quality:'detailed',message:'详细脑图已一次性创建；请调用 get_system 检查具体内容'
          },id));
        } catch (error) {
          await db.batch([
            db.prepare('DELETE FROM trading_system_nodes WHERE system_id=?').bind(systemId),
            db.prepare('DELETE FROM trading_systems WHERE id=?').bind(systemId)
          ]);
          return c.json(jsonRpcError(-32602,`Detailed mind map creation failed: ${error instanceof Error ? error.message : String(error)}`,id),400);
        }
      }

      case 'update_system': {
        const p = params || {};
        if (!p.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        if (p.status !== undefined && !['draft', 'active', 'archived'].includes(String(p.status))) {
          return c.json(jsonRpcError(-32602, 'Invalid status', id), 400);
        }
        if (p.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(p.color))) {
          return c.json(jsonRpcError(-32602, 'Invalid color', id), 400);
        }
        if (p.category !== undefined) {
          const category = await resolveActiveMindmapCategory(db, p.category);
          if (!category) return c.json(jsonRpcError(-32602, 'Invalid or disabled mind map category', id), 400);
          p.category = category;
        }
        if (p.resource_url !== undefined) {
          try { p.resource_url = normalizeExternalUrl(p.resource_url); }
          catch (error) { return c.json(jsonRpcError(-32602, error instanceof Error ? error.message : 'Invalid resource URL', id), 400); }
        }
        const fields: string[] = [];
        const values: any[] = [];
        for (const field of ['name', 'category', 'description', 'resource_url', 'markets', 'timeframes', 'status', 'color']) {
          if (p[field] !== undefined) { fields.push(`${field} = ?`); values.push(p[field]); }
        }
        if (!fields.length) return c.json(jsonRpcError(-32602, 'No fields to update', id), 400);
        fields.push("updated_at = datetime('now')");
        values.push(String(p.id));
        const result = await db.prepare(`UPDATE trading_systems SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
        if (!result.meta.changes) return c.json(jsonRpcError(-32000, 'Trading system not found', id), 404);
        if (p.name !== undefined) {
          await db.prepare("UPDATE trading_system_nodes SET title = ?, updated_at = datetime('now') WHERE system_id = ? AND parent_id IS NULL")
            .bind(String(p.name), String(p.id)).run();
        }
        return c.json(jsonRpcResult({ success: true, id: p.id }, id));
      }

      default:
        return c.json(jsonRpcError(-32601, `Method not found: ${method}`, id), 404);
    }
  } catch (err: any) {
    return c.json(jsonRpcError(-32603, `Internal error: ${err.message}`, id), 500);
  }
});

// ===================== 辅助函数 =====================

async function updateMonthlyStats(db: D1Database, entryTime: string | null) {
  if (!entryTime) return;
  await rebuildMonth(db, entryTime.substring(0, 7));
}

// 重建某个月的聚合统计（修复 #1 盈亏比公式、#2 跨月漂移、#3 范围查询）
async function rebuildMonth(db: D1Database, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const b = monthBounds(month);

  const stats = await db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) as win_count,
      SUM(CASE WHEN result = '败' THEN 1 ELSE 0 END) as loss_count,
      COALESCE(SUM(CASE WHEN return_amount > 0 THEN return_amount ELSE 0 END), 0) as gross_profit,
      COALESCE(SUM(CASE WHEN return_amount < 0 THEN return_amount ELSE 0 END), 0) as gross_loss,
      COALESCE(SUM(return_amount), 0) as total_return,
      COALESCE(ROUND(AVG(risk_reward_ratio), 2), 0) as avg_rr
    FROM trades
    WHERE entry_time >= ? AND entry_time < ?
  `).bind(b.start, b.end).first<any>();

  if (!stats || stats.total_trades === 0) {
    // 该月已无交易，清理 monthly_stats 中残留的行
    await db.prepare('DELETE FROM monthly_stats WHERE month = ?').bind(month).run();
    return;
  }

  const winRate = stats.total_trades > 0 ? (stats.win_count / stats.total_trades * 100) : 0;
  // 真实盈亏比 = 毛利 / 毛损；无亏损时视为 999
  const profitFactor = stats.gross_loss > 0
    ? stats.gross_profit / stats.gross_loss
    : stats.gross_profit > 0 ? 999 : 0;

  await db.prepare(`
    INSERT INTO monthly_stats (month, total_trades, win_count, loss_count, total_return, win_rate, avg_rr, profit_factor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      total_trades = excluded.total_trades,
      win_count = excluded.win_count,
      loss_count = excluded.loss_count,
      total_return = excluded.total_return,
      win_rate = excluded.win_rate,
      avg_rr = excluded.avg_rr,
      profit_factor = excluded.profit_factor,
      updated_at = datetime('now')
  `).bind(
    month, stats.total_trades, stats.win_count, stats.loss_count,
    stats.total_return, Math.round(winRate * 100) / 100,
    stats.avg_rr ?? 0, Math.round(profitFactor * 100) / 100
  ).run();
}

export default {
  async fetch(request:Request,env:Bindings,ctx:ExecutionContext){
    let session:D1DatabaseSession;
    try{session=env.DB.withSession(d1SessionConstraint(request));}
    catch{session=env.DB.withSession('first-primary');}
    const requestEnv:Bindings={...env,DB:sessionBackedDatabase(env.DB,session),REQUEST_DB_SESSION:session};
    const response=await app.fetch(request,requestEnv,ctx);
    const bookmark=session.getBookmark();
    if(bookmark)response.headers.set('X-D1-Bookmark',bookmark);
    return response;
  },
  async scheduled(controller:ScheduledController,env:Bindings,ctx:ExecutionContext){
    const id=`scheduled-${controller.scheduledTime}`;
    ctx.waitUntil(env.BACKUP_WORKFLOW.create({id,params:{backupId:id,scheduled:true,retention:7},retention:{successRetention:'14 days',errorRetention:'30 days'},locationHint:'apac'}));
  }
};
