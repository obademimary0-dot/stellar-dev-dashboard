# Export Integrity

How the dashboard refuses to download an export that is partial or cut off.

> Implemented for [Issue #1203](https://github.com/Nanle-code/stellar-dev-dashboard/issues/1203).
> Source: [`src/lib/exportIntegrity.ts`](../src/lib/exportIntegrity.ts), used by [`src/utils/export.ts`](../src/utils/export.ts) and [`src/hooks/useDataExport.ts`](../src/hooks/useDataExport.ts).

## The problem

A file that ends early looks like any other download. A page fetch that stopped halfway, a serializer that threw, or a blob that did not hold everything produces a short file the user only notices later, often after relying on it. Checks now run on the payload **before** the browser is asked to save it, and a bad export raises an `ExportIntegrityError` with a specific reason instead of being downloaded.

## What is checked

Three independent signals are combined:

1. **Manifest of what was meant to be exported.** Taken from the intended payload: UTF-8 byte length, CRC-32, and row count.
2. **Format structure.** CSV: an unterminated quote or a row whose column count differs from the header. JSON: a document that does not parse (cut off mid-value or missing a closing bracket). Parquet: both `PAR1` markers present. PDF: starts with `%PDF-` and ends with `%%EOF`.
3. **Completeness against a known total.** When rows come from a paged source, fewer rows than the source reported means a page failed.

| Issue code               | Meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `EMPTY_PAYLOAD`          | Nothing was produced but data was expected                           |
| `SIZE_MISMATCH`          | Fewer (or more) bytes than expected                                  |
| `CHECKSUM_MISMATCH`      | Same length, different content                                       |
| `ROW_COUNT_MISMATCH`     | Row count differs from the manifest                                  |
| `PARTIAL_DATASET`        | Fewer rows loaded than the source's total                            |
| `UNTERMINATED_CSV_QUOTE` | CSV ends inside a quoted value                                       |
| `RAGGED_CSV_ROW`         | A CSV row has a different column count than the header               |
| `TRUNCATED_JSON`         | JSON ends mid-document                                               |
| `MISSING_PARQUET_MAGIC`  | Parquet header or footer missing                                     |
| `MISSING_PDF_TRAILER`    | PDF does not end with `%%EOF`                                        |

## Using it

```ts
import { createManifest, verifyExport, assertExportIntact, assertDatasetComplete } from '../lib/exportIntegrity'

const manifest = createManifest(intendedCsv, 'csv', rows.length)
assertExportIntact(producedCsv, manifest) // throws ExportIntegrityError
```

- `verifyExport` never throws and returns `{ ok, issues, actual }`.
- `assertBlobIntact(blob, manifest)` reads a blob back and verifies it (async), for payloads where the blob is what gets saved.
- `assertDatasetComplete(loaded, expectedTotal)` refuses a partial dataset.

### In the app

`exportCsv`, `exportJson`, `exportRowsJson`, `exportPdf` and `exportParquet` verify before downloading. `downloadFile` also checks that the blob holds as many bytes as the text it was given (a blob that hit a size limit would otherwise be saved short).

`useDataExport` takes an optional `expectedTotal`:

```ts
await exportTransactions(rows, 'csv', { expectedTotal: 500 })
// -> exportError: "Export aborted, the file is incomplete or corrupt: Only 200 of 500 rows were loaded; ..."
```

Nothing is downloaded and the error is shown in the existing export error message.

## Related fix

The CSV writer now quotes any cell containing a bare carriage return (`\r`). Every CSV reader treats it as a row break, so unquoted it split one row into two. The integrity check surfaced this, since such a file has a different row count than the data.

## Limits

- A one-column CSV counts blank lines as rows, so empty cells there are not mistaken for gaps.
- The CRC-32 detects accidental corruption and truncation. It is not a security control and must not be used to authenticate a file.
- A browser download that fails _after_ the file is handed over (disk full, cancelled) cannot be detected from the page.
- Parquet and PDF are checked structurally (markers), not parsed.

## Security and privacy

No data leaves the page: verification reads only the payload already in memory. Error messages contain counts and byte sizes, never row contents. A failed check blocks the download, so a corrupt backup cannot be saved over a good one by accident.

## Testing

`src/lib/__tests__/exportIntegrity.test.ts` covers intact exports, truncation at row and mid-row boundaries, quoted fields with commas and newlines, multi-byte text, same-length corruption, empty payloads, row-count and total mismatches, Parquet/PDF markers, and blob read-back. `src/hooks/useDataExport.test.ts` covers the hook behavior.
