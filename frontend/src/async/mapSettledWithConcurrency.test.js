import { describe, expect, it } from 'vitest'
import { mapSettledWithConcurrency } from './mapSettledWithConcurrency.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitUntil(predicate) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

describe('mapSettledWithConcurrency', () => {
  it('keeps at most eight mapper calls active and returns results in input order', async () => {
    const gates = Array.from({ length: 25 }, deferred)
    let active = 0
    let peak = 0
    const started = []

    const operation = mapSettledWithConcurrency(
      Array.from({ length: 25 }, (_, index) => index),
      async (item, index) => {
        started.push(index)
        active += 1
        peak = Math.max(peak, active)
        await gates[index].promise
        active -= 1
        return `value-${item}`
      },
      { concurrency: 8 }
    )

    await waitUntil(() => started.length === 8)
    expect(peak).toBe(8)

    // Complete every group in reverse order so completion order cannot accidentally equal input
    // order. Each completion opens exactly one queue slot for the next item.
    for (let index = 7; index >= 0; index -= 1) gates[index].resolve()
    await waitUntil(() => started.length === 16)
    for (let index = 15; index >= 8; index -= 1) gates[index].resolve()
    await waitUntil(() => started.length === 24)
    for (let index = 23; index >= 16; index -= 1) gates[index].resolve()
    await waitUntil(() => started.length === 25)
    gates[24].resolve()

    const results = await operation

    expect(peak).toBe(8)
    expect(results).toEqual(
      Array.from({ length: 25 }, (_, index) => ({
        status: 'fulfilled',
        value: `value-${index}`,
      }))
    )
  })

  it('stores an individual mapper rejection as a rejected result', async () => {
    const failure = new Error('address unreadable')

    const results = await mapSettledWithConcurrency(
      ['first', 'broken', 'last'],
      async (item) => {
        if (item === 'broken') throw failure
        return item.toUpperCase()
      },
      { concurrency: 8 }
    )

    expect(results).toEqual([
      { status: 'fulfilled', value: 'FIRST' },
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 'LAST' },
    ])
  })

  it('rejects the outer operation and prevents queued mappers from starting after abort', async () => {
    const controller = new AbortController()
    const gates = Array.from({ length: 8 }, deferred)
    const started = []
    const abortReason = new Error('owner changed')

    const operation = mapSettledWithConcurrency(
      Array.from({ length: 25 }, (_, index) => index),
      async (_item, index) => {
        started.push(index)
        await gates[index].promise
        return index
      },
      { concurrency: 8, signal: controller.signal }
    )

    await waitUntil(() => started.length === 8)
    controller.abort(abortReason)
    for (const gate of gates) gate.resolve()

    await expect(operation).rejects.toBe(abortReason)
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})
