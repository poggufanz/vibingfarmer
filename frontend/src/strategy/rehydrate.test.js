// frontend/src/strategy/rehydrate.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const hasValidGrantMock = vi.fn()
const loadGrantMock = vi.fn()
const initSessionMock = vi.fn()
vi.mock('./grantStore.js', () => ({ hasValidGrant: () => hasValidGrantMock(), loadGrant: () => loadGrantMock() }))
vi.mock('./session.js', () => ({ initSession: (...a) => initSessionMock(...a), hasSession: () => false }))

import { rehydrateSession } from './rehydrate.js'

describe('rehydrateSession', () => {
  beforeEach(() => { hasValidGrantMock.mockReset(); loadGrantMock.mockReset(); initSessionMock.mockReset() })

  it('boots the session and reports active when a valid grant exists', () => {
    hasValidGrantMock.mockReturnValue(true)
    loadGrantMock.mockReturnValue({ permissionContext: '0xctx', delegationManager: '0xdm', expiresAt: Date.now() + 1000 })
    const r = rehydrateSession()
    expect(initSessionMock).toHaveBeenCalledWith({ permissionContext: '0xctx', delegationManager: '0xdm' })
    expect(r).toEqual({ active: true, expiresAt: expect.any(Number), permissionContext: '0xctx' })
  })

  it('returns inactive when no valid grant', () => {
    hasValidGrantMock.mockReturnValue(false)
    const r = rehydrateSession()
    expect(initSessionMock).not.toHaveBeenCalled()
    expect(r).toEqual({ active: false })
  })
})
