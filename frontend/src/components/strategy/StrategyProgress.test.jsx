// frontend/src/components/strategy/StrategyProgress.test.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). StrategyProgress is the three-step Plan /
// Protect / Start stepper (visual contract: .pc-strategy-stage-nav). It must render three
// LABELED steps (never bare dots), mark the current one with aria-current="step", only allow
// navigation to a step the caller has already marked reached/safe, and announce the current step
// to assistive tech via a polite live region.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { StrategyProgress } from './StrategyProgress.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

// I9 regression source, used by the test below. jsdom's cascade does not reliably reproduce a
// real browser's handling of `:where()` + `!important` (see that test's comment for the
// mechanism), so this is read as raw text and asserted on structurally rather than rendered and
// read back via getComputedStyle.
const here = path.dirname(fileURLToPath(import.meta.url))
const REAL_STYLESHEET = [
  fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8'),
  fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8'),
].join('\n')

describe('StrategyProgress', () => {
  it('renders all three steps as visibly labeled text, never bare dots', () => {
    render(<StrategyProgress current="plan" reached={['plan']} />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('Protect')).toBeTruthy()
    expect(screen.getByText('Start')).toBeTruthy()
  })

  it('marks exactly the current step with aria-current="step"', () => {
    render(<StrategyProgress current="protect" reached={['plan', 'protect']} />)
    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current'))
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toContain('Protect')
    expect(current[0].getAttribute('aria-current')).toBe('step')
  })

  it('announces the current step politely for assistive tech', () => {
    render(<StrategyProgress current="protect" reached={['plan', 'protect']} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Step 2 of 3: Protect')
  })

  it('lets the caller navigate to an already-reached, non-current step', () => {
    const onNavigate = vi.fn()
    render(<StrategyProgress current="protect" reached={['plan', 'protect']} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(onNavigate).toHaveBeenCalledWith('plan')
  })

  it('never lets the caller jump ahead to an unreached step', () => {
    const onNavigate = vi.fn()
    render(<StrategyProgress current="plan" reached={['plan']} onNavigate={onNavigate} />)
    const startButton = screen.getByRole('button', { name: 'Start' })
    expect(startButton.disabled).toBe(true)
    fireEvent.click(startButton)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does not treat the current step itself as a navigation target', () => {
    const onNavigate = vi.fn()
    render(<StrategyProgress current="plan" reached={['plan']} onNavigate={onNavigate} />)
    const planButton = screen.getByRole('button', { name: 'Plan' })
    expect(planButton.disabled).toBe(true)
    fireEvent.click(planButton)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('defaults reached to just the current step when omitted', () => {
    render(<StrategyProgress current="plan" />)
    expect(screen.getByRole('button', { name: 'Protect' }).disabled).toBe(true)
  })

  it('has zero axe violations', async () => {
    const { container } = render(
      <StrategyProgress current="plan" reached={['plan']} onNavigate={() => {}} />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  // N3 (re-review finding, fix loop 2): the old test rendered the REAL_STYLESHEET into jsdom and
  // read `getComputedStyle(...).color` -- but jsdom already reported the current step as
  // `var(--pc-ink)` even with the override deleted (i.e. against the pre-fix, buggy code), because
  // jsdom's cascade does not reproduce the real-engine behaviour where Foundation's
  // `:where(button, input, select, textarea):disabled { ... !important }` rule (pocket-crew.css)
  // beats this file's plain, un-`:where()`-wrapped current-step colour rule. So the old test could
  // never fail. This instead verifies the actual CSS-cascade fact structurally, by reading the
  // shipped source text (the same mechanism PlanStage.test.jsx's I6 guard uses, for the identical
  // jsdom/:where() tradeoff recorded in Foundation Task 2): our override selector must (a) exist,
  // (b) be `!important` -- required because Foundation's conflicting rule is also `!important`,
  // and among `!important` declarations specificity decides -- and (c) NOT be specificity-zeroed
  // by `:where()`, while Foundation's conflicting disabled rule for plain buttons IS entirely
  // `:where()`-wrapped (0 specificity). A plain compound selector with real specificity beats a
  // `:where()`-wrapped one of equal importance, exactly as measured in Chrome (forest: current
  // rgb(242,245,239) vs sibling rgb(140,155,147); day-field: rgb(23,37,31) vs rgb(95,108,101)).
  // Falsifiable: deleting the override rule from strategy.css fails this (see the fix report).
  // N3 (re-review finding, fix loop 3): the selector regex hardcoded single quotes
  // (`[aria-current='step']`), so a behaviour-identical quote-style refactor (a formatter
  // switching to double quotes) turned this red with no actual regression -- mutation-verified.
  // `['"]` accepts either quote character the shipped rule (or a formatter) might use, so the
  // guard tracks the real CSS fact (selector exists, is `!important`, isn't `:where()`-zeroed)
  // instead of one exact byte sequence.
  it("I9: the current-step override genuinely outranks Foundation's disabled rule (source-level, not jsdom's unreliable :where() cascade)", () => {
    const overrideMatch = REAL_STYLESHEET.match(
      /\.pc-strategy-stage-nav\s*>\s*\[aria-current=['"]step['"]\]:disabled\s*\{([^}]*)\}/
    )
    expect(overrideMatch).toBeTruthy()
    expect(overrideMatch[1]).toMatch(/color:\s*var\(--pc-ink\)\s*!important/)

    // Confirms the fact the override's specificity edge depends on: Foundation's conflicting
    // plain-button disabled rule really is entirely wrapped in :where() (0 specificity), so this
    // file's un-wrapped compound selector (class + attribute + pseudo-class, all real
    // specificity) outranks it among two `!important` declarations.
    expect(REAL_STYLESHEET).toMatch(/:where\(button,\s*input,\s*select,\s*textarea\):disabled/)
  })
})
