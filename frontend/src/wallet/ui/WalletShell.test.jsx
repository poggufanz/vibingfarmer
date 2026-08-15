// frontend/src/wallet/ui/WalletShell.test.jsx
// VF Wallet Task 9. WalletShell is the shared 360px onboarding/account-choice shell: a small
// product lockup, visible "Stellar testnet", a current-account chip, one heading, predictable
// back placement, and a polite status region.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { WalletShell } from './WalletShell.jsx'
import {
  parseCss,
  selectorTokens,
  checkManifestFreshness,
} from '../../../scripts/generate-wallet-contract-manifest.mjs'
import { NETWORK_IDS, getNetworkMeta } from '../../design/networks.js'
import CONTRACT_MANIFEST from './walletContractManifest.generated.json'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
// Normalized once here (CRLF -> LF) so every LF-literal marker/slice below (e.g. the
// `` `\n\nexport function WalletShell` `` marker in shippedStyleRules()) matches regardless of
// whether this checkout has the component file checked out with CRLF or LF line endings.
const RAW_SOURCE = fs
  .readFileSync(path.resolve(here, './WalletShell.jsx'), 'utf8')
  .replace(/\r\n/g, '\n')
const WALLET_CSS = fs
  .readFileSync(path.resolve(here, '../../../extension/wallet.css'), 'utf8')
  .replace(/\r\n/g, '\n')
// Structural/checklist guards below check the SHIPPED CODE, not this file's own header comment
// (which legitimately names the properties it structurally lacks, e.g. "no password prop") --
// comments are stripped first so documentation can never accidentally fail its own guard.
const SOURCE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('WalletShell — trust anchor, network text, heading, account chip', () => {
  it('renders exactly one h1 with the given heading', () => {
    render(<WalletShell heading="Create or restore a wallet">content</WalletShell>)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create or restore a wallet' })
    ).toBeTruthy()
    expect(document.querySelectorAll('h1').length).toBe(1)
  })

  // 2026-08-02 compact pass: headingHidden must keep the h1 in the accessibility tree (the
  // WalletA11y.test.jsx exactly-one-h1 freeze still counts it) while opting out of painting it.
  it('headingHidden keeps the h1 in the tree but marks it visually hidden', () => {
    render(
      <WalletShell heading="Home" headingHidden>
        content
      </WalletShell>
    )
    const h1 = screen.getByRole('heading', { level: 1, name: 'Home' })
    expect(h1.className).toBe('pc-visually-hidden')
  })

  it('renders a visible (unclassed) h1 by default', () => {
    render(<WalletShell heading="Home">content</WalletShell>)
    expect(screen.getByRole('heading', { level: 1, name: 'Home' }).className).toBe('')
  })

  it('always shows the literal Stellar testnet network text', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.getByText(getNetworkMeta(NETWORK_IDS.STELLAR_TESTNET).label)).toBeTruthy()
  })

  it('shows a small product lockup naming VF Wallet', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.getByText('VF Wallet')).toBeTruthy()
  })

  it('shows no account chip before any account is selected', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.queryByTestId('wallet-account-chip')).toBeNull()
  })

  it('shows the account type and a shortened (not full) address once an account is known', () => {
    render(
      <WalletShell heading="x" account={{ kind: 'G', address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ' }}>
        content
      </WalletShell>
    )
    const chip = screen.getByTestId('wallet-account-chip')
    expect(chip.textContent).toContain('Standard')
    expect(chip.textContent).toContain('GABCDE')
    expect(chip.textContent).not.toContain('GABCDEFGHIJKLMNOPQRSTUVWXYZ')
  })

  it('labels a passkey (C) account as Passkey, not the raw kind code', () => {
    render(
      <WalletShell heading="x" account={{ kind: 'C', address: 'CZYXWVUTSRQPONMLKJIHGFEDCBA' }}>
        content
      </WalletShell>
    )
    expect(screen.getByTestId('wallet-account-chip').textContent).toContain('Passkey')
    expect(screen.getByTestId('wallet-account-chip').textContent).not.toMatch(/\bC\b/)
  })
})

