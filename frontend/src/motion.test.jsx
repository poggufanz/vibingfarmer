// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCountUp } from './motion.js'

const here = path.dirname(fileURLToPath(import.meta.url))

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

// ---------------------------------------------------------------------------------------------
// My Money Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze), Step 3: "values never count,
// pulse, bounce, or loop". jsdom cannot measure a real animation (it reports `animationName:
// "none"` for the shorthand regardless of what's declared, and computes no geometry at all --
// this project's own recurring lesson, most recently Strategy Task 14's binding constraint 5), so
// what CAN be proven here, honestly, is absence by construction: none of the six My Money
// components (MyMoneyRoute.test.jsx's own rejection-checklist item 6 already source-scans these
// same seven files for a literal `style=`/`animation` substring -- this is a DIFFERENT, narrower
// scan for the one animation utility this codebase actually ships, `useCountUp`, which an
// `import { useCountUp } from '../../motion.js'` line would not trip: it contains neither
// substring) ever imports this module's own counting/staggered-reveal helpers, and none declares
// its own frame timer. The real-Chromium half of Step 3 (dialog/disclosure transitions instant
// under reduced motion, the agent-network graph actually halting when its disclosure closes) is
// covered in e2e/pocket-crew.visual.spec.js, which alone can measure it.
describe('My Money -- no component in this surface animates a value (Step 3)', () => {
  const MONEY_DIR = path.resolve(here, 'components/money')
  const FILES = [
    'MyMoneyRoute.jsx',
    'MoneyHero.jsx',
    'PositionList.jsx',
    'AgentTeam.jsx',
    'VaultProtection.jsx',
    'HowMoneyWorks.jsx',
    'TechnicalMoneyDetails.jsx',
  ]

  it('no file imports useCountUp/riseDelay from motion.js', () => {
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(MONEY_DIR, file), 'utf8')
      expect(source, `${file} must not import from motion.js`).not.toMatch(
        /from ['"].*\/motion\.js['"]/
      )
      expect(source, `${file} must not call useCountUp`).not.toMatch(/useCountUp/)
    }
  })

  it('no file declares its own frame/interval timer for a value', () => {
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(MONEY_DIR, file), 'utf8')
      expect(
        source,
        `${file} must not call setInterval/setTimeout/requestAnimationFrame`
      ).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/)
    }
  })

  // Positive control: a hand-written stand-in that DOES both of the things the two guards above
  // forbid -- proving the regex-based scan actually flags the shape it claims to catch, not merely
  // a selector that happens to match nothing in the current (compliant) files.
  it('control: a stand-in file that imports useCountUp and starts an interval fails both scans', () => {
    const offender = [
      "import { useCountUp } from '../../motion.js'",
      'function Bad() { setInterval(() => {}, 1000); return useCountUp(1) }',
    ].join('\n')
    expect(offender).toMatch(/from ['"].*\/motion\.js['"]/)
    expect(offender).toMatch(/useCountUp/)
    expect(offender).toMatch(/setInterval|setTimeout|requestAnimationFrame/)
  })
})
