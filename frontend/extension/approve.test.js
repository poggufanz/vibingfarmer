import { describe, it, expect } from 'vitest'
import { screenModel, rejectionResult } from './approve.js'

const ORIGIN = 'https://vibing-farmer.pages.dev'

describe('approve — screen model', () => {
  it('no wallet stored → no-wallet variant with an onboarding CTA', () => {
    const m = screenModel({ method: 'getAddress', params: {}, origin: ORIGIN }, { address: null })
    expect(m.variant).toBe('no-wallet')
    expect(m.origin).toBe(ORIGIN)
    expect(m.approveLabel).toBe('Open VF Wallet')
  })

  it('getAddress → connect variant showing account + network', () => {
    const m = screenModel(
      { method: 'getAddress', params: {}, origin: ORIGIN },
      { address: 'CDLVXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXK3QP' }
    )
    expect(m.variant).toBe('connect')
    expect(m.title).toBe('Connection request')
    expect(m.approveLabel).toBe('Connect')
    expect(m.rows).toContainEqual(['Network', 'TESTNET'])
    expect(m.rows.find(([k]) => k === 'Account')[1]).toMatch(/^CDLV…K3QP$/)
  })

  it('signTransaction with a decoded summary → sign variant with contract/function/args rows', () => {
    const m = screenModel(
      { method: 'signTransaction', params: { xdr: 'RAWXDR' }, origin: ORIGIN },
      {
        address: 'CACCT',
        summary: {
          network: 'TESTNET',
          contract: 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5',
          contractLabel: 'funding router',
          fn: 'grant',
          args: ['CDLV…K3QP', '5000000 (0.5)'],
          signer: null,
        },
      }
    )
    expect(m.variant).toBe('sign')
    expect(m.title).toBe('Signature request')
    expect(m.approveLabel).toBe('Approve')
    expect(m.raw).toBe('RAWXDR')
    expect(m.rows).toContainEqual(['Function', 'grant'])
    expect(m.rows.find(([k]) => k === 'Contract')[1]).toContain('funding router')
    expect(m.rows.filter(([k]) => k === 'Args' || k === '')).toHaveLength(2)
  })

  it('signAuthEntry with a null summary still renders a sign screen with the raw entry', () => {
    const m = screenModel(
      { method: 'signAuthEntry', params: { authEntry: 'RAWENTRY' }, origin: ORIGIN },
      { address: 'CACCT', summary: null }
    )
    expect(m.variant).toBe('sign')
    expect(m.raw).toBe('RAWENTRY')
    expect(m.rows).toContainEqual(['Network', 'TESTNET'])
  })

  it('rejectionResult is the exact SEP-43 -4 CEREMONY_RESULT', () => {
    expect(rejectionResult('rid-9')).toEqual({
      type: 'CEREMONY_RESULT',
      rid: 'rid-9',
      ok: false,
      code: -4,
      error: 'User rejected the request',
    })
  })
})
