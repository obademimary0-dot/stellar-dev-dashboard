import { describe, expect, it } from "vitest";
import {
  ExportIntegrityError,
  assertBlobIntact,
  assertDatasetComplete,
  assertExportIntact,
  checkDatasetComplete,
  createManifest,
  crc32,
  scanCsv,
  verifyExport,
} from "../exportIntegrity";

const enc = (s: string) => new TextEncoder().encode(s);

function csvOf(rows: Array<Record<string, unknown>>): string {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}

const ROWS = [
  { id: "1", memo: "hello", fee: 100 },
  { id: "2", memo: 'say "hi", ok', fee: 200 },
  { id: "3", memo: "line1\nline2", fee: 300 },
];

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("scanCsv", () => {
  it("counts records and columns through quoted commas, quotes and newlines", () => {
    const scan = scanCsv(csvOf(ROWS));
    expect(scan.records).toBe(4);
    expect(scan.columnCounts).toEqual([3, 3, 3, 3]);
    expect(scan.unterminatedQuote).toBe(false);
  });

  it("handles empty fields, trailing commas and blank lines", () => {
    expect(scanCsv("a,b,c\n1,,3\n,,\n\n").columnCounts).toEqual([3, 3, 3]);
    expect(scanCsv("a,b\r\n1,2,\r\n").columnCounts).toEqual([2, 3]);
  });

  it("flags a quote left open", () => {
    expect(scanCsv('a,b\n1,"never closed').unterminatedQuote).toBe(true);
  });
});

describe("verifyExport: CSV", () => {
  it("accepts an intact export, including quoted commas and newlines", () => {
    const text = csvOf(ROWS);
    const report = verifyExport(text, createManifest(text, "csv", ROWS.length));
    expect(report.ok).toBe(true);
    expect(report.actual.rowCount).toBe(3);
  });

  it("accepts an empty export when none was expected", () => {
    expect(verifyExport("", createManifest("", "csv", 0)).ok).toBe(true);
  });

  it("accepts a one-column CSV whose cells are empty", () => {
    const text = "memo\r\n\r\n\r\nabc";
    const report = verifyExport(text, createManifest(text, "csv", 3));
    expect(report.ok).toBe(true);
    expect(report.actual.rowCount).toBe(3);
  });

  it("detects a file cut off after a whole row (size, checksum and row count)", () => {
    const full = csvOf(ROWS);
    const cut = full.slice(0, full.lastIndexOf("\r\n"));
    const report = verifyExport(cut, createManifest(full, "csv", ROWS.length));
    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("SIZE_MISMATCH");
    expect(codes).toContain("ROW_COUNT_MISMATCH");
  });

  it("detects a file cut off in the middle of a row", () => {
    const full = csvOf(ROWS);
    const cut = full.slice(0, full.length - 6);
    const report = verifyExport(cut, createManifest(full, "csv", ROWS.length));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("SIZE_MISMATCH");
  });

  it("detects a ragged final row even when no manifest size is available", () => {
    const text = "a,b,c\r\n1,2,3\r\n4,5";
    const report = verifyExport(text, { format: "csv", byteLength: enc(text).length, checksum: createManifest(text, "csv").checksum, rowCount: null });
    expect(report.issues.map((i) => i.code)).toEqual(["RAGGED_CSV_ROW"]);
    expect(report.issues[0].message).toMatch(/Row 2 has 2 columns/);
  });

  it("detects a cut inside a quoted field", () => {
    const text = 'a,b\r\n1,"unfinished';
    const manifest = createManifest(text, "csv");
    const report = verifyExport(text, manifest);
    expect(report.issues.map((i) => i.code)).toContain("UNTERMINATED_CSV_QUOTE");
  });

  it("detects same-length corruption through the checksum", () => {
    const full = csvOf(ROWS);
    const corrupted = full.replace("hello", "jello");
    const report = verifyExport(corrupted, createManifest(full, "csv", ROWS.length));
    expect(report.issues.map((i) => i.code)).toEqual(["CHECKSUM_MISMATCH"]);
  });

  it("reports an empty payload when data was expected", () => {
    const report = verifyExport("", createManifest(csvOf(ROWS), "csv", 3));
    expect(report.issues[0].code).toBe("EMPTY_PAYLOAD");
  });

  it("counts bytes, not characters, for multi-byte text", () => {
    const text = csvOf([{ name: "naïve — ünïcödé ✓" }]);
    const manifest = createManifest(text, "csv", 1);
    expect(manifest.byteLength).toBeGreaterThan(text.length);
    expect(verifyExport(text, manifest).ok).toBe(true);
  });
});

