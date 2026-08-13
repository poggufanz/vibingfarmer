// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import SettingsPage from './SettingsPage.jsx'

const baseProps = {
  userAddress: null,
  walletPhase: 'none',
  permActive: false,
  permExpiresAt: null,
  permissionCount: 0,
  agentEnabled: false,
  setAgentEnabled: vi.fn(),
  agentSettings: {},
  setAgentSettings: vi.fn(),
  skillSource: 'default',
  language: 'en',
  onLanguageChange: vi.fn(),
  onChangeSkill: vi.fn(),
  onResetSkill: vi.fn(),
  onResetAgentSettings: vi.fn(),
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  onRevoke: vi.fn(),
  addLog: vi.fn(),
  mandateView: null,
  connected: false,
  busy: false,
  error: null,
  onSetup: vi.fn(),
  onRefresh: vi.fn(),
}

const readyBaseView = {
  status: 'ready',
  primaryCopy: 'Ready Base mandate source copy.',
  durationDays: 7,
  perCallCap: {
    usdc: '10,000',
    units: 10_000_000_000n,
    decimals: 6,
    cumulative: false,
    nonCumulative: true,
  },
  repeatedCalls: true,
  allowedActions: ['Circle USDC approve', 'YieldRouter deposit'],
  destination: 'allowlisted Base Sepolia custody proxies',
  sessionKeyAddress: '0x2222222222222222222222222222222222222222',
  kernelAddress: '0x1111111111111111111111111111111111111111',
  validUntilSeconds: 1_800_000_000,
  evidence: {
    stellarOwner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
  renewalCopy: 'Renew before expiry.',
  revokeCopy: 'Relayer copy only.',
}

function renderSettings(props = {}) {
  return render(<SettingsPage {...baseProps} {...props} />)
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/settings')
})

afterEach(() => cleanup())

