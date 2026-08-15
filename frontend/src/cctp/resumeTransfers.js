// Read/idempotent reload recovery only.  Do not add wallet, signer, burn, or send imports here.
import { checkpointCctpTransfer, listCctpTransfers } from './transferJournal.js'
import { mapSettledWithConcurrency } from '../async/mapSettledWithConcurrency.js'

const active = new Map()
const terminalForStatus = (status) =>
  status === 'expired'
    ? ['blocked', 'authorization_unavailable']
    : status === 'done' || status === 'error' || status === 'uncertain' || status === 'blocked'
      ? [status, status === 'done' ? 'job_error' : `job_${status}`]
      : null
const mismatch = () =>
  Object.assign(new Error('public identity mismatch'), { code: 'identity_mismatch' })

function intentBody(record) {
  const t = record.transfer
  return {
    requestId: record.requestId,
    sourceDomain: 27,
    mandateId: t.mandateId,
    stellarOwner: record.owner,
    kernelAddress: t.kernelAddress,
    bridgeAgent: t.bridgeAgent,
    runId: t.runId,
    grantTxHash: t.grantTxHash,
    allocations: t.allocations,
  }
}
function summary(owner) {
  return { owner, resumed: [], held: [], terminal: [], uncertain: [], blocked: [] }
}
function put(result, name, requestId) {
  result[name].push(requestId)
}
function terminalize(record, state, reasonCode, options, result) {
  checkpointCctpTransfer(
    {
      owner: record.owner,
      requestId: record.requestId,
      from: record.state,
      to: state,
      patch: { reasonCode },
    },
    options
  )
  put(
    result,
    state === 'uncertain' ? 'uncertain' : state === 'blocked' ? 'blocked' : 'terminal',
    record.requestId
  )
}

