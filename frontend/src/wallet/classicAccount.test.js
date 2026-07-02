// frontend/src/wallet/classicAccount.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installChromeMock } from './testUtils.js'
import { createClassicWallet, importFromSecret, withSecret } from './classicAccount.js'
import { getWallet, decryptSecret } from './vault.js'
import { isUnlocked, lock } from './session.js'

beforeEach(() => {
  installChromeMock()
})

afterEach(() => {
  vi.restoreAllMocks()
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

    // Prove withSecret's `finally` block actually zeroes the decoded secret buffer, not
    // just that signing succeeds. TextEncoder.prototype.encode is also used elsewhere
    // (e.g. vault.js KDF), so capture every call and select the one whose decoded text
    // starts with 'S' (the Stellar secret-seed prefix) — that is unambiguously the
    // buffer allocated from `bytes = new TextEncoder().encode(secret)` in withSecret.
    const realEncode = TextEncoder.prototype.encode
    const captured = []
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (s) {
      const out = realEncode.call(this, s)
      if (typeof s === 'string' && s.startsWith('S')) captured.push(out)
      return out
    })

    const sig = await withSecret(async (kp) => kp.sign(Buffer.from('hello')))
    expect(sig).toBeDefined()

    expect(captured.length).toBeGreaterThan(0)
    const secretBuffer = captured.at(-1)
    expect(Array.from(secretBuffer).every((b) => b === 0)).toBe(true)
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

  it('createClassicWallet({ pendingBackup: true }) persists needsBackup + a decryptable mnemonicBlob in ONE atomic save — no second save layered on top', async () => {
    const setSpy = vi.spyOn(globalThis.chrome.storage.local, 'set')
    const { publicKey, mnemonic } = await createClassicWallet({
      label: 'Main',
      password: 'pw12pw12pw12',
      pendingBackup: true,
    })

    // Exactly one storage.local.set call for the whole create — proves the record and
    // the backup gate land together, closing the creation-time race (flagless record
    // persisted while the mnemonic is lost between two separate saves).
    expect(setSpy).toHaveBeenCalledTimes(1)

    const rec = await getWallet(publicKey)
    expect(rec.needsBackup).toBe(true)
    expect(rec.mnemonicBlob).toBeTruthy()
    const revealed = await decryptSecret(rec.mnemonicBlob, 'pw12pw12pw12')
    expect(revealed).toBe(mnemonic)
  })

  it('createClassicWallet default (pendingBackup omitted) persists NEITHER needsBackup nor mnemonicBlob', async () => {
    const { publicKey } = await createClassicWallet({
      label: 'Main',
      password: 'pw12pw12pw12',
    })
    const rec = await getWallet(publicKey)
    expect(rec.needsBackup).toBeUndefined()
    expect(rec.mnemonicBlob).toBeUndefined()
  })
})
