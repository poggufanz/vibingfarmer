import { describe, it, expect } from 'vitest'
import { PermissionPhaseError } from './permissionError.js'

describe('PermissionPhaseError', () => {
  it('carries phase, code, and a fixed movement of none', () => {
    const err = new PermissionPhaseError({
      phase: 'fresh-grant',
      code: 'VF_GRANT_SUBMIT_FAILED',
      message: 'The grant relay returned FAILED.',
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PermissionPhaseError')
    expect(err.phase).toBe('fresh-grant')
    expect(err.code).toBe('VF_GRANT_SUBMIT_FAILED')
    expect(err.movement).toBe('none')
    expect(err.message).toBe('The grant relay returned FAILED.')
  })

  it('accepts every documented phase value', () => {
    for (const phase of ['preflight', 'fresh-grant', 'reuse-revalidation']) {
      const err = new PermissionPhaseError({ phase, code: 'X', message: 'm' })
      expect(err.phase).toBe(phase)
      expect(err.movement).toBe('none')
    }
  })

  it('preserves an underlying cause without leaking it into the message', () => {
    const cause = new Error('relay 502')
    const err = new PermissionPhaseError({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      message: 'Reuse evidence changed since it was reviewed.',
      cause,
    })
    expect(err.cause).toBe(cause)
    expect(err.message).toBe('Reuse evidence changed since it was reviewed.')
  })
})
