import { describe, expect, test, vi } from 'vitest'
import { checkpointCctpTransfer, createCctpTransfer, readCctpTransfer } from './transferJournal.js'
import { resumePendingCctpTransfers } from './resumeTransfers.js'
import { postFarm } from '../base/relayerClient.js'

const OWNER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'
const REQUEST_ID = '11'.repeat(16)
const OTHER_REQUEST_ID = '12'.repeat(16)
const MANDATE_ID = '22'.repeat(16)
const JOB_ID = '33'.repeat(16)
const UNWIND_JOB_ID = '44'.repeat(16)
const BURN_TX_HASH = '66'.repeat(32)
const USER_OP_HASH = `0x${'77'.repeat(32)}`
const OTHER_USER_OP_HASH = `0x${'78'.repeat(32)}`
const UNWIND_TX_HASH = `0x${'88'.repeat(32)}`
const KERNEL = `0x${'99'.repeat(20)}`
const BASE_TIME = 2_000_000_000_000

function storage() {
  const values = new Map()
  return { get length() { return values.size }, key: (i) => [...values.keys()][i] ?? null, getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) }
}
function forward({ requestId = REQUEST_ID, state = 'intent_creating' } = {}) {
  return { version: 1, direction: 'forward', owner: OWNER, requestId, state, createdAtMs: BASE_TIME, updatedAtMs: BASE_TIME, reasonCode: null, terminalFrom: null, transfer: { mandateId: MANDATE_ID, kernelAddress: KERNEL, bindingId: 'binding-v1', bindingHash: 'aa'.repeat(32), bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ', runId: 'run-42', grantTxHash: 'bb'.repeat(32), burnUnits7: '10000000', allocations: [{ allocationId: 'run-42:bridge:aave-v3', executionId: 'run-42:exec:run-42:bridge:aave-v3', poolAddress: `0x${'ab'.repeat(20)}`, amount: { token: 'USDC', units: '1000000', decimals: 6 }, minShares: '900000' }], jobId: null, burnTxHash: null } }
}
function reverse({ requestId = UNWIND_JOB_ID, state = 'userop_submitting', userOpHash = null, unwindTxHash = null } = {}) {
  return { version: 1, direction: 'reverse', owner: OWNER, requestId, state, createdAtMs: BASE_TIME, updatedAtMs: BASE_TIME, reasonCode: null, terminalFrom: null, transfer: { jobId: requestId, kernelAddress: KERNEL, recipientHint: OWNER, userOpHash, unwindTxHash } }
}
function writeForward(local, state) {
  createCctpTransfer(forward(), { storage: local })
  if (state === 'intent_creating') return
  checkpointCctpTransfer({ owner: OWNER, requestId: REQUEST_ID, from: 'intent_creating', to: 'intent_acked', patch: { jobId: JOB_ID } }, { storage: local })
  if (state === 'intent_acked') return
  checkpointCctpTransfer({ owner: OWNER, requestId: REQUEST_ID, from: 'intent_acked', to: 'burn_submitting' }, { storage: local })
  if (state === 'burn_submitting') return
  checkpointCctpTransfer({ owner: OWNER, requestId: REQUEST_ID, from: 'burn_submitting', to: 'burn_confirmed', patch: { burnTxHash: BURN_TX_HASH } }, { storage: local })
  if (state === 'burn_confirmed') return
  checkpointCctpTransfer({ owner: OWNER, requestId: REQUEST_ID, from: 'burn_confirmed', to: 'attach_pending' }, { storage: local })
  if (state === 'attach_pending') return
  checkpointCctpTransfer({ owner: OWNER, requestId: REQUEST_ID, from: 'attach_pending', to: 'settling' }, { storage: local })
}
function writeReverse(local, state, { requestId = UNWIND_JOB_ID, userOpHash = USER_OP_HASH } = {}) {
  createCctpTransfer(reverse({ requestId }), { storage: local })
  if (state === 'userop_submitting') return
  checkpointCctpTransfer({ owner: OWNER, requestId, from: 'userop_submitting', to: 'userop_submitted', patch: { userOpHash } }, { storage: local })
  if (state === 'userop_submitted') return
  checkpointCctpTransfer({ owner: OWNER, requestId, from: 'userop_submitted', to: 'unwind_confirmed', patch: { unwindTxHash: UNWIND_TX_HASH } }, { storage: local })
  if (state === 'unwind_confirmed') return
  checkpointCctpTransfer({ owner: OWNER, requestId, from: 'unwind_confirmed', to: 'relay_pending' }, { storage: local })
  if (state === 'relay_pending') return
  checkpointCctpTransfer({ owner: OWNER, requestId, from: 'relay_pending', to: 'settling' }, { storage: local })
}
function traps() {
  const trap = vi.fn(() => { throw new Error('money-moving seam touched') })
  return { sign: trap, pull: trap, burn: trap, approve: trap, wallet: trap, sendUserOperation: trap, signAndSubmitUnwind: trap, trap }
}
function intentAck(requestId) {
  return { acknowledged: true, schemaVersion: 1, jobId: JOB_ID, echoedRequestId: requestId }
}

describe('CCTP reload resume', () => {
  test('replays intent with its exact persisted body, saves the acknowledged job, and never touches a money-moving seam', async () => {
    const local = storage(); writeForward(local, 'intent_creating'); const { trap, ...unsafe } = traps()
    const postFarmIntent = vi.fn(async (body) => ({ acknowledged: true, schemaVersion: 1, jobId: JOB_ID, echoedRequestId: body.requestId }))
    const result = await resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent, ...unsafe })
    expect(postFarmIntent).toHaveBeenCalledWith({ requestId: REQUEST_ID, sourceDomain: 27, mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL, bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ', runId: 'run-42', grantTxHash: 'bb'.repeat(32), allocations: forward().transfer.allocations })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toMatchObject({ state: 'intent_acked', transfer: { jobId: JOB_ID } })
    expect(result.resumed).toEqual([REQUEST_ID]); expect(trap).not.toHaveBeenCalled()
  })

  test('replays a persisted canonical wire allocation through the production postFarm contract without legacy allocation conversion', async () => {
    const local = storage(); writeForward(local, 'intent_creating')
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ acknowledged: true, schemaVersion: 1, jobId: JOB_ID }) }))
    const postFarmIntent = (body) => postFarm({ ...body, deps: { fetchImpl } })

    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const wire = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(wire.allocations).toEqual(forward().transfer.allocations)
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toMatchObject({ state: 'intent_acked', transfer: { jobId: JOB_ID } })
  })

  test('keeps intent_creating retryable after a lost response and repeats the exact durable request on the next resume', async () => {
    const local = storage(); writeForward(local, 'intent_creating'); const calls = []
    const postFarmIntent = vi.fn(async (body) => {
      calls.push(body)
      if (calls.length === 1) throw new Error('response lost after durable server commit')
      return intentAck(body.requestId)
    })

    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('intent_creating')
    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent })
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0])
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toMatchObject({ state: 'intent_acked', transfer: { jobId: JOB_ID } })
  })

  test('holds an acknowledged forward intent and never auto-burns, pulls, attaches, or regenerates intent', async () => {
    const local = storage(); writeForward(local, 'intent_acked'); const { trap, ...unsafe } = traps()
    const result = await resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent: trap, postFarmAttach: trap, ...unsafe })
    expect(result.held).toEqual([REQUEST_ID]); expect(trap).not.toHaveBeenCalled()
  })

  test('classifies an interrupted forward burn as uncertain locally without polling or guessing an attachment', async () => {
    const local = storage(); writeForward(local, 'burn_submitting'); const { trap, ...unsafe } = traps()
    const result = await resumePendingCctpTransfers(OWNER, { storage: local, postFarmAttach: trap, pollForwardStatus: trap, ...unsafe })
    expect(result.uncertain).toEqual([REQUEST_ID])
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toMatchObject({ state: 'uncertain', reasonCode: 'burn_submission_unknown', terminalFrom: 'burn_submitting' })
    expect(trap).not.toHaveBeenCalled()
  })

  test.each(['burn_confirmed', 'attach_pending'])('attaches the exact durable Stellar evidence from %s only after attach_pending is persisted', async (state) => {
    const local = storage(); writeForward(local, state); const { trap, ...unsafe } = traps()
    const postFarmAttach = vi.fn(async (body) => {
      expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('attach_pending')
      expect(body).toEqual({ mandateId: MANDATE_ID, jobId: JOB_ID, burnTxHash: BURN_TX_HASH }); return { jobId: JOB_ID }
    })
    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmAttach, ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('settling')
    expect(trap).not.toHaveBeenCalled()
  })

  test('keeps a forward attachment retryable after a lost response and repeats the exact stored hash safely', async () => {
    const local = storage(); writeForward(local, 'attach_pending'); const calls = []
    const postFarmAttach = vi.fn(async (body) => {
      calls.push(body)
      if (calls.length === 1) throw new Error('attach response lost')
      return { jobId: JOB_ID, burnTxHash: BURN_TX_HASH }
    })

    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmAttach })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('attach_pending')
    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmAttach })
    expect(calls).toEqual([
      { mandateId: MANDATE_ID, jobId: JOB_ID, burnTxHash: BURN_TX_HASH },
      { mandateId: MANDATE_ID, jobId: JOB_ID, burnTxHash: BURN_TX_HASH },
    ])
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('settling')
  })

  test.each(['done', 'error', 'uncertain', 'blocked'])('forward status %s terminalizes once and performs no further action', async (status) => {
    const local = storage(); writeForward(local, 'settling'); const { trap, ...unsafe } = traps()
    const pollForwardStatus = vi.fn(async () => ({ status, jobId: JOB_ID }))
    await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus, ...unsafe })
    expect(pollForwardStatus).toHaveBeenCalledTimes(1)
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe(status)
    expect(trap).not.toHaveBeenCalled()
  })

  test('keeps forward settling retryable after a transport error and repeats only the same authenticated status read', async () => {
    const local = storage(); writeForward(local, 'settling'); const calls = []
    const pollForwardStatus = vi.fn(async (body) => {
      calls.push(body)
      if (calls.length === 1) throw new Error('network response lost')
      return { status: 'settling', jobId: JOB_ID, burnTxHash: BURN_TX_HASH }
    })

    await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('settling')
    await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus })
    expect(calls).toEqual([{ mandateId: MANDATE_ID, jobId: JOB_ID }, { mandateId: MANDATE_ID, jobId: JOB_ID }])
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('settling')
  })

  test('blocks a forward identity mismatch rather than overwrite the job or call a chain seam', async () => {
    const local = storage(); writeForward(local, 'settling'); const { trap, ...unsafe } = traps()
    await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus: async () => ({ status: 'done', jobId: '34'.repeat(16) }), ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toMatchObject({ state: 'blocked', reasonCode: 'status_unavailable' })
    expect(trap).not.toHaveBeenCalled()
  })

  test('blocks a changed persisted burn identity in a forward status instead of treating a terminal response as evidence', async () => {
    const local = storage(); writeForward(local, 'settling'); const { trap, ...unsafe } = traps()
    await resumePendingCctpTransfers(OWNER, {
      storage: local,
      pollForwardStatus: async () => ({ status: 'done', jobId: JOB_ID, burnTxHash: '67'.repeat(32) }),
      ...unsafe,
    })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('blocked')
    expect(trap).not.toHaveBeenCalled()
  })

  test('never performs I/O or mutates timestamps for an already-terminal row', async () => {
    const local = storage(); writeForward(local, 'settling')
    checkpointCctpTransfer({ owner: OWNER, requestId: REQUEST_ID, from: 'settling', to: 'done', patch: { reasonCode: 'job_error' } }, { storage: local })
    const before = readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local }); const { trap, ...unsafe } = traps()
    await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus: trap, postFarmAttach: trap, ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })).toEqual(before); expect(trap).not.toHaveBeenCalled()
  })

  test('never performs I/O or mutates timestamps for a reverse terminal row', async () => {
    const local = storage(); writeReverse(local, 'settling')
    checkpointCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID, from: 'settling', to: 'blocked', patch: { reasonCode: 'job_blocked' } }, { storage: local })
    const before = readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local }); const { trap, ...unsafe } = traps()
    await resumePendingCctpTransfers(OWNER, { storage: local, pollUnwindStatus: trap, reconcileUnwindUserOp: trap, postUnwindAttach: trap, ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })).toEqual(before); expect(trap).not.toHaveBeenCalled()
  })

  test('classifies an interrupted UserOperation submission as uncertain without reading a receipt or sending again', async () => {
    const local = storage(); writeReverse(local, 'userop_submitting'); const { trap, ...unsafe } = traps()
    const result = await resumePendingCctpTransfers(OWNER, { storage: local, reconcileUnwindUserOp: trap, ...unsafe })
    expect(result.uncertain).toEqual([UNWIND_JOB_ID])
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })).toMatchObject({ state: 'uncertain', reasonCode: 'userop_submission_unknown' })
    expect(trap).not.toHaveBeenCalled()
  })

  test('reconciles only the exact stored UserOperation identity and holds pending evidence without attaching', async () => {
    const local = storage(); writeReverse(local, 'userop_submitted'); const { trap, ...unsafe } = traps()
    const reconcileUnwindUserOp = vi.fn(async (body) => { expect(body).toEqual({ jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, kernelAddress: KERNEL, recipientHint: OWNER }); return { status: 'pending' } })
    const result = await resumePendingCctpTransfers(OWNER, { storage: local, reconcileUnwindUserOp, postUnwindAttach: trap, ...unsafe })
    expect(result.held).toEqual([UNWIND_JOB_ID]); expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('userop_submitted'); expect(trap).not.toHaveBeenCalled()
  })

  test('persists strict reverse evidence before relaying the exact three-field attachment', async () => {
    const local = storage(); writeReverse(local, 'userop_submitted'); const { trap, ...unsafe } = traps()
    const reconcileUnwindUserOp = async () => ({ status: 'success', evidenceStatus: 'verified', userOpHash: USER_OP_HASH, kernelAddress: KERNEL, unwindTxHash: UNWIND_TX_HASH })
    const postUnwindAttach = vi.fn(async (body) => {
      expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })).toMatchObject({ state: 'relay_pending', transfer: { userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH } })
      expect(body).toEqual({ jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH }); return { jobId: UNWIND_JOB_ID }
    })
    await resumePendingCctpTransfers(OWNER, { storage: local, reconcileUnwindUserOp, postUnwindAttach, ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('settling'); expect(trap).not.toHaveBeenCalled()
  })

  test('keeps a reverse attachment retryable after a lost response and repeats exact durable UserOperation evidence', async () => {
    const local = storage(); writeReverse(local, 'relay_pending'); const calls = []
    const postUnwindAttach = vi.fn(async (body) => {
      calls.push(body)
      if (calls.length === 1) throw new Error('unwind attach response lost')
      return { jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH }
    })

    await resumePendingCctpTransfers(OWNER, { storage: local, postUnwindAttach })
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('relay_pending')
    await resumePendingCctpTransfers(OWNER, { storage: local, postUnwindAttach })
    expect(calls).toEqual([
      { jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH },
      { jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH },
    ])
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('settling')
  })

  test.each([
    ['needs reconcile', { evidenceStatus: 'needs_reconcile' }, 'userop_submitted'],
    ['reverted receipt', { status: 'reverted' }, 'error'],
    ['mismatched kernel', { status: 'success', evidenceStatus: 'verified', userOpHash: USER_OP_HASH, kernelAddress: `0x${'90'.repeat(20)}`, unwindTxHash: UNWIND_TX_HASH }, 'blocked'],
  ])('does not attach or send on reverse %s', async (_name, evidence, expectedState) => {
    const local = storage(); writeReverse(local, 'userop_submitted'); const { trap, ...unsafe } = traps()
    await resumePendingCctpTransfers(OWNER, { storage: local, reconcileUnwindUserOp: async () => evidence, postUnwindAttach: trap, ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe(expectedState); expect(trap).not.toHaveBeenCalled()
  })

  test.each(['unwind_confirmed', 'relay_pending'])('repeats only the exact reverse attachment from %s', async (state) => {
    const local = storage(); writeReverse(local, state); const { trap, ...unsafe } = traps()
    const postUnwindAttach = vi.fn(async (body) => { expect(body).toEqual({ jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH }); return { jobId: UNWIND_JOB_ID } })
    await resumePendingCctpTransfers(OWNER, { storage: local, postUnwindAttach, ...unsafe })
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('settling'); expect(trap).not.toHaveBeenCalled()
  })

  test.each(['done', 'error', 'uncertain', 'blocked'])('reverse status %s stops after one authenticated status read', async (status) => {
    const local = storage(); writeReverse(local, 'settling'); const { trap, ...unsafe } = traps()
    const pollUnwindStatus = vi.fn(async (body) => { expect(body).toEqual({ jobId: UNWIND_JOB_ID }); return { status, jobId: UNWIND_JOB_ID } })
    await resumePendingCctpTransfers(OWNER, { storage: local, pollUnwindStatus, ...unsafe })
    expect(pollUnwindStatus).toHaveBeenCalledTimes(1); expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe(status); expect(trap).not.toHaveBeenCalled()
  })

  test('keeps reverse settling retryable after a transport error and repeats only its stable job status read', async () => {
    const local = storage(); writeReverse(local, 'settling'); const calls = []
    const pollUnwindStatus = vi.fn(async (body) => {
      calls.push(body)
      if (calls.length === 1) throw new Error('reverse status response lost')
      return { status: 'settling', jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH }
    })

    await resumePendingCctpTransfers(OWNER, { storage: local, pollUnwindStatus })
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('settling')
    await resumePendingCctpTransfers(OWNER, { storage: local, pollUnwindStatus })
    expect(calls).toEqual([{ jobId: UNWIND_JOB_ID }, { jobId: UNWIND_JOB_ID }])
    expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('settling')
  })

  test.each([
    ['forward status job', 'forward', { status: 'done', jobId: '34'.repeat(16), burnTxHash: BURN_TX_HASH }],
    ['forward status burn hash', 'forward', { status: 'done', jobId: JOB_ID, burnTxHash: '67'.repeat(32) }],
    ['reverse status job', 'reverse', { status: 'done', jobId: '45'.repeat(16), userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH }],
    ['reverse status outer transaction hash', 'reverse', { status: 'done', jobId: UNWIND_JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: `0x${'89'.repeat(32)}` }],
  ])('blocks a wrong %s identity instead of accepting a terminal status', async (_name, direction, response) => {
    const local = storage()
    if (direction === 'forward') {
      writeForward(local, 'settling')
      await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus: async () => response })
      expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('blocked')
    } else {
      writeReverse(local, 'settling')
      await resumePendingCctpTransfers(OWNER, { storage: local, pollUnwindStatus: async () => response })
      expect(readCctpTransfer({ owner: OWNER, requestId: UNWIND_JOB_ID }, { storage: local })?.state).toBe('blocked')
    }
  })

  test('joins concurrent resumes for one row so an exact attach is never duplicated in-process', async () => {
    const local = storage(); writeForward(local, 'attach_pending'); let release
    const gate = new Promise((resolve) => { release = resolve })
    const postFarmAttach = vi.fn(async () => { await gate; return { jobId: JOB_ID } })
    const first = resumePendingCctpTransfers(OWNER, { storage: local, postFarmAttach })
    const second = resumePendingCctpTransfers(OWNER, { storage: local, postFarmAttach })
    await Promise.resolve(); expect(postFarmAttach).toHaveBeenCalledTimes(1)
    release(); await Promise.all([first, second])
    expect(readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local })?.state).toBe('settling')
  })

  test('honors configured concurrency so a slow record does not block a distinct record', async () => {
    const local = storage(); writeForward(local, 'intent_creating'); createCctpTransfer(forward({ requestId: OTHER_REQUEST_ID }), { storage: local })
    let release; const gate = new Promise((resolve) => { release = resolve })
    const postFarmIntent = vi.fn(async (body) => { if (body.requestId === REQUEST_ID) await gate; return { acknowledged: true, schemaVersion: 1, jobId: JOB_ID, echoedRequestId: body.requestId } })
    const pending = resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent, concurrency: 2 })
    try {
      await Promise.resolve(); expect(postFarmIntent).toHaveBeenCalledTimes(2)
    } finally {
      release(); await pending
    }
  })

  test('aborting before a later record stops new work and leaves it nonterminal', async () => {
    const local = storage(); writeForward(local, 'intent_creating'); createCctpTransfer(forward({ requestId: OTHER_REQUEST_ID }), { storage: local })
    const controller = new AbortController(); const postFarmIntent = vi.fn(async (body) => { controller.abort(); return { acknowledged: true, schemaVersion: 1, jobId: JOB_ID, echoedRequestId: body.requestId } })
    await resumePendingCctpTransfers(OWNER, { storage: local, postFarmIntent, signal: controller.signal }).catch(() => undefined)
    expect(postFarmIntent).toHaveBeenCalledTimes(1)
    expect(readCctpTransfer({ owner: OWNER, requestId: OTHER_REQUEST_ID }, { storage: local })?.state).toBe('intent_creating')
  })

  test('never leaks poisoned network secrets into the durable row, summary, error, or console', async () => {
    const local = storage(); writeForward(local, 'settling'); const poison = 'Bearer CAPABILITY privateKey signedXDR approval cookie'
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await resumePendingCctpTransfers(OWNER, { storage: local, pollForwardStatus: async () => { throw new Error(poison) } })
      expect(JSON.stringify({ row: readCctpTransfer({ owner: OWNER, requestId: REQUEST_ID }, { storage: local }), result, calls: consoleSpy.mock.calls })).not.toContain(poison)
    } finally { consoleSpy.mockRestore() }
  })

  test('keeps two UserOperations sharing an outer transaction independent by job and hash', async () => {
    const local = storage(); writeReverse(local, 'userop_submitted'); writeReverse(local, 'userop_submitted', { requestId: OTHER_REQUEST_ID, userOpHash: OTHER_USER_OP_HASH })
    const seen = []; const reconcileUnwindUserOp = async (body) => { seen.push(body); return { status: 'success', evidenceStatus: 'verified', userOpHash: body.userOpHash, kernelAddress: KERNEL, unwindTxHash: UNWIND_TX_HASH } }
    const postUnwindAttach = async ({ jobId }) => ({ jobId })
    await resumePendingCctpTransfers(OWNER, { storage: local, reconcileUnwindUserOp, postUnwindAttach, concurrency: 2 })
    expect(seen.map(({ jobId, userOpHash }) => [jobId, userOpHash]).sort()).toEqual([[OTHER_REQUEST_ID, OTHER_USER_OP_HASH], [UNWIND_JOB_ID, USER_OP_HASH]].sort())
  })
})
