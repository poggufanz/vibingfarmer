// frontend/src/agents/exitExecutor.js
// Autonomous exit executor. Signs and submits scoped exit transactions.

import { rpcServer, buildInvokeTx } from '../stellar/client.js';
import { SOROBAN_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS, NETWORK_PASSPHRASE } from '../stellar/config.js';
import { getRelayerAddress, submitViaRelay } from '../stellar/relay.js';
import { readVaultShares } from '../stellar/agentDeposit.js';
import { loadExitKey } from '../wallet/exitKey.js';

let _sdk = null;
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk');
  return _sdk;
}

const AUTH_TTL_LEDGERS = 360;

/**
 * Sign every auth entry credentialed to `agentAddress` with the exit key (using tag 1).
 */
export async function signAgentExitEntries({ tx, exitKeypair, validUntilLedger, agentAddress }) {
  const { xdr, hash, Address } = await sdk();
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE));
  const wantScAddress = Address.fromString(agentAddress).toScAddress().toXDR('base64');

  for (const op of tx.operations) {
    const entries = op.auth || []
    for (const entry of entries) {
      if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue;
      const creds = entry.credentials().address();
      if (creds.address().toXDR('base64') !== wantScAddress) continue; // not this agent

      creds.signatureExpirationLedger(validUntilLedger);
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: creds.nonce(),
          signatureExpirationLedger: validUntilLedger,
          invocation: entry.rootInvocation(),
        })
      );
      const payload = hash(preimage.toXDR());
      
      // Sign and prepend Tag 1 (1 byte) for Exit Signer!
      const rawSig = exitKeypair.sign(new Uint8Array(payload));
      const sigWithTag = new Uint8Array(65);
      sigWithTag[0] = 1; // Tag 1 = exit key signature
      sigWithTag.set(rawSig, 1);

      creds.signature(xdr.ScVal.scvBytes(Buffer.from(sigWithTag)));
    }
  }
  return { xdr: tx.toEnvelope().toXDR('base64') };
}

/**
 * Build the double-operation exit transaction: redeem then transfer.
 */
export async function buildAgentExit({ agentAddress, ownerAddress, shares, relayer, exitKeypair, server }) {
  const s = server || (await rpcServer());
  const { Contract, TransactionBuilder, BASE_FEE } = await sdk();

  const account = await s.getAccount(relayer);
  const vaultContract = new Contract(SOROBAN_VAULT_ADDRESS);
  const tokenContract = new Contract(SOROBAN_TOKEN_ADDRESS);

  // args shape:
  // redeem(from, shares)
  // transfer(from, to, amount)
  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(vaultContract.call('redeem', agentAddress, shares))
    .addOperation(tokenContract.call('transfer', agentAddress, ownerAddress, shares))
    .setTimeout(60);

  const prepared = await s.prepareTransaction(txBuilder.build());
  const latest = await s.getLatestLedger();
  const validUntilLedger = latest.sequence + AUTH_TTL_LEDGERS;

  return signAgentExitEntries({ tx: prepared, exitKeypair, validUntilLedger, agentAddress });
}

/**
 * Run the autonomous exit using the scoped exit key.
 * @param {{ agentAddress:string, ownerAddress:string, server?:object }} p
 * @returns {Promise<{ hash:string, status:string }>}
 */
export async function runAutonomousExit({ agentAddress, ownerAddress, server }) {
  const exitKeyData = loadExitKey(agentAddress);
  if (!exitKeyData) {
    throw new Error('No exit key authorized for this agent');
  }

  const s = server || (await rpcServer());
  const { Keypair } = await sdk();
  const exitKeypair = Keypair.fromSecret(exitKeyData.secret);

  // 1. Fetch current vault shares
  const shares = await readVaultShares(agentAddress, { server: s });
  if (!shares || shares <= 0n) {
    throw new Error('No vault shares to exit');
  }

  // 2. Fetch relayer address
  const relayer = await getRelayerAddress();
  if (!relayer) {
    throw new Error('No relayer configured');
  }

  // 3. Build and sign
  const { xdr } = await buildAgentExit({
    agentAddress,
    ownerAddress,
    shares,
    relayer,
    exitKeypair,
    server: s
  });

  // 4. Submit via relayer
  return submitViaRelay({ xdr });
}
