import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { concatHex, encodeAbiParameters, keccak256, pad, slice } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { toCallPolicy, toTimestampPolicy, ParamCondition } from '@zerodev/permissions/policies';
import { createRelayerRouter, sameRecoveryFarmIntentFacts } from '../src/httpRouter.mjs';
import { DEPOSITED_TOPIC0, createOrchestrator } from '../src/base/orchestrator.mjs';
import { createFarmFlow } from '../src/flows/farm.mjs';
import {
  AgentIndexBatchConflictError,
  AgentIndexRecoveryLeaseConflictError,
  AgentIndexRecoveryVersionConflictError,
} from '../src/agentIndexReporter.mjs';
import { createMandateStoresV3 } from '../src/mandateStore.mjs';
import { MAX_CALL_CAP_UNITS, validateMandateBinding } from '../src/base/session.mjs';
import { createSqliteStores } from '../src/sqliteStores.mjs';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(s) {
      this.body = s ?? '';
      return this;
    },
  };
}
const jsonOf = (res) => (res.body ? JSON.parse(res.body) : undefined);

// Shared route allocation fixture. The approval itself is built below from the real ZeroDev
// policy serializers, so route tests exercise the same canonical Task-4 wire shape as activation.
const POOL_ADDRESS = `0x${'e5'.repeat(20)}`;

function wireAllocation({
  allocationId = 'run-42:bridge:aave-v3',
  pool = POOL_ADDRESS,
  units = 100n,
  minShares = '90',
} = {}) {
  return {
    allocationId,
    poolAddress: pool,
    amount: { token: 'USDC', units: units.toString(), decimals: 6 },
    minShares,
  };
}

const NOW_SECONDS = 2_000_000_000;
const VALID_UNTIL_SECONDS = NOW_SECONDS + 7_200;
const MANDATE_ID = '0123456789abcdef0123456789abcdef';
const CAPABILITY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CAPABILITY_HASH = 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e';
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const KERNEL = `0x${'11'.repeat(20)}`;
const SESSION_KEY = `0x${'22'.repeat(32)}`;
const SESSION = privateKeyToAccount(SESSION_KEY).address;
const USER_OP_HASH = `0x${'33'.repeat(32)}`;
const TX_HASH = `0x${'44'.repeat(32)}`;
const unwindJobCommitment = (jobId) => keccak256(concatHex(['0x76662d756e77696e642d6a6f622d7631', `0x${jobId}`]));
const UNWIND_PUBLIC_CLIENT = Object.freeze({
  getChainId() {},
  getTransactionReceipt() {},
});

describe('Task 14 Base recovery HTTP boundary', () => {
  const RECOVERY_IDENTITY = Object.freeze({
    networkId: 'stellar-testnet',
    bindingId: '0123456789abcdef0123456789abcdef',
    executionId: 'run-42:exec:run-42:bridge:aave-v3',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'abcdef0123456789abcdef0123456789',
  });
  const RECOVERY_CAPABILITY = 'ab'.repeat(32);
  const RECOVERY_AUTHORITY = Object.freeze({
    mandateId: '22'.repeat(16),
    status: 'revoked',
    stellarOwner: 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57',
    kernelAddress: '0x00000000000000000000000000000000000000aa',
    bindingId: RECOVERY_IDENTITY.bindingId,
    bindingHash: 'dd'.repeat(32),
    capabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
  });
  const recoveryEvent = (phase, state, version, evidence = {}) => ({
    identity: RECOVERY_IDENTITY,
    phase,
    state,
    evidence,
    recoveryVersion: version,
    eventId: `${String(version).padStart(2, '0')}`.repeat(32),
    observedAt: 2_000_000_000_000 + version,
  });
  function recoveryBundle({ withSubmittingDeposit = false } = {}) {
    const burn = recoveryEvent('cctp_burn', 'confirmed', 1, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      burnUnits7: '10000000',
      messageDigest: '0x' + '88'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
    });
    const attestation = recoveryEvent('cctp_attestation', 'confirmed', 2, {
      burnTxHash: '66'.repeat(32),
      expectationDigest: '77'.repeat(32),
      messageDigest: '0x' + '88'.repeat(32),
      attestationDigest: '0x' + '99'.repeat(32),
      nonce: '0x' + '77'.repeat(32),
      evidenceVersion: '1',
    });
    const events = [burn, attestation];
    if (withSubmittingDeposit) {
      events.push(
        recoveryEvent('cctp_mint', 'confirmed', 3, {
          burnTxHash: '66'.repeat(32),
          expectationDigest: '77'.repeat(32),
          messageDigest: '0x' + '88'.repeat(32),
          attestationDigest: '0x' + '99'.repeat(32),
          nonce: '0x' + '77'.repeat(32),
          evidenceVersion: '1',
          mintTxHash: '0x' + 'aa'.repeat(32),
        }),
      );
      events.push(
        recoveryEvent('base_deposit', 'submitting', 4, {
          chainId: '84532',
          yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
          caller: RECOVERY_AUTHORITY.kernelAddress,
          poolAddress: '0x00000000000000000000000000000000000000b2',
          assets: '1000000',
          minShares: '900000',
          reconcileHandle: {
            entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
            sender: RECOVERY_AUTHORITY.kernelAddress,
            nonce: '17',
            startBlock: '4321',
          },
        }),
      );
    }
    const phases = {
      cctp_burn: events[0],
      cctp_attestation: events[1],
      cctp_mint: events[2] ?? null,
      base_deposit: events[3] ?? null,
      base_position: null,
    };
    return {
      schemaVersion: 1,
      identity: RECOVERY_IDENTITY,
      owner: RECOVERY_AUTHORITY.stellarOwner,
      agent: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      recoverable: true,
      recoveryVersion: events.length,
      intent: {
        runId: 'run-42',
        grantTxHash: '66'.repeat(32),
        bindingHash: 'dd'.repeat(32),
        baseJobId: RECOVERY_IDENTITY.childId,
        kernelAddress: RECOVERY_AUTHORITY.kernelAddress,
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
  function harness({
    authority = RECOVERY_AUTHORITY,
    reporter = null,
    works = null,
    farmIntents = null,
    executor = null,
    baseAvailable = true,
  } = {}) {
    const calls = { reporter: [], works: [] };
    const fakeReporter = reporter ?? {
      readBaseRecoveryClaim: vi.fn(async (request) => ({
        acknowledged: true,
        schemaVersion: 1,
        identity: request.identity,
        action: request.action,
        phase: 'cctp_mint',
        evidenceVersion: request.evidenceVersion,
        lease: { holder: 'tab-42', expiresAt: 2_000_000_030_000 },
        bundle: recoveryBundle(),
      })),
    };
    const fakeWorks = works ?? {
      enqueue: vi.fn((input) => ({
        workId: '0a3fcbe288b70e792df216a67870ce6291c0401017ed0a3401b6d32524a655d9',
        state: 'pending',
        ...input,
      })),
    };
    const localFarmIntents = farmIntents ?? {
      getByJob: vi.fn(() => matchingFarmIntent()),
    };
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      mandatesV3: { authority: vi.fn(() => authority) },
      mandateStatusConfig: {},
      publicRuntime: { baseCrossChainAvailable: baseAvailable },
      networkId: 'stellar-testnet',
      agentIndexReporter: fakeReporter,
      baseRecoveryWorks: fakeWorks,
      baseRecoveryExecutor: executor,
      farmIntents: localFarmIntents,
      nowSeconds: () => 2_000_000_000,
    });
    calls.reporter = fakeReporter;
    calls.works = fakeWorks;
    return { router, calls };
  }
  const requestFor = (overrides = {}) => ({
    method: 'POST',
    url: '/api/vf-cross/farm/recover',
    headers: { authorization: `Bearer ${RECOVERY_CAPABILITY}` },
    body: {
      mandateId: RECOVERY_AUTHORITY.mandateId,
      identity: RECOVERY_IDENTITY,
      action: 'submit-mint',
      evidenceVersion: 2,
      leaseToken: 'aa'.repeat(32),
      ...overrides,
    },
  });

  function matchingFarmIntent(overrides = {}) {
    const bundle = recoveryBundle();
    const allocation = {
      allocationId: RECOVERY_IDENTITY.allocationId,
      executionId: RECOVERY_IDENTITY.executionId,
      childId: RECOVERY_IDENTITY.childId,
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: bundle.intent.poolAddress,
      proxyTarget: 'aave-v3',
      minShares: '900000',
    };
    const child = {
      networkId: RECOVERY_IDENTITY.networkId,
      bindingId: RECOVERY_IDENTITY.bindingId,
      executionId: RECOVERY_IDENTITY.executionId,
      allocationId: RECOVERY_IDENTITY.allocationId,
      childId: RECOVERY_IDENTITY.childId,
      owner: bundle.owner,
      agent: bundle.agent,
      intent: {
        token: allocation.token,
        units: allocation.units,
        decimals: allocation.decimals,
        poolAddress: allocation.poolAddress,
        proxyTarget: allocation.proxyTarget,
        minShares: allocation.minShares,
        runId: bundle.intent.runId,
        grantTxHash: bundle.intent.grantTxHash,
        kernelAddress: bundle.intent.kernelAddress,
        bindingHash: bundle.intent.bindingHash,
        baseJobId: bundle.intent.baseJobId,
      },
    };
    return {
      jobId: RECOVERY_IDENTITY.childId,
      mandateId: RECOVERY_AUTHORITY.mandateId,
      stellarOwner: RECOVERY_AUTHORITY.stellarOwner,
      kernelAddress: RECOVERY_AUTHORITY.kernelAddress,
      bindingId: RECOVERY_IDENTITY.bindingId,
      bindingHash: bundle.intent.bindingHash,
      intentDigest: 'ee'.repeat(32),
      relayExecId: `forward-farm:${RECOVERY_IDENTITY.childId}`,
      intent: {
        jobId: RECOVERY_IDENTITY.childId,
        mandate: {
          mandateId: RECOVERY_AUTHORITY.mandateId,
          stellarOwner: RECOVERY_AUTHORITY.stellarOwner,
          kernelAddress: RECOVERY_AUTHORITY.kernelAddress,
          bindingId: RECOVERY_IDENTITY.bindingId,
          bindingHash: bundle.intent.bindingHash,
        },
        run: {
          runId: bundle.intent.runId,
          grantTxHash: bundle.intent.grantTxHash,
        },
        allocations: [allocation],
      },
      batch: { children: [child] },
      ...overrides,
    };
  }

  it('authenticates before reporter/work existence and returns generic 401', async () => {
    const reporter = { readBaseRecoveryClaim: vi.fn() };
    const works = { enqueue: vi.fn() };
    const { router } = harness({
      reporter,
      works,
      authority: { ...RECOVERY_AUTHORITY, capabilityHash: '00'.repeat(32) },
    });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(401);
    expect(reporter.readBaseRecoveryClaim).not.toHaveBeenCalled();
    expect(works.enqueue).not.toHaveBeenCalled();
    expect(response.body).not.toContain(RECOVERY_IDENTITY.childId);
  });

  it('rejects caller money-routing fields after capability auth and before reporter read', async () => {
    const reporter = { readBaseRecoveryClaim: vi.fn() };
    const { router } = harness({ reporter });
    const response = mockRes();
    await router(requestFor({ poolAddress: '0x00000000000000000000000000000000000000b2' }), response);
    expect(response.statusCode).toBe(400);
    expect(reporter.readBaseRecoveryClaim).not.toHaveBeenCalled();
  });

  it.each([false, 'false', {}])(
    'does not schedule send-capable recovery when Base availability is not exactly true: %p',
    async (baseAvailable) => {
      const reporter = { readBaseRecoveryClaim: vi.fn() };
      const works = { enqueue: vi.fn() };
      const { router } = harness({ reporter, works, baseAvailable });
      const response = mockRes();
      await router(requestFor(), response);
      expect(response.statusCode).toBe(503);
      expect(reporter.readBaseRecoveryClaim).not.toHaveBeenCalled();
      expect(works.enqueue).not.toHaveBeenCalled();
    },
  );

  it('re-fetches the exact claim, durably enqueues before 202, and supports revoked post-burn CCTP work', async () => {
    const { router, calls } = harness();
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      accepted: true,
      workId: '817ea368c0b0ee3fd533b03ca3421421cf8a10e818dce5ba7de9ec8c3908376e',
      identity: RECOVERY_IDENTITY,
      action: 'submit-mint',
      evidenceVersion: 2,
      status: 'pending',
    });
    expect(calls.reporter.readBaseRecoveryClaim).toHaveBeenCalledTimes(1);
    expect(calls.works.enqueue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(JSON.parse(response.body))).not.toContain('leaseToken');
  });

  it('commits durable work before scheduling and joins concurrent exact retries to one executor', async () => {
    const order = [];
    let durableCommit = false;
    let finishRun;
    const running = new Promise((resolve) => {
      finishRun = resolve;
    });
    const workId = '817ea368c0b0ee3fd533b03ca3421421cf8a10e818dce5ba7de9ec8c3908376e';
    const works = {
      enqueue: vi.fn((input) => {
        order.push('enqueue');
        queueMicrotask(() => {
          durableCommit = true;
        });
        return { ...input, workId, state: 'pending' };
      }),
    };
    const executor = {
      run: vi.fn(async () => {
        order.push(durableCommit ? 'run' : 'run-before-commit');
        await running;
        return { workId, state: 'done' };
      }),
    };
    const { router } = harness({ works, executor });
    const first = mockRes();
    const second = mockRes();
    await Promise.all([router(requestFor(), first), router(requestFor(), second)]);
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalledTimes(1));
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(works.enqueue).toHaveBeenCalledTimes(2);
    expect(order[0]).toBe('enqueue');
    expect(order).not.toContain('run-before-commit');
    expect(order.at(-1)).toBe('run');
    finishRun();
    await expect(executor.run.mock.results[0].value).resolves.toMatchObject({
      state: 'done',
    });
  });

  it('continues bounded startup recovery after one malformed work item fails', async () => {
    const records = [
      { workId: '11'.repeat(32), state: 'pending' },
      { workId: '22'.repeat(32), state: 'pending' },
    ];
    const works = { listRecoverable: vi.fn(() => records) };
    const executor = {
      run: vi.fn(async (workId) => {
        if (workId === records[0].workId) throw new Error('malformed durable row');
        return { workId, state: 'done' };
      }),
    };
    const { router } = harness({ works, executor });
    await expect(router.resumeBaseRecoveryJobs({ limit: 2 })).resolves.toEqual({
      resumed: [records[1].workId],
      held: [records[0].workId],
      blocked: [],
      uncertain: [],
    });
    expect(works.listRecoverable).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(executor.run).toHaveBeenCalledTimes(2);
  });

  it('does not list, claim, or run Base recovery when Base execution is closed', async () => {
    const works = { listRecoverable: vi.fn(() => [{ workId: '11'.repeat(32) }]) };
    const executor = { run: vi.fn() };
    const { router } = harness({ works, executor, baseAvailable: false });

    await expect(router.resumeBaseRecoveryJobs({ limit: 1 })).resolves.toEqual({
      resumed: [],
      held: [],
      blocked: [],
      uncertain: [],
    });
    expect(works.listRecoverable).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it.each([
    [AgentIndexRecoveryVersionConflictError, 'version-conflict'],
    [AgentIndexRecoveryLeaseConflictError, 'lease-conflict'],
  ])('returns the frozen client conflict code for %s', async (ErrorType, code) => {
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async () => {
        throw new ErrorType('race');
      }),
    };
    const { router } = harness({ reporter });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(409);
    expect(jsonOf(response)).toEqual(expect.objectContaining({ error: expect.any(String), code }));
  });

  it('accepts the nested Task 10 reconcile handle through the recovery HTTP boundary', async () => {
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async (request) => ({
        ok: true,
        identity: request.identity,
        action: 'poll-base-deposit',
        phase: 'base_deposit',
        reasonCode: 'base-deposit-pending',
        evidenceVersion: 4,
        lease: {
          holder: 'tab-42',
          leaseToken: 'bb'.repeat(32),
          expiresAt: 2_000_000_030_000,
        },
        bundle: recoveryBundle({ withSubmittingDeposit: true }),
      })),
    };
    const { router, calls } = harness({ reporter });
    const response = mockRes();
    await router(requestFor({ action: 'poll-base-deposit', evidenceVersion: 4 }), response);
    expect(response.statusCode).toBe(202);
    expect(calls.works.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'poll-base-deposit',
        evidenceVersion: 4,
      }),
    );
  });

  it('blocks recovery when the durable local farm intent is missing', async () => {
    const { router, calls } = harness({
      farmIntents: { getByJob: vi.fn(() => null) },
    });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(409);
    expect(calls.works.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the durable local farm-intent store is not composed', async () => {
    const { router, calls } = harness({ farmIntents: {} });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(503);
    expect(calls.works.enqueue).not.toHaveBeenCalled();
  });

  it('blocks a same-identity recovery when immutable local binding facts disagree', async () => {
    const intent = matchingFarmIntent({ bindingHash: 'ab'.repeat(32) });
    const { router, calls } = harness({
      farmIntents: { getByJob: vi.fn(() => intent) },
    });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(409);
    expect(calls.works.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a local farm intent without its canonical immutable digest', async () => {
    const intent = matchingFarmIntent({ intentDigest: null });
    const { router, calls } = harness({
      farmIntents: { getByJob: vi.fn(() => intent) },
    });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(409);
    expect(calls.works.enqueue).not.toHaveBeenCalled();
  });

  it('releases an acquired Agent Index claim on authority rejection without changing the response', async () => {
    const releaseBaseRecoveryClaim = vi.fn(async () => {
      throw new Error('release race');
    });
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async (request) => ({
        ok: true,
        identity: request.identity,
        action: request.action,
        phase: 'cctp_mint',
        reasonCode: 'base-attestation-confirmed',
        evidenceVersion: request.evidenceVersion,
        lease: {
          holder: 'tab-42',
          leaseToken: request.leaseToken,
          expiresAt: 2_000_000_030_000,
        },
        bundle: recoveryBundle(),
      })),
      releaseBaseRecoveryClaim,
    };
    const { router, calls } = harness({
      reporter,
      authority: { ...RECOVERY_AUTHORITY, bindingHash: 'ab'.repeat(32) },
    });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(401);
    expect(releaseBaseRecoveryClaim).toHaveBeenCalledWith({
      identity: RECOVERY_IDENTITY,
      action: 'submit-mint',
      evidenceVersion: 2,
      leaseToken: 'aa'.repeat(32),
    });
    expect(calls.works.enqueue).not.toHaveBeenCalled();
  });

  it('releases an acquired claim when durable enqueue fails and preserves the storage response', async () => {
    const releaseBaseRecoveryClaim = vi.fn(async () => {
      throw new Error('release unavailable');
    });
    const reporter = {
      readBaseRecoveryClaim: vi.fn(async (request) => ({
        ok: true,
        identity: request.identity,
        action: request.action,
        phase: 'cctp_mint',
        reasonCode: 'base-attestation-confirmed',
        evidenceVersion: request.evidenceVersion,
        lease: {
          holder: 'tab-42',
          leaseToken: request.leaseToken,
          expiresAt: 2_000_000_030_000,
        },
        bundle: recoveryBundle(),
      })),
      releaseBaseRecoveryClaim,
    };
    const works = {
      enqueue: vi.fn(() => {
        throw new Error('sqlite unavailable');
      }),
    };
    const { router } = harness({ reporter, works });
    const response = mockRes();
    await router(requestFor(), response);
    expect(response.statusCode).toBe(503);
    expect(releaseBaseRecoveryClaim).toHaveBeenCalledTimes(1);
  });

  it('requires one binding hash across authority, D1 intent, and local farm intent', () => {
    const bundle = recoveryBundle();
    const intent = matchingFarmIntent();
    expect(
      sameRecoveryFarmIntentFacts({
        intent,
        bundle,
        authority: RECOVERY_AUTHORITY,
        identity: RECOVERY_IDENTITY,
        mandateId: RECOVERY_AUTHORITY.mandateId,
      }),
    ).toBe(true);
    expect(
      sameRecoveryFarmIntentFacts({
        intent: { ...intent, bindingHash: 'ab'.repeat(32) },
        bundle,
        authority: { ...RECOVERY_AUTHORITY, bindingHash: 'ab'.repeat(32) },
        identity: RECOVERY_IDENTITY,
        mandateId: RECOVERY_AUTHORITY.mandateId,
      }),
    ).toBe(false);
  });
});
const UNWIND_BUNDLER_CLIENT = Object.freeze({
  getUserOperation() {},
  getUserOperationReceipt() {},
});
const UNWIND_FACTS = Object.freeze({
  generation: 'hardened-v2',
  chainId: 84532,
  entryPointAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032',
  baseExitSweeperAddress: `0x${'44'.repeat(20)}`,
  usdcAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  tokenMessengerV2Address: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  messageTransmitterV2Address: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  stellarDomain: 27,
  stellarTokenMessenger: `0x${'55'.repeat(32)}`,
  cctpForwarder: `0x${'66'.repeat(32)}`,
  finalityThreshold: 1000,
});
const CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2';
const TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F';
const ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF';
const CANONICAL_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CANONICAL_ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
const DEFAULT_ACTION_SELECTOR = '0xe9ae5c53';
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const OTHER_KERNEL = `0x${'88'.repeat(20)}`;
const OTHER_SESSION_ADDRESS = privateKeyToAccount(`0x${'99'.repeat(32)}`).address;
const WITHDRAW_PERMISSION = Object.freeze({
  target: CANONICAL_ROUTER,
  valueLimit: '0',
  functionName: 'withdraw',
  args: [null, null, null],
  callType: '0x00',
  selector: '0xb5c5f672',
  rules: [],
});
const POLICY = Object.freeze({
  chainId: 84532,
  kernelVersion: '0.3.1',
  kernelImplementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
  entryPointVersion: '0.7',
  entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  callPolicyVersion: '0.0.4',
  callPolicyAddress: CALL_POLICY,
  timestampPolicyAddress: TIMESTAMP_POLICY,
  ecdsaSignerAddress: ECDSA_SIGNER,
  usdcAddress: CANONICAL_USDC,
  yieldRouterAddress: CANONICAL_ROUTER,
  approveSelector: '0x095ea7b3',
  depositSelector: '0x0efe6a8b',
  callType: 'call',
  nativeValue: '0',
  executionHorizonSeconds: 2_700,
});
const CONFIG = Object.freeze({
  publicOrigin: 'https://relayer.example',
  base: {
    chain: { id: 84532 },
    mandatePolicy: POLICY,
    baseCrossChainAvailable: true,
    hardenedDeployment: {
      generation: 'hardened-v2',
      chainId: 84532,
      yieldRouter: { address: CANONICAL_ROUTER },
      route: { usdcAddress: CANONICAL_USDC },
    },
  },
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serializeCanonical(value) {
  return Buffer.from(
    JSON.stringify(value, (_, child) => (typeof child === 'bigint' ? child.toString() : child)),
    'utf8',
  ).toString('base64');
}

function canonicalPermissions(cap = MAX_CALL_CAP_UNITS) {
  const encodedCap = pad(`0x${cap.toString(16)}`, { size: 32 });
  return [
    {
      target: CANONICAL_USDC,
      valueLimit: '0',
      functionName: 'approve',
      args: [
        { condition: ParamCondition.EQUAL, value: CANONICAL_ROUTER },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap.toString() },
      ],
      callType: '0x00',
      selector: '0x095ea7b3',
      rules: [
        {
          params: [pad(CANONICAL_ROUTER, { size: 32 })],
          offset: 0,
          condition: ParamCondition.EQUAL,
        },
        {
          params: [encodedCap],
          offset: 32,
          condition: ParamCondition.LESS_THAN_OR_EQUAL,
        },
      ],
    },
    {
      target: CANONICAL_ROUTER,
      valueLimit: '0',
      functionName: 'deposit',
      args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap.toString() }, null],
      callType: '0x00',
      selector: '0x0efe6a8b',
      rules: [
        {
          params: [encodedCap],
          offset: 32,
          condition: ParamCondition.LESS_THAN_OR_EQUAL,
        },
      ],
    },
  ];
}

function canonicalPermissionId(entries) {
  const policiesData = encodeAbiParameters(
    [{ name: 'policiesData', type: 'bytes[]' }],
    [entries.map((entry) => concatHex([entry.getPolicyInfoInBytes(), entry.getPolicyData()]))],
  );
  const signerData = encodeAbiParameters([{ name: 'signerData', type: 'bytes' }], [concatHex([ECDSA_SIGNER, SESSION])]);
  return slice(
    keccak256(
      encodeAbiParameters([{ name: 'policyAndSignerData', type: 'bytes[]' }], [[policiesData, '0x0000', signerData]]),
    ),
    0,
    4,
  ).toLowerCase();
}

function canonicalApproval(
  validUntilSeconds = VALID_UNTIL_SECONDS,
  { accountAddress = KERNEL, cap = MAX_CALL_CAP_UNITS, extraPermissions = [] } = {},
) {
  const call = toCallPolicy({
    policyVersion: '0.0.4',
    permissions: [...canonicalPermissions(cap), ...extraPermissions],
  });
  const timestamp = toTimestampPolicy({
    validAfter: 0,
    validUntil: validUntilSeconds,
  });
  return serializeCanonical({
    permissionParams: {
      permissionId: canonicalPermissionId([call, timestamp]),
      policies: [call, timestamp],
    },
    action: { selector: DEFAULT_ACTION_SELECTOR, address: ZERO_ADDRESS },
    validityData: { validAfter: 0, validUntil: 0 },
    accountParams: { initCode: '0x', accountAddress },
    enableSignature: '0x1234',
    isPreInstalled: false,
  });
}

function mandateIdAt(index) {
  return index.toString(16).padStart(32, '0');
}

