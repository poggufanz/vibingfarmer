import { describe, expect, it } from 'vitest';
import {
  requireCanonicalUserOperationHash,
  requireSuccessfulUserOperation,
} from '../../src/base/userOpReceipt.mjs';

const TX = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'b'.repeat(64)}`;

describe('requireSuccessfulUserOperation', () => {
  it('returns the canonical transaction hash for a fully successful user operation', () => {
    expect(requireSuccessfulUserOperation({
      success: true,
      receipt: { status: 'success', transactionHash: TX },
    })).toBe(TX);
  });

  it('rejects a non-canonical user operation hash before it can be trusted', () => {
    expect(() => requireCanonicalUserOperationHash('0x1')).toThrow('canonical user operation hash');
    expect(requireCanonicalUserOperationHash(USER_OP_HASH)).toBe(USER_OP_HASH);
  });

  it.each([
    [{ success: true, receipt: { status: 'reverted', transactionHash: TX } }],
    [{ success: false, receipt: { status: 'success', transactionHash: TX } }],
    [{ success: true, receipt: { status: 'success' } }],
    [{ success: true, receipt: { status: 'success', transactionHash: '0x1' } }],
  ])('rejects one-sided or malformed success %#', (receipt) => {
    expect(() => requireSuccessfulUserOperation(receipt)).toThrow();
  });
});
