// frontend/src/stellar/allowanceEventStore.js
// Strategy Task 5 (Pocket Crew redesign, Wave 1). Resumable, NON-authoritative cache/cursor over
// owner→router SEP-41 `approve` events for one token. This store NEVER proves reuse by itself:
// `syncApprovalEvents` always touches the chain for at least the delta since it was last synced,
// and a short/gapped scan is NEVER persisted as a complete range — a caller that asks for
// coverage through ledger L gets back the truth about how far coverage actually reached, capped
// at the last point this module could actually prove contiguous. allowanceProof.js is the module
// that turns this into a proof (it additionally checks the returned boundary against its own
// captured ledger numbers); this file only accelerates repeat scans.
//
// PINNED via live probe 2026-07-23 (testnet, 236/236 real `approve` events on the grant-path SAC
// CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU, no exceptions): the built-in Stellar
// Asset Contract's `approve` event topic vector has ARITY 4, not 3 — (symbol_short!("approve"),
// from, spender, asset: the SEP-0011 "CODE:ISSUER" string) — a 3-segment topic filter (approve,
// owner, router) matches ZERO events (Soroban topic filters are arity-sensitive: they never
// implicitly match a longer vector), which would make reuse permanently, silently dead. The data
// payload IS the assumed bare 2-tuple, confirmed unchanged: data = (amount: i128,
// expiration_ledger: u32) -> scValToNative gives [amount, expirationLedger]. See
// scratchpad probe-approve-topics.mjs / pocket-crew-str-task-5-report.md "Live probe evidence".
import { fromScVal, symbolScVal, addrScVal } from './scval.js'
import { NETWORK_PASSPHRASE } from './config.js'

const CACHE_KEY = 'vf.allowanceEventCache.v1'
const APPROVE_TOPIC = 'approve'
// Safety cap on one scan's page budget — mirrors routerEvents.js's MAX_PAGES: a runaway
// backstop, not a real bound. Exhausting it before the cursor reaches the tip is an UNPROVEN
// scan (gapFree=false), never a silent truncation passed off as complete.
const MAX_PAGES = 250

// node test env / SSR has no localStorage — same in-memory fallback pattern as agentCache.js.
let _memStore = null
function resolveStorage(injected) {
  if (injected) return injected
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    /* SecurityError in some embeds — fall through */
  }
  if (!_memStore) {
    const m = new Map()
    _memStore = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    }
  }
  return _memStore
}

