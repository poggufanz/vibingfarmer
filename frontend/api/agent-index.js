// /api/agent-index — Pocket Crew My Money owner→agent index.
//   GET  /api/agent-index?network=<networkId>&owner=<G-or-C-StrKey>   public, read-only
//   POST /api/agent-index?action=ingest                               protected (Bearer secret)
//
// This file is the thin real-world glue (D1 binding, live Soroban RPC, CORS/rate-limit) around
// the pure, unit-tested route logic in agent-index/handler.js — mirrors api/ai.js's split between
// "proxy wiring" and business logic, just with the business logic factored into its own module
// instead of inline, since handler.js needed to be testable without a real D1/RPC.
import { createAgentIndexStore } from './agent-index/store.js'
import { handleAssociationReport, handleIngest, handleRead } from './agent-index/handler.js'
import { scanRpcEventsPage } from './agent-index/indexer.js'
import { rateLimit } from './_guard.js'
import { symbolScVal } from '../src/stellar/scval.js'
import { readContract } from '../src/stellar/client.js'
import { AGENT_INDEX_FINALITY_LEDGERS } from '../src/stellar/agentCreatorManifest.js'

const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const INGEST_SECRET = () => process.env.AGENT_INDEX_INGEST_SECRET || ''
const REPORTER_SECRET = () => process.env.AGENT_INDEX_REPORTER_SECRET || ''
const POOL_TARGETS = new Map([
  ['0x389250872044368759d3db5c09b2706a6628d4e0', 'aave-v3'],
  ['0x5e843a639f0555e2a6669601621befc887bdb479', 'morpho-blue'],
  ['0xadd3c1a75c7cef2516b51750959bd829a4ad4761', 'moonwell'],
])
const SCOPE_REQUIREMENTS = {
  messenger:
    process.env.SOROBAN_CCTP_TOKEN_MESSENGER ||
    'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
  token:
    process.env.SOROBAN_CCTP_USDC_ADDRESS ||
    'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  destinationDomain: 6,
  reportToken: 'USDC',
  reportDecimals: 6,
  scopeDecimals: 7,
}

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
 * string this adapter never has to interpret), not the RPC's native events cursor. Interpreting
 * the raw response (truncation-safe scan bound, tip-arithmetic reachedTip) is `scanRpcEventsPage`
 * (indexer.js) — kept there, not here, so it's unit-testable without a real RPC/D1.
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
      const page = scanRpcEventsPage({
        events: res.events || [],
        cursor: res.cursor,
        latestLedger: res.latestLedger,
        startLedger,
        endLedger,
      })
      return { events: page.events, cursor: null, scannedThroughLedger: page.scannedThroughLedger, latestLedger: page.latestLedger }
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
    const limitParam = url.searchParams.get('limit')
    const store = req.env?.VF_DB ? createAgentIndexStore(req.env.VF_DB) : null
    const out = await handleRead({ networkId, owner, store, limit: limitParam ?? undefined })
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

  if (req.method === 'POST' && url.searchParams.get('action') === 'associate') {
    if (!rateLimit(req, res, { max: 120, windowMs: 60_000, bucket: 'agent-index-associate' }))
      return
    const store = req.env?.VF_DB ? createAgentIndexStore(req.env.VF_DB) : null
    const sdkMod = await import('@stellar/stellar-sdk')
    const server = new sdkMod.rpc.Server(RPC_URL())
    const out = await handleAssociationReport({
      secret: REPORTER_SECRET(),
      providedSecret: bearer(req),
      idempotencyKey: req.headers?.['idempotency-key'] || '',
      store,
      report: req.body,
      scopeReader: ({ bridgeAgent }) =>
        readContract({ contract: bridgeAgent, method: 'scope_of', server }),
      poolTargets: POOL_TARGETS,
      scopeRequirements: SCOPE_REQUIREMENTS,
    })
    return json(res, out.status, out.body)
  }

  return json(res, 404, { error: 'Not found' })
}
