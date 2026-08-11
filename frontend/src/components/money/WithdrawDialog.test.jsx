// frontend/src/components/money/WithdrawDialog.test.jsx
// My Money Task 12. WithdrawDialog is a pure preview -- it plans (money/ownerActions.js's
// planFullExit/planPartialExit, real functions, not mocked) and calls the caller's
// onConfirmFull/onConfirmPartial/onConfirmBase; it never touches the chain itself.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { WithdrawDialog } from './WithdrawDialog.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

function amt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

// A real OwnerDiscoveryV1-shaped envelope (ownerDiscovery.js), the exact shape planFullExit reads
// (discovery.status/agents[].address/scopeReadStatus/revoked/expiry) -- not a hand-waved stub.
function discoveryWith(rows, status = 'complete') {
  return { status, agents: rows }
}

function activeRow(address) {
  return { address, scopeReadStatus: 'ok', revoked: false, expiry: 0 }
}

function revokedFundedRow(address) {
  return { address, scopeReadStatus: 'ok', revoked: true, expiry: 0 }
}

function positionAgent(address, units, location = 'stellar-vault') {
  return {
    address,
    amount: amt(units),
    custody: { location },
    custodyBreakdown: [{ location, amount: amt(units) }],
  }
}

const gAccount = { kind: 'G', address: 'GOWNER' }
const cAccount = { kind: 'C', address: 'COWNERCONTRACT' }

describe('WithdrawDialog — full exit, exact known-vs-partial target set', () => {
  it('lists every target agent with its real state, never a flattened "all active" set', () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), revokedFundedRow('CAGENT2')])
    const agents = [positionAgent('CAGENT1', 100_0000000n), positionAgent('CAGENT2', 50_0000000n)]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    const list = screen.getByRole('list', { name: /agents in this exit/i })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // Mutation guard: a formulation that labels every row identically (e.g. always "active") would
    // still pass a weaker "2 items rendered" check -- this asserts the SPECIFIC, DIFFERENT state
    // text ownerActions.js's targetState() computes for each real row.
    expect(items[0].textContent).toMatch(/CAGE.*1/i)
    expect(items[0].textContent).toMatch(/active/i)
    expect(items[1].textContent).toMatch(/CAGE.*2/i)
    expect(items[1].textContent).toMatch(/revoked, still holds a confirmed balance/i)
  })

  it('never under-counts the known total: one target with an unread amount demotes the WHOLE total to Unavailable', () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), activeRow('CAGENT2')])
    // CAGENT2 carries no `.amount` at all (an unread balance) -- the sum must not silently skip it.
    const agents = [
      positionAgent('CAGENT1', 100_0000000n),
      { address: 'CAGENT2', custody: { location: 'stellar-vault' }, custodyBreakdown: [] },
    ]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a formulation that sums only the KNOWN rows (silently treating the missing
    // one as 0) would render "100 USDC" here -- a confident-looking but wrong under-count. This
    // requires the honest "Unavailable" instead.
    expect(screen.getByText(/known amount across every target agent: unavailable/i)).toBeTruthy()
  })

  // Fix loop 1, I1 regression -- the reviewer's exact reproduction: a target whose `amount.units`
  // is PRESENT but unparseable. The pre-fix gate (`row?.amount?.units != null`) let this row
  // through, then the reducer's own try/catch silently dropped it, rendering a confident-looking
  // "Known amount across every target agent: 100 USDC" for a destructive full-exit preview instead
  // of the honest "Unavailable" -- the second agent's balance vanished with no marker at all.
  it('never under-counts the known total: one target with an UNPARSEABLE (not missing) amount also demotes the WHOLE total to Unavailable', () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), activeRow('CAGENT2')])
    const agents = [
      positionAgent('CAGENT1', 100_0000000n),
      {
        address: 'CAGENT2',
        amount: { token: 'USDC', units: 'not-a-number', decimals: 7 },
        custody: { location: 'stellar-vault' },
        custodyBreakdown: [],
      },
    ]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: reverting the gate to `row?.amount?.units != null` (a null check instead of a
    // parse check) passes this row -- `units` IS present -- then the reducer's catch silently drops
    // it, rendering "100 USDC" instead of "Unavailable".
    expect(screen.getByText(/known amount across every target agent: unavailable/i)).toBeTruthy()
  })

  // Fix loop 1, M2 regression -- the total's display decimals must come from the target rows'
  // own amounts, not a hardcoded 7. A 6-decimal token (e.g. a non-SAC asset) summed at the real
  // decimals reads correctly; read at a hardcoded 7 it would silently mis-scale by 10x.
  // Fix loop 2, M6 -- `BigInt('')` returns `0n` rather than throwing, so an EMPTY units string
  // passed the fix loop 1 parse gate and was silently summed as a confirmed zero: a leg with an
  // unknown balance read as a KNOWN zero rather than demoting the whole total. No production
  // producer emits this shape (readOwnerMoney.js's amountOf always `String(bigint)`), but it is
  // one condition in the same parse check already fixed here.
  it('never reads an EMPTY units string as a confirmed zero: it also demotes the WHOLE total to Unavailable', () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), activeRow('CAGENT2')])
    const agents = [
      positionAgent('CAGENT1', 100_0000000n),
      {
        address: 'CAGENT2',
        amount: { token: 'USDC', units: '', decimals: 7 },
        custody: { location: 'stellar-vault' },
        custodyBreakdown: [],
      },
    ]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a bare `BigInt(units)` parse attempt (fix loop 1's gate, without rejecting
    // blank strings first) lets this row through -- `BigInt('') === 0n` never throws -- then sums
    // it as a confirmed zero, rendering "100 USDC" instead of "Unavailable".
    expect(screen.getByText(/known amount across every target agent: unavailable/i)).toBeTruthy()
  })

  it("formats the known total using the TARGET ROWS' own decimals, not a hardcoded assumption", () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), activeRow('CAGENT2')])
    const agents = [
      { address: 'CAGENT1', amount: { token: 'USDC', units: '100000000', decimals: 6 } },
      { address: 'CAGENT2', amount: { token: 'USDC', units: '100000000', decimals: 6 } },
    ]
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a hardcoded `unitsToDisplay(knownTotal.toString(), 7)` would render "20 USDC"
    // here (200000000 units / 10^7) -- an order-of-magnitude-wrong figure for a real 6-decimal
    // token. The correct, decimals-derived total is 200.
    expect(screen.getByText(/known amount across every target agent: 200 usdc/i)).toBeTruthy()
    expect(screen.queryByText(/known amount across every target agent: 20 usdc/i)).toBeNull()
  })

  it('a partial-discovery envelope shows the honest "known agents only" limitation, not a false "exit all"', () => {
    const discovery = discoveryWith([activeRow('CAGENT1')], 'partial')
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /exit known agents/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^exit all$/i })).toBeNull()
    expect(screen.getByText(/not a guaranteed full-account sweep/i)).toBeTruthy()
  })
})

