import { describe, expect, it } from 'vitest';
import { MalformedResponseError, QueryRateLimitedError, QueryStreamError, readNdjson, type StreamMessage } from '../src/index.js';
import {
  DOCS_NDJSON_DATA,
  DOCS_NDJSON_END,
  DOCS_NDJSON_ERROR,
  DOCS_NDJSON_SCHEMA,
  DOCS_NDJSON_STREAM,
} from './fixtures/index.js';
import { MIN_TIMESTAMP, SQL, chunkStream, chunkedResponse, collect, makeClient, mockFetch, splitBytes, textResponse } from './helpers.js';

function streamClient(chunks: (string | Uint8Array)[]) {
  const { fetch, calls } = mockFetch(() => chunkedResponse(chunks));
  return { ...makeClient(fetch), calls };
}

describe('NDJSON line reader', () => {
  it('reads one value per line', async () => {
    expect(await collect(readNdjson(chunkStream(['{"a":1}\n{"a":2}\n'])))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reads a last line without a newline', async () => {
    expect(await collect(readNdjson(chunkStream(['{"a":1}\n{"a":2}'])))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('accepts CRLF line endings', async () => {
    expect(await collect(readNdjson(chunkStream(['{"a":1}\r\n{"a":2}\r\n'])))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips blank lines', async () => {
    expect(await collect(readNdjson(chunkStream(['\n{"a":1}\n\n  \n{"a":2}\n\n'])))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('joins a line split across chunks', async () => {
    expect(await collect(readNdjson(chunkStream(['{"a":', '1}', '\n{"a"', ':2}\n'])))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const text = '{"message":"привет 👋 Grüße"}\n';
    for (const size of [1, 2, 3, 5, 7]) {
      expect(await collect(readNdjson(chunkStream(splitBytes(text, size))))).toEqual([{ message: 'привет 👋 Grüße' }]);
    }
  });

  it('reads an empty stream as no values', async () => {
    expect(await collect(readNdjson(chunkStream([])))).toEqual([]);
  });

  it('throws MalformedResponseError with the line number for invalid JSON', async () => {
    await expect(collect(readNdjson(chunkStream(['{"a":1}\n{oops\n'])))).rejects.toThrow(/line 2/);
    await expect(collect(readNdjson(chunkStream(['{oops\n'])))).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it('cancels the stream when the consumer stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const value of readNdjson(stream)) {
      expect(value).toEqual({ a: 1 });
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe('streamMessages', () => {
  it('yields the documented messages in order', async () => {
    const { client, calls } = streamClient([DOCS_NDJSON_STREAM]);
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(messages).toEqual([JSON.parse(DOCS_NDJSON_SCHEMA), JSON.parse(DOCS_NDJSON_DATA), JSON.parse(DOCS_NDJSON_END)]);
    expect(calls[0]?.headers.get('accept')).toBe('application/x-ndjson, application/problem+json;q=0.9');
    expect(calls[0]?.url).toBe('http://localhost:3000/v2/query');
  });

  it('yields the same messages when every byte arrives on its own', async () => {
    const { client } = streamClient(splitBytes(DOCS_NDJSON_STREAM, 1));
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(messages.map((m) => m.type)).toEqual(['schema', 'data', 'end']);
  });

  it('narrows message types for the caller', async () => {
    const { client } = streamClient([DOCS_NDJSON_STREAM]);
    const names: string[] = [];
    let rowCount = -1;
    for await (const message of client.streamMessages<{ service_name: string }>(SQL, { minTimestamp: MIN_TIMESTAMP })) {
      if (message.type === 'schema') {
        names.push(...message.schema.fields.map((f) => f.name));
      } else if (message.type === 'data') {
        names.push(...message.rows.map((r) => r.service_name));
      } else if (message.type === 'end') {
        rowCount = message.row_count;
      }
    }
    expect(names).toEqual(['service_name', 'backend', 'frontend']);
    expect(rowCount).toBe(2);
  });

  it('yields an explain message when explain is set', async () => {
    const explain = '{"type": "explain", "logical_plan": "Projection: records.service_name", "physical_plan": "ProjectionExec"}';
    const { client, calls } = streamClient([[DOCS_NDJSON_SCHEMA, explain, DOCS_NDJSON_DATA, DOCS_NDJSON_END].join('\n')]);
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP, explain: true }));
    const found = messages.find((m): m is Extract<StreamMessage, { type: 'explain' }> => m.type === 'explain');
    expect(found?.logical_plan).toBe('Projection: records.service_name');
    expect(found?.physical_plan).toBe('ProjectionExec');
    expect(JSON.parse(calls[0]?.body ?? '{}').explain).toBe(true);
  });

  it('keeps physical_plan_with_metrics on the end message', async () => {
    const end = '{"type": "end", "row_count": 0, "physical_plan_with_metrics": "ProjectionExec, metrics=[output_rows=0]"}';
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n${end}\n`]);
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(messages[1]).toEqual(JSON.parse(end));
  });

  it('yields the error message and lets the stream end after it', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n${DOCS_NDJSON_ERROR}\n`]);
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(messages[1]).toEqual({ type: 'error', message: 'Invalid SQL: ...' });
  });

  it('skips message types it does not know', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n{"type":"progress","pct":50}\n${DOCS_NDJSON_DATA}\n${DOCS_NDJSON_END}\n`]);
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(messages.map((m) => m.type)).toEqual(['schema', 'data', 'end']);
  });

  it('throws MalformedResponseError when the stream stops before the end message', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n${DOCS_NDJSON_DATA}\n`]);
    await expect(collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }))).rejects.toThrow(/without an "end" message/);
  });

  it.each([
    ['[1,2]'],
    ['{"rows": []}'],
    ['{"type": "schema"}'],
    ['{"type": "data", "rows": "nope"}'],
    ['{"type": "data", "rows": [1]}'],
    ['{"type": "end"}'],
  ])('throws MalformedResponseError for the line %s', async (line) => {
    const { client } = streamClient([`${line}\n${DOCS_NDJSON_END}\n`]);
    await expect(collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }))).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it('fills in a message for an error message without text', async () => {
    const { client } = streamClient(['{"type":"error","code":7}\n']);
    const messages = await collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(messages[0]?.type).toBe('error');
    expect((messages[0] as { message: string }).message).toContain('"code":7');
  });

  it('sends nothing until iteration starts', async () => {
    const { client, calls } = streamClient([DOCS_NDJSON_STREAM]);
    const iterator = client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP });
    expect(calls).toHaveLength(0);
    await iterator.next();
    expect(calls).toHaveLength(1);
    await iterator.return(undefined);
  });

  it('raises the HTTP error before any message for a rate-limited stream', async () => {
    const { fetch } = mockFetch(() => textResponse('slow down', 429, { 'retry-after': '120' }));
    const { client } = makeClient(fetch);
    await expect(collect(client.streamMessages(SQL, { minTimestamp: MIN_TIMESTAMP }))).rejects.toBeInstanceOf(QueryRateLimitedError);
  });
});

