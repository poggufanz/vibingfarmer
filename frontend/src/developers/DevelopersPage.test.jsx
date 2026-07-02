// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DevelopersPage from './DevelopersPage.jsx'

vi.mock('./portalClient.js', () => ({
  signIn: vi.fn(async () => 'JWT'),
  listKeys: vi.fn(async () => [
    {
      id: 'vfk_1',
      key_hint: 'vf_test_ab12…',
      scopes: '["market"]',
      enabled: 1,
      created_at: 1,
      last_used_at: null,
      rate_limit: 60,
    },
  ]),
  createKey: vi.fn(async () => ({
    id: 'vfk_2',
    key: 'vf_test_PLAINTEXT_ONCE',
    hint: 'vf_test_PL…',
  })),
  revokeKey: vi.fn(async () => true),
}))
vi.mock('./walletSign.js', () => ({
  connectWallet: vi.fn(async () => ({ address: 'GAAA', signChallenge: async (x) => x + ':s' })),
}))

afterEach(() => vi.restoreAllMocks())

describe('DevelopersPage', () => {
  it('connect → lists keys → generate shows plaintext once', async () => {
    render(<DevelopersPage />)
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /generate key/i }))
    await waitFor(() => expect(screen.getByText('vf_test_PLAINTEXT_ONCE')).toBeTruthy())
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy()
  })
})
