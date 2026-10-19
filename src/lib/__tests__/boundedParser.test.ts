import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PARSE_LIMITS,
  ParseAbortedError,
  ParseFormatError,
  ParseLimitError,
  parseCsvBounded,
  parseJsonBounded,
  parseJsonLinesBounded,
  readTextBounded,
} from "../boundedParser";
import { MAX_IMPORT_BYTES, readFileAsText } from "../import";

const enc = (s: string) => new TextEncoder().encode(s);

/** What a rejected parse is caught as in these tests. */
type Caught = Error & Record<string, unknown>;

/** A stream over `chunks` that records how many were pulled and whether it was cancelled. */
function trackedStream(chunks: Uint8Array[]) {
  const state = { pulled: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(chunks[i]);
      i += 1;
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.slice(o, o + size));
  return out;
}

const CSV = 'id,memo,note\r\n1,hello,"a,b"\r\n2,"say ""hi""","line1\nline2"\r\n3,naïve ✓,\r\n';

describe("parseCsvBounded", () => {
  it("parses header and rows, honouring quotes, doubled quotes, embedded newlines and empty fields", async () => {
    const result = await parseCsvBounded(CSV);
    expect(result.header).toEqual(["id", "memo", "note"]);
    expect(result.rows).toEqual([
      ["1", "hello", "a,b"],
      ["2", 'say "hi"', "line1\nline2"],
      ["3", "naïve ✓", ""],
    ]);
    expect(result.rowCount).toBe(3);
  });

  it("handles LF endings, a missing trailing newline, a BOM and empty input", async () => {
    expect((await parseCsvBounded("a,b\n1,2\n3,4")).rows).toEqual([["1", "2"], ["3", "4"]]);
    expect((await parseCsvBounded("﻿a,b\n1,2\n")).header).toEqual(["a", "b"]);
    const empty = await parseCsvBounded("");
    expect(empty).toMatchObject({ header: null, rows: [], rowCount: 0 });
    expect((await parseCsvBounded("a,b\n")).rowCount).toBe(0);
  });

  it("gives identical results however the input is chunked (split quotes, CRLF and multi-byte characters)", async () => {
    const expected = await parseCsvBounded(CSV);
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const fromString = await parseCsvBounded(CSV, { chunkBytes: size, yieldEveryMs: 1000 });
      const fromStream = await parseCsvBounded(trackedStream(splitBytes(enc(CSV), size)).stream, { yieldEveryMs: 1000 });
      expect(fromString.rows, `string chunk ${size}`).toEqual(expected.rows);
      expect(fromStream.rows, `stream chunk ${size}`).toEqual(expected.rows);
      expect(fromStream.header).toEqual(expected.header);
    }
  });

  it("reads Blob and File sources", async () => {
    const expected = await parseCsvBounded(CSV);
    const blob = await parseCsvBounded(new Blob([CSV]), { chunkBytes: 4 });
    const file = await parseCsvBounded(new File([CSV], "data.csv"), { chunkBytes: 9 });
    expect(blob.rows).toEqual(expected.rows);
    expect(file.rows).toEqual(expected.rows);
  });

  it("can treat every record as data (header: false)", async () => {
    const result = await parseCsvBounded("1,2\n3,4\n", { header: false });
    expect(result.header).toBeNull();
    expect(result.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("streams rows to onRow without retaining them", async () => {
    const seen: string[][] = [];
    const result = await parseCsvBounded(CSV, {
      retainRows: false,
      onRow: (row) => seen.push(row),
    });
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it("keeps memory flat on a large generated dataset when streaming", async () => {
    const rows = 60_000;
    const header = enc("id,value\n");
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === 0) controller.enqueue(header);
        if (next >= rows) {
          controller.close();
          return;
        }
        const batch: string[] = [];
        for (let k = 0; k < 1000 && next < rows; k += 1, next += 1) batch.push(`${next},v${next}\n`);
        controller.enqueue(enc(batch.join("")));
      },
    });
    let sum = 0;
    const result = await parseCsvBounded(stream, {
      retainRows: false,
      yieldEveryMs: 1000,
      limits: { maxRows: rows },
      onRow: (row) => {
        sum += Number(row[0]);
      },
    });
    expect(result.rowCount).toBe(rows);
    expect(result.rows).toHaveLength(0);
    expect(sum).toBe((rows * (rows - 1)) / 2);
  });

  describe("limits", () => {
    it("accepts exactly maxRows rows and rejects one more", async () => {
      const data = (n: number) => `h\n${Array.from({ length: n }, (_, i) => i).join("\n")}\n`;
      await expect(parseCsvBounded(data(5), { limits: { maxRows: 5 } })).resolves.toMatchObject({ rowCount: 5 });
      const error = await parseCsvBounded(data(6), { limits: { maxRows: 5 } }).then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
      expect(error).toBeInstanceOf(ParseLimitError);
      expect(error).toMatchObject({ limit: "maxRows", max: 5, observed: 6 });
    });

    it("rejects an oversized string before parsing anything", async () => {
      const onRow = vi.fn();
      const text = "a\n" + "x\n".repeat(100);
      const error = await parseCsvBounded(text, { limits: { maxBytes: 50 }, onRow }).then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
      expect(error).toMatchObject({ code: "PARSE_LIMIT_EXCEEDED", limit: "maxBytes", max: 50 });
      expect(onRow).not.toHaveBeenCalled();
    });

    it("accepts input of exactly maxBytes", async () => {
      const text = "a\n1\n";
      await expect(parseCsvBounded(text, { limits: { maxBytes: enc(text).length } })).resolves.toMatchObject({ rowCount: 1 });
      await expect(parseCsvBounded(text, { limits: { maxBytes: enc(text).length - 1 } })).rejects.toBeInstanceOf(ParseLimitError);
    });

    it("rejects an oversized Blob without reading it", async () => {
      const blob = new Blob(["a\n".repeat(1000)]);
      const slice = vi.spyOn(blob, "slice");
      await expect(parseCsvBounded(blob, { limits: { maxBytes: 100 } })).rejects.toBeInstanceOf(ParseLimitError);
      expect(slice).not.toHaveBeenCalled();
    });

    it("stops reading a stream of unknown size as soon as it passes maxBytes, and cancels it", async () => {
      const chunks = Array.from({ length: 50 }, () => enc("1,2\n".repeat(25)));
      const { stream, state } = trackedStream([enc("a,b\n"), ...chunks]);
      const error = await parseCsvBounded(stream, { limits: { maxBytes: 300 } }).then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
      expect(error).toBeInstanceOf(ParseLimitError);
      expect(state.pulled).toBeLessThan(10);
      expect(state.cancelled).toBe(true);
    });

    it("stops an unterminated quote from swallowing the file into one field", async () => {
      const chunks = [enc('a,b\n1,"'), ...Array.from({ length: 200 }, () => enc("x".repeat(1000)))];
      const { stream, state } = trackedStream(chunks);
      const error = await parseCsvBounded(stream, { limits: { maxFieldLength: 5000 } }).then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
      expect(error).toMatchObject({ limit: "maxFieldLength", max: 5000 });
      expect(state.pulled).toBeLessThan(20);
      expect(state.cancelled).toBe(true);
    });

    it("rejects non-positive limits", async () => {
      await expect(parseCsvBounded("a\n1\n", { limits: { maxRows: 0 } })).rejects.toBeInstanceOf(RangeError);
      await expect(parseCsvBounded("a\n1\n", { limits: { maxBytes: Number.NaN } })).rejects.toBeInstanceOf(RangeError);
    });

    it("has sane defaults", () => {
      expect(DEFAULT_PARSE_LIMITS.maxBytes).toBe(25 * 1024 * 1024);
      expect(Object.isFrozen(DEFAULT_PARSE_LIMITS)).toBe(true);
    });
  });

  it("reports a file that ends inside a quoted value as truncated", async () => {
    const error = await parseCsvBounded('a,b\n1,"never closed').then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
    expect(error).toBeInstanceOf(ParseFormatError);
    expect(error.message).toMatch(/truncated/);
  });

  describe("cancellation", () => {
    it("does not read anything when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { stream, state } = trackedStream([enc("a\n1\n")]);
      await expect(parseCsvBounded(stream, { signal: controller.signal })).rejects.toBeInstanceOf(ParseAbortedError);
      expect(state.pulled).toBe(0);
    });

    it("stops mid-parse, cancels the source, and keeps no partial rows", async () => {
      const controller = new AbortController();
      const chunks = Array.from({ length: 100 }, (_, i) => enc(`${i},v\n`.repeat(10)));
      const { stream, state } = trackedStream([enc("id,v\n"), ...chunks]);
      const onRow = vi.fn();
      const promise = parseCsvBounded(stream, {
        signal: controller.signal,
        yieldEveryMs: 0,
        onRow,
        onProgress: ({ rows }) => {
          if (rows >= 30) controller.abort();
        },
      });
      const error = await promise.then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
      expect(error).toBeInstanceOf(ParseAbortedError);
      expect(error.code).toBe("PARSE_ABORTED");
      expect(state.pulled).toBeLessThan(20);
      expect(state.cancelled).toBe(true);
      expect(onRow.mock.calls.length).toBeLessThan(100 * 10);
    });

    it("cancels a read that is waiting for the next chunk", async () => {
      const controller = new AbortController();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc("a,b\n1,2\n"));
          // never closes, never produces more
        },
        cancel() {
          cancelled = true;
        },
      });
      const promise = parseCsvBounded(stream, { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(promise).rejects.toBeInstanceOf(ParseAbortedError);
      expect(cancelled).toBe(true);
    });

    it("carries a string abort reason into the message", async () => {
      const controller = new AbortController();
      controller.abort("User closed the dialog");
      await expect(parseCsvBounded("a\n1\n", { signal: controller.signal })).rejects.toThrow("User closed the dialog");
    });
  });

  it("yields to the event loop so the UI is not blocked", async () => {
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);
    let ranBeforeFinish = false;
    const text = "a\n" + "1\n".repeat(20_000);
    await parseCsvBounded(text, {
      chunkBytes: 1024,
      yieldEveryMs: 0,
      onProgress: () => {
        if (timerRan) ranBeforeFinish = true;
      },
    });
    expect(ranBeforeFinish).toBe(true);
  });

  it("reports progress with totals for strings and blobs, and null for streams", async () => {
    const progress: Array<{ bytesRead: number; totalBytes: number | null; rows: number }> = [];
    await parseCsvBounded(CSV, { chunkBytes: 16, onProgress: (p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toMatchObject({ bytesRead: enc(CSV).length, totalBytes: enc(CSV).length, rows: 3 });
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i].bytesRead).toBeGreaterThanOrEqual(progress[i - 1].bytesRead);
    }

    const streamProgress: Array<{ totalBytes: number | null }> = [];
    await parseCsvBounded(trackedStream(splitBytes(enc(CSV), 10)).stream, { onProgress: (p) => streamProgress.push(p) });
    expect(streamProgress.every((p) => p.totalBytes === null)).toBe(true);
  });
});

