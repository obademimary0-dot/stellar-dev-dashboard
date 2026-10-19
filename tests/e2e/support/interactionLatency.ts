/**
 * Measures how long a dashboard interaction takes to respond (#1208).
 *
 * Two numbers per interaction, matching the budgets in
 * `scripts/interaction-budgets.cjs`:
 *
 *  - `eventDurationMs`: the longest Event Timing entry of any input event in
 *    the interaction, i.e. input to next paint (the quantity behind INP).
 *    Chromium-only; the browser rounds it to 8 ms.
 *  - `settleMs`: from the input event to the page showing the result. The end
 *    is detected with a per-frame poll plus one round trip to read the clock,
 *    so it can read a few tens of milliseconds high. Budgets are set well
 *    above that, and the spec judges a percentile of several samples.
 */

import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';

export interface InteractionSample {
  eventDurationMs: number;
  settleMs: number;
}

type ProbeWindow = Window & {
  __interactionProbe?: { armed: boolean; t0: number | null; durations: number[] };
};

/** Typed view of the CommonJS budget module. */
export interface InteractionBudgetsModule {
  FLOWS: Record<string, string>;
  DEFAULT_SAMPLE_COUNT: number;
  getBudgetMultiplier(_env?: Record<string, string | undefined>): number;
  evaluateFlow(_input: {
    flowId: string;
    device?: 'desktop' | 'mobile';
    samples: Partial<Record<'eventDurationMs' | 'settleMs', number[]>>;
    multiplier?: number;
  }): {
    flowId: string;
    pass: boolean;
    metrics: Array<{ metric: string; observed: number | null; effectiveBudget: number; pass: boolean; reason: string }>;
  };
  formatReport(_results: ReturnType<InteractionBudgetsModule['evaluateFlow']>[]): string;
}

const require = createRequire(import.meta.url);

export const budgets = require('../../../scripts/interaction-budgets.cjs') as InteractionBudgetsModule;

/**
 * Installs the probe before any page script runs, on every navigation. It
 * stays idle (`armed: false`) until {@link measureInteraction} turns it on, so
 * setup steps never pollute a measurement.
 */
export async function installInteractionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { armed: false, t0: null as number | null, durations: [] as number[] };
    (window as ProbeWindow).__interactionProbe = probe;

    const start = (event: Event) => {
      if (probe.armed && probe.t0 === null) probe.t0 = event.timeStamp;
    };
    for (const type of ['pointerdown', 'keydown', 'click']) {
      document.addEventListener(type, start, true);
    }

    if (PerformanceObserver.supportedEntryTypes?.includes('event')) {
      new PerformanceObserver((list) => {
        if (!probe.armed) return;
        for (const entry of list.getEntries()) probe.durations.push(entry.duration);
      }).observe({ type: 'event', durationThreshold: 16 } as never);
    }
  });
}

/** True when this browser reports Event Timing entries (Chromium does). */
export async function supportsEventTiming(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(PerformanceObserver.supportedEntryTypes?.includes('event')));
}

/**
 * Runs `action` and measures it. `settled` runs in the page once per frame and
 * must return true when the result of the interaction is on screen.
 */
export async function measureInteraction<Arg = undefined>(
  page: Page,
  options: {
    action: () => Promise<unknown>;
    settled: (_arg: Arg) => boolean;
    arg?: Arg;
    timeoutMs?: number;
  },
): Promise<InteractionSample> {
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__interactionProbe;
    if (!probe) throw new Error('Interaction probe is not installed; call installInteractionProbe(page) first.');
    probe.armed = true;
    probe.t0 = null;
    probe.durations = [];
  });

  await options.action();
  await page.waitForFunction(options.settled, options.arg as Arg, {
    polling: 'raf',
    timeout: options.timeoutMs ?? 10_000,
  });

  // Event Timing entries are delivered after the next paint; give them time to arrive.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 150))),
  );

  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__interactionProbe!;
    probe.armed = false;
    if (probe.t0 === null) throw new Error('No input event was recorded; the action did not reach the page.');
    return {
      eventDurationMs: probe.durations.length ? Math.max(...probe.durations) : 0,
      settleMs: Math.max(0, performance.now() - probe.t0),
    };
  });
}

/**
 * Collects `count` samples, running `reset` between them (not measured).
 *
 * The first run of a flow pays one-off costs (lazy route chunks, module
 * transforms on the dev server, cold caches) that are not what a user feels on
 * the second click, so `warmup` runs are executed first and discarded.
 */
export async function collectSamples(
  count: number,
  sample: () => Promise<InteractionSample>,
  reset?: () => Promise<void>,
  { warmup = 1 }: { warmup?: number } = {},
): Promise<{ eventDurationMs: number[]; settleMs: number[] }> {
  for (let i = 0; i < warmup; i += 1) {
    await sample();
    if (reset) await reset();
  }
  const eventDurationMs: number[] = [];
  const settleMs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await sample();
    eventDurationMs.push(result.eventDurationMs);
    settleMs.push(result.settleMs);
    if (reset && i < count - 1) await reset();
  }
  return { eventDurationMs, settleMs };
}
