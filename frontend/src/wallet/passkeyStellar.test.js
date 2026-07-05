// frontend/src/wallet/passkeyStellar.test.js
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { createStellarPasskeyWallet, fundStatus } from './passkeyStellar.js'

// createPasskeyWallet (account.js) caches the contractId via localStorage.setItem — node env
// has no localStorage, so stub it the same way account.test.js does.
const store = {}
beforeEach(() => {
  for (const k in store) delete store[k]
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
})

describe('createStellarPasskeyWallet', () => {
  test('provisions a passkey wallet and returns a G-address + working signBurn', async () => {
    const fakeKit = {
      createWallet: vi.fn(async () => ({ contractId: 'GAAAAWALLET000000000000000000000000000000000000000000000', credentialId: 'cred-abc' })),
      signAuthEntry: vi.fn(async (entry) => ({ ...entry, signed: true })),
    }
    const deps = { makeKit: vi.fn(async () => fakeKit) }

    const wallet = await createStellarPasskeyWallet({ email: 'user@example.com', deps })

    expect(wallet.address).toBe('GAAAAWALLET000000000000000000000000000000000000000000000')
    expect(wallet.credentialId).toBe('cred-abc')
    expect(typeof wallet.signBurn).toBe('function')

    const entry = { kind: 'sorobanCredentialsAddress' }
    const signed = await wallet.signBurn(entry)
    expect(fakeKit.signAuthEntry).toHaveBeenCalledWith(entry)
    expect(signed.signed).toBe(true)
  })

  test('passes the email through as the SAK userName and a stable app name', async () => {
    const fakeKit = {
      createWallet: vi.fn(async () => ({ contractId: 'GBBBB', credentialId: 'cred-2' })),
      signAuthEntry: vi.fn(),
    }
    const deps = { makeKit: vi.fn(async () => fakeKit) }

    await createStellarPasskeyWallet({ email: 'second@example.com', deps })

    expect(fakeKit.createWallet).toHaveBeenCalledWith(
      'Vibing Farmer',
      'second@example.com',
      { autoSubmit: true, autoFund: true }
    )
  })
})

describe('fundStatus', () => {
  test('reports balance + hasUsdc from the existing token-balance reader', async () => {
    const deps = { readBalance: vi.fn(async () => 25_000_000n) } // 2.5 USDC at 7dp
    const status = await fundStatus('GAAAAWALLET', { deps })
    expect(status.balanceUnits).toBe(25_000_000n)
    expect(status.balanceDisplay).toBeCloseTo(2.5, 5)
    expect(status.hasUsdc).toBe(true)
  })

  test('hasUsdc is false at zero balance, and null balance is treated as zero (RPC failure)', async () => {
    const deps = { readBalance: vi.fn(async () => null) }
    const status = await fundStatus('GAAAAWALLET', { deps })
    expect(status.balanceUnits).toBe(0n)
    expect(status.hasUsdc).toBe(false)
  })
})
