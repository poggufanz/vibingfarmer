// frontend/src/wallet/ui/WalletOnboarding.test.jsx
// VF Wallet Task 9 -- rebuilds onboarding and account choice around human consequences. This is
// the composition-root test file (same role MyMoneyRoute.test.jsx plays for /agent): the full
// first-run journey, the "no secret material in shared state" structural proof, and the
// rejection-checklist self-check (items 5/6/7 + the decorative .net-dot/.marker.blink elements
// Task 8 deliberately deferred here) across the entire twelve-file shipped surface, including
// popup.jsx. Real-browser 320px layout and real-Chromium animation guards close the loop jsdom
// cannot see.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WalletOnboarding } from './WalletOnboarding.jsx'
import { launchRealChromium, buildHarnessHtml, sweep320 } from './testSupport/sweep320.js'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const POPUP_PATH = path.resolve(here, '../../../extension/popup.jsx')
const WALLET_CSS_PATH = path.resolve(here, '../../../extension/wallet.css')

function buildWalletHarnessHtml(bodyHtml) {
  return buildHarnessHtml(bodyHtml).replace(
    '</head>',
    `<style>${fs.readFileSync(WALLET_CSS_PATH, 'utf8')}</style></head>`
  )
}

// Real shape resolveActiveAccount emits for 'selection-required' (activeAccount.js:21-23,:114).
const G_ACCOUNT = {
  version: 1,
  id: 'stellar-testnet:GCLASSICWALLETADDRESSXXXXXX',
  network: 'stellar-testnet',
  address: 'GCLASSICWALLETADDRESSXXXXXX',
  kind: 'G',
  signer: 'classic-ed25519',
}
const C_ACCOUNT = {
  version: 1,
  id: 'stellar-testnet:CPASSKEYWALLETADDRESSXXXXXX',
  network: 'stellar-testnet',
  address: 'CPASSKEYWALLETADDRESSXXXXXX',
  kind: 'C',
  signer: 'passkey-secp256r1',
}
const PASSKEY_ACCOUNT = { kind: 'C', address: 'C' + 'A'.repeat(55) }

// Regex source-parse guards below check the SHIPPED CODE, not this task's own prose explaining
// what was removed and why (which legitimately names the retired identifiers, e.g. "the old
// btn-lava keyframe animation is removed") -- comments are stripped first so documentation can
// never accidentally fail its own guard.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// Extracts every `animation`/`animation-name` declaration's VALUE and returns the ones that are
// not the literal, non-load-bearing `none` reset. A naive `/animation\s*:(?!\s*none)/` regex is
// defeated by its own greedy `\s*` backtracking to a position before the whitespace that satisfies
// the lookahead trivially -- extracting and trimming the actual value sidesteps that entirely.
function nonNoneAnimationDeclarations(source) {
  return [...source.matchAll(/\banimation(?:-name)?\s*:\s*([^;}]+)/gi)]
    .map((m) =>
      m[1]
        .replace(/!important/i, '')
        .trim()
        .toLowerCase()
    )
    .filter((value) => value !== 'none')
}

const SHIPPED_UI_FILES = [
  path.resolve(here, './WalletShell.jsx'),
  path.resolve(here, './AccountPicker.jsx'),
  path.resolve(here, './WalletOnboarding.jsx'),
  path.resolve(here, './classic/OnboardingScreen.jsx'),
  path.resolve(here, './classic/CreateScreen.jsx'),
  path.resolve(here, './classic/ImportScreen.jsx'),
  path.resolve(here, './classic/BackupScreen.jsx'),
  path.resolve(here, './classic/UnlockScreen.jsx'),
]

