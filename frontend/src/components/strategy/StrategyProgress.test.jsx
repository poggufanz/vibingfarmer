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

// Fix loop 1 -- I9 regression helper. jsdom's getComputedStyle does not resolve `var()`, but it
// DOES correctly apply the real cascade (specificity/!important/source order) and echo back
// whichever declaration's raw text won -- verified against these exact two files. Enough to prove
// the current-step colour override is winning over Foundation's global disabled `!important` rule.
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

  // I9 (review finding): the current step is `disabled` by design (see `canNavigate` above), so
  // Foundation's global disabled `!important` rule (pocket-crew.css:348-353) defeated this file's
  // own locked current-step colour rule, measured identical to an unreached step in Chrome
  // (rgb(140,155,147) both). Injects the REAL shipped stylesheet and proves the current step's
  // colour declaration is genuinely distinct from a sibling's.
  it('I9: the current step colour rule wins over Foundation\'s disabled !important rule', () => {
    const styleEl = document.createElement('style')
    styleEl.textContent = REAL_STYLESHEET
    document.head.appendChild(styleEl)
    try {
      render(<StrategyProgress current="protect" reached={['plan', 'protect']} />)
      const current = screen.getByRole('button', { name: 'Protect' })
      const unreached = screen.getByRole('button', { name: 'Start' })
      const currentColor = getComputedStyle(current).color
      const unreachedColor = getComputedStyle(unreached).color
      // The fix's own override rule (a plain compound selector, no :where()) must be the one
      // winning for the current step -- that's the exact regression this guards.
      expect(currentColor).toBe('var(--pc-ink)')
      expect(currentColor).not.toBe(unreachedColor)
    } finally {
      styleEl.remove()
    }
  })
})
