/**
 * Lighthouse CI Master Configuration
 *
 * Supports dynamic device resolution ('desktop' by default, or 'mobile' via
 * LHCI_PRESET or LIGHTHOUSE_DEVICE).
 *
 * Enforces route-level budgets for LCP, CLS, and TBT on key dashboard routes.
 *
 * @type {import('@lhci/cli').LHCI.ServerCommand.Options}
 */

'use strict';

const {
  generateAssertMatrix,
  DEFAULT_CHROME_FLAGS,
  getDeviceBudgets,
} = require('./scripts/lighthouse-budgets.cjs');
const { withInteractionAssertions } = require('./scripts/interaction-budgets.cjs');

const device = (
  process.env.LHCI_PRESET ||
  process.env.LIGHTHOUSE_DEVICE ||
  'desktop'
).toLowerCase();
const deviceProfile = getDeviceBudgets(device);
const isMobile = device === 'mobile';

module.exports = {
  ci: {
    collect: {
      staticDistDir: './dist',
      isSinglePageApplication: true,
      numberOfRuns: 3,
      url: [
        'http://localhost/',
        'http://localhost/connect',
        'http://localhost/overview',
        'http://localhost/analytics',
        'http://localhost/transactions',
        'http://localhost/network',
      ],
      settings: {
        preset: isMobile ? undefined : 'desktop',
        formFactor: deviceProfile.formFactor,
        screenEmulation: deviceProfile.screenEmulation,
        throttling: deviceProfile.throttling,
        chromeFlags: DEFAULT_CHROME_FLAGS.join(' '),
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        skipAudits: ['uses-http2'],
      },
    },
    assert: {
      includePassedAssertions: true,
      // Page-load budgets plus the max-potential-fid warning from the shared
      // interaction latency budgets (#1208); see docs/INTERACTION_LATENCY_BUDGETS.md.
      assertMatrix: withInteractionAssertions(generateAssertMatrix(device), device),
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