describe('WithdrawDialog — G-direct vs C-sponsored fee language, and hedged confirmation counts', () => {
  const discovery = discoveryWith([activeRow('CAGENT1')])
  const agents = [positionAgent('CAGENT1', 10_0000000n)]

  it('a G owner is told they sign and pay the fee themselves', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(
      screen.getByText(/you sign and submit directly.*pay the small network fee/i)
    ).toBeTruthy()
    expect(screen.queryByText(/relay sponsors the network fee/i)).toBeNull()
  })

  it('a C owner is told the relay sponsors the fee, never that they pay it', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={cAccount}
        onClose={() => {}}
      />
    )
    expect(screen.getByText(/network fee sponsored by fee-bump relay/i)).toBeTruthy()
    expect(screen.queryByText(/pay the small network fee yourself/i)).toBeNull()
  })

  it('never states an exact, unhedged confirmation count -- only a floor', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a formulation that drops the "at least"/"can split" hedge while keeping the
    // same number would still satisfy a bare `/1 wallet confirmation/` match -- this requires the
    // hedge phrase to be present too.
    expect(screen.getByText(/at least 1 wallet confirmation/i)).toBeTruthy()
    expect(screen.getByText(/can still split it into more/i)).toBeTruthy()
  })
})

describe('WithdrawDialog — Cancel alongside the destructive action, disabled while pending', () => {
  it('renders Cancel and the primary exit button together, and disables both while pending', () => {
    const discovery = discoveryWith([activeRow('CAGENT1')])
    const { rerender } = render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        pending={false}
      />
    )
    const cancel = screen.getByRole('button', { name: /cancel/i })
    const confirm = screen.getByRole('button', { name: /exit all/i })
    expect(cancel).toBeTruthy()
    expect(confirm.disabled).toBe(false)

    rerender(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        pending
      />
    )
    expect(screen.getByRole('button', { name: /cancel/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /withdrawing/i }).disabled).toBe(true)
  })

  it('does not close on Escape while pending (submission in flight), but does once idle', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <WithdrawDialog
        open
        agents={[]}
        discovery={discoveryWith([])}
        account={gAccount}
        onClose={onClose}
        pending
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <WithdrawDialog
        open
        agents={[]}
        discovery={discoveryWith([])}
        account={gAccount}
        onClose={onClose}
        pending={false}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('confirming calls the real plan through, never a fabricated substitute', () => {
    const onConfirmFull = vi.fn()
    const discovery = discoveryWith([activeRow('CAGENT1')])
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        onConfirmFull={onConfirmFull}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /exit all/i }))
    expect(onConfirmFull).toHaveBeenCalledTimes(1)
    const plan = onConfirmFull.mock.calls[0][0]
    expect(plan.ok).toBe(true)
    expect(plan.targets.map((t) => t.address)).toEqual(['CAGENT1'])
  })
})

