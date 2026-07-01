import { describe, it, expect } from 'vitest'
import { classifyImport } from './importValidate.js'

describe('classifyImport', () => {
  it('detects a valid secret key', () => {
    expect(classifyImport('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN').kind).toBe('secret')
  })
  it('detects a valid mnemonic', () => {
    expect(classifyImport('illness spike retreat truth genius clock brain pass fit cave bargain toe').kind).toBe('mnemonic')
  })
  it('reports checksum failure for a wrong 12-word phrase', () => {
    const r = classifyImport('illness spike retreat truth genius clock brain pass fit cave bargain zoo')
    expect(r.kind).toBe('invalid')
    expect(r.error).toMatch(/checksum/i)
  })
})
