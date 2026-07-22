// Pocket Crew My Money Task 1 (Wave 2). Freezes the FULL set of Stellar-testnet contracts this
// app trusts as "creators" of an agent_account — a funding_router (deploys agents via grant) or a
// registry (vouches for an already-deployed agent's on-chain scope) — plus every agent_account
// wasm generation those creators have ever pinned. Downstream index Tasks 2-4 read this module as
// the single source of truth for "is this address/wasm one we know about", never re-deriving it.
//
// Every address/hash/tx below is copied VERBATIM from deployments/stellar-testnet.json (and, for
// retired/superseded values no longer in the live file, from its git history — see
// .superpowers/sdd/pocket-crew-mm-task-1-report.md for the exact commits). Where the tracked
// record genuinely never recorded a value (the legacy registry's deploy tx; agent-v1's upload
// tx — both predate this project tracking that metadata at all), the field is `null`, never a
// guess — an explicit "unavailable" proof state, not a hole silently filled in later.
//
// Ledger numbers were verified live against testnet via scripts/resolve-agent-creator-ledgers.mjs
// (read-only; never rewrites this file or deployments/stellar-testnet.json — see that script's
// header and the Task 1 report for the run transcript). The two "legacy, pre-hardening" creators
// deliberately keep `deployedLedger: null` + `coverageStartLedger: 1` even though their deploy tx
// (where known) DOES resolve to a real ledger — this repo has not back-filled/archived proof that
// EVERY agent either of them ever created is indexed, so their coverage window stays maximally
// conservative (ledger 1 forward) rather than claiming a precise start we can't fully back.
import { hash } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from '../strategy/canonicalStrategy.js'

export const AGENT_INDEX_SCHEMA_VERSION = 1
export const AGENT_CREATOR_MANIFEST_VERSION = 'stellar-testnet-2026-07-22-v1'
// Finality margin an index consumer should wait before treating a creator-emitted event as
// settled (small, fast-finality Soroban network — 2 ledgers is already generous).
export const AGENT_INDEX_FINALITY_LEDGERS = 2
// Max age an index is allowed to lag the chain tip before a consumer must treat it as stale.
export const AGENT_INDEX_MAX_LAG_MS = 20 * 60 * 1000

const FUNDING_ROUTER = 'funding-router'
const REGISTRY = 'registry'

/** @type {Array<import('./agentCreatorManifest').AgentCreatorV1>} */
export const AGENT_CREATORS = [
  {
    // funding_router v2 — LIVE default (grant-covers-burn: multi-token budgets + bridge-kind
    // AgentInit). deployments/stellar-testnet.json fundingRouter.addressV2 / .v2Note.
    networkId: 'stellar-testnet',
    address: 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE',
    kind: FUNDING_ROUTER,
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    deployedLedger: 3727514,
    coverageStartLedger: 3727514,
    retiredLedger: null, // live — dual-support alongside the hardened v1 router below
    deployTx: 'e8e145660c9923ec9433dc5e7906502ee9981977653a5b1907b34f14ead68e18',
    supportedAgentWasmHashes: ['1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1'],
    discoverySources: ['router-event'],
  },
  {
    // funding_router hardened v1 — 2026-07-14 security-hardening redeploy (no admin/upgrade path,
    // owner-bound deployment salts). Still live: relay dual-supports it alongside v2 above.
    networkId: 'stellar-testnet',
    address: 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5',
    kind: FUNDING_ROUTER,
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    deployedLedger: 3593274,
    coverageStartLedger: 3593274,
    retiredLedger: null,
    deployTx: '826354384040f87a87c49ce714600e80c8a315ac8a9ebacecac72a75f13279e3',
    supportedAgentWasmHashes: ['d61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'],
    discoverySources: ['router-event'],
  },
  {
    // funding_router legacy (pre-hardening, 2026-07-10 "first one-popup factory"). Superseded by
    // the hardened v1 router above; kept in the manifest for historical grant discovery. Its
    // `Deployed` event schema HAS a committed fixture (routerEvents.js/.test.js was pinned via a
    // live probe against this exact address), so it is admitted — but ledger evidence stays
    // conservative (see module header).
    networkId: 'stellar-testnet',
    address: 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY',
    kind: FUNDING_ROUTER,
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    deployedLedger: null,
    coverageStartLedger: 1,
    retiredLedger: null,
    deployTx: '10da369f4e5deb0178e4274a8e7da075e12a7ae085c55096a33976f7dc59b656',
    supportedAgentWasmHashes: ['7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717'],
    discoverySources: ['router-event'],
  },
  {
    // registry — hardened 2026-07-14 redeploy. NEW derived-record ABI: authorize(agent) reads the
    // agent's own scope_of(); never pins a specific agent wasm itself (any agent whose scope it
    // can read qualifies), hence no supportedAgentWasmHashes.
    networkId: 'stellar-testnet',
    address: 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB',
    kind: REGISTRY,
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    deployedLedger: 3593289,
    coverageStartLedger: 3593289,
    retiredLedger: null,
    deployTx: '3fdfc5e7dcc30b0145a84d6106a5956e46f3441c1f1deac8b8782015f34245b0',
    supportedAgentWasmHashes: [],
    discoverySources: ['registry-event'],
  },
  {
    // registry legacy (pre-hardening, old owner-supplied authorize ABI). deployments/
    // stellar-testnet.json only ever recorded a bare address for this one — no deploy tx was
    // ever tracked at deploy time (git history confirms: it first appears as a bare string in the
    // very first deploy-seed commit) — genuinely unavailable evidence, not a lookup gap.
    networkId: 'stellar-testnet',
    address: 'CAEHOZGUGVNRCAFVJCSR3B2EFJ55LEA34S76HTRQGH7XSPBO7YIMNZOQ',
    kind: REGISTRY,
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    deployedLedger: null,
    coverageStartLedger: 1,
    retiredLedger: null,
    deployTx: null,
    supportedAgentWasmHashes: [],
    discoverySources: ['registry-event'],
  },
]

