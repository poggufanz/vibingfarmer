// frontend/src/history/unifiedHistory.js
// P1 G10: one unified /history feed, newest first — Horizon payments + contract events
// (grant deploys via the agent index, deposit principal via the deposit ledger, keeper
// compound/derisk via vault events) + local device receipts + Base tokentx.
//
// Honesty rules (repo-wide money-truth, same as HistoryScreen/WithdrawModal):
// - a source that cannot be read marks its leg `unavailable`; it never renders as empty.
// - a row without a transaction hash renders WITHOUT an explorer link — URLs are only ever
//   built off a hash the source itself provided, never guessed.
// - timestamps come only from the source (Horizon `created_at`, receipt `timestamp`, event
//   `ledgerClosedAt`); rows without one sort last with an explicit "date unavailable" label,
//   never `Date.now()`.
// - the same on-chain transaction surfacing in two sources (a deposit receipt + its ledger
//   hint share one txHash) renders ONCE — deduped by hash, richest row wins.
import { fetchHistory as defaultFetchHistory } from '../wallet/history.js'
import { fetchBaseHistory as defaultFetchBaseHistory } from '../base/baseHistory.js'
import { getTransactions as defaultGetTransactions } from './history.js'
import { loadDepositLedger as defaultLoadDepositLedger } from '../store/positionsStore.js'
import { fetchOwnerAgentIndex as defaultFetchAgents } from '../stellar/agentIndexClient.js'
import { fetchKeeperEvents as defaultFetchKeeper } from '../stellar/keeperEvents.js'
import { SOROBAN_RPC_URL, SOROBAN_ACTIVE_VAULT_ADDRESS } from '../stellar/config.js'

export const STELLAR_EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/'
export const BASE_EXPLORER_TX = 'https://base-sepolia.blockscout.com/tx/'

/** Explorer URL off a source-provided hash only — anything else is `null` (no link). */
export function stellarTxUrl(hash) {
  return typeof hash === 'string' && hash.length > 0 ? `${STELLAR_EXPLORER_TX}${hash}` : null
}

/** Explorer URL off a source-provided hash only — anything else is `null` (no link). */
export function baseTxUrl(hash) {
  return typeof hash === 'string' && hash.length > 0 ? `${BASE_EXPLORER_TX}${hash}` : null
}

const shortAddr = (addr) =>
  typeof addr === 'string' && addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr

// 7-dp base units (vault/token convention) -> "12.50 USDC", or null when unparseable.
function unitsToUsdcText(units) {
  try {
    const n = Number(typeof units === 'bigint' ? units.toString() : (units ?? ''))
    if (!Number.isFinite(n)) return null
    return `${(n / 10_000_000).toFixed(2)} USDC`
  } catch {
    return null
  }
}

