import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile, exportCsv, exportJson, exportPdf, exportRowsJson } from "../export";
import { ExportIntegrityError, scanCsv } from "../../lib/exportIntegrity";

/** Reads a Blob captured by the stubbed download. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("export utilities verify before downloading (#1203)", () => {
  const click = vi.fn();
  const createObjectURL = vi.fn((_blob: Blob) => "blob:mock");
  const revokeObjectURL = vi.fn();
  const originalCreateElement = document.createElement.bind(document);
  const OriginalBlob = globalThis.Blob;

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error partial stub of the URL API for the test
    globalThis.URL = { createObjectURL, revokeObjectURL };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "a") return { href: "", download: "", click, style: {} } as unknown as HTMLElement;
      return originalCreateElement(tag);
    }) as typeof document.createElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(((child: Node) => child) as never);
    vi.spyOn(document.body, "removeChild").mockImplementation(((child: Node) => child) as never);
  });

  afterEach(() => {
    globalThis.Blob = OriginalBlob;
    vi.restoreAllMocks();
  });

  const lastDownload = async () => {
    const blob = createObjectURL.mock.calls.at(-1)?.[0] as Blob;
    return { blob, text: await readBlob(blob) };
  };

  describe("CSV", () => {
    it("downloads a normal export unchanged", async () => {
      exportCsv([{ id: "1", memo: "hi" }, { id: "2", memo: "there" }], "tx", undefined);
      const { text } = await lastDownload();
      expect(text).toBe("id,memo\r\n1,hi\r\n2,there");
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("quotes a bare carriage return so it cannot split a row", async () => {
      exportCsv([{ id: "1", memo: "line1\rline2" }, { id: "2", memo: "plain" }], "tx", undefined);
      const { text } = await lastDownload();
      expect(text).toContain('"line1\rline2"');
      const scan = scanCsv(text);
      expect(scan.records).toBe(3); // header + 2 rows, not 4
      expect(scan.columnCounts).toEqual([2, 2, 2]);
    });

    it("keeps quotes, commas and newlines intact", async () => {
      exportCsv([{ memo: 'say "hi", ok\nbye' }], "tx", undefined);
      const { text } = await lastDownload();
      expect(text).toBe('memo\r\n"say ""hi"", ok\nbye"');
    });

    it("still downloads an empty file for no rows", async () => {
      exportCsv([], "tx", undefined);
      expect((await lastDownload()).text).toBe("");
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("accepts sparse rows (a missing key becomes an empty field)", () => {
      // The second row has no `memo`; verification must not reject legitimate sparse data.
      expect(() => exportCsv([{ id: "1", memo: "a" }, { id: "2" }], "tx", undefined)).not.toThrow();
      expect(click).toHaveBeenCalledTimes(1);
    });
  });

  describe("JSON", () => {
    it("downloads arrays and objects", async () => {
      exportJson({ version: 1 }, "backup");
      expect(JSON.parse((await lastDownload()).text)).toEqual({ version: 1 });
      exportRowsJson([{ a: 1 }, { a: 2 }], "rows");
      expect(JSON.parse((await lastDownload()).text)).toEqual([{ a: 1 }, { a: 2 }]);
      expect(click).toHaveBeenCalledTimes(2);
    });

    it("refuses data that cannot be serialised instead of downloading the word 'undefined'", () => {
      expect(() => exportJson(undefined, "backup")).toThrow(/Nothing to export/);
      expect(() => exportJson(() => 1, "backup")).toThrow(/Nothing to export/);
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    });

    it("propagates a serialiser failure (circular data) without downloading", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => exportJson(circular, "backup")).toThrow(TypeError);
      expect(click).not.toHaveBeenCalled();
    });
  });

  describe("PDF", () => {
    it("downloads a complete PDF", async () => {
      exportPdf("Hello\nWorld", "report");
      const { blob, text } = await lastDownload();
      expect(blob.type).toBe("application/pdf");
      expect(text.startsWith("%PDF-")).toBe(true);
      expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    });
  });

  describe("downloadFile", () => {
    it("downloads text whose blob is complete", () => {
      downloadFile("hello ✓", "a.txt", "text/plain");
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("counts bytes, so multi-byte text is not mistaken for a short blob", () => {
      expect(() => downloadFile("naïve — ünïcödé ✓ 日本語", "a.txt", "text/plain")).not.toThrow();
    });

    it("refuses to download when the blob holds fewer bytes than the text it was given", () => {
      class ShortBlob {
        size: number;
        type: string;
        constructor(parts: unknown[], options?: { type?: string }) {
          this.size = String(parts[0]).length - 3;
          this.type = options?.type ?? "";
        }
      }
      globalThis.Blob = ShortBlob as unknown as typeof Blob;

      let thrown: unknown;
      try {
        downloadFile("0123456789", "a.txt", "text/plain");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExportIntegrityError);
      expect((thrown as ExportIntegrityError).issues[0].code).toBe("SIZE_MISMATCH");
      expect((thrown as ExportIntegrityError).message).toMatch(/holds 7 bytes but 10 were generated/);
      expect(click).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it("does not size-check a Blob passed in directly", () => {
      downloadFile(new OriginalBlob(["x"]), "a.bin", "application/octet-stream");
      expect(click).toHaveBeenCalledTimes(1);
    });
  });
});
