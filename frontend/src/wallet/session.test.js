// frontend/src/wallet/session.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { encryptSecret, saveWallet } from './vault.js'
import { unlock, getUnlocked, lock, isUnlocked } from './session.js'

let bags
beforeEach(async () => {
  bags = installChromeMock()
  const blob = await encryptSecret(
    'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN',
    'pw12pw12pw12'
  )
  await saveWallet({ label: 'A', publicKey: 'GABC', blob, createdAt: 1 })
})

describe('session', () => {
  it('unlock caches the derived KEY (not the raw secret) and unlocks', async () => {
    await unlock('GABC', 'pw12pw12pw12')
    expect(await isUnlocked()).toBe(true)
    const raw = JSON.stringify(bags.session)
    expect(raw).not.toContain('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN')
    const u = await getUnlocked()
    expect(u.publicKey).toBe('GABC')
    expect(u.key).toBeDefined()
  })

  it('wrong password does not unlock', async () => {
    await expect(unlock('GABC', 'nope-nope-nope')).rejects.toThrow()
    expect(await isUnlocked()).toBe(false)
  })

  it('lock clears the session', async () => {
    await unlock('GABC', 'pw12pw12pw12')
    await lock()
    expect(await isUnlocked()).toBe(false)
    expect(await getUnlocked()).toBeNull()
  })
})
