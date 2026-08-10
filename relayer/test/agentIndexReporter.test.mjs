import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentIndexBatchConflictError,
  AgentIndexBatchPermanentError,
  AgentIndexBatchRetryableError,
  AgentIndexEvidenceConflictError,
  AgentIndexRecoveryLeaseConflictError,
  AgentIndexRecoveryVersionConflictError,
  AgentIndexReporterRetryableError,
  createAgentIndexReporter,
} from '../src/agentIndexReporter.mjs';

const SECRET = 'server-to-server-secret';

describe('durable Base child reporter protocol', () => {
  const child = {
    version: 1,
    networkId: 'stellar-testnet',
    owner: `G${'A'.repeat(55)}`,
    agent: `C${'B'.repeat(55)}`,
    bindingId: 'binding-42',
    executionId: 'run-42:exec:run-42:bridge:aave-v3',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'job-42',
    intent: {
      token: 'USDC', units: '1000000', decimals: 6, minShares: '900000',
      poolAddress: `0x${'11'.repeat(20)}`, proxyTarget: 'aave-v3',
      runId: 'run-42', grantTxHash: 'grant-hash', kernelAddress: `0x${'22'.repeat(20)}`,
      bindingHash: 'binding-hash-42', baseJobId: 'job-42',
    },
    lifecycle: {
      sequence: 0,
      status: 'planned',
      evidence: {},
      observedAt: 2_000_000_000_000,
    },
  };
  const identity = {
    networkId: child.networkId,
    owner: child.owner,
    bindingId: child.bindingId,
    executionId: child.executionId,
    allocationId: child.allocationId,
    childId: child.childId,
  };
  const recoveryIdentity = {
    networkId: child.networkId,
    bindingId: child.bindingId,
    executionId: child.executionId,
    allocationId: child.allocationId,
    childId: child.childId,
  };

  const canonicalJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };

  it('commits one exact ordered Task 9 intent batch and binds the 201 request digest and identities', async () => {
    const batch = {
      idempotencyKey: 'burn-intent-42',
      burnUnits7: '10000000',
      children: [child],
    };
    const requestDigest = createHash('sha256').update(canonicalJson(batch)).digest('hex');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        acknowledged: true, schemaVersion: 1, idempotencyKey: batch.idempotencyKey,
        requestDigest,
        children: [{ identity: recoveryIdentity, recoveryVersion: 7 }],
        written: 1, duplicates: 0,
      }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, fetchImpl,
    });

    await expect(reporter.commitIntentBatch(batch)).resolves.toMatchObject({
      requestDigest,
      children: [{ identity: recoveryIdentity, recoveryVersion: 7 }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://index.example/api/agent-index?action=base-child-intent-batch'
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(batch);
  });

  it('posts allowlisted Base evidence and classifies 409 separately from retryable delivery', async () => {
    const evidence = {
      schemaVersion: 1,
      identity: recoveryIdentity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64), phase: 'base_deposit', state: 'submitting',
        evidence: {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
          assets: '1000000', minShares: '900000',
        },
        observedAt: 2_000_000_000_000,
      },
    };
    const evidenceDigest = createHash('sha256')
      .update(canonicalJson(evidence.event.evidence)).digest('hex');
    const reportDigest = createHash('sha256').update(canonicalJson(evidence)).digest('hex');
    const success = vi.fn(async () => ({
      ok: true, status: 201,
      json: async () => ({
        acknowledged: true, schemaVersion: 1, identity: recoveryIdentity, eventId: evidence.event.eventId,
        phase: 'base_deposit', state: 'submitting', recoveryVersion: 1,
        evidenceDigest, reportDigest,
        written: 1, duplicates: 0,
      }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, fetchImpl: success,
    });
    await expect(reporter.reportBaseEvidence(evidence)).resolves.toMatchObject({
      recoveryVersion: 1,
    });
    expect(success.mock.calls[0][0]).toBe('https://index.example/api/agent-index?action=base-child-evidence');

    const conflict = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 409 })),
    });
    await expect(conflict.reportBaseEvidence(evidence)).rejects.toBeInstanceOf(AgentIndexEvidenceConflictError);
    const unavailable = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 503 })),
    });
    await expect(unavailable.reportBaseEvidence(evidence)).rejects.toBeInstanceOf(AgentIndexReporterRetryableError);
  });

  it.each([
    ['batch recovery version', (ack) => { delete ack.children[0].recoveryVersion; }],
    ['batch extra field', (ack) => { ack.internal = true; }],
  ])('rejects a non-exact %s acknowledgement', async (_label, mutate) => {
    const batch = {
      idempotencyKey: 'burn-intent-42',
      burnUnits7: '10000000',
      children: [child],
    };
    const acknowledgement = {
      acknowledged: true, schemaVersion: 1, idempotencyKey: batch.idempotencyKey,
      requestDigest: createHash('sha256').update(canonicalJson(batch)).digest('hex'),
      children: [{ identity: recoveryIdentity, recoveryVersion: 0 }],
      written: 1, duplicates: 0,
    };
    mutate(acknowledgement);
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => acknowledgement,
      })),
    });
    await expect(reporter.commitIntentBatch(batch)).rejects.toThrow(/acknowledgement/i);
  });

  it.each([
    [409, AgentIndexBatchConflictError],
    [503, AgentIndexBatchRetryableError],
    [400, AgentIndexBatchPermanentError],
  ])('classifies batch HTTP %s for durable intent recovery', async (status, ErrorType) => {
    const batch = {
      idempotencyKey: 'burn-intent-42',
      burnUnits7: '10000000',
      children: [child],
    };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET,
      fetchImpl: vi.fn(async () => ({ ok: false, status })),
    });
    await expect(reporter.commitIntentBatch(batch)).rejects.toBeInstanceOf(ErrorType);
  });

  it.each([
    ['negative written', { written: -1, duplicates: 2 }],
    ['negative duplicates', { written: 2, duplicates: -1 }],
    ['count sum mismatch', { written: 0, duplicates: 0 }],
  ])('permanently rejects %s in a batch acknowledgement', async (_label, counts) => {
    const batch = {
      idempotencyKey: 'burn-intent-42',
      burnUnits7: '10000000',
      children: [child],
    };
    const acknowledgement = {
      acknowledged: true, schemaVersion: 1, idempotencyKey: batch.idempotencyKey,
      requestDigest: createHash('sha256').update(canonicalJson(batch)).digest('hex'),
      children: [{ identity: recoveryIdentity, recoveryVersion: 0 }], ...counts,
    };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => acknowledgement,
      })),
    });
    await expect(reporter.commitIntentBatch(batch)).rejects.toBeInstanceOf(AgentIndexBatchPermanentError);
  });

  it.each([
    ['missing report digest', (ack) => { delete ack.reportDigest; }],
    ['changed evidence digest', (ack) => { ack.evidenceDigest = 'f'.repeat(64); }],
    ['extra field', (ack) => { ack.internal = true; }],
  ])('rejects an evidence 201 with %s', async (_label, mutate) => {
    const request = {
      schemaVersion: 1, identity: recoveryIdentity, expectedRecoveryVersion: 0,
      event: {
        eventId: 'b'.repeat(64), phase: 'base_deposit', state: 'submitting',
        evidence: {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
          assets: '1000000', minShares: '900000',
        }, observedAt: 2_000_000_000_000,
      },
    };
    const acknowledgement = {
      acknowledged: true, schemaVersion: 1, identity: recoveryIdentity,
      eventId: request.event.eventId, phase: request.event.phase, state: request.event.state,
      recoveryVersion: 1,
      evidenceDigest: createHash('sha256').update(canonicalJson(request.event.evidence)).digest('hex'),
      reportDigest: createHash('sha256').update(canonicalJson(request)).digest('hex'),
      written: 1, duplicates: 0,
    };
    mutate(acknowledgement);
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => acknowledgement,
      })),
    });
    await expect(reporter.reportBaseEvidence(request)).rejects.toThrow(/acknowledgement/i);
  });

  it.each([
    ['missing mandatory caller', (request) => { delete request.event.evidence.caller; }],
    ['noncanonical router address', (request) => {
      request.event.evidence.yieldRouterAddress = `0x${'AA'.repeat(20)}`;
    }],
    ['wrong phase/state schema', (request) => { request.event.phase = 'cctp_mint'; }],
    ['field from another state', (request) => {
      request.event.evidence.transactionHash = `0x${'44'.repeat(32)}`;
    }],
  ])('rejects closed phase/state evidence with %s before fetch', async (_label, mutate) => {
    const request = {
      schemaVersion: 1, identity: recoveryIdentity, expectedRecoveryVersion: 0,
      event: {
        eventId: 'c'.repeat(64), phase: 'base_deposit', state: 'submitting',
        evidence: {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
          assets: '1000000', minShares: '900000',
        }, observedAt: 2_000_000_000_000,
      },
    };
    mutate(request);
    const fetchImpl = vi.fn();
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, fetchImpl,
    });
    await expect(reporter.reportBaseEvidence(request)).rejects.toThrow(/evidence|address|field/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Defect caught: the old reporter treated every response as optional analytics instead of a custody gate.
  it('accepts only a 201 acknowledgement matching schema and immutable child identity', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ acknowledged: true, identity, schemaVersion: 1 }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });

    await expect(reporter.commitIntent(child)).resolves.toEqual({
      acknowledged: true, identity, schemaVersion: 1,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://index.example/api/agent-index?action=base-child-intent');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual({ child });
  });

  // Defect caught: a caller mistake could forward a full approval/session payload to D1.
  it('rejects unexpected or sensitive child fields before making a network request', async () => {
    const fetchImpl = vi.fn();
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });
    await expect(reporter.commitIntent({
      ...child,
      serializedApproval: 'full-mandate-payload',
      sessionPrivateKey: 'must-never-leave-relayer',
    })).rejects.toThrow(/unexpected|secret|private|approval/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Defect caught: 401, D1 failure, malformed JSON, false acknowledgement, or schema drift could be mistaken for durability.
  it.each([
    ['reporter 401', { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }, /401/],
    ['D1 failure', { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }, /503/],
    ['malformed acknowledgement', { ok: true, status: 201, json: async () => ({ ok: true }) }, /acknowledgement/i],
    [
      'schema mismatch',
      {
        ok: true,
        status: 201,
        json: async () => ({ acknowledged: true, identity, schemaVersion: 2 }),
      },
      /schema/i,
    ],
    [
      'identity mismatch',
      {
        ok: true,
        status: 201,
        json: async () => ({
          acknowledged: true,
          identity: { ...identity, childId: 'other' },
          schemaVersion: 1,
        }),
      },
      /identity/i,
    ],
  ])('fails closed on %s', async (_label, response, expected) => {
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(reporter.commitIntent(child)).rejects.toThrow(expected);
  });

  // Defect caught: an unbounded reporter request could leave burn eligibility ambiguous forever.
  it('aborts a timed-out intent request and reports explicit non-success', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1,
      timeoutMs: 5, fetchImpl,
    });
    await expect(reporter.commitIntent(child)).rejects.toThrow(/timed out/i);
  });

  // Defect caught: lifecycle delivery lacked an authenticated, acknowledgement-validated reporter method.
  it('posts one lifecycle request and validates the acknowledged sequence', async () => {
    const request = {
      identity,
      expectedSequence: 0,
      lifecycle: { sequence: 1, status: 'submitted', evidence: { executionStatus: 'accepted' }, observedAt: 2_000_000_000_100 },
    };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        acknowledged: true,
        identity,
        sequence: 1,
        schemaVersion: 1,
      }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });
    await expect(reporter.reportLifecycle(request)).resolves.toMatchObject({
      sequence: 1,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://index.example/api/agent-index?action=base-child-lifecycle');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(request);
  });

  // Defect caught: startup treated configured strings as readiness without authenticating or
  // proving the remote D1 schema/store was writable.
  it('authenticates an exact schema/store readiness probe before workers can start', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ready: true,
        schemaVersion: 1,
        stores: {
          executionReceipts: true,
          baseChildIntents: true,
          baseRecoveryEvidence: true,
        },
      }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1, fetchImpl,
    });

    await expect(reporter.probe()).resolves.toEqual({
      ready: true,
      schemaVersion: 1,
      stores: {
        executionReceipts: true,
        baseChildIntents: true,
        baseRecoveryEvidence: true,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://index.example/api/agent-index?action=base-child-ready',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${SECRET}` }),
      }),
    );
  });

  it('requires only the global receipt store when Base execution is closed', async () => {
    const acknowledgement = {
      ready: true,
      schemaVersion: 1,
      stores: { executionReceipts: true },
    };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      schemaVersion: 1,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => acknowledgement,
      }),
    });

    await expect(reporter.probe({ baseCrossChainAvailable: false }))
      .resolves.toEqual(acknowledgement);
  });

  it.each([
    ['unauthorized', { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }],
    [
      'schema mismatch',
      {
        ok: true,
        status: 200,
        json: async () => ({
          ready: true,
          schemaVersion: 2,
          stores: {
            executionReceipts: true,
            baseChildIntents: true,
            baseRecoveryEvidence: true,
          },
        }),
      },
    ],
    [
      'store unavailable',
      {
        ok: true,
        status: 200,
        json: async () => ({
          ready: false,
          schemaVersion: 1,
          stores: {
            executionReceipts: true,
            baseChildIntents: true,
            baseRecoveryEvidence: true,
          },
        }),
      },
    ],
    [
      'receipt store missing',
      {
        ok: true,
        status: 200,
        json: async () => ({
          ready: true,
          schemaVersion: 1,
          stores: { baseChildIntents: true, baseRecoveryEvidence: true },
        }),
      },
    ],
    [
      'Base-child store missing',
      {
        ok: true,
        status: 200,
        json: async () => ({
          ready: true,
          schemaVersion: 1,
          stores: { executionReceipts: true, baseRecoveryEvidence: true },
        }),
      },
    ],
    [
      'recovery evidence store missing',
      {
        ok: true,
        status: 200,
        json: async () => ({
          ready: true,
          schemaVersion: 1,
          stores: { executionReceipts: true, baseChildIntents: true },
        }),
      },
    ],
  ])('fails the readiness probe on %s', async (_label, response) => {
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index', secret: SECRET, schemaVersion: 1,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(reporter.probe()).rejects.toThrow(/reporter|schema|ready|HTTP/i);
  });

  it('reads one exact full-identity recovery claim and validates the closed response', async () => {
    const claimIdentity = {
      networkId: 'stellar-testnet',
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3',
      childId: 'abcdef0123456789abcdef0123456789',
    };
    const bundle = {
      schemaVersion: 1,
      identity: claimIdentity,
      owner: `G${'A'.repeat(55)}`,
      agent: `C${'B'.repeat(55)}`,
      recoverable: true,
      recoveryVersion: 7,
      intent: {},
      phases: {},
      events: [],
    };
    const fetchImpl = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        identity: claimIdentity,
        action: 'submit-mint',
        phase: 'cctp_mint',
        reasonCode: 'base-attestation-confirmed',
        evidenceVersion: 7,
        lease: {
          identity: claimIdentity,
          owner: `G${'A'.repeat(55)}`,
          action: 'submit-mint',
          phase: 'cctp_mint',
          evidenceVersion: 7,
          holder: 'tab-42',
          leaseToken: 'a'.repeat(64),
          acquiredAt: 2_000_000_000_000,
          expiresAt: 2_000_000_030_000,
        },
        bundle,
      }),
    }));
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl,
    });

    await expect(
      reporter.readBaseRecoveryClaim({
        identity: claimIdentity,
        action: 'submit-mint',
        evidenceVersion: 7,
        leaseToken: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({
      action: 'submit-mint',
      phase: 'cctp_mint',
      evidenceVersion: 7,
      bundle,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://index.example/api/agent-index?action=base-recovery-claim');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      identity: claimIdentity,
      action: 'submit-mint',
      evidenceVersion: 7,
      leaseToken: 'a'.repeat(64),
    });
  });

  it('rejects a claim acknowledgement that returns a different lease token', async () => {
    const claimIdentity = {
      networkId: 'stellar-testnet',
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3',
      childId: 'abcdef0123456789abcdef0123456789',
    };
    const owner = `G${'A'.repeat(55)}`;
    const response = {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        identity: claimIdentity,
        action: 'submit-mint',
        phase: 'cctp_mint',
        reasonCode: 'base-attestation-confirmed',
        evidenceVersion: 7,
        lease: {
          identity: claimIdentity,
          owner,
          action: 'submit-mint',
          phase: 'cctp_mint',
          evidenceVersion: 7,
          holder: 'tab-42',
          leaseToken: 'b'.repeat(64),
          acquiredAt: 2_000_000_000_000,
          expiresAt: 2_000_000_030_000,
        },
        bundle: {
          schemaVersion: 1,
          identity: claimIdentity,
          owner,
          agent: `C${'B'.repeat(55)}`,
          recoverable: true,
          recoveryVersion: 7,
          intent: {},
          phases: {},
          events: [],
        },
      }),
    };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl: vi.fn(async () => response),
    });
    await expect(
      reporter.readBaseRecoveryClaim({
        identity: claimIdentity,
        action: 'submit-mint',
        evidenceVersion: 7,
        leaseToken: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/lease token/i);
  });

  it('rejects a renew acknowledgement that returns a different lease holder', async () => {
    const identity = {
      networkId: 'stellar-testnet',
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3',
      childId: 'abcdef0123456789abcdef0123456789',
    };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          identity,
          action: 'submit-mint',
          phase: 'cctp_mint',
          evidenceVersion: 7,
          lease: {
            holder: 'other-tab',
            leaseToken: 'a'.repeat(64),
            expiresAt: 2_000_000_030_000,
          },
        }),
      })),
    });
    await expect(
      reporter.renewBaseRecoveryClaim({
        identity,
        action: 'submit-mint',
        evidenceVersion: 7,
        holder: 'tab-42',
        leaseToken: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/lease token or timing|holder/i);
  });

  it('posts exact recovery renew/release envelopes and classifies stale conflicts', async () => {
    const identity = {
      networkId: 'stellar-testnet',
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3',
      childId: 'abcdef0123456789abcdef0123456789',
    };
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('base-recovery-renew')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ code: 'version-conflict' }),
        };
      }
      if (url.includes('base-recovery-release')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          identity,
          action: 'submit-mint',
          evidenceVersion: 7,
        }),
      };
    });
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl,
    });
    const common = {
      identity,
      action: 'submit-mint',
      evidenceVersion: 7,
      leaseToken: 'b'.repeat(64),
    };
    await expect(
      reporter.renewBaseRecoveryClaim({
        ...common,
        holder: 'tab-42',
      }),
    ).rejects.toBeInstanceOf(AgentIndexRecoveryVersionConflictError);
    await expect(reporter.releaseBaseRecoveryClaim(common)).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      ...common,
      holder: 'tab-42',
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual(common);
  });

  it('classifies an Agent Index lease conflict separately from retryable delivery', async () => {
    const identity = {
      networkId: 'stellar-testnet',
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      allocationId: 'run-42:bridge:aave-v3',
      childId: 'abcdef0123456789abcdef0123456789',
    };
    const reporter = createAgentIndexReporter({
      endpoint: 'https://index.example/api/agent-index',
      secret: SECRET,
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: 'lease-conflict' }),
      })),
    });
    await expect(
      reporter.releaseBaseRecoveryClaim({
        identity,
        action: 'submit-mint',
        evidenceVersion: 7,
        leaseToken: 'c'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(AgentIndexRecoveryLeaseConflictError);
  });
});
