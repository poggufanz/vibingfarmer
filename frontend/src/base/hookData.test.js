import { describe, test, expect } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { buildForwarderHookData, assertHookData, assertStellarStrKey } from './hookData.js'

const VALID_G = 'GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M'
const VALID_C = 'CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V'
const INVALID = [
  {
    label: 'unsupported T-version',
    kind: 'unsupported',
    value: 'TAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDYM5',
  },
  {
    label: 'G payload with a stale checksum',
    kind: 'G',
    value: 'GAIRCEIRCEIRCEIRCEIRCEIRAEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M',
  },
  {
    label: 'G checksum mutation',
    kind: 'G',
    value: 'GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCFWM',
  },
  {
    label: 'G checksum byte-order mutation',
    kind: 'G',
    value: 'GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDTAX',
  },
  {
    label: 'C payload with a stale checksum',
    kind: 'C',
    value: `${VALID_C.slice(0, 10)}J${VALID_C.slice(11)}`,
  },
  {
    label: 'C checksum mutation',
    kind: 'C',
    value: `${VALID_C.slice(0, -1)}A`,
  },
]

function isAcceptedBySdk(value, kind) {
  if (kind === 'G') return StrKey.isValidEd25519PublicKey(value)
  if (kind === 'C') return StrKey.isValidContract(value)
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)
}

describe('Stellar StrKey validation', () => {
  test('accepts the exact SDK-generated G and C vectors with CRC16-XModem', () => {
    expect(StrKey.isValidEd25519PublicKey(VALID_G)).toBe(true)
    expect(StrKey.isValidContract(VALID_C)).toBe(true)
    expect(() => assertStellarStrKey(VALID_G)).not.toThrow()
    expect(() => assertStellarStrKey(VALID_C)).not.toThrow()
  })

  test.each(INVALID)(
    'rejects $label according to both the SDK and hook codec',
    ({ value, kind }) => {
      expect(isAcceptedBySdk(value, kind)).toBe(false)
      expect(() => assertStellarStrKey(value)).toThrow(/strkey|checksum|version/i)
    }
  )

  test.each([
    VALID_G.slice(0, 55),
    `${VALID_G}A`,
    VALID_G.toLowerCase(),
    `${VALID_G.slice(0, 10)}0${VALID_G.slice(11)}`,
    `${VALID_G.slice(0, 10)}=${VALID_G.slice(11)}`,
  ])('rejects noncanonical length/alphabet before envelope construction', (value) => {
    expect(() => buildForwarderHookData(value)).toThrow(/strkey|base32|length/i)
  })

  test.each(
    ['1', '8', '9', 'é'].flatMap((character) => [
      { character, kind: 'G', valid: VALID_G },
      { character, kind: 'C', valid: VALID_C },
    ])
  )(
    'rejects forbidden Base32 character $character in a $kind literal before checksum evaluation',
    ({ character, kind, valid }) => {
      const value = `${valid.slice(0, 10)}${character}${valid.slice(11)}`
      expect(isAcceptedBySdk(value, kind)).toBe(false)
      expect(() => assertStellarStrKey(value)).toThrow(/strkey|base32|length|checksum/i)
      expect(() => buildForwarderHookData(value)).toThrow(/strkey|base32|length|checksum/i)
    }
  )
})

describe('buildForwarderHookData', () => {
  test.each([VALID_G, VALID_C])(
    'produces the exact [zero x24][version=0][length=56][UTF-8] envelope for %s',
    (strkey) => {
      const hookData = buildForwarderHookData(strkey)
      expect(hookData.length).toBe(88)
      expect(Buffer.from(hookData.slice(0, 24)).every((byte) => byte === 0)).toBe(true)
      expect(Buffer.from(hookData.slice(24, 28)).readUInt32BE(0)).toBe(0)
      expect(Buffer.from(hookData.slice(28, 32)).readUInt32BE(0)).toBe(56)
      expect(Buffer.from(hookData.slice(32)).toString('utf8')).toBe(strkey)
      expect(assertHookData(hookData)).toBe(strkey)
    }
  )

  test('rejects dirty envelope headers, versions, lengths, and stale checksum payloads', () => {
    const clean = Buffer.from(buildForwarderHookData(VALID_G))
    const mutations = [
      (value) => {
        value[0] = 1
      },
      (value) => value.writeUInt32BE(1, 24),
      (value) => value.writeUInt32BE(55, 28),
      (value) => value.write(INVALID[1].value, 32, 'ascii'),
    ]
    for (const mutate of mutations) {
      const corrupted = Buffer.from(clean)
      mutate(corrupted)
      expect(() => assertHookData(corrupted)).toThrow()
    }
  })

  test('rejects a decoded raw key with no hook envelope', () => {
    expect(() => assertHookData(StrKey.decodeEd25519PublicKey(VALID_G))).toThrow(/length|hookData/i)
  })
})
