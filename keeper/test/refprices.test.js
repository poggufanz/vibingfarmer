// keeper/test/refprices.test.js
import { describe, it, expect, vi } from 'vitest';
import { createRefPrices, pickPath } from '../src/refprices.js';

describe('pickPath', () => {
  it('walks dot paths', () => {
    expect(pickPath({ 'usd-coin': { usd: 0.9997 } }, 'usd-coin.usd')).toBe(0.9997);
    expect(pickPath({ price: 1 }, '')).toBe(1); // no fragment -> {"price": N} contract
  });
});

describe('createRefPrices', () => {
  const CG = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd#usd-coin.usd';

  it('static LIFEBOAT_REF_PRICE short-circuits (demo mode unchanged)', async () => {
    const refPrices = createRefPrices({ LIFEBOAT_REF_PRICE: '1.0' }, { fetchImpl: vi.fn() });
    expect(await refPrices()).toEqual([1]);
  });

  it('fetches, parses via fragment path, and caches for 60s', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ 'usd-coin': { usd: 0.9998 } }) }));
    const refPrices = createRefPrices({ LIFEBOAT_REF_URLS: CG }, { fetchImpl, now: () => t });
    expect(await refPrices()).toEqual([0.9998]);
    t = 30_000;
    await refPrices();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached — radar polls every ~6s, feeds must not be hammered
    t = 61_000;
    await refPrices();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('all sources failing -> null (radar alarms rather than acts)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    const refPrices = createRefPrices({ LIFEBOAT_REF_URLS: CG }, { fetchImpl, now: () => 0 });
    expect(await refPrices()).toBeNull();
  });

  it('no env -> null (detector off, same as today)', async () => {
    const refPrices = createRefPrices({}, { fetchImpl: vi.fn() });
    expect(await refPrices()).toBeNull();
  });
});
