import { buildQueryBody } from './body.js';
import {
  InfoRequestError,
  type LogfireApiError,
  LogfireConnectionError,
  LogfireTimeoutError,
  MalformedResponseError,
  PROBLEM_JSON,
  QueryStreamError,
  errorFromResponse,
} from './errors.js';
import { readNdjson } from './ndjson.js';
import { type Region, resolveBaseUrl } from './regions.js';
import { type RetryOptions, type ResolvedRetryOptions, resolveRetryOptions, retryDelay } from './retry.js';
import { assertQueryResponse, toColumnResults, toRowResults } from './results.js';
import {
  FORMAT_MEDIA_TYPES,
  type ColumnQueryResults,
  type QueryFormat,
  type QueryOptions,
  type QueryResponse,
  type RawResult,
  type ReadTokenInfo,
  type Row,
  type RowQueryResults,
  type StreamMessage,
} from './types.js';
import { VERSION } from './version.js';

/** The default timeout, 30 seconds, the same as the Python client. Queries can be slower than a typical API call. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The default `User-Agent` header. */
export const DEFAULT_USER_AGENT = `logfire-query-ts/${VERSION}`;

/** Options for `LogfireQueryClient`. */
export interface LogfireQueryClientOptions {
  /** A Logfire read token. Create one in the project settings under Read tokens. */
  readToken: string;
  /**
   * The API base URL, for a self-hosted Logfire or a proxy. Without it the client uses `region`,
   * or else the region written in the read token, or else the US region.
   */
  baseUrl?: string | undefined;
  /** The Logfire Cloud data region. Ignored when `baseUrl` is set. */
  region?: Region | undefined;
  /** Milliseconds before a request is aborted. Default 30000. `null` waits forever. */
  timeout?: number | null | undefined;
  /** Retry settings, or `false` to turn retries off. */
  retry?: RetryOptions | false | undefined;
  /** A `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
  /** Extra headers sent with every request. They cannot replace `Authorization`. */
  headers?: Record<string, string> | Headers | undefined;
  /** The `User-Agent` header. Default `logfire-query-ts/<version>`. */
  userAgent?: string | undefined;
  /** Called when the read token names a region this package does not know. Defaults to `console.warn`. */
  onUnknownRegion?: ((region: string) => void) | undefined;
}

/** Options for `queryRaw`. */
export interface RawQueryOptions extends QueryOptions {
  /** The response format. */
  format: Exclude<QueryFormat, 'ndjson'>;
}

/** Options for one request, after the query body is built. */
interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  accept: string;
  body?: string;
  signal?: AbortSignal | undefined;
  timeout?: number | null | undefined;
}

/** A request whose response headers arrived with status 200, and whose body is still to be read. */
interface OpenResponse {
  response: Response;
  attempt: AttemptSignal;
}

/** Combines the caller's signal with a timeout, for one attempt. */
class AttemptSignal {
  readonly controller = new AbortController();
  timedOut = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAbort: () => void;

