import { describe, it, expect } from 'vitest';
import { createKeyStore } from './keyStore.js';

describe('keyStore', () => {
  it('puts, gets, and deletes a sealed blob by address (in-memory default)', async () => {
    const ks = createKeyStore(); // Node/test → in-memory adapter
    await ks.put('0xAbc', 'sealed-blob');
    expect(await ks.get('0xAbc')).toBe('sealed-blob');
    await ks.del('0xAbc');
    expect(await ks.get('0xAbc')).toBeUndefined();
  });

  it('keeps a separate blob per address', async () => {
    const ks = createKeyStore();
    await ks.put('0x1', 'a');
    await ks.put('0x2', 'b');
    expect(await ks.get('0x1')).toBe('a');
    expect(await ks.get('0x2')).toBe('b');
  });
});
