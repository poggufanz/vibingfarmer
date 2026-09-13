// frontend/src/strategy/poolSafety.js
// P0 G3 pool-safety panel data layer (Blend checklist: docs.blend.capital/users/choosing-pools.md).
// The F8 eligibility gate already checks most of this behind the scenes (eligibilityGate.js) but
// never SHOWS it when the user decides to deposit — this module projects the same evidence into
// display rows ProtectStage renders verbatim (same "renders rows verbatim" contract as
// eligibilityReview.js: this file never re-evaluates eligibility, it only shapes facts).
//
// Every row carries its own `{ value, source, asOf }`: a row whose data cannot be proved renders
// `value: null` ("Unavailable" in the panel), never a guessed number. In particular the backstop
// row is ALWAYS unavailable today — no backstop-size/withdrawal-queue read exists anywhere in
// this repo (verified: the only Blend pool reads are `get_reserve`/`get_config`, see
// stellar/vaultReads.js) — and says so, with a pointer to check the Blend pool page instead.
//
// Sources:
// - TVL + qualitative facts (audit/admin/oracle/pool-class/collateral/concentration): vaultFacts
//   resolve() — DeFiLlama-live when vaultFactsLive's overlay primed, else the curated snapshot
//   (vaultFactsSnapshot.js; its header documents which fields are carried forward).
// - Utilization: live `get_reserve` via utilizationBps (keeper/src/apr.js — the same
//   cross-package import vaultReads.js already uses for estimateSupplyAprBps).
import { resolve } from './vaultFacts.js'
import { utilizationBps } from '../../../keeper/src/apr.js'
import { readContract as _readContract } from '../stellar/client.js'
import { SOROBAN_BLEND_POOL_ADDRESS, SOROBAN_TOKEN_ADDRESS } from '../stellar/config.js'

export const POOL_SAFETY_PROTOCOL = 'blend-usdc'
export const POOL_SAFETY_LABEL = 'Blend USDC (Stellar)'

// A row the panel renders: `value` null means "Unavailable" (with `note` saying why when the
// reason is actionable). `source` names WHERE the value came from; `asOf` (epoch ms, null when
// unknown) is the fact's own timestamp, never Date.now() at render.
// @typedef {{ id:string, label:string, value:string|null, source:string, asOf:number|null, note:string|null }} PoolSafetyRow

function fieldOf(facts, key) {
  const field = facts?.[key]
  if (!field || typeof field !== 'object') return null
  return field
}

function factValue(facts, key) {
  return fieldOf(facts, key)?.value ?? null
}

/** Provenance label for a vaultFacts field — the field's own source, never upgraded. */
function factSource(facts, key) {
  const source = fieldOf(facts, key)?.source
  if (source === 'live') return 'DeFiLlama · live'
  if (source === 'snapshot') return 'Snapshot'
  return 'Unknown'
}

function factAsOf(facts, key) {
  const asOf = fieldOf(facts, key)?.asOf
  return typeof asOf === 'number' && Number.isFinite(asOf) ? asOf : null
}

const ORACLE_LABELS = {
  circuit_breaker: 'Circuit breaker',
  vwap_no_breaker: 'VWAP, no breaker',
}

const ADMIN_LABELS = {
  timelock_multisig: 'Timelock + multisig',
  multisig: 'Multisig',
  timelock: 'Timelock',
  eoa: 'Single key (EOA)',
}

const AUDIT_LABELS = {
  audited: 'Audited',
  none: 'No audit found',
}

function labeled(map, value) {
  if (value == null) return null
  if (typeof value !== 'string') return null
  return map[value] ?? value
}

