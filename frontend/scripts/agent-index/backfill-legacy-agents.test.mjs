import { describe, it, expect } from 'vitest'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import {
  parseArgs,
  candidateFromRouterEvent,
  candidateFromRegistryEvent,
  pageArchivalSource,
  interpretArchivalPage,
  evidenceHashFor,
  KNOWN_DIRECT_DEPLOY_LOGS,
  UNIMPLEMENTED_CHANNEL_SOURCES,
} from './backfill-legacy-agents.mjs'
import { buildBackfillAudit } from '../../api/agent-index/backfill.js'
import { AGENT_CREATORS } from '../../src/stellar/agentCreatorManifest.js'

const ROUTER = AGENT_CREATORS.find((c) => c.address === 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY')
const REGISTRY = AGENT_CREATORS.find((c) => c.address === 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ')
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

function authorizedRecord({ owner, agent, ledger, txHash }) {
  return {
    ledger,
    txHash,
    pagingToken: `${ledger}-${txHash}`,
    topic: [symbolScVal('agent_authorized')],
    value: nativeToScVal({ owner: addrScVal(owner), agent: addrScVal(agent) }),
  }
}

describe('parseArgs', () => {
  it('recognizes --dry-run', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true })
  })
  it('defaults dryRun to false', () => {
    expect(parseArgs([])).toEqual({ dryRun: false })
  })
})

describe('candidateFromRouterEvent', () => {
  it('normalizes a decoded Deployed event into a candidate', () => {
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 42, txHash: 'TX1' })
    const c = candidateFromRouterEvent(ROUTER, rec)
    expect(c).toMatchObject({
      networkId: ROUTER.networkId,
      address: AGENT_A,
      ownerAddress: OWNER_A,
      creatorAddress: ROUTER.address,
      creationLedger: 42,
      creationTx: 'TX1',
      evidenceKind: 'router-event',
      wasmHash: ROUTER.supportedAgentWasmHashes[0],
    })
  })

  it('returns null for a record that does not decode', () => {
    const rec = { ledger: 1, txHash: 'TX', pagingToken: 'p', topic: [symbolScVal('other')], value: nativeToScVal({}) }
    expect(candidateFromRouterEvent(ROUTER, rec)).toBeNull()
  })
})

describe('candidateFromRegistryEvent', () => {
  it('normalizes a decoded agent_authorized event into a candidate, given an externally-resolved wasm hash', () => {
    const rec = authorizedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 7, txHash: 'TX2' })
    const c = candidateFromRegistryEvent(REGISTRY, rec, 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba')
    expect(c).toMatchObject({
      networkId: REGISTRY.networkId,
      address: AGENT_A,
      ownerAddress: OWNER_A,
      creatorAddress: REGISTRY.address,
      creationLedger: 7,
      creationTx: 'TX2',
      evidenceKind: 'registry-authorization',
      wasmHash: 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba',
    })
  })

  it('flags wasmLookupFailed when the wasm hash could not be resolved (undefined, not null)', () => {
    const rec = authorizedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 7, txHash: 'TX2' })
    const c = candidateFromRegistryEvent(REGISTRY, rec, undefined)
    expect(c.wasmLookupFailed).toBe(true)
  })
})

describe('pageArchivalSource', () => {
  it('accumulates events across pages and reports contiguous:true once tip is reached', async () => {
    const rec1 = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 5, txHash: 'A' })
    let call = 0
    const eventSource = {
      latestAvailableLedger: 10,
      async getEvents({ endLedger }) {
        call++
        return { events: [rec1], cursor: null, latestLedger: 10, scannedThroughLedger: endLedger }
      },
    }
    const out = await pageArchivalSource({ creator: { coverageStartLedger: 1 }, eventSource, limit: 200, maxPages: 5 })
    expect(out.contiguous).toBe(true)
    expect(out.events).toHaveLength(1)
    expect(call).toBe(1)
  })

  it('gives up honestly (contiguous:false) after maxPages without reaching tip', async () => {
    const eventSource = {
      latestAvailableLedger: 1_000_000,
      async getEvents({ startLedger: s }) {
        // never advances meaningfully — simulates a provider that keeps truncating
        return { events: [], cursor: 'cursor', latestLedger: 1_000_000, scannedThroughLedger: s }
      },
    }
    const out = await pageArchivalSource({ creator: { coverageStartLedger: 1 }, eventSource, limit: 200, maxPages: 3 })
    expect(out.contiguous).toBe(false)
  })
})

