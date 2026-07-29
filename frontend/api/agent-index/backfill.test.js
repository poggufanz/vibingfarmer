import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import {
  classifyCandidate,
  deriveVerdict,
  toBackfillAuditV1,
  buildBackfillAudit,
  commitBackfillAudit,
  BACKFILL_METHOD_V1,
} from './backfill.js'
import { createAgentIndexStore } from './store.js'
import { coverageProof } from './indexer.js'
import { AGENT_CREATORS, AGENT_WASM_GENERATIONS } from '../../src/stellar/agentCreatorManifest.js'

// ── same in-memory-D1 helper as store.test.js / handler.test.js ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0001_vf_gate.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0002_agent_index.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0003_agent_index_bounds.sql'), 'utf8'))
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
  }
}

const LEGACY_ROUTER = AGENT_CREATORS.find(
  (c) => c.address === 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
)
const LEGACY_REGISTRY = AGENT_CREATORS.find(
  (c) => c.address === 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
)
const OWNER_A = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT_A = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_V1_WASM = AGENT_WASM_GENERATIONS.find((g) => g.generation === 'agent-v1').wasmHash

const FULL_SCOPE = {
  owner: OWNER_A,
  target: 'CVAULT',
  token: 'CTOKEN',
  kind: 'deposit',
  expiry: 999999,
  revoked: false,
}

function baseCandidate(overrides = {}) {
  return {
    networkId: 'stellar-testnet',
    address: AGENT_A,
    ownerAddress: OWNER_A,
    creatorAddress: null,
    creationLedger: 100,
    creationTx: 'TXHASH',
    wasmHash: AGENT_V1_WASM,
    evidenceKind: 'relayer-log',
    kind: 'deposit',
    scope: FULL_SCOPE,
    ...overrides,
  }
}

function sourceEntry(overrides = {}) {
  return {
    kind: 'funding-router',
    address: LEGACY_ROUTER.address,
    providerId: 'archival-rpc',
    oldestAvailableLedger: 1,
    fromLedger: 1,
    throughLedger: 5_000_000,
    contiguous: true,
    evidenceHash: '0xabc',
    ...overrides,
  }
}

