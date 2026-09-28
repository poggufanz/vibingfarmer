// frontend/src/strategy/__tests__/risksAck.test.js
// P1 G7: the Risks gate shows exactly once per wallet — before the first grant, never again.
import { describe, it, expect } from 'vitest'
import { saveGrantReceipt, buildGrantReceiptV1 } from '../../stellar/grantReceiptStore.js'
// The gate looks the receipt up under config's own default network bucket, so the fixture
// receipt must be saved under that same bucket — never a hardcoded passphrase that can drift.
import { NETWORK_PASSPHRASE } from '../../stellar/config.js'
import { hasRisksAck, loadRisksAck, needsRisksAck, saveRisksAck } from '../risksAck.js'

const OWNER = 'GOWNER'
const OTHER = 'GOTHER'
const ROUTER = 'CROUTER'

function memStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v))
    },
  }
}

function grantReceipt() {
  return buildGrantReceiptV1({
    runId: 'run-1',
    owner: OWNER,
    router: ROUTER,
    txHash: 'HGRANT',
    confirmedLedger: 1000,
    expiryLedger: 5000,
    allowanceBudgets: [],
    agentInitFingerprint: '0xabc',
    agentAddresses: ['CAGENT1'],
    confirmedAt: 1_700_000_000,
  })
}

describe('risksAck — acknowledgement is per wallet', () => {
  it('round-trips an ack and isolates wallets', () => {
    const storage = memStorage()
    expect(hasRisksAck({ owner: OWNER, storage })).toBe(false)
    expect(saveRisksAck({ owner: OWNER, storage, nowMs: 123 })).toBe(true)
    expect(loadRisksAck({ owner: OWNER, storage })).toEqual({ ackedAt: 123 })
    expect(hasRisksAck({ owner: OTHER, storage })).toBe(false)
  })

  it('corrupt or missing rows read as no ack, never a throw', () => {
    const storage = memStorage()
    storage.setItem('vf.risksAck.v1:GOWNER', '{not json')
    expect(loadRisksAck({ owner: OWNER, storage })).toBeNull()
    expect(loadRisksAck({ owner: null, storage })).toBeNull()
  })

  it('an unwritable store fails closed to false, never throws', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(saveRisksAck({ owner: OWNER, storage })).toBe(false)
  })
})

describe('needsRisksAck — the first-grant gate', () => {
  it('a fresh wallet with no receipt owes the acknowledgement', () => {
    expect(needsRisksAck({ owner: OWNER, router: ROUTER, storage: memStorage() })).toBe(true)
  })

  it('a stored ack silences the gate even with no receipt', () => {
    const storage = memStorage()
    saveRisksAck({ owner: OWNER, storage })
    expect(needsRisksAck({ owner: OWNER, router: ROUTER, storage })).toBe(false)
  })

  it('an existing grant receipt silences the gate even with no ack', () => {
    const storage = memStorage()
    saveGrantReceipt({ receipt: grantReceipt(), network: NETWORK_PASSPHRASE, storage })
    // Same storage carries both lanes: the receipt the gate reuses as its detector…
    expect(needsRisksAck({ owner: OWNER, router: ROUTER, storage })).toBe(false)
    // …while another wallet still owes it.
    expect(needsRisksAck({ owner: OTHER, router: ROUTER, storage })).toBe(true)
  })

  it('no owner never owes the gate and never touches storage', () => {
    const storage = memStorage()
    expect(needsRisksAck({ owner: null, router: ROUTER, storage })).toBe(false)
  })
})
