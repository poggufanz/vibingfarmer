import { describe, expect, it, vi } from 'vitest';
import { createRelayerRouter, MAX_REQUEST_BODY_BYTES } from '../src/httpRouter.mjs';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value; },
    end(body = '') { this.body = body; },
  };
}

function routerWithSpies() {
  const business = vi.fn();
  const router = createRelayerRouter({
    buildFarm: business,
    jobs: new Map(),
    genId: vi.fn(),
    publicRuntime: { baseCrossChainAvailable: false },
  });
  return { router, business };
}

describe('relayer raw request body ceiling', () => {
  it('rejects declared bodies above 65536 bytes before parsing or dispatch', async () => {
    const { router, business } = routerWithSpies();
    const res = response();
    await router({
      method: 'POST',
      url: '/api/vf-cross/farm',
      headers: { 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) },
      async *[Symbol.asyncIterator]() { throw new Error('must not read'); },
    }, res);

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' });
    expect(business).not.toHaveBeenCalled();
  });

  it('rejects streamed bodies above 65536 bytes without retaining raw input', async () => {
    const { router, business } = routerWithSpies();
    const res = response();
    await router({
      method: 'POST',
      url: '/api/vf-cross/farm',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(MAX_REQUEST_BODY_BYTES);
        yield Buffer.from('T16-RAW-BODY-SENTINEL');
      },
    }, res);

    expect(res.statusCode).toBe(413);
    expect(res.body).not.toContain('T16-RAW-BODY-SENTINEL');
    expect(business).not.toHaveBeenCalled();
  });
});
