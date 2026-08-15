// frontend/src/components/money/MyMoneyRoute.a11y.test.jsx
// My Money Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze). Dedicated accessibility suite
// for the /agent route's composition root -- MyMoneyRoute.test.jsx already covers heading order,
// the rejection-checklist verdicts, and a broad "zero axe violations" sweep; this file goes deeper
// on the brief's five specific items (headings/landmarks, labels, focus order, live regions, no
// icon-only network meaning, no color-only state) across five fixtures (disconnected, active,
// partial-discovery, recovery, open-dialog), each with a positive control proving the guard can
// see the violation it claims to catch -- not merely a query that never finds anything (the
// project's own recurring blindness: "no icon-only network meaning" and "no color-only state" are
// exactly the kind of assertion that silently passes over an empty selector).
//
// Own fixture builders, matching the established convention that each dedicated a11y suite
// declares its own (strategyA11y.test.jsx, foundationA11y.test.jsx) rather than importing
// another's. Every address below is a fabricated but REAL-SHAPED 56-char Stellar strkey (never a
// short 'CAGENT1'-style placeholder like MyMoneyRoute.test.jsx's own, earlier fixtures use) --
// production-shaped data is what exposed Strategy Task 11's worst miss (a 56-char contract address
// rendering where a currency symbol belonged), so every identifier here is at the real length.
// `amount.token` is the literal 'USDC' throughout, NOT a fixture shortcut: readOwnerMoney.js's own
// `TOKEN` constant (readOwnerMoney.js:25) is hardcoded to that literal for every amount this route
// ever renders -- freezing anything else here would misrepresent what this route currently ships.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { MyMoneyRoute } from './MyMoneyRoute.jsx'
import { buildMyMoneyModel } from '../../money/myMoneyModel.js'

expect.extend(axeMatchers)
afterEach(cleanup)

const NOW = 1_800_000_500_000

// Fabricated, real-shaped (56-char, valid strkey alphabet) identities -- never real testnet
// accounts, never a list index.
const OWNER = 'GMYMONEYOWNER55Y7AQ3OYXDQVJUQCKYCZOVWFAG7RT6JCBJDC56SMGO'
const AGENT_DEPOSIT = 'CMYMONEYAGENTONEINF6FO4XW6EXAHQCAXTXS6A6MIYMPFFJ2CBMKXDE'
const AGENT_BRIDGE = 'CMYMONEYAGENTTWOFKDJWAADR3NMHFEOSBH7D5KRSTXRKDA73OA6MRLS'
const AGENT_REVOKED = 'CMYMONEYAGENTREVOKEDDREDNYFAMZLP67RR6M44WUIWA7WKVCBT5D3R'

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

function depositAgent(address = AGENT_DEPOSIT, units = 300_0000000n) {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0 } },
    amount: amt(units),
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
    problems: [],
  }
}

// The "Base child" fixture: a real Stellar+Base split -- one agent, two independently-known legs.
function bridgeChildAgent(address = AGENT_BRIDGE) {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0 } },
    amount: amt(50_0000000n),
    executionStatus: 'succeeded',
    custody: { location: 'unknown' },
    custodyBreakdown: [
      { location: 'stellar-vault', amount: amt(30_0000000n) },
      { location: 'base-proxy', amount: amt(20_0000000n) },
    ],
    problems: [],
  }
}

// The "revoked-funded recovery" fixture: a confirmed scope-revoked agent still holding a known
// positive balance -- myMoneyModel.js's own confirmedProblemAgents() precedence means a model
// carrying this agent's address in `problemAgents` outranks every other state.
function revokedFundedAgent(address = AGENT_REVOKED) {
  return {
    address,
    scope: { state: 'known', value: { vault: 'CVAULT', revoked: true, expiry: 0 } },
    amount: amt(50_0000000n),
    executionStatus: 'idle',
    custody: { location: 'agent' },
    custodyBreakdown: [],
    problems: ['scope-revoked'],
  }
}

