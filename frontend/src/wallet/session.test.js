// frontend/src/wallet/session.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { encryptSecret, saveWallet } from './vault.js'
import { unlock, getUnlocked, lock, isUnlocked } from './session.js'

// Real secret/address pairing (also used in classicAccount.test.js) — unlock() now verifies the
// decrypted secret actually derives the publicKey it was asked to unlock, so the fixture's
// declared publicKey can no longer be an arbitrary label.
const SECRET = 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN'
const PUBLIC_KEY = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6'

let bags
beforeEach(async () => {
  bags = installChromeMock()
  const blob = await encryptSecret(SECRET, 'pw12pw12pw12')
  await saveWallet({ label: 'A', publicKey: PUBLIC_KEY, blob, createdAt: 1 })
})

describe('session', () => {
  it('unlock caches the derived KEY (not the raw secret) and unlocks', async () => {
    await unlock(PUBLIC_KEY, 'pw12pw12pw12')
    expect(await isUnlocked()).toBe(true)
    const raw = JSON.stringify(bags.session)
    expect(raw).not.toContain(SECRET)
    const u = await getUnlocked()
    expect(u.publicKey).toBe(PUBLIC_KEY)
    expect(u.key).toBeDefined()
  })

  it('wrong password does not unlock', async () => {
    await expect(unlock(PUBLIC_KEY, 'nope-nope-nope')).rejects.toThrow()
    expect(await isUnlocked()).toBe(false)
  })

  it('lock clears the session', async () => {
    await unlock(PUBLIC_KEY, 'pw12pw12pw12')
    await lock()
    expect(await isUnlocked()).toBe(false)
    expect(await getUnlocked()).toBeNull()
  })

  it('unlock rejects a wallet record whose blob does not derive the declared public key (fail closed)', async () => {
    // Same secret, but saved under a DIFFERENT declared publicKey — a corrupt/tampered record.
    const blob = await encryptSecret(SECRET, 'pw12pw12pw12')
    await saveWallet({ label: 'bad', publicKey: 'GNOTTHEDERIVEDKEY', blob, createdAt: 2 })
    await expect(unlock('GNOTTHEDERIVEDKEY', 'pw12pw12pw12')).rejects.toThrow(/mismatch/)
    expect(await isUnlocked()).toBe(false)
  })

  it('isUnlocked(expectedPublicKey) answers false for a session unlocked under a different address', async () => {
    await unlock(PUBLIC_KEY, 'pw12pw12pw12')
    expect(await isUnlocked(PUBLIC_KEY)).toBe(true)
    expect(await isUnlocked('GSOMEOTHERADDRESSENTIRELY')).toBe(false)
  })
})
