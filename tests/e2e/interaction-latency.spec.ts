/**
 * Interaction latency budgets for high-traffic dashboard flows (#1208).
 *
 * Each test drives one flow several times against the deterministic network
 * fixture, then judges a percentile of the samples against the budget in
 * `scripts/interaction-budgets.cjs`. A flow that cannot be measured fails
 * rather than passing silently.
 *
 * Runs on the desktop Chromium project only: Event Timing is a Chromium API
 * and the budgets are for desktop hardware. Slow CI runners relax every budget
 * by `INTERACTION_BUDGET_MULTIPLIER` (default 1.5 on CI, 1 locally).
 */

import { test, expect } from './support/fixtures';
import { buildHorizonAccount, testKeypair } from './support/dataFactories';
import { openRoute, openSection } from './support/actions';
import type { Page } from '@playwright/test';
import {
  budgets,
  collectSamples,
  installInteractionProbe,
  measureInteraction,
  supportsEventTiming,
} from './support/interactionLatency';

const ALICE = testKeypair('alice').publicKey();

/**
 * Connects, then leaves the Overview page the app lands on.
 *
 * The Overview page renders its "Dashboard Layouts" dialog unconditionally
 * (`LayoutManager` ignores `isOpen`), so a full-screen overlay covers the
 * sidebar there and swallows clicks. That is an existing app issue outside the
 * scope of the latency budgets, so the flows below start from another section,
 * reached with the same History-API navigation the other specs use.
 */
async function connectAndLeaveOverview(page: Page, address: string): Promise<void> {
  await page.goto('/connect');
  const input = page.getByLabel('Stellar account address');
  await expect(input).toBeVisible();
  await input.fill(address);
  await page.getByRole('button', { name: 'Connect to Stellar account' }).click();
  await expect(page.getByLabel('Connected account')).toBeVisible();
  await openRoute(page, '/transactions');
  await expect(page.getByLabel('Connected account')).toBeVisible();
}

const SAMPLES = Number(process.env.INTERACTION_SAMPLES ?? budgets.DEFAULT_SAMPLE_COUNT);

test.describe('Interaction latency budgets', () => {
  test.beforeEach(async ({ page, stellar }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Event Timing and the desktop budgets apply to the desktop Chromium project only',
    );
    stellar.setAccount(buildHorizonAccount({ seed: 'alice' }));
    await installInteractionProbe(page);
  });

  test.afterEach(async ({ stellar }) => {
    // A budget test is only meaningful if the app never reached for the network unmocked.
    expect(stellar.unhandled.filter((u) => /horizon/.test(u))).toEqual([]);
  });

  async function judge(
    testInfo: { attach: (_name: string, _options: { body: string; contentType: string }) => Promise<void> },
    flowId: string,
    samples: { eventDurationMs: number[]; settleMs: number[] },
  ) {
    const result = budgets.evaluateFlow({
      flowId,
      device: 'desktop',
      samples,
      multiplier: budgets.getBudgetMultiplier(),
    });
    const report = budgets.formatReport([result]);
    console.info(`\n${report}\nsamples: ${JSON.stringify(samples)}`);
    await testInfo.attach(`latency-${flowId}`, { body: `${report}\n${JSON.stringify(samples)}`, contentType: 'text/plain' });
    expect(result.pass, `\n${report}`).toBe(true);
  }

  test('connect-account: entering an address responds within budget', async ({ page }, testInfo) => {
    await page.goto('/connect');
    expect(await supportsEventTiming(page)).toBe(true);

    const samples = await collectSamples(
      SAMPLES,
      async () => {
        const input = page.getByLabel('Stellar account address');
        await expect(input).toBeVisible();
        await input.fill(ALICE);
        const connect = page.getByRole('button', { name: 'Connect to Stellar account' });
        return measureInteraction(page, {
          action: () => connect.press('Enter'),
          settled: () => {
            const el = document.querySelector('[aria-label="Connected account"]');
            return Boolean(el && (el as HTMLElement).offsetParent !== null);
          },
          timeoutMs: 15_000,
        });
      },
      async () => {
        // Reload drops the in-memory session, returning to a fresh connect screen.
        await page.goto('/connect');
      },
    );

    await judge(testInfo, 'connect-account', samples);
  });

  test('section-navigation: opening another section responds within budget', async ({ page }, testInfo) => {
    await connectAndLeaveOverview(page, ALICE);

    const samples = await collectSamples(
      SAMPLES,
      () =>
        measureInteraction(page, {
          action: () => openSection(page, 'Network Info'),
          settled: () => {
            const main = document.querySelector('main');
            return location.pathname === '/network' && Boolean(main && main.textContent?.trim());
          },
          timeoutMs: 15_000,
        }),
      async () => {
        await openSection(page, 'Transactions');
        await expect(page).toHaveURL(/\/transactions/);
      },
    );

    await judge(testInfo, 'section-navigation', samples);
  });

  test('theme-toggle: switching theme responds within budget', async ({ page }, testInfo) => {
    await connectAndLeaveOverview(page, ALICE);

    const toggle = () => page.getByRole('button', { name: /^Switch to (dark|light) theme$/ });
    const currentTheme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? '');

    const samples = await collectSamples(
      SAMPLES,
      async () => {
        const before = await currentTheme();
        return measureInteraction(page, {
          action: () => toggle().click(),
          settled: (previous: string) => (document.documentElement.getAttribute('data-theme') ?? '') !== previous,
          arg: before,
          timeoutMs: 5_000,
        });
      },
      async () => {
        // Toggle back so every sample starts from the same theme (unmeasured).
        const before = await currentTheme();
        await toggle().click();
        await expect.poll(currentTheme).not.toBe(before);
      },
    );

    await judge(testInfo, 'theme-toggle', samples);
  });

  test('a flow whose action never reaches the page fails instead of passing', async ({ page }) => {
    await page.goto('/connect');
    await expect(
      measureInteraction(page, {
        action: async () => undefined, // no input event is ever dispatched
        settled: () => true,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/No input event was recorded/);
  });
});
