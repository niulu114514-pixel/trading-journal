import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    CONFIG_ENCRYPTION_KEY: string;
    SETUP_TOKEN: string;
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}

async function setupOwner(): Promise<string> {
  const response = await SELF.fetch('https://example.com/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'strong-passphrase', setup_token: 'test-setup-token' })
  });
  expect(response.status).toBe(201);
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM trade_rule_checks'),
    env.DB.prepare('DELETE FROM trade_strategy_snapshots'),
    env.DB.prepare('DELETE FROM trades'),
    env.DB.prepare('DELETE FROM trading_rules'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM login_attempts'),
    env.DB.prepare('DELETE FROM users')
  ]);
});

describe('modular route registration', () => {
  it('keeps authentication in front of routes registered from separate modules', async () => {
    const rules = await SELF.fetch('https://example.com/api/rules');
    const stats = await SELF.fetch('https://example.com/api/stats/overview');
    const settings = await SELF.fetch('https://example.com/api/settings');
    const aiModels = await SELF.fetch('https://example.com/api/ai/models');
    expect([rules.status, stats.status, settings.status, aiModels.status]).toEqual([401, 401, 401, 401]);
  });

  it('validates rule writes and reports missing updates', async () => {
    const cookie = await setupOwner();
    const invalid = await SELF.fetch('https://example.com/api/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: '' })
    });
    expect(invalid.status).toBe(400);

    const created = await SELF.fetch('https://example.com/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: '只在收盘确认后入场', content: '等待当前周期收盘后再确认结构是否仍然成立。' })
    });
    expect(created.status).toBe(201);

    const missing = await SELF.fetch('https://example.com/api/rules/999999', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ priority: 1 })
    });
    expect(missing.status).toBe(404);
  });

  it('bounds trade pagination and rejects unsupported statistic periods', async () => {
    const cookie = await setupOwner();
    const trades = await SELF.fetch('https://example.com/api/trades?page=-5&limit=9999', { headers: { Cookie: cookie } });
    expect(trades.status).toBe(200);
    expect(await trades.json<{ page: number; limit: number }>()).toMatchObject({ page: 1, limit: 200 });

    const invalidMonth = await SELF.fetch('https://example.com/api/trades?month=2026-13', { headers: { Cookie: cookie } });
    expect(invalidMonth.status).toBe(400);

    const stats = await SELF.fetch('https://example.com/api/stats/series?granularity=quarter', { headers: { Cookie: cookie } });
    expect(stats.status).toBe(400);
  });

  it('stores multiple timeframes and keeps the entered risk/reward ratio unchanged', async () => {
    const cookie = await setupOwner();
    const created = await SELF.fetch('https://example.com/api/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        symbol: 'XAUUSD', entry_time: '2026-09-11', direction: '多', lots: 1,
        timeframe: ['5M', '15M', '5M'], entry_price: 3642.15, exit_price: 3651.8,
        risk_reward_ratio: 0.71, review: '等待确认后执行'
      })
    });
    expect(created.status).toBe(201);

    const filtered = await SELF.fetch('https://example.com/api/trades?timeframe=15M', { headers: { Cookie: cookie } });
    expect(filtered.status).toBe(200);
    const payload = await filtered.json<{ total: number; trades: Array<{ timeframe: string; entry_price: number; exit_price: number; risk_reward_ratio: number; review: string }> }>();
    expect(payload.total).toBe(1);
    expect(payload.trades[0]).toMatchObject({ timeframe: '5M,15M', entry_price: 3642.15, exit_price: 3651.8, risk_reward_ratio: 0.71, review: '等待确认后执行' });

    const unmatched = await SELF.fetch('https://example.com/api/trades?timeframe=1H', { headers: { Cookie: cookie } });
    expect(await unmatched.json<{ total: number }>()).toMatchObject({ total: 0 });

    const settings = await SELF.fetch('https://example.com/api/settings?category=symbol', { headers: { Cookie: cookie } });
    expect(await settings.json<Array<{ value: string }>>()).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'XAUUSD' })]));
  });
});
