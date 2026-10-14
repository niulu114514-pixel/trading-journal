import { Hono } from 'hono';
import { z } from 'zod';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
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
import { registerAiMetaRoutes } from './routes/ai-meta';
import { registerRuleRoutes } from './routes/rules';
import { registerSettingsRoutes } from './routes/settings';
import { registerStatsRoutes } from './routes/stats';
import { registerTradeRoutes } from './routes/trades';
import { registerMcpTokenRoutes } from './routes/mcp-tokens';
import {
  MARKET_NEWS_SOURCE_IDS,
  compactWebSearchContext,
  currentTimeContext,
  deriveWebSearchQuery,
  extractWebSearchSources,
  normalizeMarketNewsSources,
  shouldPrefetchWebSearch
} from './services/ai-web-search';
import { registerSystemRoutes } from './routes/systems';
import { registerShareRoutes } from './routes/shares';
import { ensureSensitiveConfigEncrypted, encryptConfigValue, getAllConfig } from './services/config';
import { fetchMarketCandles, fetchMarketNews } from './services/market';
import {
  aiErrorMessage,
  aiText,
  normalizeAiUsage,
  resolveAiEndpoint,
  type AiProtocol,
  type AiProviderResult
} from './services/ai-protocol';
import { callConfiguredAi } from './services/ai-provider';
import { createAiJob, failAiJobPreservingCause, isRetryableAiJobError, updateAiJob } from './services/ai-jobs';
import { createMaintenanceJob, updateMaintenanceJob } from './services/maintenance-jobs';
import {
  parseMindmapBatchNodes,
  type MindmapBatchNode
} from './services/mindmap-nodes';
import {
  calculateMindmapQuality,
  captureTradeStrategySnapshot,
  cloneMindmap,
  generateMindmapRefinement,
  isAvailableSystemNodeType,
  loadMindmapSnapshot,
  replaceMindmapFromSnapshot,
  resolveActiveMindmapCategory,
  saveMindmapVersion
} from './services/mindmaps';
import type { BackupWorkflowParams } from './workflows/types';

export { hashSessionToken } from './routes/auth';
export { cloudflareNeurons, consumeAiEventStream, normalizeAiUsage, resolveAiEndpoint, resolveAiModelsEndpoint } from './services/ai-protocol';
export { chooseAiJobFailureMessage, isRetryableAiJobError } from './services/ai-jobs';
export {
  DEFAULT_MINDMAP_REFINEMENT_INSTRUCTIONS,
  normalizeAiMindmapNodes,
  normalizeMindmapNodeType
} from './services/mindmap-nodes';
export { orderMindmapNodesParentFirst } from './services/mindmaps';

