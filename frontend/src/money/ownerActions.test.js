// frontend/src/money/ownerActions.test.js
// Pocket Crew "My money" Task 9: owner-model-correct full exit, partial exit, revoke, and
// post-action reconciliation. planFullExit/planPartialExit/planRevoke are pure — no I/O, no
// signing — so every judgment call (which agents to target, whether a partial exit must fall back
// to a full exit, whether a revoke is safe to submit) is testable without a chain or a wallet.
// reconcileOwnerAction is the one async export: it re-reads money after a submission attempt,
// never optimistically zeroing a position.
import { describe, test, expect, vi } from 'vitest'
import {
  planFullExit,
  planPartialExit,
  planRevoke,
  ownerActionOutcome,
  reconcileOwnerAction,
  confirmationsCopy,
  feeModelCopy,
  targetStateLabel,
  signaturesForSweep,
  friendlyOwnerActionError,
} from './ownerActions.js'
import { MAX_AGENTS_PER_SWEEP } from '../stellar/exit.js'
import { OwnerActionSubmissionError } from '../stellar/ownerAuthorization.js'

const usdc = (units) => ({ token: 'USDC', units: String(units), decimals: 7 })

const discoveryRow = (address, overrides = {}) => ({
  address,
  scopeReadStatus: 'ok',
  vault: 'CVAULT',
  revoked: false,
  expiry: 0,
  authorized: true,
  ...overrides,
})

const moneyRow = (address, overrides = {}) => ({
  address,
  scope: {
    state: 'known',
    value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
    checkedAt: 1,
  },
  vaultShares: { state: 'known', amount: usdc(0), checkedAt: 1 },
  idleToken: { state: 'known', amount: usdc(0), checkedAt: 1 },
  amount: usdc(0),
  executionStatus: 'idle',
  custody: { location: 'agent' },
  custodyBreakdown: [],
  problems: [],
  ...overrides,
})

