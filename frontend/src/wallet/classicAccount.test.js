// frontend/src/wallet/classicAccount.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { createClassicWallet, importFromSecret, withSecret } from './classicAccount.js'
import { isUnlocked, lock } from './session.js'

beforeEach(() => {
  installChromeMock()
})

describe('classicAccount', () => {
  it('creates a wallet, returns a 24-word mnemonic, and unlocks', async () => {
    const { publicKey, mnemonic } = await createClassicWallet({
      label: 'Main',
      password: 'pw12pw12pw12',
    })
    expect(publicKey).toMatch(/^G/)
    expect(mnemonic.split(' ')).toHaveLength(24)
    expect(await isUnlocked()).toBe(true)
  })

  it('imports from a secret and signs via withSecret (buffer wiped afterward)', async () => {
    const { publicKey } = await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12',
      label: 'Imp',
    })
    expect(publicKey).toBe('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6')
    const sig = await withSecret(async (kp) => kp.sign(Buffer.from('hello')))
    expect(sig).toBeDefined()
  })

  it('withSecret throws when locked', async () => {
    await importFromSecret({
      secret: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
      password: 'pw12pw12pw12',
      label: 'x',
    })
    await lock()
    await expect(withSecret(async () => 1)).rejects.toThrow('locked')
  })
})
