import type { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { statsPeriodSql } from '../lib/stats';

function boundedLimit(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), maximum) : fallback;
}

function validDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function registerStatsRoutes(app: Hono<AppEnv>): void {
  app.get('/api/stats/series', async context => {
    const granularity = context.req.query('granularity') || 'month';
    const period = statsPeriodSql(granularity);
    if (!period) return context.json({ error: 'granularity 仅支持 day / week / month / year' }, 400);

    const from = context.req.query('from');
    const to = context.req.query('to');
    if ((from && !validDate(from)) || (to && !validDate(to))) {
      return context.json({ error: 'from 和 to 必须是有效的 YYYY-MM-DD 日期' }, 400);
    }
    if (from && to && from >= to) {
      return context.json({ error: 'to 必须晚于 from' }, 400);
    }

    const filters = ["entry_time IS NOT NULL", "entry_time != ''"];
    const filterBindings: string[] = [];
    if (from) {
      filters.push('entry_time >= ?');
      filterBindings.push(from);
    }
    if (to) {
      filters.push('entry_time < ?');
      filterBindings.push(to);
    }

    const statement = context.env.DB.prepare(
      `SELECT ${period.expression} as period,
        COUNT(*) as trades,
        SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result = '败' THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(return_amount), 0) as total_return,
        COALESCE(ROUND(AVG(risk_reward_ratio), 2), 0) as avg_rr
       FROM trades
       WHERE ${filters.join(' AND ')}
       GROUP BY period ORDER BY period DESC LIMIT ?`
    );
    const limit = boundedLimit(context.req.query('limit'), 30, 366);
    const bindings: Array<string | number> = [...filterBindings, limit];
    if (period.format) bindings.unshift(period.format);
    const stats = await statement.bind(...bindings).all();
    return context.json({ granularity, series: stats.results });
  });

  app.get('/api/stats/monthly', async context => {
    const stats = await context.env.DB.prepare('SELECT * FROM monthly_stats ORDER BY month DESC LIMIT ?')
      .bind(boundedLimit(context.req.query('limit'), 12, 120)).all();
    return context.json(stats.results);
  });

  app.get('/api/stats/overview', async context => {
    const total = await context.env.DB.prepare(
      `SELECT COUNT(*) as total,
       SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN result = '败' THEN 1 ELSE 0 END) as losses,
       SUM(CASE WHEN result = '平' THEN 1 ELSE 0 END) as breakevens,
       COALESCE(SUM(return_amount), 0) as total_return,
       COALESCE(AVG(risk_reward_ratio), 0) as avg_rr,
       COALESCE(AVG(return_amount), 0) as expectancy,
       COALESCE(SUM(CASE WHEN return_amount > 0 THEN return_amount ELSE 0 END), 0) as gross_profit,
       COALESCE(ABS(SUM(CASE WHEN return_amount < 0 THEN return_amount ELSE 0 END)), 0) as gross_loss,
       COALESCE(MAX(return_amount), 0) as best_trade,
       COALESCE(MIN(return_amount), 0) as worst_trade,
       (SELECT COUNT(*) FROM trade_strategy_snapshots) as snapshot_trades
       FROM trades`
    ).first();
    return context.json(total);
  });

  app.get('/api/stats/symbols', async context => {
    const stats = await context.env.DB.prepare(
      `SELECT symbol, COUNT(*) as trades,
       SUM(CASE WHEN result = '胜' THEN 1 ELSE 0 END) as wins,
       COALESCE(SUM(return_amount), 0) as total_return,
       ROUND(AVG(risk_reward_ratio), 2) as avg_rr
       FROM trades GROUP BY symbol ORDER BY trades DESC`
    ).all();
    return context.json(stats.results);
  });
}
