import { describe, it, expect, vi } from 'vitest'
import { submitDeposit, submitApprove } from './submit.js'
import { SOROBAN_VAULT_ADDRESS } from '../stellar/config.js'

describe('submitDeposit (orchestration)', () => {
  const okElig = vi.fn(async () => ({ allow: true, reasons: [] }))

  it('runs the F8 gate, sources the inner tx at the relayer, relays the signed XDR, returns the share delta', async () => {
    const relay = {
      getRelayerAddress: vi.fn(async () => 'GRELAYER'),
      submitViaRelay: vi.fn(async () => ({ hash: 'HASH', status: 'SUCCESS' })),
    }
    const buildInner = vi.fn(async () => 'INNERXDR')
    const readShares = vi
      .fn()
      .mockResolvedValueOnce(0n) // before
      .mockResolvedValueOnce(5n) // after
    const out = await submitDeposit({
      contractId: 'CACCT',
      amount: 1n,
      eligibility: okElig,
      kit: {},
      relay,
      server: {},
      buildInner,
      readShares,
    })
    expect(okElig).toHaveBeenCalled()
    expect(buildInner).toHaveBeenCalledWith(
      expect.objectContaining({ relayer: 'GRELAYER', contractId: 'CACCT' })
    )
    expect(relay.submitViaRelay).toHaveBeenCalledWith({ xdr: 'INNERXDR' })
    expect(out).toEqual({ hash: 'HASH', status: 'SUCCESS', sharesBefore: 0n, sharesAfter: 5n })
  })

  it('fails closed when F8 rejects — never builds or relays', async () => {
    const relay = { getRelayerAddress: vi.fn(), submitViaRelay: vi.fn() }
    const buildInner = vi.fn()
    await expect(
      submitDeposit({
        contractId: 'CACCT',
        amount: 1n,
        eligibility: vi.fn(async () => ({ allow: false, reasons: ['stale facts'] })),
        kit: {},
        relay,
        buildInner,
        readShares: vi.fn(async () => 0n),
      })
    ).rejects.toThrow(/ineligible/)
    expect(buildInner).not.toHaveBeenCalled()
    expect(relay.submitViaRelay).not.toHaveBeenCalled()
  })

  it('surfaces an honest error when the relay is unconfigured', async () => {
    const relay = { getRelayerAddress: vi.fn(async () => null), submitViaRelay: vi.fn() }
    await expect(
      submitDeposit({
        contractId: 'CACCT',
        amount: 1n,
        eligibility: okElig,
        kit: {},
        relay,
        buildInner: vi.fn(),
        readShares: vi.fn(async () => 0n),
      })
    ).rejects.toThrow(/relay unavailable/)
  })
})

describe('submitApprove (orchestration)', () => {
  it('funds an ephemeral source and approves the vault as spender', async () => {
    const fund = vi.fn(async () => {})
    const makeEphemeral = vi.fn(() => ({ publicKey: () => 'GEPHEMERAL' }))
    const signSubmitApprove = vi.fn(async () => ({ hash: 'AHASH', status: 'SUCCESS' }))
    const out = await submitApprove({
      contractId: 'CACCT',
      amount: 100n,
      vault: SOROBAN_VAULT_ADDRESS,
      kit: {},
      server: {},
      fund,
      makeEphemeral,
      signSubmitApprove,
    })
    expect(makeEphemeral).toHaveBeenCalled()
    expect(fund).toHaveBeenCalledWith('GEPHEMERAL')
    expect(signSubmitApprove).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: 'CACCT', vault: SOROBAN_VAULT_ADDRESS })
    )
    expect(out).toEqual({ hash: 'AHASH', status: 'SUCCESS' })
  })
})
