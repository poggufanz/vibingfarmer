// Idempotent CCTP watcher: given a burn txHash, polls Iris and submits the destination mint
// EXACTLY ONCE per execId, no matter how many times relayMint is called (dedupe via `store`).
// Direction (forward: Stellar->Base vs reverse: Base->Stellar) is inferred from sourceDomain —
// this app's corridor only ever has two source domains. relayMint({sourceDomain, burnTxHash,
// execId, expectation}) always forwards an expectation to Iris (Task 7): the caller's immutable
// expectation when supplied, otherwise a fail-closed route-scope skeleton that can never match
// a real burn.

import { pollAttestation as defaultPollAttestation } from './iris.mjs';
import { mintBase as defaultMintBase } from './forward.mjs';
import { mintAndForwardStellar as defaultMintAndForwardStellar } from './reverse.mjs';

/**
 * @param {Object} config
 * @param {Object} config.store - createFileStore/createMemoryStore instance
 * @param {string} config.irisUrl
 * @param {{stellar:number, base:number}} config.domains - CCTP_DOMAIN
 * @param {Object} config.base - { publicClient, walletClient, messageTransmitterAddress }
 * @param {Object} config.stellar - { server, kp, sourcePub, passphrase, forwarderAddress }
 * @param {Function} [config.pollAttestationFn]
 * @param {Function} [config.mintBaseFn]
 * @param {Function} [config.mintAndForwardStellarFn]
 */
export function createWatcher(config) {
  const {
    store, irisUrl, domains, base, stellar,
    pollAttestationFn = defaultPollAttestation,
    mintBaseFn = defaultMintBase,
    mintAndForwardStellarFn = defaultMintAndForwardStellar,
  } = config;

  // Fail-closed fallback (Task 7): Iris must always be polled with an expectation. Until Task 8
  // threads the caller's immutable expectation end-to-end, a route-scope skeleton is forwarded —
  // it carries no identities/amounts, so the strict matcher can never match a real burn against
  // it and nothing mints unverified.
  function routeExpectation(sourceDomain) {
    if (sourceDomain === domains.stellar) {
      return {
        version: 1, direction: 'stellar-to-base',
        sourceDomain: domains.stellar, destinationDomain: domains.base,
      };
    }
    if (sourceDomain === domains.base) {
      return {
        version: 1, direction: 'base-to-stellar',
        sourceDomain: domains.base, destinationDomain: domains.stellar,
      };
    }
    throw new Error(`relayMint: unrecognized sourceDomain ${sourceDomain}`);
  }

  async function relayMint({ sourceDomain, burnTxHash, execId, expectation }) {
    const existing = store.get(execId);
    if (existing && existing.status === 'minted') {
      return { status: 'already-minted', mintTxHash: existing.mintTxHash };
    }

    const scopedExpectation = expectation ?? routeExpectation(sourceDomain);
    store.set(execId, { status: 'pending', sourceDomain, burnTxHash, expectation: scopedExpectation });

    const { message, attestation } = await pollAttestationFn({
      irisUrl, sourceDomain, txHash: burnTxHash, expectation: scopedExpectation,
    });

    let mintTxHash;
    if (sourceDomain === domains.stellar) {
      // forward leg: Stellar burned -> mint on Base
      const result = await mintBaseFn({
        walletClient: base.walletClient, publicClient: base.publicClient,
        messageTransmitterAddress: base.messageTransmitterAddress, message, attestation,
      });
      mintTxHash = result.hash;
    } else if (sourceDomain === domains.base) {
      // reverse leg: Base burned -> mint_and_forward on Stellar
      mintTxHash = await mintAndForwardStellarFn({
        server: stellar.server, kp: stellar.kp, sourcePub: stellar.sourcePub,
        passphrase: stellar.passphrase, forwarderAddress: stellar.forwarderAddress,
        message, attestation,
      });
    } else {
      throw new Error(`relayMint: unrecognized sourceDomain ${sourceDomain}`);
    }

    store.set(execId, { status: 'minted', sourceDomain, burnTxHash, mintTxHash });
    return { status: 'minted', mintTxHash };
  }

  /**
   * Re-drives any record left 'pending' (attestation completed after we stopped polling, or
   * the process restarted mid-flight) by calling relayMint again — safe because relayMint
   * itself is idempotent and re-polls from scratch.
   */
  async function sweepStuck() {
    const all = store.all();
    const redriven = [];
    for (const [execId, record] of Object.entries(all)) {
      if (record.status === 'pending') {
        await relayMint({
          sourceDomain: record.sourceDomain, burnTxHash: record.burnTxHash, execId,
          expectation: record.expectation,
        });
        redriven.push(execId);
      }
    }
    return { redriven };
  }

  return { relayMint, sweepStuck };
}