async function one(record, options, result) {
  const {
    postFarmIntent,
    postFarmAttach,
    postUnwindAttach,
    pollForwardStatus,
    pollUnwindStatus,
    reconcileUnwindUserOp,
  } = options
  const checkpoint = (from, to, patch) =>
    checkpointCctpTransfer(
      { owner: record.owner, requestId: record.requestId, from, to, ...(patch ? { patch } : {}) },
      options
    )
  if (record.direction === 'forward') {
    if (record.state === 'intent_creating') {
      if (typeof postFarmIntent !== 'function') {
        terminalize(record, 'blocked', 'authorization_unavailable', options, result)
        return
      }
      try {
        const ack = await postFarmIntent(intentBody(record))
        if (
          ack?.acknowledged !== true ||
          ack?.schemaVersion !== 1 ||
          !/^[0-9a-f]{32}$/.test(ack?.jobId || '') ||
          (ack.echoedRequestId !== undefined && ack.echoedRequestId !== record.requestId)
        )
          throw mismatch()
        checkpoint('intent_creating', 'intent_acked', { jobId: ack.jobId })
        put(result, 'resumed', record.requestId)
      } catch (error) {
        if (error?.code === 'identity_mismatch')
          terminalize(record, 'blocked', 'intent_unavailable', options, result)
        else put(result, 'held', record.requestId)
      }
      return
    }
    if (record.state === 'intent_acked') {
      put(result, 'held', record.requestId)
      return
    }
    if (record.state === 'burn_submitting') {
      terminalize(record, 'uncertain', 'burn_submission_unknown', options, result)
      return
    }
    if (record.state === 'burn_confirmed') record = checkpoint('burn_confirmed', 'attach_pending')
    if (record.state === 'attach_pending') {
      if (typeof postFarmAttach !== 'function') {
        terminalize(record, 'blocked', 'authorization_unavailable', options, result)
        return
      }
      try {
        const response = await postFarmAttach({
          mandateId: record.transfer.mandateId,
          jobId: record.transfer.jobId,
          burnTxHash: record.transfer.burnTxHash,
        })
        if (response?.jobId !== undefined && response.jobId !== record.transfer.jobId)
          throw mismatch()
        if (
          response?.burnTxHash !== undefined &&
          response.burnTxHash !== record.transfer.burnTxHash
        )
          throw mismatch()
        checkpoint('attach_pending', 'settling')
        put(result, 'resumed', record.requestId)
      } catch (error) {
        if (error?.code === 'identity_mismatch')
          terminalize(record, 'blocked', 'attach_unavailable', options, result)
        else put(result, 'held', record.requestId)
      }
      return
    }
    if (record.state === 'settling') {
      if (typeof pollForwardStatus !== 'function') {
        terminalize(record, 'blocked', 'authorization_unavailable', options, result)
        return
      }
      try {
        const response = await pollForwardStatus({
          mandateId: record.transfer.mandateId,
          jobId: record.transfer.jobId,
        })
        if (response?.jobId !== undefined && response.jobId !== record.transfer.jobId)
          throw mismatch()
        if (
          response?.burnTxHash !== undefined &&
          response.burnTxHash !== record.transfer.burnTxHash
        )
          throw mismatch()
        const terminal = terminalForStatus(response?.status)
        if (terminal) terminalize(record, terminal[0], terminal[1], options, result)
        else put(result, 'held', record.requestId)
      } catch (error) {
        if (error?.code === 'identity_mismatch')
          terminalize(record, 'blocked', 'status_unavailable', options, result)
        else put(result, 'held', record.requestId)
      }
      return
    }
  } else {
    if (record.state === 'userop_submitting') {
      terminalize(record, 'uncertain', 'userop_submission_unknown', options, result)
      return
    }
    if (record.state === 'userop_submitted') {
      if (typeof reconcileUnwindUserOp !== 'function') {
        put(result, 'held', record.requestId)
        return
      }
      try {
        const evidence = await reconcileUnwindUserOp({
          jobId: record.transfer.jobId,
          userOpHash: record.transfer.userOpHash,
          kernelAddress: record.transfer.kernelAddress,
          recipientHint: record.transfer.recipientHint,
        })
        if (evidence?.status === 'pending' || evidence?.evidenceStatus === 'needs_reconcile') {
          put(result, 'held', record.requestId)
          return
        }
        if (evidence?.status === 'reverted') {
          terminalize(record, 'error', 'receipt_reverted', options, result)
          return
        }
        if (
          evidence?.userOpHash !== record.transfer.userOpHash ||
          evidence?.kernelAddress !== record.transfer.kernelAddress ||
          !/^0x[0-9a-f]{64}$/.test(evidence?.unwindTxHash || '') ||
          evidence?.evidenceStatus !== 'verified'
        ) {
          terminalize(record, 'blocked', 'receipt_evidence_unverified', options, result)
          return
        }
        record = checkpoint('userop_submitted', 'unwind_confirmed', {
          unwindTxHash: evidence.unwindTxHash,
        })
      } catch {
        put(result, 'held', record.requestId)
        return
      }
    }
    if (record.state === 'unwind_confirmed')
      record = checkpoint('unwind_confirmed', 'relay_pending')
    if (record.state === 'relay_pending') {
      if (typeof postUnwindAttach !== 'function') {
        terminalize(record, 'blocked', 'authorization_unavailable', options, result)
        return
      }
      try {
        const response = await postUnwindAttach({
          jobId: record.transfer.jobId,
          userOpHash: record.transfer.userOpHash,
          unwindTxHash: record.transfer.unwindTxHash,
        })
        if (response?.jobId !== undefined && response.jobId !== record.transfer.jobId)
          throw mismatch()
        checkpoint('relay_pending', 'settling')
        put(result, 'resumed', record.requestId)
      } catch (error) {
        if (error?.code === 'identity_mismatch')
          terminalize(record, 'blocked', 'unwind_attach_unavailable', options, result)
        else put(result, 'held', record.requestId)
      }
      return
    }
    if (record.state === 'settling') {
      if (typeof pollUnwindStatus !== 'function') {
        terminalize(record, 'blocked', 'authorization_unavailable', options, result)
        return
      }
      try {
        const response = await pollUnwindStatus({ jobId: record.transfer.jobId })
        if (response?.jobId !== record.transfer.jobId) throw mismatch()
        if (
          response?.userOpHash !== undefined &&
          response.userOpHash !== record.transfer.userOpHash
        )
          throw mismatch()
        if (
          response?.unwindTxHash !== undefined &&
          response.unwindTxHash !== record.transfer.unwindTxHash
        )
          throw mismatch()
        const terminal = terminalForStatus(response?.status)
        if (terminal) terminalize(record, terminal[0], terminal[1], options, result)
        else put(result, 'held', record.requestId)
      } catch (error) {
        if (error?.code === 'identity_mismatch')
          terminalize(record, 'blocked', 'status_unavailable', options, result)
        else put(result, 'held', record.requestId)
      }
    }
  }
}

export async function resumePendingCctpTransfers(owner, options = {}) {
  const records = listCctpTransfers(owner, options)
  const result = summary(owner)
  try {
    await mapSettledWithConcurrency(
      records,
      async (record) => {
        if (['done', 'error', 'uncertain', 'blocked'].includes(record.state)) {
          put(result, 'terminal', record.requestId)
          return
        }
        const key = `${owner.toLowerCase()}:${record.requestId}`
        let promise = active.get(key)
        if (!promise) {
          promise = one(record, options, result).finally(() => active.delete(key))
          active.set(key, promise)
        }
        await promise
      },
      { concurrency: options.concurrency ?? 4, signal: options.signal }
    )
  } catch (error) {
    if (!options.signal?.aborted) throw error
  }
  for (const key of Object.keys(result)) if (Array.isArray(result[key])) result[key].sort()
  return result
}
