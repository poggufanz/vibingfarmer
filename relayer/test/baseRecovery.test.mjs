import { describe, expect, it, vi } from 'vitest';
import {
  computeBaseRecoveryWorkId,
  createBaseRecoveryExecutor,
  selectBaseChildRecoveryAction,
  validateBaseRecoveryBundle,
  validateBaseRecoveryRequest,
} from '../src/baseRecovery.mjs';

const IDENTITY = Object.freeze({
  networkId: 'stellar-testnet',
  bindingId: '0123456789abcdef0123456789abcdef',
  executionId: 'run-42:exec:run-42:bridge:aave-v3',
  allocationId: 'run-42:bridge:aave-v3',
  childId: 'abcdef0123456789abcdef0123456789',
});
const OWNER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const AGENT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const RECOVERY_IDENTITY_FIELDS = ['networkId', 'bindingId', 'executionId', 'allocationId', 'childId'];

function baseBundle(events = []) {
  const phases = {
    cctp_burn: null,
    cctp_attestation: null,
    cctp_mint: null,
    base_deposit: null,
    base_position: null,
  };
  for (const event of events) phases[event.phase] = event;
  return {
    schemaVersion: 1,
    identity: IDENTITY,
    owner: OWNER,
    agent: AGENT,
    recoverable: true,
    recoveryVersion: events.length,
    intent: {
      runId: 'run-42',
      grantTxHash: '66'.repeat(32),
      bindingHash: 'dd'.repeat(32),
      baseJobId: IDENTITY.childId,
      kernelAddress: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      proxyTarget: 'aave-v3',
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      minShares: '900000',
    },
    phases,
    events,
  };
}

function event(phase, state, recoveryVersion, evidence = {}) {
  return {
    identity: IDENTITY,
    phase,
    state,
    evidence,
    recoveryVersion,
    eventId: `${String(recoveryVersion).padStart(2, '0')}`.repeat(32),
    observedAt: 2_000_000_000_000 + recoveryVersion,
  };
}

function recoveryClaimLease({
  action = 'poll-mint',
  phase = 'cctp_mint',
  evidenceVersion = 3,
  leaseToken = 'aa'.repeat(32),
} = {}) {
  return {
    identity: IDENTITY,
    owner: OWNER,
    action,
    phase,
    evidenceVersion,
    holder: 'tab',
    leaseToken,
    acquiredAt: 0,
    expiresAt: 2_000_000_000_000,
  };
}

