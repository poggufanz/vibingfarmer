import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import { createAgentIndexStore } from './store.js'
import { ingestAgentIndexPage, coverageProof, scanRpcEventsPage } from './indexer.js'
import { AgentIndexConflictError } from './models.js'
import {
  AGENT_CREATORS,
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_INDEX_MAX_LAG_MS,
  AGENT_INDEX_FINALITY_LEDGERS,
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
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0003_agent_index_bounds.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0007_agent_membership_owner_pages.sql'), 'utf8'))
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
const ROUTER_V1 = AGENT_CREATORS.find(
  (c) => c.address === 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
)
const ROUTER_V2_BRIDGE = AGENT_CREATORS.find(
  (c) => c.address === 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
)
const ROUTER_LEGACY = AGENT_CREATORS.find(
  (c) => c.address === 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
)
const REGISTRY_CURRENT = AGENT_CREATORS.find(
  (c) => c.address === 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB'
)
const REGISTRY_LEGACY = AGENT_CREATORS.find(
  (c) => c.address === 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
)

const OWNER_A = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H'
const OWNER_B = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA'
const AGENT_A = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'
const AGENT_B = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW'
const AGENT_C = 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB'

function deployedRecord({
  owner,
  agent,
  cap = 1000n,
  ledger,
  txHash,
  pagingToken,
  topic = 'deployed',
}) {
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
    const rec = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V1.coverageStartLedger + 5,
      txHash: 'TX1',
    })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
    })
    const out = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es,
      finalizedLedger: ROUTER_V1.coverageStartLedger + 10,
    })
    expect(out.status).toBe('committed')
    expect(out.membershipCount).toBe(1)
    const rows = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      address: AGENT_A,
      owner: OWNER_A,
      creator: ROUTER_V1.address,
      kind: 'deposit',
    })
  })

  it('silently drops a record whose topic is not the lowercase `deployed` symbol (still commits the page)', async () => {
    const store = freshStore()
    const rec = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V1.coverageStartLedger + 5,
      txHash: 'TX1',
      topic: 'Deployed',
    })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
    })
    const out = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es,
      finalizedLedger: ROUTER_V1.coverageStartLedger + 10,
    })
    expect(out.status).toBe('committed')
    expect(out.membershipCount).toBe(0)
  })

  it('decodes the grant-covers-burn v2 router (agent-v3-bridge generation) as kind=unknown, never a guessed bridge', async () => {
    const store = freshStore()
    const rec = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V2_BRIDGE.coverageStartLedger + 1,
      txHash: 'TX2',
    })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: ROUTER_V2_BRIDGE.coverageStartLedger,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V2_BRIDGE,
      store,
      eventSource: es,
      finalizedLedger: ROUTER_V2_BRIDGE.coverageStartLedger + 5,
    })
    const rows = await store.readOwnerMemberships({
      networkId: ROUTER_V2_BRIDGE.networkId,
      owner: OWNER_A,
    })
    expect(rows[0].kind).toBe('unknown')
  })

  it('decodes the legacy (pre-hardening) router Deployed schema identically to current routers', async () => {
    const store = freshStore()
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 10, txHash: 'TXLEGACY' })
    // legacy coverageStartLedger is 1 — oldestAvailableLedger below it so no gap triggers.
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: 1,
      latestAvailableLedger: 20,
    })
    const out = await ingestAgentIndexPage({
      source: ROUTER_LEGACY,
      store,
      eventSource: es,
      finalizedLedger: 15,
    })
    expect(out.status).toBe('committed')
    const rows = await store.readOwnerMemberships({
      networkId: ROUTER_LEGACY.networkId,
      owner: OWNER_A,
    })
    expect(rows[0]).toMatchObject({
      address: AGENT_A,
      creator: ROUTER_LEGACY.address,
      kind: 'deposit',
    })
  })

  it('decodes registry `agent_authorized` events, proving generation via an on-chain wasm-hash read', async () => {
    const store = freshStore()
    const rec = authorizedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: REGISTRY_CURRENT.coverageStartLedger + 1,
      txHash: 'TXR1',
    })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: REGISTRY_CURRENT.coverageStartLedger,
      getAgentWasmHash: async () =>
        'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba', // agent-v3
    })
    const out = await ingestAgentIndexPage({
      source: REGISTRY_CURRENT,
      store,
      eventSource: es,
      finalizedLedger: REGISTRY_CURRENT.coverageStartLedger + 5,
    })
    expect(out.status).toBe('committed')
    const rows = await store.readOwnerMemberships({
      networkId: REGISTRY_CURRENT.networkId,
      owner: OWNER_A,
    })
    expect(rows[0]).toMatchObject({
      address: AGENT_A,
      creator: REGISTRY_CURRENT.address,
      kind: 'deposit',
    })
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
      getAgentWasmHash: async () =>
        '7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717', // agent-v2
    })
    const out = await ingestAgentIndexPage({
      source: REGISTRY_LEGACY,
      store,
      eventSource: es,
      finalizedLedger: 8,
    })
    expect(out.status).toBe('committed')
    const rows = await store.readOwnerMemberships({
      networkId: REGISTRY_LEGACY.networkId,
      owner: OWNER_A,
    })
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
    const out = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es,
      finalizedLedger: start + 10_000,
    })
    expect(out.status).toBe('committed')
    expect(out.throughLedger).toBe(start + 2_500)
    const { sources } = await store.readCoverage({ networkId: ROUTER_V1.networkId })
    expect(sources[0].indexedThroughLedger).toBe(start + 2_500)
  })
})

