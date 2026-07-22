// frontend/src/stellar/allowanceEventStore.test.js — resumable owner→router SAC `approve` event
// cache/cursor. Never a proof by itself: every sync re-touches the chain for at least the delta,
// and a gapped/short scan must never be persisted as a complete range.
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { xdr } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal, i128ScVal, u32ScVal } from './scval.js'
import {
  cacheKeyFor,
  loadEventCache,
  saveEventCache,
  decodeApproveEvent,
  fetchApprovalEventRange,
  syncApprovalEvents,
} from './allowanceEventStore.js'

const NET = 'Test Net'
// Real testnet-shaped addresses (valid strkeys — Address() validates them on encode).
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const ROUTER = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'

const makeStorage = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

// One raw getEvents record shaped like the real RPC response: topics + value are ScVals, exactly
// what fromScVal (scval.js) decodes. Mirrors the built-in SAC `approve` event: topics =
// (approve, from, spender), data = (amount, expiration_ledger) as a bare 2-tuple.
function approveRecord({
  owner = OWNER,
  spender = ROUTER,
  amount = 100n,
  expiry = 5000,
  ledger,
  txHash = 'HTX',
}) {
  return {
    topic: [symbolScVal('approve'), addrScVal(owner), addrScVal(spender)],
    value: xdr.ScVal.scvVec([i128ScVal(amount), u32ScVal(expiry)]),
    ledger,
    txHash,
  }
}

let storage
beforeEach(() => {
  storage = makeStorage()
})

describe('cacheKeyFor', () => {
  test('scopes by network|owner|router|token', () => {
    expect(cacheKeyFor({ owner: OWNER, router: ROUTER, token: TOKEN, network: NET })).toBe(
      `${NET}|${OWNER}|${ROUTER}|${TOKEN}`
    )
  })
})

describe('loadEventCache / saveEventCache', () => {
  test('round-trips a range, reviving bigint amounts', () => {
    saveEventCache({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      cache: {
        indexedFromLedger: 100,
        indexedThroughLedger: 200,
        approvals: [
          {
            owner: OWNER,
            spender: ROUTER,
            amount: 500n,
            expiryLedger: 9000,
            ledger: 150,
            txHash: 'H1',
            eventIndex: 0,
          },
        ],
      },
      storage,
    })
    const out = loadEventCache({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      storage,
    })
    expect(out.indexedFromLedger).toBe(100)
    expect(out.indexedThroughLedger).toBe(200)
    expect(out.approvals[0].amount).toBe(500n)
    expect(typeof out.approvals[0].amount).toBe('bigint')
  })

  test('missing bucket loads as null (never a fabricated empty range)', () => {
    expect(
      loadEventCache({ owner: OWNER, router: ROUTER, token: TOKEN, network: NET, storage })
    ).toBeNull()
  })

  test('corrupt stored JSON degrades to null, never a throw', () => {
    storage.setItem('vf.allowanceEventCache.v1', '{not json')
    expect(
      loadEventCache({ owner: OWNER, router: ROUTER, token: TOKEN, network: NET, storage })
    ).toBeNull()
  })
})

describe('decodeApproveEvent', () => {
  test('decodes a well-formed approve record', () => {
    const row = decodeApproveEvent(approveRecord({ amount: 250n, expiry: 8000, ledger: 111 }), 3)
    expect(row).toEqual({
      owner: OWNER,
      spender: ROUTER,
      amount: 250n,
      expiryLedger: 8000,
      ledger: 111,
      txHash: 'HTX',
      eventIndex: 3,
    })
  })

  test('returns null for a non-approve topic', () => {
    const rec = approveRecord({ ledger: 1 })
    rec.topic[0] = symbolScVal('transfer')
    expect(decodeApproveEvent(rec, 0)).toBeNull()
  })

  test('returns null for a malformed/undecodable record, never throws', () => {
    expect(decodeApproveEvent({ topic: [], value: null }, 0)).toBeNull()
    expect(() => decodeApproveEvent(null, 0)).not.toThrow()
    expect(decodeApproveEvent(null, 0)).toBeNull()
  })
})

