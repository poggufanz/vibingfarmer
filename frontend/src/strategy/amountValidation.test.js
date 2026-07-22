// frontend/src/strategy/amountValidation.test.js
import { describe, test, expect } from 'vitest'
import {
  parseUsdcInput,
  validateAmountInput,
  validateExecutionAllocations,
  FIRST_DEPOSIT_MIN_UNITS,
} from './amountValidation.js'
import { expandAgentSlots } from './planModel.js'

describe('parseUsdcInput', () => {
  test('rejects an empty string', () => {
    const r = parseUsdcInput('', 7)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('EMPTY')
    expect(r.units).toBeNull()
  })

  test('rejects a negative amount', () => {
    const r = parseUsdcInput('-5', 7)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NEGATIVE')
  })

  test('rejects zero', () => {
    expect(parseUsdcInput('0', 7)).toMatchObject({ ok: false, code: 'ZERO' })
    expect(parseUsdcInput('0.0000000', 7)).toMatchObject({ ok: false, code: 'ZERO' })
  })

  test('rejects exponent notation', () => {
    const r = parseUsdcInput('1e5', 7)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_FORMAT')
  })

  test('rejects NaN-shaped input', () => {
    const r = parseUsdcInput('NaN', 7)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_FORMAT')
  })

  test('rejects over-precision input beyond the requested decimals', () => {
    const r = parseUsdcInput('1.12345678', 7)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TOO_PRECISE')
  })

  test('parses a Stellar (7dp) amount into bigint base units without float rounding', () => {
    // 0.1 cannot be represented exactly in binary float -- Number('0.1') * 1e7 drifts off
    // 1000000 in naive float arithmetic. Parsing the decimal string directly must not.
    const r = parseUsdcInput('0.1', 7)
    expect(r.ok).toBe(true)
    expect(r.units).toBe(1_000_000n)
    expect(typeof r.units).toBe('bigint')
  })

  test('parses a whale-sized amount exactly (beyond safe float precision at 7dp)', () => {
    // 123456789.1234567 * 1e7 exceeds Number.MAX_SAFE_INTEGER (9.007e15) as a float product;
    // string-decimal parsing must still land on the exact bigint.
    const r = parseUsdcInput('123456789.1234567', 7)
    expect(r.ok).toBe(true)
    expect(r.units).toBe(1234567891234567n)
  })

  test('parses a Base/CCTP (6dp) amount into bigint base units', () => {
    const r = parseUsdcInput('12.5', 6)
    expect(r.ok).toBe(true)
    expect(r.units).toBe(12_500_000n)
  })

  test('rejects 6dp input carrying a 7th decimal digit', () => {
    const r = parseUsdcInput('12.5000001', 6)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TOO_PRECISE')
  })
})

describe('validateAmountInput', () => {
  test('rejects a missing risk level', () => {
    const r = validateAmountInput({ value: '100', risk: undefined, vaultTotalShares: 500n })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_RISK')
    expect(r.field).toBe('risk')
  })

  test('surfaces an invalid amount with field "amount"', () => {
    const r = validateAmountInput({ value: '-5', risk: 'low', vaultTotalShares: 500n })
    expect(r.ok).toBe(false)
    expect(r.field).toBe('amount')
    expect(r.code).toBe('NEGATIVE')
  })

  test('unknown total-supply read is a retryable "Could not verify the vault minimum" state, never an assumption', () => {
    const r = validateAmountInput({ value: '5', risk: 'low', vaultTotalShares: null })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('VAULT_STATE_UNKNOWN')
    expect(r.retryable).toBe(true)
    expect(r.message).toMatch(/Could not verify the vault minimum/)
  })

  test('applies the vault first-deposit minimum only when authoritative total shares are zero', () => {
    const tooSmall = validateAmountInput({ value: '0.5', risk: 'low', vaultTotalShares: 0n })
    expect(tooSmall.ok).toBe(false)
    expect(tooSmall.code).toBe('BELOW_FIRST_DEPOSIT_MINIMUM')

    const meetsMinimum = validateAmountInput({ value: '1', risk: 'low', vaultTotalShares: 0n })
    expect(meetsMinimum.ok).toBe(true)
    expect(meetsMinimum.units).toBe(FIRST_DEPOSIT_MIN_UNITS)
  })

  test('later deposits (nonzero total shares) have no fictional catalog min_capital floor', () => {
    // The old catalog Stellar venue carried min_capital: 100 (frontend/src/config.js). Once the
    // vault has any supply at all, a sub-$100, sub-$1 amount must still pass -- there is no
    // contract-level floor beyond "greater than zero" once seeded.
    const r = validateAmountInput({ value: '0.01', risk: 'low', vaultTotalShares: 500_0000000n })
    expect(r.ok).toBe(true)
    expect(r.units).toBe(100_000n)
  })
})

