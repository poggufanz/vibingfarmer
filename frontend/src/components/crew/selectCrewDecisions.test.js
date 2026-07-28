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

  // --- Fix round 1 -----------------------------------------------------------------------

  it('F1: an emergency de-risk falls through to OrchestratorPlanned but must not render kept', () => {
    // Real shape: app.jsx:1150 forwards derisk/resume/mandate/upgrade_* into handleAgentEvent
    // as `kind: vault_${ev.type}`; the alert-kind block's event-name ternary (app.jsx:1327-1334)
    // has no vault_* case, so it falls to the default 'OrchestratorPlanned', with
    // meta: `${ev.kind.replace(/_/g, ' ')}, ${vaultName}, tx ${short}` (app.jsx:1335).
    const logs = [L(1, 'OrchestratorPlanned', 'vault derisk, Autofarm vault, tx GDXYZ')]
    const out = selectCrewDecisions(logs)
    expect(out).toHaveLength(1)
    expect(out[0].tone).not.toBe('kept')
    expect(out[0]).toMatchObject({ tone: 'watch', title: 'Crew update' })
  })

  it('F1 regression guard: a genuine council-keep verdict still renders kept', () => {
    // app.jsx:1979-1982 -- this exact meta shape is only logged as OrchestratorPlanned when
    // result.verdict === 'keep'.
    const logs = [
      L(1, 'OrchestratorPlanned', 'Monitor full debate, keep, 3 iters, converged: true'),
    ]
    expect(selectCrewDecisions(logs)[0]).toMatchObject({ tone: 'kept', title: 'Council proposal' })
  })

  it('F2: genuine council rejections (debate reject / failed re-eval) appear, tone rejected', () => {
    const logs = [
      L(1, 'AgentFailed', 'Monitor full debate, reject, 3 iters, converged: false'),
      L(2, 'AgentFailed', 'Monitor re-eval, drawdown rule violated'),
    ]
    const out = selectCrewDecisions(logs)
    expect(out.map((d) => d.id).sort()).toEqual([1, 2])
    expect(out.every((d) => d.tone === 'rejected')).toBe(true)
  })

  it('F2 regression guard: plain infra AgentFailed noise stays excluded', () => {
    const logs = [L(1, 'AgentFailed', 'Connection failed: timeout')]
    expect(selectCrewDecisions(logs)).toEqual([])
  })

  it('M3: the default limit is exactly 8', () => {
    const logs = Array.from({ length: 12 }, (_, i) => L(i, 'VaultRejected', `r${i}`))
    const out = selectCrewDecisions(logs)
    expect(out).toHaveLength(8)
    expect(out.map((d) => d.id)).toEqual([11, 10, 9, 8, 7, 6, 5, 4])
  })

  it('M4: missing meta/time degrade to empty strings, not the word "undefined"', () => {
    const out = selectCrewDecisions([{ id: 9, event: 'VaultRejected' }])
    expect(out[0]).toMatchObject({ id: 9, detail: '', time: '' })
  })

  it('M4: a null/undefined hole in the log array is skipped, not thrown on', () => {
    const logs = [null, undefined, L(1, 'VaultRejected', 'x')]
    expect(selectCrewDecisions(logs).map((d) => d.id)).toEqual([1])
  })

  it('M5: prototype properties are not mistaken for mapped events', () => {
    const logs = [L(1, 'constructor', 'x'), L(2, 'toString', 'y'), L(3, 'VaultRejected', 'z')]
    expect(selectCrewDecisions(logs).map((d) => d.id)).toEqual([3])
  })

  it('M6: a non-array logs value returns [] instead of throwing', () => {
    expect(() => selectCrewDecisions({})).not.toThrow()
    expect(selectCrewDecisions({})).toEqual([])
    expect(selectCrewDecisions('oops')).toEqual([])
  })

  it('M7: prefers the human-readable detail field over the terse meta when both exist', () => {
    const logs = [
      {
        id: 1,
        time: 't1',
        event: 'AgentCompleted',
        meta: 'compound executed, Autofarm vault, tx GDXYZ',
        detail: 'Keeper compounded Autofarm vault, +12.34 USDC, price/share 1.0521.',
      },
    ]
    expect(selectCrewDecisions(logs)[0].detail).toBe(
      'Keeper compounded Autofarm vault, +12.34 USDC, price/share 1.0521.'
    )
  })
})
