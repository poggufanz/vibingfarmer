// Reconstructs a ZeroDev Kernel v3.1 session-key client from a serialized owner approval + the
// orchestrator's own session private key. Ported from the "orchestrator side" of
// spikes/smart-sessions/session-test.mjs buildClients() (proven on Base Sepolia — see
// spikes/SP0-GATE.md). The owner-side approval (mandate creation) is SP3's job — this module
// only ever RECONSTRUCTS an already-approved account from its serialized form; it never
// creates or approves policy.

import { http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createKernelAccountClient, createZeroDevPaymasterClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { deserializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { ParamCondition } from '@zerodev/permissions/policies';

export const ENTRY_POINT = getEntryPoint('0.7');
export const KERNEL_VERSION = KERNEL_V3_1;

// VF Wallet Task 7 — Step 2 owner/kernel/session binding validation. Everything below this line
// is pure (no RPC, no network) so it can run twice per request: once before a mandate is stored,
// once again before it is ever spent (dispatch time) — "validate before storing and again before
// every operation."

// Mirrors frontend/src/mergeFlowHelpers.js's MANDATE_SETUP_CAP_UNITS (10,000 USDC at 6dp,
// testnet value — see that module's comment for the mainnet-cutover note). The relayer
// re-derives this bound from the approval's OWN embedded policy rather than trusting a
// client-sent number, so a forged/downgraded client request can never widen it. Per call, not
// cumulative: nothing here sums across requests, by construction — each call is judged only
// against its own embedded/requested amount.
export const MAX_CALL_CAP_UNITS = 10_000_000_000n; // 10,000 USDC at 6dp

function sameAddress(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const STELLAR_STRKEY_RE = /^[GC][A-Z2-7]{55}$/; // shape check only — not a full StrKey CRC validation

/** True for a syntactically valid Stellar G (account) or C (contract) StrKey. */
export function isStellarStrKey(value) {
  return typeof value === 'string' && STELLAR_STRKEY_RE.test(value);
}

/** The EVM address viem's privateKeyToAccount derives for a session private key. */
export function deriveSessionAddress(sessionPrivateKey) {
  return privateKeyToAccount(sessionPrivateKey).address;
}

/**
 * Pure decode of a ZeroDev serializePermissionAccount blob: base64(JSON), bigints round-tripped
 * as strings — the exact format @zerodev/permissions/utils.js's
 * serializePermissionAccountParams/deserializePermissionAccountParams use (that helper isn't
 * part of the package's public export surface, so this is a local, minimal reimplementation of
 * the same two-line codec, not a fork of package internals). Deliberately does NOT call
 * deserializePermissionAccount (the real SDK function) — that one needs a live publicClient and
 * makes an RPC round trip; this only ever reads the plaintext the owner's device already
 * committed to, the same defensive-preflight posture as policyEngine.js's evaluateCall. It is
 * NOT a signature/authenticity check — the on-chain EntryPoint is what actually verifies the
 * approval's enable signature at execution time.
 * @param {string} serializedApproval
 * @returns {{accountAddress: string, permissions: Array<object>, validUntil: number|null}}
 */
export function decodeApproval(serializedApproval) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(serializedApproval), 'base64').toString('utf8'));
  } catch {
    throw new Error('malformed serializedApproval');
  }
  const accountAddress = parsed?.accountParams?.accountAddress;
  if (!accountAddress) throw new Error('malformed serializedApproval: missing account address');
  const policies = Array.isArray(parsed?.permissionParams?.policies) ? parsed.permissionParams.policies : [];
  const callPolicy = policies.find((p) => p?.policyParams?.type === 'call');
  const timestampPolicy = policies.find((p) => p?.policyParams?.type === 'timestamp');
  return {
    accountAddress,
    permissions: callPolicy?.policyParams?.permissions ?? [],
    validUntil: timestampPolicy?.policyParams?.validUntil ?? null,
  };
}

function findCapArg(args) {
  return (Array.isArray(args) ? args : []).find((a) => a && Number(a.condition) === ParamCondition.LESS_THAN_OR_EQUAL);
}

