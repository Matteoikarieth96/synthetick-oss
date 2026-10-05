/**
 * Streaming CSV reader for FMP's whole-market bulk files (spec §15.2).
 *
 * These responses are large — ratios-ttm-bulk is 68 MB, 71k rows — and only
 * ~17k of those rows match our universe. Buffering the body into a string to
 * split on newlines costs a 68 MB spike per family for data we mostly discard,
 * so rows are parsed off the byte stream and handed to a callback that keeps
 * what it wants.
 *
 * The parser is a real CSV parser, not a line splitter: profile-bulk carries
 * company `description` text with commas, embedded newlines and escaped
 * quotes inside quoted fields, and splitting that on ',' or '\n' silently
 * shreds every row after the first paragraph break.
 */
import { log } from './log.js';

/** A parsed row, keyed by the header names of the file. */
export type CsvRow = Record<string, string>;

/** HTTP failure from a bulk fetch, carrying the status so the retry loop can
 * tell "try again" (429, 5xx) from "this will never work" (other 4xx). */
export class BulkHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'BulkHttpError';
  }
}

/**
 * Incremental RFC-4180 parser. Feed it chunks, get complete records back;
 * a record split across two chunks is held until its remainder arrives.
 */
class CsvParser {
  private field = '';
  private record: string[] = [];
  private inQuotes = false;
  /** True when the previous char was a quote inside a quoted field: the next
   * char decides whether it closed the field or escapes a literal quote (""). */
  private quotePending = false;

  /**
   * Feed one chunk; returns every record completed by it. Scans by index and
   * appends whole spans rather than single characters — at 68 MB a
   * character-at-a-time loop with per-char string concatenation is the
   * difference between seconds and minutes.
   */
  push(chunk: string): string[][] {
    const out: string[][] = [];
    const len = chunk.length;
    let i = 0;
    while (i < len) {
      if (this.quotePending) {
        this.quotePending = false;
        const ch = chunk[i];
        if (ch === '"') {
          this.field += '"'; // "" inside a quoted field is a literal quote
          i++;
          continue;
        }
        this.inQuotes = false;
        // not a quote: fall through and let the unquoted scanner read it
      }
      if (this.inQuotes) {
        // Copy up to the next quote in one slice.
        const q = chunk.indexOf('"', i);
        if (q === -1) {
          this.field += chunk.slice(i);
          break;
        }
        this.field += chunk.slice(i, q);
        this.quotePending = true;
        i = q + 1;
        continue;
      }
      // Unquoted: copy up to the next delimiter, terminator or quote.
      let j = i;
      while (j < len) {
        const c = chunk.charCodeAt(j);
        if (c === 44 /* , */ || c === 10 /* \n */ || c === 34 /* " */ || c === 13 /* \r */) break;
        j++;
      }
      if (j > i) this.field += chunk.slice(i, j);
      if (j >= len) break;
      const ch = chunk[j];
      i = j + 1;
      if (ch === '"') {
        this.inQuotes = true;
      } else if (ch === ',') {
        this.record.push(this.field);
        this.field = '';
      } else if (ch === '\n') {
        this.record.push(this.field);
        this.field = '';
        out.push(this.record);
        this.record = [];
      }
      // '\r' is dropped: consumed by i = j + 1 above.
    }
    return out;
  }

  /** Flush a final record with no trailing newline. */
  end(): string[][] {
    if (this.quotePending) this.inQuotes = false;
    if (this.field !== '' || this.record.length) {
      this.record.push(this.field);
      const last = this.record;
      this.record = [];
      this.field = '';
      return [last];
    }
    return [];
  }
}

export interface StreamCsvOpts {
  /** Label for logging. */
  label: string;
  /** Additional retries after the first attempt (default 2 — these are big). */
  retries?: number;
  /** Whole-download timeout (default 5 min: 68 MB on a slow link). */
  timeoutMs?: number;
}

/**
 * GET a CSV and invoke `onRow` per data row. Returns the number of rows seen.
 * `onRow` is deliberately synchronous: it runs 71k times, and awaiting a
 * promise per row would serialize the whole download behind the consumer.
 */
export async function streamCsv(
  url: string,
  onRow: (row: CsvRow) => void,
  opts: StreamCsvOpts,
): Promise<number> {
  const { label, retries = 2, timeoutMs = 300_000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await streamOnce(url, onRow, label, timeoutMs);
    } catch (err) {
      lastErr = err;
      // 4xx other than 429 will never succeed on retry. This is load-bearing
      // for paged families: asking for a part past the last one answers HTTP
      // 400, which is the end-of-pages signal, and retrying it four times
      // just burns half a minute before the same conclusion.
      if (err instanceof BulkHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      if (attempt === retries) break;
      const wait = 2000 * 2 ** attempt;
      log.warn(`${label} → ${(err as Error).message}, retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`streamCsv failed for ${label}: ${(lastErr as Error)?.message}`);
}

async function streamOnce(
  url: string,
  onRow: (row: CsvRow) => void,
  label: string,
  timeoutMs: number,
): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new BulkHttpError(res.status, `${label} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.body) throw new Error(`${label} → empty response body`);
  return parseCsvStream(res.body, onRow, label);
}

/**
 * Parse a byte stream of CSV, invoking `onRow` per data row; returns the row
 * count. Split out from the fetch so the gate can drive it from a file.
 */
export async function parseCsvStream(
  body: ReadableStream<Uint8Array>,
  onRow: (row: CsvRow) => void,
  label: string,
): Promise<number> {
  // A JSON error payload comes back with a 200 on some bulk endpoints (the
  // eod-bulk rate limit answers `{"Error Message": …}`), so sniff the opening
  // byte rather than trusting the status alone.
  const parser = new CsvParser();
  let header: string[] | null = null;
  let rows = 0;
  let sniffed = false;

  const decoder = new TextDecoder();
  const reader = body.getReader();
  const handle = (record: string[]) => {
    if (!header) {
      header = record.map((h) => h.trim());
      return;
    }
    // Ragged rows are vendor noise, not a parse failure — skip them.
    if (record.length !== header.length) return;
    const row: CsvRow = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = record[i]!;
    rows++;
    onRow(row);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (!sniffed) {
      sniffed = true;
      const head = text.trimStart();
      if (head.startsWith('{') || head.startsWith('[')) {
        void reader.cancel();
        throw new Error(`${label} → vendor returned JSON, not CSV: ${head.slice(0, 160)}`);
      }
    }
    for (const record of parser.push(text)) handle(record);
  }
  for (const record of parser.end()) handle(record);
  return rows;
}

/**
 * Parse a CSV cell (or an already-numeric JSON field) to a finite number, or
 * null. Blank cells must NOT become 0: `Number('')` is 0, which would turn
 * "this vendor has no P/E for this line" into a real-looking zero that then
 * wins a "lowest P/E" ranking.
 */
export function num(v: string | number | undefined | null): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Percent from a vendor fraction (0.21 → 21). Null stays null. */
export function pct(v: string | number | undefined | null): number | null {
  const n = num(v);
  return n == null ? null : n * 100;
}
