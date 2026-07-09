import { describe, it, expect } from 'vitest'
import { onRequest } from './stellar-relay.js'

describe('stellar-relay pages function', () => {
  it('exports an onRequest handler', () => {
    expect(typeof onRequest).toBe('function')
  })
})
