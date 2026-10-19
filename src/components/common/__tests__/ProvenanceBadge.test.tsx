import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProvenanceBadge } from "../ProvenanceBadge";

const NOW = 1_800_000_000_000;

describe("ProvenanceBadge", () => {
  it.each([
    ["live", "Live", /fetched from the network/i],
    ["cached", "Cached", /may be out of date/i],
    ["demo", "Demo", /sample data/i],
    ["predicted", "Predicted", /estimate from a model/i],
  ] as const)("renders %s with its text label, explanation and data attribute", (kind, label, explanation) => {
    render(<ProvenanceBadge provenance={kind} />);
    const badge = screen.getByTestId("provenance-badge");
    expect(badge).toHaveAttribute("data-provenance", kind);
    expect(badge).toHaveTextContent(label);
    expect(badge.getAttribute("title")).toMatch(explanation);
  });

  it("exposes one accessible name that includes the kind and the explanation", () => {
    render(<ProvenanceBadge provenance="demo" />);
    const badge = screen.getByRole("img", { name: /Data source: Demo\. Bundled sample data/ });
    expect(badge).toBeInTheDocument();
  });

  it("uses a distinct icon per kind, not just a colour", () => {
    const markup = (["live", "cached", "demo", "predicted"] as const).map((kind) => {
      const { container, unmount } = render(<ProvenanceBadge provenance={kind} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      const html = svg!.innerHTML;
      unmount();
      return html;
    });
    expect(new Set(markup).size).toBe(4);
  });

  it("shows the age for live and cached values resolved from signals", () => {
    const { rerender } = render(
      <ProvenanceBadge signals={{ fetchedAt: NOW - 30_000 }} now={NOW} />,
    );
    expect(screen.getByTestId("provenance-badge")).toHaveAttribute("data-provenance", "live");
    expect(screen.getByTestId("provenance-badge")).toHaveTextContent("Live30s ago");

    rerender(<ProvenanceBadge signals={{ fetchedAt: NOW - 10 * 60_000 }} now={NOW} />);
    expect(screen.getByTestId("provenance-badge")).toHaveAttribute("data-provenance", "cached");
    expect(screen.getByTestId("provenance-badge")).toHaveTextContent("Cached10m ago");
  });

  it("can hide the age", () => {
    render(<ProvenanceBadge signals={{ fetchedAt: NOW - 30_000 }} now={NOW} showAge={false} />);
    expect(screen.getByTestId("provenance-badge")).toHaveTextContent(/^Live$/);
  });

  it("never shows an age for demo or predicted values", () => {
    render(<ProvenanceBadge signals={{ isPredicted: true, fetchedAt: NOW - 30_000 }} now={NOW} />);
    expect(screen.getByTestId("provenance-badge")).toHaveTextContent(/^Predicted$/);
  });

  it("shows cached when the last refresh failed", () => {
    render(<ProvenanceBadge signals={{ hasError: true, fetchedAt: NOW - 5_000 }} now={NOW} />);
    const badge = screen.getByTestId("provenance-badge");
    expect(badge).toHaveAttribute("data-provenance", "cached");
    expect(badge.getAttribute("aria-label")).toMatch(/last refresh failed/);
  });

  it("accepts an already-resolved ProvenanceInfo", () => {
    render(
      <ProvenanceBadge
        provenance={{ kind: "live", asOf: NOW, ageMs: 2_000, reason: "Fetched 2s ago." }}
        showAge={false}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Data source: Live. Fetched 2s ago.");
  });

  it("never claims live when it has nothing to go on", () => {
    render(<ProvenanceBadge />);
    const badge = screen.getByTestId("provenance-badge");
    expect(badge).toHaveAttribute("data-provenance", "cached");
    expect(badge.getAttribute("aria-label")).toMatch(/unknown/);
  });

  it("falls back to cached for an unrecognised kind instead of rendering it as live", () => {
    render(
      <ProvenanceBadge
        provenance={{ kind: "realtime" as never, asOf: null, ageMs: null, reason: "" }}
      />,
    );
    expect(screen.getByTestId("provenance-badge")).toHaveAttribute("data-provenance", "cached");
  });

  it("passes through a custom class name", () => {
    render(<ProvenanceBadge provenance="live" className="extra" />);
    expect(screen.getByTestId("provenance-badge")).toHaveClass("provenance-badge", "provenance-badge--live", "extra");
  });
});
