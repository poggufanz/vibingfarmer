// Soroban event indexer for the force-graph monitor. Polls RPC getEvents for the registry +
// vault, decodes each record (topic symbol + value map) to a typed event, dedups on the paging
// token, and maps to a graph delta. The live graph wiring is sub-project 4.
import {
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_ATTESTATION_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
} from './config.js'
import { fromScVal, symbolScVal } from './scval.js'
import { rpcServer, readContract, horizonServer } from './client.js'

// Contracts we watch + the event topic-symbols each emits (docs/soroban-interfaces.md).
// Attestation (F5) emits strategy_attested — surfaced in the public Explorer feed.
// Post-cutover the ACTIVE (autofarm) vault is the live deposit target; the old vault stays
// watched so historical sessions keep rendering.
const WATCHED = [
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_ATTESTATION_ADDRESS,
]

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
/**
 * Query Registry for all agent_authorized events belonging to a given owner.
 * Used on page refresh to discover agent addresses when localStorage cache is empty.
 * Registry events embed owner/agent/vault in the value body (not topics), so we
 * filter topic[0]=agent_authorized client-side and match owner after decode.
 * @param {string} ownerAddr - User wallet G... address
 * @param {{ server?: object, startLedger?: number }} [opts]
 * @returns {Promise<string[]>} de-duped agent C... addresses
 */
export async function queryAgentsByOwner(ownerAddr, { server, startLedger } = {}) {
  if (!ownerAddr) return []
  const s = server || (await rpcServer())
  if (!startLedger) {
    const meta = await s.getLatestLedger()
    startLedger = Math.max(1, Number(meta.sequence) - 100000)
  }
  const topic = symbolScVal('agent_authorized').toXDR('base64')
  const res = await s.getEvents({
    startLedger,
    filters: [
      {
        type: 'contract',
        contractIds: [SOROBAN_REGISTRY_ADDRESS],
        topics: [[topic]],
      },
    ],
    limit: 200,
  })
  const seen = new Set()
  const agents = []
  for (const rec of res.events || []) {
    const pt = rec.pagingToken
    if (seen.has(pt)) continue
    seen.add(pt)
    const e = decodeEvent(rec)
    if (e.type !== 'agent_authorized') continue
    if (e.data?.owner?.toLowerCase() !== ownerAddr.toLowerCase()) continue
    const agent = e.data?.agent
    if (agent && !seen.has(agent)) {
      seen.add(agent)
      agents.push(agent)
    }
  }
  return agents
}

/**
 * Discover agent addresses by scanning vault deposit events + verifying owner.
 * Fallback when Registry events are unavailable (registryAuthorize=false, the default).
 * Queries vault_deposit events from the active vault, collects unique agent (holder)
 * addresses, then reads scope_of() on each agent to confirm it belongs to `ownerAddr`.
 *
 * This is more expensive than Registry query (N+1 reads) but works for ALL agents
 * regardless of Registry configuration.
 * @param {string} ownerAddr - User wallet G... address
 * @param {{ server?: object, startLedger?: number }} [opts]
 * @returns {Promise<string[]>} de-duped agent C... addresses
 */
