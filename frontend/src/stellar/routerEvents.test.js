import { describe, it, expect } from 'vitest'
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from './scval.js'
import { decodeDeployedEvent, fetchRouterDeployedEvents } from './routerEvents.js'

const ROUTER = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const AGENT_A = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_B = 'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'
const OWNER = Keypair.random().publicKey()

// Mirror an RPC getEvents `Deployed` record: topics [deployed(lowercase), owner, agent],
// data = ScMap { cap }.
function deployedRecord({ owner = OWNER, agent, cap, ledger, txHash }) {
  return {
    ledger,
    txHash,
    topic: [symbolScVal('deployed'), addrScVal(owner), addrScVal(agent)],
    value: nativeToScVal({ cap }),
  }
}

describe('decodeDeployedEvent', () => {
  it('decodes a deployed record into { owner, agent, cap }', () => {
    const rec = deployedRecord({ agent: AGENT_A, cap: 1000n, ledger: 42, txHash: 'TX1' })
    expect(decodeDeployedEvent(rec)).toEqual({
      owner: OWNER,
      agent: AGENT_A,
      cap: 1000n,
      ledger: 42,
      txHash: 'TX1',
    })
  })

  it('returns null for a non-deployed topic', () => {
    const rec = {
      topic: [symbolScVal('pulled'), addrScVal(OWNER), addrScVal(AGENT_A)],
      value: nativeToScVal({ amount: 5n }),
    }
    expect(decodeDeployedEvent(rec)).toBeNull()
  })

  it('returns null for a malformed value instead of throwing (ScVal::Void data)', () => {
    const rec = {
      topic: [symbolScVal('deployed'), addrScVal(OWNER), addrScVal(AGENT_A)],
      value: nativeToScVal(null),
    }
    expect(() => decodeDeployedEvent(rec)).not.toThrow()
    expect(decodeDeployedEvent(rec)).toBeNull()
  })
})

describe('fetchRouterDeployedEvents', () => {
  it('builds the 3-segment lowercase topic filter and paginates by advancing cursor', async () => {
    const rec1 = deployedRecord({ agent: AGENT_A, cap: 1n, ledger: 100, txHash: 'TXA' })
    const rec2 = deployedRecord({ agent: AGENT_B, cap: 2n, ledger: 101, txHash: 'TXB' })
    const reqs = []
    const server = {
      getHealth: async () => ({ oldestLedger: 1, ledgerRetentionWindow: 120960 }),
      getLatestLedger: async () => ({ sequence: 5000 }),
      getEvents: async (req) => {
        reqs.push(req)
        if (!req.cursor) return { events: [rec1], cursor: 'p1', latestLedger: 5000 }
        if (req.cursor === 'p1') return { events: [rec2], cursor: 'p2', latestLedger: 5000 }
        return { events: [], cursor: req.cursor, latestLedger: 5000 } // cursor no-advance → terminate
      },
    }
    const out = await fetchRouterDeployedEvents({ server, routerAddress: ROUTER, owner: OWNER })

    expect(out.map((e) => e.agent)).toEqual([AGENT_A, AGENT_B])
    // First page = ledger-range mode: startLedger present, cursor absent.
    expect(typeof reqs[0].startLedger).toBe('number')
    expect(reqs[0].cursor).toBeUndefined()
    // Filter: lowercase `deployed`, owner address, wildcard — as base64 XDR.
    expect(reqs[0].filters[0].contractIds).toEqual([ROUTER])
    expect(reqs[0].filters[0].topics).toEqual([
      [symbolScVal('deployed').toXDR('base64'), addrScVal(OWNER).toXDR('base64'), '*'],
    ])
    // Cursor pages MUST omit startLedger (SDK 16 forbids mixing the two modes).
    expect(reqs[1].cursor).toBe('p1')
    expect(reqs[1].startLedger).toBeUndefined()
  })

  it('clamps startLedger and retries once on a -32600 out-of-range error', async () => {
    const rec = deployedRecord({ agent: AGENT_A, cap: 9n, ledger: 600, txHash: 'TXC' })
    const reqs = []
    let calls = 0
    const server = {
      getHealth: async () => ({ oldestLedger: 1 }), // stale floor → first scan falls out of range
      getLatestLedger: async () => ({ sequence: 900 }),
      getEvents: async (req) => {
        reqs.push(req)
        calls += 1
        if (calls === 1) throw new Error('startLedger must be within the ledger range: 500 - 900')
        if (calls === 2) return { events: [rec], cursor: 'end', latestLedger: 900 }
        return { events: [], cursor: 'end', latestLedger: 900 }
      },
    }
    const out = await fetchRouterDeployedEvents({ server, routerAddress: ROUTER, owner: OWNER })
    expect(out.map((e) => e.agent)).toEqual([AGENT_A])
    expect(reqs[0].startLedger).toBe(1)
    expect(reqs[1].startLedger).toBe(500) // clamped to the range's oldest ledger
  })

  it('returns [] when the owner has no deployed events', async () => {
    const server = {
      getHealth: async () => ({ oldestLedger: 1, ledgerRetentionWindow: 120960 }),
      getLatestLedger: async () => ({ sequence: 5000 }),
      getEvents: async (req) => ({
        events: [],
        cursor: req.cursor ?? undefined,
        latestLedger: 5000,
      }),
    }
    const out = await fetchRouterDeployedEvents({ server, routerAddress: ROUTER, owner: OWNER })
    expect(out).toEqual([])
  })
})
