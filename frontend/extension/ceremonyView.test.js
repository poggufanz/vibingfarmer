// frontend/extension/ceremonyView.test.js
// VF Wallet Task 13 -- failing-tests-first coverage for the internal-action ceremony view model
// and its DOM rendering (ceremony.html). Mirrors approvalView.test.js's own conventions (Task 12):
// ordering assertions read `sections.map(s => s.kind)` directly, mono-only-on-identifiers is
// checked both structurally (jsdom, the parts model) and in real Chromium (computed style), and
// the 320px sweep runs the shared A1 helper against every state this surface can render.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  buildCeremonyView,
  renderCeremonyView,
  ceremonyStatusText,
  CEREMONY_STATE,
  partsToText,
  STELLAR_TESTNET_LABEL,
  INTERNAL_ORIGIN_LABEL,
  BASE_ROUTE_LABEL,
  VAULT_ROUTE_LABEL,
} from './ceremonyView.js'
import { toBaseMandateView } from '../src/strategy/baseMandateView.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  launchRealChromium,
  buildHarnessHtml,
  sweep320,
} from '../src/wallet/ui/testSupport/sweep320.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const ADDRESS = 'CDLVXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXK3QP'

describe('buildCeremonyView — fail-closed, no address', () => {
  it('never renders a ceremony surface when no address is resolvable — no-wallet variant', () => {
    const v = buildCeremonyView({ action: 'deposit', params: {} }, { address: null })
    expect(v.variant).toBe('no-wallet')
    expect(v.sections).toEqual([])
    expect(v.submissionState).toBe(CEREMONY_STATE.FAILED)
  })
})

