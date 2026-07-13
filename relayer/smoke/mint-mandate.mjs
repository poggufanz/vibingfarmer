// Owner-side mandate ceremony — generates SMOKE_SESSION_APPROVAL for the smoke farm WITHOUT
// needing the full SP3 passkey wallet. Ported from the owner half of
// spikes/smart-sessions/session-test.mjs buildClients() (proven on Base Sepolia, spikes/SP0-GATE.md):
// an ECDSA sudo owner approves an ephemeral session key by ADDRESS ONLY, scoping it with a
// @zerodev/permissions Call + Timestamp policies, then serializes the account. The session key
// (SMOKE_SESSION_PRIVKEY) later reconstructs this same account and is the only thing that signs
// userOps.
//
// This mints the ordinary FARM mandate only. Its policy is the production two-call shape:
// canonical USDC.approve(spender = YieldRouter, amount <= farm cap), then
// YieldRouter.deposit(pool, amount <= farm cap, minShares). It deliberately cannot approve any
// other spender or authorize the reverse/unwind flow.
//
// SP3 replaces the ECDSA owner here with the user's passkey signer; the session/policy shape is identical.
// Run: cd relayer && node --env-file=.dev.vars smoke/mint-mandate.mjs

import { http, createPublicClient, isAddress } from 'viem';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { createKernelAccount, addressToEmptyAccount } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toPermissionValidator, serializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion } from '@zerodev/permissions/policies';
import { BASE_SEPOLIA } from '../src/cctp/constants.mjs';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from '../src/base/orchestrator.mjs';
import { buildFarmPermissions } from '../../frontend/src/base/policyEngine.js';
import deployments from '../../deployments/base-sepolia.json' with { type: 'json' };

const ENTRY_POINT = getEntryPoint('0.7');
const KERNEL_VERSION = KERNEL_V3_1;

const need = (env, k) => { if (!env[k] || /FILL_ME/.test(env[k])) throw new Error(`env ${k} missing/unfilled`); return env[k]; };
const hexKey = (v) => (v.startsWith('0x') ? v : `0x${v}`);
const SMOKE_FARM_CAP = 1_000_000n; // smoke-farm.mjs deposits exactly 1.0 Base USDC (6dp)
const SMOKE_MANDATE_TTL_SECONDS = 3600;

const DEFAULT_DEPS = {
  http,
  createPublicClient,
  isAddress,
  privateKeyToAccount,
  createKernelAccount,
  addressToEmptyAccount,
  signerToEcdsaValidator,
  toPermissionValidator,
  serializePermissionAccount,
  toECDSASigner,
  toCallPolicy,
  toTimestampPolicy,
};

export async function main({ env = process.env, nowSeconds = Math.floor(Date.now() / 1000), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const projectId = need(env, 'ZERODEV_PROJECT_ID');
  const ownerKey = hexKey(env.SMOKE_OWNER_PRIVKEY?.trim() || need(env, 'RELAYER_BASE_PRIVKEY'));
  const sessionKey = hexKey(need(env, 'SMOKE_SESSION_PRIVKEY'));
  const yieldRouter = need(env, 'YIELD_ROUTER_ADDRESS');
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const pool = deployments.yieldRouter.allowedPools[0];

  for (const [label, addr] of [['YIELD_ROUTER_ADDRESS', yieldRouter], ['pool', pool], ['USDC', BASE_SEPOLIA.usdc]]) {
    if (!d.isAddress(addr)) throw new Error(`${label}="${addr}" is not a valid address`);
  }

  const publicClient = d.createPublicClient({ chain: baseSepolia, transport: d.http(rpcUrl) });

  // Owner = ECDSA sudo validator (SP3 swaps this for the passkey signer).
  const ownerSigner = d.privateKeyToAccount(ownerKey);
  const ecdsaValidator = await d.signerToEcdsaValidator(publicClient, {
    signer: ownerSigner, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION,
  });

  // Approve the session key by ADDRESS ONLY — the owner never touches the session private key.
  const sessionAddress = d.privateKeyToAccount(sessionKey).address;
  const emptySessionKeySigner = await d.toECDSASigner({ signer: d.addressToEmptyAccount(sessionAddress) });

  const permissions = buildFarmPermissions({
    pools: [{ pool, cap: SMOKE_FARM_CAP }],
    yieldRouterAbi: YIELD_ROUTER_ABI,
    usdcAbi: APPROVE_ABI,
    yieldRouterAddress: yieldRouter,
    usdcAddress: BASE_SEPOLIA.usdc,
  });
  const callPolicy = d.toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions,
  });
  const validUntil = nowSeconds + SMOKE_MANDATE_TTL_SECONDS;
  const timestampPolicy = d.toTimestampPolicy({ validAfter: 0, validUntil });

  const permissionPlugin = await d.toPermissionValidator(publicClient, {
    entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION,
    signer: emptySessionKeySigner, policies: [callPolicy, timestampPolicy],
  });

  const ownerSideAccount = await d.createKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION,
    plugins: { sudo: ecdsaValidator, regular: permissionPlugin },
  });

  const approval = await d.serializePermissionAccount(ownerSideAccount);

  console.log('\n=== SMOKE mandate generated ===');
  console.log('Smart account (mint recipient + deposit caller):', ownerSideAccount.address);
  console.log('Session key address (scoped signer):            ', sessionAddress);
  console.log('Owner (sudo):                                   ', ownerSigner.address);
  console.log('Farm mandate expires (unix seconds):           ', validUntil);
  console.log('\nPaste this line into relayer/.dev.vars:\n');
  console.log(`SMOKE_SESSION_APPROVAL=${approval}`);

  return { approval, ownerSideAccount, ownerSigner, sessionAddress, validUntil };
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((e) => { console.error('MANDATE FAILED:', e?.message || e); process.exitCode = 1; });
}
