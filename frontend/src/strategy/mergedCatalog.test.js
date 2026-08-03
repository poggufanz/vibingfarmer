import { describe, it, expect, vi } from 'vitest'
import { buildMergedCatalog, checkRelayerHealth } from './mergedCatalog.js'
import { VAULT_CATALOG, BASE_POOL_CATALOG } from '../config.js'
import { venueDisclosure, venueYield, normalizeVenue } from './venueTruth.js'

describe('buildMergedCatalog', () => {
  it('returns only stellar entries when base unavailable', () => {
    const cat = buildMergedCatalog({ baseAvailable: false })
    expect(cat).toHaveLength(VAULT_CATALOG.length)
    expect(cat.every((v) => v.chain === 'stellar')).toBe(true)
  })
  it('appends chain-tagged base pools when available', () => {
    const cat = buildMergedCatalog({ baseAvailable: true })
    expect(cat).toHaveLength(VAULT_CATALOG.length + BASE_POOL_CATALOG.length)
    expect(cat.filter((v) => v.chain === 'base')).toHaveLength(BASE_POOL_CATALOG.length)
  })
  it('prefers liveVaults for the stellar side', () => {
    const live = [{ name: 'Live', protocol: 'aave-v3', address: 'CLIVE', apy: 5 }]
    const cat = buildMergedCatalog({ baseAvailable: false, liveVaults: live })
    expect(cat).toHaveLength(1)
    expect(cat[0]).toMatchObject({ address: 'CLIVE', chain: 'stellar' })
  })
})

describe('buildMergedCatalog — truthful venue records (Strategy Task 1)', () => {
  it('the executable Stellar-side catalog is exactly one live venue with real truth fields', () => {
    const cat = buildMergedCatalog({ baseAvailable: false })
    expect(cat).toHaveLength(1)
    expect(cat[0]).toMatchObject({
      name: 'Vibing Farmer Autofarm',
      address: VAULT_CATALOG[0].address,
      destination: 'Autofarm Vault to Blend Capital v2',
      networkId: 'stellar-testnet',
      venueKind: 'stellar-live',
    })
  })

  it('never elevates the static catalog apy to live/current yield', () => {
    const cat = buildMergedCatalog({ baseAvailable: false })
    expect(cat[0].yield).toEqual({ state: 'unavailable', apy: null })
  })

  it('stamps stellar-live truth onto liveVaults even when a fetched entry names a mainnet persona', () => {
    // liveVaults simulates a DeFiLlama-style fetch (e.g. defiLlama.js) that still carries a
    // reference-protocol string — the merged catalog must not let that string overwrite where
    // execution/yield truth actually lands.
    const live = [{ name: 'Aave v3 USDC', protocol: 'aave-v3', address: 'CLIVE', apy: 4.8 }]
    const cat = buildMergedCatalog({ baseAvailable: false, liveVaults: live })
    expect(cat[0]).toMatchObject({
      address: 'CLIVE',
      chain: 'stellar',
      networkId: 'stellar-testnet',
      venueKind: 'stellar-live',
      destination: 'Autofarm Vault to Blend Capital v2',
    })
    expect(cat[0].yield).toEqual({ state: 'unavailable', apy: null })
  })

  it('base pools normalize to custody-only proxy truth, never a live Aave/Morpho/Moonwell claim', () => {
    const cat = buildMergedCatalog({ baseAvailable: true })
    const base = cat.filter((v) => v.chain === 'base')
    expect(base).toHaveLength(BASE_POOL_CATALOG.length)
    for (const v of base) {
      expect(v.venueKind).toBe('base-custody-proxy')
      expect(v.yield).toEqual({ state: 'none', apy: null })
      expect(v.disclosure).toBe('Base Sepolia proxy. Custody only. No protocol yield.')
    }
  })

  it('a base pool with a supplied apy: 99 still normalizes to yield.state="none", apy=null', () => {
    // The exact poisoned-input regression the brief calls out, exercised through the same
    // stamping path buildMergedCatalog uses (normalizeVenue), not a hand-rolled equivalent.
    const poisoned = { ...BASE_POOL_CATALOG[0], apy: 99, venueKind: 'base-custody-proxy' }
    expect(normalizeVenue(poisoned).yield).toEqual({ state: 'none', apy: null })
    // And the real merged-catalog output (whose base side never carries a static apy at all
    // post-Task-1) stays poison-proof too.
    const cat = buildMergedCatalog({ baseAvailable: true })
    expect(cat.find((v) => v.chain === 'base').yield).toEqual({ state: 'none', apy: null })
  })

  it('regression: serialized strategist input, council input, and rendered disclosure all derive from the same normalized record', () => {
    const cat = buildMergedCatalog({ baseAvailable: true })
    for (const record of cat) {
      // "Serialized strategist input" — strategist.js JSON.stringifies the merged catalog
      // straight into the AI system prompt (see strategist.js's [VAULT_CATALOG_JSON] splice).
      const strategistInput = JSON.parse(JSON.stringify(record))
      // "Council input" — no council code consumes catalog records yet (Strategy Task 1 only
      // establishes the shared truth record every later task, including council wiring, must
      // read); a future council consumer would receive this exact same merged-catalog record.
      const councilInput = record
      const renderedDisclosure = venueDisclosure(record)

      expect(strategistInput.disclosure).toBe(renderedDisclosure)
      expect(venueDisclosure(councilInput)).toBe(renderedDisclosure)
      expect(strategistInput.yield).toEqual(venueYield(record))
      if (record.venueKind === 'base-custody-proxy') {
        expect(strategistInput.yield).toEqual({ state: 'none', apy: null })
      }
    }
  })
})

describe('checkRelayerHealth', () => {
  it('healthy on 404 unknown-jobId', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ status: 404, ok: false, json: async () => ({ error: 'unknown jobId' }) })
    expect(await checkRelayerHealth({ fetchImpl })).toBe(true)
  })
  it('unhealthy on 503 relayer-not-configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 503,
      ok: false,
      json: async () => ({ error: 'relayer not configured' }),
    })
    expect(await checkRelayerHealth({ fetchImpl })).toBe(false)
  })
  it('unhealthy on network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await checkRelayerHealth({ fetchImpl })).toBe(false)
  })
  it('probes with an abort signal so the caller can bound/cancel it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ status: 404, ok: false, json: async () => ({ error: 'unknown jobId' }) })
    await checkRelayerHealth({ fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, opts] = fetchImpl.mock.calls[0]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })
  it('unhealthy (fail-closed) when aborted/timed out', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    const fetchImpl = vi.fn().mockRejectedValue(abortError)
    expect(await checkRelayerHealth({ fetchImpl, timeoutMs: 1 })).toBe(false)
  })
})
