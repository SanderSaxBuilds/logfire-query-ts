# logfire-query

A typed TypeScript client for the [Pydantic Logfire Query API](https://pydantic.dev/docs/logfire/manage/query-api/). It runs SQL against your Logfire `records` and `metrics` tables with a read token and gives you the result as JSON rows, JSON columns, an NDJSON stream, CSV text or Arrow bytes.

- Same options and result shapes as the Python `LogfireQueryClient`, so code and docs carry over.
- `streamRows()` reads `application/x-ndjson` as an async iterator, one row at a time, while the query is still sending.
- US and EU regions, picked from the read token like the Python SDK does, or a custom base URL for a proxy or self-hosted Logfire.
- Typed errors with status, body, RFC 9457 problem details and `retryAfter`.
- Retries on `429` and `5xx` with backoff, waiting the `Retry-After` the server asks for.
- Timeout and `AbortSignal` on every call.
- No runtime dependencies. It needs only `fetch` and web streams, so Node 18.17 or newer, or any other runtime that has both.
- ES module and CommonJS builds with type declarations, checked with `tsc --strict`.

## Install

```bash
npm install github:SanderSaxBuilds/logfire-query-ts
```

Or from a checkout:

```bash
npm install
npm run build
```

## Quick start

Create a read token in Logfire under your project, Settings, Read tokens, or with `logfire read-tokens --project <org>/<project> create`.

```ts
import { LogfireQueryClient } from 'logfire-query';

const client = new LogfireQueryClient({ readToken: process.env.LOGFIRE_READ_TOKEN! });

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

const { columns, rows } = await client.queryJsonRows(
  'SELECT start_timestamp, service_name, message FROM records ORDER BY start_timestamp DESC',
  { minTimestamp: twoHoursAgo, limit: 50 },
);

console.log(columns);
// [{ name: 'start_timestamp', datatype: { Timestamp: ['Microsecond', 'UTC'] }, nullable: false }, ...]
console.log(rows[0]);
// { start_timestamp: '2026-05-27T13:16:36.517321Z', service_name: 'backend', message: '...' }
```

CommonJS works the same way:

```js
const { LogfireQueryClient } = require('logfire-query');
```

## Query options

Every query method takes the SQL and an options object. `minTimestamp` is required, as it is in the API.

```ts
await client.queryJsonRows(sql, {
  minTimestamp: '2026-11-01T00:00:00Z', // Date, epoch ms, or ISO string. No offset means UTC.
  maxTimestamp: new Date(),
  limit: 1000,                         // server default 100, maximum 10,000
  timezone: 'Europe/Paris',
  environment: ['production', ''],     // '' matches rows with no environment
  explain: false,
  signal: AbortSignal.timeout(10_000),
  timeout: 60_000,                     // overrides the client timeout for this call
});
```

`minTimestamp` and `maxTimestamp` filter `start_timestamp` on `records` and `recorded_timestamp` on `metrics`. A `limit` takes priority over a `LIMIT` in the SQL. ISO strings are sent as written, so microseconds are kept.

## Result formats

| Method | Accept header | Returns |
| --- | --- | --- |
| `query()` | `application/json` | `{ schema: { fields }, data }`, the response as the API sends it |
| `queryJsonRows()` | `application/json` | `{ columns, rows }`, the Python client's `query_json_rows` shape |
| `queryJsonColumns()` | `application/json` | `{ columns: [{ name, datatype, nullable, values }] }` |
| `streamMessages()` | `application/x-ndjson` | async iterator of `schema`, `explain`, `data`, `error` and `end` messages |
| `streamRows()` | `application/x-ndjson` | async iterator of rows |
| `queryCsv()` | `text/csv` | CSV text |
| `queryArrow()` | `application/vnd.apache.arrow.stream` | Arrow IPC stream bytes as a `Uint8Array` |
| `queryRaw()` | any of the above but NDJSON | `{ bytes, contentType }` |
| `info()` | `GET /v1/read-token-info` | `{ organization_name, project_name }` |

Each query also asks for `application/problem+json` at a lower weight, so errors come back as problem details from servers that support them.

### Typed rows

```ts
interface Span {
  span_name: string;
  duration: number;
}

const { rows } = await client.queryJsonRows<Span>(
  'SELECT span_name, duration FROM records WHERE duration > 1 ORDER BY duration DESC',
  { minTimestamp: twoHoursAgo },
);
rows[0]?.span_name;
```

`queryJsonRows` renames every `data_type` in the schema to `datatype` and drops the Arrow `dict_id`, `dict_is_ordered` and `metadata` keys at any depth, the same clean-up the Python client does. `query()` keeps the schema untouched.

### Columns

```ts
const { columns } = await client.queryJsonColumns(
  'SELECT service_name, count(*) AS n FROM records GROUP BY service_name',
  { minTimestamp: twoHoursAgo },
);
// [{ name: 'service_name', datatype: 'Utf8', nullable: true, values: ['backend', 'frontend'] },
//  { name: 'n', datatype: 'Int64', nullable: false, values: [812, 97] }]
```

The v2 API returns rows. The column view is built from them on the client, in row order.

### Streaming

`streamRows()` starts handing out rows as soon as the first `data` message arrives, so a large export never sits in memory as one string.

```ts
let count = 0;
for await (const row of client.streamRows<{ trace_id: string }>(
  'SELECT trace_id FROM records WHERE is_exception',
  { minTimestamp: twoHoursAgo, limit: 10_000 },
)) {
  count += 1;
  if (count === 100) break; // stops reading and cancels the response
}
```

An `error` message throws `QueryStreamError` with the server's message. Rows sent before it have already been yielded. The `row_count` of the `end` message is checked against the rows received, and a stream that stops with neither an `end` nor an `error` throws `MalformedResponseError`.

For the schema and plans, read the messages themselves:

```ts
for await (const message of client.streamMessages(sql, { minTimestamp: twoHoursAgo, explain: true })) {
  switch (message.type) {
    case 'schema':
      console.log(message.schema.fields.map((f) => f.name));
      break;
    case 'explain':
      console.log(message.physical_plan);
      break;
    case 'data':
      console.log(message.rows.length, 'rows');
      break;
    case 'error':
      console.error(message.message);
      break;
    case 'end':
      console.log('total', message.row_count);
      break;
  }
}
```

The request is sent when iteration starts. The timeout covers the time until the response headers arrive, and `signal` covers the whole stream.

### CSV and Arrow

```ts
const csv = await client.queryCsv('SELECT service_name, message FROM records', { minTimestamp: twoHoursAgo });

const bytes = await client.queryArrow('SELECT service_name, duration FROM records', { minTimestamp: twoHoursAgo });

// With the apache-arrow package:
import { tableFromIPC } from 'apache-arrow';
const table = tableFromIPC(bytes);
```

JSON columns such as `attributes` arrive as JSON strings in both formats.

## Regions and base URL

| Region | Base URL |
| --- | --- |
| US | `https://logfire-us.pydantic.dev` |
| EU | `https://logfire-eu.pydantic.dev` |

The client picks the region from the token (`pylf_v1_eu_...` goes to the EU), the same way the Python SDK does. Tokens from before regions existed go to the US. You can also say it yourself:

```ts
new LogfireQueryClient({ readToken, region: 'eu' });
new LogfireQueryClient({ readToken, baseUrl: 'https://logfire.internal.example.com' });
```

`baseUrl` wins over `region`, and `region` wins over the token. A base URL may include a path prefix for a proxy.

## Client options

```ts
const client = new LogfireQueryClient({
  readToken: 'pylf_v1_us_...',
  baseUrl: undefined,            // or region: 'us' | 'eu'
  timeout: 30_000,               // ms per attempt, null for none. 30 s is the Python client default.
  retry: { maxRetries: 2 },      // or false
  fetch: globalThis.fetch,       // bring your own, for example a proxy-aware fetch
  headers: { 'x-team': 'data' }, // sent with every request, cannot replace Authorization
  userAgent: 'my-app/1.0',       // default logfire-query-ts/<version>
  onUnknownRegion: (region) => {},
});
```

The token is sent as `Authorization: Bearer <token>`, as the docs describe.

## Errors

Every error derives from `LogfireQueryError`.

| Error | When |
| --- | --- |
| `QueryExecutionError` | 400, the query failed on the server, for example a bad column |
| `QueryRequestError` | 422, the request was invalid |
| `QueryRateLimitedError` | 429, after retries ran out or when the wait is too long |
| `UnexpectedResponseError` | any other status that is not 200, for example 404 or 5xx, and the base of `QueryRateLimitedError` |
| `LogfireApiError` | the base class of the four above |
| `QueryStreamError` | an `error` message in an NDJSON stream |
| `MalformedResponseError` | a 200 response that does not have the documented shape |
| `LogfireTimeoutError` | the request took longer than `timeout` |
| `LogfireConnectionError` | the server could not be reached |
| `InfoRequestError` | the read token info has no organization or project name |

The class names match the Python client. API errors carry `status`, `headers`, `body` (text), `detail`, `problem`, `problemType`, `retryable` and `retryAfter` (seconds).

For 400 and 422, `detail` is the legacy error body, the same value the Python client puts in `args[0]`, whether or not the server sent a problem detail.

```ts
import { QueryExecutionError, QueryRateLimitedError } from 'logfire-query';

try {
  await client.queryJsonRows('SELECT nope FROM records', { minTimestamp: twoHoursAgo });
} catch (error) {
  if (error instanceof QueryExecutionError) {
    console.error(error.detail); // { detail: [{ type: 'query_error', msg: 'column "nope" does not exist' }] }
  } else if (error instanceof QueryRateLimitedError) {
    console.error(`try again in ${error.retryAfter} s`);
  } else {
    throw error;
  }
}
```

An aborted call rejects with the signal's reason, an `AbortError` unless you passed your own.

## Retries

By default a failed request is tried up to 2 more times. A query only reads data, so sending the POST again is safe.

- 429 and every 5xx are retried, as are connection failures. Timeouts are not.
- The wait is the `Retry-After` header (seconds or an HTTP date), or else the `retry_after` of the problem detail.
- Without either, the client backs off exponentially: up to 0.5 seconds, then up to 1, doubling each time to at most 8, with random jitter between half and all of that.
- A problem detail with `"retryable": false` is not retried.
- If the server asks for a wait longer than `maxRetryAfterMs` (60 seconds by default), the error is thrown at once. That is what you get when the daily read token budget is used, and the error's `retryAfter` says when the budget is back.

```ts
new LogfireQueryClient({
  readToken,
  retry: {
    maxRetries: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    maxRetryAfterMs: 5 * 60_000,
    retryNetworkErrors: true,
    onRetry: ({ attempt, delayMs, error }) => console.warn(`retry ${attempt} in ${delayMs} ms`, error.message),
  },
});
```

See [Query limits](https://pydantic.dev/docs/logfire/reference/query-limits/) for how the running query and daily budget limits work.

## Reading new records only

Logfire's [query limits guide](https://pydantic.dev/docs/logfire/reference/query-limits/#read-only-new-data) describes a `created_at` cursor that reads each record exactly once. With this client:

```ts
let cursor = new Date('2026-11-01T00:00:00Z');

async function readNew() {
  const upper = new Date(Date.now() - 5 * 60_000);
  const { rows } = await client.queryJsonRows(
    `SELECT created_at, start_timestamp, service_name, span_name, message
     FROM records
     WHERE created_at > '${cursor.toISOString()}' AND created_at <= '${upper.toISOString()}'`,
    { minTimestamp: new Date(cursor.getTime() - 24 * 60 * 60_000), limit: 10_000 },
  );
  if (rows.length === 10_000) {
    throw new Error('range too large, split it in two and read again');
  }
  cursor = upper;
  return rows;
}
```

## Development

```bash
npm install
npm test           # tsc --strict over src and tests, then vitest
npm run test:dist  # builds dist/esm and dist/cjs, loads both, runs them with the real fetch against a local server
```

The test fixtures are the examples from the Query API docs and responses recorded against a real Logfire server, taken from the cassettes in the pydantic/logfire repository. The request body tests check that the JSON sent matches the bytes the Python client sent.

## License

MIT
