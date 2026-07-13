// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import GrantPanel, { DURATION_PRESETS } from './GrantPanel.jsx'

afterEach(cleanup)

describe('GrantPanel', () => {
  it('renders the budget default and the three duration presets, 24h active by default', () => {
    render(<GrantPanel defaultBudget={100} agentCount={3} onGrant={() => {}} onRevoke={() => {}} />)
    expect(screen.getByLabelText(/grant budget/i).value).toBe('100')
    DURATION_PRESETS.forEach((d) =>
      expect(screen.getByRole('button', { name: d.label })).toBeTruthy()
    )
    expect(screen.getByRole('button', { name: '24 hours' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('emits budget + selected duration seconds on Grant & run', () => {
    const onGrant = vi.fn()
    render(<GrantPanel defaultBudget={100} agentCount={3} onGrant={onGrant} onRevoke={() => {}} />)
    fireEvent.change(screen.getByLabelText(/grant budget/i), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    fireEvent.click(screen.getByRole('button', { name: /grant & run/i }))
    expect(onGrant).toHaveBeenCalledTimes(1)
    expect(onGrant).toHaveBeenCalledWith({ budget: 250, durationSeconds: 604800, durationId: '7d' })
  })

  it('blocks the grant on a non-positive budget', () => {
    const onGrant = vi.fn()
    render(<GrantPanel defaultBudget={100} onGrant={onGrant} onRevoke={() => {}} />)
    fireEvent.change(screen.getByLabelText(/grant budget/i), { target: { value: '0' } })
    const btn = screen.getByRole('button', { name: /grant & run/i })
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onGrant).not.toHaveBeenCalled()
  })

  it('fires onRevoke from the revoke control', () => {
    const onRevoke = vi.fn()
    render(<GrantPanel defaultBudget={100} onGrant={() => {}} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke grant/i }))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('shows the awaiting-wallet label and disables inputs while granting', () => {
    render(
      <GrantPanel defaultBudget={100} phase="granting" onGrant={() => {}} onRevoke={() => {}} />
    )
    expect(screen.getByRole('button', { name: /awaiting wallet/i }).disabled).toBe(true)
    expect(screen.getByLabelText(/grant budget/i).disabled).toBe(true)
  })
})
