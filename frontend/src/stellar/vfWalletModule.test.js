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

  it('getAddress reads from window.vfWallet and caches the result (no repeat ceremony tab)', async () => {
    const getAddress = vi.fn(async () => ({ address: 'CWALLET' }))
    setProvider({ getAddress })
    const mod = new VfWalletModule()
    expect(await mod.getAddress()).toEqual({ address: 'CWALLET' })
    expect(await mod.getAddress()).toEqual({ address: 'CWALLET' })
    expect(getAddress).toHaveBeenCalledOnce()
  })

  it('signTransaction delegates to window.vfWallet and falls back to the cached address', async () => {
    setProvider({
      getAddress: vi.fn(async () => ({ address: 'CWALLET' })),
      signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED' })),
    })
    const mod = new VfWalletModule()
    await mod.getAddress()
    const out = await mod.signTransaction('UNSIGNED', {
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    expect(out).toEqual({ signedTxXdr: 'SIGNED', signerAddress: 'CWALLET' })
    expect(window.vfWallet.signTransaction).toHaveBeenCalledWith('UNSIGNED', {
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

  it('disconnect clears the cached address so the next getAddress re-resolves', async () => {
    setProvider({ getAddress: vi.fn(async () => ({ address: 'CWALLET' })) })
    const mod = new VfWalletModule()
    await mod.getAddress()
    await mod.disconnect()
    await mod.getAddress()
    expect(window.vfWallet.getAddress).toHaveBeenCalledTimes(2)
  })
})
