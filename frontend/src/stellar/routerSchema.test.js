import { describe, it, expect } from 'vitest'
import { SOROBAN_TOKEN_ADDRESS } from './config.js'
import {
  ROUTER_SCHEMAS,
  AGENT_KIND_DEPOSIT,
  AGENT_KIND_BRIDGE,
  ROUTER_SCHEMA_V3_SHAPE,
  resolveRouterSchema,
} from './routerSchema.js'

const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
const ROUTER_V1 = 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
const ROUTER_LEGACY = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'

describe('routerSchema', () => {
  it('resolves the live v2 router (per-budget, multi-token)', () => {
    expect(resolveRouterSchema(ROUTER_V2)).toEqual({ version: 2, tokenMode: 'per-budget' })
  })

  it('resolves the live v1 router (pinned token = SOROBAN_TOKEN_ADDRESS)', () => {
    expect(resolveRouterSchema(ROUTER_V1)).toEqual({
      version: 1,
      tokenMode: 'pinned',
      token: SOROBAN_TOKEN_ADDRESS,
    })
  })

  it('treats the legacy router as unknown — no committed fixture for its ABI', () => {
    expect(resolveRouterSchema(ROUTER_LEGACY)).toBeNull()
    expect(ROUTER_SCHEMAS[ROUTER_LEGACY]).toBeUndefined()
  })

  it('returns null for any other/unrecognized contract address', () => {
    expect(resolveRouterSchema('CNOTAROUTERATALLXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')).toBeNull()
    expect(resolveRouterSchema('')).toBeNull()
    expect(resolveRouterSchema(undefined)).toBeNull()
  })

  it('pins the AgentInit.kind discriminants used by the v2 schema', () => {
    expect(AGENT_KIND_DEPOSIT).toBe(0)
    expect(AGENT_KIND_BRIDGE).toBe(1)
  })

  it('exposes the V3 (Task 4) shape descriptor without registering it under any address', () => {
    expect(ROUTER_SCHEMA_V3_SHAPE).toEqual({
      version: 3,
      tokenMode: 'reusable-permission',
      grantArgCount: 6,
      pullArgCount: 4,
    })
    // No V3 router is deployed — the shape must never be reachable via resolveRouterSchema.
    expect(Object.values(ROUTER_SCHEMAS).some((s) => s.version === 3)).toBe(false)
  })
})
