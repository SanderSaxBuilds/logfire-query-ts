import { describe, expect, it } from 'vitest';
import { normalizeFields, parseHttpDate, parseRetryAfterHeader, parseRetryAfterMember, toColumnResults } from '../src/index.js';

describe('parseHttpDate', () => {
  it('reads an IMF-fixdate', () => {
    expect(parseHttpDate('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(Date.UTC(2015, 9, 21, 7, 28, 0));
  });

  it('reads a numeric offset', () => {
    expect(parseHttpDate('Wed, 21 Oct 2015 09:28:00 +0200')).toBe(Date.UTC(2015, 9, 21, 7, 28, 0));
  });

  it('reads a date without a weekday or zone as UTC', () => {
    expect(parseHttpDate('21 Oct 2015 07:28:00')).toBe(Date.UTC(2015, 9, 21, 7, 28, 0));
  });

  it.each(['not a date', '1.5', '2015-10-21', 'Wed, 32 Oct 2015 07:28:00 GMT', 'Wed, 31 Feb 2015 07:28:00 GMT', 'Wed, 21 Foo 2015 07:28:00 GMT'])(
    'rejects %j',
    (value) => {
      expect(parseHttpDate(value)).toBeUndefined();
    },
  );
});

describe('parseRetryAfterHeader', () => {
  it('returns null for an absent header', () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader(undefined)).toBeNull();
  });

  it('trims whitespace around seconds', () => {
    expect(parseRetryAfterHeader(' 12 ')).toBe(12);
  });

  it('gives zero for a date in the past', () => {
    expect(parseRetryAfterHeader('Wed, 21 Oct 2015 07:28:00 GMT', Date.UTC(2026, 0, 1))).toBe(0);
  });

  it('gives seconds until a date in the future', () => {
    expect(parseRetryAfterHeader('Thu, 01 Jan 2026 00:01:30 GMT', Date.UTC(2026, 0, 1))).toBe(90);
  });
});

describe('parseRetryAfterMember', () => {
  it.each([
    [0, 0],
    [2.5, 2.5],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
    [{}, null],
  ])('%s gives %s', (value, expected) => {
    expect(parseRetryAfterMember(value)).toBe(expected);
  });
});

describe('normalizeFields', () => {
  it('renames data_type at every depth and drops dict keys, as the Python client does', () => {
    const input = [
      {
        name: 's',
        data_type: { Struct: [{ name: 'x', data_type: { List: { name: 'item', data_type: 'Int64', dict_id: 0, dict_is_ordered: false, metadata: {} } } }] },
        nullable: true,
        metadata: { k: 'v' },
      },
    ];
    expect(normalizeFields(input)).toEqual([
      { name: 's', datatype: { Struct: [{ name: 'x', datatype: { List: { name: 'item', datatype: 'Int64' } } }] }, nullable: true },
    ]);
  });

  it('leaves scalars alone', () => {
    expect(normalizeFields('Utf8')).toBe('Utf8');
    expect(normalizeFields(null)).toBeNull();
  });

  it('does not let a __proto__ key change the prototype', () => {
    const out = normalizeFields(JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps column order when pivoting', () => {
    const result = toColumnResults({
      schema: { fields: [{ name: 'b', data_type: 'Utf8', nullable: false }, { name: 'a', data_type: 'Utf8', nullable: false }] },
      data: [{ a: '1', b: '2' }],
    });
    expect(result.columns.map((c) => [c.name, c.values])).toEqual([
      ['b', ['2']],
      ['a', ['1']],
    ]);
  });
});