const app = new Hono<AppEnv>();
registerSecurityMiddleware(app);
registerAuthRoutes(app);
for (const path of [
  '/api/ai/conversations',
  '/api/ai/conversations/:id',
  '/api/ai/action-batches/:id/rollback',
  '/api/ai/chat',
  '/api/ai/chat/stream'
]) {
  app.all(path, context => context.json({ error: 'Not Found' }, 404));
}
registerAiMetaRoutes(app);
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
      await c.env.DB.prepare("UPDATE trades SET chart_image = NULL, updated_at = datetime('now') WHERE chart_image = ?")
        .bind(`/i/${publicId}`).run();
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

  const legacyR2 = `/api/image/r2/${encodeURIComponent(record.key)}`;
  const legacyTg = `/api/image/tg/${encodeURIComponent(record.tg_file_id || record.key)}`;
  const publicPath = record.public_id ? `/i/${record.public_id}` : '';
  await env.DB.batch([
    env.DB.prepare("UPDATE share_links SET revoked_at=datetime('now') WHERE target_type='image' AND target_id=? AND revoked_at IS NULL").bind(record.id),
    env.DB.prepare('DELETE FROM images WHERE id = ?').bind(record.id),
    env.DB.prepare(
      `UPDATE trades SET chart_image = NULL, updated_at = datetime('now')
       WHERE chart_image IN (?, ?, ?) OR (? != '' AND chart_image LIKE ?)`
    ).bind(legacyR2, legacyTg, publicPath, publicPath, `%${publicPath}`)
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

// ===================== 站内 AI 工作台 =====================

type AiTool = { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict: false };

const AI_READ_TOOLS: AiTool[] = [
  { type: 'function', name: 'get_dashboard_context', description: '读取交易汇总、最近交易、规则与脑图概况，用于综合分析', strict: false, parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'list_trades', description: '读取最近交易，可按品种筛选', strict: false, parameters: { type: 'object', properties: { symbol: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { type: 'function', name: 'list_rules', description: '读取交易规则，可按分类筛选', strict: false, parameters: { type: 'object', properties: { category: { type: 'string' }, active: { type: 'boolean' } }, additionalProperties: false } },
  { type: 'function', name: 'list_mindmaps', description: '读取脑图列表及分类、节点数、资料链接', strict: false, parameters: { type: 'object', properties: { category: { type: 'string' } }, additionalProperties: false } },
  { type: 'function', name: 'get_mindmap', description: '读取一张脑图和全部节点', strict: false, parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'list_settings', description: '读取自定义选项，例如交易品种、时间级别、形态、规则分类、脑图分类', strict: false, parameters: { type: 'object', properties: { category: { type: 'string', description: '交易品种使用 symbol，时间级别使用 timeframe' } }, additionalProperties: false } }
  ,{ type: 'function', name: 'get_market_candles', description: '读取实时或近期 K 线 OHLC 数据，用于基于事实分析价格结构、趋势和关键区间', strict: false, parameters: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1min','5min','15min','30min','45min','1h','2h','4h','1day','1week','1month'] }, outputsize: { type: 'integer', minimum: 10, maximum: 500 }, fresh: { type: 'boolean' } }, required: ['symbol','interval'], additionalProperties: false } }
  ,{ type: 'function', name: 'search_market_news', description: '通过 td-forex-mcp 聚合 RSS 财经新闻，并可使用已配置的 Tavily 搜索补充最新网页新闻。sources 只能使用给定来源 ID，不确定时不要传 sources。', strict: false, parameters: { type: 'object', properties: { keyword: { type: 'string' }, sources: { type: 'array', items: { type: 'string', enum: [...MARKET_NEWS_SOURCE_IDS] } }, limit: { type: 'integer', minimum: 1, maximum: 50 }, deep: { type: 'boolean' }, time_range: { type: 'string', enum: ['day','week','month','year'] } }, additionalProperties: false } }
  ,{ type: 'function', name: 'search_web', description: '通过 td-forex-mcp 中已配置的 Tavily 联网搜索当前网页信息。凡是最新、今天、当前、实时或明确要求联网的问题都应调用。', strict: false, parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 10 }, time_range: { type: 'string', enum: ['day','week','month','year'] } }, required: ['query'], additionalProperties: false } }
];

const AI_WRITE_TOOLS: AiTool[] = [
  { type: 'function', name: 'create_rule', description: '创建一条交易规则', strict: false, parameters: { type: 'object', properties: { title: { type: 'string' }, category: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string' }, priority: { type: 'integer' } }, required: ['title', 'content'], additionalProperties: false } },
  { type: 'function', name: 'update_rule', description: '更新规则内容、标题、分类或标签', strict: false, parameters: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, category: { type: 'string' }, content: { type: 'string' }, tags: { type: 'string' }, priority: { type: 'integer' }, is_active: { type: 'boolean' } }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'create_trade', description: '创建交易日志', strict: false, parameters: { type: 'object', properties: { symbol: { type: 'string' }, entry_time: { type: 'string' }, direction: { type: 'string', enum: ['多', '空'] }, lots: { type: 'number' }, entry_price: { type: 'number', description: '开仓价格' }, exit_price: { type: 'number', description: '平仓价格' }, timeframe: { type: 'string', description: '一个或多个时间级别，多个使用逗号分隔' }, trade_type: { type: 'string' }, market_cycle: { type: 'string' }, patterns: { type: 'string' }, trade_logic: { type: 'string' }, result: { type: 'string', enum: ['胜', '败', '平'] }, return_amount: { type: 'number' }, risk_reward_ratio: { type: 'number', description: '直接填写原始风险/回报比，例如 0.71' }, review: { type: 'string' } }, required: ['symbol', 'entry_time'], additionalProperties: false } },
  { type: 'function', name: 'update_trade_review', description: '根据分析更新某笔交易的复盘文字，不修改盈亏数据', strict: false, parameters: { type: 'object', properties: { id: { type: 'integer' }, review: { type: 'string' } }, required: ['id', 'review'], additionalProperties: false } },
  { type: 'function', name: 'create_setting', description: '创建业务自定义选项；可用于 symbol、timeframe、pattern、rule_category、mindmap_category 等', strict: false, parameters: { type: 'object', properties: { category: { type: 'string', description: '交易品种使用 symbol' }, label: { type: 'string' }, value: { type: 'string' }, color: { type: 'string' } }, required: ['category', 'label', 'value'], additionalProperties: false } },
  { type: 'function', name: 'update_setting', description: '更新业务选项的名称、值、颜色或启用状态；分类值改名时会同步关联数据', strict: false, parameters: { type: 'object', properties: { id: { type: 'integer' }, label: { type: 'string' }, value: { type: 'string' }, color: { type: 'string' }, is_active: { type: 'boolean' } }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'create_mindmap', description: '创建一张脑图及根节点', strict: false, parameters: { type: 'object', properties: { name: { type: 'string' }, category: { type: 'string' }, description: { type: 'string' }, resource_url: { type: 'string' }, color: { type: 'string' }, template: { type: 'boolean' } }, required: ['name', 'category'], additionalProperties: false } },
  { type: 'function', name: 'update_mindmap', description: '更新脑图名称、分类、说明、资料链接、状态或颜色', strict: false, parameters: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, category: { type: 'string' }, description: { type: 'string' }, resource_url: { type: 'string' }, status: { type: 'string', enum: ['draft','active','archived'] }, color: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'add_mindmap_node', description: '向脑图添加节点；节点类型应先从 list_settings(system_node_type) 查询', strict: false, parameters: { type: 'object', properties: { system_id: { type: 'integer' }, parent_id: { type: 'integer' }, title: { type: 'string' }, content: { type: 'string' }, node_type: { type: 'string' }, rule_id: { type: 'integer' }, sort_order: { type: 'integer' } }, required: ['system_id', 'parent_id', 'title'], additionalProperties: false } }
  ,{ type: 'function', name: 'update_mindmap_node', description: '精修已有脑图节点的标题、说明、类型、规则引用或排序', strict: false, parameters: { type: 'object', properties: { system_id: { type: 'integer' }, id: { type: 'integer' }, title: { type: 'string' }, content: { type: 'string' }, node_type: { type: 'string' }, rule_id: { anyOf: [{type:'integer'},{type:'null'}] }, sort_order: { type: 'integer' } }, required: ['system_id','id'], additionalProperties: false } }
];

type AiUndoAction = {
  tool: string;
  kind: 'created' | 'updated';
  id?: number;
  args?: Record<string, unknown>;
  row?: Record<string, unknown> | null;
  related?: Record<string, unknown> | null;
};

async function captureAiUndo(db: D1Database, name: string, args: Record<string, any>): Promise<AiUndoAction> {
  if (['create_rule','create_trade','create_setting','create_mindmap','add_mindmap_node'].includes(name)) {
    return { tool: name, kind: 'created', args };
  }
  switch (name) {
    case 'update_rule':
      return { tool: name, kind: 'updated', args, row: await db.prepare('SELECT * FROM trading_rules WHERE id=?').bind(Number(args.id)).first() };
    case 'update_trade_review':
      return { tool: name, kind: 'updated', args, row: await db.prepare('SELECT * FROM trades WHERE id=?').bind(Number(args.id)).first() };
    case 'update_setting':
      return { tool: name, kind: 'updated', args, row: await db.prepare('SELECT * FROM settings WHERE id=?').bind(Number(args.id)).first() };
    case 'update_mindmap':
      return {
        tool: name,
        kind: 'updated',
        args,
        row: await db.prepare('SELECT * FROM trading_systems WHERE id=?').bind(Number(args.id)).first(),
        related: await db.prepare('SELECT * FROM trading_system_nodes WHERE system_id=? AND parent_id IS NULL LIMIT 1').bind(Number(args.id)).first()
      };
    case 'update_mindmap_node':
      return { tool: name, kind: 'updated', args, row: await db.prepare('SELECT * FROM trading_system_nodes WHERE id=? AND system_id=?').bind(Number(args.id), Number(args.system_id)).first() };
    default:
      throw new Error(`不支持回撤的 AI 写工具: ${name}`);
  }
}

function completeAiUndo(action: AiUndoAction, result: unknown): AiUndoAction {
  if (action.kind !== 'created') return action;
  const id = Number((result as { id?: number } | null)?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('AI 写操作未返回可回撤的记录 ID');
  return { ...action, id };
}

const AI_UNDO_TABLES = new Set(['trades','trading_rules','settings','trading_systems','trading_system_nodes']);

async function restoreAiRow(db: D1Database, table: string, row: Record<string, unknown> | null | undefined): Promise<void> {
  if (!row || !AI_UNDO_TABLES.has(table)) throw new Error('缺少可恢复的数据快照');
  const id = Number(row.id);
  const columns = Object.keys(row).filter(column => column !== 'id' && /^[a-z_]+$/.test(column));
  if (!Number.isInteger(id) || !columns.length) throw new Error('回撤快照无效');
  await db.prepare(`UPDATE ${table} SET ${columns.map(column => `${column}=?`).join(',')} WHERE id=?`)
    .bind(...columns.map(column => row[column] ?? null), id).run();
}

async function rollbackAiAction(db: D1Database, action: AiUndoAction): Promise<void> {
  if (action.kind === 'created') {
    const id = Number(action.id);
    if (!Number.isInteger(id)) throw new Error('回撤记录 ID 无效');
    if (action.tool === 'create_rule') await db.prepare('DELETE FROM trading_rules WHERE id=?').bind(id).run();
    else if (action.tool === 'create_setting') await db.prepare('DELETE FROM settings WHERE id=?').bind(id).run();
    else if (action.tool === 'create_trade') {
      const trade = await db.prepare('SELECT entry_time FROM trades WHERE id=?').bind(id).first<{entry_time:string}>();
      await db.prepare('DELETE FROM trades WHERE id=?').bind(id).run();
      if (trade?.entry_time) await updateMonthlyStats(db, trade.entry_time);
    } else if (action.tool === 'create_mindmap') {
      await db.batch([
        db.prepare('DELETE FROM trading_system_nodes WHERE system_id=?').bind(id),
        db.prepare('DELETE FROM trading_systems WHERE id=?').bind(id)
      ]);
    } else if (action.tool === 'add_mindmap_node') {
      await db.prepare('DELETE FROM trading_system_nodes WHERE id=?').bind(id).run();
    }
    return;
  }

  if (action.tool === 'update_rule') await restoreAiRow(db, 'trading_rules', action.row);
  else if (action.tool === 'update_trade_review') await restoreAiRow(db, 'trades', action.row);
  else if (action.tool === 'update_mindmap_node') await restoreAiRow(db, 'trading_system_nodes', action.row);
  else if (action.tool === 'update_mindmap') {
    await restoreAiRow(db, 'trading_systems', action.row);
    if (action.related) await restoreAiRow(db, 'trading_system_nodes', action.related);
  } else if (action.tool === 'update_setting') {
    const before = action.row as Record<string, unknown> | null;
    if (!before) throw new Error('设置回撤快照缺失');
    const nextValue = action.args?.value;
    if (nextValue !== undefined && String(nextValue) !== String(before.value)) {
      const cascades: Record<string, [string,string]> = {
        system_node_type: ['trading_system_nodes','node_type'],
        image_category: ['images','category'],
        mindmap_category: ['trading_systems','category']
      };
      const cascade = cascades[String(before.category)];
      if (cascade) await db.prepare(`UPDATE ${cascade[0]} SET ${cascade[1]}=? WHERE ${cascade[1]}=?`).bind(before.value, String(nextValue)).run();
    }
    await restoreAiRow(db, 'settings', before);
  }
}

async function executeAiTool(env: Bindings, name: string, args: Record<string, any>, signal?: AbortSignal): Promise<unknown> {
  const db = env.DB;
  switch (name) {
    case 'get_market_candles':
      return fetchMarketCandles(db, { symbol: args.symbol, interval: args.interval, outputsize: args.outputsize, fresh: args.fresh === true }, env.CONFIG_ENCRYPTION_KEY, { service: env.TD_FOREX, signal });
    case 'search_market_news':
      return fetchMarketNews(db, { keyword: args.keyword, sources: normalizeMarketNewsSources(args.sources), limit: args.limit, deep: args.deep !== false && Boolean(args.keyword), timeRange: args.time_range }, env.CONFIG_ENCRYPTION_KEY, { service: env.TD_FOREX, signal });
    case 'search_web': {
      const query = String(args.query || '').trim().slice(0, 200);
      if (!query) throw new Error('联网搜索必须提供 query');
      return fetchMarketNews(db, { keyword: query, limit: Math.min(Math.max(Number(args.limit) || 8, 1), 10), deep: true, timeRange: args.time_range || 'day' }, env.CONFIG_ENCRYPTION_KEY, { service: env.TD_FOREX, signal });
    }
    case 'get_dashboard_context': {
      const [overview, recent, rules, systems] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) AS wins, COALESCE(SUM(return_amount),0) AS total_return, ROUND(AVG(risk_reward_ratio),2) AS avg_rr FROM trades`).first(),
        db.prepare('SELECT id,symbol,entry_time,entry_price,exit_price,direction,timeframe,patterns,result,return_amount,risk_reward_ratio,review FROM trades ORDER BY entry_time DESC,id DESC LIMIT 30').all(),
        db.prepare('SELECT id,title,category,content,tags,priority FROM trading_rules WHERE is_active = 1 ORDER BY priority DESC,id DESC LIMIT 50').all(),
        db.prepare(`SELECT s.id,s.name,s.category,s.description,s.resource_url,s.status,COUNT(n.id) AS node_count FROM trading_systems s LEFT JOIN trading_system_nodes n ON n.system_id=s.id GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 30`).all()
      ]);
      return { overview, recent_trades: recent.results, active_rules: rules.results, mindmaps: systems.results };
    }
    case 'list_trades': {
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const where = args.symbol ? 'WHERE symbol = ?' : '';
      const params = args.symbol ? [String(args.symbol)] : [];
      const rows = await db.prepare(`SELECT * FROM trades ${where} ORDER BY entry_time DESC,id DESC LIMIT ?`).bind(...params, limit).all();
      return rows.results;
    }
    case 'list_rules': {
      const where: string[] = [];
      const params: any[] = [];
      if (args.category) { where.push('category = ?'); params.push(String(args.category)); }
      if (typeof args.active === 'boolean') { where.push('is_active = ?'); params.push(args.active ? 1 : 0); }
      const rows = await db.prepare(`SELECT * FROM trading_rules ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC,id DESC`).bind(...params).all();
      return rows.results;
    }
    case 'list_mindmaps': {
      const where = args.category ? 'WHERE s.category = ?' : '';
      const params = args.category ? [String(args.category)] : [];
      const rows = await db.prepare(`SELECT s.*,COUNT(n.id) AS node_count FROM trading_systems s LEFT JOIN trading_system_nodes n ON n.system_id=s.id ${where} GROUP BY s.id ORDER BY s.updated_at DESC`).bind(...params).all();
      return rows.results;
    }
    case 'get_mindmap': {
      const system = await db.prepare('SELECT * FROM trading_systems WHERE id = ?').bind(Number(args.id)).first();
      if (!system) throw new Error('脑图不存在');
      const nodes = await db.prepare(`SELECT n.*,r.title AS rule_title,r.category AS rule_category FROM trading_system_nodes n LEFT JOIN trading_rules r ON r.id=n.rule_id WHERE n.system_id=? ORDER BY n.sort_order,n.id`).bind(Number(args.id)).all();
      return { system, nodes: nodes.results };
    }
    case 'list_settings': {
      const where = args.category ? 'WHERE category = ?' : '';
      const params = args.category ? [String(args.category)] : [];
      const rows = await db.prepare(`SELECT id,category,label,value,color,sort_order,is_active FROM settings ${where} ORDER BY category,sort_order,id`).bind(...params).all();
      return rows.results;
    }
    case 'create_rule': {
      const title = String(args.title || '').trim(), content = String(args.content || '').trim();
      if (!title || !content) throw new Error('规则标题和内容必填');
      const result = await db.prepare(`INSERT INTO trading_rules(title,category,content,tags,is_active,priority) VALUES(?,?,?,?,1,?)`).bind(title, String(args.category || '入场规则'), content, args.tags || null, Number(args.priority) || 0).run();
      return { success: true, id: result.meta.last_row_id };
    }
    case 'update_rule': {
      const fields: string[] = [], values: any[] = [];
      for (const field of ['title','category','content','tags','priority','is_active']) if (args[field] !== undefined) { fields.push(`${field}=?`); values.push(field === 'is_active' ? (args[field] ? 1 : 0) : args[field]); }
      if (!fields.length) throw new Error('没有可更新字段');
      values.push(Number(args.id));
      const result = await db.prepare(`UPDATE trading_rules SET ${fields.join(',')},updated_at=datetime('now') WHERE id=?`).bind(...values).run();
      if (!result.meta.changes) throw new Error('规则不存在');
      return { success: true, id: Number(args.id) };
    }
    case 'create_trade': {
      const symbol = String(args.symbol || '').trim(), entryTime = String(args.entry_time || '').trim();
      if (!symbol || !entryTime) throw new Error('symbol 和 entry_time 必填');
      const result = await db.prepare(`INSERT INTO trades(symbol,entry_time,entry_price,exit_price,direction,lots,timeframe,trade_type,market_cycle,patterns,trade_logic,result,return_amount,risk_reward_ratio,review) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(symbol, entryTime, args.entry_price ?? null, args.exit_price ?? null, args.direction || '多', Number(args.lots) || 1, normalizeTradeTimeframes(args.timeframe, '5M'), args.trade_type || null, args.market_cycle || null, args.patterns || null, args.trade_logic || null, args.result || null, args.return_amount ?? null, args.risk_reward_ratio ?? null, args.review || null).run();
      await updateMonthlyStats(db, entryTime);
      return { success: true, id: result.meta.last_row_id };
    }
    case 'update_trade_review': {
      const result = await db.prepare("UPDATE trades SET review=?,updated_at=datetime('now') WHERE id=?").bind(String(args.review || ''), Number(args.id)).run();
      if (!result.meta.changes) throw new Error('交易不存在');
      return { success: true, id: Number(args.id) };
    }
    case 'create_setting': {
      const category = String(args.category || '').trim(), label = String(args.label || '').trim(), value = String(args.value || '').trim();
      if (!/^[a-z0-9_-]{1,40}$/i.test(category) || !label || !value) throw new Error('设置分类、名称和值无效');
      const result = await db.prepare('INSERT INTO settings(category,label,value,color,sort_order,is_active) VALUES(?,?,?,?,0,1)').bind(category,label,value,args.color || '#3ec9c5').run();
      return { success: true, id: result.meta.last_row_id };
    }
    case 'update_setting': {
      const current = await db.prepare('SELECT category,value FROM settings WHERE id=?').bind(Number(args.id)).first<{category:string;value:string}>();
      if (!current) throw new Error('设置项不存在');
      const nextValue = args.value === undefined ? current.value : String(args.value).trim();
      if (!nextValue) throw new Error('设置值不能为空');
      if (current.category === 'system_node_type' && !/^[\p{L}\p{N}_-]{1,40}$/u.test(nextValue)) throw new Error('脑图节点类型值无效');
      const fields: string[] = [], values: any[] = [];
      for (const field of ['label','value','color','is_active']) if (args[field] !== undefined) { fields.push(`${field}=?`); values.push(field === 'is_active' ? (args[field] ? 1 : 0) : args[field]); }
      if (!fields.length) throw new Error('没有可更新字段');
      values.push(Number(args.id));
      const update = db.prepare(`UPDATE settings SET ${fields.join(',')},updated_at=datetime('now') WHERE id=?`).bind(...values);
      if (nextValue !== current.value && current.category === 'system_node_type') await db.batch([update,db.prepare("UPDATE trading_system_nodes SET node_type=?,updated_at=datetime('now') WHERE node_type=?").bind(nextValue,current.value)]);
      else if (nextValue !== current.value && current.category === 'image_category') await db.batch([update,db.prepare('UPDATE images SET category=? WHERE category=?').bind(nextValue,current.value)]);
      else if (nextValue !== current.value && current.category === 'mindmap_category') await db.batch([update,db.prepare("UPDATE trading_systems SET category=?,updated_at=datetime('now') WHERE category=?").bind(nextValue,current.value)]);
      else await update.run();
      return { success:true,id:Number(args.id) };
    }
    case 'create_mindmap': {
      const nameValue = String(args.name || '').trim(), category = String(args.category || '').trim();
      if (!nameValue || !category) throw new Error('脑图名称和分类必填');
      const categoryExists = await db.prepare("SELECT id FROM settings WHERE category='mindmap_category' AND value=? AND is_active=1").bind(category).first();
      if (!categoryExists) throw new Error('脑图分类不存在或未启用');
      const resourceUrl = normalizeExternalUrl(args.resource_url);
      const created = await db.prepare(`INSERT INTO trading_systems(name,category,description,resource_url,status,color) VALUES(?,?,?,?, 'draft',?)`).bind(nameValue,category,args.description || null,resourceUrl,args.color || '#3ec9c5').run();
      const systemId = Number(created.meta.last_row_id);
      const root = await db.prepare(`INSERT INTO trading_system_nodes(system_id,title,content,node_type,sort_order) VALUES(?,?,?,'root',0)`).bind(systemId,nameValue,args.description || '脑图根节点').run();
      if (args.template === true) {
        const branches = [
          ['市场环境','确认市场结构与允许执行的条件','setup'],
          ['判断条件','逐项验证决策条件','condition'],
          ['风险管理','明确仓位、止损和失效条件','risk'],
          ['复盘清单','记录执行偏差和精修方向','review']
        ];
        await db.batch(branches.map((branch,index)=>db.prepare(`INSERT INTO trading_system_nodes(system_id,parent_id,title,content,node_type,sort_order) VALUES(?,?,?,?,?,?)`).bind(systemId,Number(root.meta.last_row_id),branch[0],branch[1],branch[2],index)));
      }
      return { success: true, id: systemId, root_id: root.meta.last_row_id };
    }
    case 'update_mindmap': {
      if (args.category !== undefined) {
        const exists = await db.prepare("SELECT id FROM settings WHERE category='mindmap_category' AND value=?").bind(String(args.category)).first();
        if (!exists) throw new Error('脑图分类不存在');
      }
      if (args.status !== undefined && !['draft','active','archived'].includes(String(args.status))) throw new Error('脑图状态无效');
      if (args.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(args.color))) throw new Error('脑图颜色无效');
      if (args.resource_url !== undefined) args.resource_url = normalizeExternalUrl(args.resource_url);
      const fields:string[]=[],values:any[]=[];
      for (const field of ['name','category','description','resource_url','status','color']) if (args[field] !== undefined) { fields.push(`${field}=?`);values.push(args[field]||null); }
      if (!fields.length) throw new Error('没有可更新字段');
      values.push(Number(args.id));
      const result=await db.prepare(`UPDATE trading_systems SET ${fields.join(',')},updated_at=datetime('now') WHERE id=?`).bind(...values).run();
      if (!result.meta.changes) throw new Error('脑图不存在');
      if (args.name) await db.prepare("UPDATE trading_system_nodes SET title=?,updated_at=datetime('now') WHERE system_id=? AND parent_id IS NULL").bind(String(args.name),Number(args.id)).run();
      return {success:true,id:Number(args.id)};
    }
    case 'add_mindmap_node': {
      const nodeType = String(args.node_type || 'condition');
      const title = String(args.title || '').trim();
      if (!title) throw new Error('节点标题必填');
      if (!await isAvailableSystemNodeType(db,nodeType)) throw new Error('节点类型不存在或未启用');
      const parent = await db.prepare('SELECT id FROM trading_system_nodes WHERE id=? AND system_id=?').bind(Number(args.parent_id),Number(args.system_id)).first();
      if (!parent) throw new Error('父节点不属于该脑图');
      const result = await db.prepare(`INSERT INTO trading_system_nodes(system_id,parent_id,rule_id,title,content,node_type,sort_order) VALUES(?,?,?,?,?,?,?)`).bind(Number(args.system_id),Number(args.parent_id),args.rule_id || null,title,args.content || null,nodeType,Number(args.sort_order) || 0).run();
      await db.prepare("UPDATE trading_systems SET updated_at=datetime('now') WHERE id=?").bind(Number(args.system_id)).run();
      return { success: true, id: result.meta.last_row_id };
    }
    case 'update_mindmap_node': {
      const current=await db.prepare('SELECT parent_id,node_type FROM trading_system_nodes WHERE id=? AND system_id=?').bind(Number(args.id),Number(args.system_id)).first<{parent_id:number|null;node_type:string}>();
      if (!current) throw new Error('脑图节点不存在');
      if (args.node_type !== undefined && current.parent_id !== null && !await isAvailableSystemNodeType(db,String(args.node_type))) throw new Error('节点类型不存在或未启用');
      const fields:string[]=[],values:any[]=[];
      for (const field of ['title','content','node_type','rule_id','sort_order']) if (args[field] !== undefined) { fields.push(`${field}=?`);values.push(args[field]); }
      if (!fields.length) throw new Error('没有可更新字段');
      if (args.title !== undefined && !String(args.title).trim()) throw new Error('节点标题不能为空');
      values.push(Number(args.id),Number(args.system_id));
      await db.prepare(`UPDATE trading_system_nodes SET ${fields.join(',')},updated_at=datetime('now') WHERE id=? AND system_id=?`).bind(...values).run();
      await db.prepare("UPDATE trading_systems SET updated_at=datetime('now') WHERE id=?").bind(Number(args.system_id)).run();
      return {success:true,id:Number(args.id)};
    }
    default: throw new Error(`不支持的 AI 工具: ${name}`);
  }
}

async function getOwnedAiConversation(db: D1Database, id: number, userId: number) {
  return db.prepare('SELECT * FROM ai_conversations WHERE id=? AND user_id=?').bind(id, userId).first<Record<string, unknown>>();
}

app.get('/api/ai/conversations', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(`
    SELECT c.id,c.title,c.created_at,c.updated_at,
      (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id=c.id) AS message_count,
      (SELECT substr(content,1,120) FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS preview
    FROM ai_conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC,c.id DESC LIMIT 100
  `).bind(user.id).all();
  return c.json(rows.results);
});

app.post('/api/ai/conversations', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<any>().catch(() => ({}));
  const title = String(body?.title || '新对话').trim().slice(0, 80) || '新对话';
  const result = await c.env.DB.prepare('INSERT INTO ai_conversations(user_id,title) VALUES(?,?)').bind(user.id, title).run();
  return c.json({ id: Number(result.meta.last_row_id), title }, 201);
});

app.get('/api/ai/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const conversation = await getOwnedAiConversation(c.env.DB, id, user.id);
  if (!conversation) return c.json({ error: '对话不存在' }, 404);
  const rows = await c.env.DB.prepare(`
    SELECT m.id,m.role,m.content,m.actions_json,m.analysis_json,m.provider,m.model,m.usage_json,m.action_batch_id,m.created_at,b.status AS action_status
    FROM ai_messages m LEFT JOIN ai_action_batches b ON b.id=m.action_batch_id
    WHERE m.conversation_id=? ORDER BY m.id
  `).bind(id).all<any>();
  const messages = rows.results.map(row => ({
    ...row,
    actions: row.actions_json ? JSON.parse(String(row.actions_json)) : [],
    analysis: row.analysis_json ? JSON.parse(String(row.analysis_json)) : [],
    usage: row.usage_json ? JSON.parse(String(row.usage_json)) : null,
    actions_json: undefined,
    analysis_json: undefined,
    usage_json: undefined
  }));
  return c.json({ conversation, messages });
});

app.put('/api/ai/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const body = await c.req.json<any>().catch(() => null);
  const title = String(body?.title || '').trim().slice(0, 80);
  if (!title) return c.json({ error: '对话标题不能为空' }, 400);
  const result = await c.env.DB.prepare("UPDATE ai_conversations SET title=?,updated_at=datetime('now') WHERE id=? AND user_id=?").bind(title, id, user.id).run();
  if (!result.meta.changes) return c.json({ error: '对话不存在' }, 404);
  return c.json({ success: true });
});

app.delete('/api/ai/conversations/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  if (!await getOwnedAiConversation(c.env.DB, id, user.id)) return c.json({ error: '对话不存在' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM ai_messages WHERE conversation_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM ai_action_batches WHERE conversation_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM ai_conversations WHERE id=? AND user_id=?').bind(id, user.id)
  ]);
  return c.json({ success: true });
});

