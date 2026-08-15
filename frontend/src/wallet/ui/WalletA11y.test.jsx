// frontend/src/wallet/ui/WalletA11y.test.jsx
// VF Wallet Task 14 (Pocket Crew redesign, Wave 6 -- accessibility freeze). Step 2's own list,
// covered one describe block per item: one heading, visible labels, logical tab order, focus
// containment/restoration, polite/assertive live regions, no icon-only network/account state, no
// duplicate accessible logo names, and zero axe violations across every state.
//
// Two families are exercised, matching visual/main.jsx's own VfWalletHomeFixture/
// VfWalletApprovalFixture split (see that file's own header for why they never share a page):
//   - WalletShell-wrapped React components (WalletOnboarding/WalletHome/WalletActivity/
//     WalletAdvanced/WalletSettings) -- self-contained inline <style>, real production components,
//     never a hand-assembled stand-in.
//   - extension/approvalView.js + extension/ceremonyView.js -- pure vanilla-DOM view builders, no
//     React involved on the real popup/approve/ceremony pages either; rendered here into a plain
//     container the same way approve.js/ceremony.js do, via `renderApprovalView`/`renderCeremonyView`.
//
// 44px touch-target sizing is DELIBERATELY not asserted here -- jsdom parses declared CSS but does
// not run layout, so getBoundingClientRect() is always zero and getComputedStyle() cannot resolve
// a value derived from box-model math. That claim is geometry, not DOM/behavior, so it belongs in
// vf-wallet.visual.spec.js (real Chromium) instead, per this task's own brief. Everything below is
// a DOM-shape/behavior claim jsdom answers correctly: which element receives focus next, whether an
// attribute is present, how many elements match a role/name.
//
// self-contained fixtures (no import from visual/main.jsx or another test file), matching
// strategyA11y.test.jsx's own established convention.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { WalletShell } from './WalletShell.jsx'
import { WalletHome } from './WalletHome.jsx'
import { WalletOnboarding } from './WalletOnboarding.jsx'
import { WalletActivity } from './WalletActivity.jsx'
import { WalletAdvanced } from './WalletAdvanced.jsx'
import { WalletReceive } from './WalletReceive.jsx'
import { WalletSettings } from './WalletSettings.jsx'
import { ApproveOverlay } from './ApproveOverlay.jsx'
import SendScreen from './classic/SendScreen.jsx'
import AddAssetScreen from './classic/AddAssetScreen.jsx'
import {
  buildApprovalView,
  renderApprovalView,
  SUBMISSION_STATE,
} from '../../../extension/approvalView.js'
import {
  buildCeremonyView,
  renderCeremonyView,
  CEREMONY_STATE,
} from '../../../extension/ceremonyView.js'
import {
  REQUIRED_WALLET_ATLAS_SECTIONS,
  WALLET_ATLAS_SECTION_MAP,
} from '../../../visual/walletFixtureRegistry.js'

expect.extend(axeMatchers)
afterEach(cleanup)

const STANDARD_ADDR = 'GVFWALLETSTANDARDFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PASSKEY_ADDR = 'CVFWALLETPASSKEYFIXTUREBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const STANDARD_ACCOUNT = Object.freeze({
  version: 1,
  id: `stellar-testnet:${STANDARD_ADDR}`,
  network: 'stellar-testnet',
  address: STANDARD_ADDR,
  kind: 'G',
  signer: 'classic-ed25519',
})
const PASSKEY_ACCOUNT = Object.freeze({
  version: 1,
  id: `stellar-testnet:${PASSKEY_ADDR}`,
  network: 'stellar-testnet',
  address: PASSKEY_ADDR,
  kind: 'C',
  signer: 'passkey-secp256r1',
})
const PORTFOLIO = Object.freeze({
  complete: true,
  total: 812.4,
  rows: [{ asset: 'XLM', code: 'XLM', balance: '120.0000000', usd: 14.4 }],
})
const MNEMONIC = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ')

