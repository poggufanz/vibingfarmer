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

  it('honors an explicit expiresAt passed to set(), instead of the flat ttlMs default', () => {
    const clock = fakeClock();
    const store = createMandateStore({ ttlMs: 1000, now: clock.now }); // ttlMs is the fallback only
    store.set('approval-1', '0xkey', clock.now() + 50_000); // caller-supplied expiry far past ttlMs
    clock.advance(1500); // would have evicted under the default 1000ms ttl
    expect(store.get('approval-1')).toBe('0xkey'); // still alive — explicit expiresAt wins
  });

  it('status() reports {valid, expiresAt} without ever handing back the stored value', () => {
    const clock = fakeClock();
    const store = createMandateStore({ now: clock.now });
    store.set('approval-1', '0xsecret-session-key', clock.now() + 1000);
    expect(store.status('approval-1')).toEqual({ valid: true, expiresAt: clock.now() + 1000 });
    clock.advance(1000); // expiresAt is inclusive
    expect(store.status('approval-1')).toEqual({ valid: false });
    expect(store.status('never-registered')).toEqual({ valid: false });
  });
});
