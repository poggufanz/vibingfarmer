import { describe, expect, it } from 'vitest'
import { hashStrategy } from '../attestation.js'
import { bindPlanToPermissionWindow } from './permissionWindow.js'

function makePlan({ expiries = [101, 202] } = {}) {
  return {
    runId: 'run-1',
    planFingerprint: '0xoriginal',
    agents: expiries.map((expiry, index) => ({
      allocationId: `run-1:deposit:${index}`,
      kind: 'deposit',
      expiry,
    })),
  }
}

describe('bindPlanToPermissionWindow', () => {
  it('binds every agent and the fingerprint to the same selected lifetime', () => {
    const original = makePlan({ expiries: [101, 202] })
    const rebound = bindPlanToPermissionWindow(original, {
      checkedAt: 1_800_000_000,
      durationSeconds: 86_400,
    })

    expect(rebound.agents.map((agent) => agent.expiry)).toEqual([1_800_086_400, 1_800_086_400])
    expect(rebound.planFingerprint).toBe(hashStrategy(rebound))
    expect(original.agents.map((agent) => agent.expiry)).toEqual([101, 202])
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid duration %s', (durationSeconds) => {
    expect(() =>
      bindPlanToPermissionWindow(makePlan(), {
        checkedAt: 1_800_000_000,
        durationSeconds,
      })
    ).toThrow('durationSeconds must be a positive integer')
  })
})
