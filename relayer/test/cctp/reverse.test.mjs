import { describe, it, expect } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { buildForwarderHookData, assertHookData, contractStrkeyToBytes32 } from '../../src/cctp/reverse.mjs';

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
