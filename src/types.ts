/** A point in time: a `Date`, epoch milliseconds, or an ISO 8601 string. A string without an offset is read as UTC. */
export type Timestamp = Date | number | string;

/** Options for one query. Only `minTimestamp` is required, as in the API. */
export interface QueryOptions {
  /**
   * Lower bound on `start_timestamp` for the `records` table, or `recorded_timestamp` for `metrics`.
   * Required by the API.
   */
  minTimestamp: Timestamp;
  /** Upper bound on the same column as `minTimestamp`. */
  maxTimestamp?: Timestamp | undefined;
  /**
   * The maximum number of rows to return. It takes priority over a `LIMIT` clause in the SQL.
   * The server default is 100 and the maximum is 10,000.
   */
  limit?: number | undefined;
  /** The timezone for the query execution context, for example `Europe/Paris`. */
  timezone?: string | undefined;
  /**
   * Restrict rows to one or more deployment environments. A single string is sent as a one-item list.
   * Use the empty string to match rows where no environment is set.
   */
  environment?: string | readonly string[] | undefined;
  /** Ask the server to include the logical and physical query plans. */
  explain?: boolean | undefined;
  /** Cancels the request, including any retry wait. */
  signal?: AbortSignal | undefined;
  /** Overrides the client timeout for this call, in milliseconds. */
  timeout?: number | undefined;
}

/** The JSON body sent to `POST /v2/query`. */
export interface QueryRequestBody {
  sql: string;
  explain: boolean;
  include_schema: boolean;
  limit?: number;
  min_timestamp: string;
  max_timestamp?: string;
  timezone?: string;
  deployment_environment?: string[];
}

/** One column of the result schema as the API sends it. */
export interface SchemaField {
  name: string;
  /** The Arrow data type, for example `"Utf8"`, `{"Timestamp": ["Microsecond", "UTC"]}` or `{"List": {...}}`. */
  data_type: unknown;
  nullable: boolean;
  [key: string]: unknown;
}

/** The result schema as the API sends it. */
export interface ResultSchema {
  fields: SchemaField[];
  [key: string]: unknown;
}

/** A result row. Keys are column names. */
export type Row = Record<string, unknown>;

/** The `application/json` response of `POST /v2/query`, as documented. */
export interface QueryResponse<R extends object = Row> {
  schema: ResultSchema;
  data: R[];
  logical_plan?: unknown;
  physical_plan?: unknown;
  physical_plan_with_metrics?: unknown;
}

/** Column details in the row-oriented results, with the key names the Python client returns. */
export interface ColumnDetails {
  name: string;
  /** The column data type. Nested `data_type` keys are renamed to `datatype` and Arrow dictionary keys removed. */
  datatype: unknown;
  nullable: boolean;
}

/** Row-oriented results, the same shape as the Python client's `query_json_rows`. */
export interface RowQueryResults<R extends object = Row> {
  columns: ColumnDetails[];
  rows: R[];
}

/** One column with its values, in column-oriented results. */
export interface ColumnData extends ColumnDetails {
  values: unknown[];
}

/** Column-oriented results: one entry per column, each with every value of that column in row order. */
export interface ColumnQueryResults {
  columns: ColumnData[];
}

/** The read token details returned by `GET /v1/read-token-info`, reduced to the documented keys. */
export interface ReadTokenInfo {
  organization_name: string;
  project_name: string;
}

/** The response formats of the Query API, chosen with the `Accept` header. */
export type QueryFormat = 'json' | 'ndjson' | 'arrow' | 'csv';

/** The `Accept` media type of each response format. */
export const FORMAT_MEDIA_TYPES: Readonly<Record<QueryFormat, string>> = Object.freeze({
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  arrow: 'application/vnd.apache.arrow.stream',
  csv: 'text/csv',
});

/** NDJSON `schema` message, sent before any rows. */
export interface SchemaMessage {
  type: 'schema';
  schema: ResultSchema;
}

/** NDJSON `explain` message, sent only when `explain` is true. */
export interface ExplainMessage {
  type: 'explain';
  logical_plan: unknown;
  physical_plan: unknown;
}

/** NDJSON `data` message, one batch of rows. A query can send many. */
export interface DataMessage<R extends object = Row> {
  type: 'data';
  rows: R[];
}

/** NDJSON `error` message. The stream may end after it. */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** NDJSON `end` message, the last message of a successful stream. */
export interface EndMessage {
  type: 'end';
  row_count: number;
  physical_plan_with_metrics?: unknown;
}

/** Every documented NDJSON message. */
export type StreamMessage<R extends object = Row> =
  | SchemaMessage
  | ExplainMessage
  | DataMessage<R>
  | ErrorMessage
  | EndMessage;

/** Bytes returned for the Arrow and CSV formats, with the content type the server sent. */
export interface RawResult {
  bytes: Uint8Array;
  contentType: string | null;
}
