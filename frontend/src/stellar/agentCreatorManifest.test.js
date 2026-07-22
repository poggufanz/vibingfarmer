// Pocket Crew My Money Task 1 (Wave 2). Freezes the supported agent-creator manifest + the
// dev/test-only legacy-setup cutoff gate. Every address/hash below is copied verbatim from
// deployments/stellar-testnet.json (or its git history for retired values) — never an ellipsis —
// so a reviewer can diff this file against that JSON directly.
import { describe, it, expect } from 'vitest'
import { hash } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from '../strategy/canonicalStrategy.js'
import {
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_FINALITY_LEDGERS,
  AGENT_INDEX_MAX_LAG_MS,
  AGENT_CREATORS,
  AGENT_WASM_GENERATIONS,
  AGENT_CREATOR_MANIFEST_HASH,
  creatorForAddress,
  assertCompleteCreatorManifest,
  isLegacyDirectSetupAllowed,
} from './agentCreatorManifest.js'

const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const ROUTER_HARDENED_V1 = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const ROUTER_LEGACY = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const REGISTRY_CURRENT = 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB'
const REGISTRY_LEGACY = 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ'
const DEMO_AGENT_ACCOUNT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'

const WASM_V1 = '8c607112ba93ff289d30f2c894ca586c745328e5cb2ae6139917c6df540dda62'
const WASM_V2 = '7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717'
const WASM_V3 = 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'
const WASM_V3_BRIDGE = '1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1'

function sha256Hex(obj) {
  return '0x' + hash(JSON.stringify(canonicalizeStrategy(obj))).toString('hex')
}

describe('module constants', () => {
  it('pins the frozen schema/version/finality constants', () => {
    expect(AGENT_INDEX_SCHEMA_VERSION).toBe(1)
    expect(AGENT_CREATOR_MANIFEST_VERSION).toBe('stellar-testnet-2026-07-22-v1')
    expect(AGENT_INDEX_FINALITY_LEDGERS).toBe(2)
    expect(AGENT_INDEX_MAX_LAG_MS).toBe(20 * 60 * 1000)
  })
})

describe('AGENT_CREATORS', () => {
  it('has exactly the 5 frozen creators, by address', () => {
    expect(AGENT_CREATORS.map((c) => c.address).sort()).toEqual(
      [ROUTER_V2, ROUTER_HARDENED_V1, ROUTER_LEGACY, REGISTRY_CURRENT, REGISTRY_LEGACY].sort()
    )
  })

  it('pins router v2 exactly: kind, coverage ledger, deploy tx, supported wasm', () => {
    const c = creatorForAddress(ROUTER_V2)
    expect(c).toMatchObject({
      networkId: 'stellar-testnet',
      kind: 'funding-router',
      deployedLedger: 3727514,
      coverageStartLedger: 3727514,
      retiredLedger: null,
      deployTx: 'e8e145660c9923ec9433dc5e7906502ee9981977653a5b1907b34f14ead68e18',
      supportedAgentWasmHashes: [WASM_V3_BRIDGE],
    })
  })

  it('pins the hardened v1 router exactly: coverage ledger, deploy tx, supported wasm', () => {
    const c = creatorForAddress(ROUTER_HARDENED_V1)
    expect(c).toMatchObject({
      kind: 'funding-router',
      deployedLedger: 3593274,
      coverageStartLedger: 3593274,
      retiredLedger: null,
      deployTx: '826354384040f87a87c49ce714600e80c8a315ac8a9ebacecac72a75f13279e3',
      supportedAgentWasmHashes: [WASM_V3],
    })
  })

  it('keeps the legacy router conservative: null deployedLedger, floor coverage, real deploy tx', () => {
    const c = creatorForAddress(ROUTER_LEGACY)
    expect(c).toMatchObject({
      kind: 'funding-router',
      deployedLedger: null,
      coverageStartLedger: 1,
      deployTx: '10da369f4e5deb0178e4274a8e7da075e12a7ae085c55096a33976f7dc59b656',
      supportedAgentWasmHashes: [WASM_V2],
    })
  })

  it('pins the current registry exactly: coverage ledger, deploy tx, no pinned wasm', () => {
    const c = creatorForAddress(REGISTRY_CURRENT)
    expect(c).toMatchObject({
      kind: 'registry',
      deployedLedger: 3593289,
      coverageStartLedger: 3593289,
      retiredLedger: null,
      deployTx: '3fdfc5e7dcc30b0145a84d6106a5956e46f3441c1f1deac8b8782015f34245b0',
      supportedAgentWasmHashes: [],
    })
  })

  it('keeps the legacy registry conservative with an explicit absent-evidence deploy tx (null, never invented)', () => {
    const c = creatorForAddress(REGISTRY_LEGACY)
    expect(c).toMatchObject({
      kind: 'registry',
      deployedLedger: null,
      coverageStartLedger: 1,
      deployTx: null,
      supportedAgentWasmHashes: [],
    })
  })

  it('every discoverySources entry is a non-empty array of known values', () => {
    const KNOWN = ['router-event', 'registry-event', 'vault-event', 'horizon-history']
    for (const c of AGENT_CREATORS) {
      expect(Array.isArray(c.discoverySources)).toBe(true)
      expect(c.discoverySources.length).toBeGreaterThan(0)
      for (const s of c.discoverySources) expect(KNOWN).toContain(s)
    }
  })
})

