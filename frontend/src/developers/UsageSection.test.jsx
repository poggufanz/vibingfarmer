// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import UsageSection from './UsageSection.jsx'

const TODAY = new Date().toISOString().slice(0, 10)

vi.mock('./portalClient.js', () => ({
  listKeys: vi.fn(async () => [
    { id: 'k1', key_hint: 'vf_test_aa…', enabled: 1, rate_limit: 60 },
    { id: 'k2', key_hint: 'vf_live_bb…', enabled: 1, rate_limit: 120 },
  ]),
  getUsage: vi.fn(async () => ({
    usage: [
      { key_id: 'k1', day: TODAY, endpoint: 'GET /prices', count: 12 },
      { key_id: 'k2', day: TODAY, endpoint: 'POST /scan', count: 3 },
      { key_id: 'k1', day: '2026-07-01', endpoint: 'POST /strategy', count: 5 },
    ],
    cap: 5000,
    sinceDay: '2026-06-11',
  })),
}))

afterEach(cleanup)

const SESSION = { jwt: 'JWT', address: 'GAAA' }

describe('UsageSection', () => {
  it('renders today total vs cap and daily rows', async () => {
    render(<UsageSection session={SESSION} />)
    await waitFor(() => expect(screen.getByText('GET /prices')).toBeTruthy())
    expect(screen.getByText('15')).toBeTruthy() // today total 12+3
    expect(screen.getByText(/5,?000/)).toBeTruthy() // cap
    expect(screen.getByText('POST /strategy')).toBeTruthy() // history row
  })

  it('filters rows by key', async () => {
    render(<UsageSection session={SESSION} />)
    await waitFor(() => expect(screen.getByText('POST /scan')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'vf_test_aa…' }))
    expect(screen.queryByText('POST /scan')).toBeNull()
    expect(screen.getByText('GET /prices')).toBeTruthy()
  })
})
