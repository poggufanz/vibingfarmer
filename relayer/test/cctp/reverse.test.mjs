import { describe, it, expect, vi } from 'vitest';
import { Keypair, StrKey, Account } from '@stellar/stellar-sdk';
import {
  buildForwarderHookData, assertHookData, contractStrkeyToBytes32,
} from '../../src/cctp/reverse.mjs';
// Namespace import for the Task 8 split seams: a named import of a not-yet-existing export
// would fail the whole file at load time and mask the still-valid tests above. The RED we
// want is `reverse.submitMintAndForwardStellar is not a function` per test.
import * as reverse from '../../src/cctp/reverse.mjs';

const SAMPLE_STRKEY = Keypair.random().publicKey(); // real, valid-checksum G-address; always 56 chars

describe('buildForwarderHookData', () => {
  it('writes version 0 at offset 24, length at 28 (0x38=56 for a G-address), ASCII strkey at 32', () => {
    expect(SAMPLE_STRKEY.length).toBe(56); // Stellar ed25519 public keys are always 56-char StrKeys
    const hex = buildForwarderHookData(SAMPLE_STRKEY);
    const buf = Buffer.from(hex.slice(2), 'hex');

    expect(buf.subarray(0, 24).every((b) => b === 0)).toBe(true); // [0:24) zero padding
    expect(buf.readUInt32BE(24)).toBe(0);                          // [24:28) version = 0
    expect(buf.readUInt32BE(28)).toBe(56);                         // [28:32) length = 0x38 = 56
    expect(buf.readUInt32BE(28)).toBe(0x38);
    expect(buf.subarray(32).toString('utf8')).toBe(SAMPLE_STRKEY); // [32:] strkey as UTF-8 text
    expect(buf.length).toBe(88);                                   // 32 + 56
  });

  it('throws on an empty strkey', () => {
    expect(() => buildForwarderHookData('')).toThrow(/non-empty/);
  });
});

describe('assertHookData', () => {
  it('accepts a well-formed hookData built by buildForwarderHookData', () => {
    const hex = buildForwarderHookData(SAMPLE_STRKEY);
    expect(() => assertHookData(hex)).not.toThrow();
  });

  it('rejects a raw 32-byte input — the #7313 InvalidHookVersion failure mode from SP0 (a bare address used as hookData instead of the length-prefixed hook)', () => {
    const raw32 = `0x${'11'.repeat(32)}`;
    expect(() => assertHookData(raw32)).toThrow(/too short/);
  });

  it('rejects a non-zero hook version', () => {
    const buf = Buffer.alloc(32 + SAMPLE_STRKEY.length);
    buf.writeUInt32BE(1, 24); // wrong version
    buf.writeUInt32BE(SAMPLE_STRKEY.length, 28);
    Buffer.from(SAMPLE_STRKEY, 'utf8').copy(buf, 32);
    expect(() => assertHookData(`0x${buf.toString('hex')}`)).toThrow(/unsupported hook version/);
  });

  it('rejects a declared length that does not match the actual strkey length', () => {
    const buf = Buffer.alloc(32 + SAMPLE_STRKEY.length);
    buf.writeUInt32BE(0, 24);
    buf.writeUInt32BE(10, 28); // wrong declared length
    Buffer.from(SAMPLE_STRKEY, 'utf8').copy(buf, 32);
    expect(() => assertHookData(`0x${buf.toString('hex')}`)).toThrow(/declared strkey length/);
  });

  it('rejects a non-StrKey recipient', () => {
    const bogus = 'not-a-real-strkey-but-right-length-000000000000000000000';
    const buf = Buffer.alloc(32 + bogus.length);
    buf.writeUInt32BE(0, 24);
    buf.writeUInt32BE(bogus.length, 28);
    Buffer.from(bogus, 'utf8').copy(buf, 32);
    expect(() => assertHookData(`0x${buf.toString('hex')}`)).toThrow(/not a valid Stellar StrKey/);
  });
});

describe('contractStrkeyToBytes32', () => {
  it('decodes a C-address contract StrKey to its raw 32-byte hex representation', () => {
    const rawBytes = Buffer.alloc(32, 7); // arbitrary but deterministic
    const strkey = StrKey.encodeContract(rawBytes);
    const hex = contractStrkeyToBytes32(strkey);
    expect(hex).toBe(`0x${rawBytes.toString('hex')}`);
  });
});

