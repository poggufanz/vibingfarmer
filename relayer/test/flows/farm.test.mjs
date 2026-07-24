import { describe, it, expect, vi } from 'vitest';
import { createFarmFlow } from '../../src/flows/farm.mjs';

describe('farm', () => {
  it('publishes watcher-confirmed mint progress before dispatching deposits', async () => {
    const callOrder = [];
    const watcher = { relayMint: vi.fn(async () => { callOrder.push('relayMint'); return { status: 'minted', mintTxHash: '0xmint' }; }) };
    const orchestrator = { dispatchDeposits: vi.fn(async () => { callOrder.push('dispatchDeposits'); return [{ status: 'fulfilled', pool: '0xPoolA' }]; }) };
    const { farm } = createFarmFlow({ watcher, orchestrator, domains: { stellar: 27, base: 6 } });

    const result = await farm({
      burnTxHash: 'burn-1', execId: 'exec-1', approval: 'approval-blob',
      allocations: [{ pool: '0xPoolA', amount: 100n, minShares: 90n }],
      onMintConfirmed: vi.fn(async (mintResult) => {
        expect(mintResult).toEqual({ status: 'minted', mintTxHash: '0xmint' });
        callOrder.push('onMintConfirmed');
      }),
    });

    expect(callOrder).toEqual(['relayMint', 'onMintConfirmed', 'dispatchDeposits']);
    expect(result.mintResult).toEqual({ status: 'minted', mintTxHash: '0xmint' });
    expect(result.depositResults).toEqual([{ status: 'fulfilled', pool: '0xPoolA' }]);
    expect(watcher.relayMint).toHaveBeenCalledWith({ sourceDomain: 27, burnTxHash: 'burn-1', execId: 'exec-1' });
  });

  // VF Wallet Task 7: carries the run/bridge context httpRouter.mjs needs to write onto the job
  // record for My Money's durable index — echoed straight through, never touched by the flow
  // itself (farm.mjs has no opinion on what a runId/bridgeAgent/grantTxHash mean).
  it('echoes runId/bridgeAgent/grantTxHash through untouched, defaulting to null when omitted', async () => {
    const watcher = { relayMint: vi.fn(async () => ({ status: 'minted', mintTxHash: '0xmint' })) };
    const orchestrator = { dispatchDeposits: vi.fn(async () => [{ status: 'fulfilled', pool: '0xPoolA' }]) };
    const { farm } = createFarmFlow({ watcher, orchestrator, domains: { stellar: 27, base: 6 } });

    const withContext = await farm({
      burnTxHash: 'burn-1', execId: 'exec-1', approval: 'approval-blob',
      allocations: [{ pool: '0xPoolA', amount: 100n, minShares: 90n }],
      runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
    });
    expect(withContext).toMatchObject({ runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });

    const withoutContext = await farm({
      burnTxHash: 'burn-1', execId: 'exec-1', approval: 'approval-blob',
      allocations: [{ pool: '0xPoolA', amount: 100n, minShares: 90n }],
    });
    expect(withoutContext).toMatchObject({ runId: null, bridgeAgent: null, grantTxHash: null });
  });
});
