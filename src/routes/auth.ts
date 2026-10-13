import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { generateToken, hashPassword, sha256Text, timingSafeTextEqual, verifyPassword } from '../lib/crypto';

const SESSION_DURATION_DAYS = 7;
const SESSION_HASH_PREFIX = 'sha256$';
const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/status'
]);

type ActiveSession = { id: number; username: string; stored_token: string };

export async function hashSessionToken(token: string): Promise<string> {
  return `${SESSION_HASH_PREFIX}${await sha256Text(token)}`;
}

async function findActiveSession(db: D1Database, token: string): Promise<ActiveSession | null> {
  const digest = await hashSessionToken(token);
  const session = await db.prepare(
    `SELECT s.token AS stored_token,u.id,u.username FROM sessions s
     JOIN users u ON s.user_id=u.id
     WHERE s.token IN (?,?) AND s.expires_at>datetime('now')
     ORDER BY CASE WHEN s.token=? THEN 0 ELSE 1 END LIMIT 1`
  ).bind(digest, token, digest).first<ActiveSession>();

  if (session?.stored_token === token) {
    await db.prepare('UPDATE sessions SET token=? WHERE token=?').bind(digest, token).run();
    session.stored_token = digest;
  }
  return session;
}

async function cleanupAuthRecords(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    db.prepare("DELETE FROM login_attempts WHERE attempted_at <= datetime('now', '-15 minutes')")
  ]);
}

async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 3600 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19);
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await hashSessionToken(token), userId, expiresAt).run();
  return token;
}

function setSessionCookie(context: Context<AppEnv>, token: string): void {
  setCookie(context, 'session', token, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DURATION_DAYS * 24 * 3600
  });
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.use('/api/*', async (context, next) => {
    const path = context.req.path;
    if (path === '/api/mcp' || PUBLIC_API_PATHS.has(path) || path.startsWith('/api/public/shares/')) {
      await next();
      return;
    }

    const token = getCookie(context, 'session');
    if (!token) return context.json({ error: '未登录' }, 401);

    const session = await findActiveSession(context.env.DB, token);
    if (!session) return context.json({ error: '会话已过期，请重新登录' }, 401);

    context.set('user', { id: session.id, username: session.username });
    await next();
  });

  app.get('/api/auth/status', async context => {
    const count = await context.env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
    const initialized = (count?.cnt || 0) > 0;
    let authenticated = false;
    let username: string | null = null;
    const token = getCookie(context, 'session');
    if (token) {
      const session = await findActiveSession(context.env.DB, token);
      authenticated = Boolean(session);
      username = session?.username || null;
    }
    return context.json({ initialized, authenticated, username, setup_token_required: !initialized });
  });

  app.post('/api/auth/setup', async context => {
    const db = context.env.DB;
    const count = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
    if ((count?.cnt || 0) > 0) return context.json({ error: '系统已初始化，请直接登录' }, 400);

    const setupSecret = String(context.env.SETUP_TOKEN || '').trim();
    if (!setupSecret) return context.json({ error: '系统尚未配置一次性初始化密钥 SETUP_TOKEN' }, 503);

    const parsed = z.object({
      password: z.string().min(8).max(256),
      setup_token: z.string().min(1).max(512)
    }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '管理员密码至少 8 位，并且必须提供初始化密钥' }, 400);
    if (!await timingSafeTextEqual(parsed.data.setup_token, setupSecret)) {
      return context.json({ error: '初始化密钥错误' }, 403);
    }

    const salt = generateToken(16);
    const result = await db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
      .bind('owner', await hashPassword(parsed.data.password, salt), salt).run();
    setSessionCookie(context, await createSession(db, Number(result.meta.last_row_id)));
    return context.json({ success: true }, 201);
  });

  app.post('/api/auth/login', async context => {
    const parsed = z.object({ password: z.string().min(1).max(256) }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '请输入密码' }, 400);

    const db = context.env.DB;
    await cleanupAuthRecords(db);
    const ip = context.req.header('CF-Connecting-IP');
    const failures = ip ? await db.prepare(
      `SELECT COUNT(*) as cnt FROM login_attempts
       WHERE ip = ? AND attempted_at > datetime('now', '-15 minutes')`
    ).bind(ip).first<{ cnt: number }>() : null;
    if ((failures?.cnt || 0) >= 5) return context.json({ error: '尝试次数过多，请 15 分钟后再试' }, 429);

    const user = await db.prepare('SELECT * FROM users LIMIT 1')
      .first<{ id: number; username: string; password_hash: string; salt: string }>();
    if (!user) return context.json({ error: '系统未初始化' }, 400);

    if (!await verifyPassword(parsed.data.password, user.salt, user.password_hash)) {
      if (ip) await db.prepare('INSERT INTO login_attempts (ip) VALUES (?)').bind(ip).run();
      return context.json({ error: '密码错误' }, 401);
    }

    if (ip) await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    if (!user.password_hash.startsWith('pbkdf2$')) {
      const newSalt = generateToken(16);
      await db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
        .bind(await hashPassword(parsed.data.password, newSalt), newSalt, user.id).run();
    }
    setSessionCookie(context, await createSession(db, user.id));
    return context.json({ success: true });
  });

  app.post('/api/auth/logout', async context => {
    const token = getCookie(context, 'session');
    if (token) {
      await context.env.DB.prepare('DELETE FROM sessions WHERE token IN (?,?)')
        .bind(await hashSessionToken(token), token).run();
    }
    deleteCookie(context, 'session', { path: '/' });
    return context.json({ success: true });
  });

  app.get('/api/auth/me', context => {
    const user = context.get('user');
    return context.json({ username: user.username, id: user.id });
  });

  app.post('/api/auth/change-password', async context => {
    const parsed = z.object({
      old_password: z.string().min(1).max(256),
      new_password: z.string().min(8).max(256)
    }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '新密码至少 8 位' }, 400);

    const db = context.env.DB;
    const user = context.get('user');
    const dbUser = await db.prepare('SELECT password_hash,salt FROM users WHERE id = ?')
      .bind(user.id).first<{ password_hash: string; salt: string }>();
    if (!dbUser) return context.json({ error: '用户不存在' }, 404);
    if (!await verifyPassword(parsed.data.old_password, dbUser.salt, dbUser.password_hash)) {
      return context.json({ error: '原密码错误' }, 400);
    }

    const salt = generateToken(16);
    await db.prepare(`UPDATE users SET password_hash = ?, salt = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(await hashPassword(parsed.data.new_password, salt), salt, user.id).run();

    const currentToken = getCookie(context, 'session');
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token NOT IN (?,?)')
      .bind(user.id, currentToken ? await hashSessionToken(currentToken) : '', currentToken || '').run();
    return context.json({ success: true });
  });
}
