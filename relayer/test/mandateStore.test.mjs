import { describe, it, expect } from 'vitest';
import { createMandateStore, createMandateStoreV2 } from '../src/mandateStore.mjs';

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

// VF Wallet Task 7: the owner/kernel-bound sibling store. Key lookup/delete is by
// (serializedApproval, stellarOwner, kernelAddress) together, not approval alone — a row
// registered for owner A + kernel K1 must be invisible to a lookup for owner A + kernel K2, or
// owner B + kernel K1 (Step 5 acceptance: "owner A approval cannot execute for owner B or a
// second kernel"). The legacy createMandateStore above is untouched and still exported for
// rollback; this is an ADDITIVE sibling, never a replacement of it.
describe('createMandateStoreV2', () => {
  const rec = (over = {}) => ({
    serializedApproval: 'approval-1',
    sessionPrivateKey: '0xsecret-session-key',
    sessionKeyAddress: '0xSessionKey',
    stellarOwner: 'GOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    kernelAddress: '0xKernelA',
    relayerOrigin: 'https://relayer.example',
    expiresAt: 2_000_000,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: 'hash-1',
    createdAt: 1_000_000,
    ...over,
  });

  it('round-trips the full record, keyed on approval+owner+kernel together', () => {
    const store = createMandateStoreV2({ now: () => 1_500_000 });
    store.set(rec());
    expect(store.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
      .toEqual(rec());
    expect(store.size).toBe(1);
  });

  it('the same approval registered under a different kernel is a distinct row — owner A cannot reach it for kernel K2', () => {
    const store = createMandateStoreV2({ now: () => 1_500_000 });
    store.set(rec());
    expect(store.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelB' }))
      .toBeUndefined();
  });

  it('the same approval registered under a different Stellar owner is a distinct row — owner B cannot reach owner A\'s binding', () => {
    const store = createMandateStoreV2({ now: () => 1_500_000 });
    store.set(rec());
    expect(store.get({ serializedApproval: 'approval-1', stellarOwner: 'GOTHEROWNERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', kernelAddress: '0xKernelA' }))
      .toBeUndefined();
  });

  it('get() lazily evicts and returns undefined once expiresAt has passed', () => {
    let t = 1_500_000;
    const store = createMandateStoreV2({ now: () => t });
    store.set(rec());
    t = 2_000_000; // expiresAt is inclusive
    expect(store.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
      .toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('status() reports the full BaseMandateStatusV2 shape WITHOUT sessionPrivateKey', () => {
    const store = createMandateStoreV2({ now: () => 1_500_000 });
    store.set(rec());
    const status = store.status({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' });
    expect(status).toEqual({
      stellarOwner: rec().stellarOwner,
      kernelAddress: '0xKernelA',
      sessionKeyAddress: '0xSessionKey',
      relayerOrigin: 'https://relayer.example',
      expiresAt: 2_000_000,
      status: 'active',
      bindingId: 'binding-1',
      bindingHash: 'hash-1',
    });
    expect(JSON.stringify(status)).not.toContain('0xsecret-session-key');
  });

  it('status() reports "expired" once past expiresAt, and "missing" for an unregistered triple', () => {
    let t = 1_500_000;
    const store = createMandateStoreV2({ now: () => t });
    store.set(rec());
    t = 2_000_000;
    expect(store.status({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }).status)
      .toBe('expired');
    expect(store.status({ serializedApproval: 'never-registered', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
      .toEqual({
        stellarOwner: null, kernelAddress: null, sessionKeyAddress: null, relayerOrigin: null,
        expiresAt: null, status: 'missing', bindingId: null, bindingHash: null,
      });
  });

  it('delete() removes the exact triple only, leaving other kernels/owners on the same approval untouched', () => {
    const store = createMandateStoreV2({ now: () => 1_500_000 });
    store.set(rec());
    store.set(rec({ kernelAddress: '0xKernelB' }));
    expect(store.delete({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' })).toBe(true);
    expect(store.delete({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' })).toBe(false);
    expect(store.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelB' })).toBeDefined();
    expect(store.size).toBe(1);
  });

  it('sweep drops every expired row and returns the removed count', () => {
    let t = 1_000_000;
    const store = createMandateStoreV2({ now: () => t });
    store.set(rec({ kernelAddress: '0xKernelA', expiresAt: 1_100_000 }));
    store.set(rec({ kernelAddress: '0xKernelB', expiresAt: 9_000_000 }));
    t = 1_200_000;
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(1);
  });
});