// Fake RPC server: getEvents pages by cursor. `pages` is an array of { events, cursor?,
// latestLedger }; the fake advances one page per call and stalls (repeats the last cursor) once
// exhausted — mirroring the real RPC's "cursor stops advancing at the tip" contract.
function fakeServer(pages) {
  let i = 0
  return {
    getEvents: async ({ cursor }) => {
      // A caller passing a cursor argument that matches our own last-issued cursor resumes
      // correctly; this fake only cares about page order, not the cursor value itself.
      void cursor
      const page = pages[Math.min(i, pages.length - 1)]
      if (i < pages.length) i++
      return page
    },
  }
}

describe('fetchApprovalEventRange', () => {
  test('single page reaching the tip is gap-free', async () => {
    const server = fakeServer([
      {
        events: [approveRecord({ ledger: 100, amount: 1n })],
        cursor: undefined,
        latestLedger: 100,
      },
    ])
    const out = await fetchApprovalEventRange({
      server,
      token: TOKEN,
      owner: OWNER,
      router: ROUTER,
      fromLedger: 90,
    })
    expect(out.gapFree).toBe(true)
    expect(out.approvals).toHaveLength(1)
    expect(out.reachedThroughLedger).toBe(100)
  })

  test('paginates across multiple pages until the cursor stalls', async () => {
    const server = fakeServer([
      { events: [approveRecord({ ledger: 100, amount: 1n })], cursor: 'C1', latestLedger: 300 },
      { events: [approveRecord({ ledger: 200, amount: 2n })], cursor: 'C2', latestLedger: 300 },
      { events: [approveRecord({ ledger: 300, amount: 3n })], cursor: 'C2' }, // cursor repeats -> tip
    ])
    const out = await fetchApprovalEventRange({
      server,
      token: TOKEN,
      owner: OWNER,
      router: ROUTER,
      fromLedger: 1,
    })
    expect(out.gapFree).toBe(true)
    expect(out.approvals.map((a) => a.amount)).toEqual([1n, 2n, 3n])
    expect(out.reachedThroughLedger).toBe(300)
  })

  test('exhausting the page budget without reaching the tip is UNPROVEN (gapFree false)', async () => {
    // cursor always advances (never stalls) -> the loop must give up at MAX_PAGES, not loop forever
    let n = 0
    const server = {
      getEvents: async () => {
        n++
        return { events: [], cursor: `C${n}`, latestLedger: 999999 }
      },
    }
    const out = await fetchApprovalEventRange({
      server,
      token: TOKEN,
      owner: OWNER,
      router: ROUTER,
      fromLedger: 1,
    })
    expect(out.gapFree).toBe(false)
  })

  test('an RPC error mid-scan keeps what was proven so far but marks the range unproven', async () => {
    const server = {
      getEvents: vi
        .fn()
        .mockResolvedValueOnce({
          events: [approveRecord({ ledger: 50, amount: 9n })],
          cursor: 'C1',
          latestLedger: 500,
        })
        .mockRejectedValueOnce(new Error('retention loss')),
    }
    const out = await fetchApprovalEventRange({
      server,
      token: TOKEN,
      owner: OWNER,
      router: ROUTER,
      fromLedger: 1,
    })
    expect(out.gapFree).toBe(false)
    expect(out.approvals).toHaveLength(1)
  })
})

