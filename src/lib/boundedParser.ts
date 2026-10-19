/**
 * Cancellable, memory-bounded parsing of large datasets (#1205).
 *
 * Parsing a big CSV or JSON Lines export with `file.text()` + `split()` loads
 * the whole file (and a second copy as lines) into memory, blocks the main
 * thread until it finishes, and cannot be stopped. This module reads the input
 * in fixed-size chunks and parses incrementally instead, so that:
 *
 *  - **Memory is bounded.** Input larger than `maxBytes` is rejected up front
 *    when its size is known, and while reading when it is not. A row count cap
 *    (`maxRows`) and a per-field cap (`maxFieldLength`) stop malformed input
 *    (for example one unterminated quote that would otherwise swallow the rest
 *    of the file into a single field) from growing without limit. With
 *    `retainRows: false` rows are handed to `onRow` and dropped, so memory
 *    stays flat however large the input is.
 *  - **Work is cancellable.** The `AbortSignal` is checked between every chunk
 *    and every yield; a pending stream read is cancelled on abort. A cancelled
 *    parse throws {@link ParseAbortedError} and keeps nothing.
 *  - **The UI stays responsive.** The parser yields to the event loop at least
 *    every `yieldEveryMs`, so rendering and input are not starved.
 *
 * Limitation: `JSON.parse` is a single synchronous call and cannot be
 * interrupted. {@link parseJsonBounded} therefore enforces the byte cap and
 * checks for cancellation before and after parsing, but a document already
 * inside `maxBytes` is parsed in one step. Prefer JSON Lines for datasets that
 * need to be streamed.
 */

export const MIB = 1024 * 1024;

export interface ParseLimits {
  /** Largest input accepted, in bytes. */
  maxBytes: number;
  /** Most data rows accepted (CSV header excluded). */
  maxRows: number;
  /** Longest single CSV field or JSON Lines line accepted, in characters. */
  maxFieldLength: number;
}

export const DEFAULT_PARSE_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxBytes: 25 * MIB,
  maxRows: 250_000,
  maxFieldLength: 1 * MIB,
});

export type ParseLimitKind = keyof ParseLimits;

/** Thrown when the input exceeds one of the configured limits. */
export class ParseLimitError extends Error {
  readonly code = "PARSE_LIMIT_EXCEEDED";
  readonly limit: ParseLimitKind;
  readonly max: number;
  readonly observed: number;

  constructor(limit: ParseLimitKind, max: number, observed: number) {
    super(ParseLimitError.describe(limit, max, observed));
    this.name = "ParseLimitError";
    this.limit = limit;
    this.max = max;
    this.observed = observed;
    Object.setPrototypeOf(this, ParseLimitError.prototype);
  }

  private static describe(limit: ParseLimitKind, max: number, observed: number): string {
    switch (limit) {
      case "maxBytes":
        return `The file is too large to import (${formatBytes(observed)}; the limit is ${formatBytes(max)}).`;
      case "maxRows":
        return `The file has more than ${max.toLocaleString("en-US")} rows, which is the import limit.`;
      default:
        return `A single value is longer than ${max.toLocaleString("en-US")} characters (limit); the file is probably malformed.`;
    }
  }
}

/** Thrown when the caller's `AbortSignal` fires before parsing finishes. */
export class ParseAbortedError extends Error {
  readonly code = "PARSE_ABORTED";

  constructor(message = "Parsing was cancelled.") {
    super(message);
    this.name = "ParseAbortedError";
    Object.setPrototypeOf(this, ParseAbortedError.prototype);
  }
}

/** Thrown for input that is not valid in the requested format. */
export class ParseFormatError extends Error {
  readonly code = "PARSE_INVALID_FORMAT";
  /** 1-based line (JSON Lines) or record (CSV) the problem was found on. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "ParseFormatError";
    this.line = line;
    Object.setPrototypeOf(this, ParseFormatError.prototype);
  }
}

export function isParseAbortedError(error: unknown): error is ParseAbortedError {
  return error instanceof ParseAbortedError;
}

export function isParseLimitError(error: unknown): error is ParseLimitError {
  return error instanceof ParseLimitError;
}

function formatBytes(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

// ── input sources ─────────────────────────────────────────────────────

export type ParseSource = string | Blob | ReadableStream<Uint8Array>;

export interface ParseProgress {
  bytesRead: number;
  /** Total size when known (strings and blobs), else null. */
  totalBytes: number | null;
  rows: number;
}

