import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SUPPORTED_DEVICES,
  METRICS,
  FLOWS,
  FLOW_BUDGETS,
  MAX_POTENTIAL_FID_BUDGET_MS,
  DEFAULT_PERCENTILE,
  CI_DEFAULT_MULTIPLIER,
  InteractionBudgetError,
  validateDevice,
  validateInteractionBudgets,
  percentile,
  getBudgetMultiplier,
  evaluateFlow,
  formatReport,
  withInteractionAssertions,
} = require('../../../scripts/interaction-budgets.cjs');
const { generateAssertMatrix } = require('../../../scripts/lighthouse-budgets.cjs');

const FLOW_IDS = Object.keys(FLOWS);

describe('interaction latency budget definitions (#1208)', () => {
  it('cover every supported device and flow with every metric', () => {
    expect(SUPPORTED_DEVICES).toEqual(['desktop', 'mobile']);
    expect(FLOW_IDS.length).toBeGreaterThanOrEqual(3);
    for (const device of SUPPORTED_DEVICES) {
      for (const flowId of FLOW_IDS) {
        for (const metric of METRICS) {
          expect(FLOW_BUDGETS[device][flowId][metric], `${device}.${flowId}.${metric}`).toBeGreaterThan(0);
        }
      }
    }
    expect(validateInteractionBudgets()).toBe(true);
  });

  it('keep desktop event budgets under the "poor" INP line, and simple interactions at the "good" one', () => {
    for (const flowId of FLOW_IDS) {
      expect(FLOW_BUDGETS.desktop[flowId].eventDurationMs).toBeLessThan(500);
    }
    // Only whole-page route navigation is allowed more than the 200 ms "good" INP line.
    const overGood = FLOW_IDS.filter((id) => FLOW_BUDGETS.desktop[id].eventDurationMs > 200);
    expect(overGood).toEqual(['section-navigation']);
  });

  it('never make mobile stricter than desktop', () => {
    for (const flowId of FLOW_IDS) {
      for (const metric of METRICS) {
        expect(FLOW_BUDGETS.mobile[flowId][metric]).toBeGreaterThanOrEqual(FLOW_BUDGETS.desktop[flowId][metric]);
      }
    }
    expect(MAX_POTENTIAL_FID_BUDGET_MS.mobile).toBeGreaterThanOrEqual(MAX_POTENTIAL_FID_BUDGET_MS.desktop);
  });

  it('are frozen so a stray assignment cannot loosen a budget', () => {
    expect(Object.isFrozen(FLOW_BUDGETS)).toBe(true);
    expect(Object.isFrozen(FLOW_BUDGETS.desktop['section-navigation'])).toBe(true);
    expect(() => {
      'use strict';
      FLOW_BUDGETS.desktop['section-navigation'].settleMs = 99999;
    }).toThrow();
  });
});

describe('validateInteractionBudgets', () => {
  const clone = () => JSON.parse(JSON.stringify(FLOW_BUDGETS));

  it('rejects a missing device, flow or metric', () => {
    const noMobile = clone();
    delete noMobile.mobile;
    expect(() => validateInteractionBudgets(noMobile)).toThrow(/Missing budgets for device "mobile"/);

    const noFlow = clone();
    delete noFlow.desktop[FLOW_IDS[0]];
    expect(() => validateInteractionBudgets(noFlow)).toThrow(/no budget for flow/);

    const noMetric = clone();
    delete noMetric.desktop[FLOW_IDS[0]].settleMs;
    expect(() => validateInteractionBudgets(noMetric)).toThrow(/settleMs/);
  });

  it.each([0, -5, Number.NaN, Infinity, '200', null])('rejects a budget of %s', (bad) => {
    const budgets = clone();
    budgets.desktop[FLOW_IDS[0]].eventDurationMs = bad;
    expect(() => validateInteractionBudgets(budgets)).toThrow(InteractionBudgetError);
  });

  it('rejects a budget for a flow the spec does not measure', () => {
    const budgets = clone();
    budgets.desktop['not-a-flow'] = { eventDurationMs: 100, settleMs: 100 };
    expect(() => validateInteractionBudgets(budgets)).toThrow(/unknown flow/);
  });

  it('rejects non-objects', () => {
    expect(() => validateInteractionBudgets(null)).toThrow(InteractionBudgetError);
    expect(() => validateInteractionBudgets([])).toThrow(InteractionBudgetError);
  });
});

