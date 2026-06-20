import { describe, it, expect, vi } from 'vitest'
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk'
import { decodeEvent, eventToGraphDelta, pollEvents } from './events.js'

// Build a fake getEvents record the way the RPC returns one: topics[] + value as ScVals.
function fakeRecord({ type, fields, contractId, pagingToken, ledger }) {
  return {
    type: 'contract',
    contractId,
    ledger,
    pagingToken,
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(fields), // a map ScVal of the event body
    txHash: 'TX' + pagingToken,
  }
}

const VAULT = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
const agent = Keypair.random().publicKey()

describe('event indexer', () => {
  it('decodes a vault_deposit record into a typed event', () => {
    const rec = fakeRecord({
      type: 'vault_deposit',
      fields: { from: agent, amount: 100_0000000n, shares: 100_0000000n },
      contractId: VAULT,
      pagingToken: '0001',
      ledger: 42,
    })
    const e = decodeEvent(rec)
    expect(e.type).toBe('vault_deposit')
    expect(e.contract).toBe(VAULT)
    expect(e.ledger).toBe(42)
    expect(e.cursor).toBe('0001')
    expect(e.data.amount).toBe(100_0000000n)
  })

  it('maps a vault_deposit to a graph delta edge agent→vault', () => {
    const e = decodeEvent(
      fakeRecord({
        type: 'vault_deposit',
        fields: { from: agent, amount: 5n, shares: 5n },
        contractId: VAULT,
        pagingToken: '0002',
        ledger: 43,
      })
    )
    const delta = eventToGraphDelta(e)
    expect(delta.edge).toEqual({ source: agent, target: VAULT, kind: 'deposit' })
  })

  it('pollEvents dedups already-seen cursors and returns only new decoded events', async () => {
    const recA = fakeRecord({
      type: 'vault_drip',
      fields: { amount: 1n },
      contractId: VAULT,
      pagingToken: '0010',
      ledger: 50,
    })
    const recB = fakeRecord({
      type: 'vault_claim',
      fields: { holder: agent, amount: 2n },
      contractId: VAULT,
      pagingToken: '0011',
      ledger: 51,
    })
    const fakeServer = {
      getLatestLedger: vi.fn(async () => ({ sequence: 60 })),
      getEvents: vi.fn(async () => ({ events: [recA, recB], latestLedger: 60 })),
    }
    const seen = new Set(['0010']) // recA already processed
    const out = await pollEvents({ server: fakeServer, startLedger: 40, seen })
    expect(out.events.map((e) => e.type)).toEqual(['vault_claim'])
    expect(out.seen.has('0011')).toBe(true)
  })
})
