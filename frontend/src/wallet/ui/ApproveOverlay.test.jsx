// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApproveOverlay } from './ApproveOverlay.jsx'

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
})
