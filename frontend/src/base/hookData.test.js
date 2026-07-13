// frontend/src/base/hookData.test.js
import { describe, test, expect } from 'vitest'
import { buildForwarderHookData, assertHookData } from './hookData.js'

describe('buildForwarderHookData', () => {
  test('produces the exact layout: [zero x24][version=0 u32][strkey-length u32][strkey UTF-8]', () => {
    const strkey = 'GCXMZOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'
    const hookData = buildForwarderHookData(strkey)
    expect(hookData.length).toBe(32 + strkey.length)
    expect(Buffer.from(hookData.slice(0, 24)).every((b) => b === 0)).toBe(true)
    const version = Buffer.from(hookData.slice(24, 28)).readUInt32BE(0)
    expect(version).toBe(0)
    const len = Buffer.from(hookData.slice(28, 32)).readUInt32BE(0)
    expect(len).toBe(strkey.length)
    expect(Buffer.from(hookData.slice(32)).toString('utf8')).toBe(strkey)
  })
})

describe('assertHookData - the #7313 guard', () => {
  test('accepts a well-formed hookData buffer', () => {
    const hookData = buildForwarderHookData(
      'GCXMZOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'
    )
    expect(() => assertHookData(hookData)).not.toThrow()
  })

  test('rejects a raw 32-byte buffer (the exact SP0 #7313 mistake - a decoded key with no hook envelope)', () => {
    const raw32 = new Uint8Array(32)
    // A raw 32-byte decoded key has version 0 and a zero declared length, so it fails at the
    // strkey/envelope check rather than the version check — either way it must be rejected.
    expect(() => assertHookData(raw32)).toThrow(
      /InvalidHookVersion|too short|version|strkey|decode/
    )
  })

  test('rejects a non-zero version byte', () => {
    const hookData = buildForwarderHookData(
      'GCXMZOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'
    )
    const corrupted = Buffer.from(hookData)
    corrupted.writeUInt32BE(1, 24) // flip version to 1
    expect(() => assertHookData(corrupted)).toThrow(/version/)
  })

  test('rejects a declared strkey length that does not match the remaining bytes', () => {
    const hookData = buildForwarderHookData(
      'GCXMZOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'
    )
    const corrupted = Buffer.from(hookData)
    corrupted.writeUInt32BE(999, 28) // lie about the length
    expect(() => assertHookData(corrupted)).toThrow(/length/)
  })

  test('rejects a strkey payload that does not decode as a Stellar address', () => {
    const bogus = Buffer.alloc(32 + 4)
    bogus.writeUInt32BE(0, 24)
    bogus.writeUInt32BE(4, 28)
    bogus.write('nope', 32, 'utf8')
    expect(() => assertHookData(bogus)).toThrow(/decode|strkey/)
  })
})
