// relayer/test/ingressLimit.test.mjs
import { describe, it, expect, vi } from 'vitest';
import {
  clientIpOf,
  createIngressLimiter,
  ingressLimitFromEnv,
  withIngressLimit,
} from '../src/server.mjs';

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b || ''; } };
  return res;
}

function fakeReq(ip, method = 'POST') {
  return { method, url: '/api/vf-cross/mandate', headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '10.0.0.9' } };
}

describe('clientIpOf', () => {
  it('prefers the first x-forwarded-for entry', () => {
    expect(clientIpOf(fakeReq('203.0.113.7, 70.0.0.1'))).toBe('203.0.113.7');
  });
  it('falls back to the socket address, then unknown', () => {
    expect(clientIpOf({ headers: {}, socket: { remoteAddress: '10.0.0.9' } })).toBe('10.0.0.9');
    expect(clientIpOf({ headers: {}, socket: {} })).toBe('unknown');
  });
});

describe('ingressLimitFromEnv', () => {
  it('defaults to 60/min and rejects malformed values', () => {
    expect(ingressLimitFromEnv({})).toEqual({ max: 60, windowMs: 60_000 });
    expect(ingressLimitFromEnv({ RELAYER_INGRESS_MAX_PER_MIN: 'nope', RELAYER_INGRESS_WINDOW_MS: '-5' })).toEqual({ max: 60, windowMs: 60_000 });
    expect(ingressLimitFromEnv({ RELAYER_INGRESS_MAX_PER_MIN: '5', RELAYER_INGRESS_WINDOW_MS: '1000' })).toEqual({ max: 5, windowMs: 1000 });
  });
});

describe('createIngressLimiter', () => {
  it('allows under the limit, 429 + Retry-After over it', () => {
    const allow = createIngressLimiter({ max: 2, windowMs: 60_000, now: () => 1_000 });
    const req = fakeReq('203.0.113.8');
    expect(allow(req, fakeRes())).toBe(true);
    expect(allow(req, fakeRes())).toBe(true);
    const res = fakeRes();
    expect(allow(req, res)).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
    expect(JSON.parse(res.body)).toEqual({ error: 'Too many requests' });
  });
  it('isolates buckets per IP and resets after the window', () => {
    let t = 0;
    const allow = createIngressLimiter({ max: 1, windowMs: 1_000, now: () => t });
    expect(allow(fakeReq('203.0.113.9'), fakeRes())).toBe(true);
    expect(allow(fakeReq('203.0.113.9'), fakeRes())).toBe(false);
    expect(allow(fakeReq('203.0.113.10'), fakeRes())).toBe(true);
    t = 2_000;
    expect(allow(fakeReq('203.0.113.9'), fakeRes())).toBe(true);
  });
  it('exempts OPTIONS preflights', () => {
    const allow = createIngressLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    const preflight = fakeReq('203.0.113.11', 'OPTIONS');
    for (let i = 0; i < 5; i += 1) expect(allow(preflight, fakeRes())).toBe(true);
  });
});

describe('withIngressLimit', () => {
  it('passes through under the limit and never runs inner past it', async () => {
    const inner = vi.fn(async (req, res) => { res.statusCode = 200; res.end('ok'); });
    const wrapped = withIngressLimit(inner, { max: 1, windowMs: 60_000, now: () => 0 });
    const first = fakeRes();
    await wrapped(fakeReq('203.0.113.12'), first);
    expect(first.statusCode).toBe(200);
    const second = fakeRes();
    await wrapped(fakeReq('203.0.113.12'), second);
    expect(second.statusCode).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
