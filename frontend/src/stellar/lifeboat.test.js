// frontend/src/stellar/lifeboat.test.js
import { describe, it, expect, vi } from 'vitest'
import { panelState, REASON_LABELS, grantMandate } from './lifeboat.js'

describe('panelState', () => {
  it('ENGAGED whenever derisked, regardless of mandate', () => {
    expect(panelState({ derisked: true, mandateExpiry: 0, nowS: 100 })).toBe('ENGAGED')
  })
  it('ARMED when mandate is live', () => {
    expect(panelState({ derisked: false, mandateExpiry: 200, nowS: 100 })).toBe('ARMED')
  })
  it('DISARMED when mandate expired or never granted (boundary: expiry == now)', () => {
    expect(panelState({ derisked: false, mandateExpiry: 100, nowS: 100 })).toBe('DISARMED')
    expect(panelState({ derisked: false, mandateExpiry: 0, nowS: 100 })).toBe('DISARMED')
  })
})

describe('REASON_LABELS', () => {
  it('covers the shared reason codes 1..3', () => {
    expect(REASON_LABELS[1]).toBe('Utilization spike')
    expect(REASON_LABELS[2]).toBe('Liquidity drop')
    expect(REASON_LABELS[3]).toBe('Oracle divergence')
  })
})

describe('grantMandate', () => {
  it('builds set_mandate(now + hours*3600), signs, submits (injected deps)', async () => {
    const deps = {
      buildInvokeTx: vi.fn(async () => ({ xdr: 'XDR' })),
      signTxXdr: vi.fn(async () => 'SIGNED'),
      submitUserTx: vi.fn(async () => ({ hash: 'H', status: 'SUCCESS' })),
      nowS: 1_000_000,
    }
    const res = await grantMandate({ owner: 'GOWNER', hours: 24, deps })
    expect(deps.buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'GOWNER',
        method: 'set_mandate',
        args: [{ u64: 1_000_000 + 24 * 3600 }],
      })
    )
    expect(deps.signTxXdr).toHaveBeenCalledWith('XDR')
    expect(deps.submitUserTx).toHaveBeenCalledWith({ signedXdr: 'SIGNED' })
    expect(res).toEqual({ hash: 'H', status: 'SUCCESS' })
  })
})