function capabilityAt(index) {
  return index.toString(16).padStart(64, '0');
}

function registrationBody(overrides = {}) {
  const expiresAt = overrides.expiresAt ?? VALID_UNTIL_SECONDS;
  return {
    mandateId: MANDATE_ID,
    capability: CAPABILITY,
    serializedApproval: canonicalApproval(expiresAt),
    sessionPrivateKey: SESSION_KEY,
    sessionKeyAddress: SESSION,
    expiresAt,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    ...overrides,
  };
}

function identityOf(body) {
  return {
    mandateId: body.mandateId,
    stellarOwner: body.stellarOwner,
    kernelAddress: body.kernelAddress,
  };
}

function associationRows(stores, jobId) {
  const associations = stores.jobs.get(jobId)?._attach?.associations ?? [];
  return associations.flatMap(({ recoveryIdentity }) => stores.associationOutbox.status(recoveryIdentity));
}

function mintedResult(mintTxHash) {
  const canonicalMintTxHash = /^0x[0-9a-f]{64}$/.test(mintTxHash) ? mintTxHash : `0x${sha256(mintTxHash)}`;
  return {
    status: 'minted',
    mintTxHash,
    evidence: {
      burnTxHash: sha256('burn-evidence'),
      expectationDigest: sha256('expectation-evidence'),
      messageDigest: sha256('message-evidence'),
      attestationDigest: sha256('attestation-evidence'),
      evidenceVersion: '1',
      mintTxHash: canonicalMintTxHash,
    },
  };
}

function canonicalRecord(body, bindingId = 'binding-1') {
  const bindingHash = sha256(`${body.stellarOwner}|${body.kernelAddress}|${body.sessionKeyAddress}|${body.expiresAt}`);
  const validation = validateMandateBinding({
    serializedApproval: body.serializedApproval,
    sessionPrivateKey: body.sessionPrivateKey,
    sessionKeyAddress: body.sessionKeyAddress,
    stellarOwner: body.stellarOwner,
    kernelAddress: body.kernelAddress,
    validUntilSeconds: body.expiresAt,
    expiresAt: body.expiresAt,
    relayerOrigin: CONFIG.publicOrigin,
    bindingId,
    bindingHash,
    config: CONFIG,
    now: NOW_SECONDS,
  });
  if (!validation.ok) throw new Error(`invalid Task-4 fixture: ${validation.reason}`);
  return {
    mandateId: body.mandateId,
    approvalDigest: sha256(body.serializedApproval),
    policyDigest: validation.mandate.policyDigest,
    serializedApproval: body.serializedApproval,
    sessionPrivateKey: body.sessionPrivateKey,
    sessionKeyAddress: body.sessionKeyAddress,
    capabilityHash: sha256(body.capability),
    stellarOwner: body.stellarOwner,
    kernelAddress: body.kernelAddress,
    relayerOrigin: CONFIG.publicOrigin,
    validUntilSeconds: body.expiresAt,
    bindingId,
    bindingHash,
    permissionId: validation.mandate.permissionId,
  };
}

function tracedStores(real, events, { transformMandateGet, enqueueError } = {}) {
  const mandatesV3 = {
    get(identity) {
      events.push('store:get');
      const record = real.mandatesV3.get(identity);
      return transformMandateGet?.(record, identity) ?? record;
    },
    status(identity) {
      events.push('store:status');
      return real.mandatesV3.status(identity);
    },
    revoke(identity) {
      events.push('store:revoke');
      return real.mandatesV3.revoke(identity);
    },
    get size() {
      return real.mandatesV3.size;
    },
  };
  const mandateActivations = {
    enqueue(input) {
      events.push('store:enqueue');
      if (enqueueError) throw enqueueError;
      return real.mandateActivations.enqueue(input);
    },
    get(identity) {
      events.push('store:work:get');
      return real.mandateActivations.get(identity);
    },
    claim(input) {
      events.push('store:claim');
      return real.mandateActivations.claim(input);
    },
    renew(input) {
      events.push('store:renew');
      return real.mandateActivations.renew(input);
    },
    checkpoint(input) {
      events.push(`store:checkpoint:${input.status}`);
      return real.mandateActivations.checkpoint(input);
    },
    finishActive(input) {
      events.push('store:finishActive');
      return real.mandateActivations.finishActive(input);
    },
    finishUncertain(input) {
      events.push('store:finishUncertain');
      return real.mandateActivations.finishUncertain(input);
    },
    finishRevoked(input) {
      events.push('store:finishRevoked');
      return real.mandateActivations.finishRevoked(input);
    },
    listRecoverable(input) {
      events.push('store:listRecoverable');
      return real.mandateActivations.listRecoverable(input);
    },
    reconcileExpired(input) {
      events.push('store:reconcileExpired');
      return real.mandateActivations.reconcileExpired(input);
    },
  };
  return { mandatesV3, mandateActivations };
}

function makeHarness({
  clock = { value: NOW_SECONDS },
  activateMandate,
  evaluateMandateStatusFn,
  transformMandateGet,
  enqueueError,
  realStores = null,
  bindingPrefix = 'binding',
  baseCrossChainAvailable = true,
  recoveryConcurrency = 4,
  recoveryLimit = 100,
} = {}) {
  const events = [];
  const real =
    realStores ??
    createMandateStoresV3({
      nowSeconds: () => clock.value,
      leaseToken: (() => {
        let value = 0;
        return () => `activation-lease-${++value}`;
      })(),
    });
  const traced = tracedStores(real, events, {
    transformMandateGet,
    enqueueError,
  });
  const evaluatorCalls = [];
  const activatorCalls = [];
  const activator =
    activateMandate ??
    (async (approval, { onSubmitted } = {}) => {
      activatorCalls.push(approval);
      events.push('activator:called');
      events.push('activator:onSubmitted');
      await onSubmitted(USER_OP_HASH);
      events.push('activator:receipt');
      return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
    });
  const evaluator =
    evaluateMandateStatusFn ??
    (async (args) => {
      evaluatorCalls.push(args);
      events.push('evaluator:called');
      return { status: 'active', reasonCodes: [] };
    });
  let nextId = 0;
  const router = createRelayerRouter({
    buildFarm: vi.fn(() => ({ farm: vi.fn() })),
    jobs: new Map(),
    mandatesV2: new Proxy(
      {},
      {
        get() {
          throw new Error('v2 mandate store must not be consulted by the v3 router');
        },
      },
    ),
    mandatesV3: traced.mandatesV3,
    mandateActivations: traced.mandateActivations,
    buildMandateActivator: (sessionPrivateKey) => ({
      activateMandate: async (...args) => {
        events.push(`activator:key:${sessionPrivateKey}`);
        return activator(...args);
      },
    }),
    genId: () => `${bindingPrefix}-${++nextId}`,
    usdcAddress: CANONICAL_USDC,
    yieldRouterAddress: CANONICAL_ROUTER,
    relayerOrigin: CONFIG.publicOrigin,
    mandateStatusConfig: CONFIG,
    evaluateMandateStatusFn: evaluator,
    nowSeconds: () => clock.value,
    publicRuntime: {
      networkId: 'stellar-testnet',
      baseCrossChainAvailable,
      unavailableReason: baseCrossChainAvailable ? null : 'Hardened Base deployment is not active.',
    },
    recoveryConcurrency,
    recoveryLimit,
  });
  return {
    clock,
    events,
    real,
    mandatesV3: traced.mandatesV3,
    mandateActivations: traced.mandateActivations,
    evaluatorCalls,
    activatorCalls,
    router,
  };
}

function request(body, capability) {
  return {
    method: 'POST',
    url: '/api/vf-cross/mandate',
    body,
    headers: capability === undefined ? {} : { authorization: `Bearer ${capability}` },
  };
}

async function postMandate(harness, body, { response, bearer } = {}) {
  const res = response ?? mockRes();
  await harness.router(request(body, bearer), res);
  return { res, json: jsonOf(res) };
}

