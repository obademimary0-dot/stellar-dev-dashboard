# Interaction Latency Budgets

How fast the high-traffic dashboard flows must respond to a click or keypress, and how that is enforced in CI.

> Implemented for [Issue #1208](https://github.com/Nanle-code/stellar-dev-dashboard/issues/1208).
> Budgets: [`scripts/interaction-budgets.cjs`](../scripts/interaction-budgets.cjs).
> E2E spec: [`tests/e2e/interaction-latency.spec.ts`](../tests/e2e/interaction-latency.spec.ts).
> Lighthouse wiring: [`lighthouserc.cjs`](../lighthouserc.cjs).

## What is budgeted

Lighthouse already budgets page load (LCP, CLS, TBT). This adds budgets for what happens _after_ load. Each flow has two numbers:

| Metric            | Meaning                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventDurationMs` | Longest browser Event Timing duration of any input in the flow: input to the next frame (the quantity behind INP). Chromium only; 8 ms steps. |
| `settleMs`        | Time from the input to the interface showing the result (route rendered, account loaded, theme applied).                                      |

| Flow                 | What is driven                                                              |
| -------------------- | --------------------------------------------------------------------------- |
| `connect-account`    | Enter an address and press Connect until the connected account is shown     |
| `section-navigation` | Open another section from the sidebar until its page has rendered           |
| `theme-toggle`       | Switch the colour theme until the document reflects it                      |

Desktop budgets (ms), mobile in brackets:

| Flow                 | `eventDurationMs` | `settleMs`    |
| -------------------- | ----------------- | ------------- |
| `connect-account`    | 200 (350)         | 2500 (4000)   |
| `section-navigation` | 300 (450)         | 1500 (2500)   |
| `theme-toggle`       | 200 (350)         | 800 (1300)    |

The E2E spec enforces the **desktop** profile on the `chromium` project. The mobile numbers exist so Lighthouse and future mobile specs share one source; they are validated (never stricter than desktop) but not yet measured by Playwright.

### How the numbers were chosen

The E2E suite runs against the Vite dev server (unminified, route chunks compiled on demand). Budgets were set from repeated local runs there: connect 40-48 ms input-to-paint and 450-900 ms to settle; section navigation 120-176 ms and 570-730 ms; theme 40-48 ms and 370-440 ms, then given headroom for slower machines. Whole-page route navigation is allowed 300 ms input-to-paint rather than the 200 ms "good INP" line because it renders an entire page. Tighten these when the suite can run against a production build.

## How a run is judged

- Each flow is run once to warm up (discarded: lazy chunks and cold caches are not what a user feels on the second click), then `INTERACTION_SAMPLES` times (default 5).
- The **p75** of each metric (nearest rank) is compared with its budget, so one slow outlier of five does not fail the flow but two do.
- A metric with **no samples fails** (`NO_SAMPLES`). A flow that could not be measured never counts as passing. The spec also asserts that an action that never reaches the page is reported as an error.
- Slack for slow runners: `INTERACTION_BUDGET_MULTIPLIER` (1 to 5). Unset, it is **1.5 on CI** and 1 locally. It can only relax a budget, never tighten it, and values outside 1-5 are rejected so a typo cannot silently disable the check.
- `settleMs` ends when a per-frame poll sees the result plus one round trip to read the clock, so it can read a few tens of milliseconds high. Budgets are well above that.

Results are printed as a table, and attached to the Playwright report as `latency-<flow>`:

```
flow                 metric            observed  budget  result
section-navigation   eventDurationMs      136ms   300ms  ok
section-navigation   settleMs             574ms  1500ms  ok
```

An asterisk after a budget (`2250ms*`) means it was relaxed by the multiplier.

## Running it

```bash
pnpm run test:interaction-latency                 # all flows, desktop Chromium
INTERACTION_SAMPLES=9 pnpm run test:interaction-latency
INTERACTION_BUDGET_MULTIPLIER=2 pnpm run test:interaction-latency   # slower machine
```

Needs Chromium (`pnpm exec playwright install chromium`) and a built workspace core package (`pnpm --filter @stellar-dev-dashboard/core run build`; `tsc` emits despite diagnostics about test files). CI runs it as the `Interaction Latency Budgets` job in `.github/workflows/testing.yml` and it is part of the Testing Framework Gate.

## Lighthouse

`lighthouserc.cjs`, `lighthouserc.desktop.cjs` and `lighthouserc.mobile.cjs` add a `max-potential-fid` **warning** (130 ms desktop, 250 ms mobile) to every route next to the existing `total-blocking-time` **error** budgets, through `withInteractionAssertions()`. It is a warning because it is a lab proxy for input delay; the enforced numbers are the Playwright flows above.

## Changing a budget

Edit `FLOW_BUDGETS` (or `MAX_POTENTIAL_FID_BUDGET_MS`) in `scripts/interaction-budgets.cjs`. `tests/unit/scripts/interaction-budgets.test.js` checks that every device and flow has every metric, that budgets are positive numbers, and that mobile is never stricter than desktop. To add a flow, add it to `FLOWS` and to both device tables, then add a test to the spec.

## Known issues found while building this

- The Overview page renders its "Dashboard Layouts" dialog unconditionally (`LayoutManager` never checks `isOpen`), so a full-screen overlay covers the sidebar there. The spec connects and then leaves Overview before it clicks anything. This is an existing app issue, not changed here.
- `vite build` currently fails on `src/components/dashboard/AuditLog.tsx` (a syntax error). The latency job uses the dev server so it does not depend on the build.

## Security, privacy, accessibility

- All network traffic in the spec is served by the deterministic `stellar` fixture; no live network or real account is touched, and the spec fails if an unmocked Horizon request is made.
- The probe records only timings and counts. No page content, addresses or input values are stored in the report beyond the generated test address.
- Budgets protect keyboard and pointer users alike: both `keydown` and `pointerdown`/`click` start the clock.
