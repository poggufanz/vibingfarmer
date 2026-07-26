// frontend/src/wallet/ui/WalletSettings.test.jsx
// VF Wallet Task 11 -- WalletSettings wires WalletShell (account chip, "Stellar testnet" text,
// beginner nav) around classic/SettingsScreen.jsx (Standard only) plus the shared Base-mandate
// summary and Advanced/Testnet link. The central-truth guard: this surface must never claim a
// synced Base mandate status or offer a working revoke control, and must never imply that
// revoking on the web app destroys the underlying key everywhere.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { WalletSettings } from './WalletSettings.jsx'
import { launchRealChromium, buildHarnessHtml, sweep320 } from './testSupport/sweep320.js'

afterEach(cleanup)

const G_ACCOUNT = {
  kind: 'G',
  address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY',
}
const C_ACCOUNT = {
  kind: 'C',
  address: 'CZYXWVUTSRQPONMLKJIHGFEDCBA234567ZYXWVUTSRQPONMLKJIHGFEDCB',
}

describe('WalletSettings — shell wiring', () => {
  it('shows the active account type and the Stellar testnet text', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByTestId('wallet-account-chip').textContent).toContain('Standard')
  })

  it('renders exactly the Home/Activity/Settings nav with Settings current', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    const bar = screen.getByRole('navigation')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Home', 'Activity', 'Settings'])
    expect(within(bar).getByText('Settings').getAttribute('aria-current')).toBe('page')
  })

  it('fires onNav with the tapped tab id', () => {
    const onNav = vi.fn()
    render(<WalletSettings account={G_ACCOUNT} onNav={onNav} onOpenAdvanced={() => {}} />)
    fireEvent.click(screen.getByText('Home'))
    expect(onNav).toHaveBeenCalledWith('home')
  })

  it('renders the caller-supplied security label only when supplied', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    expect(screen.queryByTestId('wallet-security-state')).toBeNull()

    render(
      <WalletSettings
        account={G_ACCOUNT}
        onNav={() => {}}
        onOpenAdvanced={() => {}}
        securityLabel="Locked"
      />
    )
    expect(screen.getByTestId('wallet-security-state').textContent).toBe('Locked')
  })
})

describe('WalletSettings — Standard (G) account-model controls', () => {
  it('renders Lock/auto-lock/export/reset when the caller supplies real support (onLock)', () => {
    render(
      <WalletSettings
        account={G_ACCOUNT}
        onNav={() => {}}
        onOpenAdvanced={() => {}}
        onLock={() => {}}
        onExport={() => {}}
        onReset={() => {}}
        autoLockMin={10}
        onSetAutoLock={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: 'Lock now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export secret' })).toBeTruthy()
  })

  it('does not render classic security controls for a Passkey (C) account (no dead button)', () => {
    render(
      <WalletSettings
        account={C_ACCOUNT}
        onNav={() => {}}
        onOpenAdvanced={() => {}}
        onLock={() => {}}
        onExport={() => {}}
        onReset={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export secret' })).toBeNull()
  })

  it('does not render classic security controls when the caller supplies no lock handler', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull()
  })
})

describe('WalletSettings — account switch', () => {
  it('renders no switch control when none is supplied', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    expect(screen.queryByRole('button', { name: /switch/i })).toBeNull()
  })

  it('renders the caller-supplied switch label and fires onSwitchAccount once per click', () => {
    const onSwitchAccount = vi.fn()
    render(
      <WalletSettings
        account={C_ACCOUNT}
        onNav={() => {}}
        onOpenAdvanced={() => {}}
        onSwitchAccount={onSwitchAccount}
        switchLabel="Switch to classic wallet / Reset"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch to classic wallet / Reset' }))
    expect(onSwitchAccount).toHaveBeenCalledTimes(1)
  })
})

describe('WalletSettings — Advanced/Testnet link', () => {
  it('fires onOpenAdvanced exactly once per click', () => {
    const onOpenAdvanced = vi.fn()
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={onOpenAdvanced} />)
    fireEvent.click(screen.getByRole('button', { name: /advanced.*testnet/i }))
    expect(onOpenAdvanced).toHaveBeenCalledTimes(1)
  })
})

describe('WalletSettings — Base mandate: no unverifiable status claim, no unsupported revoke control', () => {
  it('links out with the exact required copy to the web app, in a new tab', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    const link = screen.getByRole('link', { name: 'Manage Base testnet in Vibing Farmer' })
    expect(link.getAttribute('href')).toBe('https://vibing-farmer.pages.dev')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('never renders a mandate status value (active/expired/revoked) it cannot verify', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    const summary = screen.getByTestId('base-mandate-summary')
    expect(summary.textContent).not.toMatch(/\bstatus:\s*(active|expired|revoked)\b/i)
  })

  it('never renders a revoke button here (no authoritative write path from the extension)', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('states plainly that this extension cannot revoke and has no synced copy of the status', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    const summary = screen.getByTestId('base-mandate-summary')
    expect(summary.textContent).toMatch(/no synced copy/i)
    expect(summary.textContent).toMatch(/no working revoke control/i)
  })

  it('does not claim that web-app revocation destroys the key everywhere (Task 7 worst-case copy)', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    const summary = screen.getByTestId('base-mandate-summary')
    expect(summary.textContent).not.toMatch(/destroys? (the )?key everywhere/i)
    expect(summary.textContent).not.toMatch(/wipes? this wallet/i)
    expect(summary.textContent).toMatch(/does not guarantee the key is destroyed everywhere/i)
  })
})

