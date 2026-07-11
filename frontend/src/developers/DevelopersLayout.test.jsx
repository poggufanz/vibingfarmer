// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import DevelopersLayout from './DevelopersLayout.jsx'

vi.mock('./portalClient.js', () => ({
  signIn: vi.fn(async () => 'JWT'),
  listKeys: vi.fn(async () => []),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  getUsage: vi.fn(async () => ({ usage: [], cap: 5000, sinceDay: '2026-06-11' })),
}))
vi.mock('./walletSign.js', () => ({
  connectWallet: vi.fn(async () => ({ address: 'GAAA', signChallenge: async (x) => x })),
}))

afterEach(cleanup)

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/developers/*" element={<DevelopersLayout />} />
      </Routes>
    </MemoryRouter>
  )

describe('DevelopersLayout', () => {
  it('renders portal nav with 4 links, overview active at index', () => {
    renderAt('/developers')
    const nav = screen.getByRole('navigation', { name: /developer portal/i })
    const links = ['Overview', 'API keys', 'Usage', 'Docs'].map((n) =>
      screen.getByRole('link', { name: n })
    )
    expect(links).toHaveLength(4)
    expect(nav).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Overview' }).className).toMatch(/active/)
  })

  it('gates keys route behind connect when no session', () => {
    renderAt('/developers/keys')
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeTruthy()
  })
})
