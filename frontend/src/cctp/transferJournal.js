// Durable, public CCTP recovery evidence.  This module intentionally has no wallet, signer,
// receipt, capability, or network imports: it is a fence in front of irreversible actions.
const PREFIX = 'vf.cctpTransfer.v1:'
const ID = /^[0-9a-f]{32}$/
const HASH = /^[0-9a-f]{64}$/
const EVM_HASH = /^0x[0-9a-f]{64}$/
const EVM = /^0x[0-9a-f]{40}$/
const STRKEY = /^[CG][A-Z2-7]{55}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const TERMINAL = new Set(['done', 'error', 'uncertain', 'blocked'])
const FORWARD = [
  'intent_creating',
  'intent_acked',
  'burn_submitting',
  'burn_confirmed',
  'attach_pending',
  'settling',
]
const REVERSE = [
  'userop_submitting',
  'userop_submitted',
  'unwind_confirmed',
  'relay_pending',
  'settling',
]
const REASONS = new Set([
  'intent_unavailable',
  'authorization_unavailable',
  'burn_submission_unknown',
  'burn_checkpoint_failed',
  'attach_unavailable',
  'status_unavailable',
  'userop_submission_unknown',
  'userop_checkpoint_failed',
  'receipt_pending',
  'receipt_reverted',
  'receipt_evidence_unverified',
  'unwind_attach_unavailable',
  'job_error',
  'job_uncertain',
  'job_blocked',
  'journal_invalid',
  'journal_unavailable',
])
const SENSITIVE =
  /secret|privatekey|capability|bearer|authorization|cookie|wallet|passkey|signedxdr|serializedapproval|approval|sessionmaterial|bridgematerial/i

const own = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((key) => keys.includes(key))
const fail = (message = 'journal_invalid') => {
  const error = new Error(message)
  error.code = message
  throw error
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const isSafeTime = (value) => Number.isSafeInteger(value) && value >= 0
const opaque = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  /^[\x21-\x7e]+$/.test(value) &&
  !/[/?#&=]/.test(value)
const ownerKey = (owner) => (typeof owner === 'string' ? owner.toLowerCase() : '')
const validOwner = (owner) => typeof owner === 'string' && STRKEY.test(owner.toUpperCase())
const keyFor = (owner, requestId) => `${PREFIX}${ownerKey(owner)}:${requestId}`

function rejectUnsafe(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail()
    return
  }
  if (
    typeof value !== 'object' ||
    value instanceof Date ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  )
    fail()
  if (seen.has(value)) fail()
  seen.add(value)
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) fail()
  for (const key of Object.keys(value)) {
    if (SENSITIVE.test(key.replace(/[^a-z0-9]/gi, ''))) fail()
    rejectUnsafe(value[key], seen)
  }
  seen.delete(value)
}

