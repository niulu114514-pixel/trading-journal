import { describe, expect, it } from 'vitest';
import {
  deriveWebSearchQuery,
  extractWebSearchSources,
  normalizeMarketNewsSources,
  shouldPrefetchWebSearch
} from '../src/services/ai-web-search';

describe('AI web search routing', () => {
  it('forces current and online requests through web search', () => {
    expect(shouldPrefetchWebSearch('查询今天的新闻')).toBe(true);
    expect(shouldPrefetchWebSearch('你无法联网查询吗')).toBe(true);
    expect(shouldPrefetchWebSearch('整理我的入场规则')).toBe(false);
    expect(shouldPrefetchWebSearch('查询我的交易规则')).toBe(false);
    expect(shouldPrefetchWebSearch('查询今天的新闻', false)).toBe(false);
  });

  it('uses a useful query for generic news and connectivity prompts', () => {
    const now = new Date('2026-09-01T02:00:00.000Z');
    expect(deriveWebSearchQuery('查询今天的新闻', now)).toContain('2026-09-01');
    expect(deriveWebSearchQuery('你无法联网查询吗', now)).toContain('current UTC date');
  });

  it('drops invented source ids instead of filtering all news out', () => {
    expect(normalizeMarketNewsSources(['td-forex-mcp', 'CNBC', 'ecb', 'ecb'])).toEqual(['cnbc', 'ecb']);
    expect(normalizeMarketNewsSources(['td-forex-mcp'])).toEqual([]);
  });

  it('builds a deduplicated evidence list from RSS and web results', () => {
    expect(extractWebSearchSources({
      items: [{ source: 'ECB', title: 'Policy update', link: 'https://example.com/ecb' }],
      search: { results: [
        { source: 'Web', title: 'Duplicate', url: 'https://example.com/ecb' },
        { source: 'Reuters', title: 'Market reaction', url: 'https://example.com/market' }
      ] }
    })).toEqual([
      { source: 'ECB', title: 'Policy update', url: 'https://example.com/ecb' },
      { source: 'Reuters', title: 'Market reaction', url: 'https://example.com/market' }
    ]);
  });
});
