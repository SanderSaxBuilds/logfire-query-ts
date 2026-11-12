import { MalformedResponseError } from './errors.js';
import type { ColumnDetails, ColumnQueryResults, QueryResponse, Row, RowQueryResults } from './types.js';

/** Arrow dictionary keys the Python client strips from data types. */
const DATA_TYPE_KEYS_TO_REMOVE = new Set(['dict_id', 'dict_is_ordered', 'metadata']);

/**
 * Renames every `data_type` key to `datatype` and drops Arrow dictionary keys, at any depth.
 * This is a port of `_transform_fields_for_backwards_compatibility` in the Python client.
 */
export function normalizeFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFields);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (DATA_TYPE_KEYS_TO_REMOVE.has(key)) {
        continue;
      }
      Object.defineProperty(out, key === 'data_type' ? 'datatype' : key, {
        value: normalizeFields(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks that a parsed `application/json` body has the documented `schema` and `data` entries. */
export function assertQueryResponse<R extends object>(value: unknown): QueryResponse<R> {
  if (!isRecord(value)) {
    throw new MalformedResponseError('Expected a JSON object with "schema" and "data"');
  }
  const schema = value['schema'];
  if (!isRecord(schema) || !Array.isArray(schema['fields'])) {
    throw new MalformedResponseError('Expected "schema.fields" to be a list in the query response');
  }
  const data = value['data'];
  if (!Array.isArray(data) || !data.every(isRecord)) {
    throw new MalformedResponseError('Expected "data" to be a list of row objects in the query response');
  }
  return value as unknown as QueryResponse<R>;
}

/** Maps a v2 JSON response to the Python client's row-oriented `{columns, rows}` shape. */
export function toRowResults<R extends object = Row>(response: QueryResponse<R>): RowQueryResults<R> {
  return {
    columns: normalizeFields(response.schema.fields) as ColumnDetails[],
    rows: response.data,
  };
}

/**
 * Pivots a v2 JSON response into column-oriented results. Each column carries its values in row order.
 * A value missing from a row is read as `null`.
 */
export function toColumnResults(response: QueryResponse<object>): ColumnQueryResults {
  const columns = normalizeFields(response.schema.fields) as ColumnDetails[];
  return {
    columns: columns.map((column) => ({
      ...column,
      values: response.data.map((row) => {
        const value = (row as Record<string, unknown>)[column.name];
        return value === undefined ? null : value;
      }),
    })),
  };
}
