import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
// signTransaction's tx object is only ever handed straight to the (already mocked)
// signTransactionForContract -- its real shape is never inspected, so a bare stub is enough and
// keeps this suite from needing a real, validly-signed envelope.
vi.mock('@stellar/stellar-sdk', () => ({
  TransactionBuilder: { fromXDR: vi.fn(() => ({ mockTx: true })) },
}))
// Decode-for-display only feeds the (best-effort, failure-swallowed) consequence-first render —
// no test below inspects rendered ceremonyView output, so a stub is enough; this also keeps this
// suite from needing txSummary.js's full real dependency chain (grantDecoder.js + several more
// stellar/config.js addresses beyond what this file mocks above).
vi.mock('./txSummary.js', () => ({
  summarizeTransaction: vi.fn(() => null),
  summarizeAuthEntry: vi.fn(() => null),
}))

import { connectPasskeyWallet, makeKit, readBalance } from '../src/wallet/account.js'
import { getTestUsdc } from '../src/wallet/faucet.js'
import { submitApprove, submitDeposit } from '../src/wallet/submit.js'
import { signAuthEntryString, signTransactionForContract } from '../src/wallet/signGeneric.js'
import { eligibility as vfEligibility, vaultFacts } from '../src/vfapi/client.js'
import { toBaseUnits } from '../src/stellar/format.js'
import { REQUEST_TTL_MS } from '../src/wallet/consentStore.js'
import * as ceremony from './ceremony.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ceremonySource = readFileSync(path.resolve(here, './ceremony.js'), 'utf8')

const kit = { signAuthEntry: vi.fn() }
const facts = { protocol: 'blend-usdc' }
const APPROVE_CAP = 100n * 10n ** 7n
const REQUESTED_ACCOUNT_ID = 'stellar-testnet:C_REQUESTED'

// Minimal, in-memory chrome.storage.local double -- real enough for
// src/wallet/activeAccount.js's resolveActiveAccount (get/set/remove over plain keys), which
// ceremony.js now calls for real (not mocked) to build/revalidate its internal-action snapshot.
function fakeStorageLocal(initial = {}) {
  const store = { ...initial }
  return {
    get: vi.fn(async (keys) => {
      if (keys == null) return { ...store }
      const list = Array.isArray(keys) ? keys : [keys]
      const out = {}
      for (const k of list) if (k in store) out[k] = store[k]
      return out
    }),
    set: vi.fn(async (obj) => {
      Object.assign(store, obj)
    }),
    remove: vi.fn(async (key) => {
      delete store[key]
    }),
  }
}

// Default storage reflects a device with exactly one cached passkey wallet, address
// 'C_REQUESTED' -- matching the contractId every existing deposit/approve test already requests,
// so resolveActiveAccount resolves 'ready' against it and the new snapshot pre-check passes
// silently for every test that doesn't deliberately set up a mismatch.
function browserHarness({ storage = { vf_wallet_contract: 'C_REQUESTED' } } = {}) {
  const status = { textContent: '' }
  const els = { status }
  return {
    chromeApi: {
      runtime: { sendMessage: vi.fn() },
      storage: { local: fakeStorageLocal(storage) },
    },
    documentRef: { getElementById: vi.fn((id) => els[id] ?? null) },
    localStorageRef: { getItem: vi.fn(() => null) },
    scheduleClose: vi.fn(),
    status,
    windowRef: { close: vi.fn() },
  }
}

