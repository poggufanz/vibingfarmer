// frontend/src/components/money/MoneyHero.test.jsx
// My Money Task 11. MoneyHero is the one Rice dominant surface for "Your money" -- see the
// component's own header comment for exactly which MyMoneyModelV1 fields it reads and why.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { MoneyHero } from './MoneyHero.jsx'
import { buildMyMoneyModel } from '../../money/myMoneyModel.js'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const NOW = 10_000_000_000

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

// Base model shared by every fixture below -- only the fields a given test cares about are
// overridden, matching buildMyMoneyModel's real output shape (myMoneyModel.js:150-173).
function baseModel(overrides = {}) {
  return {
    state: 'current',
    owner: 'GOWNER',
    confirmedTotal: { state: 'known', amount: amt(500_0000000n) },
    yield: { state: 'unavailable', apy: null },
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
      authority: 'GOWNER',
      mandateExpiry: NOW / 1000 + 100000,
      urgentRenewal: false,
      ownerIsAuthority: true,
    },
    automation: null,
    hasKnownVaultMoney: true,
    ...overrides,
  }
}

describe('MoneyHero — heading and never-a-coerced-zero', () => {
  it('renders the real confirmed total for a current model, never a bare unlabeled 0', () => {
    render(<MoneyHero model={baseModel()} />)
    expect(screen.getByText('Your money')).toBeTruthy()
    expect(screen.getByText(/500/)).toBeTruthy()
  })

  it('renders the literal "Unavailable" text when disconnected -- never a coerced 0', () => {
    const model = baseModel({
      state: 'disconnected',
      owner: null,
      confirmedTotal: null,
      checkedAt: null,
      agentCount: null,
      problemAgentCount: null,
      hasKnownVaultMoney: false,
      protection: {
        state: 'unavailable',
        authority: null,
        mandateExpiry: null,
        urgentRenewal: false,
        ownerIsAuthority: false,
      },
    })
    render(<MoneyHero model={model} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/^0\s*USDC/)).toBeNull()
  })

  it('renders the literal "Unavailable" text for the unavailable-index state, not a placeholder number', () => {
    const model = baseModel({
      state: 'unavailable',
      confirmedTotal: null,
      freshness: 'unavailable',
    })
    render(<MoneyHero model={model} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('shows the Loading placeholder while the very first read is still in flight', () => {
    const model = baseModel({ state: 'loading', confirmedTotal: null, checkedAt: null })
    render(<MoneyHero model={model} />)
    expect(screen.getByText('Loading')).toBeTruthy()
  })

  it('shows the friendly "No balance yet" text for an authoritatively empty vault, never a bare "0"', () => {
    const model = baseModel({ state: 'empty', confirmedTotal: { state: 'known', amount: amt(0n) } })
    render(<MoneyHero model={model} />)
    expect(screen.getByText('No balance yet')).toBeTruthy()
    expect(screen.queryByText(/^0\s*USDC/)).toBeNull()
  })

  it('flags a real cached figure as stale using the built-in MoneyFigure stale flag', () => {
    const model = baseModel({ state: 'stale', freshness: 'stale' })
    render(<MoneyHero model={model} />)
    expect(screen.getByText('(stale)')).toBeTruthy()
  })

  it('keeps an unsafe-integer-sized canonical amount exact in the hero figure', () => {
    const units = '9007199254740993'
    const checkedAt = NOW
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'complete', agents: [] },
      money: {
        status: 'complete',
        confirmedTotal: { state: 'known', amount: amt(units, 7) },
        yield: { state: 'unavailable', apy: null },
        earned: { state: 'unavailable', amount: null },
        custodyBreakdown: { 'stellar-vault': units },
        unattributed: {},
        executionBreakdown: {},
        agentCount: 0,
        problemAgentCount: 0,
        agents: [],
        checkedAt,
        confirmedLedger: '12345',
        confirmedBlock: '67890',
        source: 'soroban-rpc',
      },
      now: checkedAt + 1_000,
    })
    expect(model.state).toBe('current')
    render(<MoneyHero model={model} />)
    expect(screen.getByText('900,719,925.4740993 USDC')).toBeTruthy()
    expect(screen.queryByText('900719925.4740992 USDC')).toBeNull()
  })

  it('fails closed when a money model carries a malformed checkedAt timestamp', () => {
    const model = baseModel({ checkedAt: 'not-a-timestamp', freshness: 'current' })
    render(<MoneyHero model={model} />)
    const hero = screen.getByRole('region', { name: 'Your money' })
    expect(within(hero).getByText('Unavailable')).toBeTruthy()
    expect(hero.querySelector('.pc-money--current')).toBeNull()
    expect(hero.querySelector('.pc-money--stale')).toBeNull()
  })
})

