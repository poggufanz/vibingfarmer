import { describe, it, expect } from 'vitest'
import {
  Account,
  Address,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_AUTOFARM_VAULT_ADDRESS,
  SOROBAN_VAULT_ADDRESS,
  SOROBAN_DECIMALS,
  STELLAR_NETWORK_LABEL,
} from '../src/stellar/config.js'
import { STELLAR_TOKEN_MESSENGER_MINTER, CCTP_BASE_DOMAIN } from '../src/stellar/cctpBurn.js'
import {
  addrScVal,
  i128ScVal,
  u32ScVal,
  u64ScVal,
  bytes32ScVal,
  structScVal,
} from '../src/stellar/scval.js'
import {
  agentInitScVal,
  tokenBudgetScVal,
  AGENT_KIND_DEPOSIT,
  AGENT_KIND_BRIDGE,
} from '../src/stellar/grant.js'
import { decodeFundingRouterGrant } from './grantDecoder.js'

const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const ROUTER_V1 = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const ROUTER_LEGACY = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const OTHER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7)) // any other SAC, ≠ SOROBAN_TOKEN_ADDRESS

function b32(fill) {
  return Buffer.alloc(32, fill)
}

const vec = (items) => xdr.ScVal.scvVec(items)

/** v1 AgentInit — signer, salt, cap, vault, period_duration, expiry. No kind/token/bridge
 *  fields at all (v1's AgentInit predates the v2 bridge-agent rework); structScVal sorts to the
 *  lexicographic wire order regardless of the order listed here. */
function agentInitV1ScVal({ signer, salt, cap, vault, periodDuration, expiry }) {
  return structScVal({
    cap: i128ScVal(cap),
    expiry: u64ScVal(expiry),
    period_duration: u64ScVal(periodDuration),
    salt: bytes32ScVal(salt),
    signer: bytes32ScVal(signer),
    vault: addrScVal(vault),
  })
}

/** Builds a real invokeHostFunction op via Contract.call, round-trips it through XDR (build ->
 *  toXDR -> fromXDR) — the "exact SDK-built XDR fixture" the brief asks for — and returns the
 *  {contractId, functionName, args} triple exactly the way approve.js's
 *  summarizeTransaction/summarizeAuthEntry already surface an invocation (see txSummary.js's
 *  summarizeInvokeArgs). That triple is the decoder's real input. */
function invocationFor(contractId, fn, argsScVals) {
  const source = new Account(Keypair.random().publicKey(), '0')
  const xdrB64 = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...argsScVals))
    .setTimeout(300)
    .build()
    .toXDR()
  const tx = TransactionBuilder.fromXDR(xdrB64, NETWORK_PASSPHRASE)
  const inv = tx.operations[0].func.invokeContract()
  return {
    contractId: Address.fromScAddress(inv.contractAddress()).toString(),
    functionName: inv.functionName().toString(),
    args: inv.args(),
  }
}

function grantV1(owner, { budget, expiryLedger, agents }) {
  return invocationFor(ROUTER_V1, 'grant', [
    addrScVal(owner),
    i128ScVal(budget),
    u32ScVal(expiryLedger),
    vec(agents.map(agentInitV1ScVal)),
  ])
}

function grantV2(owner, { budgets, expiryLedger, agents }) {
  return invocationFor(ROUTER_V2, 'grant', [
    addrScVal(owner),
    vec(budgets.map(tokenBudgetScVal)),
    u32ScVal(expiryLedger),
    vec(agents.map(agentInitScVal)),
  ])
}

