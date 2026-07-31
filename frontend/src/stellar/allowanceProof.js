// frontend/src/stellar/allowanceProof.js
// Strategy Task 5 (Pocket Crew redesign, Wave 1). Turns a confirmed GrantReceiptV1 into a proven
// (or unproven) AllowanceExpiryProofV1 via a BOUNDED stability loop: capture the current ledger
// L1, scan owner→router approval events through L1, take a strict current-allowance read, capture
// L2, and — only when the chain moved during the check (L2 > L1) — extend the scan through L2
// before accepting anything. Proof is accepted only when the FINAL round has contiguous event
// coverage through its target ledger, the strict read agrees with the latest decoded event, and
// no approval later than the receipt's own exists. Any shortfall returns unproven; this module
// never fabricates a proof and never calls a wallet/provider/transaction builder — every chain
// read is dependency-injected so it degrades to a pure function under test.
import { hash } from '@stellar/stellar-sdk'
import { rpcServer } from './client.js'
import { readAllowanceStrict, readConfirmedLedger } from './grant.js'
import { syncApprovalEvents } from './allowanceEventStore.js'
import { canonicalizeStrategy } from '../strategy/canonicalStrategy.js'

// Fixed label, not the raw network passphrase — matches GrantReceiptV1.network (grant.js/grantReceiptStore.js).
const NETWORK_ID = 'stellar-testnet'

function sha256Hex(obj) {
  const payload = JSON.stringify(canonicalizeStrategy(obj))
  return '0x' + hash(payload).toString('hex') // hash() accepts a string directly (no Buffer needed)
}

/** Deterministic fingerprint of an AllowanceExpiryProofV1, excluding its own (self-referential)
 * `proofHash` field. */
export function computeProofHash(proof) {
  const { proofHash: _drop, ...rest } = proof
  return sha256Hex(rest)
}

async function defaultGetLatestLedger({ server }) {
  const s = server || (await rpcServer())
  const { sequence } = await s.getLatestLedger()
  return sequence
}

/** The latest-by-(ledger,eventIndex) approval among `approvals` for this owner/spender. */
function latestOf(approvals) {
  return approvals.reduce(
    (best, a) =>
      !best ||
      a.ledger > best.ledger ||
      (a.ledger === best.ledger && a.eventIndex > best.eventIndex)
        ? a
        : best,
    null
  )
}

/**
 * Scan every budgeted token's approval range through `targetLedger`. Returns per-token sync
 * results plus a single `gapFree` verdict (true only when EVERY token's scan proved contiguous
 * coverage AT LEAST through `targetLedger` — a store that reports its own gapFree=true but
 * stopped short of the target is still a gap for THIS check, e.g. a stale RPC node).
 */
async function scanAllTokens({ receipt, targetLedger, server, storage, syncEvents }) {
  const byToken = new Map()
  let gapFree = true
  for (const budget of receipt.allowanceBudgets) {
    const sync = await syncEvents({
      owner: receipt.owner,
      router: receipt.router,
      token: budget.token,
      network: NETWORK_ID,
      fromLedgerFloor: receipt.confirmedLedger,
      targetLedger,
      server,
      storage,
    })
    byToken.set(budget.token, sync)
    if (!sync.gapFree || sync.indexedThroughLedger < targetLedger) gapFree = false
  }
  return { byToken, gapFree }
}

/**
 * Prove (or fail to prove) that the receipt's own owner→router allowance still holds, unmutated,
 * for every budgeted token — via the bounded L1/L2 stability loop described above. Never rejects:
 * any unexpected failure (RPC outage, missing confirmed tx, …) resolves to `{proven:false,
 * reason:'gapped', proof:null}` rather than throwing.
 * @param {{receipt:object|null, server?:object, storage?:object, getLatestLedger?:Function,
 *          readAllowance?:Function, readConfirmedLedger?:Function, syncEvents?:Function}} p
 * @returns {Promise<{proven:boolean, reason:null|'gapped'|'mutated', proof:object|null}>}
 */
