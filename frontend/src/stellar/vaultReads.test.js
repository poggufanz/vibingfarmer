// frontend/src/stellar/vaultReads.test.js
import { describe, test, expect } from 'vitest'
import { xdr, Address, nativeToScVal } from '@stellar/stellar-sdk'
import {
  readPricePerShare,
  readStrategies,
  estimateSupplyAprBps,
  readSupplyAprBps,
  readLifeboatState,
  readPendingUpgrade,
} from './vaultReads.js'

// Stand-in strkeys (same ones agentDeposit.test.js already uses) — any syntactically valid
// C-address works since these reads never touch the network.
const VAULT = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
const STRAT_1 = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
const STRAT_2 = 'CCRG37UTQ2BRCJSA3WYZIUTSGZVLYQ7C4EET2WYUWLU4NAWTETGB77JW'

describe('readPricePerShare', () => {
  test('returns the decoded i128 via an injected server', async () => {
    const fakeServer = {
      simulateTransaction: async () => ({
        result: { retval: nativeToScVal(10_234_000n, { type: 'i128' }) },
      }),
    }
    const pps = await readPricePerShare(VAULT, { server: fakeServer })
    expect(pps).toBe(10_234_000n)
  })

  test('returns null on simulation failure rather than throwing', async () => {
    const fakeServer = { simulateTransaction: async () => ({ error: 'boom' }) }
    const pps = await readPricePerShare(VAULT, { server: fakeServer })
    expect(pps).toBeNull()
  })
})

describe('readStrategies', () => {
  test('returns decoded strategy addresses', async () => {
    const fakeServer = {
      simulateTransaction: async () => ({
        result: {
          retval: xdr.ScVal.scvVec([
            Address.fromString(STRAT_1).toScVal(),
            Address.fromString(STRAT_2).toScVal(),
          ]),
        },
      }),
    }
    const strategies = await readStrategies(VAULT, { server: fakeServer })
    expect(strategies).toEqual([STRAT_1, STRAT_2])
  })

  test('returns [] on simulation failure rather than throwing', async () => {
    const fakeServer = { simulateTransaction: async () => ({ error: 'boom' }) }
    expect(await readStrategies(VAULT, { server: fakeServer })).toEqual([])
  })
})

describe('estimateSupplyAprBps', () => {
  const baseConfig = {
    util: 6_000_000n, // 60% target
    max_util: 9_500_000n, // 95% ceiling
    r_base: 0n,
    r_one: 1_000_000n,
    r_two: 5_000_000n,
    r_three: 15_000_000n,
  }

  test('estimates supply APR when utilization is below target', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 1000n,
        b_rate: 1_000_000_000_000n,
        d_supply: 500n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    }
    expect(estimateSupplyAprBps(reserve, 0n)).toBe(416)
  })

  test('estimates a higher supply APR once utilization crosses target (kinked curve)', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 1000n,
        b_rate: 1_000_000_000_000n,
        d_supply: 800n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    }
    expect(estimateSupplyAprBps(reserve, 0n)).toBe(3085)
  })

  test('a nonzero backstop take rate reduces the estimate', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 1000n,
        b_rate: 1_000_000_000_000n,
        d_supply: 500n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    }
    expect(estimateSupplyAprBps(reserve, 1_000_000n)).toBe(374)
  })

  test('returns 0 rather than dividing by zero when nothing is supplied', () => {
    const reserve = {
      config: baseConfig,
      data: {
        b_supply: 0n,
        b_rate: 1_000_000_000_000n,
        d_supply: 0n,
        d_rate: 1_000_000_000_000n,
        ir_mod: 10_000_000n,
      },
    }
    expect(estimateSupplyAprBps(reserve, 0n)).toBe(0)
  })
})

describe('readSupplyAprBps', () => {
  // Same fixture as the "below target" estimateSupplyAprBps case above (416 bps) — reused here
  // so the expected bps is traceable back to an already-asserted pure-function result, not a
  // number invented for this test.
  const reserve = {
    config: {
      util: 6_000_000n,
      max_util: 9_500_000n,
      r_base: 0n,
      r_one: 1_000_000n,
      r_two: 5_000_000n,
      r_three: 15_000_000n,
    },
    data: {
      b_supply: 1000n,
      b_rate: 1_000_000_000_000n,
      d_supply: 500n,
      d_rate: 1_000_000_000_000n,
      ir_mod: 10_000_000n,
    },
  }
  const poolConfig = { bstop_rate: 0n }

  test('composes get_reserve + get_config (two reads) into the same bps estimateSupplyAprBps would produce', async () => {
    let calls = 0
    const fakeServer = {
      simulateTransaction: async () => {
        calls += 1
        // 1st call is get_reserve, 2nd is get_config — mirrors readSupplyAprBps's call order.
        const retval = nativeToScVal(calls === 1 ? reserve : poolConfig)
        return { result: { retval } }
      },
    }
    const bps = await readSupplyAprBps(VAULT, { server: fakeServer })
    expect(calls).toBe(2)
    expect(bps).toBe(416)
  })

  test('returns null (not a throw) when either read fails', async () => {
    const fakeServer = { simulateTransaction: async () => ({ error: 'boom' }) }
    await expect(readSupplyAprBps(VAULT, { server: fakeServer })).resolves.toBeNull()
  })
})

describe('readLifeboatState', () => {
  // mandate_expiry uses a distinctive value (not 0/1/a round demo number) so a camelCase
  // regression (reading v.mandateExpiry instead of v.mandate_expiry) would surface as
  // NaN/undefined rather than accidentally matching.
  test('maps the snake_case struct fields into camelCase, including a null authority', async () => {
    const lifeboat = {
      derisked: true,
      mandate_expiry: 1_800_000_000n,
      authority: null,
    }
    const fakeServer = {
      simulateTransaction: async () => ({ result: { retval: nativeToScVal(lifeboat) } }),
    }
    const state = await readLifeboatState(VAULT, { server: fakeServer })
    expect(state).toEqual({
      derisked: true,
      mandateExpiry: 1_800_000_000,
      authority: null,
    })
  })

  test('returns null on simulation failure rather than throwing', async () => {
    const fakeServer = { simulateTransaction: async () => ({ error: 'boom' }) }
    expect(await readLifeboatState(VAULT, { server: fakeServer })).toBeNull()
  })
})

describe('readPendingUpgrade', () => {
  test('decodes wasm_hash to hex and eta to Number when an upgrade is scheduled', async () => {
    const wasmHash = Buffer.from('cd'.repeat(32), 'hex')
    const pending = { wasm_hash: wasmHash, eta: 1_900_000_000n }
    const fakeServer = {
      simulateTransaction: async () => ({ result: { retval: nativeToScVal(pending) } }),
    }
    const v = await readPendingUpgrade(VAULT, { server: fakeServer })
    expect(v).toEqual({ wasmHashHex: wasmHash.toString('hex'), eta: 1_900_000_000 })
  })

  test('returns null when no upgrade is pending (Option::None decodes to void)', async () => {
    const fakeServer = {
      simulateTransaction: async () => ({ result: { retval: xdr.ScVal.scvVoid() } }),
    }
    expect(await readPendingUpgrade(VAULT, { server: fakeServer })).toBeNull()
  })

  test('returns null on simulation failure rather than throwing', async () => {
    const fakeServer = { simulateTransaction: async () => ({ error: 'boom' }) }
    expect(await readPendingUpgrade(VAULT, { server: fakeServer })).toBeNull()
  })
})
