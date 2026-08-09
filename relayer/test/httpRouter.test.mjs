import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { concatHex, encodeAbiParameters, keccak256, pad, slice } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  toCallPolicy,
  toTimestampPolicy,
  ParamCondition,
} from "@zerodev/permissions/policies";
import { createRelayerRouter } from "../src/httpRouter.mjs";
import {
  DEPOSITED_TOPIC0,
  createOrchestrator,
} from "../src/base/orchestrator.mjs";
import { createFarmFlow } from "../src/flows/farm.mjs";
import { createMandateStoresV3 } from "../src/mandateStore.mjs";
import {
  MAX_CALL_CAP_UNITS,
  validateMandateBinding,
} from "../src/base/session.mjs";
import { createSqliteStores } from "../src/sqliteStores.mjs";
import {
  createSecretEnvelope,
  parseSecretKeyring,
} from "../src/secretEnvelope.mjs";

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(s) {
      this.body = s ?? "";
      return this;
    },
  };
}
const jsonOf = (res) => (res.body ? JSON.parse(res.body) : undefined);

// Shared route allocation fixture. The approval itself is built below from the real ZeroDev
// policy serializers, so route tests exercise the same canonical Task-4 wire shape as activation.
const POOL_ADDRESS = `0x${"e5".repeat(20)}`;

function wireAllocation({
  allocationId = "run-42:bridge:aave-v3",
  pool = POOL_ADDRESS,
  units = 100n,
  minShares = "90",
} = {}) {
  return {
    allocationId,
    poolAddress: pool,
    amount: { token: "USDC", units: units.toString(), decimals: 6 },
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
const CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2';
const TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F';
const ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF';
const CANONICAL_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CANONICAL_ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
const DEFAULT_ACTION_SELECTOR = '0xe9ae5c53';
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const OTHER_KERNEL = `0x${'88'.repeat(20)}`;
const OTHER_SESSION_ADDRESS = privateKeyToAccount(
  `0x${'99'.repeat(32)}`,
).address;
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
  base: { chain: { id: 84532 }, mandatePolicy: POLICY },
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serializeCanonical(value) {
  return Buffer.from(JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  )), 'utf8').toString('base64');
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
        { params: [pad(CANONICAL_ROUTER, { size: 32 })], offset: 0, condition: ParamCondition.EQUAL },
        { params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL },
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
        { params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL },
      ],
    },
  ];
}

function canonicalPermissionId(entries) {
  const policiesData = encodeAbiParameters(
    [{ name: 'policiesData', type: 'bytes[]' }],
    [entries.map((entry) => concatHex([entry.getPolicyInfoInBytes(), entry.getPolicyData()]))],
  );
  const signerData = encodeAbiParameters(
    [{ name: 'signerData', type: 'bytes' }],
    [concatHex([ECDSA_SIGNER, SESSION])],
  );
  return slice(keccak256(encodeAbiParameters(
    [{ name: 'policyAndSignerData', type: 'bytes[]' }],
    [[policiesData, '0x0000', signerData]],
  )), 0, 4).toLowerCase();
}

function canonicalApproval(
  validUntilSeconds = VALID_UNTIL_SECONDS,
  {
    accountAddress = KERNEL,
    cap = MAX_CALL_CAP_UNITS,
    extraPermissions = [],
  } = {},
) {
  const call = toCallPolicy({
    policyVersion: '0.0.4',
    permissions: [...canonicalPermissions(cap), ...extraPermissions],
  });
  const timestamp = toTimestampPolicy({ validAfter: 0, validUntil: validUntilSeconds });
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
  return associations.flatMap(({ recoveryIdentity }) => (
    stores.associationOutbox.status(recoveryIdentity)
  ));
}

function mintedResult(mintTxHash) {
  return {
    status: 'minted',
    mintTxHash,
    evidence: {
      burnTxHash: 'burn-evidence', expectationDigest: 'expectation-evidence',
      messageDigest: 'message-evidence', attestationDigest: 'attestation-evidence',
      evidenceVersion: '1', mintTxHash,
    },
  };
}

function canonicalRecord(body, bindingId = 'binding-1') {
  const bindingHash = sha256(
    `${body.stellarOwner}|${body.kernelAddress}|${body.sessionKeyAddress}|${body.expiresAt}`,
  );
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
    get size() { return real.mandatesV3.size; },
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
} = {}) {
  const events = [];
  const real = realStores ?? createMandateStoresV3({
    nowSeconds: () => clock.value,
    leaseToken: (() => {
      let value = 0;
      return () => `activation-lease-${++value}`;
    })(),
  });
  const traced = tracedStores(real, events, { transformMandateGet, enqueueError });
  const evaluatorCalls = [];
  const activatorCalls = [];
  const activator = activateMandate ?? (async (approval, { onSubmitted } = {}) => {
    activatorCalls.push(approval);
    events.push('activator:called');
    events.push('activator:onSubmitted');
    await onSubmitted(USER_OP_HASH);
    events.push('activator:receipt');
    return { userOpHash: USER_OP_HASH, txHash: TX_HASH };
  });
  const evaluator = evaluateMandateStatusFn ?? (async (args) => {
    evaluatorCalls.push(args);
    events.push('evaluator:called');
    return { status: 'active', reasonCodes: [] };
  });
  let nextId = 0;
  const router = createRelayerRouter({
    buildFarm: vi.fn(() => ({ farm: vi.fn() })),
    relayUnwindMint: vi.fn(),
    jobs: new Map(),
    mandatesV2: new Proxy({}, {
      get() { throw new Error('v2 mandate store must not be consulted by the v3 router'); },
    }),
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
    publicRuntime: { networkId: 'stellar-testnet', mandateStatusConfig: CONFIG },
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
    headers: capability === undefined
      ? {}
      : { authorization: `Bearer ${capability}` },
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
    duplicateFailure.real.mandateActivations.enqueue({ record: canonicalRecord(body) });
    const duplicate = await postMandate(duplicateFailure, { ...body });
    expect(duplicate.res.statusCode).toBe(500);
    expect(duplicate.res.headers['Set-Cookie']).toBeUndefined();
    expect(duplicate.res.body).not.toContain(CAPABILITY);
    expect(duplicate.res.body).not.toContain(SESSION_KEY);
    expect(duplicate.res.body).not.toContain(body.serializedApproval);
  });

  it('authenticates exact duplicates before comparison and never reactivates pending or active bindings', async () => {
    let releaseActivation;
    const activationGate = new Promise((resolve) => { releaseActivation = resolve; });
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
    const wrongCapability = await postMandate(harness, { ...body, capability: wrong });
    expect(wrongCapability.res.statusCode).toBe(401);
    expect(wrongCapability.res.body).not.toContain(wrong);
    expect(wrongCapability.res.body).not.toContain(CAPABILITY);
    expect(sends).toBe(2);

    const missingCapability = await postMandate(harness, { ...body, capability: undefined });
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
      activateMandate: async () => { throw new Error(`bundler rejected ${SESSION_KEY}`); },
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
      expect(['activation_uncertain', 'revoked'])
        .toContain(harness.real.mandatesV3.status(identityOf(body)).status);
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
  ])('makes an activation failure %s uncertain without inventing evidence', async (_label, submitFirst, expectedHash) => {
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
    expect(JSON.stringify(harness.real.mandatesV3.status(identityOf(body))))
      .not.toContain('private activation failure');
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
      evaluateMandateStatusFn: async () => ({ status: 'unknown', reasonCodes: ['RPC_ERROR'] }),
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
      evaluateMandateStatusFn: async () => ({ status: 'revoked', reasonCodes: ['PERMISSION_REVOKED'] }),
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
    const bodies = [1, 2, 3, 4].map((index) => registrationBody({
      mandateId: mandateIdAt(index),
      capability: capabilityAt(index),
    }));
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
      ...identityOf(running), nowSeconds: NOW_SECONDS, leaseSeconds: 5,
    });
    const submittingLease = harness.real.mandateActivations.claim({
      ...identityOf(submitting), nowSeconds: NOW_SECONDS, leaseSeconds: 5,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitting), leaseToken: submittingLease.leaseToken,
      status: 'submitting', nowSeconds: NOW_SECONDS,
    });
    const submittedLease = harness.real.mandateActivations.claim({
      ...identityOf(submitted), nowSeconds: NOW_SECONDS, leaseSeconds: 5,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitted), leaseToken: submittedLease.leaseToken,
      status: 'submitting', nowSeconds: NOW_SECONDS,
    });
    harness.real.mandateActivations.checkpoint({
      ...identityOf(submitted), leaseToken: submittedLease.leaseToken,
      status: 'submitted', userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS,
    });
    expect(runningLease.status).toBe('running');
    expect(harness.real.mandateActivations.get(identityOf(pending)).status).toBe('pending');
    clock.value = NOW_SECONDS + 6;

    await harness.router.resumeMandateActivations();
    await waitForStatus(harness, running, 'active');
    await waitForStatus(harness, pending, 'active');

    expect(harness.real.mandatesV3.status(identityOf(submitting)).status)
      .toBe('activation_uncertain');
    expect(harness.real.mandatesV3.status(identityOf(submitted)).status)
      .toBe('activation_uncertain');
    expect(harness.real.mandateActivations.get(identityOf(submitting))).toMatchObject({
      status: 'uncertain', userOpHash: null,
    });
    expect(harness.real.mandateActivations.get(identityOf(submitted))).toMatchObject({
      status: 'uncertain', userOpHash: USER_OP_HASH,
    });
    expect(harness.events.filter((event) => event === 'activator:called')).toHaveLength(2);
    expect(harness.events.filter((event) => event === 'store:reconcileExpired')).toHaveLength(1);
    expect(harness.real.mandatesV3.status(identityOf(legacyBody)).status).toBe('revoked');
    expect(harness.real.mandatesV3.status(identityOf(invalidCapabilityBody)).status).toBe('revoked');
  });

  it('deduplicates concurrent restart resumes and duplicate HTTP registration', async () => {
    let releaseActivation;
    const gate = new Promise((resolve) => { releaseActivation = resolve; });
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
      wrongProcess.router(
        request({ ...body, capability: wrongCapability }),
        wrongProcessResponse,
      ),
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
    const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
    const entered = new Promise((resolve) => { enteredReceiptWait = resolve; });
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
        .filter(({ event, index }) => (
          event === 'store:renew' && index > waitingIndex && index < receiptIndex
        ));
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
});

describe('v3 mandate canonical registration validation', () => {
  it.each([
    [
      'session private key/address mismatch',
      () => registrationBody({ sessionKeyAddress: OTHER_SESSION_ADDRESS }),
    ],
    [
      'approval account/kernel mismatch',
      () =>
        registrationBody({
          kernelAddress: OTHER_KERNEL,
          serializedApproval: canonicalApproval(VALID_UNTIL_SECONDS),
        }),
    ],
    [
      'invalid Stellar owner StrKey',
      () => registrationBody({ stellarOwner: 'not-a-stellar-address' }),
    ],
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
      expect(harness.events.some((event) => event.startsWith('activator:key:')))
        .toBe(false);
      expect(res.body).not.toContain(body.capability);
      expect(res.body).not.toContain(body.serializedApproval);
      expect(res.body).not.toContain(body.sessionPrivateKey);
    },
  );
});

