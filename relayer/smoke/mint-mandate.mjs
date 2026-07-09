// Owner-side mandate ceremony — generates SMOKE_SESSION_APPROVAL for the smoke runs WITHOUT
// needing the full SP3 passkey wallet. Ported from the owner half of
// spikes/smart-sessions/session-test.mjs buildClients() (proven on Base Sepolia, spikes/SP0-GATE.md):
// an ECDSA sudo owner approves an ephemeral session key by ADDRESS ONLY, scoping it with a
// @zerodev/permissions Call Policy, then serializes the account. The session key (SMOKE_SESSION_PRIVKEY)
// later reconstructs this same account and is the only thing that signs userOps.
//
// The policy allowlists EXACTLY the calls the two smoke flows make against real contracts:
//   - USDC.approve            (deposit pulls USDC via transferFrom; burn approves TokenMessenger)
//   - <pool>.approve          (withdraw pulls shares via redeem — ERC-4626 share is an ERC-20)
//   - YieldRouter.deposit
//   - YieldRouter.withdraw
//   - TokenMessengerV2.depositForBurnWithHook
// args are all null (no per-argument constraint) — this is a testnet smoke, not the production mandate.
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
import deployments from '../../deployments/base-sepolia.json' with { type: 'json' };

const ENTRY_POINT = getEntryPoint('0.7');
const KERNEL_VERSION = KERNEL_V3_1;

const E = process.env;
const need = (k) => { if (!E[k] || /FILL_ME/.test(E[k])) throw new Error(`env ${k} missing/unfilled`); return E[k]; };
const hexKey = (v) => (v.startsWith('0x') ? v : `0x${v}`);

const APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }],
}];
const DEPOSIT_ABI = [{
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [{ name: 'pool', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'minShares', type: 'uint256' }],
  outputs: [{ name: 'shares', type: 'uint256' }],
}];
const WITHDRAW_ABI = [{
  type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
  inputs: [{ name: 'pool', type: 'address' }, { name: 'shares', type: 'uint256' }, { name: 'minAssets', type: 'uint256' }],
  outputs: [{ name: 'assets', type: 'uint256' }],
}];
const BURN_WITH_HOOK_ABI = [{
  type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' },
  ], outputs: [{ type: 'uint64' }],
}];

async function main() {
  const projectId = need('ZERODEV_PROJECT_ID');
  const ownerKey = hexKey(E.SMOKE_OWNER_PRIVKEY?.trim() || need('RELAYER_BASE_PRIVKEY'));
  const sessionKey = hexKey(need('SMOKE_SESSION_PRIVKEY'));
  const yieldRouter = need('YIELD_ROUTER_ADDRESS');
  const rpcUrl = E.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const pool = deployments.yieldRouter.allowedPools[0];

  for (const [label, addr] of [['YIELD_ROUTER_ADDRESS', yieldRouter], ['pool', pool], ['USDC', BASE_SEPOLIA.usdc], ['TokenMessengerV2', BASE_SEPOLIA.tokenMessengerV2]]) {
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

  const callPolicy = toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions: [
      { target: BASE_SEPOLIA.usdc, valueLimit: 0n, abi: APPROVE_ABI, functionName: 'approve', args: [null, null] },
      { target: pool, valueLimit: 0n, abi: APPROVE_ABI, functionName: 'approve', args: [null, null] },
      { target: yieldRouter, valueLimit: 0n, abi: DEPOSIT_ABI, functionName: 'deposit', args: [null, null, null] },
      { target: yieldRouter, valueLimit: 0n, abi: WITHDRAW_ABI, functionName: 'withdraw', args: [null, null, null] },
      { target: BASE_SEPOLIA.tokenMessengerV2, valueLimit: 0n, abi: BURN_WITH_HOOK_ABI, functionName: 'depositForBurnWithHook', args: [null, null, null, null, null, null, null, null] },
    ],
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