// Fix loop 1 -- this copy existed in the component (both full and partial mode) but had ZERO test
// coverage: nothing would fail if it were deleted, watered down, or reworded to claim the opposite.
// Money-truth table row "What happens after partial failure" depends on this copy actually being
// present and actually saying what it claims.
describe('WithdrawDialog — partial-failure consequences, honest expectation-setting (fix loop 1)', () => {
  it('full exit: states plainly that a partial failure is rechecked against the chain, never assumed done or zero', () => {
    const discovery = discoveryWith([activeRow('CAGENT1')])
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    // Mutation guard: a version that drops this paragraph, or waters it down to "we'll retry" /
    // "your funds are safe" (an assurance, not the actual "we recheck the chain" mechanism) would
    // fail this specific text match, not just a "some copy exists" check.
    expect(screen.getByText(/never assume the rest is done or the position is zero/i)).toBeTruthy()
    expect(
      screen.getByText(/recheck the real chain balance before calling it complete/i)
    ).toBeTruthy()
  })

  it('partial exit: states plainly that no amount is assumed withdrawn until the chain confirms it', async () => {
    const discovery = discoveryWith([activeRow('CAGENT1')])
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    // Mutation guard: a version that drops this paragraph, or claims a partial failure "keeps the
    // remainder safe" without the "no amount is assumed withdrawn" claim, would fail this specific
    // text match.
    expect(
      screen.getByText(/no amount is assumed withdrawn until the chain confirms it/i)
    ).toBeTruthy()
  })
})