describe('v3 mandate registration and activation worker', () => {
  async function waitForStatus(harness, body, status) {
    await vi.waitFor(() => {
      expect(harness.real.mandatesV3.status(identityOf(body)).status).toBe(status);
    });
  }

  function expectOrdered(events, checkpoints) {
    let cursor = -1;
    for (const checkpoint of checkpoints) {
      const next = events.indexOf(checkpoint, cursor + 1);
      expect(next, `missing or out-of-order checkpoint ${checkpoint}`).toBeGreaterThan(cursor);
      cursor = next;
    }
  }

  it.each([
    ['short mandate ID', { mandateId: MANDATE_ID.slice(1) }],
    ['uppercase mandate ID', { mandateId: MANDATE_ID.toUpperCase() }],
    ['non-hex mandate ID', { mandateId: `${MANDATE_ID.slice(0, -1)}g` }],
    ['short capability', { capability: CAPABILITY.slice(1) }],
    ['uppercase capability', { capability: CAPABILITY.toUpperCase() }],
    ['non-hex capability', { capability: `${CAPABILITY.slice(0, -1)}g` }],
  ])('rejects a %s at the exact 32/64 lowercase-hex registration boundary', async (_label, change) => {
    const harness = makeHarness();
    const body = registrationBody(change);

    const { res } = await postMandate(harness, body);

    expect(res.statusCode).toBe(400);
    expect(harness.real.mandatesV3.size).toBe(0);
    expect(res.body).not.toContain(String(change.mandateId ?? change.capability));
    expect(res.body).not.toContain(body.serializedApproval);
    expect(res.body).not.toContain(CAPABILITY);
    expect(res.body).not.toContain(SESSION_KEY);
  });

  it('atomically enqueues before the exact private 202 response and stores only capability/key hashes publicly', async () => {
    const harness = makeHarness();
    const body = registrationBody();
    let endSnapshot;
    const res = {
      ...mockRes(),
      end(payload) {
        this.body = payload ?? '';
        endSnapshot = {
          mandate: harness.real.mandatesV3.status(identityOf(body)),
          work: harness.real.mandateActivations.get(identityOf(body)),
        };
        return this;
      },
    };

    await postMandate(harness, body, { response: res });

    const bindingHash = sha256(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS}`);
    expect(res.statusCode).toBe(202);
    expect(jsonOf(res)).toEqual({
      ok: true,
      status: 'pending_activation',
      mandateId: MANDATE_ID,
      bindingId: 'binding-1',
      bindingHash,
      relayerOrigin: CONFIG.publicOrigin,
    });
    expect(res.headers['Set-Cookie']).toBe(
      `__Host-vf-mandate-${MANDATE_ID}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`,
    );
    expect(endSnapshot).toMatchObject({
      mandate: { mandateId: MANDATE_ID, status: 'pending_activation' },
      work: { mandateId: MANDATE_ID, status: 'pending', attempts: 0 },
    });
    const internal = harness.real.mandatesV3.get(identityOf(body));
    expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
    expect(internal.sessionPrivateKey).toBe(SESSION_KEY);
    expect(Object.keys(internal)).not.toContain('capabilityHash');
    expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body)))).not.toContain(CAPABILITY);
    expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body)))).not.toContain(SESSION_KEY);
    expect(res.body).not.toContain(CAPABILITY);
    expect(res.body).not.toContain(body.serializedApproval);
    expect(res.body).not.toContain(SESSION_KEY);
  });

  it('bounds unique activation registrations and retries durable overflow without restart', async () => {
    let active = 0;
    let maxActive = 0;
    const releases = new Map();
    const activator = vi.fn(async (approval, { onSubmitted }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await onSubmitted(USER_OP_HASH);
      await new Promise((resolve) => releases.set(approval, resolve));
      active -= 1;
      return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
    });
    const harness = makeHarness({
      activateMandate: activator,
      recoveryConcurrency: 1,
      recoveryLimit: 1,
    });
    const bodies = [1, 2, 3].map((index) => registrationBody({
      mandateId: mandateIdAt(index),
      capability: capabilityAt(index),
      expiresAt: VALID_UNTIL_SECONDS - index,
    }));

    const responses = await Promise.all(bodies.map((body) => postMandate(harness, body)));
    expect(responses.map(({ res }) => res.statusCode)).toEqual([202, 202, 202]);
    await vi.waitFor(() => expect(releases.size).toBeGreaterThanOrEqual(1));
    expect(harness.real.mandatesV3.status(identityOf(bodies[2])).status)
      .toBe('pending_activation');

    for (const body of bodies) {
      const approval = body.serializedApproval;
      await vi.waitFor(() => expect(releases.has(approval)).toBe(true));
      releases.get(approval)();
    }
    for (const body of bodies) await waitForStatus(harness, body, 'active');
    expect(maxActive).toBe(1);
    expect(activator).toHaveBeenCalledTimes(3);
    harness.router.stopMandateActivationQueue({ cancelPending: true });
  });

  it('serializes overflow retry scans while a bounded activation is still draining', async () => {
    vi.useFakeTimers();
    let releaseActivation;
    let markFirstStarted;
    const activationGate = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    let harness;
    try {
      let calls = 0;
      const activator = vi.fn(async (_approval, { onSubmitted }) => {
        calls += 1;
        if (calls === 1) markFirstStarted();
        await onSubmitted(USER_OP_HASH);
        await activationGate;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      });
      harness = makeHarness({
        activateMandate: activator,
        recoveryConcurrency: 1,
        recoveryLimit: 1,
      });
      const bodies = [6, 7, 8].map((index) => registrationBody({
        mandateId: mandateIdAt(index),
        capability: capabilityAt(index),
        expiresAt: VALID_UNTIL_SECONDS - index,
      }));

      await Promise.all(bodies.map((body) => postMandate(harness, body)));
      await firstStarted;
      await vi.advanceTimersByTimeAsync(25 * 6);
      expect(harness.events.filter((event) => event === 'store:listRecoverable')).toHaveLength(1);

      releaseActivation();
      await vi.waitFor(() => expect(calls).toBe(3));
      for (const body of bodies) await waitForStatus(harness, body, 'active');
    } finally {
      releaseActivation?.();
      if (harness) await harness.router.stopMandateActivationQueue({ cancelPending: true });
      vi.useRealTimers();
    }
  });

  it('isolates one failed activation so the next queued registration still runs', async () => {
    let calls = 0;
    const activator = vi.fn(async (_approval, { onSubmitted }) => {
      calls += 1;
      if (calls === 1) throw new Error('T16 activation failure');
      await onSubmitted(USER_OP_HASH);
      return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
    });
    const harness = makeHarness({
      activateMandate: activator,
      recoveryConcurrency: 1,
      recoveryLimit: 1,
    });
    const first = registrationBody({
      mandateId: mandateIdAt(4),
      capability: capabilityAt(4),
      expiresAt: VALID_UNTIL_SECONDS - 4,
    });
    const second = registrationBody({
      mandateId: mandateIdAt(5),
      capability: capabilityAt(5),
      expiresAt: VALID_UNTIL_SECONDS - 5,
    });

    await postMandate(harness, first);
    await postMandate(harness, second);
    await waitForStatus(harness, second, 'active');
    expect(activator).toHaveBeenCalledTimes(2);
    harness.router.stopMandateActivationQueue({ cancelPending: true });
  });

  it('returns a generic failure without a cookie or partial row when atomic enqueue fails', async () => {
    const harness = makeHarness({
      enqueueError: new Error(`storage unavailable for ${CAPABILITY} ${SESSION_KEY}`),
    });
    const body = registrationBody();

    const { res } = await postMandate(harness, body);

    expect(res.statusCode).toBe(500);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(harness.real.mandatesV3.size).toBe(0);
    expect(harness.real.mandateActivations.get(identityOf(body))).toBeNull();
    expect(res.body).not.toContain(CAPABILITY);
    expect(res.body).not.toContain(SESSION_KEY);
    expect(res.body).not.toContain(body.serializedApproval);

    const duplicateFailure = makeHarness({
      enqueueError: new Error(`duplicate storage unavailable for ${CAPABILITY} ${SESSION_KEY}`),
    });
    duplicateFailure.real.mandateActivations.enqueue({
      record: canonicalRecord(body),
    });
    const duplicate = await postMandate(duplicateFailure, { ...body });
    expect(duplicate.res.statusCode).toBe(500);
    expect(duplicate.res.headers['Set-Cookie']).toBeUndefined();
    expect(duplicate.res.body).not.toContain(CAPABILITY);
    expect(duplicate.res.body).not.toContain(SESSION_KEY);
    expect(duplicate.res.body).not.toContain(body.serializedApproval);
  });

  it('authenticates exact duplicates before comparison and never reactivates pending or active bindings', async () => {
    let releaseActivation;
    const activationGate = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    let sends = 0;
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        sends += 1;
        await onSubmitted(USER_OP_HASH);
        await activationGate;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      },
    });
    const body = registrationBody();
    const first = await postMandate(harness, body);
    await vi.waitFor(() => expect(sends).toBe(1));

    const secondBody = registrationBody({
      mandateId: mandateIdAt(2),
      capability: capabilityAt(2),
    });
    const second = await postMandate(harness, secondBody);
    expect(second.res.statusCode).toBe(202);
    await vi.waitFor(() => expect(sends).toBe(2));

    const pendingDuplicate = await postMandate(harness, { ...body });
    expect(pendingDuplicate.res.statusCode).toBe(202);
    expect(pendingDuplicate.json).toEqual(first.json);
    expect(pendingDuplicate.res.headers['Set-Cookie']).toBe(first.res.headers['Set-Cookie']);
    expect(sends).toBe(2);

    const crossMandateCapability = await postMandate(harness, {
      ...body,
      capability: secondBody.capability,
    });
    expect(crossMandateCapability.res.statusCode).toBe(401);
    expect(crossMandateCapability.res.body).not.toContain(secondBody.capability);
    expect(crossMandateCapability.res.body).not.toContain(body.serializedApproval);
    expect(sends).toBe(2);

    const wrong = capabilityAt(99);
    const wrongCapability = await postMandate(harness, {
      ...body,
      capability: wrong,
    });
    expect(wrongCapability.res.statusCode).toBe(401);
    expect(wrongCapability.res.body).not.toContain(wrong);
    expect(wrongCapability.res.body).not.toContain(CAPABILITY);
    expect(sends).toBe(2);

    const missingCapability = await postMandate(harness, {
      ...body,
      capability: undefined,
    });
    expect(missingCapability.res.statusCode).toBe(401);
    expect(sends).toBe(2);

    releaseActivation();
    await waitForStatus(harness, body, 'active');
    await waitForStatus(harness, secondBody, 'active');
    const activeDuplicate = await postMandate(harness, { ...body });
    expect(activeDuplicate.res.statusCode).toBe(202);
    expect(activeDuplicate.json).toEqual(first.json);
    expect(activeDuplicate.json.status).toBe('pending_activation');
    expect(sends).toBe(2);
  });

  it('returns 409 for exact duplicates whose durable state is uncertain, revoked, or expired', async () => {
    const uncertain = makeHarness({
      activateMandate: async () => {
        throw new Error(`bundler rejected ${SESSION_KEY}`);
      },
    });
    const uncertainBody = registrationBody();
    await postMandate(uncertain, uncertainBody);
    await waitForStatus(uncertain, uncertainBody, 'activation_uncertain');
    const uncertainRetry = await postMandate(uncertain, { ...uncertainBody });
    expect(uncertainRetry.res.statusCode).toBe(409);
    expect(uncertainRetry.res.body).not.toContain(SESSION_KEY);

    const revoked = makeHarness();
    const revokedBody = registrationBody();
    await postMandate(revoked, revokedBody);
    await waitForStatus(revoked, revokedBody, 'active');
    revoked.real.mandatesV3.revoke(identityOf(revokedBody));
    const revokedRetry = await postMandate(revoked, { ...revokedBody });
    expect(revokedRetry.res.statusCode).toBe(409);

    const clock = { value: NOW_SECONDS };
    const expired = makeHarness({ clock });
    const expiredBody = registrationBody();
    await postMandate(expired, expiredBody);
    await waitForStatus(expired, expiredBody, 'active');
    clock.value = VALID_UNTIL_SECONDS;
    expect(expired.real.mandatesV3.status(identityOf(expiredBody)).status).toBe('expired');
    const expiredRetry = await postMandate(expired, { ...expiredBody });
    expect(expiredRetry.res.statusCode).toBe(409);
  });

  it('fails closed without activating when the stored immutable binding is corrupted before worker use', async () => {
    let corruptNextRead = true;
    let sends = 0;
    const harness = makeHarness({
      transformMandateGet(record) {
        if (!record || !corruptNextRead) return record;
        corruptNextRead = false;
        const corrupted = { ...record, bindingHash: 'ff'.repeat(32) };
        Object.defineProperty(corrupted, 'sessionPrivateKey', {
          value: record.sessionPrivateKey,
          enumerable: false,
        });
        Object.defineProperty(corrupted, 'capabilityHash', {
          value: record.capabilityHash,
          enumerable: false,
        });
        return corrupted;
      },
      activateMandate: async () => {
        sends += 1;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      },
    });
    const body = registrationBody();

    const { res } = await postMandate(harness, body);
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(['activation_uncertain', 'revoked']).toContain(harness.real.mandatesV3.status(identityOf(body)).status);
    });

    expect(sends).toBe(0);
    expect(harness.events).not.toContain('store:checkpoint:submitted');
    expect(harness.events).not.toContain('evaluator:called');
    expect(harness.events).not.toContain('store:finishActive');
    await harness.router.resumeMandateActivations();
    expect(sends).toBe(0);
  });

  it('orders claim, submitting fence, activation submission, strict receipt, fresh evidence, and active finish', async () => {
    const harness = makeHarness();
    // Address comparisons are case-insensitive, so a lowercase equivalent accepted at the wire
    // boundary must not be tombstoned later when the store normalizes it or the parser derives a
    // checksummed spelling.
    const body = registrationBody({ sessionKeyAddress: SESSION.toLowerCase() });

    const { res } = await postMandate(harness, body);
    expect(res.statusCode).toBe(202);
    await waitForStatus(harness, body, 'active');

    expectOrdered(harness.events, [
      'store:claim',
      'store:get',
      'store:checkpoint:submitting',
      'activator:called',
      'activator:onSubmitted',
      'store:checkpoint:submitted',
      'activator:receipt',
      'evaluator:called',
      'store:finishActive',
    ]);
    const evaluatorIndex = harness.events.indexOf('evaluator:called');
    const recordReads = harness.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'store:get')
      .map(({ index }) => index);
    expect(recordReads.filter((index) => index < evaluatorIndex).length).toBeGreaterThanOrEqual(2);
    expect(recordReads.some((index) => index > evaluatorIndex)).toBe(true);
    expect(harness.events).toContain(`activator:key:${SESSION_KEY}`);
    expect(harness.evaluatorCalls).toHaveLength(1);
    expect(harness.evaluatorCalls[0]).toMatchObject({
      config: CONFIG,
      record: {
        mandateId: MANDATE_ID,
        activationUserOpHash: USER_OP_HASH,
        activationTxHash: TX_HASH,
        activatedAt: NOW_SECONDS,
        sessionPrivateKey: SESSION_KEY,
      },
    });
    // The real evaluator's canonical parser consumes a shallow copy of this trusted internal
    // record. The key must therefore remain visible to that parser even though no public/store
    // serialization may expose it.
    expect({ ...harness.evaluatorCalls[0].record }.sessionPrivateKey).toBe(SESSION_KEY);
    expect(harness.evaluatorCalls[0]).not.toHaveProperty('allocation');
    expect(harness.real.mandatesV3.status(identityOf(body))).toMatchObject({
      status: 'active',
      activationUserOpHash: USER_OP_HASH,
      activationTxHash: TX_HASH,
      activatedAt: NOW_SECONDS,
    });
  });

  it.each([
    ['before onSubmitted', false, null],
    ['after onSubmitted', true, USER_OP_HASH],
  ])(
    'makes an activation failure %s uncertain without inventing evidence',
    async (_label, submitFirst, expectedHash) => {
      const harness = makeHarness({
        activateMandate: async (_approval, { onSubmitted }) => {
          if (submitFirst) await onSubmitted(USER_OP_HASH);
          throw new Error(`private activation failure ${SESSION_KEY}`);
        },
      });
      const body = registrationBody();

      const { res } = await postMandate(harness, body);
      expect(res.statusCode).toBe(202);
      expect(res.body).not.toContain(SESSION_KEY);
      await waitForStatus(harness, body, 'activation_uncertain');

      expect(harness.real.mandateActivations.get(identityOf(body))).toMatchObject({
        status: 'uncertain',
        userOpHash: expectedHash,
        txHash: null,
        leaseToken: null,
      });
      expect(harness.events).toContain('store:finishUncertain');
      expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body)))).not.toContain(
        'private activation failure',
      );
    },
  );

  it('retains the callback hash when the submitted checkpoint loses its lease', async () => {
    const realStores = createMandateStoresV3({
      nowSeconds: () => NOW_SECONDS,
      leaseToken: (() => {
        let value = 0;
        return () => `checkpoint-lease-${++value}`;
      })(),
    });
    const checkpoint = realStores.mandateActivations.checkpoint.bind(realStores.mandateActivations);
    realStores.mandateActivations.checkpoint = vi.fn((input) => {
      if (input.status === 'submitted') throw new Error('submitted checkpoint lease lost');
      return checkpoint(input);
    });
    const harness = makeHarness({
      realStores,
      activateMandate: async (_approval, { onSubmitted }) => {
        await onSubmitted(USER_OP_HASH);
        throw new Error('activation failed after submitted checkpoint lease loss');
      },
    });
    const body = registrationBody();
    const { res } = await postMandate(harness, body);
    expect(res.statusCode).toBe(202);
    await waitForStatus(harness, body, 'activation_uncertain');
    expect(realStores.mandateActivations.get(identityOf(body))).toMatchObject({
      status: 'uncertain',
      userOpHash: USER_OP_HASH,
      txHash: null,
      leaseToken: null,
    });
  });

  it('rejects a mismatched strict activator result without evaluation, active finish, or resend', async () => {
    const mismatchedHash = `0x${'55'.repeat(32)}`;
    let sends = 0;
    let evaluations = 0;
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        sends += 1;
        await onSubmitted(USER_OP_HASH);
        return { userOpHash: mismatchedHash, txHash: TX_HASH };
      },
      evaluateMandateStatusFn: async () => {
        evaluations += 1;
        return { status: 'active', reasonCodes: [] };
      },
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'activation_uncertain');

    expect(harness.real.mandateActivations.get(identityOf(body))).toMatchObject({
      status: 'uncertain',
      userOpHash: USER_OP_HASH,
      txHash: null,
    });
    expect(evaluations).toBe(0);
    expect(harness.events).not.toContain('store:finishActive');
    await harness.router.resumeMandateActivations();
    expect(sends).toBe(1);
  });

  it('retains both receipt hashes as uncertain when fresh post-receipt evidence is nonactive', async () => {
    const harness = makeHarness({
      evaluateMandateStatusFn: async () => ({
        status: 'unknown',
        reasonCodes: ['RPC_ERROR'],
      }),
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'activation_uncertain');

    expect(harness.real.mandateActivations.get(identityOf(body))).toMatchObject({
      status: 'uncertain',
      userOpHash: USER_OP_HASH,
      txHash: TX_HASH,
    });
    expect(harness.events).not.toContain('store:finishActive');
  });

  it('atomically tombstones and erases the key when fresh receipt evidence says revoked', async () => {
    const harness = makeHarness({
      evaluateMandateStatusFn: async () => ({
        status: 'revoked',
        reasonCodes: ['PERMISSION_REVOKED'],
      }),
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'revoked');

    expect(harness.real.mandatesV3.status(identityOf(body))).toMatchObject({
      status: 'revoked',
      activationUserOpHash: USER_OP_HASH,
      activationTxHash: TX_HASH,
    });
    expect(harness.real.mandateActivations.get(identityOf(body))).toBeNull();
    const internal = harness.real.mandatesV3.get(identityOf(body));
    expect(internal.sessionPrivateKey).toBeUndefined();
    expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
    expect(harness.events).toContain('store:finishRevoked');
  });

  it('reconciles restart leases and resumes only stale-running and untouched-pending work once', async () => {
    const clock = { value: NOW_SECONDS };
    const invalidCapabilityId = mandateIdAt(5);
    const harness = makeHarness({
      clock,
      transformMandateGet(record, identity) {
        if (!record || identity.mandateId !== invalidCapabilityId) return record;
        const descriptors = Object.getOwnPropertyDescriptors(record);
        descriptors.capabilityHash = {
          ...descriptors.capabilityHash,
          value: 'not-a-canonical-capability-hash',
        };
        return Object.create(Object.getPrototypeOf(record), descriptors);
      },
    });
    const bodies = [1, 2, 3, 4].map((index) =>
      registrationBody({
        mandateId: mandateIdAt(index),
        capability: capabilityAt(index),
      }),
    );
    for (const [index, body] of bodies.entries()) {
      harness.real.mandateActivations.enqueue({
        record: canonicalRecord(body, `resume-binding-${index + 1}`),
      });
    }
    const legacyBody = registrationBody({
      mandateId: 'legacy-uuid-mandate-id',
      capability: capabilityAt(5),
    });
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(legacyBody, 'legacy-binding'),
    });
    const invalidCapabilityBody = registrationBody({
      mandateId: invalidCapabilityId,
      capability: capabilityAt(5),
    });
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(invalidCapabilityBody, 'invalid-capability-binding'),
    });
    const [running, submitting, submitted, pending] = bodies;
    const runningLease = harness.real.mandateActivations.claim({
      ...identityOf(running),
      nowSeconds: NOW_SECONDS,
      leaseSeconds: 5,
    });
    const submittingLease = harness.real.mandateActivations.claim({
      ...identityOf(submitting),
      nowSeconds: NOW_SECONDS,
      leaseSeconds: 5,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitting),
      leaseToken: submittingLease.leaseToken,
      status: 'submitting',
      nowSeconds: NOW_SECONDS,
    });
    const submittedLease = harness.real.mandateActivations.claim({
      ...identityOf(submitted),
      nowSeconds: NOW_SECONDS,
      leaseSeconds: 5,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitted),
      leaseToken: submittedLease.leaseToken,
      status: 'submitting',
      nowSeconds: NOW_SECONDS,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitted),
      leaseToken: submittedLease.leaseToken,
      status: 'submitted',
      userOpHash: USER_OP_HASH,
      nowSeconds: NOW_SECONDS,
    });
    expect(runningLease.status).toBe('running');
    expect(harness.real.mandateActivations.get(identityOf(pending)).status).toBe('pending');
    clock.value = NOW_SECONDS + 6;

    await harness.router.resumeMandateActivations();
    await waitForStatus(harness, running, 'active');
    await waitForStatus(harness, pending, 'active');

    expect(harness.real.mandatesV3.status(identityOf(submitting)).status).toBe('activation_uncertain');
    expect(harness.real.mandatesV3.status(identityOf(submitted)).status).toBe('activation_uncertain');
    expect(harness.real.mandateActivations.get(identityOf(submitting))).toMatchObject({
      status: 'uncertain',
      userOpHash: null,
    });
    expect(harness.real.mandateActivations.get(identityOf(submitted))).toMatchObject({
      status: 'uncertain',
      userOpHash: USER_OP_HASH,
    });
    expect(harness.events.filter((event) => event === 'activator:called')).toHaveLength(2);
    expect(harness.events.filter((event) => event === 'store:reconcileExpired')).toHaveLength(1);
    expect(harness.real.mandatesV3.status(identityOf(legacyBody)).status).toBe('revoked');
    expect(harness.real.mandatesV3.status(identityOf(invalidCapabilityBody)).status).toBe('revoked');
  });

  it('deduplicates concurrent restart resumes and duplicate HTTP registration', async () => {
    let releaseActivation;
    const gate = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    let sends = 0;
    const harness = makeHarness({
      activateMandate: async (_approval, { onSubmitted }) => {
        sends += 1;
        await onSubmitted(USER_OP_HASH);
        await gate;
        return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
      },
    });
    const body = registrationBody();

    const firstResponse = mockRes();
    const retryResponse = mockRes();
    const work = [
      harness.router(request({ ...body }), firstResponse),
      harness.router(request({ ...body }), retryResponse),
      harness.router.resumeMandateActivations(),
      harness.router.resumeMandateActivations(),
    ];
    await vi.waitFor(() => expect(sends).toBe(1));
    expect(firstResponse.statusCode).toBe(202);
    expect(retryResponse.statusCode).toBe(202);
    expect(jsonOf(retryResponse)).toEqual(jsonOf(firstResponse));
    expect(retryResponse.headers['Set-Cookie']).toBe(firstResponse.headers['Set-Cookie']);
    releaseActivation();
    await Promise.all(work);
    await waitForStatus(harness, body, 'active');

    expect(sends).toBe(1);
    expect(harness.real.mandateActivations.get(identityOf(body)).attempts).toBe(1);

    const authorityRace = makeHarness();
    const correctResponse = mockRes();
    const wrongResponse = mockRes();
    const wrongCapability = capabilityAt(99);
    await Promise.all([
      authorityRace.router(request({ ...body }), correctResponse),
      authorityRace.router(request({ ...body, capability: wrongCapability }), wrongResponse),
    ]);
    await waitForStatus(authorityRace, body, 'active');
    expect(correctResponse.statusCode).toBe(202);
    expect(wrongResponse.statusCode).toBe(401);
    expect(wrongResponse.body).not.toContain(wrongCapability);
    expect(authorityRace.activatorCalls).toHaveLength(1);

    const sharedClock = { value: NOW_SECONDS };
    const sharedReal = createMandateStoresV3({
      nowSeconds: () => sharedClock.value,
      leaseToken: (() => {
        let value = 0;
        return () => `shared-activation-lease-${++value}`;
      })(),
    });
    const left = makeHarness({
      clock: sharedClock,
      realStores: sharedReal,
      bindingPrefix: 'left-binding',
    });
    const right = makeHarness({
      clock: sharedClock,
      realStores: sharedReal,
      bindingPrefix: 'right-binding',
    });
    const sharedLeftResponse = mockRes();
    const sharedRightResponse = mockRes();
    await Promise.all([
      left.router(request({ ...body }), sharedLeftResponse),
      right.router(request({ ...body }), sharedRightResponse),
    ]);
    await waitForStatus(left, body, 'active');
    expect(sharedLeftResponse.statusCode).toBe(202);
    expect(sharedRightResponse.statusCode).toBe(202);
    expect(jsonOf(sharedRightResponse)).toEqual(jsonOf(sharedLeftResponse));
    expect(sharedRightResponse.headers['Set-Cookie']).toBe(sharedLeftResponse.headers['Set-Cookie']);
    expect(left.activatorCalls.length + right.activatorCalls.length).toBe(1);

    const wrongSharedReal = createMandateStoresV3({
      nowSeconds: () => sharedClock.value,
    });
    const correctProcess = makeHarness({
      clock: sharedClock,
      realStores: wrongSharedReal,
      bindingPrefix: 'correct-binding',
    });
    const wrongProcess = makeHarness({
      clock: sharedClock,
      realStores: wrongSharedReal,
      bindingPrefix: 'wrong-binding',
    });
    const correctProcessResponse = mockRes();
    const wrongProcessResponse = mockRes();
    await Promise.all([
      correctProcess.router(request({ ...body }), correctProcessResponse),
      wrongProcess.router(request({ ...body, capability: wrongCapability }), wrongProcessResponse),
    ]);
    await waitForStatus(correctProcess, body, 'active');
    expect(correctProcessResponse.statusCode).toBe(202);
    expect(wrongProcessResponse.statusCode).toBe(401);
    expect(wrongProcessResponse.body).not.toContain(wrongCapability);
    expect(correctProcess.activatorCalls.length + wrongProcess.activatorCalls.length).toBe(1);
  });

  it('heartbeats a submitted activation lease while the external receipt wait exceeds 30 seconds', async () => {
    vi.useFakeTimers();
    let releaseReceipt;
    let enteredReceiptWait;
    const receiptGate = new Promise((resolve) => {
      releaseReceipt = resolve;
    });
    const entered = new Promise((resolve) => {
      enteredReceiptWait = resolve;
    });
    let harness;
    try {
      harness = makeHarness({
        activateMandate: async (_approval, { onSubmitted }) => {
          await onSubmitted(USER_OP_HASH);
          harness.events.push('activator:waiting-receipt');
          enteredReceiptWait();
          await receiptGate;
          harness.events.push('activator:receipt');
          return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
        },
      });
      const body = registrationBody();

      const { res } = await postMandate(harness, body);
      expect(res.statusCode).toBe(202);
      await entered;
      for (let interval = 0; interval < 3; interval += 1) {
        harness.clock.value += 11;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(harness.clock.value).toBeGreaterThan(NOW_SECONDS + 30);
      expect(harness.real.mandateActivations.get(identityOf(body)).status).toBe('submitted');

      releaseReceipt();
      await vi.waitFor(() => {
        expect(harness.real.mandatesV3.status(identityOf(body)).status).toBe('active');
      });

      const waitingIndex = harness.events.indexOf('activator:waiting-receipt');
      const receiptIndex = harness.events.indexOf('activator:receipt');
      const waitRenewals = harness.events
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => event === 'store:renew' && index > waitingIndex && index < receiptIndex);
      expect(waitRenewals.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews the real lease before and after fresh evaluation', async () => {
    let harness;
    harness = makeHarness({
      evaluateMandateStatusFn: async () => {
        harness.events.push('evaluator:begin');
        harness.clock.value += 1;
        harness.events.push('evaluator:end');
        return { status: 'active', reasonCodes: [] };
      },
    });
    const body = registrationBody();

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'active');

    const begin = harness.events.indexOf('evaluator:begin');
    const end = harness.events.indexOf('evaluator:end');
    const renewals = harness.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'store:renew')
      .map(({ index }) => index);
    expect(renewals.some((index) => index < begin)).toBe(true);
    expect(renewals.some((index) => index > end)).toBe(true);
    expect(harness.events.indexOf('store:finishActive')).toBeGreaterThan(renewals.at(-1));
  });

  it('cannot finish active when authority is revoked during a stale-active evaluation race', async () => {
    let harness;
    const body = registrationBody();
    harness = makeHarness({
      evaluateMandateStatusFn: async () => {
        harness.real.mandatesV3.revoke(identityOf(body));
        return { status: 'active', reasonCodes: [] };
      },
    });

    await postMandate(harness, body);
    await waitForStatus(harness, body, 'revoked');

    expect(harness.real.mandatesV3.status(identityOf(body)).status).toBe('revoked');
    expect(harness.real.mandatesV3.get(identityOf(body)).sessionPrivateKey).toBeUndefined();
    expect(harness.events).not.toContain('store:finishActive');
  });

  it('rejects new mandate registration before capability validation or mandate storage when Base is unavailable', async () => {
    const harness = makeHarness({ baseCrossChainAvailable: false });
    const { res, json } = await postMandate(harness, registrationBody({ capability: 'malformed' }));

    expect(res.statusCode).toBe(503);
    expect(json).toEqual({
      error: 'Base cross-chain execution is unavailable',
    });
    expect(harness.events).toEqual([]);
    expect(harness.real.mandatesV3.size).toBe(0);
  });

  it('does not resume activation work or touch activation storage when Base is unavailable', async () => {
    const harness = makeHarness({ baseCrossChainAvailable: false });

    await expect(harness.router.resumeMandateActivations()).resolves.toEqual({
      resumed: [],
      held: [],
    });
    expect(harness.events).toEqual([]);
  });
});

describe('v3 mandate canonical registration validation', () => {
  it.each([
    ['session private key/address mismatch', () => registrationBody({ sessionKeyAddress: OTHER_SESSION_ADDRESS })],
    [
      'approval account/kernel mismatch',
      () =>
        registrationBody({
          kernelAddress: OTHER_KERNEL,
          serializedApproval: canonicalApproval(VALID_UNTIL_SECONDS),
        }),
    ],
    ['invalid Stellar owner StrKey', () => registrationBody({ stellarOwner: 'not-a-stellar-address' })],
    [
      'forbidden withdraw permission',
      () =>
        registrationBody({
          serializedApproval: canonicalApproval(VALID_UNTIL_SECONDS, {
            extraPermissions: [WITHDRAW_PERMISSION],
          }),
        }),
    ],
    [
      'policy cap above the disclosed maximum',
      () =>
        registrationBody({
          serializedApproval: canonicalApproval(VALID_UNTIL_SECONDS, {
            cap: MAX_CALL_CAP_UNITS + 1n,
          }),
        }),
    ],
    [
      'expired embedded timestamp policy',
      () =>
        registrationBody({
          serializedApproval: canonicalApproval(NOW_SECONDS - 1),
        }),
    ],
  ])(
    'rejects canonical malformed mandate authority: %s before enqueue, activation, cookie, or secret persistence',
    async (_label, bodyFactory) => {
      const harness = makeHarness();
      const body = bodyFactory();

      const { res } = await postMandate(harness, body);

      expect(res.statusCode).toBe(400);
      expect(res.headers['Set-Cookie']).toBeUndefined();
      expect(harness.real.mandatesV3.size).toBe(0);
      expect(harness.events).not.toContain('store:enqueue');
      expect(harness.activatorCalls).toHaveLength(0);
      expect(harness.events.some((event) => event.startsWith('activator:key:'))).toBe(false);
      expect(res.body).not.toContain(body.capability);
      expect(res.body).not.toContain(body.serializedApproval);
      expect(res.body).not.toContain(body.sessionPrivateKey);
    },
  );
});

describe('v3 mandate route authorization and execution gates', () => {
  const SECOND_MANDATE_ID = mandateIdAt(2);
  const SECOND_CAPABILITY = capabilityAt(2);
  const WRONG_CAPABILITY = capabilityAt(99);
  const SECOND_POOL = `0x${'55'.repeat(20)}`;
  const JOB_ID_RE = /^[0-9a-f]{32}$/;
  const routeJobIdAt = (index) => (0x1000 + index).toString(16).padStart(32, '0');
  const FIRST_JOB_ID = routeJobIdAt(1);
  const PRIVATE_JOB_ID = routeJobIdAt(90);
  const OWNED_JOB_ID = routeJobIdAt(91);
  const STATUS_JOB_ID = routeJobIdAt(92);
  const SECOND_STATUS_JOB_ID = routeJobIdAt(93);
  const UNKNOWN_JOB_ID = routeJobIdAt(99);
  const REVOKE_COOKIE = `__Host-vf-mandate-${MANDATE_ID}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  const ACTIVE_ROUTE_EVIDENCE = Object.freeze({
    version: 2,
    status: 'active',
    reasonCodes: [],
    expected: { owner: OWNER, kernelAddress: KERNEL },
    observed: {
      blockNumber: '101',
      blockHash: `0x${'66'.repeat(32)}`,
      blockTime: NOW_SECONDS,
      activation: {
        userOpHash: USER_OP_HASH,
        txHash: TX_HASH,
        activatedAt: NOW_SECONDS,
      },
    },
    checks: { activation: true, permissionInstalled: true, freshBlock: true },
  });

  function routeCipher() {
    return createSecretEnvelope(parseSecretKeyring(`route-tests:${Buffer.alloc(32, 19).toString('base64')}`));
  }

  function routeBody(overrides = {}) {
    return registrationBody({
      mandateId: MANDATE_ID,
      capability: CAPABILITY,
      ...overrides,
    });
  }

  function secondRouteBody(overrides = {}) {
    return registrationBody({
      mandateId: SECOND_MANDATE_ID,
      capability: SECOND_CAPABILITY,
      ...overrides,
    });
  }

  function routeIdentity(body = routeBody()) {
    return identityOf(body);
  }

  function routeAllocations(runId = 'run-42') {
    return [
      wireAllocation({
        allocationId: `${runId}:bridge:aave-v3`,
        pool: POOL_ADDRESS,
        units: 400n,
        minShares: '390',
      }),
      wireAllocation({
        allocationId: `${runId}:bridge:blend-v2`,
        pool: SECOND_POOL,
        units: 600n,
        minShares: '580',
      }),
    ];
  }

  function farmBody(body = routeBody(), overrides = {}) {
    return {
      sourceDomain: 27,
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'bridge-agent-1',
      runId: 'run-42',
      grantTxHash: 'grant-1',
      allocations: routeAllocations(),
      ...overrides,
    };
  }

  function attachBody(jobId, body = routeBody(), burnTxHash = 'burn-1') {
    return {
      jobId,
      burnTxHash,
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
    };
  }

  function statusBody(body = routeBody()) {
    return {
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
    };
  }

  function bearer(capability) {
    return capability === undefined ? {} : { authorization: `Bearer ${capability}` };
  }

  function protectedRequest(path, body, capability) {
    return {
      method: 'POST',
      url: `/api/vf-cross${path}`,
      body,
      headers: bearer(capability),
    };
  }

  async function postProtected(harness, path, body, ...capabilityArgs) {
    const capability = capabilityArgs.length === 0 ? CAPABILITY : capabilityArgs[0];
    const res = mockRes();
    await harness.router(protectedRequest(path, body, capability), res);
    return { res, json: jsonOf(res) };
  }

  async function flushMicrotasks(turns = 20) {
    for (let index = 0; index < turns; index += 1) {
      await Promise.resolve();
    }
  }

  function preserveInternalRecord(record, changes = {}) {
    if (!record) return record;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    for (const [key, value] of Object.entries(changes)) {
      descriptors[key] = {
        value,
        enumerable: descriptors[key]?.enumerable ?? true,
        configurable: true,
        writable: true,
      };
    }
    return Object.create(Object.getPrototypeOf(record), descriptors);
  }

  function tracePureBindingRead(record, events) {
    if (!record) return record;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const bindingHash = record.bindingHash;
    descriptors.bindingHash = {
      enumerable: descriptors.bindingHash?.enumerable ?? true,
      configurable: true,
      get() {
        events.push('binding:pure');
        return bindingHash;
      },
    };
    return Object.create(Object.getPrototypeOf(record), descriptors);
  }

  function makeRouteHarness({
    clock = { value: NOW_SECONDS },
    realStores = null,
    jobs: providedJobs = null,
    evidence = ACTIVE_ROUTE_EVIDENCE,
    evidenceSequence = [],
    transformMandateGet,
    farmImplementation,
    buildFarmImplementation,
    reporterImplementation,
    associationOutbox: providedOutbox = null,
    baseEvidenceOutbox: providedEvidenceOutbox = null,
    farmIntents: providedFarmIntents = null,
    cctpRelays: providedCctpRelays = null,
    forwardFarmDeployment = null,
    relayForwardMint = null,
    sanitizeErrors = false,
    poolTargets: providedPoolTargets = null,
    baseCrossChainAvailable = true,
  } = {}) {
    const events = [];
    const requestUrls = [];
    const real =
      realStores ??
      createMandateStoresV3({
        nowSeconds: () => clock.value,
        leaseToken: (() => {
          let value = 0;
          return () => `route-activation-lease-${++value}`;
        })(),
      });
    const jobs = providedJobs ?? new Map();
    const reports = [];
    const delivery = [];
    const associationOutbox = providedOutbox ?? {
      enqueue: vi.fn((input) => {
        const rows = Array.isArray(input) ? input : [input];
        reports.push(...rows);
        events.push('outbox:enqueue');
        return rows.map((report) => ({
          duplicate: false,
          status: 'pending',
          report,
        }));
      }),
      status: vi.fn((identity) =>
        delivery.filter((row) => row.childId === identity.childId && row.executionId === identity.executionId),
      ),
    };
    const evidenceRows = [];
    const baseEvidenceOutbox = providedEvidenceOutbox ??
      realStores?.baseEvidenceOutbox ?? {
        seed: vi.fn(() => ({ duplicate: false, recoveryVersion: 0 })),
        enqueue: vi.fn((checkpoint) => {
          evidenceRows.push(checkpoint);
          return {
            state: checkpoint.status,
            expectedRecoveryVersion: evidenceRows.length - 1,
          };
        }),
        status: vi.fn((identity) => ({
          complete: false,
          blocked: false,
          recoveryVersion: evidenceRows.filter((row) => row.identity.executionId === identity.executionId).length,
          events: [],
        })),
      };
    const reporter = {
      commitIntentBatch: vi.fn(async (batch) => {
        events.push('reporter:intent');
        if (reporterImplementation) return reporterImplementation(batch);
        const canonicalJson = (value) => {
          if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
          if (value && typeof value === 'object') {
            return `{${Object.keys(value)
              .sort()
              .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
              .join(',')}}`;
          }
          return JSON.stringify(value);
        };
        return {
          idempotencyKey: batch.idempotencyKey,
          requestDigest: createHash('sha256').update(canonicalJson(batch)).digest('hex'),
          acknowledged: true,
          children: batch.children.map((child) => ({
            identity: {
              networkId: child.networkId,
              bindingId: child.bindingId,
              executionId: child.executionId,
              allocationId: child.allocationId,
              childId: child.childId,
            },
            recoveryVersion: 0,
          })),
          schemaVersion: 1,
          written: batch.children.length,
          duplicates: 0,
        };
      }),
    };
    let transformGet = transformMandateGet ?? ((record) => record);
    const mandatesV3 = {
      authority(mandateId) {
        events.push('store:get');
        return real.mandatesV3.authority(mandateId);
      },
      get(identity) {
        events.push('store:get');
        return transformGet(real.mandatesV3.get(identity), identity);
      },
      status(identity) {
        events.push('store:status');
        return real.mandatesV3.status(identity);
      },
      revoke(identity) {
        events.push('store:revoke');
        return real.mandatesV3.revoke(identity);
      },
      get size() {
        return real.mandatesV3.size;
      },
    };
    const sequence = [...evidenceSequence];
    let currentEvidence = evidence;
    const evaluator = vi.fn(async (args) => {
      events.push('evaluator:fresh');
      const selected = sequence.length > 0 ? sequence.shift() : currentEvidence;
      return typeof selected === 'function' ? selected(args) : selected;
    });
    const farmFn = vi.fn(async (params) => {
      events.push('farm:called');
      if (farmImplementation) return farmImplementation(params);
      const mintResult = {
        status: 'minted',
        mintTxHash: '0xmint',
        evidence: {
          burnTxHash: 'burn-default',
          expectationDigest: 'expectation-default',
          messageDigest: 'message-default',
          attestationDigest: 'attestation-default',
          evidenceVersion: '1',
          mintTxHash: '0xmint',
        },
      };
      await params.onMintConfirmed?.(mintResult);
      return {
        mintResult,
        depositResults: params.allocations.map((allocation) => ({
          allocationId: allocation.allocationId,
          status: 'fulfilled',
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          txHash: `deposit:${allocation.allocationId}`,
        })),
        runId: params.runId,
        bridgeAgent: params.bridgeAgent,
        grantTxHash: params.grantTxHash,
      };
    });
    const buildFarm = vi.fn((sessionPrivateKey) => {
      events.push('buildFarm');
      if (buildFarmImplementation) return buildFarmImplementation(sessionPrivateKey);
      return { farm: (params) => farmFn(params) };
    });
    let nextJob = 0;
    const routeHandler = createRelayerRouter({
      buildFarm,
      jobs,
      mandatesV2: new Proxy(
        {},
        {
          get() {
            throw new Error('v2 mandate store must not be consulted by v3 routes');
          },
        },
      ),
      mandatesV3,
      mandateActivations: real.mandateActivations,
      buildMandateActivator: () => ({
        activateMandate: vi.fn(async () => {
          throw new Error('route tests must not activate a mandate');
        }),
      }),
      genId: () => routeJobIdAt(++nextJob),
      usdcAddress: CANONICAL_USDC,
      yieldRouterAddress: CANONICAL_ROUTER,
      relayerOrigin: CONFIG.publicOrigin,
      networkId: 'stellar-testnet',
      publicRuntime: {
        networkId: 'stellar-testnet',
        readiness: { ready: true },
        baseCrossChainAvailable,
        unavailableReason: baseCrossChainAvailable ? null : 'Hardened Base deployment is not active.',
      },
      evaluateMandateStatusFn: evaluator,
      mandateStatusConfig: CONFIG,
      nowSeconds: () => clock.value,
      poolTargets:
        providedPoolTargets ??
        new Map([
          [POOL_ADDRESS.toLowerCase(), 'aave-v3'],
          [SECOND_POOL.toLowerCase(), 'blend-v2'],
        ]),
      agentIndexReporter: reporter,
      associationOutbox,
      baseEvidenceOutbox,
      farmIntents: providedFarmIntents,
      cctpRelays: providedCctpRelays,
      forwardFarmDeployment,
      relayForwardMint,
      sanitizeErrors,
    });
    const router = async (req, res) => {
      requestUrls.push(req.url);
      return routeHandler(req, res);
    };
    router.resumeFarmJobs = routeHandler.resumeFarmJobs;
    router.resumeMandateActivations = routeHandler.resumeMandateActivations;
    return {
      clock,
      events,
      requestUrls,
      real,
      mandatesV3,
      jobs,
      reports,
      evidenceRows,
      delivery,
      associationOutbox,
      reporter,
      evaluator,
      farmFn,
      buildFarm,
      farmIntents: providedFarmIntents,
      router,
      setEvidence(next) {
        currentEvidence = next;
      },
      pushEvidence(...next) {
        sequence.push(...next);
      },
      setTransformMandateGet(next) {
        transformGet = next;
      },
    };
  }

  function seedActiveMandate(harness, body, bindingId = 'active-binding-1') {
    const identity = identityOf(body);
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(body, bindingId),
    });
    const claimed = harness.real.mandateActivations.claim({
      ...identity,
      nowSeconds: harness.clock.value,
    });
    harness.real.mandateActivations.checkpoint({
      ...identity,
      leaseToken: claimed.leaseToken,
      status: 'submitting',
      nowSeconds: harness.clock.value,
    });
    harness.real.mandateActivations.checkpoint({
      ...identity,
      leaseToken: claimed.leaseToken,
      status: 'submitted',
      userOpHash: USER_OP_HASH,
      nowSeconds: harness.clock.value,
    });
    harness.real.mandateActivations.finishActive({
      ...identity,
      leaseToken: claimed.leaseToken,
      userOpHash: USER_OP_HASH,
      txHash: TX_HASH,
      activatedAt: harness.clock.value,
      nowSeconds: harness.clock.value,
    });
    return harness.real.mandatesV3.get(identity);
  }

  function seedPendingMandate(harness, body, bindingId = 'pending-binding-1') {
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(body, bindingId),
    });
    return harness.real.mandatesV3.status(identityOf(body));
  }

  function seedUncertainMandate(harness, body, bindingId = 'uncertain-binding-1') {
    const identity = identityOf(body);
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(body, bindingId),
    });
    const claimed = harness.real.mandateActivations.claim({
      ...identity,
      nowSeconds: harness.clock.value,
    });
    harness.real.mandateActivations.checkpoint({
      ...identity,
      leaseToken: claimed.leaseToken,
      status: 'submitting',
      nowSeconds: harness.clock.value,
    });
    harness.real.mandateActivations.finishUncertain({
      ...identity,
      leaseToken: claimed.leaseToken,
      nowSeconds: harness.clock.value,
    });
    return harness.real.mandatesV3.status(identity);
  }

  function durableFenceRecord(body, bindingId, status) {
    const fenceClock = { value: NOW_SECONDS };
    const stores = createMandateStoresV3({
      nowSeconds: () => fenceClock.value,
      leaseToken: () => `fence-${status}-lease`,
    });
    const identity = identityOf(body);
    stores.mandateActivations.enqueue({
      record: canonicalRecord(body, bindingId),
    });

    if (status === 'activation_uncertain') {
      const claimed = stores.mandateActivations.claim({
        ...identity,
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.checkpoint({
        ...identity,
        leaseToken: claimed.leaseToken,
        status: 'submitting',
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.finishUncertain({
        ...identity,
        leaseToken: claimed.leaseToken,
        nowSeconds: fenceClock.value,
      });
    } else if (status === 'revoked') {
      stores.mandatesV3.revoke(identity);
    } else if (status === 'expired') {
      const claimed = stores.mandateActivations.claim({
        ...identity,
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.checkpoint({
        ...identity,
        leaseToken: claimed.leaseToken,
        status: 'submitting',
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.checkpoint({
        ...identity,
        leaseToken: claimed.leaseToken,
        status: 'submitted',
        userOpHash: USER_OP_HASH,
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.finishActive({
        ...identity,
        leaseToken: claimed.leaseToken,
        userOpHash: USER_OP_HASH,
        txHash: TX_HASH,
        activatedAt: fenceClock.value,
        nowSeconds: fenceClock.value,
      });
      fenceClock.value = body.expiresAt;
      stores.mandatesV3.status(identity);
    } else if (status !== 'pending_activation') {
      throw new Error(`unsupported fence fixture status: ${status}`);
    }

    const record = stores.mandatesV3.get(identity);
    if (status === 'expired') {
      expect(stores.mandatesV3.status(identity).status).toBe('expired');
      expect(record?.status).toBe('active');
      expect(record?.sessionPrivateKey).toBeUndefined();
    } else {
      expect(record?.status).toBe(status);
    }
    return record;
  }

  function expectPrivateMaterialAbsent(value, body = routeBody()) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    expect(text).not.toContain(body.serializedApproval);
    expect(text).not.toContain(body.sessionPrivateKey);
    expect(text).not.toContain(body.capability);
    expect(text).not.toMatch(/sessionPrivateKey|capabilityHash|_attach/);
  }

  function expectGenericUnauthorized(res, body = routeBody()) {
    expect(res.statusCode).toBe(401);
    expect(jsonOf(res)).toEqual({ error: 'unauthorized' });
    expectPrivateMaterialAbsent(res.body, body);
    expect(res.body).not.toMatch(
      /pending_activation|activation_uncertain|active-binding|private-step-sentinel|0x3333|0x4444/i,
    );
  }

  it('keeps OPTIONS/config public while advertising Authorization only at the fixed POST surface', async () => {
    const harness = makeRouteHarness();
    const options = mockRes();
    await harness.router(
      {
        method: 'OPTIONS',
        url: '/api/vf-cross/farm',
        body: {},
        headers: {},
      },
      options,
    );
    expect(options.statusCode).toBe(204);
    expect(options.headers['Access-Control-Allow-Headers']).toMatch(/Authorization/);
    expect(options.body).toBe('');

    const config = mockRes();
    await harness.router(
      {
        method: 'GET',
        url: '/api/vf-cross/config',
        headers: {},
      },
      config,
    );
    expect(config.statusCode).toBe(200);
    expect(jsonOf(config)).toMatchObject({
      networkId: 'stellar-testnet',
      readiness: { ready: true },
      baseCrossChainAvailable: true,
      unavailableReason: null,
    });
    expect(config.body).not.toMatch(/deployment|verification|rpc|runtimeCodeHash|adminSafe|selector/i);
    expectPrivateMaterialAbsent(config.body);

    const unknown = mockRes();
    await harness.router(
      {
        method: 'POST',
        url: '/api/vf-cross/not-a-route',
        body: {},
        headers: {},
      },
      unknown,
    );
    expect(unknown.statusCode).toBe(404);
  });

  const PROTECTED_ROUTE_CASES = [
    {
      label: 'mandate status',
      path: '/mandate/status',
      body: () => statusBody(),
    },
    {
      label: 'mandate revoke',
      path: '/mandate/revoke',
      body: () => statusBody(),
    },
    {
      label: 'farm intent',
      path: '/farm',
      body: () => farmBody(),
    },
    {
      label: 'farm attach',
      path: '/farm/attach',
      body: () => attachBody(PRIVATE_JOB_ID),
    },
    {
      label: 'farm status',
      path: '/status',
      body: () => ({ mandateId: MANDATE_ID, jobId: PRIVATE_JOB_ID }),
    },
  ];
  const INVALID_AUTHORITIES = [
    ['missing bearer', undefined],
    ['wrong bearer', WRONG_CAPABILITY],
    ['another mandate bearer', SECOND_CAPABILITY],
  ];
  const INVALID_JOB_IDS = [
    ['short', 'abcd'],
    ['uppercase hex', 'A'.repeat(32)],
    ['non-hex', 'g'.repeat(32)],
    ['numeric', 4097],
  ];

  const PROTECTED_AUTH_MATRIX = PROTECTED_ROUTE_CASES.flatMap((routeCase) =>
    INVALID_AUTHORITIES.map(([authorityLabel, capability]) => ({
      routeCase,
      routeLabel: routeCase.label,
      authorityLabel,
      capability,
    })),
  );

  it.each(PROTECTED_AUTH_MATRIX)(
    'returns indistinguishable 401 for $routeLabel with $authorityLabel before state disclosure',
    async ({ routeCase, capability }) => {
      const harness = makeRouteHarness();
      const bodyA = routeBody();
      const bodyB = secondRouteBody();
      const active = seedActiveMandate(harness, bodyA);
      seedActiveMandate(harness, bodyB, 'active-binding-2');
      harness.events.length = 0;
      harness.jobs.set(PRIVATE_JOB_ID, {
        status: 'queued',
        steps: [{ step: 'private-step-sentinel', status: 'secret' }],
        runId: 'run-42',
        bridgeAgent: 'bridge-agent-1',
        grantTxHash: 'grant-1',
        _attach: {
          mandateId: MANDATE_ID,
          stellarOwner: OWNER,
          kernelAddress: KERNEL,
          bindingId: active.bindingId,
          bindingHash: active.bindingHash,
          networkId: 'stellar-testnet',
          jobId: PRIVATE_JOB_ID,
          allocations: routeAllocations(),
          associations: routeAllocations().map(({ allocationId }) => ({
            allocationId,
            terminalSequence: null,
          })),
          attachedBurnTxHash: null,
        },
      });
      const beforeJob = JSON.stringify(harness.jobs.get(PRIVATE_JOB_ID));
      const beforeMandate = harness.real.mandatesV3.status(routeIdentity(bodyA));
      const jobGet = vi.spyOn(harness.jobs, 'get');
      jobGet.mockClear();

      const { res } = await postProtected(harness, routeCase.path, routeCase.body(), capability);

      expectGenericUnauthorized(res, bodyA);
      expect(jobGet).not.toHaveBeenCalled();
      jobGet.mockRestore();
      expect(JSON.stringify(harness.jobs.get(PRIVATE_JOB_ID))).toBe(beforeJob);
      expect(harness.real.mandatesV3.status(routeIdentity(bodyA))).toEqual(beforeMandate);
      expect(harness.evaluator).not.toHaveBeenCalled();
      expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(harness.events).not.toContain('store:revoke');
      expect(harness.reports).toHaveLength(0);
    },
  );

  it('preserves bearer indistinguishability before the unavailable gate on protected Base writes', async () => {
    const harness = makeRouteHarness({ baseCrossChainAvailable: false });
    const body = routeBody();
    seedActiveMandate(harness, body);

    for (const [path, payload] of [
      ['/farm', farmBody(body)],
      ['/farm/attach', attachBody(PRIVATE_JOB_ID, body)],
    ]) {
      const { res, json } = await postProtected(harness, path, payload, WRONG_CAPABILITY);
      expect(res.statusCode).toBe(401);
      expect(json).toEqual({ error: 'unauthorized' });
      expect(res.body).not.toMatch(/unavailable|hardened|legacy/i);
    }
  });

  it('rejects authenticated farm and attach before evidence, intent-store, RPC, or build work', async () => {
    const poisonIntents = new Proxy(
      {},
      {
        get() {
          throw new Error('intent store must not be touched while Base is unavailable');
        },
      },
    );
    const harness = makeRouteHarness({
      baseCrossChainAvailable: false,
      farmIntents: poisonIntents,
      transformMandateGet: () => {
        throw new Error('session key must not be decrypted while Base is unavailable');
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);

    for (const [path, payload] of [
      ['/farm', farmBody(body)],
      ['/farm/attach', attachBody(PRIVATE_JOB_ID, body)],
    ]) {
      const { res, json } = await postProtected(harness, path, payload);
      expect(res.statusCode).toBe(503);
      expect(json).toEqual({
        error: 'Base cross-chain execution is unavailable',
      });
    }
    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
  });

  it('keeps authenticated status and revoke available while Base writes are closed', async () => {
    const harness = makeRouteHarness({ baseCrossChainAvailable: false });
    const body = routeBody();
    seedActiveMandate(harness, body);

    const status = await postProtected(harness, '/mandate/status', statusBody(body));
    expect(status.res.statusCode).toBe(200);
    expect(status.json.status).toBe('active');

    const revoke = await postProtected(harness, '/mandate/revoke', statusBody(body));
    expect(revoke.res.statusCode).toBe(200);
    expect(revoke.json).toMatchObject({ ok: true, status: 'revoked' });
  });

  it('rejects unwind before reserving a job when Base execution is unavailable', async () => {
    const reserve = vi.fn();
    const harness = makeRouteHarness({ baseCrossChainAvailable: false });
    const res = mockRes();

    await harness.router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind',
        body: {
          jobId: 'ab'.repeat(16),
          capability: CAPABILITY,
          kernelAddress: KERNEL,
          recipientHint: OWNER,
        },
        headers: {},
      },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(jsonOf(res)).toEqual({
      error: 'Base cross-chain execution is unavailable',
    });
    expect(harness.jobs.size).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it('does not resume farm recovery or touch recovery storage when Base is unavailable', async () => {
    const poisonIntents = new Proxy(
      {},
      {
        get() {
          throw new Error('recovery store must not be touched while Base is unavailable');
        },
      },
    );
    const harness = makeRouteHarness({
      baseCrossChainAvailable: false,
      farmIntents: poisonIntents,
    });

    await expect(harness.router.resumeFarmJobs()).resolves.toEqual({
      resumed: [],
      held: [],
      blocked: [],
      uncertain: [],
    });
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expect(harness.evaluator).not.toHaveBeenCalled();
  });

  it('does not distinguish an existing and unknown attach job before bearer authorization', async () => {
    const harness = makeRouteHarness();
    const body = routeBody();
    const active = seedActiveMandate(harness, body);
    harness.jobs.set(PRIVATE_JOB_ID, {
      status: 'queued',
      steps: [{ step: 'private-step-sentinel' }],
      _attach: {
        mandateId: MANDATE_ID,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        bindingId: active.bindingId,
        bindingHash: active.bindingHash,
      },
    });

    const existing = await postProtected(harness, '/farm/attach', attachBody(PRIVATE_JOB_ID), WRONG_CAPABILITY);
    const unknown = await postProtected(harness, '/farm/attach', attachBody(UNKNOWN_JOB_ID), WRONG_CAPABILITY);

    expectGenericUnauthorized(existing.res, body);
    expectGenericUnauthorized(unknown.res, body);
    expect(existing.res.body).toBe(unknown.res.body);
  });

  it.each([
    [
      'capability in JSON body',
      ({ body, jobId }) => ({
        url: '/api/vf-cross/farm/attach',
        body: { ...attachBody(jobId, body), capability: body.capability },
        headers: {},
      }),
    ],
    [
      'capability in query',
      ({ body, jobId }) => ({
        url: `/api/vf-cross/farm/attach?capability=${body.capability}`,
        body: attachBody(jobId, body),
        headers: {},
      }),
    ],
    [
      'capability in cookie',
      ({ body, jobId }) => ({
        url: '/api/vf-cross/farm/attach',
        body: attachBody(jobId, body),
        headers: {
          cookie: `__Host-vf-mandate-${body.mandateId}=${body.capability}`,
        },
      }),
    ],
    [
      'Basic authorization scheme',
      ({ body, jobId }) => ({
        url: '/api/vf-cross/farm/attach',
        body: attachBody(jobId, body),
        headers: { authorization: `Basic ${body.capability}` },
      }),
    ],
    [
      'lowercase bearer scheme',
      ({ body, jobId }) => ({
        url: '/api/vf-cross/farm/attach',
        body: attachBody(jobId, body),
        headers: { authorization: `bearer ${body.capability}` },
      }),
    ],
    [
      'Bearer header with trailing token',
      ({ body, jobId }) => ({
        url: '/api/vf-cross/farm/attach',
        body: attachBody(jobId, body),
        headers: { authorization: `Bearer ${body.capability} extra` },
      }),
    ],
  ])('rejects %s as generic unauthorized before mandate or job lookup', async (_label, buildRequest) => {
    const harness = makeRouteHarness();
    const body = routeBody();
    const active = seedActiveMandate(harness, body);
    harness.jobs.set(PRIVATE_JOB_ID, {
      status: 'queued',
      steps: [{ step: 'private-step-sentinel' }],
      _attach: {
        mandateId: body.mandateId,
        stellarOwner: body.stellarOwner,
        kernelAddress: body.kernelAddress,
        bindingId: active.bindingId,
        bindingHash: active.bindingHash,
      },
    });
    harness.events.length = 0;
    const jobGet = vi.spyOn(harness.jobs, 'get');
    const candidate = buildRequest({ body, jobId: PRIVATE_JOB_ID });
    const res = mockRes();

    await harness.router(
      {
        method: 'POST',
        url: candidate.url,
        body: candidate.body,
        headers: candidate.headers,
      },
      res,
    );

    expectGenericUnauthorized(res, body);
    expect(jobGet).not.toHaveBeenCalled();
    jobGet.mockRestore();
    expect(harness.events).not.toContain('store:get');
    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expect(res.body).not.toContain('private-step-sentinel');
    expect(harness.requestUrls).toEqual([candidate.url]);
    if (candidate.url.includes('?')) {
      expect(candidate.url).toContain(body.capability);
      expect(res.body).not.toContain(body.capability);
    }
  });

  it.each(
    ['/farm/attach', '/status'].flatMap((path) => INVALID_JOB_IDS.map(([label, jobId]) => ({ path, label, jobId }))),
  )('rejects $label job ID on $path after capability authorization and before lookup', async ({ path, jobId }) => {
    const harness = makeRouteHarness();
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.events.length = 0;
    const jobGet = vi.spyOn(harness.jobs, 'get');

    const payload = path === '/farm/attach' ? attachBody(jobId, body) : { mandateId: body.mandateId, jobId };
    const { res } = await postProtected(harness, path, payload);

    expect(res.statusCode).toBe(path === '/farm/attach' ? 503 : 400);
    expect(harness.events).toContain('store:get');
    expect(jobGet).not.toHaveBeenCalled();
    jobGet.mockRestore();
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expectPrivateMaterialAbsent(res.body, body);
  });

  it('removes approval-bearing and identifier-bearing GET routes', async () => {
    const harness = makeRouteHarness();
    harness.jobs.set(PRIVATE_JOB_ID, {
      status: 'done',
      steps: [{ step: 'private-step-sentinel' }],
    });
    const oldMandate = mockRes();
    await harness.router(
      {
        method: 'GET',
        url: `/api/vf-cross/mandate/valid?approval=${encodeURIComponent(canonicalApproval())}`,
        headers: {},
      },
      oldMandate,
    );
    const oldStatus = mockRes();
    await harness.router(
      {
        method: 'GET',
        url: `/api/vf-cross/status/${PRIVATE_JOB_ID}`,
        headers: {},
      },
      oldStatus,
    );

    expect(oldMandate.statusCode).toBe(404);
    expect(oldStatus.statusCode).toBe(404);
    expect(oldStatus.body).not.toContain('private-step-sentinel');
  });

  it.each([
    ['pending_activation', (harness, body) => seedPendingMandate(harness, body)],
    ['activation_uncertain', (harness, body) => seedUncertainMandate(harness, body)],
    [
      'revoked',
      (harness, body) => {
        seedPendingMandate(harness, body, 'revoked-binding-1');
        return harness.real.mandatesV3.revoke(routeIdentity(body));
      },
    ],
    [
      'expired',
      (harness, body) => {
        seedPendingMandate(harness, body, 'expired-binding-1');
        harness.clock.value = body.expiresAt;
        return harness.real.mandatesV3.status(routeIdentity(body));
      },
    ],
  ])('returns durable %s mandate truth without evaluating or leaking authority', async (expectedStatus, arrange) => {
    const clock = { value: NOW_SECONDS };
    const harness = makeRouteHarness({ clock });
    const body =
      expectedStatus === 'expired'
        ? routeBody({
            expiresAt: NOW_SECONDS + 1,
            serializedApproval: canonicalApproval(NOW_SECONDS + 1),
          })
        : routeBody();
    arrange(harness, body);
    harness.events.length = 0;

    const { res, json } = await postProtected(harness, '/mandate/status', statusBody(body), body.capability);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(json).toMatchObject({
      mandateId: body.mandateId,
      status: expectedStatus,
    });
    expect(harness.evaluator).not.toHaveBeenCalled();
    expectPrivateMaterialAbsent(res.body, body);
  });

  it('freshly evaluates active mandate status amount-free and returns new revoked evidence instead of cached active truth', async () => {
    const revokedEvidence = {
      ...ACTIVE_ROUTE_EVIDENCE,
      status: 'revoked',
      reasonCodes: ['PERMISSION_REVOKED'],
      checks: { ...ACTIVE_ROUTE_EVIDENCE.checks, permissionInstalled: false },
    };
    const harness = makeRouteHarness({
      evidenceSequence: [ACTIVE_ROUTE_EVIDENCE, revokedEvidence],
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.events.length = 0;

    const active = await postProtected(harness, '/mandate/status', statusBody(body));
    const revoked = await postProtected(harness, '/mandate/status', statusBody(body));

    expect(active.res.statusCode).toBe(200);
    expect(active.json).toEqual(ACTIVE_ROUTE_EVIDENCE);
    expect(revoked.res.statusCode).toBe(200);
    expect(revoked.json).toEqual(revokedEvidence);
    expect(harness.evaluator).toHaveBeenCalledTimes(2);
    for (const [args] of harness.evaluator.mock.calls) {
      expect(args).toMatchObject({ config: CONFIG });
      expect(args).not.toHaveProperty('allocation');
    }
    expectPrivateMaterialAbsent(active.res.body, body);
    expectPrivateMaterialAbsent(revoked.res.body, body);

    const extra = await postProtected(harness, '/mandate/status', {
      ...statusBody(body),
      allocation: wireAllocation(),
    });
    expect(extra.res.statusCode).toBe(400);
    expect(harness.evaluator).toHaveBeenCalledTimes(2);
  });

  it('maps active evaluator failure to no-store unknown without exposing internal diagnostics', async () => {
    const harness = makeRouteHarness({
      evidence: () => {
        throw new Error(`rpc https://private.example/${SESSION_KEY}`);
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);

    const { res, json } = await postProtected(harness, '/mandate/status', statusBody(body));

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(json).toMatchObject({
      status: 'unknown',
      reasonCodes: ['STATUS_ERROR'],
    });
    expectPrivateMaterialAbsent(res.body, body);
    expect(res.body).not.toContain('private.example');
  });

  it('revokes to a capability-retaining keyless tombstone and clears the exact __Host cookie idempotently', async () => {
    const harness = makeRouteHarness();
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.jobs.set(OWNED_JOB_ID, {
      status: 'queued',
      steps: [],
      _attach: { mandateId: MANDATE_ID },
    });

    const first = await postProtected(harness, '/mandate/revoke', statusBody(body));
    expect(first.res.statusCode).toBe(200);
    expect(first.json).toMatchObject({
      ok: true,
      status: 'revoked',
      scope: 'relayer-key-copy',
    });
    expect(typeof first.json.note).toBe('string');
    expect(first.res.headers['Set-Cookie']).toBe(REVOKE_COOKIE);
    expectPrivateMaterialAbsent(first.res.body, body);

    const internal = harness.real.mandatesV3.get(routeIdentity(body));
    expect(internal.status).toBe('revoked');
    expect(internal.sessionPrivateKey).toBeUndefined();
    expect(internal.capabilityHash).toBe(sha256(CAPABILITY));
    expect(Object.keys(internal)).not.toContain('capabilityHash');
    expect(harness.real.mandateActivations.get(routeIdentity(body))).toBeNull();

    const second = await postProtected(harness, '/mandate/revoke', statusBody(body));
    expect(second.res.statusCode).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(second.res.headers['Set-Cookie']).toBe(REVOKE_COOKIE);
    expect(harness.real.mandatesV3.get(routeIdentity(body)).sessionPrivateKey).toBeUndefined();

    const deniedFarm = await postProtected(harness, '/farm', farmBody(body));
    const deniedStatus = await postProtected(harness, '/status', {
      mandateId: MANDATE_ID,
      jobId: OWNED_JOB_ID,
    });
    expectGenericUnauthorized(deniedFarm.res, body);
    expectGenericUnauthorized(deniedStatus.res, body);
    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  // Defect caught: /farm called Agent Index before any local durable request/batch authority and
  // allocated a fresh job on each browser retry.
  it('persists the exact Task 11 request before one batch call and returns the stable job', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-http-')), 'relayer.db');
    const stores = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    let reporterSawLocal = false;
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: {
        networkId: 'stellar-testnet',
        sourceDomain: 27,
        destinationDomain: 6,
        tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
        baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
      },
      reporterImplementation(batch) {
        reporterSawLocal = Boolean(
          stores.farmIntents.getByRequest({
            mandateId: MANDATE_ID,
            requestId: '01'.repeat(16),
          }),
        );
        const canonicalJson = (value) => {
          if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
          if (value && typeof value === 'object')
            return `{${Object.keys(value)
              .sort()
              .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
              .join(',')}}`;
          return JSON.stringify(value);
        };
        return {
          acknowledged: true,
          schemaVersion: 1,
          idempotencyKey: batch.idempotencyKey,
          requestDigest: createHash('sha256').update(canonicalJson(batch)).digest('hex'),
          children: batch.children.map((child) => ({
            identity: {
              networkId: child.networkId,
              bindingId: child.bindingId,
              executionId: child.executionId,
              allocationId: child.allocationId,
              childId: child.childId,
            },
            recoveryVersion: 0,
          })),
          written: batch.children.length,
          duplicates: 0,
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const request = {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    };
    const first = await postProtected(harness, '/farm', request);
    expect(first.res.statusCode).toBe(201);
    expect(first.json).toMatchObject({
      jobId: FIRST_JOB_ID,
      acknowledged: true,
      status: 'awaiting_burn',
      schemaVersion: 1,
    });
    expect(reporterSawLocal).toBe(true);
    const retry = await postProtected(harness, '/farm', request);
    expect(retry.json).toEqual(first.json);
    expect(harness.reporter.commitIntentBatch).toHaveBeenCalledTimes(1);
    stores.db.close();
  });

  it.each([
    [
      'nested allocation field',
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], privateHint: 'must-reject' }],
      }),
    ],
    [
      'nested amount field',
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, serverFact: 27 },
          },
        ],
      }),
    ],
    [
      'leading-zero units',
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: '0100' },
          },
        ],
      }),
    ],
    [
      'non-string units',
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: 100 },
          },
        ],
      }),
    ],
    [
      'leading-zero minShares',
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: '090' }],
      }),
    ],
    [
      'non-string minShares',
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: 90 }],
      }),
    ],
    ['uppercase grant hash', (request) => ({ ...request, grantTxHash: 'AA'.repeat(32) })],
  ])('rejects noncanonical forward-farm variant: %s', async (_label, mutate) => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-route-validation-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const canonical = {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    };

    const response = await postProtected(harness, '/farm', mutate(canonical));

    expect(response.res.statusCode).toBe(400);
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM farm_intent_work_v2').get().n).toBe(0);
    expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
    stores.db.close();
  });

  it('rejects immutable request mutation and a burn hash reused by another v2 job', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-route-conflicts-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const request = (requestId) => ({
      requestId,
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    const first = await postProtected(harness, '/farm', request('01'.repeat(16)));
    expect(first.res.statusCode).toBe(201);
    const mutation = await postProtected(harness, '/farm', {
      ...request('01'.repeat(16)),
      allocations: [wireAllocation({ units: 401n, minShares: '390' })],
    });
    expect(mutation.res.statusCode).toBe(409);
    const second = await postProtected(harness, '/farm', request('02'.repeat(16)));
    expect(second.res.statusCode).toBe(201);
    const burnTxHash = 'bb'.repeat(32);
    expect(
      (
        await postProtected(harness, '/farm/attach', {
          mandateId: body.mandateId,
          jobId: first.json.jobId,
          burnTxHash: 'BB'.repeat(32),
        })
      ).res.statusCode,
    ).toBe(400);
    expect(
      (
        await postProtected(harness, '/farm/attach', {
          mandateId: body.mandateId,
          jobId: first.json.jobId,
          burnTxHash,
        })
      ).res.statusCode,
    ).toBe(202);
    const reused = await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: second.json.jobId,
      burnTxHash,
    });
    expect(reused.res.statusCode).toBe(409);
    expect(
      stores.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: second.json.jobId,
      }),
    ).toMatchObject({ state: 'awaiting_burn', burnTxHash: null });
    stores.db.close();
  });

  it.each(['create intent', 'attach burn'])(
    'maps a route-level %s persistence fault to a generic 503',
    async (fault) => {
      const stores = createSqliteStores(
        join(mkdtempSync(join(tmpdir(), 'vf-task11-route-write-error-')), 'relayer.db'),
        { sessionKeyCipher: routeCipher() },
      );
      const deployment = {
        networkId: 'stellar-testnet',
        sourceDomain: 27,
        destinationDomain: 6,
        tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
        baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
      };
      const body = routeBody();
      const healthy = makeRouteHarness({
        realStores: stores,
        jobs: stores.jobs,
        farmIntents: stores.farmIntents,
        associationOutbox: stores.associationOutbox,
        baseEvidenceOutbox: stores.baseEvidenceOutbox,
        forwardFarmDeployment: deployment,
      });
      seedActiveMandate(healthy, body);
      const request = {
        requestId: '01'.repeat(16),
        mandateId: body.mandateId,
        stellarOwner: body.stellarOwner,
        kernelAddress: body.kernelAddress,
        bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
        runId: 'run-42',
        grantTxHash: 'aa'.repeat(32),
        allocations: [routeAllocations()[0]],
      };
      let jobId;
      if (fault === 'attach burn') {
        const created = await postProtected(healthy, '/farm', request);
        expect(created.res.statusCode).toBe(201);
        jobId = created.json.jobId;
      }
      const failingIntents = {
        ...stores.farmIntents,
        ...(fault === 'create intent'
          ? {
              createOrGetIntent() {
                throw new Error('SQLITE_FULL private diagnostic');
              },
            }
          : {
              attachBurnAtomic() {
                throw new Error('SQLITE_FULL private diagnostic');
              },
            }),
      };
      const failing = makeRouteHarness({
        realStores: stores,
        jobs: stores.jobs,
        farmIntents: failingIntents,
        associationOutbox: stores.associationOutbox,
        baseEvidenceOutbox: stores.baseEvidenceOutbox,
        forwardFarmDeployment: deployment,
      });
      const response =
        fault === 'create intent'
          ? await postProtected(failing, '/farm', request)
          : await postProtected(failing, '/farm/attach', {
              mandateId: body.mandateId,
              jobId,
              burnTxHash: 'bb'.repeat(32),
            });
      expect(response.res.statusCode).toBe(503);
      expect(response.res.body).not.toContain('SQLITE_FULL');
      stores.db.close();
    },
  );

  it('allows one D1 delivery owner across two routers sharing SQLite', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-route-d1-race-')), 'relayer.db');
    const leftStores = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    const rightStores = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    let release;
    const reporterImplementation = vi.fn(
      (batch) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              acknowledged: true,
              schemaVersion: 1,
              idempotencyKey: batch.idempotencyKey,
              requestDigest: createHash('sha256')
                .update(
                  ((value) => {
                    const canonical = (entry) =>
                      Array.isArray(entry)
                        ? `[${entry.map(canonical).join(',')}]`
                        : entry && typeof entry === 'object'
                          ? `{${Object.keys(entry)
                              .sort()
                              .map((key) => `${JSON.stringify(key)}:${canonical(entry[key])}`)
                              .join(',')}}`
                          : JSON.stringify(entry);
                    return canonical(value);
                  })(batch),
                )
                .digest('hex'),
              children: batch.children.map((child) => ({
                identity: {
                  networkId: child.networkId,
                  bindingId: child.bindingId,
                  executionId: child.executionId,
                  allocationId: child.allocationId,
                  childId: child.childId,
                },
                recoveryVersion: 0,
              })),
              written: batch.children.length,
              duplicates: 0,
            });
        }),
    );
    const harnessFor = (stores) =>
      makeRouteHarness({
        realStores: stores,
        jobs: stores.jobs,
        farmIntents: stores.farmIntents,
        associationOutbox: stores.associationOutbox,
        baseEvidenceOutbox: stores.baseEvidenceOutbox,
        forwardFarmDeployment: deployment,
        reporterImplementation,
      });
    const left = harnessFor(leftStores);
    const right = harnessFor(rightStores);
    const body = routeBody();
    seedActiveMandate(left, body);
    const request = {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    };
    const winner = postProtected(left, '/farm', request);
    await vi.waitFor(() => expect(reporterImplementation).toHaveBeenCalledTimes(1));
    const loser = await postProtected(right, '/farm', request);
    expect(loser.res.statusCode).toBe(202);
    release();
    expect((await winner).res.statusCode).toBe(201);
    expect(reporterImplementation).toHaveBeenCalledTimes(1);
    rightStores.db.close();
    leftStores.db.close();
  });

  // Defect caught: /farm/attach accepted client owner/kernel copies and committed the job before
  // durable CCTP/evidence work, then scheduled execution from a private `_attach` JSON blob.
  it('authenticates the minimal attach body and schedules only after the atomic relay commit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-attach-')), 'relayer.db');
    const stores = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    const relayForwardMint = vi.fn(async ({ execId }) => {
      expect(
        stores.farmIntents.getByJob({
          mandateId: MANDATE_ID,
          jobId: FIRST_JOB_ID,
        }),
      ).toMatchObject({ state: 'relay_pending', relayExecId: execId });
      expect(stores.cctpRelays.get(execId)).toMatchObject({
        state: 'attestation_pending',
      });
      return { status: 'attestation_pending' };
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint,
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const farm = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(farm.res.statusCode).toBe(201);
    const attach = await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      burnTxHash: 'bb'.repeat(32),
    });
    expect(attach.res.statusCode).toBe(202);
    expect(attach.json).toEqual({
      jobId: farm.json.jobId,
      attached: true,
      status: 'relay_pending',
    });
    await flushMicrotasks();
    expect(relayForwardMint).toHaveBeenCalledTimes(1);
    const retry = await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      burnTxHash: 'bb'.repeat(32),
    });
    expect(retry.json).toEqual(attach.json);
    expect(relayForwardMint).toHaveBeenCalledTimes(1);
    stores.db.close();
  });

  // Defect caught: startup ignored durable intent_pending v2 work and instead replayed only the
  // legacy whole-farm job JSON path.
  it('resumes only the persisted idempotent Task 9 batch after a pre-ack crash window', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-resume-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    let attempts = 0;
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      reporterImplementation(batch) {
        attempts += 1;
        if (attempts === 2) throw new Error('D1 unavailable');
        const canonicalJson = (value) =>
          Array.isArray(value)
            ? `[${value.map(canonicalJson).join(',')}]`
            : value && typeof value === 'object'
              ? `{${Object.keys(value)
                  .sort()
                  .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
                  .join(',')}}`
              : JSON.stringify(value);
        return {
          acknowledged: true,
          schemaVersion: 1,
          idempotencyKey: batch.idempotencyKey,
          requestDigest: createHash('sha256').update(canonicalJson(batch)).digest('hex'),
          children: batch.children.map((child) => ({
            identity: {
              networkId: child.networkId,
              bindingId: child.bindingId,
              executionId: child.executionId,
              allocationId: child.allocationId,
              childId: child.childId,
            },
            recoveryVersion: 0,
          })),
          written: batch.children.length,
          duplicates: 0,
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const corrupt = await postProtected(harness, '/farm', {
      requestId: '00'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(corrupt.res.statusCode).toBe(201);
    stores.db
      .prepare(
        `UPDATE farm_intent_work_v2
      SET state='deposit_pending',updated_at=1 WHERE job_id=?`,
      )
      .run(corrupt.json.jobId);
    stores.jobs.set(corrupt.json.jobId, {
      ...stores.jobs.get(corrupt.json.jobId),
      status: 'deposit_pending',
    });
    stores.db.exec('DROP TRIGGER farm_intent_work_v2_immutable');
    stores.db
      .prepare(
        `UPDATE farm_intent_work_v2 SET intent_json='{malformed'
      WHERE job_id=?`,
      )
      .run(corrupt.json.jobId);
    const failed = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(failed.res.statusCode).toBe(503);
    expect(
      stores.farmIntents.getByRequest({
        mandateId: body.mandateId,
        requestId: '01'.repeat(16),
      }),
    ).toMatchObject({ state: 'intent_pending' });
    const validRecord = stores.farmIntents.getByRequest({
      mandateId: body.mandateId,
      requestId: '01'.repeat(16),
    });
    const summary = await harness.router.resumeFarmJobs();
    expect(summary).toMatchObject({
      resumed: [validRecord.jobId],
      blocked: [corrupt.json.jobId],
      uncertain: [],
    });
    expect(
      stores.db.prepare(`SELECT state,reason_code FROM farm_intent_work_v2 WHERE job_id=?`).get(corrupt.json.jobId),
    ).toEqual({
      state: 'blocked',
      reason_code: 'malformed_recovery_record',
    });
    expect(stores.jobs.get(corrupt.json.jobId)).toMatchObject({
      jobId: corrupt.json.jobId,
      status: 'blocked',
      reasonCode: 'malformed_recovery_record',
    });
    expect(JSON.stringify(summary)).not.toContain('{malformed');
    expect(
      stores.farmIntents.getByRequest({
        mandateId: body.mandateId,
        requestId: '01'.repeat(16),
      }),
    ).toMatchObject({ state: 'awaiting_burn' });
    expect(attempts).toBe(3);
    expect(harness.buildFarm).not.toHaveBeenCalled();
    stores.db.close();
  });

  it('blocks a malformed public projection and continues later SQLite recovery work in order', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-public-corrupt-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const recoverDeposits = vi.fn(async ({ children }) =>
      children.map(({ allocation }) => ({
        identity: allocation.identity,
        status: 'fulfilled',
        executionStatus: 'deposited',
      })),
    );
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      cctpRelays: stores.cctpRelays,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
      buildFarmImplementation: () => ({ farm: vi.fn(), recoverDeposits }),
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const create = async (requestId, burnTxHash, { projectMint = true } = {}) => {
      const farm = await postProtected(harness, '/farm', {
        requestId,
        mandateId: body.mandateId,
        stellarOwner: body.stellarOwner,
        kernelAddress: body.kernelAddress,
        bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
        runId: 'run-42',
        grantTxHash: 'aa'.repeat(32),
        allocations: [routeAllocations()[0]],
      });
      expect(farm.res.statusCode).toBe(201);
      await postProtected(harness, '/farm/attach', {
        mandateId: body.mandateId,
        jobId: farm.json.jobId,
        burnTxHash,
      });
      const record = stores.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: farm.json.jobId,
      });
      if (projectMint) {
        stores.farmIntents.projectMintEvidenceAtomic({
          identity: {
            mandateId: body.mandateId,
            jobId: record.jobId,
            bindingId: record.bindingId,
            intentDigest: record.intentDigest,
          },
          relay: {
            execId: record.relayExecId,
            state: 'minted',
            burnTxHash: record.burnTxHash,
            expectationDigest: record.expectationDigest,
            messageDigest: 'cc'.repeat(32),
            attestationDigest: 'dd'.repeat(32),
            evidenceVersion: '1',
            nonceHex: `0x${'01'.repeat(32)}`,
            mintTxHash: `0x${'ee'.repeat(32)}`,
          },
          now: 2_000_000_000_000,
        });
      }
      return record;
    };
    const corrupt = await create('01'.repeat(16), 'ba'.repeat(32), {
      projectMint: false,
    });
    const valid = await create('02'.repeat(16), 'bb'.repeat(32));
    const relayAt = 2_000_000_000_000;
    const relayClaim = stores.cctpRelays.claim({
      execId: corrupt.relayExecId,
      now: relayAt,
      leaseMs: 60_000,
    });
    stores.cctpRelays.recordAttested({
      execId: corrupt.relayExecId,
      leaseToken: relayClaim.leaseToken,
      messageHex: '0xab',
      nonceHex: `0x${'01'.repeat(32)}`,
      attestationHex: '0xcd',
      now: relayAt + 1,
    });
    stores.cctpRelays.markMintSubmitting({
      execId: corrupt.relayExecId,
      leaseToken: relayClaim.leaseToken,
      now: relayAt + 2,
    });
    const canonicalMintTxHash = `0x${'ee'.repeat(32)}`;
    stores.cctpRelays.markMintSubmitted({
      execId: corrupt.relayExecId,
      leaseToken: relayClaim.leaseToken,
      mintTxHash: canonicalMintTxHash,
      now: relayAt + 3,
    });
    stores.cctpRelays.finishMinted({
      execId: corrupt.relayExecId,
      leaseToken: relayClaim.leaseToken,
      mintTxHash: canonicalMintTxHash,
      now: relayAt + 4,
    });
    stores.db
      .prepare(
        `UPDATE jobs SET job='{\"serializedApproval\":\"must-not-leak\"'
      WHERE job_id=?`,
      )
      .run(corrupt.jobId);

    const summary = await harness.router.resumeFarmJobs();

    expect(summary).toEqual({
      resumed: [valid.jobId],
      held: [],
      blocked: [corrupt.jobId],
      uncertain: [],
    });
    expect(recoverDeposits).toHaveBeenCalledTimes(1);
    expect(
      stores.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: corrupt.jobId,
      }),
    ).toMatchObject({
      state: 'blocked',
      reasonCode: 'malformed_public_projection',
    });
    expect(stores.jobs.get(corrupt.jobId)).toEqual({
      jobId: corrupt.jobId,
      status: 'blocked',
      reasonCode: 'malformed_public_projection',
    });
    expect(JSON.stringify(summary)).not.toMatch(/serializedApproval|must-not-leak|JSON/);
    stores.db.close();
  });

  it('heartbeats slow intent delivery and never acks after renewal loses the lease', async () => {
    vi.useFakeTimers();
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-intent-heartbeat-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const renewIntentDelivery = vi.fn(() => {
      throw new Error('lease stolen');
    });
    const finishAwaitingBurn = vi.fn((args) => stores.farmIntents.finishAwaitingBurn(args));
    const farmIntents = {
      ...stores.farmIntents,
      renewIntentDelivery,
      finishAwaitingBurn,
    };
    let releaseReporter;
    const reporterImplementation = vi.fn(
      (batch) =>
        new Promise((resolve) => {
          releaseReporter = () =>
            resolve({
              acknowledged: true,
              schemaVersion: 1,
              idempotencyKey: batch.idempotencyKey,
              requestDigest: createHash('sha256')
                .update(
                  ((value) => {
                    const canonical = (entry) =>
                      Array.isArray(entry)
                        ? `[${entry.map(canonical).join(',')}]`
                        : entry && typeof entry === 'object'
                          ? `{${Object.keys(entry)
                              .sort()
                              .map((key) => `${JSON.stringify(key)}:${canonical(entry[key])}`)
                              .join(',')}}`
                          : JSON.stringify(entry);
                    return canonical(value);
                  })(batch),
                )
                .digest('hex'),
              children: batch.children.map((child) => ({
                identity: {
                  networkId: child.networkId,
                  bindingId: child.bindingId,
                  executionId: child.executionId,
                  allocationId: child.allocationId,
                  childId: child.childId,
                },
                recoveryVersion: 0,
              })),
              written: batch.children.length,
              duplicates: 0,
            });
        }),
    );
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      reporterImplementation,
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const pending = postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    await vi.waitFor(() => expect(reporterImplementation).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(renewIntentDelivery).toHaveBeenCalled();
    releaseReporter();
    const response = await pending;
    expect(response.res.statusCode).toBe(503);
    expect(finishAwaitingBurn).not.toHaveBeenCalled();
    expect(
      stores.farmIntents.getByRequest({
        mandateId: body.mandateId,
        requestId: '01'.repeat(16),
      }),
    ).toMatchObject({ state: 'intent_pending' });
    stores.db.close();
    vi.useRealTimers();
  });

  it('atomically terminalizes a permanent Agent Index batch conflict instead of retrying it', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-intent-conflict-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const reporterImplementation = vi.fn(() => {
      throw new AgentIndexBatchConflictError('immutable D1 conflict');
    });
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      reporterImplementation,
    });
    const body = routeBody();
    seedActiveMandate(harness, body);

    const response = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });

    expect(response.res.statusCode).toBe(409);
    expect(
      stores.farmIntents.getByRequest({
        mandateId: body.mandateId,
        requestId: '01'.repeat(16),
      }),
    ).toMatchObject({
      state: 'blocked',
      reasonCode: 'agent_index_intent_conflict',
    });
    expect(stores.jobs.get(FIRST_JOB_ID)).toMatchObject({
      status: 'blocked',
      reasonCode: 'agent_index_intent_conflict',
    });
    expect(await harness.router.resumeFarmJobs()).toEqual({
      resumed: [],
      held: [],
      blocked: [],
      uncertain: [],
    });
    expect(reporterImplementation).toHaveBeenCalledTimes(1);
    stores.db.close();
  });

  it.each(['farm', 'farm attach'])('maps a durable getByJob read failure on %s to a generic 503', async (route) => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-read-error-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const body = routeBody();
    const healthy = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
    });
    seedActiveMandate(healthy, body);
    const created = await postProtected(healthy, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(created.res.statusCode).toBe(201);
    const failingIntents = {
      ...stores.farmIntents,
      getByJob() {
        throw new Error('SQLITE_CORRUPT private diagnostic');
      },
    };
    const failing = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: failingIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
    });
    const response =
      route === 'farm'
        ? await postProtected(failing, '/farm', {
            requestId: '02'.repeat(16),
            mandateId: body.mandateId,
            stellarOwner: body.stellarOwner,
            kernelAddress: body.kernelAddress,
            bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
            runId: 'run-42',
            grantTxHash: 'aa'.repeat(32),
            allocations: [routeAllocations()[0]],
          })
        : await postProtected(failing, '/farm/attach', {
            mandateId: body.mandateId,
            jobId: created.json.jobId,
            burnTxHash: 'bb'.repeat(32),
          });

    expect(response.res.statusCode).toBe(503);
    expect(response.res.body).not.toContain('SQLITE_CORRUPT');
    stores.db.close();
  });

  it('fails closed without v2 intent authority even when legacy jobs and work stores exist', async () => {
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const harness = makeRouteHarness({ forwardFarmDeployment: deployment });
    const body = routeBody();
    seedActiveMandate(harness, body);

    const response = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });

    expect(response.res.statusCode).toBe(503);
    await expect(harness.router.resumeFarmJobs()).rejects.toThrow(/intent store/i);
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it('fresh-gates mixed Base child recovery and passes exact ordered evidence without replaying farm', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-task11-mixed-base-')), 'relayer.db'), {
      sessionKeyCipher: routeCipher(),
    });
    const thirdPool = `0x${'66'.repeat(20)}`;
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([
        [POOL_ADDRESS.toLowerCase(), 'aave-v3'],
        [`0x${'55'.repeat(20)}`, 'blend-v2'],
        [thirdPool, 'morpho'],
      ]),
    };
    const recoverDeposits = vi.fn(async ({ children }) =>
      children.map(({ allocation }) => ({
        identity: allocation.identity,
        status: 'fulfilled',
        executionStatus: 'deposited',
      })),
    );
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
      poolTargets: deployment.poolTargets,
      buildFarmImplementation: () => ({ farm: vi.fn(), recoverDeposits }),
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const allocations = [
      wireAllocation({
        allocationId: 'run-42:bridge:aave-v3',
        pool: POOL_ADDRESS,
      }),
      wireAllocation({
        allocationId: 'run-42:bridge:blend-v2',
        pool: `0x${'55'.repeat(20)}`,
      }),
      wireAllocation({ allocationId: 'run-42:bridge:morpho', pool: thirdPool }),
    ];
    const farm = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations,
    });
    expect(farm.res.statusCode).toBe(201);
    await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      burnTxHash: 'bb'.repeat(32),
    });
    await flushMicrotasks();
    const record = stores.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
    });
    const projectionIdentity = {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      bindingId: record.bindingId,
      intentDigest: record.intentDigest,
    };
    stores.farmIntents.projectMintEvidenceAtomic({
      identity: projectionIdentity,
      relay: {
        execId: record.relayExecId,
        state: 'minted',
        burnTxHash: record.burnTxHash,
        expectationDigest: record.expectationDigest,
        messageDigest: 'cc'.repeat(32),
        attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'01'.repeat(32)}`,
        mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 2_000_000_300,
    });
    const childIdentity = (allocation) => ({
      networkId: record.intent.networkId,
      bindingId: record.bindingId,
      executionId: allocation.executionId,
      allocationId: allocation.allocationId,
      childId: allocation.childId,
    });
    const common = (allocation) => ({
      chainId: '84532',
      yieldRouterAddress: CANONICAL_ROUTER.toLowerCase(),
      caller: KERNEL.toLowerCase(),
      poolAddress: allocation.poolAddress,
      assets: allocation.units,
      minShares: allocation.minShares,
    });
    const [confirmed, submitted] = record.intent.allocations;
    for (const allocation of [confirmed, submitted]) {
      stores.baseEvidenceOutbox.enqueue({
        identity: childIdentity(allocation),
        phase: 'base_deposit',
        status: 'submitting',
        evidence: common(allocation),
        observedAt: 2_000_000_301,
      });
      stores.baseEvidenceOutbox.enqueue({
        identity: childIdentity(allocation),
        phase: 'base_deposit',
        status: 'submitted',
        evidence: { ...common(allocation), userOpHash: USER_OP_HASH },
        observedAt: 2_000_000_302,
      });
    }
    stores.baseEvidenceOutbox.enqueue({
      identity: childIdentity(confirmed),
      phase: 'base_deposit',
      status: 'confirmed',
      evidence: {
        ...common(confirmed),
        shares: confirmed.minShares,
        userOpHash: USER_OP_HASH,
        transactionHash: TX_HASH,
        event: {
          address: CANONICAL_ROUTER.toLowerCase(),
          topic0: DEPOSITED_TOPIC0,
          logIndex: '1',
          caller: KERNEL.toLowerCase(),
          poolAddress: confirmed.poolAddress,
          assets: confirmed.units,
          shares: confirmed.minShares,
        },
      },
      observedAt: 2_000_000_303,
    });

    const summary = await harness.router.resumeFarmJobs();

    expect(summary).toMatchObject({
      resumed: [farm.json.jobId],
      blocked: [],
      uncertain: [],
    });
    expect(harness.buildFarm).toHaveBeenCalledTimes(2);
    expect(harness.farmFn).not.toHaveBeenCalled();
    expect(recoverDeposits).toHaveBeenCalledTimes(2);
    expect(
      recoverDeposits.mock.calls.map(([{ children }]) =>
        children.map(({ recovery }) => `${recovery.phase}:${recovery.state}`),
      ),
    ).toEqual([['base_deposit:submitted'], ['cctp_mint:confirmed']]);
    expect(
      stores.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: farm.json.jobId,
      }),
    ).toMatchObject({ state: 'done' });

    const secondFarm = await postProtected(harness, '/farm', {
      requestId: '02'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: allocations.slice(0, 2),
    });
    await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: secondFarm.json.jobId,
      burnTxHash: 'bc'.repeat(32),
    });
    const secondRecord = stores.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: secondFarm.json.jobId,
    });
    const secondProjection = {
      mandateId: body.mandateId,
      jobId: secondRecord.jobId,
      bindingId: secondRecord.bindingId,
      intentDigest: secondRecord.intentDigest,
    };
    stores.farmIntents.projectMintEvidenceAtomic({
      identity: secondProjection,
      relay: {
        execId: secondRecord.relayExecId,
        state: 'minted',
        burnTxHash: secondRecord.burnTxHash,
        expectationDigest: secondRecord.expectationDigest,
        messageDigest: 'ce'.repeat(32),
        attestationDigest: 'de'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'02'.repeat(32)}`,
        mintTxHash: `0x${'ef'.repeat(32)}`,
      },
      now: 2_000_000_400,
    });
    const firstSecondAllocation = secondRecord.intent.allocations[0];
    const secondIdentity = {
      networkId: secondRecord.intent.networkId,
      bindingId: secondRecord.bindingId,
      executionId: firstSecondAllocation.executionId,
      allocationId: firstSecondAllocation.allocationId,
      childId: firstSecondAllocation.childId,
    };
    const secondCommon = {
      chainId: '84532',
      yieldRouterAddress: CANONICAL_ROUTER.toLowerCase(),
      caller: KERNEL.toLowerCase(),
      poolAddress: firstSecondAllocation.poolAddress,
      assets: firstSecondAllocation.units,
      minShares: firstSecondAllocation.minShares,
    };
    stores.baseEvidenceOutbox.enqueue({
      identity: secondIdentity,
      phase: 'base_deposit',
      status: 'submitting',
      evidence: secondCommon,
      observedAt: 2_000_000_401,
    });
    stores.baseEvidenceOutbox.enqueue({
      identity: secondIdentity,
      phase: 'base_deposit',
      status: 'submitted',
      evidence: { ...secondCommon, userOpHash: USER_OP_HASH },
      observedAt: 2_000_000_402,
    });
    recoverDeposits.mockImplementationOnce(async ({ children }) => {
      stores.mandatesV3.revoke(routeIdentity(body));
      return children.map(({ allocation: entry }) => ({
        identity: entry.identity,
        status: 'fulfilled',
        executionStatus: 'deposited',
      }));
    });

    const revokedSummary = await harness.router.resumeFarmJobs();

    expect(revokedSummary).toMatchObject({
      resumed: [],
      blocked: [secondFarm.json.jobId],
      uncertain: [],
    });
    expect(recoverDeposits).toHaveBeenCalledTimes(3);
    expect(recoverDeposits.mock.calls[2][0].children[0].recovery).toMatchObject({
      phase: 'base_deposit',
      state: 'submitted',
    });
    expect(harness.buildFarm).toHaveBeenCalledTimes(3);
    stores.db.close();
  });

  it('reopens a submitted receipt timeout and confirms only the exact stored UserOperation hash', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-submitted-reopen-')), 'relayer.db');
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const word = (value) => BigInt(value).toString(16).padStart(64, '0');
    const receiptFor = (allocation) => ({
      userOpHash: USER_OP_HASH,
      sender: KERNEL,
      success: true,
      logs: [
        {
          address: CANONICAL_ROUTER,
          topics: [
            DEPOSITED_TOPIC0,
            `0x${KERNEL.slice(2).padStart(64, '0')}`,
            `0x${allocation.poolAddress.slice(2).padStart(64, '0')}`,
          ],
          data: `0x${word(allocation.units)}${word(allocation.minShares)}`,
          logIndex: 1,
          transactionHash: TX_HASH,
        },
      ],
      receipt: { status: 'success', transactionHash: TX_HASH, logs: [] },
    });
    const buildFlow = (reconstructSessionClientFn, sessionPrivateKey, readBaseDepositEvidenceFn) =>
      createFarmFlow({
        watcher: {},
        domains: { stellar: 27 },
        orchestrator: createOrchestrator({
          chain: { id: 84532 },
          rpcUrl: 'https://sepolia.base.org',
          bundlerRpcUrl: 'https://bundler',
          yieldRouterAddress: CANONICAL_ROUTER,
          usdcAddress: CANONICAL_USDC,
          sessionPrivateKey,
          baseCrossChainAvailable: true,
          captureReconcileHandleFn: async ({ entryPoint, sender }) => ({
            entryPoint,
            sender,
            nonce: '0',
            startBlock: '100',
          }),
          readBaseDepositEvidenceFn,
          now: () => 2_000_000_000_000,
          reconstructSessionClientFn,
        }),
      });
    let stores = createSqliteStores(path, { sessionKeyCipher: routeCipher() });
    const sendBeforeRestart = vi.fn(async () => USER_OP_HASH);
    const waitBeforeRestart = vi.fn(async () => {
      throw new Error('bundler timeout');
    });
    const firstReconstruct = vi.fn(async () => ({
      account: { address: KERNEL, encodeCalls: vi.fn(async () => '0xencoded') },
      sendUserOperation: sendBeforeRestart,
      waitForUserOperationReceipt: waitBeforeRestart,
    }));
    const first = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
      buildFarmImplementation: (sessionPrivateKey) => buildFlow(firstReconstruct, sessionPrivateKey),
    });
    const body = routeBody();
    seedActiveMandate(first, body);
    const farm = await postProtected(first, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(farm.res.statusCode).toBe(201);
    await postProtected(first, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      burnTxHash: 'bb'.repeat(32),
    });
    await flushMicrotasks();
    const record = stores.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
    });
    const projectionIdentity = {
      mandateId: body.mandateId,
      jobId: record.jobId,
      bindingId: record.bindingId,
      intentDigest: record.intentDigest,
    };
    stores.farmIntents.projectMintEvidenceAtomic({
      identity: projectionIdentity,
      relay: {
        execId: record.relayExecId,
        state: 'minted',
        burnTxHash: record.burnTxHash,
        expectationDigest: record.expectationDigest,
        messageDigest: 'cc'.repeat(32),
        attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'01'.repeat(32)}`,
        mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 2_000_000_000_000,
    });
    const child = record.batch.children[0];
    const childIdentity = {
      networkId: child.networkId,
      bindingId: child.bindingId,
      executionId: child.executionId,
      allocationId: child.allocationId,
      childId: child.childId,
    };

    expect(await first.router.resumeFarmJobs()).toEqual({
      resumed: [],
      held: [record.jobId],
      blocked: [],
      uncertain: [],
    });
    expect(sendBeforeRestart).toHaveBeenCalledOnce();
    expect(waitBeforeRestart).toHaveBeenCalledWith({
      hash: USER_OP_HASH,
      timeout: 120_000,
    });
    expect(stores.baseEvidenceOutbox.recoveryState(childIdentity)).toMatchObject({
      phase: 'base_deposit',
      state: 'submitted',
      evidence: { userOpHash: USER_OP_HASH },
    });
    expect(
      stores.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: record.jobId,
      }),
    ).toMatchObject({ state: 'deposit_confirming' });
    stores.db.close();

    stores = createSqliteStores(path, { sessionKeyCipher: routeCipher() });
    const sendAfterRestart = vi.fn(async () => {
      throw new Error('must not resend');
    });
    const readAfterRestart = vi.fn(async ({ allocation, userOpHash, reconcileHandle }) => ({
      status: 'fulfilled',
      userOpHash,
      transactionHash: TX_HASH,
      event: {
        address: CANONICAL_ROUTER.toLowerCase(),
        topic0: DEPOSITED_TOPIC0,
        logIndex: '1',
        caller: KERNEL,
        poolAddress: allocation.pool,
        assets: allocation.amount.toString(10),
        shares: allocation.minShares.toString(10),
      },
      reconcileHandle,
    }));
    const restartedEncodeCalls = vi.fn(async () => 'must-not-encode');
    const secondReconstruct = vi.fn(async () => ({
      account: { address: KERNEL, encodeCalls: restartedEncodeCalls },
      sendUserOperation: sendAfterRestart,
      waitForUserOperationReceipt: vi.fn(async () => {
        throw new Error('must not poll signer');
      }),
    }));
    const second = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      farmIntents: stores.farmIntents,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
      buildFarmImplementation: (sessionPrivateKey) => buildFlow(secondReconstruct, sessionPrivateKey, readAfterRestart),
    });

    expect(await second.router.resumeFarmJobs()).toEqual({
      resumed: [record.jobId],
      held: [],
      blocked: [],
      uncertain: [],
    });
    expect(sendAfterRestart).not.toHaveBeenCalled();
    expect(restartedEncodeCalls).not.toHaveBeenCalled();
    expect(secondReconstruct).not.toHaveBeenCalled();
    expect(readAfterRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        userOpHash: USER_OP_HASH,
        reconcileHandle: expect.objectContaining({
          nonce: '0',
          startBlock: '100',
        }),
      }),
    );
    expect(stores.baseEvidenceOutbox.recoveryState(childIdentity)).toMatchObject({
      phase: 'base_deposit',
      state: 'confirmed',
      evidence: { userOpHash: USER_OP_HASH, transactionHash: TX_HASH },
    });
    expect(
      stores.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: record.jobId,
      }),
    ).toMatchObject({ state: 'done' });
    stores.db.close();
  });

  it('refuses a Base submission when the owning v2 farm is blocked after the final authority gate', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-block-before-claim-')), 'relayer.db');
    const first = createSqliteStores(path, { sessionKeyCipher: routeCipher() });
    const second = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const encodeCalls = vi.fn(async () => '0xencoded');
    const sendUserOperation = vi.fn(async () => USER_OP_HASH);
    const waitForUserOperationReceipt = vi.fn(async () => {
      throw new Error('must not poll');
    });
    const reconstructSessionClientFn = vi.fn(async () => ({
      account: { address: KERNEL, encodeCalls },
      sendUserOperation,
      waitForUserOperationReceipt,
    }));
    const buildFlow = (sessionPrivateKey) =>
      createFarmFlow({
        watcher: {},
        domains: { stellar: 27 },
        orchestrator: createOrchestrator({
          chain: { id: 84532 },
          rpcUrl: 'https://sepolia.base.org',
          bundlerRpcUrl: 'https://bundler',
          yieldRouterAddress: CANONICAL_ROUTER,
          usdcAddress: CANONICAL_USDC,
          sessionPrivateKey,
          baseCrossChainAvailable: true,
          captureReconcileHandleFn: async ({ entryPoint, sender }) => ({
            entryPoint,
            sender,
            nonce: '0',
            startBlock: '100',
          }),
          now: () => 2_000_000_000_000,
          reconstructSessionClientFn,
        }),
      });
    let claimReached;
    const claimSignal = new Promise((resolve) => {
      claimReached = resolve;
    });
    let releaseClaim;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    const claimAuthorizedSubmission = vi.fn(async (args) => {
      claimReached();
      await claimGate;
      return first.farmIntents.claimAuthorizedSubmission(args);
    });
    const farmIntents = { ...first.farmIntents, claimAuthorizedSubmission };
    const harness = makeRouteHarness({
      realStores: first,
      jobs: first.jobs,
      farmIntents,
      associationOutbox: first.associationOutbox,
      baseEvidenceOutbox: first.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
      buildFarmImplementation: buildFlow,
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const farm = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(farm.res.statusCode).toBe(201);
    await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      burnTxHash: 'bb'.repeat(32),
    });
    await flushMicrotasks();
    const record = first.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
    });
    const projectionIdentity = {
      mandateId: body.mandateId,
      jobId: record.jobId,
      bindingId: record.bindingId,
      intentDigest: record.intentDigest,
    };
    first.farmIntents.projectMintEvidenceAtomic({
      identity: projectionIdentity,
      relay: {
        execId: record.relayExecId,
        state: 'minted',
        burnTxHash: record.burnTxHash,
        expectationDigest: record.expectationDigest,
        messageDigest: 'cc'.repeat(32),
        attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'01'.repeat(32)}`,
        mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 2_000_000_000_000,
    });
    const child = record.batch.children[0];
    const childIdentity = {
      networkId: child.networkId,
      bindingId: child.bindingId,
      executionId: child.executionId,
      allocationId: child.allocationId,
      childId: child.childId,
    };
    const eventsBefore = first.db.prepare('SELECT COUNT(*) AS count FROM base_evidence_outbox').get().count;

    const resume = harness.router.resumeFarmJobs();
    await claimSignal;
    expect(reconstructSessionClientFn).toHaveBeenCalledOnce();
    expect(first.farmIntents.getByJob(projectionIdentity)).toMatchObject({
      state: 'deposit_confirming',
    });
    expect(
      second.farmIntents.blockEvidenceConflict({
        identity: childIdentity,
        now: 2_000_000_000_001,
      }),
    ).toEqual({ jobId: record.jobId, status: 'blocked' });
    releaseClaim();

    expect(await resume).toEqual({
      resumed: [],
      held: [record.jobId],
      blocked: [],
      uncertain: [],
    });
    expect(await claimAuthorizedSubmission.mock.results[0].value).toEqual({
      claimed: false,
      ownerToken: null,
      reasonCode: 'mandate_authority_changed',
    });
    expect(encodeCalls).not.toHaveBeenCalled();
    expect(sendUserOperation).not.toHaveBeenCalled();
    expect(waitForUserOperationReceipt).not.toHaveBeenCalled();
    expect(first.baseEvidenceOutbox.recoveryState(childIdentity)).toMatchObject({
      phase: 'cctp_mint',
      state: 'confirmed',
    });
    expect(
      first.db
        .prepare(
          `SELECT submission_owner_token,latest_phase,latest_state
      FROM base_evidence_heads WHERE network_id=? AND binding_id=? AND execution_id=?
        AND allocation_id=? AND child_id=?`,
        )
        .get(
          childIdentity.networkId,
          childIdentity.bindingId,
          childIdentity.executionId,
          childIdentity.allocationId,
          childIdentity.childId,
        ),
    ).toEqual({
      submission_owner_token: null,
      latest_phase: 'cctp_mint',
      latest_state: 'confirmed',
    });
    expect(first.db.prepare('SELECT COUNT(*) AS count FROM base_evidence_outbox').get().count).toBe(eventsBefore);
    expect(first.farmIntents.getByJob(projectionIdentity)).toMatchObject({
      state: 'blocked',
      reasonCode: 'base_evidence_conflict',
    });
    expect(first.jobs.get(record.jobId)).toMatchObject({
      status: 'blocked',
      reasonCode: 'base_evidence_conflict',
    });
    second.db.close();
    first.db.close();
  });

  it('preserves a committed Base submission fence when v2 blocking and revoke linearize afterward', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-claim-before-block-')), 'relayer.db');
    const first = createSqliteStores(path, { sessionKeyCipher: routeCipher() });
    const second = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([[POOL_ADDRESS.toLowerCase(), 'aave-v3']]),
    };
    const encodeCalls = vi.fn(async () => '0xencoded');
    const sendUserOperation = vi.fn(async () => USER_OP_HASH);
    const waitForUserOperationReceipt = vi.fn(async () => {
      throw new Error('bundler timeout');
    });
    const reconstructSessionClientFn = vi.fn(async () => ({
      account: { address: KERNEL, encodeCalls },
      sendUserOperation,
      waitForUserOperationReceipt,
    }));
    const buildFlow = (sessionPrivateKey) =>
      createFarmFlow({
        watcher: {},
        domains: { stellar: 27 },
        orchestrator: createOrchestrator({
          chain: { id: 84532 },
          rpcUrl: 'https://sepolia.base.org',
          bundlerRpcUrl: 'https://bundler',
          yieldRouterAddress: CANONICAL_ROUTER,
          usdcAddress: CANONICAL_USDC,
          sessionPrivateKey,
          baseCrossChainAvailable: true,
          captureReconcileHandleFn: async ({ entryPoint, sender }) => ({
            entryPoint,
            sender,
            nonce: '0',
            startBlock: '100',
          }),
          now: () => 2_000_000_000_000,
          reconstructSessionClientFn,
        }),
      });
    let claimCommitted;
    const claimSignal = new Promise((resolve) => {
      claimCommitted = resolve;
    });
    let releaseClaim;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    const claimAuthorizedSubmission = vi.fn(async (args) => {
      const claim = first.farmIntents.claimAuthorizedSubmission(args);
      claimCommitted(claim);
      await claimGate;
      return claim;
    });
    const farmIntents = { ...first.farmIntents, claimAuthorizedSubmission };
    const harness = makeRouteHarness({
      realStores: first,
      jobs: first.jobs,
      farmIntents,
      associationOutbox: first.associationOutbox,
      baseEvidenceOutbox: first.baseEvidenceOutbox,
      forwardFarmDeployment: deployment,
      relayForwardMint: vi.fn(async () => ({ status: 'attestation_pending' })),
      buildFarmImplementation: buildFlow,
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const farm = await postProtected(harness, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [routeAllocations()[0]],
    });
    expect(farm.res.statusCode).toBe(201);
    await postProtected(harness, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
      burnTxHash: 'bb'.repeat(32),
    });
    await flushMicrotasks();
    const record = first.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
    });
    const projectionIdentity = {
      mandateId: body.mandateId,
      jobId: record.jobId,
      bindingId: record.bindingId,
      intentDigest: record.intentDigest,
    };
    first.farmIntents.projectMintEvidenceAtomic({
      identity: projectionIdentity,
      relay: {
        execId: record.relayExecId,
        state: 'minted',
        burnTxHash: record.burnTxHash,
        expectationDigest: record.expectationDigest,
        messageDigest: 'cc'.repeat(32),
        attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'01'.repeat(32)}`,
        mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 2_000_000_000_000,
    });
    const child = record.batch.children[0];
    const childIdentity = {
      networkId: child.networkId,
      bindingId: child.bindingId,
      executionId: child.executionId,
      allocationId: child.allocationId,
      childId: child.childId,
    };
    const eventsBefore = first.db.prepare('SELECT COUNT(*) AS count FROM base_evidence_outbox').get().count;

    const resume = harness.router.resumeFarmJobs();
    const committedClaim = await claimSignal;
    expect(committedClaim).toMatchObject({ claimed: true });
    expect(typeof committedClaim.ownerToken).toBe('string');
    expect(encodeCalls).not.toHaveBeenCalled();
    expect(sendUserOperation).not.toHaveBeenCalled();
    const submittingHead = second.db
      .prepare(
        `SELECT latest_phase,latest_state,submission_owner_token
      FROM base_evidence_heads WHERE network_id=? AND binding_id=? AND execution_id=?
        AND allocation_id=? AND child_id=?`,
      )
      .get(
        childIdentity.networkId,
        childIdentity.bindingId,
        childIdentity.executionId,
        childIdentity.allocationId,
        childIdentity.childId,
      );
    expect(submittingHead).toEqual({
      latest_phase: 'base_deposit',
      latest_state: 'submitting',
      submission_owner_token: committedClaim.ownerToken,
    });
    expect(second.db.prepare('SELECT COUNT(*) AS count FROM base_evidence_outbox').get().count).toBe(eventsBefore + 1);

    expect(
      second.farmIntents.blockEvidenceConflict({
        identity: childIdentity,
        now: 2_000_000_000_001,
      }),
    ).toEqual({ jobId: record.jobId, status: 'blocked' });
    expect(second.mandatesV3.revoke(routeIdentity(body))).toMatchObject({
      status: 'revoked',
    });
    expect(
      second.db
        .prepare(
          `SELECT latest_phase,latest_state,submission_owner_token
      FROM base_evidence_heads WHERE network_id=? AND binding_id=? AND execution_id=?
        AND allocation_id=? AND child_id=?`,
        )
        .get(
          childIdentity.networkId,
          childIdentity.bindingId,
          childIdentity.executionId,
          childIdentity.allocationId,
          childIdentity.childId,
        ),
    ).toEqual(submittingHead);
    expect(second.db.prepare('SELECT COUNT(*) AS count FROM base_evidence_outbox').get().count).toBe(eventsBefore + 1);
    expect(second.farmIntents.getByJob(projectionIdentity)).toMatchObject({
      state: 'blocked',
      reasonCode: 'base_evidence_conflict',
    });
    expect(second.jobs.get(record.jobId)).toMatchObject({
      status: 'blocked',
      reasonCode: 'base_evidence_conflict',
    });
    expect(
      JSON.stringify({
        job: second.jobs.get(record.jobId),
        status: second.baseEvidenceOutbox.status(childIdentity),
      }),
    ).not.toMatch(new RegExp(`${committedClaim.ownerToken}|${SESSION_KEY.slice(2)}|${CAPABILITY}`, 'i'));

    releaseClaim();
    expect(await resume).toEqual({
      resumed: [],
      held: [record.jobId],
      blocked: [],
      uncertain: [],
    });
    expect(encodeCalls).toHaveBeenCalledOnce();
    expect(sendUserOperation).toHaveBeenCalledOnce();
    expect(waitForUserOperationReceipt).toHaveBeenCalledWith({
      hash: USER_OP_HASH,
      timeout: 120_000,
    });
    expect(first.baseEvidenceOutbox.recoveryState(childIdentity)).toMatchObject({
      phase: 'base_deposit',
      state: 'submitted',
      evidence: { userOpHash: USER_OP_HASH },
    });
    expect(first.farmIntents.getByJob(projectionIdentity)).toMatchObject({
      state: 'blocked',
      reasonCode: 'base_evidence_conflict',
    });
    expect(await harness.router.resumeFarmJobs()).toEqual({
      resumed: [],
      held: [],
      blocked: [],
      uncertain: [],
    });
    expect(sendUserOperation).toHaveBeenCalledOnce();
    second.db.close();
    first.db.close();
  });

  it('lets only the first router own two never-started children and preserves serial send order', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vf-task11-two-router-send-')), 'relayer.db');
    const first = createSqliteStores(path, { sessionKeyCipher: routeCipher() });
    const second = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
    });
    const deployment = {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([
        [POOL_ADDRESS.toLowerCase(), 'aave-v3'],
        [SECOND_POOL.toLowerCase(), 'blend-v2'],
      ]),
    };
    const allocations = routeAllocations();
    const secondUserOpHash = `0x${'44'.repeat(32)}`;
    const word = (value) => BigInt(value).toString(16).padStart(64, '0');
    const sendUserOperation = vi.fn().mockResolvedValueOnce(USER_OP_HASH).mockResolvedValueOnce(secondUserOpHash);
    let releaseRightReconstruction;
    const rightReconstructionGate = new Promise((resolve) => {
      releaseRightReconstruction = resolve;
    });
    const rightReconstruct = vi.fn(async () => {
      if (rightReconstruct.mock.calls.length === 1) await rightReconstructionGate;
      return makeKernelClient();
    });
    let submittedReached;
    const submittedSignal = new Promise((resolve) => {
      submittedReached = resolve;
    });
    let releaseSubmitted;
    const submittedGate = new Promise((resolve) => {
      releaseSubmitted = resolve;
    });
    let releaseFirstReceipt;
    const firstReceiptGate = new Promise((resolve) => {
      releaseFirstReceipt = resolve;
    });
    let firstReceiptReached;
    const firstReceiptSignal = new Promise((resolve) => {
      firstReceiptReached = resolve;
    });
    const receiptFor = (allocation, userOpHash, transactionHash) => ({
      userOpHash,
      sender: KERNEL,
      success: true,
      logs: [
        {
          address: CANONICAL_ROUTER,
          topics: [
            DEPOSITED_TOPIC0,
            `0x${KERNEL.slice(2).padStart(64, '0')}`,
            `0x${allocation.poolAddress.slice(2).padStart(64, '0')}`,
          ],
          data: `0x${word(allocation.amount.units)}${word(allocation.minShares)}`,
          logIndex: 1,
          transactionHash,
        },
      ],
      receipt: { status: 'success', transactionHash, logs: [] },
    });
    const makeKernelClient = () => ({
      account: { address: KERNEL, encodeCalls: vi.fn(async () => '0xencoded') },
      sendUserOperation,
      waitForUserOperationReceipt: vi.fn(async ({ hash }) => {
        if (hash === USER_OP_HASH) {
          firstReceiptReached();
          await firstReceiptGate;
          return receiptFor(allocations[0], USER_OP_HASH, TX_HASH);
        }
        return receiptFor(allocations[1], secondUserOpHash, `0x${'55'.repeat(32)}`);
      }),
    });
    const leftReconstruct = vi.fn(async () => makeKernelClient());
    const relayForwardMint = vi.fn(async () => ({
      status: 'attestation_pending',
    }));
    const buildFlow = (reconstructSessionClientFn) =>
      createFarmFlow({
        watcher: {},
        domains: { stellar: 27 },
        orchestrator: createOrchestrator({
          chain: { id: 84532 },
          rpcUrl: 'https://sepolia.base.org',
          bundlerRpcUrl: 'https://bundler',
          yieldRouterAddress: CANONICAL_ROUTER,
          usdcAddress: CANONICAL_USDC,
          sessionPrivateKey: SESSION_KEY,
          now: () => 2_000_000_000_000,
          baseCrossChainAvailable: true,
          captureReconcileHandleFn: async ({ entryPoint, sender }) => ({
            entryPoint,
            sender,
            nonce: '0',
            startBlock: '100',
          }),
          reconstructSessionClientFn,
        }),
      });
    const leftOutbox = {
      ...first.baseEvidenceOutbox,
      claimSubmission: vi.fn((checkpoint) => first.baseEvidenceOutbox.claimSubmission(checkpoint)),
      async enqueueOwned(checkpoint, ownership) {
        if (checkpoint.status === 'submitted') {
          submittedReached();
          await submittedGate;
        }
        return first.baseEvidenceOutbox.enqueueOwned(checkpoint, ownership);
      },
    };
    const harnessFor = (stores, baseEvidenceOutbox, reconstructSessionClientFn) =>
      makeRouteHarness({
        realStores: stores,
        jobs: stores.jobs,
        farmIntents: stores.farmIntents,
        associationOutbox: stores.associationOutbox,
        baseEvidenceOutbox,
        forwardFarmDeployment: deployment,
        relayForwardMint,
        poolTargets: deployment.poolTargets,
        buildFarmImplementation: () => buildFlow(reconstructSessionClientFn),
      });
    const left = harnessFor(first, leftOutbox, leftReconstruct);
    const right = harnessFor(second, second.baseEvidenceOutbox, rightReconstruct);
    const body = routeBody();
    seedActiveMandate(left, body);
    const farm = await postProtected(left, '/farm', {
      requestId: '01'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations,
    });
    const attachments = await Promise.all(
      [left, right].map((harness) =>
        postProtected(harness, '/farm/attach', {
          mandateId: body.mandateId,
          jobId: farm.json.jobId,
          burnTxHash: 'bb'.repeat(32),
        }),
      ),
    );
    expect(attachments.map(({ res }) => res.statusCode)).toEqual([202, 202]);
    await flushMicrotasks();
    expect(relayForwardMint).toHaveBeenCalledTimes(1);
    const record = first.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: farm.json.jobId,
    });
    const projectionIdentity = {
      mandateId: body.mandateId,
      jobId: record.jobId,
      bindingId: record.bindingId,
      intentDigest: record.intentDigest,
    };
    first.farmIntents.projectMintEvidenceAtomic({
      identity: projectionIdentity,
      relay: {
        execId: record.relayExecId,
        state: 'minted',
        burnTxHash: record.burnTxHash,
        expectationDigest: record.expectationDigest,
        messageDigest: 'cc'.repeat(32),
        attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'01'.repeat(32)}`,
        mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 2_000_000_000_000,
    });
    first.farmIntents.advanceProjection({
      identity: projectionIdentity,
      from: 'deposit_pending',
      to: 'deposit_confirming',
      now: 2_000_000_000_000,
    });
    const rightResume = right.router.resumeFarmJobs();
    await vi.waitFor(() => expect(rightReconstruct).toHaveBeenCalledTimes(1));
    const leftResume = left.router.resumeFarmJobs();
    await submittedSignal;
    releaseRightReconstruction();
    const rightSummary = await rightResume;
    releaseSubmitted();
    await firstReceiptSignal;
    const sendsBeforeWinnerReceipt = sendUserOperation.mock.calls.length;
    releaseFirstReceipt();
    const leftSummary = await leftResume;

    expect(sendsBeforeWinnerReceipt).toBe(1);
    expect(sendUserOperation).toHaveBeenCalledTimes(2);
    const summaries = [leftSummary, rightSummary];
    expect(summaries.flatMap(({ resumed }) => resumed)).toEqual([farm.json.jobId]);
    expect(
      first.farmIntents.getByJob({
        mandateId: body.mandateId,
        jobId: farm.json.jobId,
      }),
    ).toMatchObject({ state: 'done' });

    const gapBody = secondRouteBody();
    seedActiveMandate(left, gapBody, 'active-binding-gap');
    const gapFarm = await postProtected(
      left,
      '/farm',
      {
        requestId: '03'.repeat(16),
        mandateId: gapBody.mandateId,
        stellarOwner: gapBody.stellarOwner,
        kernelAddress: gapBody.kernelAddress,
        bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
        runId: 'run-42',
        grantTxHash: 'aa'.repeat(32),
        allocations: [allocations[0]],
      },
      SECOND_CAPABILITY,
    );
    expect(gapFarm.res.statusCode).toBe(201);
    await postProtected(
      left,
      '/farm/attach',
      {
        mandateId: gapBody.mandateId,
        jobId: gapFarm.json.jobId,
        burnTxHash: 'bd'.repeat(32),
      },
      SECOND_CAPABILITY,
    );
    const gapRecord = first.farmIntents.getByJob({
      mandateId: gapBody.mandateId,
      jobId: gapFarm.json.jobId,
    });
    const gapProjection = {
      mandateId: gapBody.mandateId,
      jobId: gapRecord.jobId,
      bindingId: gapRecord.bindingId,
      intentDigest: gapRecord.intentDigest,
    };
    first.farmIntents.projectMintEvidenceAtomic({
      identity: gapProjection,
      relay: {
        execId: gapRecord.relayExecId,
        state: 'minted',
        burnTxHash: gapRecord.burnTxHash,
        expectationDigest: gapRecord.expectationDigest,
        messageDigest: 'cf'.repeat(32),
        attestationDigest: 'df'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'03'.repeat(32)}`,
        mintTxHash: `0x${'f0'.repeat(32)}`,
      },
      now: 2_000_000_000_050,
    });
    let gapRevoked = false;
    const revokeInClaimGap = () => {
      if (gapRevoked) return;
      gapRevoked = true;
      second.mandatesV3.revoke(routeIdentity(gapBody));
    };
    const rawClaim = first.baseEvidenceOutbox.claimSubmission.bind(first.baseEvidenceOutbox);
    leftOutbox.claimSubmission.mockImplementationOnce((checkpoint) => {
      revokeInClaimGap();
      return rawClaim(checkpoint);
    });
    const authorizedClaim = first.farmIntents.claimAuthorizedSubmission.bind(first.farmIntents);
    const claimAuthorizedSubmission = vi.fn((args) => {
      revokeInClaimGap();
      return authorizedClaim(args);
    });
    first.farmIntents.claimAuthorizedSubmission = claimAuthorizedSubmission;
    const gapSendsBefore = sendUserOperation.mock.calls.length;

    const gapSummary = await left.router.resumeFarmJobs();

    expect(gapSummary.held).toContain(gapFarm.json.jobId);
    expect(claimAuthorizedSubmission).toHaveBeenCalledOnce();
    expect(sendUserOperation).toHaveBeenCalledTimes(gapSendsBefore);
    const gapChild = gapRecord.batch.children[0];
    expect(
      first.baseEvidenceOutbox.recoveryState({
        networkId: gapChild.networkId,
        bindingId: gapChild.bindingId,
        executionId: gapChild.executionId,
        allocationId: gapChild.allocationId,
        childId: gapChild.childId,
      }),
    ).toMatchObject({ phase: 'cctp_mint', state: 'confirmed' });

    const revokedFarm = await postProtected(left, '/farm', {
      requestId: '02'.repeat(16),
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [allocations[0]],
    });
    await postProtected(left, '/farm/attach', {
      mandateId: body.mandateId,
      jobId: revokedFarm.json.jobId,
      burnTxHash: 'bc'.repeat(32),
    });
    const revokedRecord = first.farmIntents.getByJob({
      mandateId: body.mandateId,
      jobId: revokedFarm.json.jobId,
    });
    const revokedProjection = {
      mandateId: body.mandateId,
      jobId: revokedRecord.jobId,
      bindingId: revokedRecord.bindingId,
      intentDigest: revokedRecord.intentDigest,
    };
    first.farmIntents.projectMintEvidenceAtomic({
      identity: revokedProjection,
      relay: {
        execId: revokedRecord.relayExecId,
        state: 'minted',
        burnTxHash: revokedRecord.burnTxHash,
        expectationDigest: revokedRecord.expectationDigest,
        messageDigest: 'ce'.repeat(32),
        attestationDigest: 'de'.repeat(32),
        evidenceVersion: '1',
        nonceHex: `0x${'02'.repeat(32)}`,
        mintTxHash: `0x${'ef'.repeat(32)}`,
      },
      now: 2_000_000_000_100,
    });
    let releaseRevokedReconstruction;
    const revokedReconstructionGate = new Promise((resolve) => {
      releaseRevokedReconstruction = resolve;
    });
    leftReconstruct.mockImplementationOnce(async () => {
      await revokedReconstructionGate;
      return makeKernelClient();
    });
    const reconstructCallsBefore = leftReconstruct.mock.calls.length;
    const claimsBefore = leftOutbox.claimSubmission.mock.calls.length;
    const sendsBefore = sendUserOperation.mock.calls.length;
    const revokedResume = left.router.resumeFarmJobs();
    await vi.waitFor(() => expect(leftReconstruct).toHaveBeenCalledTimes(reconstructCallsBefore + 1));
    first.mandatesV3.revoke(routeIdentity(body));
    releaseRevokedReconstruction();
    const revokedSummary = await revokedResume;

    expect(revokedSummary.held).toContain(revokedFarm.json.jobId);
    expect(leftOutbox.claimSubmission).toHaveBeenCalledTimes(claimsBefore);
    expect(sendUserOperation).toHaveBeenCalledTimes(sendsBefore);
    second.db.close();
    first.db.close();
  });

  it.each([
    'getAuthority',
    'status',
    'claimEvidence',
    'renewEvidence',
    'releaseEvidence',
    'attachAndEnqueue',
    'finishBlocked',
    'finishUncertain',
    'reconcileFromCctp',
    'reconcileExpired',
    'listForResume',
    'readUnwindEvidence',
    'relayReverseMint',
    'unwindPublicClient',
    'unwindBundlerClient',
    'unwindEvidenceFacts',
  ])('fails reserve closed before persistence when attach dependency %s is unavailable', async (missing) => {
    const reserve = vi.fn(() => ({
      jobId: 'ab'.repeat(16),
      status: 'awaiting_burn',
      expiresAt: 1_700_003_600_000,
    }));
    const unwindJobs = {
      reserve,
      getAuthority: vi.fn(),
      status: vi.fn(),
      claimEvidence: vi.fn(),
      renewEvidence: vi.fn(),
      releaseEvidence: vi.fn(),
      attachAndEnqueue: vi.fn(),
      finishBlocked: vi.fn(),
      finishUncertain: vi.fn(),
      reconcileFromCctp: vi.fn(),
      reconcileExpired: vi.fn(),
      listForResume: vi.fn(),
    };
    const dependencies = {
      readUnwindEvidence: vi.fn(),
      relayReverseMint: vi.fn(),
      unwindPublicClient: { getChainId() {}, getTransactionReceipt() {} },
      unwindBundlerClient: {
        getUserOperation() {},
        getUserOperationReceipt() {},
      },
      unwindEvidenceFacts: {
        generation: 'hardened-v2',
        chainId: 84532,
        entryPointAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032',
        baseExitSweeperAddress: `0x${'44'.repeat(20)}`,
        usdcAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        tokenMessengerV2Address: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
        messageTransmitterV2Address: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
        stellarDomain: 27,
        stellarTokenMessenger: `0x${'55'.repeat(32)}`,
        cctpForwarder: `0x${'66'.repeat(32)}`,
        finalityThreshold: 1000,
      },
    };
    if (Object.hasOwn(unwindJobs, missing)) delete unwindJobs[missing];
    else delete dependencies[missing];
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs,
      ...dependencies,
      unwindCookieMaxAgeSeconds: 3600,
      nowMs: () => 1_700_000_000_000,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();
    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind',
        headers: {},
        body: {
          jobId: 'ab'.repeat(16),
          capability: CAPABILITY,
          kernelAddress: KERNEL,
          recipientHint: OWNER,
        },
      },
      response,
    );

    expect(response.statusCode).toBe(503);
    expect(jsonOf(response)).toEqual({
      error: 'unwind relay is unavailable',
    });
    expect(response.headers['Set-Cookie']).toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('reserves a durable hash-only unwind authority before any Base or CCTP action', async () => {
    const jobId = 'ab'.repeat(16);
    const mixedKernel = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
    const canonicalKernel = mixedKernel.toLowerCase();
    const reserve = vi.fn((input) => ({
      jobId: input.jobId,
      status: 'awaiting_burn',
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: input.expiresAt,
      capabilityExpiresAt: input.capabilityExpiresAt,
    }));
    const relayReverseMint = vi.fn();
    const jobs = new Map();
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs,
      genId: vi.fn(),
      unwindJobs: {
        reserve,
        getAuthority: vi.fn(),
        status: vi.fn(),
        claimEvidence: vi.fn(),
        renewEvidence: vi.fn(),
        releaseEvidence: vi.fn(),
        attachAndEnqueue: vi.fn(),
        finishBlocked: vi.fn(),
        finishUncertain: vi.fn(),
        reconcileFromCctp: vi.fn(),
        reconcileExpired: vi.fn(),
        listForResume: vi.fn(),
      },
      readUnwindEvidence: vi.fn(),
      relayReverseMint,
      unwindPublicClient: { getChainId() {}, getTransactionReceipt() {} },
      unwindBundlerClient: {
        getUserOperation() {},
        getUserOperationReceipt() {},
      },
      unwindEvidenceFacts: {
        generation: 'hardened-v2',
        chainId: 84532,
        entryPointAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032',
        baseExitSweeperAddress: `0x${'44'.repeat(20)}`,
        usdcAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        tokenMessengerV2Address: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
        messageTransmitterV2Address: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
        stellarDomain: 27,
        stellarTokenMessenger: `0x${'55'.repeat(32)}`,
        cctpForwarder: `0x${'66'.repeat(32)}`,
        finalityThreshold: 1000,
      },
      unwindCookieMaxAgeSeconds: 3600,
      nowMs: () => 1_700_000_000_000,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind',
        headers: {},
        body: {
          jobId,
          capability: CAPABILITY,
          kernelAddress: mixedKernel,
          recipientHint: OWNER,
        },
      },
      response,
    );

    expect(response.statusCode).toBe(202);
    expect(jsonOf(response)).toEqual({ jobId, status: 'awaiting_burn' });
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Set-Cookie']).toBe(
      `__Host-vf-unwind-${jobId}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
    );
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        capabilityHash: CAPABILITY_HASH,
        kernelAddress: canonicalKernel,
        recipientHint: OWNER,
        expiresAt: 1_700_003_300_000,
        capabilityExpiresAt: 1_700_003_600_000,
        now: 1_700_000_000_000,
      }),
    );
    expect(Object.keys(reserve.mock.calls[0][0])).not.toContain('capability');
    expect(jobs.size).toBe(0);
    expect(relayReverseMint).not.toHaveBeenCalled();
  });

  it('reinstalls an exact reserve retry cookie only for the immutable remaining lifetime', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-unwind-retry-')), 'relayer.db'));
    const jobId = 'ab'.repeat(16);
    let now = 1_700_000_000_000;
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: stores.unwindJobs,
      readUnwindEvidence: vi.fn(),
      relayReverseMint: vi.fn(),
      unwindPublicClient: { getChainId() {}, getTransactionReceipt() {} },
      unwindBundlerClient: {
        getUserOperation() {},
        getUserOperationReceipt() {},
      },
      unwindEvidenceFacts: {
        generation: 'hardened-v2',
        chainId: 84532,
        entryPointAddress: '0x0000000071727de22e5e9d8baf0edac6f37da032',
        baseExitSweeperAddress: `0x${'44'.repeat(20)}`,
        usdcAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        tokenMessengerV2Address: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
        messageTransmitterV2Address: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
        stellarDomain: 27,
        stellarTokenMessenger: `0x${'55'.repeat(32)}`,
        cctpForwarder: `0x${'66'.repeat(32)}`,
        finalityThreshold: 1000,
      },
      unwindCookieMaxAgeSeconds: 3600,
      nowMs: () => now,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const request = () => ({
      method: 'POST',
      url: '/api/vf-cross/unwind',
      headers: {},
      body: {
        jobId,
        capability: CAPABILITY,
        kernelAddress: KERNEL,
        recipientHint: OWNER,
      },
    });
    const first = mockRes();
    await router(request(), first);
    const before = stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(jobId);
    now += 1_234_000;
    const retry = mockRes();
    await router(request(), retry);

    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(retry.headers['Set-Cookie']).toContain('Max-Age=2366');
    expect(retry.headers['Set-Cookie']).not.toContain('Max-Age=3600');
    expect(stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(jobId)).toEqual(before);
    stores.db.close();
  });

  it('keeps the exact attach capability alive through bounded evidence grace without reopening burn admission', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-unwind-grace-')), 'relayer.db'));
    const jobId = 'ab'.repeat(16);
    const start = 1_700_000_000_000;
    let now = start;
    const readUnwindEvidence = vi.fn(async () => {
      const error = new Error('receipt index is not ready');
      error.code = 'UNWIND_EVIDENCE_RETRYABLE';
      throw error;
    });
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: stores.jobs,
      genId: vi.fn(),
      unwindJobs: stores.unwindJobs,
      readUnwindEvidence,
      relayReverseMint: vi.fn(),
      unwindPublicClient: UNWIND_PUBLIC_CLIENT,
      unwindBundlerClient: UNWIND_BUNDLER_CLIENT,
      unwindEvidenceFacts: UNWIND_FACTS,
      unwindCookieMaxAgeSeconds: 3_600,
      unwindBurnMaxAgeSeconds: 3_300,
      unwindEvidenceRetryMs: 300_000,
      nowMs: () => now,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const reserveRequest = () => ({
      method: 'POST',
      url: '/api/vf-cross/unwind',
      headers: {},
      body: {
        jobId,
        capability: CAPABILITY,
        kernelAddress: KERNEL,
        recipientHint: OWNER,
      },
    });
    const attachRequest = (userOpHash = USER_OP_HASH) => ({
      method: 'POST',
      url: '/api/vf-cross/unwind/attach',
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: { jobId, userOpHash, unwindTxHash: TX_HASH },
    });

    const reserved = mockRes();
    await router(reserveRequest(), reserved);
    expect(reserved.statusCode).toBe(202);
    expect(reserved.headers['Set-Cookie']).toContain('Max-Age=3600');
    expect(stores.unwindJobs.getAuthority(jobId)).toMatchObject({
      expiresAt: start + 3_300_000,
      capabilityExpiresAt: start + 3_600_000,
    });

    now = start + 3_299_000;
    const transient = mockRes();
    await router(attachRequest(), transient);
    expect(transient.statusCode).toBe(503);
    expect(readUnwindEvidence).toHaveBeenCalledTimes(1);

    now = start + 3_301_000;
    const secondBurn = mockRes();
    await router(reserveRequest(), secondBurn);
    expect(secondBurn.statusCode).toBe(409);
    expect(secondBurn.headers['Set-Cookie']).toBeUndefined();

    const exactRetry = mockRes();
    await router(attachRequest(), exactRetry);
    expect(exactRetry.statusCode).toBe(503);
    expect(readUnwindEvidence).toHaveBeenCalledTimes(2);

    const changed = mockRes();
    await router(attachRequest(`0x${'35'.repeat(32)}`), changed);
    expect(changed.statusCode).toBe(409);
    expect(readUnwindEvidence).toHaveBeenCalledTimes(2);
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(0);
    stores.db.close();
  });

  it('returns only the authenticated unwind public projection from POST /status', async () => {
    const jobId = 'ab'.repeat(16);
    const getAuthority = vi.fn(() => ({
      jobId,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      expiresAt: 1_700_003_600_000,
      capabilityExpiresAt: 1_700_003_600_000,
      state: 'relay_pending',
      capabilityHash: CAPABILITY_HASH,
    }));
    const status = vi.fn(() => {
      throw new Error('stale wrapper read must not answer status');
    });
    const reconcileFromCctp = vi.fn(() => ({
      jobId,
      status: 'relay_pending',
      unwindTxHash: TX_HASH,
    }));
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: { getAuthority, status, reconcileFromCctp },
      nowMs: () => 1_700_000_000_000,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/status',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: { jobId },
      },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(jsonOf(response)).toEqual({
      jobId,
      status: 'relay_pending',
      unwindTxHash: TX_HASH,
    });
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(getAuthority).toHaveBeenCalledWith(jobId);
    expect(reconcileFromCctp).toHaveBeenCalledWith({
      jobId,
      now: 1_700_000_000_000,
    });
    expect(status).not.toHaveBeenCalled();
    expect(response.body).not.toContain(CAPABILITY);
    expect(response.body).not.toContain(CAPABILITY_HASH);
  });

  it('enforces the durable capability expiry boundary before attach/status follow-on work', async () => {
    const jobId = 'ab'.repeat(16);
    const capabilityExpiresAt = 1_700_000_001_000;
    let now = capabilityExpiresAt - 1;
    const claimEvidence = vi.fn(() => ({
      jobId,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      leaseToken: 'boundary-lease',
      leaseExpiresAt: capabilityExpiresAt,
    }));
    const reconcileFromCctp = vi.fn(() => ({ jobId, status: 'awaiting_burn' }));
    const readUnwindEvidence = vi.fn(async () => {
      const error = new Error('retry');
      error.code = 'UNWIND_EVIDENCE_RETRYABLE';
      throw error;
    });
    const unwindJobs = {
      reserve: vi.fn(),
      getAuthority: vi.fn(() => ({
        jobId,
        kernelAddress: KERNEL,
        recipientHint: OWNER,
        state: 'awaiting_burn',
        capabilityHash: CAPABILITY_HASH,
        capabilityExpiresAt,
        userOpHash: null,
        unwindTxHash: null,
      })),
      status: vi.fn(),
      claimEvidence,
      renewEvidence: vi.fn(),
      releaseEvidence: vi.fn(),
      attachAndEnqueue: vi.fn(),
      finishBlocked: vi.fn(),
      finishUncertain: vi.fn(),
      reconcileFromCctp,
      reconcileExpired: vi.fn(),
      listForResume: vi.fn(),
    };
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs,
      readUnwindEvidence,
      relayReverseMint: vi.fn(),
      unwindPublicClient: UNWIND_PUBLIC_CLIENT,
      unwindBundlerClient: UNWIND_BUNDLER_CLIENT,
      unwindEvidenceFacts: UNWIND_FACTS,
      nowMs: () => now,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const statusRequest = () => ({
      method: 'POST',
      url: '/api/vf-cross/status',
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: { jobId },
    });
    const attachRequest = () => ({
      method: 'POST',
      url: '/api/vf-cross/unwind/attach',
      headers: { authorization: `Bearer ${CAPABILITY}` },
      body: { jobId, userOpHash: USER_OP_HASH, unwindTxHash: TX_HASH },
    });

    const justBeforeStatus = mockRes();
    await router(statusRequest(), justBeforeStatus);
    expect(justBeforeStatus.statusCode).toBe(200);
    const justBeforeAttach = mockRes();
    await router(attachRequest(), justBeforeAttach);
    expect(justBeforeAttach.statusCode).toBe(503);
    expect({
      claim: claimEvidence.mock.calls.length,
      reconcile: reconcileFromCctp.mock.calls.length,
      reads: readUnwindEvidence.mock.calls.length,
    }).toEqual({ claim: 1, reconcile: 1, reads: 1 });

    for (const boundary of [capabilityExpiresAt, capabilityExpiresAt + 1]) {
      now = boundary;
      for (const request of [statusRequest(), attachRequest()]) {
        const response = mockRes();
        await router(request, response);
        expect(response.statusCode).toBe(401);
        expect(jsonOf(response)).toEqual({ error: 'unauthorized' });
      }
    }
    expect({
      claim: claimEvidence.mock.calls.length,
      reconcile: reconcileFromCctp.mock.calls.length,
      reads: readUnwindEvidence.mock.calls.length,
    }).toEqual({ claim: 1, reconcile: 1, reads: 1 });
  });

  it.each([
    [
      'pending',
      {
        jobId: 'ab'.repeat(16),
        status: 'relay_pending',
        unwindTxHash: TX_HASH,
      },
    ],
    [
      'running',
      {
        jobId: 'ab'.repeat(16),
        status: 'relay_running',
        unwindTxHash: TX_HASH,
      },
    ],
    [
      'submitted',
      {
        jobId: 'ab'.repeat(16),
        status: 'relay_running',
        unwindTxHash: TX_HASH,
        mintTxHash: 'aa'.repeat(32),
      },
    ],
    [
      'done',
      {
        jobId: 'ab'.repeat(16),
        status: 'done',
        unwindTxHash: TX_HASH,
        mintTxHash: 'aa'.repeat(32),
      },
    ],
    [
      'blocked',
      {
        jobId: 'ab'.repeat(16),
        status: 'blocked',
        unwindTxHash: TX_HASH,
        reasonCode: 'destination_reverted',
      },
    ],
    [
      'uncertain',
      {
        jobId: 'ab'.repeat(16),
        status: 'uncertain',
        unwindTxHash: TX_HASH,
        mintTxHash: 'aa'.repeat(32),
        reasonCode: 'submitted_checkpoint_failed',
      },
    ],
  ])(
    'projects authenticated Task8 %s truth on status without evidence reads or relay sends',
    async (_label, projection) => {
      const readUnwindEvidence = vi.fn();
      const relayReverseMint = vi.fn();
      const reconcileFromCctp = vi.fn(() => projection);
      const router = createRelayerRouter({
        buildFarm: vi.fn(),
        jobs: new Map(),
        genId: vi.fn(),
        unwindJobs: {
          reserve: vi.fn(),
          getAuthority: vi.fn(() => ({
            jobId: projection.jobId,
            kernelAddress: KERNEL,
            recipientHint: OWNER,
            capabilityHash: CAPABILITY_HASH,
            capabilityExpiresAt: 1_700_003_600_000,
          })),
          reconcileFromCctp,
        },
        readUnwindEvidence,
        relayReverseMint,
        nowMs: () => 1_700_000_000_000,
        publicRuntime: { baseCrossChainAvailable: true },
      });
      const response = mockRes();
      await router(
        {
          method: 'POST',
          url: '/api/vf-cross/status',
          headers: { authorization: `Bearer ${CAPABILITY}` },
          body: { jobId: projection.jobId },
        },
        response,
      );

      expect(response.statusCode).toBe(200);
      expect(jsonOf(response)).toEqual(projection);
      expect(reconcileFromCctp).toHaveBeenCalledOnce();
      expect(readUnwindEvidence).not.toHaveBeenCalled();
      expect(relayReverseMint).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing Authorization', {}],
    ['Basic Authorization', { authorization: `Basic ${CAPABILITY}` }],
    ['lowercase bearer', { authorization: `bearer ${CAPABILITY}` }],
    ['trailing bearer token', { authorization: `Bearer ${CAPABILITY} extra` }],
    ['Node Cookie only', { cookie: `__Host-vf-unwind-${'ab'.repeat(16)}=${CAPABILITY}` }],
    [
      'Bearer plus Node Cookie',
      {
        authorization: `Bearer ${CAPABILITY}`,
        cookie: `__Host-vf-unwind-${'ab'.repeat(16)}=${CAPABILITY}`,
      },
    ],
  ])('rejects unwind attach with %s before authority, evidence, or state reads', async (_label, headers) => {
    const getAuthority = vi.fn();
    const status = vi.fn();
    const readUnwindEvidence = vi.fn();
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: { getAuthority, status },
      readUnwindEvidence,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind/attach',
        headers,
        body: {
          jobId: 'ab'.repeat(16),
          userOpHash: USER_OP_HASH,
          unwindTxHash: TX_HASH,
        },
      },
      response,
    );

    expect(response.statusCode).toBe(401);
    expect(jsonOf(response)).toEqual({ error: 'unauthorized' });
    expect(getAuthority).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(readUnwindEvidence).not.toHaveBeenCalled();
    expect(response.body).not.toContain(CAPABILITY);
  });

  it('returns indistinguishable authorization failures for wrong, cross-job, and unknown unwind authority', async () => {
    const existingJob = 'ab'.repeat(16);
    const unknownJob = 'cd'.repeat(16);
    const wrongCapability = 'f'.repeat(64);
    const secondCapability = 'e'.repeat(64);
    const authorities = new Map([
      [
        existingJob,
        {
          jobId: existingJob,
          capabilityHash: CAPABILITY_HASH,
          kernelAddress: KERNEL,
          recipientHint: OWNER,
          capabilityExpiresAt: 1_700_003_600_000,
        },
      ],
      [
        unknownJob,
        {
          jobId: unknownJob,
          capabilityHash: sha256(secondCapability),
          kernelAddress: KERNEL,
          recipientHint: OWNER,
          capabilityExpiresAt: 1_700_003_600_000,
        },
      ],
    ]);
    const getAuthority = vi.fn((jobId) => authorities.get(jobId) ?? null);
    const status = vi.fn();
    const readUnwindEvidence = vi.fn();
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: { getAuthority, status },
      readUnwindEvidence,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const cases = [
      { jobId: existingJob, capability: wrongCapability },
      { jobId: existingJob, capability: secondCapability },
      { jobId: 'ef'.repeat(16), capability: wrongCapability },
    ];
    const bodies = [];
    for (const testCase of cases) {
      const response = mockRes();
      await router(
        {
          method: 'POST',
          url: '/api/vf-cross/status',
          headers: { authorization: `Bearer ${testCase.capability}` },
          body: { jobId: testCase.jobId },
        },
        response,
      );
      expect(response.statusCode).toBe(401);
      bodies.push(response.body);
    }

    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: 'unauthorized' })]));
    expect(status).not.toHaveBeenCalled();
    expect(readUnwindEvidence).not.toHaveBeenCalled();
    for (const body of bodies) {
      expect(body).not.toMatch(new RegExp(`${wrongCapability}|${secondCapability}|${existingJob}`));
    }
  });

  it('rejects capability material in attach JSON before authority lookup', async () => {
    const getAuthority = vi.fn();
    const readUnwindEvidence = vi.fn();
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: { getAuthority },
      readUnwindEvidence,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();
    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind/attach',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: {
          jobId: 'ab'.repeat(16),
          userOpHash: USER_OP_HASH,
          unwindTxHash: TX_HASH,
          capability: CAPABILITY,
        },
      },
      response,
    );
    expect(response.statusCode).toBe(400);
    expect(jsonOf(response)).toEqual({ error: 'invalid unwind attach' });
    expect(getAuthority).not.toHaveBeenCalled();
    expect(readUnwindEvidence).not.toHaveBeenCalled();
    expect(response.body).not.toContain(CAPABILITY);
  });

  it('rejects extra unwind status fields before authority lookup or RPC', async () => {
    const getAuthority = vi.fn();
    const readUnwindEvidence = vi.fn();
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: { getAuthority, status: vi.fn() },
      readUnwindEvidence,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/status',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: { jobId: 'ab'.repeat(16), owner: KERNEL },
      },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(jsonOf(response)).toEqual({ error: 'invalid status request' });
    expect(getAuthority).not.toHaveBeenCalled();
    expect(readUnwindEvidence).not.toHaveBeenCalled();
  });

  it('authenticates and atomically attaches chain proof before scheduling only Task8 mint resume', async () => {
    const jobId = 'ab'.repeat(16);
    const proof = Object.freeze({
      synthetic: 'verified-proof',
      userOpHash: USER_OP_HASH,
      unwindTxHash: TX_HASH,
    });
    const expectation = Object.freeze({
      sourceDomain: 6,
      direction: 'base-to-stellar',
    });
    const publicClient = UNWIND_PUBLIC_CLIENT;
    const bundlerClient = UNWIND_BUNDLER_CLIENT;
    const facts = UNWIND_FACTS;
    const getAuthority = vi.fn(() => ({
      jobId,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      state: 'awaiting_burn',
      capabilityHash: CAPABILITY_HASH,
      capabilityExpiresAt: 1_700_003_600_000,
      userOpHash: null,
      unwindTxHash: null,
    }));
    const claimEvidence = vi.fn(() => ({
      jobId,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      leaseToken: 'evidence-lease',
      leaseExpiresAt: 1_700_000_030_000,
    }));
    const attachAndEnqueue = vi.fn(() => ({
      duplicate: false,
      record: { jobId, status: 'relay_pending', unwindTxHash: TX_HASH },
    }));
    const readUnwindEvidence = vi.fn(async () => ({ proof, expectation }));
    const relayReverseMint = vi.fn(async () => ({ status: 'in-progress' }));
    const buildFarm = vi.fn();
    const router = createRelayerRouter({
      buildFarm,
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: {
        reserve: vi.fn(),
        getAuthority,
        status: vi.fn(),
        claimEvidence,
        renewEvidence: vi.fn(),
        releaseEvidence: vi.fn(),
        attachAndEnqueue,
        finishBlocked: vi.fn(),
        finishUncertain: vi.fn(),
        reconcileFromCctp: vi.fn(),
        reconcileExpired: vi.fn(),
        listForResume: vi.fn(),
      },
      readUnwindEvidence,
      relayReverseMint,
      unwindPublicClient: publicClient,
      unwindBundlerClient: bundlerClient,
      unwindEvidenceFacts: facts,
      nowMs: () => 1_700_000_000_000,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind/attach',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: { jobId, userOpHash: USER_OP_HASH, unwindTxHash: TX_HASH },
      },
      response,
    );

    expect(response.statusCode).toBe(202);
    expect(jsonOf(response)).toEqual({
      jobId,
      status: 'relay_pending',
      unwindTxHash: TX_HASH,
    });
    expect(readUnwindEvidence).toHaveBeenCalledWith({
      publicClient,
      bundlerClient,
      jobId,
      userOpHash: USER_OP_HASH,
      unwindTxHash: TX_HASH,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      facts,
    });
    expect(claimEvidence).toHaveBeenCalledWith({
      jobId,
      userOpHash: USER_OP_HASH,
      unwindTxHash: TX_HASH,
      now: 1_700_000_000_000,
      leaseMs: 30_000,
      retryMs: 300_000,
    });
    expect(attachAndEnqueue).toHaveBeenCalledWith({
      jobId,
      proof,
      expectation,
      relayExecId: `unwind:${jobId}`,
      leaseToken: 'evidence-lease',
      now: 1_700_000_000_000,
    });
    await vi.waitFor(() =>
      expect(relayReverseMint).toHaveBeenCalledWith({
        execId: `unwind:${jobId}`,
        sourceDomain: 6,
        burnTxHash: TX_HASH,
        expectation,
      }),
    );
    expect(buildFarm).not.toHaveBeenCalled();
  });

  it('attaches through the real SQLite authority from a fresh reservation with nullable hashes', async () => {
    const stores = createSqliteStores(join(mkdtempSync(join(tmpdir(), 'vf-unwind-route-')), 'relayer.db'));
    const jobId = 'ab'.repeat(16);
    const reserveJson = JSON.stringify({
      jobId,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
    });
    const requestDigest = sha256(`vf-unwind-reserve-v1\0${reserveJson}`);
    stores.unwindJobs.reserve({
      jobId,
      capabilityHash: CAPABILITY_HASH,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      requestDigest,
      expiresAt: 1_700_003_300_000,
      capabilityExpiresAt: 1_700_003_600_000,
      now: 1_700_000_000_000,
    });
    expect(stores.unwindJobs.getAuthority(jobId).userOpHash).toBeNull();
    expect(stores.unwindJobs.getAuthority(jobId).unwindTxHash).toBeNull();
    const expectation = Object.freeze({
      version: 1,
      direction: 'base-to-stellar',
      sourceDomain: 6,
      destinationDomain: 27,
      sender: `0x${'01'.repeat(32)}`,
      recipient: `0x${'02'.repeat(32)}`,
      destinationCaller: `0x${'03'.repeat(32)}`,
      burnToken: `0x${'04'.repeat(32)}`,
      mintRecipient: `0x${'05'.repeat(32)}`,
      messageSender: `0x${'00'.repeat(12)}${'06'.repeat(20)}`,
      amount: '123',
      burnUnits7: null,
      maxFee: '7',
      minFinalityThreshold: 1000,
      hookData: '0x',
    });
    const proof = Object.freeze({
      version: 1,
      chainId: 84532,
      userOpHash: USER_OP_HASH,
      jobCommitment: unwindJobCommitment(jobId),
      unwindTxHash: TX_HASH,
      entryPointAddress: `0x${'07'.repeat(20)}`,
      kernelAddress: KERNEL,
      blockNumber: '1234',
      blockHash: `0x${'08'.repeat(32)}`,
      userOpNonce: '9',
      burned: '123',
      exited: '125',
      skipped: '0',
      maxFee: '7',
      hookData: '0x',
      sourceMessageHex: '0xdeadbeef',
      sourceMessageDigest: sha256(Buffer.from('deadbeef', 'hex')),
      logIndices: Object.freeze({
        messageSent: 1,
        depositForBurn: 2,
        swept: 3,
        userOperationEvent: 4,
      }),
      logDigests: Object.freeze({
        messageSent: '11'.repeat(32),
        depositForBurn: '12'.repeat(32),
        swept: '13'.repeat(32),
        userOperationEvent: '14'.repeat(32),
      }),
    });
    const relayReverseMint = vi.fn(async () => ({ status: 'in-progress' }));
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: stores.jobs,
      genId: vi.fn(),
      unwindJobs: stores.unwindJobs,
      readUnwindEvidence: vi.fn(async () => ({ proof, expectation })),
      relayReverseMint,
      unwindPublicClient: UNWIND_PUBLIC_CLIENT,
      unwindBundlerClient: UNWIND_BUNDLER_CLIENT,
      unwindEvidenceFacts: UNWIND_FACTS,
      nowMs: () => 1_700_000_000_100,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind/attach',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: { jobId, userOpHash: USER_OP_HASH, unwindTxHash: TX_HASH },
      },
      response,
    );

    expect(response.statusCode).toBe(202);
    expect(jsonOf(response)).toEqual({
      jobId,
      status: 'relay_pending',
      unwindTxHash: TX_HASH,
    });
    expect(stores.cctpRelays.get(`unwind:${jobId}`)).toMatchObject({
      sourceDomain: 6,
      burnTxHash: TX_HASH,
      state: 'attestation_pending',
    });
    expect(JSON.stringify(stores.unwindJobs.getAuthority(jobId))).not.toContain(CAPABILITY);
    await vi.waitFor(() => expect(relayReverseMint).toHaveBeenCalledTimes(1));
    stores.db.close();
  });

  it('rejects a reader-returned receipt identity that differs from the authenticated attach pair', async () => {
    const jobId = 'ab'.repeat(16);
    const finishBlocked = vi.fn(() => ({
      jobId,
      status: 'blocked',
      reasonCode: 'message_mismatch',
    }));
    const attachAndEnqueue = vi.fn();
    const relayReverseMint = vi.fn();
    const unwindJobs = {
      reserve: vi.fn(),
      getAuthority: vi.fn(() => ({
        jobId,
        kernelAddress: KERNEL,
        recipientHint: OWNER,
        state: 'awaiting_burn',
        capabilityHash: CAPABILITY_HASH,
        capabilityExpiresAt: 1_700_003_600_000,
        userOpHash: null,
        unwindTxHash: null,
      })),
      status: vi.fn(),
      claimEvidence: vi.fn(() => ({
        jobId,
        kernelAddress: KERNEL,
        recipientHint: OWNER,
        leaseToken: 'identity-lease',
        leaseExpiresAt: 1_700_000_030_000,
      })),
      renewEvidence: vi.fn(),
      releaseEvidence: vi.fn(),
      attachAndEnqueue,
      finishBlocked,
      finishUncertain: vi.fn(),
      reconcileFromCctp: vi.fn(),
      reconcileExpired: vi.fn(),
      listForResume: vi.fn(),
    };
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs,
      readUnwindEvidence: vi.fn(async () => ({
        proof: {
          userOpHash: `0x${'35'.repeat(32)}`,
          unwindTxHash: TX_HASH,
        },
        expectation: { direction: 'base-to-stellar', sourceDomain: 6 },
      })),
      relayReverseMint,
      unwindPublicClient: UNWIND_PUBLIC_CLIENT,
      unwindBundlerClient: UNWIND_BUNDLER_CLIENT,
      unwindEvidenceFacts: UNWIND_FACTS,
      nowMs: () => 1_700_000_000_000,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();
    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind/attach',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: { jobId, userOpHash: USER_OP_HASH, unwindTxHash: TX_HASH },
      },
      response,
    );

    expect(response.statusCode).toBe(409);
    expect(finishBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        leaseToken: 'identity-lease',
        reasonCode: 'message_mismatch',
      }),
    );
    expect(attachAndEnqueue).not.toHaveBeenCalled();
    expect(relayReverseMint).not.toHaveBeenCalled();
  });

  it('durably blocks an authenticated mismatched proof under the live evidence lease', async () => {
    const jobId = 'ab'.repeat(16);
    const finishBlocked = vi.fn(() => ({
      jobId,
      status: 'blocked',
      reasonCode: 'message_mismatch',
    }));
    const releaseEvidence = vi.fn();
    const attachAndEnqueue = vi.fn();
    const relayReverseMint = vi.fn();
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: {
        reserve: vi.fn(),
        getAuthority: vi.fn(() => ({
          jobId,
          kernelAddress: KERNEL,
          recipientHint: OWNER,
          state: 'awaiting_burn',
          capabilityHash: CAPABILITY_HASH,
          capabilityExpiresAt: 1_700_003_600_000,
          userOpHash: null,
          unwindTxHash: null,
        })),
        claimEvidence: vi.fn(() => ({
          jobId,
          kernelAddress: KERNEL,
          recipientHint: OWNER,
          leaseToken: 'evidence-lease',
          leaseExpiresAt: 1_700_000_030_000,
        })),
        renewEvidence: vi.fn(),
        releaseEvidence,
        finishBlocked,
        finishUncertain: vi.fn(),
        status: vi.fn(),
        reconcileFromCctp: vi.fn(),
        reconcileExpired: vi.fn(),
        listForResume: vi.fn(),
        attachAndEnqueue,
      },
      readUnwindEvidence: vi.fn(async () => {
        const error = new Error('private decoder detail');
        error.code = 'UNWIND_EVIDENCE_MISMATCH';
        throw error;
      }),
      relayReverseMint,
      unwindPublicClient: UNWIND_PUBLIC_CLIENT,
      unwindBundlerClient: UNWIND_BUNDLER_CLIENT,
      unwindEvidenceFacts: UNWIND_FACTS,
      nowMs: () => 1_700_000_000_000,
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router(
      {
        method: 'POST',
        url: '/api/vf-cross/unwind/attach',
        headers: { authorization: `Bearer ${CAPABILITY}` },
        body: { jobId, userOpHash: USER_OP_HASH, unwindTxHash: TX_HASH },
      },
      response,
    );

    expect(response.statusCode).toBe(409);
    expect(jsonOf(response)).toEqual({ error: 'unwind evidence was rejected' });
    expect(response.body).not.toContain('private decoder detail');
    expect(finishBlocked).toHaveBeenCalledWith({
      jobId,
      leaseToken: 'evidence-lease',
      reasonCode: 'message_mismatch',
      now: 1_700_000_000_000,
    });
    expect(releaseEvidence).not.toHaveBeenCalled();
    expect(attachAndEnqueue).not.toHaveBeenCalled();
    expect(relayReverseMint).not.toHaveBeenCalled();
  });

  it.each(['/unwind?capability=secret', '/unwind/attach?x=1', '/status?token=secret'])(
    'rejects query-bearing unwind request %s before auth, lookup, or RPC',
    async (suffix) => {
      const reserve = vi.fn();
      const getAuthority = vi.fn();
      const readUnwindEvidence = vi.fn();
      const router = createRelayerRouter({
        buildFarm: vi.fn(),
        jobs: new Map(),
        genId: vi.fn(),
        unwindJobs: { reserve, getAuthority, status: vi.fn() },
        readUnwindEvidence,
        publicRuntime: { baseCrossChainAvailable: true },
      });
      const response = mockRes();
      const path = suffix.split('?')[0];
      const body =
        path === '/unwind'
          ? {
              jobId: 'ab'.repeat(16),
              capability: CAPABILITY,
              kernelAddress: KERNEL,
              recipientHint: OWNER,
            }
          : path === '/unwind/attach'
            ? {
                jobId: 'ab'.repeat(16),
                userOpHash: USER_OP_HASH,
                unwindTxHash: TX_HASH,
              }
            : { jobId: 'ab'.repeat(16) };

      await router(
        {
          method: 'POST',
          url: `/api/vf-cross${suffix}`,
          headers: { authorization: `Bearer ${CAPABILITY}` },
          body,
        },
        response,
      );

      expect(response.statusCode).toBe(400);
      expect(jsonOf(response)).toEqual({ error: 'invalid request' });
      expect(response.headers['Cache-Control']).toBe('no-store');
      expect(reserve).not.toHaveBeenCalled();
      expect(getAuthority).not.toHaveBeenCalled();
      expect(readUnwindEvidence).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['POST', '/api/vf-cross/unwind'],
    ['POST', '/api/vf-cross/unwind/attach'],
    ['POST', '/api/vf-cross/status'],
    ['OPTIONS', '/api/vf-cross/unwind/attach'],
  ])('never exposes protected unwind authority with wildcard CORS: %s %s', async (method, url) => {
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      publicRuntime: { baseCrossChainAvailable: true },
    });
    const response = mockRes();

    await router({ method, url, headers: {}, body: {} }, response);

    expect(response.headers['Access-Control-Allow-Origin']).not.toBe('*');
    expect(response.headers['Access-Control-Allow-Credentials']).not.toBe('true');
  });

  it('reconciles expired leases then bounded Task8 projections without evidence reads or mint sends', async () => {
    const calls = [];
    const readUnwindEvidence = vi.fn();
    const relayReverseMint = vi.fn();
    const unwindJobs = {
      reconcileExpired: vi.fn(() => {
        calls.push('expired');
        return [{ jobId: 'ee'.repeat(16), status: 'expired' }];
      }),
      listForResume: vi.fn(() => {
        calls.push('list');
        return [
          {
            jobId: '01'.repeat(16),
            relayExecId: `unwind:${'01'.repeat(16)}`,
            state: 'relay_pending',
          },
          {
            jobId: '02'.repeat(16),
            relayExecId: `unwind:${'02'.repeat(16)}`,
            state: 'relay_running',
          },
        ];
      }),
      reconcileFromCctp: vi.fn(({ jobId }) => {
        calls.push(`project:${jobId}`);
        return jobId.startsWith('01')
          ? {
              jobId,
              status: 'done',
              unwindTxHash: TX_HASH,
              mintTxHash: 'aa'.repeat(32),
            }
          : { jobId, status: 'relay_running', unwindTxHash: TX_HASH };
      }),
    };
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs,
      readUnwindEvidence,
      relayReverseMint,
      nowMs: () => 1_700_000_000_000,
      recoveryLimit: 10,
      recoveryConcurrency: 1,
      publicRuntime: { baseCrossChainAvailable: true },
    });

    const result = await router.resumeUnwindJobs({ limit: 2 });

    expect(calls).toEqual(['expired', 'list', `project:${'01'.repeat(16)}`, `project:${'02'.repeat(16)}`]);
    expect(unwindJobs.reconcileExpired).toHaveBeenCalledWith({
      now: 1_700_000_000_000,
      limit: 2,
    });
    expect(unwindJobs.listForResume).toHaveBeenCalledWith({
      now: 1_700_000_000_000,
      limit: 2,
    });
    expect(result).toEqual({
      resumed: ['01'.repeat(16)],
      held: ['02'.repeat(16)],
      blocked: [],
      uncertain: [],
      expired: ['ee'.repeat(16)],
    });
    expect(readUnwindEvidence).not.toHaveBeenCalled();
    expect(relayReverseMint).not.toHaveBeenCalled();
  });

  it('recovers only proof-fenced existing reverse work while new Base execution is unavailable', async () => {
    const jobId = '03'.repeat(16);
    const relayExecId = `unwind:${jobId}`;
    const calls = [];
    const readUnwindEvidence = vi.fn();
    const relayReverseMint = vi.fn();
    const resumeExistingReverse = vi.fn(async (execId) => {
      calls.push(`drive:${execId}`);
      return { status: 'mint_submitted', mintTxHash: 'aa'.repeat(32) };
    });
    const unwindJobs = {
      reconcileExpired: vi.fn(() => []),
      listForResume: vi.fn(() => [{ jobId, relayExecId, state: 'relay_running' }]),
      reconcileFromCctp: vi.fn(({ jobId: projectedJobId }) => {
        calls.push(`project:${projectedJobId}`);
        return {
          jobId: projectedJobId,
          status: 'relay_running',
          unwindTxHash: TX_HASH,
          mintTxHash: 'aa'.repeat(32),
        };
      }),
    };
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs,
      readUnwindEvidence,
      relayReverseMint,
      resumeExistingReverse,
      nowMs: () => 1_700_000_000_000,
      recoveryLimit: 10,
      recoveryConcurrency: 1,
      publicRuntime: { baseCrossChainAvailable: false },
    });

    await expect(router.resumeUnwindJobs({ limit: 2 })).resolves.toEqual({
      resumed: [],
      held: [jobId],
      blocked: [],
      uncertain: [],
      expired: [],
    });
    expect(calls).toEqual([`drive:${relayExecId}`, `project:${jobId}`]);
    expect(readUnwindEvidence).not.toHaveBeenCalled();
    expect(relayReverseMint).not.toHaveBeenCalled();
  });

  it('keeps the recovery guard until every sibling settles after an early worker failure', async () => {
    const firstJob = '04'.repeat(16);
    const gatedJob = '05'.repeat(16);
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const listForResume = vi.fn(() => [
      {
        jobId: firstJob,
        relayExecId: `unwind:${firstJob}`,
        state: 'relay_pending',
      },
      {
        jobId: gatedJob,
        relayExecId: `unwind:${gatedJob}`,
        state: 'relay_pending',
      },
    ]);
    const reconcileFromCctp = vi.fn(async ({ jobId }) => {
      if (jobId === firstJob) throw new Error('injected early projection failure');
      await gate;
      return { jobId, status: 'relay_pending', unwindTxHash: TX_HASH };
    });
    const router = createRelayerRouter({
      buildFarm: vi.fn(),
      jobs: new Map(),
      genId: vi.fn(),
      unwindJobs: {
        reconcileExpired: vi.fn(() => []),
        listForResume,
        reconcileFromCctp,
      },
      nowMs: () => 1_700_000_000_000,
      recoveryLimit: 10,
      recoveryConcurrency: 2,
      publicRuntime: { baseCrossChainAvailable: true },
    });

    const first = router.resumeUnwindJobs({ limit: 2 });
    const firstOutcome = first.catch((error) => error);
    let firstSettled = false;
    firstOutcome.finally(() => {
      firstSettled = true;
    });
    await vi.waitFor(() => expect(reconcileFromCctp).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstSettled).toBe(false);
    const overlapping = router.resumeUnwindJobs({ limit: 2 });
    const overlappingOutcome = overlapping.catch((error) => error);
    await Promise.resolve();

    expect(listForResume).toHaveBeenCalledTimes(1);
    expect(reconcileFromCctp).toHaveBeenCalledTimes(2);
    releaseGate();
    expect((await firstOutcome).message).toBe('injected early projection failure');
    expect((await overlappingOutcome).message).toBe('injected early projection failure');
    expect(listForResume).toHaveBeenCalledTimes(1);
  });
});