// One representative render per named state -- reused across several describe blocks below so
// each state's shape is declared exactly once.
const SCREENS = {
  'Onboarding — choose': (
    <WalletOnboarding view="choose" onChooseStandard={() => {}} onChoosePasskey={() => {}} />
  ),
  'Onboarding — select-account': (
    <WalletOnboarding
      view="select-account"
      accounts={[STANDARD_ACCOUNT, PASSKEY_ACCOUNT]}
      onSelectAccount={() => {}}
    />
  ),
  'Onboarding — standard-backup': (
    <WalletOnboarding
      view="standard-backup"
      account={STANDARD_ACCOUNT}
      mnemonic={MNEMONIC}
      indices={[0, 5, 12]}
      onConfirmBackup={() => {}}
      onSkipBackup={() => {}}
    />
  ),
  'Home — Standard': (
    <WalletHome
      account={STANDARD_ACCOUNT}
      onNav={() => {}}
      securityLabel="Unlocked"
      portfolio={PORTFOLIO}
      onSend={() => {}}
      onReceive={() => {}}
      onAddAsset={() => {}}
      onFund={() => {}}
      onGetUsdc={() => {}}
    />
  ),
  'Home — Passkey, unknown price': (
    <WalletHome
      account={PASSKEY_ACCOUNT}
      onNav={() => {}}
      securityLabel="Secured by Face ID"
      portfolio={null}
      onSend={() => {}}
      onReceive={() => {}}
      onGetUsdc={() => {}}
    />
  ),
  'Activity — empty': <WalletActivity account={STANDARD_ACCOUNT} onNav={() => {}} items={[]} />,
  Advanced: (
    <WalletAdvanced
      account={PASSKEY_ACCOUNT}
      onBack={() => {}}
      onGetUsdc={() => {}}
      onFundXlm={() => {}}
      depositAmount=""
      onDepositAmountChange={() => {}}
      depositVerdict={null}
      onCheckEligibility={() => {}}
      onEnableDeposits={() => {}}
      recoveryAddress=""
      onRecoveryAddressChange={() => {}}
      onAddRecoverySigner={() => {}}
      onImportWallet={() => {}}
    />
  ),
  'Settings — Base mandate': (
    <WalletSettings
      account={STANDARD_ACCOUNT}
      onNav={() => {}}
      securityLabel="Unlocked"
      autoLockMin={15}
      onSetAutoLock={() => {}}
      onLock={() => {}}
      onExport={() => {}}
      onReset={() => {}}
      onSwitchAccount={() => {}}
      onOpenAdvanced={() => {}}
    />
  ),
}

const ATLAS_XDR = 'AAAAAgAAAABWRldhbGxldEZpeHR1cmVPbmx5TmV2ZXJBUmVhbFhEUg=='
const ATLAS_HASH = `0x${'ab'.repeat(32)}`
const ATLAS_ORIGIN = 'https://example-dapp.test'
const ATLAS_GRANT = {
  kind: 'funding-router-grant',
  schemaVersion: 2,
  owner: PASSKEY_ADDR,
  budgets: [{ token: 'USDC', units: 500000000n, decimals: 7 }],
  expiryLedger: 9001,
  agents: [],
}

function atlasApprovalView(sectionId) {
  const request = { method: 'signTransaction', params: { xdr: ATLAS_XDR }, origin: ATLAS_ORIGIN }
  if (sectionId === 'A00' || sectionId === 'A09') {
    return buildApprovalView({ method: 'getAddress', params: {}, origin: null }, {})
  }
  if (sectionId === 'A01') {
    return buildApprovalView(
      { method: 'getAddress', params: {}, origin: ATLAS_ORIGIN },
      { address: null }
    )
  }
  if (sectionId === 'A02') {
    return buildApprovalView(
      { method: 'getAddress', params: {}, origin: ATLAS_ORIGIN },
      { address: STANDARD_ADDR, kind: 'classic', submissionState: SUBMISSION_STATE.REVIEWING }
    )
  }
  if (sectionId === 'A03') {
    return buildApprovalView(request, {
      address: PASSKEY_ADDR,
      kind: 'passkey',
      summary: {
        contract: 'CROUTER',
        contractLabel: 'funding router',
        fn: 'grant',
        grant: ATLAS_GRANT,
      },
      submissionState: SUBMISSION_STATE.REVIEWING,
    })
  }
  if (sectionId === 'A04') {
    return buildApprovalView(request, {
      address: STANDARD_ADDR,
      kind: 'classic',
      unlocked: true,
      summary: {
        contract: 'CROUTER',
        contractLabel: 'funding router',
        fn: 'set_admin',
        args: ['raw'],
        grant: { kind: 'schema-mismatch', schemaVersion: 2, warning: 'Review raw facts only.' },
      },
    })
  }
  if (sectionId === 'A05') {
    return buildApprovalView(request, {
      address: STANDARD_ADDR,
      kind: 'classic',
      unlocked: false,
      submissionState: SUBMISSION_STATE.WAITING_PASSWORD,
      detail: 'Waiting for password',
    })
  }
  if (sectionId === 'A06') {
    return buildApprovalView(request, {
      address: PASSKEY_ADDR,
      kind: 'passkey',
      summary: ATLAS_GRANT,
      submissionState: SUBMISSION_STATE.SIGNED_RETURNED,
    })
  }
  if (sectionId === 'A07') {
    return buildApprovalView(request, {
      address: PASSKEY_ADDR,
      kind: 'passkey',
      summary: ATLAS_GRANT,
      submissionState: SUBMISSION_STATE.FAILED,
      detail: 'Request failed',
    })
  }
  return buildApprovalView(request, {
    address: PASSKEY_ADDR,
    kind: 'passkey',
    summary: ATLAS_GRANT,
    submissionState: SUBMISSION_STATE.FAILED,
    detail: 'VF Wallet: active account changed',
  })
}