describe('ingestAgentIndexPage — canonical router deployment order', () => {
  it('assigns same-transaction ordinals by authoritative paging token, independent of response order and replay', async () => {
    const store = freshStore()
    const start = ROUTER_V2_BRIDGE.coverageStartLedger
    const ledger = start + 3
    const txHash = 'TX-CANONICAL-ORDER'
    const shuffled = [
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_C,
        ledger,
        txHash,
        pagingToken: '30',
      }),
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_A,
        ledger,
        txHash,
        pagingToken: '10',
      }),
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_B,
        ledger,
        txHash,
        pagingToken: '20',
      }),
    ]

    await ingestAgentIndexPage({
      source: ROUTER_V2_BRIDGE,
      store,
      eventSource: fakeEventSource({
        events: shuffled,
        cursor: 'page-1',
        oldestAvailableLedger: start,
        scannedThroughLedger: ledger,
      }),
      finalizedLedger: ledger + 10,
    })

    const beforeReplay = await store.readOwnerMemberships({
      networkId: ROUTER_V2_BRIDGE.networkId,
      owner: OWNER_A,
    })
    const byAddress = new Map(beforeReplay.map((row) => [row.address, row]))
    expect(byAddress.get(AGENT_A).runOrdinal).toBe(0)
    expect(byAddress.get(AGENT_B).runOrdinal).toBe(1)
    expect(byAddress.get(AGENT_C).runOrdinal).toBe(2)
    expect([...byAddress.values()].every((row) => row.kind === 'unknown')).toBe(true)

    const replay = await ingestAgentIndexPage({
      source: ROUTER_V2_BRIDGE,
      store,
      eventSource: fakeEventSource({
        events: [shuffled[1], shuffled[2], shuffled[0]],
        cursor: 'page-2',
        oldestAvailableLedger: start,
        scannedThroughLedger: ledger + 1,
      }),
      finalizedLedger: ledger + 10,
    })
    expect(replay.membershipCount).toBe(0)
    expect(
      await store.readOwnerMemberships({
        networkId: ROUTER_V2_BRIDGE.networkId,
        owner: OWNER_A,
      })
    ).toEqual(beforeReplay)
  })

  it('drops an incomplete boundary ledger, then assigns all same-transaction ordinals together from its complete replay', async () => {
    const store = freshStore()
    const start = ROUTER_V2_BRIDGE.coverageStartLedger
    const boundaryLedger = start + 7
    const txHash = 'TX-BOUNDARY-ORDER'
    const records = [
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_C,
        ledger: boundaryLedger,
        txHash,
        pagingToken: '30',
      }),
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_A,
        ledger: boundaryLedger,
        txHash,
        pagingToken: '10',
      }),
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_B,
        ledger: boundaryLedger,
        txHash,
        pagingToken: '20',
      }),
    ]

    const firstPage = scanRpcEventsPage({
      events: [records[2]],
      cursor: 'more',
      latestLedger: boundaryLedger + 100,
      startLedger: start,
      endLedger: boundaryLedger + 50,
      limit: 1,
    })
    const first = await ingestAgentIndexPage({
      source: ROUTER_V2_BRIDGE,
      store,
      eventSource: fakeEventSource({
        events: firstPage.events,
        cursor: 'page-1',
        oldestAvailableLedger: start,
        scannedThroughLedger: firstPage.scannedThroughLedger,
      }),
      finalizedLedger: boundaryLedger + 50,
    })
    expect(first.throughLedger).toBe(boundaryLedger - 1)
    expect(first.membershipCount).toBe(0)

    const completePage = scanRpcEventsPage({
      events: records,
      cursor: null,
      latestLedger: boundaryLedger,
      startLedger: boundaryLedger,
      endLedger: boundaryLedger,
    })
    const second = await ingestAgentIndexPage({
      source: ROUTER_V2_BRIDGE,
      store,
      eventSource: fakeEventSource({
        events: completePage.events,
        oldestAvailableLedger: start,
        latestAvailableLedger: boundaryLedger,
        scannedThroughLedger: completePage.scannedThroughLedger,
      }),
      finalizedLedger: boundaryLedger,
    })
    expect(second.membershipCount).toBe(3)
    const rows = await store.readOwnerMemberships({
      networkId: ROUTER_V2_BRIDGE.networkId,
      owner: OWNER_A,
    })
    const byAddress = new Map(rows.map((row) => [row.address, row]))
    expect(byAddress.get(AGENT_A).runOrdinal).toBe(0)
    expect(byAddress.get(AGENT_B).runOrdinal).toBe(1)
    expect(byAddress.get(AGENT_C).runOrdinal).toBe(2)
  })

  it('fails the whole router page when a matched deployment has no paging token to prove order', async () => {
    const store = freshStore()
    const start = ROUTER_V2_BRIDGE.coverageStartLedger
    const record = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TX-NO-PAGING-TOKEN',
    })
    delete record.pagingToken

    await expect(
      ingestAgentIndexPage({
        source: ROUTER_V2_BRIDGE,
        store,
        eventSource: fakeEventSource({ events: [record], oldestAvailableLedger: start }),
        finalizedLedger: start + 10,
      })
    ).rejects.toThrow(/paging token/i)

    const { sources } = await store.readCoverage({ networkId: ROUTER_V2_BRIDGE.networkId })
    expect(sources).toMatchObject([
      {
        status: 'error',
        indexedThroughLedger: start - 1,
        lastErrorMessage: expect.stringMatching(/paging token/i),
      },
    ])
    expect(
      await store.readOwnerMemberships({
        networkId: ROUTER_V2_BRIDGE.networkId,
        owner: OWNER_A,
      })
    ).toEqual([])
  })
})