describe('SettingsPage route tab handoff', () => {
  it('shows the canonical Stellar testnet badge in the real Wallet & Network section', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings()

    const walletSection = screen.getByText('Wallet & Network').closest('section')
    const label = within(walletSection).getByText('Stellar testnet', { exact: true })

    expect(label.closest('.network-badge')?.getAttribute('data-network')).toBe('stellar-testnet')
    expect(walletSection.querySelector('.network-route')).toBeNull()
  })

  it('selects Wallet and focuses the Base mandate deep-link target without rewriting the URL', async () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings()

    expect(screen.getByRole('tab', { name: 'Wallet' }).getAttribute('aria-selected')).toBe('true')
    const target = screen.getByRole('region', { name: /base mandate/i })
    expect(target.getAttribute('id')).toBe('base-mandate')
    expect(document.activeElement).toBe(target)
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.search).toBe('?tab=wallet')
    expect(window.location.hash).toBe('#base-mandate')
  })

  it('keeps every tab keyboard reachable while Wallet is selected', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Agent',
      'Strategy',
      'Alerts',
      'Wallet',
      'Data & Privacy',
      'About',
    ])
    tabs.forEach((tab) => expect(tab.getAttribute('tabindex')).toBe('0'))
  })

  it('updates the selected tab and deep-link focus when the URL changes while mounted', async () => {
    window.history.replaceState({}, '', '/settings?tab=agent')

    renderSettings()

    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true')

    window.history.pushState({}, '', '/settings?tab=wallet#base-mandate')
    window.dispatchEvent(new PopStateEvent('popstate'))

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Wallet' }).getAttribute('aria-selected')).toBe('true')
    )
    const target = screen.getByRole('region', { name: /base mandate/i })
    await waitFor(() => expect(document.activeElement).toBe(target))
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.search).toBe('?tab=wallet')
    expect(window.location.hash).toBe('#base-mandate')
  })

  it('keeps user focus after switching away and back with the unchanged deep-link URL', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings()

    const walletTab = screen.getByRole('tab', { name: 'Wallet' })
    const strategyTab = screen.getByRole('tab', { name: 'Strategy' })
    fireEvent.click(strategyTab)
    strategyTab.focus()
    walletTab.focus()
    fireEvent.click(walletTab)

    expect(document.activeElement).toBe(walletTab)
  })

  it('ignores duplicate popstate and hashchange events for the unchanged URL signature', async () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings()

    const walletTab = screen.getByRole('tab', { name: 'Wallet' })
    walletTab.focus()

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
      window.dispatchEvent(new Event('hashchange'))
    })

    expect(document.activeElement).toBe(walletTab)
  })

  it('focuses the Base target for a genuinely new pathname, search, or hash signature', async () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#other')

    renderSettings()

    const walletTab = screen.getByRole('tab', { name: 'Wallet' })
    walletTab.focus()
    window.history.pushState({}, '', '/settings?tab=wallet#base-mandate')

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    const target = screen.getByRole('region', { name: /base mandate/i })
    await waitFor(() => expect(document.activeElement).toBe(target))
  })

  it('treats a previously seen URL as new after navigating through another signature', async () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings()

    window.history.pushState({}, '', '/settings?tab=agent')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const walletTab = screen.getByRole('tab', { name: 'Wallet' })
    walletTab.focus()

    window.history.pushState({}, '', '/settings?tab=wallet#base-mandate')
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    const target = screen.getByRole('region', { name: /base mandate/i })
    await waitFor(() => expect(document.activeElement).toBe(target))
  })

  it('does not steal a user focus target when Base mandate props rerender', async () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    const { rerender } = renderSettings({ mandateView: readyBaseView, connected: true })
    const target = screen.getByRole('region', { name: /base mandate/i })
    await waitFor(() => expect(document.activeElement).toBe(target))

    const walletTab = screen.getByRole('tab', { name: 'Wallet' })
    walletTab.focus()
    expect(document.activeElement).toBe(walletTab)

    rerender(
      <SettingsPage
        {...baseProps}
        mandateView={{ ...readyBaseView, primaryCopy: 'Updated source-backed mandate copy.' }}
        connected
      />
    )

    expect(document.activeElement).toBe(walletTab)
  })

  it('keeps the Base handoff source-backed and read-only without inventing actions', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')

    renderSettings({ mandateView: readyBaseView, connected: true })

    const manager = screen.getByRole('region', { name: /base mandate/i })
    expect(manager.textContent).toContain('Base Sepolia proxy. Custody only. No protocol yield.')
    expect(manager.textContent).toContain(
      'Renewal Unavailable — this view is read-only until an app-owned Base action is supplied.'
    )
    expect(manager.textContent).toContain(
      'Revoke Unavailable — this view is read-only until an app-owned Base action is supplied.'
    )
    expect(screen.queryByRole('button', { name: 'Renew Base mandate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke Base mandate copy' })).toBeNull()
  })

  it('keeps base-mandate source-unavailable state unavailable with refresh only and no revoke inference', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')
    const onRefresh = vi.fn()

    renderSettings({
      mandateView: {
        status: 'unavailable',
        primaryCopy: 'Source-backed Base status is unavailable.',
      },
      connected: true,
      onRefresh,
    })

    const manager = screen.getByRole('region', { name: /base mandate/i })
    expect(screen.getByRole('status').textContent).toBe('Status: Unavailable')
    expect(manager.textContent).not.toContain('10,000 USDC')
    expect(manager.textContent).not.toContain(
      'Base Sepolia proxy. Custody only. No protocol yield.'
    )
    expect(screen.queryByRole('button', { name: 'Set up Base mandate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Renew Base mandate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke Base mandate copy' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Base mandate' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('relates each tab to its panel and supports normal Enter and Space activation', () => {
    window.history.replaceState({}, '', '/settings?tab=agent')

    renderSettings()

    const tabs = screen.getAllByRole('tab')
    const strategyTab = screen.getByRole('tab', { name: 'Strategy' })
    const walletTab = screen.getByRole('tab', { name: 'Wallet' })
    tabs.forEach((tab) => {
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).toBe(`settings-panel-${tab.id.replace('settings-tab-', '')}`)
      expect(document.getElementById(panelId)?.getAttribute('aria-labelledby')).toBe(tab.id)
    })

    fireEvent.keyDown(strategyTab, { key: 'Enter' })
    expect(strategyTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(strategyTab.id)
    expect(screen.getByText('Vault Strategy')).toBeTruthy()

    fireEvent.keyDown(walletTab, { key: ' ' })
    expect(walletTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(walletTab.id)
  })

  it('falls back to Agent for an unknown tab without changing the route URL', () => {
    window.history.replaceState({}, '', '/settings?tab=not-a-real-tab')

    renderSettings()

    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Agent Configuration')).toBeTruthy()
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.search).toBe('?tab=not-a-real-tab')
    expect(window.location.hash).toBe('')
  })

  it('preserves the current wallet controls and destructive confirmation copy', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet')
    const onRevoke = vi.fn()

    renderSettings({
      userAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      permActive: true,
      permissionCount: 2,
      onRevoke,
    })

    expect(screen.getByText('Active Permissions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }))
    expect(onRevoke).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('tab', { name: 'Data & Privacy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear all data' }))
    expect(
      within(screen.getByRole('dialog', { name: 'Clear all data?' })).getByText(
        'This clears all history and resets settings. Continue?'
      )
    ).toBeTruthy()
  })

  it('uses the Foundation dialog contract for the existing clear-all confirmation', () => {
    window.history.replaceState({}, '', '/settings?tab=data')

    renderSettings()
    const opener = screen.getByRole('button', { name: 'Clear all data' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Clear all data?' })
    const description = screen.getByText('This clears all history and resets settings. Continue?')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-describedby')).toBe(description.id)
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.querySelector('.pc-settings-header[inert]')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Yes, clear all' })
    )
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Clear all data?' })).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(document.body.style.overflow).toBe('')
    expect(document.querySelector('.pc-settings-header[inert]')).toBeNull()
  })

  it('keeps the existing clear-all callback behind the explicit confirmation', () => {
    window.history.replaceState({}, '', '/settings?tab=data')
    localStorage.setItem('yv_agent_settings', JSON.stringify({ enabled: true }))
    const onResetAgentSettings = vi.fn()

    renderSettings({ onResetAgentSettings })
    const opener = screen.getByRole('button', { name: 'Clear all data' })
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Clear all data?' })

    expect(onResetAgentSettings).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, clear all' }))

    expect(onResetAgentSettings).toHaveBeenCalledOnce()
    expect(localStorage.getItem('yv_agent_settings')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Clear all data?' })).toBeNull()
  })

  it('closes the clear-all confirmation through the declared backdrop and keeps the exact copy', () => {
    window.history.replaceState({}, '', '/settings?tab=data')

    renderSettings()
    const opener = screen.getByRole('button', { name: 'Clear all data' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Clear all data?' })

    expect(
      within(dialog).getByText('This clears all history and resets settings. Continue?')
    ).toBeTruthy()
    fireEvent.click(dialog)
    expect(screen.queryByRole('dialog', { name: 'Clear all data?' })).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps generic Stellar revoke isolated from the Base manager', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet')
    const onRevoke = vi.fn()

    renderSettings({
      userAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      permActive: true,
      mandateView: readyBaseView,
      connected: true,
      onRevoke,
      onBaseRevoke: undefined,
    })

    expect(screen.queryByRole('button', { name: 'Revoke Base mandate copy' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('contains no JSX inline style attributes after route style migration', async () => {
    const file = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'SettingsPage.jsx'),
      'utf8'
    )
    expect(file).not.toMatch(/style\s*=|style\s*=\s*\{/)
  })

  it('keeps VF Wallet ownership outside the web Settings component', async () => {
    const file = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'SettingsPage.jsx'),
      'utf8'
    )
    const vfWalletComponent = ['Wallet', 'Settings'].join('')
    const vfWalletPath = ['wallet', 'ui', vfWalletComponent].join('/')
    expect(file).not.toContain(vfWalletComponent)
    expect(file).not.toContain(vfWalletPath)
  })
})