/** @type {Array<import('./agentCreatorManifest').AgentWasmGenerationV1>} */
export const AGENT_WASM_GENERATIONS = [
  {
    // Pins ONLY the pre-seeded demoAgentAccount (deployments/stellar-testnet.json demoAgentNote).
    // Predates the funding_router entirely — deployed directly (deploy-seed.sh), never by a
    // tracked creator contract, so it has no creatorAddresses and no upload tx was ever recorded.
    networkId: 'stellar-testnet',
    wasmHash: '8c607112ba93ff289d30f2c894ca586c745328e5cb2ae6139917c6df540dda62',
    uploadTx: null,
    uploadedLedger: null,
    generation: 'agent-v1',
    creatorAddresses: [],
  },
  {
    // "First one-popup factory" generation — constructor-pinned by the legacy funding_router.
    networkId: 'stellar-testnet',
    wasmHash: '7ced45e735e7e084d96d6a04df7cec6e07bc2b203eedb4d3422949a7e9cca717',
    uploadTx: 'c84f563290f7d2ef459e91ce6b179f53f19a068871e3ba8071df09c7c56a44db',
    uploadedLedger: 3534437, // resolved via scripts/resolve-agent-creator-ledgers.mjs (Horizon)
    generation: 'agent-v2',
    creatorAddresses: ['CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'],
  },
  {
    // Hardened generation (on-chain enforced revoke, owner_withdraw terminal exit, scope_of()).
    networkId: 'stellar-testnet',
    wasmHash: 'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba',
    uploadTx: 'd52f0ba0f5598b1ccf6d0036c152072f4b4cb23449f6af0e9d733850ff59b63f',
    uploadedLedger: 3593271, // resolved via scripts/resolve-agent-creator-ledgers.mjs (Horizon)
    generation: 'agent-v3',
    creatorAddresses: ['CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'],
  },
  {
    // grant-covers-burn generation: rebuilt with bridge-scope fields (target/kind/mint_recipient/
    // destination_domain, deposit_for_burn enforcement) alongside funding_router v2.
    networkId: 'stellar-testnet',
    wasmHash: '1fdbe175ddeb6d237a178c3c117b4e6c168122eec7d94f06a4b27ee4026efbe1',
    uploadTx: 'c8a9bc3b434f4d65e35926dcbe28207ef909d15230c204f94f390f2fb5144451',
    uploadedLedger: 3727511, // resolved via scripts/resolve-agent-creator-ledgers.mjs (RPC)
    generation: 'agent-v3-bridge',
    creatorAddresses: ['CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'],
  },
]

