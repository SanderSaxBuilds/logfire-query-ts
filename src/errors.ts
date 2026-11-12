import { parseRetryAfterHeader, parseRetryAfterMember } from './retry-after.js';

/** The media type of an RFC 9457 problem detail body. */
export const PROBLEM_JSON = 'application/problem+json';

/** The base class of every error this package throws, except `TypeError` and `RangeError` for invalid arguments. */
export class LogfireQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Fields shared by every error built from an HTTP response that was not `200 OK`. */
export interface ApiErrorInit {
  status: number;
  headers: Headers;
  body: string;
  detail: unknown;
  problem: Record<string, unknown> | null;
  retryAfter: number | null;
}

/**
 * An error built from an HTTP response that was not `200 OK`.
 *
 * When the server sends an RFC 9457 problem detail (`application/problem+json`), `problem` holds the
 * whole body and `problemType` and `retryable` are read from it. Otherwise they are `null`.
 */
export class LogfireApiError extends LogfireQueryError {
  /** The HTTP status code. */
  readonly status: number;
  /** The response headers. */
  readonly headers: Headers;
  /** The raw response body as text. */
  readonly body: string;
  /**
   * The error detail. For `400` and `422` it is the legacy error body (from `error_details` when the
   * server sent a problem detail), the problem detail itself, the parsed JSON body, or the body text,
   * in that order, the same value the Python client puts in `args[0]`. For other statuses it is the message.
   */
  readonly detail: unknown;
  /** The full problem detail body, when the server sent one. */
  readonly problem: Record<string, unknown> | null;
  /** The `type` URI of the problem detail, which identifies the kind of error. */
  readonly problemType: string | null;
  /** Whether the server said the same request can succeed later. */
  readonly retryable: boolean | null;
  /** Seconds the server asks the client to wait, from `Retry-After` or else the problem body. */
  readonly retryAfter: number | null;

  constructor(message: string, init: ApiErrorInit) {
    super(message);
    this.status = init.status;
    this.headers = init.headers;
    this.body = init.body;
    this.detail = init.detail;
    this.problem = init.problem;
    const problemType = init.problem?.['type'];
    this.problemType = typeof problemType === 'string' ? problemType : null;
    const retryable = init.problem?.['retryable'];
    this.retryable = typeof retryable === 'boolean' ? retryable : null;
    this.retryAfter = init.retryAfter;
  }
}

/** Raised when the query execution fails on the server, status `400`. */
export class QueryExecutionError extends LogfireApiError {}

/** Raised when the query request is invalid, status `422`. */
export class QueryRequestError extends LogfireApiError {}

/** Raised when the API responds with an unexpected status code, such as a `5xx` server error. */
export class UnexpectedResponseError extends LogfireApiError {}

/**
 * Raised when the API responds with status `429` because the query was rate limited.
 * `retryAfter` says how many seconds to wait before the next request.
 */
export class QueryRateLimitedError extends UnexpectedResponseError {}

/** Raised when the read token info response is missing the organization or project name. */
export class InfoRequestError extends LogfireQueryError {}

/** Raised when a request takes longer than the client's `timeout`. */
export class LogfireTimeoutError extends LogfireQueryError {
  /** The timeout that was reached, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Logfire request timed out after ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when the request could not reach the server, for example a DNS or TLS failure. */
export class LogfireConnectionError extends LogfireQueryError {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

/** Raised when a `200 OK` response does not have the documented shape. */
export class MalformedResponseError extends LogfireQueryError {}

/** Raised while streaming NDJSON when the server sends an `error` message. */
export class QueryStreamError extends LogfireQueryError {
  /** The `message` field of the `error` message. */
  readonly serverMessage: string;
  /** The whole `error` message as sent by the server. */
  readonly raw: Record<string, unknown>;

  constructor(raw: Record<string, unknown>) {
    const serverMessage = typeof raw['message'] === 'string' ? raw['message'] : JSON.stringify(raw);
    super(serverMessage);
    this.serverMessage = serverMessage;
    this.raw = raw;
  }
}

function mediaTypeOf(headers: Headers): string {
  // An absent content type is read as text, the same assumption the Python client makes.
  const contentType = headers.get('content-type') ?? 'text/plain';
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(detail: unknown): string {
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

/**
 * Builds the typed error for a response that was not `200 OK`.
 * This is a port of `handle_response_errors` in the Python `LogfireQueryClient`.
 */
export function errorFromResponse(status: number, headers: Headers, body: string, now: number = Date.now()): LogfireApiError {
  const mediaType = mediaTypeOf(headers);
  let problem: Record<string, unknown> | null = null;
  if (mediaType === PROBLEM_JSON) {
    const parsed = parseJson(body);
    problem = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  }

  // The `Retry-After` header takes precedence. The problem body is used only when the header is absent or invalid.
  let retryAfter = parseRetryAfterHeader(headers.get('retry-after'), now);
  if (retryAfter === null && problem !== null) {
    retryAfter = parseRetryAfterMember(problem['retry_after']);
  }

  if (status === 400 || status === 422) {
    let detail: unknown;
    const errorDetails = problem?.['error_details'];
    if (errorDetails !== undefined && errorDetails !== null) {
      // The problem detail carries the legacy error body in `error_details`,
      // so `detail` is the same whether or not the server sends a problem detail.
      detail = errorDetails;
    } else if (mediaType === PROBLEM_JSON) {
      // A problem detail body that is not a JSON object is passed as text.
      detail = problem ?? body;
    } else if (mediaType === 'application/json') {
      const parsed = parseJson(body);
      detail = parsed.ok ? parsed.value : body;
    } else {
      detail = body;
    }
    const ErrorClass = status === 400 ? QueryExecutionError : QueryRequestError;
    return new ErrorClass(describe(detail), { status, headers, body, detail, problem, retryAfter });
  }

  // An unexpected response (a 5xx, or an error page from a proxy) is not guaranteed to have
  // a well-formed body, so it is kept as text.
  const message = `Unexpected response status code ${status}: ${JSON.stringify(body)}`;
  const ErrorClass = status === 429 ? QueryRateLimitedError : UnexpectedResponseError;
  return new ErrorClass(message, { status, headers, body, detail: message, problem, retryAfter });
}
