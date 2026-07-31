// frontend/src/stellar/grantReceiptStore.test.js — persists GrantReceiptV1 only for a confirmed
// submission and verifies its own deterministic fingerprint on every read. An input pointer for
// reuse preflight only — never authoritative expiry evidence by itself (allowanceProof.js is).
import { describe, test, expect, beforeEach } from 'vitest'
import {
  fingerprintGrantReceipt,
  buildGrantReceiptV1,
  saveGrantReceipt,
  loadGrantReceipt,
  saveGrantReceiptV3,
  loadGrantReceiptV3History,
} from './grantReceiptStore.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const ROUTER = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const OTHER_ROUTER = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const NET = 'Test Net'

const makeStorage = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

function receipt(over = {}) {
  return {
    version: 1,
    runId: 'run-1',
    owner: OWNER,
    router: ROUTER,
    network: 'stellar-testnet',
    txHash: 'HGRANT',
    confirmedLedger: 1000,
    expiryLedger: 5000,
    allowanceBudgets: [{ token: TOKEN, units: '100000000', decimals: 7 }],
    agentInitFingerprint: '0xabc',
    agentAddresses: ['CAGENT1'],
    confirmedAt: 1_700_000_000,
    ...over,
  }
}

let storage
beforeEach(() => {
  storage = makeStorage()
})

describe('fingerprintGrantReceipt', () => {
  test('is deterministic regardless of source key order', () => {
    const r = receipt()
    const swapped = Object.fromEntries(Object.entries(r).reverse())
    expect(fingerprintGrantReceipt(r)).toBe(fingerprintGrantReceipt(swapped))
  })

  test('is a 0x-prefixed sha256 hex string', () => {
    expect(fingerprintGrantReceipt(receipt())).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test.each([
    ['txHash', { txHash: 'HOTHER' }],
    ['confirmedLedger', { confirmedLedger: 1001 }],
    ['expiryLedger', { expiryLedger: 5001 }],
    ['allowanceBudgets', { allowanceBudgets: [{ token: TOKEN, units: '1', decimals: 7 }] }],
    ['agentInitFingerprint', { agentInitFingerprint: '0xdef' }],
    ['agentAddresses', { agentAddresses: ['CAGENT2'] }],
    ['confirmedAt', { confirmedAt: 1 }],
  ])('changes when %s changes', (_label, over) => {
    expect(fingerprintGrantReceipt(receipt(over))).not.toBe(fingerprintGrantReceipt(receipt()))
  })
})

describe('buildGrantReceiptV1', () => {
  test('assembles the exact GrantReceiptV1 shape, stringifying bigint budget units', () => {
    const out = buildGrantReceiptV1({
      runId: 'run-1',
      owner: OWNER,
      router: ROUTER,
      txHash: 'HGRANT',
      confirmedLedger: 1000,
      expiryLedger: 5000,
      allowanceBudgets: [{ token: TOKEN, units: 100_000_000n, decimals: 7 }],
      agentInitFingerprint: '0xabc',
      agentAddresses: ['CAGENT1'],
      confirmedAt: 1_700_000_000,
    })
    expect(out).toEqual(receipt())
    expect(typeof out.allowanceBudgets[0].units).toBe('string')
  })

  test('never accepts Date.now() as confirmedAt implicitly - the caller must supply it', () => {
    expect(() =>
      buildGrantReceiptV1({
        runId: 'run-1',
        owner: OWNER,
        router: ROUTER,
        txHash: 'H',
        confirmedLedger: 1,
        expiryLedger: 2,
        allowanceBudgets: [],
        agentInitFingerprint: '0x0',
        agentAddresses: [],
        // confirmedAt omitted
      })
    ).toThrow()
  })
})

describe('saveGrantReceipt / loadGrantReceipt', () => {
  test('round-trips a receipt and its fingerprint verifies on read', () => {
    const r = receipt()
    saveGrantReceipt({ receipt: r, network: NET, storage })
    const loaded = loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })
    expect(loaded).toEqual(r)
  })

  test('missing receipt loads as null', () => {
    expect(loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })).toBeNull()
  })

  test('corrupt stored JSON degrades to null, never a throw', () => {
    storage.setItem('vf.grantReceiptStore.v1', '{not json')
    expect(loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })).toBeNull()
  })

  test('a tampered/corrupted receipt (fingerprint mismatch) loads as null', () => {
    saveGrantReceipt({ receipt: receipt(), network: NET, storage })
    // Directly corrupt the stored row's receipt without updating its fingerprint tag.
    const key = 'vf.grantReceiptStore.v1'
    const all = JSON.parse(storage.getItem(key))
    const bucketKey = Object.keys(all)[0]
    all[bucketKey].receipt.expiryLedger = 999999 // tamper
    storage.setItem(key, JSON.stringify(all))
    expect(loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })).toBeNull()
  })

  test('a receipt whose internal owner/router disagrees with the requested bucket loads as null', () => {
    saveGrantReceipt({ receipt: receipt(), network: NET, storage })
    const key = 'vf.grantReceiptStore.v1'
    const all = JSON.parse(storage.getItem(key))
    const bucketKey = Object.keys(all)[0]
    all[bucketKey].receipt.router = OTHER_ROUTER // now disagrees with its own fingerprint too
    // recompute a fingerprint over the tampered receipt so this test isolates the owner/router
    // guard from the fingerprint guard already covered above.
    all[bucketKey].fingerprint = fingerprintGrantReceipt(all[bucketKey].receipt)
    storage.setItem(key, JSON.stringify(all))
    expect(loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })).toBeNull()
  })

  test('different (owner, router) buckets stay isolated', () => {
    saveGrantReceipt({ receipt: receipt(), network: NET, storage })
    expect(
      loadGrantReceipt({ owner: OWNER, router: OTHER_ROUTER, network: NET, storage })
    ).toBeNull()
  })
})

