// frontend/extension/grantDecoder.js
// Decodes a parsed funding_router.grant invocation (contractId/functionName/args — the same
// triple txSummary.js already extracts from a tx envelope or auth entry) into a truthful
// FundingGrantSummaryV1 for the approve popup.
//
// Money-truth rule: this is a PURE, SYNCHRONOUS decode of what the XDR actually says — no RPC
// reads, no invented run amount/APY/venue/cap/agent-count. `budgets` is the allowance CEILING the
// grant would set (SEP-41 approve REPLACES the allowance to exactly this, per-token); each
// agent's `capPerPeriod` is its own separate rolling-window ceiling. Neither is "the deposit
// amount" — later execution may pull less, or nothing at all. Mixed-token grants keep every
// token's numbers separate; same-token entries may be summed, different tokens never collapse
// into one total (aggregateCapsByToken, allowanceHeadroomByToken are BY token, always arrays).
//
// Fail-closed: an unrecognized router address, or a known router whose args don't match the
// pinned schema, NEVER falls through to a fabricated summary — see routerSchema.js for the
// pinned ABI table and its own "unknown by design" comment on the untested legacy router.
// No import from txSummary.js here on purpose: txSummary.js calls INTO this decoder (to attach
// a `grant` field to its invocation summary), so this module must stay a leaf — an import back
// the other way would be a circular ES module dependency.
import { scValToNative } from '@stellar/stellar-sdk'
// Explicit import (not a bare global) so this module decodes correctly regardless of import
// order — unlike approve.js's shims.js, which installs Buffer onto globalThis for the classic-
// wallet chunk, this decoder must not depend on having been imported after that shim ran.
import { Buffer } from 'buffer'
import { resolveRouterSchema, AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from '../src/stellar/routerSchema.js'
import { SOROBAN_DECIMALS, SOROBAN_AUTOFARM_VAULT_ADDRESS, STELLAR_NETWORK_LABEL } from '../src/stellar/config.js'
import { STELLAR_TOKEN_MESSENGER_MINTER, CCTP_BASE_DOMAIN } from '../src/stellar/cctpBurn.js'

// Deliberately plainer than txSummary.js's formatArg (no strkey truncation, no 7dp display
// hint) — this is the FAIL-CLOSED raw-facts fallback, where exactness matters more than
// prettiness.
function formatRawArg(v) {
  if (typeof v === 'bigint') return v.toString()
  if (v && typeof v === 'object') {
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function hex(bytes) {
  return bytes ? `0x${Buffer.from(bytes).toString('hex')}` : null
}

function tokenAmount(token, units) {
  return { token, units: BigInt(units), decimals: SOROBAN_DECIMALS }
}

/** Only an EXACT target-address match against an allowlisted, deployments-verified contract may
 *  ever earn a trusted route/venue label — an arbitrary target can never be labeled Blend (or
 *  CCTP) from its mere position in the XDR. Everything else is `unknown`, fail-closed. */
function classifyDestination({ kind, target, destinationDomain }) {
  if (kind === AGENT_KIND_DEPOSIT && target === SOROBAN_AUTOFARM_VAULT_ADDRESS) {
    return {
      network: STELLAR_NETWORK_LABEL,
      targetAddress: target,
      classification: 'known-stellar-vault',
      routeLabel: 'Autofarm Vault → Blend Capital v2',
      venueLabel: 'Blend Capital v2',
    }
  }
  if (
    kind === AGENT_KIND_BRIDGE &&
    target === STELLAR_TOKEN_MESSENGER_MINTER &&
    Number(destinationDomain) === CCTP_BASE_DOMAIN
  ) {
    return {
      network: STELLAR_NETWORK_LABEL,
      targetAddress: target,
      classification: 'known-cctp-messenger',
      routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
      // Base-side pools are custody proxies holding real Circle USDC — no live protocol yield,
      // so there is no venue to name here (copy-truth constraint, never invent one).
      venueLabel: null,
    }
  }
  return {
    network: STELLAR_NETWORK_LABEL,
    targetAddress: target ?? null,
    classification: 'unknown',
    routeLabel: null,
    venueLabel: null,
  }
}

function agentKindLabel(kind) {
  if (kind === AGENT_KIND_DEPOSIT) return 'deposit'
  if (kind === AGENT_KIND_BRIDGE) return 'bridge'
  return 'unknown'
}

// v1 AgentInit has no kind/token/bridge fields — the router itself was constructed with ONE
// token, and every v1 agent is implicitly a deposit agent (soroban/contracts/funding_router
// commit e4453d4/30794bb, before the v2 "grant-covers-burn" rework).
function decodeAgentV1(raw, index, token) {
  return {
    index,
    kind: 'deposit',
    signer: hex(raw.signer),
    token,
    capPerPeriod: tokenAmount(token, raw.cap),
    periodDurationSeconds: Number(raw.period_duration),
    expiryTimestamp: Number(raw.expiry),
    target: raw.vault,
    destinationDomain: null,
    mintRecipient: null,
    destination: classifyDestination({ kind: AGENT_KIND_DEPOSIT, target: raw.vault }),
  }
}

function decodeAgentV2(raw, index) {
  const kind = Number(raw.kind)
  const destinationDomain = Number(raw.destination_domain)
  return {
    index,
    kind: agentKindLabel(kind),
    signer: hex(raw.signer),
    token: raw.token,
    capPerPeriod: tokenAmount(raw.token, raw.cap),
    periodDurationSeconds: Number(raw.period_duration),
    expiryTimestamp: Number(raw.expiry),
    target: raw.target,
    destinationDomain,
    mintRecipient: hex(raw.mint_recipient),
    destination: classifyDestination({ kind, target: raw.target, destinationDomain }),
  }
}

// Sums UNITS within the SAME token only — never mixes two different tokens into one number
// (that would be the "collapse incomparable ceilings into a total" mistake the brief forbids).
function sumByToken(entries) {
  const byToken = new Map()
  for (const e of entries) byToken.set(e.token, (byToken.get(e.token) ?? 0n) + BigInt(e.units))
  return [...byToken.entries()].map(([token, units]) => tokenAmount(token, units))
}

function rawFacts(contractId, functionName, args) {
  return {
    contractId,
    functionName: functionName ?? null,
    args: (args ?? []).map((a) => formatRawArg(scValToNative(a))),
  }
}

/**
 * @param {{contractId:string, functionName:string,
 *          args:import('@stellar/stellar-sdk').xdr.ScVal[]}} p
 * @returns {object} FundingGrantSummaryV1 (kind:'funding-router-grant'), or a fail-closed
 *          {kind:'schema-mismatch'|'unknown', ...rawFacts} — see module doc.
 */
export function decodeFundingRouterGrant({ contractId, functionName, args }) {
  const schema = resolveRouterSchema(contractId)
  if (!schema) return { kind: 'unknown', ...rawFacts(contractId, functionName, args) }

  if (functionName !== 'grant') {
    return {
      kind: 'schema-mismatch',
      schemaVersion: schema.version,
      warning: `This is the known funding_router v${schema.version}, but "${functionName}" is not its grant call — showing raw facts only.`,
      ...rawFacts(contractId, functionName, args),
    }
  }

  try {
    const native = (args ?? []).map((a) => scValToNative(a))
    if (native.length !== 4) throw new Error(`grant expects 4 args, got ${native.length}`)
    const [owner, budgetsArg, expiryLedger, agentsArg] = native
    if (typeof owner !== 'string' || !owner) throw new Error('owner is not a decoded address')
    if (!Array.isArray(agentsArg)) throw new Error('agents is not a Vec')

    let budgets
    let agents
    if (schema.version === 1) {
      if (typeof budgetsArg !== 'bigint') throw new Error('v1 budget must be a scalar i128')
      budgets = [tokenAmount(schema.token, budgetsArg)]
      agents = agentsArg.map((raw, i) => decodeAgentV1(raw, i, schema.token))
    } else if (schema.version === 2) {
      if (!Array.isArray(budgetsArg)) throw new Error('v2 budgets must be a Vec<TokenBudget>')
      budgets = budgetsArg.map((b) => tokenAmount(b.token, b.budget))
      agents = agentsArg.map((raw, i) => decodeAgentV2(raw, i))
    } else {
      throw new Error(`unsupported schema version ${schema.version}`)
    }

    const caps = agents.map((a) => a.capPerPeriod)
    const aggregateCapsByToken = sumByToken(caps)
    const capSumByToken = new Map(aggregateCapsByToken.map((c) => [c.token, c.units]))
    const allowanceHeadroomByToken = budgets.map((b) =>
      tokenAmount(b.token, b.units - (capSumByToken.get(b.token) ?? 0n))
    )

    return {
      kind: 'funding-router-grant',
      schemaVersion: schema.version,
      owner,
      budgets,
      expiryLedger: Number(expiryLedger),
      agents,
      aggregateCapsByToken,
      allowanceHeadroomByToken,
    }
  } catch (err) {
    return {
      kind: 'schema-mismatch',
      schemaVersion: schema.version,
      warning: `Args did not match the known funding_router v${schema.version} grant schema (${err.message}) — showing raw facts only.`,
      ...rawFacts(contractId, functionName, args),
    }
  }
}