// ---------------------------------------------------------------------------
// Task 8 RED: split Stellar destination seams.
//
// The regression under test is the combined `mintAndForwardStellar` (sendTransaction +
// confirmStellarTx in one call): a process loss after broadcast but before confirmation
// leaves no durable hash, and the legacy 'pending' sweep can rebroadcast the mint. The
// split contract:
//
//   submitMintAndForwardStellar({ server, kp, sourcePub, passphrase, forwarderAddress,
//                                 message, attestation })
//     -> Promise<canonical 64-hex-no-0x hash>   (returns right after sendTransaction)
//   confirmMintAndForwardStellar({ server, hash, attempts?, intervalMs? })
//     -> Promise<hash>                          (delegates to confirmStellarTx; read-only)
//
// Machine-readable rejection codes (assert .code, never prose):
//   CCTP_MINT_SUBMISSION_AMBIGUOUS — post-send-fence without a canonical hash
//                                    (watcher: uncertain, never auto-resubmit)
//   STELLAR_TX_FAILED              — definitive on-chain failure (watcher: blocked)
//   STELLAR_TX_TIMEOUT             — attempt window expired on a known hash
//                                    (watcher: stay mint_submitted, confirm again later)
// ---------------------------------------------------------------------------

const PASSPHRASE = 'Test SDF Network ; September 2015';
const FORWARDER = StrKey.encodeContract(Buffer.alloc(32, 1));
const STELLAR_HASH = 'cd'.repeat(32);          // canonical Stellar form: 64 hex, no 0x
const MESSAGE = '0x1234';
const ATTESTATION = '0x5678';

const rejection = (p) => p.then(
  () => { throw new Error('expected the seam to reject, but it resolved'); },
  (err) => err,
);

// Boundary-fake Soroban RPC server. prepareTransaction captures the built operation so the
// test can assert the exact mint_and_forward call the seam constructed.
const makeStellarServer = ({ sendResult, getTransaction } = {}) => {
  const kp = Keypair.random();
  const captured = { op: null };
  const server = {
    getAccount: vi.fn().mockResolvedValue(new Account(kp.publicKey(), '1')),
    prepareTransaction: vi.fn(async (tx) => { captured.op = tx.operations[0]; return tx; }),
    sendTransaction: vi.fn().mockResolvedValue(sendResult ?? { status: 'PENDING', hash: STELLAR_HASH }),
    getTransaction: getTransaction ?? vi.fn(),
  };
  return { kp, server, captured };
};

const submitArgs = (kp, server) => ({
  server, kp, sourcePub: kp.publicKey(), passphrase: PASSPHRASE,
  forwarderAddress: FORWARDER, message: MESSAGE, attestation: ATTESTATION,
});