export async function discoverAgentsFromVault(ownerAddr, { server, startLedger } = {}) {
  if (!ownerAddr) return []
  const s = server || (await rpcServer())
  if (!startLedger) {
    const meta = await s.getLatestLedger()
    startLedger = Math.max(1, Number(meta.sequence) - 100000)
  }
  const topic = symbolScVal('vault_deposit').toXDR('base64')
  console.log('[discover] querying vault_deposit from', SOROBAN_ACTIVE_VAULT_ADDRESS, 'owner', ownerAddr, 'ledgerRange', startLedger, '- latest')
  const res = await s.getEvents({
    startLedger,
    filters: [
      {
        type: 'contract',
        contractIds: [SOROBAN_ACTIVE_VAULT_ADDRESS],
        topics: [[topic]],
      },
    ],
    limit: 200,
  })
  console.log('[discover] vault_deposit events count:', res.events?.length)
  if (res.events?.length) {
    console.log('[discover] first event raw:', JSON.stringify(res.events[0], (k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
  }
  const seenPt = new Set()
  const agentSet = new Set()
  for (const rec of res.events || []) {
    const pt = rec.pagingToken
    if (seenPt.has(pt)) continue
    seenPt.add(pt)
    const e = decodeEvent(rec)
    if (e.type !== 'vault_deposit') continue
    console.log('[discover] decoded event type:', e.type, 'keys:', Object.keys(e.data))
    const holder = e.data?.holder
    if (holder) {
      agentSet.add(holder)
    } else {
      console.log('[discover] NO holder field, data:', JSON.stringify(e.data, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
    }
  }
  console.log('[discover] unique agents collected:', [...agentSet])
  // Verify each agent's owner by reading scope_of() from the agent contract.
  // Batch in groups of 10 to avoid RPC throttling on testnet.
  const agents = [...agentSet]
  console.log('[discover] verifying', agents.length, 'agents via scope_of...')
  const found = []
  const BATCH = 10
  for (let i = 0; i < agents.length; i += BATCH) {
    const batch = agents.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map(async (agent) => {
        try {
          const scope = await readContract({ contract: agent, method: 'scope_of', server: s })
          const match = scope?.owner?.toLowerCase() === ownerAddr.toLowerCase()
          console.log('[discover] scope_of', agent, '→ owner:', scope?.owner, 'match:', match)
          return match ? agent : null
        } catch (err) {
          console.warn('[discover] scope_of failed for', agent, err?.message)
          return null
        }
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) found.push(r.value)
    }
  }
  console.log('[discover] verified agents for this owner:', found)
  return found
}

/**
 * Discover agent addresses by scanning Horizon for USDC transfers sent by ownerAddr
 * inside invoke_host_function ops. Each deposit sends USDC from the user wallet to the
 * agent contract — the `to` address of that transfer IS the agent address.
 * Horizon retains full history, unlike RPC getEvents which prunes old ledgers.
 *
 * @param {string} ownerAddr - User wallet G... address
 * @param {{ horizon?: object, rpc?: object }} [opts]
 * @returns {Promise<string[]>} de-duped agent C... addresses
 */
export async function discoverAgentsFromHorizon(ownerAddr, { horizon, rpc } = {}) {
  if (!ownerAddr) return []
  const h = horizon || (await horizonServer())
  const s = rpc || (await rpcServer())
  console.log('[horizon] scanning operations for', ownerAddr)
  const records = []
  let page = null
  let cursor = null
  try {
    do {
      const builder = h.operations().forAccount(ownerAddr).limit(200).order('desc')
      page = cursor ? builder.cursor(cursor) : builder
      page = await page.call()
      records.push(...page.records)
      cursor = page.records.length ? page.records[page.records.length - 1].paging_token : null
      console.log('[horizon] fetched', page.records.length, 'ops, cursor:', cursor?.slice(0, 20))
    } while (page.records.length === 200 && records.length < 2000)
  } catch (err) {
    console.warn('[horizon] operations fetch failed:', err.message)
    return []
  }
  console.log('[horizon] total operations:', records.length + 0)
  const owner = ownerAddr.toLowerCase()
  const agentSet = new Set()
  for (const op of records) {
    if (op.type !== 'invoke_host_function') continue
    const changes = op.asset_balance_changes || []
    for (const c of changes) {
      if (c.asset_code !== 'USDC') continue
      if ((c.from || '').toLowerCase() !== owner) continue
      if (c.to) agentSet.add(c.to)
    }
  }
  console.log('[horizon] unique agent candidates from transfers:', [...agentSet])
  const agents = [...agentSet]
  if (!agents.length) return []
  console.log('[horizon] verifying', agents.length, 'agents via scope_of...')
  const found = []
  const BATCH = 10
  for (let i = 0; i < agents.length; i += BATCH) {
    const batch = agents.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map(async (agent) => {
        try {
          const scope = await readContract({ contract: agent, method: 'scope_of', server: s })
          const match = scope?.owner?.toLowerCase() === owner
          console.log('[horizon] scope_of', agent, '→ owner:', scope?.owner, 'match:', match)
          return match ? agent : null
        } catch (err) {
          console.warn('[horizon] scope_of failed for', agent, err?.message)
          return null
        }
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) found.push(r.value)
    }
  }
  console.log('[horizon] verified agents for this owner:', found)
  return found
}

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
