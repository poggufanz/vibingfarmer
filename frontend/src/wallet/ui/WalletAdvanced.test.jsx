// frontend/src/wallet/ui/WalletAdvanced.test.jsx
// VF Wallet Task 11 -- WalletAdvanced replaces the old, unreachable 'deposit'/'signers'/
// 'recovery'/'agent' popup.jsx screens, one of which (agent) exposed `addAgentSigner` as a LIVE
// submit control. The load-bearing guard in this file is the last describe block: the
// standalone agent-signer section must be permanently inert -- no input, no button, ever -- no
// matter what props this component is given, because there is no prop shape here that could wire
// a submit path to it at all (structural, like WalletShell.test.jsx's "secret material cannot
// reach this component" guard).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { WalletAdvanced } from './WalletAdvanced.jsx'
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

describe('WalletAdvanced — shell wiring', () => {
  it('shows the Advanced / Testnet heading, the active account, Stellar testnet, and Back', () => {
    const onBack = vi.fn()
    render(<WalletAdvanced account={G_ACCOUNT} onBack={onBack} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Advanced / Testnet' })).toBeTruthy()
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByTestId('wallet-account-chip').textContent).toContain('Standard')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('renders no bottom nav (reached from Settings, not a tab destination)', () => {
    render(<WalletAdvanced account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('renders nothing but the always-on agent-signer preview when the caller supplies no support at all', () => {
    render(<WalletAdvanced account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.queryByTestId('advanced-faucet')).toBeNull()
    expect(screen.queryByTestId('advanced-direct-deposit')).toBeNull()
    expect(screen.queryByTestId('advanced-recovery-signer')).toBeNull()
    expect(screen.queryByTestId('advanced-import')).toBeNull()
    expect(screen.getByTestId('advanced-agent-preview')).toBeTruthy()
  })
})

describe('WalletAdvanced — faucet (both account models)', () => {
  it('fires onGetUsdc and onFundXlm from their own buttons, once per click', () => {
    const onGetUsdc = vi.fn()
    const onFundXlm = vi.fn()
    render(
      <WalletAdvanced
        account={G_ACCOUNT}
        onBack={() => {}}
        onGetUsdc={onGetUsdc}
        onFundXlm={onFundXlm}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /get test usdc/i }))
    fireEvent.click(screen.getByRole('button', { name: /fund via friendbot/i }))
    expect(onGetUsdc).toHaveBeenCalledTimes(1)
    expect(onFundXlm).toHaveBeenCalledTimes(1)
  })

  it('omits Fund via Friendbot when the caller has no XLM-fund support for this account (Passkey)', () => {
    render(<WalletAdvanced account={C_ACCOUNT} onBack={() => {}} onGetUsdc={() => {}} />)
    expect(screen.queryByRole('button', { name: /fund via friendbot/i })).toBeNull()
    expect(screen.getByRole('button', { name: /get test usdc/i })).toBeTruthy()
  })
})

describe('WalletAdvanced — direct vault deposit (Passkey-only, gated on real support)', () => {
  it('is absent when the caller supplies no eligibility handler (e.g. Standard/G account)', () => {
    render(<WalletAdvanced account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.queryByTestId('advanced-direct-deposit')).toBeNull()
  })

  it('labels the section with the exact required copy', () => {
    render(<WalletAdvanced account={C_ACCOUNT} onBack={() => {}} onCheckEligibility={() => {}} />)
    expect(
      screen.getByRole('heading', {
        name: 'Advanced direct vault action — not the Pocket Crew route',
      })
    ).toBeTruthy()
  })

  it('disables Check eligibility until an amount is entered, and reports the typed amount', () => {
    const onDepositAmountChange = vi.fn()
    render(
      <WalletAdvanced
        account={C_ACCOUNT}
        onBack={() => {}}
        onCheckEligibility={() => {}}
        onDepositAmountChange={onDepositAmountChange}
      />
    )
    const checkBtn = screen.getByRole('button', { name: /check eligibility/i })
    expect(checkBtn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount (USDC)'), { target: { value: '5' } })
    expect(onDepositAmountChange).toHaveBeenCalledWith('5')
  })

  it('fires onCheckEligibility/onEnableDeposits from their own buttons', () => {
    const onCheckEligibility = vi.fn()
    const onEnableDeposits = vi.fn()
    render(
      <WalletAdvanced
        account={C_ACCOUNT}
        onBack={() => {}}
        depositAmount="5"
        onCheckEligibility={onCheckEligibility}
        onEnableDeposits={onEnableDeposits}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /check eligibility/i }))
    fireEvent.click(screen.getByRole('button', { name: /enable deposits/i }))
    expect(onCheckEligibility).toHaveBeenCalledTimes(1)
    expect(onEnableDeposits).toHaveBeenCalledTimes(1)
  })

  it('renders the eligibility verdict via ApproveOverlay and hides Check eligibility once a verdict exists', () => {
    const onApproveDeposit = vi.fn()
    const onRejectDeposit = vi.fn()
    render(
      <WalletAdvanced
        account={C_ACCOUNT}
        onBack={() => {}}
        onCheckEligibility={() => {}}
        depositVerdict={{ allow: true, reasons: [] }}
        onApproveDeposit={onApproveDeposit}
        onRejectDeposit={onRejectDeposit}
      />
    )
    expect(screen.queryByRole('button', { name: /^check eligibility$/i })).toBeNull()
    expect(screen.getByTestId('verdict').textContent).toMatch(/eligible/i)
    fireEvent.click(screen.getByRole('button', { name: /approve with face id/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onApproveDeposit).toHaveBeenCalledTimes(1)
    expect(onRejectDeposit).toHaveBeenCalledTimes(1)
  })
})

describe('WalletAdvanced — recovery signer (Passkey-only, gated on real support)', () => {
  it('is absent when the caller supplies no recovery handler (e.g. Standard/G account)', () => {
    render(<WalletAdvanced account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.queryByTestId('advanced-recovery-signer')).toBeNull()
  })

  it('disables Add recovery signer until an address is present, and reports typed input to the caller', () => {
    const onRecoveryAddressChange = vi.fn()
    render(
      <WalletAdvanced
        account={C_ACCOUNT}
        onBack={() => {}}
        recoveryAddress=""
        onRecoveryAddressChange={onRecoveryAddressChange}
        onAddRecoverySigner={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /add recovery signer/i }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Recovery G-address'), { target: { value: 'GXXXX' } })
    expect(onRecoveryAddressChange).toHaveBeenCalledWith('GXXXX')
  })

  it('enables Add recovery signer once the caller-controlled address is non-empty, and fires it once', () => {
    const onAddRecoverySigner = vi.fn()
    render(
      <WalletAdvanced
        account={C_ACCOUNT}
        onBack={() => {}}
        recoveryAddress="GXXXX"
        onAddRecoverySigner={onAddRecoverySigner}
      />
    )
    const button = screen.getByRole('button', { name: /add recovery signer/i })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onAddRecoverySigner).toHaveBeenCalledTimes(1)
  })

  it('shows the VF-custodied recovery honesty label', () => {
    render(<WalletAdvanced account={C_ACCOUNT} onBack={() => {}} onAddRecoverySigner={() => {}} />)
    expect(screen.getByTestId('honesty-recovery')).toBeTruthy()
  })
})

describe('WalletAdvanced — recovery/import for the Standard (G) account model, gated on real support', () => {
  it('is absent when the caller supplies no import handler (e.g. Passkey account)', () => {
    render(<WalletAdvanced account={C_ACCOUNT} onBack={() => {}} />)
    expect(screen.queryByTestId('advanced-import')).toBeNull()
  })

  it('shows a replace-this-wallet warning and the reused ImportScreen with its overridden heading', () => {
    const onImportWallet = vi.fn()
    render(<WalletAdvanced account={G_ACCOUNT} onBack={() => {}} onImportWallet={onImportWallet} />)
    const panel = screen.getByTestId('advanced-import')
    expect(within(panel).getByText(/replaces the wallet on this device/i)).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'Restore a different Standard wallet' })
    ).toBeTruthy()
  })
})

describe('WalletAdvanced — standalone agent-signer preview: structurally inert, always present', () => {
  it('renders the exact required warning', () => {
    render(<WalletAdvanced account={C_ACCOUNT} onBack={() => {}} />)
    expect(
      screen.getByText('Preview only — the required on-chain cap policy is not deployed')
    ).toBeTruthy()
  })

  it('renders no input and no button anywhere inside the preview (no Confirm/submit control)', () => {
    render(
      <WalletAdvanced
        account={C_ACCOUNT}
        onBack={() => {}}
        onCheckEligibility={() => {}}
        onAddRecoverySigner={() => {}}
      />
    )
    const panel = screen.getByTestId('advanced-agent-preview')
    expect(within(panel).queryAllByRole('button').length).toBe(0)
    expect(panel.querySelectorAll('input, textarea, select').length).toBe(0)
  })

  it('is present for both account models, unconditionally', () => {
    render(<WalletAdvanced account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.getByTestId('advanced-agent-preview')).toBeTruthy()
    render(<WalletAdvanced account={C_ACCOUNT} onBack={() => {}} />)
    expect(screen.getAllByTestId('advanced-agent-preview').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser guards (320px layout via the shared sweep320 helper -- VF Wallet Task 12, Part A1
// -- and items 5/6/7 as jsdom cannot compute any of them reliably): same launch mechanism
// WalletOnboarding.test.jsx's/WalletSettings.test.jsx's guards already use, reused verbatim
// rather than reinvented. sweep320 walks every element's own boundingClientRect (see
// sweep320.js's header) -- a strict superset of the document/`.pc-wallet` two-scrollWidth check
// this block used to hand-roll. This exact check already caught one real bug during this task
// (WalletSettings.jsx's "Manage Base testnet in Vibing Farmer" link at 350px .pc-wallet-
// scrollWidth before being de-buttoned -- see the task report).
// ---------------------------------------------------------------------------------------------
const ADVANCED_STATES = [
  [
    'faucet-both',
    <WalletAdvanced
      account={G_ACCOUNT}
      onBack={() => {}}
      onGetUsdc={() => {}}
      onFundXlm={() => {}}
    />,
  ],
  [
    'direct-deposit-with-verdict',
    <WalletAdvanced
      account={C_ACCOUNT}
      onBack={() => {}}
      depositAmount="5"
      onCheckEligibility={() => {}}
      onEnableDeposits={() => {}}
      depositVerdict={{ allow: true, reasons: ['under cap'] }}
      onApproveDeposit={() => {}}
      onRejectDeposit={() => {}}
    />,
  ],
  [
    'recovery-signer',
    <WalletAdvanced
      account={C_ACCOUNT}
      onBack={() => {}}
      recoveryAddress="GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY"
      onAddRecoverySigner={() => {}}
    />,
  ],
  [
    'restore-different-wallet',
    <WalletAdvanced account={G_ACCOUNT} onBack={() => {}} onImportWallet={() => {}} />,
  ],
  ['agent-preview-only', <WalletAdvanced account={C_ACCOUNT} onBack={() => {}} />],
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

describe('WalletAdvanced — real-browser 320px layout guard, per state', () => {
  it('creates no horizontal overflow at 320px for every state built (page-level and inside .pc-wallet)', async () => {
    const results = renderStates(ADVANCED_STATES)
    await sweep320(results, { logPrefix: 'WalletAdvanced' })
  }, 60000)
})

describe('WalletAdvanced — real-Chromium proof of rejection-checklist item 5 (jsdom cannot see this)', () => {
  it('no friendly copy outside .pc-technical/code/pre computes a JetBrains Mono font-family', async () => {
    const results = renderStates(ADVANCED_STATES)
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

describe('WalletAdvanced — real-Chromium proof of rejection-checklist items 6/7 (jsdom cannot see this)', () => {
  it('no element has a running (non-"none") animation in a real browser, in any state', async () => {
    const results = renderStates(ADVANCED_STATES)
    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildHarnessHtml(html))
        const animating = await page.evaluate(() =>
          Array.from(document.querySelectorAll('*'))
            .map((el) => getComputedStyle(el).animationName)
            .filter((name) => name && name !== 'none')
        )
        expect(animating, `${label}: entry/infinite animation found in real Chromium`).toEqual([])
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})
