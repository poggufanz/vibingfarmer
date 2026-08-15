// Pocket Crew My Money Task 1 (Wave 2). READ-ONLY: resolves the ledger each tracked deploy/upload
// transaction confirmed in, against LIVE testnet — Soroban RPC first (fast, but short retention),
// falling back to Horizon (full archival history) for anything outside RPC retention. Prints what
// src/stellar/agentCreatorManifest.js should pin; writes NOTHING — never touches
// deployments/stellar-testnet.json or the manifest itself. A human reads the output and pins the
// numbers by hand (see the Task 1 report for the run this produced).
//
// Run: node scripts/resolve-agent-creator-ledgers.mjs
import { rpcServer, horizonServer } from '../src/stellar/client.js'
import { readConfirmedLedger } from '../src/stellar/grant.js'

// label, tx hash (verbatim from deployments/stellar-testnet.json / its git history), and the
// ledger number agentCreatorManifest.js pins for it today. `pinned: null` means ONE of two things
// (see each entry's comment): either the manifest deliberately stays unpinned (the conservative
// ledger-1 legacy router's OWN deploy tx — coverageStartLedger stays 1 regardless of what this
// resolves to) or this script had not yet been run to produce a number to pin (not the case for
// any TARGET below anymore — every upload tx now carries its resolved+pinned ledger too).
const TARGETS = [
  {
    label: 'funding_router v2 deploy (CB675TTS…RSE)',
    hash: 'e8e145660c9923ec9433dc5e7906502ee9981977653a5b1907b34f14ead68e18',
    pinned: 3727514,
  },
  {
    label: 'agent wasm v3-bridge upload (creator: funding_router v2)',
    hash: 'c8a9bc3b434f4d65e35926dcbe28207ef909d15230c204f94f390f2fb5144451',
    pinned: 3727511,
  },
  {
    label: 'funding_router hardened v1 deploy (CCEWWRQV…CYE5)',
    hash: '826354384040f87a87c49ce714600e80c8a315ac8a9ebacecac72a75f13279e3',
    pinned: 3593274,
  },
  {
    label: 'agent wasm v3 upload (creator: funding_router hardened v1)',
    hash: 'd52f0ba0f5598b1ccf6d0036c152072f4b4cb23449f6af0e9d733850ff59b63f',
    pinned: 3593271,
  },
  {
    label: 'registry (current, derived-record ABI) deploy',
    hash: '3fdfc5e7dcc30b0145a84d6106a5956e46f3441c1f1deac8b8782015f34245b0',
    pinned: 3593289,
  },
  {
    // The only deliberately-unpinned target: agentCreatorManifest.js keeps this creator's
    // deployedLedger null / coverageStartLedger at the conservative floor (1) even though this
    // resolves fine — see the manifest's module header for why.
    label: 'funding_router legacy deploy (CBEI5VJK…NOFY) — manifest keeps deployedLedger null',
    hash: '10da369f4e5deb0178e4274a8e7da075e12a7ae085c55096a33976f7dc59b656',
    pinned: null,
  },
  {
    label: 'agent wasm v2 upload (creator: funding_router legacy)',
    hash: 'c84f563290f7d2ef459e91ce6b179f53f19a068871e3ba8071df09c7c56a44db',
    pinned: 3534437,
  },
]

async function resolveViaHorizon(txHash) {
  const horizon = await horizonServer()
  const tx = await horizon.transactions().transaction(txHash).call()
  const ledger = tx.ledger_attr ?? tx.ledger
  if (!Number.isFinite(ledger)) throw new Error('Horizon record is missing a ledger number')
  return ledger
}

/** RPC first (fast); Horizon fallback for anything the RPC no longer retains. Never guesses — an
 * unresolvable tx returns `{ledger: null}`, the honest "outside retention" state. */
async function resolveLedger(txHash, server) {
  try {
    const { confirmedLedger } = await readConfirmedLedger({ hash: txHash, server })
    return { ledger: confirmedLedger, source: 'rpc' }
  } catch (rpcErr) {
    try {
      const ledger = await resolveViaHorizon(txHash)
      return { ledger, source: 'horizon' }
    } catch (horizonErr) {
      return { ledger: null, error: `rpc: ${rpcErr.message}; horizon: ${horizonErr.message}` }
    }
  }
}

async function main() {
  const server = await rpcServer()
  let mismatched = false
  for (const t of TARGETS) {
    const { ledger, source, error } = await resolveLedger(t.hash, server)
    if (ledger == null) {
      console.log(`UNRESOLVED  ${t.label}  tx=${t.hash}\n            (${error})`)
      continue
    }
    let verdict = ''
    if (t.pinned != null) verdict = ledger === t.pinned ? ' OK (matches pinned)' : ` MISMATCH (manifest pins ${t.pinned})`
    console.log(`ledger ${ledger} [${source}]  ${t.label}  tx=${t.hash}${verdict}`)
    if (t.pinned != null && ledger !== t.pinned) mismatched = true
  }
  if (mismatched) {
    console.error(
      '\nOne or more resolved ledgers do not match the numbers pinned in agentCreatorManifest.js.'
    )
    process.exit(1)
  }
  console.log('\nAll pinned ledgers verified against live testnet.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