function readAll(storage) {
  try {
    return JSON.parse(resolveStorage(storage).getItem(CACHE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAll(all, storage) {
  try {
    resolveStorage(storage).setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    /* quota/serialization failure — cache is best-effort, never fatal */
  }
}

/** Cache bucket key: one approval-event range per (network, owner, router, token). */
export function cacheKeyFor({ owner, router, token, network = NETWORK_PASSPHRASE }) {
  return `${network}|${owner}|${router}|${token}`
}

/**
 * Load the persisted range for one bucket, or null when nothing is cached yet. `amount` is
 * revived from its stringified form (JSON has no bigint).
 * @returns {{indexedFromLedger:number, indexedThroughLedger:number, approvals:Array}|null}
 */
export function loadEventCache({ owner, router, token, network, storage } = {}) {
  const row = readAll(storage)[cacheKeyFor({ owner, router, token, network })]
  if (!row) return null
  try {
    return {
      indexedFromLedger: row.indexedFromLedger,
      indexedThroughLedger: row.indexedThroughLedger,
      approvals: (row.approvals || []).map((a) => ({ ...a, amount: BigInt(a.amount) })),
    }
  } catch {
    return null // corrupt row — never surface a half-decoded range
  }
}

/** Persist a range for one bucket. `cache.approvals[].amount` is a bigint — stringified for storage. */
export function saveEventCache({ owner, router, token, network, cache, storage }) {
  const all = readAll(storage)
  all[cacheKeyFor({ owner, router, token, network })] = {
    indexedFromLedger: cache.indexedFromLedger,
    indexedThroughLedger: cache.indexedThroughLedger,
    approvals: cache.approvals.map((a) => ({ ...a, amount: a.amount.toString() })),
  }
  writeAll(all, storage)
}

/**
 * Decode one raw getEvents record into an approve-event fact, or null for any non-approve topic
 * or malformed record — callers filter nulls so one bad record never breaks a batch (mirrors
 * routerEvents.js's decodeDeployedEvent).
 * @param {{topic:unknown[], value:unknown, ledger?:number, txHash?:string}} rec
 * @param {number} [eventIndex] this record's position within the scan (tie-breaker alongside ledger)
 * @returns {{owner:string, spender:string, amount:bigint, expiryLedger:number, ledger:number,
 *           txHash:string, eventIndex:number}|null}
 */
export function decodeApproveEvent(rec, eventIndex = 0) {
  try {
    if (fromScVal(rec.topic[0]) !== APPROVE_TOPIC) return null
    const owner = fromScVal(rec.topic[1])
    const spender = fromScVal(rec.topic[2])
    const data = fromScVal(rec.value)
    const [amount, expiryLedger] = Array.isArray(data) ? data : [null, null]
    if (amount == null || expiryLedger == null || !owner || !spender) return null
    return {
      owner,
      spender,
      amount: BigInt(amount),
      expiryLedger: Number(expiryLedger),
      ledger: rec.ledger,
      txHash: rec.txHash,
      eventIndex,
    }
  } catch {
    return null
  }
}

/**
 * Scan owner→router `approve` events on `token`, from `fromLedger` up to the RPC's CURRENT TIP.
 * Soroban getEvents has no "scan to ledger X" mode — it pages a fixed ledger window per request
 * and the only way to know you have reached the tip is the cursor no longer advancing
 * (routerEvents.js's fetchRouterDeployedEvents establishes the same to-the-tip pattern this
 * mirrors). Terminates PROVEN when the cursor stalls at the tip; terminates UNPROVEN when the
 * page budget runs out first, or an RPC error interrupts the scan (whatever was decoded before
 * the error is kept — a partial result is not discarded — but the range is marked ungapped-free).
 * @param {{server:object, token:string, owner:string, router:string, fromLedger:number, limit?:number}} p
 * @returns {Promise<{approvals:Array, reachedThroughLedger:number, gapFree:boolean}>}
 */
export async function fetchApprovalEventRange({
  server,
  token,
  owner,
  router,
  fromLedger,
  limit = 1000,
}) {
  const topics = [
    [
      symbolScVal(APPROVE_TOPIC).toXDR('base64'),
      addrScVal(owner).toXDR('base64'),
      addrScVal(router).toXDR('base64'),
      '*', // 4th topic = the SEP-0011 asset string ("CODE:ISSUER") — live-probed, see module header
    ],
  ]
  const filters = [{ type: 'contract', contractIds: [token], topics }]
  const approvals = []
  let cursor
  let reachedThroughLedger = fromLedger - 1
  let gapFree = false
  let eventIndex = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    let res
    try {
      res = cursor
        ? await server.getEvents({ filters, cursor, limit }) // cursor mode: startLedger MUST be omitted
        : await server.getEvents({ startLedger: fromLedger, filters, limit })
    } catch {
      // Retention loss / transient RPC error mid-scan: keep whatever was proven so far, but the
      // range cannot be claimed gap-free through the tip.
      return { approvals, reachedThroughLedger, gapFree: false }
    }
    for (const rec of res.events || []) {
      const row = decodeApproveEvent(rec, eventIndex++)
      if (row) approvals.push(row)
      if (Number.isFinite(rec.ledger))
        reachedThroughLedger = Math.max(reachedThroughLedger, rec.ledger)
    }
    if (Number.isFinite(res.latestLedger))
      reachedThroughLedger = Math.max(reachedThroughLedger, res.latestLedger)
    // Terminate when the cursor stops advancing (tip reached) — never stop on an empty page, a
    // sparse window may still have later ledgers to scan.
    if (!res.cursor || res.cursor === cursor) {
      gapFree = true
      break
    }
    cursor = res.cursor
  }
  return { approvals, reachedThroughLedger, gapFree }
}

/**
 * Resumable sync: extend the cached range for (owner, router, token, network) up through the
 * chain's current tip. ALWAYS calls `fetchRange` for at least the delta since the cache was last
 * synced — a cache hit alone is never treated as "rechecked against chain" (Task 5 invariant).
 * Resumes from `cache.indexedThroughLedger + 1` when the cache's own floor already covers the
 * requested `fromLedgerFloor`; otherwise (no cache, or the cache's floor is later than what is
 * now needed) performs a full fresh scan from `fromLedgerFloor`. Never persists
 * `indexedThroughLedger` beyond what THIS scan actually proved contiguous — a gapped/short scan
 * caps the boundary at the last proven point instead of upgrading it.
 *
 * `targetLedger` (optional — the caller's own just-captured ledger number, e.g. allowanceProof.js's
 * L1/L2) guards against asking the RPC for a `startLedger` past its own current tip: when the
 * cache already reaches at least `targetLedger` (a prior sync's OWN real chain touch already
 * cleared it — two preflights inside one ledger, or a scan that over-reached before the caller's
 * L2 was even captured), the delta is empty by construction and is returned as a gap-free
 * zero-width range with no network call, instead of erroring into a spurious gap. Omitted (the
 * default): behaves exactly as before — always calls `fetchRange` for at least the delta.
 * @param {{owner:string, router:string, token:string, network:string, fromLedgerFloor:number,
 *          targetLedger?:number, server?:object, storage?:object, fetchRange?:Function}} p
 * @returns {Promise<{approvals:Array, indexedFromLedger:number, indexedThroughLedger:number, gapFree:boolean}>}
 */
export async function syncApprovalEvents({
  owner,
  router,
  token,
  network,
  fromLedgerFloor,
  targetLedger,
  server,
  storage,
  fetchRange = fetchApprovalEventRange,
}) {
  const cached = loadEventCache({ owner, router, token, network, storage })
  const usable = Boolean(cached) && cached.indexedFromLedger <= fromLedgerFloor
  const resumeFrom = usable ? cached.indexedThroughLedger + 1 : fromLedgerFloor

  if (usable && targetLedger != null && resumeFrom > targetLedger) {
    return {
      approvals: cached.approvals,
      indexedFromLedger: cached.indexedFromLedger,
      indexedThroughLedger: cached.indexedThroughLedger,
      gapFree: true,
    }
  }

  const {
    approvals: fresh,
    reachedThroughLedger,
    gapFree,
  } = await fetchRange({
    server,
    token,
    owner,
    router,
    fromLedger: resumeFrom,
  })

  const priorApprovals = usable ? cached.approvals : []
  const approvals = [...priorApprovals, ...fresh].sort(
    (a, b) => a.ledger - b.ledger || a.eventIndex - b.eventIndex
  )
  const indexedFromLedger = usable ? cached.indexedFromLedger : fromLedgerFloor
  const priorThrough = usable ? cached.indexedThroughLedger : fromLedgerFloor - 1
  // Never claim contiguous coverage past what this scan actually proved.
  const indexedThroughLedger = gapFree ? Math.max(reachedThroughLedger, priorThrough) : priorThrough

  const nextCache = { indexedFromLedger, indexedThroughLedger, approvals }
  saveEventCache({ owner, router, token, network, cache: nextCache, storage })
  return { ...nextCache, gapFree }
}
