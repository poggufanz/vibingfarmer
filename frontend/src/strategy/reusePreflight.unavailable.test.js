import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  newSessionKey: vi.fn(() => ({
    rawPublicKey: new Uint8Array(32).fill(7),
    secret: 'SYNTHETIC_TEST_SECRET',
  })),
}))

vi.mock('../stellar/sessionKey.js', () => ({ newSessionKey: calls.newSessionKey }))

import { preflightPermission } from './reusePreflight.js'
import { AGENT_KIND_BRIDGE } from '../stellar/grant.js'

describe('preflightPermission legacy Base deployment fence', () => {
  it('rejects a crafted bridge plan before signer/salt persistence or any proof/read seam', async () => {
    const rows = new Map()
    const storage = {
      getItem: vi.fn((key) => rows.get(key) ?? null),
      setItem: vi.fn((key, value) => rows.set(key, value)),
      removeItem: vi.fn((key) => rows.delete(key)),
    }
    const resolveSchema = vi.fn(() => ({ version: 2 }))
    const loadReceipt = vi.fn()
    const proveAllowance = vi.fn()
    const inspectAgents = vi.fn()
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues')

    await expect(
      preflightPermission({
        runId: 'run-crafted',
        owner: 'GOWNER',
        router: 'CROUTER',
        planFingerprint: '0xcrafted',
        agentInits: [
          {
            allocationId: 'run-crafted:bridge:base',
            kind: AGENT_KIND_BRIDGE,
            token: 'CUSDC',
            target: 'CTOKENMESSENGER',
            cap: { token: 'CUSDC', units: '10000000', decimals: 7 },
            periodSeconds: 3600,
            expiry: 2_000_000_000,
            destinationDomain: 6,
            mintRecipient: new Uint8Array(32),
          },
        ],
        reviewedBudgets: [{ token: 'CUSDC', units: '10000000', decimals: 7 }],
        durationSeconds: 3600,
        storage,
        resolveSchema,
        loadReceipt,
        proveAllowance,
        inspectAgents,
      })
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })

    expect(calls.newSessionKey).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(resolveSchema).not.toHaveBeenCalled()
    expect(loadReceipt).not.toHaveBeenCalled()
    expect(proveAllowance).not.toHaveBeenCalled()
    expect(inspectAgents).not.toHaveBeenCalled()
  })
})
