import { describe, it, expect } from 'vitest'
import { applyRefresh } from './vaultFacts.js'

const NOW = 2_000_000_000_000
const entry = {
  facts: {
    tvl: { value: 100, source: 'snapshot', asOf: 1 },
    audit: { value: 'audited', source: 'snapshot', asOf: 1 },
  },
}

describe('provenance integrity', () => {
  it('a successful field refresh becomes source live with new asOf', () => {
    const r = applyRefresh(entry, { tvl: 250 }, NOW)
    expect(r.facts.tvl).toEqual({ value: 250, source: 'live', asOf: NOW })
  })
  it('an un-refreshed field keeps snapshot source + original asOf', () => {
    const r = applyRefresh(entry, { tvl: 250 }, NOW)
    expect(r.facts.audit).toEqual({ value: 'audited', source: 'snapshot', asOf: 1 })
  })
  it('a failed refresh (undefined value) keeps snapshot, never relabels live', () => {
    const r = applyRefresh(entry, { tvl: undefined }, NOW)
    expect(r.facts.tvl).toEqual({ value: 100, source: 'snapshot', asOf: 1 })
  })
})
