import { describe, expect, it } from 'vitest'
import { buildEligibilityReview } from './eligibilityReview.js'

describe('buildEligibilityReview', () => {
  const survivor = { vault: { protocol: 'Blend Capital v2', chain: 'stellar' } }
  const droppedEntry = {
    vault: { protocol: 'Aave v3 (proxy)', chain: 'base' },
    verdict: { eligible: false, reasons: ['facts stale', 'no oracle circuit breaker'] },
  }

  it('maps survivors to eligible rows and dropped to rejected rows with reasons', () => {
    const candidates = buildEligibilityReview({ survivors: [survivor], dropped: [droppedEntry] })
    expect(candidates).toEqual([
      { protocol: 'Blend Capital v2', chain: 'stellar', eligible: true, reasons: [] },
      {
        protocol: 'Aave v3 (proxy)',
        chain: 'base',
        eligible: false,
        reasons: ['facts stale', 'no oracle circuit breaker'],
      },
    ])
  })

  it('is defensive about missing fields', () => {
    const candidates = buildEligibilityReview({ survivors: [{}], dropped: [{}] })
    expect(candidates[0]).toEqual({ protocol: 'Unknown venue', chain: 'stellar', eligible: true, reasons: [] })
    expect(candidates[1].eligible).toBe(false)
    expect(candidates[1].reasons).toEqual([])
  })

  it('handles empty input', () => {
    expect(buildEligibilityReview({})).toEqual([])
  })
})
