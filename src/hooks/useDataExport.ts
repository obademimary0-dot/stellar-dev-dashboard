/**
 * useDataExport hook (#114).
 *
 * Provides export/import actions bound to the live Zustand store state.
 */

import { useCallback, useRef, useState } from "react";
import { useStore } from "../lib/store";
import {
  buildBackupPayload,
  exportJson,
  exportCsv,
  exportRowsJson,
  exportParquet,
  flattenTransaction,
  flattenBalance,
} from "../utils/export";
import { readFileAsText, parseBackup, validateBackupPayload, applyBackupToStore } from "../lib/import";
import { assertDatasetComplete } from "../lib/exportIntegrity";
import { isParseAbortedError } from "../lib/boundedParser";

export type ExportFormat = "csv" | "json" | "parquet";

/**
 * A generic exportable row (transaction or balance record).
 */
export type ExportableRow = Record<string, unknown>;

/**
 * Options for {@link UseDataExportReturn.exportTransactions} and
 * {@link UseDataExportReturn.exportBalances}.
 */
export interface ExportOptions {
  /**
   * How many rows the source says exist in total. When fewer rows were loaded
   * (a page failed, or the fetch stopped early) the export is refused instead
   * of silently producing a partial file (#1203).
   */
  expectedTotal?: number;
}

/**
 * Return value of the {@link useDataExport} hook.
 */
export interface UseDataExportReturn {
  isExporting: boolean;
  isImporting: boolean;
  exportError: string | null;
  importError: string | null;
  importSuccess: boolean;
  exportDashboard: () => void;
  exportTransactions: (transactions: ExportableRow[], format?: ExportFormat, _options?: ExportOptions) => Promise<void>;
  exportBalances: (balances: ExportableRow[], format?: ExportFormat, _options?: ExportOptions) => Promise<void>;
  importBackup: (file: File) => Promise<void>;
  /** Stops an import in progress (#1205). Safe to call when none is running. */
  cancelImport: () => void;
}

/**
 * @returns Export/import actions bound to the live Zustand store state.
 */
export function useDataExport(): UseDataExportReturn {
  const store = useStore();
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<boolean>(false);
  const importAbort = useRef<AbortController | null>(null);

  const cancelImport = useCallback((): void => {
    importAbort.current?.abort();
  }, []);

  const exportDashboard = useCallback((): void => {
    setIsExporting(true);
    setExportError(null);
    try {
      const payload = buildBackupPayload(store);
      const slug = store.connectedAddress
        ? store.connectedAddress.slice(0, 6)
        : "dashboard";
      exportJson(payload, `stellar-${slug}-backup`);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setIsExporting(false);
    }
  }, [store]);

  const exportTransactions = useCallback(async (transactions: ExportableRow[], format: ExportFormat = "csv", options: ExportOptions = {}): Promise<void> => {
    setIsExporting(true);
    setExportError(null);
    try {
      const rows = (transactions || []).map(flattenTransaction);
      assertDatasetComplete(rows.length, options.expectedTotal);
      if (format === "csv") {
        exportCsv(rows, "stellar-transactions");
      } else if (format === "json") {
        exportRowsJson(rows, "stellar-transactions");
      } else if (format === "parquet") {
        await exportParquet(rows, "stellar-transactions");
      }
    } catch (err) {
      setExportError(err.message);
    } finally {
      setIsExporting(false);
    }
  }, []);

  const exportBalances = useCallback(async (balances: ExportableRow[], format: ExportFormat = "csv", options: ExportOptions = {}): Promise<void> => {
    setIsExporting(true);
    setExportError(null);
    try {
      const rows = (balances || []).map(flattenBalance);
      assertDatasetComplete(rows.length, options.expectedTotal);
      if (format === "csv") {
        exportCsv(rows, "stellar-balances");
      } else if (format === "json") {
        exportRowsJson(rows, "stellar-balances");
      } else if (format === "parquet") {
        await exportParquet(rows, "stellar-balances");
      }
    } catch (err) {
      setExportError(err.message);
    } finally {
      setIsExporting(false);
    }
  }, []);

  const importBackup = useCallback(
    async (file: File): Promise<void> => {
      importAbort.current?.abort(); // a new import replaces any running one
      const controller = new AbortController();
      importAbort.current = controller;
      setIsImporting(true);
      setImportError(null);
      setImportSuccess(false);
      try {
        const text = await readFileAsText(file, { signal: controller.signal });
        const result = parseBackup(text);
        if (!result.ok) {
          setImportError(result.error);
          return;
        }
        const validationErrors = validateBackupPayload(result.data);
        if (validationErrors.length > 0) {
          setImportError(validationErrors.join(" "));
          return;
        }
        applyBackupToStore(result.data, store);
        setImportSuccess(true);
      } catch (err) {
        setImportError(isParseAbortedError(err) ? "Import cancelled." : err.message);
      } finally {
        if (importAbort.current === controller) {
          importAbort.current = null;
          setIsImporting(false);
        }
      }
    },
    [store],
  );

  return {
    isExporting,
    isImporting,
    exportError,
    importError,
    importSuccess,
    exportDashboard,
    exportTransactions,
    exportBalances,
    importBackup,
    cancelImport,
  };
}
