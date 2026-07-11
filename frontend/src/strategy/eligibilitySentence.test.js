import { describe, it, expect } from 'vitest'
import { buildEligibilitySentence, vaultEligibilityLabel } from './eligibilitySentence.js'

const verdict = {
  protocol: 'aave-v3',
  eligible: true,
  yieldReality: { ratio: 1.0, verdict: 'real' },
  security: { score: 92, auditGate: 'pass' },
  reasons: [],
  isFixture: false,
}
const ctx = { targetMaxLossPct: 5, protocolLabel: 'Aave v3 (mainnet)' }

describe('eligibility sentence honesty', () => {
  it('includes the mainnet revenue-covered phrasing with ratio', () => {
    expect(buildEligibilitySentence(verdict, ctx)).toMatch(/revenue-covered \(ratio 1\.0/)
  })
  it('co-emits the testnet caveat', () => {
    expect(buildEligibilitySentence(verdict, ctx)).toMatch(/testnet/i)
  })
  it('never says bare "yield is real" / "real yield"', () => {
    const s = buildEligibilitySentence(verdict, ctx)
    expect(s).not.toMatch(/yield is real/i)
    expect(s).not.toMatch(/real yield/i)
  })
  it('tags the score as our weighting and uses target not guaranteed', () => {
    const s = buildEligibilitySentence(verdict, ctx)
    expect(s).toMatch(/our weighting/i)
    expect(s).toMatch(/target max loss/i)
    expect(s).not.toMatch(/guaranteed/i)
  })
  it('label for a real verdict is ratio+context anchored', () => {
    expect(vaultEligibilityLabel(verdict)).toMatch(/revenue-covered \(ratio 1\.0\)/)
  })
  it('surfaces no raw mainnet TVL/revenue figure (only the ratio is shown)', () => {
    // honesty: a 4+ digit run or a $-figure or "TVL" would leak an absolute mainnet number
    expect(buildEligibilitySentence(verdict, ctx)).not.toMatch(/\$\s?[\d,]{4,}|\bTVL\b/i)
  })
})
