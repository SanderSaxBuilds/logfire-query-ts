import { describe, expect, it, vi } from 'vitest';
import {
  LogfireQueryClient,
  REGION_BASE_URLS,
  baseUrlFromToken,
  normalizeBaseUrl,
  resolveBaseUrl,
  tokenRegion,
} from '../src/index.js';
import { jsonResponse, mockFetch } from './helpers.js';

const US_TOKEN = 'pylf_v1_us_abc123DEF';
const EU_TOKEN = 'pylf_v1_eu_abc123DEF';

describe('region from token', () => {
  it.each([
    ['pylf_v1_us_abc', 'us'],
    ['pylf_v1_eu_abc', 'eu'],
    ['pylf_v2_eu_abc', 'eu'],
    ['pylf_v1_stagingus_abc', 'stagingus'],
    ['pylf_v1_eu_2d5a7ceb-641c-471c-b4bd-543331cd1e8b_abc', 'eu'],
  ])('reads the region of %s', (token, region) => {
    expect(tokenRegion(token)).toBe(region);
  });

  it.each(['fake-read-token', 'pylf_us_abc', 'pylf_v1_US_abc', ''])('finds no region in %j', (token) => {
    expect(tokenRegion(token)).toBeUndefined();
  });

  it('documents the two region URLs', () => {
    expect(REGION_BASE_URLS).toEqual({
      us: 'https://logfire-us.pydantic.dev',
      eu: 'https://logfire-eu.pydantic.dev',
    });
  });

  it('maps a US token to the US URL', () => {
    expect(baseUrlFromToken(US_TOKEN)).toBe('https://logfire-us.pydantic.dev');
  });

  it('maps an EU token to the EU URL', () => {
    expect(baseUrlFromToken(EU_TOKEN)).toBe('https://logfire-eu.pydantic.dev');
  });

  it('uses the US region for tokens made before regions existed', () => {
    expect(baseUrlFromToken('legacy-token-without-region')).toBe('https://logfire-us.pydantic.dev');
  });

  it('maps staging regions the same way as the Python SDK', () => {
    expect(baseUrlFromToken('pylf_v1_stagingus_x')).toBe('https://logfire-us.pydantic.info');
    expect(baseUrlFromToken('pylf_v1_stagingeu_x')).toBe('https://logfire-eu.pydantic.info');
  });

  it('falls back to the US region for an unknown region and reports it', () => {
    const seen: string[] = [];
    expect(baseUrlFromToken('pylf_v1_mars_x', (region) => seen.push(region))).toBe('https://logfire-us.pydantic.dev');
    expect(seen).toEqual(['mars']);
  });
});

describe('base URL option', () => {
  it('prefers an explicit base URL over the token', () => {
    expect(resolveBaseUrl({ readToken: EU_TOKEN, baseUrl: 'https://logfire.example.com' })).toBe('https://logfire.example.com');
  });

  it('prefers an explicit region over the token', () => {
    expect(resolveBaseUrl({ readToken: US_TOKEN, region: 'eu' })).toBe('https://logfire-eu.pydantic.dev');
  });

  it('prefers the base URL over the region', () => {
    expect(resolveBaseUrl({ readToken: US_TOKEN, region: 'eu', baseUrl: 'http://localhost:3000' })).toBe('http://localhost:3000');
  });

  it('rejects an unknown region option', () => {
    expect(() => resolveBaseUrl({ readToken: US_TOKEN, region: 'ap' as never })).toThrow(TypeError);
  });

  it('removes trailing slashes', () => {
    expect(normalizeBaseUrl('https://logfire.example.com///')).toBe('https://logfire.example.com');
  });

  it('keeps a path prefix for a proxy', () => {
    expect(normalizeBaseUrl('https://proxy.example.com/logfire/')).toBe('https://proxy.example.com/logfire');
  });

  it.each(['not a url', 'ftp://logfire.example.com', 'https://x.example.com/?a=1', 'https://x.example.com/#top'])(
    'rejects %j',
    (url) => {
      expect(() => normalizeBaseUrl(url)).toThrow(TypeError);
    },
  );

  it('sends queries to the base URL with a path prefix', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ schema: { fields: [] }, data: [] }));
    const client = new LogfireQueryClient({ readToken: US_TOKEN, baseUrl: 'https://proxy.example.com/logfire/', fetch });
    await client.query('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z' });
    expect(calls[0]?.url).toBe('https://proxy.example.com/logfire/v2/query');
  });

  it('sends EU tokens to the EU endpoint without any option', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ schema: { fields: [] }, data: [] }));
    const client = new LogfireQueryClient({ readToken: EU_TOKEN, fetch });
    await client.query('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z' });
    expect(calls[0]?.url).toBe('https://logfire-eu.pydantic.dev/v2/query');
    expect(client.baseUrl).toBe('https://logfire-eu.pydantic.dev');
  });

  it('warns once through console.warn for an unknown token region by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = new LogfireQueryClient({ readToken: 'pylf_v1_mars_x', fetch: mockFetch().fetch });
      expect(client.baseUrl).toBe('https://logfire-us.pydantic.dev');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('mars');
    } finally {
      warn.mockRestore();
    }
  });
});
