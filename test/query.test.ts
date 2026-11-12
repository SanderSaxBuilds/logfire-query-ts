import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_AGENT, InfoRequestError, LogfireQueryClient, MalformedResponseError, VERSION } from '../src/index.js';
import {
  DOCS_JSON_RESPONSE,
  DOCS_PYTHON_ROWS_OUTPUT,
  RECORDED_ARROW_RESPONSE,
  RECORDED_ARROW_SHA256,
  RECORDED_BODY_PARAMS_RESPONSE,
  RECORDED_CSV_RESPONSE,
  RECORDED_EMPTY_CSV_RESPONSE,
  RECORDED_INFO_RESPONSE,
  RECORDED_JSON_RESPONSE,
  RECORDED_REQUEST_BODY,
  RECORDED_SQL,
} from './fixtures/index.js';
import { BASE_URL, MIN_TIMESTAMP, READ_TOKEN, SQL, jsonResponse, makeClient, mockFetch, textResponse } from './helpers.js';

describe('request', () => {
  it('posts to /v2/query', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${BASE_URL}/v2/query`);
  });

  it('sends the read token as a Bearer token, as documented', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${READ_TOKEN}`);
  });

  it('does not add a second Bearer prefix', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch, { readToken: 'Bearer pylf_v1_us_x' });
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer pylf_v1_us_x');
  });

  it('sends a JSON body with a JSON content type', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(RECORDED_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await client.query(RECORDED_SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.body).toBe(RECORDED_REQUEST_BODY);
  });

  it('sends the package user agent by default', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('user-agent')).toBe(`logfire-query-ts/${VERSION}`);
    expect(DEFAULT_USER_AGENT).toBe(`logfire-query-ts/${VERSION}`);
  });

  it('lets the caller set the user agent and extra headers', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch, { userAgent: 'my-app/1.0', headers: { 'x-team': 'data' } });
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('user-agent')).toBe('my-app/1.0');
    expect(calls[0]?.headers.get('x-team')).toBe('data');
  });

  it('keeps a user agent given in headers', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch, { headers: { 'User-Agent': 'from-headers/2' } });
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('user-agent')).toBe('from-headers/2');
  });

  it('does not let extra headers replace the authorization header', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch, { headers: { Authorization: 'Bearer other' } });
    await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${READ_TOKEN}`);
  });

  it.each([
    ['query', 'application/json, application/problem+json;q=0.9'],
    ['queryJsonRows', 'application/json, application/problem+json;q=0.9'],
    ['queryJsonColumns', 'application/json, application/problem+json;q=0.9'],
    ['queryCsv', 'text/csv, application/problem+json;q=0.9'],
    ['queryArrow', 'application/vnd.apache.arrow.stream, application/problem+json;q=0.9'],
  ] as const)('%s ranks its data type before problem details in Accept', async (method, accept) => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await client[method](SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls[0]?.headers.get('accept')).toBe(accept);
  });

  it('accepts the read token as a plain string argument', () => {
    const client = new LogfireQueryClient('pylf_v1_eu_x');
    expect(client.baseUrl).toBe('https://logfire-eu.pydantic.dev');
  });

  it('rejects an empty read token', () => {
    expect(() => new LogfireQueryClient({ readToken: '  ' })).toThrow(TypeError);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeout %s', (timeout) => {
    expect(() => new LogfireQueryClient({ readToken: READ_TOKEN, timeout })).toThrow(RangeError);
  });

  it('uses a 30 second timeout by default, like the Python client', () => {
    expect(new LogfireQueryClient(READ_TOKEN).timeout).toBe(30_000);
    expect(new LogfireQueryClient({ readToken: READ_TOKEN, timeout: null }).timeout).toBeNull();
  });

  it('checks options before sending anything', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP, limit: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe('JSON results', () => {
  it('returns the documented {schema, data} response as sent', async () => {
    const { fetch } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    const result = await client.query<{ service_name: string }>(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(result).toEqual(DOCS_JSON_RESPONSE);
    expect(result.data[0]?.service_name).toBe('backend');
  });

  it('maps the documented response to Python-style {columns, rows}', async () => {
    const { fetch } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    expect(await client.queryJsonRows(SQL, { minTimestamp: MIN_TIMESTAMP })).toEqual({
      columns: [{ name: 'service_name', datatype: 'Utf8', nullable: false }],
      rows: [{ service_name: 'backend' }],
    });
  });

  it('gives the same shape as the documented Python output for a timestamp column', async () => {
    const response = {
      schema: { fields: [{ name: 'start_timestamp', data_type: { Timestamp: ['Microsecond', 'UTC'] }, nullable: false }] },
      data: [{ start_timestamp: '2026-05-27T13:16:36.517321Z' }],
    };
    const { fetch } = mockFetch(() => jsonResponse(response));
    const { client } = makeClient(fetch);
    expect(await client.queryJsonRows(SQL, { minTimestamp: MIN_TIMESTAMP })).toEqual(DOCS_PYTHON_ROWS_OUTPUT);
  });

  it('renames nested data_type keys and drops Arrow dictionary keys in the recorded response', async () => {
    const { fetch } = mockFetch(() => jsonResponse(RECORDED_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    const result = await client.queryJsonRows(RECORDED_SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(result.columns).toEqual([
      { name: 'kind', datatype: 'Utf8', nullable: false },
      { name: 'message', datatype: 'Utf8', nullable: false },
      { name: 'is_exception', datatype: 'Boolean', nullable: true },
      { name: 'tags', datatype: { List: { name: 'item', datatype: 'Utf8', nullable: true } }, nullable: true },
    ]);
    expect(result.rows).toEqual([
      { kind: 'log', message: 'about to raise an error', is_exception: false, tags: [] },
      { kind: 'log', message: 'aha 0', is_exception: false, tags: ['tag1', 'tag2'] },
    ]);
  });

  it('keeps the schema metadata in the raw response', async () => {
    const { fetch } = mockFetch(() => jsonResponse(RECORDED_BODY_PARAMS_RESPONSE));
    const { client } = makeClient(fetch);
    const result = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(result.schema['metadata']).toEqual({});
    expect(result.data).toEqual([{ n: 0 }]);
  });

  it('pivots results into columns', async () => {
    const { fetch } = mockFetch(() => jsonResponse(RECORDED_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    const result = await client.queryJsonColumns(RECORDED_SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(result.columns.map((c) => c.name)).toEqual(['kind', 'message', 'is_exception', 'tags']);
    expect(result.columns[1]).toEqual({
      name: 'message',
      datatype: 'Utf8',
      nullable: false,
      values: ['about to raise an error', 'aha 0'],
    });
    expect(result.columns[3]?.values).toEqual([[], ['tag1', 'tag2']]);
  });

  it('reads a value missing from a row as null in columns', async () => {
    const response = {
      schema: { fields: [{ name: 'a', data_type: 'Int64', nullable: true }] },
      data: [{ a: 1 }, {}],
    };
    const { fetch } = mockFetch(() => jsonResponse(response));
    const { client } = makeClient(fetch);
    expect((await client.queryJsonColumns(SQL, { minTimestamp: MIN_TIMESTAMP })).columns[0]?.values).toEqual([1, null]);
  });

  it('returns empty columns and rows for an empty result', async () => {
    const response = { schema: { fields: [{ name: 'n', data_type: 'Int64', nullable: false }] }, data: [] };
    const { fetch } = mockFetch(() => jsonResponse(response));
    const { client } = makeClient(fetch);
    expect(await client.queryJsonRows(SQL, { minTimestamp: MIN_TIMESTAMP })).toEqual({
      columns: [{ name: 'n', datatype: 'Int64', nullable: false }],
      rows: [],
    });
    expect((await client.queryJsonColumns(SQL, { minTimestamp: MIN_TIMESTAMP })).columns[0]?.values).toEqual([]);
  });

  it('passes plans through when explain is set', async () => {
    const response = { ...DOCS_JSON_RESPONSE, logical_plan: 'Projection', physical_plan: 'ProjectionExec' };
    const { fetch, calls } = mockFetch(() => jsonResponse(response));
    const { client } = makeClient(fetch);
    const result = await client.query(SQL, { minTimestamp: MIN_TIMESTAMP, explain: true });
    expect(JSON.parse(calls[0]?.body ?? '{}').explain).toBe(true);
    expect(result.logical_plan).toBe('Projection');
    expect(result.physical_plan).toBe('ProjectionExec');
  });

  it.each([
    ['not JSON', 'Expected a JSON'],
    ['[]', 'Expected a JSON object'],
    ['{"data": []}', 'schema.fields'],
    ['{"schema": {"fields": []}}', '"data"'],
    ['{"schema": {"fields": []}, "data": [1]}', '"data"'],
  ])('throws MalformedResponseError for the 200 body %j', async (body) => {
    const { fetch } = mockFetch(() => textResponse(body, 200, { 'content-type': 'application/json' }));
    const { client } = makeClient(fetch);
    await expect(client.query(SQL, { minTimestamp: MIN_TIMESTAMP })).rejects.toBeInstanceOf(MalformedResponseError);
  });
});

describe('CSV and Arrow', () => {
  it('returns the recorded CSV text unchanged', async () => {
    const { fetch } = mockFetch(() => textResponse(RECORDED_CSV_RESPONSE, 200, { 'content-type': 'text/csv' }));
    const { client } = makeClient(fetch);
    expect(await client.queryCsv(RECORDED_SQL, { minTimestamp: MIN_TIMESTAMP })).toBe(RECORDED_CSV_RESPONSE);
  });

  it('returns a header-only CSV for an empty result', async () => {
    const { fetch } = mockFetch(() => textResponse(RECORDED_EMPTY_CSV_RESPONSE));
    const { client } = makeClient(fetch);
    expect(await client.queryCsv(SQL, { minTimestamp: '2030-01-01T00:00:00+00:00' })).toBe('is_exception,count(*)\n');
  });

  it('decodes UTF-8 CSV text', async () => {
    const { fetch } = mockFetch(() => new Response(new TextEncoder().encode('message\nпривет 👋\n'), { status: 200 }));
    const { client } = makeClient(fetch);
    expect(await client.queryCsv(SQL, { minTimestamp: MIN_TIMESTAMP })).toBe('message\nпривет 👋\n');
  });

  it('returns the recorded Arrow stream bytes unchanged', async () => {
    const { fetch } = mockFetch(
      () => new Response(RECORDED_ARROW_RESPONSE, { status: 200, headers: { 'content-type': 'application/vnd.apache.arrow.stream' } }),
    );
    const { client } = makeClient(fetch);
    const bytes = await client.queryArrow(RECORDED_SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(1544);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(RECORDED_ARROW_SHA256);
  });

  it('returns an Arrow IPC stream that starts and ends with continuation markers', async () => {
    const { fetch } = mockFetch(() => new Response(RECORDED_ARROW_RESPONSE, { status: 200 }));
    const { client } = makeClient(fetch);
    const bytes = await client.queryArrow(RECORDED_SQL, { minTimestamp: MIN_TIMESTAMP });
    expect([...bytes.slice(0, 4)]).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect([...bytes.slice(-8)]).toEqual([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
  });

  it('queryRaw returns bytes and the content type for any format', async () => {
    const { fetch, calls } = mockFetch(() => textResponse(RECORDED_CSV_RESPONSE, 200, { 'content-type': 'text/csv; charset=utf-8' }));
    const { client } = makeClient(fetch);
    const raw = await client.queryRaw(SQL, { minTimestamp: MIN_TIMESTAMP, format: 'csv' });
    expect(new TextDecoder().decode(raw.bytes)).toBe(RECORDED_CSV_RESPONSE);
    expect(raw.contentType).toBe('text/csv; charset=utf-8');
    expect(calls[0]?.headers.get('accept')).toBe('text/csv, application/problem+json;q=0.9');
  });

  it('queryRaw can return the JSON body as bytes', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(RECORDED_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    const raw = await client.queryRaw(SQL, { minTimestamp: MIN_TIMESTAMP, format: 'json' });
    expect(new TextDecoder().decode(raw.bytes)).toBe(RECORDED_JSON_RESPONSE);
    expect(calls[0]?.headers.get('accept')).toBe('application/json, application/problem+json;q=0.9');
  });

  it('queryRaw rejects the streaming format and unknown formats', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(DOCS_JSON_RESPONSE));
    const { client } = makeClient(fetch);
    await expect(client.queryRaw(SQL, { minTimestamp: MIN_TIMESTAMP, format: 'ndjson' as never })).rejects.toThrow(TypeError);
    await expect(client.queryRaw(SQL, { minTimestamp: MIN_TIMESTAMP, format: 'xml' as never })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('read token info', () => {
  it('reads the organization and project from the recorded response', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(RECORDED_INFO_RESPONSE));
    const { client } = makeClient(fetch);
    expect(await client.info()).toEqual({ organization_name: 'viicos', project_name: 'logfire-sdk-cassettes' });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/read-token-info`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.has('content-type')).toBe(false);
  });

  it.each([
    ['{"organization_name": "acme"}'],
    ['{"project_name": "web"}'],
    ['{"organization_name": 1, "project_name": "web"}'],
    ['[]'],
  ])('throws InfoRequestError for %s', async (body) => {
    const { fetch } = mockFetch(() => jsonResponse(body));
    const { client } = makeClient(fetch);
    await expect(client.info()).rejects.toBeInstanceOf(InfoRequestError);
  });
});
