import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/wallet/account.js', () => ({
  connectPasskeyWallet: vi.fn(),
  makeKit: vi.fn(),
  readBalance: vi.fn(),
}))
vi.mock('../src/wallet/submit.js', () => ({
  submitApprove: vi.fn(),
  submitDeposit: vi.fn(),
}))
vi.mock('../src/wallet/faucet.js', () => ({
  getTestUsdc: vi.fn(),
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
  SOROBAN_DECIMALS: 7,
}))

import { connectPasskeyWallet, makeKit, readBalance } from '../src/wallet/account.js'
import { getTestUsdc } from '../src/wallet/faucet.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import * as ceremony from './ceremony.js'

const kit = { signAuthEntry: vi.fn() }
const facts = { protocol: 'blend-usdc' }
const APPROVE_CAP = 100n * 10n ** 7n

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
  readBalance.mockResolvedValue(2n * 10n ** 7n)
  getTestUsdc.mockResolvedValue({
    dispensed: APPROVE_CAP,
    calls: 1,
    lastHash: 'faucet-hash',
    capped: false,
  })
  vaultFacts.mockReturnValue({ facts })
  vfEligibility.mockResolvedValue({ allow: true })
})

describe('runCeremony submit wiring', () => {
  it('normalizes the popup decimal amount and forwards the complete deposit receipt', async () => {
    submitDeposit.mockResolvedValue({
      hash: 'deposit-hash',
      status: 'SUCCESS',
      sharesBefore: '0002',
      sharesAfter: '0007',
    })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 7,
      ...browser,
    })

    expect(connectPasskeyWallet).toHaveBeenCalledWith({ contractId: 'C_REQUESTED', kit })
    expect(submitDeposit).toHaveBeenCalledOnce()
    expect(submitDeposit).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: 15_000_000n,
      eligibility: expect.any(Function),
      kit,
    })
    const eligibility = submitDeposit.mock.calls[0][0].eligibility
    await eligibility({ vault: 'C_VAULT', amount: 15_000_000n })
    expect(vfEligibility).toHaveBeenCalledWith({
      vault: 'C_VAULT',
      amount: 15_000_000n,
      facts,
    })
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CEREMONY_RESULT',
      tabId: 7,
      action: 'deposit',
      ok: true,
      hash: 'deposit-hash',
      status: 'SUCCESS',
      sharesBefore: '2',
      sharesAfter: '7',
    })
    expect(browser.status.textContent).toBe('Minted 5 shares.')
    expect(browser.scheduleClose).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-numeric', 'not-a-number'],
    ['non-finite', 'Infinity'],
    ['zero', '0'],
    ['negative', '-1'],
    ['sub-base-unit', '0.00000001'],
  ])('rejects a %s deposit amount before wallet setup or submit', async (_label, amount) => {
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount, protocol: 'blend-usdc' },
      tabId: 9,
      ...browser,
    })

    expect(makeKit).not.toHaveBeenCalled()
    expect(connectPasskeyWallet).not.toHaveBeenCalled()
    expect(submitDeposit).not.toHaveBeenCalled()
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CEREMONY_RESULT',
        tabId: 9,
        action: 'deposit',
        ok: false,
        error: expect.any(String),
      })
    )
    expect(browser.scheduleClose).not.toHaveBeenCalled()
  })

  it('approves a fixed cap without calling the faucet when the connected account is funded', async () => {
    submitApprove.mockResolvedValue({ hash: 'approve-hash', status: 'SUCCESS' })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'approve',
      params: { contractId: 'C_REQUESTED' },
      tabId: 8,
      ...browser,
    })

    expect(connectPasskeyWallet).toHaveBeenCalledWith({ contractId: 'C_REQUESTED', kit })
    expect(readBalance).toHaveBeenCalledWith('C_CONNECTED')
    expect(getTestUsdc).not.toHaveBeenCalled()
    expect(submitApprove).toHaveBeenCalledOnce()
    expect(submitApprove).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: APPROVE_CAP,
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
    expect(browser.status.textContent).toBe('Deposits enabled.')
    expect(browser.scheduleClose).toHaveBeenCalledOnce()
  })

  it('funds a low connected account before approving the fixed cap', async () => {
    readBalance.mockResolvedValue(0n)
    submitApprove.mockResolvedValue({ hash: 'approve-hash', status: 'SUCCESS' })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'approve',
      params: { contractId: 'C_REQUESTED' },
      tabId: 10,
      ...browser,
    })

    expect(getTestUsdc).toHaveBeenCalledWith({ to: 'C_CONNECTED', amount: APPROVE_CAP })
    expect(submitApprove).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: APPROVE_CAP,
      kit,
    })
    expect(browser.status.textContent).toBe('Deposits enabled.')
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', ok: true, hash: 'approve-hash' })
    )
  })

  it('keeps approval available while honestly reporting a faucet failure', async () => {
    readBalance.mockResolvedValue(0n)
    getTestUsdc.mockRejectedValue(new Error('faucet unavailable'))
    submitApprove.mockResolvedValue({ hash: 'approve-hash', status: 'SUCCESS' })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'approve',
      params: { contractId: 'C_REQUESTED' },
      tabId: 11,
      ...browser,
    })

    expect(submitApprove).toHaveBeenCalledWith({
      contractId: 'C_CONNECTED',
      amount: APPROVE_CAP,
      kit,
    })
    expect(browser.status.textContent).toMatch(/approval set/i)
    expect(browser.status.textContent).toMatch(/faucet is unavailable/i)
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', ok: true, hash: 'approve-hash' })
    )
  })

  it('reports submitApprove failure and does not schedule the ceremony to close', async () => {
    submitApprove.mockRejectedValue(new Error('approve failed'))
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'approve',
      params: { contractId: 'C_REQUESTED' },
      tabId: 12,
      ...browser,
    })

    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CEREMONY_RESULT',
      tabId: 12,
      action: 'approve',
      ok: false,
      error: 'approve failed',
    })
    expect(browser.status.textContent).toMatch(/^Failed: approve failed/)
    expect(browser.scheduleClose).not.toHaveBeenCalled()
  })
})

describe('shouldAutoRunCeremony', () => {
  const genuineExtension = () => ({
    chromeApi: {
      runtime: { id: 'extension-id', sendMessage: vi.fn() },
      storage: { session: { get: vi.fn() } },
      tabs: { getCurrent: vi.fn() },
    },
    documentRef: { getElementById: vi.fn() },
    locationRef: { protocol: 'chrome-extension:' },
  })

  it('runs only for a genuine extension page with the required APIs', () => {
    expect(ceremony.shouldAutoRunCeremony(genuineExtension())).toBe(true)
  })

  it.each([
    ['ordinary web page', { locationRef: { protocol: 'https:' } }],
    ['missing runtime id', { chromeApi: { runtime: { id: '' } } }],
    ['missing runtime messaging', { chromeApi: { runtime: { sendMessage: undefined } } }],
    ['missing session storage', { chromeApi: { storage: { session: {} } } }],
    ['missing current-tab API', { chromeApi: { tabs: {} } }],
    ['missing document', { documentRef: undefined }],
  ])('does not auto-run for %s', (_label, override) => {
    expect(ceremony.shouldAutoRunCeremony({ ...genuineExtension(), ...override })).toBe(false)
  })
})
