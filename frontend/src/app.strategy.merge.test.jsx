// @vitest-environment jsdom
// Reality check on the brief: this touches `localStorage` (via isVfWallet), which plain Node
// (no jsdom) does not provide globally — the "node env fine" note in the brief only holds for
// helpers that never touch browser globals. jsdom below, same as components.sidebar.test.jsx.
import { describe, it, expect, vi } from 'vitest'
import {
  checkCircleUsdcFunding,
  checkStoredBaseMandate,
  buildBaseLegContext,
} from './mergeFlowHelpers.js'

describe('merge flow helpers', () => {
  // Strategy Task 13 (decision log #22, obligation D): the two `resolveBaseAvailability`
  // legacy-shape tests that lived here (`{checkHealth}`-only) are DELETED along with the
  // migrated app.jsx call site and the now-removed `resolveLegacyBaseAvailability` branch —
  // mergeFlowHelpers.test.js's 'resolveBaseAvailability — canonical bound-mandate contract'
  // describe block covers the surviving `{mandate, connection, health}` contract, including that
  // `baseAvailable` is a Promise resolved lazily.
  it('no wallet -> no base leg context', () => {
    expect(buildBaseLegContext({ connectedAddress: null, kitSignTransaction: vi.fn() })).toBeNull()
  })
  it('context carries address + signer + vf flag', () => {
    localStorage.setItem('vf_wallet_contract', 'CVF')
    const ctx = buildBaseLegContext({ connectedAddress: 'CVF', kitSignTransaction: vi.fn() })
    expect(ctx).toMatchObject({ connectedAddress: 'CVF', isVf: true })
    expect(typeof ctx.signTx).toBe('function')
  })
})

// Strategy Task 13 (decision log #22, obligation D): the 'resolveBaseAvailability - fail-closed
// preflight (Task 7: mandate + funding gates)' describe block (the `{checkHealth, checkMandate,
// checkFunding}` legacy shape) and the 'checkStoredBaseMandate' describe block (the unscoped
// `{getMandateStatus, storage}` shape with no `stellarOwner`) are BOTH DELETED here, in the same
// commit that migrates app.jsx's call site off them and removes the two overloads from
// mergeFlowHelpers.js. checkStoredBaseMandate now REQUIRES `stellarOwner`; its owner-scoped
// behavior (including the funding gate, now composed at the app.jsx integration layer via
// `resolveBaseForPlan` rather than inside `resolveBaseAvailability` itself) is covered by
// mergeFlowHelpers.test.js's 'checkStoredBaseMandate — owner-scoped gating' and
// 'resolveBaseAvailability — canonical bound-mandate contract' describe blocks.

describe('app owner-scoped v3 mandate boundary', () => {
  it('rechecks one amount-free mandate identity and never reads a global approval blob', async () => {
    const mandateId = '11'.repeat(16)
    const kernelAddress = '0x0000000000000000000000000000000000000aa1'
    const record = {
      version: 3,
      mandateId,
      stellarOwner: 'GUSER',
      kernelAddress,
      sessionKeyAddress: '0x0000000000000000000000000000000000000bb2',
      relayerOrigin: 'https://relayer.example',
      validUntilSeconds: 9_999_999_999,
      status: 'active',
      bindingId: 'binding-1',
      bindingHash: 'binding-hash-1',
      reasonCodes: [],
      expected: {},
      observed: {
        blockNumber: '100',
        blockHash: `0x${'ab'.repeat(32)}`,
        blockTime: 2_000_000_000,
        implementation: '0x0000000000000000000000000000000000000cc3',
        permission: { digest: 'permission-digest' },
        activation: {
          userOpHash: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          activatedAt: 2_000_000_000,
        },
      },
      checks: Object.fromEntries(
        [
          'chain',
          'owner',
          'kernel',
          'session',
          'permission',
          'policy',
          'binding',
          'origin',
          'implementation',
          'freshness',
          'reconstruction',
          'activation',
        ].map((key) => [key, true])
      ),
    }
    const values = new Map([
      [`vf_base_mandate_v3:GUSER`, JSON.stringify(record)],
      ['vf_base_mandate', JSON.stringify({ serializedApproval: 'MUST-NOT-BE-READ' })],
    ])
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      removeItem: vi.fn((key) => values.delete(key)),
    }
    const getMandateStatus = vi.fn(async () => record)

    expect(
      await checkStoredBaseMandate({ getMandateStatus, storage, stellarOwner: 'GUSER' })()
    ).toBe(true)
    expect(getMandateStatus).toHaveBeenCalledWith(mandateId, {
      stellarOwner: 'GUSER',
      kernelAddress,
    })
    expect(storage.removeItem).toHaveBeenCalledWith('vf_base_mandate')
    expect(JSON.stringify(getMandateStatus.mock.calls)).not.toMatch(
      /MUST-NOT-BE-READ|serializedApproval/
    )
  })
})

describe('checkCircleUsdcFunding', () => {
  it('no connected address -> false', async () => {
    const check = checkCircleUsdcFunding({
      address: null,
      readTokenBalance: vi.fn(),
      token: 'CUSDC',
    })
    expect(await check()).toBe(false)
  })
  it('a positive SAC balance -> true, reads the burn token specifically', async () => {
    const readTokenBalance = vi.fn(async () => 5_000_000n)
    const check = checkCircleUsdcFunding({ address: 'GUSER', readTokenBalance, token: 'CUSDC' })
    expect(await check()).toBe(true)
    expect(readTokenBalance).toHaveBeenCalledWith('GUSER', { token: 'CUSDC' })
  })
  it('a zero or null balance -> false (no trustline and empty-trustline read the same)', async () => {
    const check1 = checkCircleUsdcFunding({
      address: 'GUSER',
      readTokenBalance: vi.fn(async () => 0n),
      token: 'CUSDC',
    })
    expect(await check1()).toBe(false)
    const check2 = checkCircleUsdcFunding({
      address: 'GUSER',
      readTokenBalance: vi.fn(async () => null),
      token: 'CUSDC',
    })
    expect(await check2()).toBe(false)
  })
})
