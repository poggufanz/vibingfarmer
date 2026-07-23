// Forward leg: Stellar (domain 27) burn -> Base (domain 6) mint.
// Ported from spikes/cctp-corridor/roundtrip.mjs (PROVEN: burn 27a3914b... -> mint
// 0x5d0c577a..., see spikes/SP0-GATE.md). approveAndBurnStellar is a DEV/SMOKE helper only —
// in production the user's own Stellar passkey signs deposit_for_burn client-side (SP3); the
// relayer never holds user funds or user signing keys. mintBase is the production relay
// action: anyone holding a valid attested message can submit the destination mint, so the
// relayer's OWN Base key submits it (gas/relay identity only, not custody).

import {
  rpc, Contract, TransactionBuilder, Address, nativeToScVal, xdr, BASE_FEE,
} from '@stellar/stellar-sdk';
import { confirmStellarTx } from './stellarTx.mjs';

// EVM 0x address (20 bytes) -> left-padded 32-byte Buffer for Soroban BytesN<32>.
export function evmAddrToBytes32(addr) {
  const hex = addr.replace(/^0x/, '').toLowerCase();
  if (hex.length !== 40) throw new Error(`bad evm address ${addr}`);
  return Buffer.concat([Buffer.alloc(12), Buffer.from(hex, 'hex')]);
}

export const ZERO_BYTES32_BUFFER = Buffer.alloc(32);

// Generic Soroban invoke: re-fetches the source account each call so a retry always gets a
// fresh sequence number (matches spikes/cctp-corridor/roundtrip.mjs `invoke`).
async function invokeStellar({ server, kp, sourcePub, passphrase, op, label }) {
  const source = await server.getAccount(sourcePub);
  const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op).setTimeout(120).build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${label} send ERROR: ${JSON.stringify(sent.errorResult ?? sent)}`);
  return confirmStellarTx({ server, hash: sent.hash, label });
}

/**
 * DEV/SMOKE ONLY — simulates the user's burn signature until SP3's passkey wallet ships.
 * Never called by relayMint/farm() in the production path; production burns are user-signed
 * client-side and only the resulting txHash reaches the relayer.
 */
export async function approveAndBurnStellar({
  server, kp, sourcePub, passphrase, tokenMessengerMinter, usdcSac,
  amount7dp, allowance7dp, baseRecipient, destDomain, minFinality, maxFee,
}) {
  const latest = await server.getLatestLedger();
  const expLedger = latest.sequence + 100_000; // ~6 days at 5s/ledger
  const approveOp = new Contract(usdcSac).call('approve',
    Address.fromString(sourcePub).toScVal(),
    Address.fromString(tokenMessengerMinter).toScVal(),
    nativeToScVal(allowance7dp, { type: 'i128' }),
    nativeToScVal(expLedger, { type: 'u32' }));
  await invokeStellar({ server, kp, sourcePub, passphrase, op: approveOp, label: 'approve' });

  const burnOp = new Contract(tokenMessengerMinter).call('deposit_for_burn',
    Address.fromString(sourcePub).toScVal(),
    nativeToScVal(amount7dp, { type: 'i128' }),
    nativeToScVal(destDomain, { type: 'u32' }),
    xdr.ScVal.scvBytes(evmAddrToBytes32(baseRecipient)),
    Address.fromString(usdcSac).toScVal(),
    xdr.ScVal.scvBytes(ZERO_BYTES32_BUFFER),
    nativeToScVal(maxFee, { type: 'i128' }),
    nativeToScVal(minFinality, { type: 'u32' }));
  return invokeStellar({ server, kp, sourcePub, passphrase, op: burnOp, label: 'burn' });
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ type: 'bool' }],
}];

/**
 * Production relay action: submits the attested message to Base MessageTransmitterV2.
 * Callable by anyone holding a valid (message, attestation) pair — the relayer's own Base key
 * pays gas here; it is not moving user funds, only delivering a publicly-attested mint.
 */
export async function mintBase({ walletClient, publicClient, messageTransmitterAddress, message, attestation }) {
  const hash = await walletClient.writeContract({
    address: messageTransmitterAddress,
    abi: RECEIVE_MESSAGE_ABI,
    functionName: 'receiveMessage',
    args: [message, attestation],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status };
}
