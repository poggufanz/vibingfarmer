// Frontend keeper-event feed (vf-autofarm). The keeper Worker (keeper/) calls the autofarm
// vault's keeper-gated `compound`/`rebalance` on a cron schedule — this module polls the Soroban
// RPC for the `Compound`/`Rebalance` contract events those calls emit (topics `vault_compound` /
// `vault_rebalance`, see soroban/contracts/rwa_vault/src/types.rs) and decodes them into the
// alert-ready shape app.jsx feeds into the existing agent-alert pipeline. Mirrors the
// getEvents/decode pattern in ./events.js (that module watches the OLD vault + registry +
// attestation contracts; this one watches the NEW autofarm vault for the two keeper-only events).
import { fromScVal } from './scval.js'

const COMPOUND_TOPIC = 'vault_compound'
const REBALANCE_TOPIC = 'vault_rebalance'

// Ledgers to look back when no cursor is known yet (cold start) — same constant ExplorerPage.jsx
// uses for the attestation feed. ~8000 ledgers is comfortably inside the RPC retention window
// without replaying the contract's entire history on every fresh page load.
const DEFAULT_LOOKBACK_LEDGERS = 8000

/**
 * Decode one raw `getEvents` record into a typed keeper event. Returns `null` for anything that
 * isn't a Compound/Rebalance record, or that fails to decode — callers filter nulls so one
 * malformed/unexpected record never breaks the whole batch.
 * @param {{ topic: unknown[], value: unknown, ledger: number, txHash?: string }} rec
 * @returns {{
 *   type: 'compound' | 'rebalance',
 *   ledger: number,
 *   txHash?: string,
 *   totalGain?: bigint,
 *   pricePerShare?: bigint,
 *   from?: string,
 *   to?: string,
 *   amount?: bigint,
 * } | null}
 */
export function decodeKeeperEvent(rec) {
  try {
    const topic = fromScVal(rec.topic[0])
    if (topic !== COMPOUND_TOPIC && topic !== REBALANCE_TOPIC) return null
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