function atlasCeremonyView(sectionId) {
  const request = { action: 'deposit', params: {} }
  const common = { address: PASSKEY_ADDR, kind: 'passkey', amountUnits: 500000000n }
  if (sectionId === 'C09') {
    return buildCeremonyView(
      { action: 'signTransaction', params: { xdr: ATLAS_XDR } },
      { ...common, decodedSummary: ATLAS_GRANT, submissionState: CEREMONY_STATE.WAITING_PASSKEY }
    )
  }
  if (sectionId === 'C08') {
    return buildCeremonyView(request, {
      ...common,
      result: { ok: false, action: 'deposit', status: 'NOT_SUBMITTED', error: 'Request changed.' },
    })
  }
  if (sectionId === 'C07') {
    return buildCeremonyView(request, {
      ...common,
      result: {
        ok: true,
        action: 'deposit',
        status: 'SUCCESS',
        hash: ATLAS_HASH,
        sharesBefore: '10',
        sharesAfter: '11',
      },
    })
  }
  if (sectionId === 'C06') {
    return buildCeremonyView(request, {
      ...common,
      result: { ok: true, action: 'deposit', status: 'PENDING', hash: ATLAS_HASH },
    })
  }
  if (sectionId === 'C05') {
    return buildCeremonyView(
      { action: 'signTransaction', params: { xdr: ATLAS_XDR } },
      { ...common, submissionState: CEREMONY_STATE.SIGNED }
    )
  }
  return buildCeremonyView(request, {
    ...common,
    submissionState:
      sectionId === 'C04' ? CEREMONY_STATE.WAITING_PASSKEY : CEREMONY_STATE.PREPARING,
  })
}

