import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/wallet/account.js', () => ({
  connectPasskeyWallet: vi.fn(),
  makeKit: vi.fn(),
}))
vi.mock('../src/wallet/submit.js', () => ({
  submitApprove: vi.fn(),
  submitDeposit: vi.fn(),
}))
vi.mock('../src/wallet/signGeneric.js', () => ({
  signAuthEntryString: vi.fn(),
  signTransactionForContract: vi.fn(),
}))
vi.mock('../src/vfapi/client.js', () => ({
  eligibility: vi.fn(),
  vaultFacts: vi.fn(),
}))
vi.mock('../src/stellar/config.js', () => ({
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
}))

import { connectPasskeyWallet, makeKit } from '../src/wallet/account.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { runCeremony } from './ceremony.js'

const kit = { signAuthEntry: vi.fn() }
const facts = { protocol: 'blend-usdc' }

function browserHarness() {
  const status = { textContent: '' }
  return {
    chromeApi: {
      runtime: { sendMessage: vi.fn() },
      storage: { local: { get: vi.fn(async () => ({})) } },
    },
    documentRef: { getElementById: vi.fn(() => status) },
    localStorageRef: { getItem: vi.fn(() => null) },
    scheduleClose: vi.fn(),
    status,
    windowRef: { close: vi.fn() },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  makeKit.mockResolvedValue(kit)
  connectPasskeyWallet.mockResolvedValue({ contractId: 'C_CONNECTED' })
  vaultFacts.mockReturnValue({ facts })
  vfEligibility.mockResolvedValue({ allow: true })
})

describe('runCeremony submit wiring', () => {
  it('runs the production deposit branch through submitDeposit', async () => {
    submitDeposit.mockResolvedValue({ hash: 'deposit-hash', status: 'SUCCESS' })
    const browser = browserHarness()

    await runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '2500000', protocol: 'blend-usdc' },
      tabId: 7,
      ...browser,
    })

    expect(connectPasskeyWallet).toHaveBeenCalledWith({ contractId: 'C_REQUESTED', kit })
    expect(submitDeposit).toHaveBeenCalledOnce()
    expect(submitDeposit).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: '2500000',
      eligibility: expect.any(Function),
      kit,
    })
    const eligibility = submitDeposit.mock.calls[0][0].eligibility
    await eligibility({ vault: 'C_VAULT', amount: '2500000' })
    expect(vfEligibility).toHaveBeenCalledWith({
      vault: 'C_VAULT',
      amount: '2500000',
      facts,
    })
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CEREMONY_RESULT',
      tabId: 7,
      action: 'deposit',
      ok: true,
      hash: 'deposit-hash',
      status: 'SUCCESS',
    })
    expect(browser.status.textContent).toBe('Deposit executed.')
    expect(browser.scheduleClose).toHaveBeenCalledOnce()
  })

  it('runs the production approve branch through submitApprove', async () => {
    submitApprove.mockResolvedValue({ hash: 'approve-hash', status: 'SUCCESS' })
    const browser = browserHarness()

    await runCeremony({
      action: 'approve',
      params: { contractId: 'C_REQUESTED', amount: '2500000' },
      tabId: 8,
      ...browser,
    })

    expect(connectPasskeyWallet).toHaveBeenCalledWith({ contractId: 'C_REQUESTED', kit })
    expect(submitApprove).toHaveBeenCalledOnce()
    expect(submitApprove).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: '2500000',
      kit,
    })
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CEREMONY_RESULT',
      tabId: 8,
      action: 'approve',
      ok: true,
      hash: 'approve-hash',
      status: 'SUCCESS',
    })
    expect(browser.status.textContent).toBe('Approval completed.')
    expect(browser.scheduleClose).toHaveBeenCalledOnce()
  })
})
