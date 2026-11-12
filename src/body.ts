import type { QueryOptions, QueryRequestBody, Timestamp } from './types.js';

/** The largest `limit` the API accepts. */
export const MAX_LIMIT = 10_000;

/** An ISO 8601 date-time. The time and the offset are optional. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Turns a timestamp option into the ISO string sent to the API.
 *
 * The API needs timestamps with an offset. A string without one is read as UTC, the same rule the
 * Python client applies to naive datetimes. Strings are otherwise sent unchanged, so microsecond
 * precision is kept.
 */
export function formatTimestamp(value: Timestamp, name: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`${name} is an invalid Date`);
    }
    return value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} must be a finite number of milliseconds, got ${value}`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new RangeError(`${name} is out of the Date range: ${value}`);
    }
    return date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = ISO_PATTERN.exec(trimmed);
    let result: string | undefined;
    if (match !== null) {
      if (match[1] !== undefined) {
        result = trimmed;
      } else if (trimmed.length === 10) {
        result = `${trimmed}T00:00:00Z`;
      } else {
        result = `${trimmed}Z`;
      }
    }
    if (result === undefined || Number.isNaN(Date.parse(result.replace(' ', 'T')))) {
      throw new RangeError(`${name} must be an ISO 8601 timestamp, got ${JSON.stringify(value)}`);
    }
    return result;
  }
  throw new TypeError(`${name} must be a Date, a number or an ISO 8601 string`);
}

/** Builds the `POST /v2/query` body. Keys are in the same order as the Python client sends them. */
export function buildQueryBody(sql: string, options: QueryOptions): QueryRequestBody {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new TypeError('sql must be a non-empty string');
  }
  if (options === undefined || options === null || options.minTimestamp === undefined || options.minTimestamp === null) {
    throw new TypeError('minTimestamp is required by the Logfire Query API');
  }

  if (options.explain !== undefined && typeof options.explain !== 'boolean') {
    throw new TypeError('explain must be a boolean');
  }
  if (options.limit !== undefined) {
    const { limit } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}, got ${limit}`);
    }
  }

  // Keys are added in this order so the JSON matches what the Python client sends.
  const head: Pick<QueryRequestBody, 'sql' | 'explain' | 'include_schema'> & { limit?: number } = {
    sql,
    explain: options.explain ?? false,
    include_schema: true,
  };
  if (options.limit !== undefined) {
    head.limit = options.limit;
  }
  const body: QueryRequestBody = Object.assign(head, {
    min_timestamp: formatTimestamp(options.minTimestamp, 'minTimestamp'),
  });
  if (options.maxTimestamp !== undefined) {
    body.max_timestamp = formatTimestamp(options.maxTimestamp, 'maxTimestamp');
  }

  if (options.timezone !== undefined) {
    if (typeof options.timezone !== 'string' || options.timezone === '') {
      throw new TypeError('timezone must be a non-empty string');
    }
    body.timezone = options.timezone;
  }

  if (options.environment !== undefined) {
    const environments = typeof options.environment === 'string' ? [options.environment] : [...options.environment];
    for (const environment of environments) {
      if (typeof environment !== 'string') {
        throw new TypeError('environment must be a string or a list of strings');
      }
    }
    body.deployment_environment = environments;
  }

  return body;
}