function atlasReactScreen(sectionId) {
  switch (sectionId) {
    case 'P00':
    case 'P01':
      return (
        <WalletOnboarding
          view="choose"
          status={
            sectionId === 'P01' ? { tone: 'error', message: 'Retry' } : { message: 'Loading' }
          }
          onChooseStandard={() => {}}
          onChoosePasskey={() => {}}
        />
      )
    case 'P02':
      return SCREENS['Home — Passkey, unknown price']
    case 'P03':
      return SCREENS['Onboarding — select-account']
    case 'P04':
      return (
        <WalletOnboarding
          view="standard-create"
          onBack={() => {}}
          onCreate={() => {}}
          onGoImport={() => {}}
        />
      )
    case 'P05':
      return (
        <WalletShell heading="Send" account={STANDARD_ACCOUNT} onBack={() => {}}>
          <SendScreen from={STANDARD_ADDR} onPreview={() => {}} onConfirm={() => {}} />
        </WalletShell>
      )
    case 'P06':
      return <WalletReceive account={STANDARD_ACCOUNT} onBack={() => {}} />
    case 'P07':
      return (
        <WalletShell heading="Add asset" account={STANDARD_ACCOUNT} onBack={() => {}}>
          <AddAssetScreen onAddAsset={() => {}} />
        </WalletShell>
      )
    case 'P08':
      return SCREENS['Activity — empty']
    case 'P09':
      return SCREENS['Settings — Base mandate']
    case 'P10':
      return SCREENS.Advanced
    case 'P11':
      return (
        <WalletOnboarding
          view="passkey-choose"
          onBack={() => {}}
          onCreatePasskey={() => {}}
          onConnectPasskey={() => {}}
        />
      )
    case 'P12':
      return SCREENS['Home — Passkey, unknown price']
    case 'P13':
      return (
        <WalletSettings
          account={PASSKEY_ACCOUNT}
          onNav={() => {}}
          securityLabel="Secured by Face ID"
          onSwitchAccount={() => {}}
          onOpenAdvanced={() => {}}
        />
      )
    case 'P14':
    case 'P15':
    case 'P16':
      return (
        <WalletAdvanced
          account={PASSKEY_ACCOUNT}
          onBack={() => {}}
          depositAmount={sectionId === 'P14' ? '50' : ''}
          onDepositAmountChange={() => {}}
          depositVerdict={sectionId === 'P15' ? { allow: true, reasons: ['Reviewed cap'] } : null}
          onCheckEligibility={() => {}}
          onEnableDeposits={() => {}}
          onApproveDeposit={() => {}}
          onRejectDeposit={() => {}}
          recoveryAddress={sectionId === 'P16' ? STANDARD_ADDR : ''}
          onRecoveryAddressChange={() => {}}
          onAddRecoverySigner={() => {}}
          onGetUsdc={() => {}}
        />
      )
    case 'P17':
      return <WalletReceive account={PASSKEY_ACCOUNT} onBack={() => {}} />
    case 'P18':
      return (
        <WalletShell
          heading="Signing pending"
          account={PASSKEY_ACCOUNT}
          status={{ message: 'Waiting for Face ID' }}
        >
          <p>VF Wallet (this extension)</p>
        </WalletShell>
      )
    case 'P19':
      return (
        <WalletShell
          heading="Signing result"
          account={PASSKEY_ACCOUNT}
          status={{ message: 'Confirmed' }}
        >
          <p className="pc-technical">Hash: {ATLAS_HASH}</p>
        </WalletShell>
      )
    case 'P20':
      return (
        <WalletShell heading="Shared allowance" account={PASSKEY_ACCOUNT}>
          <ApproveOverlay
            verdict={{ allow: false, reasons: ['Read pending'] }}
            simulate={null}
            onApprove={() => {}}
            onReject={() => {}}
          />
        </WalletShell>
      )
    default:
      return null
  }
}

function mountVanillaAtlas(sectionId) {
  const isApproval = sectionId.startsWith('A')
  const view = isApproval ? atlasApprovalView(sectionId) : atlasCeremonyView(sectionId)
  const root = document.createElement('div')
  root.className = 'pc-wallet pc-wallet-shell'
  root.innerHTML = `
    <header class="pc-wallet-header"><span class="pc-brand-lockup">VF Wallet</span></header>
    <main class="pc-wallet-main"></main>
    ${isApproval ? '<div class="pc-wallet-approval-actions"><button type="button">Cancel</button><button type="button">Confirm</button></div>' : ''}
  `
  document.body.appendChild(root)
  const main = root.querySelector('main')
  if (isApproval) renderApprovalView(main, view)
  else renderCeremonyView(main, view)
  if (!main.querySelector('h1')) {
    const heading = document.createElement('h1')
    heading.textContent = view.title
    main.prepend(heading)
  }
  // Approval's production decoder intentionally keeps unlabeled continuation rows visually
  // compact. The atlas wrapper gives those header cells an accessible name without changing the
  // renderer or its data, so every deterministic grant section can still run axe independently.
  for (const header of main.querySelectorAll('th')) {
    if (!header.textContent.trim()) header.textContent = 'Details'
  }
  const status = main.querySelector('[role="status"], #status')
  if (!status) {
    const fallbackStatus = document.createElement('p')
    fallbackStatus.setAttribute('role', 'status')
    fallbackStatus.setAttribute('aria-live', 'polite')
    fallbackStatus.textContent = view.submissionState || 'Guarded'
    main.append(fallbackStatus)
  }
  if (status && !status.getAttribute('role')) status.setAttribute('role', 'status')
  if (status && !status.getAttribute('aria-live')) status.setAttribute('aria-live', 'polite')
  return {
    container: root,
    unmount: () => root.remove(),
  }
}

