// Narrow read-only seam for reload recovery.  It accepts a known UserOperation hash and a
// receipt reader only; unlike withdrawBatch it cannot construct or submit an operation.
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

// Intentionally read-only AA client. It owns neither an account nor any signing capability.
export async function readKnownUnwindUserOperation({
  userOpHash,
  kernelAddress,
  makePublicClient,
  makeBundlerClient,
}) {
  if (!HASH.test(userOpHash) || !ADDRESS.test(kernelAddress))
    throw new Error('receipt evidence is unavailable')
  const [
    { createPublicClient, http, parseEventLogs },
    { createBundlerClient },
    {
      BASE_CHAIN,
      BASE_SEPOLIA_RPC_URL,
      zerodevRpcUrl,
      BASE_EXIT_SWEEPER_ADDRESS,
      BASE_EXIT_SWEEPER_ABI,
    },
  ] = await Promise.all([import('viem'), import('viem/account-abstraction'), import('./config.js')])
  const publicClient = (
    makePublicClient ||
    (() => createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_SEPOLIA_RPC_URL) }))
  )()
  const bundler = (
    makeBundlerClient ||
    ((client) =>
      createBundlerClient({
        client,
        chain: BASE_CHAIN,
        transport: http(zerodevRpcUrl(BASE_CHAIN.id)),
      }))
  )(publicClient)
  let receipt
  try {
    receipt = await bundler.getUserOperationReceipt({ hash: userOpHash })
  } catch {
    return { status: 'pending' }
  }
  if (!receipt) return { status: 'pending' }
  if (receipt.success === false || receipt.receipt?.status === 'reverted')
    return { status: 'reverted' }
  if (receipt.success !== true || receipt.receipt?.status !== 'success')
    return { status: 'mismatch' }
  if (
    receipt?.userOpHash?.toLowerCase() !== userOpHash ||
    receipt?.sender?.toLowerCase() !== kernelAddress ||
    !HASH.test(receipt?.receipt?.transactionHash || '')
  )
    return { status: 'mismatch' }
  const TOPIC = '0x4f2d11fb664b5f2f436d0d6acfed89a492c2f8fde20a4811da677150003332eb'
  const candidates = Array.isArray(receipt.receipt.logs)
    ? receipt.receipt.logs.filter(
        (log) =>
          log?.address?.toLowerCase() === BASE_EXIT_SWEEPER_ADDRESS.toLowerCase() &&
          log?.topics?.[0]?.toLowerCase() === TOPIC
      )
    : []
  // The UserOperation is mined, so a missing/wrong/nested Swept event is evidence failure — not
  // a future-finality condition. Only an absent receipt is retryable pending.
  if (candidates.length === 0) return { status: 'mismatch' }
  if (candidates.length !== 1) return { status: 'mismatch' }
  try {
    const [swept] = parseEventLogs({
      abi: BASE_EXIT_SWEEPER_ABI,
      logs: candidates,
      eventName: 'Swept',
      strict: true,
    })
    if (
      !swept ||
      swept.args?.owner?.toLowerCase() !== kernelAddress ||
      typeof swept.args?.burned !== 'bigint' ||
      swept.args.burned <= 0n
    )
      return { status: 'mismatch' }
  } catch {
    return { status: 'mismatch' }
  }
  return {
    status: 'success',
    userOpHash,
    kernelAddress,
    unwindTxHash: receipt.receipt.transactionHash.toLowerCase(),
    evidenceStatus: 'verified',
  }
}

export async function reconcileUnwindUserOperation({
  jobId,
  userOpHash,
  kernelAddress,
  recipientHint,
  readReceipt,
}) {
  if (
    !/^[0-9a-f]{32}$/.test(jobId) ||
    !HASH.test(userOpHash) ||
    !ADDRESS.test(kernelAddress) ||
    typeof recipientHint !== 'string' ||
    typeof readReceipt !== 'function'
  ) {
    throw new Error('receipt evidence is unavailable')
  }
  let receipt
  try {
    receipt = await readReceipt({ userOpHash })
  } catch {
    return { status: 'pending', evidenceStatus: 'needs_reconcile' }
  }
  if (!receipt || receipt.status === 'pending')
    return { status: 'pending', evidenceStatus: 'needs_reconcile' }
  if (receipt.status === 'reverted') return { status: 'reverted' }
  if (
    receipt.userOpHash !== userOpHash ||
    receipt.kernelAddress !== kernelAddress ||
    !HASH.test(receipt.unwindTxHash || '') ||
    receipt.evidenceStatus !== 'verified'
  ) {
    return { status: 'mismatch' }
  }
  return {
    userOpHash,
    kernelAddress,
    recipientHint,
    unwindTxHash: receipt.unwindTxHash,
    evidenceStatus: 'verified',
  }
}