describe('submitMintAndForwardStellar', () => {
  it('builds the exact mint_and_forward call, returns the canonical sent.hash, and never calls getTransaction — regression: combined send+wait crash window (no durable hash between broadcast and confirmation)', async () => {
    const { kp, server, captured } = makeStellarServer();
    const result = await reverse.submitMintAndForwardStellar(submitArgs(kp, server));

    expect(result).toBe(STELLAR_HASH);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(server.getTransaction).not.toHaveBeenCalled(); // submit does NOT confirm

    // The exact call the forwarder contract expects: mint_and_forward(message, attestation)
    // as raw bytes, in this argument order, against the configured forwarder contract.
    expect(captured.op.type).toBe('invokeHostFunction');
    const call = captured.op.func.invokeContract();
    expect(StrKey.encodeContract(Buffer.from(call.contractAddress().contractId()))).toBe(FORWARDER);
    expect(call.functionName().toString()).toBe('mint_and_forward');
    expect(call.args().length).toBe(2);
    expect(Buffer.from(call.args()[0].bytes()).toString('hex')).toBe('1234');
    expect(Buffer.from(call.args()[1].bytes()).toString('hex')).toBe('5678');
  });

  it('rejects CCTP_MINT_SUBMISSION_AMBIGUOUS on an ERROR send status — regression: a post-fence send failure treated as a safe pre-send error and automatically rebroadcast', async () => {
    const { kp, server } = makeStellarServer({
      sendResult: { status: 'ERROR', errorResult: 'tx_failed' },
    });
    const err = await rejection(reverse.submitMintAndForwardStellar(submitArgs(kp, server)));
    expect(err.code).toBe('CCTP_MINT_SUBMISSION_AMBIGUOUS');
    expect(server.sendTransaction).toHaveBeenCalledTimes(1); // genuinely post-fence
    expect(server.getTransaction).not.toHaveBeenCalled();    // no hash, nothing to confirm
  });

  it.each([
    ['non-hex placeholder', { status: 'PENDING', hash: 'MINT_HASH' }],
    ['missing hash', { status: 'PENDING' }],
    ['wrong prefix for the Stellar domain', { status: 'PENDING', hash: `0x${'ab'.repeat(32)}` }],
    ['short hash', { status: 'PENDING', hash: 'abcd' }],
  ])('rejects CCTP_MINT_SUBMISSION_AMBIGUOUS when sendTransaction returns a %s — regression: no durable confirmation identity checkpointed before any confirm attempt', async (_label, sendResult) => {
    const { kp, server } = makeStellarServer({ sendResult });
    const err = await rejection(reverse.submitMintAndForwardStellar(submitArgs(kp, server)));
    expect(err.code).toBe('CCTP_MINT_SUBMISSION_AMBIGUOUS');
    expect(server.sendTransaction).toHaveBeenCalledTimes(1); // post-fence, not input validation
  });
});

describe('confirmMintAndForwardStellar', () => {
  it('confirms the exact supplied hash via getTransaction and returns it — regression: a confirmation seam that rebroadcasts a second mint instead of observing the persisted hash', async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
      sendTransaction: vi.fn(), // must stay untouched: confirmation is read-only
    };
    // NO kp/sourcePub/message/attestation: if the seam tried to rebuild and resend the mint
    // it would blow up on the missing signer.
    const result = await reverse.confirmMintAndForwardStellar({
      server, hash: STELLAR_HASH, attempts: 3, intervalMs: 0,
    });
    expect(result).toBe(STELLAR_HASH);
    expect(server.getTransaction).toHaveBeenCalledTimes(1);
    expect(server.getTransaction).toHaveBeenCalledWith(STELLAR_HASH); // exact hash delegation
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps polling through NOT_FOUND and transient RPC errors, then returns the same hash — regression: a temporary outage after broadcast relabeled as terminal failure (live incident: mint 2a93e14f... landed, job recorded error)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // swallow-and-retry breadcrumb
    const server = {
      getTransaction: vi.fn()
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue({ status: 'SUCCESS' }),
      sendTransaction: vi.fn(),
    };
    const result = await reverse.confirmMintAndForwardStellar({
      server, hash: STELLAR_HASH, attempts: 5, intervalMs: 0,
    });
    expect(result).toBe(STELLAR_HASH);
    expect(server.getTransaction).toHaveBeenCalledTimes(3);
    expect(server.getTransaction).toHaveBeenNthCalledWith(3, STELLAR_HASH);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects STELLAR_TX_FAILED on an explicit FAILED status — regression: a failed destination mint recorded as minted because prose was the only signal', async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: 'FAILED', resultXdr: 'XDR' }),
      sendTransaction: vi.fn(),
    };
    const err = await rejection(reverse.confirmMintAndForwardStellar({
      server, hash: STELLAR_HASH, attempts: 3, intervalMs: 0,
    }));
    expect(err.code).toBe('STELLAR_TX_FAILED'); // definitive: watcher marks blocked
  });

  it('rejects STELLAR_TX_TIMEOUT when the attempt window expires — regression: a known, persisted hash thrown away (or the mint rebroadcast) on a slow ledger', async () => {
    const server = {
      getTransaction: vi.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      sendTransaction: vi.fn(),
    };
    const err = await rejection(reverse.confirmMintAndForwardStellar({
      server, hash: STELLAR_HASH, attempts: 3, intervalMs: 0,
    }));
    expect(err.code).toBe('STELLAR_TX_TIMEOUT'); // retryable: watcher stays mint_submitted
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });
});