describe('ingestAgentIndexPage — duplicate/replay safety', () => {
  it('a later duplicate Deployed event for an already-decoded agent cannot change its owner', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const first = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TX-REAL',
    })
    const spoof = deployedRecord({
      owner: OWNER_B,
      agent: AGENT_A,
      ledger: start + 2,
      txHash: 'TX-SPOOF',
      pagingToken: 'different-token',
    })
    const es = fakeEventSource({ events: [first, spoof], oldestAvailableLedger: start })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es,
      finalizedLedger: start + 10,
    })
    const ownedByA = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    const ownedByB = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_B,
    })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A])
    expect(ownedByB).toEqual([])
  })

  it('cursor replay across two calls never corrupts an already-recorded agent (idempotent overlap)', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const rec1 = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TXA',
    })
    const es1 = fakeEventSource({
      events: [rec1],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 5,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es1,
      finalizedLedger: start + 20,
    })

    // Second bounded page starts right after the first; the provider replays the SAME record at
    // the paging boundary (a real getEvents overlap) alongside one genuinely new agent.
    const rec1Again = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TXA',
    })
    const rec2 = deployedRecord({
      owner: OWNER_B,
      agent: AGENT_B,
      ledger: start + 6,
      txHash: 'TXB',
    })
    const es2 = fakeEventSource({
      events: [rec1Again, rec2],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 10,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es2,
      finalizedLedger: start + 20,
    })

    const ownedByA = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    const ownedByB = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_B,
    })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A]) // not duplicated
    expect(ownedByB.map((r) => r.address)).toEqual([AGENT_B])
  })

  it('a duplicate deployed event in a LATER page can never rewrite an already-indexed agent (Spec-partial 6)', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const first = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TX-REAL',
    })
    const es1 = fakeEventSource({
      events: [first],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 5,
    })
    const out1 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es1,
      finalizedLedger: start + 100,
    })
    expect(out1.membershipCount).toBe(1)

    // A LATER page (later ledger, cross-tick) re-emits AGENT_A under a different owner — a spoof
    // or a corrupt replay. It must be dropped, never flow into commitSourcePage's ON CONFLICT.
    const spoof = deployedRecord({
      owner: OWNER_B,
      agent: AGENT_A,
      ledger: start + 6,
      txHash: 'TX-SPOOF',
    })
    const es2 = fakeEventSource({
      events: [spoof],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 10,
    })
    const out2 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es2,
      finalizedLedger: start + 100,
    })
    expect(out2.membershipCount).toBe(0)
    expect(out2.duplicateCount).toBe(1)

    const ownedByA = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    const ownedByB = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_B,
    })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A]) // ownership never moved
    expect(ownedByB).toEqual([])
  })

  it('an identical re-emission in a later page is a harmless no-op, not counted as a rewrite', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const first = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TX-REAL',
    })
    const es1 = fakeEventSource({
      events: [first],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 5,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es1,
      finalizedLedger: start + 100,
    })

    const echo = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TX-REAL',
      pagingToken: 'later-page-echo',
    })
    const es2 = fakeEventSource({
      events: [echo],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 10,
    })
    const out2 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es2,
      finalizedLedger: start + 100,
    })
    expect(out2.membershipCount).toBe(0)
    expect(out2.duplicateCount).toBeUndefined() // identical — nothing to flag
  })
})

describe('ingestAgentIndexPage — decode failure fails closed (Important 4)', () => {
  it('a matching-topic record that fails to decode aborts the whole page — never commits, marks the source error, next tick can retry', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    // topic matches 'deployed' but the value body is missing `cap` — schema drift.
    const bad = {
      ledger: start + 1,
      txHash: 'TX-BAD',
      pagingToken: `${start + 1}-TX-BAD`,
      topic: [symbolScVal('deployed'), addrScVal(OWNER_A), addrScVal(AGENT_A)],
      value: nativeToScVal({}),
    }
    const es = fakeEventSource({ events: [bad], oldestAvailableLedger: start })
    await expect(
      ingestAgentIndexPage({
        source: ROUTER_V1,
        store,
        eventSource: es,
        finalizedLedger: start + 10,
      })
    ).rejects.toThrow(/schema drift|failed to decode/)

    const { sources } = await store.readCoverage({ networkId: ROUTER_V1.networkId })
    expect(sources).toHaveLength(1)
    expect(sources[0].status).toBe('error')
    expect(sources[0].indexedThroughLedger).toBe(start - 1) // cursor never advanced past the bad page
    expect(sources[0].lastErrorMessage).toMatch(/schema drift|failed to decode/)

    // Next tick retries the exact same range — no membership was ever written.
    const owned = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    expect(owned).toEqual([])
  })
})