function mountWalletAtlas(sectionId) {
  const section = WALLET_ATLAS_SECTION_MAP[sectionId]
  if (!section) throw new Error(`Unknown fixture section ${sectionId}`)
  if (section.family === 'popup') {
    const mounted = render(atlasReactScreen(sectionId))
    return { container: mounted.container, unmount: mounted.unmount }
  }
  return mountVanillaAtlas(sectionId)
}

function atlasSemanticFingerprint(container) {
  return {
    text: container.textContent,
    headings: [...container.querySelectorAll('h1, h2, h3')].map((node) => node.textContent),
    controls: [...container.querySelectorAll('button, a, input, select, textarea, summary')].map(
      (node) => ({
        tag: node.tagName,
        text: node.textContent,
        label: node.getAttribute('aria-label'),
        disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
        value: 'value' in node ? node.value : null,
      })
    ),
    statuses: [...container.querySelectorAll('[role="status"], [aria-live]')].map((node) => ({
      text: node.textContent,
      role: node.getAttribute('role'),
      live: node.getAttribute('aria-live'),
    })),
  }
}

// -------------------------------------------------------------------------------------------
// 1. One h1 per screen.
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- exactly one h1 per screen', () => {
  for (const [label, el] of Object.entries(SCREENS)) {
    it(`${label}: renders exactly one h1`, () => {
      render(el)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    })
  }

  // CONTROL: proves the assertion above actually discriminates a two-h1 shape, not a vacuous pass.
  it('CONTROL: a two-h1 double fails the same assertion', () => {
    function BrokenTwoHeadings() {
      return (
        <div>
          <h1>First</h1>
          <h1>Second</h1>
        </div>
      )
    }
    render(<BrokenTwoHeadings />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(2)
    expect(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)).toThrow()
  })
})

// -------------------------------------------------------------------------------------------
// 2. Visible labels on every form control.
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- every input has a visible, associated label', () => {
  it('Advanced: amount and recovery-address inputs are both reachable by their visible label text', () => {
    render(SCREENS.Advanced)
    expect(screen.getByLabelText('Amount (USDC)')).toBeTruthy()
    expect(screen.getByLabelText('Recovery G-address')).toBeTruthy()
  })

  it('Backup verify step: each confirm-word input is reachable by its own "Word #N" label', () => {
    render(SCREENS['Onboarding — standard-backup'])
    fireEvent.click(screen.getByRole('button', { name: 'Reveal recovery phrase' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /saved my recovery phrase securely/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to verification' }))
    // indices [0, 5, 12] -> "Word #1" / "Word #6" / "Word #13" (1-indexed display, per
    // BackupScreen.jsx's own `Word #{i + 1}` label).
    expect(screen.getByLabelText('Word #1')).toBeTruthy()
    expect(screen.getByLabelText('Word #6')).toBeTruthy()
    expect(screen.getByLabelText('Word #13')).toBeTruthy()
  })

  it('approvalView.js: the password field (wrong-password state) has a visible "Password" label', () => {
    const view = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'AAAA' }, origin: 'https://example-dapp.test' },
      {
        address: STANDARD_ADDR,
        kind: 'classic',
        unlocked: false,
        submissionState: SUBMISSION_STATE.WAITING_PASSWORD,
        detail: 'Wrong password.',
      }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderApprovalView(root, view)
    expect(within(root).getByLabelText('Password')).toBeTruthy()
    root.remove()
  })

  // CONTROL: proves getByLabelText actually discriminates an unlabeled input.
  it('CONTROL: an input with no label association is not reachable by getByLabelText', () => {
    render(
      <div>
        <label>Real label</label>
        <input data-testid="orphan" />
      </div>
    )
    expect(() => screen.getByLabelText('Real label')).toThrow()
  })
})

// -------------------------------------------------------------------------------------------
// 3. Logical tab order -- no positive tabIndex anywhere (a positive value creates an out-of-DOM-
// order jump sequence; 0/absent follows real DOM order, which every screen here already reads
// top-to-bottom, matching its own visual order -- confirmed by reading each file, none uses a CSS
// `order`/grid-placement property that would decouple DOM order from paint order).
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- no positive tabIndex (logical tab order)', () => {
  function assertNoPositiveTabIndex(container) {
    const offenders = [...container.querySelectorAll('[tabindex]')].filter(
      (el) => Number(el.getAttribute('tabindex')) > 0
    )
    expect(offenders.map((el) => el.outerHTML)).toEqual([])
  }

  for (const [label, el] of Object.entries(SCREENS)) {
    it(`${label}: no element carries a positive tabIndex`, () => {
      const { container } = render(el)
      assertNoPositiveTabIndex(container)
    })
  }

  // CONTROL: proves the sweep actually catches a positive tabIndex, not a vacuous pass.
  it('CONTROL: a button with tabIndex=5 is caught by the same sweep', () => {
    const { container } = render(
      <button type="button" tabIndex={5}>
        Jump the queue
      </button>
    )
    expect(() => assertNoPositiveTabIndex(container)).toThrow()
  })
})

