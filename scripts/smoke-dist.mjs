// Loads the built package through both entry points and runs it with the real fetch
// against a local HTTP server that answers with the documented response shapes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esm = await import('logfire-query');
const cjs = require('logfire-query');

assert.equal(typeof esm.LogfireQueryClient, 'function', 'ESM entry exports LogfireQueryClient');
assert.equal(typeof cjs.LogfireQueryClient, 'function', 'CJS entry exports LogfireQueryClient');
assert.equal(esm.VERSION, cjs.VERSION);

let attempts = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    assert.equal(req.headers.authorization, 'Bearer pylf_v1_us_smoke');
    if (req.url === '/v1/read-token-info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"organization_name":"acme","project_name":"web"}');
      return;
    }
    assert.equal(req.url, '/v2/query');
    assert.equal(JSON.parse(body).min_timestamp, '2020-01-01T00:00:00Z');
    const accept = req.headers.accept ?? '';
    if (accept.startsWith('application/x-ndjson')) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type": "schema", "schema": {"fields": [{"name": "service_name", "data_type": "Utf8", "nullable": false}]}}\n');
      setTimeout(() => {
        res.write('{"type": "data", "rows": [{"service_name": "backend"}, {"service_name": "frontend"}]}\n');
        res.end('{"type": "end", "row_count": 2}\n');
      }, 20);
      return;
    }
    if (accept.startsWith('text/csv')) {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'text/plain' });
        res.end('slow down');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end('service_name\nbackend\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"schema": {"fields": [{"name": "service_name", "data_type": "Utf8", "nullable": false}]}, "data": [{"service_name": "backend"}]}');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  for (const [label, mod] of [['esm', esm], ['cjs', cjs]]) {
    attempts = 0;
    const client = new mod.LogfireQueryClient({ readToken: 'pylf_v1_us_smoke', baseUrl });
    const options = { minTimestamp: '2020-01-01T00:00:00Z' };
    assert.deepEqual(await client.info(), { organization_name: 'acme', project_name: 'web' });
    assert.deepEqual(await client.queryJsonRows('SELECT service_name FROM records', options), {
      columns: [{ name: 'service_name', datatype: 'Utf8', nullable: false }],
      rows: [{ service_name: 'backend' }],
    });
    const rows = [];
    for await (const row of client.streamRows('SELECT service_name FROM records', options)) {
      rows.push(row.service_name);
    }
    assert.deepEqual(rows, ['backend', 'frontend']);
    assert.equal(await client.queryCsv('SELECT service_name FROM records', options), 'service_name\nbackend\n');
    assert.equal(attempts, 2, 'the 429 was retried once');
    console.log(`${label}: info, JSON rows, NDJSON stream and CSV with a retried 429 all passed over real fetch`);
  }
} finally {
  server.close();
}
