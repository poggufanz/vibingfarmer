// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import GrantFallbackFee from '../GrantFallbackFee.jsx'

afterEach(cleanup)

const props = {
  owner: 'GOWNER',
  agentCount: 2,
  budgets: [{ token: 'CTOKEN', units: '1000000000' }],
  durationSeconds: 86400,
}

describe('GrantFallbackFee', () => {
  it('renders the simulated fallback fee, never touching submission logic', async () => {
    const estimate = vi.fn(async () => ({ feeStroops: 12345n, feeXlm: '~0.0012345 XLM' }))
    render(<GrantFallbackFee {...props} estimate={estimate} />)
    expect(screen.getByText(/estimating fallback network fee/i)).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByText(/you pay the network fee yourself/i)).toBeTruthy()
    )
    expect(screen.getByText(/~0\.0012345 XLM/i)).toBeTruthy()
    expect(screen.getByText(/simulated estimate, not a quote/i)).toBeTruthy()
    expect(estimate).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GOWNER', agentCount: 2, durationSeconds: 86400 })
    )
  })

  it('a failed simulation renders unavailable, never a fabricated number', async () => {
    render(<GrantFallbackFee {...props} estimate={async () => null} />)
    await waitFor(() =>
      expect(screen.getByText(/fallback network fee estimate unavailable/i)).toBeTruthy()
    )
    expect(screen.queryByText(/XLM.*quote|pay the network fee yourself/i)).toBeNull()
  })
})