describe('WalletShell — predictable back placement', () => {
  it('renders no back control by default', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('renders a Back button that fires onBack exactly once per click', () => {
    const onBack = vi.fn()
    render(
      <WalletShell heading="x" onBack={onBack}>
        content
      </WalletShell>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('WalletShell — polite status region', () => {
  it('always renders a polite live region, even with nothing to say', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })

  it('renders structural output without an injected style tag', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(document.querySelector('.pc-wallet style')).toBeNull()
  })

  it('shows a status message and marks the error tone', () => {
    render(
      <WalletShell heading="x" status={{ tone: 'error', message: 'Wrong password.' }}>
        content
      </WalletShell>
    )
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Wrong password.')
    expect(status.getAttribute('data-tone')).toBe('error')
  })
})

describe('WalletShell — secret material cannot reach this component (structural)', () => {
  it('renders whatever children it is given without inspecting or transforming them', () => {
    render(
      <WalletShell heading="x">
        <p data-testid="child">just a child</p>
      </WalletShell>
    )
    expect(screen.getByTestId('child')).toBeTruthy()
  })

  // Structural, not behavioral: the real component signature (read from source, not mocked) has
  // no prop shaped to carry a phrase/secret/session key at all -- `account` is fixed to the public
  // activeAccount.js shape (activeAccount.js:21-23: version/id/network/address/kind/signer),
  // which never includes any of those fields, so there is nowhere for one to travel through.
  it('the component source never references seed/secret/password/session-key identifiers', () => {
    const forbidden = /\b(mnemonic|seedPhrase|secretKey|privateKey|sessionKey|password)\b/i
    expect(SOURCE).not.toMatch(forbidden)
  })
})

describe('WalletShell — rejection-checklist items 6/7 (source-parse, mutation-provable)', () => {
  // jsdom always reports getComputedStyle(...).animationName as "none" for the animation
  // SHORTHAND regardless of the declared value (same finding MyMoneyRoute.test.jsx's/
  // PlanStage.test.jsx's I6 guards document) -- a jsdom computed-style assertion cannot see an
  // entry animation or an infinite button animation here. This reads the real shipped source
  // text instead, the same mechanism those guards use. WalletOnboarding.test.jsx additionally
  // proves this in a real Chromium instance.
  it('defines no keyframes, animation, or gradient declarations', () => {
    expect(SOURCE).not.toMatch(/@keyframes/i)
    // `animation: none !important` (the documented, non-load-bearing [data-pocket-critical]
    // reset) is explicitly allowed; any OTHER animation value is not. Extracting and trimming the
    // actual declared value (rather than a `(?!none)` lookahead, which a greedy `\s*` right before
    // it can backtrack around) is what makes this check reliable.
    const nonNoneAnimations = [...SOURCE.matchAll(/\banimation(?:-name)?\s*:\s*([^;}]+)/gi)]
      .map((m) =>
        m[1]
          .replace(/!important/i, '')
          .trim()
          .toLowerCase()
      )
      .filter((value) => value !== 'none')
    expect(nonNoneAnimations).toEqual([])
    expect(SOURCE).not.toMatch(/gradient/i)
  })

  it('never sets an inline style attribute', () => {
    expect(SOURCE).not.toMatch(/style=/i)
  })
})

// VF Wallet Task 10, Part A1 (owner-directed fix for the VF Wallet Task 9 reviewer's follow-up
// finding): the hand-pinned CONTRACT_PORTED_RULES list this guard used through fix loop 2 had the
// SAME blind spot as the two-rule bug it was built to catch, one level up -- a list a human must
// remember to extend can never notice the 26th selector nobody added to it. This guard is now
// driven by walletContractManifest.generated.json, a manifest GENERATED by parsing the actual
// contract text (scripts/generate-wallet-contract-manifest.mjs -- see its header for the full
// design), not hand-transcribed. Regenerating that manifest after a contract change picks up any
// new `.pc-wallet`-scoped rule automatically; this test then fails BY NAME (`ports <id>`) for any
// entry with no shipped counterpart.
//
// The guard and the manifest share the exact same CSS mini-parser (parseCss/selectorTokens,
// imported from the generator script, never reimplemented here) so the two can never drift apart
// by disagreeing about what "a CSS rule" or "a matching selector" means.
//
// Matching is structural, not byte-verbatim (unlike the old guard): a manifest entry has a shipped
// counterpart when some shipped rule, in the SAME media context, shares at least one selector
// token with it (selectorTokens() strips the `.pc-wallet` scope prefix and unwraps `:where()`
// first, so `.pc-wallet :where(h1, ..., textarea)` still matches contract's bare
// `h1, ..., textarea`) and declares the same property (margin-top/right/bottom/left and
// padding-* count as satisfied by the base `margin`/`padding` shorthand, the one legitimate
// same-value-different-property-name case in this file, `.pc-wallet h1`'s `margin` vs the
// contract's `margin-bottom`). This intentionally checks PRESENCE (the property is declared
// somewhere applicable), not exact value equality -- exact values are a separate, harder problem
// (contractTokens.test.js already owns token values; VF Wallet Task 9 fix loop 1's manual census
// already covers this file's declared values) and value-diffing would reintroduce false positives
// for legitimate partial ports (the brand lockup only ever renders `<img>` logos -- the
// bottom-nav tab icons added in the 2026-08-02 compact pass are inline `<svg>`, but no manifest
// entry targets them -- so `.pc-brand-lockup img, .pc-brand-lockup svg` is satisfied by the `img`
// half alone). Presence
// is exactly what the two historical bugs needed and didn't have: the font-family and
// color-scheme rules were not "wrong value," they were ABSENT.
describe('WalletShell — contract manifest drift guard: every manifest entry has a shipped counterpart (VF Wallet Task 10, Part A1)', () => {
  function shippedStyleRules() {
    return parseCss(WALLET_CSS)
  }

  const baseProp = (prop) => {
    const m = prop.match(/^(margin|padding|border)-(top|right|bottom|left)$/)
    return m ? m[1] : prop
  }

  function hasShippedCounterpart(entry, shipped) {
    return shipped.some((rule) => {
      if ((entry.media ?? null) !== (rule.media ?? null)) return false
      const ruleTokens = selectorTokens(rule.selector)
      if (!entry.tokens.some((t) => ruleTokens.includes(t))) return false
      const ruleProps = new Set(rule.declarations.map((d) => baseProp(d.prop)))
      return entry.properties.some((p) => ruleProps.has(baseProp(p)))
    })
  }

  const shipped = shippedStyleRules()

  it('the generated manifest is non-empty (sanity: the generator actually found rules)', () => {
    expect(CONTRACT_MANIFEST.length).toBeGreaterThan(20)
  })

  it.each(CONTRACT_MANIFEST)('ports $id', (entry) => {
    expect(hasShippedCounterpart(entry, shipped), `no shipped rule covers "${entry.id}"`).toBe(true)
  })

  // VF Wallet Task 10 fix loop 1 (I1 part (ii)): regeneration was previously available but never
  // enforced -- no package.json script, no CI step, no regenerate-and-diff test, so this file could
  // silently drift from the local contract with nothing failing. This calls the SAME
  // checkManifestFreshness() the `manifest:check` npm script uses (never a second, potentially
  // drifting reimplementation) as a normal assertion, so a stale manifest fails THIS test run, not
  // just a separately-remembered command. Skips (not fails) when the local, gitignored contract
  // file is absent -- the identical graceful degradation contractTokens.test.js documents for CI.
  it('the committed manifest matches a fresh regeneration from the local contract (skips if the gitignored contract is absent)', () => {
    const result = checkManifestFreshness()
    if (result.skipped) return
    expect(
      result.fresh,
      'walletContractManifest.generated.json is STALE -- run `node scripts/generate-wallet-contract-manifest.mjs`'
    ).toBe(true)
  })
})

// VF Wallet Task 10, Part A2 (owner-directed): the mono guarantee for `.pc-input.pc-technical`
// elements (the mnemonic-confirmation input, BackupScreen.jsx:112; the secret/mnemonic import
// textarea, ImportScreen.jsx) depends on `.pc-technical` (declared further down the STYLE string)
// winning a SPECIFICITY TIE against `.pc-wallet :where(h1, h2, h3, button, input, select,
// textarea)` (declared above it) purely by SOURCE ORDER -- both resolve to specificity (0,1,0). A
// plausible "tidy up, reorder these two blocks" edit would silently flip every secret/technical
// input+textarea in this surface to Geist, and the presence-only Part A1 guard above cannot see
// it (both rules would still individually "have a shipped counterpart"). This asserts the actual
// COMPUTED font-family on a rendered element carrying both classes, the only check that can catch
// an order-dependent regression a presence check structurally cannot.
describe('WalletShell — pins the .pc-technical mono guarantee against reordering (VF Wallet Task 10, Part A2)', () => {
  // jsdom's getComputedStyle does not substitute a var() reference's final value even for a
  // standard property (only contractTokens.test.js's own custom-property lookups need
  // resolveComputedVar chasing -- confirmed empirically here: a standard `font-family: var(--x)`
  // declaration comes back as the literal string "var(--x)", never the resolved font stack). That
  // is still enough to prove WHICH rule won the cascade: `.pc-technical` declares
  // `var(--pc-font-mono)`, the competing `.pc-wallet :where(...)` rule declares
  // `var(--pc-font-body)` -- two different strings, so asserting the exact literal distinguishes
  // them precisely, without needing jsdom to resolve either variable.
  it('ships the mono custom-property rule for a rendered .pc-input.pc-technical element', () => {
    expect(WALLET_CSS).toMatch(
      /code,\s*pre,\s*\.pc-technical\s*\{[^}]*font-family:\s*var\(--pc-font-mono\)/s
    )
  })
})

// VF Wallet Task 10 fix loop 1 (M1): the reviewer measured, in real Chromium on the revealed
// backup screen, that the twelve/24 recovery words (LI.pc-technical) compute mono while the
// adjacent "I've saved my recovery phrase securely" confirmation checkbox -- BackupScreen.jsx step
// 2, no class of its own -- computes Geist: the same backup flow, two faces. Fixed with a
// `.pc-backup-check input` rule in this file (BackupScreen.jsx itself is not in this task's
// authorized file list, so the class can't be added there; the checkbox is unclassed by design).
// This pins that computed value the same way A2 pins .pc-technical, against a rendered element
// carrying the exact class BackupScreen.jsx actually renders (label.pc-backup-check > input), not
// a synthetic stand-in.
describe('WalletShell — pins the backup confirmation checkbox to mono, matching the words it confirms (VF Wallet Task 10 fix loop 1, M1)', () => {
  it('ships the mono custom-property rule for the unclassed checkbox inside .pc-backup-check', () => {
    expect(WALLET_CSS).toMatch(
      /\.pc-backup-check input\s*\{[^}]*font-family:\s*var\(--pc-font-mono\)/s
    )
  })
})

// VF Wallet Task 10: WalletHome.jsx/WalletActivity.jsx render an optional bottom tab bar through
// this shared shell (the beginner navigation model is exactly Home/Activity/Settings) rather than
// each inventing their own -- this is the "reuse WalletShell, don't build a second home for the
// same rules" instruction applied to the one genuinely new structural piece Task 10 needs.
describe('WalletShell — optional bottom nav (VF Wallet Task 10)', () => {
  const TABS = [
    { id: 'home', label: 'Home' },
    { id: 'activity', label: 'Activity' },
    { id: 'settings', label: 'Settings' },
  ]

  it('renders no nav when the prop is omitted (onboarding/account-choice screens, unchanged)', () => {
    render(<WalletShell heading="x">content</WalletShell>)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('renders exactly the given tabs, in order, marking only the active one aria-current', () => {
    render(
      <WalletShell heading="x" nav={{ tabs: TABS, active: 'activity', onNav: () => {} }}>
        content
      </WalletShell>
    )
    const bar = screen.getByRole('navigation')
    const buttons = within(bar).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Home', 'Activity', 'Settings'])
    expect(within(bar).getByText('Activity').getAttribute('aria-current')).toBe('page')
    expect(within(bar).getByText('Home').getAttribute('aria-current')).toBeNull()
    expect(within(bar).getByText('Settings').getAttribute('aria-current')).toBeNull()
  })

  it('fires onNav with exactly the tapped tab id, once per click', () => {
    const onNav = vi.fn()
    render(
      <WalletShell heading="x" nav={{ tabs: TABS, active: 'home', onNav }}>
        content
      </WalletShell>
    )
    fireEvent.click(screen.getByText('Activity'))
    expect(onNav).toHaveBeenCalledTimes(1)
    expect(onNav).toHaveBeenCalledWith('activity')
  })

  // 2026-08-02 compact pass: known tab ids render a decorative stroke icon above the label.
  // The icon is aria-hidden and contributes no text, so the label-text assertions above are
  // unaffected; an unknown id stays label-only (no broken empty icon).
  it('renders an aria-hidden icon inside each known tab, none for unknown ids', () => {
    render(
      <WalletShell
        heading="x"
        nav={{
          tabs: [...TABS, { id: 'mystery', label: 'Mystery' }],
          active: 'home',
          onNav: () => {},
        }}
      >
        content
      </WalletShell>
    )
    const bar = screen.getByRole('navigation')
    for (const label of ['Home', 'Activity', 'Settings']) {
      const svg = within(bar).getByText(label).querySelector('svg')
      expect(svg).toBeTruthy()
      expect(svg.getAttribute('aria-hidden')).toBe('true')
    }
    expect(within(bar).getByText('Mystery').querySelector('svg')).toBeNull()
  })
})