describe('syncApprovalEvents (resumable cache/cursor)', () => {
  test('a fresh sync (no cache) fetches from the floor and persists what it proved', async () => {
    const fetchRange = vi.fn(async () => ({
      approvals: [
        {
          owner: OWNER,
          spender: ROUTER,
          amount: 10n,
          expiryLedger: 900,
          ledger: 120,
          txHash: 'H',
          eventIndex: 0,
        },
      ],
      reachedThroughLedger: 500,
      gapFree: true,
    }))
    const out = await syncApprovalEvents({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      fromLedgerFloor: 100,
      storage,
      fetchRange,
    })
    expect(fetchRange).toHaveBeenCalledWith(expect.objectContaining({ fromLedger: 100 }))
    expect(out).toMatchObject({ indexedFromLedger: 100, indexedThroughLedger: 500, gapFree: true })
    expect(
      loadEventCache({ owner: OWNER, router: ROUTER, token: TOKEN, network: NET, storage })
        .indexedThroughLedger
    ).toBe(500)
  })

  test('resumes from the cached boundary instead of re-scanning from the floor', async () => {
    saveEventCache({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      cache: {
        indexedFromLedger: 100,
        indexedThroughLedger: 400,
        approvals: [
          {
            owner: OWNER,
            spender: ROUTER,
            amount: 1n,
            expiryLedger: 900,
            ledger: 150,
            txHash: 'H1',
            eventIndex: 0,
          },
        ],
      },
      storage,
    })
    const fetchRange = vi.fn(async () => ({
      approvals: [
        {
          owner: OWNER,
          spender: ROUTER,
          amount: 2n,
          expiryLedger: 950,
          ledger: 450,
          txHash: 'H2',
          eventIndex: 0,
        },
      ],
      reachedThroughLedger: 600,
      gapFree: true,
    }))
    const out = await syncApprovalEvents({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      fromLedgerFloor: 100,
      storage,
      fetchRange,
    })
    expect(fetchRange).toHaveBeenCalledWith(expect.objectContaining({ fromLedger: 401 })) // 400 + 1, never re-scans
    expect(out.approvals.map((a) => a.amount)).toEqual([1n, 2n]) // merged, cached + fresh
    expect(out.indexedThroughLedger).toBe(600)
  })

  test('ALWAYS touches the chain, even when the cache already looks sufficient (never a cache-only "prove")', async () => {
    saveEventCache({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      cache: { indexedFromLedger: 100, indexedThroughLedger: 9000, approvals: [] },
      storage,
    })
    const fetchRange = vi.fn(async () => ({
      approvals: [],
      reachedThroughLedger: 9100,
      gapFree: true,
    }))
    await syncApprovalEvents({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      fromLedgerFloor: 100,
      storage,
      fetchRange,
    })
    expect(fetchRange).toHaveBeenCalledTimes(1)
  })

  test('a gapped scan NEVER upgrades the persisted range past what was proven', async () => {
    saveEventCache({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      cache: { indexedFromLedger: 100, indexedThroughLedger: 400, approvals: [] },
      storage,
    })
    const fetchRange = vi.fn(async () => ({
      approvals: [],
      reachedThroughLedger: 550,
      gapFree: false,
    }))
    const out = await syncApprovalEvents({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      fromLedgerFloor: 100,
      storage,
      fetchRange,
    })
    expect(out.gapFree).toBe(false)
    expect(out.indexedThroughLedger).toBe(400) // capped at the last PROVEN boundary, not 550
    expect(
      loadEventCache({ owner: OWNER, router: ROUTER, token: TOKEN, network: NET, storage })
        .indexedThroughLedger
    ).toBe(400)
  })

  test('a floor earlier than the cached range triggers a full fresh fetch (cache not usable)', async () => {
    saveEventCache({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      cache: {
        indexedFromLedger: 500,
        indexedThroughLedger: 900,
        approvals: [
          {
            owner: OWNER,
            spender: ROUTER,
            amount: 7n,
            expiryLedger: 950,
            ledger: 600,
            txHash: 'H',
            eventIndex: 0,
          },
        ],
      },
      storage,
    })
    const fetchRange = vi.fn(async () => ({
      approvals: [],
      reachedThroughLedger: 1000,
      gapFree: true,
    }))
    const out = await syncApprovalEvents({
      owner: OWNER,
      router: ROUTER,
      token: TOKEN,
      network: NET,
      fromLedgerFloor: 100,
      storage,
      fetchRange,
    })
    expect(fetchRange).toHaveBeenCalledWith(expect.objectContaining({ fromLedger: 100 }))
    expect(out.indexedFromLedger).toBe(100)
    expect(out.approvals).toEqual([]) // the old (now out-of-window) cached row is not blindly reused
  })
})