describe("parseJsonLinesBounded", () => {
  const LINES = '{"id":1}\r\n{"id":2,"memo":"naïve ✓"}\n\n[3]\n{"id":4}';

  it("parses one value per line, skipping blank lines and tolerating CRLF and a missing final newline", async () => {
    const result = await parseJsonLinesBounded(LINES);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2, memo: "naïve ✓" }, [3], { id: 4 }]);
    expect(result.rowCount).toBe(4);
  });

  it("is chunk-invariant", async () => {
    const expected = await parseJsonLinesBounded(LINES);
    for (const size of [1, 2, 5, 11]) {
      const r = await parseJsonLinesBounded(trackedStream(splitBytes(enc(LINES), size)).stream, { yieldEveryMs: 1000 });
      expect(r.rows, `chunk ${size}`).toEqual(expected.rows);
    }
  });

  it("fails on an invalid line with its number by default", async () => {
    const error = await parseJsonLinesBounded('{"a":1}\n{broken\n{"a":3}\n').then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
    expect(error).toBeInstanceOf(ParseFormatError);
    expect(error).toMatchObject({ line: 2 });
  });

  it("can skip invalid lines and count them", async () => {
    const result = await parseJsonLinesBounded('{"a":1}\n{broken\n{"a":3}\n', { onInvalidLine: "skip" });
    expect(result.rows).toEqual([{ a: 1 }, { a: 3 }]);
    expect(result.skipped).toBe(1);
  });

  it("enforces maxRows exactly", async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `{"i":${i}}`).join("\n");
    await expect(parseJsonLinesBounded(lines(3), { limits: { maxRows: 3 } })).resolves.toMatchObject({ rowCount: 3 });
    await expect(parseJsonLinesBounded(lines(4), { limits: { maxRows: 3 } })).rejects.toMatchObject({ limit: "maxRows" });
  });

  it("rejects a line longer than maxFieldLength without buffering the rest", async () => {
    const { stream, state } = trackedStream(Array.from({ length: 100 }, () => enc("x".repeat(1000))));
    const error = await parseJsonLinesBounded(stream, { limits: { maxFieldLength: 4000 } }).then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
    expect(error).toMatchObject({ limit: "maxFieldLength" });
    expect(state.pulled).toBeLessThan(10);
    expect(state.cancelled).toBe(true);
  });

  it("streams without retaining and stops on abort", async () => {
    const seen: unknown[] = [];
    const ok = await parseJsonLinesBounded(LINES, { retainRows: false, onRow: (v) => seen.push(v) });
    expect(ok.rows).toEqual([]);
    expect(seen).toHaveLength(4);

    const controller = new AbortController();
    controller.abort();
    await expect(parseJsonLinesBounded(LINES, { signal: controller.signal })).rejects.toBeInstanceOf(ParseAbortedError);
  });
});