// Fix loop 2, I1: `model.state === 'stale'` alone is not the same claim as `model.freshness ===
// 'stale'`. `problem` and `partial-discovery` both outrank buildMyMoneyModel's own 'stale' state
// assignment (myMoneyModel.js:196-208, :254-270 outrank :306-308) while still genuinely carrying
// `freshness: 'stale'` once DEFAULT_STALE_AFTER_MS (2 minutes, freshness.js:18) has passed -- so a
// model built from real 30-day-old data must still flag stale in the hero even though its `state`
// is 'problem' or 'partial-discovery', never 'stale' itself. Built with the REAL
// buildMyMoneyModel, not a hand-written model literal, exactly as the review demanded: a
// hand-built fixture lets the author pick `state` and `freshness` independently and can never
// prove this bug exists.
describe('MoneyHero — I1 (fix loop 2): staleness comes from the real freshness triple, not model.state alone', () => {
  const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000

  // Matches the real MoneySnapshot shape myMoneyModel.js's own JSDoc documents (myMoneyModel.js:14-39).
  function realMoneySnapshot(overrides = {}) {
    return {
      confirmedTotal: { state: 'known', amount: amt(500_0000000n) },
      yield: { state: 'unavailable', apy: null },
      earned: { state: 'unavailable', amount: null },
      custodyBreakdown: { 'stellar-vault': '5000000000' },
      unattributed: {},
      executionBreakdown: {},
      agentCount: 1,
      problemAgentCount: 0,
      agents: [],
      checkedAt: NOW - THIRTY_DAYS_MS,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
      source: 'soroban-rpc',
      ...overrides,
    }
  }

  it('a real "problem" model (revoked-but-funded agent) from 30-day-old data flags stale, never confident-current', () => {
    const money = realMoneySnapshot({
      agents: [{ address: 'CREVOKED1', problems: ['scope-revoked'], amount: amt(500_0000000n) }],
    })
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'complete', agents: [] },
      money,
      now: NOW,
    })
    expect(model.state).toBe('problem')
    expect(model.freshness).toBe('stale')
    render(<MoneyHero model={model} />)
    expect(screen.getByText('(stale)')).toBeTruthy()
  })

  it('a real "partial-discovery" model from 30-day-old data flags stale, never confident-current', () => {
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'partial', agents: [] },
      money: realMoneySnapshot(),
      now: NOW,
    })
    expect(model.state).toBe('partial-discovery')
    expect(model.freshness).toBe('stale')
    render(<MoneyHero model={model} />)
    expect(screen.getByText('(stale)')).toBeTruthy()
  })

  // Not a proof of the state-vs-freshness ternary bug (heroFigureState's own allow-list already
  // excludes 'disconnected' from ever reaching the 'known' branch, so this passes on both sides of
  // the I1 fix) -- included because the coordinator asked for one per outranking state, and it
  // pins down a real, adjacent invariant: disconnected must never leak a known-but-stale figure
  // either, regardless of what freshness says.
  it('a real "disconnected" model never shows a known confirmed figure regardless of freshness', () => {
    const model = buildMyMoneyModel({
      owner: null,
      discovery: { status: 'complete', agents: [] },
      money: realMoneySnapshot(),
      now: NOW,
    })
    expect(model.state).toBe('disconnected')
    expect(model.freshness).toBe('stale') // computed regardless of connection state (myMoneyModel.js:221)
    render(<MoneyHero model={model} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/500/)).toBeNull()
  })

  it('a real "problem" model with a corrupt/missing checkedAt (freshness: unavailable) renders Unavailable, never a confident current figure', () => {
    const money = realMoneySnapshot({
      agents: [{ address: 'CREVOKED1', problems: ['scope-revoked'], amount: amt(500_0000000n) }],
      checkedAt: null,
    })
    const model = buildMyMoneyModel({
      owner: 'GOWNER',
      discovery: { status: 'complete', agents: [] },
      money,
      now: NOW,
    })
    expect(model.state).toBe('problem')
    expect(model.freshness).toBe('unavailable')
    render(<MoneyHero model={model} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/500/)).toBeNull()
  })
})

