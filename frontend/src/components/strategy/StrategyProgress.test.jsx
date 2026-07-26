// frontend/src/components/strategy/StrategyProgress.test.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). StrategyProgress is the three-step Plan /
// Protect / Start stepper (visual contract: .pc-strategy-stage-nav). It must render three
// LABELED steps (never bare dots), mark the current one with aria-current="step", only allow
// navigation to a step the caller has already marked reached/safe, and announce the current step
// to assistive tech via a polite live region.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { StrategyProgress } from './StrategyProgress.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

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
})
