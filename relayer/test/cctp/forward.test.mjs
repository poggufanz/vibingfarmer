import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, StrKey, Account } from '@stellar/stellar-sdk';
import { evmAddrToBytes32, ZERO_BYTES32_BUFFER, approveAndBurnStellar } from '../../src/cctp/forward.mjs';
// Namespace import for the Task 8 split seams: a named import of a not-yet-existing export
// would fail the whole file at load time and mask the still-valid tests above. The RED we
// want is `forward.submitMintBase is not a function` per test, not a suite-level import error.
import * as forward from '../../src/cctp/forward.mjs';

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

// ---------------------------------------------------------------------------
// Task 8 RED: split Base destination seams.
//
// The regression under test is the combined `mintBase` (send + wait in one call, receipt
// status returned but never enforced): a crash between writeContract and
// waitForTransactionReceipt leaves no durable destination hash, and a reverted receipt
// reaches the watcher indistinguishable from a real mint. The split contract:
//
//   submitMintBase({ walletClient, messageTransmitterAddress, message, attestation })
//     -> Promise<canonical '0x'+64-hex hash>   (NO publicClient, NO waiting)
//   confirmMintBase({ publicClient, hash })
//     -> Promise<hash>                          (NO walletClient/message/attestation)
//
// Machine-readable rejection codes (assert .code, never prose) so the watcher can classify
// without parsing messages:
//   CCTP_MINT_SUBMISSION_AMBIGUOUS   — the send fence was crossed but no canonical hash came
//                                      back (watcher: uncertain, never auto-resubmit)
//   CCTP_MINT_REVERTED               — definitive on-chain revert (watcher: blocked)
//   CCTP_MINT_CONFIRMATION_RETRYABLE — transient/unknown confirmation of a known hash
//                                      (watcher: stay mint_submitted, confirm again later)
// ---------------------------------------------------------------------------

const MT_ADDRESS = `0x${'11'.repeat(20)}`;      // MessageTransmitterV2 stand-in; boundary fake target
const BASE_HASH = `0x${'ab'.repeat(32)}`;       // canonical Base form: 0x + 64 lowercase hex
const OTHER_BASE_HASH = `0x${'cd'.repeat(32)}`;
const MESSAGE = '0x1234';
const ATTESTATION = '0x5678';

const rejection = (p) => p.then(
  () => { throw new Error('expected the seam to reject, but it resolved'); },
  (err) => err,
);

