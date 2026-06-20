import { describe, it, expect } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { newSessionKey } from './sessionKey.js'

describe('agent session key', () => {
  it('generates a G-address keypair with a 32-byte raw public key', () => {
    const sk = newSessionKey()
    expect(sk.publicKey).toMatch(/^G[A-Z2-7]{55}$/) // ed25519 strkey
    expect(sk.rawPublicKey).toBeInstanceOf(Uint8Array)
    expect(sk.rawPublicKey.length).toBe(32) // the BytesN<32> the registry registers as signer
  })

  it('sign() produces a 64-byte ed25519 signature that verifies under the public key', () => {
    const sk = newSessionKey()
    const payload = Buffer.from('a'.repeat(32)) // a 32-byte auth payload hash
    const sig = sk.sign(payload)
    expect(sig.length).toBe(64) // BytesN<64> — what __check_auth expects
    // independent verification via a fresh Keypair from the same public strkey
    expect(Keypair.fromPublicKey(sk.publicKey).verify(payload, sig)).toBe(true)
  })

  it('restores a session key from its secret (worker re-hydration across a refresh)', () => {
    const sk = newSessionKey()
    const restored = newSessionKey(sk.secret)
    expect(restored.publicKey).toBe(sk.publicKey)
  })
})
