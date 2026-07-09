// @vitest-environment jsdom
// frontend/src/dev/devDispatch.test.js
import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  buildScenarioCall,
  dispatchRawCall,
  registerDevDispatch,
} from './devDispatch.js'
import { YIELD_ROUTER_ADDRESS } from '../base/config.js'

afterEach(() => {
  delete window.__vfDevMandateFixture
  delete window.__vfDevDispatchRawCall
})

describe('registerDevDispatch', () => {
  test('registers window.__vfDevDispatchRawCall (also happens on module import in DEV)', () => {
    expect(window.__vfDevDispatchRawCall).toBeTruthy() // side effect ran on import above
    delete window.__vfDevDispatchRawCall
    registerDevDispatch(window)
    expect(window.__vfDevDispatchRawCall).toBe(dispatchRawCall)
  })
})

describe('buildScenarioCall', () => {
  const pool = '0x1111111111111111111111111111111111111112'

  test('sweep: wrong selector (withdraw) on the real router', () => {
    const { to } = buildScenarioCall('sweep', pool)
    expect(to.toLowerCase()).toBe(YIELD_ROUTER_ADDRESS.toLowerCase())
  })

  test('wrong-target: right selector, deliberately not the router address', () => {
    const { to } = buildScenarioCall('wrong-target', pool)
    expect(to.toLowerCase()).not.toBe(YIELD_ROUTER_ADDRESS.toLowerCase())
  })

  test('over-cap: right target, amount far beyond any realistic cap', () => {
    const { to, data } = buildScenarioCall('over-cap', pool)
    expect(to.toLowerCase()).toBe(YIELD_ROUTER_ADDRESS.toLowerCase())
    expect(data.length).toBeGreaterThan(10) // encoded calldata produced
  })

  test('expired: an otherwise-valid deposit call on the real router', () => {
    const { to } = buildScenarioCall('expired', pool)
    expect(to.toLowerCase()).toBe(YIELD_ROUTER_ADDRESS.toLowerCase())
  })

  test('unknown scenario throws', () => {
    expect(() => buildScenarioCall('not-a-scenario', pool)).toThrow(/unknown scenario/)
  })
})

describe('dispatchRawCall', () => {
  const fakeKernelClient = {
    account: { encodeCalls: vi.fn(async () => '0xCALLDATA') },
    sendUserOperation: vi.fn(async () => '0xUSEROPHASH'),
  }

  test('returns {executed:false} with a clear error when session material is missing', async () => {
    const result = await dispatchRawCall({ scenario: 'sweep' })
    expect(result.executed).toBe(false)
    expect(result.error).toMatch(/missing session material/)
  })

  test('reads session material from window.__vfDevMandateFixture when not passed directly', async () => {
    window.__vfDevMandateFixture = {
      publicClient: {},
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xKEY',
      pool: '0x1111111111111111111111111111111111111112',
    }
    const reconstruct = vi.fn(async () => fakeKernelClient)
    const result = await dispatchRawCall({ scenario: 'sweep', deps: { reconstruct } })
    expect(result.executed).toBe(true)
    expect(reconstruct).toHaveBeenCalledWith({
      publicClient: {},
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xKEY',
    })
  })

  test('expired scenario prefers fixture.expired override material', async () => {
    window.__vfDevMandateFixture = {
      publicClient: {},
      serializedApproval: 'live-approval',
      sessionPrivateKey: '0xLIVE',
      expired: { serializedApproval: 'expired-approval', sessionPrivateKey: '0xEXPIRED' },
    }
    const reconstruct = vi.fn(async () => fakeKernelClient)
    await dispatchRawCall({ scenario: 'expired', deps: { reconstruct } })
    expect(reconstruct).toHaveBeenCalledWith(
      expect.objectContaining({ serializedApproval: 'expired-approval', sessionPrivateKey: '0xEXPIRED' })
    )
  })

  test('{executed:true} + userOpHash when the policy allows the call through (happy path)', async () => {
    const result = await dispatchRawCall({
      scenario: 'sweep',
      publicClient: {},
      serializedApproval: 'a',
      sessionPrivateKey: '0xk',
      deps: { reconstruct: vi.fn(async () => fakeKernelClient) },
    })
    expect(result).toEqual({ executed: true, userOpHash: '0xUSEROPHASH' })
  })

  test('{executed:false} when the policy rejects the call (reconstructSessionClient throws)', async () => {
    const reconstruct = vi.fn(async () => {
      throw new Error('AA23 reverted: policy rejected')
    })
    const result = await dispatchRawCall({
      scenario: 'over-cap',
      publicClient: {},
      serializedApproval: 'a',
      sessionPrivateKey: '0xk',
      deps: { reconstruct },
    })
    expect(result.executed).toBe(false)
    expect(result.error).toMatch(/policy rejected/)
  })

  test('{executed:false} when sendUserOperation itself throws (bundler-side rejection)', async () => {
    const rejectingClient = {
      account: { encodeCalls: vi.fn(async () => '0xCALLDATA') },
      sendUserOperation: vi.fn(async () => {
        throw new Error('bundler rejected simulation')
      }),
    }
    const result = await dispatchRawCall({
      scenario: 'wrong-target',
      publicClient: {},
      serializedApproval: 'a',
      sessionPrivateKey: '0xk',
      deps: { reconstruct: vi.fn(async () => rejectingClient) },
    })
    expect(result.executed).toBe(false)
    expect(result.error).toMatch(/bundler rejected/)
  })
})
