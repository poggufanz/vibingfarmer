import { describe, expect, it } from 'vitest'
import {
  requireCanonicalUserOperationHash,
  requireSuccessfulUserOperation,
} from './userOpReceipt.js'

const TX_HASH_MIXED = `0x${'Aa'.repeat(32)}`
const TX_HASH = TX_HASH_MIXED.toLowerCase()
const USER_OP_HASH_MIXED = `0x${'Bb'.repeat(32)}`
const USER_OP_HASH = USER_OP_HASH_MIXED.toLowerCase()

describe('requireSuccessfulUserOperation', () => {
  it('requires outer and inner success and returns one normalized transaction hash', () => {
    const receipt = Object.freeze({
      success: true,
      receipt: Object.freeze({ status: 'success', transactionHash: TX_HASH_MIXED }),
    })

    expect(requireSuccessfulUserOperation(receipt)).toBe(TX_HASH)
    expect(receipt.receipt.transactionHash).toBe(TX_HASH_MIXED)
  })

  it.each([
    ['outer failure', { success: false, receipt: { status: 'success', transactionHash: TX_HASH } }],
    ['inner revert', { success: true, receipt: { status: 'reverted', transactionHash: TX_HASH } }],
    ['missing outer result', { receipt: { status: 'success', transactionHash: TX_HASH } }],
    ['missing inner receipt', { success: true }],
    ['missing inner status', { success: true, receipt: { transactionHash: TX_HASH } }],
  ])('rejects %s instead of accepting one-sided success', (_label, receipt) => {
    expect(() => requireSuccessfulUserOperation(receipt)).toThrow()
  })

  it.each([
    undefined,
    '',
    '0x1',
    `0x${'a'.repeat(63)}`,
    `0x${'a'.repeat(65)}`,
    `0x${'g'.repeat(64)}`,
    `${'a'.repeat(64)}`,
  ])('rejects malformed transaction hash %#', (transactionHash) => {
    expect(() =>
      requireSuccessfulUserOperation({
        success: true,
        receipt: { status: 'success', transactionHash },
      })
    ).toThrow(/transaction hash/i)
  })
})

describe('requireCanonicalUserOperationHash', () => {
  it('validates and normalizes a 32-byte UserOperation identity without mutating input', () => {
    expect(requireCanonicalUserOperationHash(USER_OP_HASH_MIXED)).toBe(USER_OP_HASH)
  })

  it.each([undefined, '', '0x1', `0x${'a'.repeat(63)}`, `0x${'z'.repeat(64)}`])(
    'rejects malformed UserOperation hash %#',
    (hash) => {
      expect(() => requireCanonicalUserOperationHash(hash)).toThrow(/user operation hash/i)
    }
  )
})