describe("parseJsonBounded", () => {
  it("parses arrays and objects from strings, blobs and streams", async () => {
    const doc = JSON.stringify({ a: [1, 2, { b: "naïve ✓" }] });
    expect(await parseJsonBounded(doc)).toEqual(JSON.parse(doc));
    expect(await parseJsonBounded(new Blob([doc]), { chunkBytes: 3 })).toEqual(JSON.parse(doc));
    expect(await parseJsonBounded(trackedStream(splitBytes(enc(doc), 4)).stream)).toEqual(JSON.parse(doc));
  });

  it("reports a document that does not parse (for example truncated)", async () => {
    const error = await parseJsonBounded('{"a":[1,2').then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
    expect(error).toBeInstanceOf(ParseFormatError);
    expect(error.message).toMatch(/not valid JSON/);
  });

  it("enforces maxBytes and maxRows", async () => {
    await expect(parseJsonBounded("[1,2,3]", { limits: { maxBytes: 3 } })).rejects.toMatchObject({ limit: "maxBytes" });
    await expect(parseJsonBounded("[1,2,3]", { limits: { maxRows: 2 } })).rejects.toMatchObject({ limit: "maxRows" });
    await expect(parseJsonBounded("[1,2,3]", { limits: { maxRows: 3 } })).resolves.toEqual([1, 2, 3]);
    // maxRows only applies to top-level arrays.
    await expect(parseJsonBounded('{"a":1,"b":2,"c":3}', { limits: { maxRows: 1 } })).resolves.toBeTruthy();
  });

  it("can be cancelled before the document is parsed", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parseJsonBounded("[1]", { signal: controller.signal })).rejects.toBeInstanceOf(ParseAbortedError);
  });
});