describe('AGENT_WASM_GENERATIONS', () => {
  it('has exactly the 4 frozen generations, by wasmHash', () => {
    expect(AGENT_WASM_GENERATIONS.map((g) => g.wasmHash).sort()).toEqual(
      [WASM_V1, WASM_V2, WASM_V3, WASM_V3_BRIDGE].sort()
    )
  })

  it('agent-v1 has no creator (pre-router demo agent) and no known upload tx', () => {
    const g = AGENT_WASM_GENERATIONS.find((x) => x.wasmHash === WASM_V1)
    expect(g).toMatchObject({ generation: 'agent-v1', uploadTx: null, uploadedLedger: null })
    expect(g.creatorAddresses).toEqual([])
  })

  it('agent-v2 was uploaded/created by the legacy router, with resolved ledger evidence', () => {
    const g = AGENT_WASM_GENERATIONS.find((x) => x.wasmHash === WASM_V2)
    expect(g).toMatchObject({
      generation: 'agent-v2',
      uploadTx: 'c84f563290f7d2ef459e91ce6b179f53f19a068871e3ba8071df09c7c56a44db',
    })
    expect(g.uploadedLedger).toBeGreaterThan(0)
    expect(g.creatorAddresses).toEqual([ROUTER_LEGACY])
  })

  it('agent-v3 was uploaded/created by the hardened v1 router, with resolved ledger evidence', () => {
    const g = AGENT_WASM_GENERATIONS.find((x) => x.wasmHash === WASM_V3)
    expect(g).toMatchObject({
      generation: 'agent-v3',
      uploadTx: 'd52f0ba0f5598b1ccf6d0036c152072f4b4cb23449f6af0e9d733850ff59b63f',
    })
    expect(g.uploadedLedger).toBeGreaterThan(0)
    expect(g.creatorAddresses).toEqual([ROUTER_HARDENED_V1])
  })

  it('agent-v3-bridge was uploaded/created by router v2, with resolved ledger evidence', () => {
    const g = AGENT_WASM_GENERATIONS.find((x) => x.wasmHash === WASM_V3_BRIDGE)
    expect(g).toMatchObject({
      generation: 'agent-v3-bridge',
      uploadTx: 'c8a9bc3b434f4d65e35926dcbe28207ef909d15230c204f94f390f2fb5144451',
    })
    expect(g.uploadedLedger).toBeGreaterThan(0)
    expect(g.creatorAddresses).toEqual([ROUTER_V2])
  })

  it('every creatorAddresses entry names a real AGENT_CREATORS record', () => {
    const known = new Set(AGENT_CREATORS.map((c) => c.address))
    for (const g of AGENT_WASM_GENERATIONS) {
      for (const addr of g.creatorAddresses) expect(known.has(addr)).toBe(true)
    }
  })
})

describe('AGENT_CREATOR_MANIFEST_HASH', () => {
  it('is a 0x-prefixed sha256 hex string recomputable from the raw arrays', () => {
    const recomputed = sha256Hex({
      version: AGENT_CREATOR_MANIFEST_VERSION,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: AGENT_CREATORS,
      wasmGenerations: AGENT_WASM_GENERATIONS,
    })
    expect(AGENT_CREATOR_MANIFEST_HASH).toMatch(/^0x[0-9a-f]{64}$/)
    expect(AGENT_CREATOR_MANIFEST_HASH).toBe(recomputed)
  })

  it('is sensitive to a changed creator address (would require a deliberate version bump)', () => {
    const mutated = sha256Hex({
      version: AGENT_CREATOR_MANIFEST_VERSION,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: AGENT_CREATORS.map((c, i) => (i === 0 ? { ...c, address: 'CDIFFERENT' } : c)),
      wasmGenerations: AGENT_WASM_GENERATIONS,
    })
    expect(mutated).not.toBe(AGENT_CREATOR_MANIFEST_HASH)
  })

  it('is sensitive to a changed coverage ledger', () => {
    const mutated = sha256Hex({
      version: AGENT_CREATOR_MANIFEST_VERSION,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: AGENT_CREATORS.map((c, i) =>
        i === 0 ? { ...c, coverageStartLedger: c.coverageStartLedger + 1 } : c
      ),
      wasmGenerations: AGENT_WASM_GENERATIONS,
    })
    expect(mutated).not.toBe(AGENT_CREATOR_MANIFEST_HASH)
  })

  it('is sensitive to a changed wasm generation', () => {
    const mutated = sha256Hex({
      version: AGENT_CREATOR_MANIFEST_VERSION,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: AGENT_CREATORS,
      wasmGenerations: AGENT_WASM_GENERATIONS.map((g, i) =>
        i === 0 ? { ...g, generation: 'agent-v2' } : g
      ),
    })
    expect(mutated).not.toBe(AGENT_CREATOR_MANIFEST_HASH)
  })
})