describe('WithdrawDialog — partial exit, delegates its correctness gate to planPartialExit', () => {
  const discovery = discoveryWith([activeRow('CAGENT1')])

  it('an amount over the confirmed balance is rejected with the real max, not silently allowed', async () => {
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    // Defect: a numeric input coerces the raw decimal before the shared parser sees it.
    fireEvent.change(screen.getByRole('textbox', { name: /amount/i }), { target: { value: '11' } })
    expect(screen.getByText(/exceeds this agent's confirmed balance \(10 usdc\)/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /withdraw this amount/i })).toBeNull()
  })

  it('a revoked agent falls back to full exit, offered explicitly rather than silently blocked', async () => {
    const revokedDiscovery = discoveryWith([revokedFundedRow('CAGENT1')])
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={revokedDiscovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    // Defect: a numeric input coerces the raw decimal before the shared parser sees it.
    fireEvent.change(screen.getByRole('textbox', { name: /amount/i }), { target: { value: '1' } })
    expect(screen.getByText(/exit-signer can no longer act on it/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /use full exit instead/i })).toBeTruthy()
  })

  it("a valid amount confirms through planPartialExit's own real output", async () => {
    const onConfirmPartial = vi.fn()
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        onConfirmPartial={onConfirmPartial}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    // Defect: a numeric input coerces the raw decimal before the shared parser sees it.
    fireEvent.change(screen.getByRole('textbox', { name: /amount/i }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /withdraw this amount/i }))
    expect(onConfirmPartial).toHaveBeenCalledTimes(1)
    const plan = onConfirmPartial.mock.calls[0][0]
    expect(plan.ok).toBe(true)
    expect(plan.mode).toBe('partial')
    expect(plan.agentAddress).toBe('CAGENT1')
  })

  // Defect: Number/Math.round changes integer units above Number.MAX_SAFE_INTEGER.
  it('preserves a raw text amount and confirms the exact canonical integer units', async () => {
    const onConfirmPartial = vi.fn()
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_000_000_000_000_000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        onConfirmPartial={onConfirmPartial}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    const input = screen.getByRole('textbox', { name: /amount/i })
    expect(input.type).toBe('text')
    expect(input.inputMode).toBe('decimal')
    fireEvent.change(input, { target: { value: '0900719925.4740993' } })
    expect(input.value).toBe('0900719925.4740993')
    fireEvent.click(screen.getByRole('button', { name: /withdraw this amount/i }))
    expect(onConfirmPartial).toHaveBeenCalledTimes(1)
    expect(onConfirmPartial.mock.calls[0][0].amount).toEqual({
      token: 'USDC',
      units: '9007199254740993',
      decimals: 7,
    })
  })

  // Defect: the dialog can apply Stellar's seven-decimal scale to a selected six-decimal leg.
  it('routes the selected Stellar-vault leg decimals through parsing and planning', async () => {
    const onConfirmPartial = vi.fn()
    const sixDecimalAmount = { token: 'USDC', units: '12345678', decimals: 6 }
    const agent = {
      address: 'CAGENT1',
      amount: sixDecimalAmount,
      custody: { location: 'stellar-vault' },
      custodyBreakdown: [{ location: 'stellar-vault', amount: sixDecimalAmount }],
    }
    render(
      <WithdrawDialog
        open
        agents={[agent]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        onConfirmPartial={onConfirmPartial}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    const input = screen.getByRole('textbox', { name: /amount/i })
    fireEvent.change(input, { target: { value: '12.345678' } })
    fireEvent.click(screen.getByRole('button', { name: /withdraw this amount/i }))
    expect(onConfirmPartial.mock.calls[0][0].amount).toEqual({
      token: 'USDC',
      units: '12345678',
      decimals: 6,
    })
  })

  // Defect: excess fractional digits are rounded and submitted instead of being rejected.
  it('rejects input more precise than the selected Stellar-vault leg', async () => {
    render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('textbox', { name: /amount/i }), {
      target: { value: '1.00000001' },
    })
    expect(screen.getByText(/more than 7 decimal places/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /withdraw this amount/i })).toBeNull()
  })
})

describe('WithdrawDialog — Base full unwind: honest known set + knownPool exit semantics, full-unwind only', () => {
  const discovery = discoveryWith([activeRow('CAGENT1')])
  const agents = [positionAgent('CAGENT1', 1_0000000n)]

  it('no Base tab at all when basePlan is absent -- fails closed, no dead button', () => {
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(screen.queryByRole('tab', { name: /base/i })).toBeNull()
  })

  it('keeps historical Base positions represented but disables the tab and CTA under the deployment gate', () => {
    const onConfirmBase = vi.fn()
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        basePlan={{
          available: false,
          unavailableReason:
            'Base cross-chain actions are temporarily unavailable while the hardened deployment is verified.',
          positions: [{ pool: '0xPOOL1', poolName: 'Historical Aave USDC', assets: 5_000000 }],
        }}
        onConfirmBase={onConfirmBase}
      />
    )

    const tab = screen.getByRole('tab', { name: /base full unwind/i })
    expect(tab.disabled).toBe(true)
    expect(tab.getAttribute('aria-describedby')).toBe('withdraw-base-unavailable')
    expect(screen.getByRole('status').textContent).toMatch(/temporarily unavailable/i)
    expect(screen.queryByRole('button', { name: /withdraw everything from base/i })).toBeNull()
    fireEvent.click(tab)
    expect(onConfirmBase).not.toHaveBeenCalled()
  })

  it('explains that disabling new deposits does not block a knownPool exit', () => {
    const basePlan = {
      available: true,
      positions: [{ pool: '0xPOOL1', poolName: 'Aave USDC', assets: 5_000000 }],
    }
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        basePlan={basePlan}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /base full unwind/i }))
    expect(screen.getByText(/aave usdc/i)).toBeTruthy()
    expect(screen.getByText(/5\.00 usdc/i)).toBeTruthy()
    expect(screen.getByText(/known.pool record/i)).toBeTruthy()
    expect(screen.getByText(/disabled pool remains sweepable/i)).toBeTruthy()
    expect(screen.queryByText(/skips that pool/i)).toBeNull()
    expect(screen.queryByText(/partial base withdrawal isn't available/i)).toBeTruthy()
  })

  it('confirming Base calls onConfirmBase with no arguments claiming a guaranteed amount', () => {
    const onConfirmBase = vi.fn()
    const basePlan = { available: true, positions: [{ pool: '0xPOOL1', assets: 1_000000 }] }
    render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
        basePlan={basePlan}
        onConfirmBase={onConfirmBase}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /base full unwind/i }))
    fireEvent.click(screen.getByRole('button', { name: /withdraw everything from base/i }))
    expect(onConfirmBase).toHaveBeenCalledTimes(1)
  })
})

