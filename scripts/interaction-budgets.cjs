/**
 * Interaction latency budgets (#1208).
 *
 * Lighthouse measures page load. This module owns the budgets for what happens
 * *after* load: how long the high-traffic dashboard flows take to respond to a
 * click or keypress. Two numbers are budgeted per flow:
 *
 *  - `eventDurationMs`: the longest browser Event Timing duration of any input
 *    event in the flow (input to the next frame; the quantity behind INP).
 *    "Good" INP is 200 ms.
 *  - `settleMs`: time from the input to the interface showing the result
 *    (route rendered, account loaded, control updated).
 *
 * Budgets are checked on a percentile of several samples (default p75 of 5),
 * not on a single run, and can be relaxed on slow runners with
 * `INTERACTION_BUDGET_MULTIPLIER`. The Playwright spec
 * (`tests/e2e/interaction-latency.spec.ts`) measures and calls
 * {@link evaluateFlow}; `lighthouserc.cjs` adds a `max-potential-fid`
 * assertion through {@link withInteractionAssertions}. Both read from here, so
 * a budget is changed in one place.
 *
 * @license Apache-2.0
 */

'use strict';

const SUPPORTED_DEVICES = Object.freeze(['desktop', 'mobile']);

const METRICS = Object.freeze(['eventDurationMs', 'settleMs']);

/** Flows covered by the Playwright spec, with a short description each. */
const FLOWS = Object.freeze({
  'connect-account': 'Enter an address and press Connect until the account is shown',
  'section-navigation': 'Open another dashboard section from the sidebar until its page has rendered',
  'theme-toggle': 'Switch the colour theme until the document reflects it',
});

/**
 * Budgets in milliseconds. Mobile is looser because the same work runs on a
 * slower CPU; the E2E spec currently enforces `desktop` only (see
 * docs/INTERACTION_LATENCY_BUDGETS.md).
 *
 * Calibration: the E2E suite runs against the Vite dev server (unminified,
 * route chunks transformed on demand), so these were set from p75 samples taken
 * there (connect 40-48 ms / 450-900 ms, section navigation 120-176 ms /
 * 570-730 ms, theme 40-48 ms / 370-440 ms) with headroom for slower machines.
 * Route navigation is allowed 300 ms input-to-paint rather than the 200 ms
 * "good INP" line because it renders a whole page; tighten it once the suite
 * can run against a production build.
 */
const FLOW_BUDGETS = Object.freeze({
  desktop: Object.freeze({
    'connect-account': Object.freeze({ eventDurationMs: 200, settleMs: 2500 }),
    'section-navigation': Object.freeze({ eventDurationMs: 300, settleMs: 1500 }),
    'theme-toggle': Object.freeze({ eventDurationMs: 200, settleMs: 800 }),
  }),
  mobile: Object.freeze({
    'connect-account': Object.freeze({ eventDurationMs: 350, settleMs: 4000 }),
    'section-navigation': Object.freeze({ eventDurationMs: 450, settleMs: 2500 }),
    'theme-toggle': Object.freeze({ eventDurationMs: 350, settleMs: 1300 }),
  }),
});

/**
 * Lighthouse `max-potential-fid` (the longest task a first input could have
 * waited behind), asserted as a warning next to the existing TBT error budget.
 */
const MAX_POTENTIAL_FID_BUDGET_MS = Object.freeze({ desktop: 130, mobile: 250 });

/** Percentile the flows are judged on. */
const DEFAULT_PERCENTILE = 0.75;
/** Samples the E2E spec takes per flow. */
const DEFAULT_SAMPLE_COUNT = 5;
/** Slack applied on CI, where shared runners are slower than a laptop. */
const CI_DEFAULT_MULTIPLIER = 1.5;
const MAX_MULTIPLIER = 5;

class InteractionBudgetError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'InteractionBudgetError';
    this.code = code;
  }
}

/**
 * @param {string} device
 * @returns {'desktop' | 'mobile'}
 */
function validateDevice(device) {
  if (!SUPPORTED_DEVICES.includes(device)) {
    throw new InteractionBudgetError(
      `Unsupported device "${device}". Expected one of: ${SUPPORTED_DEVICES.join(', ')}`,
      'ERR_UNSUPPORTED_DEVICE'
    );
  }
  return /** @type {'desktop' | 'mobile'} */ (device);
}

/**
 * Checks a budget table: both devices present, every flow has every metric,
 * every budget a positive finite number.
 * @param {Record<string, any>} [budgets]
 * @returns {true}
 */
function validateInteractionBudgets(budgets = FLOW_BUDGETS) {
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) {
    throw new InteractionBudgetError('Budgets must be an object', 'ERR_INVALID_CONFIG');
  }
  for (const device of SUPPORTED_DEVICES) {
    const flows = budgets[device];
    if (!flows || typeof flows !== 'object') {
      throw new InteractionBudgetError(`Missing budgets for device "${device}"`, 'ERR_MISSING_DEVICE');
    }
    for (const flowId of Object.keys(FLOWS)) {
      const flow = flows[flowId];
      if (!flow || typeof flow !== 'object') {
        throw new InteractionBudgetError(
          `Device "${device}" has no budget for flow "${flowId}"`,
          'ERR_MISSING_FLOW'
        );
      }
      for (const metric of METRICS) {
        const value = flow[metric];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new InteractionBudgetError(
            `Budget "${device}.${flowId}.${metric}" must be a positive number (got ${String(value)})`,
            'ERR_INVALID_BUDGET'
          );
        }
      }
    }
    for (const flowId of Object.keys(flows)) {
      if (!(flowId in FLOWS)) {
        throw new InteractionBudgetError(
          `Device "${device}" has a budget for unknown flow "${flowId}"`,
          'ERR_UNKNOWN_FLOW'
        );
      }
    }
  }
  return true;
}

