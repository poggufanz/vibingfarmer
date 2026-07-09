import { describe, it, expect } from 'vitest';
import { evmAddrToBytes32, ZERO_BYTES32_BUFFER } from '../../src/cctp/forward.mjs';

describe('evmAddrToBytes32', () => {
  it('left-pads a 20-byte EVM address to 32 bytes', () => {
    const addr = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC
    const buf = evmAddrToBytes32(addr);
    expect(buf.length).toBe(32);
    expect(buf.subarray(0, 12).every((b) => b === 0)).toBe(true);
    expect(buf.subarray(12).toString('hex')).toBe(addr.slice(2).toLowerCase());
  });

  it('throws on a malformed address (wrong length)', () => {
    expect(() => evmAddrToBytes32('0x1234')).toThrow(/bad evm address/);
  });
});

describe('ZERO_BYTES32_BUFFER', () => {
  it('is exactly 32 zero bytes', () => {
    expect(ZERO_BYTES32_BUFFER.length).toBe(32);
    expect(ZERO_BYTES32_BUFFER.every((b) => b === 0)).toBe(true);
  });
});
