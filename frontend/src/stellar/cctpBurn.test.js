// frontend/src/stellar/cctpBurn.test.js
import { describe, test, expect, vi } from 'vitest'
import { evmAddrToBytes32, signAndSubmitStellarBurn } from './cctpBurn.js'

describe('evmAddrToBytes32', () => {
  test('left-pads a 20-byte EVM address to 32 bytes', () => {
    const out = evmAddrToBytes32('0x1111111111111111111111111111111111111111')
    expect(out.length).toBe(32)
    expect(Buffer.from(out.slice(0, 12)).every((b) => b === 0)).toBe(true)
    expect(Buffer.from(out.slice(12)).toString('hex')).toBe(
      '1111111111111111111111111111111111111111'
    )
  })

  test('rejects a malformed address', () => {
    expect(() => evmAddrToBytes32('0xnothex')).toThrow(/bad evm address/)
  })
})

describe('signAndSubmitStellarBurn', () => {
  test('approves TokenMessengerMinter then burns, both self-paid by a fresh ephemeral fee-payer, both signed via the wallet passkey', async () => {
    const signedEntries = []
    const kit = {
      signAuthEntry: vi.fn(async (entry) => {
        signedEntries.push(entry)
        return { ...entry, signed: true }
      }),
    }
    const submittedOps = []
    const deps = {
      fund: vi.fn(async () => {}),
      makeEphemeral: vi.fn(async () => ({ publicKey: () => 'GEPHEMERAL', sign: vi.fn() })),
      buildAndSubmitOp: vi.fn(async ({ method }) => {
        submittedOps.push(method)
        return { hash: `hash-for-${method}` }
      }),
    }

    const result = await signAndSubmitStellarBurn({
      contractId: 'GWALLET000000000000000000000000000000000000000000000000',
      amountUnits: 10_000_000n,
      baseRecipientAddress: '0x2222222222222222222222222222222222222222',
      kit,
      server: { getLatestLedger: async () => ({ sequence: 1000 }) },
      deps,
    })

    expect(submittedOps).toEqual(['approve', 'deposit_for_burn'])
    expect(result.approveHash).toBe('hash-for-approve')
    expect(result.burnHash).toBe('hash-for-deposit_for_burn')
    expect(deps.fund).toHaveBeenCalledWith('GEPHEMERAL')
  })

  test('burn args match the proven SP0 forward recipe exactly (domain 6, standard finality, zero max fee)', async () => {
    const kit = { signAuthEntry: vi.fn(async (e) => e) }
    let burnArgs = null
    const deps = {
      fund: vi.fn(async () => {}),
      makeEphemeral: vi.fn(async () => ({ publicKey: () => 'GEPHEMERAL', sign: vi.fn() })),
      buildAndSubmitOp: vi.fn(async ({ method, args }) => {
        if (method === 'deposit_for_burn') burnArgs = args
        return { hash: 'x' }
      }),
    }
    await signAndSubmitStellarBurn({
      contractId: 'GWALLET',
      amountUnits: 5_000_000n,
      baseRecipientAddress: '0x3333333333333333333333333333333333333333',
      kit,
      server: { getLatestLedger: async () => ({ sequence: 1000 }) },
      deps,
    })
    // [caller, amount, destination_domain, mint_recipient, burn_token, destination_caller, max_fee, min_finality]
    expect(burnArgs[0]).toEqual({ addr: 'GWALLET' })
    expect(burnArgs[1]).toEqual({ i128: 5_000_000n })
    expect(burnArgs[2]).toEqual({ u32: 6 })
    expect(burnArgs[4]).toEqual({
      addr: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    })
    expect(burnArgs[6]).toEqual({ i128: 0n })
    expect(burnArgs[7]).toEqual({ u32: 2000 })
  })
})
