/**
 * Export integrity checks (#1203).
 *
 * A download that silently ends early (an interrupted page fetch, a
 * serializer that threw halfway, a blob that did not hold everything) looks
 * like a normal file but is missing data, and the user only finds out later.
 * These checks run on the payload *before* the browser is asked to download
 * it, so a partial or truncated export is refused with a specific reason
 * instead of being saved.
 *
 * Three independent signals are combined:
 *  - a manifest of what the export was *meant* to contain (byte length,
 *    CRC-32 and row count, taken from the intended payload);
 *  - format structure (an unterminated CSV quote, a JSON document that ends
 *    mid-value, a Parquet file without its trailing magic, a PDF without
 *    `%%EOF`);
 *  - completeness against a total the caller knows about (e.g. the API said
 *    there were 500 rows but only 200 were fetched).
 *
 * The CRC-32 is for detecting accidental corruption and truncation only. It
 * is not a security control and must not be used to authenticate files.
 */

export type ExportDataFormat = "csv" | "json" | "parquet" | "pdf" | "text";

export type IntegrityIssueCode =
  | "EMPTY_PAYLOAD"
  | "SIZE_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "ROW_COUNT_MISMATCH"
  | "PARTIAL_DATASET"
  | "UNTERMINATED_CSV_QUOTE"
  | "RAGGED_CSV_ROW"
  | "TRUNCATED_JSON"
  | "MISSING_PARQUET_MAGIC"
  | "MISSING_PDF_TRAILER";

export interface IntegrityIssue {
  code: IntegrityIssueCode;
  message: string;
}

/** What an export is supposed to contain, computed from the intended payload. */
export interface ExportManifest {
  format: ExportDataFormat;
  /** UTF-8 byte length of the payload. */
  byteLength: number;
  /** CRC-32 of the payload bytes, lowercase hex, 8 digits. */
  checksum: string;
  /** Data rows (excluding any header), or null when the format has no rows. */
  rowCount: number | null;
}

export interface IntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
  /** What was actually found in the payload that was checked. */
  actual: {
    byteLength: number;
    checksum: string;
    rowCount: number | null;
  };
}

export class ExportIntegrityError extends Error {
  readonly issues: IntegrityIssue[];
  readonly report: IntegrityReport;

  constructor(report: IntegrityReport) {
    const first = report.issues[0];
    super(
      `Export aborted, the file is incomplete or corrupt: ${first ? first.message : "unknown problem"}` +
        (report.issues.length > 1 ? ` (+${report.issues.length - 1} more)` : ""),
    );
    this.name = "ExportIntegrityError";
    this.issues = report.issues;
    this.report = report;
  }
}

// ── CRC-32 ────────────────────────────────────────────────────────────

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 (IEEE 802.3) of `bytes`, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (table[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toHex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

// ── structure checks ──────────────────────────────────────────────────

/**
 * Walks a CSV document once, honouring quoted fields (including embedded
 * commas, newlines and doubled quotes).
 *
 * Returns the number of records (header included), whether a quoted field was
 * left open, and the field count of every record.
 */
export function scanCsv(text: string): {
  records: number;
  unterminatedQuote: boolean;
  columnCounts: number[];
  /** Record terminators seen outside quotes. */
  terminators: number;
  endedOnTerminator: boolean;
} {
  const columnCounts: number[] = [];
  let terminators = 0;
  let endedOnTerminator = false;
  let inQuotes = false;
  let fields = 0;
  let fieldHasContent = false;
  let recordHasContent = false;

  const endField = () => {
    fields += 1;
    fieldHasContent = false;
  };
  const endRecord = () => {
    if (recordHasContent || fields > 0) {
      if (fieldHasContent || recordHasContent) endField();
      columnCounts.push(fields);
    }
    fields = 0;
    fieldHasContent = false;
    recordHasContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    endedOnTerminator = false;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 1; // escaped quote
        } else {
          inQuotes = false;
        }
      }
      fieldHasContent = true;
      recordHasContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      fieldHasContent = true;
      recordHasContent = true;
    } else if (ch === ",") {
      endField();
      recordHasContent = true;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      terminators += 1;
      endedOnTerminator = true;
      endRecord();
    } else if (ch === "\n") {
      terminators += 1;
      endedOnTerminator = true;
      endRecord();
    } else {
      fieldHasContent = true;
      recordHasContent = true;
    }
  }
  if (recordHasContent || fields > 0) endRecord();

  return {
    records: columnCounts.length,
    unterminatedQuote: inQuotes,
    columnCounts,
    terminators,
    endedOnTerminator,
  };
}

