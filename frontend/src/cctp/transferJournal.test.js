import { describe, expect, test } from 'vitest'
import {
  checkpointCctpTransfer,
  createCctpTransfer,
  listCctpTransfers,
  readCctpTransfer,
  removeCctpTransfer,
} from './transferJournal.js'

const OWNER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'
const OTHER_OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const REQUEST_ID = '11'.repeat(16)
const OTHER_REQUEST_ID = '12'.repeat(16)
const MANDATE_ID = '22'.repeat(16)
const JOB_ID = '33'.repeat(16)
const UNWIND_JOB_ID = '44'.repeat(16)
const BURN_TX_HASH = '66'.repeat(32)
const USER_OP_HASH = `0x${'77'.repeat(32)}`
const UNWIND_TX_HASH = `0x${'88'.repeat(32)}`
const KERNEL = `0x${'99'.repeat(20)}`
const BASE_TIME = 2_000_000_000_000
const PREFIX = 'vf.cctpTransfer.v1:'

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function makeStorage({ write } = {}) {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { write ? write(values, key, value) : values.set(key, value) },
    removeItem(key) { values.delete(key) },
    dump() { return [...values.entries()] },
  }
}

function forward({ owner = OWNER, requestId = REQUEST_ID, state = 'intent_creating', createdAtMs = BASE_TIME } = {}) {
  return {
    version: 1, direction: 'forward', owner, requestId, state,
    createdAtMs, updatedAtMs: createdAtMs, reasonCode: null, terminalFrom: null,
    transfer: {
      mandateId: MANDATE_ID, kernelAddress: KERNEL, bindingId: 'binding-v1',
      bindingHash: 'aa'.repeat(32),
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42', grantTxHash: 'bb'.repeat(32), burnUnits7: '90071992547409930',
      allocations: [{
        allocationId: 'run-42:bridge:aave-v3', executionId: 'run-42:exec:run-42:bridge:aave-v3',
        poolAddress: `0x${'ab'.repeat(20)}`,
        amount: { token: 'USDC', units: '9007199254740993', decimals: 6 }, minShares: '1',
      }],
      jobId: null, burnTxHash: null,
    },
  }
}

function reverse({ owner = OWNER, requestId = UNWIND_JOB_ID, state = 'userop_submitting', createdAtMs = BASE_TIME } = {}) {
  return {
    version: 1, direction: 'reverse', owner, requestId, state,
    createdAtMs, updatedAtMs: createdAtMs, reasonCode: null, terminalFrom: null,
    transfer: { jobId: requestId, kernelAddress: KERNEL, recipientHint: OWNER, userOpHash: null, unwindTxHash: null },
  }
}

function checkpoint(local, requestId, from, to, patch, now = BASE_TIME + 1) {
  return checkpointCctpTransfer({ owner: OWNER, requestId, from, to, ...(patch ? { patch } : {}) }, { storage: local, now: () => now })
}

function expectCode(fn, code) {
  try { fn() } catch (error) { expect(error.code).toBe(code); return }
  throw new Error(`expected ${code}`)
}

function key(owner, requestId) { return `${PREFIX}${owner.toLowerCase()}:${requestId}` }