describe('Base recovery selector and durable executor seam', () => {
  it('returns no-movement for an exact child with no phase evidence', () => {
    expect(selectBaseChildRecoveryAction(baseBundle())).toMatchObject({
      action: 'no-movement',
      phase: null,
      reasonCode: 'base-no-movement',
    });
  });

  it('polls attestation after confirmed burn and never invents a burn action', () => {
    const selected = selectBaseChildRecoveryAction(
      baseBundle([
        event('cctp_burn', 'confirmed', 1, {
          burnTxHash: '66'.repeat(32),
          expectationDigest: '77'.repeat(32),
          burnUnits7: '10000000',
          messageDigest: '0x' + '88'.repeat(32),
          nonce: '0x' + '77'.repeat(32),
        }),
      ]),
    );
    expect(selected).toMatchObject({
      action: 'poll-attestation',
      phase: 'cctp_attestation',
    });
    expect(selected.action).not.toBe('burn');
  });

  it('submits mint only after exact attestation evidence and then selects Base deposit', () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation]))).toMatchObject({
      action: 'submit-mint',
      phase: 'cctp_mint',
    });
    const mint = event('cctp_mint', 'confirmed', 3, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
      mintTxHash: '0x' + 'aa'.repeat(32),
    });
    expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation, mint]))).toMatchObject({
      action: 'submit-base-deposit',
      phase: 'base_deposit',
    });
  });

  it('accepts the Agent Index array-projection bundle and binds event subjects', () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const subjects = { owner: OWNER, agent: AGENT };
    const bundle = {
      ...baseBundle(),
      recoveryVersion: 2,
      phases: [burn, attestation],
      events: [
        { ...burn, ...subjects },
        { ...attestation, ...subjects },
      ],
    };
    expect(selectBaseChildRecoveryAction(bundle)).toMatchObject({
      action: 'submit-mint',
      phase: 'cctp_mint',
    });
  });

  it.each([
    ['expectation digest', { expectationDigest: '55'.repeat(32) }],
    ['burn amount', { burnUnits7: '9999999' }],
  ])('rejects a same-phase immutable %s mutation hidden by the latest projection', (_label, mutation) => {
    const submitted = event('cctp_burn', 'submitted', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
    });
    const confirmed = event('cctp_burn', 'confirmed', 2, {
      ...submitted.evidence,
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      ...mutation,
    });
    expect(selectBaseChildRecoveryAction(baseBundle([submitted, confirmed]))).toMatchObject({
      action: 'manual-review',
      phase: null,
    });
  });

  it('requires confirmed Base deposit amount bounds to equal the reviewed intent', () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const mint = event('cctp_mint', 'confirmed', 3, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
      mintTxHash: '0x' + 'aa'.repeat(32),
    });
    const deposit = (overrides = {}) => {
      const evidence = {
        chainId: '84532',
        yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
        caller: '0x00000000000000000000000000000000000000aa',
        poolAddress: '0x00000000000000000000000000000000000000b2',
        assets: '1000000',
        minShares: '900000',
        shares: '900001',
        userOpHash: '0x' + 'bb'.repeat(32),
        transactionHash: '0x' + 'cc'.repeat(32),
        ...overrides,
      };
      evidence.event = {
        address: evidence.yieldRouterAddress,
        topic0: '0x' + '12'.repeat(32),
        logIndex: '0',
        caller: evidence.caller,
        poolAddress: evidence.poolAddress,
        assets: evidence.assets,
        shares: evidence.shares,
      };
      return event('base_deposit', 'confirmed', 4, evidence);
    };
    expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation, mint, deposit()]))).toMatchObject({
      action: 'complete',
      phase: null,
    });
    for (const changed of [{ assets: '1000001' }, { minShares: '800000' }]) {
      expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation, mint, deposit(changed)]))).toMatchObject({
        action: 'manual-review',
        phase: null,
      });
    }
  });

  it('rejects malformed identity/version/token requests before network use', () => {
    expect(
      validateBaseRecoveryRequest({
        mandateId: '22'.repeat(16),
        identity: IDENTITY,
        action: 'submit-mint',
        evidenceVersion: 7,
        leaseToken: 'aa'.repeat(32),
      }),
    ).toMatchObject({ mandateId: '22'.repeat(16), action: 'submit-mint' });
    expect(() =>
      validateBaseRecoveryRequest({
        mandateId: '22'.repeat(16),
        identity: { ...IDENTITY, executionId: 'wrong' },
        action: 'submit-mint',
        evidenceVersion: 7,
        leaseToken: 'aa'.repeat(32),
      }),
    ).toThrow();
    expect(() =>
      validateBaseRecoveryRequest({
        mandateId: '22'.repeat(16),
        identity: IDENTITY,
        action: 'burn',
        evidenceVersion: 7,
        leaseToken: 'aa'.repeat(32),
      }),
    ).toThrow();
  });

  it('uses the literal deterministic work ID tuple', () => {
    expect(
      computeBaseRecoveryWorkId({
        identity: IDENTITY,
        evidenceVersion: 7,
        action: 'submit-mint',
      }),
    ).toBe('0a3fcbe288b70e792df216a67870ce6291c0401017ed0a3401b6d32524a655d9');
  });

  it('routes a poll action through only its narrow injected operation', async () => {
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'poll-mint',
        evidenceVersion: 3,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(32),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const bundle = baseBundle([
      event('cctp_burn', 'confirmed', 1, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        burnUnits7: '10000000',
        messageDigest: '0x' + '88'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
      }),
      event('cctp_attestation', 'confirmed', 2, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
        evidenceVersion: '1',
      }),
      event('cctp_mint', 'submitting', 3, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
      }),
    ]);
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-mint-pending',
        identity: IDENTITY,
        action: 'poll-mint',
        phase: 'cctp_mint',
        evidenceVersion: 3,
        lease: recoveryClaimLease(),
        bundle,
      })),
      renewBaseRecoveryClaim: vi.fn(async () => ({})),
    };
    const pollMint = vi.fn(async () => ({ state: 'done' }));
    const executor = createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { pollMint },
      now: () => 1000,
    });
    await executor.run('w');
    expect(pollMint).toHaveBeenCalledTimes(1);
  });

  it('preserves post-burn recovery but gates Base deposit sends on a fresh active mandate', async () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const mint = event('cctp_mint', 'confirmed', 3, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
      mintTxHash: '0x' + 'aa'.repeat(32),
    });
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'submit-base-deposit',
        evidenceVersion: 3,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(32),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-mint-confirmed',
        identity: IDENTITY,
        action: 'submit-base-deposit',
        phase: 'base_deposit',
        evidenceVersion: 3,
        lease: recoveryClaimLease({
          action: 'submit-base-deposit',
          phase: 'base_deposit',
        }),
        bundle: baseBundle([burn, attestation, mint]),
      })),
      renewBaseRecoveryClaim: vi.fn(async () => ({})),
    };
    const submitBaseDeposit = vi.fn(async () => ({ state: 'done' }));
    const projectBaseDepositOwnerAction = vi.fn(async () => ({
      state: 'owner_action_required',
      reasonCode: 'base-deposit-failed-kernel-custody',
    }));
    const executor = createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { submitBaseDeposit, projectBaseDepositOwnerAction },
      freshActiveMandateGate: async () => ({ active: false }),
      now: () => 1000,
    });
    await executor.run('w');
    expect(submitBaseDeposit).not.toHaveBeenCalled();
    expect(projectBaseDepositOwnerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: IDENTITY,
        action: 'submit-base-deposit',
        evidenceVersion: 3,
        reasonCode: 'mandate_inactive',
      }),
    );
    expect(workStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'owner_action_required',
        reasonCode: 'mandate_inactive',
      }),
    );
  });

  it('selects owner action only after public failed evidence proves Base Kernel custody', () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const mint = event('cctp_mint', 'confirmed', 3, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
      mintTxHash: '0x' + 'aa'.repeat(32),
    });
    const failedDeposit = event('base_deposit', 'failed', 4, {
      chainId: '84532',
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      caller: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      assets: '1000000',
      minShares: '900000',
      userOpHash: '0x' + 'bb'.repeat(32),
      transactionHash: '0x' + 'cc'.repeat(32),
      reasonCode: 'base-deposit-failed-kernel-custody',
      custodyLocation: 'base-kernel',
      kernelCustodyConfirmed: true,
      custody: { location: 'base-kernel', confirmed: true },
    });
    expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation, mint, failedDeposit]))).toEqual({
      action: 'owner-action-required',
      phase: null,
      reasonCode: 'base-deposit-failed-kernel-custody',
    });
    const blockedWithoutDepositHash = event('base_deposit', 'blocked', 4, {
      chainId: '84532',
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      caller: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      assets: '1000000',
      minShares: '900000',
      reasonCode: 'mandate_inactive',
      custodyLocation: 'base-kernel',
      kernelCustodyConfirmed: true,
      custody: { location: 'base-kernel', confirmed: true },
    });
    expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation, mint, blockedWithoutDepositHash]))).toEqual({
      action: 'owner-action-required',
      phase: null,
      reasonCode: 'base-deposit-failed-kernel-custody',
    });
  });

  it('accepts the real Task 10 nested Base deposit reconcile handle', () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const mint = event('cctp_mint', 'confirmed', 3, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
      mintTxHash: '0x' + 'aa'.repeat(32),
    });
    const baseDeposit = event('base_deposit', 'submitting', 4, {
      chainId: '84532',
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      caller: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      assets: '1000000',
      minShares: '900000',
      reconcileHandle: {
        entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
        sender: '0x00000000000000000000000000000000000000aa',
        nonce: '17',
        startBlock: '4321',
      },
    });
    expect(selectBaseChildRecoveryAction(baseBundle([burn, attestation, mint, baseDeposit]))).toEqual({
      action: 'poll-base-deposit',
      phase: 'base_deposit',
      reasonCode: 'base-deposit-pending',
    });
  });

  it('rejects a phase-inappropriate evidence field instead of accepting the broad union', () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      userOpHash: '0x' + 'aa'.repeat(32),
    });
    expect(() => validateBaseRecoveryBundle(baseBundle([burn]))).toThrow(/phase|evidence|allowlisted/i);
  });

  it('passes the nested handle unchanged into the confirm-only executor seam', async () => {
    const burn = event('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = event('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const mint = event('cctp_mint', 'confirmed', 3, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
      mintTxHash: '0x' + 'aa'.repeat(32),
    });
    const baseDeposit = event('base_deposit', 'submitting', 4, {
      chainId: '84532',
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      caller: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      assets: '1000000',
      minShares: '900000',
      reconcileHandle: {
        entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
        sender: '0x00000000000000000000000000000000000000aa',
        nonce: '17',
        startBlock: '4321',
      },
    });
    const bundle = baseBundle([burn, attestation, mint, baseDeposit]);
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'poll-base-deposit',
        evidenceVersion: 4,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(64),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-deposit-pending',
        identity: IDENTITY,
        action: 'poll-base-deposit',
        phase: 'base_deposit',
        evidenceVersion: 4,
        lease: recoveryClaimLease({
          action: 'poll-base-deposit',
          phase: 'base_deposit',
          evidenceVersion: 4,
        }),
        bundle,
      })),
      renewBaseRecoveryClaim: vi.fn(async () => ({})),
    };
    const pollBaseDeposit = vi.fn(async ({ bundle: input }) => ({
      state: 'done',
      checkpointRef: input.events.at(-1).evidence.reconcileHandle.startBlock,
    }));
    await createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { pollBaseDeposit },
      now: () => 1000,
    }).run('w');
    expect(pollBaseDeposit).toHaveBeenCalledTimes(1);
    expect(pollBaseDeposit.mock.calls[0][0].bundle.events.at(-1).evidence.reconcileHandle).toEqual(
      baseDeposit.evidence.reconcileHandle,
    );
  });

  it('exposes a deterministic dual-lease pre-send renewal callback to narrow operations', async () => {
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'submit-mint',
        evidenceVersion: 2,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(64),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const bundle = baseBundle([
      event('cctp_burn', 'confirmed', 1, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        burnUnits7: '10000000',
        messageDigest: '0x' + '88'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
      }),
      event('cctp_attestation', 'confirmed', 2, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
        evidenceVersion: '1',
      }),
    ]);
    let remoteRenewals = 0;
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-attestation-confirmed',
        identity: IDENTITY,
        action: 'submit-mint',
        phase: 'cctp_mint',
        evidenceVersion: 2,
        lease: recoveryClaimLease({
          action: 'submit-mint',
          evidenceVersion: 2,
        }),
        bundle,
      })),
      renewBaseRecoveryClaim: vi.fn(async () => {
        remoteRenewals += 1;
        return {};
      }),
    };
    let sendCount = 0;
    const submitMint = vi.fn(async ({ renewAuthority }) => {
      await renewAuthority();
      sendCount += 1;
      return { state: 'done' };
    });
    await createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { submitMint },
      now: () => 1000,
    }).run('w');
    expect(submitMint).toHaveBeenCalledTimes(1);
    expect(remoteRenewals).toBe(2);
    expect(workStore.heartbeat).toHaveBeenCalledTimes(2);
    expect(sendCount).toBe(1);
  });

  it('does not permit a narrow send after either pre-send lease renewal fails', async () => {
    for (const failure of ['remote', 'local']) {
      const workStore = {
        get: vi.fn(() => ({
          workId: 'w',
          identity: IDENTITY,
          action: 'submit-mint',
          evidenceVersion: 2,
          state: 'pending',
          claimToken: 'aa'.repeat(32),
        })),
        claim: vi.fn(() => ({
          leaseOwner: 'worker',
          leaseToken: 'bb'.repeat(64),
        })),
        heartbeat: vi.fn(() =>
          failure === 'local' && workStore.heartbeat.mock.calls.length > 1 ? null : { state: 'running' },
        ),
        finish: vi.fn((input) => ({ ...input, state: input.state })),
        hold: vi.fn((input) => ({ ...input, state: 'held' })),
      };
      let remoteCalls = 0;
      const reporter = {
        readBaseRecoveryClaim: vi.fn(async () => ({
          ok: true,
          reasonCode: 'base-attestation-confirmed',
          identity: IDENTITY,
          action: 'submit-mint',
          phase: 'cctp_mint',
          evidenceVersion: 2,
          lease: recoveryClaimLease({
            action: 'submit-mint',
            evidenceVersion: 2,
          }),
          bundle: baseBundle([
            event('cctp_burn', 'confirmed', 1, {
              burnTxHash: '66'.repeat(32),
              expectationDigest: '77'.repeat(32),
              burnUnits7: '10000000',
              messageDigest: '0x' + '88'.repeat(32),
              nonce: '0x' + '77'.repeat(32),
            }),
            event('cctp_attestation', 'confirmed', 2, {
              burnTxHash: '66'.repeat(32),
              expectationDigest: '77'.repeat(32),
              messageDigest: '0x' + '88'.repeat(32),
              attestationDigest: '0x' + '99'.repeat(32),
              nonce: '0x' + '77'.repeat(32),
              evidenceVersion: '1',
            }),
          ]),
        })),
        renewBaseRecoveryClaim: vi.fn(async () => {
          remoteCalls += 1;
          if (failure === 'remote' && remoteCalls > 1) {
            throw Object.assign(new Error('remote lease lost'), {
              code: 'RECOVERY_LEASE_CONFLICT',
            });
          }
          return {};
        }),
      };
      let sendCount = 0;
      const submitMint = vi.fn(async ({ renewAuthority }) => {
        try {
          await renewAuthority();
        } catch {
          return { state: 'held', reasonCode: 'pre-send-lease-lost' };
        }
        sendCount += 1;
        return { state: 'done' };
      });
      await createBaseRecoveryExecutor({
        workStore,
        reporter,
        operations: { submitMint },
        now: () => 1000,
      }).run('w');
      expect(sendCount).toBe(0);
      expect(workStore.finish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'done' }));
    }
  });

  it('releases the remote claim after a retryable poll and keeps durable work held', async () => {
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'poll-mint',
        evidenceVersion: 3,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(64),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      hold: vi.fn((input) => ({ ...input, state: 'held' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const releaseBaseRecoveryClaim = vi.fn(async () => ({}));
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-mint-pending',
        identity: IDENTITY,
        action: 'poll-mint',
        phase: 'cctp_mint',
        evidenceVersion: 3,
        lease: recoveryClaimLease(),
        bundle: baseBundle([
          event('cctp_burn', 'confirmed', 1, {
            burnTxHash: '66'.repeat(32),
            expectationDigest: '77'.repeat(32),
            burnUnits7: '10000000',
            messageDigest: '0x' + '88'.repeat(32),
            nonce: '0x' + '77'.repeat(32),
          }),
          event('cctp_attestation', 'confirmed', 2, {
            burnTxHash: '66'.repeat(32),
            expectationDigest: '77'.repeat(32),
            messageDigest: '0x' + '88'.repeat(32),
            attestationDigest: '0x' + '99'.repeat(32),
            nonce: '0x' + '77'.repeat(32),
            evidenceVersion: '1',
          }),
          event('cctp_mint', 'submitted', 3, {
            burnTxHash: '66'.repeat(32),
            expectationDigest: '77'.repeat(32),
            messageDigest: '0x' + '88'.repeat(32),
            attestationDigest: '0x' + '99'.repeat(32),
            nonce: '0x' + '77'.repeat(32),
            evidenceVersion: '1',
            mintTxHash: '0x' + 'aa'.repeat(32),
          }),
        ]),
      })),
      renewBaseRecoveryClaim: vi.fn(async () => ({})),
      releaseBaseRecoveryClaim,
    };
    const pollMint = vi.fn(async () => ({
      state: 'held',
      reasonCode: 'confirmation-pending',
    }));
    const outcome = await createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { pollMint },
      now: () => 1000,
    }).run('w');
    expect(outcome.state).toBe('held');
    expect(workStore.hold).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'confirmation-pending',
      }),
    );
    expect(releaseBaseRecoveryClaim).toHaveBeenCalledWith({
      identity: IDENTITY,
      action: 'poll-mint',
      evidenceVersion: 3,
      leaseToken: 'aa'.repeat(32),
    });
  });

  it('maps an explicit retryable operation result to held durable work', async () => {
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'poll-mint',
        evidenceVersion: 3,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(64),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      hold: vi.fn((input) => ({ ...input, state: 'held' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-mint-pending',
        identity: IDENTITY,
        action: 'poll-mint',
        phase: 'cctp_mint',
        evidenceVersion: 3,
        lease: recoveryClaimLease(),
        bundle: baseBundle([
          event('cctp_burn', 'confirmed', 1, {
            burnTxHash: '66'.repeat(32),
            expectationDigest: '77'.repeat(32),
            burnUnits7: '10000000',
            messageDigest: '0x' + '88'.repeat(32),
            nonce: '0x' + '77'.repeat(32),
          }),
          event('cctp_attestation', 'confirmed', 2, {
            burnTxHash: '66'.repeat(32),
            expectationDigest: '77'.repeat(32),
            messageDigest: '0x' + '88'.repeat(32),
            attestationDigest: '0x' + '99'.repeat(32),
            nonce: '0x' + '77'.repeat(32),
            evidenceVersion: '1',
          }),
          event('cctp_mint', 'submitted', 3, {
            burnTxHash: '66'.repeat(32),
            expectationDigest: '77'.repeat(32),
            messageDigest: '0x' + '88'.repeat(32),
            attestationDigest: '0x' + '99'.repeat(32),
            nonce: '0x' + '77'.repeat(32),
            evidenceVersion: '1',
            mintTxHash: '0x' + 'aa'.repeat(32),
          }),
        ]),
      })),
      renewBaseRecoveryClaim: vi.fn(async () => ({})),
      releaseBaseRecoveryClaim: vi.fn(async () => ({})),
    };
    const pollMint = vi.fn(async () => ({
      state: 'retryable',
      reasonCode: 'confirmation-pending',
    }));
    const outcome = await createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { pollMint },
      now: () => 1000,
    }).run('w');
    expect(outcome.state).toBe('held');
    expect(workStore.hold).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'confirmation-pending',
      }),
    );
  });

  it('re-reads local authority before any recovery seam and blocks immutable farm drift', async () => {
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'poll-mint',
        evidenceVersion: 3,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
        farmIntentDigest: 'ee'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'bb'.repeat(64),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const bundle = baseBundle([
      event('cctp_burn', 'confirmed', 1, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        burnUnits7: '10000000',
        messageDigest: '0x' + '88'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
      }),
      event('cctp_attestation', 'confirmed', 2, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
        evidenceVersion: '1',
      }),
      event('cctp_mint', 'submitted', 3, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
        evidenceVersion: '1',
        mintTxHash: '0x' + 'aa'.repeat(32),
      }),
    ]);
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => ({
        ok: true,
        reasonCode: 'base-mint-pending',
        identity: IDENTITY,
        action: 'poll-mint',
        phase: 'cctp_mint',
        evidenceVersion: 3,
        lease: recoveryClaimLease(),
        bundle,
      })),
      renewBaseRecoveryClaim: vi.fn(async () => ({})),
      releaseBaseRecoveryClaim: vi.fn(async () => ({})),
    };
    const pollMint = vi.fn(async () => ({ state: 'done' }));
    const outcome = await createBaseRecoveryExecutor({
      workStore,
      reporter,
      operations: { pollMint },
      localRecoveryGuard: async () => ({ valid: false }),
      now: () => 1000,
    }).run('w');
    expect(outcome).toMatchObject({
      state: 'blocked',
      reasonCode: 'base-recovery-local-authority-conflict',
    });
    expect(pollMint).not.toHaveBeenCalled();
  });

  it.each([
    ...RECOVERY_IDENTITY_FIELDS.map((field) => [
      `claim identity ${field}`,
      (claim) => ({
        ...claim,
        identity: {
          ...claim.identity,
          [field]: `${claim.identity[field]}-drift`,
        },
      }),
    ]),
    ['claim evidence version', (claim) => ({ ...claim, evidenceVersion: 4 })],
    [
      'claim action',
      (claim) => ({
        ...claim,
        action: 'poll-attestation',
        phase: 'cctp_attestation',
      }),
    ],
    [
      'claim lease token',
      (claim) => ({
        ...claim,
        lease: { ...claim.lease, leaseToken: 'bb'.repeat(32) },
      }),
    ],
    [
      'claim lease holder',
      (claim) => ({
        ...claim,
        lease: { ...claim.lease, holder: '' },
      }),
    ],
    [
      'expired claim at the validation boundary',
      (claim) => ({
        ...claim,
        lease: { ...claim.lease, expiresAt: 1000 },
      }),
    ],
    [
      'claim bundle identity',
      (claim) => ({
        ...claim,
        bundle: {
          ...claim.bundle,
          identity: { ...claim.bundle.identity, childId: 'drift-child' },
        },
      }),
    ],
  ])('rejects an injected authoritative claim mismatch before any renewal or operation: %s', async (_label, mutate) => {
    const bundle = baseBundle([
      event('cctp_burn', 'confirmed', 1, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        burnUnits7: '10000000',
        messageDigest: '0x' + '88'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
      }),
      event('cctp_attestation', 'confirmed', 2, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
        evidenceVersion: '1',
      }),
      event('cctp_mint', 'submitting', 3, {
        burnTxHash: '66'.repeat(32),
        expectationDigest: '77'.repeat(32),
        messageDigest: '0x' + '88'.repeat(32),
        attestationDigest: '0x' + '99'.repeat(32),
        nonce: '0x' + '77'.repeat(32),
      }),
    ]);
    const validClaim = {
      ok: true,
      reasonCode: 'base-mint-submitting',
      identity: IDENTITY,
      action: 'poll-mint',
      phase: 'cctp_mint',
      evidenceVersion: 3,
      lease: recoveryClaimLease(),
      bundle,
    };
    const workStore = {
      get: vi.fn(() => ({
        workId: 'w',
        identity: IDENTITY,
        action: 'poll-mint',
        evidenceVersion: 3,
        state: 'pending',
        claimToken: 'aa'.repeat(32),
      })),
      claim: vi.fn(() => ({
        leaseOwner: 'worker',
        leaseToken: 'cc'.repeat(32),
      })),
      heartbeat: vi.fn(() => ({ state: 'running' })),
      hold: vi.fn((input) => ({ ...input, state: 'held' })),
      finish: vi.fn((input) => ({ ...input, state: input.state })),
    };
    const renewBaseRecoveryClaim = vi.fn(async () => ({}));
    const localRecoveryGuard = vi.fn(async () => ({ valid: true }));
    const pollMint = vi.fn(async () => ({ state: 'done' }));
    const outcome = await createBaseRecoveryExecutor({
      workStore,
      reporter: {
        readBaseRecoveryClaim: vi.fn(),
        renewBaseRecoveryClaim,
        releaseBaseRecoveryClaim: vi.fn(async () => ({})),
      },
      operations: { pollMint },
      localRecoveryGuard,
      now: () => 1000,
    }).run('w', { claim: mutate(validClaim) });
    expect(outcome).toMatchObject({
      state: 'held',
      reasonCode: 'base-recovery-claim-conflict',
    });
    expect(renewBaseRecoveryClaim).not.toHaveBeenCalled();
    expect(localRecoveryGuard).not.toHaveBeenCalled();
    expect(pollMint).not.toHaveBeenCalled();
  });
});
