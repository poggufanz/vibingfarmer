import { describe, expect, it } from 'vitest'
import { selectCrewDecisions } from './selectCrewDecisions.js'

// Matches the real addLog shape (app.jsx:951-955): { id, time, ...entry } where entry
// carries at least { event, meta }. id is a composite string in the real app
// (`${logIdRef.current}-${Date.now()}`) but the selector only ever passes it through.
const L = (id, event, meta) => ({ id, time: `t${id}`, event, meta })

describe('selectCrewDecisions', () => {
  it('keeps only known decision events, newest first, with the right tone/title/detail', () => {
    const logs = [
      L(1, 'SomethingIrrelevant', 'x'),
      L(2, 'VaultRejected', 'facts stale'),
      L(3, 'OrchestratorPlanned', 'Proposal: hold'),
    ]
    const out = selectCrewDecisions(logs)
    expect(out.map((d) => d.id)).toEqual([3, 2])
    expect(out[0]).toMatchObject({
      tone: 'kept',
      title: 'Council proposal',
      detail: 'Proposal: hold',
      time: 't3',
    })
    expect(out[1]).toMatchObject({
      tone: 'rejected',
      title: 'Rejected a candidate pool',
      detail: 'facts stale',
      time: 't2',
    })
  })

  it('maps the keeper decision events (compound completed / rebalance created) to their own tones', () => {
    const logs = [L(1, 'AgentCompleted', 'compounded'), L(2, 'RedelegationCreated', 'rebalanced')]
    const out = selectCrewDecisions(logs)
    expect(out.find((d) => d.id === 1)).toMatchObject({ tone: 'kept', detail: 'compounded' })
    expect(out.find((d) => d.id === 2)).toMatchObject({ tone: 'watch', detail: 'rebalanced' })
  })

  it('returns every decision entry, newest first, when there are fewer than the default limit of 8', () => {
    const logs = Array.from({ length: 12 }, (_, i) =>
      L(i, i % 2 === 0 ? 'OrchestratorPlanned' : 'SomethingIrrelevant', `p${i}`)
    )
    // decision events land on the even ids: 0,2,4,6,8,10 -- 6 total, under the limit
    const out = selectCrewDecisions(logs)
    expect(out.map((d) => d.id)).toEqual([10, 8, 6, 4, 2, 0])
  })

  it('caps at a custom limit, keeping the newest ones in newest-first order', () => {
    const logs = Array.from({ length: 20 }, (_, i) => L(i, 'OrchestratorPlanned', `p${i}`))
    const out = selectCrewDecisions(logs, { limit: 5 })
    expect(out.map((d) => d.id)).toEqual([19, 18, 17, 16, 15])
  })

  it('returns [] for absent, empty, or all-unknown-event logs', () => {
    expect(selectCrewDecisions()).toEqual([])
    expect(selectCrewDecisions([])).toEqual([])
    expect(selectCrewDecisions([L(1, 'SomethingIrrelevant', 'x')])).toEqual([])
  })
})
