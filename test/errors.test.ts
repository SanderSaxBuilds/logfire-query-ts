import { describe, expect, it } from 'vitest';
import {
  LogfireApiError,
  LogfireQueryError,
  QueryExecutionError,
  QueryRateLimitedError,
  QueryRequestError,
  UnexpectedResponseError,
  errorFromResponse,
} from '../src/index.js';
import { LEGACY_ERROR, problemBody } from './fixtures/index.js';
import { MIN_TIMESTAMP, SQL, jsonResponse, makeClient, mockFetch, problemResponse, textResponse, type Handler } from './helpers.js';

/** Runs one JSON query against a handler with retries off and returns the error it throws. */
async function failWith(handler: Handler, method: 'queryJsonRows' | 'queryCsv' | 'queryArrow' | 'info' = 'queryJsonRows'): Promise<unknown> {
  const { fetch } = mockFetch(handler);
  const { client } = makeClient(fetch, { retry: false });
  try {
    if (method === 'info') {
      await client.info();
    } else {
      await client[method](SQL, { minTimestamp: MIN_TIMESTAMP });
    }
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** A server that sends a problem detail only when Accept names application/problem+json. */
function negotiating(status: number, problem: Record<string, unknown>, headers: Record<string, string> = {}): Handler {
  return (request) => {
    if ((request.headers.get('accept') ?? '').includes('application/problem+json')) {
      return problemResponse(problem, status, headers);
    }
    return jsonResponse(LEGACY_ERROR, status, headers);
  };
}

describe('unexpected status codes', () => {
  it.each([204, 301, 404, 500, 502, 503])('raises UnexpectedResponseError for %i', async (status) => {
    const error = await failWith(() => textResponse('upstream is unhappy', status));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).status).toBe(status);
    expect(String((error as Error).message)).toContain(String(status));
    if (status !== 204) {
      expect((error as Error).message).toContain('upstream is unhappy');
    }
  });

  it('keeps an undecodable JSON body of an unexpected response as text', async () => {
    const error = await failWith(() => textResponse('{"detail": "trunca', 500, { 'content-type': 'application/json' }));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toContain('{\\"detail\\": \\"trunca');
    expect((error as UnexpectedResponseError).body).toBe('{"detail": "trunca');
  });

  it('raises UnexpectedResponseError from info for a 503', async () => {
    const error = await failWith(() => textResponse('unavailable', 503), 'info');
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toContain('unavailable');
  });

  it('every API error is a LogfireApiError and a LogfireQueryError', async () => {
    const error = await failWith(() => textResponse('x', 500));
    expect(error).toBeInstanceOf(LogfireApiError);
    expect(error).toBeInstanceOf(LogfireQueryError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('UnexpectedResponseError');
  });
});

describe('query errors', () => {
  const statuses = [
    [400, QueryExecutionError],
    [422, QueryRequestError],
  ] as const;

  describe.each(statuses)('status %i', (status, ErrorClass) => {
    it('passes a JSON body as the detail', async () => {
      const error = await failWith(() => jsonResponse({ detail: 'nope' }, status));
      expect(error).toBeInstanceOf(ErrorClass);
      expect((error as LogfireApiError).detail).toEqual({ detail: 'nope' });
      expect((error as Error).message).toBe('{"detail":"nope"}');
    });

    it('passes a text body as the detail', async () => {
      const error = await failWith(() => textResponse('nope', status));
      expect((error as LogfireApiError).detail).toBe('nope');
      expect((error as Error).message).toBe('nope');
    });

    it('reads a JSON content type with parameters and any case', async () => {
      const error = await failWith(() => textResponse('1', status, { 'content-type': 'APPLICATION/JSON; charset=utf-8' }));
      expect((error as LogfireApiError).detail).toBe(1);
    });

    it('gives the same detail for old and new servers', async () => {
      const problem = problemBody(status, 'query-error', { retryable: false });
      const oldError = (await failWith(() => jsonResponse(LEGACY_ERROR, status))) as LogfireApiError;
      const newError = (await failWith(negotiating(status, problem))) as LogfireApiError;
      expect(oldError).toBeInstanceOf(ErrorClass);
      expect(newError).toBeInstanceOf(ErrorClass);
      expect(oldError.detail).toEqual(LEGACY_ERROR);
      expect(newError.detail).toEqual(LEGACY_ERROR);
      expect(oldError.problem).toBeNull();
      expect(oldError.problemType).toBeNull();
      expect(oldError.retryable).toBeNull();
      expect(newError.problem).toEqual(problem);
      expect(newError.problemType).toBe('https://logfire.pydantic.dev/-/errors/query-error');
      expect(newError.retryable).toBe(false);
      expect(newError.retryAfter).toBeNull();
    });

    it('passes a problem detail without error_details whole', async () => {
      const problem = { type: 'about:blank', title: 'Bad Request', status, detail: 'bad' };
      const error = (await failWith(() => problemResponse(problem, status))) as LogfireApiError;
      expect(error.detail).toEqual(problem);
      expect(error.problemType).toBe('about:blank');
    });

    it.each(['{"trunca', '[1]'])('passes a malformed problem body %j as text', async (content) => {
      const error = (await failWith(() => textResponse(content, status, { 'content-type': 'application/problem+json' }))) as LogfireApiError;
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.detail).toBe(content);
      expect(error.problem).toBeNull();
    });

    it('keeps the status, headers and raw body', async () => {
      const error = (await failWith(() => jsonResponse(LEGACY_ERROR, status, { 'x-request-id': 'r1' }))) as LogfireApiError;
      expect(error.status).toBe(status);
      expect(error.headers.get('x-request-id')).toBe('r1');
      expect(JSON.parse(error.body)).toEqual(LEGACY_ERROR);
    });
  });

  it('a server that is not asked for problem details sends the legacy body', async () => {
    const handler = negotiating(400, problemBody(400, 'query-error'));
    const response = await handler({ url: '', method: 'POST', headers: new Headers({ accept: 'application/json' }), body: '{}', signal: undefined });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(LEGACY_ERROR);
  });
});

