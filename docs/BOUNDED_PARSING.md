# Cancellable, Memory-Bounded Dataset Parsing

How large files are read and parsed without exhausting memory, freezing the page, or being impossible to stop.

> Implemented for [Issue #1205](https://github.com/Nanle-code/stellar-dev-dashboard/issues/1205).
> Source: [`src/lib/boundedParser.ts`](../src/lib/boundedParser.ts). The backup import ([`src/lib/import.ts`](../src/lib/import.ts)) uses it.

## The problem

`file.text()` followed by `split()` holds the whole file twice, blocks the main thread until it finishes, and cannot be stopped. One unterminated quote can turn the rest of a file into a single value.

## What it guarantees

| Guarantee             | How                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bounded memory**    | Input is read in 64 KiB chunks. `maxBytes` rejects oversized input before reading it (size known) or as soon as it is passed (streams). `maxRows` and `maxFieldLength` stop runaway data. `retainRows: false` hands rows to `onRow` and drops them, so memory stays flat for any input size. |
| **Cancellable**       | An `AbortSignal` is checked between every chunk and every yield; a pending stream read is cancelled. Cancelling throws `ParseAbortedError` and keeps nothing.            |
| **UI stays usable**   | The parser yields to the event loop at least every `yieldEveryMs` (default 12 ms).                                                                                        |
| **Correct decoding**  | Multi-byte characters, quoted newlines, `""` escapes and `\r\n` that straddle a chunk boundary parse identically to a single read (tested with 1-byte chunks).           |

Default limits (`DEFAULT_PARSE_LIMITS`): 25 MiB, 250,000 rows, 1 MiB per field or line. The backup import lowers the byte limit to 10 MiB (`MAX_IMPORT_BYTES`).

## API

```ts
import { parseCsvBounded, parseJsonLinesBounded, parseJsonBounded, readTextBounded } from '../lib/boundedParser'

const controller = new AbortController()
const { header, rows, rowCount } = await parseCsvBounded(file, {
  signal: controller.signal,
  limits: { maxRows: 50_000 },
  onProgress: ({ bytesRead, totalBytes, rows }) => setProgress(bytesRead / (totalBytes ?? Infinity)),
})
// elsewhere: controller.abort('Closed the dialog')
```

Sources: `string`, `Blob`/`File`, or `ReadableStream<Uint8Array>`.

| Function                 | Format             | Notes                                                                                  |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------- |
| `parseCsvBounded`        | CSV (RFC 4180)     | `header`, `onRow`, `retainRows`. A file ending inside a quote is `ParseFormatError`.   |
| `parseJsonLinesBounded`  | JSON Lines         | `onInvalidLine: 'throw' \| 'skip'`; errors carry the line number.                       |
| `parseJsonBounded`       | One JSON document  | Chunked, cancellable read, then one `JSON.parse`.                                      |
| `readTextBounded`        | Plain text         | What `readFileAsText` uses.                                                            |

### Errors

| Error               | `code`                  | When                                                                                |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `ParseLimitError`   | `PARSE_LIMIT_EXCEEDED`  | `limit` is `maxBytes`, `maxRows` or `maxFieldLength`; carries `max` and `observed`. |
| `ParseAbortedError` | `PARSE_ABORTED`         | The signal fired.                                                                   |
| `ParseFormatError`  | `PARSE_INVALID_FORMAT`  | Not valid for the format; `line` says where.                                        |

Messages are written for users ("The file is too large to import (12.0 MiB; the limit is 10.0 MiB).").

## In the app

`readFileAsText(file, { signal, maxBytes, onProgress })` is now chunked and cancellable. `useDataExport` exposes `cancelImport()`, the Data Export screen shows a **Cancel import** button while an import runs, and a cancelled import reports "Import cancelled." Starting a new import cancels the one in progress.

## Limits

- `JSON.parse` is a single synchronous call and **cannot be interrupted**. `parseJsonBounded` enforces the byte limit and checks for cancellation before and after, but a document within the limit parses in one step. Prefer JSON Lines for data that must stream.
- Strings passed in are already in memory; the parser bounds _additional_ memory and responsiveness, not the caller's copy.
- `onRow` runs synchronously inside the parse loop; heavy work there still blocks the page.

## Security and privacy

- Limits make a hostile or corrupt file fail fast instead of exhausting memory (a denial of service against the user's own tab).
- Nothing is sent anywhere; parsing is local. Limit and format errors report sizes and line numbers, never file contents.
- Parsed cell text is returned as plain strings and is never evaluated or interpreted as HTML or formulas.

## Testing

`src/lib/__tests__/boundedParser.test.ts` covers quotes, escapes, BOM and CRLF, chunk-size invariance (1 to 64 bytes) for strings, blobs and streams, `maxRows`/`maxBytes` at exactly the limit and one over, an unterminated quote that would swallow the file, cancellation before and during a parse (including that the source stream is cancelled and the next chunk is never pulled), a read blocked on the next chunk, event-loop yielding, progress reporting, a 60,000-row streamed dataset with flat memory, and the `readFileAsText` import path.
