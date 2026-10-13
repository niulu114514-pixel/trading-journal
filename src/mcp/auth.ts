import type { Context } from 'hono';
import type { AppEnv } from '../app-types';
import { sha256Text } from '../lib/crypto';
import { jsonRpcError, type JsonRpcResponse } from './protocol';

export async function hashMcpToken(token: string): Promise<string> {
  return `sha256$${await sha256Text(token)}$${token.slice(-4)}`;
}

export function maskMcpToken(storedToken: string): string {
  if (storedToken.startsWith('sha256$')) return `mcp_••••••••••••••••••••…${storedToken.slice(-4)}`;
  return `${storedToken.slice(0, 12)}...${storedToken.slice(-4)}`;
}

export async function authenticateMcpRequest(
  context: Context<AppEnv>
): Promise<{ authorized: boolean; permissions?: string; error?: JsonRpcResponse }> {
  const authHeader = context.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { authorized: false, error: jsonRpcError(-32001, 'Unauthorized: missing or invalid Bearer token', null) };
  }

  const token = authHeader.slice(7);
  const storedToken = await hashMcpToken(token);
  const record = await context.env.DB.prepare(
    `SELECT id, token, permissions FROM mcp_tokens
     WHERE (token = ? OR (token = ? AND token NOT LIKE 'sha256$%')) AND is_active = 1
     LIMIT 1`
  ).bind(storedToken, token).first<{ id: number; token: string; permissions: string }>();
  if (!record) return { authorized: false, error: jsonRpcError(-32001, 'Unauthorized: invalid token', null) };

  await context.env.DB.prepare("UPDATE mcp_tokens SET token = ?, last_used_at = datetime('now') WHERE id = ?")
    .bind(storedToken, record.id).run();
  return { authorized: true, permissions: record.permissions || 'read' };
}
