import { describe, expect, it } from 'vitest'
import { buildEligibilityReview } from './eligibilityReview.js'
import { filterBasket } from './basketFilter.js'

describe('buildEligibilityReview', () => {
  const survivor = { vault: { protocol: 'Blend Capital v2', chain: 'stellar' } }
  // basketFilter.filterBasket wraps a dropped entry as `{agent, verdict}` -- the vault lives at
  // entry.agent.vault, NOT entry.vault (unlike survivors, which spread the agent record
  // directly). Verified against basketFilter.js and basketFilter.test.js (`dropped[0].agent.id`).
  const droppedEntry = {
    agent: { vault: { protocol: 'Aave v3 (proxy)', chain: 'base' } },
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

  // This is the test that catches what hand-built fixtures above cannot: it drives the adapter
  // with basketFilter.filterBasket's OWN real output (not a hand-shaped mimic), so a future shape
  // drift in basketFilter.js breaks this test automatically. filterBasket (not computeBasket) is
  // used deliberately -- computeBasket resolves live vault facts with a 30-day expiry window,
  // which would make this test's pass/fail depend on wall-clock fact freshness for no reason;
  // filterBasket is the pure boundary that actually shapes survivors/dropped and takes an explicit
  // verdictBySlug, exactly like basketFilter.test.js's own tests do.
  it('reads the real filterBasket/computeBasket output shape, where dropped nests under `.agent`', () => {
    const agents = [
      { id: 'w-ok', allocation: 50, vault: { protocol: 'aave-v3', chain: 'stellar', addr: 'C...' } },
      { id: 'w-bad', allocation: 50, vault: { protocol: 'hyperfarm', chain: 'base', addr: 'C...' } },
    ]
    const { survivors, dropped } = filterBasket(agents, {
      'aave-v3': { eligible: true },
      hyperfarm: { eligible: false, reasons: ['facts stale'] },
    })
    const candidates = buildEligibilityReview({ survivors, dropped })
    expect(candidates).toEqual([
      { protocol: 'aave-v3', chain: 'stellar', eligible: true, reasons: [] },
      { protocol: 'hyperfarm', chain: 'base', eligible: false, reasons: ['facts stale'] },
    ])
  })

  it('is defensive about missing fields', () => {
    const candidates = buildEligibilityReview({ survivors: [{}], dropped: [{}] })
    expect(candidates[0]).toEqual({
      protocol: 'Unknown venue',
      chain: 'stellar',
      eligible: true,
      reasons: [],
    })
    expect(candidates[1].eligible).toBe(false)
    expect(candidates[1].reasons).toEqual([])
  })

  it('handles empty input', () => {
    expect(buildEligibilityReview({})).toEqual([])
  })
})