export interface ParseBaseOptions {
  signal?: AbortSignal;
  limits?: Partial<ParseLimits>;
  /** Bytes read per step. Default 64 KiB. */
  chunkBytes?: number;
  /** Yield to the event loop after this many ms of work. 0 = after every chunk. Default 12. */
  yieldEveryMs?: number;
  onProgress?: (_progress: ParseProgress) => void;
}

function resolveLimits(partial?: Partial<ParseLimits>): ParseLimits {
  const limits = { ...DEFAULT_PARSE_LIMITS, ...partial };
  for (const key of Object.keys(limits) as ParseLimitKind[]) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) {
      throw new RangeError(`Parse limit ${key} must be a positive number.`);
    }
  }
  return limits;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = (signal as { reason?: unknown }).reason;
    throw new ParseAbortedError(
      typeof reason === "string" && reason ? reason : "Parsing was cancelled.",
    );
  }
}

/** Lets rendering and input run between chunks. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function readBlobSlice(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsArrayBuffer(blob);
  });
}

interface Chunk {
  /** Decoded text of this chunk (may end mid-line). */
  text: string;
  /** Bytes consumed from the source so far. */
  bytesRead: number;
  /** Total size of the source when known, else null. */
  totalBytes: number | null;
}

/**
 * Yields the input as decoded text chunks, enforcing `maxBytes` and observing
 * cancellation. Multi-byte characters split across chunks are decoded
 * correctly (streaming decoder).
 */
async function* readChunks(
  source: ParseSource,
  options: { chunkBytes: number; maxBytes: number; signal?: AbortSignal },
): AsyncGenerator<Chunk, void, void> {
  const { chunkBytes, maxBytes, signal } = options;
  const decoder = new TextDecoder("utf-8");
  let bytesRead = 0;

  throwIfAborted(signal);

  if (typeof source === "string") {
    const bytes = new TextEncoder().encode(source);
    if (bytes.length > maxBytes) throw new ParseLimitError("maxBytes", maxBytes, bytes.length);
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      throwIfAborted(signal);
      const slice = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
      bytesRead += slice.length;
      yield {
        text: decoder.decode(slice, { stream: true }),
        bytesRead,
        totalBytes: bytes.length,
      };
    }
    const tail = decoder.decode();
    if (tail) yield { text: tail, bytesRead, totalBytes: bytes.length };
    return;
  }

  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        bytesRead += value.length;
        if (bytesRead > maxBytes) throw new ParseLimitError("maxBytes", maxBytes, bytesRead);
        yield { text: decoder.decode(value, { stream: true }), bytesRead, totalBytes: null };
      }
      const tail = decoder.decode();
      if (tail) yield { text: tail, bytesRead, totalBytes: null };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => undefined);
    }
    return;
  }

  const blob = source as Blob;
  if (blob.size > maxBytes) throw new ParseLimitError("maxBytes", maxBytes, blob.size);
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    throwIfAborted(signal);
    const bytes = await readBlobSlice(blob.slice(offset, Math.min(offset + chunkBytes, blob.size)));
    throwIfAborted(signal);
    bytesRead += bytes.length;
    yield { text: decoder.decode(bytes, { stream: true }), bytesRead, totalBytes: blob.size };
  }
  const tail = decoder.decode();
  if (tail) yield { text: tail, bytesRead, totalBytes: blob.size };
}

/**
 * Drives `consume` with each chunk, yielding to the event loop on a schedule
 * and reporting progress. All parsers share this loop.
 */
async function pump(
  source: ParseSource,
  options: ParseBaseOptions,
  limits: ParseLimits,
  consume: (_text: string) => void,
  currentRows: () => number,
): Promise<number> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? 64 * 1024);
  const yieldEveryMs = options.yieldEveryMs ?? 12;
  let bytesRead = 0;
  let sliceStart = now();

  for await (const chunk of readChunks(source, {
    chunkBytes,
    maxBytes: limits.maxBytes,
    signal: options.signal,
  })) {
    bytesRead = chunk.bytesRead;
    consume(chunk.text);
    options.onProgress?.({ bytesRead, totalBytes: chunk.totalBytes, rows: currentRows() });
    if (now() - sliceStart >= yieldEveryMs) {
      await yieldToEventLoop();
      throwIfAborted(options.signal);
      sliceStart = now();
    }
  }
  return bytesRead;
}

