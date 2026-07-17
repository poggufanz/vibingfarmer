// frontend/src/mergeFlowHelpers.js
// The two small decision points that wire the merged Stellar+Base flow into app.jsx: what the
// strategy step tells the strategist about Base availability, and what the dispatch step tells
// the orchestrator about the connected wallet's Base leg signer. Extracted so both are unit-
// testable without rendering the 126KB app.jsx.
import { isVfWallet } from './wallet/passkeyBridge.js'

// One place that decides what the strategy step tells the strategist about Base. Returns the
// health-check PROMISE (not its resolved value) so the ~3s relayer probe overlaps the caller's own
// concurrent work (the strategy DAG fetch) instead of serializing before it — the caller awaits
// `baseAvailable` only once it actually needs the boolean (generateStrategy does this after its
// own DAG fetch, so the two waits run in parallel).
export function resolveBaseAvailability({ checkHealth }) {
  return { baseAvailable: checkHealth() }
}

// One place that builds the orchestrator's base leg context from the connected wallet.
export function buildBaseLegContext({ connectedAddress, kitSignTransaction }) {
  if (!connectedAddress) return null
  return {
    connectedAddress,
    signTx: kitSignTransaction, // (xdr) => Promise<signedXdr> via StellarWalletsKit
    isVf: isVfWallet(connectedAddress),
  }
}
