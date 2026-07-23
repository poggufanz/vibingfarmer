// /api/agent-index — Pocket Crew My Money owner→agent index.
//   GET  /api/agent-index?network=<networkId>&owner=<G-or-C-StrKey>   public, read-only
//   POST /api/agent-index?action=ingest                               protected (Bearer secret)
//
// This file is the thin real-world glue (D1 binding, live Soroban RPC, CORS/rate-limit) around
// the pure, unit-tested route logic in agent-index/handler.js — mirrors api/ai.js's split between
// "proxy wiring" and business logic, just with the business logic factored into its own module
// instead of inline, since handler.js needed to be testable without a real D1/RPC.
import { createAgentIndexStore } from './agent-index/store.js'
import { handleIngest, handleRead } from './agent-index/handler.js'
import { rateLimit } from './_guard.js'
import { symbolScVal } from '../src/stellar/scval.js'
import { AGENT_INDEX_FINALITY_LEDGERS } from '../src/stellar/agentCreatorManifest.js'

const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const INGEST_SECRET = () => process.env.AGENT_INDEX_INGEST_SECRET || ''

function json(res, status, obj) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

function bearer(req) {
  const h = req.headers?.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

async function retentionFloor(server) {
  try {
    const health = await server.getHealth()
    if (Number.isFinite(health?.oldestLedger)) return health.oldestLedger
  } catch {
    /* older RPC without getHealth — floor stays 1 */
  }
  return 1
}

/**
 * Real StellarEventSourceV1 for `source`, backed by the live Soroban RPC.
 * ponytail: one non-cursor ledger-range `getEvents` call per ingestAgentIndexPage invocation —
 * cross-tick resumption already comes from the store's own persisted cursor column (an opaque
 * string this adapter never has to interpret), not the RPC's native events cursor. `events`
 * empty AND the tip not yet reached is the one case this can't move past honestly (it reports the
 * range it actually confirmed rather than guessing); ingestAgentIndexPage then throws and the
 * next scheduled tick retries — fine for a page this bounded, given real windows run ~2-3k
 * ledgers (see stellar/routerEvents.js's own header note on the same RPC).
 */
async function buildEventSource(source, server, sdkMod) {
  const [oldestAvailableLedger, latest] = await Promise.all([retentionFloor(server), server.getLatestLedger()])
  const topics =
    source.kind === 'funding-router'
      ? [[symbolScVal('deployed').toXDR('base64'), '*', '*']]
      : [[symbolScVal('agent_authorized').toXDR('base64')]]
  return {
    providerId: 'soroban-rpc',
    endpointClass: 'live',
    oldestAvailableLedger,
    latestAvailableLedger: latest.sequence,
    async getEvents({ startLedger, endLedger, limit }) {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: 'contract', contractIds: [source.address], topics }],
        limit,
      })
      const events = res.events || []
      const reachedTip = !res.cursor
      const maxSeenLedger = events.reduce((m, e) => Math.max(m, e.ledger || 0), startLedger - 1)
      const scannedThroughLedger = reachedTip ? Math.min(endLedger, res.latestLedger ?? endLedger) : maxSeenLedger
      return { events, cursor: null, scannedThroughLedger }
    },
    // Registry `authorize()` never pins a wasm — only funding-router sources skip this (the
    // manifest's own supportedAgentWasmHashes already proves their generation, see indexer.js).
    getAgentWasmHash:
      source.kind === 'registry'
        ? async (agentAddress) => {
            const entry = await server.getContractData(
              agentAddress,
              sdkMod.xdr.ScVal.scvLedgerKeyContractInstance(),
              sdkMod.rpc.Durability.Persistent
            )
            const exec = entry.val.contractData().val().instance().executable()
            if (exec.switch().name !== 'contractExecutableWasm') return null
            return exec.wasmHash().toString('hex')
          }
        : undefined,
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local')

  if (req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*') // public, read-only, on-chain-derived data
    if (!rateLimit(req, res, { max: 60, windowMs: 60_000, bucket: 'agent-index-read' })) return
    const networkId = url.searchParams.get('network') || ''
    const owner = url.searchParams.get('owner') || ''
    const store = req.env?.VF_DB ? createAgentIndexStore(req.env.VF_DB) : null
    const out = await handleRead({ networkId, owner, store })
    return json(res, out.status, out.body)
  }

  if (req.method === 'POST' && url.searchParams.get('action') === 'ingest') {
    if (!rateLimit(req, res, { max: 6, windowMs: 60_000, bucket: 'agent-index-ingest' })) return
    const store = req.env?.VF_DB ? createAgentIndexStore(req.env.VF_DB) : null
    const sdkMod = await import('@stellar/stellar-sdk')
    const server = new sdkMod.rpc.Server(RPC_URL())
    const out = await handleIngest({
      secret: INGEST_SECRET(),
      providedSecret: bearer(req),
      store,
      eventSourceFor: (source) => buildEventSource(source, server, sdkMod),
      finalizedLedgerFor: async (_source, eventSource) =>
        Math.max(1, eventSource.latestAvailableLedger - AGENT_INDEX_FINALITY_LEDGERS),
    })
    return json(res, out.status, out.body)
  }

  return json(res, 404, { error: 'Not found' })
}