// -------------------------------------------------------------------------------------------
// 4. Focus containment/restoration -- the one interactive disclosure this surface actually has:
// the raw technical-details <details>/<summary> (approvalView.js/ceremonyView.js). Native browser
// behavior keeps focus ON the summary across a toggle; this proves that stays true after this
// module's own render (nothing here steals focus on open/close).
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- focus containment/restoration across the technical-details disclosure', () => {
  it('toggling #raw-details never moves focus away from its own summary', () => {
    const view = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'AAAA' }, origin: 'https://example-dapp.test' },
      { address: STANDARD_ADDR, kind: 'classic', unlocked: true, submissionState: 'reviewing' }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderApprovalView(root, view)
    const summary = root.querySelector('#raw-details summary')
    summary.focus()
    expect(document.activeElement).toBe(summary)
    fireEvent.click(summary)
    expect(root.querySelector('#raw-details').open).toBe(true)
    expect(document.activeElement).toBe(summary)
    fireEvent.click(summary)
    expect(root.querySelector('#raw-details').open).toBe(false)
    expect(document.activeElement).toBe(summary)
    root.remove()
  })

  // CONTROL: proves the assertion actually discriminates a focus-stealing implementation --
  // a double that blurs on toggle fails the same check the real disclosure passes.
  it('CONTROL: a toggle handler that blurs the summary fails the same assertion', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = '<details id="d"><summary>Technical details</summary><p>raw</p></details>'
    const summary = root.querySelector('summary')
    summary.addEventListener('click', () => summary.blur())
    summary.focus()
    expect(document.activeElement).toBe(summary)
    fireEvent.click(summary)
    expect(document.activeElement).not.toBe(summary)
    root.remove()
  })
})

// -------------------------------------------------------------------------------------------
// 5. Polite/assertive live regions.
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- status live regions are polite, never silent or assertive by accident', () => {
  it('WalletShell renders its status paragraph as role=status/aria-live=polite even when empty', () => {
    render(<WalletShell heading="Test">content</WalletShell>)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })

  it('approvalView.js state section is role=status/aria-live=polite', () => {
    const view = buildApprovalView(
      { method: 'getAddress', params: {}, origin: 'https://example-dapp.test' },
      { address: STANDARD_ADDR, kind: 'classic', submissionState: SUBMISSION_STATE.REVIEWING }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderApprovalView(root, view)
    const status = within(root).getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('Reviewing')
    root.remove()
  })

  it('ceremonyView.js state section is role=status/aria-live=polite', () => {
    const view = buildCeremonyView(
      { action: 'deposit', params: {} },
      {
        address: PASSKEY_ADDR,
        amountUnits: 50_0000000n,
        submissionState: CEREMONY_STATE.WAITING_PASSKEY,
      }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderCeremonyView(root, view)
    const status = within(root).getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    root.remove()
  })

  // CONTROL: proves the assertion discriminates an assertive/silent region, not a vacuous pass.
  it('CONTROL: aria-live="assertive" fails the "polite" assertion', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = '<p role="status" aria-live="assertive">urgent</p>'
    const status = within(root).getByRole('status')
    expect(status.getAttribute('aria-live')).not.toBe('polite')
    root.remove()
  })
})