describe('rate limits and problem details', () => {
  it('raises QueryRateLimitedError, where Retry-After wins over the problem body', async () => {
    const problem = problemBody(429, 'rate-limit', { retryable: true, retry_after: 30, rule_id: 'rule-1', expires_at: '2030-01-01T00:00:00Z' });
    const error = (await failWith(negotiating(429, problem, { 'retry-after': '45' }))) as QueryRateLimitedError;
    expect(error).toBeInstanceOf(QueryRateLimitedError);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.message.startsWith('Unexpected response status code 429: ')).toBe(true);
    expect(error.retryAfter).toBe(45);
    expect(error.retryable).toBe(true);
    expect(error.problemType).toBe('https://logfire.pydantic.dev/-/errors/rate-limit');
    expect(error.problem?.['rule_id']).toBe('rule-1');
    expect(error.problem?.['expires_at']).toBe('2030-01-01T00:00:00Z');
  });

  it.each([
    [{ 'retry-after': '7' }, 7],
    [{ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, 0],
    [{ 'retry-after': 'not a date' }, null],
    [{ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 -0000' }, 0],
    [{}, null],
  ])('reads Retry-After %j from a server without problem details', async (headers, expected) => {
    const error = (await failWith(() => textResponse('slow down', 429, headers))) as QueryRateLimitedError;
    expect(error).toBeInstanceOf(QueryRateLimitedError);
    expect(error.message).toBe('Unexpected response status code 429: "slow down"');
    expect(error.problem).toBeNull();
    expect(error.retryAfter).toBe(expected);
  });

  it('reads retry_after from the problem body when the header is missing', async () => {
    const error = (await failWith(negotiating(503, problemBody(503, 'query-timeout', { retryable: true, retry_after: 5 })))) as LogfireApiError;
    expect(error.constructor).toBe(UnexpectedResponseError);
    expect(error.retryAfter).toBe(5);
    expect(error.problemType).toBe('https://logfire.pydantic.dev/-/errors/query-timeout');
  });

  it('reads retry_after from the problem body when the header is invalid', async () => {
    const problem = problemBody(429, 'rate-limit', { retryable: true, retry_after: 12 });
    const error = (await failWith(negotiating(429, problem, { 'retry-after': 'not a date' }))) as LogfireApiError;
    expect(error.retryAfter).toBe(12);
  });

  it.each(['{"trunca', '[1]'])('ignores a malformed problem body %j on a 500', async (content) => {
    const error = (await failWith(() => textResponse(content, 500, { 'content-type': 'application/problem+json' }))) as LogfireApiError;
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.problem).toBeNull();
  });

  it.each([
    ['30', 30],
    ['0', 0],
    ['nan', null],
    ['inf', null],
    ['-5', null],
    ['1e9', null],
    ['1.5', null],
    ['9'.repeat(5000), null],
  ])('accepts only delay-seconds in the Retry-After header %j', async (header, expected) => {
    const error = (await failWith(() => textResponse('slow down', 429, { 'retry-after': header }))) as LogfireApiError;
    expect(error.retryAfter).toBe(expected);
  });

  it.each([
    [30, 30],
    [2.5, 2.5],
    [1e9, 1e9],
    [-5, null],
    [true, null],
    ['nan', null],
    ['30', null],
  ])('accepts only finite non-negative numbers in the problem retry_after %j', async (retryAfter, expected) => {
    const error = (await failWith(negotiating(503, problemBody(503, 'query-timeout', { retryable: true, retry_after: retryAfter })))) as LogfireApiError;
    expect(error.retryAfter).toBe(expected);
  });

  it('rejects a problem retry_after that overflows to infinity', () => {
    const body = '{"type":"x","retry_after":1e400}';
    const error = errorFromResponse(503, new Headers({ 'content-type': 'application/problem+json' }), body);
    expect(error.retryAfter).toBeNull();
  });

  it('turns an HTTP date in the future into seconds from now', () => {
    const now = Date.UTC(2026, 10, 13, 12, 0, 0);
    const header = new Date(now + 3_600_000).toUTCString();
    const error = errorFromResponse(429, new Headers({ 'retry-after': header }), 'slow down', now);
    expect(error.retryAfter).toBe(3600);
  });

  it('raises the rate-limit error from CSV and Arrow queries too', async () => {
    expect(await failWith(() => textResponse('slow down', 429), 'queryCsv')).toBeInstanceOf(QueryRateLimitedError);
    expect(await failWith(() => textResponse('slow down', 429), 'queryArrow')).toBeInstanceOf(QueryRateLimitedError);
  });
});