describe('planFullExit', () => {
  test('complete discovery: "Exit all", known:true, no limitation', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1'), discoveryRow('CA2')] }
    const position = { agents: [moneyRow('CA1'), moneyRow('CA2')] }
    const plan = planFullExit({ discovery, position, account: { kind: 'G', address: 'GOWNER' } })
    expect(plan.ok).toBe(true)
    expect(plan.known).toBe(true)
    expect(plan.label).toBe('Exit all')
    expect(plan.limitation).toBeNull()
  })

  test('partial discovery: "Exit known agents", known:false, and the limitation is its own field — not just prose a caller could drop', () => {
    const discovery = { status: 'partial', agents: [discoveryRow('CA1')] }
    const position = { agents: [moneyRow('CA1')] }
    const plan = planFullExit({ discovery, position, account: { kind: 'G', address: 'GOWNER' } })
    expect(plan.known).toBe(false)
    expect(plan.label).toBe('Exit known agents')
    expect(typeof plan.limitation).toBe('string')
    expect(plan.limitation.length).toBeGreaterThan(0)
  })

  test('targets include active, expired, revoked, AND revoked-but-funded agents — none filtered out', () => {
    const now = 1_000_000_000_000 // ms
    const nowSec = Math.floor(now / 1000)
    const discovery = {
      status: 'complete',
      agents: [
        discoveryRow('CA_ACTIVE'),
        discoveryRow('CA_EXPIRED', { expiry: nowSec - 10 }),
        discoveryRow('CA_REVOKED', { revoked: true }),
        discoveryRow('CA_REVOKED_FUNDED', { revoked: true }),
      ],
    }
    const position = {
      agents: [
        moneyRow('CA_ACTIVE'),
        moneyRow('CA_EXPIRED'),
        moneyRow('CA_REVOKED'), // empty — already swept
        moneyRow('CA_REVOKED_FUNDED', { amount: usdc(5_000_000) }), // still holds money
      ],
    }
    const plan = planFullExit({
      discovery,
      position,
      account: { kind: 'G', address: 'GOWNER' },
      now,
    })
    const byAddr = Object.fromEntries(plan.targets.map((t) => [t.address, t.state]))
    expect(byAddr).toEqual({
      CA_ACTIVE: 'active',
      CA_EXPIRED: 'expired',
      CA_REVOKED: 'revoked',
      CA_REVOKED_FUNDED: 'revoked-funded',
    })
    expect(plan.targets).toHaveLength(4) // every one of them present — revoked is never dropped as "already handled"
  })

  test('Fix 2 (fix loop 1): a revoked agent with an unavailable balance read is "revoked-unknown", never classified as if it were already swept', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1', { revoked: true })] }
    const position = { agents: [moneyRow('CA1', { amount: null })] }
    const plan = planFullExit({ discovery, position, account: { kind: 'G', address: 'GOWNER' } })
    expect(plan.targets[0].state).toBe('revoked-unknown')
  })

  test('Fix 2: a revoked agent with a PROVEN zero balance still classifies as plain "revoked"', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1', { revoked: true })] }
    const position = { agents: [moneyRow('CA1', { amount: usdc(0) })] }
    const plan = planFullExit({ discovery, position, account: { kind: 'G', address: 'GOWNER' } })
    expect(plan.targets[0].state).toBe('revoked')
  })

  test('Fix 2: a revoked-but-funded agent is unaffected by the new unknown state', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1', { revoked: true })] }
    const position = { agents: [moneyRow('CA1', { amount: usdc(5_000_000) })] }
    const plan = planFullExit({ discovery, position, account: { kind: 'G', address: 'GOWNER' } })
    expect(plan.targets[0].state).toBe('revoked-funded')
  })

  test('Fix 2: the same unknown-balance distinction applies symmetrically to an expired agent', () => {
    const nowSec = 1_700_000_000
    const discovery = { status: 'complete', agents: [discoveryRow('CA1', { expiry: nowSec - 5 })] }
    const position = { agents: [moneyRow('CA1', { amount: null })] }
    const plan = planFullExit({
      discovery,
      position,
      account: { kind: 'G', address: 'GOWNER' },
      now: nowSec * 1000,
    })
    expect(plan.targets[0].state).toBe('expired-unknown')
  })

  test('a scope read failure targets as "unknown" rather than being dropped or guessed active', () => {
    const discovery = {
      status: 'partial',
      agents: [
        discoveryRow('CA1', {
          scopeReadStatus: 'failed',
          revoked: null,
          expiry: null,
          authorized: null,
        }),
      ],
    }
    const plan = planFullExit({
      discovery,
      position: { agents: [] },
      account: { kind: 'G', address: 'GOWNER' },
    })
    expect(plan.targets[0]).toMatchObject({ address: 'CA1', state: 'unknown' })
  })

  test('rejects a zero (blank) address', () => {
    const discovery = { status: 'complete', agents: [discoveryRow(''), discoveryRow('CA1')] }
    const plan = planFullExit({
      discovery,
      position: { agents: [] },
      account: { kind: 'G', address: 'GOWNER' },
    })
    expect(plan.targets.map((t) => t.address)).toEqual(['CA1'])
  })

  test('rejects a duplicate address — one target, not two', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1'), discoveryRow('CA1')] }
    const plan = planFullExit({
      discovery,
      position: { agents: [] },
      account: { kind: 'G', address: 'GOWNER' },
    })
    expect(plan.targets).toHaveLength(1)
  })

  test('rejects a foreign agent — an address only present in `position`, never in discovery, is never targeted', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1')] }
    const position = { agents: [moneyRow('CA1'), moneyRow('CA_FOREIGN')] }
    const plan = planFullExit({ discovery, position, account: { kind: 'G', address: 'GOWNER' } })
    expect(plan.targets.map((t) => t.address)).toEqual(['CA1'])
  })

  test('expected confirmation count derives from actual batch splits (MAX_AGENTS_PER_SWEEP)', () => {
    const n = MAX_AGENTS_PER_SWEEP * 2 + 1 // one full batch short of 3 batches
    const discovery = {
      status: 'complete',
      agents: Array.from({ length: n }, (_, i) => discoveryRow(`CA${i}`)),
    }
    const plan = planFullExit({
      discovery,
      position: { agents: [] },
      account: { kind: 'G', address: 'GOWNER' },
    })
    expect(plan.expectedConfirmations).toBe(Math.ceil(n / MAX_AGENTS_PER_SWEEP))
    expect(plan.batches).toHaveLength(plan.expectedConfirmations)
  })

  test('C account: the plan still carries account/model — G vs C is decided at execution, not planning', () => {
    const discovery = { status: 'complete', agents: [discoveryRow('CA1')] }
    const plan = planFullExit({
      discovery,
      position: { agents: [] },
      account: { kind: 'C', address: 'COWNER' },
    })
    expect(plan.model).toBe('C')
    expect(plan.account).toMatchObject({ kind: 'C', address: 'COWNER' })
  })

  test('unavailable discovery: not ok, and never silently claims "Exit all"', () => {
    const plan = planFullExit({
      discovery: { status: 'unavailable', agents: [] },
      position: { agents: [] },
      account: {},
    })
    expect(plan.ok).toBe(false)
    expect(plan.label).not.toBe('Exit all')
  })

  test('no agents at all: not ok', () => {
    const plan = planFullExit({
      discovery: { status: 'complete', agents: [] },
      position: { agents: [] },
      account: {},
    })
    expect(plan.ok).toBe(false)
  })
})