/** Deterministic 0x-prefixed sha256 fingerprint over the frozen manifest content (same key-sorted
 * canonicalization the rest of Strategy Wave 1 uses for hashing — see canonicalStrategy.js). Any
 * change to an address, schema, wasm hash, or coverage ledger changes this hash, which is exactly
 * the point: bumping it requires a deliberate AGENT_CREATOR_MANIFEST_VERSION update alongside it. */
function computeManifestHash() {
  // ponytail: canonicalizeStrategy's EXCLUDED_KEYS denylist (timestamp/createdAt/updatedAt/…)
  // silently drops any manifest field that happens to share one of those names — harmless today
  // (no such field exists here), but a future field literally named e.g. `createdAt` would go
  // unhashed without a loud failure. Revisit if this manifest ever grows a field on that list.
  const payload = JSON.stringify(
    canonicalizeStrategy({
      version: AGENT_CREATOR_MANIFEST_VERSION,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      creators: AGENT_CREATORS,
      wasmGenerations: AGENT_WASM_GENERATIONS,
    })
  )
  return '0x' + hash(payload).toString('hex')
}

export const AGENT_CREATOR_MANIFEST_HASH = computeManifestHash()

/** The frozen creator record for `address`, or `null` when it names no known creator. Never
 * fabricates a record — the seeded demo agent (a historical explorer address, not a creator) is
 * absent from AGENT_CREATORS on purpose and will correctly resolve to null here. */
export function creatorForAddress(address) {
  return AGENT_CREATORS.find((c) => c.address === address) || null
}

/** Every creator address a wasm-generation record names in `creatorAddresses` must itself exist
 * in AGENT_CREATORS — a cross-reference integrity check, not a duplicate of it. */
function isKnownCreatorAddress(address, creators) {
  return creators.some((c) => c.address === address)
}

/**
 * Throws a descriptive Error the first time it finds an incomplete/inconsistent record; returns
 * `true` when the manifest is fully self-consistent. Encodes the "no 0, guessed ledger, missing
 * deploy transaction, or unbounded current creator" rule from the Task 1 brief:
 *   - every ledger field (deployedLedger/coverageStartLedger/retiredLedger/uploadedLedger) is
 *     either `null` or a finite integer >= 1 — 0 is never a valid ledger;
 *   - coverageStartLedger is always present (a "current"/non-retired creator can never be
 *     unbounded — it starts somewhere, even if that somewhere is the conservative floor `1`);
 *   - a creator whose coverage does NOT start at the conservative floor (coverageStartLedger > 1)
 *     must carry real deploy-tx evidence — only the deliberately-conservative ledger-1 legacy
 *     records are allowed to omit it;
 *   - every wasmHash / deployTx / uploadTx that IS present looks like real chain evidence (64-hex
 *     wasm hash; deploy/upload tx strings are non-empty) — never an empty-string placeholder;
 *   - every wasm generation's creatorAddresses resolve to a real entry in `creators`.
 * @param {{creators?: object[], wasmGenerations?: object[]}} [manifest] defaults to the frozen
 *   module-level AGENT_CREATORS/AGENT_WASM_GENERATIONS — call with no args to self-check the
 *   live manifest; pass an explicit shape from a test to check a candidate before adopting it.
 */
