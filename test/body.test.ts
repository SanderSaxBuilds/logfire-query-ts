import { describe, expect, it } from 'vitest';
import { MAX_LIMIT, buildQueryBody, formatTimestamp } from '../src/index.js';
import { RECORDED_BODY_PARAMS_REQUEST, RECORDED_REQUEST_BODY, RECORDED_SQL } from './fixtures/index.js';

describe('request body', () => {
  it('matches the body the Python client sent, byte for byte', () => {
    const body = buildQueryBody(RECORDED_SQL, { minTimestamp: '2020-01-01T00:00:00+00:00' });
    expect(JSON.stringify(body)).toBe(RECORDED_REQUEST_BODY);
  });

  it('matches the recorded body with every optional parameter, byte for byte', () => {
    const body = buildQueryBody('SELECT count(*) AS n FROM records', {
      minTimestamp: '2020-01-01T00:00:00+00:00',
      maxTimestamp: '2099-01-01T00:00:00+00:00',
      timezone: 'UTC',
      environment: ['production'],
    });
    expect(JSON.stringify(body)).toBe(RECORDED_BODY_PARAMS_REQUEST);
  });

  it('puts limit before the timestamps, as the Python client does', () => {
    const body = buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00+00:00', limit: 1 });
    expect(Object.keys(body)).toEqual(['sql', 'explain', 'include_schema', 'limit', 'min_timestamp']);
    expect(body.limit).toBe(1);
  });

  it('sends a single environment as a one-item list', () => {
    const body = buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', environment: 'staging' });
    expect(body.deployment_environment).toEqual(['staging']);
  });

  it('keeps the empty string environment, which matches rows with no environment', () => {
    const body = buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', environment: ['', 'prod'] });
    expect(body.deployment_environment).toEqual(['', 'prod']);
  });

  it('sends explain when asked', () => {
    expect(buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', explain: true }).explain).toBe(true);
  });

  it('defaults explain to false and always asks for the schema', () => {
    const body = buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z' });
    expect(body.explain).toBe(false);
    expect(body.include_schema).toBe(true);
  });

  it('leaves out optional keys that were not given', () => {
    const body = buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z' });
    expect(body).not.toHaveProperty('max_timestamp');
    expect(body).not.toHaveProperty('limit');
    expect(body).not.toHaveProperty('timezone');
    expect(body).not.toHaveProperty('deployment_environment');
  });

  it('requires minTimestamp, as the API does', () => {
    expect(() => buildQueryBody('SELECT 1', {} as never)).toThrow(/minTimestamp is required/);
  });

  it.each(['', '   '])('rejects empty SQL %j', (sql) => {
    expect(() => buildQueryBody(sql, { minTimestamp: '2020-01-01T00:00:00Z' })).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, MAX_LIMIT + 1, Number.NaN])('rejects limit %s', (limit) => {
    expect(() => buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', limit })).toThrow(RangeError);
  });

  it('accepts the documented maximum limit of 10,000', () => {
    expect(MAX_LIMIT).toBe(10_000);
    expect(buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', limit: 10_000 }).limit).toBe(10_000);
  });

  it('rejects an empty timezone', () => {
    expect(() => buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', timezone: '' })).toThrow(TypeError);
  });

  it('rejects a non-string environment', () => {
    expect(() =>
      buildQueryBody('SELECT 1', { minTimestamp: '2020-01-01T00:00:00Z', environment: [1 as unknown as string] }),
    ).toThrow(TypeError);
  });
});

describe('timestamps', () => {
  it('formats a Date in UTC', () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 4, 27, 13, 16, 36, 517)), 'minTimestamp')).toBe('2026-05-27T13:16:36.517Z');
  });

  it('formats epoch milliseconds', () => {
    expect(formatTimestamp(0, 'minTimestamp')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('keeps a string with an offset unchanged, microseconds included', () => {
    expect(formatTimestamp('2026-05-27T13:16:36.517321Z', 'minTimestamp')).toBe('2026-05-27T13:16:36.517321Z');
    expect(formatTimestamp('2026-05-27T15:16:36+02:00', 'minTimestamp')).toBe('2026-05-27T15:16:36+02:00');
  });

  it('reads a string without an offset as UTC, like naive datetimes in the Python client', () => {
    expect(formatTimestamp('2020-01-01T00:00:00', 'minTimestamp')).toBe('2020-01-01T00:00:00Z');
  });

  it('reads a bare date as midnight UTC', () => {
    expect(formatTimestamp('2020-01-01', 'minTimestamp')).toBe('2020-01-01T00:00:00Z');
  });

  it.each(['yesterday', '2020-13-01T00:00:00Z', '01/02/2020', ''])('rejects %j', (value) => {
    expect(() => formatTimestamp(value, 'minTimestamp')).toThrow(RangeError);
  });

  it('rejects an invalid Date', () => {
    expect(() => formatTimestamp(new Date('nope'), 'minTimestamp')).toThrow(RangeError);
  });

  it('rejects a non-finite number', () => {
    expect(() => formatTimestamp(Number.POSITIVE_INFINITY, 'maxTimestamp')).toThrow(/maxTimestamp/);
  });

  it('rejects other types', () => {
    expect(() => formatTimestamp({} as never, 'minTimestamp')).toThrow(TypeError);
  });
});
