// Task 8 RED extension — farm flow must propagate the immutable canonical expectation into
// relayMint (plan mismatch #3) and must refuse to dispatch deposits unless the watcher
// returned CONFIRMED mint evidence ('minted' or 'already-minted'). An 'in-progress',
// 'mint_submitted', 'attestation_pending', 'blocked', or 'uncertain' shape is never mint
// evidence, no matter how it is spelled.
//
// The two pre-existing tests survive with one modification: farm() now takes `expectation`
// and forwards it to watcher.relayMint (the old calledWith assertion without expectation is
// a documented victim of the contract change).

import { describe, it, expect, vi } from 'vitest';
import { createFarmFlow } from '../../src/flows/farm.mjs';

const ZERO32 = '00'.repeat(32);

// Canonical forward expectation (task-8 schema; same literal as the store/watcher suites).
const FORWARD_EXPECTATION = {
  version: 1,
  direction: 'stellar-to-base',
  sourceDomain: 27,
  destinationDomain: 6,
  sender: '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8',
  recipient: '0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  destinationCaller: `0x${ZERO32}`,
  burnToken: '0x5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01',
  mintRecipient: '0x0000000000000000000000000123456789abcdef0123456789abcdef01234567',
  messageSender: '0xabababababababababababababababababababababababababababababababab',
  amount: '1000000',
  burnUnits7: '10000000',
  maxFee: '0',
  minFinalityThreshold: 2000,
  hookData: '0x',
};

const BURN_FORWARD = 'aa'.repeat(32);

function buildFlow({
  mintResult = { status: 'minted', mintTxHash: '0xmint' }, callOrder = [], recoveryEvidence = null,
} = {}) {
  const watcher = {
    relayMint: vi.fn(async () => { callOrder.push('relayMint'); return mintResult; }),
    getRecoveryEvidence: recoveryEvidence
      ? vi.fn(() => recoveryEvidence)
      : undefined,
  };
  const orchestrator = {
    dispatchDeposits: vi.fn(async () => {
      callOrder.push('dispatchDeposits');
      return [{ status: 'fulfilled', pool: '0xPoolA' }];
    }),
  };
  const flow = createFarmFlow({ watcher, orchestrator, domains: { stellar: 27, base: 6 } });
  return { flow, watcher, orchestrator, callOrder };
}

const farmArgs = (overrides = {}) => ({
  burnTxHash: BURN_FORWARD,
  execId: 'exec-1',
  approval: 'approval-blob',
  expectation: FORWARD_EXPECTATION,
  allocations: [{ pool: '0xPoolA', amount: 100n, minShares: 90n }],
  ...overrides,
});

