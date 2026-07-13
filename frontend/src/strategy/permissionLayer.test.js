// frontend/src/strategy/permissionLayer.test.js
import { describe, test, expect, vi } from 'vitest'
import { buildPermission, confirmPermission } from './permissionLayer.js'

const converged = (recommend, outcome = 'converge') => ({
  outcome,
  proposal: { recommend, payload: { kind: 'rebalance', to: 'B' } },
  citedRules: ['CVAR_TAIL_FLOOR'],
})
const METRICS = { cvar95: -2.4, worst: -4.3, mean: 0.6 }

describe('buildPermission', () => {
  test('falls back to a deterministic template when no LLM is provided', async () => {
    // Arrange / Act
    const p = await buildPermission(converged('proceed'), {
      metrics: METRICS,
      riskTier: 'moderate',
    })
    // Assert
    expect(p.recommend).toBe('proceed')
    expect(p.sentence).toContain('2.4%') // loss-framed CVaR surfaced honestly
    expect(p.payload).toEqual({ kind: 'rebalance', to: 'B' })
  })

  test('uses the LLM sentence when present, but template if it throws', async () => {
    // Arrange
    const good = vi.fn().mockResolvedValue('Risk is up, but mostly from gas - proceed?')
    const bad = vi.fn().mockRejectedValue(new Error('LLM down'))
    // Act
    const a = await buildPermission(converged('proceed'), {
      metrics: METRICS,
      riskTier: 'moderate',
      summarize: good,
    })
    const b = await buildPermission(converged('proceed'), {
      metrics: METRICS,
      riskTier: 'moderate',
      summarize: bad,
    })
    // Assert
    expect(a.sentence).toBe('Risk is up, but mostly from gas - proceed?')
    expect(b.sentence).toContain('2.4%') // template fallback, never throws
  })

  test('no-consensus recommends hold', async () => {
    // Arrange / Act
    const p = await buildPermission(
      { outcome: 'no-consensus', proposal: { recommend: 'hold' }, citedRules: [] },
      { metrics: METRICS, riskTier: 'moderate' }
    )
    // Assert
    expect(p.recommend).toBe('hold')
  })
})

describe('confirmPermission (WAJIB BERHENTI)', () => {
  test('executes only on an explicit true', async () => {
    // Arrange
    const execute = vi.fn().mockResolvedValue('tx')
    const permission = { outcome: 'converge', recommend: 'proceed', payload: { kind: 'rebalance' } }
    // Act
    const yes = await confirmPermission(permission, true, { execute })
    // Assert
    expect(yes.executed).toBe(true)
    expect(execute).toHaveBeenCalledWith({ kind: 'rebalance' })
  })

  test('never auto-proceeds without a true (No, undefined, truthy non-true)', async () => {
    // Arrange
    const execute = vi.fn()
    const onReject = vi.fn()
    const permission = { outcome: 'converge', recommend: 'proceed', payload: {} }
    // Act
    const no = await confirmPermission(permission, false, { execute, onReject })
    const blank = await confirmPermission(permission, undefined, { execute, onReject })
    const sneaky = await confirmPermission(permission, 'yes', { execute, onReject })
    // Assert
    expect(no.executed).toBe(false)
    expect(blank.executed).toBe(false)
    expect(sneaky.executed).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledTimes(3)
  })

  test('a fatal result never executes even on an explicit Yes', async () => {
    // Arrange
    const execute = vi.fn()
    const permission = { outcome: 'fatal', recommend: 'hold', payload: {} }
    // Act
    const r = await confirmPermission(permission, true, { execute })
    // Assert
    expect(r.executed).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  test('fail-closed: no-consensus, unknown outcome, and a converged hold never execute on Yes', async () => {
    // Arrange — only converge+proceed is executable; everything else stays shut.
    const execute = vi.fn()
    const onReject = vi.fn()
    const blocked = [
      { outcome: 'no-consensus', recommend: 'hold', payload: {} },
      { outcome: 'unknown', recommend: 'proceed', payload: {} },
      { outcome: 'converge', recommend: 'hold', payload: {} },
    ]
    // Act
    const results = []
    for (const permission of blocked) {
      results.push(await confirmPermission(permission, true, { execute, onReject }))
    }
    // Assert
    expect(results.every((r) => r.executed === false)).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledTimes(3)
  })
})