describe("verifyExport: JSON", () => {
  it("accepts an intact array and an intact object", () => {
    const arr = JSON.stringify(ROWS, null, 2);
    expect(verifyExport(arr, createManifest(arr, "json", 3)).ok).toBe(true);
    const obj = JSON.stringify({ version: 1 });
    expect(verifyExport(obj, createManifest(obj, "json")).ok).toBe(true);
  });

  it("detects a document that stops mid-value", () => {
    const full = JSON.stringify(ROWS, null, 2);
    const cut = full.slice(0, Math.floor(full.length * 0.6));
    const report = verifyExport(cut, createManifest(full, "json", 3));
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain("TRUNCATED_JSON");
    expect(codes).toContain("SIZE_MISMATCH");
  });

  it("detects a missing closing bracket", () => {
    const text = '[{"id":1},{"id":2}';
    const report = verifyExport(text, createManifest(text, "json"));
    expect(report.issues.map((i) => i.code)).toEqual(["TRUNCATED_JSON"]);
  });

  it("detects an array with fewer rows than expected", () => {
    const text = JSON.stringify(ROWS.slice(0, 2));
    const manifest = { ...createManifest(text, "json"), rowCount: 3 };
    expect(verifyExport(text, manifest).issues.map((i) => i.code)).toEqual(["ROW_COUNT_MISMATCH"]);
  });
});

describe("verifyExport: binary formats", () => {
  const parquet = (body: number[]) => new Uint8Array([0x50, 0x41, 0x52, 0x31, ...body, 0x50, 0x41, 0x52, 0x31]);

  it("accepts a Parquet file with both PAR1 markers", () => {
    const bytes = parquet([1, 2, 3, 4]);
    expect(verifyExport(bytes, createManifest(bytes, "parquet")).ok).toBe(true);
  });

  it("detects a Parquet file cut before its footer", () => {
    const full = parquet([1, 2, 3, 4, 5, 6, 7, 8]);
    const cut = full.slice(0, full.length - 6);
    const report = verifyExport(cut, createManifest(full, "parquet"));
    expect(report.issues.map((i) => i.code)).toContain("MISSING_PARQUET_MAGIC");
    expect(report.issues.map((i) => i.code)).toContain("SIZE_MISMATCH");
  });

  it("rejects bytes that are not Parquet at all", () => {
    const bytes = enc("not a parquet file at all");
    expect(verifyExport(bytes, createManifest(bytes, "parquet")).issues[0].code).toBe("MISSING_PARQUET_MAGIC");
  });

  it("accepts a PDF with its trailer and detects one without", () => {
    const pdf = "%PDF-1.1\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n";
    expect(verifyExport(pdf, createManifest(pdf, "pdf")).ok).toBe(true);
    const cut = pdf.slice(0, pdf.length - 8);
    expect(verifyExport(cut, createManifest(cut, "pdf")).issues[0].code).toBe("MISSING_PDF_TRAILER");
  });
});

describe("assertExportIntact / ExportIntegrityError", () => {
  it("returns the report when intact", () => {
    const text = csvOf(ROWS);
    expect(assertExportIntact(text, createManifest(text, "csv", 3)).ok).toBe(true);
  });

  it("throws an error that names the problem and carries every issue", () => {
    const full = csvOf(ROWS);
    const cut = full.slice(0, 20);
    let thrown: unknown;
    try {
      assertExportIntact(cut, createManifest(full, "csv", 3));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExportIntegrityError);
    const error = thrown as ExportIntegrityError;
    expect(error.message).toMatch(/Export aborted/);
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.report.ok).toBe(false);
  });
});

describe("dataset completeness", () => {
  it("is fine when the loaded rows reach the expected total or the total is unknown", () => {
    expect(checkDatasetComplete(100, 100)).toBeNull();
    expect(checkDatasetComplete(120, 100)).toBeNull();
    expect(checkDatasetComplete(5, undefined)).toBeNull();
    expect(checkDatasetComplete(0, null)).toBeNull();
  });

  it("flags a partial dataset", () => {
    const issue = checkDatasetComplete(40, 100);
    expect(issue?.code).toBe("PARTIAL_DATASET");
    expect(issue?.message).toMatch(/40 of 100/);
  });

  it("assertDatasetComplete throws only for a partial dataset", () => {
    expect(() => assertDatasetComplete(100, 100)).not.toThrow();
    expect(() => assertDatasetComplete(99, 100)).toThrow(ExportIntegrityError);
  });
});

describe("assertBlobIntact", () => {
  it("passes for a blob that holds the intended bytes", async () => {
    const text = csvOf(ROWS);
    const blob = new Blob([text], { type: "text/csv" });
    await expect(assertBlobIntact(blob, createManifest(text, "csv", 3))).resolves.toMatchObject({ ok: true });
  });

  it("rejects a blob that is shorter than intended", async () => {
    const text = csvOf(ROWS);
    const blob = new Blob([text.slice(0, text.length - 10)], { type: "text/csv" });
    await expect(assertBlobIntact(blob, createManifest(text, "csv", 3))).rejects.toBeInstanceOf(ExportIntegrityError);
  });
});