function validAmount(amount) {
  return (
    own(amount, ['token', 'units', 'decimals']) &&
    amount.token === 'USDC' &&
    DECIMAL.test(amount.units) &&
    BigInt(amount.units) > 0n &&
    amount.decimals === 6
  )
}
function validForwardTransfer(t) {
  const fields = [
    'mandateId',
    'kernelAddress',
    'bindingId',
    'bindingHash',
    'bridgeAgent',
    'runId',
    'grantTxHash',
    'burnUnits7',
    'allocations',
    'jobId',
    'burnTxHash',
  ]
  if (
    !own(t, fields) ||
    !ID.test(t.mandateId) ||
    !EVM.test(t.kernelAddress) ||
    !opaque(t.bindingId) ||
    !HASH.test(t.bindingHash) ||
    !STRKEY.test(t.bridgeAgent) ||
    !opaque(t.runId) ||
    !HASH.test(t.grantTxHash) ||
    !DECIMAL.test(t.burnUnits7) ||
    BigInt(t.burnUnits7) <= 0n ||
    BigInt(t.burnUnits7) % 10n !== 0n ||
    !Array.isArray(t.allocations) ||
    !t.allocations.length ||
    !(t.jobId === null || ID.test(t.jobId)) ||
    !(t.burnTxHash === null || HASH.test(t.burnTxHash))
  )
    return false
  const ids = new Set()
  let sum = 0n
  for (const a of t.allocations) {
    if (
      !own(a, ['allocationId', 'executionId', 'poolAddress', 'amount', 'minShares']) ||
      !opaque(a.allocationId) ||
      !opaque(a.executionId) ||
      a.executionId !== `${t.runId}:exec:${a.allocationId}` ||
      !EVM.test(a.poolAddress) ||
      a.poolAddress !== a.poolAddress.toLowerCase() ||
      !validAmount(a.amount) ||
      !DECIMAL.test(a.minShares) ||
      !ids.add(a.allocationId)
    )
      return false
    sum += BigInt(a.amount.units)
  }
  return sum * 10n === BigInt(t.burnUnits7) && (t.burnTxHash === null || t.jobId !== null)
}
function validReverseTransfer(t, requestId) {
  return (
    own(t, ['jobId', 'kernelAddress', 'recipientHint', 'userOpHash', 'unwindTxHash']) &&
    t.jobId === requestId &&
    ID.test(t.jobId) &&
    EVM.test(t.kernelAddress) &&
    STRKEY.test(t.recipientHint) &&
    (t.userOpHash === null || EVM_HASH.test(t.userOpHash)) &&
    (t.unwindTxHash === null || EVM_HASH.test(t.unwindTxHash)) &&
    (t.unwindTxHash === null || t.userOpHash !== null)
  )
}
function hasEvidence(record) {
  const t = record.transfer
  if (record.direction === 'forward') {
    if (
      ['intent_acked', 'burn_submitting', 'burn_confirmed', 'attach_pending', 'settling'].includes(
        record.state
      ) &&
      !t.jobId
    )
      return false
    if (['burn_confirmed', 'attach_pending', 'settling'].includes(record.state) && !t.burnTxHash)
      return false
  } else {
    if (
      ['userop_submitted', 'unwind_confirmed', 'relay_pending', 'settling'].includes(
        record.state
      ) &&
      !t.userOpHash
    )
      return false
    if (['unwind_confirmed', 'relay_pending', 'settling'].includes(record.state) && !t.unwindTxHash)
      return false
  }
  return true
}
function validate(record) {
  try {
    rejectUnsafe(record)
    const keys = [
      'version',
      'direction',
      'owner',
      'requestId',
      'state',
      'createdAtMs',
      'updatedAtMs',
      'reasonCode',
      'terminalFrom',
      'transfer',
    ]
    if (
      !own(record, keys) ||
      record.version !== 1 ||
      !['forward', 'reverse'].includes(record.direction) ||
      !STRKEY.test(record.owner) ||
      !ID.test(record.requestId) ||
      !isSafeTime(record.createdAtMs) ||
      !isSafeTime(record.updatedAtMs) ||
      record.updatedAtMs < record.createdAtMs
    )
      return false
    const states = record.direction === 'forward' ? FORWARD : REVERSE
    const terminal = TERMINAL.has(record.state)
    if (
      !(states.includes(record.state) || terminal) ||
      (terminal
        ? !REASONS.has(record.reasonCode) || !states.includes(record.terminalFrom)
        : record.reasonCode !== null || record.terminalFrom !== null)
    )
      return false
    return (
      (record.direction === 'forward'
        ? validForwardTransfer(record.transfer)
        : validReverseTransfer(record.transfer, record.requestId)) && hasEvidence(record)
    )
  } catch {
    return false
  }
}
function storageOf(storage) {
  const selected = storage || globalThis.localStorage
  if (!selected || typeof selected.getItem !== 'function' || typeof selected.setItem !== 'function')
    fail('journal_unavailable')
  return selected
}
function write(storage, key, record) {
  const body = JSON.stringify(record)
  try {
    storage.setItem(key, body)
    const read = storage.getItem(key)
    if (read !== body || !validate(JSON.parse(read))) throw new Error('read-back')
  } catch {
    fail('journal_unavailable')
  }
  return clone(record)
}
function rawRead({ owner, requestId }, { storage, quarantine = true } = {}) {
  if (!validOwner(owner) || !ID.test(requestId)) return null
  let raw
  const selected = storageOf(storage)
  const key = keyFor(owner, requestId)
  try {
    raw = selected.getItem(key)
  } catch {
    fail('journal_unavailable')
  }
  if (raw === null) return null
  try {
    const record = JSON.parse(raw)
    if (
      !validate(record) ||
      ownerKey(record.owner) !== ownerKey(owner) ||
      record.requestId !== requestId
    )
      throw new Error('invalid')
    return record
  } catch {
    if (quarantine) {
      try {
        selected.removeItem(key)
      } catch {}
    }
    return null
  }
}