describe("v3 mandate route authorization and execution gates", () => {
  const SECOND_MANDATE_ID = mandateIdAt(2);
  const SECOND_CAPABILITY = capabilityAt(2);
  const WRONG_CAPABILITY = capabilityAt(99);
  const SECOND_POOL = `0x${"55".repeat(20)}`;
  const JOB_ID_RE = /^[0-9a-f]{32}$/;
  const routeJobIdAt = (index) => (0x1000 + index).toString(16).padStart(32, "0");
  const FIRST_JOB_ID = routeJobIdAt(1);
  const PRIVATE_JOB_ID = routeJobIdAt(90);
  const OWNED_JOB_ID = routeJobIdAt(91);
  const STATUS_JOB_ID = routeJobIdAt(92);
  const SECOND_STATUS_JOB_ID = routeJobIdAt(93);
  const UNKNOWN_JOB_ID = routeJobIdAt(99);
  const REVOKE_COOKIE = `__Host-vf-mandate-${MANDATE_ID}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  const ACTIVE_ROUTE_EVIDENCE = Object.freeze({
    version: 2,
    status: "active",
    reasonCodes: [],
    expected: { owner: OWNER, kernelAddress: KERNEL },
    observed: {
      blockNumber: "101",
      blockHash: `0x${"66".repeat(32)}`,
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
    return createSecretEnvelope(
      parseSecretKeyring(
        `route-tests:${Buffer.alloc(32, 19).toString("base64")}`,
      ),
    );
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

  function routeAllocations(runId = "run-42") {
    return [
      wireAllocation({
        allocationId: `${runId}:bridge:aave-v3`,
        pool: POOL_ADDRESS,
        units: 400n,
        minShares: "390",
      }),
      wireAllocation({
        allocationId: `${runId}:bridge:blend-v2`,
        pool: SECOND_POOL,
        units: 600n,
        minShares: "580",
      }),
    ];
  }

  function farmBody(body = routeBody(), overrides = {}) {
    return {
      sourceDomain: 27,
      mandateId: body.mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      bridgeAgent: "bridge-agent-1",
      runId: "run-42",
      grantTxHash: "grant-1",
      allocations: routeAllocations(),
      ...overrides,
    };
  }

  function attachBody(jobId, body = routeBody(), burnTxHash = "burn-1") {
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
    return capability === undefined
      ? {}
      : { authorization: `Bearer ${capability}` };
  }

  function protectedRequest(path, body, capability) {
    return {
      method: "POST",
      url: `/api/vf-cross${path}`,
      body,
      headers: bearer(capability),
    };
  }

  async function postProtected(harness, path, body, ...capabilityArgs) {
    const capability = capabilityArgs.length === 0
      ? CAPABILITY
      : capabilityArgs[0];
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
        events.push("binding:pure");
        return bindingHash;
      },
    };
    return Object.create(Object.getPrototypeOf(record), descriptors);
  }

  function makeFarmExecutions({
    jobs,
    associationOutbox,
    baseEvidenceOutbox,
    events,
    claimEnabled = true,
    onClaim,
  }) {
    const rows = new Map();
    const api = {
      rows,
      prepare: vi.fn(({ jobId, job, evidenceHeads }) => {
        for (const head of evidenceHeads) {
          baseEvidenceOutbox.seed(head.identity, head.recoveryVersion, { jobId });
        }
        jobs.set(jobId, job);
        return { jobId, evidenceHeads: evidenceHeads.length };
      }),
      get: vi.fn((jobId) => rows.get(jobId) ?? null),
      attach: vi.fn(({ jobId, burnTxHash, job, reports }) => {
        events.push("farm-work:attach");
        const existing = rows.get(jobId);
        if (existing) {
          if (existing.burnTxHash !== burnTxHash) {
            throw new Error(
              "farm execution already has a different burn hash",
            );
          }
          return { duplicate: true, work: existing };
        }
        associationOutbox.enqueue(reports);
        jobs.set(jobId, job);
        const work = {
          jobId,
          burnTxHash,
          status: "pending",
          attempts: 0,
          leaseToken: null,
          leaseExpiresAt: null,
        };
        rows.set(jobId, work);
        return { duplicate: false, work };
      }),
      claim: vi.fn(({ jobId }) => {
        events.push("farm-work:claim");
        if (!claimEnabled) return null;
        const work = rows.get(jobId);
        if (!work || work.status !== "pending") return null;
        onClaim?.(jobId);
        const claimed = {
          ...work,
          status: "running",
          attempts: work.attempts + 1,
          leaseToken: `route-lease:${jobId}`,
          leaseExpiresAt: Date.now() + 30_000,
        };
        rows.set(jobId, claimed);
        return claimed;
      }),
      renew: vi.fn(({ jobId, leaseToken }) => {
        const work = rows.get(jobId);
        if (!work || work.leaseToken !== leaseToken)
          throw new Error("stale farm lease");
        const renewed = { ...work, leaseExpiresAt: Date.now() + 30_000 };
        rows.set(jobId, renewed);
        return renewed;
      }),
      checkpoint: vi.fn(({ jobId, leaseToken, job, reports, baseEvidenceReports = [] }) => {
        events.push("farm-work:checkpoint");
        const work = rows.get(jobId);
        if (!work || work.leaseToken !== leaseToken)
          throw new Error("stale farm lease");
        associationOutbox.enqueue(reports);
        for (const report of baseEvidenceReports) baseEvidenceOutbox.enqueue(report);
        jobs.set(jobId, job);
        return work;
      }),
      finish: vi.fn(
        ({ jobId, leaseToken, job, reports, baseEvidenceReports = [], status = "done" }) => {
          events.push("farm-work:finish");
          const work = rows.get(jobId);
          if (!work || work.leaseToken !== leaseToken)
            throw new Error("stale farm lease");
          associationOutbox.enqueue(reports);
          for (const report of baseEvidenceReports) baseEvidenceOutbox.enqueue(report);
          jobs.set(jobId, job);
          const terminal = {
            ...work,
            status,
            leaseToken: null,
            leaseExpiresAt: null,
          };
          rows.set(jobId, terminal);
          return terminal;
        },
      ),
      listRecoverable: vi.fn(() =>
        [...rows.values()].filter(
          ({ status }) => status === "pending" || status === "running",
        ),
      ),
      reconcileUncertain: vi.fn(({ jobId, job, reports }) => {
        associationOutbox.enqueue(reports);
        jobs.set(jobId, job);
        const work = rows.get(jobId);
        const terminal = {
          ...work,
          status: "uncertain",
          leaseToken: null,
          leaseExpiresAt: null,
        };
        rows.set(jobId, terminal);
        return terminal;
      }),
    };
    return api;
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
    farmExecutions: providedFarmExecutions = null,
    claimEnabled = true,
    onClaim,
    sanitizeErrors = false,
    relayUnwindMint: providedRelayUnwindMint,
    poolTargets: providedPoolTargets = null,
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
        events.push("outbox:enqueue");
        return rows.map((report) => ({
          duplicate: false,
          status: "pending",
          report,
        }));
      }),
      status: vi.fn((identity) =>
        delivery.filter((row) => row.childId === identity.childId
          && row.executionId === identity.executionId),
      ),
    };
    const evidenceRows = [];
    const baseEvidenceOutbox = providedEvidenceOutbox ?? realStores?.baseEvidenceOutbox ?? {
      seed: vi.fn(() => ({ duplicate: false, recoveryVersion: 0 })),
      enqueue: vi.fn((checkpoint) => {
        evidenceRows.push(checkpoint);
        return { state: checkpoint.status, expectedRecoveryVersion: evidenceRows.length - 1 };
      }),
      status: vi.fn((identity) => ({
        complete: false,
        blocked: false,
        recoveryVersion: evidenceRows.filter((row) => (
          row.identity.executionId === identity.executionId
        )).length,
        events: [],
      })),
    };
    const reporter = {
      commitIntentBatch: vi.fn(async (batch) => {
        events.push("reporter:intent");
        if (reporterImplementation) return reporterImplementation(batch);
        return {
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
        };
      }),
    };
    let transformGet = transformMandateGet ?? ((record) => record);
    const mandatesV3 = {
      authority(mandateId) {
        events.push("store:get");
        return real.mandatesV3.authority(mandateId);
      },
      get(identity) {
        events.push("store:get");
        return transformGet(real.mandatesV3.get(identity), identity);
      },
      status(identity) {
        events.push("store:status");
        return real.mandatesV3.status(identity);
      },
      revoke(identity) {
        events.push("store:revoke");
        return real.mandatesV3.revoke(identity);
      },
      get size() {
        return real.mandatesV3.size;
      },
    };
    const sequence = [...evidenceSequence];
    let currentEvidence = evidence;
    const evaluator = vi.fn(async (args) => {
      events.push("evaluator:fresh");
      const selected =
        sequence.length > 0 ? sequence.shift() : currentEvidence;
      return typeof selected === "function" ? selected(args) : selected;
    });
    const farmFn = vi.fn(async (params) => {
      events.push("farm:called");
      if (farmImplementation) return farmImplementation(params);
      const mintResult = {
        status: "minted",
        mintTxHash: "0xmint",
        evidence: {
          burnTxHash: "burn-default",
          expectationDigest: "expectation-default",
          messageDigest: "message-default",
          attestationDigest: "attestation-default",
          evidenceVersion: "1",
          mintTxHash: "0xmint",
        },
      };
      await params.onMintConfirmed?.(mintResult);
      return {
        mintResult,
        depositResults: params.allocations.map((allocation) => ({
          allocationId: allocation.allocationId,
          status: "fulfilled",
          executionStatus: "deposited",
          custody: { location: "base-proxy" },
          txHash: `deposit:${allocation.allocationId}`,
        })),
        runId: params.runId,
        bridgeAgent: params.bridgeAgent,
        grantTxHash: params.grantTxHash,
      };
    });
    const buildFarm = vi.fn((sessionPrivateKey) => {
      events.push("buildFarm");
      if (buildFarmImplementation) return buildFarmImplementation(sessionPrivateKey);
      return { farm: (params) => farmFn(params) };
    });
    const farmExecutions =
      providedFarmExecutions ??
      makeFarmExecutions({
        jobs,
        associationOutbox,
        baseEvidenceOutbox,
        events,
        claimEnabled,
        onClaim,
      });
    const relayUnwindMint =
      providedRelayUnwindMint ??
      vi.fn(async () => ({
        status: "minted",
        mintTxHash: "0xreverse",
      }));
    let nextJob = 0;
    const routeHandler = createRelayerRouter({
      buildFarm,
      relayUnwindMint,
      jobs,
      mandatesV2: new Proxy(
        {},
        {
          get() {
            throw new Error(
              "v2 mandate store must not be consulted by v3 routes",
            );
          },
        },
      ),
      mandatesV3,
      mandateActivations: real.mandateActivations,
      buildMandateActivator: () => ({
        activateMandate: vi.fn(async () => {
          throw new Error("route tests must not activate a mandate");
        }),
      }),
      genId: () => routeJobIdAt(++nextJob),
      usdcAddress: CANONICAL_USDC,
      yieldRouterAddress: CANONICAL_ROUTER,
      relayerOrigin: CONFIG.publicOrigin,
      networkId: "stellar-testnet",
      publicRuntime: {
        networkId: "stellar-testnet",
        readiness: { ready: true },
        mandateStatusConfig: CONFIG,
      },
      evaluateMandateStatusFn: evaluator,
      mandateStatusConfig: CONFIG,
      nowSeconds: () => clock.value,
      poolTargets: providedPoolTargets ?? new Map([
        [POOL_ADDRESS.toLowerCase(), "aave-v3"],
        [SECOND_POOL.toLowerCase(), "blend-v2"],
      ]),
      agentIndexReporter: reporter,
      associationOutbox,
      baseEvidenceOutbox,
      farmExecutions,
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
      farmExecutions,
      relayUnwindMint,
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

  function seedActiveMandate(harness, body, bindingId = "active-binding-1") {
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
      status: "submitting",
      nowSeconds: harness.clock.value,
    });
    harness.real.mandateActivations.checkpoint({
      ...identity,
      leaseToken: claimed.leaseToken,
      status: "submitted",
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

  function seedPendingMandate(
    harness,
    body,
    bindingId = "pending-binding-1",
  ) {
    harness.real.mandateActivations.enqueue({
      record: canonicalRecord(body, bindingId),
    });
    return harness.real.mandatesV3.status(identityOf(body));
  }

  function seedUncertainMandate(
    harness,
    body,
    bindingId = "uncertain-binding-1",
  ) {
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
      status: "submitting",
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

    if (status === "activation_uncertain") {
      const claimed = stores.mandateActivations.claim({
        ...identity,
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.checkpoint({
        ...identity,
        leaseToken: claimed.leaseToken,
        status: "submitting",
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.finishUncertain({
        ...identity,
        leaseToken: claimed.leaseToken,
        nowSeconds: fenceClock.value,
      });
    } else if (status === "revoked") {
      stores.mandatesV3.revoke(identity);
    } else if (status === "expired") {
      const claimed = stores.mandateActivations.claim({
        ...identity,
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.checkpoint({
        ...identity,
        leaseToken: claimed.leaseToken,
        status: "submitting",
        nowSeconds: fenceClock.value,
      });
      stores.mandateActivations.checkpoint({
        ...identity,
        leaseToken: claimed.leaseToken,
        status: "submitted",
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
    } else if (status !== "pending_activation") {
      throw new Error(`unsupported fence fixture status: ${status}`);
    }

    const record = stores.mandatesV3.get(identity);
    if (status === "expired") {
      expect(stores.mandatesV3.status(identity).status).toBe("expired");
      expect(record?.status).toBe("active");
      expect(record?.sessionPrivateKey).toBeUndefined();
    } else {
      expect(record?.status).toBe(status);
    }
    return record;
  }

  function expectPrivateMaterialAbsent(value, body = routeBody()) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    expect(text).not.toContain(body.serializedApproval);
    expect(text).not.toContain(body.sessionPrivateKey);
    expect(text).not.toContain(body.capability);
    expect(text).not.toMatch(/sessionPrivateKey|capabilityHash|_attach/);
  }

  function expectGenericUnauthorized(res, body = routeBody()) {
    expect(res.statusCode).toBe(401);
    expect(jsonOf(res)).toEqual({ error: "unauthorized" });
    expectPrivateMaterialAbsent(res.body, body);
    expect(res.body).not.toMatch(
      /pending_activation|activation_uncertain|active-binding|private-step-sentinel|0x3333|0x4444/i,
    );
  }

  it("keeps OPTIONS/config public while advertising Authorization only at the fixed POST surface", async () => {
    const harness = makeRouteHarness();
    const options = mockRes();
    await harness.router(
      {
        method: "OPTIONS",
        url: "/api/vf-cross/farm",
        body: {},
        headers: {},
      },
      options,
    );
    expect(options.statusCode).toBe(204);
    expect(options.headers["Access-Control-Allow-Headers"]).toMatch(
      /Authorization/,
    );
    expect(options.body).toBe("");

    const config = mockRes();
    await harness.router(
      {
        method: "GET",
        url: "/api/vf-cross/config",
        headers: {},
      },
      config,
    );
    expect(config.statusCode).toBe(200);
    expect(jsonOf(config)).toMatchObject({
      networkId: "stellar-testnet",
      readiness: { ready: true },
    });
    expectPrivateMaterialAbsent(config.body);

    const unknown = mockRes();
    await harness.router(
      {
        method: "POST",
        url: "/api/vf-cross/not-a-route",
        body: {},
        headers: {},
      },
      unknown,
    );
    expect(unknown.statusCode).toBe(404);
  });

  const PROTECTED_ROUTE_CASES = [
    {
      label: "mandate status",
      path: "/mandate/status",
      body: () => statusBody(),
    },
    {
      label: "mandate revoke",
      path: "/mandate/revoke",
      body: () => statusBody(),
    },
    {
      label: "farm intent",
      path: "/farm",
      body: () => farmBody(),
    },
    {
      label: "farm attach",
      path: "/farm/attach",
      body: () => attachBody(PRIVATE_JOB_ID),
    },
    {
      label: "farm status",
      path: "/status",
      body: () => ({ mandateId: MANDATE_ID, jobId: PRIVATE_JOB_ID }),
    },
  ];
  const INVALID_AUTHORITIES = [
    ["missing bearer", undefined],
    ["wrong bearer", WRONG_CAPABILITY],
    ["another mandate bearer", SECOND_CAPABILITY],
  ];
  const INVALID_JOB_IDS = [
    ["short", "abcd"],
    ["uppercase hex", "A".repeat(32)],
    ["non-hex", "g".repeat(32)],
    ["numeric", 4097],
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
    "returns indistinguishable 401 for $routeLabel with $authorityLabel before state disclosure",
    async ({ routeCase, capability }) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const bodyA = routeBody();
      const bodyB = secondRouteBody();
      const active = seedActiveMandate(harness, bodyA);
      seedActiveMandate(harness, bodyB, "active-binding-2");
      harness.events.length = 0;
      harness.jobs.set(PRIVATE_JOB_ID, {
        status: "queued",
        steps: [{ step: "private-step-sentinel", status: "secret" }],
        runId: "run-42",
        bridgeAgent: "bridge-agent-1",
        grantTxHash: "grant-1",
        _attach: {
          mandateId: MANDATE_ID,
          stellarOwner: OWNER,
          kernelAddress: KERNEL,
          bindingId: active.bindingId,
          bindingHash: active.bindingHash,
          networkId: "stellar-testnet",
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
      const beforeMandate = harness.real.mandatesV3.status(
        routeIdentity(bodyA),
      );
      const jobGet = vi.spyOn(harness.jobs, "get");
      jobGet.mockClear();

      const { res } = await postProtected(
        harness,
        routeCase.path,
        routeCase.body(),
        capability,
      );

      expectGenericUnauthorized(res, bodyA);
      expect(jobGet).not.toHaveBeenCalled();
      jobGet.mockRestore();
      expect(JSON.stringify(harness.jobs.get(PRIVATE_JOB_ID))).toBe(
        beforeJob,
      );
      expect(harness.real.mandatesV3.status(routeIdentity(bodyA))).toEqual(
        beforeMandate,
      );
      expect(harness.evaluator).not.toHaveBeenCalled();
      expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.events).not.toContain("store:revoke");
      expect(harness.reports).toHaveLength(0);
    },
  );

  it("does not distinguish an existing and unknown attach job before bearer authorization", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    const active = seedActiveMandate(harness, body);
    harness.jobs.set(PRIVATE_JOB_ID, {
      status: "queued",
      steps: [{ step: "private-step-sentinel" }],
      _attach: {
        mandateId: MANDATE_ID,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        bindingId: active.bindingId,
        bindingHash: active.bindingHash,
      },
    });

    const existing = await postProtected(
      harness,
      "/farm/attach",
      attachBody(PRIVATE_JOB_ID),
      WRONG_CAPABILITY,
    );
    const unknown = await postProtected(
      harness,
      "/farm/attach",
      attachBody(UNKNOWN_JOB_ID),
      WRONG_CAPABILITY,
    );

    expectGenericUnauthorized(existing.res, body);
    expectGenericUnauthorized(unknown.res, body);
    expect(existing.res.body).toBe(unknown.res.body);
    expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
  });

  it.each([
    [
      "capability in JSON body",
      ({ body, jobId }) => ({
        url: "/api/vf-cross/farm/attach",
        body: { ...attachBody(jobId, body), capability: body.capability },
        headers: {},
      }),
    ],
    [
      "capability in query",
      ({ body, jobId }) => ({
        url: `/api/vf-cross/farm/attach?capability=${body.capability}`,
        body: attachBody(jobId, body),
        headers: {},
      }),
    ],
    [
      "capability in cookie",
      ({ body, jobId }) => ({
        url: "/api/vf-cross/farm/attach",
        body: attachBody(jobId, body),
        headers: {
          cookie: `__Host-vf-mandate-${body.mandateId}=${body.capability}`,
        },
      }),
    ],
    [
      "Basic authorization scheme",
      ({ body, jobId }) => ({
        url: "/api/vf-cross/farm/attach",
        body: attachBody(jobId, body),
        headers: { authorization: `Basic ${body.capability}` },
      }),
    ],
    [
      "lowercase bearer scheme",
      ({ body, jobId }) => ({
        url: "/api/vf-cross/farm/attach",
        body: attachBody(jobId, body),
        headers: { authorization: `bearer ${body.capability}` },
      }),
    ],
    [
      "Bearer header with trailing token",
      ({ body, jobId }) => ({
        url: "/api/vf-cross/farm/attach",
        body: attachBody(jobId, body),
        headers: { authorization: `Bearer ${body.capability} extra` },
      }),
    ],
  ])(
    "rejects %s as generic unauthorized before mandate or job lookup",
    async (_label, buildRequest) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      const active = seedActiveMandate(harness, body);
      harness.jobs.set(PRIVATE_JOB_ID, {
        status: "queued",
        steps: [{ step: "private-step-sentinel" }],
        _attach: {
          mandateId: body.mandateId,
          stellarOwner: body.stellarOwner,
          kernelAddress: body.kernelAddress,
          bindingId: active.bindingId,
          bindingHash: active.bindingHash,
        },
      });
      harness.events.length = 0;
      const jobGet = vi.spyOn(harness.jobs, "get");
      const candidate = buildRequest({ body, jobId: PRIVATE_JOB_ID });
      const res = mockRes();

      await harness.router(
        {
          method: "POST",
          url: candidate.url,
          body: candidate.body,
          headers: candidate.headers,
        },
        res,
      );

      expectGenericUnauthorized(res, body);
      expect(jobGet).not.toHaveBeenCalled();
      jobGet.mockRestore();
      expect(harness.events).not.toContain("store:get");
      expect(harness.evaluator).not.toHaveBeenCalled();
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(res.body).not.toContain("private-step-sentinel");
      expect(harness.requestUrls).toEqual([candidate.url]);
      if (candidate.url.includes("?")) {
        expect(candidate.url).toContain(body.capability);
        expect(res.body).not.toContain(body.capability);
      }
    },
  );

  it.each(
    ["/farm/attach", "/status"].flatMap((path) =>
      INVALID_JOB_IDS.map(([label, jobId]) => ({ path, label, jobId })),
    ),
  )(
    "rejects $label job ID on $path after capability authorization and before lookup",
    async ({ path, jobId }) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      seedActiveMandate(harness, body);
      harness.events.length = 0;
      const jobGet = vi.spyOn(harness.jobs, "get");

      const payload =
        path === "/farm/attach"
          ? attachBody(jobId, body)
          : { mandateId: body.mandateId, jobId };
      const { res } = await postProtected(harness, path, payload);

      expect(res.statusCode).toBe(400);
      expect(harness.events).toContain("store:get");
      expect(jobGet).not.toHaveBeenCalled();
      jobGet.mockRestore();
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("removes approval-bearing and identifier-bearing GET routes", async () => {
    const harness = makeRouteHarness();
    harness.jobs.set(PRIVATE_JOB_ID, {
      status: "done",
      steps: [{ step: "private-step-sentinel" }],
    });
    const oldMandate = mockRes();
    await harness.router(
      {
        method: "GET",
        url: `/api/vf-cross/mandate/valid?approval=${encodeURIComponent(canonicalApproval())}`,
        headers: {},
      },
      oldMandate,
    );
    const oldStatus = mockRes();
    await harness.router(
      {
        method: "GET",
        url: `/api/vf-cross/status/${PRIVATE_JOB_ID}`,
        headers: {},
      },
      oldStatus,
    );

    expect(oldMandate.statusCode).toBe(404);
    expect(oldStatus.statusCode).toBe(404);
    expect(oldStatus.body).not.toContain("private-step-sentinel");
  });

  it("uses only fixed identifier-free URLs across every protected successful route", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.requestUrls.length = 0;

    const mandateStatus = await postProtected(
      harness,
      "/mandate/status",
      statusBody(body),
    );
    const intent = await postProtected(harness, "/farm", farmBody(body));
    expect(intent.json.jobId).toMatch(JOB_ID_RE);
    const attach = await postProtected(
      harness,
      "/farm/attach",
      attachBody(intent.json.jobId, body, "burn-fixed-url"),
    );
    const farmStatus = await postProtected(harness, "/status", {
      mandateId: body.mandateId,
      jobId: intent.json.jobId,
    });
    const revoke = await postProtected(
      harness,
      "/mandate/revoke",
      statusBody(body),
    );

    expect([
      mandateStatus.res.statusCode,
      intent.res.statusCode,
      attach.res.statusCode,
      farmStatus.res.statusCode,
      revoke.res.statusCode,
    ]).toEqual([200, 201, 200, 200, 200]);
    expect(harness.requestUrls).toEqual([
      "/api/vf-cross/mandate/status",
      "/api/vf-cross/farm",
      "/api/vf-cross/farm/attach",
      "/api/vf-cross/status",
      "/api/vf-cross/mandate/revoke",
    ]);
    for (const url of harness.requestUrls) {
      expect(url).not.toContain("?");
      expect(url).not.toContain(body.mandateId);
      expect(url).not.toContain(intent.json.jobId);
      expect(url).not.toContain(body.capability);
      expect(url).not.toContain(body.serializedApproval);
    }
    expectPrivateMaterialAbsent(
      [mandateStatus, intent, attach, farmStatus, revoke].map(
        ({ json }) => json,
      ),
      body,
    );
  });

  it.each([
    [
      "pending_activation",
      (harness, body) => seedPendingMandate(harness, body),
    ],
    [
      "activation_uncertain",
      (harness, body) => seedUncertainMandate(harness, body),
    ],
    [
      "revoked",
      (harness, body) => {
        seedPendingMandate(harness, body, "revoked-binding-1");
        return harness.real.mandatesV3.revoke(routeIdentity(body));
      },
    ],
    [
      "expired",
      (harness, body) => {
        seedPendingMandate(harness, body, "expired-binding-1");
        harness.clock.value = body.expiresAt;
        return harness.real.mandatesV3.status(routeIdentity(body));
      },
    ],
  ])(
    "returns durable %s mandate truth without evaluating or leaking authority",
    async (expectedStatus, arrange) => {
      const clock = { value: NOW_SECONDS };
      const harness = makeRouteHarness({ clock });
      const body =
        expectedStatus === "expired"
          ? routeBody({
              expiresAt: NOW_SECONDS + 1,
              serializedApproval: canonicalApproval(NOW_SECONDS + 1),
            })
          : routeBody();
      arrange(harness, body);
      harness.events.length = 0;

      const { res, json } = await postProtected(
        harness,
        "/mandate/status",
        statusBody(body),
        body.capability,
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(json).toMatchObject({
        mandateId: body.mandateId,
        status: expectedStatus,
      });
      expect(harness.evaluator).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("freshly evaluates active mandate status amount-free and returns new revoked evidence instead of cached active truth", async () => {
    const revokedEvidence = {
      ...ACTIVE_ROUTE_EVIDENCE,
      status: "revoked",
      reasonCodes: ["PERMISSION_REVOKED"],
      checks: { ...ACTIVE_ROUTE_EVIDENCE.checks, permissionInstalled: false },
    };
    const harness = makeRouteHarness({
      evidenceSequence: [ACTIVE_ROUTE_EVIDENCE, revokedEvidence],
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.events.length = 0;

    const active = await postProtected(
      harness,
      "/mandate/status",
      statusBody(body),
    );
    const revoked = await postProtected(
      harness,
      "/mandate/status",
      statusBody(body),
    );

    expect(active.res.statusCode).toBe(200);
    expect(active.json).toEqual(ACTIVE_ROUTE_EVIDENCE);
    expect(revoked.res.statusCode).toBe(200);
    expect(revoked.json).toEqual(revokedEvidence);
    expect(harness.evaluator).toHaveBeenCalledTimes(2);
    for (const [args] of harness.evaluator.mock.calls) {
      expect(args).toMatchObject({ config: CONFIG });
      expect(args).not.toHaveProperty("allocation");
    }
    expectPrivateMaterialAbsent(active.res.body, body);
    expectPrivateMaterialAbsent(revoked.res.body, body);

    const extra = await postProtected(harness, "/mandate/status", {
      ...statusBody(body),
      allocation: wireAllocation(),
    });
    expect(extra.res.statusCode).toBe(400);
    expect(harness.evaluator).toHaveBeenCalledTimes(2);
  });

  it("maps active evaluator failure to no-store unknown without exposing internal diagnostics", async () => {
    const harness = makeRouteHarness({
      evidence: () => {
        throw new Error(`rpc https://private.example/${SESSION_KEY}`);
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);

    const { res, json } = await postProtected(
      harness,
      "/mandate/status",
      statusBody(body),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(json).toMatchObject({
      status: "unknown",
      reasonCodes: ["STATUS_ERROR"],
    });
    expectPrivateMaterialAbsent(res.body, body);
    expect(res.body).not.toContain("private.example");
  });

  it("revokes to a capability-retaining keyless tombstone and clears the exact __Host cookie idempotently", async () => {
    const harness = makeRouteHarness();
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.jobs.set(OWNED_JOB_ID, {
      status: "queued",
      steps: [],
      _attach: { mandateId: MANDATE_ID },
    });

    const first = await postProtected(
      harness,
      "/mandate/revoke",
      statusBody(body),
    );
    expect(first.res.statusCode).toBe(200);
    expect(first.json).toMatchObject({
      ok: true,
      status: "revoked",
      scope: "relayer-key-copy",
    });
    expect(typeof first.json.note).toBe("string");
    expect(first.res.headers["Set-Cookie"]).toBe(REVOKE_COOKIE);
    expectPrivateMaterialAbsent(first.res.body, body);

    const internal = harness.real.mandatesV3.get(routeIdentity(body));
    expect(internal.status).toBe("revoked");
    expect(internal.sessionPrivateKey).toBeUndefined();
    expect(internal.capabilityHash).toBe(sha256(CAPABILITY));
    expect(Object.keys(internal)).not.toContain("capabilityHash");
    expect(
      harness.real.mandateActivations.get(routeIdentity(body)),
    ).toBeNull();

    const second = await postProtected(
      harness,
      "/mandate/revoke",
      statusBody(body),
    );
    expect(second.res.statusCode).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(second.res.headers["Set-Cookie"]).toBe(REVOKE_COOKIE);
    expect(
      harness.real.mandatesV3.get(routeIdentity(body)).sessionPrivateKey,
    ).toBeUndefined();

    const deniedFarm = await postProtected(harness, "/farm", farmBody(body));
    const deniedStatus = await postProtected(harness, "/status", {
      mandateId: MANDATE_ID,
      jobId: OWNED_JOB_ID,
    });
    expectGenericUnauthorized(deniedFarm.res, body);
    expectGenericUnauthorized(deniedStatus.res, body);
    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it("orders pure binding, one amount-free fresh read, durable child acknowledgements, then private job persistence", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    const active = seedActiveMandate(harness, body);
    harness.events.length = 0;

    const { res, json } = await postProtected(
      harness,
      "/farm",
      farmBody(body),
    );

    expect(res.statusCode).toBe(201);
    expect(json).toEqual({
      jobId: FIRST_JOB_ID,
      acknowledged: true,
      schemaVersion: 1,
    });
    expect(harness.evaluator).toHaveBeenCalledTimes(1);
    expect(harness.evaluator.mock.calls[0][0]).not.toHaveProperty(
      "allocation",
    );
    expect(harness.reporter.commitIntentBatch).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).not.toHaveBeenCalled();
    const freshIndex = harness.events.indexOf("evaluator:fresh");
    const reportIndex = harness.events.indexOf("reporter:intent");
    expect(harness.events.slice(0, freshIndex)).toContain("store:get");
    expect(reportIndex).toBeGreaterThan(freshIndex);

    const job = harness.jobs.get(json.jobId);
    expect(job).toMatchObject({
      status: "queued",
      runId: "run-42",
      bridgeAgent: "bridge-agent-1",
      grantTxHash: "grant-1",
      _attach: {
        mandateId: MANDATE_ID,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        bindingId: active.bindingId,
        bindingHash: active.bindingHash,
        attachedBurnTxHash: null,
        associations: [
          { allocationId: "run-42:bridge:aave-v3", terminalSequence: null },
          { allocationId: "run-42:bridge:blend-v2", terminalSequence: null },
        ],
      },
    });
    expect(job._attach).not.toHaveProperty("serializedApproval");
    expectPrivateMaterialAbsent(res.body, body);
    expect(JSON.stringify(job)).not.toContain(body.serializedApproval);
    expect(JSON.stringify(job)).not.toContain(body.sessionPrivateKey);
    expect(JSON.stringify(job)).not.toContain(body.capability);
    expect(harness.requestUrls).toEqual(["/api/vf-cross/farm"]);
    expect(harness.requestUrls[0]).not.toContain("?");

    const [intentBatch] = harness.reporter.commitIntentBatch.mock.calls[0];
    expect(intentBatch).toMatchObject({ burnUnits7: '10000' });
    for (const intent of intentBatch.children) {
      expect(intent).toMatchObject({
        networkId: "stellar-testnet",
        owner: OWNER,
        agent: "bridge-agent-1",
        bindingId: active.bindingId,
        childId: json.jobId,
        lifecycle: { sequence: 0, status: "planned" },
        intent: {
          runId: "run-42",
          grantTxHash: "grant-1",
          kernelAddress: KERNEL,
          bindingHash: active.bindingHash,
        },
      });
      expectPrivateMaterialAbsent(intent, body);
    }
  });

  it("does not persist or acknowledge a farm job until every immutable child intent is durable", async () => {
    let acknowledge;
    const harness = makeRouteHarness({
      claimEnabled: false,
      reporterImplementation: (batch) =>
        new Promise((resolve) => {
          acknowledge = () =>
            resolve({
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
            });
        }),
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const request = farmBody(body, { allocations: [routeAllocations()[0]] });
    const res = mockRes();
    const pending = harness.router(
      protectedRequest("/farm", request, CAPABILITY),
      res,
    );

    await vi.waitFor(() =>
      expect(harness.reporter.commitIntentBatch).toHaveBeenCalledTimes(1),
    );
    expect(harness.jobs.get(FIRST_JOB_ID)).toBeUndefined();
    expect(res.body).toBe("");
    expect(harness.buildFarm).not.toHaveBeenCalled();

    acknowledge();
    await pending;
    expect(res.statusCode).toBe(201);
    expect(harness.jobs.get(FIRST_JOB_ID)).toMatchObject({
      status: "queued",
    });
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it("seeds each local evidence head from the exact ordered Agent Index recovery version", async () => {
    const allocations = routeAllocations();
    const harness = makeRouteHarness({
      claimEnabled: false,
      reporterImplementation: async (batch) => ({
        acknowledged: true,
        schemaVersion: 1,
        children: batch.children.map((child, ordinal) => ({
          identity: {
            networkId: child.networkId,
            bindingId: child.bindingId,
            executionId: child.executionId,
            allocationId: child.allocationId,
            childId: child.childId,
          },
          recoveryVersion: 7 + ordinal,
        })),
      }),
    });
    const body = routeBody();
    seedActiveMandate(harness, body);

    const jobId = await queueIntent(harness, body, { allocations });

    expect(harness.jobs.get(jobId)._attach.associations.map((entry) => (
      entry.startingRecoveryVersion
    ))).toEqual([7, 8]);
    expect(harness.evidenceRows).toEqual([]);
  });

  it.each([
    [
      "reporter authentication failure",
      new Error("HTTP 401 reporter secret"),
    ],
    ["reporter timeout", new Error("private D1 timeout")],
    ["reporter schema failure", new Error("schema mismatch")],
  ])(
    "fails closed on %s without a job, burn acknowledgement, or private diagnostic",
    async (_label, failure) => {
      const harness = makeRouteHarness({
        claimEnabled: false,
        reporterImplementation: async () => {
          throw failure;
        },
      });
      const body = routeBody();
      seedActiveMandate(harness, body);

      const { res, json } = await postProtected(
        harness,
        "/farm",
        farmBody(body, { allocations: [routeAllocations()[0]] }),
      );

      expect(res.statusCode).toBe(503);
      expect(json).toEqual({ error: "Base child intent is unavailable" });
      expect(harness.jobs.get(FIRST_JOB_ID)).toBeUndefined();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(res.body).not.toContain(failure.message);
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("fails the intent gate on corrupted immutable binding before fresh evidence, reporting, job creation, or key use", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    seedActiveMandate(harness, body);
    harness.setTransformMandateGet((record) =>
      preserveInternalRecord(record, {
        bindingHash: "ff".repeat(32),
      }),
    );
    harness.events.length = 0;

    const { res } = await postProtected(harness, "/farm", farmBody(body));

    expect(res.statusCode).toBe(409);
    expect(harness.events).toContain("store:get");
    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
    expect(harness.jobs.get(FIRST_JOB_ID)).toBeUndefined();
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
    expectPrivateMaterialAbsent(res.body, body);
  });

  it.each([
    ["revoked", ["PERMISSION_REVOKED"]],
    ["unknown", ["RPC_ERROR"]],
  ])(
    "fails the fresh %s intent gate before reporter/job/burn acknowledgement",
    async (status, reasonCodes) => {
      const harness = makeRouteHarness({
        claimEnabled: false,
        evidence: { ...ACTIVE_ROUTE_EVIDENCE, status, reasonCodes },
      });
      const body = routeBody();
      seedActiveMandate(harness, body);

      const { res } = await postProtected(harness, "/farm", farmBody(body));

      expect(res.statusCode).toBe(409);
      expect(harness.evaluator).toHaveBeenCalledTimes(1);
      expect(harness.evaluator.mock.calls[0][0]).not.toHaveProperty(
        "allocation",
      );
      expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
      expect(harness.jobs.get(FIRST_JOB_ID)).toBeUndefined();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("reloads local authority after intent evidence so a concurrent relayer revoke cannot create a burnable job", async () => {
    let harness;
    const body = routeBody();
    harness = makeRouteHarness({
      evidence: () => {
        harness.events.push("test:revoke-during-intent-evidence");
        harness.real.mandatesV3.revoke(routeIdentity(body));
        return ACTIVE_ROUTE_EVIDENCE;
      },
      claimEnabled: false,
    });
    seedActiveMandate(harness, body);
    harness.events.length = 0;

    const { res } = await postProtected(harness, "/farm", farmBody(body));

    expect(res.statusCode).toBe(409);
    expect(harness.evaluator).toHaveBeenCalledTimes(1);
    const revokeIndex = harness.events.indexOf(
      "test:revoke-during-intent-evidence",
    );
    expect(revokeIndex).toBeGreaterThan(
      harness.events.indexOf("evaluator:fresh"),
    );
    expect(harness.events.indexOf("store:get", revokeIndex + 1)).toBeGreaterThan(
      revokeIndex,
    );
    expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
    expect(harness.jobs.get(FIRST_JOB_ID)).toBeUndefined();
    expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it("dispatches two ordered allocations with the stored key and emits complete sequence 1/2/3 lifecycle evidence", async () => {
    const allocations = [...routeAllocations()].reverse();
    const harness = makeRouteHarness({
      farmImplementation: async (params) => {
        await params.onMintConfirmed(mintedResult("0xmint-two-allocations"));
        return {
          mintResult: mintedResult("0xmint-two-allocations"),
          depositResults: params.allocations.map((allocation, index) => ({
            allocationId: allocation.allocationId,
            status: "fulfilled",
            executionStatus: "deposited",
            custody: { location: "base-proxy" },
            txHash: `0xdeposit-${index + 1}`,
          })),
          runId: params.runId,
          bridgeAgent: params.bridgeAgent,
          grantTxHash: params.grantTxHash,
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, { allocations });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-two-allocations"),
    );
    expect(attached.res.statusCode).toBe(200);
    await flushMicrotasks(50);

    expect(harness.buildFarm).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).toHaveBeenCalledWith(SESSION_KEY);
    expect(harness.farmFn).toHaveBeenCalledTimes(1);
    const dispatch = harness.farmFn.mock.calls[0][0];
    expect(dispatch).toMatchObject({
      burnTxHash: "burn-two-allocations",
      execId: "burn-two-allocations",
      approval: body.serializedApproval,
      runId: "run-42",
      bridgeAgent: "bridge-agent-1",
      grantTxHash: "grant-1",
      onMintConfirmed: expect.any(Function),
    });
    expect(dispatch.allocations).toMatchObject([
      {
        allocationId: "run-42:bridge:blend-v2",
        pool: SECOND_POOL,
        amount: 600n,
        minShares: 580n,
        reportAmount: { token: "USDC", units: "600", decimals: 6 },
        proxyTarget: "blend-v2",
      },
      {
        allocationId: "run-42:bridge:aave-v3",
        pool: POOL_ADDRESS,
        amount: 400n,
        minShares: 390n,
        reportAmount: { token: "USDC", units: "400", decimals: 6 },
        proxyTarget: "aave-v3",
      },
    ]);
    expect(dispatch).not.toHaveProperty("allocation");

    expect(harness.jobs.get(jobId)).toMatchObject({
      status: "done",
      runId: "run-42",
      bridgeAgent: "bridge-agent-1",
      grantTxHash: "grant-1",
      _attach: {
        associations: [
          {
            allocationId: "run-42:bridge:blend-v2",
            terminalSequence: 3,
          },
          {
            allocationId: "run-42:bridge:aave-v3",
            terminalSequence: 3,
          },
        ],
      },
    });
    for (const allocation of allocations) {
      const lifecycle = harness.reports.filter(
        (report) => report.identity.allocationId === allocation.allocationId,
      );
      expect(lifecycle.map(({ expectedSequence }) => expectedSequence)).toEqual([
        0,
        1,
        2,
      ]);
      expect(lifecycle.map(({ lifecycle: event }) => event.sequence)).toEqual([
        1,
        2,
        3,
      ]);
      expect(lifecycle.at(-1)).toMatchObject({
        lifecycle: {
          sequence: 3,
          status: "confirmed",
          evidence: {
            executionStatus: "deposited",
            custodyLocation: "base-proxy",
            txHash: expect.stringMatching(/^0xdeposit-/),
          },
        },
      });
    }
    expect(JSON.stringify(harness.jobs.get(jobId))).not.toContain(SESSION_KEY);
    expect(JSON.stringify(harness.reports)).not.toContain(SESSION_KEY);
  });

  it('atomically persists ordered shared CCTP evidence and each Base checkpoint before the next external boundary', async () => {
    const order = [];
    let harness;
    harness = makeRouteHarness({
      farmImplementation: async ({ allocations, onMintConfirmed, onDepositCheckpoint }) => {
        const allocation = allocations[0];
        await onMintConfirmed(mintedResult('0xmint-evidence-order'));
        order.push('mint-persisted');
        await onDepositCheckpoint({
          identity: {
            networkId: 'stellar-testnet', bindingId: 'active-binding-1',
            executionId: `run-42:exec:${allocation.allocationId}`,
            allocationId: allocation.allocationId, childId: FIRST_JOB_ID,
          },
          phase: 'base_deposit', status: 'submitting', observedAt: 2_000_000_000_000,
          evidence: {
            chainId: '84532', yieldRouterAddress: CANONICAL_ROUTER.toLowerCase(),
            caller: KERNEL.toLowerCase(), poolAddress: allocation.pool.toLowerCase(),
            assets: allocation.amount.toString(), minShares: allocation.minShares.toString(),
          },
        });
        expect(harness.evidenceRows.map(({ phase }) => phase)).toEqual([
          'cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit',
        ]);
        order.push('send');
        return {
          mintResult: mintedResult('0xmint-evidence-order'),
          depositResults: [{
            identity: harness.evidenceRows.at(-1).identity,
            allocationId: allocation.allocationId,
            status: 'rejected', executionStatus: 'unknown', custody: { location: 'agent' },
            userOpHash: null, transactionHash: null, txHash: null,
          }],
          runId: 'run-42', bridgeAgent: 'bridge-agent-1', grantTxHash: 'grant-1',
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, { allocations: [routeAllocations()[0]] });
    await postProtected(harness, '/farm/attach', attachBody(jobId, body, 'burn-evidence-order'));
    await vi.waitFor(() => expect(harness.jobs.get(jobId)?.status).toBe('uncertain'));
    expect(harness.farmExecutions.get(jobId)).toMatchObject({ status: 'uncertain' });
    expect(order).toEqual(['mint-persisted', 'send']);
    expect(harness.jobs.get(jobId).depositProgress).toMatchObject({
      'run-42:bridge:aave-v3': { state: 'submitting' },
    });
  });

  it("emits an explicit unknown terminal sequence for an expected allocation missing from orchestrator results", async () => {
    const allocations = routeAllocations();
    const harness = makeRouteHarness({
      farmImplementation: async (params) => {
        await params.onMintConfirmed(mintedResult("0xmint-missing-result"));
        return {
          mintResult: mintedResult("0xmint-missing-result"),
          depositResults: [
            {
              allocationId: allocations[0].allocationId,
              status: "fulfilled",
              executionStatus: "deposited",
              custody: { location: "base-proxy" },
              txHash: "0xdeposit-present",
            },
          ],
          runId: params.runId,
          bridgeAgent: params.bridgeAgent,
          grantTxHash: params.grantTxHash,
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, { allocations });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-missing-result"),
    );
    expect(attached.res.statusCode).toBe(200);
    await flushMicrotasks(50);

    const terminal = harness.reports.filter(
      ({ lifecycle }) => lifecycle.sequence === 3,
    );
    expect(terminal).toHaveLength(2);
    expect(
      terminal.find(
        ({ identity }) =>
          identity.allocationId === "run-42:bridge:blend-v2",
      ),
    ).toMatchObject({
      expectedSequence: 2,
      lifecycle: {
        sequence: 3,
        status: "unknown",
        evidence: {
          executionStatus: "unknown",
          custodyLocation: "unknown",
          txHash: null,
        },
      },
    });
    expect(harness.jobs.get(jobId)?._attach.associations).toMatchObject([
      {
        allocationId: "run-42:bridge:aave-v3",
        terminalSequence: 3,
      },
      {
        allocationId: "run-42:bridge:blend-v2",
        terminalSequence: 3,
      },
    ]);
    expect(harness.jobs.get(jobId)).toMatchObject({ status: 'uncertain' });
    expect(harness.farmExecutions.get(jobId)).toMatchObject({ status: 'uncertain' });
  });

  it("surfaces a terminal lifecycle outbox failure as association uncertainty instead of complete success", async () => {
    const acceptedReports = [];
    const associationOutbox = {
      enqueue: vi.fn((input) => {
        const rows = Array.isArray(input) ? input : [input];
        if (rows.some(({ lifecycle }) => lifecycle.sequence === 3)) {
          throw new Error("terminal outbox transaction failed");
        }
        acceptedReports.push(...rows);
        return rows.map((report) => ({
          duplicate: false,
          status: "pending",
          report,
        }));
      }),
      status: vi.fn(() => []),
    };
    const harness = makeRouteHarness({ associationOutbox });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-terminal-outbox"),
    );
    expect(attached.res.statusCode).toBe(200);
    await flushMicrotasks(50);

    expect(acceptedReports.map(({ lifecycle }) => lifecycle.sequence)).toEqual([
      1,
      2,
    ]);
    expect(harness.jobs.get(jobId)).toMatchObject({
      status: "error",
      associationUncertain: true,
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "association-persistence",
          status: "error",
          message: "terminal outbox transaction failed",
        }),
      ]),
    });
    expect(harness.farmExecutions.get(jobId)).toMatchObject({
      status: "running",
      attempts: 1,
    });
    const status = await postProtected(harness, "/status", {
      mandateId: body.mandateId,
      jobId,
    });
    expect(status.res.statusCode).toBe(200);
    expect(status.json.associationDelivery).toMatchObject({
      complete: false,
      uncertain: true,
    });
    expect(status.json).not.toHaveProperty("associationUncertain");
  });

  it.each([
    [
      "missing Stellar source domain",
      ({ sourceDomain: _sourceDomain, ...request }) => request,
    ],
    [
      "non-Stellar source domain",
      (request) => ({ ...request, sourceDomain: 6 }),
    ],
    [
      "string Stellar source domain",
      (request) => ({ ...request, sourceDomain: "27" }),
    ],
    [
      "burn hash on intent route",
      (request) => ({ ...request, burnTxHash: "already-burned" }),
    ],
    [
      "unknown top-level field",
      (request) => ({ ...request, serializedApproval: canonicalApproval() }),
    ],
    [
      "missing bridgeAgent association",
      (request) => ({ ...request, bridgeAgent: null }),
    ],
    [
      "missing runId association",
      (request) => ({ ...request, runId: null }),
    ],
    [
      "missing grantTxHash association",
      (request) => ({ ...request, grantTxHash: null }),
    ],
    [
      "missing allocation identity",
      (request) => ({
        ...request,
        allocations: [
          { ...request.allocations[0], allocationId: undefined },
        ],
      }),
    ],
    [
      "duplicate allocation identity",
      (request) => ({
        ...request,
        allocations: [request.allocations[0], { ...request.allocations[0] }],
      }),
    ],
    [
      "cross-run allocation identity",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            allocationId: "other-run:bridge:aave-v3",
          },
        ],
      }),
    ],
    [
      "allocation identity proxy suffix does not match its pool",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            allocationId: "run-42:bridge:blend-v2",
            poolAddress: POOL_ADDRESS,
          },
        ],
      }),
    ],
    [
      "unallowlisted pool",
      (request) => ({
        ...request,
        allocations: [
          { ...request.allocations[0], poolAddress: `0x${"77".repeat(20)}` },
        ],
      }),
    ],
    [
      "noncanonical amount",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: "1.5" },
          },
        ],
      }),
    ],
    [
      "zero amount units",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: "0" },
          },
        ],
      }),
    ],
    [
      "negative amount units",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: "-1" },
          },
        ],
      }),
    ],
    [
      "numeric amount units",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: 12 },
          },
        ],
      }),
    ],
    [
      "boolean amount units",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: true },
          },
        ],
      }),
    ],
    [
      "exponent amount units",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: "1e6" },
          },
        ],
      }),
    ],
    [
      "whitespace amount units",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: { ...request.allocations[0].amount, units: " 12 " },
          },
        ],
      }),
    ],
    [
      "noncanonical minShares",
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: "-1" }],
      }),
    ],
    [
      "numeric minShares",
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: 12 }],
      }),
    ],
    [
      "boolean minShares",
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: true }],
      }),
    ],
    [
      "exponent minShares",
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: "1e6" }],
      }),
    ],
    [
      "whitespace minShares",
      (request) => ({
        ...request,
        allocations: [{ ...request.allocations[0], minShares: " 12 " }],
      }),
    ],
    [
      "per-call cap exceeded",
      (request) => ({
        ...request,
        allocations: [
          {
            ...request.allocations[0],
            amount: {
              ...request.allocations[0].amount,
              units: (MAX_CALL_CAP_UNITS + 1n).toString(),
            },
          },
        ],
      }),
    ],
  ])(
    "rejects %s before reporter, job persistence, attachment, or execution",
    async (_label, mutate) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      seedActiveMandate(harness, body);

      const { res } = await postProtected(
        harness,
        "/farm",
        mutate(farmBody(body, { allocations: [routeAllocations()[0]] })),
      );

      expect(res.statusCode).toBe(400);
      // Malformed bodies are still behind the mandate capability boundary. A legacy handler
      // that rejects its old field shape before authenticating would otherwise make these
      // tests pass for the wrong reason.
      expect(harness.events).toContain("store:get");
      expect(harness.reporter.commitIntentBatch).not.toHaveBeenCalled();
      expect(harness.jobs.get(FIRST_JOB_ID)).toBeUndefined();
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("keeps the disclosed cap per-call and non-cumulative while evaluating authority only once", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const allocations = routeAllocations().map((allocation) => ({
      ...allocation,
      amount: { ...allocation.amount, units: MAX_CALL_CAP_UNITS.toString() },
    }));

    const { res } = await postProtected(
      harness,
      "/farm",
      farmBody(body, { allocations }),
    );

    expect(res.statusCode).toBe(201);
    expect(harness.evaluator).toHaveBeenCalledTimes(1);
    expect(harness.reporter.commitIntentBatch).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it("accepts canonical zero minShares without weakening positive amount validation", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const allocation = {
      ...routeAllocations()[0],
      minShares: "0",
    };

    const { res, json } = await postProtected(
      harness,
      "/farm",
      farmBody(body, { allocations: [allocation] }),
    );

    expect(res.statusCode).toBe(201);
    expect(json.jobId).toMatch(JOB_ID_RE);
    expect(harness.reporter.commitIntentBatch).toHaveBeenCalledTimes(1);
    expect(harness.jobs.get(json.jobId)?._attach.allocations).toEqual([
      allocation,
    ]);
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  async function queueIntent(harness, body = routeBody(), overrides = {}) {
    const response = await postProtected(
      harness,
      "/farm",
      farmBody(body, overrides),
      body.capability,
    );
    expect(response.res.statusCode).toBe(201);
    expect(response.json.jobId).toMatch(JOB_ID_RE);
    return response.json.jobId;
  }

  it("joins durable child identity and immutable caller before the real farm orchestrator sends", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-route-real-orchestrator-")),
      "relayer.db",
    );
    const stores = createSqliteStores(path, {
      sessionKeyCipher: routeCipher(),
      nowSeconds: () => NOW_SECONDS,
    });
    let jobId;
    const allocation = routeAllocations()[0];
    const transactionHash = `0x${"ab".repeat(32)}`;
    const userOpHash = `0x${"cd".repeat(32)}`;
    const word = (value) => BigInt(value).toString(16).padStart(64, "0");
    const kernelClient = {
      account: {
        address: KERNEL,
        encodeCalls: vi.fn().mockResolvedValue("0xencoded"),
      },
      sendUserOperation: vi.fn(async () => {
        const association = stores.jobs.get(jobId)._attach.associations[0];
        expect(stores.baseEvidenceOutbox.status(association.recoveryIdentity)).toMatchObject({
          recoveryVersion: 4,
          events: expect.arrayContaining([
            expect.objectContaining({ phase: "base_deposit", state: "submitting" }),
          ]),
        });
        return userOpHash;
      }),
      waitForUserOperationReceipt: vi.fn(async () => ({
        userOpHash,
        sender: KERNEL,
        success: true,
        logs: [{
          address: CANONICAL_ROUTER,
          topics: [
            DEPOSITED_TOPIC0,
            `0x${KERNEL.slice(2).padStart(64, "0")}`,
            `0x${allocation.poolAddress.slice(2).padStart(64, "0")}`,
          ],
          data: `0x${word(allocation.amount.units)}${word(allocation.minShares)}`,
          logIndex: 1,
          transactionHash,
        }],
        receipt: { status: "success", transactionHash, logs: [] },
      })),
    };
    const watcher = {
      relayMint: vi.fn(async () => mintedResult("0xmint-real-path")),
      getRecoveryEvidence: vi.fn(() => mintedResult("0xmint-real-path").evidence),
    };
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      associationOutbox: stores.associationOutbox,
      baseEvidenceOutbox: stores.baseEvidenceOutbox,
      farmExecutions: stores.farmExecutions,
      buildFarmImplementation: (sessionPrivateKey) => {
        const flow = createFarmFlow({
          watcher,
          orchestrator: createOrchestrator({
          chain: { id: 84532 },
          rpcUrl: "https://base.invalid",
          bundlerRpcUrl: "https://bundler.invalid",
          yieldRouterAddress: CANONICAL_ROUTER,
          usdcAddress: CANONICAL_USDC,
          sessionPrivateKey,
          reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
          now: () => 2_000_000_000_000,
          }),
          domains: { stellar: 27, base: 6 },
        });
        return {
          farm: (params) => flow.farm({
            ...params,
            // Task 11 owns persisting/wiring this pre-D1 expectation. This test isolates the
            // Task 10 post-mint production seam while still exercising the real farm flow.
            expectation: { testOnlyStableBurnIntent: true },
          }),
        };
      },
    });
    const body = routeBody();
    try {
      seedActiveMandate(harness, body);
      jobId = await queueIntent(harness, body, { allocations: [allocation] });
      const attached = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-real-path"),
      );
      expect(attached.res.statusCode).toBe(200);
      await flushMicrotasks(50);
      expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1);
      expect(stores.farmExecutions.get(jobId)).toMatchObject({ status: "done" });
    } finally {
      stores.db.close();
    }
  });

  it.each([
    [
      "mandate revoke",
      "/mandate/revoke",
      (_jobId, body) => ({ ...statusBody(body), extra: "rejected" }),
    ],
    [
      "farm attach",
      "/farm/attach",
      (jobId, body) => ({
        ...attachBody(jobId, body, "burn-extra-field"),
        extra: "rejected",
      }),
    ],
    [
      "farm status",
      "/status",
      (jobId, body) => ({
        mandateId: body.mandateId,
        jobId,
        extra: "rejected",
      }),
    ],
  ])(
    "rejects extra fields on %s only after valid capability authorization",
    async (_label, path, payloadFor) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      seedActiveMandate(harness, body);
      const jobId = await queueIntent(harness, body, {
        allocations: [routeAllocations()[0]],
      });
      const beforeJob = JSON.stringify(harness.jobs.get(jobId));
      harness.events.length = 0;

      const { res } = await postProtected(
        harness,
        path,
        payloadFor(jobId, body),
      );

      expect(res.statusCode).toBe(400);
      expect(harness.events).toContain("store:get");
      expect(harness.events).not.toContain("store:revoke");
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.jobs.get(jobId))).toBe(beforeJob);
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it.each([
    ["empty burn hash", ""],
    ["numeric burn hash", 1234],
    ["boolean burn hash", true],
    ["object burn hash", { hash: "burn-1" }],
    ["array burn hash", ["burn-1"]],
  ])(
    "rejects %s after authorization but before durable attachment",
    async (_label, burnTxHash) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      seedActiveMandate(harness, body);
      const jobId = await queueIntent(harness, body, {
        allocations: [routeAllocations()[0]],
      });
      harness.events.length = 0;

      const { res } = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, burnTxHash),
      );

      expect(res.statusCode).toBe(400);
      expect(harness.events).toContain("store:get");
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(harness.jobs.get(jobId)?._attach.attachedBurnTxHash).toBeNull();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("revalidates pure and fresh authority before durable attach and reauthorizes an idempotent same-burn retry", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body);
    harness.evaluator.mockClear();
    harness.events.length = 0;

    const first = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-observed"),
    );

    expect(first.res.statusCode).toBe(200);
    expect(first.json).toEqual({ jobId, attached: true, status: "pending" });
    expect(harness.evaluator).toHaveBeenCalledTimes(1);
    expect(harness.evaluator.mock.calls[0][0]).not.toHaveProperty(
      "allocation",
    );
    expect(harness.farmExecutions.attach).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expect(harness.events.indexOf("store:get")).toBeLessThan(
      harness.events.indexOf("evaluator:fresh"),
    );
    expect(harness.events.indexOf("evaluator:fresh")).toBeLessThan(
      harness.events.indexOf("farm-work:attach"),
    );
    expect(harness.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expectedSequence: 0,
          lifecycle: {
            sequence: 1,
            status: "submitted",
            evidence: {
              executionStatus: "accepted",
              custodyLocation: "in-transit",
              txHash: "burn-observed",
            },
            observedAt: expect.any(Number),
          },
        }),
      ]),
    );
    const repeated = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-observed"),
    );
    expect(repeated.res.statusCode).toBe(200);
    expect(repeated.json).toEqual(first.json);
    expect(harness.evaluator).toHaveBeenCalledTimes(2);
    expect(harness.farmExecutions.attach).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).not.toHaveBeenCalled();

    const conflict = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "different-burn"),
    );
    expect(conflict.res.statusCode).toBe(409);
    expect(harness.farmExecutions.attach).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expectPrivateMaterialAbsent(first.res.body, body);
    expectPrivateMaterialAbsent(repeated.res.body, body);
    expectPrivateMaterialAbsent(conflict.res.body, body);
  });

  it.each([
    [
      "corrupted stored binding",
      (harness) => {
        harness.setTransformMandateGet((record) =>
          preserveInternalRecord(record, {
            bindingHash: "ee".repeat(32),
          }),
        );
        return 0;
      },
    ],
    [
      "fresh revoked permission",
      (harness) => {
        harness.setEvidence({
          ...ACTIVE_ROUTE_EVIDENCE,
          status: "revoked",
          reasonCodes: ["PERMISSION_REVOKED"],
        });
        return 1;
      },
    ],
    [
      "fresh unknown permission",
      (harness) => {
        harness.setEvidence({
          ...ACTIVE_ROUTE_EVIDENCE,
          status: "unknown",
          reasonCodes: ["RPC_ERROR"],
        });
        return 1;
      },
    ],
  ])(
    "fails attach on %s without mutation, lifecycle acknowledgement, work, or key reconstruction",
    async (_label, arrange) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      seedActiveMandate(harness, body);
      const jobId = await queueIntent(harness, body);
      harness.evaluator.mockClear();
      harness.events.length = 0;
      harness.reports.length = 0;
      const expectedEvaluations = arrange(harness);
      const before = JSON.stringify(harness.jobs.get(jobId));

      const { res } = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-denied"),
      );

      expect(res.statusCode).toBe(409);
      expect(harness.evaluator).toHaveBeenCalledTimes(expectedEvaluations);
      expect(JSON.stringify(harness.jobs.get(jobId))).toBe(before);
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.farmExecutions.get(jobId)).toBeNull();
      expect(harness.reports).toHaveLength(0);
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it("reloads local authority after attach evidence so a concurrent relayer revoke cannot acknowledge the burn", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body);
    harness.setEvidence(() => {
      harness.events.push("test:revoke-during-attach-evidence");
      harness.real.mandatesV3.revoke(routeIdentity(body));
      return ACTIVE_ROUTE_EVIDENCE;
    });
    harness.events.length = 0;

    const { res } = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-revoked-during-attach"),
    );

    expect(res.statusCode).toBe(409);
    expect(harness.evaluator).toHaveBeenCalledTimes(2);
    const revokeIndex = harness.events.indexOf(
      "test:revoke-during-attach-evidence",
    );
    expect(revokeIndex).toBeGreaterThan(
      harness.events.indexOf("evaluator:fresh"),
    );
    expect(harness.events.indexOf("store:get", revokeIndex + 1)).toBeGreaterThan(
      revokeIndex,
    );
    expect(harness.jobs.get(jobId)).toMatchObject({ status: "queued" });
    expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
    expect(harness.farmExecutions.get(jobId)).toBeNull();
    expect(harness.reports).toHaveLength(0);
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it.each([
    ["mandateId", SECOND_MANDATE_ID],
    [
      "stellarOwner",
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey(),
    ],
    ["kernelAddress", `0x${"88".repeat(20)}`],
    ["bindingId", "different-binding"],
    ["bindingHash", "dd".repeat(32)],
  ])(
    "binds attach to the job private context and rejects a changed %s",
    async (field, value) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      seedActiveMandate(harness, body);
      const jobId = await queueIntent(harness, body);
      const job = harness.jobs.get(jobId);
      harness.jobs.set(jobId, {
        ...job,
        _attach: { ...job._attach, [field]: value },
      });
      harness.evaluator.mockClear();

      const { res } = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-mismatch"),
      );

      expect(res.statusCode).toBe(409);
      expect(harness.farmExecutions.attach).not.toHaveBeenCalled();
      expect(harness.reports).toHaveLength(0);
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expectPrivateMaterialAbsent(res.body, body);
    },
  );

  it.each([
    ["durable pending activation", "pending_activation", 2],
    ["durable activation uncertainty", "activation_uncertain", 2],
    ["durable revocation", "revoked", 2],
    ["durable expiry", "expired", 2],
    ["pure binding mismatch", "mismatch", 2],
    ["fresh on-chain revocation", "fresh_revoked", 3],
  ])(
    "terminalizes the final pre-key fence on %s without reconstructing a key or dispatching deposits",
    async (_label, fenceState, expectedEvaluations) => {
      let harness;
      let fenceArmed = false;
      let replacementRecord = null;
      let bindingId;
      const body = routeBody({
        expiresAt: NOW_SECONDS + 120,
        serializedApproval: canonicalApproval(NOW_SECONDS + 120),
      });
      harness = makeRouteHarness({
        onClaim: () => {
          fenceArmed = true;
          if (
            fenceState === "pending_activation" ||
            fenceState === "activation_uncertain" ||
            fenceState === "expired"
          ) {
            replacementRecord = durableFenceRecord(
              body,
              bindingId,
              fenceState,
            );
          } else if (fenceState === "revoked") {
            harness.real.mandatesV3.revoke(routeIdentity(body));
          } else if (fenceState === "fresh_revoked") {
            harness.setEvidence({
              ...ACTIVE_ROUTE_EVIDENCE,
              status: "revoked",
              reasonCodes: ["PERMISSION_REVOKED"],
              checks: {
                ...ACTIVE_ROUTE_EVIDENCE.checks,
                permissionInstalled: false,
              },
            });
          }
        },
        transformMandateGet: (record) => {
          if (!fenceArmed) return record;
          if (replacementRecord) return replacementRecord;
          if (fenceState === "mismatch") {
            return preserveInternalRecord(record, {
              bindingHash: "cc".repeat(32),
            });
          }
          return record;
        },
      });
      const active = seedActiveMandate(
        harness,
        body,
        "final-fence-binding",
      );
      bindingId = active.bindingId;
      const jobId = await queueIntent(harness, body, {
        allocations: [routeAllocations()[0]],
      });

      const attached = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, `burn-fence-${fenceState}`),
      );
      expect(attached.res.statusCode).toBe(200);
      await vi.waitFor(() =>
        expect(harness.farmExecutions.finish).toHaveBeenCalledTimes(1),
      );

      expect(harness.evaluator).toHaveBeenCalledTimes(expectedEvaluations);
      for (const [args] of harness.evaluator.mock.calls) {
        expect(args).not.toHaveProperty("allocation");
      }
      expect(harness.farmExecutions.get(jobId)).toMatchObject({
        status: "done",
        attempts: 1,
        leaseToken: null,
      });
      expect(harness.jobs.get(jobId)).toMatchObject({ status: "error" });
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(harness.farmFn).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.jobs.get(jobId))).not.toContain(
        SESSION_KEY,
      );
      expect(JSON.stringify(harness.reports)).not.toContain(SESSION_KEY);
    },
  );

  it("reloads local authority after the pre-key evaluator so a concurrent revoke cannot reconstruct the farm client", async () => {
    const harness = makeRouteHarness();
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });
    harness.pushEvidence(
      ACTIVE_ROUTE_EVIDENCE,
      () => {
        harness.events.push("test:revoke-during-pre-key-evidence");
        harness.real.mandatesV3.revoke(routeIdentity(body));
        return ACTIVE_ROUTE_EVIDENCE;
      },
    );
    harness.events.length = 0;

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-revoked-before-key"),
    );
    expect(attached.res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(harness.jobs.get(jobId)).toMatchObject({ status: "error" }),
    );

    expect(harness.evaluator).toHaveBeenCalledTimes(3);
    const revokeIndex = harness.events.indexOf(
      "test:revoke-during-pre-key-evidence",
    );
    expect(revokeIndex).toBeGreaterThan(
      harness.events.indexOf("evaluator:fresh"),
    );
    expect(harness.events.indexOf("store:get", revokeIndex + 1)).toBeGreaterThan(
      revokeIndex,
    );
    expect(harness.buildFarm).not.toHaveBeenCalled();
    expect(harness.farmFn).not.toHaveBeenCalled();
    expect(harness.reports.map(({ lifecycle }) => lifecycle.sequence)).toEqual([
      1,
      2,
    ]);
  });

  it("retains observed mint custody at sequence 3 when the mint checkpoint transaction fails", async () => {
    const farmEvents = [];
    const harness = makeRouteHarness({
      farmImplementation: async ({ onMintConfirmed }) => {
        farmEvents.push("farm:mint-confirmed");
        try {
          await onMintConfirmed(mintedResult("0xmint-checkpoint-failure"));
        } catch (error) {
          farmEvents.push("farm:held-after-checkpoint-failure");
          throw error;
        }
        farmEvents.push("farm:deposit-dispatched");
        throw new Error("deposit must not run after checkpoint failure");
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });
    harness.farmExecutions.checkpoint.mockImplementationOnce(() => {
      throw new Error("mint checkpoint transaction failed");
    });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-checkpoint-failure"),
    );
    expect(attached.res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(harness.farmExecutions.finish).toHaveBeenCalledTimes(1),
    );

    expect(farmEvents).toEqual([
      "farm:mint-confirmed",
      "farm:held-after-checkpoint-failure",
    ]);
    expect(farmEvents).not.toContain("farm:deposit-dispatched");
    expect(harness.jobs.get(jobId)).toMatchObject({
      status: "error",
      executionStatus: "held",
      custodyLocation: "agent",
      steps: [
        { step: "mint", status: "minted", mintTxHash: "0xmint-checkpoint-failure" },
      ],
    });
    const recovery = harness.reports.filter(
      ({ lifecycle }) => lifecycle.sequence >= 2,
    );
    expect(recovery).toEqual([
      expect.objectContaining({
        expectedSequence: 1,
        lifecycle: expect.objectContaining({
          sequence: 2,
          status: "submitted",
          evidence: {
            executionStatus: "minted",
            custodyLocation: "agent",
            txHash: "0xmint-checkpoint-failure",
          },
        }),
      }),
      expect.objectContaining({
        expectedSequence: 2,
        lifecycle: expect.objectContaining({
          sequence: 3,
          status: "unknown",
          evidence: {
            executionStatus: "held",
            custodyLocation: "agent",
            txHash: "0xmint-checkpoint-failure",
          },
        }),
      }),
    ]);
    expect(harness.reports.map(({ lifecycle }) => lifecycle.sequence)).toEqual([
      1,
      2,
      3,
    ]);

    await harness.router.resumeFarmJobs();
    await harness.router.resumeFarmJobs();
    expect(harness.buildFarm).toHaveBeenCalledTimes(1);
    expect(harness.farmFn).toHaveBeenCalledTimes(1);
    expect(harness.farmExecutions.get(jobId)).toMatchObject({ status: "done" });
    expect(harness.reports.map(({ lifecycle }) => lifecycle.sequence)).toEqual([
      1,
      2,
      3,
    ]);
  });

  it("rejects missing mint transaction evidence before any deposit can run or be replayed", async () => {
    const farmEvents = [];
    const harness = makeRouteHarness({
      evidenceSequence: [
        ACTIVE_ROUTE_EVIDENCE,
        ACTIVE_ROUTE_EVIDENCE,
        ACTIVE_ROUTE_EVIDENCE,
        {
          ...ACTIVE_ROUTE_EVIDENCE,
          status: "revoked",
          reasonCodes: ["PERMISSION_REVOKED"],
        },
      ],
      farmImplementation: async ({ onMintConfirmed }) => {
        farmEvents.push("farm:mint-without-hash");
        try {
          await onMintConfirmed({ status: "minted" });
        } catch (error) {
          farmEvents.push("farm:missing-evidence-rejected");
          throw error;
        }
        farmEvents.push("farm:deposit-dispatched");
        return {
          mintResult: { status: "minted" },
          depositResults: [],
          runId: "run-42",
          bridgeAgent: "bridge-agent-1",
          grantTxHash: "grant-1",
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-missing-mint-hash"),
    );
    expect(attached.res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(harness.jobs.get(jobId)).toMatchObject({ status: "error" }),
    );

    expect(farmEvents).toEqual([
      "farm:mint-without-hash",
      "farm:missing-evidence-rejected",
    ]);
    expect(farmEvents).not.toContain("farm:deposit-dispatched");
    expect(harness.jobs.get(jobId)).toMatchObject({
      status: "error",
      executionStatus: "unknown",
      custodyLocation: "unknown",
    });
    expect(harness.jobs.get(jobId).steps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ step: "deposits" })]),
    );
    expect(JSON.stringify(harness.jobs.get(jobId))).not.toMatch(/mintTxHash/);

    await harness.router.resumeFarmJobs();
    await harness.router.resumeFarmJobs();
    expect(harness.buildFarm).toHaveBeenCalledTimes(1);
    expect(harness.farmFn).toHaveBeenCalledTimes(1);
    expect(harness.jobs.get(jobId).status).not.toBe("done");
  });

  it("persists mint custody then converts a late revoke into a terminal recoverable held result without any deposit replay", async () => {
    const farmEvents = [];
    let harness;
    harness = makeRouteHarness({
      transformMandateGet: (record) =>
        tracePureBindingRead(record, harness.events),
      evidenceSequence: [
        ACTIVE_ROUTE_EVIDENCE,
        ACTIVE_ROUTE_EVIDENCE,
        ACTIVE_ROUTE_EVIDENCE,
        {
          ...ACTIVE_ROUTE_EVIDENCE,
          status: "revoked",
          reasonCodes: ["PERMISSION_REVOKED"],
        },
      ],
      farmImplementation: async ({ onMintConfirmed, allocations }) => {
        farmEvents.push("farm:mint-confirmed");
        try {
          await onMintConfirmed(mintedResult("0xmint"));
        } catch (error) {
          farmEvents.push("farm:held-by-gate");
          throw error;
        }
        farmEvents.push("farm:deposit-dispatched");
        return {
          mintResult: mintedResult("0xmint"),
          depositResults: allocations.map(({ allocationId }) => ({
            allocationId,
            executionStatus: "deposited",
            custody: { location: "base-proxy" },
            txHash: "0xdeposit-must-not-happen",
          })),
          runId: "run-42",
          bridgeAgent: "bridge-agent-1",
          grantTxHash: "grant-1",
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-late-revoke"),
    );
    expect(attached.res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(harness.jobs.get(jobId)).toMatchObject({
        status: "error",
        executionStatus: "held",
        custodyLocation: "agent",
      }),
    );

    expect(harness.evaluator).toHaveBeenCalledTimes(4);
    expect(harness.buildFarm).toHaveBeenCalledTimes(1);
    expect(harness.buildFarm).toHaveBeenCalledWith(SESSION_KEY);
    expect(harness.farmFn).toHaveBeenCalledTimes(1);
    expect(farmEvents).toEqual(["farm:mint-confirmed", "farm:held-by-gate"]);
    expect(farmEvents).not.toContain("farm:deposit-dispatched");
    const checkpointIndex = harness.events.indexOf("farm-work:checkpoint");
    const storeReloadIndex = harness.events.indexOf(
      "store:get",
      checkpointIndex + 1,
    );
    const pureBindingIndex = harness.events.indexOf(
      "binding:pure",
      storeReloadIndex + 1,
    );
    const freshEvidenceIndex = harness.events.indexOf(
      "evaluator:fresh",
      pureBindingIndex + 1,
    );
    expect(checkpointIndex).toBeGreaterThanOrEqual(0);
    expect(storeReloadIndex).toBeGreaterThan(checkpointIndex);
    expect(pureBindingIndex).toBeGreaterThan(storeReloadIndex);
    expect(freshEvidenceIndex).toBeGreaterThan(pureBindingIndex);
    expect(harness.jobs.get(jobId)).toMatchObject({
      status: "error",
      executionStatus: "held",
      custodyLocation: "agent",
      steps: [{ step: "mint", status: "minted", mintTxHash: "0xmint" }],
    });
    expect(
      harness.jobs.get(jobId).steps.find(({ step }) => step === "deposits"),
    ).toBeUndefined();
    expect(harness.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expectedSequence: 2,
          lifecycle: {
            sequence: 3,
            status: "unknown",
            evidence: {
              executionStatus: "held",
              custodyLocation: "agent",
              txHash: "0xmint",
            },
            observedAt: expect.any(Number),
          },
        }),
      ]),
    );
    expect(harness.evidenceRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'base_deposit', status: 'blocked',
        evidence: expect.objectContaining({
          caller: KERNEL.toLowerCase(), reasonCode: 'mandate_held_after_mint',
          userOpHash: null, transactionHash: null,
        }),
      }),
    ]));

    const publicStatus = await postProtected(harness, "/status", {
      mandateId: MANDATE_ID,
      jobId,
    });
    expect(publicStatus.res.statusCode).toBe(200);
    expect(publicStatus.json).toMatchObject({
      status: "error",
      executionStatus: "held",
      custodyLocation: "agent",
    });
    expect(publicStatus.json).not.toHaveProperty('steps');
    expectPrivateMaterialAbsent(publicStatus.res.body, body);
    expect(publicStatus.res.body).not.toContain("0xdeposit-must-not-happen");

    await harness.router.resumeFarmJobs();
    expect(harness.buildFarm).toHaveBeenCalledTimes(1);
    expect(harness.farmFn).toHaveBeenCalledTimes(1);
    expect(harness.farmExecutions.get(jobId)).toMatchObject({
      status: "done",
    });
  });

  it("reloads local authority after post-mint evidence so a concurrent revoke holds custody before any deposit", async () => {
    const farmEvents = [];
    const harness = makeRouteHarness({
      farmImplementation: async ({ onMintConfirmed, allocations }) => {
        farmEvents.push("farm:mint-confirmed");
        try {
          await onMintConfirmed(mintedResult("0xmint-local-revoke-race"));
        } catch (error) {
          farmEvents.push("farm:held-by-local-reload");
          throw error;
        }
        farmEvents.push("farm:deposit-dispatched");
        return {
          mintResult: {
            status: "minted",
            mintTxHash: "0xmint-local-revoke-race",
          },
          depositResults: allocations.map(({ allocationId }) => ({
            allocationId,
            executionStatus: "deposited",
            custody: { location: "base-proxy" },
            txHash: "0xdeposit-must-not-happen",
          })),
          runId: "run-42",
          bridgeAgent: "bridge-agent-1",
          grantTxHash: "grant-1",
        };
      },
    });
    const body = routeBody();
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });
    harness.pushEvidence(
      ACTIVE_ROUTE_EVIDENCE,
      ACTIVE_ROUTE_EVIDENCE,
      () => {
        harness.events.push("test:revoke-during-post-mint-evidence");
        harness.real.mandatesV3.revoke(routeIdentity(body));
        return ACTIVE_ROUTE_EVIDENCE;
      },
    );
    harness.events.length = 0;

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-local-revoke-race"),
    );
    expect(attached.res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(harness.jobs.get(jobId)).toMatchObject({
        status: "error",
        executionStatus: "held",
        custodyLocation: "agent",
      }),
    );

    expect(harness.evaluator).toHaveBeenCalledTimes(4);
    const revokeIndex = harness.events.indexOf(
      "test:revoke-during-post-mint-evidence",
    );
    expect(revokeIndex).toBeGreaterThan(
      harness.events.indexOf("evaluator:fresh"),
    );
    expect(harness.events.indexOf("store:get", revokeIndex + 1)).toBeGreaterThan(
      revokeIndex,
    );
    expect(farmEvents).toEqual([
      "farm:mint-confirmed",
      "farm:held-by-local-reload",
    ]);
    expect(farmEvents).not.toContain("farm:deposit-dispatched");
    expect(harness.reports.map(({ lifecycle }) => lifecycle.sequence)).toEqual([
      1,
      2,
      3,
    ]);
    expect(harness.jobs.get(jobId).steps).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ step: "deposits" })]),
    );
  });

  it("authorizes farm status by durable mandate/job binding and exposes only contiguous delivery truth", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const bodyA = routeBody();
    const bodyB = secondRouteBody();
    const activeA = seedActiveMandate(harness, bodyA);
    seedActiveMandate(harness, bodyB, "active-binding-2");
    const jobId = STATUS_JOB_ID;
    harness.jobs.set(jobId, {
      status: "done",
      executionStatus: "deposited",
      custodyLocation: "base-proxy",
      depositProgress: { privateAllocation: { bearer: 'progress-bearer-sentinel' } },
      results: [{ endpoint: 'results-endpoint-sentinel' }],
      rawError: { capability: 'raw-capability-sentinel' },
      leaseToken: 'lease-token-sentinel',
      steps: [
        { step: "mint", status: "minted", mintTxHash: "0xmint-status", approval: 'approval-sentinel' },
        { step: "deposits", results: [{ sessionKey: 'session-key-sentinel' }] },
      ],
      _attach: {
        mandateId: MANDATE_ID,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        bindingId: activeA.bindingId,
        bindingHash: activeA.bindingHash,
        associations: [
          {
            allocationId: "run-42:bridge:aave-v3",
            identity: {
              networkId: 'stellar-testnet', owner: OWNER, bindingId: activeA.bindingId,
              executionId: 'run-42:exec:run-42:bridge:aave-v3',
              allocationId: 'run-42:bridge:aave-v3', childId: jobId,
            },
            recoveryIdentity: {
              networkId: 'stellar-testnet', bindingId: activeA.bindingId,
              executionId: 'run-42:exec:run-42:bridge:aave-v3',
              allocationId: 'run-42:bridge:aave-v3', childId: jobId,
            },
            terminalSequence: 2,
          },
          {
            allocationId: "run-42:bridge:blend-v2",
            identity: {
              networkId: 'stellar-testnet', owner: OWNER, bindingId: activeA.bindingId,
              executionId: 'run-42:exec:run-42:bridge:blend-v2',
              allocationId: 'run-42:bridge:blend-v2', childId: jobId,
            },
            recoveryIdentity: {
              networkId: 'stellar-testnet', bindingId: activeA.bindingId,
              executionId: 'run-42:exec:run-42:bridge:blend-v2',
              allocationId: 'run-42:bridge:blend-v2', childId: jobId,
            },
            terminalSequence: 3,
          },
        ],
      },
    });

    const empty = await postProtected(harness, "/status", {
      mandateId: MANDATE_ID,
      jobId,
    });
    expect(empty.res.statusCode).toBe(200);
    expect(empty.json).toMatchObject({
      status: "done",
      associationDelivery: {
        complete: false,
        uncertain: true,
        events: [],
      },
    });
    expect(Object.keys(empty.json).sort()).toEqual([
      'associationDelivery', 'custodyLocation', 'evidenceDelivery', 'executionStatus',
      'jobId', 'status',
    ]);
    for (const sentinel of [
      'progress-bearer-sentinel', 'results-endpoint-sentinel', 'raw-capability-sentinel',
      'lease-token-sentinel', 'approval-sentinel', 'session-key-sentinel',
    ]) expect(empty.res.body).not.toContain(sentinel);
    expectPrivateMaterialAbsent(empty.res.body, bodyA);

    harness.delivery.push(
      {
        childId: jobId,
        executionId: "run-42:exec:run-42:bridge:aave-v3",
        allocationId: "run-42:bridge:aave-v3",
        sequence: 1,
        status: "delivered",
      },
      {
        childId: jobId,
        executionId: "run-42:exec:run-42:bridge:aave-v3",
        allocationId: "run-42:bridge:aave-v3",
        sequence: 2,
        status: "delivered",
      },
      {
        childId: jobId,
        executionId: "run-42:exec:run-42:bridge:blend-v2",
        allocationId: "run-42:bridge:blend-v2",
        sequence: 1,
        status: "delivered",
      },
      {
        childId: jobId,
        executionId: "run-42:exec:run-42:bridge:blend-v2",
        allocationId: "run-42:bridge:blend-v2",
        sequence: 2,
        status: "delivered",
      },
    );
    const missingSecondTerminal = await postProtected(harness, "/status", {
      mandateId: MANDATE_ID,
      jobId,
    });
    expect(missingSecondTerminal.res.statusCode).toBe(200);
    expect(missingSecondTerminal.json.associationDelivery).toMatchObject({
      complete: false,
      uncertain: true,
      events: expect.arrayContaining([
        expect.objectContaining({
          allocationId: "run-42:bridge:aave-v3",
          sequence: 2,
        }),
        expect.objectContaining({
          allocationId: "run-42:bridge:blend-v2",
          sequence: 2,
        }),
      ]),
    });

    harness.delivery.push({
      childId: jobId,
      executionId: "run-42:exec:run-42:bridge:blend-v2",
      allocationId: "run-42:bridge:blend-v2",
      sequence: 3,
      status: "delivered",
    });
    const complete = await postProtected(harness, "/status", {
      mandateId: MANDATE_ID,
      jobId,
    });
    expect(complete.res.statusCode).toBe(200);
    expect(complete.json.associationDelivery).toMatchObject({
      complete: true,
      uncertain: false,
      events: expect.arrayContaining([
        expect.objectContaining({
          allocationId: "run-42:bridge:aave-v3",
          sequence: 1,
        }),
        expect.objectContaining({
          allocationId: "run-42:bridge:aave-v3",
          sequence: 2,
        }),
        expect.objectContaining({
          allocationId: "run-42:bridge:blend-v2",
          sequence: 1,
        }),
        expect.objectContaining({
          allocationId: "run-42:bridge:blend-v2",
          sequence: 2,
        }),
        expect.objectContaining({
          allocationId: "run-42:bridge:blend-v2",
          sequence: 3,
        }),
      ]),
    });
    expect(complete.json.associationDelivery.events).toHaveLength(5);

    const crossCapability = await postProtected(
      harness,
      "/status",
      {
        mandateId: MANDATE_ID,
        jobId,
      },
      SECOND_CAPABILITY,
    );
    expectGenericUnauthorized(crossCapability.res, bodyA);

    const unknown = await postProtected(harness, "/status", {
      mandateId: MANDATE_ID,
      jobId: UNKNOWN_JOB_ID,
    });
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.json).toEqual({ error: "unknown jobId" });
    expectPrivateMaterialAbsent(unknown.res.body, bodyA);
  });

  it("keeps association delivery complete while Base evidence delivery remains pending", async () => {
    const body = routeBody();
    const associationIdentity = {
      networkId: 'stellar-testnet', owner: OWNER, bindingId: 'active-binding-1',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3', childId: STATUS_JOB_ID,
    };
    const { owner: _owner, ...recoveryIdentity } = associationIdentity;
    const associationOutbox = {
      enqueue: vi.fn(),
      status: vi.fn(() => [{
        allocationId: associationIdentity.allocationId,
        executionId: associationIdentity.executionId,
        sequence: 1, status: 'delivered', attempts: 1,
      }]),
    };
    const baseEvidenceOutbox = {
      seed: vi.fn(), enqueue: vi.fn(),
      status: vi.fn(() => ({
        complete: false, blocked: false, recoveryVersion: 4,
        latestPhase: 'base_deposit', latestState: 'confirmed',
        events: [{
          allocationId: recoveryIdentity.allocationId,
          executionId: recoveryIdentity.executionId,
          phase: 'base_deposit', state: 'confirmed', expectedRecoveryVersion: 3,
          resultingRecoveryVersion: 4, deliveryStatus: 'pending', attempts: 0,
        }],
      })),
    };
    const harness = makeRouteHarness({ associationOutbox, baseEvidenceOutbox, claimEnabled: false });
    const active = seedActiveMandate(harness, body);
    harness.jobs.set(STATUS_JOB_ID, {
      status: 'done', steps: [],
      _attach: {
        mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL,
        bindingId: active.bindingId, bindingHash: active.bindingHash,
        associations: [{
          allocationId: associationIdentity.allocationId,
          identity: associationIdentity, recoveryIdentity, terminalSequence: 1,
        }],
      },
    });

    const status = await postProtected(harness, '/status', {
      mandateId: MANDATE_ID, jobId: STATUS_JOB_ID,
    });

    expect(status.json.associationDelivery).toMatchObject({ complete: true, uncertain: false });
    expect(status.json.evidenceDelivery).toMatchObject({ complete: false, blocked: false, uncertain: true });
    expect(associationOutbox.status).toHaveBeenCalledWith(recoveryIdentity);
    expect(baseEvidenceOutbox.status).toHaveBeenCalledWith(recoveryIdentity);
  });

  it.each([
    [
      "stellarOwner",
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey(),
    ],
    ["kernelAddress", OTHER_KERNEL],
    ["bindingId", "status-binding-mismatch"],
    ["bindingHash", "ab".repeat(32)],
  ])(
    "fails farm status closed when the durable job context has a changed %s",
    async (field, value) => {
      const harness = makeRouteHarness({ claimEnabled: false });
      const body = routeBody();
      const active = seedActiveMandate(harness, body);
      harness.jobs.set(STATUS_JOB_ID, {
        status: "done",
        steps: [{ step: "private-step-sentinel" }],
        _attach: {
          mandateId: body.mandateId,
          stellarOwner: body.stellarOwner,
          kernelAddress: body.kernelAddress,
          bindingId: active.bindingId,
          bindingHash: active.bindingHash,
          associations: [],
          [field]: value,
        },
      });
      const before = JSON.stringify(harness.jobs.get(STATUS_JOB_ID));

      const response = await postProtected(harness, "/status", {
        mandateId: body.mandateId,
        jobId: STATUS_JOB_ID,
      });

      expectGenericUnauthorized(response.res, body);
      expect(response.res.body).not.toContain("private-step-sentinel");
      expect(JSON.stringify(harness.jobs.get(STATUS_JOB_ID))).toBe(before);
      expect(harness.evaluator).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(harness.reports).toHaveLength(0);
    },
  );

  it("rejects mandate/body mismatch for a real job as generic unauthorized before public job disclosure", async () => {
    const harness = makeRouteHarness({ claimEnabled: false });
    const bodyA = routeBody();
    const bodyB = secondRouteBody();
    seedActiveMandate(harness, bodyA);
    const activeB = seedActiveMandate(harness, bodyB, "active-binding-2");
    harness.jobs.set(SECOND_STATUS_JOB_ID, {
      status: "done",
      steps: [{ step: "private-step-sentinel" }],
      _attach: {
        mandateId: bodyB.mandateId,
        stellarOwner: bodyB.stellarOwner,
        kernelAddress: bodyB.kernelAddress,
        bindingId: activeB.bindingId,
        bindingHash: activeB.bindingHash,
        associations: [],
      },
    });

    const response = await postProtected(
      harness,
      "/status",
      {
        mandateId: bodyA.mandateId,
        jobId: SECOND_STATUS_JOB_ID,
      },
      bodyA.capability,
    );

    expectGenericUnauthorized(response.res, bodyA);
    expect(response.res.body).not.toContain("private-step-sentinel");
  });

  it("authenticates every body-identity route from reopened SQLite metadata before any key-envelope decryption", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-body-auth-")),
      "relayer.db",
    );
    const trace = [];
    const baseCipher = routeCipher();
    const openEnvelope = vi.fn((...args) => {
      trace.push("cipher:open");
      return baseCipher.open(...args);
    });
    const cipher = {
      seal: (...args) => baseCipher.seal(...args),
      open: openEnvelope,
    };
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      nowSeconds: () => NOW_SECONDS,
    });
    const bodyA = routeBody();
    const bodyB = secondRouteBody();
    try {
      const first = makeRouteHarness({
        realStores: stores1,
        jobs: stores1.jobs,
        associationOutbox: stores1.associationOutbox,
        farmExecutions: stores1.farmExecutions,
        claimEnabled: false,
      });
      const activeA = seedActiveMandate(first, bodyA, "body-auth-binding-a");
      seedActiveMandate(first, bodyB, "body-auth-binding-b");
      stores1.jobs.set(STATUS_JOB_ID, {
        status: "queued",
        steps: [{ step: "private-step-sentinel" }],
        runId: "run-42",
        bridgeAgent: "bridge-agent-1",
        grantTxHash: "grant-1",
        _attach: {
          mandateId: bodyA.mandateId,
          stellarOwner: bodyA.stellarOwner,
          kernelAddress: bodyA.kernelAddress,
          bindingId: activeA.bindingId,
          bindingHash: activeA.bindingHash,
          networkId: "stellar-testnet",
          jobId: STATUS_JOB_ID,
          allocations: routeAllocations(),
          associations: [],
          attachedBurnTxHash: null,
        },
      });
      stores1.db.close();

      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: cipher,
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        const originalAuthority = stores2.mandatesV3.authority.bind(stores2.mandatesV3);
        const authorityLookup = vi.spyOn(stores2.mandatesV3, "authority")
          .mockImplementation((mandateId) => {
            trace.push("store:authority");
            return originalAuthority(mandateId);
          });
        const attachWork = vi.spyOn(stores2.farmExecutions, "attach");
        const reopened = makeRouteHarness({
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
          claimEnabled: false,
        });
        openEnvelope.mockClear();
        trace.length = 0;
        const jobGet = vi.spyOn(stores2.jobs, "get");
        const cases = [
          ["/mandate/status", statusBody(bodyA)],
          ["/mandate/revoke", statusBody(bodyA)],
          ["/farm", farmBody(bodyA)],
          ["/farm/attach", attachBody(STATUS_JOB_ID, bodyA, "burn-preauth")],
        ];

        for (const capability of [WRONG_CAPABILITY, SECOND_CAPABILITY]) {
          for (const [route, requestBody] of cases) {
            const denied = await postProtected(
              reopened,
              route,
              requestBody,
              capability,
            );
            expectGenericUnauthorized(denied.res, bodyA);
          }
        }
        expect(authorityLookup).toHaveBeenCalledTimes(8);
        expect(openEnvelope).not.toHaveBeenCalled();
        expect(jobGet).not.toHaveBeenCalled();
        expect(reopened.evaluator).not.toHaveBeenCalled();
        expect(reopened.reporter.commitIntentBatch).not.toHaveBeenCalled();
        expect(attachWork).not.toHaveBeenCalled();
        expect(stores2.mandatesV3.status(routeIdentity(bodyA)).status).toBe("active");

        trace.length = 0;
        const allowed = await postProtected(
          reopened,
          "/mandate/status",
          statusBody(bodyA),
        );
        expect(allowed.res.statusCode).toBe(200);
        expect(allowed.json.status).toBe("active");
        expect(trace.indexOf("store:authority")).toBeLessThan(
          trace.indexOf("cipher:open"),
        );
        expect(openEnvelope).toHaveBeenCalledTimes(1);
        expectPrivateMaterialAbsent(allowed.res.body, bodyA);
        jobGet.mockRestore();
        attachWork.mockRestore();
        authorityLookup.mockRestore();
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("authenticates farm status from SQLite authority metadata after reopen before reading or decrypting the job mandate", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-status-auth-")),
      "relayer.db",
    );
    const baseCipher = routeCipher();
    const openEnvelope = vi.fn((...args) => baseCipher.open(...args));
    const cipher = {
      seal: (...args) => baseCipher.seal(...args),
      open: openEnvelope,
    };
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      nowSeconds: () => NOW_SECONDS,
    });
    const body = routeBody();
    try {
      const first = makeRouteHarness({
        realStores: stores1,
        jobs: stores1.jobs,
        associationOutbox: stores1.associationOutbox,
        farmExecutions: stores1.farmExecutions,
      });
      const active = seedActiveMandate(first, body, "reopened-status-binding");
      stores1.jobs.set(STATUS_JOB_ID, {
        status: "done",
        steps: [{ step: "mint", status: "minted", mintTxHash: "0xstatus" }],
        _attach: {
          mandateId: body.mandateId,
          stellarOwner: body.stellarOwner,
          kernelAddress: body.kernelAddress,
          bindingId: active.bindingId,
          bindingHash: active.bindingHash,
          associations: [],
        },
      });
      stores1.db.close();

      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: cipher,
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        const reopened = makeRouteHarness({
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
        });
        openEnvelope.mockClear();
        const jobGet = vi.spyOn(stores2.jobs, "get");

        const denied = await postProtected(
          reopened,
          "/status",
          { mandateId: body.mandateId, jobId: STATUS_JOB_ID },
          WRONG_CAPABILITY,
        );
        expectGenericUnauthorized(denied.res, body);
        expect(jobGet).not.toHaveBeenCalled();
        expect(openEnvelope).not.toHaveBeenCalled();

        const allowed = await postProtected(reopened, "/status", {
          mandateId: body.mandateId,
          jobId: STATUS_JOB_ID,
        });
        expect(allowed.res.statusCode).toBe(200);
        expect(allowed.json).toMatchObject({ status: "done" });
        expect(jobGet).toHaveBeenCalledTimes(1);
        expect(openEnvelope).not.toHaveBeenCalled();
        expectPrivateMaterialAbsent(allowed.res.body, body);
        jobGet.mockRestore();
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("reads durable non-active status and performs emergency revoke without opening a corrupt SQLite key envelope", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-keyless-control-")),
      "relayer.db",
    );
    const clock = { value: NOW_SECONDS };
    const goodCipher = routeCipher();
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: goodCipher,
      nowSeconds: () => clock.value,
    });
    const pending = routeBody({
      mandateId: mandateIdAt(10),
      capability: capabilityAt(10),
    });
    const uncertain = routeBody({
      mandateId: mandateIdAt(11),
      capability: capabilityAt(11),
    });
    const revoked = routeBody({
      mandateId: mandateIdAt(12),
      capability: capabilityAt(12),
    });
    const expired = routeBody({
      mandateId: mandateIdAt(13),
      capability: capabilityAt(13),
      expiresAt: NOW_SECONDS + 1,
      serializedApproval: canonicalApproval(NOW_SECONDS + 1),
    });
    try {
      const first = makeRouteHarness({
        clock,
        realStores: stores1,
        jobs: stores1.jobs,
        associationOutbox: stores1.associationOutbox,
        farmExecutions: stores1.farmExecutions,
      });
      seedPendingMandate(first, pending, "keyless-pending");
      seedUncertainMandate(first, uncertain, "keyless-uncertain");
      seedPendingMandate(first, revoked, "keyless-revoked");
      stores1.mandatesV3.revoke(routeIdentity(revoked));
      seedPendingMandate(first, expired, "keyless-expired");
      stores1.db.close();

      clock.value = NOW_SECONDS + 2;
      const openEnvelope = vi.fn(() => {
        throw new Error("corrupt encrypted session envelope");
      });
      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: {
          seal: (...args) => goodCipher.seal(...args),
          open: openEnvelope,
        },
        nowSeconds: () => clock.value,
      });
      try {
        const reopened = makeRouteHarness({
          clock,
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
        });
        for (const [body, expectedStatus] of [
          [pending, "pending_activation"],
          [uncertain, "activation_uncertain"],
          [revoked, "revoked"],
          [expired, "expired"],
        ]) {
          const response = await postProtected(
            reopened,
            "/mandate/status",
            statusBody(body),
            body.capability,
          );
          expect(response.res.statusCode).toBe(200);
          expect(response.json).toMatchObject({
            mandateId: body.mandateId,
            status: expectedStatus,
          });
          expectPrivateMaterialAbsent(response.res.body, body);
        }
        expect(openEnvelope).not.toHaveBeenCalled();
        expect(reopened.evaluator).not.toHaveBeenCalled();

        const emergency = await postProtected(
          reopened,
          "/mandate/revoke",
          statusBody(pending),
          pending.capability,
        );
        expect(emergency.res.statusCode).toBe(200);
        expect(emergency.json).toMatchObject({ status: "revoked" });
        expect(openEnvelope).not.toHaveBeenCalled();
        expect(stores2.mandatesV3.status(routeIdentity(pending)).status).toBe("revoked");
        expect(stores2.db.prepare(`
          SELECT session_key_envelope FROM mandates_v3 WHERE mandate_id = ?
        `).get(pending.mandateId).session_key_envelope).toBeNull();
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("renews a running farm lease beyond 30 seconds so an exact attach retry cannot reconcile or replay it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_900_000_000_000);
    let resolveFarm;
    const harness = makeRouteHarness({
      farmImplementation: () =>
        new Promise((resolve) => {
          resolveFarm = resolve;
        }),
    });
    const body = routeBody();
    try {
      seedActiveMandate(harness, body);
      const allocation = routeAllocations()[0];
      const jobId = await queueIntent(harness, body, {
        allocations: [allocation],
      });
      const attached = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-heartbeat"),
      );
      expect(attached.res.statusCode).toBe(200);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.farmExecutions.get(jobId)).toMatchObject({
        status: "running",
        attempts: 1,
      });
      expect(harness.buildFarm).toHaveBeenCalledTimes(1);
      expect(harness.farmFn).toHaveBeenCalledTimes(1);

      const originalLeaseExpiry = harness.farmExecutions.get(
        jobId,
      ).leaseExpiresAt;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(harness.farmExecutions.renew).toHaveBeenCalled();
      expect(
        harness.farmExecutions.get(jobId).leaseExpiresAt,
      ).toBeGreaterThan(originalLeaseExpiry);

      const repeated = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-heartbeat"),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(repeated.res.statusCode).toBe(200);
      expect(harness.farmExecutions.reconcileUncertain).not.toHaveBeenCalled();
      expect(harness.farmExecutions.get(jobId)).toMatchObject({
        status: "running",
        attempts: 1,
      });
      expect(harness.buildFarm).toHaveBeenCalledTimes(1);
      expect(harness.farmFn).toHaveBeenCalledTimes(1);

      resolveFarm({
        mintResult: mintedResult("0xmint-heartbeat"),
        depositResults: [
          {
            allocationId: allocation.allocationId,
            status: "fulfilled",
            executionStatus: "deposited",
            custody: { location: "base-proxy" },
            txHash: "0xdeposit-heartbeat",
          },
        ],
        runId: "run-42",
        bridgeAgent: "bridge-agent-1",
        grantTxHash: "grant-1",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.farmExecutions.get(jobId)).toMatchObject({
        status: "done",
        attempts: 1,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(harness.farmExecutions.finish).toHaveBeenCalledTimes(1);
      expect(harness.farmExecutions.reconcileUncertain).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a durable finish transaction failure immediately uncertain and never replays farm work on attach retry", async () => {
    const harness = makeRouteHarness();
    const body = routeBody();
    harness.farmExecutions.finish.mockImplementation(() => {
      throw new Error("durable finish commit failed");
    });
    seedActiveMandate(harness, body);
    const jobId = await queueIntent(harness, body, {
      allocations: [routeAllocations()[0]],
    });

    const attached = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-finish-failure"),
    );
    expect(attached.res.statusCode).toBe(200);
    await flushMicrotasks(50);
    expect(harness.farmExecutions.finish).toHaveBeenCalledTimes(1);
    expect(harness.jobs.get(jobId)).toMatchObject({
      status: "error",
      associationUncertain: true,
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "association-persistence",
          status: "error",
          message: "durable finish commit failed",
        }),
      ]),
    });
    expect(harness.farmExecutions.get(jobId)).toMatchObject({
      status: "running",
      attempts: 1,
    });

    const status = await postProtected(harness, "/status", {
      mandateId: body.mandateId,
      jobId,
    });
    expect(status.res.statusCode).toBe(200);
    expect(status.json).toMatchObject({
      status: "error",
      associationDelivery: { complete: false, uncertain: true },
    });
    expect(status.json).not.toHaveProperty("associationUncertain");

    const repeated = await postProtected(
      harness,
      "/farm/attach",
      attachBody(jobId, body, "burn-finish-failure"),
    );
    await flushMicrotasks();
    expect(repeated.res.statusCode).toBe(200);
    expect(harness.buildFarm).toHaveBeenCalledTimes(1);
    expect(harness.farmFn).toHaveBeenCalledTimes(1);
    expect(harness.farmExecutions.reconcileUncertain).not.toHaveBeenCalled();
  });

  it("recovers a post-mint farm plus finish failure at sequence 3 exactly once across repeated resume without replay", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-post-mint-")),
      "relayer.db",
    );
    const cipher = routeCipher();
    let nowMs = 1_900_000_000_000;
    const stores = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      now: () => nowMs,
      nowSeconds: () => NOW_SECONDS,
    });
    const finish = vi.fn(() => {
      throw new Error("durable terminal commit failed");
    });
    const harness = makeRouteHarness({
      realStores: stores,
      jobs: stores.jobs,
      associationOutbox: stores.associationOutbox,
      farmExecutions: { ...stores.farmExecutions, finish },
      farmImplementation: async ({ onMintConfirmed }) => {
        await onMintConfirmed(mintedResult("0xmint-before-failure"));
        throw new Error("deposit failed after mint");
      },
    });
    const body = routeBody();
    try {
      seedActiveMandate(harness, body);
      const jobId = await queueIntent(harness, body, {
        allocations: [routeAllocations()[0]],
      });
      const attached = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-post-mint-failure"),
      );
      expect(attached.res.statusCode).toBe(200);
      await flushMicrotasks(50);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(stores.jobs.get(jobId)).toMatchObject({
        status: "error",
        associationUncertain: true,
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "mint",
            status: "minted",
            mintTxHash: "0xmint-before-failure",
          }),
          expect.objectContaining({
            step: "farm",
            status: "error",
            message: "deposit failed after mint",
          }),
          expect.objectContaining({
            step: "association-persistence",
            status: "error",
            message: "durable terminal commit failed",
          }),
        ]),
      });
      expect(
        associationRows(stores, jobId).map(({ sequence }) => sequence),
      ).toEqual([1, 2]);

      nowMs = stores.farmExecutions.get(jobId).leaseExpiresAt + 1;
      await expect(harness.router.resumeFarmJobs()).resolves.toBeUndefined();
      const afterFirst = associationRows(stores, jobId).map(({ sequence }) => sequence);
      await expect(harness.router.resumeFarmJobs()).resolves.toBeUndefined();
      const afterSecond = associationRows(stores, jobId).map(({ sequence }) => sequence);

      expect(stores.farmExecutions.get(jobId)).toMatchObject({
        status: "uncertain",
        attempts: 1,
        leaseToken: null,
      });
      expect(afterFirst).toEqual([1, 2, 3]);
      expect(afterSecond).toEqual([1, 2, 3]);
      expect(harness.buildFarm).toHaveBeenCalledTimes(1);
      expect(harness.farmFn).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledTimes(1);
    } finally {
      stores.db.close();
    }
  });

  it("reopens and resumes one durably attached pending farm without a second attach or burn acknowledgement", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-resume-")),
      "relayer.db",
    );
    const cipher = routeCipher();
    let nowMs = 1_900_000_000_000;
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      now: () => nowMs,
      nowSeconds: () => NOW_SECONDS,
    });
    const noDispatchExecutions = {
      ...stores1.farmExecutions,
      claim: vi.fn(() => null),
    };
    const first = makeRouteHarness({
      realStores: stores1,
      jobs: stores1.jobs,
      associationOutbox: stores1.associationOutbox,
      farmExecutions: noDispatchExecutions,
    });
    const body = routeBody();
    try {
      seedActiveMandate(first, body);
      const jobId = await queueIntent(first, body, {
        allocations: [routeAllocations()[0]],
      });
      const attached = await postProtected(
        first,
        "/farm/attach",
        attachBody(jobId, body, "burn-durable-resume"),
      );
      expect(attached.res.statusCode).toBe(200);
      expect(stores1.farmExecutions.get(jobId)).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      expect(first.buildFarm).not.toHaveBeenCalled();
      stores1.db.close();

      nowMs += 1_000;
      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: cipher,
        now: () => nowMs,
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        const resumed = makeRouteHarness({
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
        });
        await resumed.router.resumeFarmJobs();
        await vi.waitFor(() =>
          expect(stores2.farmExecutions.get(jobId)).toMatchObject({
            status: "done",
            attempts: 1,
            leaseToken: null,
          }),
        );
        expect(resumed.buildFarm).toHaveBeenCalledTimes(1);
        expect(resumed.buildFarm).toHaveBeenCalledWith(SESSION_KEY);
        expect(resumed.farmFn).toHaveBeenCalledTimes(1);
        expect(
          associationRows(stores2, jobId)
            .map(({ sequence }) => sequence),
        ).toEqual([1, 2, 3]);
        expect(JSON.stringify(stores2.jobs.get(jobId))).not.toContain(
          SESSION_KEY,
        );
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("terminalizes every persisted association when a pending farm pool is no longer allowlisted after reopen", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-pool-drift-")),
      "relayer.db",
    );
    const cipher = routeCipher();
    let nowMs = 1_900_000_000_000;
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      now: () => nowMs,
      nowSeconds: () => NOW_SECONDS,
    });
    const first = makeRouteHarness({
      realStores: stores1,
      jobs: stores1.jobs,
      associationOutbox: stores1.associationOutbox,
      farmExecutions: { ...stores1.farmExecutions, claim: vi.fn(() => null) },
    });
    const body = routeBody();
    try {
      seedActiveMandate(first, body);
      const allocations = routeAllocations();
      const jobId = await queueIntent(first, body, { allocations });
      const attached = await postProtected(
        first,
        "/farm/attach",
        attachBody(jobId, body, "burn-pool-drift"),
      );
      expect(attached.res.statusCode).toBe(200);
      expect(stores1.farmExecutions.get(jobId)).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      stores1.db.close();

      nowMs += 1_000;
      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: cipher,
        now: () => nowMs,
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        const recovered = makeRouteHarness({
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
          poolTargets: new Map([
            [SECOND_POOL.toLowerCase(), "blend-v2"],
          ]),
        });
        await recovered.router.resumeFarmJobs();
        await vi.waitFor(() =>
          expect(stores2.farmExecutions.get(jobId)).toMatchObject({
            status: "done",
            attempts: 1,
            leaseToken: null,
          }),
        );

        expect(stores2.jobs.get(jobId)).toMatchObject({
          status: "error",
          _attach: {
            associations: allocations.map(({ allocationId }) => ({
              allocationId,
              terminalSequence: 2,
            })),
          },
        });
        for (const { allocationId } of allocations) {
          expect(
            associationRows(stores2, jobId)
              .filter((row) => row.allocationId === allocationId)
              .map(({ sequence }) => sequence),
          ).toEqual([1, 2]);
        }
        expect(recovered.buildFarm).not.toHaveBeenCalled();
        expect(recovered.farmFn).not.toHaveBeenCalled();
        expect(recovered.evaluator).not.toHaveBeenCalled();

        await recovered.router.resumeFarmJobs();
        expect(recovered.buildFarm).not.toHaveBeenCalled();
        expect(recovered.farmFn).not.toHaveBeenCalled();
        for (const { allocationId } of allocations) {
          expect(
            associationRows(stores2, jobId)
              .filter((row) => row.allocationId === allocationId)
              .map(({ sequence }) => sequence),
          ).toEqual([1, 2]);
        }
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("reconciles an expired running farm lease to terminal uncertain after reopen without reconstructing or replaying deposits", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-uncertain-")),
      "relayer.db",
    );
    const cipher = routeCipher();
    let nowMs = 1_900_000_000_000;
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      now: () => nowMs,
      nowSeconds: () => NOW_SECONDS,
    });
    const first = makeRouteHarness({
      realStores: stores1,
      jobs: stores1.jobs,
      associationOutbox: stores1.associationOutbox,
      farmExecutions: { ...stores1.farmExecutions, claim: vi.fn(() => null) },
    });
    const body = routeBody();
    try {
      seedActiveMandate(first, body);
      const jobId = await queueIntent(first, body, {
        allocations: [routeAllocations()[0]],
      });
      const attached = await postProtected(
        first,
        "/farm/attach",
        attachBody(jobId, body, "burn-durable-uncertain"),
      );
      expect(attached.res.statusCode).toBe(200);
      const claimed = stores1.farmExecutions.claim({
        jobId,
        now: nowMs,
        leaseMs: 1,
      });
      expect(claimed).toMatchObject({ status: "running", attempts: 1 });
      stores1.db.close();

      nowMs += 2;
      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: cipher,
        now: () => nowMs,
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        const recovered = makeRouteHarness({
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
        });
        await recovered.router.resumeFarmJobs();

        expect(stores2.farmExecutions.get(jobId)).toMatchObject({
          status: "uncertain",
          attempts: 1,
          leaseToken: null,
        });
        expect(stores2.jobs.get(jobId)).toMatchObject({
          status: "uncertain",
          _attach: {
            associations: [
              {
                allocationId: "run-42:bridge:aave-v3",
                terminalSequence: 2,
              },
            ],
          },
        });
        expect(recovered.buildFarm).not.toHaveBeenCalled();
        expect(recovered.farmFn).not.toHaveBeenCalled();
        expect(
          associationRows(stores2, jobId)
            .map(({ sequence }) => sequence),
        ).toEqual([1, 2]);
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("reconciles every persisted association when an expired running farm has corrupt allocation data", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "vf-v3-route-corrupt-allocation-")),
      "relayer.db",
    );
    const cipher = routeCipher();
    let nowMs = 1_900_000_000_000;
    const stores1 = createSqliteStores(path, {
      sessionKeyCipher: cipher,
      now: () => nowMs,
      nowSeconds: () => NOW_SECONDS,
    });
    const first = makeRouteHarness({
      realStores: stores1,
      jobs: stores1.jobs,
      associationOutbox: stores1.associationOutbox,
      farmExecutions: { ...stores1.farmExecutions, claim: vi.fn(() => null) },
    });
    const body = routeBody();
    try {
      seedActiveMandate(first, body);
      const allocations = routeAllocations();
      const jobId = await queueIntent(first, body, { allocations });
      const attached = await postProtected(
        first,
        "/farm/attach",
        attachBody(jobId, body, "burn-corrupt-allocation"),
      );
      expect(attached.res.statusCode).toBe(200);
      const claimed = stores1.farmExecutions.claim({
        jobId,
        now: nowMs,
        leaseMs: 1,
      });
      expect(claimed).toMatchObject({ status: "running", attempts: 1 });
      const corrupted = stores1.jobs.get(jobId);
      corrupted._attach.allocations[0].amount.units = "not-an-integer";
      stores1.jobs.set(jobId, corrupted);
      stores1.db.close();

      nowMs += 2;
      const stores2 = createSqliteStores(path, {
        sessionKeyCipher: cipher,
        now: () => nowMs,
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        const recovered = makeRouteHarness({
          realStores: stores2,
          jobs: stores2.jobs,
          associationOutbox: stores2.associationOutbox,
          farmExecutions: stores2.farmExecutions,
        });
        await recovered.router.resumeFarmJobs();

        expect(stores2.farmExecutions.get(jobId)).toMatchObject({
          status: "uncertain",
          attempts: 1,
          leaseToken: null,
        });
        expect(stores2.jobs.get(jobId)).toMatchObject({
          status: "uncertain",
          _attach: {
            associations: allocations.map(({ allocationId }) => ({
              allocationId,
              terminalSequence: 2,
            })),
          },
        });
        for (const { allocationId } of allocations) {
          expect(
            associationRows(stores2, jobId)
              .filter((row) => row.allocationId === allocationId)
              .map(({ sequence }) => sequence),
          ).toEqual([1, 2]);
        }
        expect(recovered.buildFarm).not.toHaveBeenCalled();
        expect(recovered.farmFn).not.toHaveBeenCalled();
        expect(recovered.evaluator).not.toHaveBeenCalled();

        await recovered.router.resumeFarmJobs();
        expect(recovered.buildFarm).not.toHaveBeenCalled();
        expect(recovered.farmFn).not.toHaveBeenCalled();
        for (const { allocationId } of allocations) {
          expect(
            associationRows(stores2, jobId)
              .filter((row) => row.allocationId === allocationId)
              .map(({ sequence }) => sequence),
          ).toEqual([1, 2]);
        }
      } finally {
        stores2.db.close();
      }
    } catch (error) {
      try {
        stores1.db.close();
      } catch {}
      throw error;
    }
  });

  it("keeps reverse mint relay non-custodial while status remains unavailable until job capabilities exist", async () => {
    const relayUnwindMint = vi.fn(async () => ({
      status: "minted",
      mintTxHash: "0xreverse-safe",
    }));
    const harness = makeRouteHarness({ relayUnwindMint });
    const unwind = mockRes();
    await harness.router(
      {
        method: "POST",
        url: "/api/vf-cross/unwind",
        body: {
          unwindTxHash: "0xowner-signed-exit-and-burn",
          stellarRecipient: OWNER,
        },
        headers: {},
      },
      unwind,
    );
    expect(unwind.statusCode).toBe(200);
    const { jobId } = jsonOf(unwind);
    expect(jobId).toMatch(JOB_ID_RE);
    await vi.waitFor(() =>
      expect(relayUnwindMint).toHaveBeenCalledWith({
        unwindTxHash: "0xowner-signed-exit-and-burn",
        stellarRecipient: OWNER,
      }),
    );
    expect(harness.buildFarm).not.toHaveBeenCalled();
    harness.events.length = 0;
    const jobGet = vi.spyOn(harness.jobs, "get");

    const existing = await postProtected(
      harness,
      "/status",
      { jobId },
      CAPABILITY,
    );
    const unknown = await postProtected(
      harness,
      "/status",
      { jobId: UNKNOWN_JOB_ID },
      CAPABILITY,
    );
    expect(existing.res.statusCode).toBe(400);
    expect(unknown.res.statusCode).toBe(400);
    expect(existing.json).toEqual({ error: "unsupported status identity" });
    expect(unknown.json).toEqual(existing.json);
    expect(existing.res.body).toBe(unknown.res.body);
    expect(existing.res.body).not.toContain("0xreverse-safe");
    expect(unknown.res.body).not.toContain(UNKNOWN_JOB_ID);
    expect(jobGet).not.toHaveBeenCalled();
    jobGet.mockRestore();
    expect(harness.events).not.toContain("store:get");
    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.buildFarm).not.toHaveBeenCalled();
  });

  it.each([
    ["missing unwind hash", { stellarRecipient: OWNER }],
    ["empty unwind hash", { unwindTxHash: "", stellarRecipient: OWNER }],
    ["numeric unwind hash", { unwindTxHash: 1234, stellarRecipient: OWNER }],
    ["missing Stellar recipient", { unwindTxHash: "0xunwind" }],
    [
      "empty Stellar recipient",
      { unwindTxHash: "0xunwind", stellarRecipient: "" },
    ],
    [
      "numeric Stellar recipient",
      { unwindTxHash: "0xunwind", stellarRecipient: 1234 },
    ],
    [
      "extra routing field",
      {
        unwindTxHash: "0xunwind",
        stellarRecipient: OWNER,
        amount: "1000000",
      },
    ],
  ])(
    "rejects %s before creating an unwind job or invoking the reverse mint relay",
    async (_label, requestBody) => {
      const harness = makeRouteHarness();
      const res = mockRes();

      await harness.router(
        {
          method: "POST",
          url: "/api/vf-cross/unwind",
          body: requestBody,
          headers: {},
        },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(harness.jobs.size).toBe(0);
      expect(harness.relayUnwindMint).not.toHaveBeenCalled();
      expect(harness.buildFarm).not.toHaveBeenCalled();
      expect(res.body).not.toContain(SESSION_KEY);
    },
  );

  it("sanitizes an unwind relay rejection internally while keeping both existing and unknown jobs publicly unavailable", async () => {
    const rawFailure = `iris ${SESSION_KEY} https://iris.private timed out`;
    const relayUnwindMint = vi.fn(async () => {
      throw new Error(rawFailure);
    });
    const harness = makeRouteHarness({
      relayUnwindMint,
      sanitizeErrors: true,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const unwind = mockRes();
      await harness.router(
        {
          method: "POST",
          url: "/api/vf-cross/unwind",
          body: {
            unwindTxHash: "0xowner-signed-failing-unwind",
            stellarRecipient: OWNER,
          },
          headers: {},
        },
        unwind,
      );

      expect(unwind.statusCode).toBe(200);
      const { jobId } = jsonOf(unwind);
      expect(jobId).toMatch(JOB_ID_RE);
      await flushMicrotasks(30);
      expect(relayUnwindMint).toHaveBeenCalledTimes(1);
      expect(harness.jobs.get(jobId)).toMatchObject({
        status: "error",
        steps: [
          expect.objectContaining({
            status: "error",
            message: "internal error",
          }),
        ],
      });
      expect(JSON.stringify(harness.jobs.get(jobId))).not.toContain(
        rawFailure,
      );
      expect(JSON.stringify(harness.jobs.get(jobId))).not.toContain(
        "iris.private",
      );
      expect(consoleError).toHaveBeenCalled();
      harness.events.length = 0;
      const jobGet = vi.spyOn(harness.jobs, "get");

      const existing = await postProtected(
        harness,
        "/status",
        { jobId },
        CAPABILITY,
      );
      const unknown = await postProtected(
        harness,
        "/status",
        { jobId: UNKNOWN_JOB_ID },
        CAPABILITY,
      );
      expect(existing.res.statusCode).toBe(400);
      expect(existing.json).toEqual({ error: "unsupported status identity" });
      expect(unknown.res.statusCode).toBe(400);
      expect(unknown.res.body).toBe(existing.res.body);
      expect(existing.res.body).not.toContain("internal error");
      expect(existing.res.body).not.toContain("iris.private");
      expect(existing.res.body).not.toContain(jobId);
      expect(unknown.res.body).not.toContain(UNKNOWN_JOB_ID);
      expect(jobGet).not.toHaveBeenCalled();
      jobGet.mockRestore();
      expect(harness.events).not.toContain("store:get");
      expect(harness.buildFarm).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes ordinary post-attach farm failure in authenticated status without losing immutable association context", async () => {
    const rawFailure = `private rpc ${SESSION_KEY} https://internal.example`;
    const harness = makeRouteHarness({
      sanitizeErrors: true,
      farmImplementation: async () => {
        throw new Error(rawFailure);
      },
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const body = routeBody();
    try {
      seedActiveMandate(harness, body);
      const jobId = await queueIntent(harness, body, {
        allocations: [routeAllocations()[0]],
      });
      const attached = await postProtected(
        harness,
        "/farm/attach",
        attachBody(jobId, body, "burn-sanitized-failure"),
      );
      expect(attached.res.statusCode).toBe(200);
      await vi.waitFor(() =>
        expect(harness.jobs.get(jobId)).toMatchObject({ status: "error" }),
      );

      const status = await postProtected(harness, "/status", {
        mandateId: MANDATE_ID,
        jobId,
      });
      expect(status.res.statusCode).toBe(200);
      expect(status.json).toMatchObject({
        status: "error",
        runId: "run-42",
        bridgeAgent: "bridge-agent-1",
        grantTxHash: "grant-1",
      });
      expect(status.json).not.toHaveProperty('steps');
      expect(status.res.body).not.toContain('internal error');
      expect(status.res.body).not.toContain(rawFailure);
      expect(status.res.body).not.toContain("internal.example");
      expectPrivateMaterialAbsent(status.res.body, body);
    } finally {
      consoleError.mockRestore();
    }
  });
});
