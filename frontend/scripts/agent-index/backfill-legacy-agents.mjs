#!/usr/bin/env node
// Pocket Crew My Money Task 4 (Wave 2). One-time historical audit for legacy DIRECT-DEPLOY
// agent_accounts — agents with no funding_router `Deployed` event and no registry
// `agent_authorized` event because they predate both entirely (deploy-seed.sh; see
// agentCreatorManifest.js AGENT_WASM_GENERATIONS 'agent-v1' header). This is the ONLY thing that
// can flip coverageProof's `historicalBackfill` out of 'pending' (indexer.js) — via a genuinely
// verified api/agent-index/backfill.js audit, posted through handler.js's handleBackfillCommit.
//
// Candidate union (brief Step 2):
//   1+2. archival router/registry event history, from each legacy creator's coverageStartLedger,
//        via AGENT_INDEX_ARCHIVAL_RPC_URL (a provider implementing the same StellarEventSourceV1
//        getEvents contract Task 3 uses — see pageArchivalSource). Unset/unreachable => that
//        source is honestly reported non-contiguous, never silently skipped.
//   3+4+5. vault deposit-holder history, owner-linked Horizon operations, and known relayer/
//        direct-deploy logs. ponytail: only bullet 5 (KNOWN_DIRECT_DEPLOY_LOGS below) is
//        automated today — 3+4 have no existing on-chain "list holders"/"list creations" helper
//        in this codebase to reuse, and a hand-rolled Horizon-XDR parser untested against live
//        data would risk FALSE coverage claims, worse than an honest gap. Wire real vault/Horizon
//        scanning into that list (or a new collector feeding the same `candidates` array) if a
//        fuller automated sweep is ever needed — until then this audit is expected, correctly, to
//        land on 'partial' rather than pretend completeness it cannot prove (see
//        classifyCandidate's 'missing-provenance'/'scope_of-failed' outcomes for the demo agent).
//
// Run: node scripts/agent-index/backfill-legacy-agents.mjs [--dry-run]
//   --dry-run: classify + print a verdict/evidence-count summary, touch nothing.
//   (no flag):  same classification, then commits through handleBackfillCommit against a LOCAL D1
//     (wrangler `--local` sqlite) using AGENT_INDEX_INGEST_SECRET as both sides of the gate — a
//     real production run needs a remote D1 connection this script does not build (ponytail:
//     local-only; wire the Cloudflare D1 REST API here if a production run is ever needed).
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { rpcServer } from '../../src/stellar/client.js'
import { readAgentScope } from '../../src/stellar/agentCache.js'
import { decodeDeployedEvent } from '../../src/stellar/routerEvents.js'
import { decodeEvent } from '../../src/stellar/events.js'
import { fromScVal, symbolScVal } from '../../src/stellar/scval.js'
import { AGENT_CREATORS, AGENT_CREATOR_MANIFEST_VERSION } from '../../src/stellar/agentCreatorManifest.js'
import { createAgentIndexStore } from '../../api/agent-index/store.js'
import { buildBackfillAudit } from '../../api/agent-index/backfill.js'
import { handleBackfillCommit } from '../../api/agent-index/handler.js'

const NETWORK_ID = 'stellar-testnet'
// funding_router hardened v1 deploy ledger — the moment the router became the mandatory grant
// path (agentCreatorManifest.js isLegacyDirectSetupAllowed gates the dev/test-only direct seam
// from this same production cutoff). A "direct-deploy" candidate found after this ledger via
// anything other than a router/registry event is out of scope for a HISTORICAL audit.
export const DIRECT_SETUP_CUTOFF_LEDGER = 3_593_274

// Bullet 5: known relayer/direct-deploy logs supplied explicitly — the only discovery path for an
// agent with NO router/registry event at all (predates both). `creationLedger`/`creationTx` stay
// `null` where deployments/stellar-testnet.json genuinely never recorded them (see
// agentCreatorManifest.js header) — never guessed. That is precisely why this candidate resolves
// to 'unresolved' (missing-provenance) today, not 'verified': an honest partial, not a fabricated
// complete.
export const KNOWN_DIRECT_DEPLOY_LOGS = [
  {
    networkId: NETWORK_ID,
    address: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC', // demoAgentAccount
    ownerAddress: 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS', // demoAgentOwner
    wasmHash: '8c607112ba93ff289d30f2c894ca586c745328e5cb2ae6139917c6df540dda62', // agent-v1
    creationLedger: null,
    creationTx: null,
    evidenceKind: 'relayer-log',
    kind: 'deposit',
  },
]

export function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') }
}

/** Bullets 1+2: normalize one decoded event into the shared candidate shape (backfill.js
 * classifyCandidate's input). Reuses the exact decode helpers indexer.js's ordinary ingest path
 * already relies on — no new ScVal-decoding logic lives here. */