export function assertCompleteCreatorManifest({
  creators = AGENT_CREATORS,
  wasmGenerations = AGENT_WASM_GENERATIONS,
} = {}) {
  const validLedger = (v) => v === null || (Number.isInteger(v) && v >= 1)
  const nonEmptyString = (v) => typeof v === 'string' && v.length > 0

  for (const c of creators) {
    if (!nonEmptyString(c.address) || !/^C[A-Z0-9]{55}$/.test(c.address))
      throw new Error(`agentCreatorManifest: creator has an invalid address: ${c.address}`)
    if (c.kind !== FUNDING_ROUTER && c.kind !== REGISTRY)
      throw new Error(`agentCreatorManifest: creator ${c.address} has an invalid kind: ${c.kind}`)
    if (!Number.isInteger(c.schemaVersion))
      throw new Error(`agentCreatorManifest: creator ${c.address} is missing schemaVersion`)
    if (!validLedger(c.deployedLedger))
      throw new Error(`agentCreatorManifest: creator ${c.address} has an invalid deployedLedger`)
    if (!validLedger(c.retiredLedger))
      throw new Error(`agentCreatorManifest: creator ${c.address} has an invalid retiredLedger`)
    if (!Number.isInteger(c.coverageStartLedger) || c.coverageStartLedger < 1)
      throw new Error(
        `agentCreatorManifest: creator ${c.address} has an unbounded/invalid coverageStartLedger`
      )
    if (c.coverageStartLedger > 1 && !nonEmptyString(c.deployTx))
      throw new Error(
        `agentCreatorManifest: creator ${c.address} pins a coverage start above the conservative floor without a deploy transaction`
      )
    if (c.deployTx != null && !nonEmptyString(c.deployTx))
      throw new Error(`agentCreatorManifest: creator ${c.address} has an empty deployTx`)
    if (!Array.isArray(c.supportedAgentWasmHashes))
      throw new Error(
        `agentCreatorManifest: creator ${c.address} is missing supportedAgentWasmHashes`
      )
    if (!Array.isArray(c.discoverySources) || c.discoverySources.length === 0)
      throw new Error(`agentCreatorManifest: creator ${c.address} is missing discoverySources`)
  }

  for (const g of wasmGenerations) {
    if (!/^[0-9a-f]{64}$/i.test(g.wasmHash || ''))
      throw new Error(
        `agentCreatorManifest: wasm generation has an invalid wasmHash: ${g.wasmHash}`
      )
    if (g.uploadTx != null && !nonEmptyString(g.uploadTx))
      throw new Error(`agentCreatorManifest: wasm generation ${g.wasmHash} has an empty uploadTx`)
    if (!validLedger(g.uploadedLedger))
      throw new Error(
        `agentCreatorManifest: wasm generation ${g.wasmHash} has an invalid uploadedLedger`
      )
    if (g.uploadedLedger != null && g.uploadTx == null)
      throw new Error(
        `agentCreatorManifest: wasm generation ${g.wasmHash} pins an uploadedLedger without an uploadTx`
      )
    if (!['agent-v1', 'agent-v2', 'agent-v3', 'agent-v3-bridge'].includes(g.generation))
      throw new Error(
        `agentCreatorManifest: wasm generation ${g.wasmHash} has an unknown generation: ${g.generation}`
      )
    if (!Array.isArray(g.creatorAddresses))
      throw new Error(
        `agentCreatorManifest: wasm generation ${g.wasmHash} is missing creatorAddresses`
      )
    for (const addr of g.creatorAddresses) {
      if (!isKnownCreatorAddress(addr, creators))
        throw new Error(
          `agentCreatorManifest: wasm generation ${g.wasmHash} names an unknown creator: ${addr}`
        )
    }
  }

  return true
}

/**
 * Gate for `orchestrator.js`'s dev/test-only legacy direct-deploy seam (`setupLegacy`), pinning
 * the production cutoff this Task closes: an ALLOWLIST of exactly `development`/`test`
 * (never a `mode !== 'production'` blocklist — that would silently also open the seam for
 * staging/preview/any other deploy mode this app never anticipated), and even inside that
 * allowlist the seam stays off unless the caller opts in EXPLICITLY. Vite bakes VITE_ vars into
 * the client bundle, so a flag alone could never gate production even if mode-checking were
 * skipped — trusting one for a production authorization decision would let anyone flip it via
 * devtools.
 * @param {{mode: string, explicitFlag: string|boolean}} p `mode` is import.meta.env.MODE;
 *   `explicitFlag` is import.meta.env.VITE_ENABLE_LEGACY_AGENT_SETUP (a Vite env var is always a
 *   string at runtime — 'true'/'false' — so both the string and boolean forms are accepted).
 * @returns {boolean}
 */
export function isLegacyDirectSetupAllowed({ mode, explicitFlag } = {}) {
  if (mode !== 'development' && mode !== 'test') return false
  return explicitFlag === true || explicitFlag === 'true'
}
