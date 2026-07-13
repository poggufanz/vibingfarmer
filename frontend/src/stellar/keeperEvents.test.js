import { describe, it, expect } from 'vitest'
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk'
import { decodeKeeperEvent, fetchKeeperEvents } from './keeperEvents.js'

// Build a fake getEvents record the way the RPC returns one — mirrors events.test.js's
// fakeRecord helper (same topic[0]-symbol + value-map shape).
function fakeRecord({ type, fields, ledger, pagingToken }) {
  return {
    ledger,
    pagingToken,
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(fields),
    txHash: 'TX' + pagingToken,
  }
}

const VAULT = 'CB5VKYDUIYX3RZWGVLKKNBPG7V7Z5JIHF2QPNQKWKAHVA3IPSLFZJDYU'
const strategyA = Keypair.random().publicKey()
const strategyB = Keypair.random().publicKey()

describe('decodeKeeperEvent', () => {
  it('decodes a vault_compound record into a compound event', () => {
    const rec = fakeRecord({
      type: 'vault_compound',
      fields: { total_gain: 5_0000000n, price_per_share: 10_1000000n },
      ledger: 100,
      pagingToken: '0001',
    })
    const e = decodeKeeperEvent(rec)
    expect(e.type).toBe('compound')
    expect(e.ledger).toBe(100)
    expect(e.txHash).toBe('TX0001')
    expect(e.totalGain).toBe(5_0000000n)
    expect(e.pricePerShare).toBe(10_1000000n)
  })

  it('decodes a vault_rebalance record into a rebalance event', () => {
    const rec = fakeRecord({
      type: 'vault_rebalance',
      fields: { from: strategyA, to: strategyB, amount: 50_0000000n },
      ledger: 101,
      pagingToken: '0002',
    })
    const e = decodeKeeperEvent(rec)
    expect(e.type).toBe('rebalance')
    expect(e.from).toBe(strategyA)
    expect(e.to).toBe(strategyB)
    expect(e.amount).toBe(50_0000000n)
  })

  it('returns null for topics outside the compound/rebalance set', () => {
    const rec = fakeRecord({
      type: 'vault_deposit',
      fields: { from: strategyA, amount: 1n, shares: 1n },
      ledger: 1,
      pagingToken: '0003',
    })
    expect(decodeKeeperEvent(rec)).toBeNull()
  })

  it('skips a malformed vault_compound record instead of throwing', () => {
    // value decodes to `null` (ScVal::Void) — reading `.total_gain` off it would throw;
    // decodeKeeperEvent must catch that and return null, not propagate the error.
    const rec = fakeRecord({ type: 'vault_compound', fields: null, ledger: 2, pagingToken: '0004' })
    expect(() => decodeKeeperEvent(rec)).not.toThrow()
    expect(decodeKeeperEvent(rec)).toBeNull()
  })
})

describe('decodeKeeperEvent - lifeboat topics', () => {
  it('decodes vault_derisk', () => {
    const rec = fakeRecord({
      type: 'vault_derisk',
      fields: { reason_code: 2, drained_total: 800_0000000n },
      ledger: 102,
      pagingToken: '0005',
    })
    expect(decodeKeeperEvent(rec)).toEqual({
      type: 'derisk',
      ledger: rec.ledger,
      txHash: rec.txHash,
      reasonCode: 2,
      drainedTotal: 800_0000000n,
    })
  })

  it('decodes vault_resume', () => {
    const rec = fakeRecord({
      type: 'vault_resume',
      fields: { idle: 800_0000000n },
      ledger: 103,
      pagingToken: '0006',
    })
    expect(decodeKeeperEvent(rec)).toEqual({
      type: 'resume',
      ledger: rec.ledger,
      txHash: rec.txHash,
      idle: 800_0000000n,
    })
  })

  it('decodes vault_mandate', () => {
    const rec = fakeRecord({
      type: 'vault_mandate',
      fields: { authority: 'GAUTH', expiry: 1_999_999n },
      ledger: 104,
      pagingToken: '0007',
    })
    expect(decodeKeeperEvent(rec)).toEqual({
      type: 'mandate',
      ledger: rec.ledger,
      txHash: rec.txHash,
      authority: 'GAUTH',
      expiry: 1_999_999n,
    })
  })
})

describe('fetchKeeperEvents', () => {
  it('parses a batch of getEvents records into typed keeper events', async () => {
    const recCompound = fakeRecord({
      type: 'vault_compound',
      fields: { total_gain: 1_0000000n, price_per_share: 10_0000000n },
      ledger: 200,
      pagingToken: '0010',
    })
    const recRebalance = fakeRecord({
      type: 'vault_rebalance',
      fields: { from: strategyA, to: strategyB, amount: 2_0000000n },
      ledger: 201,
      pagingToken: '0011',
    })
    const fakeServer = {
      getEvents: async () => ({ events: [recCompound, recRebalance], latestLedger: 210 }),
    }
    const out = await fetchKeeperEvents('https://rpc.test', VAULT, 190, { server: fakeServer })
    expect(out.map((e) => e.type)).toEqual(['compound', 'rebalance'])
  })

  it('returns [] when getEvents has no events', async () => {
    const fakeServer = { getEvents: async () => ({ events: [], latestLedger: 300 }) }
    const out = await fetchKeeperEvents('https://rpc.test', VAULT, 290, { server: fakeServer })
    expect(out).toEqual([])
  })

  it('skips a malformed event within a batch without throwing', async () => {
    const good = fakeRecord({
      type: 'vault_compound',
      fields: { total_gain: 3_0000000n, price_per_share: 10_2000000n },
      ledger: 400,
      pagingToken: '0020',
    })
    const bad = fakeRecord({
      type: 'vault_compound',
      fields: null,
      ledger: 401,
      pagingToken: '0021',
    })
    const fakeServer = { getEvents: async () => ({ events: [bad, good], latestLedger: 410 }) }
    const out = await fetchKeeperEvents('https://rpc.test', VAULT, 390, { server: fakeServer })
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('compound')
  })

  it('auto-resolves a cold-start window via getLatestLedger when sinceLedger is omitted', async () => {
    let seenStartLedger = null
    const fakeServer = {
      getLatestLedger: async () => ({ sequence: 9000 }),
      getEvents: async ({ startLedger }) => {
        seenStartLedger = startLedger
        return { events: [], latestLedger: 9000 }
      },
    }
    await fetchKeeperEvents('https://rpc.test', VAULT, undefined, { server: fakeServer })
    expect(seenStartLedger).toBe(1000) // 9000 - 8000 lookback
  })
})