/** 127174055 -> '$127.2M'. null for anything that is not a positive finite number. */
export function formatUsdCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${Math.round(value)}`
}

/** 6532 (bps) -> '65.32%'. null for anything outside 0..10000 bps. */
export function formatUtilizationBps(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps < 0 || bps > 10_000) return null
  return `${(bps / 100).toFixed(2)}%`
}

/**
 * Pure projection: resolved gate facts + live utilization -> panel rows. Never throws on
 * misshapen input (null facts / null utilization degrade row-by-row to unavailable).
 * @param {{ facts?: object|null, poolLabel?: string, utilization?: { bps:number, asOf:number|null }|null }} input
 * @returns {{ poolLabel:string, rows:PoolSafetyRow[] }}
 */
export function buildPoolSafetyView({
  facts = null,
  poolLabel = POOL_SAFETY_LABEL,
  utilization = null,
} = {}) {
  const tvl = typeof facts?.tvl?.value === 'number' ? formatUsdCompact(facts.tvl.value) : null
  const utilizationText =
    utilization && typeof utilization.bps === 'number'
      ? formatUtilizationBps(utilization.bps)
      : null
  const collateral =
    typeof facts?.collateralLiquidityDepthUsd?.value === 'number'
      ? formatUsdCompact(facts.collateralLiquidityDepthUsd.value)
      : null
  const concentration =
    typeof facts?.supplierConcentrationPct?.value === 'number' &&
    Number.isFinite(facts.supplierConcentrationPct.value)
      ? `${facts.supplierConcentrationPct.value}%`
      : null
  return {
    poolLabel,
    rows: [
      {
        id: 'tvl',
        label: 'Total value locked',
        value: tvl,
        source: factSource(facts, 'tvl'),
        asOf: factAsOf(facts, 'tvl'),
        note: null,
      },
      {
        id: 'utilization',
        label: 'Pool utilization (live)',
        value: utilizationText,
        source: 'Blend pool · live RPC',
        asOf: utilization && typeof utilization.asOf === 'number' ? utilization.asOf : null,
        note: null,
      },
      {
        id: 'backstop',
        label: 'Backstop + withdrawal queue',
        value: null,
        source: 'No verified source',
        asOf: null,
        note: 'No on-chain backstop read is wired yet — check the Blend pool page before large deposits.',
      },
      {
        id: 'oracle',
        label: 'Price oracle',
        value: labeled(ORACLE_LABELS, factValue(facts, 'oracleType')),
        source: factSource(facts, 'oracleType'),
        asOf: factAsOf(facts, 'oracleType'),
        note: null,
      },
      {
        id: 'admin',
        label: 'Pool admin',
        value: labeled(ADMIN_LABELS, factValue(facts, 'adminKey')),
        source: factSource(facts, 'adminKey'),
        asOf: factAsOf(facts, 'adminKey'),
        note: null,
      },
      {
        id: 'audit',
        label: 'Audit status',
        value: labeled(AUDIT_LABELS, factValue(facts, 'audit')),
        source: factSource(facts, 'audit'),
        asOf: factAsOf(facts, 'audit'),
        note: null,
      },
      {
        id: 'collateral',
        label: 'Collateral depth',
        value: collateral,
        source: factSource(facts, 'collateralLiquidityDepthUsd'),
        asOf: factAsOf(facts, 'collateralLiquidityDepthUsd'),
        note: null,
      },
      {
        id: 'concentration',
        label: 'Top-supplier concentration',
        value: concentration,
        source: factSource(facts, 'supplierConcentrationPct'),
        asOf: factAsOf(facts, 'supplierConcentrationPct'),
        note: null,
      },
    ],
  }
}

/**
 * Live pool utilization from the Blend reserve books. `{ bps, asOf }`, or null on ANY failure
 * (RPC down, undecodable reserve, empty pool) — never throws, never a guessed number.
 */
export async function readPoolUtilization({
  poolAddress = SOROBAN_BLEND_POOL_ADDRESS,
  tokenAddress = SOROBAN_TOKEN_ADDRESS,
  server,
  readContractImpl = _readContract,
  nowMs = Date.now(),
} = {}) {
  try {
    const reserve = await readContractImpl({
      contract: poolAddress,
      method: 'get_reserve',
      args: [{ addr: tokenAddress }],
      server,
    })
    const bps = utilizationBps(reserve)
    if (bps == null) return null
    return { bps, asOf: nowMs }
  } catch {
    return null
  }
}

function safeResolve(protocol) {
  try {
    return resolve(protocol)
  } catch {
    return null
  }
}

/** Snapshot-only first paint for the panel: zero I/O, so mounting never hits the network. */
export function initialPoolSafetyView({
  protocol = POOL_SAFETY_PROTOCOL,
  poolLabel = POOL_SAFETY_LABEL,
} = {}) {
  const resolved = safeResolve(protocol)
  return buildPoolSafetyView({ facts: resolved?.facts ?? null, poolLabel, utilization: null })
}

/**
 * Full load: resolved facts (live TVL overlay when primed) + live utilization, projected to
 * panel rows. Fail-soft end to end — a total failure still returns an all-unavailable view,
 * never throws.
 */
export async function loadPoolSafety({
  protocol = POOL_SAFETY_PROTOCOL,
  poolLabel = POOL_SAFETY_LABEL,
  poolAddress = SOROBAN_BLEND_POOL_ADDRESS,
  tokenAddress = SOROBAN_TOKEN_ADDRESS,
  server,
  readContractImpl,
  resolveImpl = resolve,
  nowMs = Date.now(),
} = {}) {
  let facts = null
  try {
    facts = resolveImpl(protocol)?.facts ?? null
  } catch {
    facts = null
  }
  const utilization = await readPoolUtilization({
    poolAddress,
    tokenAddress,
    server,
    ...(readContractImpl ? { readContractImpl } : {}),
    nowMs,
  })
  return buildPoolSafetyView({ facts, poolLabel, utilization })
}
