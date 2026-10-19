/**
 * Resolves and describes data provenance (#1206). See `types/provenance.ts`.
 *
 * "Live" is a claim that has to be earned: a value is only live when it was
 * fetched, recently, and the latest refresh did not fail. Anything that cannot
 * show that is reported as cached, so the UI errs toward "this may be old".
 */

import type {
  DataProvenance,
  ProvenanceInfo,
  ProvenanceInput,
} from "../types/provenance";

/** Fetched values older than this are reported as cached. */
export const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;

export const PROVENANCE_KINDS: readonly DataProvenance[] = [
  "live",
  "cached",
  "demo",
  "predicted",
];

export const PROVENANCE_LABELS: Readonly<Record<DataProvenance, string>> = {
  live: "Live",
  cached: "Cached",
  demo: "Demo",
  predicted: "Predicted",
};

const BASE_DESCRIPTIONS: Readonly<Record<DataProvenance, string>> = {
  live: "Fetched from the network and up to date.",
  cached: "May be out of date: served from a cache or the last refresh did not complete.",
  demo: "Bundled sample data, not real network data.",
  predicted: "An estimate from a model, not an observed value.",
};

function toMillis(value: number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : value;
  return Number.isFinite(ms) ? ms : null;
}

/** "just now", "45s ago", "5m ago", "2h ago", "3d ago". Negative ages clamp to "just now". */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 5_000) return "just now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Decides which provenance applies. Precedence, strongest caveat first:
 * demo, predicted, cached (explicit, failed refresh, overdue, or unknown),
 * and only then live.
 */
export function resolveProvenance(input: ProvenanceInput = {}): ProvenanceInfo {
  const now = input.now ?? Date.now();
  const asOf = toMillis(input.fetchedAt);
  const ageMs = asOf === null ? null : Math.max(0, now - asOf);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const result = (kind: DataProvenance, reason: string): ProvenanceInfo => ({
    kind,
    asOf,
    ageMs,
    reason,
  });

  if (input.isDemo) return result("demo", BASE_DESCRIPTIONS.demo);
  if (input.isPredicted) return result("predicted", BASE_DESCRIPTIONS.predicted);

  if (input.fromCache) {
    return result(
      "cached",
      ageMs === null
        ? "Served from a cache; the fetch time is unknown."
        : `Served from a cache, fetched ${formatAge(ageMs)}.`,
    );
  }
  if (input.hasError) {
    return result(
      "cached",
      ageMs === null
        ? "The last refresh failed and there is no earlier value."
        : `The last refresh failed; showing the value fetched ${formatAge(ageMs)}.`,
    );
  }
  if (asOf === null) {
    return result("cached", "Not refreshed yet, so freshness is unknown.");
  }
  if (ageMs !== null && ageMs > staleAfterMs) {
    return result("cached", `Last refreshed ${formatAge(ageMs)}, which is older than expected.`);
  }
  return result("live", `Fetched ${formatAge(ageMs ?? 0)}.`);
}

/** Short label plus the sentence used for tooltips and screen readers. */
export function describeProvenance(info: Pick<ProvenanceInfo, "kind" | "reason">): {
  label: string;
  description: string;
} {
  return {
    label: PROVENANCE_LABELS[info.kind],
    description: info.reason || BASE_DESCRIPTIONS[info.kind],
  };
}

/** Narrowing helper for values that may come from props or persisted state. */
export function isDataProvenance(value: unknown): value is DataProvenance {
  return typeof value === "string" && (PROVENANCE_KINDS as readonly string[]).includes(value);
}
