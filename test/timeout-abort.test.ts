import { describe, expect, it } from 'vitest';
import { LogfireTimeoutError } from '../src/index.js';
import { DOCS_JSON_RESPONSE, DOCS_NDJSON_DATA, DOCS_NDJSON_SCHEMA } from './fixtures/index.js';
import { MIN_TIMESTAMP, SQL, collect, hang, jsonResponse, makeClient, mockFetch, textResponse } from './helpers.js';

const sleepForTests = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A body that sends `first` and then nothing, and errors when the request signal aborts, as `fetch` bodies do. */
function stalledBody(first: string, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
}

describe('timeout', () => {
  it('throws LogfireTimeoutError when the server does not answer in time', async () => {
    const { fetch } = mockFetch(hang());
    const { client } = makeClient(fetch, { timeout: 20 });
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LogfireTimeoutError);
    expect((error as LogfireTimeoutError).timeoutMs).toBe(20);
  });

  it('does not retry a timeout', async () => {
    const { fetch, calls } = mockFetch(hang());
    const { client } = makeClient(fetch, { timeout: 10 });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(LogfireTimeoutError);
    expect(calls).toHaveLength(1);
  });

  it('lets one call override the client timeout', async () => {
    const { fetch } = mockFetch(hang());
    const { client } = makeClient(fetch, { timeout: 60_000 });
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP, timeout: 15 }).catch((e: unknown) => e);
    expect((error as LogfireTimeoutError).timeoutMs).toBe(15);
  });

  it('times out a body that stops arriving', async () => {
    const { fetch } = mockFetch((request) => new Response(stalledBody('{"schema":', request.signal), { status: 200 }));
    const { client } = makeClient(fetch, { timeout: 20 });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(LogfireTimeoutError);
  });

  it('applies the timeout to each attempt', async () => {
    let call = 0;
    const { fetch, calls } = mockFetch((request) => {
      call += 1;
      if (call === 1) {
        return textResponse('boom', 503);
      }
      return hang()(request);
    });
    const { client } = makeClient(fetch, { timeout: 20 });
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(LogfireTimeoutError);
    expect(calls).toHaveLength(2);
  });

  it('clears the timeout after a stream has started', async () => {
    let push: ((text: string) => void) | undefined;
    let close: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (text) => controller.enqueue(encoder.encode(text));
        close = () => controller.close();
      },
    });
    const { fetch } = mockFetch(() => new Response(body, { status: 200 }));
    const { client } = makeClient(fetch, { timeout: 20 });
    const rows = collect(client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP }));
    await sleepForTests(5);
    push?.(`${DOCS_NDJSON_SCHEMA}\n`);
    await sleepForTests(40);
    push?.(`${DOCS_NDJSON_DATA}\n{"type":"end","row_count":2}\n`);
    close?.();
    expect(await rows).toHaveLength(2);
  });
});

describe('AbortSignal', () => {
  it('does not send a request when the signal is already aborted', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP, signal: controller.signal })).rejects.toThrow('stop');
    expect(calls).toHaveLength(0);
  });

  it('rejects with the abort reason when aborted during the request', async () => {
    const { fetch } = mockFetch(hang());
    const { client } = makeClient(fetch);
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    setTimeout(() => controller.abort(reason), 5);
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP, signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(reason);
  });

  it('rejects with an AbortError by default', async () => {
    const { fetch } = mockFetch(hang());
    const { client } = makeClient(fetch);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP, signal: controller.signal }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
  });

  it('stops a retry wait when aborted', async () => {
    const { fetch, calls } = mockFetch(() => textResponse('slow down', 429, { 'retry-after': '30' }));
    const { client } = makeClient(fetch, { retry: { sleep: undefined } });
    const controller = new AbortController();
    const reason = new Error('give up');
    setTimeout(() => controller.abort(reason), 20);
    const started = Date.now();
    const error = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP, signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBe(reason);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toHaveLength(1);
  });

  it('aborts a stream that is being read', async () => {
    const { fetch } = mockFetch(
      (request) => new Response(stalledBody(`${DOCS_NDJSON_SCHEMA}\n${DOCS_NDJSON_DATA}\n`, request.signal), { status: 200 }),
    );
    const { client } = makeClient(fetch);
    const controller = new AbortController();
    const reason = new Error('enough');
    const rows: unknown[] = [];
    const error = await (async () => {
      for await (const row of client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP, signal: controller.signal })) {
        rows.push(row);
        if (rows.length === 2) {
          controller.abort(reason);
        }
      }
    })().catch((e: unknown) => e);
    expect(rows).toHaveLength(2);
    expect(error).toBe(reason);
  });

  it('passes a signal to fetch on every request', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
