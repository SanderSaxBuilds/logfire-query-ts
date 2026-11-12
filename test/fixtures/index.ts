/**
 * Response fixtures.
 *
 * DOCS_* values are copied from the Query API guide:
 * https://pydantic.dev/docs/logfire/manage/query-api/
 *
 * RECORDED_* values are responses recorded against a real Logfire server, taken from the cassettes
 * in the pydantic/logfire repository (MIT), tests/cassettes/test_query_client/.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The documented `application/json` response: the `schema` example and the `data` example together. */
export const DOCS_JSON_RESPONSE = {
  schema: { fields: [{ name: 'service_name', data_type: 'Utf8', nullable: false }] },
  data: [{ service_name: 'backend' }],
};

/** The documented NDJSON `schema` message. */
export const DOCS_NDJSON_SCHEMA = '{"type": "schema", "schema": {"fields": [{"name": "service_name", "data_type": "Utf8", "nullable": false}]}}';
/** The documented NDJSON `data` message. */
export const DOCS_NDJSON_DATA = '{"type": "data", "rows": [{"service_name": "backend"}, {"service_name": "frontend"}]}';
/** The documented NDJSON `error` message. */
export const DOCS_NDJSON_ERROR = '{"type": "error", "message": "Invalid SQL: ..."}';
/** The documented NDJSON `end` message. */
export const DOCS_NDJSON_END = '{"type": "end", "row_count": 2}';

/** A full stream built from the documented messages, in the documented order. */
export const DOCS_NDJSON_STREAM = [DOCS_NDJSON_SCHEMA, DOCS_NDJSON_DATA, DOCS_NDJSON_END].join('\n') + '\n';

/** The documented `query_json_rows` output of the Python client for `SELECT start_timestamp FROM records LIMIT 1`. */
export const DOCS_PYTHON_ROWS_OUTPUT = {
  columns: [{ name: 'start_timestamp', datatype: { Timestamp: ['Microsecond', 'UTC'] }, nullable: false }],
  rows: [{ start_timestamp: '2026-05-27T13:16:36.517321Z' }],
};

/** The SQL of the recorded JSON, CSV and Arrow cassettes. */
export const RECORDED_SQL =
  '\n        SELECT kind, message, is_exception, tags\n        FROM records\n        ORDER BY is_exception, message\n        LIMIT 2\n        ';

/** The exact request body the Python client sent for RECORDED_SQL. */
export const RECORDED_REQUEST_BODY =
  '{"sql":"\\n        SELECT kind, message, is_exception, tags\\n        FROM records\\n        ORDER BY is_exception, message\\n        LIMIT 2\\n        ","explain":false,"include_schema":true,"min_timestamp":"2020-01-01T00:00:00+00:00"}';

/** The exact request body the Python client sent with every optional body parameter. */
export const RECORDED_BODY_PARAMS_REQUEST =
  '{"sql":"SELECT count(*) AS n FROM records","explain":false,"include_schema":true,"min_timestamp":"2020-01-01T00:00:00+00:00","max_timestamp":"2099-01-01T00:00:00+00:00","timezone":"UTC","deployment_environment":["production"]}';

/** The recorded response to RECORDED_BODY_PARAMS_REQUEST. */
export const RECORDED_BODY_PARAMS_RESPONSE = '{"schema":{"fields":[{"name":"n","data_type":"Int64","nullable":false}],"metadata":{}},"data":[{"n":0}]}';

/** The recorded `application/json` response to RECORDED_SQL, including a nested `List` data type. */
export const RECORDED_JSON_RESPONSE =
  '{"schema":{"fields":[{"name":"kind","data_type":"Utf8","nullable":false},{"name":"message","data_type":"Utf8","nullable":false},{"name":"is_exception","data_type":"Boolean","nullable":true},{"name":"tags","data_type":{"List":{"name":"item","data_type":"Utf8","nullable":true,"dict_id":0,"dict_is_ordered":false,"metadata":{}}},"nullable":true}],"metadata":{}},"data":[{"kind":"log","message":"about to raise an error","is_exception":false,"tags":[]},{"kind":"log","message":"aha 0","is_exception":false,"tags":["tag1","tag2"]}]}';

/** The recorded `text/csv` response to RECORDED_SQL. */
export const RECORDED_CSV_RESPONSE = 'kind,message,is_exception,tags\nlog,about to raise an error,false,[]\nlog,aha 0,false,"[""tag1"",""tag2""]"\n';

/** A recorded CSV response with no rows. */
export const RECORDED_EMPTY_CSV_RESPONSE = 'is_exception,count(*)\n';

/** The recorded `GET /v1/read-token-info` response. */
export const RECORDED_INFO_RESPONSE =
  '{"token_id":"d11b14d3-620f-42ce-8243-28188ac4b6c6","organization_id":"2d5a7ceb-641c-471c-b4bd-543331cd1e8b","organization_subscription_plan":"personal","project_id":"cb6682e7-60cf-45d8-96e3-59edde9a4920","organization_name":"viicos","project_name":"logfire-sdk-cassettes","expires_at":null,"spending_cap_reached_at":null,"billing_cycle_start":"2026-06-01T00:00:00Z","billing_cycle_end":"2026-07-01T00:00:00Z","organization_analytics_enabled":true,"owner_user_id":"e378ba5a-34aa-45b0-bb8d-7bea7eead615"}';

/** The recorded `application/vnd.apache.arrow.stream` response to RECORDED_SQL, 1544 bytes. */
export const RECORDED_ARROW_RESPONSE: Uint8Array<ArrayBuffer> = new Uint8Array(
  Buffer.from(readFileSync(join(here, 'arrow_stream.b64'), 'utf8').trim(), 'base64'),
);

/** SHA-256 of RECORDED_ARROW_RESPONSE. */
export const RECORDED_ARROW_SHA256 = '696430c5e3fdc6e044c778ac9aa0f225354e71d6371fbfba263643ee3005119f';

/** The legacy error body of a failed query, as used by the Python client's tests. */
export const LEGACY_ERROR = { detail: [{ type: 'query_error', msg: 'column "nope" does not exist' }] };

/** An RFC 9457 problem detail body for a failed query, as used by the Python client's tests. */
export function problemBody(status: number, problemType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: `https://logfire.pydantic.dev/-/errors/${problemType}`,
    title: 'Query failed',
    status,
    detail: 'column "nope" does not exist',
    error_details: LEGACY_ERROR,
    ...extra,
  };
}