// ── CSV ───────────────────────────────────────────────────────────────

export interface CsvParseOptions extends ParseBaseOptions {
  /** Treat the first record as column names. Default true. */
  header?: boolean;
  /** Called for every data row. Combine with `retainRows: false` to stream. */
  onRow?: (_row: string[], _index: number) => void;
  /** Keep rows in the result. Default true. Set false when using `onRow`. */
  retainRows?: boolean;
}

export interface CsvParseResult {
  header: string[] | null;
  rows: string[][];
  rowCount: number;
  bytesRead: number;
}

/**
 * Incremental RFC 4180 CSV parser. Feed it text with {@link push}; state
 * (open quote, pending `""`, pending `\r`) carries across chunks.
 */
class CsvStream {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  /** A `"` was seen inside quotes; the next char decides escape vs close. */
  private quotePending = false;
  private crPending = false;
  private rowHasContent = false;
  private atStart = true;
  record = 0;

  private readonly maxFieldLength: number;
  private readonly emit: (_row: string[], _record: number) => void;

  constructor(maxFieldLength: number, emit: (_row: string[], _record: number) => void) {
    this.maxFieldLength = maxFieldLength;
    this.emit = emit;
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = "";
  }

  private endRecord(): void {
    if (this.rowHasContent || this.row.length > 0) {
      this.endField();
      this.record += 1;
      this.emit(this.row, this.record);
    }
    this.row = [];
    this.field = "";
    this.rowHasContent = false;
  }

  private append(ch: string): void {
    this.field += ch;
    this.rowHasContent = true;
    if (this.field.length > this.maxFieldLength) {
      throw new ParseLimitError("maxFieldLength", this.maxFieldLength, this.field.length);
    }
  }

  push(text: string): void {
    let chunk = text;
    if (this.atStart && chunk.length > 0) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); // BOM
      this.atStart = chunk.length === 0;
    }
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk.charAt(i);

      if (this.crPending) {
        this.crPending = false;
        this.endRecord();
        if (ch === "\n") continue;
      }
      if (this.quotePending) {
        this.quotePending = false;
        if (ch === '"') {
          this.append('"'); // "" inside quotes
          continue;
        }
        this.inQuotes = false; // the quote closed the field; fall through
      }

      if (this.inQuotes) {
        if (ch === '"') this.quotePending = true;
        else this.append(ch);
        continue;
      }
      if (ch === '"') {
        this.inQuotes = true;
        this.rowHasContent = true;
      } else if (ch === ",") {
        this.endField();
        this.rowHasContent = true;
      } else if (ch === "\r") {
        this.crPending = true;
      } else if (ch === "\n") {
        this.endRecord();
      } else {
        this.append(ch);
      }
    }
  }

  /** Flushes the final record and rejects input that ends inside quotes. */
  finish(): void {
    if (this.crPending) {
      this.crPending = false;
      this.endRecord();
    }
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) {
      throw new ParseFormatError(
        "The CSV ends inside a quoted value; the file looks truncated.",
        this.record + 1,
      );
    }
    this.endRecord();
  }
}

/**
 * Parses CSV incrementally with cancellation and memory limits.
 *
 * Resolves with the header, the rows (unless `retainRows` is false) and the
 * count. Rejects with {@link ParseAbortedError}, {@link ParseLimitError} or
 * {@link ParseFormatError}; in every failure case nothing is retained.
 */
export async function parseCsvBounded(
  source: ParseSource,
  options: CsvParseOptions = {},
): Promise<CsvParseResult> {
  const limits = resolveLimits(options.limits);
  const wantHeader = options.header ?? true;
  const retain = options.retainRows ?? true;
  let header: string[] | null = null;
  let rows: string[][] = [];
  let rowCount = 0;

  const csv = new CsvStream(limits.maxFieldLength, (row, record) => {
    if (wantHeader && record === 1) {
      header = row;
      return;
    }
    if (rowCount >= limits.maxRows) {
      throw new ParseLimitError("maxRows", limits.maxRows, rowCount + 1);
    }
    options.onRow?.(row, rowCount);
    if (retain) rows.push(row);
    rowCount += 1;
  });

  try {
    const bytesRead = await pump(source, options, limits, (text) => csv.push(text), () => rowCount);
    csv.finish();
    return { header, rows, rowCount, bytesRead };
  } catch (error) {
    rows = []; // drop partial results
    throw error;
  }
}