describe('decodeFundingRouterGrant — v1 (pinned-token) router', () => {
  it('decodes a single deposit agent targeting the allowlisted Autofarm Vault', () => {
    const owner = Keypair.random().publicKey()
    const result = decodeFundingRouterGrant(
      grantV1(owner, {
        budget: 5_000_000n,
        expiryLedger: 1_000_000,
        agents: [
          {
            signer: b32(1),
            salt: b32(9),
            cap: 1_000_000n,
            vault: SOROBAN_AUTOFARM_VAULT_ADDRESS,
            periodDuration: 86400,
            expiry: 2_000_000,
          },
        ],
      })
    )

    expect(result.kind).toBe('funding-router-grant')
    expect(result.schemaVersion).toBe(1)
    expect(result.owner).toBe(owner)
    expect(result.expiryLedger).toBe(1_000_000)
    expect(result.budgets).toEqual([
      { token: SOROBAN_TOKEN_ADDRESS, units: 5_000_000n, decimals: SOROBAN_DECIMALS },
    ])
    expect(result.agents).toHaveLength(1)
    const agent = result.agents[0]
    expect(agent.index).toBe(0)
    expect(agent.kind).toBe('deposit')
    expect(agent.signer).toBe(`0x${b32(1).toString('hex')}`)
    expect(agent.token).toBe(SOROBAN_TOKEN_ADDRESS)
    expect(agent.target).toBe(SOROBAN_AUTOFARM_VAULT_ADDRESS)
    expect(agent.capPerPeriod).toEqual({
      token: SOROBAN_TOKEN_ADDRESS,
      units: 1_000_000n,
      decimals: SOROBAN_DECIMALS,
    })
    expect(agent.periodDurationSeconds).toBe(86400)
    expect(agent.expiryTimestamp).toBe(2_000_000)
    expect(agent.destinationDomain).toBeNull()
    expect(agent.mintRecipient).toBeNull()
    expect(agent.destination).toEqual({
      network: STELLAR_NETWORK_LABEL,
      targetAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
      classification: 'known-stellar-vault',
      routeLabel: 'Autofarm Vault → Blend Capital v2',
      venueLabel: 'Blend Capital v2',
    })
    expect(result.aggregateCapsByToken).toEqual([
      { token: SOROBAN_TOKEN_ADDRESS, units: 1_000_000n, decimals: SOROBAN_DECIMALS },
    ])
    // headroom = budget - sum(caps) for that token: how much of the granted allowance is NOT
    // already earmarked by any agent's per-period cap — never the amount that WILL move.
    expect(result.allowanceHeadroomByToken).toEqual([
      { token: SOROBAN_TOKEN_ADDRESS, units: 4_000_000n, decimals: SOROBAN_DECIMALS },
    ])
  })

  it('never labels a NON-allowlisted deposit target as the Blend route, even for a real known contract', () => {
    const owner = Keypair.random().publicKey()
    const result = decodeFundingRouterGrant(
      grantV1(owner, {
        budget: 1_000_000n,
        expiryLedger: 500_000,
        agents: [
          {
            signer: b32(2),
            salt: b32(3),
            // the LEGACY 1:1 vault — a real, known contract, but NOT the allowlisted Autofarm
            // Vault. Its position in the XDR alone must never earn it the Blend label.
            vault: SOROBAN_VAULT_ADDRESS,
            cap: 500_000n,
            periodDuration: 3600,
            expiry: 900_000,
          },
        ],
      })
    )
    expect(result.kind).toBe('funding-router-grant')
    expect(result.agents[0].destination).toEqual({
      network: STELLAR_NETWORK_LABEL,
      targetAddress: SOROBAN_VAULT_ADDRESS,
      classification: 'unknown',
      routeLabel: null,
      venueLabel: null,
    })
  })
})