function okResult(mock) {
  return mock.mock.calls.map((c) => c[0]).find((m) => m.ok === true)
}
function failResult(mock) {
  return mock.mock.calls.map((c) => c[0]).find((m) => m.ok === false)
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

// ---------------------------------------------------------------------------------------------
// Step 1, assertion 1: no reference to the undefined pre-Gate-0 functions remains. Gate 0's
// commit f0f1f29 ("restore live popup amount, funding, and receipt contracts") already removed
// them; this pins that fact so a future edit can never silently reintroduce them. Mutation-proof
// performed manually against the source file (see task report) -- inserting either identifier
// anywhere in ceremony.js, including a comment, turns this RED.
// ---------------------------------------------------------------------------------------------
describe('ceremony.js source — Step 1: no undefined function references remain', () => {
  it('never references executeAgentDeposit or executeAgentApprove anywhere in the source text', () => {
    expect(ceremonySource).not.toMatch(/executeAgentDeposit/)
    expect(ceremonySource).not.toMatch(/executeAgentApprove/)
  })
})

// ---------------------------------------------------------------------------------------------
// Step 1, assertion 4 (pinned, not re-fixed — see task brief): amounts parse to EXACT chain units
// via toBaseUnits, never Number*10**decimals. 8.26220495 is not a hypothetical edge case: verified
// empirically (see task report) that Math.round(Number('8.26220495') * 1e7) === 82622049n while
// the exact decimal value is 82622050n — a genuine, provable float-vs-exact divergence.
// ---------------------------------------------------------------------------------------------
describe('normalizeDepositAmount — Step 1: exact chain units, never Number*10**decimals', () => {
  it('returns the EXACT toBaseUnits value, not the naive float-rounded one, for an input where they provably differ', () => {
    const naiveFloatUnits = BigInt(Math.round(Number('8.26220495') * 1e7))
    expect(naiveFloatUnits).toBe(82622049n) // the wrong answer a naive Number*10**decimals gives
    expect(ceremony.normalizeDepositAmount('8.26220495')).toBe(toBaseUnits('8.26220495'))
    expect(ceremony.normalizeDepositAmount('8.26220495')).toBe(82622050n) // the exact answer
    expect(ceremony.normalizeDepositAmount('8.26220495')).not.toBe(naiveFloatUnits)
  })
})

describe('runCeremony submit wiring', () => {
  it('normalizes the popup decimal amount and forwards the complete deposit receipt, including the active-account snapshot ID', async () => {
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
    // Step 1, assertion 5: result includes sharesBefore, sharesAfter, hash/status, AND the
    // active-account snapshot ID.
    expect(browser.chromeApi.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CEREMONY_RESULT',
      tabId: 7,
      action: 'deposit',
      ok: true,
      hash: 'deposit-hash',
      status: 'SUCCESS',
      sharesBefore: '2',
      sharesAfter: '7',
      accountSnapshotId: REQUESTED_ACCOUNT_ID,
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
      accountSnapshotId: REQUESTED_ACCOUNT_ID,
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

// ---------------------------------------------------------------------------------------------
// Step 1, assertion 3 (Step 3 substance): a shares-delta "confirmed deposit" claim may appear only
// once the transaction is actually confirmed (out.status === 'SUCCESS'). api/stellar-relay.js's
// own pollResult can legitimately return 'PENDING' (submitted but not yet observed) while
// sharesAfter was already read right after submission -- a pending/unknown status must read as
// unknown, never as a minted-shares claim.
// ---------------------------------------------------------------------------------------------
describe('runCeremony — Step 3: shares-delta confirmed copy gated on out.status === SUCCESS', () => {
  it('a PENDING relay status never claims "Minted N shares" — reads as not-yet-confirmed, but still delivers the true sharesBefore/sharesAfter/hash (never hidden)', async () => {
    submitDeposit.mockResolvedValue({
      hash: 'deposit-hash',
      status: 'PENDING',
      sharesBefore: '0',
      sharesAfter: '0', // read right after submission -- may not reflect the eventual mint at all
    })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 13,
      ...browser,
    })

    expect(browser.status.textContent).not.toMatch(/^Minted/)
    expect(browser.status.textContent).toMatch(/not yet confirmed/i)
    const ok = okResult(browser.chromeApi.runtime.sendMessage)
    expect(ok).toMatchObject({
      hash: 'deposit-hash',
      status: 'PENDING',
      sharesBefore: '0',
      sharesAfter: '0',
    })
  })

  it('a SUCCESS relay status DOES claim the minted shares (positive control: the gate is not vacuously closed)', async () => {
    submitDeposit.mockResolvedValue({
      hash: 'deposit-hash',
      status: 'SUCCESS',
      sharesBefore: '0',
      sharesAfter: '5',
    })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 14,
      ...browser,
    })

    expect(browser.status.textContent).toBe('Minted 5 shares.')
  })
})

// ---------------------------------------------------------------------------------------------
// Step 1, assertions 6-8 (the real substance of this task): snapshot revalidation, before WebAuthn
// and again before result delivery; a mismatched/switching/expired request submits nothing; and a
// built-but-not-submitted passkey Send path is never exposed as completed.
// ---------------------------------------------------------------------------------------------
describe('runCeremony — security: snapshot revalidated before WebAuthn; mismatched/expired submits nothing', () => {
  it('a requested contractId that does not match the currently active account submits nothing — no kit, no connect, no submit', async () => {
    const browser = browserHarness({ storage: { vf_wallet_contract: 'C_OTHER' } })

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 20,
      ...browser,
    })

    expect(makeKit).not.toHaveBeenCalled()
    expect(connectPasskeyWallet).not.toHaveBeenCalled()
    expect(submitDeposit).not.toHaveBeenCalled()
    const fail = failResult(browser.chromeApi.runtime.sendMessage)
    expect(fail).toMatchObject({ tabId: 20, action: 'deposit' })
    expect(fail.error).toMatch(/does not match the active account/i)
    expect(browser.scheduleClose).not.toHaveBeenCalled()
  })

  it('no active account at all (e.g. the cached wallet was removed) submits nothing for a targeted request', async () => {
    const browser = browserHarness({ storage: {} })

    await ceremony.runCeremony({
      action: 'approve',
      params: { contractId: 'C_REQUESTED' },
      tabId: 21,
      ...browser,
    })

    expect(makeKit).not.toHaveBeenCalled()
    expect(submitApprove).not.toHaveBeenCalled()
    const fail = failResult(browser.chromeApi.runtime.sendMessage)
    expect(fail.ok).toBe(false)
  })

  it('an expired request (older than the snapshot TTL) submits nothing, independent of the account matching', async () => {
    const browser = browserHarness() // storage matches C_REQUESTED — this is NOT a mismatch case
    let call = 0
    // First now() call stamps snapshot.createdAt; the second (the pre-check's own `now`) lands
    // just past REQUEST_TTL_MS later — simulating a stale ceremony tab, not an account switch.
    const now = () => (call++ === 0 ? 1_000 : 1_000 + REQUEST_TTL_MS + 1)

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 22,
      now,
      ...browser,
    })

    expect(makeKit).not.toHaveBeenCalled()
    expect(submitDeposit).not.toHaveBeenCalled()
    const fail = failResult(browser.chromeApi.runtime.sendMessage)
    expect(fail.error).toMatch(/expired/i)
  })

  it('a fresh (non-expired) request with a matching account proceeds normally (positive control: the TTL check is not vacuously closed)', async () => {
    submitDeposit.mockResolvedValue({
      hash: 'deposit-hash',
      status: 'SUCCESS',
      sharesBefore: '0',
      sharesAfter: '5',
    })
    const browser = browserHarness()
    const now = () => 1_000 // both calls return the same, un-expired instant

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 23,
      now,
      ...browser,
    })

    expect(submitDeposit).toHaveBeenCalledOnce()
    const ok = okResult(browser.chromeApi.runtime.sendMessage)
    expect(ok).toBeTruthy()
  })

  it('connect with no requested address (fresh discovery) is never blocked by the snapshot check even with no cached account', async () => {
    connectPasskeyWallet.mockResolvedValue({ contractId: 'C_DISCOVERED' })
    const browser = browserHarness({ storage: {} }) // nothing cached yet — legitimate first connect

    await ceremony.runCeremony({
      action: 'connect',
      params: {},
      tabId: 24,
      ...browser,
    })

    expect(connectPasskeyWallet).toHaveBeenCalledOnce()
    const ok = okResult(browser.chromeApi.runtime.sendMessage)
    expect(ok).toMatchObject({ address: 'C_DISCOVERED' })
  })
})