app.post('/api/ai/action-batches/:id/rollback', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const batch = await c.env.DB.prepare(`
    SELECT b.* FROM ai_action_batches b JOIN ai_conversations c ON c.id=b.conversation_id
    WHERE b.id=? AND c.user_id=?
  `).bind(id, user.id).first<any>();
  if (!batch) return c.json({ error: '回撤记录不存在' }, 404);
  if (batch.status === 'rolled_back') return c.json({ error: '这组操作已经回撤' }, 409);
  let undo: AiUndoAction[];
  try { undo = JSON.parse(String(batch.undo_json || '[]')); }
  catch { return c.json({ error: '回撤记录已损坏' }, 500); }
  for (const action of [...undo].reverse()) await rollbackAiAction(c.env.DB, action);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE ai_action_batches SET status='rolled_back',rolled_back_at=datetime('now') WHERE id=?").bind(id),
    c.env.DB.prepare("UPDATE ai_conversations SET updated_at=datetime('now') WHERE id=?").bind(Number(batch.conversation_id))
  ]);
  return c.json({ success: true, rolled_back: undo.length });
});

async function saveAiAssistantMessage(
  db: D1Database,
  conversationId: number,
  content: string,
  actions: { tool: string; arguments: Record<string, any>; result: unknown }[],
  undo: AiUndoAction[],
  analysis: Record<string, unknown>[] = [],
  metadata: { provider?: string; model?: string; usage?: unknown } = {}
) {
  let batchId: number | null = null;
  if (actions.length) {
    const batch = await db.prepare('INSERT INTO ai_action_batches(conversation_id,actions_json,undo_json) VALUES(?,?,?)')
      .bind(conversationId, JSON.stringify(actions), JSON.stringify(undo)).run();
    batchId = Number(batch.meta.last_row_id);
  }
  const saved = await db.prepare('INSERT INTO ai_messages(conversation_id,role,content,actions_json,analysis_json,provider,model,usage_json,action_batch_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(conversationId, 'assistant', content, actions.length ? JSON.stringify(actions) : null, analysis.length ? JSON.stringify(analysis) : null, metadata.provider || null, metadata.model || null, metadata.usage ? JSON.stringify(metadata.usage) : null, batchId).run();
  await db.prepare("UPDATE ai_conversations SET updated_at=datetime('now') WHERE id=?").bind(conversationId).run();
  return { message_id: Number(saved.meta.last_row_id), action_batch_id: batchId };
}

type AiChatHooks = {
  signal?: AbortSignal;
  onStatus?: (status:{stage:string;label:string})=>void;
  onMeta?: (meta:Record<string,unknown>)=>void;
  onDelta?: (delta:string)=>void;
  onReset?: ()=>void;
  onTrace?: (trace:Record<string,unknown>)=>void;
};

class AiChatRequestError extends Error{
  constructor(public status:400|404|502,message:string){super(message);}
}

async function runAiChat(env:Bindings,user:{id:number;username:string},rawBody:any,hooks:AiChatHooks={}){
  const body=rawBody&&typeof rawBody==='object'?rawBody:{};
  const fallbackMessage = Array.isArray(body?.messages) ? [...body.messages].reverse().find((item: any) => item?.role === 'user')?.content : '';
  const content = String(body?.message || fallbackMessage || '').trim().slice(0, 12000);
  if (!content) throw new AiChatRequestError(400,'请输入问题');
  const config = await getAllConfig(env.DB,env.CONFIG_ENCRYPTION_KEY);
  if (config.ai_enabled !== 'true') throw new AiChatRequestError(400,'AI 工作台未启用，请先到系统设置中启用');
  const primaryConfigured = Boolean(config.ai_api_key && config.ai_model);
  if (!primaryConfigured && config.ai_cf_fallback_enabled === 'false') throw new AiChatRequestError(400,'请配置主模型，或启用 Cloudflare 备用模型');
  let protocol: AiProtocol = 'responses';
  try {
    if (primaryConfigured) protocol = resolveAiEndpoint(config.ai_base_url || 'https://api.openai.com/v1',config.ai_api_format || 'auto').protocol;
  } catch (error) {
    throw new AiChatRequestError(400,aiErrorMessage(error) || 'AI API 地址无效');
  }

  hooks.onStatus?.({stage:'preparing',label:'正在准备对话上下文'});
  let conversationId = Number(body.conversation_id);
  if (Number.isInteger(conversationId) && conversationId > 0) {
    if (!await getOwnedAiConversation(env.DB, conversationId, user.id)) throw new AiChatRequestError(404,'对话不存在');
  } else {
    const created = await env.DB.prepare('INSERT INTO ai_conversations(user_id,title) VALUES(?,?)')
      .bind(user.id, content.replace(/\s+/g, ' ').slice(0, 36)).run();
    conversationId = Number(created.meta.last_row_id);
  }
  hooks.onMeta?.({conversation_id:conversationId});
  const history = await env.DB.prepare('SELECT role,content FROM ai_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 19').bind(conversationId).all<any>();
  const messages = [...history.results].reverse().map(item => ({ role: item.role, content: String(item.content).slice(0, 12000) }));
  messages.push({ role: 'user', content });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)').bind(conversationId, 'user', content),
    env.DB.prepare("UPDATE ai_conversations SET updated_at=datetime('now') WHERE id=?").bind(conversationId)
  ]);

  const execute = body.execute === true;
  const webSearchEnabled = body.web_search !== false;
  const readTools = webSearchEnabled
    ? AI_READ_TOOLS
    : AI_READ_TOOLS.filter(tool => !['search_web', 'search_market_news'].includes(tool.name));
  const tools = execute ? [...readTools, ...AI_WRITE_TOOLS] : readTools;
  const allowedToolNames = new Set(tools.map(tool => tool.name));
  const input: any[] = [...messages];
  const chatMessages: any[] = [];
  const actions: { tool: string; arguments: Record<string, any>; result: unknown }[] = [];
  const undo: AiUndoAction[] = [];
  const analysis: { tool: string; arguments: Record<string, any>; status: 'completed' | 'failed'; summary: string; sources?: ReturnType<typeof extractWebSearchSources> }[] = [];
  let prefetchedWebContext = '';
  if (shouldPrefetchWebSearch(content, webSearchEnabled)) {
    const query = deriveWebSearchQuery(content);
    hooks.onStatus?.({stage:'tool',label:'正在通过 td-forex-mcp 联网搜索'});
    try {
      const result = await executeAiTool(env, 'search_web', { query, limit: 8, time_range: 'day' }, hooks.signal);
      const compact = compactWebSearchContext(result, query);
      prefetchedWebContext = `\n本轮已由服务器强制完成联网搜索。只能根据以下搜索结果陈述最新信息；若结果为空或带有 warning，必须如实说明：\n${JSON.stringify(compact).slice(0, 18000)}`;
      analysis.push({tool:'search_web',arguments:{query,limit:8,time_range:'day'},status:'completed',summary:'已通过 td-forex-mcp 完成联网搜索',sources:extractWebSearchSources(result)});
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      prefetchedWebContext = `\n本轮联网搜索失败：${summary.slice(0, 500)}。必须明确告诉用户搜索失败原因，不得声称已取得实时结果。`;
      analysis.push({tool:'search_web',arguments:{query,limit:8,time_range:'day'},status:'failed',summary:summary.slice(0,240)});
    }
    hooks.onTrace?.(analysis[analysis.length-1]);
  }
  const webCapability = webSearchEnabled
    ? '你具备由 td-forex-mcp 提供的服务器端联网搜索能力，绝不能声称自己无法联网；遇到最新、今天、当前、实时、新闻或明确要求搜索的问题，必须使用 search_web。若上下文已提供“本轮已由服务器强制完成联网搜索”，直接使用该结果且无需重复搜索。回答中给出结果来源链接与抓取时间。'
    : '用户本轮关闭了智能联网，不得调用网页搜索或声称已经获取最新网页信息。';
  const instructions = `你是交易日志系统内置的中文 AI 复盘助手。${currentTimeContext()} ${webCapability} 先读取事实再回答，禁止编造交易数据、日期和行情。你可以分析交易表现、提炼规则、整理脑图和检查配置。${execute ? '用户已明确开启本轮写入授权；只有在意图清楚时才执行修改，执行后逐项说明结果。' : '当前是只读分析模式，不得声称已经修改任何数据；需要修改时告诉用户开启写入授权。'} 风险提示要具体，但不要把分析表述为保证盈利。`;
  const assistantInstructions = `${instructions}\n请按需调用行情和新闻工具读取实时事实；使用清晰的 Markdown 输出，并明确区分事实、推断、风险与失效条件。不要展示或声称展示隐藏思维链。${prefetchedWebContext}`;
  chatMessages.push({ role: 'system', content: assistantInstructions }, ...messages);
  const chatTools = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false } }));
  let provider: 'primary' | 'cloudflare' = primaryConfigured ? 'primary' : 'cloudflare';
  let providerModel = primaryConfigured ? config.ai_model : (config.ai_cf_fallback_model || '@cf/meta/llama-3.2-3b-instruct');
  let primaryError = '';

  for (let round = 0; round < 6; round++) {
    hooks.onStatus?.({stage:round?'tool_followup':'analyzing',label:round?'正在根据工具结果继续分析':'正在读取数据并分析'});
    const payload = protocol === 'chat_completions'
      ? { messages: chatMessages, tools: chatTools, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: 4000 }
      : { instructions: assistantInstructions, input, tools, tool_choice: 'auto', parallel_tool_calls: false, store: false, max_output_tokens: 4000 };
    let aiResult: AiProviderResult;
    try {
      aiResult = await callConfiguredAi(env,config,protocol,payload,{
        skipPrimary:provider === 'cloudflare' && Boolean(primaryError),
        timeoutMs:90_000,
        signal:hooks.signal,
        onDelta:hooks.onDelta,
        onReset:hooks.onReset
      });
    } catch (error) {
      throw new AiChatRequestError(502,`AI 请求失败：${aiErrorMessage(error,90_000)}`);
    }
    const data = aiResult.data;
    provider = aiResult.provider;
    providerModel = aiResult.model;
    primaryError = aiResult.primaryError || primaryError;
    hooks.onMeta?.({conversation_id:conversationId,provider,model:providerModel,usage:aiResult.usage,fallback_used:provider==='cloudflare'});
    if(aiResult.protocol!==protocol){
      protocol=aiResult.protocol;
      if(aiResult.fallbackMessages)chatMessages.splice(0,chatMessages.length,...aiResult.fallbackMessages);
    }
    const output = protocol === 'responses' && Array.isArray(data.output) ? data.output : [];
    const nativeToolCalls=Array.isArray(data?.tool_calls)?data.tool_calls.map((item:any,index:number)=>item?.function?item:{id:item?.id||`cf_${round}_${index}`,type:'function',function:{name:item?.name,arguments:typeof item?.arguments==='string'?item.arguments:JSON.stringify(item?.arguments||{})}}):[];
    const assistantMessage = protocol === 'chat_completions' ? (data?.choices?.[0]?.message||{content:data?.response||'',tool_calls:nativeToolCalls}) : null;
    const calls = protocol === 'chat_completions'
      ? (Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls.map((item: any) => ({
          name: item?.function?.name,
          arguments: item?.function?.arguments,
          call_id: item?.id,
          raw: item
        })) : [])
      : output.filter((item: any) => item.type === 'function_call');
    if (!calls.length) {
      const text = aiText(data,protocol);
      const message = text || 'AI 未返回文字结果';
      const usage = aiResult.usage || normalizeAiUsage(data.usage);
      const saved = await saveAiAssistantMessage(env.DB, conversationId, message, actions, undo, analysis, { provider, model: providerModel, usage });
      return { conversation_id: conversationId, message, actions, analysis, ...saved, usage, provider, model: providerModel, fallback_used: provider === 'cloudflare', primary_error: primaryError || undefined };
    }
    if (protocol === 'chat_completions') chatMessages.push({ role: 'assistant', content: assistantMessage?.content || null, tool_calls: calls.map((call: any) => call.raw) });
    else input.push(...output);
    for (const call of calls) {
      let args: Record<string, any> = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }
      let result: unknown;
      try {
        const isWrite = AI_WRITE_TOOLS.some(tool => tool.name === call.name);
        if (!allowedToolNames.has(String(call.name))) throw new Error('当前模式不允许调用该工具');
        if (isWrite && actions.length >= 12) throw new Error('本轮写操作已达到 12 个上限');
        hooks.onStatus?.({stage:'tool',label:`正在执行 ${String(call.name)}`});
        const undoBefore = isWrite ? await captureAiUndo(env.DB, String(call.name), args) : null;
        result = await executeAiTool(env, String(call.name), args, hooks.signal);
        if (isWrite && undoBefore) {
          actions.push({ tool: call.name, arguments: args, result });
          undo.push(completeAiUndo(undoBefore, result));
        }
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      const failed = Boolean(result && typeof result === 'object' && 'error' in (result as Record<string, unknown>));
      analysis.push({
        tool: String(call.name),
        arguments: args,
        status: failed ? 'failed' : 'completed',
        summary: failed ? String((result as any).error).slice(0, 240) : `已完成 ${String(call.name)}`
      });
      hooks.onTrace?.(analysis[analysis.length-1]);
      if (protocol === 'chat_completions') chatMessages.push({ role: 'tool', tool_call_id: call.call_id, content: JSON.stringify(result) });
      else input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }
  const message = 'AI 已达到本轮工具调用上限。已执行的修改均已记录，你可以直接回撤这组操作。';
  const saved = await saveAiAssistantMessage(env.DB, conversationId, message, actions, undo, analysis, { provider, model: providerModel });
  return { conversation_id: conversationId, message, actions, analysis, ...saved, warning: 'tool_round_limit', provider, model: providerModel, fallback_used: provider === 'cloudflare', primary_error: primaryError || undefined };
}