// --- V3 additive history lane (Task 5 chunk A) -------------------------------------------------
// A distinct storage key from the V2 single-slot bucket above (vf.grantReceiptStore.v3 vs
// vf.grantReceiptStore.v1) — old V3 receipts are never overwritten, they accumulate as history.
// The V2 bucket shape, buildGrantReceiptV1, saveGrantReceipt, loadGrantReceipt and
// fingerprintGrantReceipt above are untouched by any of this.
function receiptV3(over = {}) {
  return {
    version: 3,
    permissionId: '0x' + '11'.repeat(32),
    scopeId: '0x' + '22'.repeat(32),
    owner: OWNER,
    router: ROUTER,
    network: 'stellar-testnet',
    mandateCeilingUnits: '100000000',
    liveUntilLedger: 5000,
    confirmedAt: 1_700_000_000,
    ...over,
  }
}

describe('saveGrantReceiptV3 / loadGrantReceiptV3History — additive V3 lane', () => {
  test('saving a V3 receipt leaves an existing V2 receipt at the same bucket byte-identical', () => {
    const v2 = receipt()
    saveGrantReceipt({ receipt: v2, network: NET, storage })
    saveGrantReceiptV3({ receipt: receiptV3(), network: NET, storage })
    expect(loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })).toEqual(v2)
  })

  test('multiple V3 receipts accumulate as history rather than overwriting each other', () => {
    saveGrantReceiptV3({
      receipt: receiptV3({ permissionId: '0x' + '11'.repeat(32) }),
      network: NET,
      storage,
    })
    saveGrantReceiptV3({
      receipt: receiptV3({ permissionId: '0x' + '33'.repeat(32) }),
      network: NET,
      storage,
    })
    const history = loadGrantReceiptV3History({
      owner: OWNER,
      router: ROUTER,
      network: NET,
      storage,
    })
    expect(history).toHaveLength(2)
    expect(history.map((r) => r.permissionId)).toEqual([
      '0x' + '11'.repeat(32),
      '0x' + '33'.repeat(32),
    ])
  })

  test('loadGrantReceipt (V2) is unaffected by the presence of V3 history', () => {
    const v2 = receipt()
    saveGrantReceipt({ receipt: v2, network: NET, storage })
    saveGrantReceiptV3({ receipt: receiptV3(), network: NET, storage })
    saveGrantReceiptV3({
      receipt: receiptV3({ permissionId: '0x' + '44'.repeat(32) }),
      network: NET,
      storage,
    })
    expect(loadGrantReceipt({ owner: OWNER, router: ROUTER, network: NET, storage })).toEqual(v2)
  })

  test('no history loads as an empty array, never null/throw', () => {
    expect(
      loadGrantReceiptV3History({ owner: OWNER, router: ROUTER, network: NET, storage })
    ).toEqual([])
  })

  test('a tampered V3 history entry (fingerprint mismatch) is dropped, not the whole history', () => {
    saveGrantReceiptV3({
      receipt: receiptV3({ permissionId: '0x' + '55'.repeat(32) }),
      network: NET,
      storage,
    })
    saveGrantReceiptV3({
      receipt: receiptV3({ permissionId: '0x' + '66'.repeat(32) }),
      network: NET,
      storage,
    })
    const key = 'vf.grantReceiptStore.v3'
    const all = JSON.parse(storage.getItem(key))
    const bucketKey = Object.keys(all)[0]
    all[bucketKey][0].receipt.mandateCeilingUnits = '999999999' // tamper the first entry only
    storage.setItem(key, JSON.stringify(all))
    const history = loadGrantReceiptV3History({
      owner: OWNER,
      router: ROUTER,
      network: NET,
      storage,
    })
    expect(history).toHaveLength(1)
    expect(history[0].permissionId).toBe('0x' + '66'.repeat(32))
  })

  test('different (owner, router) buckets stay isolated for V3 history too', () => {
    saveGrantReceiptV3({ receipt: receiptV3(), network: NET, storage })
    expect(
      loadGrantReceiptV3History({ owner: OWNER, router: OTHER_ROUTER, network: NET, storage })
    ).toEqual([])
  })
})
