// frontend/src/strategy/gasSnapshot.test.js
import { describe, it, expect } from 'vitest'
import { fetchGasSnapshot } from './gasSnapshot.js'

describe('fetchGasSnapshot (relayer-sponsored)', () => {
  it('reports a sponsored, zero-gas, normal snapshot with no on-chain read', async () => {
    const snap = await fetchGasSnapshot()
    expect(snap).toEqual({ gwei: 0, level: 'normal', sponsored: true })
  })

  it('keeps the { gwei, level } shape the DAG gas node + deriveSignals consume', async () => {
    const snap = await fetchGasSnapshot()
    expect(typeof snap.gwei).toBe('number')
    expect(['normal', 'elevated', 'high']).toContain(snap.level)
  })
})
