import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_AFTER_MS,
  PROVENANCE_KINDS,
  PROVENANCE_LABELS,
  describeProvenance,
  formatAge,
  isDataProvenance,
  resolveProvenance,
} from "../provenance";

const NOW = 1_800_000_000_000;

describe("resolveProvenance", () => {
  it("is live for a recent successful fetch", () => {
    const info = resolveProvenance({ fetchedAt: NOW - 10_000, now: NOW });
    expect(info.kind).toBe("live");
    expect(info.ageMs).toBe(10_000);
    expect(info.asOf).toBe(NOW - 10_000);
    expect(info.reason).toMatch(/Fetched 10s ago/);
  });

  it("accepts a Date for fetchedAt", () => {
    const info = resolveProvenance({ fetchedAt: new Date(NOW - 1_000), now: NOW });
    expect(info.kind).toBe("live");
    expect(info.asOf).toBe(NOW - 1_000);
  });

  it("is live at exactly the stale threshold and cached one millisecond past it", () => {
    expect(resolveProvenance({ fetchedAt: NOW - DEFAULT_STALE_AFTER_MS, now: NOW }).kind).toBe("live");
    expect(resolveProvenance({ fetchedAt: NOW - DEFAULT_STALE_AFTER_MS - 1, now: NOW }).kind).toBe("cached");
  });

  it("honours a custom staleAfterMs", () => {
    expect(resolveProvenance({ fetchedAt: NOW - 20_000, staleAfterMs: 10_000, now: NOW }).kind).toBe("cached");
    expect(resolveProvenance({ fetchedAt: NOW - 20_000, staleAfterMs: 30_000, now: NOW }).kind).toBe("live");
  });

  it("is cached when explicitly served from a cache, even if recent", () => {
    const info = resolveProvenance({ fromCache: true, fetchedAt: NOW - 1_000, now: NOW });
    expect(info.kind).toBe("cached");
    expect(info.reason).toMatch(/cache/i);
  });

  it("is cached when the last refresh failed, keeping the last good time", () => {
    const info = resolveProvenance({ hasError: true, fetchedAt: NOW - 90_000, now: NOW });
    expect(info.kind).toBe("cached");
    expect(info.reason).toMatch(/failed/);
    expect(info.reason).toMatch(/1m ago/);
  });

  it("is cached, not live, when the value was never fetched", () => {
    const info = resolveProvenance({ now: NOW });
    expect(info.kind).toBe("cached");
    expect(info.asOf).toBeNull();
    expect(info.ageMs).toBeNull();
    expect(resolveProvenance({ hasError: true, now: NOW }).reason).toMatch(/no earlier value/);
  });

  it("treats an unusable timestamp as unknown", () => {
    expect(resolveProvenance({ fetchedAt: Number.NaN, now: NOW }).kind).toBe("cached");
    expect(resolveProvenance({ fetchedAt: null, now: NOW }).kind).toBe("cached");
  });

  it("never reports a negative age for a timestamp in the future", () => {
    const info = resolveProvenance({ fetchedAt: NOW + 60_000, now: NOW });
    expect(info.ageMs).toBe(0);
    expect(info.kind).toBe("live");
  });

  it("is demo for demo data regardless of freshness", () => {
    expect(resolveProvenance({ isDemo: true, fetchedAt: NOW, now: NOW }).kind).toBe("demo");
    expect(resolveProvenance({ isDemo: true, now: NOW }).kind).toBe("demo");
  });

  it("is predicted for model output", () => {
    expect(resolveProvenance({ isPredicted: true, fetchedAt: NOW, now: NOW }).kind).toBe("predicted");
  });

  it("applies the strongest caveat when signals conflict: demo > predicted > cached > live", () => {
    const base = { fetchedAt: NOW, now: NOW };
    expect(resolveProvenance({ ...base, isDemo: true, isPredicted: true, fromCache: true }).kind).toBe("demo");
    expect(resolveProvenance({ ...base, isPredicted: true, fromCache: true, hasError: true }).kind).toBe("predicted");
    expect(resolveProvenance({ ...base, fromCache: true }).kind).toBe("cached");
    expect(resolveProvenance({ ...base }).kind).toBe("live");
  });

  it("falls back to the real clock when none is given", () => {
    expect(resolveProvenance({ fetchedAt: Date.now() }).kind).toBe("live");
  });
});

describe("formatAge", () => {
  it.each([
    [0, "just now"],
    [4_999, "just now"],
    [5_000, "5s ago"],
    [59_999, "59s ago"],
    [60_000, "1m ago"],
    [3_599_999, "59m ago"],
    [3_600_000, "1h ago"],
    [86_399_999, "23h ago"],
    [86_400_000, "1d ago"],
    [-5_000, "just now"],
    [Number.NaN, "just now"],
  ])("formats %s ms as %s", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});

describe("labels and guards", () => {
  it("has a label for every kind", () => {
    expect(PROVENANCE_KINDS).toEqual(["live", "cached", "demo", "predicted"]);
    for (const kind of PROVENANCE_KINDS) {
      expect(PROVENANCE_LABELS[kind]).toMatch(/^[A-Z]/);
    }
  });

  it("describeProvenance prefers the specific reason and falls back to the generic one", () => {
    expect(describeProvenance({ kind: "live", reason: "Fetched 3s ago." })).toEqual({
      label: "Live",
      description: "Fetched 3s ago.",
    });
    expect(describeProvenance({ kind: "demo", reason: "" }).description).toMatch(/sample data/);
  });

  it("isDataProvenance only accepts the four kinds", () => {
    expect(isDataProvenance("live")).toBe(true);
    expect(isDataProvenance("predicted")).toBe(true);
    expect(isDataProvenance("LIVE")).toBe(false);
    expect(isDataProvenance(undefined)).toBe(false);
    expect(isDataProvenance(3)).toBe(false);
  });
});
