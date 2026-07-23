import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import { createAgentIndexStore } from './store.js'
import { handleIngest, handleRead, LIVE_MANIFEST } from './handler.js'
import { AGENT_CREATORS } from '../../src/stellar/agentCreatorManifest.js'

// ── same in-memory-D1 helper as store.test.js / indexer.test.js ──
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

const ROUTER_V1 = AGENT_CREATORS.find((c) => c.address === 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5')
const OWNER_A = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H'
const AGENT_A = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'

function deployedRecord({ owner, agent, cap = 1000n, ledger, txHash }) {
  return {
    ledger,
    txHash,
    pagingToken: `${ledger}-${txHash}`,
    topic: [symbolScVal('deployed'), addrScVal(owner), addrScVal(agent)],
    value: nativeToScVal({ cap }),
  }
}

function fakeEventSource({ events = [], scannedThroughLedger, oldestAvailableLedger = 1, latestAvailableLedger = 10_000_000 } = {}) {
  return {
    providerId: 'test-rpc',
    endpointClass: 'live',
    oldestAvailableLedger,
    latestAvailableLedger,
    async getEvents(req) {
      return { events, cursor: null, scannedThroughLedger: scannedThroughLedger ?? req.endLedger }
    },
  }
}

describe('handleIngest — secret gate', () => {
  it('503s when the ingest secret is not configured', async () => {
    const out = await handleIngest({ secret: '', providedSecret: 'x', store: {}, sources: [] })
    expect(out.status).toBe(503)
    expect(out.body.configured).toBe(false)
  })

  it('401s on a missing bearer token', async () => {
    const out = await handleIngest({ secret: 'topsecret', providedSecret: '', store: {}, sources: [] })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong-but-same-length token (constant-time path, not just a length check)', async () => {
    const out = await handleIngest({ secret: 'topsecret', providedSecret: 'wrongsecre', store: {}, sources: [] })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong-length token', async () => {
    const out = await handleIngest({ secret: 'topsecret', providedSecret: 'nope', store: {}, sources: [] })
    expect(out.status).toBe(401)
  })
})

describe('handleIngest — bounded ingestion, one page per source, isolated failures', () => {
  it('ingests every source and reports per-source ok/failed without aborting the batch', async () => {
    const store = createAgentIndexStore(fakeD1())
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 1, txHash: 'TX1' })
    const goodEventSource = fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger })

    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: 'topsecret',
      store,
      sources: [ROUTER_V1, { ...ROUTER_V1, address: 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY' }],
      eventSourceFor: async (source) =>
        source.address === ROUTER_V1.address ? goodEventSource : (() => {
          throw new Error('rpc down')
        })(),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(1)
    expect(out.body.failed).toBe(1)
    const good = out.body.results.find((r) => r.sourceId.endsWith(ROUTER_V1.address))
    expect(good).toMatchObject({ ok: true, status: 'committed', membershipCount: 1 })
    const bad = out.body.results.find((r) => !r.ok)
    expect(bad.error).toMatch(/rpc down/)

    const rows = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_A })
    expect(rows).toHaveLength(1)
  })
})

describe('handleRead — input validation', () => {
  it('400s an empty network', async () => {
    const out = await handleRead({ networkId: '', owner: OWNER_A, store: {} })
    expect(out.status).toBe(400)
  })

  it('400s an owner that is neither a valid G nor C StrKey', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: 'not-an-address', store: {} })
    expect(out.status).toBe(400)
  })

  it('accepts a valid C-address owner (bridge/contract owners are legitimate)', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: AGENT_A, store: null })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('unavailable')
  })
})

describe('handleRead — unavailable store never reports complete', () => {
  it('returns a structured unavailable response when store is null', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: null })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ version: 1, status: 'unavailable', agents: [] })
    expect(out.body.coverage.contiguous).toBe(false)
  })

  it('returns unavailable (not agents:[] + complete) when the store throws', async () => {
    const throwingStore = {
      readOwnerMemberships: async () => {
        throw new Error('D1 unreachable')
      },
      readCoverage: async () => ({ sources: [], gaps: [], backfillAudits: [] }),
    }
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: throwingStore })
    expect(out.body.status).toBe('unavailable')
  })
})

describe('handleRead — empty-but-available store is partial, never a false complete', () => {
  it('reports partial with agents:[] against the real live manifest when nothing has ever been ingested', async () => {
    const store = createAgentIndexStore(fakeD1())
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('partial')
    expect(out.body.agents).toEqual([])
    expect(out.body.coverage.manifestHash).toBe(LIVE_MANIFEST.hash)
  })
})

describe('handleRead — end-to-end after ingest', () => {
  it("shapes an owner's agents and coverage per the documented response contract", async () => {
    const store = createAgentIndexStore(fakeD1())
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 1, txHash: 'TX1' })
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () => fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    const out = await handleRead({ networkId: ROUTER_V1.networkId, owner: OWNER_A, store })
    expect(out.body.agents).toHaveLength(1)
    expect(out.body.agents[0]).toMatchObject({ address: AGENT_A, kind: 'deposit', creator: ROUTER_V1.address })
    expect(out.body.coverage).toMatchObject({
      manifestHash: LIVE_MANIFEST.hash,
      manifestVersion: LIVE_MANIFEST.version,
      schemaVersion: LIVE_MANIFEST.schemaVersion,
      requiredFinalityLedgers: 2,
    })
    // Only one of five manifest sources has ever been ingested — can never be 'complete'.
    expect(out.body.status).toBe('partial')
  })
})