export async function proveCurrentAllowance({
  receipt,
  server,
  storage,
  getLatestLedger = defaultGetLatestLedger,
  readAllowance = readAllowanceStrict,
  readConfirmedLedger: readConfirmedLedgerFn = readConfirmedLedger,
  syncEvents = syncApprovalEvents,
}) {
  if (!receipt || !Array.isArray(receipt.allowanceBudgets) || receipt.allowanceBudgets.length === 0)
    return { proven: false, reason: 'gapped', proof: null }

  // The confirmed grant tx itself is re-read from chain — a stored receipt is an input pointer,
  // never authoritative on its own (module header). A missing/failed tx, or one whose confirmed
  // ledger/close-time disagrees with what the receipt claims (forged or corrupted locally), is
  // unproven. This is independent of the L1/L2 stability loop below (it concerns the receipt's
  // own immutable history, not "right now").
  try {
    const confirmed = await readConfirmedLedgerFn({ hash: receipt.txHash, server })
    if (confirmed.confirmedLedger !== receipt.confirmedLedger) {
      return { proven: false, reason: 'gapped', proof: null }
    }
    if (receipt.confirmedAt != null && confirmed.confirmedAt !== receipt.confirmedAt) {
      return { proven: false, reason: 'gapped', proof: null }
    }
  } catch {
    return { proven: false, reason: 'gapped', proof: null }
  }

  let L1
  try {
    L1 = await getLatestLedger({ server })
  } catch {
    return { proven: false, reason: 'gapped', proof: null }
  }
  let scan = await scanAllTokens({ receipt, targetLedger: L1, server, storage, syncEvents })

  // The strict current-allowance read for every budgeted token, capturing RPC failure distinctly
  // (readAllowanceStrict throws rather than coercing to 0 — see grant.js).
  let liveAmounts
  try {
    liveAmounts = new Map(
      await Promise.all(
        receipt.allowanceBudgets.map(async (b) => [
          b.token,
          (
            await readAllowance({
              owner: receipt.owner,
              router: receipt.router,
              token: b.token,
              server,
            })
          ).amount,
        ])
      )
    )
  } catch {
    return { proven: false, reason: 'gapped', proof: null }
  }

  let L2
  try {
    L2 = await getLatestLedger({ server })
  } catch {
    return { proven: false, reason: 'gapped', proof: null }
  }
  let boundary = L1
  if (L2 > L1) {
    boundary = L2
    scan = await scanAllTokens({ receipt, targetLedger: L2, server, storage, syncEvents })
  }
  if (!scan.gapFree) return { proven: false, reason: 'gapped', proof: null }

  const approvals = []
  let indexedFromLedger = null
  let indexedThroughLedger = null
  for (const budget of receipt.allowanceBudgets) {
    const sync = scan.byToken.get(budget.token)
    indexedFromLedger =
      indexedFromLedger == null
        ? sync.indexedFromLedger
        : Math.min(indexedFromLedger, sync.indexedFromLedger)
    indexedThroughLedger =
      indexedThroughLedger == null
        ? sync.indexedThroughLedger
        : Math.min(indexedThroughLedger, sync.indexedThroughLedger)

    // Defense-in-depth (review Minor 6): the RPC topic filter already scopes to owner+router,
    // but a decoded event that somehow does not actually belong to this owner/router — a
    // widened/wildcard filter, a future decode change, a malicious RPC — must never be silently
    // accepted just because it sorted highest by ledger/eventIndex.
    const latest = latestOf(
      sync.approvals.filter((a) => a.owner === receipt.owner && a.spender === receipt.router)
    )
    if (!latest) return { proven: false, reason: 'gapped', proof: null }

    // The receipt's own approval must still be the LATEST one — any amount/expiry drift, or any
    // event after it (including a later zero == revoke), is a mutation. No exceptions: a bigger
    // NEW allowance is still a mutation (we did not review it), never silently accepted as reuse.
    const expectedUnits = BigInt(budget.units)
    const matchesReceipt =
      latest.amount === expectedUnits && latest.expiryLedger === receipt.expiryLedger
    if (!matchesReceipt) return { proven: false, reason: 'mutated', proof: null }

    // Cross-check the live SAC getter against the latest decoded event — they must agree, or
    // something changed that the event trace does not (yet) account for.
    const live = liveAmounts.get(budget.token)
    if (live == null || live !== latest.amount)
      return { proven: false, reason: 'mutated', proof: null }

    approvals.push({
      amount: { token: budget.token, units: latest.amount.toString(), decimals: budget.decimals },
      expiryLedger: latest.expiryLedger,
      ledger: latest.ledger,
      txHash: latest.txHash,
      eventIndex: latest.eventIndex,
    })
  }

  const proofBase = {
    version: 1,
    owner: receipt.owner,
    router: receipt.router,
    network: NETWORK_ID,
    indexedFromLedger,
    indexedThroughLedger,
    latestLedger: boundary,
    gapFree: true,
    noLaterMutation: true,
    approvals,
  }
  const proof = { ...proofBase, proofHash: computeProofHash(proofBase) }
  return { proven: true, reason: null, proof }
}

/**
 * V3-facing view of the two boolean evidence fields `proveCurrentAllowance` already computes as
 * part of AllowanceExpiryProofV1 (`proof.gapFree`/`proof.noLaterMutation` above) — a narrow read
 * so a V3 caller (permissionGrantV3.js's `proveAllowance` seam) does not need to know
 * AllowanceExpiryProofV1's full shape. Pure projection, no new computation: `proveCurrentAllowance`
 * itself, its signature, and its return shape are unchanged.
 * @param {object|null} proof an AllowanceExpiryProofV1, or null/unproven
 * @returns {{gapFree:boolean, noLaterMutation:boolean}}
 */
export function allowanceGapEvidence(proof) {
  return { gapFree: !!proof?.gapFree, noLaterMutation: !!proof?.noLaterMutation }
}
