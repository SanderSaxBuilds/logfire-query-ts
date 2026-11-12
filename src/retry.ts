import { LogfireApiError, LogfireConnectionError } from './errors.js';

/** What `onRetry` receives before each wait. */
export interface RetryInfo {
  /** The number of the retry about to happen, starting at 1. */
  attempt: number;
  /** How long the client waits before that retry, in milliseconds. */
  delayMs: number;
  /** The error that caused the retry. */
  error: LogfireApiError | LogfireConnectionError;
}

/** Retry settings. Rate limits (`429`) and server errors (`5xx`) are retried. */
export interface RetryOptions {
  /** How many times to retry after the first attempt. Default 2. Use 0 to turn retries off. */
  maxRetries?: number | undefined;
  /** The first backoff delay in milliseconds when the server sends no `Retry-After`. Default 500. */
  baseDelayMs?: number | undefined;
  /** The largest backoff delay in milliseconds. Default 8000. */
  maxDelayMs?: number | undefined;
  /**
   * The longest `Retry-After` the client waits for, in milliseconds. Default 60000.
   * A longer wait, for example when the daily query budget is used, is not retried and the
   * error is thrown at once so the caller can decide.
   */
  maxRetryAfterMs?: number | undefined;
  /** Whether connection failures are retried too. Default true. Timeouts are never retried. */
  retryNetworkErrors?: boolean | undefined;
  /** Called before each wait, for logging or metrics. */
  onRetry?: ((info: RetryInfo) => void) | undefined;
  /** Replaces the wait between attempts. It must reject when `signal` aborts. Mainly for tests. */
  sleep?: ((ms: number, signal: AbortSignal | undefined) => Promise<void>) | undefined;
  /** Replaces `Math.random` for the backoff jitter. Mainly for tests. */
  random?: (() => number) | undefined;
}

/** Retry settings with every default filled in. */
export interface ResolvedRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  retryNetworkErrors: boolean;
  onRetry: ((info: RetryInfo) => void) | undefined;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  random: () => number;
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new RangeError(`retry.${name} must be a non-negative number, got ${String(value)}`);
  }
  return value;
}

/** Fills in retry defaults. `false` turns retries off. */
export function resolveRetryOptions(options: RetryOptions | false | undefined): ResolvedRetryOptions {
  const source: RetryOptions = options === false ? { maxRetries: 0 } : (options ?? {});
  const maxRetries = nonNegative(source.maxRetries, 2, 'maxRetries');
  if (!Number.isInteger(maxRetries)) {
    throw new RangeError(`retry.maxRetries must be an integer, got ${maxRetries}`);
  }
  return {
    maxRetries,
    baseDelayMs: nonNegative(source.baseDelayMs, 500, 'baseDelayMs'),
    maxDelayMs: nonNegative(source.maxDelayMs, 8_000, 'maxDelayMs'),
    maxRetryAfterMs: nonNegative(source.maxRetryAfterMs, 60_000, 'maxRetryAfterMs'),
    retryNetworkErrors: source.retryNetworkErrors ?? true,
    onRetry: source.onRetry,
    sleep: source.sleep ?? sleep,
    random: source.random ?? Math.random,
  };
}

/** Whether a status code is retried: `429` and every `5xx`. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Returns the wait in milliseconds before the next attempt, or `null` when the error must not be retried.
 * `attempt` counts the retries already made, starting at 0.
 */
export function retryDelay(error: unknown, attempt: number, options: ResolvedRetryOptions): number | null {
  if (attempt >= options.maxRetries) {
    return null;
  }
  if (error instanceof LogfireConnectionError) {
    return options.retryNetworkErrors ? backoff(attempt, options) : null;
  }
  if (!(error instanceof LogfireApiError) || !isRetryableStatus(error.status) || error.retryable === false) {
    return null;
  }
  if (error.retryAfter !== null) {
    const ms = error.retryAfter * 1000;
    return ms <= options.maxRetryAfterMs ? ms : null;
  }
  return backoff(attempt, options);
}

/** Exponential backoff with jitter: between half and all of `baseDelayMs * 2^attempt`, capped at `maxDelayMs`. */
export function backoff(attempt: number, options: Pick<ResolvedRetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return ceiling * (0.5 + options.random() * 0.5);
}

/** Waits `ms` milliseconds. Rejects with the signal's reason when it aborts. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