describe('CCTP transfer journal v1', () => {
  test('round trips every legal forward state without losing an amount above 2^53', () => {
    const local = makeStorage(); createCctpTransfer(forward(), { storage: local })
    checkpoint(local, REQUEST_ID, 'intent_creating', 'intent_acked', { jobId: JOB_ID })
    checkpoint(local, REQUEST_ID, 'intent_acked', 'burn_submitting')
    checkpoint(local, REQUEST_ID, 'burn_submitting', 'burn_confirmed', { burnTxHash: BURN_TX_HASH })
    checkpoint(local, REQUEST_ID, 'burn_confirmed', 'attach_pending')
    checkpoint(local, REQUEST_ID, 'attach_pending', 'settling')
    checkpoint(local, REQUEST_ID, 'settling', 'done', { reasonCode: 'job_error' })

    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toEqual(expect.objectContaining({
      state: 'done', terminalFrom: 'settling',
      transfer: expect.objectContaining({ burnUnits7: '90071992547409930', jobId: JOB_ID, burnTxHash: BURN_TX_HASH }),
    }))
  })

  test('round trips every legal reverse state in hash order', () => {
    const local = makeStorage(); createCctpTransfer(reverse(), { storage: local })
    checkpoint(local, UNWIND_JOB_ID, 'userop_submitting', 'userop_submitted', { userOpHash: USER_OP_HASH })
    checkpoint(local, UNWIND_JOB_ID, 'userop_submitted', 'unwind_confirmed', { unwindTxHash: UNWIND_TX_HASH })
    checkpoint(local, UNWIND_JOB_ID, 'unwind_confirmed', 'relay_pending')
    checkpoint(local, UNWIND_JOB_ID, 'relay_pending', 'settling')
    checkpoint(local, UNWIND_JOB_ID, 'settling', 'done', { reasonCode: 'job_error' })

    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })).toMatchObject({
      state: 'done', terminalFrom: 'settling', transfer: { jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH },
    })
  })

  test('isolates every owner/request row while case-equivalent owner lookup resolves its canonical row', () => {
    const local = makeStorage()
    createCctpTransfer(forward(), { storage: local })
    createCctpTransfer(forward({ owner: OTHER_OWNER }), { storage: local })
    createCctpTransfer(forward({ requestId: OTHER_REQUEST_ID }), { storage: local })

    expect(local.dump().map(([name]) => name)).toEqual(expect.arrayContaining([
      key(OWNER, REQUEST_ID), key(OTHER_OWNER, REQUEST_ID), key(OWNER, OTHER_REQUEST_ID),
    ]))
    expect(readCctpTransfer({ owner: OWNER.toLowerCase(), requestId: REQUEST_ID }, { storage: local })?.owner).toBe(OWNER)
    expect(readCctpTransfer({ owner: OTHER_OWNER, requestId: OTHER_REQUEST_ID }, { storage: local })).toBeNull()
    expect(listCctpTransfers(OTHER_OWNER, { storage: local })).toHaveLength(1)
    removeCctpTransfer({ owner: OTHER_OWNER, requestId: REQUEST_ID }, { storage: local })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).not.toBeNull()
  })

  test.each([
    ['uppercase request ID', (record) => { record.requestId = 'AA'.repeat(16) }],
    ['prefixed request ID', (record) => { record.requestId = `0x${REQUEST_ID}` }],
    ['whitespace request ID', (record) => { record.requestId = ` ${REQUEST_ID}` }],
    ['noncanonical decimal amount', (record) => { record.transfer.allocations[0].amount.units = '01' }],
    ['zero allocation', (record) => { record.transfer.allocations[0].amount.units = '0' }],
    ['allocation sum mismatch', (record) => { record.transfer.burnUnits7 = '10000000' }],
    ['duplicate allocation ID', (record) => { record.transfer.allocations.push(clone(record.transfer.allocations[0])) }],
    ['wrong execution identity', (record) => { record.transfer.allocations[0].executionId = 'wrong' }],
    ['uppercase EVM address', (record) => { record.transfer.kernelAddress = KERNEL.toUpperCase() }],
    ['unsafe timestamp', (record) => { record.createdAtMs = Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s before it can become durable evidence', (_name, mutate) => {
    const local = makeStorage(); const candidate = forward(); mutate(candidate)
    expectCode(() => createCctpTransfer(candidate, { storage: local }), 'journal_invalid')
    expect(local.length).toBe(0)
  })

  test('rejects reverse identity/evidence contradictions before writing', () => {
    const local = makeStorage(); const mismatched = reverse(); mismatched.transfer.jobId = REQUEST_ID
    expectCode(() => createCctpTransfer(mismatched, { storage: local }), 'journal_invalid')
    const withoutUserOp = reverse(); withoutUserOp.transfer.unwindTxHash = UNWIND_TX_HASH
    expectCode(() => createCctpTransfer(withoutUserOp, { storage: local }), 'journal_invalid')
  })

  test.each([
    ['envelope', (record) => { record.serverPayload = 'innocuous-but-unapproved' }],
    ['transfer', (record) => { record.transfer.metadata = 'innocuous-but-unapproved' }],
    ['allocation', (record) => { record.transfer.allocations[0].extra = 'innocuous-but-unapproved' }],
    ['amount', (record) => { record.transfer.allocations[0].amount.note = 'innocuous-but-unapproved' }],
  ])('rejects unknown %s fields and preserves the original bytes', (_name, mutate) => {
    const local = makeStorage(); createCctpTransfer(forward(), { storage: local })
    const before = local.getItem(key(OWNER, REQUEST_ID)); const candidate = forward(); mutate(candidate)
    expectCode(() => createCctpTransfer(candidate, { storage: local }), 'journal_invalid')
    expect(local.getItem(key(OWNER, REQUEST_ID))).toBe(before)
  })

  test.each([
    ['top-level', (record) => { record.Authorization = 'Bearer TOP_SECRET' }],
    ['transfer', (record) => { record.transfer['private-key'] = 'PRIVATE_TRANSFER' }],
    ['allocation', (record) => { record.transfer.allocations[0].capability = 'CAP_ALLOCATION' }],
    ['nested error', (record) => { record.transfer.allocations[0].amount.fakeError = { signed_xdr: 'XDR_NESTED' } }],
    ['mixed session key', (record) => { record.transfer.sessionKeyAddress = 'SESSION_SECRET' }],
  ])('rejects recursive sensitive %s fields without leaking their sentinel', (_name, mutate) => {
    const local = makeStorage(); const candidate = forward(); mutate(candidate)
    expectCode(() => createCctpTransfer(candidate, { storage: local }), 'journal_invalid')
    expect(JSON.stringify(local.dump())).not.toMatch(/TOP_SECRET|PRIVATE_TRANSFER|CAP_ALLOCATION|XDR_NESTED|SESSION_SECRET/)
  })

  test.each([
    ['BigInt', (record) => { record.transfer.burnUnits7 = 1n }],
    ['function', (record) => { record.transfer.fn = () => {} }],
    ['typed secret buffer', (record) => { record.transfer.buffer = new Uint8Array([1, 2]) }],
    ['non-finite number', (record) => { record.createdAtMs = NaN }],
    ['class instance', (record) => { record.transfer.extra = new (class Secret {})() }],
  ])('rejects non-JSON %s before Storage.setItem', (_name, mutate) => {
    let writes = 0; const local = makeStorage({ write: () => { writes += 1 } }); const candidate = forward(); mutate(candidate)
    expectCode(() => createCctpTransfer(candidate, { storage: local }), 'journal_invalid')
    expect(writes).toBe(0)
  })

  test('rejects cycles and prototype pollution before any write', () => {
    let writes = 0; const local = makeStorage({ write: () => { writes += 1 } })
    const cycle = forward(); cycle.transfer.error = cycle
    expectCode(() => createCctpTransfer(cycle, { storage: local }), 'journal_invalid')
    const polluted = forward(); Object.setPrototypeOf(polluted.transfer, { capability: 'prototype-secret' })
    expectCode(() => createCctpTransfer(polluted, { storage: local }), 'journal_invalid')
    expect(writes).toBe(0)
  })

  test('enforces compare-and-swap, evidence order, and immutable known hashes without changing bytes', () => {
    const local = makeStorage(); createCctpTransfer(forward(), { storage: local })
    const before = local.getItem(key(OWNER, REQUEST_ID))
    expectCode(() => checkpoint(local, REQUEST_ID, 'intent_acked', 'burn_submitting'), 'journal_conflict')
    expectCode(() => checkpoint(local, REQUEST_ID, 'intent_creating', 'burn_confirmed', { burnTxHash: BURN_TX_HASH }), 'journal_conflict')
    expect(local.getItem(key(OWNER, REQUEST_ID))).toBe(before)

    checkpoint(local, REQUEST_ID, 'intent_creating', 'intent_acked', { jobId: JOB_ID })
    checkpoint(local, REQUEST_ID, 'intent_acked', 'burn_submitting')
    checkpoint(local, REQUEST_ID, 'burn_submitting', 'burn_confirmed', { burnTxHash: BURN_TX_HASH })
    const confirmed = local.getItem(key(OWNER, REQUEST_ID))
    expectCode(() => checkpoint(local, REQUEST_ID, 'burn_confirmed', 'attach_pending', { burnTxHash: '67'.repeat(32) }), 'journal_conflict')
    expect(local.getItem(key(OWNER, REQUEST_ID))).toBe(confirmed)
  })

  test('accepts an exact lost-response checkpoint replay without changing timestamps', () => {
    const local = makeStorage(); createCctpTransfer(forward(), { storage: local })
    checkpoint(local, REQUEST_ID, 'intent_creating', 'intent_acked', { jobId: JOB_ID }, BASE_TIME + 1)
    const once = readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })
    const twice = checkpoint(local, REQUEST_ID, 'intent_creating', 'intent_acked', { jobId: JOB_ID }, BASE_TIME + 999)
    expect(twice).toEqual(once)
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.updatedAtMs).toBe(BASE_TIME + 1)
  })

  test.each([
    ['throw', (_values, _key, _body) => { throw new Error('quota') }],
    ['silent no-op', () => {}],
    ['truncated write', (values, name, body) => values.set(name, body.slice(0, -2))],
    ['different value', (values, name) => values.set(name, '{}')],
  ])('fails closed when Storage performs a %s write and does not cross a following side-effect boundary', (_name, write) => {
    const local = makeStorage({ write }); const trace = []
    expectCode(() => { createCctpTransfer(forward(), { storage: local }); trace.push('external-side-effect') }, 'journal_unavailable')
    expect(trace).toEqual([])
  })

  test.each([
    ['malformed JSON', () => '{bad json'],
    ['wrong version', () => JSON.stringify({ ...forward(), version: 2 })],
    ['wrong direction', () => JSON.stringify({ ...forward(), direction: 'sideways' })],
    ['foreign owner inside matching key', () => JSON.stringify({ ...forward(), owner: OTHER_OWNER })],
    ['key/request mismatch', () => JSON.stringify({ ...forward(), requestId: OTHER_REQUEST_ID })],
    ['sensitive injected field', () => JSON.stringify({ ...forward(), transfer: { ...forward().transfer, cookie: 'DO-NOT-KEEP' } })],
    ['state/evidence mismatch', () => JSON.stringify({ ...forward(), state: 'burn_confirmed', transfer: { ...forward().transfer, jobId: JOB_ID } })],
  ])('quarantines a %s row without hiding a valid sibling', (_name, corrupt) => {
    const local = makeStorage(); createCctpTransfer(forward(), { storage: local }); createCctpTransfer(forward({ requestId: OTHER_REQUEST_ID }), { storage: local })
    local.setItem(key(OWNER, REQUEST_ID), corrupt())
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toBeNull()
    expect(readCctpTransfer({ owner: OWNER, requestId: OTHER_REQUEST_ID }, { storage: local })?.requestId).toBe(OTHER_REQUEST_ID)
    expect(local.getItem(key(OWNER, REQUEST_ID))).toBeNull()
  })

  test('lists rows deterministically, bounded, owner-scoped, and despite a corrupt sibling', () => {
    const local = makeStorage()
    createCctpTransfer(forward({ requestId: OTHER_REQUEST_ID, createdAtMs: BASE_TIME }), { storage: local })
    createCctpTransfer(forward({ requestId: REQUEST_ID, createdAtMs: BASE_TIME }), { storage: local })
    createCctpTransfer(forward({ owner: OTHER_OWNER, createdAtMs: 1 }), { storage: local })
    local.setItem(key(OWNER, '13'.repeat(16)), '{corrupt')
    expect(listCctpTransfers(OWNER, { storage: local, limit: 1 }).map((record) => record.requestId)).toEqual([REQUEST_ID])
    expect(listCctpTransfers(OWNER, { storage: local, limit: 20 }).map((record) => record.requestId)).toEqual([REQUEST_ID, OTHER_REQUEST_ID])
  })

  test.each(['done', 'error', 'uncertain', 'blocked'])('keeps %s terminal evidence immutable except for its exact replay', (terminal) => {
    const local = makeStorage(); createCctpTransfer(forward(), { storage: local })
    checkpoint(local, REQUEST_ID, 'intent_creating', terminal, { reasonCode: 'job_error' })
    const saved = readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })
    expect(checkpoint(local, REQUEST_ID, terminal, terminal)).toEqual(saved)
    expectCode(() => checkpoint(local, REQUEST_ID, terminal, 'settling'), 'journal_conflict')
    expectCode(() => checkpoint(local, REQUEST_ID, terminal, terminal, { reasonCode: 'job_blocked' }), 'journal_conflict')
  })
})
