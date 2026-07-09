// Reverse leg: Base (domain 6) burn-with-hook -> Stellar (domain 27) mint_and_forward.
// Ported from spikes/cctp-corridor/reverse.mjs (PROVEN: burn 0x828951c3... -> mint_and_forward
// ca2a0edc..., see spikes/SP0-GATE.md). hookData layout is EXACT and load-bearing: a malformed
// version reverts the Stellar mint with Error(Contract,#7313) InvalidHookVersion AND the
// burned USDC is unrecoverable (bad hookData is baked into the attested message, no on-chain
// retry — cost 1 test USDC in SP0, tx 0x7df2af34...). assertHookData MUST run before every burn.

import { Contract, TransactionBuilder, xdr, BASE_FEE, StrKey } from '@stellar/stellar-sdk';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HOOK_VERSION_OFFSET = 24;
const HOOK_LEN_OFFSET = 28;
const HOOK_STRKEY_OFFSET = 32;
const HOOK_MIN_LENGTH = 32; // 24 zero + 4 version + 4 length, strkey text follows

/**
 * Builds the CctpForwarder hookData: [zero x24][u32 version=0 BE][u32 strkey-byte-length BE]
 * [strkey as UTF-8 TEXT]. EXACT layout from circlefin/stellar-cctp message.rs, proven in
 * spikes/cctp-corridor/reverse.mjs. `strkey` is the literal "G..." (or "C...") text, NOT the
 * decoded bytes — the forwarder contract expects the human-readable StrKey string.
 */
export function buildForwarderHookData(strkey) {
  if (typeof strkey !== 'string' || strkey.length === 0) {
    throw new Error('buildForwarderHookData: strkey must be a non-empty string');
  }
  const recipientBytes = Buffer.from(strkey, 'utf8');
  const buf = Buffer.alloc(HOOK_STRKEY_OFFSET + recipientBytes.length);
  buf.writeUInt32BE(0, HOOK_VERSION_OFFSET);                 // hook version = 0
  buf.writeUInt32BE(recipientBytes.length, HOOK_LEN_OFFSET); // recipient strkey length
  recipientBytes.copy(buf, HOOK_STRKEY_OFFSET);              // recipient strkey as UTF-8 text
  return `0x${buf.toString('hex')}`;
}

/**
 * Guards every Base burn-with-hook call. Rejects anything that is not the exact
 * [zero x24][version=0][len][strkey] layout — in particular a raw 32-byte hook (the #7313
 * failure mode from SP0: a caller who forgets to wrap the recipient and passes the bare
 * 32-byte forwarder address as hookData instead of a length-prefixed strkey).
 */
export function assertHookData(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('assertHookData: not a hex string');
  }
  const buf = Buffer.from(hex.slice(2), 'hex');
  if (buf.length <= HOOK_MIN_LENGTH) {
    throw new Error(`assertHookData: too short (${buf.length} bytes) — looks like a raw address, not a length-prefixed hook`);
  }
  for (let i = 0; i < HOOK_VERSION_OFFSET; i += 1) {
    if (buf[i] !== 0) throw new Error(`assertHookData: byte ${i} of the zero-padding prefix is non-zero`);
  }
  const version = buf.readUInt32BE(HOOK_VERSION_OFFSET);
  if (version !== 0) throw new Error(`assertHookData: unsupported hook version ${version} (must be 0)`);
  const declaredLen = buf.readUInt32BE(HOOK_LEN_OFFSET);
  const actualLen = buf.length - HOOK_STRKEY_OFFSET;
  if (declaredLen !== actualLen) {
    throw new Error(`assertHookData: declared strkey length ${declaredLen} != actual ${actualLen}`);
  }
  const strkey = buf.subarray(HOOK_STRKEY_OFFSET).toString('utf8');
  if (!StrKey.isValidEd25519PublicKey(strkey) && !StrKey.isValidContract(strkey)) {
    throw new Error(`assertHookData: recipient is not a valid Stellar StrKey: ${strkey}`);
  }
}

/** Contract ("C...") StrKey -> raw 32-byte hex, for use as mintRecipient/destinationCaller. */
export function contractStrkeyToBytes32(strkey) {
  return `0x${Buffer.from(StrKey.decodeContract(strkey)).toString('hex')}`;
}

const BURN_WITH_HOOK_ABI = [{
  type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' },
  ], outputs: [{ type: 'uint64' }],
}];
const APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }],
}];

/**
 * Approves + burns Base USDC to the Stellar forwarder, with the recipient's G-address baked
 * into hookData. Validates hookData BEFORE broadcasting (assertHookData) — this is the one
 * guard that stands between a typo and permanently stranded funds.
 */
export async function burnBaseWithHook({
  walletClient, publicClient, usdcAddress, tokenMessengerV2Address,
  amount6dp, approveAmount6dp, destDomain, forwarder32, maxFee, minFinality, hookData,
}) {
  assertHookData(hookData);

  const approveHash = await walletClient.writeContract({
    address: usdcAddress, abi: APPROVE_ABI, functionName: 'approve',
    args: [tokenMessengerV2Address, approveAmount6dp],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const burnHash = await walletClient.writeContract({
    address: tokenMessengerV2Address, abi: BURN_WITH_HOOK_ABI, functionName: 'depositForBurnWithHook',
    args: [amount6dp, destDomain, forwarder32, usdcAddress, forwarder32, maxFee, minFinality, hookData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: burnHash });
  if (receipt.status !== 'success') throw new Error('burnBaseWithHook: burn reverted');
  return { hash: burnHash, status: receipt.status };
}

/**
 * Production relay action: submits the attested message to Stellar CctpForwarder.mint_and_forward.
 * Permissionless (anyone with a valid message+attestation can call it) — relayer's own Stellar
 * key pays the fee; the final recipient is whatever G-address was baked into hookData by the
 * burner, not chosen by the relayer.
 */
export async function mintAndForwardStellar({ server, kp, sourcePub, passphrase, forwarderAddress, message, attestation }) {
  const hex = (s) => Buffer.from(s.replace(/^0x/, ''), 'hex');
  const op = new Contract(forwarderAddress).call('mint_and_forward',
    xdr.ScVal.scvBytes(hex(message)),
    xdr.ScVal.scvBytes(hex(attestation)));
  const source = await server.getAccount(sourcePub);
  const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op).setTimeout(120).build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`mint_and_forward send ERROR: ${JSON.stringify(sent.errorResult ?? sent)}`);
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'NOT_FOUND') continue;
    if (got.status === 'SUCCESS') return sent.hash;
    throw new Error(`mint_and_forward FAILED: ${got.status} ${JSON.stringify(got.resultXdr ?? '')}`);
  }
  throw new Error(`mint_and_forward not confirmed: ${sent.hash}`);
}
