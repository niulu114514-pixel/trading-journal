import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { generateToken } from '../lib/crypto';
import { hashMcpToken, maskMcpToken } from '../mcp/auth';

type McpTokenRow = {
  id: number;
  name: string;
  token: string;
  permissions: string;
  created_at: string;
  last_used_at: string | null;
};

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.enum(['read', 'write', 'admin']).default('read')
});

export function registerMcpTokenRoutes(app: Hono<AppEnv>): void {
  app.get('/api/mcp/tokens', async context => {
    const database = context.env.DB;
    const tokens = await database.prepare(
      `SELECT id, name, token, permissions, created_at, last_used_at
       FROM mcp_tokens ORDER BY created_at DESC`
    ).all<McpTokenRow>();

    const results = [];
    for (const row of tokens.results) {
      let storedToken = row.token;
      if (!storedToken.startsWith('sha256$')) {
        storedToken = await hashMcpToken(storedToken);
        await database.prepare('UPDATE mcp_tokens SET token = ? WHERE id = ?')
          .bind(storedToken, row.id).run();
      }
      results.push({
        id: row.id,
        name: row.name,
        permissions: row.permissions,
        token_mask: maskMcpToken(storedToken),
        created_at: row.created_at,
        last_used_at: row.last_used_at
      });
    }
    return context.json(results);
  });

  app.post('/api/mcp/tokens', async context => {
    const parsed = createTokenSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '密钥名称或权限无效' }, 400);

    const token = generateToken(24).replace(/(.{8})/g, '$1-').replace(/-$/, '');
    const tokenValue = `mcp_${token}`;
    const storedToken = await hashMcpToken(tokenValue);
    const result = await context.env.DB.prepare(
      'INSERT INTO mcp_tokens (name, token, permissions) VALUES (?, ?, ?)'
    ).bind(parsed.data.name, storedToken, parsed.data.permissions).run();

    return context.json({
      id: result.meta.last_row_id,
      token: tokenValue,
      name: parsed.data.name,
      permissions: parsed.data.permissions,
      success: true
    }, 201);
  });

  app.delete('/api/mcp/tokens/:id', async context => {
    const id = Number(context.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return context.json({ error: 'Token ID 无效' }, 400);
    const result = await context.env.DB.prepare('DELETE FROM mcp_tokens WHERE id = ?').bind(id).run();
    if (!result.meta.changes) return context.json({ error: 'Token 不存在' }, 404);
    return context.json({ success: true });
  });
}