describe('creatorForAddress', () => {
  it('finds every frozen creator by address', () => {
    for (const c of AGENT_CREATORS) expect(creatorForAddress(c.address)).toBe(c)
  })

  it('returns null for the seeded demo agent — historical explorer data, never an owner fallback', () => {
    expect(creatorForAddress(DEMO_AGENT_ACCOUNT)).toBeNull()
  })

  it('returns null for an address that names no known creator', () => {
    expect(creatorForAddress('CUNKNOWNADDRESS')).toBeNull()
  })
})

describe('assertCompleteCreatorManifest', () => {
  it('accepts the live frozen manifest', () => {
    expect(assertCompleteCreatorManifest()).toBe(true)
    expect(
      assertCompleteCreatorManifest({
        creators: AGENT_CREATORS,
        wasmGenerations: AGENT_WASM_GENERATIONS,
      })
    ).toBe(true)
  })

  it('rejects a ledger value of 0 (never a valid ledger)', () => {
    const creators = AGENT_CREATORS.map((c, i) => (i === 0 ? { ...c, deployedLedger: 0 } : c))
    expect(() =>
      assertCompleteCreatorManifest({ creators, wasmGenerations: AGENT_WASM_GENERATIONS })
    ).toThrow(/invalid deployedLedger/)
  })

  it('rejects a creator with no coverageStartLedger (unbounded current creator)', () => {
    const creators = AGENT_CREATORS.map((c, i) =>
      i === 0 ? { ...c, coverageStartLedger: null } : c
    )
    expect(() =>
      assertCompleteCreatorManifest({ creators, wasmGenerations: AGENT_WASM_GENERATIONS })
    ).toThrow(/unbounded\/invalid coverageStartLedger/)
  })

  it('rejects a non-conservative coverage start with no deploy transaction', () => {
    const creators = AGENT_CREATORS.map((c, i) => (i === 0 ? { ...c, deployTx: null } : c))
    expect(() =>
      assertCompleteCreatorManifest({ creators, wasmGenerations: AGENT_WASM_GENERATIONS })
    ).toThrow(/without a deploy transaction/)
  })

  it('rejects a wasm generation naming an unknown creator address', () => {
    const wasmGenerations = AGENT_WASM_GENERATIONS.map((g, i) =>
      i === 0 ? { ...g, creatorAddresses: ['CNOTREAL'] } : g
    )
    expect(() =>
      assertCompleteCreatorManifest({ creators: AGENT_CREATORS, wasmGenerations })
    ).toThrow(/unknown creator/)
  })

  it('rejects a malformed wasm hash', () => {
    const wasmGenerations = AGENT_WASM_GENERATIONS.map((g, i) =>
      i === 0 ? { ...g, wasmHash: 'not-hex' } : g
    )
    expect(() =>
      assertCompleteCreatorManifest({ creators: AGENT_CREATORS, wasmGenerations })
    ).toThrow(/invalid wasmHash/)
  })
})

describe('isLegacyDirectSetupAllowed', () => {
  it('is always false in production, regardless of the client flag', () => {
    expect(isLegacyDirectSetupAllowed({ mode: 'production', explicitFlag: 'true' })).toBe(false)
    expect(isLegacyDirectSetupAllowed({ mode: 'production', explicitFlag: true })).toBe(false)
    expect(isLegacyDirectSetupAllowed({ mode: 'production', explicitFlag: undefined })).toBe(false)
  })

  it('is true in dev/test ONLY with the explicit flag set (string "true" — a real Vite env value)', () => {
    expect(isLegacyDirectSetupAllowed({ mode: 'development', explicitFlag: 'true' })).toBe(true)
    expect(isLegacyDirectSetupAllowed({ mode: 'test', explicitFlag: 'true' })).toBe(true)
    expect(isLegacyDirectSetupAllowed({ mode: 'test', explicitFlag: true })).toBe(true)
  })

  it('is false in dev/test when the flag is absent, false, or "false"', () => {
    expect(isLegacyDirectSetupAllowed({ mode: 'development', explicitFlag: undefined })).toBe(false)
    expect(isLegacyDirectSetupAllowed({ mode: 'test', explicitFlag: 'false' })).toBe(false)
    expect(isLegacyDirectSetupAllowed({ mode: 'test', explicitFlag: false })).toBe(false)
    expect(isLegacyDirectSetupAllowed({})).toBe(false)
  })
})
