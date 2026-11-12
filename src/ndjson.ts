import { MalformedResponseError } from './errors.js';

/**
 * Reads newline-delimited JSON from a byte stream and yields one parsed value per line.
 *
 * Lines may end with `\n` or `\r\n`. Blank lines are skipped, and a last line without a newline is
 * still read. Multi-byte UTF-8 characters split across chunks are decoded correctly. When the
 * consumer stops early, the underlying stream is cancelled.
 */
export async function* readNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  let lineNumber = 0;
  let finished = false;

  const parse = (line: string): unknown => {
    lineNumber += 1;
    try {
      return JSON.parse(line) as unknown;
    } catch (cause) {
      const preview = line.length > 200 ? `${line.slice(0, 200)}...` : line;
      throw new MalformedResponseError(`Invalid JSON on NDJSON line ${lineNumber}: ${preview}`, { cause });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '') {
          yield parse(line);
        } else {
          lineNumber += 1;
        }
        newline = buffer.indexOf('\n');
      }
    }
    const last = buffer.replace(/\r$/, '');
    if (last.trim() !== '') {
      yield parse(last);
    }
    finished = true;
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