app.post('/api/ai/chat', async (c) => {
  try{return c.json(await runAiChat(c.env,c.get('user'),await c.req.json<any>().catch(()=>({}))));}
  catch(error){
    const status=error instanceof AiChatRequestError?error.status:502;
    return c.json({error:error instanceof Error?error.message:'AI 请求失败'},status);
  }
});

// ===================== 完整备份（D1 + R2） =====================

app.post('/api/ai/chat/stream', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const encoder = new TextEncoder();
  const aborter = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const data=await runAiChat(c.env,c.get('user'),body,{
          signal:aborter.signal,
          onStatus:status=>send('status',status),
          onMeta:meta=>send('meta',meta),
          onDelta:delta=>send('delta',{delta}),
          onReset:()=>send('reset',{}),
          onTrace:trace=>send('trace',trace)
        });
        const bookmark=c.env.REQUEST_DB_SESSION?.getBookmark();
        if(bookmark)send('bookmark',{bookmark});
        send('meta', { conversation_id: data.conversation_id, message_id: data.message_id, provider: data.provider, model: data.model, usage: 'usage' in data?data.usage:undefined, fallback_used: data.fallback_used });
        send('done', data);
      } catch (error) {
        if(!aborter.signal.aborted)send('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        try{controller.close();}catch{/* 客户端主动取消时流已经关闭。 */}
      }
    },
    cancel(){aborter.abort();}
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Content-Encoding':'identity', 'X-Accel-Buffering': 'no' } });
});

