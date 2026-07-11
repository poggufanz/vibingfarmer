// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import DevelopersPage from './DevelopersPage.jsx'
import { createKey, listKeys, revokeKey } from './portalClient.js'

vi.mock('./portalClient.js', () => ({
  signIn: vi.fn(async () => 'JWT'),
  listKeys: vi.fn(async () => [
    {
      id: 'vfk_1',
      key_hint: 'vf_test_ab12…',
      scopes: '["market"]',
      enabled: 1,
      created_at: 1_700_000_000,
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DevelopersPage', () => {
  it('connect → lists keys → create form → secret shown once with ack', async () => {
    render(<DevelopersPage />)

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())

    // Create opens dialog (not inline generate)
    fireEvent.click(screen.getAllByRole('button', { name: /create secret key/i })[0])
    expect(screen.getByRole('dialog', { name: /create secret key/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^create key$/i }))
    await waitFor(() => expect(screen.getByText('vf_test_PLAINTEXT_ONCE')).toBeTruthy())
    expect(screen.getByText(/only time the full key is available/i)).toBeTruthy()

    // Done blocked until acknowledge
    const done = screen.getByRole('button', { name: /^done$/i })
    expect(done.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(done.disabled).toBe(false)
    fireEvent.click(done)
    await waitFor(() =>
      expect(screen.queryByText('vf_test_PLAINTEXT_ONCE')).toBeNull()
    )
  })

  it('revoke requires confirmation before calling API', async () => {
    render(<DevelopersPage />)
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: /^revoke$/i })[0])
    expect(screen.getByRole('dialog', { name: /revoke api key/i })).toBeTruthy()
    expect(revokeKey).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^revoke key$/i }))
    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith('JWT', 'vfk_1'))
  })

  it('create sends scopes, env, and expiresAt', async () => {
    render(<DevelopersPage />)
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    await waitFor(() => expect(screen.getAllByText('vf_test_ab12…').length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByRole('button', { name: /create secret key/i })[0])
    const liveEnv = screen
      .getAllByRole('radio')
      .find((el) => /^Live/i.test(el.textContent || '') && /production/i.test(el.textContent || ''))
    fireEvent.click(liveEnv)
    fireEvent.click(screen.getByRole('radio', { name: /30 days/i }))
    fireEvent.click(screen.getByRole('button', { name: /^create key$/i }))

    await waitFor(() => expect(createKey).toHaveBeenCalled())
    const [, payload] = createKey.mock.calls[0]
    expect(payload.env).toBe('live')
    expect(payload.scopes).toEqual(expect.arrayContaining(['market', 'scan']))
    expect(payload.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(listKeys).toHaveBeenCalled()
  })
})