describe('WithdrawDialog — accessibility', () => {
  it('has no axe violations in the full-exit state', async () => {
    const discovery = discoveryWith([activeRow('CAGENT1')])
    const { container } = render(
      <WithdrawDialog
        open
        agents={[positionAgent('CAGENT1', 10_0000000n)]}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ---------------------------------------------------------------------------------------------
// Real-browser 320px layout guard, per dialog state -- same launch mechanism MyMoneyRoute.test.jsx
// already uses (jsdom never runs layout; scrollWidth/getBoundingClientRect are inert there).
// ---------------------------------------------------------------------------------------------
const POCKET_CREW_CSS = fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8')
const MY_MONEY_CSS = fs.readFileSync(path.resolve(here, './my-money.css'), 'utf8')
const REAL_STYLESHEET = [POCKET_CREW_CSS, MY_MONEY_CSS].join('\n')
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../../style.css'), 'utf8')
const GEIST_FONT_HREF =
  'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

function buildLayoutHarnessHtml(bodyHtml) {
  // Final-review MUST-FIX 2: this harness used to inject `<div class="pc-my-money-route">` around
  // the body, claiming it matched the real MyMoneyRoute.jsx tree. app.jsx renders this dialog as a
  // SIBLING of <MyMoneyRoute> and Primitives.jsx's Dialog uses no portal, so no such ancestor ever
  // existed in production and the wrapper activated CSS that was dead on the shipped surface. The
  // scope now travels on the dialog's own `pc-money-dialog` class, so the body below is exactly
  // what React rendered and nothing about the cascade is supplied by this file.
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${GEIST_FONT_HREF}">
<style>${LEGACY_STYLESHEET}</style>
<style>${REAL_STYLESHEET}</style>
</head><body>${bodyHtml}</body></html>`
}

const CHROMIUM_CANDIDATES = [
  undefined,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]

async function launchRealChromium() {
  const { chromium } = await import('playwright-core')
  let lastErr
  for (const executablePath of CHROMIUM_CANDIDATES) {
    if (executablePath && !fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch(
        executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }
      )
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `Layout guard: no usable Chromium binary found for real-layout measurement (${lastErr?.message})`
  )
}

describe('WithdrawDialog — real-browser 320px layout guard, per state', () => {
  // Defect: changing the amount control can introduce horizontal overflow in the partial state.
  it('creates no horizontal overflow at 320px for full/partial/base states', async () => {
    const discovery = discoveryWith([activeRow('CAGENT1'), revokedFundedRow('CAGENT2')])
    const agents = [positionAgent('CAGENT1', 100_0000000n), positionAgent('CAGENT2', 50_0000000n)]
    const basePlan = {
      available: true,
      positions: [
        {
          pool: '0xLONGPOOLADDRESSFORLAYOUT00000000000000001',
          poolName: 'Aave USDC',
          assets: 5_000000,
        },
      ],
    }

    const states = []
    const full = render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    states.push(['full', full.container.innerHTML])
    full.unmount()

    const partial = render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={gAccount}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(screen.getByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('textbox', { name: /amount/i }), { target: { value: '5' } })
    states.push(['partial', partial.container.innerHTML])
    partial.unmount()

    const withBase = render(
      <WithdrawDialog
        open
        agents={agents}
        discovery={discovery}
        account={cAccount}
        onClose={() => {}}
        basePlan={basePlan}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /base full unwind/i }))
    states.push(['base', withBase.container.innerHTML])
    withBase.unmount()

    const browser = await launchRealChromium()
    try {
      for (const [label, html] of states) {
        const page = await browser.newPage()
        await page.setViewportSize({ width: 320, height: 1400 })
        await page.setContent(buildLayoutHarnessHtml(html))
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(scrollWidth, `${label} @320px scrollWidth`).toBe(320)
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})