describe('decodeFundingRouterGrant — v2 (per-budget, multi-token) router', () => {
  it('decodes multi-token budgets and N deposit agents, aggregating caps per token separately', () => {
    const owner = Keypair.random().publicKey()
    const result = decodeFundingRouterGrant(
      grantV2(owner, {
        budgets: [
          { budget: 10_000_000n, token: SOROBAN_TOKEN_ADDRESS },
          { budget: 2_000_000n, token: OTHER_TOKEN },
        ],
        expiryLedger: 2_500_000,
        agents: [
          {
            signer: b32(1),
            salt: b32(1),
            cap: 3_000_000n,
            token: SOROBAN_TOKEN_ADDRESS,
            target: SOROBAN_AUTOFARM_VAULT_ADDRESS,
            kind: AGENT_KIND_DEPOSIT,
            mintRecipient: new Uint8Array(32),
            destinationDomain: 0,
            periodDuration: 86400,
            expiry: 3_000_000,
          },
          {
            signer: b32(2),
            salt: b32(2),
            cap: 4_000_000n,
            token: SOROBAN_TOKEN_ADDRESS,
            target: SOROBAN_AUTOFARM_VAULT_ADDRESS,
            kind: AGENT_KIND_DEPOSIT,
            mintRecipient: new Uint8Array(32),
            destinationDomain: 0,
            periodDuration: 86400,
            expiry: 3_000_000,
          },
          {
            signer: b32(3),
            salt: b32(3),
            cap: 1_500_000n,
            token: OTHER_TOKEN,
            target: SOROBAN_AUTOFARM_VAULT_ADDRESS,
            kind: AGENT_KIND_DEPOSIT,
            mintRecipient: new Uint8Array(32),
            destinationDomain: 0,
            periodDuration: 86400,
            expiry: 3_000_000,
          },
        ],
      })
    )

    expect(result.kind).toBe('funding-router-grant')
    expect(result.schemaVersion).toBe(2)
    expect(result.owner).toBe(owner)
    expect(result.budgets).toEqual(
      expect.arrayContaining([
        { token: SOROBAN_TOKEN_ADDRESS, units: 10_000_000n, decimals: SOROBAN_DECIMALS },
        // OTHER_TOKEN is not the pinned 7dp SAC — its decimals are genuinely unknown from a pure
        // XDR decode, so this must be null, never a fabricated 7 (Finding 2).
        { token: OTHER_TOKEN, units: 2_000_000n, decimals: null },
      ])
    )
    expect(result.budgets).toHaveLength(2)
    expect(result.agents).toHaveLength(3)
    expect(result.agents.map((a) => a.index)).toEqual([0, 1, 2])

    // Same-token caps sum; different-token caps stay SEPARATE — never collapsed into one total.
    expect(result.aggregateCapsByToken).toEqual(
      expect.arrayContaining([
        { token: SOROBAN_TOKEN_ADDRESS, units: 7_000_000n, decimals: SOROBAN_DECIMALS },
        { token: OTHER_TOKEN, units: 1_500_000n, decimals: null },
      ])
    )
    expect(result.aggregateCapsByToken).toHaveLength(2)
    expect(result.allowanceHeadroomByToken).toEqual(
      expect.arrayContaining([
        { token: SOROBAN_TOKEN_ADDRESS, units: 3_000_000n, decimals: SOROBAN_DECIMALS },
        { token: OTHER_TOKEN, units: 500_000n, decimals: null },
      ])
    )
  })

  it('computes negative headroom (a truthful signal, not clamped) when per-period caps could exceed the budget in one period', () => {
    const owner = Keypair.random().publicKey()
    const result = decodeFundingRouterGrant(
      grantV2(owner, {
        budgets: [{ budget: 1_000_000n, token: SOROBAN_TOKEN_ADDRESS }],
        expiryLedger: 2_000_000,
        agents: [
          {
            signer: b32(1),
            salt: b32(1),
            cap: 3_000_000n, // agent's per-period cap alone exceeds the whole grant budget
            token: SOROBAN_TOKEN_ADDRESS,
            target: SOROBAN_AUTOFARM_VAULT_ADDRESS,
            kind: AGENT_KIND_DEPOSIT,
            mintRecipient: new Uint8Array(32),
            destinationDomain: 0,
            periodDuration: 86400,
            expiry: 2_500_000,
          },
        ],
      })
    )
    expect(result.allowanceHeadroomByToken).toEqual([
      { token: SOROBAN_TOKEN_ADDRESS, units: -2_000_000n, decimals: SOROBAN_DECIMALS },
    ])
  })

  it('classifies a bridge agent with real Base-route fields as known-cctp-messenger', () => {
    const owner = Keypair.random().publicKey()
    const mintRecipient = b32(0xaa)
    const result = decodeFundingRouterGrant(
      grantV2(owner, {
        budgets: [{ budget: 8_000_000n, token: SOROBAN_TOKEN_ADDRESS }],
        expiryLedger: 2_000_000,
        agents: [
          {
            signer: b32(4),
            salt: b32(4),
            cap: 2_000_000n,
            token: SOROBAN_TOKEN_ADDRESS,
            target: STELLAR_TOKEN_MESSENGER_MINTER,
            kind: AGENT_KIND_BRIDGE,
            mintRecipient,
            destinationDomain: CCTP_BASE_DOMAIN,
            periodDuration: 86400,
            expiry: 1_800_000,
          },
        ],
      })
    )
    expect(result.kind).toBe('funding-router-grant')
    const agent = result.agents[0]
    expect(agent.kind).toBe('bridge')
    expect(agent.target).toBe(STELLAR_TOKEN_MESSENGER_MINTER)
    expect(agent.destinationDomain).toBe(CCTP_BASE_DOMAIN)
    expect(agent.mintRecipient).toBe(`0x${mintRecipient.toString('hex')}`)
    expect(agent.destination).toEqual({
      network: STELLAR_NETWORK_LABEL,
      targetAddress: STELLAR_TOKEN_MESSENGER_MINTER,
      classification: 'known-cctp-messenger',
      routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
      // No live protocol yield on the Base custody-proxy side — never claim a venue here.
      venueLabel: null,
    })
  })

  it('classifies a bridge-kind agent targeting the real messenger but a non-Base domain as unknown (fail closed — this app offers only the Base route)', () => {
    const owner = Keypair.random().publicKey()
    const result = decodeFundingRouterGrant(
      grantV2(owner, {
        budgets: [{ budget: 1_000_000n, token: SOROBAN_TOKEN_ADDRESS }],
        expiryLedger: 2_000_000,
        agents: [
          {
            signer: b32(5),
            salt: b32(5),
            cap: 500_000n,
            token: SOROBAN_TOKEN_ADDRESS,
            target: STELLAR_TOKEN_MESSENGER_MINTER,
            kind: AGENT_KIND_BRIDGE,
            mintRecipient: b32(0xbb),
            destinationDomain: 999, // not Base
            periodDuration: 86400,
            expiry: 1_800_000,
          },
        ],
      })
    )
    expect(result.agents[0].destination.classification).toBe('unknown')
    expect(result.agents[0].destination.routeLabel).toBeNull()
  })

  it('an AgentInit.kind outside {0,1} (e.g. a future/unrecognized kind) decodes as kind:"unknown" with no route/venue label and no invented cap semantics', () => {
    const owner = Keypair.random().publicKey()
    const result = decodeFundingRouterGrant(
      grantV2(owner, {
        budgets: [{ budget: 1_000_000n, token: SOROBAN_TOKEN_ADDRESS }],
        expiryLedger: 2_000_000,
        agents: [
          {
            signer: b32(6),
            salt: b32(6),
            cap: 250_000n,
            token: SOROBAN_TOKEN_ADDRESS,
            // A real, known target address — even so, an unrecognized kind must NOT be
            // classified as a deposit (or bridge) route just because the target matches one.
            target: SOROBAN_AUTOFARM_VAULT_ADDRESS,
            kind: 2, // neither AGENT_KIND_DEPOSIT (0) nor AGENT_KIND_BRIDGE (1)
            mintRecipient: new Uint8Array(32),
            destinationDomain: 0,
            periodDuration: 86400,
            expiry: 1_800_000,
          },
        ],
      })
    )
    expect(result.kind).toBe('funding-router-grant')
    const agent = result.agents[0]
    expect(agent.kind).toBe('unknown')
    expect(agent.destination).toEqual({
      network: STELLAR_NETWORK_LABEL,
      targetAddress: SOROBAN_AUTOFARM_VAULT_ADDRESS,
      classification: 'unknown',
      routeLabel: null,
      venueLabel: null,
    })
    // Still a real, decoded cap ceiling — an unrecognized kind must not suppress or invent it.
    expect(agent.capPerPeriod).toEqual({
      token: SOROBAN_TOKEN_ADDRESS,
      units: 250_000n,
      decimals: SOROBAN_DECIMALS,
    })
  })
})

