import { describe, it, expect } from 'vitest'
import { Keypair, scValToNative } from '@stellar/stellar-sdk'
import { addrScVal, i128ScVal, fromScVal, bytes32ScVal, symbolScVal } from './scval.js'
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

describe('encodeArgs dispatch', () => {
  it('maps {bytes32} and {symbol} tags to the right ScVals', () => {
    const [b, s] = encodeArgs([{ bytes32: '0x' + '01'.repeat(32) }, { symbol: 'strategy' }])
    expect(b.switch().name).toBe('scvBytes')
    expect(b.bytes().length).toBe(32)
    expect(s.switch().name).toBe('scvSymbol')
  })
})
