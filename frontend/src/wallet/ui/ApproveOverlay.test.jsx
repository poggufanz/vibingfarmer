// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ApproveOverlay } from './ApproveOverlay.jsx'

afterEach(cleanup)

describe('Approve overlay (verdict-first)', () => {
  it('shows the F8 verdict above the amount and disables approve when ineligible', () => {
    render(
      <ApproveOverlay
        verdict={{ allow: false, reasons: ['ponzi ratio below 1.5'] }}
        simulate={{ sharesOut: '0' }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    )
    const verdict = screen.getByTestId('verdict')
    const amount = screen.getByTestId('amount')
    // verdict appears before amount in the DOM (verdict-first):
    expect(verdict.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Deviation from brief: use .disabled instead of .toBeDisabled() (no jest-dom setup)
    const btn = screen.getByRole('button', { name: /face id/i })
    expect(btn.disabled).toBe(true)
  })

  it('explains that approving can start a transaction that may move funds', () => {
    render(
      <ApproveOverlay
        verdict={{ allow: true, reasons: [] }}
        simulate={{ sharesOut: { token: 'USDC', units: '10000000', decimals: 7 } }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toMatch(/approve transaction/i)
    expect(screen.getByTestId('verdict').getAttribute('data-eligible')).toBe('true')
    expect(screen.getByText(/can start a transaction ceremony/i)).toBeTruthy()
    expect(screen.getByText(/may move funds/i)).toBeTruthy()
    expect(screen.queryByText(/does not move funds/i)).toBeNull()
    expect(screen.getByTestId('amount').textContent).toMatch(/1(?:\.0+)?\s*USDC/i)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
    expect(screen.queryByText(/acid|lava|confirm deposit/i)).toBeNull()
  })

  it('fails closed for an unknown verdict while retaining equal Cancel/Approve actions', () => {
    render(<ApproveOverlay verdict={null} onApprove={vi.fn()} onReject={vi.fn()} />)
    expect(screen.getByTestId('verdict').textContent).toBe('Unavailable')
    expect(screen.getByRole('button', { name: /approve with face id/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
    expect(screen.getByText(/transaction consequence is unavailable/i)).toBeTruthy()
    expect(screen.queryByText(/does not move funds/i)).toBeNull()
  })
})
