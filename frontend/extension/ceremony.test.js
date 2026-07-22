import { describe, expect, it, vi } from 'vitest'
import { submitCeremonyApprove, submitCeremonyDeposit } from './ceremonyActions.js'

describe('ceremony submit adapters', () => {
  it('submits a deposit with the connected contract and the existing submit API', async () => {
    const submit = vi.fn(async () => ({ hash: 'deposit-hash', status: 'SUCCESS' }))
    const eligibility = vi.fn()
    const kit = { signAuthEntry: vi.fn() }

    await expect(
      submitCeremonyDeposit({
        contractId: 'C_CONNECTED',
        amount: '2500000',
        eligibility,
        kit,
        submit,
      })
    ).resolves.toEqual({ hash: 'deposit-hash', status: 'SUCCESS' })

    expect(submit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: '2500000',
      eligibility,
      kit,
    })
  })

  it('submits an approval with the connected contract and the existing submit API', async () => {
    const submit = vi.fn(async () => ({ hash: 'approve-hash', status: 'SUCCESS' }))
    const kit = { signAuthEntry: vi.fn() }

    await expect(
      submitCeremonyApprove({
        contractId: 'C_CONNECTED',
        amount: '2500000',
        kit,
        submit,
      })
    ).resolves.toEqual({ hash: 'approve-hash', status: 'SUCCESS' })

    expect(submit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: '2500000',
      kit,
    })
  })
})
