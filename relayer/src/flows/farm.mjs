// Deposit -> Farm flow: given a user-signed Stellar burn txHash, relay the mint onto Base,
// then fan the bridged USDC out across pools via the session-key swarm. Composes watcher +
// orchestrator; holds no signing key of its own beyond what those configs already bind.

export function createFarmFlow({ watcher, orchestrator, domains }) {
  /**
   * @param {Object} params
   * @param {string} params.burnTxHash - the user's already-submitted Stellar deposit_for_burn tx
   * @param {string} params.execId - stable id for idempotency (e.g. derived from burnTxHash)
   * @param {string} params.approval - serialized session approval (SP3 mandate)
   * @param {{pool:string, amount:bigint, minShares:bigint}[]} params.allocations
   */
  async function farm({ burnTxHash, execId, approval, allocations }) {
    const mintResult = await watcher.relayMint({ sourceDomain: domains.stellar, burnTxHash, execId });
    const depositResults = await orchestrator.dispatchDeposits(approval, allocations);
    return { mintResult, depositResults };
  }

  return { farm };
}