describe('submitMintBase', () => {
  it('calls writeContract(receiveMessage) exactly once and returns the canonical hash immediately — regression: combined send+wait crash window (no durable hash between writeContract and waitForTransactionReceipt)', async () => {
    const walletClient = { writeContract: vi.fn().mockResolvedValue(BASE_HASH) };
    // Structural separation: NO publicClient is passed. If the seam tried to wait for a
    // receipt it would blow up on the missing client — an immediate resolve with the hash
    // is the proof that no waitForTransactionReceipt happens inside submit.
    const result = await forward.submitMintBase({
      walletClient, messageTransmitterAddress: MT_ADDRESS, message: MESSAGE, attestation: ATTESTATION,
    });
    expect(result).toBe(BASE_HASH);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      address: MT_ADDRESS,
      functionName: 'receiveMessage',
      args: [MESSAGE, ATTESTATION],
    }));
  });

  it.each([
    ['short hash', '0x1234'],
    ['missing 0x prefix', 'ab'.repeat(32)],
    ['non-hex', `0x${'zz'.repeat(32)}`],
    ['overlong', `0x${'ab'.repeat(33)}`],
  ])('rejects CCTP_MINT_SUBMISSION_AMBIGUOUS when the wallet returns a %s — regression: persisting an unusable recovery identity as if it were a safe pre-send validation error', async (_label, badHash) => {
    const walletClient = { writeContract: vi.fn().mockResolvedValue(badHash) };
    const err = await rejection(forward.submitMintBase({
      walletClient, messageTransmitterAddress: MT_ADDRESS, message: MESSAGE, attestation: ATTESTATION,
    }));
    expect(err.code).toBe('CCTP_MINT_SUBMISSION_AMBIGUOUS');
    // The rejection must be POST-fence: the send genuinely happened, so this is an ambiguous
    // submission (uncertain), not a pre-send input-validation failure.
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it('rejects CCTP_MINT_SUBMISSION_AMBIGUOUS when the wallet returns no hash at all — regression: confirming/persisting an undefined destination hash', async () => {
    const walletClient = { writeContract: vi.fn().mockResolvedValue(undefined) };
    const err = await rejection(forward.submitMintBase({
      walletClient, messageTransmitterAddress: MT_ADDRESS, message: MESSAGE, attestation: ATTESTATION,
    }));
    expect(err.code).toBe('CCTP_MINT_SUBMISSION_AMBIGUOUS');
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it('rejects CCTP_MINT_SUBMISSION_AMBIGUOUS when writeContract itself throws after the fence — regression: an unclassified viem error leaking to the watcher and triggering an automatic resubmit', async () => {
    const walletClient = { writeContract: vi.fn().mockRejectedValue(new Error('nonce too low')) };
    const err = await rejection(forward.submitMintBase({
      walletClient, messageTransmitterAddress: MT_ADDRESS, message: MESSAGE, attestation: ATTESTATION,
    }));
    expect(err.code).toBe('CCTP_MINT_SUBMISSION_AMBIGUOUS');
    expect(err.cause?.message ?? err.message).toContain('nonce too low'); // root cause kept for operators
  });
});

describe('confirmMintBase', () => {
  it('waits for the supplied hash and returns it only for status success — regression: mintBase returning receipt.status without enforcing it (reverted receipt recorded as minted)', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', transactionHash: BASE_HASH }),
    };
    // Structural separation: NO walletClient, message, or attestation. If the seam tried to
    // rebroadcast it would blow up on the missing client — confirmation must be read-only.
    const result = await forward.confirmMintBase({ publicClient, hash: BASE_HASH });
    expect(result).toBe(BASE_HASH);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: BASE_HASH }),
    );
  });

  it('rejects CCTP_MINT_REVERTED on an explicit reverted receipt — regression: watcher recording a reverted destination mint as minted', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', transactionHash: BASE_HASH }),
    };
    const err = await rejection(forward.confirmMintBase({ publicClient, hash: BASE_HASH }));
    expect(err.code).toBe('CCTP_MINT_REVERTED');
  });

  it.each([
    ['undefined status', { transactionHash: BASE_HASH }],
    ['case-changed SUCCESS status', { status: 'SUCCESS', transactionHash: BASE_HASH }],
  ])('rejects confirmation for a receipt with %s — regression: truthy or loose success checks minting on an unproven receipt', async (_label, receipt) => {
    const publicClient = { waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt) };
    const err = await rejection(forward.confirmMintBase({ publicClient, hash: BASE_HASH }));
    // Not an explicit revert: the receipt shape is untrustworthy, so this stays retryable
    // (confirm the same hash again) rather than definitive blocked.
    expect(err.code).toBe('CCTP_MINT_CONFIRMATION_RETRYABLE');
  });

  it('rejects a success receipt whose transactionHash differs — regression: confirming an unrelated receipt and marking the wrong transaction minted', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', transactionHash: OTHER_BASE_HASH }),
    };
    const err = await rejection(forward.confirmMintBase({ publicClient, hash: BASE_HASH }));
    expect(err.code).toBe('CCTP_MINT_CONFIRMATION_RETRYABLE');
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: BASE_HASH }),
    );
  });

  it('rejects CCTP_MINT_CONFIRMATION_RETRYABLE when the receipt wait throws transiently — regression: relabeling a known-hash timeout/RPC blip as a definitive failure (or worse, a resubmit)', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error('socket hang up')),
    };
    const err = await rejection(forward.confirmMintBase({ publicClient, hash: BASE_HASH }));
    expect(err.code).toBe('CCTP_MINT_CONFIRMATION_RETRYABLE');
    expect(err.cause?.message ?? err.message).toContain('socket hang up'); // transient cause kept distinguishable
  });
});
