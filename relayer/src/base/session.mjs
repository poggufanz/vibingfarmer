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
import {
  CANONICAL_BASE_MANDATE_POLICY,
  deriveSessionAddress,
  isStellarStrKey,
  MAX_CALL_CAP_UNITS,
  validateCanonicalMandate,
} from './canonicalMandate.mjs';

export const ENTRY_POINT = getEntryPoint('0.7');
export const KERNEL_VERSION = KERNEL_V3_1;
export { deriveSessionAddress, isStellarStrKey, MAX_CALL_CAP_UNITS };

/**
 * The Step-2 gate: every check that must pass BEFORE a session private key is stored, and again
 * BEFORE it is ever handed to reconstructSessionClient / a userOp is sent — derive+compare the
 * session address, decode+compare the approval's own kernel, validate its embedded policy, and
 * require a checksum-valid Stellar owner. Never throws on adversarial/malformed input
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
  permissionId,
  validUntilSeconds,
  expiresAt = validUntilSeconds,
  relayerOrigin,
  bindingId,
  bindingHash,
  config = {
    publicOrigin: relayerOrigin,
    base: { chain: { id: CANONICAL_BASE_MANDATE_POLICY.chainId }, mandatePolicy: CANONICAL_BASE_MANDATE_POLICY },
  },
  now = Math.floor(Date.now() / 1000),
}) {
  const result = validateCanonicalMandate({
    serializedApproval,
    sessionPrivateKey,
    sessionKeyAddress,
    stellarOwner,
    kernelAddress,
    permissionId,
    validUntilSeconds,
    expiresAt,
    relayerOrigin,
    bindingId,
    bindingHash,
    config,
    now,
  });
  return result.ok
    ? { ok: true, derivedSessionAddress: result.mandate.sessionKeyAddress, mandate: result.mandate }
    : { ok: false, reason: result.reason, code: result.code };
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