describe('planPartialExit', () => {
  const account = { kind: 'G', address: 'GOWNER' }

  test('revoked scope: falls back to full exit, truthfully — never labels the balance lost', () => {
    const agent = moneyRow('CA1', {
      scope: {
        state: 'known',
        value: { vault: 'CVAULT', revoked: true, expiry: 0, authorized: true },
        checkedAt: 1,
      },
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = true
    agent.expiry = 0
    const plan = planPartialExit({ agent, amount: usdc(1_000_000), account })
    expect(plan.ok).toBe(true)
    expect(plan.mode).toBe('fallback-full-exit')
    expect(plan.reason).toBe('scope-revoked')
    expect(plan.message).not.toMatch(/\bis lost\b/i)
    expect(plan.message).toMatch(/not lost/i)
    expect(plan.message).toMatch(/full exit/i)
  })

  test('expired scope: falls back to full exit', () => {
    const nowSec = 1_700_000_000
    const agent = moneyRow('CA1')
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = nowSec - 5
    const plan = planPartialExit({ agent, amount: usdc(1_000_000), account, now: nowSec * 1000 })
    expect(plan.mode).toBe('fallback-full-exit')
    expect(plan.reason).toBe('scope-expired')
  })

  test('unknown scope: never guessed as safe to partial-exit', () => {
    const agent = moneyRow('CA1')
    agent.scopeReadStatus = 'failed'
    agent.revoked = null
    agent.expiry = null
    const plan = planPartialExit({ agent, amount: usdc(1_000_000), account })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('scope-unknown')
  })

  test('split agent (Stellar + Base leg): reads the per-leg custodyBreakdown, not the collapsed "unknown" location', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'unknown' }, // collapsed summary — must NOT be trusted directly
      custodyBreakdown: [
        { location: 'stellar-vault', amount: usdc(8_000_000) },
        { location: 'base-proxy', amount: usdc(2_000_000) },
      ],
      executionStatus: 'succeeded',
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({ agent, amount: usdc(5_000_000), account })
    expect(plan.ok).toBe(true)
    expect(plan.mode).toBe('partial')
  })

  test('split agent: an amount within the Base leg but exceeding the Stellar-vault leg is rejected — Base has no partial-exit path here', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'unknown' },
      custodyBreakdown: [
        { location: 'stellar-vault', amount: usdc(1_000_000) },
        { location: 'base-proxy', amount: usdc(9_000_000) },
      ],
      executionStatus: 'succeeded',
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({ agent, amount: usdc(5_000_000), account })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('exceeds-max')
  })

  test('plain (non-split) agent: uses custody.location stellar-vault directly', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'stellar-vault' },
      amount: usdc(10_000_000),
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({ agent, amount: usdc(4_000_000), account })
    expect(plan.ok).toBe(true)
    expect(plan.mode).toBe('partial')
  })

  test('amount exceeds the agent max: rejected before any signing', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'stellar-vault' },
      amount: usdc(1_000_000),
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({ agent, amount: usdc(9_000_000), account })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('exceeds-max')
  })

  // Defect: a different token can be compared numerically with the selected Stellar-vault leg.
  test('rejects an amount token mismatch before comparing the available balance', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'stellar-vault' },
      amount: usdc(1_000_000),
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({
      agent,
      amount: { token: 'EURC', units: '9000000', decimals: 7 },
      account,
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('asset-mismatch')
  })

  // Defect: units at different decimal scales can be compared as though they represented one asset.
  test('rejects an amount decimals mismatch before comparing the available balance', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'stellar-vault' },
      amount: usdc(1_000_000),
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({
      agent,
      amount: { token: 'USDC', units: '9000000', decimals: 6 },
      account,
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('asset-mismatch')
  })

  // Defect: a successful plan can preserve padded unit text instead of one canonical integer string.
  test('returns successful partial-exit units as a canonical integer string', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'stellar-vault' },
      amount: usdc(1_000_000),
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({
      agent,
      amount: { token: 'USDC', units: '0001000', decimals: 7 },
      account,
    })
    expect(plan.ok).toBe(true)
    expect(plan.amount).toEqual({ token: 'USDC', units: '1000', decimals: 7 })
  })

  test('no known Stellar-vault balance: rejected as balance-unavailable, never a guessed zero', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'unknown' },
      vaultShares: { state: 'unavailable', amount: null },
    })
    agent.scopeReadStatus = 'ok'
    agent.revoked = false
    agent.expiry = 0
    const plan = planPartialExit({ agent, amount: usdc(1_000_000), account })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('balance-unavailable')
  })

  test('zero/invalid amount rejected', () => {
    const agent = moneyRow('CA1', {
      custody: { location: 'stellar-vault' },
      amount: usdc(10_000_000),
    })
    agent.scopeReadStatus = 'ok'
    const plan = planPartialExit({ agent, amount: usdc(0), account })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('invalid-amount')
  })
})

