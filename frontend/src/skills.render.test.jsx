// @vitest-environment jsdom
// frontend/src/skills.render.test.jsx
// Task: ensureBaseOwner (wallet/passkeyBridge.js) runs a real ZeroDev passkey ceremony for EVERY
// wallet type — VF reuse is impossible (see that file's header: the SDK never durably persists
// the P-256 pubkey behind a VF passkey credential). SkillCard's disclosure must therefore never
// be suppressed just because the connected wallet happens to be a VF wallet.
import { describe, test, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SkillReviewCard } from './skills.jsx'

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

  test('hides the note once the ceremony has already run (vf_base_owner recorded), any wallet', () => {
    localStorage.setItem('vf_base_owner', JSON.stringify({ address: '0xOWNER' }))
    renderCard('GVFWALLET')
    expect(screen.queryByText(/one-time passkey setup/i)).toBeNull()
  })
})