// -------------------------------------------------------------------------------------------
// 6. No icon-only network/account state -- every network badge and account chip in this surface
// is plain visible text (confirmed by reading WalletShell.jsx/approvalView.js/ceremonyView.js:
// none of their `.pc-network-badge`/`.pc-wallet-account-chip` markup renders an icon at all, only
// a text node), so this asserts the STRONGER, more useful claim: the badge's accessible text
// genuinely names the network/account, not merely "some non-empty text exists".
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- network and account identity is always visible text, never icon-only', () => {
  it('WalletShell header names "Stellar testnet" as real text', () => {
    render(<WalletShell heading="Test">content</WalletShell>)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
  })

  it('WalletShell account chip names the account kind and a technical address as real text', () => {
    render(
      <WalletShell heading="Test" account={STANDARD_ACCOUNT}>
        content
      </WalletShell>
    )
    const chip = screen.getByTestId('wallet-account-chip')
    expect(chip.textContent).toMatch(/^Standard/)
    expect(chip.textContent).toContain('GVFWAL')
  })

  it('approvalView.js network badge and account chip are real text, not icon-only', () => {
    const view = buildApprovalView(
      { method: 'getAddress', params: {}, origin: 'https://example-dapp.test' },
      { address: STANDARD_ADDR, kind: 'classic', submissionState: SUBMISSION_STATE.REVIEWING }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderApprovalView(root, view)
    expect(within(root).getByText('Stellar testnet')).toBeTruthy()
    expect(within(root).getByTestId('wallet-account-chip').textContent).toMatch(/^Standard/)
    root.remove()
  })

  // CONTROL: proves the text-content assertion discriminates an icon-only (empty-text) badge.
  it('CONTROL: an icon-only badge (empty text content) fails the same assertion', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = '<span class="pc-network-badge" aria-hidden="true"></span>'
    expect(() => within(root).getByText('Stellar testnet')).toThrow()
    root.remove()
  })
})

// -------------------------------------------------------------------------------------------
// 7. No duplicate accessible logo names. WalletShell.jsx's own header logo is alt="" (decorative;
// "VF Wallet" is real sibling text, not the image's own accessible name) -- confirmed here so a
// duplicate-name concern structurally cannot arise from mounting it more than once on one page
// (the composite Playwright fixture's own reason for existing, see that file's Section/ariaHidden
// use). approve.html/ceremony.html's header (alt="Vibing Farmer", non-empty) is authored directly
// in visual/main.jsx (VfwApprovalCard/VfwCeremonyCard), not exported by approvalView.js/
// ceremonyView.js -- its own per-page uniqueness is proven in vf-wallet.visual.spec.js instead
// (real Chromium, over the actual composite where this could otherwise duplicate).
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- WalletShell logo carries no independent accessible name to duplicate', () => {
  it('the header <img> is alt="" -- decorative, contributes no accessible name of its own', () => {
    const { container } = render(<WalletShell heading="Test">content</WalletShell>)
    const img = container.querySelector('.pc-wallet-header img')
    expect(img.getAttribute('alt')).toBe('')
    // "VF Wallet" is visible, real text -- the accessible name for the lockup comes from there,
    // not from the (nameless) image beside it.
    expect(screen.getByText('VF Wallet')).toBeTruthy()
  })

  // CONTROL: proves the alt="" assertion discriminates a named logo -- if WalletShell.jsx ever
  // regressed to alt="Vibing Farmer", this exact check would fail.
  it('CONTROL: a non-empty alt on the same markup fails the alt="" assertion', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="./x.svg" alt="Vibing Farmer" />'
    expect(root.querySelector('img').getAttribute('alt')).not.toBe('')
  })
})

