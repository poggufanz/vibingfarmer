// @vitest-environment jsdom
// frontend/src/skills.render.test.jsx
// Task: ensureBaseOwner (wallet/passkeyBridge.js) runs a real ZeroDev passkey ceremony for EVERY
// wallet type — VF reuse is impossible (see that file's header: the SDK never durably persists
// the P-256 pubkey behind a VF passkey credential). SkillCard's disclosure must therefore never
// be suppressed just because the connected wallet happens to be a VF wallet.
import { describe, test, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SkillReviewCard } from './skills.jsx'
import { baseOwnerStorageKey } from './wallet/baseBinding.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const baseAgent = {
  id: 'a1',
  idx: 1,
  name: 'Worker 1',
  allocation: 40,
  skillName: 'worker-1-skill',
  role: 'Base pool depositor',
  vault: { chain: 'base', protocol: 'aave-v3', addr: '0xPOOL', risk: 'medium' },
}

function renderCard(connectedAddress) {
  render(
    <SkillReviewCard
      agents={[baseAgent]}
      riskProfile="medium"
      skillStates={{}}
      onApprove={() => {}}
      onSkillUpdate={() => {}}
      onApproveAll={() => {}}
      onContinue={() => {}}
      connectedAddress={connectedAddress}
    />
  )
}

describe('SkillCard passkey-setup disclosure (ceremony is universal, not VF-wallet-exempt)', () => {
  test('shows the one-time passkey setup note for a VF wallet too, when no ceremony has run yet', () => {
    localStorage.setItem('vf_wallet_contract', 'GVFWALLET')
    renderCard('GVFWALLET') // isVfWallet(connectedAddress) is true here
    expect(screen.getByText(/one-time passkey setup/i)).toBeTruthy()
  })

  test('shows the note for a non-VF wallet too', () => {
    renderCard('GFREIGHTER')
    expect(screen.getByText(/one-time passkey setup/i)).toBeTruthy()
  })

  // VF Wallet Task 6: the disclosure gate reads the owner-scoped v2 record (wallet/baseBinding.js)
  // now, not the old global vf_base_owner key — that key never recorded WHICH wallet ran the
  // ceremony, so it could never be checked safely against the currently connected wallet.
  test('hides the note once the ceremony has already run for THIS connected wallet (owner-scoped v2 record)', () => {
    localStorage.setItem(
      baseOwnerStorageKey('GVFWALLET'),
      JSON.stringify({ version: 2, stellarOwner: 'GVFWALLET', kernelAddress: '0xOWNER' })
    )
    renderCard('GVFWALLET')
    expect(screen.queryByText(/one-time passkey setup/i)).toBeNull()
  })

  test('a ceremony recorded for a DIFFERENT wallet still shows the note (no cross-wallet adoption)', () => {
    localStorage.setItem(
      baseOwnerStorageKey('GSOMEOTHERWALLET'),
      JSON.stringify({ version: 2, stellarOwner: 'GSOMEOTHERWALLET', kernelAddress: '0xOWNER' })
    )
    renderCard('GVFWALLET')
    expect(screen.getByText(/one-time passkey setup/i)).toBeTruthy()
  })
})

describe('Secondary skill dialogs', () => {
  test('opens exactly one Foundation detail owner and preserves the selected skill callback', () => {
    renderCard('GDEFAULT')
    fireEvent.click(screen.getByRole('button', { name: /view details/i }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: /worker 1, medium/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /edit skill/i }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: /edit worker 1/i })).toBeTruthy()
  })

  test('owned skill shells contain no legacy overlay or local focus implementation', () => {
    const here = resolve(globalThis.process.cwd(), 'src/components')
    for (const file of ['SkillDrawer.jsx', 'SkillEditModal.jsx', 'SkillDetailModal.jsx']) {
      const source = readFileSync(resolve(here, file), 'utf8')
      expect(source).toMatch(/Dialog/)
      expect(source).toMatch(/SecondaryDialogs\.css/)
      expect(source).not.toMatch(
        /modal-backdrop|skill-drawer-overlay|addEventListener\(['"]keydown/
      )
    }
  })
})