describe('decodeFundingRouterGrant — fail-closed branches', () => {
  it('known router + mismatched arg shape (v1-style scalar budget sent to the v2 router) → schema-mismatch with raw facts, no invented budgets/agents', () => {
    const owner = Keypair.random().publicKey()
    const inv = invocationFor(ROUTER_V2, 'grant', [
      addrScVal(owner),
      i128ScVal(1_000_000n), // WRONG SHAPE for v2 — should be Vec<TokenBudget>
      u32ScVal(1_000_000),
      vec([]),
    ])
    const result = decodeFundingRouterGrant(inv)
    expect(result.kind).toBe('schema-mismatch')
    expect(result.schemaVersion).toBe(2)
    expect(typeof result.warning).toBe('string')
    expect(result.warning.length).toBeGreaterThan(0)
    expect(result.contractId).toBe(ROUTER_V2)
    expect(result.functionName).toBe('grant')
    expect(Array.isArray(result.args)).toBe(true)
    expect(result).not.toHaveProperty('budgets')
    expect(result).not.toHaveProperty('agents')
  })

  it('known router + wrong function name → schema-mismatch, not a fabricated grant summary', () => {
    const owner = Keypair.random().publicKey()
    const inv = invocationFor(ROUTER_V1, 'pull', [addrScVal(owner), i128ScVal(100n)])
    const result = decodeFundingRouterGrant(inv)
    expect(result.kind).toBe('schema-mismatch')
    expect(result.schemaVersion).toBe(1)
    expect(result.functionName).toBe('pull')
  })

  it('the legacy router (no committed fixture) decodes as generic unknown/raw facts, never a summary', () => {
    const owner = Keypair.random().publicKey()
    const inv = invocationFor(ROUTER_LEGACY, 'grant', [addrScVal(owner), i128ScVal(1_000_000n)])
    const result = decodeFundingRouterGrant(inv)
    expect(result.kind).toBe('unknown')
    expect(result.contractId).toBe(ROUTER_LEGACY)
    expect(result.functionName).toBe('grant')
    expect(result).not.toHaveProperty('budgets')
    expect(result).not.toHaveProperty('agents')
  })

  it('an unrelated invocation on a totally different, non-router contract decodes as generic unknown/raw facts', () => {
    const owner = Keypair.random().publicKey()
    const inv = invocationFor(SOROBAN_AUTOFARM_VAULT_ADDRESS, 'deposit', [
      addrScVal(owner),
      i128ScVal(5_000_000n),
    ])
    const result = decodeFundingRouterGrant(inv)
    expect(result.kind).toBe('unknown')
    expect(result.contractId).toBe(SOROBAN_AUTOFARM_VAULT_ADDRESS)
    expect(result.functionName).toBe('deposit')
    expect(result.args).toHaveLength(2)
  })
})
