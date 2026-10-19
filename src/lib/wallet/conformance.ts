/**
 * Wallet-adapter conformance test suite.
 *
 * This module provides a reusable, production-grade conformance harness for wallet
 * adapters. Adapter authors and contributors can run the suite against any adapter to
 * verify that it honors the public contract defined in `src/lib/wallet/types`.
 *
 * The suite is pure and deterministic: it never touches the network, never requires
 * secrets in source, and reports structured results instead of throwing on the first
 * failure. This makes it usable from both unit tests and contributor CLI tooling.
 */

import type { WalletAdapter } from "./types";

/** Severity of a conformance check. */
export type ConformanceSeverity = "error" | "warning";

/** Status of a single conformance check result. */
export type ConformanceStatus = "pass" | "fail" | "skip";

/** Result of a single conformance check. */
export interface ConformanceResult {
  /** Stable identifier for the check (e.g. `connect.id`). */
  id: string;
  /** Human-readable description of what was verified. */
  description: string;
  /** Outcome of the check. */
  status: ConformanceStatus;
  /** Severity used to decide whether the suite passes. */
  severity: ConformanceSeverity;
  /** Optional explanation for failures or skips. */
  message?: string;
}

/** Aggregate report returned by the conformance suite. */
export interface ConformanceReport {
  /** Name of the adapter under test. */
  adapterName: string;
  /** Individual check results in execution order. */
  results: ConformanceResult[];
  /** True when no error-severity check failed. */
  passed: boolean;
  /** Count of error-severity failures. */
  errorCount: number;
  /** Count of warning-severity failures. */
  warningCount: number;
  /** Count of skipped checks. */
  skippedCount: number;
}

/** Options controlling suite execution. */
export interface ConformanceOptions {
  /** Timeout in milliseconds for each async check. Defaults to 5000. */
  timeoutMs?: number;
  /** Check ids to skip entirely (reported as skips). */
  skip?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5000;

const REQUIRED_METHODS = ["connect", "disconnect"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface CheckDefinition {
  id: string;
  description: string;
  severity: ConformanceSeverity;
  run: (adapter: WalletAdapter, options: Required<ConformanceOptions>) => Promise<void>;
}

const CHECKS: readonly CheckDefinition[] = [
  {
    id: "adapter.name",
    description: "Adapter exposes a non-empty string name.",
    severity: "error",
    run: async (adapter) => {
      if (!isRecord(adapter)) {
        throw new Error("Adapter must be an object.");
      }
      if (!isNonEmptyString(adapter.name)) {
        throw new Error("Adapter.name must be a non-empty string.");
      }
    },
  },
  {
    id: "adapter.methods",
    description: "Adapter implements connect and disconnect as functions.",
    severity: "error",
    run: async (adapter) => {
      for (const method of REQUIRED_METHODS) {
        const candidate = (adapter as unknown as Record<string, unknown>)[method];
        if (typeof candidate !== "function") {
          throw new Error(`Adapter is missing required method "${method}".`);
        }
      }
    },
  },
  {
    id: "adapter.disconnectIdempotent",
    description: "Disconnecting an already-disconnected adapter resolves without throwing.",
    severity: "error",
    run: async (adapter, options) => {
      await withTimeout(
        Promise.resolve(adapter.disconnect()),
        options.timeoutMs,
        "disconnect",
      );
    },
  },
  {
    id: "adapter.connectReturnsAddress",
    description: "Connect resolves to a non-empty address string.",
    severity: "error",
    run: async (adapter, options) => {
      const result = await withTimeout(
        Promise.resolve(adapter.connect()),
        options.timeoutMs,
        "connect",
      );
      const address = isRecord(result) ? result.address : result;
      if (!isNonEmptyString(address)) {
        throw new Error("Connect must resolve to a non-empty address string.");
      }
    },
  },
  {
    id: "adapter.connectIdempotent",
    description: "Connecting twice yields the same address.",
    severity: "warning",
    run: async (adapter, options) => {
      const first = await withTimeout(
        Promise.resolve(adapter.connect()),
        options.timeoutMs,
        "connect",
      );
      const second = await withTimeout(
        Promise.resolve(adapter.connect()),
        options.timeoutMs,
        "connect",
      );
      const addressOf = (value: unknown) =>
        isRecord(value) ? value.address : value;
      if (addressOf(first) !== addressOf(second)) {
        throw new Error("Repeated connect calls returned different addresses.");
      }
    },
  },
] as const;

/** List of check ids exposed by the conformance suite. */
export const CONFORMANCE_CHECK_IDS: readonly string[] = CHECKS.map((c) => c.id);

/**
 * Run the conformance suite against a wallet adapter.
 *
 * The suite executes every check, capturing failures as structured results rather than
 * aborting early. A check that throws is recorded as a failure with the error
 * message; a check that is listed in `options.skip` is recorded as a skip.
 */
export async function runConformanceSuite(
  adapter: WalletAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const resolvedOptions: Required<ConformanceOptions> = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    skip: options.skip ?? [],
  };
  const skipSet = new Set(resolvedOptions.skip);
  const results: ConformanceResult[] = [];

  for (const check of CHECKS) {
    if (skipSet.has(check.id)) {
      results.push({
        id: check.id,
        description: check.description,
        status: "skip",
        severity: check.severity,
        message: "Skipped via options.skip.",
      });
      continue;
    }

    try {
      await check.run(adapter, resolvedOptions);
      results.push({
        id: check.id,
        description: check.description,
        status: "pass",
        severity: check.severity,
      });
    } catch (error) {
      results.push({
        id: check.id,
        description: check.description,
        status: "fail",
        severity: check.severity,
        message: describeError(error),
      });
    }
  }

  const errorCount = results.filter(
    (r) => r.status === "fail" && r.severity === "error",
  ).length;
  const warningCount = results.filter(
    (r) => r.status === "fail" && r.severity === "warning",
  ).length;
  const skippedCount = results.filter((r) => r.status === "skip").length;

  return {
    adapterName: isRecord(adapter) && isNonEmptyString(adapter.name)
      ? adapter.name
      : "<unnamed>",
    results,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    skippedCount,
  };
}

/**
 * Render a conformance report as a human-readable multi-line string.
 * Useful for CLI output and for attaching evidence to a PR.
 */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines = report.results.map((result) => {
    const marker =
      result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";
    const suffix = result.message ? ` - ${result.message}` : "";
    return `[${marker}] ${result.id} (${result.severity})${suffix}`;
  });
  const summary = `${report.passed ? "PASSED" : "FAILED"} - ${report.errorCount} error(s), ${report.warningCount} warning(s), ${report.skippedCount} skipped`;
  return [`Adapter: ${report.adapterName}`, ...lines, summary].join("\n");
}
