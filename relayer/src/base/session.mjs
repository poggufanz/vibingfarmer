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

export const ENTRY_POINT = getEntryPoint('0.7');
export const KERNEL_VERSION = KERNEL_V3_1;

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
