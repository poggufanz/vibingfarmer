import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import { readKnownUnwindUserOperation, reconcileUnwindUserOperation } from './unwindEvidence.js'

vi.mock('./deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import { BASE_EXIT_SWEEPER_ABI, BASE_EXIT_SWEEPER_ADDRESS } from './config.js'

const JOB_ID = '44'.repeat(16)
const USER_OP_HASH = `0x${'77'.repeat(32)}`
const UNWIND_TX_HASH = `0x${'88'.repeat(32)}`
const KERNEL = `0x${'99'.repeat(20)}`
const OWNER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'

function reconcile(readReceipt) {
  return reconcileUnwindUserOperation({
    jobId: JOB_ID,
    userOpHash: USER_OP_HASH,
    kernelAddress: KERNEL,
    recipientHint: OWNER,
    readReceipt,
  })
}

describe('reconcileUnwindUserOperation', () => {
  it.each([
    ['pending', { status: 'pending' }, { status: 'pending', evidenceStatus: 'needs_reconcile' }],
    ['reverted', { status: 'reverted' }, { status: 'reverted' }],
  ])('returns the strict %s receipt result without an attach-ready hash', async (_name, receipt, expected) => {
    const readReceipt = vi.fn(async () => receipt)

    await expect(reconcile(readReceipt)).resolves.toEqual(expected)
    expect(readReceipt).toHaveBeenCalledWith({ userOpHash: USER_OP_HASH })
  })

  it.each([
    ['changed UserOperation', { userOpHash: `0x${'79'.repeat(32)}`, kernelAddress: KERNEL, unwindTxHash: UNWIND_TX_HASH, evidenceStatus: 'verified' }],
    ['changed Kernel', { userOpHash: USER_OP_HASH, kernelAddress: `0x${'90'.repeat(20)}`, unwindTxHash: UNWIND_TX_HASH, evidenceStatus: 'verified' }],
    ['missing verified evidence', { userOpHash: USER_OP_HASH, kernelAddress: KERNEL, unwindTxHash: UNWIND_TX_HASH, evidenceStatus: 'needs_reconcile' }],
  ])('rejects a %s receipt as a non-attachable mismatch', async (_name, receipt) => {
    await expect(reconcile(async () => receipt)).resolves.toEqual({ status: 'mismatch' })
  })

  it('returns attach-ready evidence only for the exact successful UserOperation and Kernel', async () => {
    const receipt = {
      status: 'success',
      userOpHash: USER_OP_HASH,
      kernelAddress: KERNEL,
      unwindTxHash: UNWIND_TX_HASH,
      evidenceStatus: 'verified',
    }

    await expect(reconcile(async () => receipt)).resolves.toEqual({
      userOpHash: USER_OP_HASH,
      kernelAddress: KERNEL,
      recipientHint: OWNER,
      unwindTxHash: UNWIND_TX_HASH,
      evidenceStatus: 'verified',
    })
  })
})

function sweptLog({
  owner = KERNEL,
  burned = 5_500_000n,
  address = BASE_EXIT_SWEEPER_ADDRESS,
  topic,
  data,
} = {}) {
  return {
    address,
    topics: topic
      ? [topic]
      : encodeEventTopics({ abi: BASE_EXIT_SWEEPER_ABI, eventName: 'Swept', args: { owner } }),
    data:
      data ??
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [burned, 2n, 0n]
      ),
  }
}

function knownReceipt({
  userOpHash = USER_OP_HASH,
  sender = KERNEL,
  success = true,
  receiptStatus = 'success',
  transactionHash = UNWIND_TX_HASH,
  logs = [],
  nestedLogs,
} = {}) {
  return {
    success,
    userOpHash,
    sender,
    ...(nestedLogs ? { logs: nestedLogs } : {}),
    receipt: { status: receiptStatus, transactionHash, logs },
  }
}

function readKnown(receipt) {
  const publicClient = { marker: 'read-only-public-client' }
  const bundler = { getUserOperationReceipt: vi.fn(async () => receipt) }
  const makePublicClient = vi.fn(() => publicClient)
  const makeBundlerClient = vi.fn((client) => {
    expect(client).toBe(publicClient)
    return bundler
  })
  return {
    result: readKnownUnwindUserOperation({
      userOpHash: USER_OP_HASH,
      kernelAddress: KERNEL,
      makePublicClient,
      makeBundlerClient,
    }),
    makePublicClient,
    makeBundlerClient,
    bundler,
  }
}

describe('readKnownUnwindUserOperation', () => {
  it('returns pending when the injected bundler has no receipt, without constructing a network client', async () => {
    const attempt = readKnown(null)

    await expect(attempt.result).resolves.toEqual({ status: 'pending' })
    expect(attempt.makePublicClient).toHaveBeenCalledOnce()
    expect(attempt.makeBundlerClient).toHaveBeenCalledOnce()
    expect(attempt.bundler.getUserOperationReceipt).toHaveBeenCalledWith({ hash: USER_OP_HASH })
  })

  it.each([
    ['outer revert', knownReceipt({ success: false })],
    ['inner revert', knownReceipt({ receiptStatus: 'reverted' })],
  ])('returns reverted for an explicit %s', async (_name, receipt) => {
    await expect(readKnown(receipt).result).resolves.toEqual({ status: 'reverted' })
  })

  it('returns verified evidence only for one exact requested UserOperation, sender, canonical transaction, and pinned Swept log', async () => {
    const attempt = readKnown(knownReceipt({ logs: [sweptLog()] }))

    await expect(attempt.result).resolves.toEqual({
      status: 'success',
      userOpHash: USER_OP_HASH,
      kernelAddress: KERNEL,
      unwindTxHash: UNWIND_TX_HASH,
      evidenceStatus: 'verified',
    })
  })

  it.each([
    ['wrong UserOperation', knownReceipt({ userOpHash: `0x${'79'.repeat(32)}`, logs: [sweptLog()] })],
    ['wrong sender', knownReceipt({ sender: `0x${'90'.repeat(20)}`, logs: [sweptLog()] })],
    ['nested-only Swept', knownReceipt({ nestedLogs: [sweptLog()] })],
    ['wrong Swept address', knownReceipt({ logs: [sweptLog({ address: `0x${'91'.repeat(20)}` })] })],
    ['wrong Swept topic', knownReceipt({ logs: [sweptLog({ topic: `0x${'01'.repeat(32)}` })] })],
    ['duplicate Swept', knownReceipt({ logs: [sweptLog(), sweptLog()] })],
    ['malformed Swept decode', knownReceipt({ logs: [sweptLog({ data: '0x01' })] })],
    ['wrong Swept owner', knownReceipt({ logs: [sweptLog({ owner: `0x${'92'.repeat(20)}` })] })],
    ['zero burned amount', knownReceipt({ logs: [sweptLog({ burned: 0n })] })],
  ])('returns mismatch for %s rather than making it attach-ready', async (_name, receipt) => {
    await expect(readKnown(receipt).result).resolves.toEqual({ status: 'mismatch' })
  })
})
