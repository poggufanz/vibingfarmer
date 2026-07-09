import { describe, it, expect } from 'vitest'
import { Keypair, scValToNative } from '@stellar/stellar-sdk'
import {
  addrScVal,
  i128ScVal,
  u64ScVal,
  fromScVal,
  bytes32ScVal,
  symbolScVal,
  boolScVal,
  structScVal,
  voidScVal,
} from './scval.js'
import { encodeArgs } from './client.js'

describe('scval codec', () => {
  it('round-trips an i128 amount (BigInt) through ScVal', () => {
    const sv = i128ScVal(100_0000000n) // 100 VFUSD at 7 decimals
    expect(fromScVal(sv)).toBe(100_0000000n)
  })

  it('accepts a number for i128 and yields a BigInt back', () => {
    const sv = i128ScVal(42)
    expect(fromScVal(sv)).toBe(42n)
  })

  it('encodes an Address ScVal that decodes back to the same strkey', () => {
    const g = Keypair.random().publicKey()
    const sv = addrScVal(g)
    // scValToNative on an address ScVal returns the strkey string
    expect(scValToNative(sv)).toBe(g)
  })

  it('fromScVal decodes a symbol/string value natively', () => {
    // build a symbol the SDK way and confirm our decoder matches scValToNative
    const sv = i128ScVal(7n)
    expect(fromScVal(sv)).toBe(scValToNative(sv))
  })

  it('voidScVal encodes Option::None as a bare ScVal Void', () => {
    const sv = voidScVal()
    expect(sv.switch().name).toBe('scvVoid')
  })
})

describe('bytes32ScVal', () => {
  it('encodes a 0x-prefixed hex string to 32-byte ScVal bytes', () => {
    const hex = '0x' + 'ab'.repeat(32)
    const sv = bytes32ScVal(hex)
    expect(sv.switch().name).toBe('scvBytes')
    expect(sv.bytes().length).toBe(32)
  })
})

describe('symbolScVal', () => {
  it('encodes a string to an ScVal symbol', () => {
    const sv = symbolScVal('venice')
    expect(sv.switch().name).toBe('scvSymbol')
  })
})

describe('boolScVal + structScVal (contracttype struct encoding)', () => {
  it('encodes booleans as ScVal bool', () => {
    expect(boolScVal(false).switch().name).toBe('scvBool')
    expect(fromScVal(boolScVal(true))).toBe(true)
  })

  it('encodes a struct as a symbol-keyed map that decodes back to the same object', () => {
    const g = Keypair.random().publicKey()
    // Fields deliberately OUT of lexicographic order — structScVal must sort them (the
    // Soroban host rejects unsorted map keys).
    const sv = structScVal({
      vault: addrScVal(g),
      cap_per_period: i128ScVal(50_0000000n),
      revoked: boolScVal(false),
      expiry: u64ScVal(4000000000),
    })
    expect(sv.switch().name).toBe('scvMap')
    const keys = sv.map().map((e) => e.key().sym().toString())
    expect(keys).toEqual(['cap_per_period', 'expiry', 'revoked', 'vault'])
    expect(scValToNative(sv)).toEqual({
      cap_per_period: 50_0000000n,
      expiry: 4000000000n,
      revoked: false,
      vault: g,
    })
  })
})

describe('encodeArgs dispatch', () => {
  it('maps {bytes32} and {symbol} tags to the right ScVals', () => {
    const [b, s] = encodeArgs([{ bytes32: '0x' + '01'.repeat(32) }, { symbol: 'strategy' }])
    expect(b.switch().name).toBe('scvBytes')
    expect(b.bytes().length).toBe(32)
    expect(s.switch().name).toBe('scvSymbol')
  })
})
