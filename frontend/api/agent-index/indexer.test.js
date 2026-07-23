import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import { createAgentIndexStore } from './store.js'
import { ingestAgentIndexPage, coverageProof } from './indexer.js'
import {
  AGENT_CREATORS,
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_INDEX_MAX_LAG_MS,
} from '../../src/stellar/agentCreatorManifest.js'

// ── same in-memory-D1 helper as store.test.js (MM2) — real node:sqlite running the actual
// migration SQL, never a hand-rolled mock (see store.test.js header for why). ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0001_vf_gate.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0002_agent_index.sql'), 'utf8'))
  function bound(sql, args) {
    return {
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
        const rows = sqlite.prepare(sql).all(...args)
        return { success: true, results: rows }
      },
    }
  }
  return {
    prepare(sql) {
      return { bind: (...args) => bound(sql, args) }
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
    _raw: sqlite,
  }
}

function freshStore() {
  return createAgentIndexStore(fakeD1())
}

// ── real manifest creators (Task 1) — decode fixtures/wasm checks are keyed against these
// exact addresses/hashes, so tests use the live manifest rather than synthetic ones. ──
const ROUTER_V1 = AGENT_CREATORS.find((c) => c.address === 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5')
const ROUTER_V2_BRIDGE = AGENT_CREATORS.find((c) => c.address === 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE')
const ROUTER_LEGACY = AGENT_CREATORS.find((c) => c.address === 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY')
const REGISTRY_CURRENT = AGENT_CREATORS.find((c) => c.address === 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB')
const REGISTRY_LEGACY = AGENT_CREATORS.find((c) => c.address === 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ')

const OWNER_A = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H'
const OWNER_B = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA'
const AGENT_A = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'
const AGENT_B = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW'

function deployedRecord({ owner, agent, cap = 1000n, ledger, txHash, pagingToken, topic = 'deployed' }) {
  return {
    ledger,
    txHash,
    pagingToken: pagingToken ?? `${ledger}-${txHash}-${agent}`,
    topic: [symbolScVal(topic), addrScVal(owner), addrScVal(agent)],
    value: nativeToScVal({ cap }),
  }
}

function authorizedRecord({ owner, agent, ledger, txHash, pagingToken }) {
  return {
    ledger,
    txHash,
    pagingToken: pagingToken ?? `${ledger}-${txHash}-${agent}`,
    topic: [symbolScVal('agent_authorized')],
    value: nativeToScVal({
      owner: addrScVal(owner),
      agent: addrScVal(agent),
      vault: addrScVal(owner),
      token: addrScVal(owner),
      cap_per_period: 1n,
      expiry: 1n,
    }),
  }
}

/** A StellarEventSourceV1 test double whose getEvents ALWAYS reports the full requested range as
 * confirmed (scannedThroughLedger = endLedger), unless overridden. */
function fakeEventSource({
  events = [],
  cursor = null,
  scannedThroughLedger,
  oldestAvailableLedger = 1,
  latestAvailableLedger = 10_000_000,
  getAgentWasmHash,
  providerId = 'test-rpc',
  endpointClass = 'live',
  onGetEvents,
} = {}) {
  return {
    providerId,
    endpointClass,
    oldestAvailableLedger,
    latestAvailableLedger,
    async getEvents(req) {
      onGetEvents?.(req)
      return {
        events,
        cursor,
        scannedThroughLedger: scannedThroughLedger ?? req.endLedger,
      }
    },
    getAgentWasmHash,
  }
}

describe('ingestAgentIndexPage — decode fixtures per manifest creator', () => {
  it('decodes the lowercase `deployed` topic for a current (hardened v1) router', async () => {
    const store = freshStore()
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 5, txHash: 'TX1' })
    const es = fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger })
    const out = await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es, finalizedLedger: ROUTER_V1.coverageStartLedger + 10 })
    expect(out.status).toBe('committed')
    expect(out.membershipCount).toBe(1)
    const rows = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_A })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ address: AGENT_A, owner: OWNER_A, creator: ROUTER_V1.address, kind: 'deposit' })
  })

  it('silently drops a record whose topic is not the lowercase `deployed` symbol (still commits the page)', async () => {
    const store = freshStore()
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 5, txHash: 'TX1', topic: 'Deployed' })
    const es = fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger })
    const out = await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es, finalizedLedger: ROUTER_V1.coverageStartLedger + 10 })
    expect(out.status).toBe('committed')
    expect(out.membershipCount).toBe(0)
  })

  it('decodes the grant-covers-burn v2 router (agent-v3-bridge generation) as kind=unknown, never a guessed bridge', async () => {
    const store = freshStore()
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V2_BRIDGE.coverageStartLedger + 1, txHash: 'TX2' })
    const es = fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V2_BRIDGE.coverageStartLedger })
    await ingestAgentIndexPage({ source: ROUTER_V2_BRIDGE, store, eventSource: es, finalizedLedger: ROUTER_V2_BRIDGE.coverageStartLedger + 5 })
    const rows = await store.readOwnerMemberships({ networkId: ROUTER_V2_BRIDGE.networkId, owner: OWNER_A })
    expect(rows[0].kind).toBe('unknown')
  })

  it('decodes the legacy (pre-hardening) router Deployed schema identically to current routers', async () => {
    const store = freshStore()
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 10, txHash: 'TXLEGACY' })
    // legacy coverageStartLedger is 1 — oldestAvailableLedger below it so no gap triggers.
    const es = fakeEventSource({ events: [rec], oldestAvailableLedger: 1, latestAvailableLedger: 20 })
    const out = await ingestAgentIndexPage({ source: ROUTER_LEGACY, store, eventSource: es, finalizedLedger: 15 })
    expect(out.status).toBe('committed')
    const rows = await store.readOwnerMemberships({ networkId: ROUTER_LEGACY.networkId, owner: OWNER_A })
    expect(rows[0]).toMatchObject({ address: AGENT_A, creator: ROUTER_LEGACY.address, kind: 'deposit' })
  })

  it('decodes registry `agent_authorized` events, proving generation via an on-chain wasm-hash read', async () => {
    const store = freshStore()
    const rec = authorizedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: REGISTRY_CURRENT.coverageStartLedger + 1, txHash: 'TXR1' })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: REGISTRY_CURRENT.coverageStartLedger,
      getAgentWasmHash: async () => 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba', // agent-v3
    })
    const out = await ingestAgentIndexPage({ source: REGISTRY_CURRENT, store, eventSource: es, finalizedLedger: REGISTRY_CURRENT.coverageStartLedger + 5 })
    expect(out.status).toBe('committed')
    const rows = await store.readOwnerMemberships({ networkId: REGISTRY_CURRENT.networkId, owner: OWNER_A })
    expect(rows[0]).toMatchObject({ address: AGENT_A, creator: REGISTRY_CURRENT.address, kind: 'deposit' })
    // registry is not a grant/funding_router relationship — no run labeling.
    expect(rows[0].runId).toBeNull()
    expect(rows[0].runOrdinal).toBeNull()
  })

  it('decodes the legacy registry the same way', async () => {
    const store = freshStore()
    const rec = authorizedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 5, txHash: 'TXR2' })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: 1,
      latestAvailableLedger: 10,
      getAgentWasmHash: async () => '7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717', // agent-v2
    })
    const out = await ingestAgentIndexPage({ source: REGISTRY_LEGACY, store, eventSource: es, finalizedLedger: 8 })
    expect(out.status).toBe('committed')
    const rows = await store.readOwnerMemberships({ networkId: REGISTRY_LEGACY.networkId, owner: OWNER_A })
    expect(rows[0].creator).toBe(REGISTRY_LEGACY.address)
  })
})