describe('WalletSettings — honesty labels and extra children', () => {
  it('always renders the global honesty labels', () => {
    render(<WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />)
    expect(screen.getByTestId('honesty-global')).toBeTruthy()
  })

  it('renders extra children after its own content', () => {
    render(
      <WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}}>
        <p data-testid="extra">extra</p>
      </WalletSettings>
    )
    expect(screen.getByTestId('extra')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser guards (320px layout via the shared sweep320 helper -- VF Wallet Task 12, Part A1
// -- and items 5/6/7 as jsdom cannot compute any of them reliably): same launch mechanism
// WalletOnboarding.test.jsx's guard already uses, reused verbatim rather than reinvented (see
// that file's header for why jsdom's getComputedStyle cannot answer either question). WalletShell
// carries its own <style>, so `container.innerHTML` after a render already includes the real,
// complete stylesheet -- no separate CSS file to concatenate. This surface is the text-heaviest
// one this task ships (Settings prose, Base mandate summary), so item 5 (friendly copy in
// monospace) gets its own dedicated check here, not just a shared assumption from WalletShell's
// guard.
// ---------------------------------------------------------------------------------------------
function StandardSettingsWithResetOpen() {
  return (
    <WalletSettings
      account={G_ACCOUNT}
      onNav={() => {}}
      onOpenAdvanced={() => {}}
      onLock={() => {}}
      onExport={() => {}}
      onReset={() => {}}
      autoLockMin={10}
      onSetAutoLock={() => {}}
    />
  )
}

const SETTINGS_STATES = [
  [
    'standard-default',
    <WalletSettings account={G_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />,
  ],
  ['standard-with-security-controls', <StandardSettingsWithResetOpen />],
  [
    'passkey-default',
    <WalletSettings account={C_ACCOUNT} onNav={() => {}} onOpenAdvanced={() => {}} />,
  ],
  [
    'passkey-with-switch-link',
    <WalletSettings
      account={C_ACCOUNT}
      onNav={() => {}}
      onOpenAdvanced={() => {}}
      onSwitchAccount={() => {}}
      switchLabel="Switch to classic wallet / Reset"
    />,
  ],
]

function renderStates(states) {
  const results = []
  for (const [label, node] of states) {
    const { container, unmount } = render(node)
    results.push([label, container.innerHTML])
    unmount()
  }
  return results
}

describe('WalletSettings — real-browser 320px layout guard, per state', () => {
  // sweep320 (VF Wallet Task 12, Part A1) checks every element's own boundingClientRect, not just
  // document/`.pc-wallet` scrollWidth -- see sweep320.js's own header for why that is a strictly
  // stronger replacement for the two-width check this block used to hand-roll: `.pc-wallet` has
  // `overflow-x: clip`, which contains an internal grid blowout from ever reaching
  // `document.documentElement` (so the page itself never gains a horizontal scrollbar) without
  // stopping the blown-out content from being real, clipped, unreadable overflow *inside* the
  // 320px popup box -- exactly the WalletShell.jsx-documented "clip hides the paint, it does not
  // stop the grid track's content-based sizing" failure mode.
  it('creates no horizontal overflow at 320px for every state built (page-level and inside .pc-wallet)', async () => {
    const results = renderStates(SETTINGS_STATES)
    await sweep320(results, { logPrefix: 'WalletSettings' })
  }, 60000)
})

describe('WalletSettings — real-Chromium proof of rejection-checklist item 5 (jsdom cannot see this)', () => {
  it('no friendly copy outside .pc-technical/code/pre computes a JetBrains Mono font-family', async () => {
    const results = renderStates(SETTINGS_STATES)
    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildHarnessHtml(html))
        const monoOffenders = await page.evaluate(() =>
          Array.from(document.querySelectorAll('*'))
            .filter((el) => el.children.length === 0 && el.textContent.trim())
            .filter((el) => !el.closest('.pc-technical, code, pre'))
            .map((el) => ({
              text: el.textContent.trim().slice(0, 40),
              fontFamily: getComputedStyle(el).fontFamily,
            }))
            .filter((entry) => /jetbrains mono/i.test(entry.fontFamily))
        )
        expect(monoOffenders, `${label}: friendly copy rendered in JetBrains Mono`).toEqual([])
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})

describe('WalletSettings — real-Chromium proof of rejection-checklist items 6/7 (jsdom cannot see this)', () => {
  it('the reset-confirmation (destructive) state has no running animation in a real browser', async () => {
    const { container, unmount } = render(<StandardSettingsWithResetOpen />)
    // Open the reset-confirm panel BEFORE capturing HTML -- this is the destructive state.
    const resetButton = within(container).getByRole('button', { name: 'Reset wallet' })
    fireEvent.click(resetButton)
    const html = container.innerHTML
    unmount()

    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setContent(buildHarnessHtml(html))
      const animating = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .map((el) => getComputedStyle(el).animationName)
          .filter((name) => name && name !== 'none')
      )
      expect(animating, 'reset-confirm: entry/infinite animation found in real Chromium').toEqual(
        []
      )
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)
})
