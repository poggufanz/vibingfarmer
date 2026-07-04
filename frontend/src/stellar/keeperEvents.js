// Frontend keeper-event feed (vf-autofarm + lifeboat). The keeper Worker (keeper/) calls the
// autofarm vault's keeper-gated `compound`/`rebalance`/`derisk`/`resume` on a cron schedule, and
// the vault itself emits `mandate` on a user-signed `set_mandate` — this module polls the Soroban
// RPC for those contract events (topics `vault_compound` / `vault_rebalance` / `vault_derisk` /
// `vault_resume` / `vault_mandate`, see soroban/contracts/rwa_vault/src/types.rs) and decodes them
// into the alert-ready shape app.jsx feeds into the existing agent-alert pipeline. Mirrors the
// getEvents/decode pattern in ./events.js (that module watches the OLD vault + registry +
// attestation contracts; this one watches the NEW autofarm vault).
import { fromScVal } from './scval.js'

const COMPOUND_TOPIC = 'vault_compound'
const REBALANCE_TOPIC = 'vault_rebalance'
const DERISK_TOPIC = 'vault_derisk'
const RESUME_TOPIC = 'vault_resume'
const MANDATE_TOPIC = 'vault_mandate'
const KNOWN_TOPICS = [COMPOUND_TOPIC, REBALANCE_TOPIC, DERISK_TOPIC, RESUME_TOPIC, MANDATE_TOPIC]

// Ledgers to look back when no cursor is known yet (cold start) — same constant ExplorerPage.jsx
// uses for the attestation feed. ~8000 ledgers is comfortably inside the RPC retention window
// without replaying the contract's entire history on every fresh page load.
const DEFAULT_LOOKBACK_LEDGERS = 8000

/**
 * Decode one raw `getEvents` record into a typed keeper event. Returns `null` for anything
 * outside `KNOWN_TOPICS`, or that fails to decode — callers filter nulls so one
 * malformed/unexpected record never breaks the whole batch.
 * @param {{ topic: unknown[], value: unknown, ledger: number, txHash?: string }} rec
 * @returns {{
 *   type: 'compound' | 'rebalance' | 'derisk' | 'resume' | 'mandate',
 *   ledger: number,
 *   txHash?: string,
 *   totalGain?: bigint,
 *   pricePerShare?: bigint,
 *   from?: string,
 *   to?: string,
 *   amount?: bigint,
 *   reasonCode?: number,
 *   drainedTotal?: bigint,
 *   idle?: bigint,
 *   authority?: string,
 *   expiry?: bigint,
 * } | null}
 */
export function decodeKeeperEvent(rec) {
  try {
    const topic = fromScVal(rec.topic[0])
    if (!KNOWN_TOPICS.includes(topic)) return null
    const data = fromScVal(rec.value)
    const base = { ledger: rec.ledger, txHash: rec.txHash }
    if (topic === COMPOUND_TOPIC) {
      return {
        ...base,
        type: 'compound',
        totalGain: data.total_gain,
        pricePerShare: data.price_per_share,
      }
    }
    if (topic === DERISK_TOPIC) {
      return {
        ...base,
        type: 'derisk',
        reasonCode: Number(data.reason_code),
        drainedTotal: data.drained_total,
      }
    }
    if (topic === RESUME_TOPIC) {
      return { ...base, type: 'resume', idle: data.idle }
    }
    if (topic === MANDATE_TOPIC) {
      return { ...base, type: 'mandate', authority: data.authority, expiry: data.expiry }
    }
    return { ...base, type: 'rebalance', from: data.from, to: data.to, amount: data.amount }
  } catch {
    return null // malformed record — skip, never throw out of the batch
  }
}

async function realServer(rpcUrl) {
  const { rpc } = await import('@stellar/stellar-sdk')
  return new rpc.Server(rpcUrl)
}

/**
 * Poll the autofarm vault contract for Compound/Rebalance events since `sinceLedger`. One-shot
 * fetch — callers (app.jsx) re-invoke it on their own interval, piggybacking whatever poll loop
 * already exists rather than opening a second one.
 * @param {string} rpcUrl Soroban RPC endpoint
 * @param {string} vaultAddress the autofarm vault contract address (C...)
 * @param {number} [sinceLedger] inclusive lower bound; omit to auto-resolve a recent cold-start
 *   window via `getLatestLedger()` (avoids replaying the contract's whole history on first call)
 * @param {{ server?: object }} [opts] `server` is an injectable RPC client — test seam only;
 *   production lazily constructs the real `rpc.Server(rpcUrl)`
 * @returns {Promise<Array>} decoded compound/rebalance events; malformed records silently skipped
 */
export async function fetchKeeperEvents(rpcUrl, vaultAddress, sinceLedger, { server } = {}) {
  const s = server || (await realServer(rpcUrl))
  let startLedger = sinceLedger
  if (startLedger == null) {
    const { sequence } = await s.getLatestLedger()
    startLedger = Math.max(1, sequence - DEFAULT_LOOKBACK_LEDGERS)
  }
  const res = await s.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [vaultAddress] }],
    limit: 100,
  })
  const out = []
  for (const rec of res.events || []) {
    const ev = decodeKeeperEvent(rec)
    if (ev) out.push(ev)
  }
  return out
}