describe('ingestAgentIndexPage — immutable membership conflict diagnostics', () => {
  it('records the source error without advancing coverage or mutating the original membership', async () => {
    const store = freshStore()
    const start = ROUTER_V2_BRIDGE.coverageStartLedger
    const original = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: start + 1,
      txHash: 'TX-ORIGINAL',
      pagingToken: '10',
    })
    await ingestAgentIndexPage({
      source: ROUTER_V2_BRIDGE,
      store,
      eventSource: fakeEventSource({
        events: [original],
        cursor: 'page-1',
        oldestAvailableLedger: start,
        scannedThroughLedger: start + 1,
      }),
      finalizedLedger: start + 10,
    })
    const before = await store.readOwnerMemberships({
      networkId: ROUTER_V2_BRIDGE.networkId,
      owner: OWNER_A,
    })

    // Simulate an immutable row appearing after the indexer's read-before-write duplicate check.
    const racingStore = {
      ...store,
      readMembershipsByAgentAddresses: async () => [],
    }
    const conflict = deployedRecord({
      owner: OWNER_B,
      agent: AGENT_A,
      ledger: start + 2,
      txHash: 'TX-CONFLICT',
      pagingToken: '20',
    })
    await expect(
      ingestAgentIndexPage({
        source: ROUTER_V2_BRIDGE,
        store: racingStore,
        eventSource: fakeEventSource({
          events: [conflict],
          cursor: 'page-2',
          oldestAvailableLedger: start,
          scannedThroughLedger: start + 2,
        }),
        finalizedLedger: start + 10,
      })
    ).rejects.toThrow(AgentIndexConflictError)

    const { sources } = await store.readCoverage({ networkId: ROUTER_V2_BRIDGE.networkId })
    expect(sources[0]).toMatchObject({
      status: 'error',
      indexedThroughLedger: start + 1,
      cursor: 'page-1',
      lastErrorMessage: expect.stringMatching(/immutable agent membership identity conflict/i),
    })
    expect(
      await store.readOwnerMemberships({
        networkId: ROUTER_V2_BRIDGE.networkId,
        owner: OWNER_A,
      })
    ).toEqual(before)
    expect(
      await store.readOwnerMemberships({
        networkId: ROUTER_V2_BRIDGE.networkId,
        owner: OWNER_B,
      })
    ).toEqual([])
  })
})

