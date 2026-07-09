// frontend/src/wallet/vault.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from './testUtils.js'
import {
  encryptSecret,
  decryptSecret,
  saveWallet,
  getWallet,
  listWallets,
  removeWallet,
} from './vault.js'

let bags
beforeEach(() => {
  bags = installChromeMock()
})

describe('vault', () => {
  it('round-trips encrypt/decrypt', async () => {
    const blob = await encryptSecret(
      'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      'hunter2hunter2'
    )
    expect(blob.kdf.iters).toBe(600000)
    const out = await decryptSecret(blob, 'hunter2hunter2')
    expect(out).toBe('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN')
  })

  it('wrong password throws and never yields plaintext', async () => {
    const blob = await encryptSecret('SECRETSEED', 'right-password')
    await expect(decryptSecret(blob, 'wrong-password')).rejects.toThrow()
  })

  it('persists only ciphertext (no plaintext secret in storage)', async () => {
    const blob = await encryptSecret('SBPLAINTEXTSHOULDNOTAPPEAR', 'pw123456pw12')
    await saveWallet({ label: 'A', publicKey: 'GABC', blob, createdAt: 1 })
    const raw = JSON.stringify(bags.local)
    expect(raw).not.toContain('SBPLAINTEXTSHOULDNOTAPPEAR')
    expect((await getWallet('GABC')).label).toBe('A')
    expect(await listWallets()).toHaveLength(1)
    await removeWallet('GABC')
    expect(await listWallets()).toHaveLength(0)
  })
})
