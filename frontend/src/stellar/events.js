// Soroban event indexer for the force-graph monitor. Polls RPC getEvents for the registry +
// vault, decodes each record (topic symbol + value map) to a typed event, dedups on the paging
// token, and maps to a graph delta. The live graph wiring is sub-project 4.
import {
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_ATTESTATION_ADDRESS,
} from './config.js'
import { fromScVal } from './scval.js'
import { rpcServer } from './client.js'

// Contracts we watch + the event topic-symbols each emits (docs/soroban-interfaces.md).
// Attestation (F5) emits strategy_attested — surfaced in the public Explorer feed.
const WATCHED = [SOROBAN_REGISTRY_ADDRESS, SOROBAN_VAULT_ADDRESS, SOROBAN_ATTESTATION_ADDRESS]

/**
 * Decode one RPC getEvents record into a typed event.
 * @param {object} rec a getEvents record: { topic: ScVal[], value: ScVal, contractId, ledger, pagingToken, txHash }
 * @returns {{ type: string, contract: string, ledger: number, cursor: string, txHash: string, data: object }}
 */
export function decodeEvent(rec) {
  const type = fromScVal(rec.topic[0]) // first topic is the event name symbol
  const data = fromScVal(rec.value) // event body decoded to a native object
  return {
    type,
    contract: rec.contractId,
    ledger: rec.ledger,
    cursor: rec.pagingToken,
    txHash: rec.txHash,
    data,
  }
}

/**
 * Map a decoded event to a force-graph delta. Returns { node?, edge? } — sub-project 4 applies
 * them. Unknown event types yield an empty delta (forward-compatible).
 * @param {ReturnType<typeof decodeEvent>} e
 * @returns {{ node?: object, edge?: object }}
 */
export function eventToGraphDelta(e) {
  switch (e.type) {
    case 'agent_authorized':
      return {
        node: { id: e.data.agent, kind: 'agent' },
        edge: { source: e.data.owner, target: e.data.agent, kind: 'owns' },
      }
    case 'agent_revoked':
      return { node: { id: e.data.agent, kind: 'agent', revoked: true } }
    case 'vault_deposit':
      return { edge: { source: e.data.from, target: e.contract, kind: 'deposit' } }
    case 'vault_redeem':
      return { edge: { source: e.contract, target: e.data.from, kind: 'redeem' } }
    case 'vault_drip':
      return { node: { id: e.contract, kind: 'vault', lastDrip: e.ledger } }
    case 'vault_claim':
      return { edge: { source: e.contract, target: e.data.holder, kind: 'claim' } }
    default:
      return {}
  }
}

/**
 * Poll new contract events for the watched contracts. Caller persists `seen` + `startLedger`
 * across calls. `seen` dedups across overlapping windows (getEvents is inclusive at the edges).
 * @param {{ server?: object, startLedger: number, seen?: Set<string>, limit?: number }} p
 * @returns {Promise<{ events: Array, deltas: Array, seen: Set<string>, latestLedger: number }>}
 */
export async function pollEvents({ server, startLedger, seen = new Set(), limit = 100 }) {
  const s = server || (await rpcServer())
  const res = await s.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: WATCHED }],
    limit,
  })
  const fresh = []
  for (const rec of res.events || []) {
    if (seen.has(rec.pagingToken)) continue
    seen.add(rec.pagingToken)
    fresh.push(decodeEvent(rec))
  }
  return {
    events: fresh,
    deltas: fresh.map(eventToGraphDelta),
    seen,
    latestLedger: res.latestLedger,
  }
}