describe('ingestAgentIndexPage — scanRpcEventsPage never loses a mid-ledger-truncated deploy (Critical 2)', () => {
  it("a truncated page followed by the next page delivers BOTH of a boundary ledger's deploys, never one", async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const boundaryLedger = start + 50

    // First RPC response: truncated by `limit` mid-ledger — only the FIRST of two deploys at the
    // boundary ledger came back before the cutoff, and `latestLedger` proves the real chain tip
    // is still far ahead (a genuine truncation, not "we reached the tip and it's just sparse").
    const es1 = {
      providerId: 'test-rpc',
      endpointClass: 'live',
      oldestAvailableLedger: start,
      latestAvailableLedger: start + 10_000,
      async getEvents({ startLedger, endLedger }) {
        const rec = deployedRecord({
          owner: OWNER_A,
          agent: AGENT_A,
          ledger: boundaryLedger,
          txHash: 'TX-FIRST',
        })
        // The real chain tip (as reported by THIS response) is far beyond our bounded request
        // window — proves this is a genuine mid-window truncation, not "sparse but at tip".
        const page = scanRpcEventsPage({
          events: [rec],
          cursor: 'more',
          latestLedger: start + 1_000_000,
          startLedger,
          endLedger,
        })
        return {
          events: page.events,
          cursor: null,
          scannedThroughLedger: page.scannedThroughLedger,
          latestLedger: page.latestLedger,
        }
      },
    }
    const out1 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es1,
      finalizedLedger: start + 10_000,
    })
    expect(out1.throughLedger).toBe(boundaryLedger - 1) // boundary ledger NOT claimed complete
    expect(out1.membershipCount).toBe(0) // its (possibly partial) events were held back, not written

    // Second page starts exactly at the boundary ledger — the RPC now returns BOTH deploys for it.
    const es2 = {
      providerId: 'test-rpc',
      endpointClass: 'live',
      oldestAvailableLedger: start,
      latestAvailableLedger: start + 10_000,
      async getEvents({ startLedger, endLedger }) {
        const recs = [
          deployedRecord({
            owner: OWNER_A,
            agent: AGENT_A,
            ledger: boundaryLedger,
            txHash: 'TX-FIRST',
          }),
          deployedRecord({
            owner: OWNER_B,
            agent: AGENT_B,
            ledger: boundaryLedger,
            txHash: 'TX-SECOND',
          }),
        ]
        const page = scanRpcEventsPage({
          events: recs,
          cursor: null,
          latestLedger: start + 10_000,
          startLedger,
          endLedger,
        })
        return {
          events: page.events,
          cursor: null,
          scannedThroughLedger: page.scannedThroughLedger,
          latestLedger: page.latestLedger,
        }
      },
    }
    const out2 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es2,
      finalizedLedger: start + 10_000,
    })
    expect(out2.membershipCount).toBe(2) // BOTH deploys land — the second one was never lost
    const ownedByA = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    const ownedByB = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_B,
    })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A])
    expect(ownedByB.map((r) => r.address)).toEqual([AGENT_B])
  })

  it('nothing is lost in the REALISTIC production shape — endLedger === latestLedger, limit-capped, cursor set (regression re-fix)', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const boundaryLedger = start + 50
    const tip = start + 5000

    // The adapter's endLedger IS the pre-call tip snapshot, and latestLedger is ~the same ledger —
    // this is exactly the shape the earlier fix's tip-arithmetic-first logic mishandled: with
    // endLedger === latestLedger, `endLedger >= latestLedger` is trivially true even though the
    // page was cut off by `limit`. Truncation evidence must win.
    const es1 = {
      providerId: 'test-rpc',
      endpointClass: 'live',
      oldestAvailableLedger: start,
      latestAvailableLedger: tip,
      async getEvents({ startLedger, endLedger }) {
        const rec = deployedRecord({
          owner: OWNER_A,
          agent: AGENT_A,
          ledger: boundaryLedger,
          txHash: 'TX-FIRST',
        })
        const page = scanRpcEventsPage({
          events: [rec],
          cursor: 'more',
          latestLedger: endLedger,
          startLedger,
          endLedger,
          limit: 1,
        })
        return {
          events: page.events,
          cursor: null,
          scannedThroughLedger: page.scannedThroughLedger,
          latestLedger: page.latestLedger,
        }
      },
    }
    const out1 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es1,
      finalizedLedger: tip,
      pageLimit: 1,
    })
    expect(out1.throughLedger).toBe(boundaryLedger - 1) // cursor must NOT advance past the last complete ledger
    expect(out1.membershipCount).toBe(0) // TX-FIRST held back, not lost — just not committed yet

    const es2 = {
      providerId: 'test-rpc',
      endpointClass: 'live',
      oldestAvailableLedger: start,
      latestAvailableLedger: tip,
      async getEvents({ startLedger, endLedger }) {
        const recs = [
          deployedRecord({
            owner: OWNER_A,
            agent: AGENT_A,
            ledger: boundaryLedger,
            txHash: 'TX-FIRST',
          }),
          deployedRecord({
            owner: OWNER_B,
            agent: AGENT_B,
            ledger: boundaryLedger,
            txHash: 'TX-SECOND',
          }),
        ]
        const page = scanRpcEventsPage({
          events: recs,
          cursor: null,
          latestLedger: endLedger,
          startLedger,
          endLedger,
        })
        return {
          events: page.events,
          cursor: null,
          scannedThroughLedger: page.scannedThroughLedger,
          latestLedger: page.latestLedger,
        }
      },
    }
    const out2 = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es2,
      finalizedLedger: tip,
    })
    expect(out2.membershipCount).toBe(2) // BOTH deploys land — TX-SECOND was never lost
    const ownedByA = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    const ownedByB = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_B,
    })
    expect(ownedByA.map((r) => r.address)).toEqual([AGENT_A])
    expect(ownedByB.map((r) => r.address)).toEqual([AGENT_B])
  })
})

