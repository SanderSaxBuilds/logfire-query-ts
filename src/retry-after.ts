const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * An RFC 5322 date as used by HTTP, for example `Wed, 21 Oct 2015 07:28:00 GMT`.
 * The weekday is optional and the zone is `GMT`, `UT`, `UTC`, `Z` or a numeric offset.
 */
const HTTP_DATE_PATTERN =
  /^(?:(?:mon|tue|wed|thu|fri|sat|sun),\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(gmt|utc|ut|z|[+-]\d{4})?$/i;

/** Parses an HTTP date into epoch milliseconds, or returns `undefined` when it is not a valid date. */
export function parseHttpDate(value: string): number | undefined {
  const match = HTTP_DATE_PATTERN.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const [, dayText, monthText, yearText, hourText, minuteText, secondText, zone] = match;
  const month = MONTHS[(monthText ?? '').toLowerCase()];
  if (month === undefined) {
    return undefined;
  }
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  let offsetMinutes = 0;
  if (zone !== undefined && /^[+-]\d{4}$/.test(zone)) {
    const sign = zone.startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  }
  const utc = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCDate() !== day) {
    return undefined;
  }
  return utc - offsetMinutes * 60_000;
}

/**
 * Returns the delay in seconds from a `Retry-After` header, or `null` if the header is absent or invalid.
 *
 * The header is either the delay-seconds form of RFC 9110, a non-negative integer, or an HTTP date.
 * An HTTP date in the past gives a delay of zero. This follows the Python `LogfireQueryClient`, which
 * accepts only plain digits for the seconds form, so `1.5`, `1e9` and `-5` are invalid.
 */
export function parseRetryAfterHeader(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return parseRetryAfterMember(Number(trimmed));
  }
  const at = parseHttpDate(trimmed);
  if (at === undefined) {
    return null;
  }
  return Math.max(0, (at - now) / 1000);
}

/** Returns a finite, non-negative delay in seconds from a JSON value, or `null` for any other value. */
export function parseRetryAfterMember(value: unknown): number | null {
  if (typeof value !== 'number') {
    return null;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}