describe('planRevoke', () => {
  const agent = { address: 'CA1' }
  const account = { kind: 'G', address: 'GOWNER' }

  test('known positive shares: directs the owner to withdraw first, blocks the revoke', () => {
    const plan = planRevoke({
      agent,
      shareRead: { state: 'known', amount: usdc(5_000_000) },
      idleBalanceRead: { state: 'known', amount: usdc(0) },
      account,
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('funded')
    expect(plan.message).toMatch(/withdraw/i)
  })

  test('known positive idle balance alone also blocks the revoke', () => {
    const plan = planRevoke({
      agent,
      shareRead: { state: 'known', amount: usdc(0) },
      idleBalanceRead: { state: 'known', amount: usdc(3_000_000) },
      account,
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toBe('funded')
  })

  test('both known zero: revoke proceeds, no warning', () => {
    const plan = planRevoke({
      agent,
      shareRead: { state: 'known', amount: usdc(0) },
      idleBalanceRead: { state: 'known', amount: usdc(0) },
      account,
    })
    expect(plan.ok).toBe(true)
    expect(plan.warning).toBeNull()
  })

  test('unavailable balance read: warns but PRESERVES the owner-authorized revoke action (kill switch never removed)', () => {
    const plan = planRevoke({
      agent,
      shareRead: { state: 'unavailable', amount: null },
      idleBalanceRead: { state: 'known', amount: usdc(0) },
      account,
    })
    expect(plan.ok).toBe(true)
    expect(plan.warning).toBe('Funding status could not be checked')
  })

  test('both reads unavailable: still ok, still warns', () => {
    const plan = planRevoke({
      agent,
      shareRead: { state: 'unavailable', amount: null },
      idleBalanceRead: { state: 'unavailable', amount: null },
      account,
    })
    expect(plan.ok).toBe(true)
    expect(plan.warning).toBe('Funding status could not be checked')
  })

  test('Base-associated agent (bridge/kernel): "Stop access" is scoped Stellar-only, fail-closed — no dead Base button', () => {
    const bridgeAgent = { address: 'CA1', executionStatus: 'succeeded' }
    const plan = planRevoke({
      agent: bridgeAgent,
      shareRead: { state: 'known', amount: usdc(0) },
      idleBalanceRead: { state: 'known', amount: usdc(0) },
      account,
    })
    expect(plan.ok).toBe(true)
    expect(plan.baseStopAccess).toMatchObject({ available: false, scope: 'stellar-only' })
  })

  test('plain Stellar-only agent: no baseStopAccess field noise', () => {
    const plan = planRevoke({
      agent: { address: 'CA1', executionStatus: 'idle' },
      shareRead: { state: 'known', amount: usdc(0) },
      idleBalanceRead: { state: 'known', amount: usdc(0) },
      account,
    })
    expect(plan.baseStopAccess).toBeNull()
  })
})

describe('ownerActionOutcome', () => {
  test('ok:true maps to confirmed-success', () => {
    expect(ownerActionOutcome({ agentAddress: 'CA1', ok: true, txHash: 'h1' }).outcome).toBe(
      'confirmed-success'
    )
  })
  test('status: SUCCESS (revoke/ownerWithdraw raw shape) also maps to confirmed-success', () => {
    expect(ownerActionOutcome({ agentAddress: 'CA1', status: 'SUCCESS', hash: 'h1' }).outcome).toBe(
      'confirmed-success'
    )
  })
  test('a not-submitted OwnerActionSubmissionError stays not-submitted, distinct from unknown/confirmed', () => {
    const err = new OwnerActionSubmissionError('refused', 'VF_RELAY_REFUSED', 'not-submitted')
    expect(ownerActionOutcome({ agentAddress: 'CA1', error: err }).outcome).toBe('not-submitted')
  })
  test('an unknown-submission OwnerActionSubmissionError stays unknown — never collapsed into confirmed or not-submitted', () => {
    const err = new OwnerActionSubmissionError('lost contact', 'VF_SUBMISSION_UNKNOWN', 'unknown')
    expect(ownerActionOutcome({ agentAddress: 'CA1', error: err }).outcome).toBe('unknown')
  })
  test('a plain on-chain failure (bare Error, reached the chain) is confirmed-failed, not not-submitted', () => {
    const err = new Error('The exit was not confirmed: FAILED.')
    expect(ownerActionOutcome({ agentAddress: 'CA1', error: err }).outcome).toBe('confirmed-failed')
  })
  test('ok:false with a string error is confirmed-failed', () => {
    expect(
      ownerActionOutcome({ agentAddress: 'CA1', ok: false, error: 'nothing to sweep' }).outcome
    ).toBe('confirmed-failed')
  })
  test('a result object with neither an ok/status nor an error is unknown, not a fabricated confirmed-failed', () => {
    // Fix 1 (fix loop 1), second half: the default branch used to map ANY error-less/unrecognized
    // result to confirmed-failed. A result that says nothing at all is not proof of a failure.
    expect(ownerActionOutcome({ agentAddress: 'CA1' }).outcome).toBe('unknown')
  })
})

describe('reconcileOwnerAction', () => {
  test('all not-submitted: reports not-submitted, never calls readOwnerMoney, retry allowed', async () => {
    const readOwnerMoney = vi.fn()
    const err = new OwnerActionSubmissionError('refused', 'VF_RELAY_REFUSED', 'not-submitted')
    const out = await reconcileOwnerAction({
      action: { kind: 'revoke', agentAddress: 'CA1' },
      result: { agentAddress: 'CA1', error: err },
      readOwnerMoney,
      beforeRevision: 3,
    })
    expect(out.status).toBe('not-submitted')
    expect(out.retryAllowed).toBe(true)
    expect(readOwnerMoney).not.toHaveBeenCalled()
    expect(out.revision).toBe(3) // unchanged — nothing was re-read
  })

  test('an unknown submission renders "Checking status" and forbids automatic retry', async () => {
    const err = new OwnerActionSubmissionError('lost contact', 'VF_SUBMISSION_UNKNOWN', 'unknown')
    const readOwnerMoney = vi.fn(async () => ({ checkedAt: 1, agents: [] }))
    const out = await reconcileOwnerAction({
      action: { kind: 'revoke', agentAddress: 'CA1' },
      result: { agentAddress: 'CA1', error: err },
      readOwnerMoney,
      beforeRevision: 3,
    })
    expect(out.status).toBe('checking')
    expect(out.label).toBe('Checking status')
    expect(out.retryAllowed).toBe(false)
    expect(out.revision).toBe(4) // a re-read DID happen, trying to resolve it from chain
  })

  test('external on-chain revocation reconciles an unknown revoke submission to confirmed/complete', async () => {
    const err = new OwnerActionSubmissionError('lost contact', 'VF_SUBMISSION_UNKNOWN', 'unknown')
    const readOwnerMoney = vi.fn(async () => ({
      checkedAt: 2,
      agents: [
        {
          address: 'CA1',
          scope: { state: 'known', value: { revoked: true, expiry: 0 }, checkedAt: 2 },
          vaultShares: { state: 'known', amount: usdc(0) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
      ],
    }))
    const out = await reconcileOwnerAction({
      action: { kind: 'revoke', agentAddress: 'CA1' },
      result: { agentAddress: 'CA1', error: err },
      readOwnerMoney,
      beforeRevision: 0,
    })
    expect(out.complete).toBe(true)
    expect(out.status).toBe('complete')
  })

  test('full exit: complete requires BOTH a confirmed result AND zero remaining balance across the resolved targets', async () => {
    const readOwnerMoney = vi.fn(async () => ({
      checkedAt: 2,
      agents: [
        {
          address: 'CA1',
          vaultShares: { state: 'known', amount: usdc(0) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
        {
          address: 'CA2',
          vaultShares: { state: 'known', amount: usdc(0) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
      ],
    }))
    const out = await reconcileOwnerAction({
      action: { kind: 'full-exit', targets: [{ address: 'CA1' }, { address: 'CA2' }] },
      result: [
        { agentAddress: 'CA1', ok: true, txHash: 'h1' },
        { agentAddress: 'CA2', ok: true, txHash: 'h1' },
      ],
      readOwnerMoney,
      beforeRevision: 0,
    })
    expect(out.complete).toBe(true)
    expect(out.status).toBe('complete')
  })

  test('confirmed result but a balance is STILL present on re-read: never an optimistic complete', async () => {
    const readOwnerMoney = vi.fn(async () => ({
      checkedAt: 2,
      agents: [
        {
          address: 'CA1',
          vaultShares: { state: 'known', amount: usdc(1_000_000) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
      ],
    }))
    const out = await reconcileOwnerAction({
      action: { kind: 'full-exit', targets: [{ address: 'CA1' }] },
      result: [{ agentAddress: 'CA1', ok: true, txHash: 'h1' }],
      readOwnerMoney,
      beforeRevision: 0,
    })
    expect(out.complete).toBe(false)
    expect(out.status).toBe('partial')
  })

  test('a successful sibling stays successful in the outcomes list even when another batch fails outright', async () => {
    const readOwnerMoney = vi.fn(async () => ({
      checkedAt: 2,
      agents: [
        {
          address: 'CA1',
          vaultShares: { state: 'known', amount: usdc(0) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
        {
          address: 'CA2',
          vaultShares: { state: 'known', amount: usdc(5_000_000) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
      ],
    }))
    const out = await reconcileOwnerAction({
      action: { kind: 'full-exit', targets: [{ address: 'CA1' }, { address: 'CA2' }] },
      result: [
        { agentAddress: 'CA1', ok: true, txHash: 'h1' },
        { agentAddress: 'CA2', ok: false, error: 'Transaction xyz failed on-chain.' },
      ],
      readOwnerMoney,
      beforeRevision: 0,
    })
    const byAddr = Object.fromEntries(out.outcomes.map((o) => [o.agentAddress, o.outcome]))
    expect(byAddr.CA1).toBe('confirmed-success') // never demoted by CA2's failure
    expect(byAddr.CA2).toBe('confirmed-failed')
    expect(out.complete).toBe(false) // the ACTION as a whole is not fully complete
  })

  test('Fix 4 bullet 5 (fix loop 1): a mix of not-submitted and confirmed-success is NOT the all-not-submitted shortcut — it re-reads and stays partial, not complete', async () => {
    const readOwnerMoney = vi.fn(async () => ({
      checkedAt: 2,
      agents: [
        {
          address: 'CA1',
          vaultShares: { state: 'known', amount: usdc(0) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
        {
          address: 'CA2',
          vaultShares: { state: 'known', amount: usdc(0) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
      ],
    }))
    const notSubmittedErr = new OwnerActionSubmissionError(
      'refused',
      'VF_RELAY_REFUSED',
      'not-submitted'
    )
    const out = await reconcileOwnerAction({
      action: { kind: 'full-exit', targets: [{ address: 'CA1' }, { address: 'CA2' }] },
      result: [
        { agentAddress: 'CA1', error: notSubmittedErr },
        { agentAddress: 'CA2', ok: true, txHash: 'h1' },
      ],
      readOwnerMoney,
      beforeRevision: 0,
    })
    // Only ALL-not-submitted skips the re-read; one confirmed sibling means something DID reach
    // the chain, so the honest move is still to re-read, not to shortcut.
    expect(readOwnerMoney).toHaveBeenCalled()
    const byAddr = Object.fromEntries(out.outcomes.map((o) => [o.agentAddress, o.outcome]))
    expect(byAddr.CA1).toBe('not-submitted')
    expect(byAddr.CA2).toBe('confirmed-success')
    // Not every target reached confirmed-success, so the action as a whole cannot be 'complete'.
    expect(out.complete).toBe(false)
    expect(out.status).toBe('partial')
  })

  test('Fix 1 (fix loop 2): a full-exit sweep with a PENDING-poll-exhaustion leg (VF_SUBMISSION_UNKNOWN) reconciles to "checking", never "partial" with a null label', async () => {
    // exit.js now raises this for a G owner whose sweep confirmation poll ran out before seeing an
    // outcome (fix loop 2's Fix 1) instead of a bare Error — this is the reconciliation half of
    // that fix: reconcileOwnerAction must already route it to the 'checking' state that exists for
    // exactly this, not read it as an ordinary confirmed failure ('partial', label: null).
    const err = new OwnerActionSubmissionError(
      'The exit was not confirmed: PENDING. Check the chain before retrying.',
      'VF_SUBMISSION_UNKNOWN',
      'unknown'
    )
    const readOwnerMoney = vi.fn(async () => ({
      checkedAt: 2,
      agents: [
        {
          address: 'CA1',
          vaultShares: { state: 'known', amount: usdc(5_000_000) },
          idleToken: { state: 'known', amount: usdc(0) },
        },
      ],
    }))
    const out = await reconcileOwnerAction({
      action: { kind: 'full-exit', targets: [{ address: 'CA1' }] },
      result: [{ agentAddress: 'CA1', ok: false, error: err }],
      readOwnerMoney,
      beforeRevision: 0,
    })
    expect(out.status).toBe('checking')
    expect(out.label).toBe('Checking status')
    expect(out.status).not.toBe('partial')
  })

  test('a readOwnerMoney failure never manufactures a false complete', async () => {
    const readOwnerMoney = vi.fn(async () => {
      throw new Error('RPC down')
    })
    const out = await reconcileOwnerAction({
      action: { kind: 'full-exit', targets: [{ address: 'CA1' }] },
      result: [{ agentAddress: 'CA1', ok: true, txHash: 'h1' }],
      readOwnerMoney,
      beforeRevision: 5,
    })
    expect(out.complete).toBe(false)
    expect(out.revision).toBe(6) // a re-read was attempted — revision still advances
  })
})

// -------------------------------------------------------------------------------------------
// My Money Task 13 Part B item 7: presentation copy moved here from WithdrawDialog.jsx
// (confirmationsCopy/feeModelCopy/targetStateLabel) and WithdrawModal.jsx
// (signaturesFor/friendlyError) -- both files now import from here instead of keeping a local
// copy. See ownerActions.js's own header comment on this section for the MM12 concern it closes.
// -------------------------------------------------------------------------------------------
describe('confirmationsCopy', () => {
  test('zero/non-finite -> no confirmation needed', () => {
    expect(confirmationsCopy(0)).toBe('No wallet confirmation is needed.')
    expect(confirmationsCopy(NaN)).toBe('No wallet confirmation is needed.')
    expect(confirmationsCopy(undefined)).toBe('No wallet confirmation is needed.')
  })
  test('exactly 1 -> singular phrasing, never plural', () => {
    expect(confirmationsCopy(1)).toBe(
      'At least 1 wallet confirmation (a busy network can still split it into more).'
    )
  })
  test('more than 1 -> plural, batches phrasing', () => {
    expect(confirmationsCopy(3)).toBe(
      'At least 3 wallet confirmations, in batches (a busy network can split a batch into more).'
    )
  })
})

describe('feeModelCopy', () => {
  test('C -> network fee sponsored by the fee-bump relay', () => {
    expect(feeModelCopy('C')).toBe('Network fee sponsored by fee-bump relay.')
  })
  test('G (or anything else) -> the owner pays their own fee', () => {
    expect(feeModelCopy('G')).toMatch(/you pay the small network fee yourself/)
    expect(feeModelCopy(undefined)).toMatch(/you pay the small network fee yourself/)
  })
})

describe('targetStateLabel', () => {
  test('every targetState() vocabulary word maps to a distinct, honest sentence', () => {
    const cases = {
      active: 'active',
      revoked: 'revoked, no balance left to confirm',
      'revoked-funded': 'revoked, still holds a confirmed balance',
      'revoked-unknown': 'revoked, balance could not be confirmed',
      expired: 'expired, no balance left to confirm',
      'expired-funded': 'expired, still holds a confirmed balance',
      'expired-unknown': 'expired, balance could not be confirmed',
      unknown: 'status unknown',
    }
    for (const [state, expected] of Object.entries(cases)) {
      expect(targetStateLabel(state)).toBe(expected)
    }
  })
})

describe('signaturesForSweep', () => {
  test('oneSignatureExit (default): matches planFullExit batching exactly (MAX_AGENTS_PER_SWEEP chunks)', () => {
    // Cross-check against the SAME batching planFullExit's own `expectedConfirmations` produces,
    // so the two numbers can never silently drift apart.
    const discovery = {
      status: 'complete',
      agents: Array.from({ length: MAX_AGENTS_PER_SWEEP * 2 + 1 }, (_, i) =>
        discoveryRow(`CA${i}`)
      ),
    }
    const plan = planFullExit({ discovery, position: { agents: [] }, account: { kind: 'G' } })
    expect(signaturesForSweep(discovery.agents.length)).toBe(plan.expectedConfirmations)
  })
  test('oneSignatureExit:false -> one signature per agent, no batching', () => {
    expect(signaturesForSweep(7, { oneSignatureExit: false })).toBe(7)
  })
  test('zero/non-finite agent count -> 0, never NaN or a negative', () => {
    expect(signaturesForSweep(0)).toBe(0)
    expect(signaturesForSweep(-1)).toBe(0)
    expect(signaturesForSweep(NaN)).toBe(0)
  })
})

describe('friendlyOwnerActionError', () => {
  test('user rejection (code or message) -> the same friendly line either way', () => {
    expect(friendlyOwnerActionError({ code: 'ACTION_REJECTED' })).toBe(
      'You rejected the transaction in your wallet.'
    )
    expect(friendlyOwnerActionError({ code: 4001 })).toBe(
      'You rejected the transaction in your wallet.'
    )
    expect(friendlyOwnerActionError({ message: 'User denied transaction signature.' })).toBe(
      'You rejected the transaction in your wallet.'
    )
  })
  test('insufficient funds/balance -> insufficient balance copy', () => {
    expect(friendlyOwnerActionError({ message: 'Insufficient funds for gas' })).toBe(
      'Insufficient balance to cover this withdrawal.'
    )
  })
  test('timeout -> relayer timed out copy', () => {
    expect(friendlyOwnerActionError({ message: 'Request timed out' })).toBe(
      'The relayer timed out. Please try again.'
    )
  })
  test('expired/permission -> re-grant copy', () => {
    expect(friendlyOwnerActionError({ message: 'permission expired' })).toBe(
      'Agent permission is no longer active. Re-grant and retry.'
    )
  })
  test('short wallet-provided message with none of the above -> passed through verbatim', () => {
    expect(friendlyOwnerActionError({ shortMessage: 'Simulation failed: bad auth' })).toBe(
      'Simulation failed: bad auth'
    )
  })
  test('no usable message at all -> the generic fallback, never undefined/empty', () => {
    expect(friendlyOwnerActionError({})).toBe('Withdraw failed. Please try again.')
    expect(friendlyOwnerActionError(undefined)).toBe('Withdraw failed. Please try again.')
  })
})