// ── JSON Lines ────────────────────────────────────────────────────────

export interface JsonLinesParseOptions extends ParseBaseOptions {
  onRow?: (_value: unknown, _index: number) => void;
  retainRows?: boolean;
  /** What to do with a line that is not valid JSON. Default "throw". */
  onInvalidLine?: "throw" | "skip";
}

export interface JsonLinesParseResult {
  rows: unknown[];
  rowCount: number;
  skipped: number;
  bytesRead: number;
}

/** Parses JSON Lines (one JSON value per line) incrementally. */
export async function parseJsonLinesBounded(
  source: ParseSource,
  options: JsonLinesParseOptions = {},
): Promise<JsonLinesParseResult> {
  const limits = resolveLimits(options.limits);
  const retain = options.retainRows ?? true;
  const strict = (options.onInvalidLine ?? "throw") === "throw";
  let rows: unknown[] = [];
  let rowCount = 0;
  let skipped = 0;
  let lineNumber = 0;
  let carry = "";
  let atStart = true;

  const handleLine = (line: string) => {
    lineNumber += 1;
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      if (strict) throw new ParseFormatError(`Line ${lineNumber} is not valid JSON.`, lineNumber);
      skipped += 1;
      return;
    }
    if (rowCount >= limits.maxRows) {
      throw new ParseLimitError("maxRows", limits.maxRows, rowCount + 1);
    }
    options.onRow?.(value, rowCount);
    if (retain) rows.push(value);
    rowCount += 1;
  };

  const consume = (text: string) => {
    let data = text;
    if (atStart && data.length > 0) {
      if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
      atStart = data.length === 0;
    }
    let start = 0;
    for (;;) {
      const newline = data.indexOf("\n", start);
      if (newline === -1) break;
      handleLine(carry + data.slice(start, newline));
      carry = "";
      start = newline + 1;
    }
    carry += data.slice(start);
    if (carry.length > limits.maxFieldLength) {
      throw new ParseLimitError("maxFieldLength", limits.maxFieldLength, carry.length);
    }
  };

  try {
    const bytesRead = await pump(source, options, limits, consume, () => rowCount);
    if (carry) handleLine(carry); // last line without a trailing newline
    return { rows, rowCount, skipped, bytesRead };
  } catch (error) {
    rows = [];
    throw error;
  }
}

// ── whole-document JSON ───────────────────────────────────────────────

export type JsonBoundedOptions = ParseBaseOptions;

/**
 * Reads a JSON document within the byte limit, then parses it. The read is
 * chunked and cancellable; the final `JSON.parse` is one synchronous step (see
 * the note at the top of this file). A top-level array is also held to
 * `maxRows`.
 */
export async function parseJsonBounded(
  source: ParseSource,
  options: JsonBoundedOptions = {},
): Promise<unknown> {
  const limits = resolveLimits(options.limits);
  const parts: string[] = [];
  await pump(source, options, limits, (text) => parts.push(text), () => 0);
  throwIfAborted(options.signal);

  const text = parts.join("");
  parts.length = 0;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ParseFormatError(
      `The file is not valid JSON (${error instanceof Error ? error.message : "parse error"}).`,
      1,
    );
  }
  throwIfAborted(options.signal);
  if (Array.isArray(value) && value.length > limits.maxRows) {
    throw new ParseLimitError("maxRows", limits.maxRows, value.length);
  }
  return value;
}

/** Reads a whole text input within `maxBytes`, chunked and cancellable. */
export async function readTextBounded(
  source: ParseSource,
  options: ParseBaseOptions = {},
): Promise<string> {
  const limits = resolveLimits(options.limits);
  const parts: string[] = [];
  await pump(source, options, limits, (text) => parts.push(text), () => 0);
  throwIfAborted(options.signal);
  return parts.join("");
}