  constructor(
    private readonly user: AbortSignal | undefined,
    readonly timeoutMs: number | null,
  ) {
    this.onAbort = () => this.controller.abort(this.user?.reason);
    if (user !== undefined) {
      if (user.aborted) {
        this.controller.abort(user.reason);
      } else {
        user.addEventListener('abort', this.onAbort, { once: true });
      }
    }
    if (timeoutMs !== null) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort(new LogfireTimeoutError(timeoutMs));
      }, timeoutMs);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Stops the timeout but keeps the caller's signal linked, for streams that outlive the headers. */
  clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.user?.removeEventListener('abort', this.onAbort);
  }

  /** Maps an error thrown by `fetch` or a body read to the error the caller should see. */
  translate(error: unknown): unknown {
    if (this.timedOut && this.timeoutMs !== null) {
      return new LogfireTimeoutError(this.timeoutMs);
    }
    if (this.user?.aborted) {
      return this.user.reason;
    }
    return error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTimeout(value: number | null | undefined, name: string): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds or null, got ${String(value)}`);
  }
  return value;
}

/**
 * A client for the Logfire Query API, `POST /v2/query`.
 *
 * It runs SQL against a project's `records` and `metrics` tables with a read token, and returns
 * JSON rows, JSON columns, an NDJSON stream, CSV text or Arrow IPC bytes.
 */
export class LogfireQueryClient {
  /** The API base URL requests are sent to. */
  readonly baseUrl: string;
  /** The request timeout in milliseconds, or `null` for none. */
  readonly timeout: number | null;
  private readonly readToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Headers;
  private readonly retry: ResolvedRetryOptions;

  constructor(options: LogfireQueryClientOptions | string) {
    const resolved: LogfireQueryClientOptions = typeof options === 'string' ? { readToken: options } : options;
    if (resolved === null || typeof resolved !== 'object') {
      throw new TypeError('LogfireQueryClient needs a read token or an options object');
    }
    if (typeof resolved.readToken !== 'string' || resolved.readToken.trim() === '') {
      throw new TypeError('readToken must be a non-empty string');
    }
    this.readToken = resolved.readToken.trim();
    this.baseUrl = resolveBaseUrl({
      readToken: this.readToken,
      baseUrl: resolved.baseUrl,
      region: resolved.region,
      onUnknownRegion:
        resolved.onUnknownRegion ??
        ((region) => {
          console.warn(`Unknown region "${region}" in Logfire token, falling back to the US region. Known regions: eu, us.`);
        }),
    });
    const timeout = validateTimeout(resolved.timeout, 'timeout');
    this.timeout = timeout === undefined ? DEFAULT_TIMEOUT_MS : timeout;
    const fetchImpl = resolved.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No fetch implementation found. Pass one with the fetch option.');
    }
    this.fetchImpl = fetchImpl;
    this.retry = resolveRetryOptions(resolved.retry);

    this.baseHeaders = new Headers(resolved.headers);
    if (!this.baseHeaders.has('user-agent') || resolved.userAgent !== undefined) {
      this.baseHeaders.set('user-agent', resolved.userAgent ?? DEFAULT_USER_AGENT);
    }
    const authorization = /^bearer\s/i.test(this.readToken) ? this.readToken : `Bearer ${this.readToken}`;
    this.baseHeaders.set('authorization', authorization);
  }

  /** Returns the organization and project the read token belongs to, from `GET /v1/read-token-info`. */
  async info(options: { signal?: AbortSignal | undefined; timeout?: number | null | undefined } = {}): Promise<ReadTokenInfo> {
    const text = await this.fetchText({
      method: 'GET',
      path: '/v1/read-token-info',
      accept: 'application/json',
      signal: options.signal,
      timeout: options.timeout,
    });
    const value = this.parseJson(text);
    const organization = isRecord(value) ? value['organization_name'] : undefined;
    const project = isRecord(value) ? value['project_name'] : undefined;
    if (typeof organization !== 'string' || typeof project !== 'string') {
      throw new InfoRequestError(
        'The read token info response is missing required fields: organization_name or project_name',
      );
    }
    return { organization_name: organization, project_name: project };
  }

  /** Runs a query and returns the `application/json` response as the API sends it: `{schema, data}`. */
  async query<R extends object = Row>(sql: string, options: QueryOptions): Promise<QueryResponse<R>> {
    const text = await this.fetchText(this.querySpec(sql, options, 'json'));
    return assertQueryResponse<R>(this.parseJson(text));
  }

  /**
   * Runs a query and returns row-oriented results: `{columns, rows}`, the same shape as the Python
   * client's `query_json_rows`. Column `data_type` keys are renamed to `datatype`.
   */
  async queryJsonRows<R extends object = Row>(sql: string, options: QueryOptions): Promise<RowQueryResults<R>> {
    return toRowResults(await this.query<R>(sql, options));
  }

  /** Runs a query and returns column-oriented results: one entry per column, with its values in row order. */
  async queryJsonColumns(sql: string, options: QueryOptions): Promise<ColumnQueryResults> {
    return toColumnResults(await this.query(sql, options));
  }

  /** Runs a query and returns the CSV text. JSON columns such as `attributes` arrive as JSON strings. */
  async queryCsv(sql: string, options: QueryOptions): Promise<string> {
    const { bytes } = await this.queryRaw(sql, { ...options, format: 'csv' });
    return new TextDecoder('utf-8').decode(bytes);
  }

  /**
   * Runs a query and returns the Arrow IPC stream bytes. Read them with `tableFromIPC` from the
   * `apache-arrow` package, or pass them to any Arrow reader.
   */
  async queryArrow(sql: string, options: QueryOptions): Promise<Uint8Array> {
    const { bytes } = await this.queryRaw(sql, { ...options, format: 'arrow' });
    return bytes;
  }

  /** Runs a query and returns the response body bytes in the chosen format, with the response content type. */
  async queryRaw(sql: string, options: RawQueryOptions): Promise<RawResult> {
    const { format, ...rest } = options;
    if (format !== 'json' && format !== 'arrow' && format !== 'csv') {
      throw new TypeError(`format must be "json", "arrow" or "csv", got ${JSON.stringify(format)}`);
    }
    const spec = this.querySpec(sql, rest, format);
    const { response, attempt } = await this.open(spec);
    try {
      const buffer = await response.arrayBuffer();
      return { bytes: new Uint8Array(buffer), contentType: response.headers.get('content-type') };
    } catch (error) {
      throw attempt.translate(error);
    } finally {
      attempt.dispose();
    }
  }

  /**
   * Runs a query with the `application/x-ndjson` format and yields each message as it arrives:
   * `schema`, `explain`, `data`, `error` and `end`. Message types this package does not know are skipped.
   *
   * The request is sent when iteration starts. The timeout covers the time until the response headers
   * arrive, the caller's `signal` covers the whole stream. Stopping the loop early cancels the response.
   * A stream that ends without an `end` or `error` message throws `MalformedResponseError`.
   */
  async *streamMessages<R extends object = Row>(sql: string, options: QueryOptions): AsyncGenerator<StreamMessage<R>, void, undefined> {
    const spec = this.querySpec(sql, options, 'ndjson');
    const { response, attempt } = await this.open(spec);
    attempt.clearTimer();
    let finished = false;
    try {
      if (response.body === null) {
        throw new MalformedResponseError('The NDJSON response has no body');
      }
      for await (const value of readNdjson(response.body)) {
        const message = parseStreamMessage<R>(value);
        if (message === undefined) {
          continue;
        }
        if (message.type === 'end' || message.type === 'error') {
          finished = true;
        }
        yield message;
      }
      if (!finished) {
        throw new MalformedResponseError('The NDJSON stream ended without an "end" message');
      }
    } catch (error) {
      throw attempt.translate(error);
    } finally {
      attempt.dispose();
    }
  }

  /**
   * Runs a query with the NDJSON format and yields one row at a time.
   * An `error` message throws `QueryStreamError`. The `row_count` of the `end` message is checked
   * against the rows received.
   */
  async *streamRows<R extends object = Row>(sql: string, options: QueryOptions): AsyncGenerator<R, void, undefined> {
    let received = 0;
    for await (const message of this.streamMessages<R>(sql, options)) {
      if (message.type === 'data') {
        for (const row of message.rows) {
          received += 1;
          yield row;
        }
      } else if (message.type === 'error') {
        throw new QueryStreamError(message as unknown as Record<string, unknown>);
      } else if (message.type === 'end') {
        if (message.row_count !== received) {
          throw new MalformedResponseError(
            `The NDJSON stream sent ${received} rows but its end message says ${message.row_count}`,
          );
        }
        return;
      }
    }
  }

  private querySpec(sql: string, options: QueryOptions, format: QueryFormat): RequestSpec {
    const body = buildQueryBody(sql, options);
    return {
      method: 'POST',
      path: '/v2/query',
      accept: `${FORMAT_MEDIA_TYPES[format]}, ${PROBLEM_JSON};q=0.9`,
      body: JSON.stringify(body),
      signal: options.signal,
      timeout: options.timeout,
    };
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new MalformedResponseError('The response body is not valid JSON', { cause });
    }
  }

  private async fetchText(spec: RequestSpec): Promise<string> {
    const { response, attempt } = await this.open(spec);
    try {
      return await response.text();
    } catch (error) {
      throw attempt.translate(error);
    } finally {
      attempt.dispose();
    }
  }

  /**
   * Sends a request, retrying as configured, until a `200 OK` response arrives or an error is final.
   * The returned attempt must be disposed by the caller once the body is read.
   */
  private async open(spec: RequestSpec): Promise<OpenResponse> {
    const timeoutOption = validateTimeout(spec.timeout, 'timeout');
    const timeoutMs = timeoutOption === undefined ? this.timeout : timeoutOption;
    const url = `${this.baseUrl}${spec.path}`;
    const headers = new Headers(this.baseHeaders);
    headers.set('accept', spec.accept);
    if (spec.body !== undefined) {
      headers.set('content-type', 'application/json');
    }

    for (let retries = 0; ; retries += 1) {
      if (spec.signal?.aborted) {
        throw spec.signal.reason;
      }
      const attempt = new AttemptSignal(spec.signal, timeoutMs);
      let failure: unknown;
      try {
        const init: RequestInit = { method: spec.method, headers, signal: attempt.signal };
        if (spec.body !== undefined) {
          init.body = spec.body;
        }
        let response: Response;
        try {
          response = await this.fetchImpl(url, init);
        } catch (error) {
          const translated = attempt.translate(error);
          if (translated !== error || spec.signal?.aborted) {
            throw translated;
          }
          const reason = error instanceof Error ? error.message : String(error);
          throw new LogfireConnectionError(`Could not reach ${this.baseUrl}: ${reason}`, error);
        }
        if (response.status === 200) {
          return { response, attempt };
        }
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw attempt.translate(error);
        }
        throw errorFromResponse(response.status, response.headers, text);
      } catch (error) {
        attempt.dispose();
        failure = error;
      }

      const delay = retryDelay(failure, retries, this.retry);
      if (delay === null) {
        throw failure;
      }
      // retryDelay only allows API and connection errors through.
      this.retry.onRetry?.({ attempt: retries + 1, delayMs: delay, error: failure as LogfireApiError | LogfireConnectionError });
      await this.retry.sleep(delay, spec.signal);
    }
  }
}

/** Checks one NDJSON value against the documented message shapes. Unknown types return `undefined`. */
function parseStreamMessage<R extends object>(value: unknown): StreamMessage<R> | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new MalformedResponseError(`Expected an NDJSON message object with a "type", got ${JSON.stringify(value)}`);
  }
  switch (value['type']) {
    case 'schema': {
      const schema = value['schema'];
      if (!isRecord(schema) || !Array.isArray(schema['fields'])) {
        throw new MalformedResponseError('The NDJSON schema message has no "schema.fields" list');
      }
      return value as unknown as StreamMessage<R>;
    }
    case 'explain':
      return value as unknown as StreamMessage<R>;
    case 'data': {
      const rows = value['rows'];
      if (!Array.isArray(rows) || !rows.every(isRecord)) {
        throw new MalformedResponseError('The NDJSON data message has no "rows" list of objects');
      }
      return value as unknown as StreamMessage<R>;
    }
    case 'error':
      if (typeof value['message'] !== 'string') {
        return { ...value, type: 'error', message: JSON.stringify(value) } as StreamMessage<R>;
      }
      return value as unknown as StreamMessage<R>;
    case 'end':
      if (typeof value['row_count'] !== 'number') {
        throw new MalformedResponseError('The NDJSON end message has no numeric "row_count"');
      }
      return value as unknown as StreamMessage<R>;
    default:
      return undefined;
  }
}
