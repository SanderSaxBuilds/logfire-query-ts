import { describe, expect, it } from 'vitest';
import {
  LogfireConnectionError,
  QueryExecutionError,
  QueryRateLimitedError,
  QueryRequestError,
  UnexpectedResponseError,
  backoff,
  isRetryableStatus,
  resolveRetryOptions,
  type RetryInfo,
} from '../src/index.js';
import { DOCS_JSON_RESPONSE, DOCS_NDJSON_STREAM, LEGACY_ERROR, problemBody } from './fixtures/index.js';
import { MIN_TIMESTAMP, SQL, chunkedResponse, collect, jsonResponse, makeClient, mockFetch, problemResponse, textResponse } from './helpers.js';

const ok = () => jsonResponse(DOCS_JSON_RESPONSE);

describe('retries', () => {
  it('retries a 429 and returns the next success', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('slow down', 429), ok);
    const { client } = makeClient(fetch);
    expect((await client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).data).toEqual([{ service_name: 'backend' }]);
    expect(calls).toHaveLength(2);
  });

  it.each([500, 502, 503, 504])('retries a %i', async (status) => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', status), ok);
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [400, QueryExecutionError],
    [422, QueryRequestError],
    [404, UnexpectedResponseError],
    [401, UnexpectedResponseError],
  ] as const)('does not retry a %i', async (status, ErrorClass) => {
    const { fetch, calls } = mockFetch(() => jsonResponse(LEGACY_ERROR, status), ok);
    const { client } = makeClient(fetch);
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(ErrorClass);
    expect(calls).toHaveLength(1);
  });

  it('waits the Retry-After seconds the server asks for', async () => {
    const { fetch } = mockFetch(() => textResponse('slow down', 429, { 'retry-after': '3' }), ok);
    const { client, delays } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(delays).toEqual([3000]);
  });

  it('waits the retry_after of a problem body when there is no header', async () => {
    const problem = problemBody(503, 'query-timeout', { retryable: true, retry_after: 1.5 });
    const { fetch } = mockFetch(() => problemResponse(problem, 503), ok);
    const { client, delays } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(delays).toEqual([1500]);
  });

  it('retries at once for Retry-After 0', async () => {
    const { fetch } = mockFetch(() => textResponse('slow down', 429, { 'retry-after': '0' }), ok);
    const { client, delays } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(delays).toEqual([0]);
  });

  it('does not wait out a Retry-After longer than maxRetryAfterMs, for example a used daily budget', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('daily budget used', 429, { 'retry-after': '3600' }), ok);
    const { client, delays } = makeClient(fetch);
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryRateLimitedError);
    expect((error as QueryRateLimitedError).retryAfter).toBe(3600);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('waits a long Retry-After when maxRetryAfterMs allows it', async () => {
    const { fetch } = mockFetch(() => textResponse('slow down', 429, { 'retry-after': '3600' }), ok);
    const { client, delays } = makeClient(fetch, { retry: { maxRetryAfterMs: 3_600_000 } });
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(delays).toEqual([3_600_000]);
  });

  it('does not retry when the problem detail says the error is not retryable', async () => {
    const problem = problemBody(503, 'query-failed', { retryable: false });
    const { fetch, calls } = mockFetch(() => problemResponse(problem, 503), ok);
    const { client } = makeClient(fetch);
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(calls).toHaveLength(1);
  });

  it('uses exponential backoff when the server gives no delay', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', 503));
    const { client, delays } = makeClient(fetch, { retry: { maxRetries: 4, baseDelayMs: 100, maxDelayMs: 10_000 } });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(calls).toHaveLength(5);
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const { fetch } = mockFetch(() => textResponse('boom', 503));
    const { client, delays } = makeClient(fetch, { retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 1500 } });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toThrow();
    expect(delays).toEqual([1000, 1500, 1500]);
  });

  it('adds jitter between half and all of the backoff', () => {
    const options = { baseDelayMs: 1000, maxDelayMs: 60_000 };
    expect(backoff(2, { ...options, random: () => 0 })).toBe(2000);
    expect(backoff(2, { ...options, random: () => 1 })).toBe(4000);
    expect(backoff(2, { ...options, random: () => 0.5 })).toBe(3000);
  });

  it('throws the last error after maxRetries', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('first', 503), () => textResponse('second', 503), () => textResponse('third', 502));
    const { client } = makeClient(fetch);
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP }).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect((error as UnexpectedResponseError).status).toBe(502);
    expect((error as Error).message).toContain('third');
  });

  it('makes one attempt when retries are off', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', 503), ok);
    const { client } = makeClient(fetch, { retry: false });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(calls).toHaveLength(1);
  });

  it('makes one attempt with maxRetries 0', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', 503), ok);
    const { client } = makeClient(fetch, { retry: { maxRetries: 0 } });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('retries connection failures and reports them as LogfireConnectionError', async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new TypeError('fetch failed');
    }, ok);
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls).toHaveLength(2);
  });

  it('throws LogfireConnectionError with the cause when connection retries run out', async () => {
    const cause = new TypeError('getaddrinfo ENOTFOUND');
    const { fetch } = mockFetch(() => {
      throw cause;
    });
    const { client } = makeClient(fetch, { retry: { retryNetworkErrors: false } });
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LogfireConnectionError);
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).toContain('ENOTFOUND');
  });

  it('calls onRetry before each wait', async () => {
    const seen: RetryInfo[] = [];
    const { fetch } = mockFetch(() => textResponse('slow down', 429, { 'retry-after': '1' }), () => textResponse('boom', 500), ok);
    const { client } = makeClient(fetch, { retry: { baseDelayMs: 10, onRetry: (info: RetryInfo) => seen.push(info) } });
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(seen.map((s) => [s.attempt, s.delayMs])).toEqual([
      [1, 1000],
      [2, 20],
    ]);
    expect(seen[0]?.error).toBeInstanceOf(QueryRateLimitedError);
  });

  it('retries a stream that fails before its body', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', 503), () => chunkedResponse([DOCS_NDJSON_STREAM]));
    const { client } = makeClient(fetch);
    expect(await collect(client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP }))).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('retries info requests', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', 502), () =>
      jsonResponse({ organization_name: 'acme', project_name: 'web' }),
    );
    const { client } = makeClient(fetch);
    expect(await client.info()).toEqual({ organization_name: 'acme', project_name: 'web' });
    expect(calls).toHaveLength(2);
  });

  it('sends the same body on every attempt', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('boom', 503), ok);
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP, limit: 5 });
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });
});

describe('retry settings', () => {
  it('has documented defaults', () => {
    const options = resolveRetryOptions(undefined);
    expect(options.maxRetries).toBe(2);
    expect(options.baseDelayMs).toBe(500);
    expect(options.maxDelayMs).toBe(8000);
    expect(options.maxRetryAfterMs).toBe(60_000);
    expect(options.retryNetworkErrors).toBe(true);
  });

  it.each([{ maxRetries: -1 }, { maxRetries: 1.5 }, { baseDelayMs: -1 }, { maxDelayMs: Number.NaN }])('rejects %j', (options) => {
    expect(() => resolveRetryOptions(options)).toThrow(RangeError);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [599, true],
    [400, false],
    [404, false],
    [422, false],
    [200, false],
  ])('status %i retryable: %s', (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});
