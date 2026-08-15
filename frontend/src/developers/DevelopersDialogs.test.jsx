// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import KeysSection from './KeysSection.jsx'
import SkillDrawer from '../components/SkillDrawer.jsx'
import SkillEditModal from '../components/SkillEditModal.jsx'
import SkillDetailModal from '../components/SkillDetailModal.jsx'
import { revokeKey } from './portalClient.js'
import { clearUserSkill, loadVaultSkill, saveUserSkill } from '../skillLoader.js'

vi.mock('./portalClient.js', () => ({
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
  createKey: vi.fn(async () => ({ key: 'vf_test_ONCE_ONLY' })),
  revokeKey: vi.fn(async () => true),
}))

vi.mock('../skillLoader.js', () => ({
  clearUserSkill: vi.fn(),
  loadVaultSkill: vi.fn(async () => ({ content: '', source: 'default' })),
  saveUserSkill: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.body.style.removeProperty('overflow')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
})

const SESSION = { jwt: 'JWT', address: 'GAAAAAAA' }

const AGENT = {
  id: 'a1',
  name: 'Worker 1',
  allocation: 40,
  vault: { protocol: 'aave-v3', addr: 'CVAULT', chain: 'stellar-testnet' },
}

const SKILL = {
  target: { vault: 'CVAULT', chain: 'stellar-testnet' },
  steps: [{ id: 'deposit', action: 'vault_deposit', params: {} }],
  guards: {
    maxAmount: '40 USDC',
    expiresIn: '86400',
    riskProfile: 'medium',
    revocable: true,
  },
}

function renderKeys() {
  return render(<KeysSection session={SESSION} />)
}

function ControlledSkillEdit({ onSave, onClosed }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      {open && (
        <SkillEditModal
          agent={AGENT}
          skill={SKILL}
          onClose={() => {
            onClosed()
            setOpen(false)
          }}
          onSave={onSave}
        />
      )}
      <button type="button" onClick={() => setOpen(true)}>
        Reopen edit
      </button>
    </>
  )
}

function ControlledSkillDetail({ onEdit, onApprove, onClosed }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      {open && (
        <SkillDetailModal
          agent={AGENT}
          skill={SKILL}
          state="pending"
          onClose={() => {
            onClosed()
            setOpen(false)
          }}
          onEdit={onEdit}
          onApprove={onApprove}
        />
      )}
      <button type="button" onClick={() => setOpen(true)}>
        Reopen detail
      </button>
    </>
  )
}

describe('Secondary developer dialogs', () => {
  it('uses one Foundation create dialog with initial focus, Escape, backdrop, and restore', async () => {
    renderKeys()
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())

    const opener = screen.getAllByRole('button', { name: /create secret key/i })[0]
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: /create secret key/i })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /test/i }))

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)

    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('dialog', { name: /create secret key/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(dialog).not.toBe(screen.queryByRole('dialog'))
  })

  it('keeps revoke cancellation callback-free and confirms only through its action', async () => {
    renderKeys()
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))

    screen.getByRole('dialog', { name: /revoke api key/i })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^cancel$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(revokeKey).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^revoke key$/i }))
    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith('JWT', 'vfk_1'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the one-time secret gated by acknowledgement and surfaces clipboard failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    })
    renderKeys()
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())
    const opener = screen.getAllByRole('button', { name: /create secret key/i })[0]
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: /^create key$/i }))

    await waitFor(() => expect(screen.getByText('vf_test_ONCE_ONLY')).toBeTruthy())
    expect(screen.getByRole('dialog').textContent).not.toMatch(/curl/i)
    expect(screen.getByRole('button', { name: /^done$/i }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^copy key$/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not copy/i))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: /^done$/i }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    expect(screen.queryByText('vf_test_ONCE_ONLY')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps drawer selection, unsaved cancellation, and apply callbacks in one Dialog owner', async () => {
    const onClose = vi.fn()
    const onSkillChange = vi.fn()
    render(
      <SkillDrawer open onClose={onClose} skillSource="default" onSkillChange={onSkillChange} />
    )
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: /vault advisor skill/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /custom strategy/i }))
    const textarea = screen.getByRole('textbox')
    await waitFor(() => expect(document.activeElement).toBe(textarea))
    fireEvent.click(screen.getByRole('button', { name: /apply strategy/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/cannot be empty/i)
    fireEvent.change(textarea, { target: { value: '# custom' } })
    fireEvent.click(screen.getByRole('button', { name: /apply strategy/i }))
    expect(saveUserSkill).toHaveBeenCalledWith('# custom')
    expect(onSkillChange).toHaveBeenCalledWith('user-local')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(clearUserSkill).not.toHaveBeenCalled()
    expect(loadVaultSkill).not.toHaveBeenCalled()
  })

  it('gives edit and detail dialogs initial focus, containment, and callback ownership', async () => {
    const onSave = vi.fn()
    const onEdited = vi.fn()
    const onEditClosed = vi.fn()
    render(<ControlledSkillEdit onSave={onSave} onClosed={onEditClosed} />)
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: /maximum usdc/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onEditClosed).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: /edit worker 1/i })).toBeNull()

    render(<ControlledSkillDetail onEdit={onEdited} onApprove={vi.fn()} onClosed={vi.fn()} />)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /edit skill/i }))
    expect(onEdited).toHaveBeenCalledTimes(1)
  })
})