describe('KNOWN_DIRECT_DEPLOY_LOGS', () => {
  it('is a non-empty explicit seed list including the pre-seeded demo agent', () => {
    expect(KNOWN_DIRECT_DEPLOY_LOGS.length).toBeGreaterThan(0)
    expect(KNOWN_DIRECT_DEPLOY_LOGS.some((c) => c.address === 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC')).toBe(true)
  })
})

// Review finding 1 (MAJOR): the brief conditions 'verified' on vault-holder (bullet 3) and
// Horizon-operations (bullet 4) evidence too — neither has an automated collector. Without a
// structural gate, once demo-agent provenance is ever filled in, every OTHER check could line up
// and deriveVerdict would return 'verified' despite those two channels never being consulted.
describe('UNIMPLEMENTED_CHANNEL_SOURCES — structural verified-gate', () => {
  it('is exactly the two not-yet-automated channels, permanently non-contiguous', () => {
    expect(UNIMPLEMENTED_CHANNEL_SOURCES).toHaveLength(2)
    expect(UNIMPLEMENTED_CHANNEL_SOURCES.map((s) => s.kind).sort()).toEqual(['horizon-account', 'vault'])
    expect(UNIMPLEMENTED_CHANNEL_SOURCES.every((s) => s.contiguous === false)).toBe(true)
  })

  it('keeps the audit verdict "partial" even when every creator source is contiguous and every candidate resolves', () => {
    const audit = buildBackfillAudit({
      auditId: 'gate-1',
      networkId: 'stellar-testnet',
      fromLedger: 1,
      throughLedger: 100,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [
        {
          kind: 'funding-router',
          address: ROUTER.address,
          providerId: 'archival-rpc',
          oldestAvailableLedger: 1,
          fromLedger: 1,
          throughLedger: 100,
          contiguous: true,
          evidenceHash: '0x1',
        },
        {
          kind: 'registry',
          address: REGISTRY.address,
          providerId: 'archival-rpc',
          oldestAvailableLedger: 1,
          fromLedger: 1,
          throughLedger: 100,
          contiguous: true,
          evidenceHash: '0x2',
        },
        ...UNIMPLEMENTED_CHANNEL_SOURCES,
      ],
      candidates: [], // nothing unresolved either
      completedAt: 1700000000,
    })
    expect(audit.verdict).toBe('partial')
  })
})

// Review finding 2 (HIGH): the raw-RPC adapter used to stamp `scannedThroughLedger: endLedger`
// unconditionally, so a truncated page (cursor set, events at `limit`) was reported as fully
// scanned and pageArchivalSource stopped paging — silently dropping every event past the
// truncation boundary. interpretArchivalPage now reuses indexer.js's own scanRpcEventsPage (the
// exact MM3 truncation fix) instead of guessing.
describe('interpretArchivalPage — honest truncation (mirrors indexer.js scanRpcEventsPage)', () => {
  it('never claims the full requested range scanned when the response was truncated', () => {
    // 150 events at ledgers 1..150 requested as one page (startLedger=1, endLedger=1000), but the
    // "RPC" truncates at its own limit of 100 and sets a cursor — exactly the shape a truncated
    // real response has.
    const events = Array.from({ length: 100 }, (_, i) =>
      deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: i + 1, txHash: `TX${i + 1}` })
    )
    const out = interpretArchivalPage({
      res: { events, cursor: 'more', latestLedger: 1000 },
      startLedger: 1,
      endLedger: 1000,
    })
    expect(out.scannedThroughLedger).toBeLessThan(1000) // NOT the unconditional endLedger stamp
    expect(out.scannedThroughLedger).toBeLessThan(100) // boundary ledger's events are unsafe to claim
  })

  it('claims the full range only when the response genuinely reached it (no truncation signal)', () => {
    const events = [deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: 5, txHash: 'A' })]
    const out = interpretArchivalPage({ res: { events, cursor: null, latestLedger: 10 }, startLedger: 1, endLedger: 10 })
    expect(out.scannedThroughLedger).toBe(10)
  })

  it('regression: pageArchivalSource pages a truncated source through to completion — never silently loses events', async () => {
    const TOTAL = 250
    const LIMIT = 100
    const allRecs = Array.from({ length: TOTAL }, (_, i) =>
      deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: i + 1, txHash: `TX${i + 1}` })
    )
    const eventSource = {
      latestAvailableLedger: TOTAL,
      async getEvents({ startLedger, endLedger, limit }) {
        const remaining = allRecs.filter((r) => r.ledger >= startLedger)
        const page = remaining.slice(0, limit)
        const res = { events: page, cursor: remaining.length > limit ? 'more' : null, latestLedger: TOTAL }
        return interpretArchivalPage({ res, startLedger, endLedger })
      },
    }
    const out = await pageArchivalSource({ creator: { coverageStartLedger: 1 }, eventSource, limit: LIMIT, maxPages: 10 })
    expect(out.contiguous).toBe(true)
    expect(out.events).toHaveLength(TOTAL) // every event recovered, none lost to a falsely-claimed page 1
  })
})

// Review finding 3 (SPEC-MISSING): the brief requires persisting the audit evidence hash;
// evidenceHash was hard-coded to null. evidenceHashFor computes a deterministic hash over a
// source's actual evidence, reusing the same canonical-hash idiom as
// agentCreatorManifest.js's computeManifestHash.
describe('evidenceHashFor', () => {
  it('is stable for identical evidence and non-null', () => {
    const payload = { kind: 'funding-router', address: ROUTER.address, events: [{ ledger: 1, txHash: 'A' }] }
    const h1 = evidenceHashFor(payload)
    const h2 = evidenceHashFor({ ...payload })
    expect(h1).toBeTruthy()
    expect(h1).toBe(h2)
  })

  it('changes when the evidence changes', () => {
    const h1 = evidenceHashFor({ kind: 'funding-router', address: ROUTER.address, events: [{ ledger: 1, txHash: 'A' }] })
    const h2 = evidenceHashFor({ kind: 'funding-router', address: ROUTER.address, events: [{ ledger: 2, txHash: 'B' }] })
    expect(h2).not.toBe(h1)
  })
})
