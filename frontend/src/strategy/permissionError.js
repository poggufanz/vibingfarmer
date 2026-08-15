// frontend/src/strategy/permissionError.js
// Strategy Task 7 (Pocket Crew redesign, Wave 1). The ONLY pre-movement rejection type for the
// permission-locked dispatch path (orchestrator.js): thrown before any wallet/provider call and
// before any worker/pull/deposit movement, for every way a reviewed permission decision can fail
// to hold — a stale preflight (`phase:'preflight'`), a fresh grant that never confirmed
// (`phase:'fresh-grant'`), or reuse evidence that moved since it was reviewed
// (`phase:'reuse-revalidation'`). `movement` is always `'none'` — this error type exists
// precisely because nothing moved.
export class PermissionPhaseError extends Error {
  constructor({ phase, code, message, cause }) {
    super(message, { cause })
    this.name = 'PermissionPhaseError'
    this.phase = phase // 'preflight' | 'fresh-grant' | 'reuse-revalidation'
    this.code = code
    this.movement = 'none'
  }
}