describe('percentile (nearest rank)', () => {
  it('picks the right sample', () => {
    expect(percentile([5, 1, 3, 4, 2], 0.75)).toBe(4);
    expect(percentile([5, 1, 3, 4, 2], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 4, 2], 1)).toBe(5);
    expect(percentile([5, 1, 3, 4, 2], 0)).toBe(1);
    expect(percentile([7], 0.75)).toBe(7);
  });

  it('does not modify its input', () => {
    const samples = [3, 1, 2];
    percentile(samples, 0.5);
    expect(samples).toEqual([3, 1, 2]);
  });

  it('rejects empty input, bad samples and bad ranks', () => {
    expect(() => percentile([], 0.75)).toThrow(/no samples/);
    expect(() => percentile([1, Number.NaN], 0.75)).toThrow(/Invalid sample/);
    expect(() => percentile([1, -1], 0.75)).toThrow(/Invalid sample/);
    expect(() => percentile([1, 2], 1.5)).toThrow(/between 0 and 1/);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(InteractionBudgetError);
  });
});

describe('getBudgetMultiplier', () => {
  it('is 1 locally and relaxed on CI', () => {
    expect(getBudgetMultiplier({})).toBe(1);
    expect(getBudgetMultiplier({ CI: 'true' })).toBe(CI_DEFAULT_MULTIPLIER);
  });

  it('honours an explicit override, including on CI', () => {
    expect(getBudgetMultiplier({ INTERACTION_BUDGET_MULTIPLIER: '2.5', CI: 'true' })).toBe(2.5);
    expect(getBudgetMultiplier({ INTERACTION_BUDGET_MULTIPLIER: '1' })).toBe(1);
    expect(getBudgetMultiplier({ INTERACTION_BUDGET_MULTIPLIER: '' })).toBe(1);
  });

  it.each(['0.5', '0', '-1', 'abc', '6', 'Infinity'])('rejects %s (it may only relax, within a cap)', (raw) => {
    expect(() => getBudgetMultiplier({ INTERACTION_BUDGET_MULTIPLIER: raw })).toThrow(/INTERACTION_BUDGET_MULTIPLIER/);
  });
});

describe('evaluateFlow', () => {
  const budget = FLOW_BUDGETS.desktop['section-navigation'];
  const within = { eventDurationMs: [80, 90, 100, 110, 120], settleMs: [400, 500, 600, 700, 800] };

  it('passes when the p75 of every metric is within budget', () => {
    const result = evaluateFlow({ flowId: 'section-navigation', samples: within });
    expect(result.pass).toBe(true);
    expect(result.metrics.map((m) => m.reason)).toEqual(['OK', 'OK']);
    expect(result.device).toBe('desktop');
  });

  it('passes exactly at the budget and fails one millisecond over', () => {
    const atBudget = { eventDurationMs: [budget.eventDurationMs], settleMs: [budget.settleMs] };
    expect(evaluateFlow({ flowId: 'section-navigation', samples: atBudget }).pass).toBe(true);
    const over = { eventDurationMs: [budget.eventDurationMs], settleMs: [budget.settleMs + 1] };
    const result = evaluateFlow({ flowId: 'section-navigation', samples: over });
    expect(result.pass).toBe(false);
    expect(result.metrics.find((m) => m.metric === 'settleMs').reason).toBe('OVER_BUDGET');
  });

  it('judges the p75, so one slow outlier of five does not fail the flow but two do', () => {
    const oneOutlier = { ...within, settleMs: [400, 450, 500, 550, 9000] };
    expect(evaluateFlow({ flowId: 'section-navigation', samples: oneOutlier }).pass).toBe(true);
    const twoSlow = { ...within, settleMs: [400, 450, 500, 9000, 9000] };
    expect(evaluateFlow({ flowId: 'section-navigation', samples: twoSlow }).pass).toBe(false);
  });

  it('fails a flow that has no samples instead of passing it', () => {
    const none = evaluateFlow({ flowId: 'section-navigation', samples: {} });
    expect(none.pass).toBe(false);
    expect(none.metrics.every((m) => m.reason === 'NO_SAMPLES' && m.observed === null)).toBe(true);

    const half = evaluateFlow({ flowId: 'section-navigation', samples: { eventDurationMs: [10], settleMs: [] } });
    expect(half.pass).toBe(false);
  });

  it('relaxes every budget by the multiplier and reports the effective value', () => {
    const slow = { eventDurationMs: [budget.eventDurationMs * 1.4], settleMs: [budget.settleMs * 1.4] };
    expect(evaluateFlow({ flowId: 'section-navigation', samples: slow }).pass).toBe(false);
    const relaxed = evaluateFlow({ flowId: 'section-navigation', samples: slow, multiplier: 1.5 });
    expect(relaxed.pass).toBe(true);
    expect(relaxed.metrics[0].effectiveBudget).toBe(Math.round(budget.eventDurationMs * 1.5));
  });

  it('refuses a multiplier below 1 (budgets can be relaxed, never tightened by accident)', () => {
    expect(() => evaluateFlow({ flowId: 'section-navigation', samples: within, multiplier: 0.5 })).toThrow(/>= 1/);
  });

  it('uses the mobile budgets when asked', () => {
    const between = { eventDurationMs: [300], settleMs: [budget.settleMs + 500] };
    expect(evaluateFlow({ flowId: 'section-navigation', samples: between, device: 'desktop' }).pass).toBe(false);
    expect(evaluateFlow({ flowId: 'section-navigation', samples: between, device: 'mobile' }).pass).toBe(true);
  });

  it('rejects unknown flows and devices', () => {
    expect(() => evaluateFlow({ flowId: 'nope', samples: within })).toThrow(/No desktop budget/);
    expect(() => evaluateFlow({ flowId: 'section-navigation', samples: within, device: 'tablet' })).toThrow(/Unsupported device/);
    expect(() => validateDevice('tv')).toThrow(InteractionBudgetError);
  });

  it('defaults to the p75', () => {
    expect(DEFAULT_PERCENTILE).toBe(0.75);
  });
});

