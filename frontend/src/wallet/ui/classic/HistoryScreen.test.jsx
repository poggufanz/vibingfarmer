// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import HistoryScreen from './HistoryScreen.jsx'

afterEach(cleanup)

describe('HistoryScreen — supplied Stellar read states', () => {
  it('keeps an unavailable read distinct from a confirmed empty history', () => {
    const { rerender } = render(<HistoryScreen items={null} />)
    expect(screen.getByText(/stellar activity unavailable/i)).toBeTruthy()
    expect(screen.queryByText(/no stellar activity yet/i)).toBeNull()

    rerender(<HistoryScreen items={[]} />)
    expect(screen.getByText(/no stellar activity yet/i)).toBeTruthy()
    expect(screen.queryByText(/unavailable/i)).toBeNull()
  })

  it('renders an explicit loading state without fabricating empty activity', () => {
    render(<HistoryScreen items={{ state: 'loading', items: [] }} />)
    expect(screen.getByText(/loading stellar activity/i)).toBeTruthy()
    expect(screen.queryByText(/no stellar activity yet/i)).toBeNull()
  })

  it('formats canonical token units exactly in current rows', () => {
    render(
      <HistoryScreen
        items={{
          state: 'current',
          items: [
            {
              id: 'op-1',
              direction: 'in',
              from: 'GFROM',
              asset: 'USDC:GISSUER',
              amount: { token: 'USDC', units: '10000001', decimals: 7 },
              createdAt: '2026-08-13',
            },
          ],
        }}
      />
    )
    expect(screen.getByText(/received usdc/i)).toBeTruthy()
    expect(screen.getByText(/\+1\.0000001 usdc/i)).toBeTruthy()
  })
})
