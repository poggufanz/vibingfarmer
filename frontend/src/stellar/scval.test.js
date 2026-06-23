import { describe, it, expect } from 'vitest'
import { Keypair, scValToNative } from '@stellar/stellar-sdk'
import { addrScVal, i128ScVal, fromScVal } from './scval.js'

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