export function candidateFromRouterEvent(creator, rec) {
  const d = decodeDeployedEvent(rec)
  if (!d || !d.agent || !d.owner || !d.txHash) return null
  return {
    networkId: creator.networkId,
    address: d.agent,
    ownerAddress: d.owner,
    creatorAddress: creator.address,
    creationLedger: d.ledger,
    creationTx: d.txHash,
    // The router only ever deploys its own constructor-pinned wasm (on-chain enforced) — no RPC
    // round trip needed, same reasoning as indexer.js resolveAgentGeneration.
    wasmHash: creator.supportedAgentWasmHashes?.[0] ?? null,
    evidenceKind: 'router-event',
    kind: 'deposit',
  }
}

/** Bullets 1+2: registry side. `authorize()` never pins a wasm — the caller must resolve
 * `wasmHash` itself (a contract-instance read, see buildRegistryWasmLookup) and pass it in;
 * `undefined` (lookup attempted, failed) is distinguished from `null` (nothing to look up) via
 * `wasmLookupFailed` so classifyCandidate never confuses "unknown" with "couldn't check". */
export function candidateFromRegistryEvent(creator, rec, wasmHash) {
  let topic0
  try {
    topic0 = fromScVal(rec.topic[0])
  } catch {
    return null
  }
  if (topic0 !== 'agent_authorized') return null
  let e
  try {
    e = decodeEvent(rec)
  } catch {
    return null
  }
  const agentAddress = e.data?.agent
  const ownerAddress = e.data?.owner
  if (!agentAddress || !ownerAddress || !e.txHash) return null
  return {
    networkId: creator.networkId,
    address: agentAddress,
    ownerAddress,
    creatorAddress: creator.address,
    creationLedger: e.ledger,
    creationTx: e.txHash,
    wasmHash: wasmHash ?? null,
    wasmLookupFailed: wasmHash === undefined,
    evidenceKind: 'registry-authorization',
    kind: 'unknown',
  }
}

/** Bounded, honest pager over one archival `StellarEventSourceV1` (same contract as
 * indexer.js/api/agent-index.js's live one — only `providerId`/`endpointClass`/retention differ).
 * Returns raw events only — decoding is the caller's job (candidateFromRouterEvent/
 * candidateFromRegistryEvent), keeping this function a single-responsibility pager.
 * `contiguous` is true ONLY when the loop actually reached the reported tip — a provider that
 * keeps truncating never gets to claim it, it just runs out of `maxPages` and reports honestly. */
export async function pageArchivalSource({ creator, eventSource, limit = 200, maxPages = 2000 }) {
  const events = []
  let startLedger = creator.coverageStartLedger
  let cursor
  for (let page = 0; page < maxPages; page++) {
    const latestLedger = eventSource.latestAvailableLedger
    const endLedger = Number.isInteger(latestLedger) ? latestLedger : startLedger + 100_000
    const res = await eventSource.getEvents({ startLedger, endLedger, cursor, limit })
    events.push(...(res.events ?? []))
    const scannedThroughLedger = Number.isInteger(res.scannedThroughLedger) ? res.scannedThroughLedger : endLedger
    const tip = Number.isInteger(res.latestLedger) ? res.latestLedger : latestLedger
    if (Number.isInteger(tip) && scannedThroughLedger >= tip) {
      return { events, contiguous: true, scannedThroughLedger, latestLedger: tip }
    }
    if (!res.cursor && scannedThroughLedger >= endLedger) {
      return { events, contiguous: true, scannedThroughLedger, latestLedger: tip ?? endLedger }
    }
    startLedger = scannedThroughLedger + 1
    cursor = res.cursor
  }
  return { events, contiguous: false, scannedThroughLedger: startLedger - 1, latestLedger: eventSource.latestAvailableLedger ?? null }
}

async function buildArchivalEventSource(creator) {
  const url = process.env.AGENT_INDEX_ARCHIVAL_RPC_URL
  if (!url) return null
  const sdkMod = await import('@stellar/stellar-sdk')
  const server = new sdkMod.rpc.Server(url)
  let health
  try {
    health = await server.getHealth()
  } catch {
    health = null
  }
  let latest
  try {
    latest = await server.getLatestLedger()
  } catch {
    return null
  }
  const topics =
    creator.kind === 'funding-router'
      ? [[symbolScVal('deployed').toXDR('base64'), '*', '*']]
      : [[symbolScVal('agent_authorized').toXDR('base64')]]
  return {
    providerId: process.env.AGENT_INDEX_ARCHIVAL_PROVIDER_ID || 'archival-rpc',
    endpointClass: 'archival',
    oldestAvailableLedger: Number.isFinite(health?.oldestLedger) ? health.oldestLedger : 1,
    latestAvailableLedger: latest.sequence,
    async getEvents({ startLedger, endLedger, cursor, limit }) {
      const res = await server.getEvents({
        startLedger,
        cursor,
        filters: [{ type: 'contract', contractIds: [creator.address], topics }],
        limit,
      })
      return { events: res.events || [], cursor: res.cursor ?? null, latestLedger: res.latestLedger, scannedThroughLedger: endLedger }
    },
  }
}