function baseModel(overrides = {}) {
  return {
    state: 'current',
    owner: OWNER,
    confirmedTotal: { state: 'known', amount: amt(500_0000000n) },
    yield: { state: 'live', apy: 8.2 },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: { 'stellar-vault': '5000000000' },
    agentCount: 2,
    problemAgentCount: 0,
    freshness: 'current',
    checkedAt: NOW,
    confirmedLedger: '12345',
    confirmedBlock: '67890',
    source: 'soroban-rpc',
    problemAgents: [],
    protection: {
      state: 'armed',
      authority: OWNER,
      mandateExpiry: NOW / 1000 + 100000,
      urgentRenewal: false,
      ownerIsAuthority: true,
    },
    automation: null,
    hasKnownVaultMoney: true,
    ...overrides,
  }
}

// The five fixtures the brief names, each built the way production actually reaches that state
// (buildMyMoneyModel for 'disconnected' -- the real state machine, not a hand-typed shape it could
// never itself emit; the other four via baseModel overrides, matching MyMoneyRoute.test.jsx's own
// established convention for states buildMyMoneyModel needs a live discovery/money read to reach).
function disconnectedFixture() {
  return { model: buildMyMoneyModel({ owner: null, now: NOW }), agents: [] }
}
function activeFixture() {
  return { model: baseModel(), agents: [depositAgent(), bridgeChildAgent()] }
}
function partialDiscoveryFixture() {
  return {
    model: baseModel({ state: 'partial-discovery', agentCount: 1, problemAgentCount: 0 }),
    agents: [depositAgent()],
  }
}
function recoveryFixture() {
  return {
    model: baseModel({ state: 'problem', problemAgents: [AGENT_REVOKED] }),
    agents: [depositAgent(), revokedFundedAgent()],
  }
}

const FIXTURES = [
  ['disconnected', disconnectedFixture],
  ['active', activeFixture],
  ['partial-discovery', partialDiscoveryFixture],
  ['recovery', recoveryFixture],
]

