// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VfWalletModule } from './vfWalletModule.js'

function setProvider(methods) {
  window.vfWallet = methods
}

describe('VfWalletModule', () => {
  beforeEach(() => {
    delete window.vfWallet
  })

  it('isAvailable resolves false after the 300ms grace window when nothing injects', async () => {
    vi.useFakeTimers()
    try {
      const mod = new VfWalletModule()
      const p = mod.isAvailable()
      await vi.advanceTimersByTimeAsync(300)
      expect(await p).toBe(false)
      setProvider({})
      expect(await mod.isAvailable()).toBe(true) // provider present → immediate true, no timer
    } finally {
      vi.useRealTimers()
    }
  })

  it('isAvailable resolves true when the announce event fires within the grace window', async () => {
    vi.useFakeTimers()
    try {
      const mod = new VfWalletModule()
      const p = mod.isAvailable()
      setProvider({})
      window.dispatchEvent(new Event('vfWallet#initialized'))
      expect(await p).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('getAddress throws a clear error when the extension is not detected', async () => {
    const mod = new VfWalletModule()
    await expect(mod.getAddress()).rejects.toThrow(/not detected/i)
  })

  it('getAddress reads from window.vfWallet fresh every call — no permanent cache', async () => {
    const getAddress = vi.fn(async () => ({ address: 'CWALLET' }))
    setProvider({ getAddress })
    const mod = new VfWalletModule()
    expect(await mod.getAddress()).toEqual({ address: 'CWALLET' })
    expect(await mod.getAddress()).toEqual({ address: 'CWALLET' })
    expect(getAddress).toHaveBeenCalledTimes(2)
  })

  it('getAddress reflects an account switch on the very next call (no stale cached address)', async () => {
    const getAddress = vi
      .fn()
      .mockResolvedValueOnce({ address: 'COLD' })
      .mockResolvedValueOnce({ address: 'CNEW' })
    setProvider({ getAddress })
    const mod = new VfWalletModule()
    expect(await mod.getAddress()).toEqual({ address: 'COLD' })
    expect(await mod.getAddress()).toEqual({ address: 'CNEW' })
  })

  it('signTransaction delegates without manufacturing signer metadata the provider omitted', async () => {
    setProvider({
      signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED' })),
    })
    const mod = new VfWalletModule()
    const out = await mod.signTransaction('UNSIGNED', {
      address: 'CWALLET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    expect(out).toEqual({ signedTxXdr: 'SIGNED' })
    expect(window.vfWallet.signTransaction).toHaveBeenCalledWith('UNSIGNED', {
      address: 'CWALLET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
  })

  it('signAuthEntry delegates to window.vfWallet', async () => {
    setProvider({
      signAuthEntry: vi.fn(async () => ({ signedAuthEntry: 'SENTRY', signerAddress: 'CWALLET' })),
    })
    const mod = new VfWalletModule()
    const out = await mod.signAuthEntry('ENTRY', { address: 'CWALLET' })
    expect(out).toEqual({ signedAuthEntry: 'SENTRY', signerAddress: 'CWALLET' })
  })

  it('signAuthEntry does not manufacture signer metadata the provider omitted', async () => {
    setProvider({ signAuthEntry: vi.fn(async () => ({ signedAuthEntry: 'SENTRY' })) })
    const mod = new VfWalletModule()
    await expect(mod.signAuthEntry('ENTRY', { address: 'CWALLET' })).resolves.toEqual({
      signedAuthEntry: 'SENTRY',
    })
  })

  it('signMessage rejects - VF Wallet only signs Soroban auth entries', async () => {
    const mod = new VfWalletModule()
    await expect(mod.signMessage('hi')).rejects.toMatchObject({ code: -3 })
  })

  it('getNetwork reports the pinned testnet passphrase without touching the extension', async () => {
    const mod = new VfWalletModule()
    const out = await mod.getNetwork()
    expect(out).toEqual({
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
  })

  it('disconnect resolves without throwing (no local state to tear down)', async () => {
    const mod = new VfWalletModule()
    await expect(mod.disconnect()).resolves.toBeUndefined()
  })
})
