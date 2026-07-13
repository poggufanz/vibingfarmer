// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import OverviewSection from './OverviewSection.jsx'

vi.mock('./portalClient.js', () => ({
  listKeys: vi.fn(async () => [
    { id: 'a', enabled: 1 },
    { id: 'b', enabled: 0 },
  ]),
  getUsage: vi.fn(async () => ({
    usage: [
      {
        key_id: 'a',
        day: new Date().toISOString().slice(0, 10),
        endpoint: 'GET /prices',
        count: 7,
      },
      { key_id: 'a', day: '2020-01-01', endpoint: 'GET /prices', count: 99 },
    ],
    cap: 5000,
    sinceDay: '2026-06-11',
  })),
}))

afterEach(cleanup)

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('OverviewSection', () => {
  it('public: welcome + CTAs, no stats', () => {
    wrap(<OverviewSection session={null} />)
    expect(screen.getByRole('link', { name: /create api key/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /view documentation/i })).toBeTruthy()
    expect(screen.queryByText(/requests today/i)).toBeNull()
  })

  it('authed: shows active keys and today request count', async () => {
    wrap(<OverviewSection session={{ jwt: 'JWT', address: 'GAAA' }} />)
    await waitFor(() => expect(screen.getByText(/requests today/i)).toBeTruthy())
    expect(screen.getByText('1').className).toMatch(/figure/) // 1 active key
    expect(screen.getByText('7').className).toMatch(/figure/) // today count
  })
})
