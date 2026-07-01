import { describe, it, expect } from 'vitest'
import { generate24, validate, keypairFromMnemonic, keypairFromSecret } from './classicKeypair.js'

// Canonical SEP-0005 published test vector (account m/44'/148'/0')
const VEC_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe'
const VEC_PUB = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6'
const VEC_SEC = 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN'

describe('classicKeypair', () => {
  it('derives the SEP-0005 vector keypair from its mnemonic', () => {
    const kp = keypairFromMnemonic(VEC_MNEMONIC, 0)
    expect(kp.publicKey()).toBe(VEC_PUB)
    expect(kp.secret()).toBe(VEC_SEC)
  })

  it('generate24 produces a valid 24-word mnemonic', () => {
    const m = generate24()
    expect(m.split(' ')).toHaveLength(24)
    expect(validate(m)).toBe(true)
  })

  it('rejects a bad-checksum mnemonic and a bad secret', () => {
    expect(validate('bogus bogus bogus')).toBe(false)
    expect(() => keypairFromSecret('SNOTVALID')).toThrow()
  })

  it('round-trips a secret key', () => {
    expect(keypairFromSecret(VEC_SEC).publicKey()).toBe(VEC_PUB)
  })
})