async function collectArchivalSource(creator) {
  const eventSource = await buildArchivalEventSource(creator).catch(() => null)
  if (!eventSource) {
    return {
      sourceEntry: {
        kind: creator.kind,
        address: creator.address,
        providerId: null,
        oldestAvailableLedger: null,
        fromLedger: creator.coverageStartLedger,
        throughLedger: creator.coverageStartLedger,
        contiguous: false,
        evidenceHash: null,
      },
      candidates: [],
    }
  }
  const decode =
    creator.kind === 'funding-router'
      ? (rec) => candidateFromRouterEvent(creator, rec)
      : (rec) => candidateFromRegistryEvent(creator, rec, undefined) // registry wasm lookup: see ponytail note in module header

  let page
  try {
    page = await pageArchivalSource({ creator, eventSource })
  } catch {
    page = { events: [], contiguous: false, scannedThroughLedger: creator.coverageStartLedger - 1 }
  }
  return {
    sourceEntry: {
      kind: creator.kind,
      address: creator.address,
      providerId: eventSource.providerId,
      oldestAvailableLedger: eventSource.oldestAvailableLedger,
      fromLedger: creator.coverageStartLedger,
      throughLedger: Math.max(page.scannedThroughLedger, creator.coverageStartLedger),
      contiguous: page.contiguous,
      evidenceHash: null,
    },
    candidates: page.events.map(decode).filter(Boolean),
  }
}

/** Resolves scope_of live (the agent contract itself still exists on-chain regardless of how far
 * back it was created — this is a live read, never archival). Errors -> `null` scope, which
 * classifyCandidate honestly turns into 'unresolved'/'scope_of-failed', never a guess. */
async function hydrateScope(candidate, server) {
  const scope = await readAgentScope(candidate.address, { server })
  return { ...candidate, scope }
}

/** Finds a LOCAL wrangler D1 sqlite file (the `--local` dev database), or null if none exists —
 * ponytail: local-only, see module header. */
function findLocalD1File() {
  const dir = join(process.cwd(), '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite'))
  return file ? join(dir, file) : null
}

async function openLocalStore() {
  const path = findLocalD1File()
  if (!path) return null
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const sqlite = new DatabaseSync(path)
  const db = {
    prepare(sql) {
      return {
        bind: (...args) => ({
          run() {
            const info = sqlite.prepare(sql).run(...args)
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
          },
          first(column) {
            const row = sqlite.prepare(sql).get(...args)
            if (!row) return null
            return column ? row[column] : row
          },
          all() {
            return { success: true, results: sqlite.prepare(sql).all(...args) }
          },
        }),
      }
    },
    batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => s.run())
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  }
  return createAgentIndexStore(db)
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2))
  const legacyCreators = AGENT_CREATORS.filter((c) => c.coverageStartLedger === 1)

  const collected = await Promise.all(legacyCreators.map((c) => collectArchivalSource(c)))
  const sources = collected.map((c) => c.sourceEntry)
  const rawCandidates = [...collected.flatMap((c) => c.candidates), ...KNOWN_DIRECT_DEPLOY_LOGS]

  const server = await rpcServer()
  const hydrated = await Promise.all(rawCandidates.map((c) => hydrateScope(c, server)))

  const audit = buildBackfillAudit({
    auditId: `${NETWORK_ID}-legacy-backfill-${Date.now()}`,
    networkId: NETWORK_ID,
    fromLedger: 1,
    throughLedger: Math.max(1, ...sources.map((s) => s.throughLedger)),
    directSetupCutoffLedger: DIRECT_SETUP_CUTOFF_LEDGER,
    creatorManifestVersion: AGENT_CREATOR_MANIFEST_VERSION,
    sources,
    candidates: hydrated,
    completedAt: Math.floor(Date.now() / 1000),
  })

  console.log(`\nLegacy direct-deploy backfill audit: ${audit.auditId}`)
  console.log(`  verdict:              ${audit.verdict}`)
  console.log(`  sources examined:     ${audit.sources.length} (contiguous: ${audit.sources.filter((s) => s.contiguous).length})`)
  console.log(`  candidates examined:  ${audit.candidates.length}`)
  console.log(`  verified agents:      ${audit.verifiedAgents.length}`)
  console.log(`  rejected candidates:  ${audit.rejectedCandidates.length}`)
  console.log(`  unresolved candidates:${audit.unresolvedCandidates.length}`)
  for (const u of audit.unresolvedCandidates) console.log(`    unresolved: ${u.candidate.address} (${u.reason})`)
  for (const r of audit.rejectedCandidates) console.log(`    rejected:   ${r.candidate.address} (${r.reason})`)

  if (dryRun) {
    console.log('\n--dry-run: D1 untouched.')
    return
  }

  const secret = process.env.AGENT_INDEX_INGEST_SECRET || ''
  if (!secret) throw new Error('AGENT_INDEX_INGEST_SECRET is not set — refusing to write without an authorized gate')
  const store = await openLocalStore()
  if (!store) throw new Error('No local D1 database found (.wrangler/state/v3/d1) — run `npx wrangler d1 migrations apply vf-gate --local` first, or use --dry-run')
  const out = await handleBackfillCommit({ secret, providedSecret: secret, store, audit })
  if (out.status !== 200) throw new Error(`commit failed: ${JSON.stringify(out.body)}`)
  console.log(`\ncommitted: ${JSON.stringify(out.body)}`)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