describe('farm', () => {
  it('recovers mixed children in order by confirming submitted and dispatching only never-started', async () => {
    const callOrder = [];
    const { flow, orchestrator } = buildFlow({ callOrder });
    orchestrator.reconcileSubmittedDeposit = vi.fn(async (_approval, allocation, hash) => {
      callOrder.push(`confirm:${allocation.identity.allocationId}:${hash}`);
      return { identity: allocation.identity, status: 'fulfilled', userOpHash: hash };
    });
    orchestrator.dispatchDeposits.mockImplementation(async (_approval, allocations) => {
      callOrder.push(`dispatch:${allocations[0].identity.allocationId}`);
      return [{ identity: allocations[0].identity, status: 'fulfilled' }];
    });
    const allocation = (id) => ({
      identity: {
        networkId: 'stellar-testnet', bindingId: 'binding-42',
        executionId: `run-42:exec:${id}`, allocationId: id, childId: 'child-42',
      },
      caller: '0x00000000000000000000000000000000000000aa',
      pool: '0x00000000000000000000000000000000000000b2', amount: 100n, minShares: 90n,
    });
    const submittedHash = `0x${'ab'.repeat(32)}`;
    const onCheckpoint = vi.fn(async () => {});

    const result = await flow.recoverDeposits({
      approval: 'approval-blob',
      children: [
        { allocation: allocation('confirmed'), recovery: { phase: 'base_deposit', state: 'confirmed' } },
        { allocation: allocation('submitted'), recovery: {
          phase: 'base_deposit', state: 'submitted', evidence: { userOpHash: submittedHash },
        } },
        { allocation: allocation('fresh'), recovery: { phase: 'cctp_mint', state: 'confirmed' } },
      ],
      onCheckpoint,
    });

    expect(callOrder).toEqual([
      `confirm:submitted:${submittedHash}`,
      'dispatch:fresh',
    ]);
    expect(orchestrator.reconcileSubmittedDeposit).toHaveBeenCalledTimes(1);
    expect(orchestrator.dispatchDeposits).toHaveBeenCalledTimes(1);
    expect(orchestrator.dispatchDeposits.mock.calls[0][1]).toEqual([allocation('fresh')]);
    expect(result.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  });

  it.each(['submitting', 'unknown'])(
    'holds %s and every later never-started child without confirming or sending',
    async (state) => {
      const { flow, orchestrator } = buildFlow();
      orchestrator.reconcileSubmittedDeposit = vi.fn();
      const allocation = (id) => ({
        identity: {
          networkId: 'stellar-testnet', bindingId: 'binding-42',
          executionId: `run-42:exec:${id}`, allocationId: id, childId: 'child-42',
        },
        caller: '0x00000000000000000000000000000000000000aa',
        pool: '0x00000000000000000000000000000000000000b2', amount: 100n, minShares: 90n,
      });
      const results = await flow.recoverDeposits({
        approval: 'approval-blob',
        children: [
          { allocation: allocation('ambiguous'), recovery: { phase: 'base_deposit', state } },
          { allocation: allocation('fresh'), recovery: { phase: 'cctp_mint', state: 'confirmed' } },
        ],
        onCheckpoint: vi.fn(),
      });

      expect(orchestrator.reconcileSubmittedDeposit).not.toHaveBeenCalled();
      expect(orchestrator.dispatchDeposits).not.toHaveBeenCalled();
      expect(results.map(({ status }) => status)).toEqual(['uncertain', 'held']);
    },
  );

  it('adds the watcher safe recovery summary only to the awaited mint checkpoint', async () => {
    const recoveryEvidence = {
      burnTxHash: BURN_FORWARD, expectationDigest: 'expectation', messageDigest: 'message',
      attestationDigest: 'attestation', evidenceVersion: '1', mintTxHash: '0xmint',
    };
    const { flow, watcher } = buildFlow({ recoveryEvidence });
    const onMintConfirmed = vi.fn();

    const result = await flow.farm(farmArgs({ onMintConfirmed }));

    expect(watcher.getRecoveryEvidence).toHaveBeenCalledWith('exec-1');
    expect(onMintConfirmed).toHaveBeenCalledWith({
      status: 'minted', mintTxHash: '0xmint', evidence: recoveryEvidence,
    });
    expect(result.mintResult).toEqual({ status: 'minted', mintTxHash: '0xmint' });
  });

  it('forwards the exact deposit checkpoint callback and allocation identity after mint persistence', async () => {
    const callOrder = [];
    const { flow, orchestrator } = buildFlow({ callOrder });
    const identity = {
      networkId: 'stellar-testnet', bindingId: 'binding-42',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3', childId: 'child-42',
    };
    const allocations = [{
      identity, caller: '0x00000000000000000000000000000000000000aa',
      pool: '0x00000000000000000000000000000000000000b2', amount: 100n, minShares: 90n,
    }];
    const onDepositCheckpoint = vi.fn(async () => {});

    await flow.farm(farmArgs({
      allocations,
      onMintConfirmed: async () => callOrder.push('mint-persisted'),
      onDepositCheckpoint,
    }));

    expect(callOrder).toEqual(['relayMint', 'mint-persisted', 'dispatchDeposits']);
    expect(orchestrator.dispatchDeposits).toHaveBeenCalledWith(
      'approval-blob', allocations, { onCheckpoint: onDepositCheckpoint },
    );
  });
  it('publishes watcher-confirmed mint progress before dispatching deposits', async () => {
    const callOrder = [];
    const { flow, watcher } = buildFlow({ callOrder });

    const result = await flow.farm(farmArgs({
      onMintConfirmed: vi.fn(async (mintResult) => {
        expect(mintResult).toEqual({ status: 'minted', mintTxHash: '0xmint' });
        callOrder.push('onMintConfirmed');
      }),
    }));

    expect(callOrder).toEqual(['relayMint', 'onMintConfirmed', 'dispatchDeposits']);
    expect(result.mintResult).toEqual({ status: 'minted', mintTxHash: '0xmint' });
    expect(result.depositResults).toEqual([{ status: 'fulfilled', pool: '0xPoolA' }]);
    expect(watcher.relayMint).toHaveBeenCalledWith({
      sourceDomain: 27, burnTxHash: BURN_FORWARD, execId: 'exec-1',
      expectation: FORWARD_EXPECTATION,
    });
  });

  // VF Wallet Task 7: carries the run/bridge context httpRouter.mjs needs to write onto the job
  // record for My Money's durable index — echoed straight through, never touched by the flow
  // itself (farm.mjs has no opinion on what a runId/bridgeAgent/grantTxHash mean).
  it('echoes runId/bridgeAgent/grantTxHash through untouched, defaulting to null when omitted', async () => {
    const { flow } = buildFlow();

    const withContext = await flow.farm(farmArgs({
      runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT',
    }));
    expect(withContext).toMatchObject({ runId: 'run-42', bridgeAgent: 'CBRIDGE', grantTxHash: 'HGRANT' });

    const withoutContext = await flow.farm(farmArgs());
    expect(withoutContext).toMatchObject({ runId: null, bridgeAgent: null, grantTxHash: null });
  });

  // Regression caught (plan mismatch #3): farm called relayMint with no expectation, so the
  // mint was relayed against no immutable intent while deposits dispatched against real funds.
  it('passes the immutable canonical expectation into relayMint', async () => {
    const { flow, watcher } = buildFlow();
    await flow.farm(farmArgs());
    expect(watcher.relayMint).toHaveBeenCalledTimes(1);
    const relayArgs = watcher.relayMint.mock.calls[0][0];
    expect(relayArgs.expectation).toEqual(FORWARD_EXPECTATION);
  });

  it('refuses to call the watcher at all without an expectation', async () => {
    const { flow, watcher, orchestrator } = buildFlow();
    await expect(flow.farm(farmArgs({ expectation: undefined })))
      .rejects.toMatchObject({ code: 'RELAY_VALIDATION' });
    expect(watcher.relayMint).not.toHaveBeenCalled();
    expect(orchestrator.dispatchDeposits).not.toHaveBeenCalled();
  });

  it('dispatches deposits when the watcher reports already-minted (confirmed evidence)', async () => {
    const { flow, orchestrator } = buildFlow({
      mintResult: { status: 'already-minted', mintTxHash: '0xmint' },
    });
    const result = await flow.farm(farmArgs());
    expect(result.depositResults).toEqual([{ status: 'fulfilled', pool: '0xPoolA' }]);
    expect(orchestrator.dispatchDeposits).toHaveBeenCalledTimes(1);
  });

  // Regression caught: ANY non-confirmed watcher shape (a concurrent join, a pending
  // attestation, a retained submission, an uncertain or blocked record) fell through to
  // dispatchDeposits, deploying user funds against an unproven mint.
  it.each([
    ['in-progress', { status: 'in-progress' }],
    ['attestation_pending', { status: 'attestation_pending' }],
    ['mint_submitted', { status: 'mint_submitted', mintTxHash: '0xmint' }],
    ['blocked', { status: 'blocked', reasonCode: 'message_mismatch' }],
    ['uncertain', { status: 'uncertain', reasonCode: 'submission_unknown' }],
  ])('refuses to dispatch deposits when the watcher returns %s', async (_label, mintResult) => {
    const onMintConfirmed = vi.fn();
    const { flow, orchestrator } = buildFlow({ mintResult });
    await expect(flow.farm(farmArgs({ onMintConfirmed })))
      .rejects.toMatchObject({ code: 'FARM_MINT_UNCONFIRMED' });
    expect(orchestrator.dispatchDeposits).not.toHaveBeenCalled();
    // the progress callback only ever fires with CONFIRMED mint evidence
    expect(onMintConfirmed).not.toHaveBeenCalled();
  });
});
