import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../src/mcp/catalog';

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
    env.DB.prepare('DELETE FROM daily_chart_images'),
    env.DB.prepare('DELETE FROM images'),
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

    const invalidRange = await SELF.fetch('https://example.com/api/stats/series?granularity=day&from=2026-02-30', { headers: { Cookie: cookie } });
    expect(invalidRange.status).toBe(400);

    const reversedRange = await SELF.fetch('https://example.com/api/stats/series?granularity=day&from=2026-10-31&to=2026-10-01', { headers: { Cookie: cookie } });
    expect(reversedRange.status).toBe(400);
  });

  it('does not expose removed chart, news, or AI assistant endpoints', async () => {
    const cookie = await setupOwner();
    const responses = await Promise.all([
      SELF.fetch('https://example.com/api/kline', { headers: { Cookie: cookie } }),
      SELF.fetch('https://example.com/api/news', { headers: { Cookie: cookie } }),
      SELF.fetch('https://example.com/api/ai/conversations', { headers: { Cookie: cookie } }),
      SELF.fetch('https://example.com/api/ai/chat', { method: 'POST', headers: { Cookie: cookie } })
    ]);
    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404]);
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

  it('shares one daily chart across every trade on the selected date', async () => {
    const cookie = await setupOwner();
    await env.DB.prepare(
      `INSERT INTO images (key,storage,filename,mime_type,size,public_id)
       VALUES ('daily-chart-test','r2','2026-10-14.png','image/png',12,'0123456789abcdef0123456789abcdef')`
    ).run();
    const image = await env.DB.prepare("SELECT id FROM images WHERE key='daily-chart-test'").first<{ id: number }>();
    expect(image?.id).toBeTruthy();

    const linked = await SELF.fetch('https://example.com/api/daily-charts/2026-10-14', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ image_id: image!.id })
    });
    expect(linked.status).toBe(200);

    for (const symbol of ['XAUUSD', 'EURUSD']) {
      const created = await SELF.fetch('https://example.com/api/trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ symbol, entry_time: '2026-10-14', direction: '多', lots: 1, timeframe: ['5M'] })
      });
      expect(created.status).toBe(201);
    }

    const response = await SELF.fetch('https://example.com/api/trades?month=2026-10', { headers: { Cookie: cookie } });
    const payload = await response.json<{ trades: Array<{ daily_chart_image: string }> }>();
    expect(payload.trades).toHaveLength(2);
    expect(payload.trades.every(trade => trade.daily_chart_image === '/i/0123456789abcdef0123456789abcdef')).toBe(true);

    const removed = await SELF.fetch('https://example.com/api/daily-charts/2026-10-14', { method: 'DELETE', headers: { Cookie: cookie } });
    expect(removed.status).toBe(200);
    const after = await SELF.fetch('https://example.com/api/trades?month=2026-10', { headers: { Cookie: cookie } });
    expect((await after.json<{ trades: Array<{ daily_chart_image: null }> }>()).trades.every(trade => trade.daily_chart_image === null)).toBe(true);
  });

  it('exposes only the compact core MCP tool set', () => {
    const names = MCP_TOOLS.map(tool => tool.name);
    expect(names).toHaveLength(17);
    expect(names).toEqual(expect.arrayContaining(['list_trades', 'get_stats', 'list_rules', 'list_systems', 'upload_chart_image']));
    expect(names).not.toEqual(expect.arrayContaining(['get_market_candles', 'refine_mindmap', 'reconcile_images', 'add_setting']));
  });
});
