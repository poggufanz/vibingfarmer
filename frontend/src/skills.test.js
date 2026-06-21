import { describe, it, expect } from 'vitest'
import { buildSkill, DEPOSITOR_TARGET } from './skills.js'

describe('skill generator single fund path', () => {
  it('generated skill only targets the vault', () => {
    const skill = buildSkill({ vault: DEPOSITOR_TARGET, token: 'CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4', amount: '100000000' })
    const targets = skill.steps.map((s) => s.target)
    expect(new Set(targets)).toEqual(new Set([DEPOSITOR_TARGET]))
  })

  it('throws if a caller tries to pass a worker target', () => {
    expect(() => buildSkill({ vault: DEPOSITOR_TARGET, token: 'CAJSGONIIU4QPLNIVVOO7QCYC2LWGYMGXTD7BXSSNIQWWDHWFQTSAEB4', amount: '1', worker: 'CD3MQJ4YZQ5MDSKDETEFZMDV5J5URVXM46NY5Y3RICUOVJJOFIZTKJ7K' })).toThrow()
  })

  it('exports a valid Stellar contract target (no placeholder leaked to runtime)', () => {
    expect(DEPOSITOR_TARGET).toMatch(/^C[A-Z2-7]{55}$/)
  })
})
