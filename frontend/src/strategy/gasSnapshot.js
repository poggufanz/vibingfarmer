// gasSnapshot.js
// Fee snapshot node for the /strategy DAG. On Stellar the autonomous deposit is
// fee-bumped by the relayer (the user signs nothing and pays no gas), so there is
// no user-facing gas price to read — unlike the EVM path which read Stellar
// fee data. Report a sponsored snapshot the DAG + UI can render without a chain call.

/**
 * @returns {Promise<{ gwei:number, level:'normal', sponsored:true }>}
 */
export async function fetchGasSnapshot() {
  // ponytail: relayer pays the fee; nothing to read on-chain. level:'normal' keeps the
  // existing { gwei, level } shape (deriveSignals + the DAG gas node) working unchanged.
  return { gwei: 0, level: 'normal', sponsored: true }
}
