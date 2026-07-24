// Deposit -> Farm flow: given a user-signed Stellar burn txHash, relay the mint onto Base,
// then fan the bridged USDC out across pools via the session-key swarm. Composes watcher +
// orchestrator; holds no signing key of its own beyond what those configs already bind.

export function createFarmFlow({ watcher, orchestrator, domains }) {
  /**
   * @param {Object} params
   * @param {string} params.burnTxHash - the user's already-submitted Stellar deposit_for_burn tx
   * @param {string} params.execId - stable id for idempotency (e.g. derived from burnTxHash)
   * @param {string} params.approval - serialized session approval (SP3 mandate)
   * @param {{allocationId:string, pool:string, amount:bigint, minShares:bigint,
   *   reportAmount:{token:string,units:string,decimals:number}, proxyTarget:string}[]} params.allocations
   * @param {string|null} [params.runId] - My Money's durable per-run identifier; opaque here,
   *   echoed straight through onto the result so httpRouter.mjs can carry it onto the job record.
   * @param {string|null} [params.bridgeAgent] - the Stellar bridge-agent address for this run
   * @param {string|null} [params.grantTxHash] - the funding_router grant tx this run spent from
   */
  async function farm({ burnTxHash, execId, approval, allocations, runId = null, bridgeAgent = null, grantTxHash = null }) {
    const mintResult = await watcher.relayMint({ sourceDomain: domains.stellar, burnTxHash, execId });
    // dispatchDeposits preserves allocationId and emits custody separately from executionStatus;
    // the reporter consumes that explicit evidence and never infers custody from fulfilled/rejected.
    const depositResults = await orchestrator.dispatchDeposits(approval, allocations);
    return { mintResult, depositResults, runId, bridgeAgent, grantTxHash };
  }

  return { farm };
}