describe('WalletOnboarding — first screen: the branch, before backup/recovery instructions diverge', () => {
  it('offers explicit Standard and Passkey choices without an address or cross-model jargon', () => {
    render(
      <WalletOnboarding view="choose" onChooseStandard={() => {}} onChoosePasskey={() => {}} />
    )
    expect(screen.getByRole('button', { name: /standard/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy()
    expect(screen.queryByText(/coordination swarm|session signer|seed/i)).toBeNull()
    expect(screen.queryByTestId('wallet-account-chip')).toBeNull()
  })

  it('says "Create or restore a wallet", "Stellar testnet", and explains Standard vs Passkey in plain language', () => {
    render(<WalletOnboarding view="choose" onChooseStandard={vi.fn()} onChoosePasskey={vi.fn()} />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create or restore a wallet' })
    ).toBeTruthy()
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Standard' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Passkey' })).toBeTruthy()
    expect(screen.getByText(/password you choose/i)).toBeTruthy()
    expect(screen.getByText(/Face ID, fingerprint/i)).toBeTruthy()
  })

  it('never surfaces backup/recovery-phrase specifics before a branch is chosen', () => {
    render(<WalletOnboarding view="choose" onChooseStandard={vi.fn()} onChoosePasskey={vi.fn()} />)
    expect(screen.queryByText(/write these 24 words/i)).toBeNull()
    expect(screen.queryByText(/starts with C/i)).toBeNull()
  })

  it('fires the exact callback for the branch chosen, never the other one', () => {
    const onChooseStandard = vi.fn()
    const onChoosePasskey = vi.fn()
    render(
      <WalletOnboarding
        view="choose"
        onChooseStandard={onChooseStandard}
        onChoosePasskey={onChoosePasskey}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use a Passkey wallet' }))
    expect(onChoosePasskey).toHaveBeenCalledTimes(1)
    expect(onChooseStandard).not.toHaveBeenCalled()
  })
})

describe('WalletOnboarding — Standard path: password unlock + recovery phrase, backup verified before completion', () => {
  it('names password + recovery phrase, and never completes on unverified words', () => {
    const mnemonic = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ')
    const onConfirmBackup = vi.fn()
    render(
      <WalletOnboarding
        view="standard-backup"
        mnemonic={mnemonic}
        indices={[0, 1, 2]}
        onConfirmBackup={onConfirmBackup}
        onSkipBackup={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reveal recovery phrase' }))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Save your recovery phrase' })
    ).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/saved my recovery phrase/i))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    // Every confirm input is left blank -- checkConfirm must reject this and onConfirm must not fire.
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }))
    expect(onConfirmBackup).not.toHaveBeenCalled()
  })
})

describe('WalletOnboarding — Passkey path: device/password-manager passkey, C-account behavior, honest recovery constraints', () => {
  it('does not claim Passkey funding before device confirmation', () => {
    render(<WalletOnboarding view="passkey-creating" account={PASSKEY_ACCOUNT} busy />)
    expect(screen.getByRole('status').textContent).toMatch(/waiting for your device confirmation/i)
    expect(screen.queryByText(/funded|confirmed|connected/i)).toBeNull()
    expect(screen.queryByText(/seed|mnemonic|password/i)).toBeNull()
  })

  it('states all three in plain language', () => {
    render(
      <WalletOnboarding
        view="passkey-choose"
        onCreatePasskey={vi.fn()}
        onConnectPasskey={vi.fn()}
      />
    )
    expect(screen.getByText(/device or password-manager passkey/i)).toBeTruthy()
    expect(screen.getByText(/starts with C/i)).toBeTruthy()
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy()
  })
})