describe('MoneyHero — earned/APY only with valid evidence', () => {
  it('never shows an APY line when yield is unavailable', () => {
    render(<MoneyHero model={baseModel({ yield: { state: 'unavailable', apy: null } })} />)
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it('shows the APY line only once yield is genuinely live', () => {
    render(
      <MoneyHero
        model={baseModel({
          yield: {
            state: 'live',
            apy: 8.2,
            asOf: '2026-08-10T23:59:00.000Z',
            source: 'defillama',
            checkedAt: '2026-08-11T00:00:00.000Z',
          },
        })}
      />
    )
    expect(screen.getByText('Earning 8.2% APY')).toBeTruthy()
  })

  it('qualifies the APY line as stale when the model itself is stale, never showing a cached APY unqualified (I1)', () => {
    const model = baseModel({
      state: 'stale',
      freshness: 'stale',
      yield: {
        state: 'live',
        apy: 8.2,
        asOf: '2026-08-10T23:59:00.000Z',
        source: 'defillama',
        checkedAt: '2026-08-11T00:00:00.000Z',
      },
    })
    render(<MoneyHero model={model} />)
    expect(screen.getByText('Earning 8.2% APY (stale)')).toBeTruthy()
  })

  it('fails closed when a flat live yield omits nested source metadata', () => {
    render(<MoneyHero model={baseModel({ yield: { state: 'live', apy: 8.2 } })} />)
    expect(screen.queryByText(/APY/)).toBeNull()
  })

  it("never shows an Earned line while earned evidence is unavailable (today's real production shape)", () => {
    render(<MoneyHero model={baseModel()} />)
    expect(screen.queryByText(/^Earned/)).toBeNull()
  })

  it('shows Earned once given valid injected evidence (forward-compatible branch)', () => {
    const model = baseModel({ earned: { state: 'known', amount: amt(12_0000000n) } })
    render(<MoneyHero model={model} />)
    expect(screen.getByText(/^Earned 12/)).toBeTruthy()
  })
})

describe('MoneyHero — Partial discovery sits adjacent to totals/actions and exposes coverage', () => {
  it('renders the literal "Partial discovery" notice next to the total, with coverage counts', () => {
    const model = baseModel({
      state: 'partial-discovery',
      agentCount: 3,
      problemAgentCount: 1,
    })
    render(<MoneyHero model={model} />)
    const notice = screen.getByText('Partial discovery')
    expect(notice).toBeTruthy()
    // Adjacent to the total: both live inside the same hero section, not a separate disclosure.
    const hero = screen.getByRole('heading', { name: 'Your money' }).closest('section')
    expect(hero.contains(notice)).toBe(true)
    expect(screen.getByText(/3 agent\(s\) confirmed so far/)).toBeTruthy()
    expect(screen.getByText(/1 flagged for review/)).toBeTruthy()
  })

  it('never renders the Partial discovery notice outside that state', () => {
    render(<MoneyHero model={baseModel({ state: 'current' })} />)
    expect(screen.queryByText('Partial discovery')).toBeNull()
  })
})

describe('MoneyHero — unknown Base money never renders as absent', () => {
  it('surfaces unattributed unconfirmed Base balances even on an otherwise-current model', () => {
    const model = baseModel({
      unattributed: { '0xkernel1': { state: 'unavailable', amount: null, checkedAt: null } },
    })
    render(<MoneyHero model={model} />)
    expect(screen.getByText(/1 Base balance could not be confirmed/)).toBeTruthy()
  })
})

describe('MoneyHero — state-aware primary action', () => {
  it('offers Connect wallet when disconnected', () => {
    const onAction = vi.fn()
    const model = baseModel({ state: 'disconnected', owner: null, confirmedTotal: null })
    render(<MoneyHero model={model} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(onAction).toHaveBeenCalledWith('connect-wallet')
  })

  it('offers Review problem when a confirmed problem exists, beating every other action', () => {
    const onAction = vi.fn()
    const model = baseModel({ state: 'problem', problemAgents: ['CAGENT1'] })
    render(<MoneyHero model={model} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review problem' }))
    expect(onAction).toHaveBeenCalledWith('review-problem')
  })

  it('offers Make a deposit for an authoritatively empty vault', () => {
    const model = baseModel({ state: 'empty', confirmedTotal: { state: 'known', amount: amt(0n) } })
    render(<MoneyHero model={model} />)
    expect(screen.getByRole('button', { name: 'Make a deposit' })).toBeTruthy()
  })

  it('offers Renew vault protection only when the owner is the configured authority AND renewal is urgent', () => {
    const urgentModel = baseModel({
      protection: {
        state: 'armed',
        authority: 'GOWNER',
        mandateExpiry: NOW / 1000 + 100,
        urgentRenewal: true,
        ownerIsAuthority: true,
      },
    })
    render(<MoneyHero model={urgentModel} />)
    expect(screen.getByRole('button', { name: 'Renew vault protection' })).toBeTruthy()
  })

  it('falls back to Add money when urgent renewal exists but the owner is NOT the configured authority', () => {
    const model = baseModel({
      protection: {
        state: 'armed',
        authority: 'GSOMEONEELSE',
        mandateExpiry: NOW / 1000 + 100,
        urgentRenewal: true,
        ownerIsAuthority: false,
      },
    })
    render(<MoneyHero model={model} />)
    expect(screen.getByRole('button', { name: 'Add money' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Renew vault protection' })).toBeNull()
  })

  it('disables the primary action and shows a pending label while an action is in flight', () => {
    render(<MoneyHero model={baseModel()} actionPending />)
    const btn = screen.getByRole('button', { name: 'Working…' })
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('MoneyHero — accessibility', () => {
  it('has zero axe violations for a current, fully-populated model', async () => {
    const { container } = render(
      <MoneyHero model={baseModel({ yield: { state: 'live', apy: 5 } })} />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations for the disconnected state', async () => {
    const { container } = render(
      <MoneyHero model={baseModel({ state: 'disconnected', owner: null, confirmedTotal: null })} />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// Mutation-provable guard, same pattern as PlanStage.test.jsx's I6: reads the real shipped source
// text rather than a computed style jsdom can't be trusted for. Falsifiable: reintroducing
// `@keyframes`/`animation:`/a gradient onto this component's own primary action would fail this.
describe('MoneyHero — no forbidden motion/gradient (rejection checklist item 6)', () => {
  it("renders no inline style/animation in this component's own JSX", () => {
    const source = fs.readFileSync(path.resolve(here, './MoneyHero.jsx'), 'utf8')
    expect(source).not.toMatch(/style=|animation/i)
  })
})

describe('MoneyHero — AgentMark identity discipline (rejection checklist item 10)', () => {
  it('never imports AgentMark at all -- this surface renders no per-agent identity marks', () => {
    // MoneyHero is an aggregate total, never a per-agent view -- AgentTeam.jsx owns AgentMark.
    // Guards against a future edit silently smuggling a list-index-seeded mark in here.
    const source = fs.readFileSync(path.resolve(here, './MoneyHero.jsx'), 'utf8')
    expect(source).not.toMatch(/AgentMark/)
  })
})
