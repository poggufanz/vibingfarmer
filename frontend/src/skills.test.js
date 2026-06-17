import { describe, it, expect } from 'vitest'
import { buildSkill, DEPOSITOR_TARGET } from './skills.js'

describe('skill generator single fund path', () => {
  it('generated skill only targets the depositor', () => {
    const skill = buildSkill({ vault: '0x' + 'a1'.repeat(20), token: '0x' + 'b2'.repeat(20), amount: '100000000' })
    const targets = skill.steps.map((s) => s.target.toLowerCase())
    expect(new Set(targets)).toEqual(new Set([DEPOSITOR_TARGET.toLowerCase()]))
  })

  it('throws if a caller tries to pass a worker target', () => {
    expect(() => buildSkill({ vault: '0x' + 'a1'.repeat(20), token: '0x' + 'b2'.repeat(20), amount: '1', worker: '0x' + 'cc'.repeat(20) })).toThrow()
  })

  it('exports a valid 20-byte depositor target (no placeholder leaked to runtime)', () => {
    expect(DEPOSITOR_TARGET).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})