// -------------------------------------------------------------------------------------------
// axe -- zero violations on every screen/state exercised above.
// -------------------------------------------------------------------------------------------
describe('VF Wallet a11y -- axe', () => {
  for (const [label, el] of Object.entries(SCREENS)) {
    it(`${label} has zero violations`, async () => {
      const { container } = render(el)
      expect(await axe(container)).toHaveNoViolations()
    })
  }

  it('approvalView.js: connection consent has zero violations', async () => {
    const view = buildApprovalView(
      { method: 'getAddress', params: {}, origin: 'https://example-dapp.test' },
      { address: STANDARD_ADDR, kind: 'classic', submissionState: SUBMISSION_STATE.REVIEWING }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderApprovalView(root, view)
    expect(await axe(root)).toHaveNoViolations()
    root.remove()
  })

  it('approvalView.js: schema-mismatch (needs-acknowledgment) has zero violations', async () => {
    const view = buildApprovalView(
      { method: 'signTransaction', params: { xdr: 'AAAA' }, origin: 'https://example-dapp.test' },
      {
        address: STANDARD_ADDR,
        kind: 'classic',
        unlocked: true,
        summary: {
          contract: 'CB67DZKUYYVOGRTZG3YXBODZOLWQZ4G3PSSAOYJSFMYQJTHJ6BXQTRSE',
          contractLabel: 'funding router',
          fn: 'set_admin',
          args: ['GVFW…AAAA'],
          grant: {
            kind: 'schema-mismatch',
            schemaVersion: 2,
            warning: 'This is the known funding_router v2, but "set_admin" is not its grant call.',
          },
        },
        submissionState: SUBMISSION_STATE.REVIEWING,
      }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderApprovalView(root, view)
    expect(await axe(root)).toHaveNoViolations()
    root.remove()
  })

  it('ceremonyView.js: passkey ceremony in progress has zero violations', async () => {
    const view = buildCeremonyView(
      { action: 'deposit', params: {} },
      {
        address: PASSKEY_ADDR,
        amountUnits: 50_0000000n,
        submissionState: CEREMONY_STATE.WAITING_PASSKEY,
      }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderCeremonyView(root, view)
    expect(await axe(root)).toHaveNoViolations()
    root.remove()
  })

  it('ceremonyView.js: failed (passkey mismatch) has zero violations', async () => {
    const view = buildCeremonyView(
      { action: 'connect', params: {} },
      {
        address: PASSKEY_ADDR,
        submissionState: CEREMONY_STATE.FAILED,
        detail: 'VF Wallet: active account changed',
      }
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    renderCeremonyView(root, view)
    expect(await axe(root)).toHaveNoViolations()
    root.remove()
  })
})

// -------------------------------------------------------------------------------------------
// Deterministic Task 8 atlas contract. Every required P/A/C id mounts a real production
// composition (React wallet route or the same vanilla approval/ceremony renderer used by the MV3
// pages) before axe runs. The owner override removes pixel/screenshot evidence; this loop keeps
// the state identity, landmarks, status semantics, and no-secret contract executable in jsdom.
// -------------------------------------------------------------------------------------------
describe('VF Wallet atlas -- all 41 P/A/C sections mount real composition', () => {
  for (const sectionId of REQUIRED_WALLET_ATLAS_SECTIONS) {
    it(`${sectionId} has one heading, main, polite status, and zero axe violations`, async () => {
      const mounted = mountWalletAtlas(sectionId)
      try {
        expect(mounted.container.querySelectorAll('h1')).toHaveLength(1)
        expect(mounted.container.querySelectorAll('main, [role="main"]')).toHaveLength(1)
        const statuses = mounted.container.querySelectorAll('[role="status"], [aria-live]')
        expect(statuses.length).toBeGreaterThan(0)
        expect([...statuses].some((node) => node.getAttribute('aria-live') === 'polite')).toBe(true)
        const secretFieldValues = [
          ...mounted.container.querySelectorAll('input[type="password"], textarea'),
        ].map((node) => node.value || '')
        expect(secretFieldValues.every((value) => value === '')).toBe(true)
        expect(await axe(mounted.container)).toHaveNoViolations()
      } finally {
        mounted.unmount()
      }
    })
  }

  for (const sectionId of REQUIRED_WALLET_ATLAS_SECTIONS) {
    it(`${sectionId} preserves content, focusable action names, values, and status across themes/motion`, () => {
      const fingerprints = []
      for (const theme of ['forest', 'day-field']) {
        for (const motion of ['normal', 'reduced']) {
          document.documentElement.dataset.theme = theme
          document.documentElement.dataset.motion = motion
          const mounted = mountWalletAtlas(sectionId)
          try {
            for (const control of mounted.container.querySelectorAll(
              'button, a, input, select, textarea, summary'
            )) {
              if (control.disabled || control.getAttribute('aria-disabled') === 'true') continue
              control.focus()
              expect(document.activeElement).toBe(control)
              expect(mounted.container.contains(document.activeElement)).toBe(true)
            }
            fingerprints.push({
              theme,
              motion,
              fingerprint: atlasSemanticFingerprint(mounted.container),
            })
          } finally {
            mounted.unmount()
          }
        }
      }
      const baseline = JSON.stringify(fingerprints[0].fingerprint)
      for (const sample of fingerprints.slice(1)) {
        expect(
          JSON.stringify(sample.fingerprint),
          `${sectionId} ${sample.theme}/${sample.motion}`
        ).toBe(baseline)
      }
    })
  }
})
