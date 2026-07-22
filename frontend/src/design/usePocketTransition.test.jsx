// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import gsap from 'gsap'
import { usePocketTransition } from './usePocketTransition.js'

afterEach(cleanup)

function Harness({ stateKey, error, children }) {
  const ref = useRef(null)
  usePocketTransition(ref, stateKey, { error })
  return <div ref={ref}>{children}</div>
}

function setReducedMotion(matches) {
  window.matchMedia = (query) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
}

describe('usePocketTransition', () => {
  beforeEach(() => {
    setReducedMotion(false)
  })

  it('animates only elements carrying data-pocket-enter inside the scope', () => {
    const fromSpy = vi.spyOn(gsap, 'from')
    render(
      <Harness stateKey="a">
        <div data-pocket-enter data-testid="in-scope" />
        <div data-testid="no-attr" />
      </Harness>
    )
    expect(fromSpy).toHaveBeenCalledTimes(1)
    const [targets] = fromSpy.mock.calls[0]
    const targetArray = Array.isArray(targets) ? targets : [targets]
    expect(targetArray).toHaveLength(1)
    expect(targetArray[0].hasAttribute('data-pocket-enter')).toBe(true)
    fromSpy.mockRestore()
  })

  it('ignores a data-pocket-enter element that lives outside the scope element', () => {
    const outside = document.createElement('div')
    outside.setAttribute('data-pocket-enter', '')
    document.body.appendChild(outside)
    const fromSpy = vi.spyOn(gsap, 'from')
    render(
      <Harness stateKey="a">
        <div data-pocket-enter data-testid="in-scope" />
      </Harness>
    )
    const [targets] = fromSpy.mock.calls[0]
    const targetArray = Array.isArray(targets) ? targets : [targets]
    expect(targetArray.every((el) => el !== outside)).toBe(true)
    fromSpy.mockRestore()
    document.body.removeChild(outside)
  })

  it('only animates opacity, x, y, and scale', () => {
    // gsap.from() mutates the live vars object it's given (internal bookkeeping keys like
    // `parent` get attached after the tween runs), so snapshot the keys MY code actually passed
    // at call time rather than reading the object after GSAP has touched it.
    const originalFrom = gsap.from.bind(gsap)
    let snapshot
    const fromSpy = vi.spyOn(gsap, 'from').mockImplementation((targets, vars, position) => {
      snapshot = { ...vars }
      return originalFrom(targets, vars, position)
    })
    render(
      <Harness stateKey="a">
        <div data-pocket-enter />
      </Harness>
    )
    const nonMotionKeys = new Set([
      'duration',
      'ease',
      'stagger',
      'delay',
      'onComplete',
      'onStart',
      'onUpdate',
      'overwrite',
    ])
    const animatableKeys = Object.keys(snapshot).filter((k) => !nonMotionKeys.has(k))
    expect(animatableKeys.length).toBeGreaterThan(0)
    for (const key of animatableKeys) {
      expect(['opacity', 'x', 'y', 'scale']).toContain(key)
    }
    fromSpy.mockRestore()
  })

  it('normal motion uses the 0.32s / power3.out / y:8 / 0.04s-stagger defaults', () => {
    const fromSpy = vi.spyOn(gsap, 'from')
    render(
      <Harness stateKey="a">
        <div data-pocket-enter />
      </Harness>
    )
    const [, vars] = fromSpy.mock.calls[0]
    expect(vars.duration).toBe(0.32)
    expect(vars.ease).toBe('power3.out')
    expect(vars.y).toBe(8)
    expect(vars.opacity).toBe(0)
    expect(vars.stagger).toBeLessThanOrEqual(0.04)
    fromSpy.mockRestore()
  })

  it('reduced motion uses gsap.set for the final state and never a tween or timeline', () => {
    setReducedMotion(true)
    const setSpy = vi.spyOn(gsap, 'set')
    const toSpy = vi.spyOn(gsap, 'to')
    const fromSpy = vi.spyOn(gsap, 'from')
    const timelineSpy = vi.spyOn(gsap, 'timeline')
    render(
      <Harness stateKey="a">
        <div data-pocket-enter />
      </Harness>
    )
    expect(setSpy).toHaveBeenCalled()
    expect(toSpy).not.toHaveBeenCalled()
    expect(fromSpy).not.toHaveBeenCalled()
    expect(timelineSpy).not.toHaveBeenCalled()
    const [, vars] = setSpy.mock.calls[0]
    expect(vars.opacity).toBe(1)
    setSpy.mockRestore()
    toSpy.mockRestore()
    fromSpy.mockRestore()
    timelineSpy.mockRestore()
  })

  it('a state-key change re-triggers the transition', () => {
    const fromSpy = vi.spyOn(gsap, 'from')
    const { rerender } = render(
      <Harness stateKey="a">
        <div data-pocket-enter />
      </Harness>
    )
    expect(fromSpy).toHaveBeenCalledTimes(1)
    rerender(
      <Harness stateKey="b">
        <div data-pocket-enter />
      </Harness>
    )
    expect(fromSpy).toHaveBeenCalledTimes(2)
    fromSpy.mockRestore()
  })

  it('the same state-key on rerender does not re-fire the transition', () => {
    const fromSpy = vi.spyOn(gsap, 'from')
    const { rerender } = render(
      <Harness stateKey="a">
        <div data-pocket-enter />
      </Harness>
    )
    expect(fromSpy).toHaveBeenCalledTimes(1)
    rerender(
      <Harness stateKey="a">
        <div data-pocket-enter>updated</div>
      </Harness>
    )
    expect(fromSpy).toHaveBeenCalledTimes(1)
    fromSpy.mockRestore()
  })

  it('the error option uses a single small (2px) x-shift, never a repeating shake', () => {
    const toSpy = vi.spyOn(gsap, 'to')
    render(
      <Harness stateKey="a" error>
        <div data-pocket-enter />
      </Harness>
    )
    expect(toSpy).toHaveBeenCalledTimes(1)
    const [, vars] = toSpy.mock.calls[0]
    expect(vars.x).toBe(2)
    expect(vars.repeat).not.toBe(-1)
    toSpy.mockRestore()
  })

  it('cleans up via gsap.context().revert() on unmount (the useGSAP contract)', () => {
    const contextSpy = vi.spyOn(gsap, 'context')
    const { unmount } = render(
      <Harness stateKey="a">
        <div data-pocket-enter />
      </Harness>
    )
    expect(contextSpy).toHaveBeenCalled()
    const ctx = contextSpy.mock.results[0].value
    const revertSpy = vi.spyOn(ctx, 'revert')
    unmount()
    expect(revertSpy).toHaveBeenCalled()
    contextSpy.mockRestore()
  })

  it('the implementation never uses a setInterval loop, ScrollTrigger, or an infinite repeat', () => {
    const src = readFileSync(resolve(import.meta.dirname, './usePocketTransition.js'), 'utf8')
    expect(src).not.toMatch(/setInterval/)
    expect(src).not.toMatch(/ScrollTrigger/)
    expect(src).not.toMatch(/repeat:\s*-1/)
  })
})
