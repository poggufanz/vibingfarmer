import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk'
import { decodeEvent, eventToGraphDelta, pollEvents, discoverAgentsFromVault } from './events.js'

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

  it('decodes a strategy_attested event', () => {
    const rec = fakeRecord({
      type: 'strategy_attested',
      fields: { attester: agent, strategy_hash: 'ab'.repeat(32), ledger: 99, label: 'venice' },
      contractId: 'CATTEST_PLACEHOLDER',
      pagingToken: '0099',
      ledger: 99,
    })
    const e = decodeEvent(rec)
    expect(e.type).toBe('strategy_attested')
    expect(e.data.label).toBe('venice')
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

describe('discoverAgentsFromVault — bounded, abortable holder verification', () => {
  let consoleLog
  beforeAll(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterAll(() => consoleLog.mockRestore())

  function vaultDepositRecords(count) {
    return Array.from({ length: count }, (_, index) =>
      fakeRecord({
        type: 'vault_deposit',
        fields: { holder: Keypair.random().publicKey(), amount: 1n, shares: 1n },
        contractId: VAULT,
        pagingToken: `vault-${index}`,
        ledger: 100 + index,
      })
    )
  }

  async function waitUntil(predicate) {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('condition was not reached')
  }

  it('caps 501 individual scope RPCs at eight and keeps verified holders in event order', async () => {
    const records = vaultDepositRecords(501)
    // Derive holder addresses through the same public decoder used by production, not private XDR
    // representation details.
    const addresses = records.map((record) => decodeEvent(record).data.holder)
    let active = 0
    let peak = 0
    const readScope = async (address) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      if (address === addresses[250]) throw new Error('scope unavailable')
      return { owner: 'GOWNER' }
    }
    const server = {
      getLatestLedger: vi.fn(async () => ({ sequence: 1_000 })),
      getEvents: vi.fn(async () => ({ events: records })),
    }

    const result = await discoverAgentsFromVault('GOWNER', { server, readScope })

    expect(peak).toBe(8)
    expect(result).toEqual(addresses.filter((_, index) => index !== 250))
  })

  it('propagates abort and does not start queued holder scope RPCs', async () => {
    const records = vaultDepositRecords(501)
    const controller = new AbortController()
    const gates = Array.from({ length: 8 }, () => {
      let resolve
      const promise = new Promise((res) => {
        resolve = res
      })
      return { promise, resolve }
    })
    const started = []
    const server = {
      getLatestLedger: vi.fn(async () => ({ sequence: 1_000 })),
      getEvents: vi.fn(async () => ({ events: records })),
    }
    const operation = discoverAgentsFromVault('GOWNER', {
      server,
      signal: controller.signal,
      readScope: async () => {
        const call = started.length
        started.push(call)
        if (call < gates.length) await gates[call].promise
        return { owner: 'GOWNER' }
      },
    })

    await waitUntil(() => started.length >= 8)
    const reason = new Error('owner switched')
    controller.abort(reason)
    for (const gate of gates) gate.resolve()

    await expect(operation).rejects.toBe(reason)
    expect(started).toHaveLength(8)
  })
})
