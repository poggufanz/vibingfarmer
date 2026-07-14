// frontend/src/wallet/ui/classic/controller.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installChromeMock } from '../../testUtils.js'

// Partial mocks: keep the real crypto/keypair/session logic (already covered by
// classicAccount.test.js / send.test.js / prices.test.js / history.test.js), but
// stub the network-touching leaves so this controller-level suite stays fast and
// deterministic, and so we can assert the controller passes arguments through
// verbatim rather than re-testing the underlying modules.
vi.mock('../../classicAccount.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, readBalances: vi.fn(), fundTestnet: vi.fn() }
})
vi.mock('../../prices.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchXlmUsd: vi.fn() }
})
vi.mock('../../history.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchHistory: vi.fn() }
})
vi.mock('../../send.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, previewSend: vi.fn(), sendPayment: vi.fn() }
})
vi.mock('../../trustline.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, addTrustline: vi.fn() }
})

import {
  bootstrap,
  doCreate,
  confirmBackup,
  revealBackup,
  doImport,
  doUnlock,
  doLock,
  doExport,
  refreshHome,
  doFund,
  doPreview,
  doSend,
  doAddAsset,
  loadActivity,
} from './controller.js'
import { readBalances, fundTestnet } from '../../classicAccount.js'
import { fetchXlmUsd } from '../../prices.js'
import { fetchHistory } from '../../history.js'
import { previewSend, sendPayment } from '../../send.js'
import { addTrustline } from '../../trustline.js'

beforeEach(() => {
  installChromeMock()
  vi.clearAllMocks()
})

describe('classic controller', () => {
  it('bootstrap reports no wallet initially, then create yields a pending-backup mnemonic', async () => {
    expect((await bootstrap()).hasWallet).toBe(false)
    const res = await doCreate('Main', 'pw12pw12pw12')
    expect(res.publicKey).toMatch(/^G/)
    expect(res.mnemonic.split(' ')).toHaveLength(24)
    expect(res.needsBackup).toBe(true)
  })

  it('bootstrap reports a wallet after create + backup confirm', async () => {
    const { publicKey } = await doCreate('Main', 'pw12pw12pw12')
    await confirmBackup(publicKey)
    const b = await bootstrap()
    expect(b.hasWallet).toBe(true)
    expect(b.publicKey).toMatch(/^G/)
  })

  it('create without confirming persists the pending-backup gate - a FRESH bootstrap call (modeling the popup having closed and reopened) still reports it, not just in-memory state', async () => {
    const { publicKey } = await doCreate('Main', 'pw12pw12pw12')
    const b = await bootstrap()
    expect(b.hasWallet).toBe(true)
    expect(b.needsBackup).toBe(true)
    expect(b.publicKey).toBe(publicKey)
  })

  it('revealBackup decrypts the same mnemonic doCreate returned when given the correct password, and rejects a wrong password', async () => {
    const { publicKey, mnemonic } = await doCreate('Main', 'pw12pw12pw12')
    await expect(revealBackup(publicKey, 'totally-wrong-pw')).rejects.toThrow()
    const revealed = await revealBackup(publicKey, 'pw12pw12pw12')
    expect(revealed).toBe(mnemonic)
  })

  it('confirmBackup clears the gate and deletes the mnemonic blob - bootstrap reports needsBackup false and revealBackup now throws', async () => {
    const { publicKey } = await doCreate('Main', 'pw12pw12pw12')
    await confirmBackup(publicKey)

    const b = await bootstrap()
    expect(b.needsBackup).toBe(false)
    expect(b.hasWallet).toBe(true)

    await expect(revealBackup(publicKey, 'pw12pw12pw12')).rejects.toThrow()
  })

  it('doImport routes a valid secret key to importFromSecret', async () => {
    const r = await doImport(
      'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      'pw12pw12pw12',
      'Imp'
    )
    expect(r.publicKey).toBe('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6')
  })

  it('doImport rejects unparseable input instead of silently importing', async () => {
    await expect(doImport('not a key or phrase', 'pw12pw12pw12', 'x')).rejects.toThrow()
  })

  it('doImport never sets the pending-backup gate - bootstrap reports needsBackup false for an imported wallet', async () => {
    const r = await doImport(
      'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      'pw12pw12pw12',
      'Imp'
    )
    const b = await bootstrap()
    expect(b.hasWallet).toBe(true)
    expect(b.publicKey).toBe(r.publicKey)
    expect(b.needsBackup).toBe(false)
  })

  it('doUnlock/doLock round-trip; doExport is password-gated against the vault record', async () => {
    const { publicKey } = await doCreate('Main', 'pw12pw12pw12')
    await confirmBackup(publicKey)
    await doLock()

    await expect(doExport(publicKey, 'totally-wrong-pw')).rejects.toThrow()
    const secret = await doExport(publicKey, 'pw12pw12pw12')
    expect(secret).toMatch(/^S/)

    await doUnlock(publicKey, 'pw12pw12pw12')
    const b = await bootstrap()
    expect(b.unlocked).toBe(true)
  })

  it('refreshHome reports unfunded when the account has no balances yet', async () => {
    readBalances.mockResolvedValueOnce(null)
    const r = await refreshHome('GXXXX')
    expect(r).toEqual({ unfunded: true, portfolio: null })
  })

  it('refreshHome degrades to balance-only display when the price feed is unavailable', async () => {
    readBalances.mockResolvedValueOnce([{ asset: 'XLM', code: 'XLM', issuer: null, balance: '10' }])
    fetchXlmUsd.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    const r = await refreshHome('GXXXX')
    expect(r.unfunded).toBe(false)
    expect(r.portfolio.complete).toBe(false)
  })

  it('doFund proxies to fundTestnet', async () => {
    fundTestnet.mockResolvedValueOnce(true)
    expect(await doFund('GXXXX')).toBe(true)
    expect(fundTestnet).toHaveBeenCalledWith('GXXXX')
  })

  it('doPreview/doSend proxy straight through to send.js', async () => {
    previewSend.mockResolvedValueOnce({ confirm: {}, vault: { hit: false } })
    sendPayment.mockResolvedValueOnce({ hash: 'x', status: 'SUCCESS' })
    const params = { from: 'GA', to: 'GB', asset: 'XLM', amount: '1' }

    expect(await doPreview(params)).toEqual({ confirm: {}, vault: { hit: false } })
    expect(await doSend(params)).toEqual({ hash: 'x', status: 'SUCCESS' })
    expect(previewSend).toHaveBeenCalledWith(params)
    expect(sendPayment).toHaveBeenCalledWith(params)
  })

  it('doAddAsset proxies to addTrustline with code + issuer', async () => {
    addTrustline.mockResolvedValueOnce({ hash: 'x', status: 'SUCCESS', code: 'USDC', issuer: 'GI' })
    expect(await doAddAsset('USDC', 'GI')).toEqual({
      hash: 'x',
      status: 'SUCCESS',
      code: 'USDC',
      issuer: 'GI',
    })
    expect(addTrustline).toHaveBeenCalledWith({ code: 'USDC', issuer: 'GI' })
  })

  it('loadActivity proxies to fetchHistory', async () => {
    fetchHistory.mockResolvedValueOnce([{ id: '1' }])
    expect(await loadActivity('GXXXX')).toEqual([{ id: '1' }])
  })
})
