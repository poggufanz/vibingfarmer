// relayer/test/serverAuth.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { withProxyKeyAuth } from '../src/server.mjs';

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b || ''; } };
  return res;
}

describe('withProxyKeyAuth', () => {
  const inner = async (req, res) => { res.statusCode = 200; res.end('ok'); };

  it('no key configured -> passthrough (local dev unchanged)', async () => {
    const res = fakeRes();
    await withProxyKeyAuth(inner, '')({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
  });

  it('key configured + wrong/missing header -> 401, inner never runs', async () => {
    const res = fakeRes();
    await withProxyKeyAuth(inner, 'sekret')({ headers: { 'x-vf-relayer-key': 'nope' } }, res);
    expect(res.statusCode).toBe(401);
    const res2 = fakeRes();
    await withProxyKeyAuth(inner, 'sekret')({ headers: {} }, res2);
    expect(res2.statusCode).toBe(401);
  });

  it('key configured + correct header -> passthrough', async () => {
    const res = fakeRes();
    await withProxyKeyAuth(inner, 'sekret')({ headers: { 'x-vf-relayer-key': 'sekret' } }, res);
    expect(res.statusCode).toBe(200);
  });

  it('accepts only current or one previous exact key during overlap', async () => {
    const current = 'a'.repeat(64);
    const previous = 'b'.repeat(64);
    const handler = vi.fn(inner);
    const wrapped = withProxyKeyAuth(handler, { current, previous });

    const oldRes = fakeRes();
    await wrapped({ headers: { 'x-vf-relayer-key': previous } }, oldRes);
    expect(oldRes.statusCode).toBe(200);
    const currentRes = fakeRes();
    await wrapped({ headers: { 'x-vf-relayer-key': current } }, currentRes);
    expect(currentRes.statusCode).toBe(200);
    const badRes = fakeRes();
    await wrapped({ headers: { 'x-vf-relayer-key': 'c'.repeat(64) } }, badRes);
    expect(badRes.statusCode).toBe(401);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('evaluates both current and previous candidates even after a match', async () => {
    const current = 'a'.repeat(64);
    const previous = 'b'.repeat(64);
    let outcomes = [true, false];
    const compare = vi.fn(() => outcomes.shift() ?? false);
    const wrapped = withProxyKeyAuth(vi.fn(inner), { current, previous }, { compare });

    const res = fakeRes();
    await wrapped({ headers: { 'x-vf-relayer-key': current } }, res);
    expect(compare).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);

    outcomes = [false, false];
    compare.mockClear();
    const mismatch = fakeRes();
    await wrapped({ headers: { 'x-vf-relayer-key': 'c'.repeat(64) } }, mismatch);
    expect(compare).toHaveBeenCalledTimes(2);
    expect(mismatch.statusCode).toBe(401);
  });
});