describe('buildCeremonyView — section ordering (Step 2: consequence-first)', () => {
  it('deposit: consequence, origin, account, network, state, technical', () => {
    const v = buildCeremonyView(
      { action: 'deposit', params: { contractId: ADDRESS, amount: '1.5' } },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    expect(v.sections.map((s) => s.kind)).toEqual([
      'consequence',
      'origin',
      'account',
      'network',
      'state',
      'technical',
    ])
  })

  it('a bridge-carrying decoded summary inserts base-mandate directly after network, before state', () => {
    const bridgeSummary = {
      fn: 'grant',
      contract: 'CROUTER11111111111111111111111111111111111111111111',
      grant: {
        agents: [
          { index: 0, kind: 'deposit' },
          { index: 1, kind: 'bridge' },
        ],
      },
    }
    const v = buildCeremonyView(
      { action: 'signTransaction', params: { xdr: 'X' } },
      { address: ADDRESS, decodedSummary: bridgeSummary }
    )
    expect(v.sections.map((s) => s.kind)).toEqual([
      'consequence',
      'origin',
      'account',
      'network',
      'base-mandate',
      'state',
      'technical',
    ])
  })

  it('no bridge agent -> never inserts base-mandate', () => {
    const v = buildCeremonyView(
      { action: 'signTransaction', params: { xdr: 'X' } },
      { address: ADDRESS, decodedSummary: { fn: 'deposit', grant: null } }
    )
    expect(v.sections.map((s) => s.kind)).not.toContain('base-mandate')
  })
})

describe('buildCeremonyView — origin is always the truthful internal label, never a guessed/blank value', () => {
  it('every action renders the fixed internal-origin label, never empty', () => {
    for (const action of ['deposit', 'approve', 'connect', 'signTransaction', 'signAuthEntry']) {
      const v = buildCeremonyView({ action, params: {} }, { address: ADDRESS, amountUnits: 1n })
      const origin = v.sections.find((s) => s.kind === 'origin')
      expect(origin.origin).toBe(INTERNAL_ORIGIN_LABEL)
      expect(origin.origin.length).toBeGreaterThan(0)
    }
  })
})

describe('buildCeremonyView — consequence never claims more than the action actually does', () => {
  it('deposit states the exact amount and the one known vault destination', () => {
    const v = buildCeremonyView(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    const text = consequence.statements.map(partsToText).join(' ')
    expect(text).toContain('1.5')
    expect(text).toContain(VAULT_ROUTE_LABEL)
    expect(text).toMatch(/Face ID/)
  })

  it('approve never claims funds move by itself', () => {
    const v = buildCeremonyView(
      { action: 'approve', params: {} },
      { address: ADDRESS, amountUnits: 1_000_000_000n }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    const text = consequence.statements.map(partsToText).join(' ')
    expect(text).toMatch(/does not move funds by itself/)
  })

  it('connect never claims funds move or allowances change', () => {
    const v = buildCeremonyView({ action: 'connect', params: {} }, { address: ADDRESS })
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    const text = consequence.statements.map(partsToText).join(' ')
    expect(text).toMatch(/No funds move and no allowance changes/)
  })

  it('an undecoded sign request states plainly that no ceiling can be guaranteed, never a guessed amount', () => {
    const v = buildCeremonyView(
      { action: 'signTransaction', params: { xdr: 'X' } },
      { address: ADDRESS, decodedSummary: null }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    const text = consequence.statements.map(partsToText).join(' ')
    expect(text).toMatch(/cannot state a guaranteed spending ceiling/i)
  })

  it('every sign statement says this ceremony only signs, never submits', () => {
    for (const action of ['signTransaction', 'signAuthEntry']) {
      const v = buildCeremonyView(
        { action, params: {} },
        { address: ADDRESS, decodedSummary: { fn: 'mystery_call', contract: null } }
      )
      const consequence = v.sections.find((s) => s.kind === 'consequence')
      const text = consequence.statements.map(partsToText).join(' ')
      expect(text).toMatch(/never submits or moves funds itself/)
    }
  })
})

describe('buildCeremonyView — bridge detection uses the canonical Base mandate view verbatim (never re-derived)', () => {
  it('the base-mandate section carries the exact seven-day / 10,000-USDC per-call non-cumulative scope from toBaseMandateView, not a hand-typed number', () => {
    const canonical = toBaseMandateView({
      mandate: null,
      stellarOwner: null,
      kernelAddress: null,
      relayerOrigin: null,
    })
    const v = buildCeremonyView(
      { action: 'signTransaction', params: { xdr: 'X' } },
      {
        address: ADDRESS,
        decodedSummary: { fn: 'grant', grant: { agents: [{ kind: 'bridge' }] } },
      }
    )
    const mandate = v.sections.find((s) => s.kind === 'base-mandate')
    expect(mandate.route).toBe(BASE_ROUTE_LABEL)
    expect(mandate.route).toBe(`${STELLAR_TESTNET_LABEL} → Base Sepolia`)
    expect(mandate.perCallCapUsdc).toBe(canonical.perCallCap.usdc)
    expect(mandate.durationDays).toBe(canonical.durationDays)
    expect(mandate.statements).toContain(canonical.primaryCopy)
    expect(mandate.perCallCapUsdc).toBe('10,000')
    expect(mandate.durationDays).toBe(7)
  })
})

describe('ceremonyStatusText — Step 3: distinct labels for signed/submitted/confirmed/not-submitted/checking', () => {
  it('every state maps to a distinct label', () => {
    const labels = Object.values(CEREMONY_STATE).map((s) => ceremonyStatusText(s))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('CONFIRMED includes the shares figure only when supplied; SUBMITTED/CHECKING_STATUS never claim a shares figure', () => {
    expect(ceremonyStatusText(CEREMONY_STATE.CONFIRMED, { shares: '5' })).toBe(
      'Confirmed — minted 5 shares'
    )
    expect(ceremonyStatusText(CEREMONY_STATE.CONFIRMED)).toBe('Confirmed')
    expect(ceremonyStatusText(CEREMONY_STATE.SUBMITTED)).not.toMatch(/shares|minted/i)
    expect(ceremonyStatusText(CEREMONY_STATE.CHECKING_STATUS)).not.toMatch(/shares|minted/i)
  })

  it('NOT_SUBMITTED reads as not submitted by default and accepts a detail override, never "signed" or "completed"', () => {
    expect(ceremonyStatusText(CEREMONY_STATE.NOT_SUBMITTED)).toBe('Not submitted')
    expect(ceremonyStatusText(CEREMONY_STATE.NOT_SUBMITTED, { detail: 'account changed' })).toBe(
      'account changed'
    )
    expect(ceremonyStatusText(CEREMONY_STATE.NOT_SUBMITTED)).not.toMatch(
      /signed|completed|confirmed/i
    )
  })

  it('FAILED accepts a detail override (the real error message)', () => {
    expect(ceremonyStatusText(CEREMONY_STATE.FAILED)).toBe('Failed')
    expect(ceremonyStatusText(CEREMONY_STATE.FAILED, { detail: 'network error' })).toBe(
      'Failed: network error'
    )
  })

  it('SIGNED is distinct from SUBMITTED and CONFIRMED (Step 3: signed != submitted != confirmed)', () => {
    const signed = ceremonyStatusText(CEREMONY_STATE.SIGNED)
    const submitted = ceremonyStatusText(CEREMONY_STATE.SUBMITTED)
    const confirmed = ceremonyStatusText(CEREMONY_STATE.CONFIRMED)
    expect(new Set([signed, submitted, confirmed]).size).toBe(3)
  })
})

describe('buildCeremonyView / mono-marking — item 5: addr() only on identifiers, never on prose', () => {
  function addrSegments(parts) {
    return parts.filter((p) => p.addr)
  }
  function plainSegments(parts) {
    return parts.filter((p) => !p.addr)
  }

  it('the deposit consequence marks only the token unit "USDC" as technical, the sentence stays plain', () => {
    const v = buildCeremonyView(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    const parts = consequence.statements[0]
    const technical = addrSegments(parts).map((p) => p.text)
    expect(technical).toEqual(['USDC'])
    const plainText = plainSegments(parts)
      .map((p) => p.text)
      .join('')
    expect(plainText).toContain(VAULT_ROUTE_LABEL)
    expect(plainText).toContain('Deposit')
  })

  it('a decoded sign consequence marks only the contract address technical, the rest stays plain', () => {
    const v = buildCeremonyView(
      { action: 'signTransaction', params: {} },
      {
        address: ADDRESS,
        decodedSummary: {
          fn: 'mystery_call',
          contract: 'CUNKNOWN1111111111111111111111111111111111111111111',
        },
      }
    )
    const consequence = v.sections.find((s) => s.kind === 'consequence')
    const parts = consequence.statements[0]
    expect(addrSegments(parts)).toHaveLength(1)
    expect(addrSegments(parts)[0].text).toBe('CUNK…1111')
  })
})

describe('renderCeremonyView — DOM order matches view.sections exactly', () => {
  it('consequence precedes origin, which precedes account, which precedes network, which precedes state', () => {
    const v = buildCeremonyView(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const root = document.createElement('main')
    renderCeremonyView(root, v)
    const consequenceEl = root.querySelector('.pc-wallet-consequence')
    const originEl = root.querySelector('#origin')
    const chipEl = root.querySelector('[data-testid="wallet-account-chip"]')
    const networkEl = root.querySelector('.pc-network-badge')
    const statusEl = root.querySelector('#status')
    expect(consequenceEl && originEl && chipEl && networkEl && statusEl).toBeTruthy()
    expect(
      consequenceEl.compareDocumentPosition(originEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(originEl.compareDocumentPosition(chipEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      chipEl.compareDocumentPosition(networkEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      networkEl.compareDocumentPosition(statusEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('no-wallet renders a minimal title/note and no interactive/technical content at all', () => {
    const v = buildCeremonyView({ action: 'deposit', params: {} }, { address: null })
    const root = document.createElement('main')
    renderCeremonyView(root, v)
    expect(root.querySelector('#title').textContent).toBe('No wallet yet')
    expect(root.querySelector('table')).toBeNull()
    expect(root.querySelector('#origin')).toBeNull()
    expect(root.querySelector('#raw-wrap')).toBeNull()
  })

  it('renders the fixed auto-close note alongside the live status line', () => {
    const v = buildCeremonyView(
      { action: 'connect', params: {} },
      { address: ADDRESS, submissionState: CEREMONY_STATE.WAITING_PASSKEY }
    )
    const root = document.createElement('main')
    renderCeremonyView(root, v)
    expect(root.querySelector('#note').textContent).toMatch(/closes automatically/i)
    expect(root.querySelector('#status').textContent).toBe('Waiting for Face ID')
  })
})

// ---------------------------------------------------------------------------------------------
// Real-Chromium guards, mirroring approvalView.test.js's own sweep exactly (Part A1 helper).
// ceremony.html loads approval.css as a real <link>, so this suite inlines the actual shipped
// CSS via a raw file read, same as approvalView.test.js does.
// ---------------------------------------------------------------------------------------------
const approvalCss = readFileSync(path.resolve(here, './approval.css'), 'utf8')

function pageHtml(mainInnerHtml) {
  return `<style>${approvalCss}</style><div class="pc-wallet pc-wallet-shell" data-pocket-critical>
    <header class="pc-wallet-header">
      <div class="pc-brand-lockup pc-brand-lockup--compact">
        <img src="./vibing_farmer.logo.svg" alt="Vibing Farmer" />
        <span>VF Wallet</span>
      </div>
      <span class="pc-technical">passkey · secp256r1</span>
    </header>
    <main class="pc-wallet-main" id="ceremony-main">${mainInnerHtml}</main>
  </div>`
}

function renderStateHtml(request, ctx) {
  const view = buildCeremonyView(request, ctx)
  const main = document.createElement('div')
  renderCeremonyView(main, view)
  return pageHtml(main.innerHTML)
}

const LONG_SOROBAN_SYMBOL = 'abcdefghij_klmnopqrs_tuvwxyz_012' // 32 chars -- the Soroban Symbol max
const FULL_STELLAR_ADDRESS = `C${'A'.repeat(55)}` // 56 chars, untruncated (safeShortAddr's input)

const CEREMONY_STATES = [
  [
    'deposit-preparing',
    [
      { action: 'deposit', params: { contractId: ADDRESS, amount: '1.5' } },
      { address: ADDRESS, amountUnits: 15_000_000n, submissionState: CEREMONY_STATE.PREPARING },
    ],
  ],
  [
    'deposit-confirmed',
    [
      { action: 'deposit', params: {} },
      {
        address: ADDRESS,
        amountUnits: 15_000_000n,
        submissionState: CEREMONY_STATE.CONFIRMED,
        shares: '5',
      },
    ],
  ],
  [
    'deposit-submitted-not-confirmed',
    [
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n, submissionState: CEREMONY_STATE.SUBMITTED },
    ],
  ],
  [
    'approve-waiting-passkey',
    [
      { action: 'approve', params: {} },
      {
        address: ADDRESS,
        amountUnits: 1_000_000_000n,
        submissionState: CEREMONY_STATE.WAITING_PASSKEY,
      },
    ],
  ],
  [
    'connect',
    [
      { action: 'connect', params: {} },
      { address: ADDRESS, submissionState: CEREMONY_STATE.SIGNED },
    ],
  ],
  [
    'sign-undecoded',
    [
      { action: 'signTransaction', params: { xdr: 'X' } },
      { address: ADDRESS, decodedSummary: null },
    ],
  ],
  [
    'sign-decoded-bridge-base-mandate',
    [
      { action: 'signTransaction', params: { xdr: 'X' } },
      {
        address: ADDRESS,
        decodedSummary: {
          fn: 'grant',
          contract: 'CROUTER11111111111111111111111111111111111111111111',
          grant: { agents: [{ kind: 'deposit' }, { kind: 'bridge' }] },
        },
        submissionState: CEREMONY_STATE.NOT_SUBMITTED,
        detail: 'active account changed before the signed result could be delivered',
      },
    ],
  ],
  [
    'sign-not-submitted-stale',
    [
      { action: 'signAuthEntry', params: { authEntry: 'E' } },
      {
        address: ADDRESS,
        decodedSummary: { fn: 'mystery_call', contract: null },
        submissionState: CEREMONY_STATE.NOT_SUBMITTED,
        detail: 'active account changed before the signed result could be delivered',
      },
    ],
  ],
  // Adversarial shape 1: a 32-char Soroban Symbol function name (the real maximum -- reachable
  // whenever a signTransaction/signAuthEntry ceremony decodes a real contract call).
  [
    'sign-long-fn',
    [
      { action: 'signTransaction', params: { xdr: 'X' } },
      {
        address: ADDRESS,
        decodedSummary: { fn: LONG_SOROBAN_SYMBOL, contract: null },
      },
    ],
  ],
  // Adversarial shape 2: a full, untruncated 56-char Stellar address as the active account --
  // stresses safeShortAddr/the account chip even though production always shortens it first.
  ['long-account-address', [{ action: 'connect', params: {} }, { address: FULL_STELLAR_ADDRESS }]],
  ['no-wallet', [{ action: 'deposit', params: {} }, { address: null }]],
]

function buildStatesHtml() {
  return CEREMONY_STATES.map(([label, [req, ctx]]) => [label, renderStateHtml(req, ctx)])
}

describe('renderCeremonyView — real-browser 320px layout guard, every ceremony state (Part A1 sweep)', () => {
  it('creates no horizontal overflow at 320px for every state', async () => {
    await sweep320(buildStatesHtml(), { logPrefix: 'ceremony' })
  }, 60000)
})

describe('renderCeremonyView — real-Chromium proof of rejection-checklist item 5, every state', () => {
  it('no friendly copy outside .pc-technical/code/pre computes a JetBrains Mono font-family', async () => {
    const results = buildStatesHtml()
    const browser = await launchRealChromium()
    try {
      for (const [label, html] of results) {
        const page = await browser.newPage()
        await page.setContent(buildHarnessHtml(html))
        const monoOffenders = await page.evaluate(() =>
          Array.from(document.querySelectorAll('*'))
            .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim()))
            .filter((el) => !el.closest('.pc-technical, code, pre'))
            .map((el) => ({
              text: el.textContent.trim().slice(0, 60),
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

  // Positive control: prove the check isn't vacuously green -- the decoded-sign state DOES carry
  // a real .pc-technical contract-address segment, and it DOES compute JetBrains Mono.
  it("positive control: the decoded state's address segment DOES compute JetBrains Mono", async () => {
    const html = renderStateHtml(
      { action: 'signTransaction', params: {} },
      {
        address: ADDRESS,
        decodedSummary: {
          fn: 'mystery_call',
          contract: 'CUNKNOWN1111111111111111111111111111111111111111111',
        },
      }
    )
    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setContent(buildHarnessHtml(html))
      const technicalFonts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.pc-technical')).map(
          (el) => getComputedStyle(el).fontFamily
        )
      )
      expect(technicalFonts.length).toBeGreaterThan(0)
      expect(technicalFonts.every((f) => /jetbrains mono/i.test(f))).toBe(true)
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)

  // RED-then-GREEN mutation proof: forcing every consequence <p> into mono reproduces the class of
  // regression this check exists to catch.
  it('mutation-proof: forcing .pc-wallet-consequence p into mono fails the check', async () => {
    const html = renderStateHtml(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const mutated = html.replace(
      '.pc-wallet-consequence p {',
      '.pc-wallet-consequence p { font-family: var(--pc-font-mono) !important;'
    )
    expect(mutated).not.toBe(html)
    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setContent(buildHarnessHtml(mutated))
      const monoOffenders = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim()))
          .filter((el) => !el.closest('.pc-technical, code, pre'))
          .filter((entry) => /jetbrains mono/i.test(getComputedStyle(entry).fontFamily))
      )
      expect(monoOffenders.length).toBeGreaterThan(0) // RED on the mutated CSS
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)
})

describe('renderCeremonyView — real-Chromium proof of rejection-checklist items 6/7 (no entry animation)', () => {
  it('no element in any ceremony state has a running (non-"none") animation', async () => {
    const results = buildStatesHtml()
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

  // Positive control: prove the animation check can actually see one, so the all-clear above is
  // not vacuously green because nothing in this harness ever animates.
  it('positive control: an injected animated element IS detected by the same check', async () => {
    const html = renderStateHtml(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const mutated = html.replace(
      '</style>',
      '@keyframes vf-test-spin { from { opacity: 0 } to { opacity: 1 } } .pc-wallet-consequence { animation: vf-test-spin 300ms; }</style>'
    )
    expect(mutated).not.toBe(html)
    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setContent(buildHarnessHtml(mutated))
      const animating = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .map((el) => getComputedStyle(el).animationName)
          .filter((name) => name && name !== 'none')
      )
      expect(animating.length).toBeGreaterThan(0) // RED: the injected animation IS seen
      await page.close()
    } finally {
      await browser.close()
    }
  }, 60000)
})

// ---------------------------------------------------------------------------------------------
// WCAG AA contrast for every text leaf inside .pc-wallet-consequence -- same walk approvalView.
// test.js uses (C1), reused here because this surface reuses the SAME class and MUST inherit the
// same fix, not merely resemble it.
// ---------------------------------------------------------------------------------------------
function parseRgb(str) {
  const m = str && str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}

function contrastRatio(rgbA, rgbB) {
  const lA = relativeLuminance(rgbA)
  const lB = relativeLuminance(rgbB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

async function measureConsequenceLeafContrasts(html) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setContent(buildHarnessHtml(html))
    const leaves = await page.evaluate(() => {
      function resolvedBackground(el) {
        for (let node = el; node; node = node.parentElement) {
          const bg = getComputedStyle(node).backgroundColor
          if (bg && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg) && bg !== 'transparent') return bg
        }
        return null
      }
      function describe(el) {
        const cls =
          el.className && typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).join('.')}`
            : ''
        return `${el.tagName.toLowerCase()}${cls}`
      }
      const box = document.querySelector('.pc-wallet-consequence')
      if (!box) return []
      return Array.from(box.querySelectorAll('*'))
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim()))
        .map((el) => ({
          selector: describe(el),
          text: el.textContent.trim().slice(0, 60),
          color: getComputedStyle(el).color,
          background: resolvedBackground(el),
        }))
    })
    await page.close()
    return leaves
  } finally {
    await browser.close()
  }
}

describe('renderCeremonyView — real-Chromium WCAG AA contrast inside .pc-wallet-consequence (inherits C1)', () => {
  const AA_NORMAL_TEXT = 4.5

  it('every text leaf in the deposit consequence meets AA contrast against its resolved background', async () => {
    const html = renderStateHtml(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const leaves = await measureConsequenceLeafContrasts(html)
    expect(leaves.length).toBeGreaterThan(0)
    for (const leaf of leaves) {
      const ratio = contrastRatio(parseRgb(leaf.color), parseRgb(leaf.background))
      expect(
        ratio,
        `${leaf.selector} "${leaf.text}" contrast ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }
  }, 60000)

  // Mutation proof: this surface must INHERIT approval.css's C1 fix (--pc-owned-ink), not merely
  // resemble it — reverting the ceiling/consequence ink override the same way approvalView.
  // test.js proves it reproduces the pre-fix white-on-white failure here too.
  it('mutation-proof: removing the .pc-wallet-consequence-scoped ink override reproduces low contrast here too', async () => {
    const html = renderStateHtml(
      { action: 'deposit', params: {} },
      { address: ADDRESS, amountUnits: 15_000_000n }
    )
    const mutated = html.replace(/\.pc-wallet-consequence\s*\{[^}]*\}/, (block) =>
      block.replace(/color:\s*var\(--pc-owned-ink\);?/, '')
    )
    expect(mutated).not.toBe(html)
    const leaves = await measureConsequenceLeafContrasts(mutated)
    const failing = leaves.filter(
      (leaf) => contrastRatio(parseRgb(leaf.color), parseRgb(leaf.background)) < AA_NORMAL_TEXT
    )
    expect(
      failing.length,
      'expected the pre-fix regression to reproduce low contrast'
    ).toBeGreaterThan(0)
  }, 60000)
})