function checkCsv(text: string, issues: IntegrityIssue[]): number | null {
  if (text.length === 0) return 0;
  const scan = scanCsv(text);
  if (scan.unterminatedQuote) {
    issues.push({
      code: "UNTERMINATED_CSV_QUOTE",
      message: "The CSV ends inside a quoted field, so it was cut off mid-record.",
    });
  }
  const headerColumns = scan.columnCounts[0];
  const ragged = scan.columnCounts.findIndex((n, i) => i > 0 && n !== headerColumns);
  if (ragged > 0) {
    issues.push({
      code: "RAGGED_CSV_ROW",
      message: `Row ${ragged} has ${scan.columnCounts[ragged]} columns but the header has ${headerColumns}; the file looks truncated.`,
    });
  }
  // In a one-column CSV an empty value is an empty line, which is a record
  // (not whitespace), so count lines instead of non-empty records.
  const records =
    headerColumns === 1
      ? scan.terminators + (scan.endedOnTerminator ? 0 : 1)
      : scan.records;
  return Math.max(0, records - 1);
}

function checkJson(text: string, issues: IntegrityIssue[]): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch (err) {
    issues.push({
      code: "TRUNCATED_JSON",
      message: `The JSON document is not complete (${err instanceof Error ? err.message : "parse error"}).`,
    });
    return null;
  }
}

const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31]; // "PAR1"

function checkParquet(bytes: Uint8Array, issues: IntegrityIssue[]): void {
  const hasHead =
    bytes.length >= 8 && PARQUET_MAGIC.every((b, i) => bytes[i] === b);
  const hasTail =
    bytes.length >= 8 &&
    PARQUET_MAGIC.every((b, i) => bytes[bytes.length - 4 + i] === b);
  if (!hasHead || !hasTail) {
    issues.push({
      code: "MISSING_PARQUET_MAGIC",
      message: hasHead
        ? "The Parquet file is missing its closing 'PAR1' footer, so it was cut off."
        : "The data is not a Parquet file (missing the leading 'PAR1' marker).",
    });
  }
}

function checkPdf(text: string, issues: IntegrityIssue[]): void {
  const trimmed = text.trimEnd();
  if (!text.startsWith("%PDF-") || !trimmed.endsWith("%%EOF")) {
    issues.push({
      code: "MISSING_PDF_TRAILER",
      message: "The PDF is missing its '%%EOF' trailer, so it was cut off.",
    });
  }
}

// ── public API ────────────────────────────────────────────────────────

/**
 * Computes the manifest of an *intended* payload. Call it on the data you
 * meant to export, then verify what actually got produced against it.
 *
 * @param rowCount - Rows the export should hold; pass null for formats
 *   without rows. Defaults to counting rows in the payload itself.
 */
export function createManifest(
  data: string | Uint8Array,
  format: ExportDataFormat,
  rowCount?: number | null,
): ExportManifest {
  const bytes = toBytes(data);
  let rows: number | null;
  if (rowCount !== undefined) {
    rows = rowCount;
  } else if (format === "csv" && typeof data === "string") {
    rows = checkCsv(data, []);
  } else if (format === "json" && typeof data === "string") {
    rows = checkJson(data, []);
  } else {
    rows = null;
  }
  return {
    format,
    byteLength: bytes.length,
    checksum: toHex(crc32(bytes)),
    rowCount: rows,
  };
}

/**
 * Verifies a payload against the manifest of what it was supposed to be.
 * Never throws; inspect `report.ok` / `report.issues`.
 */
