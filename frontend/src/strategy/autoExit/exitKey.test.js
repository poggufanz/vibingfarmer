// frontend/src/strategy/autoExit/exitKey.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateExitKey, saveExitKey, loadExitKey, clearExitKey } from '../../wallet/exitKey.js';

const store = {};
beforeEach(() => {
  for (const k in store) delete store[k];
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; }
  };
});

describe('Exit Key Management', () => {
  it('generates a random ed25519 keypair', async () => {
    const key = await generateExitKey();
    expect(key.publicKey).toBeDefined();
    expect(key.secret).toBeDefined();
  });

  it('saves, loads, and clears the exit key correctly', () => {
    const key = { publicKey: 'GEXIT', secret: 'SEXIT' };
    saveExitKey('CAGENT', key);
    
    const loaded = loadExitKey('CAGENT');
    expect(loaded).toEqual(key);

    clearExitKey('CAGENT');
    expect(loadExitKey('CAGENT')).toBeNull();
  });
});
