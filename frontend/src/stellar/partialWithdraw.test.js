import { describe, test, expect, vi } from 'vitest'
import { sharesForAmount, ensureExitSigner, partialWithdraw } from './partialWithdraw.js'

const PPS_SCALE = 10_000_000n

describe('sharesForAmount', () => {
  test('pps 1.0: 1:1, exact', () => {
    expect(sharesForAmount(20_000_000n, PPS_SCALE, 100_000_000n)).toBe(20_000_000n)
  })
  test('rounds shares UP so the user gets at least the requested amount', () => {
    // pps = 1.5 → 2000 units needs ceil(2000/1.5) = 1334 shares (1333 would under-deliver)
    expect(sharesForAmount(2000n, 15_000_000n, 1_000_000n)).toBe(1334n)
  })
  test('clamps to the agent balance', () => {
    expect(sharesForAmount(99_999_999n, PPS_SCALE, 500n)).toBe(500n)
  })
  test('rejects non-positive amounts', () => {
    expect(() => sharesForAmount(0n, PPS_SCALE, 500n)).toThrow()
  })
})

describe('ensureExitSigner', () => {
  test('returns the stored key without registering again', async () => {
    const deps = {
      loadExitKey: () => ({ publicKey: 'GPUB', secret: 'SSEC' }),
      registerExitSigner: vi.fn(),
    }
    const key = await ensureExitSigner({ owner: 'GOWNER', agentAddress: 'CAGENT', deps })
    expect(key.publicKey).toBe('GPUB')
    expect(deps.registerExitSigner).not.toHaveBeenCalled()
  })
  test('generates, registers on-chain, and saves ONLY after SUCCESS', async () => {
    const calls = []
    const deps = {
      loadExitKey: () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner: async () => (calls.push('register'), { status: 'SUCCESS' }),
      saveExitKey: (agent, key) => calls.push(`save:${key.publicKey}`),
    }
    const key = await ensureExitSigner({ owner: 'GOWNER', agentAddress: 'CAGENT', deps })
    expect(key.publicKey).toBe('GNEW')
    expect(calls).toEqual(['register', 'save:GNEW'])
  })
  test('does NOT save when registration fails', async () => {
    const save = vi.fn()
    const deps = {
      loadExitKey: () => null,
      generateExitKey: async () => ({ publicKey: 'GNEW', secret: 'SNEW' }),
      registerExitSigner: async () => ({ status: 'FAILED' }),
      saveExitKey: save,
    }
    await expect(ensureExitSigner({ owner: 'G', agentAddress: 'C', deps })).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
  })
})

describe('partialWithdraw', () => {
  const baseDeps = () => {
    const submitted = []
    return {
      submitted,
      getRelayerAddress: async () => 'GRELAYER',
      readVaultShares: async () => 100_000_000n, // 10 USDC of shares
      readPricePerShare: async () => PPS_SCALE, // 1.0
      // post-redeem agent token balance = what the transfer leg must move
      readTokenBalance: async () => 20_000_000n,
      // ponytail: brief's literal fixture secret has an invalid Stellar checksum (typo) and
      // Keypair.fromSecret rejects it — substituted a valid random ed25519 seed; no test
      // asserts on the derived public key, so this is inert everywhere else.
      loadExitKey: () => ({
        publicKey: 'GPUB',
        secret: 'SANNPHPONDNLIZ7DWOSNPUSVWJF7ILLMVQWGURVNYXHI6J6QFGXLNSQM',
      }),
      buildAgentAuthedInvoke: async ({ method }) => ({ xdr: `XDR:${method}` }),
      submitViaRelay: async ({ xdr }) => (
        submitted.push(xdr),
        { hash: `H:${xdr}`, status: 'SUCCESS' }
      ),
      waitForTx: async () => ({ status: 'SUCCESS' }),
    }
  }
  test('happy path: redeem leg then transfer leg of the ACTUAL balance', async () => {
    const deps = baseDeps()
    const out = await partialWithdraw({
      owner: 'GOWNER',
      agentAddress: 'CAGENT',
      amountUnits: 20_000_000n,
      deps,
    })
    expect(deps.submitted).toEqual(['XDR:redeem', 'XDR:transfer'])
    expect(out.redeemed).toBe(20_000_000n)
    expect(out.redeemHash).toBe('H:XDR:redeem')
    expect(out.transferHash).toBe('H:XDR:transfer')
  })
  test('no relayer → throws, nothing submitted', async () => {
    const deps = { ...baseDeps(), getRelayerAddress: async () => null }
    await expect(
      partialWithdraw({ owner: 'G', agentAddress: 'C', amountUnits: 1n, deps })
    ).rejects.toThrow(/relay/i)
    expect(deps.submitted).toEqual([])
  })
  test('amount above the agent max → throws before any tx', async () => {
    const deps = baseDeps()
    await expect(
      partialWithdraw({ owner: 'G', agentAddress: 'C', amountUnits: 999_000_000n, deps })
    ).rejects.toThrow(/max/i)
    expect(deps.submitted).toEqual([])
  })
  test('redeem confirmed but transfer leg fails → error names the stranded amount', async () => {
    const deps = baseDeps()
    deps.submitViaRelay = async ({ xdr }) => {
      if (xdr === 'XDR:transfer') throw new Error('relay refused')
      deps.submitted.push(xdr)
      return { hash: 'H1', status: 'SUCCESS' }
    }
    await expect(
      partialWithdraw({ owner: 'G', agentAddress: 'C', amountUnits: 20_000_000n, deps })
    ).rejects.toThrow(/agent/i)
  })
})