describe('streamRows', () => {
  it('yields each row of the documented stream', async () => {
    const { client } = streamClient([DOCS_NDJSON_STREAM]);
    expect(await collect(client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP }))).toEqual([
      { service_name: 'backend' },
      { service_name: 'frontend' },
    ]);
  });

  it('yields rows across many data messages', async () => {
    const batches = Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: 'data', rows: [{ n: i * 2 }, { n: i * 2 + 1 }] }));
    const { client } = streamClient([[DOCS_NDJSON_SCHEMA, ...batches, '{"type":"end","row_count":10}'].join('\n')]);
    const rows = await collect(client.streamRows<{ n: number }>(SQL, { minTimestamp: MIN_TIMESTAMP }));
    expect(rows.map((r) => r.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('yields nothing for a stream with no rows', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n{"type":"end","row_count":0}\n`]);
    expect(await collect(client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP }))).toEqual([]);
  });

  it('throws QueryStreamError with the server message for an error message', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n${DOCS_NDJSON_ERROR}\n`]);
    const error = await collect(client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryStreamError);
    expect((error as QueryStreamError).serverMessage).toBe('Invalid SQL: ...');
    expect((error as QueryStreamError).raw).toEqual({ type: 'error', message: 'Invalid SQL: ...' });
  });

  it('yields the rows sent before an error, then throws', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n${DOCS_NDJSON_DATA}\n${DOCS_NDJSON_ERROR}\n`]);
    const rows: unknown[] = [];
    await expect(
      (async () => {
        for await (const row of client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP })) {
          rows.push(row);
        }
      })(),
    ).rejects.toBeInstanceOf(QueryStreamError);
    expect(rows).toHaveLength(2);
  });

  it('checks row_count against the rows received', async () => {
    const { client } = streamClient([`${DOCS_NDJSON_SCHEMA}\n${DOCS_NDJSON_DATA}\n{"type":"end","row_count":3}\n`]);
    await expect(collect(client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP }))).rejects.toThrow(/sent 2 rows but its end message says 3/);
  });

  it('cancels the response body when the caller breaks out early', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(encoder.encode(sent === 1 ? `${DOCS_NDJSON_SCHEMA}\n` : `${DOCS_NDJSON_DATA}\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = mockFetch(() => new Response(body, { status: 200 }));
    const { client } = makeClient(fetch);
    for await (const row of client.streamRows(SQL, { minTimestamp: MIN_TIMESTAMP })) {
      expect(row).toEqual({ service_name: 'backend' });
      break;
    }
    expect(cancelled).toBe(true);
  });
});
