// Owner-side mandate ceremony — generates SMOKE_SESSION_APPROVAL for the smoke farm WITHOUT
// needing the full SP3 passkey wallet. Ported from the owner half of
// spikes/smart-sessions/session-test.mjs buildClients() (proven on Base Sepolia, spikes/SP0-GATE.md):
// an ECDSA sudo owner approves an ephemeral session key by ADDRESS ONLY, scoping it with a
// @zerodev/permissions Call Policy, then serializes the account. The session key (SMOKE_SESSION_PRIVKEY)
// later reconstructs this same account and is the only thing that signs userOps.
//
// This mints the ordinary FARM mandate only. Its policy is the production two-call shape:
// canonical USDC.approve(spender = YieldRouter, amount <= farm cap), then
// YieldRouter.deposit(pool, amount <= farm cap, minShares). It deliberately cannot approve any
// other spender or authorize the reverse/unwind flow.
//
// SP3 replaces the ECDSA owner here with the user's passkey signer; the session/policy shape is identical.
// Run: cd relayer && node --env-file=.dev.vars smoke/mint-mandate.mjs

import { http, createPublicClient, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { createKernelAccount, addressToEmptyAccount } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toPermissionValidator, serializePermissionAccount } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toCallPolicy, CallPolicyVersion } from '@zerodev/permissions/policies';
import { BASE_SEPOLIA } from '../src/cctp/constants.mjs';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from '../src/base/orchestrator.mjs';
import { buildFarmPermissions } from '../../frontend/src/base/policyEngine.js';
import deployments from '../../deployments/base-sepolia.json' with { type: 'json' };

const ENTRY_POINT = getEntryPoint('0.7');
const KERNEL_VERSION = KERNEL_V3_1;

const E = process.env;
const need = (k) => { if (!E[k] || /FILL_ME/.test(E[k])) throw new Error(`env ${k} missing/unfilled`); return E[k]; };
const hexKey = (v) => (v.startsWith('0x') ? v : `0x${v}`);
const SMOKE_FARM_CAP = 1_000_000n; // smoke-farm.mjs deposits exactly 1.0 Base USDC (6dp)

async function main() {
  const projectId = need('ZERODEV_PROJECT_ID');
  const ownerKey = hexKey(E.SMOKE_OWNER_PRIVKEY?.trim() || need('RELAYER_BASE_PRIVKEY'));
  const sessionKey = hexKey(need('SMOKE_SESSION_PRIVKEY'));
  const yieldRouter = need('YIELD_ROUTER_ADDRESS');
  const rpcUrl = E.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const pool = deployments.yieldRouter.allowedPools[0];

  for (const [label, addr] of [['YIELD_ROUTER_ADDRESS', yieldRouter], ['pool', pool], ['USDC', BASE_SEPOLIA.usdc]]) {
    if (!isAddress(addr)) throw new Error(`${label}="${addr}" is not a valid address`);
  }

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  // Owner = ECDSA sudo validator (SP3 swaps this for the passkey signer).
  const ownerSigner = privateKeyToAccount(ownerKey);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerSigner, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION,
  });

  // Approve the session key by ADDRESS ONLY — the owner never touches the session private key.
  const sessionAddress = privateKeyToAccount(sessionKey).address;
  const emptySessionKeySigner = await toECDSASigner({ signer: addressToEmptyAccount(sessionAddress) });

  const permissions = buildFarmPermissions({
    pools: [{ pool, cap: SMOKE_FARM_CAP }],
    yieldRouterAbi: YIELD_ROUTER_ABI,
    usdcAbi: APPROVE_ABI,
    yieldRouterAddress: yieldRouter,
    usdcAddress: BASE_SEPOLIA.usdc,
  });
  const callPolicy = toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions,
  });

  const permissionPlugin = await toPermissionValidator(publicClient, {
    entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION,
    signer: emptySessionKeySigner, policies: [callPolicy],
  });

  const ownerSideAccount = await createKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION,
    plugins: { sudo: ecdsaValidator, regular: permissionPlugin },
  });

  const approval = await serializePermissionAccount(ownerSideAccount);

  console.log('\n=== SMOKE mandate generated ===');
  console.log('Smart account (mint recipient + deposit caller):', ownerSideAccount.address);
  console.log('Session key address (scoped signer):            ', sessionAddress);
  console.log('Owner (sudo):                                   ', ownerSigner.address);
  console.log('\nPaste this line into relayer/.dev.vars:\n');
  console.log(`SMOKE_SESSION_APPROVAL=${approval}`);
}

main().catch((e) => { console.error('MANDATE FAILED:', e?.message || e); process.exitCode = 1; });
