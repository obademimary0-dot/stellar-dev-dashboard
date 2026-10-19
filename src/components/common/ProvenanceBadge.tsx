import React from "react";
import { Clock, FlaskConical, Radio, Sparkles } from "lucide-react";
import { Badge } from "../../design-system/components";
import {
  PROVENANCE_LABELS,
  describeProvenance,
  formatAge,
  isDataProvenance,
  resolveProvenance,
} from "../../lib/provenance";
import type {
  DataProvenance,
  ProvenanceInfo,
  ProvenanceInput,
} from "../../types/provenance";

const TONES: Record<DataProvenance, "success" | "neutral" | "warning" | "info"> = {
  live: "success",
  cached: "neutral",
  demo: "warning",
  predicted: "info",
};

/** A different icon per kind, so meaning never depends on colour alone. */
const ICONS: Record<DataProvenance, typeof Radio> = {
  live: Radio,
  cached: Clock,
  demo: FlaskConical,
  predicted: Sparkles,
};

export interface ProvenanceBadgeProps {
  /**
   * Either a ready kind (`"live"`, `"cached"`, `"demo"`, `"predicted"`), a
   * resolved {@link ProvenanceInfo}, or raw signals to resolve.
   */
  provenance?: DataProvenance | ProvenanceInfo;
  /** Raw signals, used when `provenance` is not given. */
  signals?: ProvenanceInput;
  /** Show how old the value is next to the label (live and cached only). Default true. */
  showAge?: boolean;
  /** Override the clock; for deterministic rendering in tests. */
  now?: number;
  className?: string;
}

/**
 * Tells the reader whether a value is live, cached, demo or predicted (#1206).
 *
 * Accessible by construction: the kind is always written out as text and has
 * its own icon, the full explanation is in the tooltip and in the accessible
 * name, and nothing relies on colour. An unrecognised `provenance` falls back
 * to "cached" rather than claiming the value is live.
 */
export function ProvenanceBadge({
  provenance,
  signals,
  showAge = true,
  now,
  className = "",
}: ProvenanceBadgeProps) {
  let info: ProvenanceInfo;
  if (provenance && typeof provenance === "object") {
    info = provenance;
  } else if (isDataProvenance(provenance)) {
    info = { kind: provenance, asOf: null, ageMs: null, reason: "" };
  } else if (signals) {
    info = resolveProvenance({ ...signals, now: signals.now ?? now });
  } else {
    info = {
      kind: "cached",
      asOf: null,
      ageMs: null,
      reason: "The source of this value is unknown.",
    };
  }

  const kind = isDataProvenance(info.kind) ? info.kind : "cached";
  const { label, description } = describeProvenance({ ...info, kind });
  const Icon = ICONS[kind];
  const age =
    showAge && (kind === "live" || kind === "cached") && info.ageMs !== null
      ? formatAge(info.ageMs)
      : null;

  return (
    <Badge
      tone={TONES[kind]}
      className={`provenance-badge provenance-badge--${kind} ${className}`.trim()}
      data-testid="provenance-badge"
      data-provenance={kind}
      role="img"
      aria-label={`Data source: ${PROVENANCE_LABELS[kind]}. ${description}`}
      title={description}
    >
      <Icon size={11} aria-hidden="true" focusable="false" />
      <span aria-hidden="true">{label}</span>
      {age && (
        <span aria-hidden="true" className="provenance-badge__age">
          {age}
        </span>
      )}
    </Badge>
  );
}

export default ProvenanceBadge;
