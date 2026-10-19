/**
 * Data provenance (#1206): where a value on screen came from.
 *
 * - `live`:      fetched from the network recently and the last refresh succeeded.
 * - `cached`:    served from a cache, or the last refresh failed / is overdue,
 *                so the value may be out of date.
 * - `demo`:      comes from bundled demo fixtures, not from the network.
 * - `predicted`: produced by a model or forecast, not observed.
 *
 * The four are mutually exclusive. When more than one could apply, the
 * strongest caveat wins: demo, then predicted, then cached, then live.
 */
export type DataProvenance = "live" | "cached" | "demo" | "predicted";

/** Everything {@link resolveProvenance} looks at. All fields are optional. */
export interface ProvenanceInput {
  /** The value comes from bundled demo fixtures. */
  isDemo?: boolean;
  /** The value is a model output or forecast. */
  isPredicted?: boolean;
  /** The value was read from a cache rather than fetched just now. */
  fromCache?: boolean;
  /** When the value was last fetched successfully (ms epoch, or a Date). */
  fetchedAt?: number | Date | null;
  /** The most recent refresh attempt failed. */
  hasError?: boolean;
  /** Age after which a fetched value counts as cached. Default 2 minutes. */
  staleAfterMs?: number;
  /** Clock override for tests and deterministic rendering. */
  now?: number;
}

/** The resolved provenance with a human-readable reason. */
export interface ProvenanceInfo {
  kind: DataProvenance;
  /** When the value was fetched, if known (ms epoch). */
  asOf: number | null;
  /** Age at resolution time in ms, if `asOf` is known. */
  ageMs: number | null;
  /** One sentence for tooltips and assistive technology. */
  reason: string;
}