// ---------------------------------------------------------------------------------------------
// 1. Headings and landmarks
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- one h1, seven labelled regions', () => {
  for (const [label, build] of FIXTURES) {
    it(`fixture=${label}: exactly one h1 and seven accessible regions`, () => {
      const { model, agents } = build()
      render(<MyMoneyRoute model={model} agents={agents} />)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getByRole('heading', { level: 1, name: 'My money' })).toBeTruthy()
      // A plain <section> with an aria-labelledby accessible name computes an implicit ARIA
      // "region" role (HTML-AAM) -- real landmarks, not merely visual headings.
      const regions = screen.getAllByRole('region')
      expect(regions.map((r) => within(r).getByRole('heading', { level: 2 }).textContent)).toEqual([
        'Your money',
        'Your position',
        'Your agent team',
        'Vault protection',
        'How your money is working',
        'Technical details',
        'Recover a Base account',
      ])
    })
  }

  // Positive control: a plain <section> with NO accessible name computes no implicit landmark
  // role at all -- proving the `getAllByRole('region')` query above is discriminating on the real
  // accessibility tree, not just counting <section> elements.
  it('control: an unlabelled section is not a region', () => {
    render(
      <section>
        <p>no accessible name</p>
      </section>
    )
    expect(screen.queryAllByRole('region')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Labels -- every interactive control has a real accessible name
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- every button and link has an accessible name', () => {
  for (const [label, build] of FIXTURES) {
    it(`fixture=${label}: no button or link renders with a blank accessible name`, () => {
      const { model, agents } = build()
      render(<MyMoneyRoute model={model} agents={agents} account={OWNER} />)
      const controls = [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]
      expect(controls.length).toBeGreaterThan(0)
      for (const el of controls) {
        expect((el.textContent || el.getAttribute('aria-label') || '').trim()).not.toBe('')
      }
    })
  }

  // Positive control: a real <button> with no text and no aria-label has a blank accessible name
  // -- proving the sweep above would have caught one.
  it('control: an icon-only button with no text or aria-label fails the same sweep', () => {
    render(<button type="button" />)
    const btn = screen.getByRole('button')
    expect((btn.textContent || btn.getAttribute('aria-label') || '').trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Focus order -- opening/closing the recovery dialog
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- focus order around the recovery dialog', () => {
  it('never steals focus while the dialog is closed (differential control)', () => {
    const { model, agents } = recoveryFixture()
    render(<MyMoneyRoute model={model} agents={agents} />)
    expect(document.activeElement).toBe(document.body)
  })

  it("moves focus into the open dialog, and Cancel returns it to the SAME agent's trigger", () => {
    const { model, agents } = recoveryFixture()
    render(<MyMoneyRoute model={model} agents={agents} />)
    const trigger = screen.getByRole('button', { name: 'Recover funds' })
    // A real click focuses the activated button before anything else happens; jsdom's fireEvent
    // does not simulate that side effect on its own, so it's made explicit here -- otherwise the
    // dialog's own focus-trap (Primitives.jsx's useDialogFocusTrap) would capture `document.body`
    // as the element to restore focus to on close, not the real trigger.
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: "Recover this agent's funds" })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(document.body)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(trigger)
  })

  it('does not move focus for an unrelated re-render while the dialog stays closed', () => {
    const { model, agents } = recoveryFixture()
    const { rerender } = render(<MyMoneyRoute model={model} agents={agents} />)
    rerender(<MyMoneyRoute model={{ ...model }} agents={agents} />)
    expect(document.activeElement).toBe(document.body)
  })
})

// ---------------------------------------------------------------------------------------------
// 4. Live regions -- state notices are found by ROLE, not by a CSS-attribute query that an
// accessibility-tree removal (aria-hidden/hidden) would leave blind to (Strategy Task 14's own
// m-2 lesson: `container.querySelector('[role="status"]')` still finds a hidden element).
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- state notices are real, role-queryable live regions', () => {
  // StatusNotice (Primitives.jsx) sets role="status"/"alert" with no aria-label/aria-labelledby,
  // so per the ARIA spec these two roles compute NO accessible name from their own content ("name
  // from: author" only) -- confirmed empirically below (the differential control shows the same
  // empty-name shape). The role itself, found by `getByRole` rather than a CSS attribute selector
  // that an `aria-hidden` removal would still match, is what proves it survives to the
  // accessibility tree; `textContent` is what proves it carries the real message.
  it('the problem banner is an alert, found by role, inside the money hero', () => {
    const { model, agents } = recoveryFixture()
    render(<MyMoneyRoute model={model} agents={agents} />)
    const hero = screen.getByRole('heading', { name: 'Your money' }).closest('section')
    const alert = within(hero).getByRole('alert')
    expect(alert.textContent).toMatch(/Action needed/)
    expect(alert.textContent).toMatch(/revoked or expired grant/)
  })

  it('the partial-discovery banner is an alert, found by role, inside the money hero', () => {
    // MoneyHero.jsx renders this with state="warning" (Partial discovery is exactly as
    // action-relevant as the problem banner above, per StatusNotice's own role table --
    // Primitives.jsx:55 maps warning/danger to "alert", info-only states to "status").
    const { model, agents } = partialDiscoveryFixture()
    render(<MyMoneyRoute model={model} agents={agents} />)
    const hero = screen.getByRole('heading', { name: 'Your money' }).closest('section')
    const alert = within(hero).getByRole('alert')
    expect(alert.textContent).toMatch(/Partial discovery/)
    expect(alert.textContent).toMatch(/have not finished confirming/)
  })

  it('an unavailable money figure is announced as status, found by role', () => {
    const model = baseModel({ state: 'disconnected', owner: null, confirmedTotal: null })
    render(<MyMoneyRoute model={model} agents={[]} />)
    // Scoped to the hero: VaultProtection's own StatusNotice (state 'armed' -> role="status" too,
    // Primitives.jsx:55) is a SECOND status region on this same fixture -- a real, separate,
    // equally valid live region, not a bug; this test is about the money figure specifically.
    const hero = screen.getByRole('heading', { name: 'Your money' }).closest('section')
    const status = within(hero).getByRole('status')
    expect(status.textContent).toBe('Unavailable')
  })

  // Positive control (differential, no source mutation needed): StatusNotice's own role choice is
  // state-driven (danger/warning -> alert, info -> status, Primitives.jsx:55) -- rendering the
  // SAME component with a different `state` prop must change which role a role-based query finds,
  // proving the query is reading the real computed role rather than a hardcoded assumption. Also
  // confirms empirically that these roles carry no accessible name from their title text (Name ""
  // in testing-library's own error output when a `{name}` filter was tried) -- which is why the
  // three tests above check `textContent`, not a `name` filter.
  it('control: a role-based query is state-sensitive, not a fixed guess', async () => {
    const { StatusNotice } = await import('../pocket/Primitives.jsx')
    const { unmount } = render(
      <StatusNotice state="info" title="Info title">
        <p>body</p>
      </StatusNotice>
    )
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/Info title/)
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()
    render(
      <StatusNotice state="danger" title="Danger title">
        <p>body</p>
      </StatusNotice>
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Danger title/)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// 5. No icon-only network meaning
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- network identity is never icon-only', () => {
  it('every network badge on the active/mixed-custody fixture carries visible label text', () => {
    const { model, agents } = activeFixture()
    render(<MyMoneyRoute model={model} agents={agents} />)
    const badges = document.querySelectorAll('.network-badge')
    expect(badges.length).toBeGreaterThan(0)
    for (const badge of badges) {
      const label = badge.querySelector('.network-badge-label')
      expect(label, 'every .network-badge must carry a .network-badge-label').toBeTruthy()
      expect(label.textContent.trim()).not.toBe('')
    }
    // The Base leg's own venue truth sentence is what carries meaning for the base-proxy leg
    // (PositionList.jsx renders VenueTruth, not a second badge, for that row) -- confirm it too.
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
  })

  // Positive control: an icon-only badge (mark image, no label span) has NO text content at all --
  // proving the sweep above would catch a regression that dropped `.network-badge-label`.
  it('control: a network mark with no label span is icon-only and fails the same sweep', () => {
    render(
      <span className="network-badge" data-network="stellar-testnet">
        <img src="/brand/networks/stellar.svg" alt="" width={16} height={16} />
      </span>
    )
    const badge = document.querySelector('.network-badge')
    expect(badge.querySelector('.network-badge-label')).toBeNull()
    expect(badge.textContent.trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------------------------
// 6. No color-only state
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- agent state is never color-only', () => {
  it('every agent mark on the recovery fixture carries a real state word in its accessible name', () => {
    const { model, agents } = recoveryFixture()
    render(<MyMoneyRoute model={model} agents={agents} />)
    const marks = document.querySelectorAll('.pc-agent-mark')
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) {
      expect(mark.getAttribute('role')).toBe('img')
      const name = mark.getAttribute('aria-label') || ''
      expect(name.trim()).not.toBe('')
      expect(name).toMatch(/Active|Confirmed|Failed|Idle|Planned|Existing/)
    }
    // The needs-recovery row's own visible text label -- the SAME fact the mark's aria-label
    // encodes as "Failed", stated again in plain sight, never behind color alone.
    expect(screen.getByText('Needs recovery')).toBeTruthy()
  })

  // Positive control: an AgentMark rendered directly with no `aria-label` at all still paints its
  // color/glyph -- proving the check above would catch a regression that dropped the label
  // (AgentMark.jsx always sets one today; this renders the underlying primitive bypassing that to
  // simulate the regression, the same "structurally different but plausible" shape a reviewer
  // would inject).
  it('control: a bare colored mark with no aria-label conveys state by color alone', () => {
    render(
      <svg role="img" data-state="failed">
        <circle fill="red" />
      </svg>
    )
    const mark = document.querySelector('svg[data-state]')
    expect((mark.getAttribute('aria-label') || '').trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------------------------
// 7. axe -- zero violations, including with the recovery dialog open
// ---------------------------------------------------------------------------------------------

describe('MyMoneyRoute a11y -- zero axe violations', () => {
  for (const [label, build] of FIXTURES) {
    it(`fixture=${label}: zero axe violations`, async () => {
      const { model, agents } = build()
      const { container } = render(<MyMoneyRoute model={model} agents={agents} />)
      expect(await axe(container)).toHaveNoViolations()
    })
  }

  it('fixture=open-dialog: zero axe violations with the recovery dialog open', async () => {
    const { model, agents } = recoveryFixture()
    const { container } = render(<MyMoneyRoute model={model} agents={agents} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recover funds' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(await axe(container)).toHaveNoViolations()
  })
})
