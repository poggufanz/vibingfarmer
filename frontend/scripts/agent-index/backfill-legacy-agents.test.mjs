import { describe, it, expect } from 'vitest'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import {
  parseArgs,
  candidateFromRouterEvent,
  candidateFromRegistryEvent,
  pageArchivalSource,
  KNOWN_DIRECT_DEPLOY_LOGS,
} from './backfill-legacy-agents.mjs'
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
