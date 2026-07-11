import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, createMemoryStore } from '../src/store.mjs';

describe('createFileStore', () => {
  let dir;
  let path;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vf-relayer-store-'));
    path = join(dir, 'store.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for an unknown execId', () => {
    const store = createFileStore(path);
    expect(store.get('unknown')).toBeNull();
    expect(store.has('unknown')).toBe(false);
  });

  it('persists a record across store instances (same path)', () => {
    createFileStore(path).set('exec-1', { status: 'minted', mintTxHash: '0xabc' });
    const reopened = createFileStore(path);
    expect(reopened.has('exec-1')).toBe(true);
    expect(reopened.get('exec-1').status).toBe('minted');
    expect(reopened.get('exec-1').mintTxHash).toBe('0xabc');
    expect(typeof reopened.get('exec-1').updatedAt).toBe('number');
  });
});

describe('createMemoryStore', () => {
  it('round-trips get/set/has with no disk I/O', () => {
    const store = createMemoryStore();
    expect(store.get('e1')).toBeNull();
    store.set('e1', { status: 'pending' });
    expect(store.has('e1')).toBe(true);
    expect(store.get('e1').status).toBe('pending');
  });
});
