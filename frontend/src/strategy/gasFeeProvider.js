// frontend/src/strategy/gasFeeProvider.js
// One responsibility: produce a fresh { maxFeePerGas, at } from the RPC provider.
// The submitGate consumes `at` for freshness and `maxFeePerGas` for the economic
// check. Refresh immediately before each submit window — never reuse a stale one.
//
// Distinct from ./gasSnapshot.js (fetchGasSnapshot), which classifies network
// congestion (normal/elevated/high) for the strategy DAG. This module is a
// stateful fee-data provider feeding the pre-submit circuit breaker.
export function createGasSnapshotProvider({ provider, now = () => Date.now() }) {
  let last = null;

  async function refresh() {
    const fee = await provider.getFeeData(); // ethers v6: { maxFeePerGas, ... }
    last = { maxFeePerGas: fee.maxFeePerGas, at: now() };
    return last;
  }

  return { refresh, current: () => last };
}
