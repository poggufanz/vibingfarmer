function abortReason(signal) {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError')
}

/**
 * Map items with bounded concurrency while retaining Promise.allSettled-style results in input
 * order. Aborting rejects the outer operation; already-running mappers remain observed, but no
 * queued mapper is started after the signal is aborted.
 */
export async function mapSettledWithConcurrency(items, mapper, { concurrency = 8, signal } = {}) {
  if (signal?.aborted) throw abortReason(signal)
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new TypeError('concurrency must be a finite positive number')
  }

  const input = Array.from(items)
  if (input.length === 0) return []

  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), input.length)
  const results = new Array(input.length)
  let nextIndex = 0

  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw abortReason(signal)
      const index = nextIndex
      if (index >= input.length) return
      nextIndex += 1
      if (signal?.aborted) throw abortReason(signal)

      try {
        const value = await mapper(input[index], index)
        results[index] = { status: 'fulfilled', value }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (!signal) {
    await workers
    return results
  }

  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    await Promise.race([workers, aborted])
    return results
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
