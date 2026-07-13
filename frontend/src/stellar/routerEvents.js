// funding_router `Deployed` event feed — cross-device source for rehydrating active agent scopes.
// The router emits one `Deployed` event per agent it deploys from a user grant (topics
// [deployed, owner, agent], data ScMap {cap}). `scopes` in app.jsx is in-memory, so a browser
// refresh loses the "Agent permissions" panel even though the grants are live on-chain. This
// module re-enumerates the owner's deployed agents from RPC getEvents so the panel can be rebuilt.
//
// Encoding gotchas (PINNED via live probe 2026-07-12, router CBEI5VJK…):
//   - topic0 is the event name symbol LOWERCASE `deployed` — soroban-sdk #[contractevent]
//     snake_cases the variant. Filtering on `Deployed` matches nothing, silently, forever.
//   - data is an ScMap `{cap}`, not a bare i128 → decode `fromScVal(rec.value).cap`.
//   - getEvents pages by a fixed LEDGER WINDOW per request (~2-3k ledgers), NOT by event count.
//     It returns a cursor even on a 0-match page, so paging must loop while the cursor ADVANCES,
//     never stop at an empty page (a full 7d window is ~41-61 pages). Cursor-mode requests MUST
//     omit startLedger (SDK 16 enforces: ledger-range mode xor cursor mode).
import { fromScVal, symbolScVal, addrScVal } from './scval.js'
import { SOROBAN_RPC_URL } from './config.js'

const DEPLOYED_TOPIC = 'deployed' // lowercase — see header note
// Safety cap on the cursor loop: the probe saw ≤61 pages for a full 7d retention window; 250 is a
// runaway backstop, not a real bound. ponytail: bump only if retention windows grow past ~15 days.
const MAX_PAGES = 250

async function realServer(rpcUrl) {
  const { rpc } = await import('@stellar/stellar-sdk')
  return new rpc.Server(rpcUrl)
}

/**
 * Decode one raw getEvents record into a deployed-agent row. Returns `null` for any topic that
 * isn't `deployed`, or any record that fails to decode — callers filter nulls so one malformed
 * record never breaks the batch.
 * @param {{ topic: unknown[], value: unknown, ledger?: number, txHash?: string }} rec
 * @returns {{ owner: string, agent: string, cap: bigint, ledger?: number, txHash?: string } | null}
 */
export function decodeDeployedEvent(rec) {
  try {
    if (fromScVal(rec.topic[0]) !== DEPLOYED_TOPIC) return null
    const owner = fromScVal(rec.topic[1])
    const agent = fromScVal(rec.topic[2])
    const cap = fromScVal(rec.value)?.cap
    if (!agent || cap == null) return null
    return { owner, agent, cap: BigInt(cap), ledger: rec.ledger, txHash: rec.txHash }
  } catch {
    return null
  }
}

/** oldestLedger the RPC still retains — the floor for any startLedger. */
async function retentionFloor(server) {
  try {
    const health = await server.getHealth()
    if (Number.isFinite(health?.oldestLedger)) return health.oldestLedger
  } catch {
    /* older RPC without getHealth — the -32600 clamp below is the safety net */
  }
  return 1
}

/**
 * Resolve the scan window's lower bound. Default (`lookbackLedgers` omitted) = the full retention
 * window, i.e. oldestLedger — a 7d grant can be that old. A caller wanting a cheaper recent-only
 * scan (e.g. the last 24h) passes an explicit lookback. NEVER hardcode a ledger count: ledger time
 * can shift (CAP-0070) so a fixed number silently under-scans.
 */
async function resolveStartLedger(server, lookbackLedgers) {
  const floor = await retentionFloor(server)
  if (lookbackLedgers == null) return floor
  const { sequence } = await server.getLatestLedger()
  return Math.max(floor, Math.max(1, sequence - lookbackLedgers))
}

/** Parse the oldest ledger out of a `-32600 startLedger must be within the ledger range: A - B`. */
function oldestFromRangeError(err) {
  const m = /ledger range:\s*(\d+)\s*-\s*\d+/.exec(String(err?.message ?? err))
  return m ? Number(m[1]) : null
}

/**
 * Fetch every `Deployed` event the router emitted for `owner`, paginating the full ledger window.
 * @param {{
 *   server?: object,          // injected RPC client (test seam); else built from rpcUrl
 *   rpcUrl?: string,          // defaults to SOROBAN_RPC_URL
 *   routerAddress: string,    // funding_router contract (C...)
 *   owner: string,            // grant owner (G...) — scopes the topic filter
 *   lookbackLedgers?: number, // omit = full retention window
 *   limit?: number,
 * }} p
 * @returns {Promise<Array<{ owner: string, agent: string, cap: bigint, ledger?: number, txHash?: string }>>}
 */
export async function fetchRouterDeployedEvents({
  server,
  rpcUrl = SOROBAN_RPC_URL,
  routerAddress,
  owner,
  lookbackLedgers,
  limit = 1000,
} = {}) {
  const s = server || (await realServer(rpcUrl))
  // 3-segment topic filter: [deployed(lowercase), owner, *]. Base64-XDR strings + '*' wildcard —
  // verified to match exactly the owner's deployed events (no client-side re-filter needed).
  const topics = [
    [symbolScVal(DEPLOYED_TOPIC).toXDR('base64'), addrScVal(owner).toXDR('base64'), '*'],
  ]
  const filters = [{ type: 'contract', contractIds: [routerAddress], topics }]

  let startLedger = await resolveStartLedger(s, lookbackLedgers)
  const out = []
  let cursor
  for (let page = 0; page < MAX_PAGES; page++) {
    let res
    try {
      res = cursor
        ? await s.getEvents({ filters, cursor, limit }) // cursor mode: startLedger MUST be omitted
        : await s.getEvents({ startLedger, filters, limit })
    } catch (err) {
      const oldest = oldestFromRangeError(err)
      if (oldest != null && !cursor) {
        startLedger = oldest // fell below retention between probe and call — clamp & retry once
        continue
      }
      throw err
    }
    for (const rec of res.events || []) {
      const row = decodeDeployedEvent(rec)
      if (row) out.push(row)
    }
    // Terminate when the cursor stops advancing (tip reached). Do NOT stop on an empty page —
    // the window may be sparse but still have later ledgers to scan.
    if (!res.cursor || res.cursor === cursor) break
    cursor = res.cursor
  }
  return out
}
