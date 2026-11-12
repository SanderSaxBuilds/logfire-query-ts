import { LogfireQueryClient, type LogfireQueryClientOptions } from '../src/index.js';

export const BASE_URL = 'http://localhost:3000';
export const READ_TOKEN = 'fake-read-token';
export const SQL = 'SELECT message FROM records';
export const MIN_TIMESTAMP = '2020-01-01T00:00:00+00:00';

/** One request as the fake server saw it. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * A fake `fetch`. Each call uses the next handler, and the last handler answers every call after it.
 * Every request is recorded in `calls`.
 */
export function mockFetch(...handlers: Handler[]): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(request);
    if (request.signal?.aborted) {
      throw request.signal.reason;
    }
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (handler === undefined) {
      throw new Error('mockFetch has no handler');
    }
    return handler(request);
  };
  return { fetch: fake as typeof fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 || status === 304 ? null : text, { status, headers });
}

export function problemResponse(problem: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(problem), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

/** A response whose body arrives in the given chunks. Strings are UTF-8 encoded. */
export function chunkedResponse(chunks: (string | Uint8Array)[], contentType = 'application/x-ndjson'): Response {
  return new Response(chunkStream(chunks), { status: 200, headers: { 'content-type': contentType } });
}

export function chunkStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  });
}

/** Splits bytes into pieces of `size` bytes, to cut lines and UTF-8 characters at awkward places. */
export function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

/** A handler that never answers until the request is aborted, then rejects like `fetch` does. */
export function hang(): Handler {
  return (request) =>
    new Promise<Response>((_, reject) => {
      const signal = request.signal;
      if (signal === undefined) {
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

/** A client against the fake server. Retry waits are recorded instead of slept. */
export function makeClient(
  fetchImpl: typeof fetch,
  options: Partial<LogfireQueryClientOptions> = {},
): { client: LogfireQueryClient; delays: number[] } {
  const delays: number[] = [];
  const retry = options.retry === false ? false : {
    random: () => 1,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    ...(options.retry ?? {}),
  };
  const client = new LogfireQueryClient({
    readToken: READ_TOKEN,
    baseUrl: BASE_URL,
    ...options,
    fetch: fetchImpl,
    retry,
  });
  return { client, delays };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}
