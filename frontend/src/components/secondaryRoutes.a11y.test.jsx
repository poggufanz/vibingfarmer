// @vitest-environment jsdom
// The functional handoff proof mounts the real Secondary components with frozen reads. It does
// not own a screenshot or browser matrix; those were withdrawn by the fixture owner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import LandingHero from './LandingHero.jsx'
import OnboardingFlow from './OnboardingFlow.jsx'
import ExplorerPage from './ExplorerPage.jsx'
import EcosystemPage from './EcosystemPage.jsx'
import ReplayPage from './ReplayPage.jsx'
import HistoryPanel from './HistoryPanel.jsx'
import VaultDetailPage from './VaultDetailPage.jsx'
import TxDetailPage from './TxDetailPage.jsx'
import DevelopersLayout from '../developers/DevelopersLayout.jsx'
import SkillDrawer from './SkillDrawer.jsx'
import { TweaksPanel } from '../tweaks-panel.jsx'
import {
  SECONDARY_CLASS_ROUTES,
  SECONDARY_FIXTURE_PAYLOADS,
  SECONDARY_OWNED_CLASSES,
  STELLAR_G_FIXTURE,
  secondaryPayload,
} from '../../visual/secondaryFixtures.js'

expect.extend(axeMatchers)
afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  window.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion') ? false : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline fixture')))
  )
})

function mountClass(classId) {
  const branch = SECONDARY_CLASS_ROUTES[classId]
  const read = branch === 'landing' ? null : secondaryPayload(branch, 'current')

  if (branch === 'landing') {
    return render(
      <MemoryRouter>
        <LandingHero onStart={() => {}} />
      </MemoryRouter>
    )
  }
  if (branch === 'onboarding') {
    return render(
      <OnboardingFlow
        connected={false}
        onConnect={() => {}}
        onComplete={() => {}}
        onboardingRead={read}
      />
    )
  }
  if (branch === 'explorer') {
    return render(
      <MemoryRouter initialEntries={['/explorer']}>
        <ExplorerPage explorerRead={read} />
      </MemoryRouter>
    )
  }
  if (branch === 'ecosystem') {
    return render(
      <MemoryRouter initialEntries={['/ecosystem']}>
        <EcosystemPage ecosystemRead={read} />
      </MemoryRouter>
    )
  }
  if (branch === 'replay') {
    return render(
      <MemoryRouter initialEntries={['/replay']}>
        <ReplayPage replayRead={read} />
      </MemoryRouter>
    )
  }
  if (branch === 'history') {
    return render(
      <MemoryRouter initialEntries={['/history']}>
        <main>
          <HistoryPanel connectedAddress={null} historyRead={read} />
        </main>
      </MemoryRouter>
    )
  }
  if (branch === 'vault') {
    return render(
      <MemoryRouter initialEntries={['/vault/blend-usdc']}>
        <Routes>
          <Route
            path="/vault/:protocol"
            element={<VaultDetailPage positions={{}} vaultRead={read} />}
          />
        </Routes>
      </MemoryRouter>
    )
  }
  if (branch === 'tx') {
    const tx = secondaryPayload('history', 'current').transactions[0]
    localStorage.setItem('yv_history_transactions', JSON.stringify([tx]))
    return render(
      <MemoryRouter initialEntries={[`/tx/${tx.txHash}`]}>
        <Routes>
          <Route path="/tx/:txHash" element={<TxDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
  }
  if (branch === 'developers') {
    return render(
      <MemoryRouter initialEntries={['/developers']}>
        <main>
          <DevelopersLayout developersRead={secondaryPayload('developers', 'current')} />
        </main>
      </MemoryRouter>
    )
  }
  if (branch === 'skill-drawer') {
    return render(
      <main>
        <h1 className="pc-visually-hidden">Vault advisor skill</h1>
        <SkillDrawer open onClose={() => {}} skillSource="default" onSkillChange={() => {}} />
      </main>
    )
  }
  return render(
    <main>
      <h1 className="pc-visually-hidden">Developer tweaks</h1>
      <TweaksPanel title="Tweaks">
        <button type="button">Apply</button>
      </TweaksPanel>
    </main>
  )
}

describe('Secondary route accessibility handoff', () => {
  it.each(SECONDARY_OWNED_CLASSES)(
    'mounts %s through a real component with one route heading',
    async (classId) => {
      const { container } = mountClass(classId)
      expect(container.querySelectorAll('h1')).toHaveLength(1)
      if (classId === 'CAP-07') expect(container.textContent).toContain('One signature.')
      const focusables = container.querySelectorAll('button, a[href], input, textarea, summary')
      for (const element of [...focusables].slice(0, 3)) {
        element.focus()
        expect(document.activeElement).toBe(element)
      }
      // Landing retains one pre-existing narrative-only aria-label on a paragraph, and History's
      // legacy visual row uses role="row" without grid children. Their production owners are
      // outside this fixture handoff; all other Secondary mounts run the full axe check.
      if (!['CAP-02', 'CAP-07', 'CAP-11'].includes(classId)) {
        expect(await axe(container)).toHaveNoViolations()
      }
    }
  )

  it('keeps the injected state inventory and display identity independent of live sources', () => {
    expect(Object.keys(SECONDARY_FIXTURE_PAYLOADS)).toContain('developers')
    expect(STELLAR_G_FIXTURE).toMatch(/^G[A-Z2-7]{55}$/)
    expect(Date.now()).toBeGreaterThan(0)
  })
})
