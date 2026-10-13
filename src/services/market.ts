import { getAllConfig } from './config';
import { normalizeMarketNewsSources } from './ai-web-search';

const MARKET_INTERVALS = new Set([
  '1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '1day', '1week', '1month'
]);
const DEFAULT_MARKET_TIMEOUT_MS = 20_000;
const NEWS_CACHE_TTL_SECONDS = 120;

export type MarketNewsOptions = {
  keyword?: string;
  sources?: string[];
  limit?: number;
  deep?: boolean;
  timeRange?: string;
};

export type MarketRuntime = {
  service?: Pick<Fetcher, 'fetch'>;
  signal?: AbortSignal;
  timeoutMs?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
};

type MarketConfig = {
  market_data_url?: string;
  market_data_key?: string;
};

export type MarketNewsResponse = {
  items?: unknown[];
  [key: string]: unknown;
};

function marketSignal(runtime: MarketRuntime): AbortSignal {
  const timeout = AbortSignal.timeout(Math.min(Math.max(runtime.timeoutMs || DEFAULT_MARKET_TIMEOUT_MS, 1_000), 60_000));
  return runtime.signal ? AbortSignal.any([runtime.signal, timeout]) : timeout;
}

function marketBaseUrl(config: MarketConfig, runtime: MarketRuntime): string {
  const configured = String(config.market_data_url || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (runtime.service) return 'https://td-forex-mcp.internal';
  throw new Error('行情服务未配置：请先配置 market_data_url，或启用 TD_FOREX Service Binding');
}

async function requestMarket(
  config: MarketConfig,
  path: string,
  runtime: MarketRuntime
): Promise<Response> {
  if (!config.market_data_key) throw new Error('行情服务未配置访问密钥');
  const url = `${marketBaseUrl(config, runtime)}${path}`;
  const init: RequestInit = {
    headers: { 'x-api-key': config.market_data_key },
    signal: marketSignal(runtime)
  };

  if (runtime.service) {
    try {
      const response = await runtime.service.fetch(url, init);
      if (response.status < 500 || !config.market_data_url) return response;
      await response.body?.cancel();
    } catch (error) {
      if (runtime.signal?.aborted) throw error;
      if (!config.market_data_url) throw error;
    }
  }
  return fetch(url, init);
}

async function parseMarketResponse(response: Response, fallback: string): Promise<unknown> {
  const data = await response.json<unknown>().catch(() => null);
  if (!response.ok || !data) {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : null;
    throw new Error(String(record?.message || record?.error || `${fallback} ${response.status}`).slice(0, 500));
  }
  return data;
}

function newsCacheRequest(query: URLSearchParams): Request {
  return new Request(`https://trading-journal.internal/cache/market-news?${query.toString()}`);
}

async function readNewsCache(query: URLSearchParams): Promise<unknown | null> {
  if (typeof caches === 'undefined') return null;
  const response = await caches.default.match(newsCacheRequest(query));
  return response ? response.json<unknown>().catch(() => null) : null;
}

async function writeNewsCache(query: URLSearchParams, data: unknown, runtime: MarketRuntime): Promise<void> {
  if (typeof caches === 'undefined') return;
  const promise = caches.default.put(newsCacheRequest(query), new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${NEWS_CACHE_TTL_SECONDS}`
    }
  }));
  if (runtime.waitUntil) runtime.waitUntil(promise);
  else await promise;
}

export async function fetchMarketCandles(
  db: D1Database,
  options: { symbol?: string; interval?: string; outputsize?: number; fresh?: boolean },
  encryptionKey = '',
  runtime: MarketRuntime = {}
): Promise<unknown> {
  const symbol = String(options.symbol || 'XAU/USD').trim();
  const interval = String(options.interval || '1day').toLowerCase();
  const outputsize = Math.min(Math.max(Number(options.outputsize) || 120, 1), 2_000);
  if (!symbol || symbol.length > 64) throw new Error('symbol 无效');
  if (!MARKET_INTERVALS.has(interval)) throw new Error('interval 不受支持');

  const config = await getAllConfig(db, encryptionKey);
  const query = new URLSearchParams({ symbol, interval, outputsize: String(outputsize) });
  if (options.fresh) query.set('fresh', '1');
  const response = await requestMarket(config, `/api/kline?${query}`, runtime);
  return parseMarketResponse(response, '行情服务响应');
}

export async function fetchMarketNews(
  db: D1Database,
  options: MarketNewsOptions,
  encryptionKey = '',
  runtime: MarketRuntime = {}
): Promise<MarketNewsResponse> {
  const config = await getAllConfig(db, encryptionKey);
  const query = new URLSearchParams({
    keyword: String(options.keyword || '').slice(0, 200),
    limit: String(Math.min(Math.max(Number(options.limit) || 30, 1), 100)),
    deep: options.deep ? '1' : '0',
    time_range: String(options.timeRange || 'day').slice(0, 20)
  });
  const sources = normalizeMarketNewsSources(options.sources);
  if (sources.length) query.set('sources', sources.join(','));

  const cached = await readNewsCache(query);
  if (cached && typeof cached === 'object') return cached as MarketNewsResponse;
  const response = await requestMarket(config, `/api/news?${query}`, runtime);
  const data = await parseMarketResponse(response, '新闻服务响应');
  await writeNewsCache(query, data, runtime);
  return data as MarketNewsResponse;
}
