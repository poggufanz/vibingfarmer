import { describe, it, expect, vi } from 'vitest'

// memory.js writes to localStorage (absent in node) — mock it so the failure path returns cleanly.
vi.mock('./memory.js', () => ({
  writeMemory: vi.fn(),
  createEntry: (step, status, data = {}, lesson) => ({ step, status, ...data, lesson }),
  buildLesson: () => 'lesson',
}))

import { WorkerAgent } from './worker.js'
import { MAX_TOKEN_AGE_MS } from './strategy/eligibilityGate.js'

const NOW = Date.now()
const goodToken = {
  protocolSlug: 'aave-v3',
  planIndex: 0,
  eligible: true,
  verdictHash: '123',
  asOf: NOW,
}

function makeWorker(token) {
  return new WorkerAgent({
    agentId: 'w1',
    user: 'G...',
    vault: 'C...',
    amount: 1n,
    sessionId: 's',
    agentAddress: 'CA...',
    sessionKey: { publicKey: 'GP', rawPublicKey: new Uint8Array(), sign: () => {} },
    eligibilityToken: token,
  })
}

describe('worker eligibility assertion', () => {
  it('throws when the token is absent', async () => {
    const r = await makeWorker(null).execute()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/eligibility/i)
  })
  it('throws when the token is stale', async () => {
    const r = await makeWorker({ ...goodToken, asOf: NOW - MAX_TOKEN_AGE_MS - 1 }).execute()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/eligibility/i)
  })
})