/**
 * Nearest-rank percentile. `p` is 0..1; `percentile([a,b,c,d,e], 0.75)` is the
 * 4th smallest of five.
 * @param {number[]} samples
 * @param {number} p
 * @returns {number}
 */
function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new InteractionBudgetError('Cannot take a percentile of no samples', 'ERR_NO_SAMPLES');
  }
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new InteractionBudgetError(`Percentile must be between 0 and 1 (got ${p})`, 'ERR_INVALID_PERCENTILE');
  }
  for (const sample of samples) {
    if (typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0) {
      throw new InteractionBudgetError(`Invalid sample: ${String(sample)}`, 'ERR_INVALID_SAMPLE');
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/**
 * Budget multiplier from the environment: `INTERACTION_BUDGET_MULTIPLIER` if
 * set, else 1.5 on CI and 1 elsewhere.
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
function getBudgetMultiplier(env = process.env) {
  const raw = env.INTERACTION_BUDGET_MULTIPLIER;
  if (raw === undefined || raw === '') {
    return env.CI ? CI_DEFAULT_MULTIPLIER : 1;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > MAX_MULTIPLIER) {
    throw new InteractionBudgetError(
      `INTERACTION_BUDGET_MULTIPLIER must be between 1 and ${MAX_MULTIPLIER} (got "${raw}"). It can only relax a budget, never tighten it.`,
      'ERR_INVALID_MULTIPLIER'
    );
  }
  return value;
}

/**
 * Judges one flow's samples against its budget.
 *
 * A metric with no samples fails (`NO_SAMPLES`): a flow that could not be
 * measured must never count as passing.
 *
 * @param {{
 *   flowId: string,
 *   device?: 'desktop' | 'mobile',
 *   samples: Partial<Record<'eventDurationMs' | 'settleMs', number[]>>,
 *   multiplier?: number,
 *   percentileRank?: number,
 *   budgets?: Record<string, any>,
 * }} input
 */
function evaluateFlow(input) {
  const device = validateDevice(input.device ?? 'desktop');
  const budgets = input.budgets ?? FLOW_BUDGETS;
  const flowBudget = budgets[device] && budgets[device][input.flowId];
  if (!flowBudget) {
    throw new InteractionBudgetError(
      `No ${device} budget for flow "${input.flowId}"`,
      'ERR_UNKNOWN_FLOW'
    );
  }
  const multiplier = input.multiplier ?? 1;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new InteractionBudgetError('Multiplier must be a number >= 1', 'ERR_INVALID_MULTIPLIER');
  }
  const rank = input.percentileRank ?? DEFAULT_PERCENTILE;

  const metrics = METRICS.map((metric) => {
    const budget = flowBudget[metric];
    const effectiveBudget = Math.round(budget * multiplier);
    const samples = (input.samples && input.samples[metric]) || [];
    if (samples.length === 0) {
      return { metric, budget, effectiveBudget, observed: null, sampleCount: 0, pass: false, reason: 'NO_SAMPLES' };
    }
    const observed = percentile(samples, rank);
    return {
      metric,
      budget,
      effectiveBudget,
      observed,
      sampleCount: samples.length,
      pass: observed <= effectiveBudget,
      reason: observed <= effectiveBudget ? 'OK' : 'OVER_BUDGET',
    };
  });

  return {
    flowId: input.flowId,
    device,
    pass: metrics.every((m) => m.pass),
    metrics,
  };
}

/**
 * Plain-text table of evaluation results, for test output and CI logs.
 * @param {ReturnType<typeof evaluateFlow>[]} results
 * @returns {string}
 */
function formatReport(results) {
  const lines = ['flow                 metric            observed  budget  result'];
  for (const result of results) {
    for (const m of result.metrics) {
      const observed = m.observed === null ? 'n/a' : `${Math.round(m.observed)}ms`;
      const budget = m.effectiveBudget === m.budget ? `${m.budget}ms` : `${m.effectiveBudget}ms*`;
      lines.push(
        `${result.flowId.padEnd(20)} ${m.metric.padEnd(17)} ${observed.padStart(8)}  ${budget.padStart(6)}  ${m.pass ? 'ok' : m.reason}`
      );
    }
  }
  if (results.some((r) => r.metrics.some((m) => m.effectiveBudget !== m.budget))) {
    lines.push('* budget relaxed by INTERACTION_BUDGET_MULTIPLIER / CI slack');
  }
  return lines.join('\n');
}

/**
 * Adds the `max-potential-fid` warning to every entry of an LHCI assert
 * matrix. Returns a new matrix; the input is not modified. An entry that
 * already sets the assertion keeps its own value.
 *
 * @param {Array<{ matchingUrlPattern: string, assertions: Record<string, any> }>} matrix
 * @param {'desktop' | 'mobile' | string} device
 */
function withInteractionAssertions(matrix, device) {
  const maxMs = MAX_POTENTIAL_FID_BUDGET_MS[validateDevice(device)];
  return matrix.map((entry) => ({
    ...entry,
    assertions: {
      'max-potential-fid': ['warn', { maxNumericValue: maxMs }],
      ...entry.assertions,
    },
  }));
}

module.exports = {
  SUPPORTED_DEVICES,
  METRICS,
  FLOWS,
  FLOW_BUDGETS,
  MAX_POTENTIAL_FID_BUDGET_MS,
  DEFAULT_PERCENTILE,
  DEFAULT_SAMPLE_COUNT,
  CI_DEFAULT_MULTIPLIER,
  MAX_MULTIPLIER,
  InteractionBudgetError,
  validateDevice,
  validateInteractionBudgets,
  percentile,
  getBudgetMultiplier,
  evaluateFlow,
  formatReport,
  withInteractionAssertions,
};
