// relayer/test/serverAuth.test.mjs
import { describe, it, expect } from 'vitest';
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
});