describe("readTextBounded", () => {
  it("round-trips multi-byte text across tiny chunks", async () => {
    const text = "héllo wörld ✓ 日本語 😀".repeat(20);
    expect(await readTextBounded(text, { chunkBytes: 3 })).toBe(text);
    expect(await readTextBounded(new Blob([text]), { chunkBytes: 5 })).toBe(text);
  });
});

describe("readFileAsText (import path)", () => {
  it("reads a file in chunks and returns its exact text", async () => {
    const text = '{"version":1,"memo":"naïve ✓"}'.repeat(1000);
    const file = new File([text], "backup.json", { type: "application/json" });
    expect(await readFileAsText(file)).toBe(text);
  });

  it("rejects files over the import limit before reading them", async () => {
    const file = new File(["x".repeat(2000)], "big.json");
    const slice = vi.spyOn(file, "slice");
    const error = await readFileAsText(file, { maxBytes: 1000 }).then(
        () => {
          throw new Error("expected the parse to be rejected");
        },
        (e: Caught) => e,
      );
    expect(error).toBeInstanceOf(ParseLimitError);
    expect(error.message).toMatch(/too large/);
    expect(slice).not.toHaveBeenCalled();
  });

  it("uses a 10 MiB default limit", () => {
    expect(MAX_IMPORT_BYTES).toBe(10 * 1024 * 1024);
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readFileAsText(new File(["{}"], "a.json"), { signal: controller.signal })).rejects.toBeInstanceOf(ParseAbortedError);
  });
});
