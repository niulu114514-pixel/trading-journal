function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function configCryptoKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('CONFIG_ENCRYPTION_KEY 未配置');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptConfigValue(secret: string, key: string, value: string): Promise<string> {
  if (!value || value.startsWith('enc$v1$')) return value;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
    await configCryptoKey(secret),
    new TextEncoder().encode(value)
  );
  return `enc$v1$${bytesToBase64(iv)}$${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptConfigValue(secret: string, key: string, value: string): Promise<string> {
  if (!value.startsWith('enc$v1$')) return value;
  const parts = value.split('$');
  if (parts.length !== 4) throw new Error(`敏感配置 ${key} 的密文格式无效`);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(parts[2]), additionalData: new TextEncoder().encode(key) },
    await configCryptoKey(secret),
    base64ToBytes(parts[3])
  );
  return new TextDecoder().decode(decrypted);
}

export async function getAllConfig(db: D1Database, encryptionKey = ''): Promise<Record<string, string>> {
  const rows = await db.prepare('SELECT config_key, config_value FROM app_config')
    .all<{ config_key: string; config_value: string }>();
  const config: Record<string, string> = {};
  for (const row of rows.results) {
    const value = row.config_value || '';
    config[row.config_key] = value.startsWith('enc$v1$')
      ? await decryptConfigValue(encryptionKey, row.config_key, value)
      : value;
  }
  return config;
}

export async function ensureSensitiveConfigEncrypted(env: Bindings): Promise<void> {
  if (!env.CONFIG_ENCRYPTION_KEY) throw new Error('CONFIG_ENCRYPTION_KEY 未配置，不能安全读取敏感配置');
  const rows = await env.DB.prepare(
    `SELECT config_key,config_value FROM app_config
     WHERE config_key IN ('tg_bot_token','market_data_key','ai_api_key','ai_cf_api_token')`
  ).all<{ config_key: string; config_value: string }>();
  for (const row of rows.results) {
    if (!row.config_value || row.config_value.startsWith('enc$v1$')) continue;
    const encrypted = await encryptConfigValue(env.CONFIG_ENCRYPTION_KEY, row.config_key, row.config_value);
    await env.DB.prepare(
      "UPDATE app_config SET config_value=?,updated_at=datetime('now') WHERE config_key=? AND config_value=?"
    ).bind(encrypted, row.config_key, row.config_value).run();
  }
}
import type { Bindings } from '../app-types';

export const MASKED_CONFIG_VALUE = '••••••••';
export const SENSITIVE_CONFIG_KEYS = new Set(['tg_bot_token', 'market_data_key', 'ai_api_key', 'ai_cf_api_token']);