describe('ingestAgentIndexPage — empty pages advance only to the RPC-confirmed range', () => {
  it('commits an empty page through scannedThroughLedger, never the full requested endLedger', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const es = fakeEventSource({
      events: [],
      oldestAvailableLedger: start,
      latestAvailableLedger: start + 10_000, // requested end would be far beyond what the "RPC" confirms
      scannedThroughLedger: start + 2_500, // provider only confirms a ~2.5k-ledger window
    })
    const out = await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es, finalizedLedger: start + 10_000 })
    expect(out.status).toBe('committed')
    expect(out.throughLedger).toBe(start + 2_500)
    const { sources } = await store.readCoverage({ networkId: ROUTER_V1.networkId })
    expect(sources[0].indexedThroughLedger).toBe(start + 2_500)
  })
})

describe('ingestAgentIndexPage — duplicate/replay safety', () => {
  it('a later duplicate Deployed event for an already-decoded agent cannot change its owner', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const first = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: start + 1, txHash: 'TX-REAL' })
    const spoof = deployedRecord({ owner: OWNER_B, agent: AGENT_A, ledger: start + 2, txHash: 'TX-SPOOF', pagingToken: 'different-token' })
    const es = fakeEventSource({ events: [first, spoof], oldestAvailableLedger: start })
    await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es, finalizedLedger: start + 10 })
    const ownedByA = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_A })
    const ownedByB = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_B })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A])
    expect(ownedByB).toEqual([])
  })

  it('cursor replay across two calls never corrupts an already-recorded agent (idempotent overlap)', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const rec1 = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: start + 1, txHash: 'TXA' })
    const es1 = fakeEventSource({ events: [rec1], oldestAvailableLedger: start, scannedThroughLedger: start + 5 })
    await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es1, finalizedLedger: start + 20 })

    // Second bounded page starts right after the first; the provider replays the SAME record at
    // the paging boundary (a real getEvents overlap) alongside one genuinely new agent.
    const rec1Again = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: start + 1, txHash: 'TXA' })
    const rec2 = deployedRecord({ owner: OWNER_B, agent: AGENT_B, ledger: start + 6, txHash: 'TXB' })
    const es2 = fakeEventSource({ events: [rec1Again, rec2], oldestAvailableLedger: start, scannedThroughLedger: start + 10 })
    await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es2, finalizedLedger: start + 20 })

    const ownedByA = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_A })
    const ownedByB = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_B })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A]) // not duplicated
    expect(ownedByB.map((r) => r.address)).toEqual([AGENT_B])
  })
})