export function verifyExport(
  data: string | Uint8Array,
  manifest: ExportManifest,
): IntegrityReport {
  const bytes = toBytes(data);
  const issues: IntegrityIssue[] = [];
  const checksum = toHex(crc32(bytes));

  if (bytes.length === 0 && manifest.byteLength > 0) {
    issues.push({
      code: "EMPTY_PAYLOAD",
      message: `The export is empty but ${manifest.byteLength} bytes were expected.`,
    });
  } else if (bytes.length !== manifest.byteLength) {
    const shortBy = manifest.byteLength - bytes.length;
    issues.push({
      code: "SIZE_MISMATCH",
      message:
        shortBy > 0
          ? `The export is ${shortBy} bytes shorter than expected (${bytes.length} of ${manifest.byteLength}).`
          : `The export is ${-shortBy} bytes longer than expected (${bytes.length} of ${manifest.byteLength}).`,
    });
  }
  if (bytes.length === manifest.byteLength && checksum !== manifest.checksum) {
    issues.push({
      code: "CHECKSUM_MISMATCH",
      message: `The export content differs from what was generated (checksum ${checksum}, expected ${manifest.checksum}).`,
    });
  }

  let rowCount: number | null = null;
  const text = typeof data === "string" ? data : new TextDecoder().decode(bytes);
  if (bytes.length > 0 || manifest.byteLength > 0) {
    switch (manifest.format) {
      case "csv":
        rowCount = checkCsv(text, issues);
        break;
      case "json":
        rowCount = checkJson(text, issues);
        break;
      case "parquet":
        checkParquet(bytes, issues);
        break;
      case "pdf":
        checkPdf(text, issues);
        break;
      default:
        break;
    }
  } else if (manifest.format === "csv") {
    rowCount = 0;
  }

  if (
    manifest.rowCount !== null &&
    rowCount !== null &&
    rowCount !== manifest.rowCount
  ) {
    issues.push({
      code: "ROW_COUNT_MISMATCH",
      message: `The export holds ${rowCount} rows but ${manifest.rowCount} were expected.`,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    actual: { byteLength: bytes.length, checksum, rowCount },
  };
}

/** Like {@link verifyExport} but throws {@link ExportIntegrityError} on any problem. */
export function assertExportIntact(
  data: string | Uint8Array,
  manifest: ExportManifest,
): IntegrityReport {
  const report = verifyExport(data, manifest);
  if (!report.ok) throw new ExportIntegrityError(report);
  return report;
}

/**
 * Completeness against a total the caller knows about. Use it when rows come
 * from a paged source: fewer rows than the source reported means a page
 * failed or the fetch stopped early.
 */
export function checkDatasetComplete(
  exportedRows: number,
  expectedTotal: number | null | undefined,
): IntegrityIssue | null {
  if (expectedTotal === null || expectedTotal === undefined) return null;
  if (exportedRows >= expectedTotal) return null;
  return {
    code: "PARTIAL_DATASET",
    message: `Only ${exportedRows} of ${expectedTotal} rows were loaded; exporting now would produce a partial file.`,
  };
}

/** Throws {@link ExportIntegrityError} when the dataset is smaller than its expected total. */
export function assertDatasetComplete(
  exportedRows: number,
  expectedTotal: number | null | undefined,
): void {
  const issue = checkDatasetComplete(exportedRows, expectedTotal);
  if (!issue) return;
  throw new ExportIntegrityError({
    ok: false,
    issues: [issue],
    actual: { byteLength: 0, checksum: toHex(crc32(new Uint8Array(0))), rowCount: exportedRows },
  });
}

/**
 * Reads a blob back and verifies it. Use right before handing a blob to the
 * browser, for payloads where the blob is what actually gets saved. Resolves
 * with the report; rejects with {@link ExportIntegrityError} when it fails.
 */
export async function assertBlobIntact(
  blob: Blob,
  manifest: ExportManifest,
): Promise<IntegrityReport> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return assertExportIntact(bytes, manifest);
}
