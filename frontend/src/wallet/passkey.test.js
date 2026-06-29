import { describe, it, expect } from 'vitest'
import {
  derToRaw,
  normalizeLowS,
  buildChallenge,
  assertChallengeMatches,
  runCeremony,
} from './passkey.js'
import { createHash } from 'crypto'

// secp256r1 curve order n:
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const HALF_N = N >> 1n

function sToBig(raw) {
  return BigInt('0x' + Buffer.from(raw.slice(32, 64)).toString('hex'))
}

describe('passkey signature normalization', () => {
  it('derToRaw extracts 64-byte r||s from a DER ECDSA signature', () => {
    // DER: 30 44 02 20 <32B r> 02 20 <32B s>
    const r = new Uint8Array(32).fill(0x11)
    const s = new Uint8Array(32).fill(0x22)
    const der = Uint8Array.from([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s])
    const raw = derToRaw(der)
    expect(raw.length).toBe(64)
    expect(Buffer.from(raw.slice(0, 32)).toString('hex')).toBe('11'.repeat(32))
    expect(Buffer.from(raw.slice(32)).toString('hex')).toBe('22'.repeat(32))
  })

  it('normalizeLowS flips a high-S signature to n - s', () => {
    const r = new Uint8Array(32).fill(0x01)
    const highS = BigInt('0x' + (N - 5n).toString(16).padStart(64, '0'))
    const sBytes = Uint8Array.from(Buffer.from(highS.toString(16).padStart(64, '0'), 'hex'))
    const raw = Uint8Array.from([...r, ...sBytes])
    const out = normalizeLowS(raw)
    expect(sToBig(out)).toBe(5n) // n - (n-5) = 5, which is <= n/2
    expect(sToBig(out) <= HALF_N).toBe(true)
  })

  it('normalizeLowS leaves an already-low-S signature untouched', () => {
    const r = new Uint8Array(32).fill(0x01)
    const lowS = Uint8Array.from(Buffer.from(7n.toString(16).padStart(64, '0'), 'hex'))
    const raw = Uint8Array.from([...r, ...lowS])
    const out = normalizeLowS(raw)
    expect(sToBig(out)).toBe(7n)
  })
})

describe('passkey challenge binding', () => {
  it('challenge == base64url(payload), unpadded, 43 chars for 32B', async () => {
    const preimage = Uint8Array.from(createHash('sha256').update('vf-auth-entry').digest())
    const ch = await buildChallenge(preimage)
    // Value assertion (not just format): buildChallenge single-encodes the
    // already-hashed payload. A re-introduced double-hash (base64url(sha256(payload)))
    // would change the value and fail here — the format-only checks below could not.
    const expected = Buffer.from(preimage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(ch).toBe(expected)
    expect(ch).not.toMatch(/[=]/) // unpadded
    expect(ch).not.toMatch(/[+/]/) // url-safe alphabet
    expect(ch.length).toBe(43) // 32B payload → 43 base64url chars
  })

  it('assertChallengeMatches throws when clientDataJSON challenge != expected', async () => {
    const preimage = Uint8Array.from(createHash('sha256').update('x').digest())
    const expected = await buildChallenge(preimage)
    const goodClientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: expected,
      origin: 'chrome-extension://abc',
    })
    const badClientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: 'tampered',
      origin: 'chrome-extension://abc',
    })
    expect(() => assertChallengeMatches(goodClientData, expected)).not.toThrow()
    expect(() => assertChallengeMatches(badClientData, expected)).toThrow(/challenge mismatch/)
  })
})

describe('passkey ceremony runner', () => {
  it('passes the bound challenge to the authenticator and returns normalized parts', async () => {
    const fakeAssertion = {
      response: {
        authenticatorData: new Uint8Array([0xaa]).buffer,
        clientDataJSON: new TextEncoder().encode(
          JSON.stringify({ type: 'webauthn.get', challenge: 'CH', origin: 'chrome-extension://x' })
        ).buffer,
        signature: Uint8Array.from([
          0x30,
          0x44,
          0x02,
          0x20,
          ...new Uint8Array(32).fill(1),
          0x02,
          0x20,
          ...new Uint8Array(32).fill(2),
        ]).buffer,
      },
    }
    const provider = {
      get: async (opts) => {
        provider.seen = opts
        return fakeAssertion
      },
    }
    const out = await runCeremony({ kind: 'get', challenge: 'CH', rpId: 'localhost', provider })
    // challenge reached the authenticator:
    expect(new TextDecoder().decode(provider.seen.publicKey.challenge)).toContain('CH')
    expect(out.signature.length).toBe(64) // DER → raw, already low-S
  })
})
