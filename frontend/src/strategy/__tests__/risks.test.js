// frontend/src/strategy/__tests__/risks.test.js
// P1 G7: the risks table is the deposit flow's one honest page — pin its shape so a refactor
// can never silently drop a risk or its mitigation.
import { describe, it, expect } from 'vitest'
import { RISKS } from '../risks.js'

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
}

describe('RISKS — six risks, two sentences plus a mitigation each', () => {
  it('covers exactly the six brief risks, in order, with unique ids', () => {
    expect(RISKS.map((r) => r.id)).toEqual([
      'smart-contract',
      'oracle',
      'liquidity',
      'testnet-reset',
      'bridge-delay',
      'grant-scope',
    ])
  })

  it('every risk carries a title, a two-sentence body, and a non-empty mitigation', () => {
    for (const risk of RISKS) {
      expect(risk.title, `${risk.id}: title`).toMatch(/\S+ risk/)
      expect(sentences(risk.body), `${risk.id}: body is two sentences`).toHaveLength(2)
      expect(risk.mitigation.length, `${risk.id}: mitigation`).toBeGreaterThan(20)
    }
  })

  it('names the shipped mitigations, never vapor', () => {
    const all = RISKS.map((r) => `${r.body} ${r.mitigation}`).join(' ')
    for (const proof of [
      'unaudited',
      'multisig',
      'revoke',
      'lifeboat',
      'testnet',
      'resumable',
    ]) {
      expect(all).toMatch(new RegExp(proof))
    }
  })

  it('is frozen and free of em/en dashes', () => {
    expect(Object.isFrozen(RISKS)).toBe(true)
    expect(JSON.stringify(RISKS)).not.toMatch(/[—–]/)
  })
})

describe('AUDIT_PLAN — honestly unaudited with a mainnet scope', () => {
  it('states the unaudited status and the four-part scope, with no audited claim', async () => {
    const { AUDIT_PLAN } = await import('../risks.js')
    expect(AUDIT_PLAN).toMatch(/not audited/i)
    for (const part of ['router', 'vault', 'strategy', 'agent auth']) {
      expect(AUDIT_PLAN).toMatch(new RegExp(part))
    }
    expect(AUDIT_PLAN).not.toMatch(/audited by|audit complete|passed (an |the )?audit|certified/i)
  })
})