function msOrNull(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Horizon payments (already null on network failure) -> unified rows. `null` stays `null`. */
export function normalizeHorizonRows(rows) {
  if (rows == null) return null
  return rows.map((r, i) => ({
    id: `horizon:${r.id ?? i}`,
    time: r.createdAt != null ? msOrNull(r.createdAt) : null,
    kind: r.type === 'create_account' ? 'account' : 'payment',
    label: r.direction === 'in' ? 'Received' : 'Sent',
    detail: r.amount != null && r.asset ? `${r.amount} ${r.asset}` : 'Details unavailable',
    hash: typeof r.txHash === 'string' && r.txHash.length > 0 ? r.txHash : null,
    url: stellarTxUrl(r.txHash),
    network: 'stellar',
    status: 'confirmed',
  }))
}

/** Local device receipts (saved only after on-chain SUCCESS) -> unified rows. */
export function normalizeReceiptRows(rows) {
  if (rows == null) return null
  return (Array.isArray(rows) ? rows : []).map((r, i) => {
    const hash = typeof r?.txHash === 'string' && r.txHash.length > 0 ? r.txHash : null
    const amount =
      amountText(r?.amountUsdc, 'USDC') ?? amountText(r?.amount) ?? 'Amount unavailable'
    const time = r?.timestamp ?? r?.savedAt
    return {
      id: `local:${hash ?? `${time ?? 'notime'}-${i}`}`,
      time: time != null ? msOrNull(time) : null,
      kind: r?.type === 'withdraw' ? 'withdraw' : 'deposit',
      label: r?.type === 'withdraw' ? 'Withdraw' : 'Deposit',
      detail: [r?.vaultName, amount].filter(Boolean).join(' · '),
      hash,
      url: stellarTxUrl(hash),
      network: 'stellar',
      status: 'confirmed',
    }
  })
}

/** Deposit-ledger principal hints (no timestamps on-chain here) -> unified rows. */
export function normalizeLedgerRows(entries) {
  if (entries == null) return null
  return (Array.isArray(entries) ? entries : []).map((e, i) => {
    const hash = typeof e?.txHash === 'string' && e.txHash.length > 0 ? e.txHash : null
    const principal = unitsToUsdcText(e?.assetsIn) ?? 'Amount unavailable'
    return {
      id: `ledger:${e?.agent ?? i}:${hash ?? e?.assetsIn ?? i}`,
      time: null,
      kind: 'deposit',
      label: 'Deposit principal',
      detail: `${principal}${e?.agent ? ` · ${shortAddr(e.agent)}` : ''}`,
      hash,
      url: stellarTxUrl(hash),
      network: 'stellar',
      status: 'confirmed',
    }
  })
}

// Canonical amount objects ({token, units, decimals} — the HistoryPanel fixture shape) as
// well as plain numbers/strings render here; anything else is honestly unavailable.
function amountText(value, symbol) {
  if (value != null && typeof value === 'object') {
    try {
      const n = Number(value.units) / 10 ** Number(value.decimals ?? 0)
      if (Number.isFinite(n) && typeof value.token === 'string') return `${n} ${value.token}`
    } catch {
      /* fall through */
    }
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return symbol ? `${value} ${symbol}` : String(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return symbol ? `${value} ${symbol}` : value
  }
  return null
}
/** Agent-index deployed agents (address only is trusted) -> one grant row each, no links. */
export function normalizeAgentRows(agents) {
  if (agents == null) return null
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => typeof a?.address === 'string' && a.address.length > 0)
    .map((a) => ({
      id: `grant:${a.address}`,
      time: null,
      kind: 'grant',
      label: 'Agent deployed',
      detail: `Grant · ${shortAddr(a.address)}`,
      hash: null,
      url: null,
      network: 'stellar',
      status: 'confirmed',
    }))
}

const KEEPER_LABELS = {
  compound: 'Keeper compound',
  rebalance: 'Keeper rebalance',
  derisk: 'Lifeboat derisk',
  resume: 'Lifeboat resume',
  mandate: 'Vault mandate',
  upgrade_scheduled: 'Vault upgrade scheduled',
  upgrade_executed: 'Vault upgrade executed',
  upgrade_cancelled: 'Vault upgrade cancelled',
}

/** Vault keeper events (real `closedAt` or undated) -> unified rows. */
export function normalizeKeeperRows(events) {
  if (events == null) return null
  return (Array.isArray(events) ? events : [])
    .filter((e) => e != null && typeof e.type === 'string')
    .map((e, i) => {
      const hash = typeof e.txHash === 'string' && e.txHash.length > 0 ? e.txHash : null
      const gain =
        e.type === 'compound' && e.totalGain != null ? unitsToUsdcText(e.totalGain) : null
      return {
        id: `keeper:${e.type}:${e.ledger ?? i}:${hash ?? i}`,
        time: e.closedAt != null ? msOrNull(e.closedAt) : null,
        kind: e.type,
        label: KEEPER_LABELS[e.type] ?? `Keeper ${e.type}`,
        detail:
          [gain ? `+${gain}` : null, e.ledger != null ? `ledger ${e.ledger}` : null]
            .filter(Boolean)
            .join(' · ') || 'Details unavailable',
        hash,
        url: stellarTxUrl(hash),
        network: 'stellar',
        status: 'confirmed',
      }
    })
}

/** Base tokentx rows (already null on indexer failure) -> unified rows. `null` stays `null`. */
export function normalizeBaseRows(rows) {
  if (rows == null) return null
  return rows.map((r, i) => {
    const direction = r?.direction ?? r?.action
    return {
      id: `base:${r?.hash ?? r?.id ?? i}`,
      time:
        r?.time != null ? msOrNull(r.time) : r?.timestamp != null ? msOrNull(r.timestamp) : null,
      kind: 'base',
      label: direction === 'in' ? 'Received' : direction === 'out' ? 'Sent' : 'Unavailable',
      detail: amountText(r?.amount, r?.symbol ?? r?.asset) ?? 'Details unavailable',
      hash: typeof r?.hash === 'string' && r.hash.length > 0 ? r.hash : null,
      url: baseTxUrl(r?.hash),
      network: 'base',
      status: 'confirmed',
    }
  })
}

// Richest row wins a hash collision: the local receipt (reviewed labels + amounts) beats a
// raw indexer row for the same transaction. `null` sources are excluded, never rendered.
const DEDUP_PRIORITY = ['local', 'horizon', 'ledger', 'keeper', 'grant', 'base']

/**
 * Merge normalized source lists into one newest-first feed. Pure.
 * @param {{[source:string]: Array|null}} lists normalized rows per source (`null` = unavailable)
 * @returns {Array} deduped (by hash), time-desc rows; undated rows last in priority order.
 */
export function mergeActivityRows(lists = {}) {
  const order = new Map(DEDUP_PRIORITY.map((s, i) => [s, i]))
  const ranked = []
  for (const [source, rows] of Object.entries(lists)) {
    if (!Array.isArray(rows)) continue
    // Stamp the origin on each row: the table names the DATA SOURCE per row, so an
    // unverified row never has to claim a settled route to say where it came from.
    for (const row of rows)
      ranked.push({ row: { ...row, source }, rank: order.get(source) ?? order.size })
  }
  const seenHash = new Set()
  const deduped = []
  // First pass in priority order so the richest row claims each hash.
  for (const { row, rank } of [...ranked].sort((a, b) => a.rank - b.rank)) {
    const key = typeof row?.hash === 'string' && row.hash.length > 0 ? row.hash.toLowerCase() : null
    if (key == null) {
      deduped.push({ row, rank })
      continue
    }
    if (seenHash.has(key)) continue
    seenHash.add(key)
    deduped.push({ row, rank })
  }
  // Newest first; undated rows keep their priority order at the end (stable sort).
  deduped.sort((a, b) => {
    const ta = a.row?.time
    const tb = b.row?.time
    if (ta == null && tb == null) return a.rank - b.rank
    if (ta == null) return 1
    if (tb == null) return -1
    return tb - ta
  })
  return deduped.map((d) => d.row)
}

function statusOf(value) {
  if (value == null) return 'unavailable'
  return value.length === 0 ? 'empty' : 'ok'
}

async function settle(fn, fallback = null) {
  try {
    const value = await fn()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * Fetch every unified-feed source for `owner`. Never throws: each leg resolves to rows,
 * `[]`, or `null`, and `sources` reports which legs are `ok` / `empty` / `unavailable`.
 * @param {{owner:string, baseAccount?:string|null, deps?:object}} p injectable sources (tests)
 * @returns {Promise<{rows:Array, sources:object, partial:boolean}>}
 */
export async function fetchUnifiedActivity({ owner, baseAccount = null, deps = {} } = {}) {
  const {
    fetchHistory = defaultFetchHistory,
    getTransactions = defaultGetTransactions,
    loadDepositLedger = defaultLoadDepositLedger,
    fetchAgents = (o) => defaultFetchAgents({ owner: o }),
    fetchKeeper = () => defaultFetchKeeper(SOROBAN_RPC_URL, SOROBAN_ACTIVE_VAULT_ADDRESS),
    fetchBase = defaultFetchBaseHistory,
  } = deps

  const [horizonRaw, receiptsRaw, ledgerRaw, agentsRaw, keeperRaw, baseRaw] = await Promise.all([
    owner ? settle(() => fetchHistory(owner, { limit: 40 })) : [],
    settle(() => getTransactions()),
    owner ? settle(() => loadDepositLedger(owner)) : [],
    owner ? settle(() => fetchAgents(owner)) : [],
    settle(() => fetchKeeper()),
    baseAccount ? settle(() => fetchBase({ account: baseAccount, limit: 40 })) : [],
  ])

  const agents =
    agentsRaw != null
      ? Array.isArray(agentsRaw)
        ? agentsRaw
        : agentsRaw.status === 'unavailable'
          ? null
          : (agentsRaw.agents ?? null)
      : null

  const lists = {
    local: normalizeReceiptRows(receiptsRaw),
    horizon: normalizeHorizonRows(horizonRaw),
    ledger: normalizeLedgerRows(ledgerRaw),
    keeper: normalizeKeeperRows(keeperRaw),
    grant: normalizeAgentRows(agents),
    base: normalizeBaseRows(baseRaw),
  }
  const raws = {
    local: receiptsRaw,
    horizon: horizonRaw,
    ledger: ledgerRaw,
    keeper: keeperRaw,
    grant: agents,
    base: baseAccount ? baseRaw : [],
  }
  const sources = Object.fromEntries(
    Object.entries(raws).map(([source, raw]) => [source, statusOf(raw)])
  )
  return {
    rows: mergeActivityRows(lists),
    sources,
    partial: Object.values(sources).some((s) => s === 'unavailable'),
  }
}
