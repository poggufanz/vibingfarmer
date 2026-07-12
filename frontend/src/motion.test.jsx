// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCountUp } from './motion.js'

let frameId
let frames

const flushFrame = (now) => {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(now))
}

beforeEach(() => {
  vi.useFakeTimers()
  frameId = 0
  frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useCountUp', () => {
  it('retargets from the value currently on screen', () => {
    const { result, rerender } = renderHook(
      ({ target }) => useCountUp(target, { duration: 1000 }),
      { initialProps: { target: 100 } }
    )

    act(() => vi.runOnlyPendingTimers())
    act(() => flushFrame(1))
    act(() => flushFrame(101))
    expect(result.current).toBeCloseTo(50, 5)

    rerender({ target: 200 })
    act(() => vi.runOnlyPendingTimers())
    act(() => flushFrame(102))
    act(() => flushFrame(202))
    expect(result.current).toBeCloseTo(125, 5)
  })
})