describe('scanRpcEventsPage — pure unit coverage (Critical 2 + Livelock check 8)', () => {
  it("advances only through the last COMPLETE ledger when truncated, dropping the boundary ledger's events", () => {
    const page = scanRpcEventsPage({
      events: [{ ledger: 100 }, { ledger: 100 }, { ledger: 101 }],
      cursor: 'more',
      latestLedger: 5000, // real chain tip is far ahead — genuine truncation, not sparse-at-tip
      startLedger: 100,
      endLedger: 4990,
    })
    expect(page.scannedThroughLedger).toBe(100)
    expect(page.events.every((e) => e.ledger === 100)).toBe(true)
    expect(page.events).toHaveLength(2)
  })

  it('an empty window AT the chain tip completes honestly even if the SDK always sets a cursor', () => {
    const page = scanRpcEventsPage({
      events: [],
      cursor: 'sdk-always-sets-this', // the exact livelock trigger: cursor present on a complete result
      latestLedger: 5000,
      startLedger: 4900,
      endLedger: 5000, // our request already reaches the reported tip
    })
    expect(page.scannedThroughLedger).toBe(5000) // proven complete via ledger arithmetic, not cursor
    expect(page.events).toEqual([])
  })

  it('an ambiguous empty window (no latestLedger reported) stays fail-safe, never claims completion', () => {
    const page = scanRpcEventsPage({
      events: [],
      cursor: 'more',
      latestLedger: undefined,
      startLedger: 100,
      endLedger: 5000,
    })
    expect(page.scannedThroughLedger).toBeLessThan(100) // < fromLedger — ingestAgentIndexPage will throw on this
  })

  it('truncation OVERRIDES tip arithmetic — realistic production shape (endLedger === latestLedger, limit-capped, cursor set) must not silently claim the boundary ledger complete', () => {
    // The production adapter's endLedger IS the pre-call tip snapshot, and res.latestLedger is
    // ~the same ledger a few seconds later — endLedger >= latestLedger is true on almost every
    // truncated call too. Truncation evidence (limit-capped response) must win regardless.
    const page = scanRpcEventsPage({
      events: [{ ledger: 100 }, { ledger: 100 }, { ledger: 101 }, { ledger: 101 }, { ledger: 102 }], // 5 events == limit
      cursor: 'more',
      latestLedger: 5000,
      startLedger: 100,
      endLedger: 5000, // == latestLedger — the exact shape the old tip-arithmetic branch mishandled
      limit: 5,
    })
    expect(page.scannedThroughLedger).toBe(101) // NOT 5000 — ledger 102 may be only partially fetched
    expect(page.events.every((e) => e.ledger < 102)).toBe(true)
  })
})

describe('ingestAgentIndexPage — livelock check 8, end-to-end via a fake eventSource', () => {
  it('completes an empty window at tip without throwing (no permanent stall)', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const es = {
      providerId: 'test-rpc',
      endpointClass: 'live',
      oldestAvailableLedger: start,
      latestAvailableLedger: start,
      async getEvents({ startLedger, endLedger }) {
        const page = scanRpcEventsPage({
          events: [],
          cursor: 'sdk-always-sets-this',
          latestLedger: start,
          startLedger,
          endLedger,
        })
        return {
          events: page.events,
          cursor: null,
          scannedThroughLedger: page.scannedThroughLedger,
          latestLedger: page.latestLedger,
        }
      },
    }
    const out = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es,
      finalizedLedger: start,
    })
    expect(out.status).toBe('committed')
    expect(out.throughLedger).toBe(start)
  })

  it('throws (never falsely completes) on a genuinely ambiguous not-at-tip empty window', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const es = {
      providerId: 'test-rpc',
      endpointClass: 'live',
      oldestAvailableLedger: start,
      latestAvailableLedger: start + 5000,
      async getEvents({ startLedger, endLedger }) {
        const page = scanRpcEventsPage({
          events: [],
          cursor: 'more',
          latestLedger: undefined,
          startLedger,
          endLedger,
        })
        return {
          events: page.events,
          cursor: null,
          scannedThroughLedger: page.scannedThroughLedger,
          latestLedger: page.latestLedger,
        }
      },
    }
    await expect(
      ingestAgentIndexPage({
        source: ROUTER_V1,
        store,
        eventSource: es,
        finalizedLedger: start + 5000,
      })
    ).rejects.toThrow(/no confirmed scanned range/)
  })
})

describe('ingestAgentIndexPage — retention-floor gaps', () => {
  it('records a gap and advances the cursor past ledgers the provider cannot certify', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    const es = fakeEventSource({
      events: [],
      oldestAvailableLedger: start + 100,
      latestAvailableLedger: start + 500,
    })
    const out = await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es,
      finalizedLedger: start + 500,
    })
    expect(out.status).toBe('gapped')
    const { sources, gaps } = await store.readCoverage({ networkId: ROUTER_V1.networkId })
    expect(sources[0].indexedThroughLedger).toBe(start + 99) // cursor moved past the hole
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ fromLedger: start, throughLedger: start + 99, status: 'open' })
    // The proof can never call this contiguous while the gap is open.
    expect(
      coverageProof({ manifest: { creators: [] }, sources, gaps, backfillAudit: [] }).contiguous
    ).toBe(false)
  })
})

