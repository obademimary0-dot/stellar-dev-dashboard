import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  ConformanceRunner,
  ConformanceError,
  defineConformanceSuite,
  runConformanceSuite,
} from '../../src/lib/wallet/conformance';
import type {
  WalletAdapter,
  WalletAdapterConformanceCase,
} from '../../src/lib/wallet/types';

function createFakeAdapter(): WalletAdapter {
  const listeners = new Set<(address: string | null) => void>();
  let connected = false;
  let address: string | null = null;

  const adapter: WalletAdapter = {
    id: 'fake-wallet',
    name: 'Fake Wallet',
    get connected() {
      return connected;
    },
    get address() {
      return address;
    },
    async connect() {
      connected = true;
      address = 'FAKEADDRESS11111111111111111111111111111111';
      for (const listener of listeners) {
        listener(address);
      }
      return { address };
    },
    async disconnect() {
      connected = false;
      address = null;
      for (const listener of listeners) {
        listener(null);
      }
    },
    async signMessage(message: string) {
      if (!connected) {
        throw new Error('Wallet not connected');
      }
      return { signature: `FAKE-SIG-${message.length}`, publicKey: 'FAKE-PKC' };
    },
    on(event: 'connect' | 'disconnect', listener: (address: string | null) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return adapter;
}

describe('wallet conformance suite', () => {
  let adapter: WalletAdapter;

  beforeEach(() => {
    adapter = createFakeAdapter();
  });

  afterEach(async () => {
    if (adapter.connected) {
      await adapter.disconnect();
    }
  });

  it('passes the happy path for a complete adapter', () => {
    const suite = defineConformanceSuite({
      name: 'fake-wallet-suite',
      adapter,
      cases: [
        {
          name: 'connects and reports address',
          async run(ctx) {
            const result = await ctx.adapter.connect();
            expect(result.address).toBeTruthy();
            expect(ctx.adapter.connected).toBe(true);
          },
        },
        {
          name: 'signs a message',
          async run(ctx) {
            await ctx.adapter.connect();
            const sig = await ctx.adapter.signMessage('hello');
            expect(sig.signature).toBeTruthy();
          },
        },
      ],
    });

    const report = runConformanceSuite(suite);
    expect(report.passed).toBeTruthy();
    expect(report.results.length).toBe(2);
  });

  it('handles a boundary case with an empty suite', () => {
    const suite = defineConformanceSuite({
      name: 'empty-suite',
      adapter,
      cases: [],
    });

    const report = runConformanceSuite(suite);
    expect(report.results).toHaveLength(0);
    expect(report.passed).toBe(true);
  });

  it('reports a failure when a case throws', () => {
    const suite = defineConformanceSuite({
      name: 'failing-suite',
      adapter,
      cases: [
        {
          name: 'signs without connecting',
          async run(ctx) {
            await ctx.adapter.signMessage('nope');
          },
        },
      ],
    });

    const report = runConformanceSuite(suite);
    expect(report.passed).toBe(false);
    expect(report.results[0].status).toBe('failed');
  });

  it('raises ConformanceError for invalid suite definitions', () => {
    expect(() =>
      defineConformanceSuite({
        name: '',
        adapter,
        cases: [],
      }),
    ).toThrow(ConformanceError);
  });

  it('runs cases through ConformanceRunner', () => {
    const runner = new ConformanceRunner(adapter);
    const conformanceCase: WalletAdapterConformanceCase = {
      name: 'connects',
      async run(ctx) {
        await ctx.adapter.connect();
        expect(ctx.adapter.connected).toBe(true);
      },
    };
    const result = runner.runCase(conformanceCase);
    expect(result.status).toBe('passed');
  });
});
