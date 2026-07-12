import { describe, it, expect } from 'vitest';
import { createMandateStore } from '../src/mandateStore.mjs';

// A controllable clock so TTL behaviour is deterministic (no real timers).
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createMandateStore', () => {
  it('returns a stored key before its TTL elapses', () => {
    const clock = fakeClock();
    const store = createMandateStore({ ttlMs: 1000, now: clock.now });
    store.set('approval-1', '0xkey');
    clock.advance(999);
    expect(store.get('approval-1')).toBe('0xkey');
    expect(store.size).toBe(1);
  });

  it('lazily evicts and returns undefined once the TTL has elapsed', () => {
    const clock = fakeClock();
    const store = createMandateStore({ ttlMs: 1000, now: clock.now });
    store.set('approval-1', '0xkey');
    clock.advance(1000); // expiresAt is inclusive (t >= expiresAt)
    expect(store.get('approval-1')).toBeUndefined();
    expect(store.size).toBe(0); // the get evicted it — no lingering session key
  });

  it('sweep drops every expired entry and keeps the fresh ones, returning the removed count', () => {
    const clock = fakeClock();
    const store = createMandateStore({ ttlMs: 1000, now: clock.now });
    store.set('old-1', '0xa');
    store.set('old-2', '0xb');
    clock.advance(1001);
    store.set('fresh', '0xc'); // set after the advance -> not yet expired
    expect(store.sweep()).toBe(2);
    expect(store.size).toBe(1);
    expect(store.get('fresh')).toBe('0xc');
  });

  it('delete removes a key explicitly', () => {
    const store = createMandateStore();
    store.set('k', '0xkey');
    expect(store.delete('k')).toBe(true);
    expect(store.get('k')).toBeUndefined();
  });
});