describe('formatReport', () => {
  it('lists each metric and marks failures and relaxed budgets', () => {
    const ok = evaluateFlow({ flowId: 'theme-toggle', samples: { eventDurationMs: [10], settleMs: [100] } });
    const bad = evaluateFlow({ flowId: 'connect-account', samples: { eventDurationMs: [10], settleMs: [99999] }, multiplier: 1.5 });
    const report = formatReport([ok, bad]);
    expect(report).toMatch(/theme-toggle\s+eventDurationMs\s+10ms\s+200ms\s+ok/);
    expect(report).toMatch(/connect-account\s+settleMs\s+99999ms\s+3750ms\*\s+OVER_BUDGET/);
    expect(report).toMatch(/budget relaxed/);
  });

  it('shows n/a for a flow with no samples', () => {
    expect(formatReport([evaluateFlow({ flowId: 'theme-toggle', samples: {} })])).toMatch(/n\/a.*NO_SAMPLES/);
  });
});

describe('withInteractionAssertions (Lighthouse)', () => {
  it('adds a max-potential-fid warning to every entry for the device', () => {
    for (const device of SUPPORTED_DEVICES) {
      const base = generateAssertMatrix(device);
      const matrix = withInteractionAssertions(base, device);
      expect(matrix).toHaveLength(base.length);
      for (const entry of matrix) {
        expect(entry.assertions['max-potential-fid']).toEqual([
          'warn',
          { maxNumericValue: MAX_POTENTIAL_FID_BUDGET_MS[device] },
        ]);
      }
    }
  });

  it('keeps every existing assertion, including the TBT error budgets', () => {
    const base = generateAssertMatrix('desktop');
    const matrix = withInteractionAssertions(base, 'desktop');
    matrix.forEach((entry, i) => {
      for (const [key, value] of Object.entries(base[i].assertions)) {
        expect(entry.assertions[key]).toEqual(value);
      }
    });
    expect(matrix[0].assertions['total-blocking-time'][0]).toBe('error');
  });

  it('does not modify the matrix it is given and lets an entry override', () => {
    const base = [{ matchingUrlPattern: '.*', assertions: { 'max-potential-fid': ['off', {}] } }];
    const snapshot = JSON.stringify(base);
    const matrix = withInteractionAssertions(base, 'mobile');
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(matrix[0].assertions['max-potential-fid']).toEqual(['off', {}]);
  });

  it('rejects an unsupported device', () => {
    expect(() => withInteractionAssertions([], 'watch')).toThrow(/Unsupported device/);
  });
});