describe('ingestAgentIndexPage — gap-branch atomicity ordering (Important 3)', () => {
  it("records the gap before the empty spanning commit — even on a source's very first page (FK satisfied via ensureSourceRow first)", async () => {
    const store = freshStore()
    const calls = []
    const spiedStore = {
      ...store,
      ensureSourceRow: async (p) => {
        calls.push('ensureSourceRow')
        return store.ensureSourceRow(p)
      },
      recordGap: async (g) => {
        calls.push('recordGap')
        return store.recordGap(g)
      },
      commitSourcePage: async (p) => {
        calls.push('commitSourcePage')
        return store.commitSourcePage(p)
      },
    }
    const start = ROUTER_V1.coverageStartLedger
    const es = fakeEventSource({
      events: [],
      oldestAvailableLedger: start + 100,
      latestAvailableLedger: start + 500,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store: spiedStore,
      eventSource: es,
      finalizedLedger: start + 500,
    })
    expect(calls).toEqual(['ensureSourceRow', 'recordGap', 'commitSourcePage'])
  })

  it('records the gap before the commit when the source row already exists (retention floor advances mid-catch-up; ensureSourceRow is a harmless idempotent no-op here)', async () => {
    const store = freshStore()
    const start = ROUTER_V1.coverageStartLedger
    // A normal committed page first establishes the source row.
    const es1 = fakeEventSource({
      events: [],
      oldestAvailableLedger: start,
      scannedThroughLedger: start + 10,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store,
      eventSource: es1,
      finalizedLedger: start + 20,
    })

    const calls = []
    const spiedStore = {
      ...store,
      ensureSourceRow: async (p) => {
        calls.push('ensureSourceRow')
        return store.ensureSourceRow(p)
      },
      recordGap: async (g) => {
        calls.push('recordGap')
        return store.recordGap(g)
      },
      commitSourcePage: async (p) => {
        calls.push('commitSourcePage')
        return store.commitSourcePage(p)
      },
    }
    // The retention floor jumps ahead of what's indexed — a hole opens for an EXISTING source.
    const es2 = fakeEventSource({
      events: [],
      oldestAvailableLedger: start + 200,
      latestAvailableLedger: start + 500,
    })
    await ingestAgentIndexPage({
      source: ROUTER_V1,
      store: spiedStore,
      eventSource: es2,
      finalizedLedger: start + 500,
    })
    // ensureSourceRow always runs first (idempotent ON CONFLICT DO NOTHING) — the invariant that
    // matters is recordGap strictly before commitSourcePage, which holds either way.
    expect(calls).toEqual(['ensureSourceRow', 'recordGap', 'commitSourcePage'])
  })
})