describe('runCeremony — security: snapshot revalidated again before result delivery (switching during the ceremony)', () => {
  it('deposit/approve: an account switch WHILE the ceremony was running still delivers the true, honest on-chain result (money already moved), but flags accountSnapshotStale', async () => {
    const browser = browserHarness()
    submitDeposit.mockImplementation(async () => {
      // Simulates the user switching the active passkey account in another window while this
      // ceremony's Face-ID/RPC round-trip was still in flight.
      await browser.chromeApi.storage.local.set({ vf_wallet_contract: 'C_SWITCHED' })
      return { hash: 'deposit-hash', status: 'SUCCESS', sharesBefore: '0', sharesAfter: '5' }
    })

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 25,
      ...browser,
    })

    const ok = okResult(browser.chromeApi.runtime.sendMessage)
    expect(ok).toMatchObject({
      ok: true,
      hash: 'deposit-hash', // the real, already-submitted transaction — never hidden or suppressed
      accountSnapshotId: REQUESTED_ACCOUNT_ID, // the account THIS ceremony actually ran for
      accountSnapshotStale: true,
    })
  })

  it('a stable account (no switch) never carries the accountSnapshotStale flag at all (positive control)', async () => {
    submitDeposit.mockResolvedValue({
      hash: 'deposit-hash',
      status: 'SUCCESS',
      sharesBefore: '0',
      sharesAfter: '5',
    })
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'deposit',
      params: { contractId: 'C_REQUESTED', amount: '1.5', protocol: 'blend-usdc' },
      tabId: 26,
      ...browser,
    })

    const ok = okResult(browser.chromeApi.runtime.sendMessage)
    expect(ok).not.toHaveProperty('accountSnapshotStale')
  })

  it('signTransaction: a built-but-not-submitted artifact is DISCARDED (never delivered) when the account switches before delivery — reported as an honest failure, never as signed/completed', async () => {
    const browser = browserHarness()
    signTransactionForContract.mockImplementation(async () => {
      await browser.chromeApi.storage.local.set({ vf_wallet_contract: 'C_SWITCHED' })
      return 'SIGNED_XDR'
    })

    await ceremony.runCeremony({
      action: 'signTransaction',
      params: { xdr: 'RAWXDR', opts: { address: 'C_REQUESTED' } },
      tabId: 27,
      ...browser,
    })

    const fail = failResult(browser.chromeApi.runtime.sendMessage)
    expect(fail).toBeTruthy()
    expect(fail).not.toHaveProperty('signedTxXdr') // the built artifact must never leave this ceremony
    expect(fail.error).toMatch(/not submitted/i)
    expect(browser.status.textContent).not.toMatch(/signed|completed/i)
    expect(browser.scheduleClose).not.toHaveBeenCalled()
  })

  it('signTransaction: a STABLE account delivers the signed artifact normally (positive control: the discard path is not vacuously closed)', async () => {
    signTransactionForContract.mockResolvedValue('SIGNED_XDR')
    const browser = browserHarness()

    await ceremony.runCeremony({
      action: 'signTransaction',
      params: { xdr: 'RAWXDR', opts: { address: 'C_REQUESTED' } },
      tabId: 28,
      ...browser,
    })

    const ok = okResult(browser.chromeApi.runtime.sendMessage)
    expect(ok).toMatchObject({ signedTxXdr: 'SIGNED_XDR' })
    expect(browser.status.textContent).toBe('Transaction signed.')
  })

  it('signAuthEntry: a built-but-not-submitted artifact is DISCARDED the same way as signTransaction', async () => {
    const browser = browserHarness()
    signAuthEntryString.mockImplementation(async () => {
      await browser.chromeApi.storage.local.set({ vf_wallet_contract: 'C_SWITCHED' })
      return 'SIGNED_ENTRY'
    })

    await ceremony.runCeremony({
      action: 'signAuthEntry',
      params: { authEntry: 'RAWENTRY', opts: { address: 'C_REQUESTED' } },
      tabId: 29,
      ...browser,
    })

    const fail = failResult(browser.chromeApi.runtime.sendMessage)
    expect(fail).toBeTruthy()
    expect(fail).not.toHaveProperty('signedAuthEntry')
    expect(fail.error).toMatch(/not submitted/i)
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
