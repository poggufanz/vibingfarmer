import { describe, it, expect } from 'vitest'
import { pickConfirmIndices, checkConfirm } from './backupConfirm.js'

describe('backupConfirm', () => {
  it('picks n unique sorted indices in range', () => {
    let i = 0
    const rng = () => [0.01, 0.5, 0.99, 0.5][i++] // 3rd duplicate forces re-draw
    const idx = pickConfirmIndices(24, 3, rng)
    expect(idx).toHaveLength(3)
    expect(new Set(idx).size).toBe(3)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('accepts correct words (case/space-insensitive), rejects wrong', () => {
    const m = 'alpha bravo charlie delta echo foxtrot'
    expect(checkConfirm(m, [{ index: 1, word: 'Bravo' }, { index: 3, word: ' delta ' }])).toBe(true)
    expect(checkConfirm(m, [{ index: 1, word: 'wrong' }])).toBe(false)
  })
})
