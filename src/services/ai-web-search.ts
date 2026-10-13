export const MARKET_NEWS_SOURCE_IDS = [
  'federalreserve',
  'ecb',
  'bankofengland',
  'oilprice',
  'cnbc',
  'forexlive'
] as const;

const MARKET_NEWS_SOURCE_SET = new Set<string>(MARKET_NEWS_SOURCE_IDS);
const WEB_SEARCH_INTENT = /(联网|上网|网页|网络|新闻|资讯|最新|今天|今日|当前|实时|刚刚|近期|本周|本月|current|latest|today|news|search web|web search)/i;
const GENERIC_SEARCH_ACTION = /(搜索|搜一下|查一下|查询|检索|search)/i;
const LOCAL_DATA_TARGET = /(我的|交易|规则|脑图|设置|配置|日志|图片|账户|统计|回撤)/i;
const CONNECTIVITY_QUESTION = /(能否|能不能|可以|是否|无法|不会|不支持).{0,8}(联网|上网|网络|搜索|查询)|(联网|上网).{0,8}(吗|么|？|\?)/i;

export function normalizeMarketNewsSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim().toLowerCase()).filter(item => MARKET_NEWS_SOURCE_SET.has(item)))];
}

export function shouldPrefetchWebSearch(content: string, enabled = true): boolean {
  const text = String(content || '').trim();
  return enabled && (WEB_SEARCH_INTENT.test(text) || (GENERIC_SEARCH_ACTION.test(text) && !LOCAL_DATA_TARGET.test(text)));
}

export function deriveWebSearchQuery(content: string, now = new Date()): string {
  const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const date = now.toISOString().slice(0, 10);
  if (!text || CONNECTIVITY_QUESTION.test(text)) return `current UTC date and latest financial market news ${date}`;
  if (/^(今天|今日).{0,8}(新闻|资讯|消息)?$/i.test(text) || /查询今天的新闻|今天有什么新闻|今日新闻/i.test(text)) {
    return `latest global forex gold central bank financial market news ${date}`;
  }
  return `${text} ${date}`.slice(0, 200);
}

export function currentTimeContext(now = new Date()): string {
  const utc = now.toISOString();
  const china = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(now);
  return `当前服务器时间：${utc}（UTC）；${china}（Asia/Shanghai）。`;
}

export function compactWebSearchContext(result: any, query: string): Record<string, unknown> {
  const rssItems = Array.isArray(result?.items) ? result.items.slice(0, 8).map((item: any) => ({
    source: item?.source,
    title: item?.title,
    link: item?.link,
    publishedAt: item?.publishedAt,
    description: item?.description
  })) : [];
  return {
    query,
    fetched_at: new Date().toISOString(),
    rss_items: rssItems,
    web_search: result?.search ?? null,
    search_warning: result?.search_warning || undefined,
    source_status: result?.source_status || undefined
  };
}

export type WebSearchSource = {
  title: string;
  url: string;
  source: string;
};

export function extractWebSearchSources(result: unknown, limit = 8): WebSearchSource[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const rss = Array.isArray(record.items) ? record.items : [];
  const search = record.search;
  const searchRecord = search && typeof search === 'object' && !Array.isArray(search) ? search as Record<string, unknown> : null;
  const web = Array.isArray(search)
    ? search
    : Array.isArray(searchRecord?.results)
      ? searchRecord.results
      : Array.isArray(searchRecord?.data)
        ? searchRecord.data
        : [];
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const item of [...rss, ...web]) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const url = String(value.url || value.link || '').trim();
    const title = String(value.title || '').trim();
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: title.slice(0, 180), url, source: String(value.source || '网页').slice(0, 60) });
    if (sources.length >= Math.min(Math.max(limit, 1), 20)) break;
  }
  return sources;
}
