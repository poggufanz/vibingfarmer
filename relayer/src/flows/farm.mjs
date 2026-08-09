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
  async function recoverDeposits({ approval, children, onCheckpoint }) {
    if (!Array.isArray(children) || typeof onCheckpoint !== 'function') {
      throw farmError('FARM_RECOVERY_VALIDATION', 'deposit recovery requires children and durable checkpoints');
    }
    const results = [];
    let holdLater = false;
    for (const child of children) {
      const { allocation, recovery } = child || {};
      if (recovery?.phase === 'base_deposit' && recovery.state === 'confirmed') {
        results.push({
          identity: allocation.identity,
          allocationId: allocation.identity.allocationId,
          pool: allocation.pool,
          status: 'fulfilled',
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          recovered: true,
        });
        continue;
      }
      if (holdLater) {
        results.push({
          identity: allocation.identity,
          allocationId: allocation.identity.allocationId,
          pool: allocation.pool,
          status: 'held',
          reasonCode: 'not_dispatched_after_unknown',
          executionStatus: 'held',
          custody: { location: 'agent' },
        });
        continue;
      }
      if (recovery?.phase === 'base_deposit' && recovery.state === 'submitted') {
        try {
          const result = await orchestrator.reconcileSubmittedDeposit(
            approval, allocation, recovery.evidence?.userOpHash, { onCheckpoint },
          );
          results.push(result);
        } catch (reason) {
          holdLater = true;
          results.push({
            identity: allocation.identity,
            allocationId: allocation.identity.allocationId,
            pool: allocation.pool,
            status: 'uncertain',
            reason,
            reasonCode: 'submitted_reconciliation_ambiguous',
            executionStatus: 'unknown',
            custody: { location: 'agent' },
          });
        }
        continue;
      }
      if (recovery?.phase === 'cctp_mint' && recovery.state === 'confirmed') {
        const [result] = await orchestrator.dispatchDeposits(approval, [allocation], {
          onCheckpoint,
        });
        results.push(result);
        if (result?.status === 'uncertain') holdLater = true;
        continue;
      }
      holdLater = recovery?.phase === 'base_deposit'
        && (recovery.state === 'submitting' || recovery.state === 'unknown');
      results.push({
        identity: allocation.identity,
        allocationId: allocation.identity.allocationId,
        pool: allocation.pool,
        status: recovery?.state === 'unknown' || recovery?.state === 'submitting'
          ? 'uncertain' : 'held',
        reasonCode: `recovery_${recovery?.state || 'missing'}`,
        executionStatus: recovery?.state === 'unknown' || recovery?.state === 'submitting'
          ? 'unknown' : 'held',
        custody: { location: 'agent' },
      });
    }
    return results;
  }

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
    onDepositCheckpoint = null,
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
    if (onMintConfirmed) {
      const evidence = typeof watcher.getRecoveryEvidence === 'function'
        ? watcher.getRecoveryEvidence(execId) : null;
      await onMintConfirmed(evidence ? { ...mintResult, evidence } : mintResult);
    }
    // dispatchDeposits preserves allocationId and emits custody separately from executionStatus;
    // the reporter consumes that explicit evidence and never infers custody from fulfilled/rejected.
    const depositResults = await orchestrator.dispatchDeposits(approval, allocations, {
      onCheckpoint: onDepositCheckpoint,
    });
    return { mintResult, depositResults, runId, bridgeAgent, grantTxHash };
  }

  return { farm, recoverDeposits };
}