describe('WalletOnboarding — both-account state opens AccountPicker before any address reaches the shell', () => {
  it('renders AccountPicker and no wallet-account-chip', () => {
    render(
      <WalletOnboarding
        view="select-account"
        accounts={[G_ACCOUNT, C_ACCOUNT]}
        onSelectAccount={vi.fn()}
      />
    )
    expect(screen.getByTestId('account-picker')).toBeTruthy()
    expect(screen.queryByTestId('wallet-account-chip')).toBeNull()
  })

  it('selecting an account calls onSelectAccount with the exact account chosen', () => {
    const onSelectAccount = vi.fn()
    render(
      <WalletOnboarding
        view="select-account"
        accounts={[G_ACCOUNT, C_ACCOUNT]}
        onSelectAccount={onSelectAccount}
      />
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this wallet' })[0])
    expect(onSelectAccount).toHaveBeenCalledWith(G_ACCOUNT)
  })
})

describe('WalletOnboarding — account type + shortened address stay visible in the shell once known', () => {
  it('standard-unlock shows the account chip for the wallet being unlocked', () => {
    render(
      <WalletOnboarding
        view="standard-unlock"
        publicKey="GABCDEFGHIJKLMNOPQRSTUVWXYZ"
        account={{ kind: 'G', address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ' }}
        onUnlock={vi.fn()}
      />
    )
    const chip = screen.getByTestId('wallet-account-chip')
    expect(chip.textContent).toContain('Standard')
    expect(chip.textContent).toContain('GABCDE')
  })
})

describe('WalletOnboarding — every actionable view keeps exactly one primary action visible', () => {
  const CASES = [
    [
      'standard-create with an error',
      {
        view: 'standard-create',
        createError: 'Something went wrong',
        onCreate: vi.fn(),
        onGoImport: vi.fn(),
      },
    ],
    [
      'standard-create while busy',
      { view: 'standard-create', createBusy: true, onCreate: vi.fn(), onGoImport: vi.fn() },
    ],
    [
      'standard-import with an error',
      { view: 'standard-import', importError: 'Bad input', onImport: vi.fn() },
    ],
    [
      'standard-unlock with an error',
      {
        view: 'standard-unlock',
        unlockError: 'Wrong password.',
        onUnlock: vi.fn(),
        publicKey: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      },
    ],
    [
      'passkey-choose with an error (cancel path)',
      {
        view: 'passkey-choose',
        passkeyError: 'No wallet found.',
        onCreatePasskey: vi.fn(),
        onConnectPasskey: vi.fn(),
      },
    ],
  ]

  it.each(CASES)('%s exposes exactly one primary button', (_label, props) => {
    render(<WalletOnboarding {...props} />)
    expect(document.querySelectorAll('.pc-button--primary').length).toBe(1)
  })
})

describe('WalletOnboarding — success routes to the real handler that selects the created/restored account', () => {
  // WalletOnboarding forwards straight through to the real onCreate/onImport/onCreatePasskey/
  // onConnectPasskey callbacks -- the actual "selects the exact created/restored account"
  // guarantee lives in classicAccount.js/account.js (createClassicWallet/importFromSecret/
  // importFromMnemonic/createPasskeyWallet/connectPasskeyWallet all call selectActiveAccount --
  // see activeAccount.js's own "deliberate switch" comments), proven by their own unmodified,
  // still-green test suites. This proves WalletOnboarding actually wires the click to that real
  // callback rather than an inert stub.
  it('Create wallet calls the injected onCreate with the entered label and password', () => {
    const onCreate = vi.fn()
    render(<WalletOnboarding view="standard-create" onCreate={onCreate} onGoImport={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-strong-password' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'a-strong-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create wallet' }))
    expect(onCreate).toHaveBeenCalledWith('Main', 'a-strong-password')
  })

  it('Create new wallet (passkey) calls the injected onCreatePasskey exactly once', () => {
    const onCreatePasskey = vi.fn()
    render(
      <WalletOnboarding
        view="passkey-choose"
        onCreatePasskey={onCreatePasskey}
        onConnectPasskey={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create new wallet' }))
    expect(onCreatePasskey).toHaveBeenCalledTimes(1)
  })
})

describe('WalletOnboarding — secret material cannot reach shared state (structural)', () => {
  const SOURCE = stripComments(
    fs.readFileSync(path.resolve(here, './WalletOnboarding.jsx'), 'utf8')
  )

  // WalletOnboarding is a pure router: no hook that could accumulate state exists in this file at
  // all, so there is no shared/context/module-level slot here a secret could land in even by
  // accident -- mnemonic/publicKey pass straight through, untouched, to BackupScreen/UnlockScreen,
  // which already keep them in transient, per-render React state only (unchanged by this task).
  it('holds no state of its own — no useState/useEffect/useReducer/useContext anywhere in this file', () => {
    expect(SOURCE).not.toMatch(/\buseState\b|\buseEffect\b|\buseReducer\b|\buseContext\b/)
  })

  it('never references seed/secret/password/session-key identifiers directly', () => {
    const forbidden = /\b(mnemonicBlob|seedPhrase|secretKey|privateKey|sessionKey)\b/i
    expect(SOURCE).not.toMatch(forbidden)
  })

  it('never renders mnemonic text in account-choice or Passkey screens', () => {
    const mnemonic = 'alpha bravo charlie delta echo foxtrot'
    const { unmount } = render(
      <WalletOnboarding
        view="select-account"
        accounts={[{ ...G_ACCOUNT, mnemonic }]}
        onSelectAccount={() => {}}
      />
    )
    expect(screen.queryByText(mnemonic)).toBeNull()
    unmount()

    render(
      <WalletOnboarding
        view="passkey-choose"
        mnemonic={mnemonic}
        onCreatePasskey={() => {}}
        onConnectPasskey={() => {}}
      />
    )
    expect(screen.queryByText(mnemonic)).toBeNull()
  })
})

describe('WalletOnboarding — rejection checklist items 5/6/7 across the entire shipped surface (source-parse, mutation-provable)', () => {
  it('item 7: none of the rebuilt onboarding screens declares an entry keyframe animation', () => {
    for (const file of SHIPPED_UI_FILES) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      expect(source, `${file} must declare no @keyframes`).not.toMatch(/@keyframes/i)
      // `animation: none !important` (the documented, non-load-bearing [data-pocket-critical]
      // reset) is explicitly allowed; any OTHER animation value is not.
      expect(
        nonNoneAnimationDeclarations(source),
        `${file} must declare no animation value other than none`
      ).toEqual([])
    }
  })

  it('item 6: none of the rebuilt onboarding screens sets a gradient', () => {
    for (const file of SHIPPED_UI_FILES) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      expect(source, `${file} must declare no gradient`).not.toMatch(/gradient/i)
    }
  })

  it('item 6: no rebuilt onboarding screen hardcodes a design value via inline style', () => {
    for (const file of SHIPPED_UI_FILES) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      expect(source, `${file} must set no inline style=`).not.toMatch(/style=/i)
    }
  })

  it('uses one explicit class for each backup progress state', () => {
    const source = stripComments(
      fs.readFileSync(path.resolve(here, './classic/BackupScreen.jsx'), 'utf8')
    )
    expect(source).toMatch(/pc-backup-progress--one/)
    expect(source).toMatch(/pc-backup-progress--two/)
    expect(source).toMatch(/pc-backup-progress--three/)
  })

  // The exact regressions VF Wallet Task 8 (73802e8) deliberately deferred to this task:
  // popup.jsx's shared CSS carried an entry-fade keyframe applied to every .vf-screen (item 7) and
  // an infinite gradient animation on the primary button (item 6). Run against the pre-fix tree,
  // these assertions were genuinely red (not synthetic) -- confirmed while writing this guard.
  // `screenIn`/`btn-lava` are checked file-wide (their @keyframes definitions and every usage must
  // both be gone); the gradient/infinite check is scoped to the actual button rules. Fix loop 1
  // (M1) also flattened the one surviving non-button gradient (.vf-token-icon.unknown's fallback
  // avatar background) to a solid color -- see the dedicated assertion below -- so popup.jsx now
  // declares no gradient anywhere, not just off of buttons.
  it('popup.jsx no longer declares the screenIn entry animation or the infinite btn-lava button animation', () => {
    const source = stripComments(fs.readFileSync(POPUP_PATH, 'utf8'))
    expect(source).not.toMatch(/\bscreenIn\b/i)
    expect(source).not.toMatch(/\bbtn-lava\b/i)
    const buttonRules = ['.btn-primary', '.vf-btn.primary', '.btn-ghost', '.vf-btn.ghost']
      .map((selector) => {
        const escaped = selector.replace(/[.]/g, '\\.')
        const re = new RegExp(`${escaped}[a-zA-Z:().-]*\\{[^}]*\\}`, 'g')
        return source.match(re)?.join('\n') ?? ''
      })
      .join('\n')
    expect(buttonRules).not.toMatch(/gradient/i)
    expect(buttonRules).not.toMatch(/infinite/i)
  })

  // M1 (VF Wallet Task 9 fix loop 1): the contract's non-negotiable visual signature bans
  // gradients outright ("No gradients, glow, glass blur..."), not just on buttons. The one
  // surviving gradient in the extension (.vf-token-icon.unknown's fallback avatar background) is
  // flattened to a solid color -- popup.jsx now declares no gradient anywhere in its CSS.
  it('M1: popup.jsx declares no gradient anywhere, not just off of buttons', () => {
    const source = stripComments(fs.readFileSync(POPUP_PATH, 'utf8'))
    expect(source).not.toMatch(/gradient/i)
  })

  // Decorative net-dot and blinking marker elements Task 8 also deferred here.
  it('popup.jsx no longer renders the decorative net-dot dot or the blinking marker element', () => {
    const source = stripComments(fs.readFileSync(POPUP_PATH, 'utf8'))
    expect(source).not.toMatch(/net-dot/i)
    expect(source).not.toMatch(/marker\s+blink/i)
    expect(source).not.toMatch(/@keyframes\s+blink\b/i)
  })

  // Item 5: the specific popup.jsx regression Task 8 deferred -- the shared .pending status line
  // (used by the passkey creating/signing-pending/loading screens) set font-family:var(--mono) on
  // plain English status text ("working…", "loading…", ceremony status). Scoped to the
  // .pending{...} rule itself so this can never false-positive on the many correct,
  // contract-required mono rules elsewhere (.mono/.addr/.pc-technical) that legitimately style
  // real technical/secret data. Not comment-stripped: this checks the literal CSS rule text.
  it('item 5: popup.jsx no longer styles the shared friendly status line in monospace', () => {
    const source = fs.readFileSync(POPUP_PATH, 'utf8')
    const pendingRule = source.match(/\.pending\{[^}]*\}/)?.[0] ?? ''
    expect(pendingRule).not.toMatch(/font-family:\s*var\(--mono\)/i)
  })

  it('item 5: friendly onboarding copy never renders inside a monospace/technical wrapper', () => {
    render(<WalletOnboarding view="passkey-creating" />)
    const status = screen.getByText('Waiting for your device confirmation')
    expect(status.closest('.pc-technical')).toBeNull()
    const body = screen.getByText(/passkey prompt on your device/i)
    expect(body.closest('.pc-technical')).toBeNull()
  })

  it('no file in the shipped surface names Coordination Swarm, ed25519 session-key, or Gasless Relaying as primary copy', () => {
    for (const file of [...SHIPPED_UI_FILES, POPUP_PATH]) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      expect(source, `${file} must not name Coordination Swarm`).not.toMatch(/Coordination Swarm/i)
      expect(source, `${file} must not name "ed25519 session-key"`).not.toMatch(
        /ed25519 session-key/i
      )
      expect(source, `${file} must not name Gasless Relaying`).not.toMatch(/Gasless Relaying/i)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser guards (320px layout via the shared sweep320 helper -- VF Wallet Task 12, Part A1
// -- plus items 6/7 as jsdom cannot compute either): same launch mechanism MyMoneyRoute.test.jsx's/
// PlanStage.test.jsx's G1 guard already use, reused verbatim rather than reinvented. WalletShell
// carries its own <style> (popup.html loads neither wallet.css nor pocket-crew.css -- see
// WalletShell.jsx's header), so `container.innerHTML` after a render already includes the real,
// complete stylesheet -- no separate CSS file to concatenate.
// ---------------------------------------------------------------------------------------------
const ONBOARDING_STATES = [
  ['choose', { view: 'choose', onChooseStandard: () => {}, onChoosePasskey: () => {} }],
  [
    'select-account',
    { view: 'select-account', accounts: [G_ACCOUNT, C_ACCOUNT], onSelectAccount: () => {} },
  ],
  ['standard-create', { view: 'standard-create', onCreate: () => {}, onGoImport: () => {} }],
  ['standard-import', { view: 'standard-import', onImport: () => {} }],
  [
    'standard-backup',
    {
      view: 'standard-backup',
      mnemonic: Array.from({ length: 24 }, (_, i) => `word${i}`).join(' '),
      indices: [0, 5, 12],
      onConfirmBackup: () => {},
      onSkipBackup: () => {},
    },
  ],
  [
    'standard-unlock',
    { view: 'standard-unlock', publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ', onUnlock: () => {} },
  ],
  [
    'passkey-choose',
    { view: 'passkey-choose', onCreatePasskey: () => {}, onConnectPasskey: () => {} },
  ],
  ['passkey-creating', { view: 'passkey-creating' }],
  ['passkey-create', { view: 'passkey-create', account: PASSKEY_ACCOUNT, busy: true }],
  ['passkey-error', { view: 'passkey-error', passkeyError: 'Passkey unavailable' }],
]

describe('WalletOnboarding — real-browser 320px layout guard, per onboarding/account-picker state', () => {
  it('creates no horizontal overflow at 320px for every state built', async () => {
    const results = []
    for (const [label, props] of ONBOARDING_STATES) {
      const { container, unmount } = render(<WalletOnboarding {...props} />)
      results.push([label, container.innerHTML])
      unmount()
    }
    await sweep320(results, { logPrefix: 'WalletOnboarding' })
  }, 60000)
})

describe('WalletOnboarding — real-Chromium proof of rejection-checklist item 5 (jsdom cannot see this)', () => {
  // VF Wallet Task 9 fix loop 1: HonestyLabels.jsx applied a hardcoded JetBrains Mono
  // font-family to six friendly-prose <p> elements. Two of them (the testnet/protocol labels)
  // rendered in mono on 5 of 8 states in real Chromium, with no .pc-technical ancestor -- the
  // exact rejection-checklist item 5 condition ("Body or friendly copy uses monospace"). jsdom's
  // getComputedStyle cannot resolve font-family reliably (same trap items 6/7 hit above), so this
  // is measured the same way: real Chromium, across every one of the eight onboarding states.
  it('no text outside .pc-technical/code/pre computes a JetBrains Mono font-family, in any of the 8 states', async () => {
    const results = []
    for (const [label, props] of ONBOARDING_STATES) {
      const { container, unmount } = render(<WalletOnboarding {...props} />)
      results.push([label, container.innerHTML])
      unmount()
    }

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildWalletHarnessHtml(html))
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

describe('WalletOnboarding — real-Chromium proof of rejection-checklist items 6/7 (jsdom cannot see this)', () => {
  it('no element in any critical view has a running (non-"none") animation in a real browser', async () => {
    const criticalLabels = [
      'standard-create',
      'standard-import',
      'standard-backup',
      'standard-unlock',
      'passkey-creating',
    ]
    const results = []
    for (const [label, props] of ONBOARDING_STATES) {
      if (!criticalLabels.includes(label)) continue
      const { container, unmount } = render(<WalletOnboarding {...props} />)
      results.push([label, container.innerHTML])
      unmount()
    }

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildWalletHarnessHtml(html))
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

// VF Wallet Task 9 fix loop 2 (I2 re-opened): WalletShell.jsx's <style> omitted the contract's
// `h1,h2,h3,button,input,select,textarea { font-family: var(--pc-font-body) }` (contract :199-207)
// and `color-scheme: dark` (contract :39) entirely -- form controls do not inherit font-family, so
// every button computed the UA default face (Arial) against Geist body text, and native controls
// (e.g. BackupScreen.jsx:84's checkbox) rendered light-themed on the dark surface. jsdom cannot
// resolve font-family reliably (the same trap the item-5 mono guard above documents), so this is
// measured the same way: real Chromium, across all 8 onboarding states. This also proves the fix
// did NOT regress the one thing that made the naive fix wrong during development: a plain
// `.pc-wallet button/input/...` selector outranks `.pc-technical` alone on specificity and would
// have silently switched the secret-key/mnemonic textarea (ImportScreen.jsx) and the
// recovery-phrase confirmation inputs (BackupScreen.jsx) from mono to Geist -- caught empirically
// before shipping, fixed with `:where()` (see WalletShell.jsx's comment on the rule).
describe('WalletOnboarding — real-Chromium proof of the I2 fix loop 2 rules (font-family, color-scheme)', () => {
  it('every button/input/select/textarea computes the Geist body face, except .pc-technical ones which stay mono, in all 8 states', async () => {
    const results = []
    for (const [label, props] of ONBOARDING_STATES) {
      const { container, unmount } = render(<WalletOnboarding {...props} />)
      results.push([label, container.innerHTML])
      unmount()
    }

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildWalletHarnessHtml(html))
        const offenders = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, input, select, textarea'))
            .map((el) => ({
              tag: el.tagName,
              technical:
                Boolean(el.closest('.pc-technical')) || el.classList.contains('pc-technical'),
              fontFamily: getComputedStyle(el).fontFamily,
            }))
            .filter((entry) =>
              entry.technical
                ? !/jetbrains mono/i.test(entry.fontFamily)
                : !/geist/i.test(entry.fontFamily)
            )
        )
        expect(offenders, `${label}: wrong font-family face`).toEqual([])
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)

  it('the wallet surface computes color-scheme: dark in all 8 states', async () => {
    const results = []
    for (const [label, props] of ONBOARDING_STATES) {
      const { container, unmount } = render(<WalletOnboarding {...props} />)
      results.push([label, container.innerHTML])
      unmount()
    }

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildWalletHarnessHtml(html))
        const colorScheme = await page.evaluate(
          () => getComputedStyle(document.querySelector('.pc-wallet')).colorScheme
        )
        expect(colorScheme, `${label}: .pc-wallet color-scheme`).toBe('dark')
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})
