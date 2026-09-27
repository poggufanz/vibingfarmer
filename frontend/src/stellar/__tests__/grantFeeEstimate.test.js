// P1 G10: the fallback fee estimate comes from a simulated grant-shaped transaction —
// the prepared tx fee is the number, any failure is null (never a fabricated fee).
import { describe, it, expect, vi } from 'vitest'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from '../config.js'
import { estimateGrantFallbackFee, formatStroopsXlm } from '../grantFeeEstimate.js'
const TOKEN = 'CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L'
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'

describe('formatStroopsXlm', () => {
  it('formats 7-dp stroops without floating math', () => {
    expect(formatStroopsXlm(10_000_000n)).toBe('~1.0000000 XLM')
    expect(formatStroopsXlm(12345n)).toBe('~0.0012345 XLM')
    expect(formatStroopsXlm(0n)).toBe('~0.0000000 XLM')
  })
})

describe('estimateGrantFallbackFee', () => {
  it('reports the prepared-tx fee from the simulated grant shape', async () => {
    const build = vi.fn(async () => ({ tx: { fee: '12345' } }))
    const out = await estimateGrantFallbackFee({
      owner: OWNER,
      agentCount: 2,
      budgets: [{ token: TOKEN, units: '1000000000' }],
      durationSeconds: 86400,
      build,
    })
    expect(out).toMatchObject({ feeStroops: 12345n, feeXlm: '~0.0012345 XLM', agentCount: 2 })
    // Fee-equivalent shape: one init per agent, real budgets, placeholder signers.
    expect(build).toHaveBeenCalledOnce()
    const args = build.mock.calls[0][0]
    expect(args.owner).toBe(OWNER)
    expect(args.agentInits).toHaveLength(2)
    expect(args.budgets).toEqual([{ budget: 1000000000n, token: TOKEN }])
    for (const init of args.agentInits) {
      expect(init.signer).toBeInstanceOf(Uint8Array)
      expect(init.kind).toBe(0)
    }
  })

  it('accepts {budget} and {units} budget shapes alike', async () => {
    const build = vi.fn(async () => ({ tx: { fee: '100' } }))
    const out = await estimateGrantFallbackFee({
      owner: OWNER,
      agentCount: 1,
      budgets: [{ token: TOKEN, budget: 5n }],
      build,
    })
    expect(out.feeStroops).toBe(100n)
  })

  it('a simulation failure resolves to null, never a throw or a guess', async () => {
    const build = vi.fn(async () => {
      throw new Error('RPC down')
    })
    await expect(
      estimateGrantFallbackFee({ owner: OWNER, agentCount: 1, budgets: [{ token: TOKEN, units: '1' }], build })
    ).resolves.toBeNull()
  })

  it('rejects unshapable input to null before touching the network', async () => {
    const build = vi.fn()
    await expect(estimateGrantFallbackFee({ owner: '', agentCount: 1, budgets: [{ token: TOKEN, units: '1' }], build })).resolves.toBeNull()
    await expect(estimateGrantFallbackFee({ owner: OWNER, agentCount: 0, budgets: [{ token: TOKEN, units: '1' }], build })).resolves.toBeNull()
    await expect(estimateGrantFallbackFee({ owner: OWNER, agentCount: 1, budgets: [], build })).resolves.toBeNull()
    await expect(estimateGrantFallbackFee({ owner: OWNER, agentCount: 1, budgets: [{ token: TOKEN, units: '0' }], build })).resolves.toBeNull()
    expect(build).not.toHaveBeenCalled()
  })

  it('defaults token/target to the configured vault legs when the caller omits them', async () => {
    const build = vi.fn(async () => ({ tx: { fee: '100' } }))
    await estimateGrantFallbackFee({
      owner: OWNER,
      agentCount: 1,
      budgets: [{ token: TOKEN, units: '1' }],
      build,
    })
    const [init] = build.mock.calls[0][0].agentInits
    expect(init.token).toBe(TOKEN)
    expect(init.target).toBe(SOROBAN_ACTIVE_VAULT_ADDRESS)
  })
})
