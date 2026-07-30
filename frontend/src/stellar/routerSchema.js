// frontend/src/stellar/routerSchema.js
// Pins the funding_router contract-address -> ABI-shape schema the decoders in
// extension/grantDecoder.js trust. Each router VERSION encodes `grant`'s args differently —
// v1's budget is a single i128 for the one token the router was constructed with; v2's is a
// Vec<TokenBudget> covering several tokens at once. See soroban/contracts/funding_router/src/
// {lib,types}.rs (v1: commit e4453d4/30794bb, v2: ccc4197 "grant-covers-burn").
//
// A router address absent here is UNKNOWN by design: the extension must never guess an ABI it
// hasn't pinned against a committed fixture — grantDecoder.js's fail-closed contract.
import { SOROBAN_TOKEN_ADDRESS } from './config.js'
// `AgentInit.kind` discriminants (v2 only; v1's AgentInit has no `kind` field at all, every v1
// agent is implicitly a deposit agent) — single source of truth lives in grant.js (the encoder),
// re-exported here so decoders never redefine the same constants.
import { AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from './grant.js'

export { AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE }

/**
 * contractId -> known funding_router ABI shape.
 * `tokenMode: 'pinned'` (v1) — the router was constructed with ONE token forever; it never
 *   appears in `grant`'s args, so `schema.token` supplies it for display.
 * `tokenMode: 'per-budget'` (v2) — `grant` itself carries `budgets: Vec<TokenBudget>`, one
 *   entry per token.
 */
export const ROUTER_SCHEMAS = {
  CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE: {
    version: 2,
    tokenMode: 'per-budget',
  },
  CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5: {
    version: 1,
    tokenMode: 'pinned',
    token: SOROBAN_TOKEN_ADDRESS,
  },
  // CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY (legacy router) is deliberately
  // ABSENT — no committed passing fixture for its ABI, so it decodes as unknown/raw.
}

/**
 * @param {string} contractId
 * @returns {{version:1|2, tokenMode:'pinned'|'per-budget', token?:string}|null}
 */
export function resolveRouterSchema(contractId) {
  return ROUTER_SCHEMAS[contractId] ?? null
}

/**
 * V3 (Task 4, bounded reusable grant) argument shape — deliberately NOT registered in
 * `ROUTER_SCHEMAS` (that map is keyed by a LIVE deployed contract address, and no V3 router has
 * been deployed; inventing an address/hash here would violate the same fail-closed rule that
 * keeps the legacy router's ABI absent above). Exported so decoders/tests can already recognize
 * `grant_v3`/`pull_v3`'s argument counts the day a V3 router address is actually deployed and
 * added to `ROUTER_SCHEMAS`.
 */
export const ROUTER_SCHEMA_V3_SHAPE = Object.freeze({
  version: 3,
  tokenMode: 'reusable-permission',
  // grant_v3(owner, token, mandate_ceiling, per_run_max, live_until_ledger, agents)
  grantArgCount: 6,
  // pull_v3(permission_id, execution_id, agent, amount)
  pullArgCount: 4,
})
