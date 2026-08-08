// Deposit -> Farm flow: given a user-signed Stellar burn txHash AND the immutable canonical
// CCTP expectation for that burn, relay the mint onto Base, then fan the bridged USDC out
// across pools via the session-key swarm. Composes watcher + orchestrator; holds no signing
// key of its own beyond what those configs already bind.
//
// Task 8 (plan mismatch #3): the expectation is mandatory and forwarded verbatim into
// relayMint — without it the flow refuses to call the watcher at all (RELAY_VALIDATION).
// Deposits dispatch ONLY on confirmed mint evidence ('minted' / 'already-minted'); any other
// watcher shape — in-progress join, pending attestation, retained submission, blocked,
// uncertain — is never mint evidence and aborts with FARM_MINT_UNCONFIRMED before any user
// funds move.

function farmError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createFarmFlow({ watcher, orchestrator, domains }) {
  /**
   * @param {Object} params
   * @param {string} params.burnTxHash - the user's already-submitted Stellar deposit_for_burn tx
   * @param {string} params.execId - stable id for idempotency (e.g. derived from burnTxHash)
   * @param {string} params.approval - serialized session approval (SP3 mandate)
   * @param {Object} params.expectation - immutable canonical CCTP burn expectation (task-8 schema)
   * @param {{allocationId:string, pool:string, amount:bigint, minShares:bigint,
   *   reportAmount:{token:string,units:string,decimals:number}, proxyTarget:string}[]} params.allocations
   * @param {string|null} [params.runId] - My Money's durable per-run identifier; opaque here,
   *   echoed straight through onto the result so httpRouter.mjs can carry it onto the job record.
   * @param {string|null} [params.bridgeAgent] - the Stellar bridge-agent address for this run
   * @param {string|null} [params.grantTxHash] - the funding_router grant tx this run spent from
   * @param {Function|null} [params.onMintConfirmed] - fires only with CONFIRMED mint evidence
   */
  async function farm({
    burnTxHash,
    execId,
    approval,
    expectation,
    allocations,
    runId = null,
    bridgeAgent = null,
    grantTxHash = null,
    onMintConfirmed = null,
  }) {
    if (expectation === undefined || expectation === null) {
      throw farmError('RELAY_VALIDATION', 'farm requires the immutable canonical CCTP burn expectation');
    }
    const mintResult = await watcher.relayMint({
      sourceDomain: domains.stellar, burnTxHash, execId, expectation,
    });
    if (mintResult?.status !== 'minted' && mintResult?.status !== 'already-minted') {
      throw farmError(
        'FARM_MINT_UNCONFIRMED',
        `destination mint is not confirmed (watcher status: ${mintResult?.status ?? 'unknown'})`,
      );
    }
    if (onMintConfirmed) await onMintConfirmed(mintResult);
    // dispatchDeposits preserves allocationId and emits custody separately from executionStatus;
    // the reporter consumes that explicit evidence and never infers custody from fulfilled/rejected.
    const depositResults = await orchestrator.dispatchDeposits(approval, allocations);
    return { mintResult, depositResults, runId, bridgeAgent, grantTxHash };
  }

  return { farm };
}