describe('validateExecutionAllocations', () => {
  test('unknown total-supply read is retryable, never an assumption', () => {
    const plan = { agents: expandAgentSlots({ risk: 'low', stellarUnits: 100_0000000n }) }
    const r = validateExecutionAllocations({ plan, vaultTotalShares: null })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('VAULT_STATE_UNKNOWN')
    expect(r.retryable).toBe(true)
    expect(r.message).toMatch(/Could not verify the vault minimum/)
  })

  test('every real AgentInit must receive positive integer units', () => {
    const plan = {
      agents: [
        {
          allocationId: 'run:deposit:0',
          kind: 'deposit',
          allocation: { token: 'USDC', units: '0', decimals: 7 },
          children: [],
        },
      ],
    }
    const r = validateExecutionAllocations({ plan, vaultTotalShares: 500_0000000n })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NON_POSITIVE_AGENT_UNITS')
    expect(r.field).toBe('run:deposit:0')
  })

  test('a Base child amount must remain positive after six-decimal conversion', () => {
    const plan = {
      agents: [
        {
          allocationId: 'run:bridge:base',
          kind: 'bridge',
          allocation: { token: 'USDC', units: '10', decimals: 7 },
          children: [
            {
              allocationId: 'run:bridge:pool-a',
              allocation: { token: 'USDC', units: '0', decimals: 6 },
            },
          ],
        },
      ],
    }
    const r = validateExecutionAllocations({ plan, vaultTotalShares: 500_0000000n })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NON_POSITIVE_BASE_UNITS')
    expect(r.field).toBe('run:bridge:pool-a')
  })

  test('a real 1/2/3-slot plan passes once every deposit slot clears the vault first-deposit minimum', () => {
    // High risk -> 3 deposit slots. 3 USDC split evenly gives each slot exactly 1 USDC, the
    // Soroban MIN_FIRST_DEPOSIT -- the smallest amount that can never strand a slot below the
    // on-chain floor regardless of which agent lands first on an empty vault.
    const plan = { agents: expandAgentSlots({ risk: 'high', stellarUnits: 3_0000000n }) }
    const r = validateExecutionAllocations({ plan, vaultTotalShares: 0n })
    expect(r.ok).toBe(true)
  })

  test('a 1/2/3-slot plan fails when any deposit slot would land below the first-deposit minimum', () => {
    // Same 3-slot shape, but only 2 USDC total -- the even split leaves a slot under 1 USDC.
    const plan = { agents: expandAgentSlots({ risk: 'high', stellarUnits: 2_0000000n }) }
    const r = validateExecutionAllocations({ plan, vaultTotalShares: 0n })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('BELOW_FIRST_DEPOSIT_MINIMUM')
  })

  test('later deposits (nonzero total shares) impose no fictional catalog min_capital floor on any slot', () => {
    const plan = { agents: expandAgentSlots({ risk: 'high', stellarUnits: 300_000n }) } // 0.03 USDC total
    const r = validateExecutionAllocations({ plan, vaultTotalShares: 500_0000000n })
    expect(r.ok).toBe(true)
  })
})
