import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMarketCandles } from '../src/services/market';

vi.mock('../src/services/config', () => ({
  getAllConfig: vi.fn(async () => ({
    market_data_url: 'https://fx.example.test',
    market_data_key: 'test-market-key'
  }))
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('market service transport', () => {
  it('prefers the TD service binding over the public endpoint', async () => {
    const service = {
      fetch: vi.fn(async () => Response.json({ values: [{ close: '2500.00' }] }))
    };
    const publicFetch = vi.fn();
    vi.stubGlobal('fetch', publicFetch);

    const result = await fetchMarketCandles(env.DB, { symbol: 'XAU/USD', interval: '1h' }, '', { service });

    expect(result).toEqual({ values: [{ close: '2500.00' }] });
    expect(service.fetch).toHaveBeenCalledOnce();
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('falls back to the configured public endpoint after a bound service 5xx', async () => {
    const service = { fetch: vi.fn(async () => new Response('unavailable', { status: 503 })) };
    const publicFetch = vi.fn(async () => Response.json({ values: [{ close: '2501.00' }] }));
    vi.stubGlobal('fetch', publicFetch);

    const result = await fetchMarketCandles(env.DB, { symbol: 'XAU/USD', interval: '1h' }, '', { service });

    expect(result).toEqual({ values: [{ close: '2501.00' }] });
    expect(publicFetch).toHaveBeenCalledOnce();
  });

  it('propagates caller cancellation to the bound request', async () => {
    const aborter = new AbortController();
    aborter.abort('cancelled by client');
    let receivedSignal: AbortSignal | null = null;
    const service = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedSignal = init?.signal || null;
        return Response.json({ values: [] });
      })
    };

    await fetchMarketCandles(env.DB, { symbol: 'XAU/USD', interval: '1h' }, '', { service, signal: aborter.signal });

    expect(receivedSignal?.aborted).toBe(true);
  });
});
