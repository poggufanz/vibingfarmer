import { describe, it, expect } from 'vitest';
import { generateWorkerKey, deriveSecret, newSalt, sealKey, openKey, zeroize } from './keyVault.js';

describe('keyVault', () => {
  it('generates a fresh private key + address each call', async () => {
    const a = await generateWorkerKey();
    const b = await generateWorkerKey();
    expect(a.privateKey).not.toEqual(b.privateKey);
    expect(a.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('derives a stable 32-byte secret from passphrase + salt (KDF)', async () => {
    const salt = await newSalt();
    const a = await deriveSecret('correct horse battery staple', salt);
    const b = await deriveSecret('correct horse battery staple', salt);
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b)); // deterministic for same input
  });

  it('different passphrase yields a different secret', async () => {
    const salt = await newSalt();
    const a = await deriveSecret('p1', salt);
    const b = await deriveSecret('p2', salt);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('seals then opens back to the same key', async () => {
    const { privateKey } = await generateWorkerKey();
    const salt = await newSalt();
    const secret = await deriveSecret('session-passphrase', salt); // production secret source
    const blob = await sealKey(privateKey, secret);
    expect(blob).not.toContain(privateKey.slice(2)); // not stored in clear
    const opened = await openKey(blob, secret);
    expect(opened).toEqual(privateKey);
  });

  it('zeroize wipes a Uint8Array buffer in place', () => {
    const buf = new Uint8Array([1, 2, 3]);
    zeroize(buf);
    expect(Array.from(buf)).toEqual([0, 0, 0]);
  });
});
