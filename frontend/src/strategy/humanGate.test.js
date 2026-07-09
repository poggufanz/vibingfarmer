import { describe, it, expect, vi } from 'vitest'

// Models the PermissionCard contract: onConfirm => startExecution; onReject => never.
function wirePermission({ onConfirm, onReject }) {
  return { confirm: () => onConfirm(), decline: () => onReject() }
}

describe('human gate teeth', () => {
  it('decline never calls startExecution', () => {
    const startExecution = vi.fn()
    const goBack = vi.fn()
    const card = wirePermission({ onConfirm: startExecution, onReject: goBack })
    card.decline()
    expect(startExecution).not.toHaveBeenCalled()
    expect(goBack).toHaveBeenCalledTimes(1)
  })
  it('confirm calls startExecution exactly once', () => {
    const startExecution = vi.fn()
    const card = wirePermission({ onConfirm: startExecution, onReject: vi.fn() })
    card.confirm()
    expect(startExecution).toHaveBeenCalledTimes(1)
  })
})