const BACKUP_PREFIX = '__backups/';
const BACKUP_TABLES = [
  'users','app_config','settings','trading_rules','trading_systems','trading_system_nodes','mindmap_versions',
  'mindmap_refinement_drafts','trades','trade_strategy_snapshots','trade_rule_checks','monthly_stats','image_folders','images','share_links','mcp_tokens','ai_conversations','ai_action_batches','ai_messages'
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

async function runMindmapRefinementWorkflow(env:Bindings,step:WorkflowStep,jobId:string,systemId:number,instructions:string){
  await step.do('标记脑图精修任务开始',()=>updateAiJob(env,jobId,'running'));
  const resultJson=await step.do('后台生成脑图精修草稿',{retries:{limit:2,delay:'10 seconds',backoff:'exponential'},timeout:'5 minutes'},async()=>{
    try{return JSON.stringify(await generateMindmapRefinement(env,systemId,instructions,undefined,jobId));}
    catch(error){
      const message=aiErrorMessage(error,180_000).slice(0,500);
      await updateAiJob(env,jobId,'running',{error:message});
      if(!isRetryableAiJobError(message))throw new NonRetryableError(message);
      throw new Error(message);
    }
  });
  const result=JSON.parse(resultJson) as {draft_id:string;summary:string;node_count:number;provider:'primary'|'cloudflare';fallback_used:boolean};
  const summary={draft_id:result.draft_id,summary:result.summary,node_count:result.node_count,provider:result.provider,fallback_used:result.fallback_used};
  await step.do('完成脑图精修任务',()=>updateAiJob(env,jobId,'completed',{result:summary}));
  return summary;
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
    if(action==='mindmap_refinement'){
      if(!params.jobId||!Number.isInteger(params.systemId)||Number(params.systemId)<=0)throw new Error('脑图精修任务参数无效');
      try{return await runMindmapRefinementWorkflow(this.env,step,params.jobId,Number(params.systemId),String(params.instructions||'').slice(0,4000));}
      catch(error){const message=await failAiJobPreservingCause(this.env,params.jobId,error);throw new NonRetryableError(message);}
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
  const addedLater=new Set<BackupTable>(['mindmap_refinement_drafts','trade_strategy_snapshots','trade_rule_checks','image_folders','share_links']);
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

  // 写方法需要 write / admin 权限
  if (MCP_WRITE_METHODS.has(method) && auth.permissions === 'read') {
    return c.json(jsonRpcError(-32002, 'Forbidden: this method requires write permission (token is read-only)', id), 403);
  }

  // 处理内联 base64 图片（add_trade / update_trade 通用）
  let inlineChartUrl: string | null = null;
  if ((method === 'add_trade' || method === 'update_trade') && params?.chart_image_base64) {
    const filename = params.chart_image_filename || `mcp-chart-${Date.now()}.png`;
    const mime = inferMime(filename, params.chart_image_mime);
    try {
      const buffer = base64ToArrayBuffer(String(params.chart_image_base64));
      const stored = await storeImageBuffer(c.env, buffer, filename, mime, buffer.byteLength, params.caption || 'MCP K线图');
      if (!stored.ok) {
        return c.json(jsonRpcError(-32000, `Image upload failed: ${stored.error}`, id), 400);
      }
      inlineChartUrl = stored.url!;
      if (stored.tg_error) {
        // 备份失败不阻断，继续
      }
    } catch (err: any) {
      return c.json(jsonRpcError(-32000, `Invalid base64 image: ${err.message}`, id), 400);
    }
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

        const sql = `SELECT t.*, s.name AS trading_system_name
          FROM trades t LEFT JOIN trading_systems s ON s.id = t.trading_system_id
          ${where} ORDER BY t.entry_time DESC LIMIT ? OFFSET ?`;
        const trades = await db.prepare(sql).bind(...queryParams, limit, offset).all();

        const tradeRows = (trades.results as any[]).map(trade => ({
          ...trade,
          chart_image: absoluteUrl(c.req.url, trade.chart_image)
        }));
        return c.json(jsonRpcResult({ trades: tradeRows, total, page, limit }, id));
      }

      case 'get_trade': {
        if (!params || !params.id) {
          return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        }
        const trade = await db.prepare(
          `SELECT t.*,COALESCE(ss.system_name,s.name) AS trading_system_name,ss.version_id AS strategy_version_id,ss.created_at AS strategy_snapshot_at,CASE WHEN ss.id IS NULL THEN 0 ELSE 1 END AS strategy_snapshot_locked
           FROM trades t LEFT JOIN trading_systems s ON s.id = t.trading_system_id LEFT JOIN trade_strategy_snapshots ss ON ss.trade_id=t.id WHERE t.id = ?`
        ).bind(String(params.id)).first();
        if (!trade) {
          return c.json(jsonRpcError(-32000, 'Trade not found', id), 404);
        }
        return c.json(jsonRpcResult({
          ...trade as any,
          chart_image: absoluteUrl(c.req.url, (trade as any).chart_image)
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
          risk_reward_ratio, result, review, chart_image)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const res = await db.prepare(sql).bind(
          symbol || 'XAUUSD', code || null, entry_time || null,
          lots || 1, entry_price ?? null, exit_price ?? null,
          direction || '多', normalizeTradeTimeframes(timeframe, '5M'),
          trading_system_id || null,
          trade_type || null, market_cycle || null, patterns || null,
          trade_logic || null, exit_type || null, return_amount ?? null,
          risk_reward_ratio ?? null, result || null, review || null,
          inlineChartUrl || params.chart_image_url || null
        ).run();

        const tradeId=Number(res.meta.last_row_id);
        await captureTradeStrategySnapshot(db,tradeId,trading_system_id?Number(trading_system_id):null);
        await updateMonthlyStats(db, entry_time);

        return c.json(jsonRpcResult({
          id: tradeId,
          success: true,
          chart_image: absoluteUrl(c.req.url, inlineChartUrl || params.chart_image_url || null)
        }, id));
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
          'return_amount', 'risk_reward_ratio', 'result', 'review', 'chart_image'];

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

        // 内联 base64 图片：覆盖 chart_image
        if (inlineChartUrl) {
          const idx = fields.indexOf('chart_image = ?');
          if (idx >= 0) {
            values[idx] = inlineChartUrl;
          } else {
            fields.push('chart_image = ?');
            values.push(inlineChartUrl);
          }
        } else if (params.chart_image_url !== undefined) {
          const idx = fields.indexOf('chart_image = ?');
          if (idx >= 0) {
            values[idx] = params.chart_image_url;
          } else {
            fields.push('chart_image = ?');
            values.push(params.chart_image_url);
          }
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

        return c.json(jsonRpcResult({
          success: true,
          chart_image: absoluteUrl(c.req.url, inlineChartUrl || params.chart_image_url || undefined)
        }, id));
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
        if (!params || !params.image_base64) {
          return c.json(jsonRpcError(-32602, 'Invalid params: image_base64 is required', id), 400);
        }
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
          return c.json(jsonRpcError(-32602, 'Invalid params: image category does not exist; create it with add_setting(category=image_category)', id), 400);
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

        // 可选：直接关联到某笔交易
        if (params.trade_id) {
          await db.prepare("UPDATE trades SET chart_image = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(stored.url, String(params.trade_id)).run();
        }

        return c.json(jsonRpcResult({
          success: true,
          id: stored.id,
          key: stored.key,
          url: absoluteUrl(c.req.url, stored.url),
          public_id: stored.public_id,
          storage: stored.storage,
          tg_uploaded: stored.tg_uploaded || false,
          tg_error: stored.tg_error || null,
          trade_id: params.trade_id || null,
          note: 'url 是无需登录即可在线查看、分享或嵌入的绝对链接'
        }, id));
      }

      case 'set_trade_chart': {
        if (!params || !params.trade_id || (!params.image_base64 && !params.image_url)) {
          return c.json(jsonRpcError(-32602, 'Invalid params: trade_id and image_base64 or image_url are required', id), 400);
        }
        let url: string;
        if (params.image_base64) {
          const filename = params.filename || `mcp-chart-${Date.now()}.png`;
          const mime = inferMime(filename, params.mime_type);
          let buffer: ArrayBuffer;
          try {
            buffer = base64ToArrayBuffer(String(params.image_base64));
          } catch (err: any) {
            return c.json(jsonRpcError(-32000, `Invalid base64: ${err.message}`, id), 400);
          }
          const stored = await storeImageBuffer(c.env, buffer, filename, mime, buffer.byteLength, params.caption || 'MCP K线图');
          if (!stored.ok) {
            return c.json(jsonRpcError(-32000, `Upload failed: ${stored.error}`, id), 400);
          }
          url = stored.url!;
        } else {
          url = String(params.image_url);
        }

        const exists = await db.prepare('SELECT id FROM trades WHERE id = ?').bind(String(params.trade_id)).first();
        if (!exists) {
          return c.json(jsonRpcError(-32000, 'Trade not found', id), 404);
        }

        await db.prepare("UPDATE trades SET chart_image = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(url, String(params.trade_id)).run();

        return c.json(jsonRpcResult({
          success: true,
          trade_id: params.trade_id,
          chart_image: absoluteUrl(c.req.url, url)
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

      case 'update_image': {
        if (!params?.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const image = await db.prepare(
          'SELECT id, display_name, category, tags, caption, resource_url FROM images WHERE id = ?'
        ).bind(String(params.id)).first<any>();
        if (!image) return c.json(jsonRpcError(-32000, 'Image not found', id), 404);
        const imageCategory = params.category === undefined
          ? String(image.category || '').trim()
          : String(params.category || '').trim();
        if (!(await imageCategoryExists(db, imageCategory))) {
          return c.json(jsonRpcError(-32602, 'Invalid params: image category does not exist; create it with add_setting(category=image_category)', id), 400);
        }
        let imageResourceUrl: string | null;
        try {
          imageResourceUrl = params.resource_url === undefined ? image.resource_url : normalizeExternalUrl(params.resource_url);
        } catch (error) {
          return c.json(jsonRpcError(-32602, error instanceof Error ? error.message : 'Invalid resource URL', id), 400);
        }
        await db.prepare('UPDATE images SET display_name = ?, category = ?, tags = ?, caption = ?, resource_url = ? WHERE id = ?')
          .bind(
            params.display_name === undefined ? image.display_name : (params.display_name || null),
            imageCategory || null,
            params.tags === undefined ? image.tags : (params.tags || null),
            params.caption === undefined ? image.caption : (params.caption || null),
            imageResourceUrl,
            String(params.id)
          ).run();
        return c.json(jsonRpcResult({ success: true, id: params.id }, id));
      }

      case 'delete_image': {
        if (!params?.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const image = await db.prepare('SELECT * FROM images WHERE id = ?').bind(String(params.id)).first<any>();
        if (!image) return c.json(jsonRpcError(-32000, 'Image not found', id), 404);
        const result = await deleteStoredImage(c.env, image);
        return c.json(jsonRpcResult({ success: true, id: params.id, ...result }, id));
      }

      case 'reconcile_images': {
        const jobId=await createMaintenanceJob(c.env,'reconcile_images');
        try{
          await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'reconcile_images',jobId},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});
          return c.json(jsonRpcResult({success:true,status:'queued',job_id:jobId},id));
        }catch(error){
          await updateMaintenanceJob(c.env,jobId,'failed',{error:error instanceof Error?error.message:String(error)});
          return c.json(jsonRpcError(-32000,'Unable to start image reconciliation job',id),500);
        }
      }

      // ---------- stats ----------
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

      case 'get_rule': {
        if (!params || !params.id) {
          return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        }
        const rule = await db.prepare('SELECT * FROM trading_rules WHERE id = ?').bind(String(params.id)).first();
        if (!rule) {
          return c.json(jsonRpcError(-32000, 'Rule not found', id), 404);
        }
        return c.json(jsonRpcResult(rule, id));
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

      case 'delete_rule': {
        if (!params?.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const res = await db.prepare('DELETE FROM trading_rules WHERE id = ?').bind(String(params.id)).run();
        if (!res.meta.changes) return c.json(jsonRpcError(-32000, 'Rule not found', id), 404);
        return c.json(jsonRpcResult({ success: true, id: params.id }, id));
      }

      // ---------- trading systems / mind map ----------
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

      case 'add_system': {
        const p = params || {};
        const name = String(p.name || '').trim();
        if (!name || name.length > 100) {
          return c.json(jsonRpcError(-32602, 'Invalid params: name is required and must be <= 100 characters', id), 400);
        }
        const status = ['draft', 'active', 'archived'].includes(String(p.status)) ? String(p.status) : 'draft';
        const color = /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? String(p.color) : '#3ec9c5';
        const category = await resolveActiveMindmapCategory(db, p.category);
        if (!category) return c.json(jsonRpcError(-32602, 'Invalid params: mind map category does not exist or is disabled', id), 400);
        let resourceUrl: string | null;
        try { resourceUrl = normalizeExternalUrl(p.resource_url); }
        catch (error) { return c.json(jsonRpcError(-32602, error instanceof Error ? error.message : 'Invalid resource URL', id), 400); }
        const result = await db.prepare(
          `INSERT INTO trading_systems (name, category, description, original_prompt, resource_url, markets, timeframes, status, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(name, category, p.description ? String(p.description) : null, String(p.original_prompt || p.description || name).slice(0,12000), resourceUrl, p.markets ? String(p.markets) : null,
          p.timeframes ? String(p.timeframes) : null, status, color).run();
        const systemId = Number(result.meta.last_row_id);
        const root = await db.prepare(
          `INSERT INTO trading_system_nodes (system_id, title, content, node_type) VALUES (?, ?, ?, 'root')`
        ).bind(systemId, name, p.description ? String(p.description) : '完整交易决策流程').run();
        const rootId = Number(root.meta.last_row_id);
        if (p.template !== false) {
          const branches = [
            ['市场环境', '先确认市场结构与允许交易的时段', 'setup'],
            ['入场确认', '所有入场条件满足后才执行', 'entry'],
            ['风险管理', '明确仓位、止损和单笔风险上限', 'risk'],
            ['出场计划', '入场前确定止盈与失效条件', 'exit'],
            ['复盘清单', '记录执行偏差并更新系统', 'review']
          ];
          await db.batch(branches.map((branch, index) => db.prepare(
            `INSERT INTO trading_system_nodes (system_id, parent_id, title, content, node_type, sort_order)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(systemId, rootId, branch[0], branch[1], branch[2], index)));
        }
        return c.json(jsonRpcResult({ id: systemId, root_id: rootId, success: true }, id));
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
        if (!category) return c.json(jsonRpcError(-32602, 'Invalid params: mind map category does not exist or is disabled; use list_settings with category mindmap_category', id),400);
        let resourceUrl: string | null;
        try { resourceUrl = normalizeExternalUrl(p.resource_url); }
        catch (error) { return c.json(jsonRpcError(-32602,error instanceof Error ? error.message : 'Invalid resource URL',id),400); }
        const created = await db.prepare(
          `INSERT INTO trading_systems(name,category,description,original_prompt,resource_url,markets,timeframes,status,color) VALUES(?,?,?,?,?,?,?,?,?)`
        ).bind(name,category,p.description ? String(p.description) : null,String(p.original_prompt || p.description || name).slice(0,12000),resourceUrl,p.markets ? String(p.markets) : null,p.timeframes ? String(p.timeframes) : null,status,color).run();
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
            quality:'detailed',message:'详细脑图已一次性创建；请调用 get_system 检查具体内容，必要时使用 expand_mindmap 继续精修'
          },id));
        } catch (error) {
          await db.batch([
            db.prepare('DELETE FROM trading_system_nodes WHERE system_id=?').bind(systemId),
            db.prepare('DELETE FROM trading_systems WHERE id=?').bind(systemId)
          ]);
          return c.json(jsonRpcError(-32602,`Detailed mind map creation failed: ${error instanceof Error ? error.message : String(error)}`,id),400);
        }
      }

      case 'expand_mindmap': {
        const p = params || {};
        const systemId = Number(p.system_id);
        if (!Number.isInteger(systemId) || systemId <= 0) return c.json(jsonRpcError(-32602,'Invalid params: system_id is required',id),400);
        let nodes: MindmapBatchNode[];
        try { nodes = parseMindmapBatchNodes(p.nodes); }
        catch (error) { return c.json(jsonRpcError(-32602,`Mind map expansion validation failed: ${error instanceof Error ? error.message : String(error)}`,id),400); }
        const system = await db.prepare('SELECT id FROM trading_systems WHERE id=?').bind(systemId).first();
        if (!system) return c.json(jsonRpcError(-32000,'Trading system not found',id),404);
        const anchor = p.anchor_id
          ? await db.prepare('SELECT id FROM trading_system_nodes WHERE id=? AND system_id=?').bind(Number(p.anchor_id),systemId).first<{id:number}>()
          : await db.prepare('SELECT id FROM trading_system_nodes WHERE system_id=? AND parent_id IS NULL LIMIT 1').bind(systemId).first<{id:number}>();
        if (!anchor) return c.json(jsonRpcError(-32602,'Invalid anchor_id: node does not belong to this mind map',id),400);
        try {
          const report = await insertMindmapBatchNodes(db,systemId,Number(anchor.id),nodes);
          const count = await db.prepare('SELECT COUNT(*) AS count FROM trading_system_nodes WHERE system_id=?').bind(systemId).first<{count:number}>();
          return c.json(jsonRpcResult({
            success:true,system_id:systemId,anchor_id:Number(anchor.id),created_nodes:report.created,
            node_count:Number(count?.count || 0),max_added_depth:report.max_depth,node_ids:report.node_ids,
            message:'节点已批量加入，请调用 get_system 检查层级与具体内容'
          },id));
        } catch (error) {
          return c.json(jsonRpcError(-32602,`Mind map expansion failed: ${error instanceof Error ? error.message : String(error)}`,id),400);
        }
      }

      case 'refine_mindmap': {
        const systemId=Number(params?.system_id);
        if(!Number.isInteger(systemId)||systemId<=0)return c.json(jsonRpcError(-32602,'Invalid params: system_id is required',id),400);
        if(!await db.prepare('SELECT id FROM trading_systems WHERE id=?').bind(systemId).first())return c.json(jsonRpcError(-32000,'Mind map not found',id),404);
        const jobId=await createAiJob(c.env,'mindmap_refinement',String(systemId));
        try{await c.env.BACKUP_WORKFLOW.create({id:jobId,params:{action:'mindmap_refinement',jobId,systemId,instructions:String(params?.instructions||'').slice(0,4000)},retention:{successRetention:'7 days',errorRetention:'30 days'},locationHint:'apac'});return c.json(jsonRpcResult({success:true,status:'queued',job_id:jobId},id));}
        catch(error){await updateAiJob(c.env,jobId,'failed',{error:aiErrorMessage(error)});return c.json(jsonRpcError(-32000,'Unable to start mind map refinement job',id),500);}
      }

      case 'get_ai_job': {
        const row=await db.prepare('SELECT * FROM ai_jobs WHERE id=?').bind(String(params?.job_id||'')).first<any>();
        if(!row)return c.json(jsonRpcError(-32000,'AI job not found',id),404);
        return c.json(jsonRpcResult({...row,result:row.result_json?JSON.parse(row.result_json):null,result_json:undefined},id));
      }

      case 'apply_mindmap_refinement': {
        const systemId=Number(params?.system_id),draftId=String(params?.draft_id||'');
        const row=await db.prepare("SELECT * FROM mindmap_refinement_drafts WHERE id=? AND system_id=? AND status='draft'").bind(draftId,systemId).first<any>();
        if(!row)return c.json(jsonRpcError(-32000,'Refinement draft not found or already handled',id),404);
        const current=await db.prepare('SELECT updated_at FROM trading_systems WHERE id=?').bind(systemId).first<{updated_at:string}>();
        if(current?.updated_at!==row.base_updated_at)return c.json(jsonRpcError(-32009,'Mind map changed after the draft was generated; generate a new draft',id),409);
        try{
          const proposed=JSON.parse(row.proposed_snapshot_json) as MindmapSnapshot,base=JSON.parse(row.base_snapshot_json) as MindmapSnapshot;
          const excluded=new Set((Array.isArray(params?.excluded_node_ids)?params.excluded_node_ids:[]).map(Number));let changed=true;
          while(changed){changed=false;for(const node of proposed.nodes)if(node.parent_id!==null&&excluded.has(Number(node.parent_id))&&!excluded.has(Number(node.id))){excluded.add(Number(node.id));changed=true;}}
          const nodes=proposed.nodes.filter(node=>node.parent_id===null||!excluded.has(Number(node.id))).map(node=>({...node}));
          const preserve=new Set((Array.isArray(params?.preserve_removed_node_ids)?params.preserve_removed_node_ids:[]).map(Number));let expanded=true;while(expanded){expanded=false;for(const node of base.nodes)if(node.parent_id!==null&&preserve.has(Number(node.parent_id))&&!preserve.has(Number(node.id))){preserve.add(Number(node.id));expanded=true;}}
          let next=Math.max(...nodes.map(node=>Number(node.id)),1)+1;const oldToNew=new Map<number,number>();
          for(const node of base.nodes.filter(item=>item.parent_id!==null&&preserve.has(Number(item.id)))){const newId=next++;oldToNew.set(Number(node.id),newId);nodes.push({...node,id:newId,parent_id:oldToNew.get(Number(node.parent_id))||nodes[0].id,sort_order:999});}
          if(nodes.length<2)throw new Error('At least one non-root node must remain');
          const versionId=await saveMindmapVersion(db,systemId,'before_refine_apply','MCP 应用 AI 精修草稿前');
          await replaceMindmapFromSnapshot(db,systemId,{...proposed,nodes});
          await db.prepare("UPDATE mindmap_refinement_drafts SET status='applied',applied_at=datetime('now') WHERE id=?").bind(draftId).run();
          return c.json(jsonRpcResult({success:true,system_id:systemId,draft_id:draftId,version_id:versionId,node_count:nodes.length},id));
        }catch(error){return c.json(jsonRpcError(-32000,error instanceof Error?error.message:'Apply refinement failed',id),400);}
      }

      case 'discard_mindmap_refinement': {
        const result=await db.prepare("UPDATE mindmap_refinement_drafts SET status='discarded' WHERE id=? AND system_id=? AND status='draft'").bind(String(params?.draft_id||''),Number(params?.system_id)).run();
        if(!result.meta.changes)return c.json(jsonRpcError(-32000,'Refinement draft not found or already handled',id),404);
        return c.json(jsonRpcResult({success:true},id));
      }

      case 'list_mindmap_versions': {
        const systemId=Number(params?.system_id);
        if(!Number.isInteger(systemId)||systemId<=0)return c.json(jsonRpcError(-32602,'Invalid params: system_id is required',id),400);
        const rows=await db.prepare('SELECT id,system_id,action,label,created_at,length(snapshot_json) AS snapshot_size FROM mindmap_versions WHERE system_id=? ORDER BY id DESC LIMIT 30').bind(systemId).all();
        return c.json(jsonRpcResult(rows.results,id));
      }

      case 'save_mindmap_version': {
        const systemId=Number(params?.system_id);
        if(!Number.isInteger(systemId)||systemId<=0)return c.json(jsonRpcError(-32602,'Invalid params: system_id is required',id),400);
        try { const versionId=await saveMindmapVersion(db,systemId,'manual',String(params?.label||'MCP 手动保存').slice(0,100));return c.json(jsonRpcResult({success:true,id:versionId,system_id:systemId},id)); }
        catch(error){return c.json(jsonRpcError(-32000,error instanceof Error?error.message:'Save version failed',id),400);}
      }

      case 'restore_mindmap_version': {
        const systemId=Number(params?.system_id),versionId=Number(params?.version_id);
        if(!Number.isInteger(systemId)||!Number.isInteger(versionId))return c.json(jsonRpcError(-32602,'Invalid params: system_id and version_id are required',id),400);
        const row=await db.prepare('SELECT snapshot_json FROM mindmap_versions WHERE id=? AND system_id=?').bind(versionId,systemId).first<{snapshot_json:string}>();
        if(!row)return c.json(jsonRpcError(-32000,'Mind map version not found',id),404);
        try { await saveMindmapVersion(db,systemId,'before_restore','MCP 回撤前自动版本');await replaceMindmapFromSnapshot(db,systemId,JSON.parse(row.snapshot_json));return c.json(jsonRpcResult({success:true,system_id:systemId,version_id:versionId},id)); }
        catch(error){return c.json(jsonRpcError(-32000,error instanceof Error?error.message:'Restore failed',id),400);}
      }

      case 'delete_mindmap_version': {
        const systemId=Number(params?.system_id),versionId=Number(params?.version_id);
        if(!Number.isInteger(systemId)||!Number.isInteger(versionId))return c.json(jsonRpcError(-32602,'Invalid params: system_id and version_id are required',id),400);
        const version=await db.prepare('SELECT id FROM mindmap_versions WHERE id=? AND system_id=?').bind(versionId,systemId).first();
        if(!version)return c.json(jsonRpcError(-32000,'Mind map version not found',id),404);
        await db.batch([
          db.prepare('UPDATE trade_strategy_snapshots SET version_id=NULL WHERE version_id=?').bind(versionId),
          db.prepare('DELETE FROM mindmap_versions WHERE id=? AND system_id=?').bind(versionId,systemId)
        ]);
        return c.json(jsonRpcResult({success:true,system_id:systemId,version_id:versionId},id));
      }

      case 'duplicate_mindmap': {
        try { const newId=await cloneMindmap(db,Number(params?.system_id),{name:String(params?.name||'').trim()||undefined});return c.json(jsonRpcResult({success:true,id:newId},id)); }
        catch(error){return c.json(jsonRpcError(-32000,error instanceof Error?error.message:'Duplicate failed',id),400);}
      }

      case 'save_mindmap_template': {
        try { const newId=await cloneMindmap(db,Number(params?.system_id),{name:String(params?.name||'').trim()||undefined,isTemplate:true});return c.json(jsonRpcResult({success:true,id:newId},id)); }
        catch(error){return c.json(jsonRpcError(-32000,error instanceof Error?error.message:'Save template failed',id),400);}
      }

      case 'list_mindmap_templates': {
        const rows=await db.prepare(`SELECT s.*,COUNT(n.id) AS node_count FROM trading_systems s LEFT JOIN trading_system_nodes n ON n.system_id=s.id WHERE s.is_template=1 GROUP BY s.id ORDER BY s.updated_at DESC`).all();
        return c.json(jsonRpcResult(rows.results,id));
      }

      case 'create_mindmap_from_template': {
        const template=await db.prepare('SELECT * FROM trading_systems WHERE id=? AND is_template=1').bind(Number(params?.template_id)).first<Record<string,any>>();
        if(!template)return c.json(jsonRpcError(-32000,'Mind map template not found',id),404);
        const category=await resolveActiveMindmapCategory(db,params?.category||template.category);
        if(!category)return c.json(jsonRpcError(-32602,'Invalid or disabled mind map category',id),400);
        try { const newId=await cloneMindmap(db,Number(template.id),{name:String(params?.name||'').trim()||String(template.name).replace(/\s*模板$/,''),category});return c.json(jsonRpcResult({success:true,id:newId},id)); }
        catch(error){return c.json(jsonRpcError(-32000,error instanceof Error?error.message:'Create from template failed',id),400);}
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
        for (const field of ['name', 'category', 'description', 'original_prompt', 'resource_url', 'markets', 'timeframes', 'status', 'color']) {
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

      case 'delete_system': {
        if (!params?.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        await db.prepare('UPDATE trades SET trading_system_id = NULL WHERE trading_system_id = ?').bind(String(params.id)).run();
        await db.prepare('DELETE FROM trading_system_nodes WHERE system_id = ?').bind(String(params.id)).run();
        const result = await db.prepare('DELETE FROM trading_systems WHERE id = ?').bind(String(params.id)).run();
        if (!result.meta.changes) return c.json(jsonRpcError(-32000, 'Trading system not found', id), 404);
        return c.json(jsonRpcResult({ success: true, id: params.id }, id));
      }

      case 'add_system_node': {
        const p = params || {};
        if (!p.system_id || !p.parent_id || !String(p.title || '').trim()) {
          return c.json(jsonRpcError(-32602, 'Invalid params: system_id, parent_id and title are required', id), 400);
        }
        const parent = await db.prepare('SELECT id FROM trading_system_nodes WHERE id = ? AND system_id = ?')
          .bind(String(p.parent_id), String(p.system_id)).first();
        if (!parent) return c.json(jsonRpcError(-32602, 'Parent does not belong to this trading system', id), 400);
        const nodeType = String(p.node_type || 'condition').trim();
        if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(nodeType) || !await isAvailableSystemNodeType(db, nodeType)) {
          return c.json(jsonRpcError(-32602, 'Invalid params: node_type does not exist or is disabled; use list_settings with category system_node_type', id), 400);
        }
        const result = await db.prepare(
          `INSERT INTO trading_system_nodes (system_id, parent_id, rule_id, title, content, node_type, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(String(p.system_id), String(p.parent_id), p.rule_id || null, String(p.title).trim(),
          p.content ? String(p.content) : null, nodeType, Number(p.sort_order) || 0).run();
        await db.prepare("UPDATE trading_systems SET updated_at = datetime('now') WHERE id = ?").bind(String(p.system_id)).run();
        return c.json(jsonRpcResult({ success: true, id: result.meta.last_row_id }, id));
      }

      case 'update_system_node': {
        const p = params || {};
        if (!p.system_id || !p.id) return c.json(jsonRpcError(-32602, 'Invalid params: system_id and id are required', id), 400);
        const node = await db.prepare('SELECT parent_id, node_type FROM trading_system_nodes WHERE id = ? AND system_id = ?')
          .bind(String(p.id), String(p.system_id)).first<{ parent_id: number | null; node_type: string }>();
        if (!node) return c.json(jsonRpcError(-32000, 'System node not found', id), 404);
        if (p.parent_id !== undefined) {
          if (node.parent_id === null) return c.json(jsonRpcError(-32602, 'Root node cannot be moved', id), 400);
          const invalid = Number(p.parent_id) === Number(p.id) || !await db.prepare(
            'SELECT id FROM trading_system_nodes WHERE id = ? AND system_id = ?'
          ).bind(String(p.parent_id), String(p.system_id)).first();
          const descendant = await db.prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM trading_system_nodes WHERE parent_id = ?
               UNION ALL SELECT n.id FROM trading_system_nodes n JOIN descendants d ON n.parent_id = d.id
             ) SELECT id FROM descendants WHERE id = ? LIMIT 1`
          ).bind(String(p.id), String(p.parent_id)).first();
          if (invalid || descendant) return c.json(jsonRpcError(-32602, 'Invalid parent or cycle detected', id), 400);
        }
        if (p.node_type !== undefined) {
          const nextType = String(p.node_type).trim();
          if (node.parent_id === null && nextType !== 'root') {
            return c.json(jsonRpcError(-32602, 'Root node type cannot be changed', id), 400);
          }
          if (node.parent_id !== null && nextType !== node.node_type && (!/^[\p{L}\p{N}_-]{1,40}$/u.test(nextType) || !await isAvailableSystemNodeType(db, nextType))) {
            return c.json(jsonRpcError(-32602, 'Invalid params: node_type does not exist or is disabled; use list_settings with category system_node_type', id), 400);
          }
        }
        const fields: string[] = [];
        const values: any[] = [];
        for (const field of ['parent_id', 'rule_id', 'title', 'content', 'node_type', 'sort_order', 'is_collapsed']) {
          if (p[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(field === 'is_collapsed' ? (p[field] ? 1 : 0) : p[field]);
          }
        }
        if (!fields.length) return c.json(jsonRpcError(-32602, 'No fields to update', id), 400);
        fields.push("updated_at = datetime('now')");
        values.push(String(p.id), String(p.system_id));
        await db.prepare(`UPDATE trading_system_nodes SET ${fields.join(', ')} WHERE id = ? AND system_id = ?`).bind(...values).run();
        await db.prepare("UPDATE trading_systems SET updated_at = datetime('now') WHERE id = ?").bind(String(p.system_id)).run();
        return c.json(jsonRpcResult({ success: true, id: p.id }, id));
      }

      case 'delete_system_node': {
        const p = params || {};
        if (!p.system_id || !p.id) return c.json(jsonRpcError(-32602, 'Invalid params: system_id and id are required', id), 400);
        const node = await db.prepare('SELECT parent_id FROM trading_system_nodes WHERE id = ? AND system_id = ?')
          .bind(String(p.id), String(p.system_id)).first<{ parent_id: number | null }>();
        if (!node) return c.json(jsonRpcError(-32000, 'System node not found', id), 404);
        if (node.parent_id === null) return c.json(jsonRpcError(-32602, 'Root node cannot be deleted', id), 400);
        await db.prepare('DELETE FROM trading_system_nodes WHERE id = ? AND system_id = ?')
          .bind(String(p.id), String(p.system_id)).run();
        await db.prepare("UPDATE trading_systems SET updated_at = datetime('now') WHERE id = ?").bind(String(p.system_id)).run();
        return c.json(jsonRpcResult({ success: true, id: p.id }, id));
      }

      // ---------- custom settings ----------
      case 'list_settings': {
        const p = params || {};
        let where = 'WHERE 1=1';
        const settingParams: any[] = [];
        if (p.category) { where += ' AND category = ?'; settingParams.push(String(p.category)); }
        if (typeof p.active === 'boolean') { where += ' AND is_active = ?'; settingParams.push(p.active ? 1 : 0); }
        const settings = await db.prepare(
          `SELECT * FROM settings ${where} ORDER BY category, sort_order ASC, id ASC`
        ).bind(...settingParams).all();
        return c.json(jsonRpcResult(settings.results, id));
      }

      case 'add_setting': {
        const p = params || {};
        const category = String(p.category || '').trim();
        const label = String(p.label || '').trim();
        const value = String(p.value || '').trim();
        if (!/^[a-z0-9_-]{1,40}$/i.test(category) || !label || !value) {
          return c.json(jsonRpcError(-32602, 'Invalid params: category, label and value are required; category must use letters/numbers/_/-', id), 400);
        }
        if (category === 'system_node_type' && !/^[\p{L}\p{N}_-]{1,40}$/u.test(value)) {
          return c.json(jsonRpcError(-32602, 'Invalid system node type value', id), 400);
        }
        const res = await db.prepare(
          `INSERT INTO settings (category, label, value, color, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(category, label, value, p.color ? String(p.color) : null, Number(p.sort_order) || 0, p.is_active === false ? 0 : 1).run();
        return c.json(jsonRpcResult({ id: res.meta.last_row_id, success: true }, id));
      }

      case 'update_setting': {
        const p = params || {};
        if (!p.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const current = await db.prepare('SELECT category, value FROM settings WHERE id = ?').bind(String(p.id))
          .first<{ category: string; value: string }>();
        if (!current) return c.json(jsonRpcError(-32000, 'Setting not found', id), 404);
        if (p.category !== undefined && !/^[a-z0-9_-]{1,40}$/i.test(String(p.category))) {
          return c.json(jsonRpcError(-32602, 'Invalid params: category must use letters/numbers/_/-', id), 400);
        }
        const nextCategory = String(p.category ?? current.category);
        const nextValue = String(p.value ?? current.value).trim();
        if (nextCategory === 'system_node_type' && !/^[\p{L}\p{N}_-]{1,40}$/u.test(nextValue)) {
          return c.json(jsonRpcError(-32602, 'Invalid system node type value', id), 400);
        }
        if (current.category === 'system_node_type' && nextCategory !== 'system_node_type') {
          const used = await db.prepare('SELECT id FROM trading_system_nodes WHERE node_type = ? LIMIT 1').bind(current.value).first();
          if (used) return c.json(jsonRpcError(-32000, 'System node type is in use and cannot change category', id), 409);
        }
        if (current.category === 'image_category' && nextCategory !== 'image_category') {
          const used = await db.prepare('SELECT id FROM images WHERE category = ? LIMIT 1').bind(current.value).first();
          if (used) return c.json(jsonRpcError(-32000, 'Image category is in use and cannot change category', id), 409);
        }
        if (current.category === 'mindmap_category' && nextCategory !== 'mindmap_category') {
          const used = await db.prepare('SELECT id FROM trading_systems WHERE category = ? LIMIT 1').bind(current.value).first();
          if (used) return c.json(jsonRpcError(-32000, 'Mind map category is in use and cannot change category', id), 409);
          const otherCategory = await db.prepare(
            "SELECT id FROM settings WHERE category = 'mindmap_category' AND id != ? LIMIT 1"
          ).bind(String(p.id)).first();
          if (!otherCategory) return c.json(jsonRpcError(-32000, 'At least one mind map category is required', id), 409);
        }
        if (current.category === 'mindmap_category' && p.is_active === false) {
          const used = await db.prepare('SELECT id FROM trading_systems WHERE category = ? LIMIT 1').bind(current.value).first();
          if (used) return c.json(jsonRpcError(-32000, 'Mind map category is in use; move its mind maps before disabling it', id), 409);
          const otherActive = await db.prepare(
            "SELECT id FROM settings WHERE category = 'mindmap_category' AND is_active = 1 AND id != ? LIMIT 1"
          ).bind(String(p.id)).first();
          if (!otherActive) return c.json(jsonRpcError(-32000, 'At least one active mind map category is required', id), 409);
        }
        const fields: string[] = [];
        const values: any[] = [];
        for (const field of ['category', 'label', 'value', 'color', 'sort_order', 'is_active']) {
          if (p[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(field === 'is_active' ? (p[field] ? 1 : 0) : p[field]);
          }
        }
        if (!fields.length) return c.json(jsonRpcError(-32602, 'No fields to update', id), 400);
        fields.push("updated_at = datetime('now')");
        values.push(String(p.id));
        const updateSetting = db.prepare(`UPDATE settings SET ${fields.join(', ')} WHERE id = ?`).bind(...values);
        if (current.category === 'system_node_type' && nextCategory === 'system_node_type' && nextValue !== current.value) {
          await db.batch([
            updateSetting,
            db.prepare("UPDATE trading_system_nodes SET node_type = ?, updated_at = datetime('now') WHERE node_type = ?")
              .bind(nextValue, current.value)
          ]);
        } else if (current.category === 'image_category' && nextCategory === 'image_category' && nextValue !== current.value) {
          await db.batch([
            updateSetting,
            db.prepare('UPDATE images SET category = ? WHERE category = ?').bind(nextValue, current.value)
          ]);
        } else if (current.category === 'mindmap_category' && nextCategory === 'mindmap_category' && nextValue !== current.value) {
          await db.batch([
            updateSetting,
            db.prepare("UPDATE trading_systems SET category = ?, updated_at = datetime('now') WHERE category = ?").bind(nextValue, current.value)
          ]);
        } else {
          await updateSetting.run();
        }
        return c.json(jsonRpcResult({ success: true, id: p.id }, id));
      }

      case 'delete_setting': {
        if (!params?.id) return c.json(jsonRpcError(-32602, 'Invalid params: id is required', id), 400);
        const current = await db.prepare('SELECT category, value FROM settings WHERE id = ?').bind(String(params.id))
          .first<{ category: string; value: string }>();
        if (!current) return c.json(jsonRpcError(-32000, 'Setting not found', id), 404);
        if (current.category === 'system_node_type') {
          const used = await db.prepare('SELECT id FROM trading_system_nodes WHERE node_type = ? LIMIT 1').bind(current.value).first();
          if (used) return c.json(jsonRpcError(-32000, 'System node type is in use; update related nodes first', id), 409);
        }
        if (current.category === 'image_category') {
          await db.batch([
            db.prepare('UPDATE images SET category = NULL WHERE category = ?').bind(current.value),
            db.prepare('DELETE FROM settings WHERE id = ?').bind(String(params.id))
          ]);
        } else if (current.category === 'mindmap_category') {
          const [used, categoryCount] = await Promise.all([
            db.prepare('SELECT id FROM trading_systems WHERE category = ? LIMIT 1').bind(current.value).first(),
            db.prepare("SELECT COUNT(*) AS count FROM settings WHERE category = 'mindmap_category'").first<{ count: number }>()
          ]);
          if (used) return c.json(jsonRpcError(-32000, 'Mind map category is in use; move its mind maps before deleting it', id), 409);
          if (Number(categoryCount?.count || 0) <= 1) return c.json(jsonRpcError(-32000, 'At least one mind map category is required', id), 409);
          await db.prepare('DELETE FROM settings WHERE id = ?').bind(String(params.id)).run();
        } else {
          await db.prepare('DELETE FROM settings WHERE id = ?').bind(String(params.id)).run();
        }
        return c.json(jsonRpcResult({ success: true, id: params.id }, id));
      }

      case 'get_market_candles': {
        try {
          const data = await fetchMarketCandles(db, {
            symbol: params?.symbol,
            interval: params?.interval,
            outputsize: params?.outputsize,
            fresh: params?.fresh === true
          },c.env.CONFIG_ENCRYPTION_KEY,{service:c.env.TD_FOREX,signal:c.req.raw.signal});
          return c.json(jsonRpcResult(data, id));
        } catch (e: any) {
          return c.json(jsonRpcError(-32000, `Market data failed: ${e?.message || String(e)}`, id), 502);
        }
      }

      // ---------- unknown ----------
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
