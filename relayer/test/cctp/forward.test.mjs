import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, StrKey, Account } from '@stellar/stellar-sdk';
import { evmAddrToBytes32, ZERO_BYTES32_BUFFER, approveAndBurnStellar } from '../../src/cctp/forward.mjs';

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

// Same regression guard as reverse.test.mjs's mintAndForwardStellar case: invokeStellar (via
// approveAndBurnStellar) must ride out a transient getTransaction error instead of throwing.
describe('approveAndBurnStellar', () => {
  afterEach(() => vi.useRealTimers());

  it('survives a transient getTransaction error mid-confirm and returns the burn hash', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kp = Keypair.random();
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getAccount: vi.fn().mockResolvedValue(new Account(kp.publicKey(), '1')),
      prepareTransaction: vi.fn(async (tx) => tx),
      sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'BURN_HASH' }),
      getTransaction: vi.fn()
        .mockResolvedValueOnce({ status: 'SUCCESS' })            // approve confirms cleanly
        .mockRejectedValueOnce(new Error('socket hang up'))      // burn confirm blips once
        .mockResolvedValue({ status: 'SUCCESS' }),
    };
    const pending = approveAndBurnStellar({
      server, kp, sourcePub: kp.publicKey(), passphrase: 'Test SDF Network ; September 2015',
      tokenMessengerMinter: StrKey.encodeContract(Buffer.alloc(32, 2)),
      usdcSac: StrKey.encodeContract(Buffer.alloc(32, 3)),
      amount7dp: 10_000_000n, allowance7dp: 10_000_000n,
      baseRecipient: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      destDomain: 6, minFinality: 2000, maxFee: 0n,
    });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(6000); // approve: 1 poll; burn: 2 polls (2s interval)
    await expect(pending).resolves.toBe('BURN_HASH');
    expect(server.getTransaction).toHaveBeenCalledTimes(3);
  });
});
