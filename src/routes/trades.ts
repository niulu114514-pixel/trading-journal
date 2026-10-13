import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { monthBounds } from '../lib/stats';
import { normalizeTradeTimeframes } from '../lib/trades';

const timeframeSchema = z.union([
  z.string().min(1).max(255),
  z.array(z.string().min(1).max(20)).min(1).max(20)
]).transform(value => normalizeTradeTimeframes(value)).pipe(z.string().min(1).max(255));

const tradeFieldsSchema = z.object({
  symbol: z.string().min(1).max(50).optional(),
  code: z.string().min(1).max(20).nullable().optional(),
  entry_time: z.string().min(10).max(40).nullable().optional(),
  lots: z.number().min(0.0001).max(1e6).optional(),
  entry_price: z.number().min(0).max(1e12).nullable().optional(),
  exit_price: z.number().min(0).max(1e12).nullable().optional(),
  direction: z.enum(['多', '空']).optional(),
  timeframe: timeframeSchema.optional(),
  trading_system_id: z.number().int().positive().nullable().optional(),
  trade_type: z.string().min(1).max(20).nullable().optional(),
  market_cycle: z.string().min(1).max(30).nullable().optional(),
  patterns: z.string().min(1).max(255).nullable().optional(),
  trade_logic: z.string().min(1).max(2000).nullable().optional(),
  exit_type: z.string().min(1).max(20).nullable().optional(),
  return_amount: z.number().min(-1e9).max(1e9).nullable().optional(),
  risk_reward_ratio: z.number().min(0).max(1e6).nullable().optional(),
  result: z.enum(['胜', '败', '平']).nullable().optional(),
  review: z.string().min(1).max(2000).nullable().optional(),
  chart_image: z.string().min(1).max(500).nullable().optional()
});