describe('ingestAgentIndexPage — refuses to guess an unverifiable agent generation', () => {
  it('throws (and writes nothing) when a registry event cannot prove its wasm generation', async () => {
    const store = freshStore()
    const rec = authorizedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: REGISTRY_CURRENT.coverageStartLedger + 1,
      txHash: 'TXR-BAD',
    })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: REGISTRY_CURRENT.coverageStartLedger,
      getAgentWasmHash: async () => 'deadbeef'.repeat(8), // not in AGENT_WASM_GENERATIONS
    })
    await expect(
      ingestAgentIndexPage({
        source: REGISTRY_CURRENT,
        store,
        eventSource: es,
        finalizedLedger: REGISTRY_CURRENT.coverageStartLedger + 5,
      })
    ).rejects.toThrow(/cannot prove wasm generation/)
    const { sources } = await store.readCoverage({ networkId: REGISTRY_CURRENT.networkId })
    expect(sources).toEqual([]) // nothing committed — never claim coverage over a guess
  })

  it('throws when a registry source has no wasm-hash lookup available at all', async () => {
    const store = freshStore()
    const rec = authorizedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: REGISTRY_CURRENT.coverageStartLedger + 1,
      txHash: 'TXR-NOFN',
    })
    const es = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: REGISTRY_CURRENT.coverageStartLedger,
    })
    await expect(
      ingestAgentIndexPage({
        source: REGISTRY_CURRENT,
        store,
        eventSource: es,
        finalizedLedger: REGISTRY_CURRENT.coverageStartLedger + 5,
      })
    ).rejects.toThrow()
  })

  it('rejects a source address the manifest does not recognize', async () => {
    const store = freshStore()
    const es = fakeEventSource({ events: [] })
    await expect(
      ingestAgentIndexPage({
        source: { ...ROUTER_V1, address: 'CUNKNOWNROUTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
        store,
        eventSource: es,
        finalizedLedger: 100,
      })
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

// `reportedLatestLedger` defaults to exactly "at tip" (indexedThroughLedger + the finality
// margin) — a healthy/fresh/gap-free fixture should also be at-tip by default so the many
// existing 'complete' scenarios below don't all have to spell it out. Pass `reportedLatestLedger`
// explicitly (or `null`) to build a mid-catch-up / no-tip-known fixture (Critical 1).
function sourceRow({
  address,
  coverageStartLedger,
  indexedThroughLedger = 5000,
  status = 'ok',
  lastSuccessAt,
  manifestHash = AGENT_CREATOR_MANIFEST_HASH,
  manifestVersion = AGENT_CREATOR_MANIFEST_VERSION,
  schemaVersion = AGENT_INDEX_SCHEMA_VERSION,
  reportedLatestLedger = indexedThroughLedger + AGENT_INDEX_FINALITY_LEDGERS,
}) {
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
    providerId: 'test-rpc',
    endpointClass: 'live',
    reportedOldestLedger: 1,
    reportedLatestLedger,
  }
}

describe('coverageProof — completeness requires every source, no gaps, within the finality margin', () => {
  it('is complete when a single current creator is fully covered, gap-free, and fresh', () => {
    const CURRENT = creator({
      address: 'CCUR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 })]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('complete')
    expect(proof.contiguous).toBe(true)
    expect(proof.requiredFinalityLedgers).toBe(2)
  })

  it('is partial when any source has an open gap', () => {
    const CURRENT = creator({
      address: 'CCUR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 })]
    const gaps = [
      {
        sourceId: `${NET}:${CURRENT.address}`,
        fromLedger: 1500,
        throughLedger: 1510,
        status: 'open',
      },
    ]
    const proof = coverageProof({ manifest, sources, gaps, backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
    expect(proof.contiguous).toBe(false)
  })

  it("is partial when a source has not indexed from the creator's own coverage start", () => {
    const CURRENT = creator({
      address: 'CCUR3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const row = sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 })
    row.indexedFromLedger = 1050 // missed the first 50 ledgers of this creator's history
    const proof = coverageProof({ manifest, sources: [row], gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
  })
})

describe('coverageProof — chain-tip bound (Critical 1)', () => {
  it('is partial (mid-catch-up) even when a source is internally gap-free at indexedThroughLedger:5000 but far behind the reported tip', () => {
    const CURRENT = creator({
      address: 'CTIP1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [
      sourceRow({
        address: CURRENT.address,
        coverageStartLedger: 1000,
        indexedThroughLedger: 5000,
        reportedLatestLedger: 50_000,
      }),
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.contiguous).toBe(true) // gap-free...
    expect(proof.status).toBe('partial') // ...but nowhere near the real tip — never 'complete'
  })

  it('is complete once indexed coverage reaches the tip within the finality margin', () => {
    const CURRENT = creator({
      address: 'CTIP2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [
      sourceRow({
        address: CURRENT.address,
        coverageStartLedger: 1000,
        indexedThroughLedger: 5000,
        reportedLatestLedger: 5000 + AGENT_INDEX_FINALITY_LEDGERS,
      }),
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('complete')
  })

  it('is partial when no tip has ever been reported for a source — never guesses completeness', () => {
    const CURRENT = creator({
      address: 'CTIP3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [
      sourceRow({
        address: CURRENT.address,
        coverageStartLedger: 1000,
        reportedLatestLedger: null,
      }),
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
  })
})

describe('coverageProof — freshness (20-minute product lag bound)', () => {
  it('is partial/stale once a source last succeeded beyond AGENT_INDEX_MAX_LAG_MS ago, never complete', () => {
    const CURRENT = creator({
      address: 'CFRESH1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const staleSuccessAt = Math.floor((NOW - AGENT_INDEX_MAX_LAG_MS - 60_000) / 1000)
    const sources = [
      sourceRow({
        address: CURRENT.address,
        coverageStartLedger: 1000,
        lastSuccessAt: staleSuccessAt,
      }),
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW })
    expect(proof.status).toBe('partial')
  })
})

describe('coverageProof — unknown creator/manifest identity forces partial', () => {
  it('is partial when a source reports a stale manifestHash (manifest bumped since last ingest)', () => {
    const CURRENT = creator({
      address: 'CSTALE1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [
      sourceRow({ address: CURRENT.address, coverageStartLedger: 1000, manifestHash: '0xold' }),
    ]
    expect(coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW }).status).toBe(
      'partial'
    )
  })

  it('is partial when a source address is not recognized by the current manifest at all', () => {
    const CURRENT = creator({
      address: 'CKNOWN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [CURRENT],
    }
    const sources = [
      sourceRow({ address: CURRENT.address, coverageStartLedger: 1000 }),
      sourceRow({
        address: 'CROGUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        coverageStartLedger: 1,
      }),
    ]
    expect(coverageProof({ manifest, sources, gaps: [], backfillAudit: [], now: NOW }).status).toBe(
      'partial'
    )
  })
})

describe('coverageProof — historical direct-deploy backfill gate', () => {
  it('current router coverage being perfect cannot, by itself, close the legacy no-deploy-evidence requirement', () => {
    const CURRENT = creator({
      address: 'CCUR9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1000,
    })
    const LEGACY = creator({
      address: 'CLEGACY1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1,
      deployedLedger: null,
    })
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
    const LEGACY = creator({
      address: 'CLEGACY2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1,
      deployedLedger: null,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [LEGACY],
    }
    const sources = [sourceRow({ address: LEGACY.address, coverageStartLedger: 1 })]
    const backfillAudit = [
      {
        sourceId: `${NET}:${LEGACY.address}`,
        result: 'verified',
        fromLedger: 1,
        throughLedger: 999,
      },
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit, now: NOW })
    expect(proof.historicalBackfill).toBe('verified')
    expect(proof.status).toBe('complete')
  })

  it('reports failed when an audit was attempted and failed with no later verified attempt', () => {
    const LEGACY = creator({
      address: 'CLEGACY3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      coverageStartLedger: 1,
      deployedLedger: null,
    })
    const manifest = {
      version: AGENT_CREATOR_MANIFEST_VERSION,
      hash: AGENT_CREATOR_MANIFEST_HASH,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: [LEGACY],
    }
    const sources = [sourceRow({ address: LEGACY.address, coverageStartLedger: 1 })]
    const backfillAudit = [
      { sourceId: `${NET}:${LEGACY.address}`, result: 'failed', fromLedger: 1, throughLedger: 999 },
    ]
    const proof = coverageProof({ manifest, sources, gaps: [], backfillAudit, now: NOW })
    expect(proof.historicalBackfill).toBe('failed')
    expect(proof.status).toBe('partial')
  })
})
