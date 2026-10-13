import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { aiErrorMessage, normalizeAiUsage } from '../services/ai-protocol';
import { runAiText } from '../services/ai-provider';
import { getAllConfig } from '../services/config';
import { fetchMarketCandles, fetchMarketNews } from '../services/market';

const analyzeNewsSchema = z.object({
  items: z.array(z.unknown()).max(40).optional(),
  keyword: z.string().max(200).optional(),
  deep: z.boolean().optional(),
  time_range: z.string().max(30).optional(),
  symbol: z.string().max(30).optional(),
  interval: z.string().max(20).optional()
});

export function registerNewsRoutes(app: Hono<AppEnv>): void {
  app.get('/api/news', async context => {
    try {
      const limit = Math.min(Math.max(Number(context.req.query('limit')) || 30, 1), 100);
      const data = await fetchMarketNews(context.env.DB, {
        keyword: context.req.query('keyword') || '',
        sources: String(context.req.query('sources') || '').split(',').filter(Boolean).slice(0, 20),
        limit,
        deep: ['1', 'true', 'yes'].includes(String(context.req.query('deep') || '').toLowerCase()),
        timeRange: context.req.query('time_range') || 'day'
      }, context.env.CONFIG_ENCRYPTION_KEY, {
        service: context.env.TD_FOREX,
        signal: context.req.raw.signal,
        waitUntil: promise => context.executionCtx.waitUntil(promise)
      });
      context.header('Cache-Control', 'no-store');
      return context.json(data);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : '获取财经新闻失败' }, 502);
    }
  });

  app.post('/api/news/analyze', async context => {
    const parsed = analyzeNewsSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: '新闻分析参数无效' }, 400);
    const body = parsed.data;
    const config = await getAllConfig(context.env.DB, context.env.CONFIG_ENCRYPTION_KEY);
    if (config.ai_enabled !== 'true') return context.json({ error: '请先在系统设置中启用 AI' }, 400);

    let items = body.items || [];
    if (!items.length) {
      const news = await fetchMarketNews(context.env.DB, {
        keyword: body.keyword,
        limit: 30,
        deep: body.deep === true,
        timeRange: body.time_range
      }, context.env.CONFIG_ENCRYPTION_KEY, {
        service: context.env.TD_FOREX,
        signal: context.req.raw.signal,
        waitUntil: promise => context.executionCtx.waitUntil(promise)
      });
      items = news.items || [];
    }

    let candles: unknown = null;
    if (body.symbol) {
      try {
        candles = await fetchMarketCandles(context.env.DB, {
          symbol: body.symbol,
          interval: body.interval || '1h',
          outputsize: 80
        }, context.env.CONFIG_ENCRYPTION_KEY, {
          service: context.env.TD_FOREX,
          signal: context.req.raw.signal
        });
      } catch {
        // 新闻分析不依赖行情快照，行情服务暂时不可用时仍可继续。
      }
    }

    const prompt = `分析下面的财经新闻，并用 Markdown 输出：\n1. 核心事件与可信来源\n2. 对 ${String(body.symbol || '外汇、黄金及相关市场')} 的可能影响（区分事实与推断）\n3. 多空情景、需要验证的关键价位/数据\n4. 风险与失效条件\n5. 新闻时效性与后续观察清单\n\n新闻：${JSON.stringify(items).slice(0, 30000)}\n\n行情快照：${JSON.stringify(candles).slice(0, 20000)}`;
    try {
      const result = await runAiText(
        context.env,
        config,
        '你是严谨的中文宏观与外汇研究助手。不得把新闻推断表述为确定事实，不提供收益保证。输出清晰的 Markdown。',
        prompt,
        5000
      );
      return context.json({
        analysis: result.text,
        provider: result.provider,
        model: result.model,
        usage: result.usage || normalizeAiUsage(result.data?.usage),
        item_count: items.length
      });
    } catch (error) {
      return context.json({ error: aiErrorMessage(error) }, 502);
    }
  });
}