/**
 * Validate a DECODED approval's embedded call policy against the exact shape
 * frontend/src/base/policyEngine.js's buildFarmPermissions produces: only
 * USDC.approve(YieldRouter, <=cap) and YieldRouter.deposit(pool, <=cap, minShares) permissions,
 * each capped at or below MAX_CALL_CAP_UNITS, under an unexpired timestamp policy. Anything
 * else — a withdraw entry, a third target/function, a missing or too-high cap — fails closed.
 * Pool identity itself is unconstrained here by design (arg 0 of deposit is `null`): the pool
 * allowlist is enforced on-chain by YieldRouter.deposit's own `allowedPool`, exactly as
 * policyEngine.js's module doc explains — "nonallowlisted" at this layer means an approval whose
 * policy targets something other than the two allowed (contract, function) pairs, not a specific
 * pool address.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function validateApprovalPolicy({ permissions, validUntil, usdcAddress, yieldRouterAddress, now = Math.floor(Date.now() / 1000) }) {
  if (validUntil != null && Number(validUntil) !== 0 && now >= Number(validUntil)) {
    return { ok: false, reason: 'expired' };
  }
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return { ok: false, reason: 'approval has no call policy permissions' };
  }
  for (const perm of permissions) {
    const target = perm?.target;
    const fn = perm?.functionName;
    const isApprove = fn === 'approve' && sameAddress(target, usdcAddress);
    const isDeposit = fn === 'deposit' && sameAddress(target, yieldRouterAddress);
    if (!isApprove && !isDeposit) {
      return { ok: false, reason: `nonallowlisted contract/function: ${fn ?? 'unknown'}@${target ?? 'unknown'}` };
    }
    if (BigInt(perm.valueLimit ?? 0) !== 0n) {
      return { ok: false, reason: 'unexpected native value limit on an allowlisted call' };
    }
    const capArg = findCapArg(perm.args);
    if (!capArg) return { ok: false, reason: 'permission has no per-call cap constraint' };
    if (BigInt(capArg.value) > MAX_CALL_CAP_UNITS) {
      return { ok: false, reason: 'per-call cap exceeds the 10,000 USDC limit' };
    }
  }
  return { ok: true };
}

/**
 * The Step-2 gate: every check that must pass BEFORE a session private key is stored, and again
 * BEFORE it is ever handed to reconstructSessionClient / a userOp is sent — derive+compare the
 * session address, decode+compare the approval's own kernel, validate its embedded policy, and
 * require a syntactically valid Stellar owner. Never throws on adversarial/malformed input
 * (that's exactly what this exists to turn into a clean `{ok:false, reason}` instead of a 500).
 *
 * What this does NOT check: that `stellarOwner` is the RIGHT owner for this approval — nothing in
 * the approval blob encodes a Stellar identity (see baseBinding.js's boundary note), so that half
 * of "owner A cannot execute for owner B" is enforced by the caller's storage lookup being keyed
 * on (approval, stellarOwner, kernelAddress) together, not by this function.
 * @returns {{ok: true, derivedSessionAddress: string}|{ok: false, reason: string}}
 */
export function validateMandateBinding({
  serializedApproval,
  sessionPrivateKey,
  sessionKeyAddress,
  stellarOwner,
  kernelAddress,
  usdcAddress,
  yieldRouterAddress,
  now = Math.floor(Date.now() / 1000),
}) {
  if (!isStellarStrKey(stellarOwner)) {
    return { ok: false, reason: 'stellarOwner must be a valid Stellar G/C address' };
  }
  if (!EVM_ADDRESS_RE.test(String(kernelAddress || ''))) {
    return { ok: false, reason: 'kernelAddress must be a 0x address' };
  }

  let derivedSessionAddress;
  try {
    derivedSessionAddress = deriveSessionAddress(sessionPrivateKey);
  } catch {
    return { ok: false, reason: 'sessionPrivateKey is not a valid private key' };
  }
  if (!sameAddress(derivedSessionAddress, sessionKeyAddress)) {
    return { ok: false, reason: 'sessionKeyAddress does not match the address derived from sessionPrivateKey' };
  }

  let decoded;
  try {
    decoded = decodeApproval(serializedApproval);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!sameAddress(decoded.accountAddress, kernelAddress)) {
    return { ok: false, reason: "kernelAddress does not match the approval's own account" };
  }

  const policyCheck = validateApprovalPolicy({
    permissions: decoded.permissions, validUntil: decoded.validUntil, usdcAddress, yieldRouterAddress, now,
  });
  if (!policyCheck.ok) return policyCheck;

  return { ok: true, derivedSessionAddress };
}

/**
 * @param {Object} params
 * @param {import('viem').Chain} params.chain
 * @param {string} params.rpcUrl - plain chain RPC (viem public client transport)
 * @param {string} params.bundlerRpcUrl - ZeroDev bundler+paymaster RPC
 * @param {string} params.approval - serialized permission account (from the SP3 mandate ceremony)
 * @param {`0x${string}`} params.sessionPrivateKey - the orchestrator's held session key
 * @returns {Promise<import('@zerodev/sdk').KernelAccountClient>}
 */
export async function reconstructSessionClient({ chain, rpcUrl, bundlerRpcUrl, approval, sessionPrivateKey }) {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const sessionKeySigner = await toECDSASigner({ signer: privateKeyToAccount(sessionPrivateKey) });

  const orchestratorAccount = await deserializePermissionAccount(
    publicClient, ENTRY_POINT, KERNEL_VERSION, approval, sessionKeySigner,
  );

  const paymasterClient = createZeroDevPaymasterClient({ chain, transport: http(bundlerRpcUrl) });

  return createKernelAccountClient({
    account: orchestratorAccount,
    chain,
    bundlerTransport: http(bundlerRpcUrl),
    client: publicClient,
    paymaster: {
      getPaymasterData: (userOperation) => paymasterClient.sponsorUserOperation({ userOperation }),
    },
  });
}