describe('classifyCandidate', () => {
  it('verifies a fully-evidenced candidate', () => {
    const out = classifyCandidate({
      candidate: baseCandidate(),
      directSetupCutoffLedger: 3_600_000,
    })
    expect(out.status).toBe('verified')
    expect(out.membership).toMatchObject({
      agentAddress: AGENT_A,
      ownerAddress: OWNER_A,
      creatorAddress: AGENT_A, // no creator contract -> falls back to itself (valid StrKey)
      kind: 'deposit',
      creationLedger: 100,
      creationTx: 'TXHASH',
    })
  })

  it('rejects an unrecognized wasm hash', () => {
    const out = classifyCandidate({ candidate: baseCandidate({ wasmHash: 'deadbeef'.repeat(8) }) })
    expect(out).toMatchObject({ status: 'rejected', reason: 'unrecognized-wasm' })
  })

  it('marks a failed wasm lookup unresolved, never a false reject', () => {
    const out = classifyCandidate({
      candidate: baseCandidate({ wasmLookupFailed: true, wasmHash: null }),
    })
    expect(out).toMatchObject({ status: 'unresolved', reason: 'wasm-lookup-failed' })
  })

  it('marks a failed scope_of read unresolved', () => {
    const out = classifyCandidate({ candidate: baseCandidate({ scope: null }) })
    expect(out).toMatchObject({ status: 'unresolved', reason: 'scope_of-failed' })
  })

  it('marks an incompletely-decoded scope unresolved', () => {
    const out = classifyCandidate({ candidate: baseCandidate({ scope: { owner: OWNER_A } }) })
    expect(out).toMatchObject({ status: 'unresolved', reason: 'scope-incomplete' })
  })

  it('verifies a legacy (pre-hardening) scope shape — `vault` not `target`, no `kind` field at all (real on-chain shape for agent-v1/v2)', () => {
    const legacyScope = {
      owner: OWNER_A,
      vault: 'CVAULT',
      token: 'CTOKEN',
      expiry: 999999,
      revoked: false,
    }
    const out = classifyCandidate({ candidate: baseCandidate({ scope: legacyScope }) })
    expect(out.status).toBe('verified')
  })

  it('rejects a claimed owner that does not match the on-chain scope owner (seeded/demo mismatch guard)', () => {
    const out = classifyCandidate({
      candidate: baseCandidate({
        ownerAddress: 'GDIFFERENTOWNERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      }),
    })
    expect(out).toMatchObject({ status: 'rejected', reason: 'owner-mismatch' })
  })

  it('marks missing creation provenance unresolved', () => {
    const out = classifyCandidate({ candidate: baseCandidate({ creationTx: null }) })
    expect(out).toMatchObject({ status: 'unresolved', reason: 'missing-provenance' })
    const out2 = classifyCandidate({ candidate: baseCandidate({ creationLedger: null }) })
    expect(out2).toMatchObject({ status: 'unresolved', reason: 'missing-provenance' })
  })

  it('rejects a non-router/registry candidate created after the direct-setup cutoff', () => {
    const out = classifyCandidate({
      candidate: baseCandidate({ creationLedger: 4_000_000, evidenceKind: 'vault-history' }),
      directSetupCutoffLedger: 3_600_000,
    })
    expect(out).toMatchObject({ status: 'rejected', reason: 'post-cutoff-direct-deploy' })
  })

  it('does not apply the cutoff rule to router/registry-sourced candidates', () => {
    const out = classifyCandidate({
      candidate: baseCandidate({ creationLedger: 4_000_000, evidenceKind: 'router-event' }),
      directSetupCutoffLedger: 3_600_000,
    })
    expect(out.status).toBe('verified')
  })
})

describe('deriveVerdict', () => {
  it('verified only when every source is contiguous and nothing is unresolved', () => {
    expect(deriveVerdict({ sources: [sourceEntry()], unresolvedCandidates: [] })).toBe('verified')
  })

  it('partial when any source is non-contiguous', () => {
    expect(
      deriveVerdict({ sources: [sourceEntry({ contiguous: false })], unresolvedCandidates: [] })
    ).toBe('partial')
  })

  it('partial when there are unresolved candidates even if sources are contiguous', () => {
    expect(
      deriveVerdict({ sources: [sourceEntry()], unresolvedCandidates: [{ reason: 'x' }] })
    ).toBe('partial')
  })

  it('partial (never verified) with zero sources — vacuous truth is not completeness', () => {
    expect(deriveVerdict({ sources: [], unresolvedCandidates: [] })).toBe('partial')
  })
})

describe('toBackfillAuditV1', () => {
  const okShape = () => ({
    auditId: 'audit-1',
    networkId: 'stellar-testnet',
    fromLedger: 1,
    throughLedger: 100,
    directSetupCutoffLedger: 3_600_000,
    creatorManifestVersion: 'v1',
    sources: [sourceEntry()],
    candidates: [1],
    verifiedAgents: [1],
    rejectedCandidates: [],
    unresolvedCandidates: [],
    verdict: 'verified',
    completedAt: 1700000000,
  })

  it('accepts a well-formed verified audit', () => {
    expect(() => toBackfillAuditV1(okShape())).not.toThrow()
  })

  it('rejects a missing required field', () => {
    const bad = okShape()
    delete bad.auditId
    expect(() => toBackfillAuditV1(bad)).toThrow(/auditId/)
  })

  it('rejects a candidate-bucket partition mismatch', () => {
    const bad = okShape()
    bad.candidates = [1, 2]
    expect(() => toBackfillAuditV1(bad)).toThrow(/partition/)
  })

  it('THE critical guard: refuses to normalize verdict "verified" with any unresolved candidate', () => {
    const bad = okShape()
    bad.candidates = [1, 2]
    bad.unresolvedCandidates = [{ reason: 'x' }]
    expect(() => toBackfillAuditV1(bad)).toThrow(/verified.*unresolved/i)
  })

  it('THE critical guard: refuses to normalize verdict "verified" with a non-contiguous source', () => {
    const bad = okShape()
    bad.sources = [sourceEntry({ contiguous: false })]
    expect(() => toBackfillAuditV1(bad)).toThrow(/verified.*contiguous/i)
  })

  it('THE critical guard: refuses to normalize verdict "verified" with zero sources', () => {
    const bad = okShape()
    bad.sources = []
    expect(() => toBackfillAuditV1(bad)).toThrow(/verified.*contiguous/i)
  })

  it('accepts a partial verdict alongside unresolved candidates', () => {
    const p = okShape()
    p.verdict = 'partial'
    p.candidates = [1, 2]
    p.unresolvedCandidates = [{ reason: 'x' }]
    expect(() => toBackfillAuditV1(p)).not.toThrow()
  })
})

describe('buildBackfillAudit — integration of classify + verdict + shape', () => {
  it('produces a verified audit when every candidate verifies and every source is contiguous', () => {
    const audit = buildBackfillAudit({
      auditId: 'audit-2',
      networkId: 'stellar-testnet',
      fromLedger: 1,
      throughLedger: 100,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [
        sourceEntry({ kind: 'funding-router', address: LEGACY_ROUTER.address }),
        sourceEntry({ kind: 'registry', address: LEGACY_REGISTRY.address }),
      ],
      candidates: [baseCandidate()],
      completedAt: 1700000000,
    })
    expect(audit.verdict).toBe('verified')
    expect(audit.verifiedAgents).toHaveLength(1)
    expect(audit.rejectedCandidates).toHaveLength(0)
    expect(audit.unresolvedCandidates).toHaveLength(0)
  })

  it('produces an honest partial audit — never overclaims — when one candidate cannot be resolved', () => {
    const audit = buildBackfillAudit({
      auditId: 'audit-3',
      networkId: 'stellar-testnet',
      fromLedger: 1,
      throughLedger: 100,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [sourceEntry()],
      candidates: [
        baseCandidate(),
        baseCandidate({
          address: 'CBEDIFOTUJAZQJ7F643EKDRLG7MT5AWOR23VZ6C3K6V5IBG447T6MNDP',
          scope: null,
        }),
      ],
      completedAt: 1700000000,
    })
    expect(audit.verdict).toBe('partial')
    expect(audit.verifiedAgents).toHaveLength(1)
    expect(audit.unresolvedCandidates).toHaveLength(1)
  })
})

describe('commitBackfillAudit — the only D1 write path', () => {
  it('posts verified memberships and writes verified per-source audit rows for a verified audit', async () => {
    const store = createAgentIndexStore(fakeD1())
    const audit = buildBackfillAudit({
      auditId: 'audit-4',
      networkId: 'stellar-testnet',
      fromLedger: 1,
      throughLedger: 5_000_000,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [
        sourceEntry({ kind: 'funding-router', address: LEGACY_ROUTER.address }),
        sourceEntry({ kind: 'registry', address: LEGACY_REGISTRY.address }),
      ],
      candidates: [baseCandidate()],
      completedAt: 1700000000,
    })

    const result = await commitBackfillAudit({ store, audit })
    expect(result).toMatchObject({ verdict: 'verified', membershipsPosted: 1, auditRowsWritten: 2 })

    const rows = await store.readOwnerMemberships({ networkId: 'stellar-testnet', owner: OWNER_A })
    expect(rows).toHaveLength(1)
    expect(rows[0].address).toBe(AGENT_A)

    const coverage = await store.readCoverage({ networkId: 'stellar-testnet' })
    expect(coverage.backfillAudits).toHaveLength(2)
    expect(
      coverage.backfillAudits.every(
        (a) => a.result === 'verified' && a.method === BACKFILL_METHOD_V1
      )
    ).toBe(true)
  })

  it('a partial audit still posts its individually-verified candidates, but writes only "failed" audit rows — never a hand-converted verified', async () => {
    const store = createAgentIndexStore(fakeD1())
    const audit = buildBackfillAudit({
      auditId: 'audit-5',
      networkId: 'stellar-testnet',
      fromLedger: 1,
      throughLedger: 5_000_000,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [sourceEntry({ kind: 'funding-router', address: LEGACY_ROUTER.address })],
      candidates: [
        baseCandidate(),
        baseCandidate({
          address: 'CBEDIFOTUJAZQJ7F643EKDRLG7MT5AWOR23VZ6C3K6V5IBG447T6MNDP',
          scope: null,
        }),
      ],
      completedAt: 1700000000,
    })
    expect(audit.verdict).toBe('partial')

    const result = await commitBackfillAudit({ store, audit })
    expect(result).toMatchObject({ verdict: 'partial', membershipsPosted: 1, auditRowsWritten: 1 })

    const coverage = await store.readCoverage({ networkId: 'stellar-testnet' })
    expect(coverage.backfillAudits).toHaveLength(1)
    expect(coverage.backfillAudits[0].result).toBe('failed')
  })

  it('skips vault/horizon/relayer-log source entries — they have no agent_index_sources FK target', async () => {
    const store = createAgentIndexStore(fakeD1())
    const audit = buildBackfillAudit({
      auditId: 'audit-6',
      networkId: 'stellar-testnet',
      fromLedger: 1,
      throughLedger: 5_000_000,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [
        sourceEntry({
          kind: 'vault',
          address: 'CVAULTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        }),
      ],
      candidates: [],
      completedAt: 1700000000,
    })
    const result = await commitBackfillAudit({ store, audit })
    expect(result.auditRowsWritten).toBe(0)
  })

  describe('end-to-end honesty (Step 3): coverageProof only reports historicalBackfill "verified" after a genuinely verified commit', () => {
    const manifestFixture = {
      version: 'v1',
      hash: 'h1',
      schemaVersion: 1,
      creators: [
        { networkId: 'stellar-testnet', address: LEGACY_ROUTER.address, coverageStartLedger: 1 },
        { networkId: 'stellar-testnet', address: LEGACY_REGISTRY.address, coverageStartLedger: 1 },
      ],
    }

    it('stays "pending" before any audit is committed', () => {
      const proof = coverageProof({
        manifest: manifestFixture,
        sources: [],
        gaps: [],
        backfillAudit: [],
      })
      expect(proof.historicalBackfill).toBe('pending')
      expect(proof.status).toBe('partial')
    })

    it('stays non-"verified" after a partial audit commit — never silently upgraded', async () => {
      const store = createAgentIndexStore(fakeD1())
      const audit = buildBackfillAudit({
        auditId: 'audit-7',
        networkId: 'stellar-testnet',
        fromLedger: 1,
        throughLedger: 5_000_000,
        directSetupCutoffLedger: 3_600_000,
        creatorManifestVersion: 'v1',
        sources: [
          sourceEntry({ kind: 'funding-router', address: LEGACY_ROUTER.address }),
          sourceEntry({ kind: 'registry', address: LEGACY_REGISTRY.address, contiguous: false }),
        ],
        candidates: [],
        completedAt: 1700000000,
      })
      await commitBackfillAudit({ store, audit })
      const coverage = await store.readCoverage({ networkId: 'stellar-testnet' })
      const proof = coverageProof({
        manifest: manifestFixture,
        sources: coverage.sources,
        gaps: coverage.gaps,
        backfillAudit: coverage.backfillAudits,
      })
      expect(proof.historicalBackfill).toBe('failed')
      expect(proof.status).toBe('partial')
    })

    it('flips to "verified" only once every needs-backfill source has a genuinely verified commit', async () => {
      const store = createAgentIndexStore(fakeD1())
      const audit = buildBackfillAudit({
        auditId: 'audit-8',
        networkId: 'stellar-testnet',
        fromLedger: 1,
        throughLedger: 5_000_000,
        directSetupCutoffLedger: 3_600_000,
        creatorManifestVersion: 'v1',
        sources: [
          sourceEntry({ kind: 'funding-router', address: LEGACY_ROUTER.address }),
          sourceEntry({ kind: 'registry', address: LEGACY_REGISTRY.address }),
        ],
        candidates: [],
        completedAt: 1700000000,
      })
      expect(audit.verdict).toBe('verified')
      await commitBackfillAudit({ store, audit })
      const coverage = await store.readCoverage({ networkId: 'stellar-testnet' })
      const proof = coverageProof({
        manifest: manifestFixture,
        sources: coverage.sources,
        gaps: coverage.gaps,
        backfillAudit: coverage.backfillAudits,
      })
      expect(proof.historicalBackfill).toBe('verified')
    })
  })
})