describe('ingestAgentIndexPage — retention-floor gaps', () => {
  it('records a gap and advances the cursor past ledgers the provider cannot certify', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const es = fakeEventSource({ events: [], oldestAvailableLedger: start + 100, latestAvailableLedger: start + 500 })
    const out = await ingestAgentIndexPage({ source: ROUTER_V1, store, eventSource: es, finalizedLedger: start + 500 })
    expect(out.status).toBe('gapped')
    const { sources, gaps } = await store.readCoverage({ networkId: ROUTER_V1.networkId })
    expect(sources[0].indexedThroughLedger).toBe(start + 99) // cursor moved past the hole
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ fromLedger: start, throughLedger: start + 99, status: 'open' })
    // The proof can never call this contiguous while the gap is open.
    expect(coverageProof({ manifest: { creators: [] }, sources, gaps, backfillAudit: [] }).contiguous).toBe(false)
  })
})

describe('ingestAgentIndexPage — refuses to guess an unverifiable agent generation', () => {
  it('throws (and writes nothing) when a registry event cannot prove its wasm generation', async () => {
    const store = freshStore()
    const rec = authorizedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: REGISTRY_CURRENT.coverageStartLedger + 1, txHash: 'TXR-BAD' })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: REGISTRY_CURRENT.coverageStartLedger,
      getAgentWasmHash: async () => 'deadbeef'.repeat(8), // not in AGENT_WASM_GENERATIONS
    })
    await expect(
      ingestAgentIndexPage({ source: REGISTRY_CURRENT, store, eventSource: es, finalizedLedger: REGISTRY_CURRENT.coverageStartLedger + 5 })
    ).rejects.toThrow(/cannot prove wasm generation/)
    const { sources } = await store.readCoverage({ networkId: REGISTRY_CURRENT.networkId })
    expect(sources).toEqual([]) // nothing committed — never claim coverage over a guess
  })

  it('throws when a registry source has no wasm-hash lookup available at all', async () => {
    const store = freshStore()
    const rec = authorizedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: REGISTRY_CURRENT.coverageStartLedger + 1, txHash: 'TXR-NOFN' })
    const es = fakeEventSource({ events: [rec], oldestAvailableLedger: REGISTRY_CURRENT.coverageStartLedger })
    await expect(
      ingestAgentIndexPage({ source: REGISTRY_CURRENT, store, eventSource: es, finalizedLedger: REGISTRY_CURRENT.coverageStartLedger + 5 })
    ).rejects.toThrow()
  })

  it('rejects a source address the manifest does not recognize', async () => {
    const store = freshStore()
    const es = fakeEventSource({ events: [] })
    await expect(
      ingestAgentIndexPage({ source: { ...ROUTER_V1, address: 'CUNKNOWNROUTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }, store, eventSource: es, finalizedLedger: 100 })
    ).rejects.toThrow(/unknown creator/)
  })
})

// ── coverageProof: the honesty layer. Small synthetic manifests so each scenario is legible. ──

const NET = 'stellar-testnet'
const NOW = 1_800_000_000_000

function creator({ address, coverageStartLedger, deployedLedger = coverageStartLedger }) {
  return {
    networkId: NET,
    address,
    kind: 'funding-router',
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    deployedLedger,
    coverageStartLedger,
    retiredLedger: null,
    deployTx: 'deploy-tx',
    supportedAgentWasmHashes: ['d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'],
    discoverySources: ['router-event'],
  }
}

function sourceRow({ address, coverageStartLedger, indexedThroughLedger = 5000, status = 'ok', lastSuccessAt, manifestHash = AGENT_CREATOR_MANIFEST_HASH, manifestVersion = AGENT_CREATOR_MANIFEST_VERSION, schemaVersion = AGENT_INDEX_SCHEMA_VERSION }) {
  return {
    sourceId: `${NET}:${address}`,
    networkId: NET,
    creatorAddress: address,
    manifestHash,
    manifestVersion,
    schemaVersion,
    indexedFromLedger: coverageStartLedger,
    indexedThroughLedger,
    finalizedThroughLedger: indexedThroughLedger - 2,
    cursor: 'c',
    status,
    lastSuccessAt: lastSuccessAt ?? Math.floor(NOW / 1000),
    lastErrorAt: null,
    lastErrorMessage: null,
  }
}

describe('coverageProof — completeness requires every source, no gaps, within the finality margin', () => {
  it('is complete when a single current creator is fully covered, gap-free, and fresh', () => {
    const CURRENT = creator({ address: 'CCUR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [CURRENT] }
    const sources = [sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 })]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('complete')
    expect(proof.contiguous).toBe(true)
    expect(proof.requiredFinalityLedgers).toBe(2)
  })

  it('is partial when any source has an open gap', () => {
    const CURRENT = creator({ address: 'CCUR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [CURRENT] }
    const sources = [sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 })]
    const gaps = [{ sourceId: `${NET}:${CURRENT.address}`, fromLedger: 1500, throughLedger: 1510, status: 'open' }]
    const proof = coverageProof({ manifest, sources, gaps, backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
    expect(proof.contiguous).toBe(false)
  })

  it('is partial when a source has not indexed from the creator\'s own coverage start', () => {
    const CURRENT = creator({ address: 'CCUR3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [CURRENT] }
    const row = sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 })
    row.indexedFromLedger = 1050 // missed the first 50 ledgers of this creator's history
    const proof = coverageProof({ manifest, sources: [row], gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
  })
})

describe('coverageProof — freshness (20-minute product lag bound)', () => {
  it('is partial/stale once a source last succeeded beyond AGENT_INDEX_MAX_LAG_MS ago, never complete', () => {
    const CURRENT = creator({ address: 'CFRESH1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [CURRENT] }
    const staleSuccessAt = Math.floor((NOW - AGENT_INDEX_MAX_LAG_MS - 60_000) / 1000)
    const sources = [sourceRow({ address: CURRENT.address, coverageStartLedger: 1000, lastSuccessAt: staleSuccessAt })]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
  })
})

describe('coverageProof — unknown creator/manifest identity forces partial', () => {
  it('is partial when a source reports a stale manifestHash (manifest bumped since last ingest)', () => {
    const CURRENT = creator({ address: 'CSTALE1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [CURRENT] }
    const sources = [sourceRow({ address: CURRENT.address, coverageStartLedger: 1000, manifestHash: '0xold' })]
    expect(coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW }).status).toBe('partial')
  })

  it('is partial when a source address is not recognized by the current manifest at all', () => {
    const CURRENT = creator({ address: 'CKNOWN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [CURRENT] }
    const sources = [
      sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 }),
      sourceRow({ address: 'CROGUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1 }),
    ]
    expect(coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW }).status).toBe('partial')
  })
})

describe('coverageProof — historical direct-deploy backfill gate', () => {
  it('current router coverage being perfect cannot, by itself, close the legacy no-deploy-evidence requirement', () => {
    const CURRENT = creator({ address: 'CCUR9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1000 })
    const LEGACY = creator({ address: 'CLEGACY1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1, deployedLedger: null })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT, LEGACY],
    }
    // Both sources look perfect on paper: gap-free, fresh, indexed from their own start.
    const sources = [
      sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 }),
      sourceRow({ address: LEGACY.address, coverageStartLedger: 1 }),
    ]
    // No backfill audit has ever been attempted for the legacy source.
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.historicalBackfill).toBe('pending') // derived from absence, never a stored 'pending' result
    expect(proof.status).toBe('partial')
  })

  it('is complete once every no-deploy-evidence creator has a verified backfill audit', () => {
    const LEGACY = creator({ address: 'CLEGACY2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1, deployedLedger: null })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [LEGACY] }
    const sources = [sourceRow({ address: LEGACY.address, coverageStartLedger: 1 })]
    const backfillAudit = [
      { sourceId: `${NET}:${LEGACY.address}`, result: 'verified', fromLedger: 1, throughLedger: 999 },
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit, now: NOW })
    expect(proof.historicalBackfill).toBe('verified')
    expect(proof.status).toBe('complete')
  })

  it('reports failed when an audit was attempted and failed with no later verified attempt', () => {
    const LEGACY = creator({ address: 'CLEGACY3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', coverageStartLedger: 1, deployedLedger: null })
    const manifest = { version: AGENT_CREATOR_MANIFEST_VERSION, hash: AGENT_CREATOR_MANIFEST_HASH, schemaVersion: AGENT_INDEX_SCHEMA_VERSION, creators: [LEGACY] }
    const sources = [sourceRow({ address: LEGACY.address, coverageStartLedger: 1 })]
    const backfillAudit = [{ sourceId: `${NET}:${LEGACY.address}`, result: 'failed', fromLedger: 1, throughLedger: 999 }]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit, now: NOW })
    expect(proof.historicalBackfill).toBe('failed')
    expect(proof.status).toBe('partial')
  })
})