type TradeRouteDependencies = {
  captureTradeStrategySnapshot(db: D1Database, tradeId: number, systemId: number | null | undefined): Promise<void>;
  updateMonthlyStats(db: D1Database, entryTime: string | null): Promise<void>;
  rebuildMonth(db: D1Database, month: string): Promise<void>;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

export function registerTradeRoutes(app: Hono<AppEnv>, dependencies: TradeRouteDependencies): void {
  app.get('/api/trades', async context => {
    const page = boundedInteger(context.req.query('page'), 1, 1, 1_000_000);
    const limit = boundedInteger(context.req.query('limit'), 50, 1, 200);
    const where = ['1=1'];
    const parameters: (string | number)[] = [];
    const filters = {
      symbol: context.req.query('symbol'),
      result: context.req.query('result'),
      direction: context.req.query('direction'),
      timeframe: context.req.query('timeframe'),
      systemId: context.req.query('trading_system_id')
    };
    if (filters.symbol) { where.push('t.symbol = ?'); parameters.push(filters.symbol.trim()); }
    if (filters.result) { where.push('t.result = ?'); parameters.push(filters.result); }
    if (filters.direction) { where.push('t.direction = ?'); parameters.push(filters.direction); }
    if (filters.timeframe) {
      where.push("instr(',' || replace(t.timeframe, ' ', '') || ',', ',' || ? || ',') > 0");
      parameters.push(filters.timeframe.trim());
    }
    if (filters.systemId) { where.push('t.trading_system_id = ?'); parameters.push(filters.systemId); }
    const month = context.req.query('month');
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return context.json({ error: 'month 必须使用 YYYY-MM 格式' }, 400);
      }
      const bounds = monthBounds(month);
      where.push('t.entry_time >= ?', 't.entry_time < ?');
      parameters.push(bounds.start, bounds.end);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const count = await context.env.DB.prepare(`SELECT COUNT(*) as total FROM trades t ${whereSql}`)
      .bind(...parameters).first<{ total: number }>();
    const trades = await context.env.DB.prepare(
      `SELECT t.*, COALESCE(ss.system_name,s.name) AS trading_system_name,
        CASE WHEN ss.id IS NULL THEN 0 ELSE 1 END AS strategy_snapshot_locked
       FROM trades t LEFT JOIN trading_systems s ON s.id=t.trading_system_id
       LEFT JOIN trade_strategy_snapshots ss ON ss.trade_id=t.id
       ${whereSql} ORDER BY t.entry_time DESC LIMIT ? OFFSET ?`
    ).bind(...parameters, limit, (page - 1) * limit).all();
    return context.json({ trades: trades.results, total: count?.total || 0, page, limit });
  });

  app.get('/api/trades/:id', async context => {
    const id = context.req.param('id');
    const trade = await context.env.DB.prepare(
      `SELECT t.*, COALESCE(ss.system_name,s.name) AS trading_system_name,
       ss.version_id AS strategy_version_id,ss.created_at AS strategy_snapshot_at,
       CASE WHEN ss.id IS NULL THEN 0 ELSE 1 END AS strategy_snapshot_locked
       FROM trades t LEFT JOIN trading_systems s ON s.id=t.trading_system_id
       LEFT JOIN trade_strategy_snapshots ss ON ss.trade_id=t.id WHERE t.id=?`
    ).bind(id).first<Record<string, unknown>>();
    if (!trade) return context.json({ error: 'Not found' }, 404);
    return context.json(trade);
  });

  app.get('/api/trades/:id/strategy-snapshot', async context => {
    const row = await context.env.DB.prepare(
      'SELECT system_id,system_name,version_id,snapshot_json,created_at FROM trade_strategy_snapshots WHERE trade_id=?'
    ).bind(context.req.param('id')).first<Record<string, unknown> & { snapshot_json: string }>();
    if (!row) return context.json({ error: '这笔历史交易尚未锁定脑图版本' }, 404);
    return context.json({ ...row, snapshot: JSON.parse(row.snapshot_json) });
  });

  app.post('/api/trades', async context => {
    const parsed = tradeFieldsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: '参数校验失败', issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), msg: issue.message })) }, 400);
    }
    const trade = parsed.data;
    const result = await context.env.DB.prepare(
      `INSERT INTO trades (symbol,code,entry_time,lots,entry_price,exit_price,direction,timeframe,trading_system_id,trade_type,market_cycle,patterns,trade_logic,exit_type,return_amount,risk_reward_ratio,result,review,chart_image)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      trade.symbol || 'XAUUSD', trade.code || null, trade.entry_time || null, trade.lots ?? 1,
      trade.entry_price ?? null, trade.exit_price ?? null,
      trade.direction || '多', trade.timeframe || '5M', trade.trading_system_id ?? null,
      trade.trade_type || null, trade.market_cycle || null, trade.patterns || null, trade.trade_logic || null,
      trade.exit_type || null, trade.return_amount ?? null, trade.risk_reward_ratio ?? null,
      trade.result || null, trade.review || null, trade.chart_image || null
    ).run();
    const tradeId = Number(result.meta.last_row_id);
    await dependencies.captureTradeStrategySnapshot(context.env.DB, tradeId, trade.trading_system_id);
    await dependencies.updateMonthlyStats(context.env.DB, trade.entry_time ?? null);
    return context.json({ id: tradeId, success: true, strategy_snapshot_locked: Boolean(trade.trading_system_id) }, 201);
  });

  app.put('/api/trades/:id', async context => {
    const parsed = tradeFieldsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: '参数校验失败', issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), msg: issue.message })) }, 400);
    }
    const trade = parsed.data;
    const id = context.req.param('id');
    const before = await context.env.DB.prepare('SELECT entry_time,trading_system_id FROM trades WHERE id=?')
      .bind(id).first<{ entry_time: string | null; trading_system_id: number | null }>();
    if (!before) return context.json({ error: 'Not found' }, 404);

    const updatable = ['symbol', 'code', 'entry_time', 'lots', 'entry_price', 'exit_price', 'direction', 'timeframe', 'trading_system_id',
      'trade_type', 'market_cycle', 'patterns', 'trade_logic', 'exit_type', 'return_amount', 'risk_reward_ratio',
      'result', 'review', 'chart_image'] as const;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const field of updatable) {
      if (trade[field] !== undefined) { fields.push(`${field} = ?`); values.push(trade[field]); }
    }
    if (!fields.length) return context.json({ error: 'No fields to update' }, 400);
    if (fields.length) {
      fields.push("updated_at = datetime('now')");
      await context.env.DB.prepare(`UPDATE trades SET ${fields.join(', ')} WHERE id=?`).bind(...values, id).run();
    }

    const existingSnapshot = await context.env.DB.prepare('SELECT id FROM trade_strategy_snapshots WHERE trade_id=?').bind(id).first();
    if (trade.trading_system_id !== undefined || !existingSnapshot) {
      await dependencies.captureTradeStrategySnapshot(context.env.DB, Number(id), trade.trading_system_id !== undefined ? trade.trading_system_id : before.trading_system_id);
    }

    const after = await context.env.DB.prepare('SELECT entry_time FROM trades WHERE id=?').bind(id).first<{ entry_time: string | null }>();
    const months = new Set<string>();
    if (before.entry_time) months.add(before.entry_time.substring(0, 7));
    if (after?.entry_time) months.add(after.entry_time.substring(0, 7));
    for (const month of months) await dependencies.rebuildMonth(context.env.DB, month);
    return context.json({ success: true });
  });

  app.delete('/api/trades/:id', async context => {
    const id = context.req.param('id');
    const trade = await context.env.DB.prepare('SELECT entry_time FROM trades WHERE id=?')
      .bind(id).first<{ entry_time: string | null }>();
    if (!trade) return context.json({ error: 'Not found' }, 404);
    await context.env.DB.prepare('DELETE FROM trades WHERE id=?').bind(id).run();
    await dependencies.updateMonthlyStats(context.env.DB, trade.entry_time);
    return context.json({ success: true });
  });
}