export function createCctpTransfer(record, options = {}) {
  if (!validate(record)) fail()
  const storage = storageOf(options.storage)
  const key = keyFor(record.owner, record.requestId)
  const existing = rawRead({ owner: record.owner, requestId: record.requestId }, { storage })
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(record)) return clone(existing)
    fail('journal_conflict')
  }
  return write(storage, key, clone(record))
}
export function readCctpTransfer(identity, options = {}) {
  const record = rawRead(identity, options)
  return record ? clone(record) : null
}
export function checkpointCctpTransfer({ owner, requestId, from, to, patch = {} }, options = {}) {
  const storage = storageOf(options.storage)
  const current = rawRead({ owner, requestId }, { storage })
  if (!current) fail('journal_conflict')
  rejectUnsafe(patch)
  // A response can be lost after the durable write. Replaying that exact prior transition is a
  // read-only acknowledgement, never a timestamp-changing second mutation.
  if (current.state === to && from !== to) {
    const matches = Object.entries(patch).every(([field, value]) =>
      field === 'reasonCode' ? current.reasonCode === value : current.transfer[field] === value
    )
    if (matches) return clone(current)
    fail('journal_conflict')
  }
  if (current.state !== from) fail('journal_conflict')
  const states = current.direction === 'forward' ? FORWARD : REVERSE
  const exact = from === to && JSON.stringify(patch) === '{}'
  if (exact) return clone(current)
  const terminal = TERMINAL.has(to)
  const nextIndex = states.indexOf(to),
    currentIndex = states.indexOf(from)
  if ((!terminal && nextIndex !== currentIndex + 1) || (terminal && !states.includes(from)))
    fail('journal_conflict')
  const allowed =
    current.direction === 'forward' ? ['jobId', 'burnTxHash'] : ['userOpHash', 'unwindTxHash']
  const terminalFields = ['reasonCode']
  if (
    !own(patch, terminal ? terminalFields : allowed.filter((field) => Object.hasOwn(patch, field)))
  )
    fail()
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'reasonCode') continue
    if (current.transfer[field] !== null && current.transfer[field] !== value)
      fail('journal_conflict')
  }
  const next = clone(current)
  next.state = to
  next.updatedAtMs = Math.max(current.updatedAtMs, options.now ? options.now() : Date.now())
  Object.assign(
    next.transfer,
    Object.fromEntries(Object.entries(patch).filter(([field]) => field !== 'reasonCode'))
  )
  if (terminal) {
    next.reasonCode = patch.reasonCode
    next.terminalFrom = from
  }
  if (!validate(next)) fail('journal_conflict')
  return write(storage, keyFor(owner, requestId), next)
}
export function listCctpTransfers(owner, { storage, limit = 20 } = {}) {
  if (!validOwner(owner) || !Number.isSafeInteger(limit) || limit < 0) fail()
  const selected = storageOf(storage)
  const prefix = `${PREFIX}${ownerKey(owner)}:`
  const found = []
  const keys = Array.from({ length: selected.length }, (_, i) => selected.key(i))
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue
    const requestId = key.slice(prefix.length)
    const record = rawRead({ owner, requestId }, { storage: selected })
    if (record) found.push(record)
  }
  return found
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.requestId.localeCompare(b.requestId))
    .slice(0, limit)
    .map(clone)
}
export function removeCctpTransfer({ owner, requestId }, { storage } = {}) {
  if (!validOwner(owner) || !ID.test(requestId)) fail()
  try {
    storageOf(storage).removeItem(keyFor(owner, requestId))
  } catch {
    fail('journal_unavailable')
  }
}
