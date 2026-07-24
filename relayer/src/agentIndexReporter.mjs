const REPORT_FIELDS = [
  'version',
  'networkId',
  'owner',
  'bridgeAgent',
  'runId',
  'grantTxHash',
  'kernelAddress',
  'mandateBindingId',
  'mandateBindingHash',
  'baseJobId',
];

export const BASE_SEPOLIA_POOL_TARGETS = new Map([
  ['0x389250872044368759d3db5c09b2706a6628d4e0', 'aave-v3'],
  ['0x5e843a639f0555e2a6669601621befc887bdb479', 'morpho-blue'],
  ['0xadd3c1a75c7cef2516b51750959bd829a4ad4761', 'moonwell'],
]);

function canonicalAllocation(value) {
  const allocation = value || {};
  return {
    allocationId: allocation.allocationId,
    poolAddress: allocation.poolAddress,
    proxyTarget: allocation.proxyTarget,
    amount: {
      token: allocation.amount?.token,
      units: allocation.amount?.units,
      decimals: allocation.amount?.decimals,
    },
    executionStatus: allocation.executionStatus,
    custody: { location: allocation.custody?.location },
    txHash: allocation.txHash ?? null,
  };
}

function canonicalReport(record, allocation) {
  const out = {};
  for (const field of REPORT_FIELDS) out[field] = record?.[field];
  out.allocations = [canonicalAllocation(allocation)];
  return out;
}

export function associationIdempotencyKey(record, allocation) {
  return JSON.stringify([
    record?.networkId,
    record?.runId,
    allocation?.allocationId,
    allocation?.executionStatus,
    allocation?.txHash ?? null,
  ]);
}

function assertBinding(record, expectedBinding) {
  if (
    !record?.mandateBindingId ||
    !record?.mandateBindingHash ||
    record.mandateBindingId !== expectedBinding?.bindingId ||
    record.mandateBindingHash !== expectedBinding?.bindingHash
  ) {
    throw new Error('association report mandate binding does not match the exact relayer lookup');
  }
}

export function createAgentIndexReporter({
  endpoint,
  secret,
  fetchImpl = fetch,
  logger = console,
  maxAttempts = 3,
} = {}) {
  async function postAllocation(record, allocation) {
    const idempotencyKey = associationIdempotencyKey(record, allocation);
    let lastWarning = 'agent index reporting failed';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(canonicalReport(record, allocation)),
        });
        if (response?.ok) return null;
        lastWarning = `agent index reporting returned HTTP ${response?.status ?? 'unknown'}`;
      } catch {
        lastWarning = 'agent index reporting endpoint is unavailable';
      }
    }
    logger?.warn?.('[relayer] non-custodial agent index warning', {
      networkId: record?.networkId,
      runId: record?.runId,
      allocationId: allocation?.allocationId,
      executionStatus: allocation?.executionStatus,
      txHash: allocation?.txHash ?? null,
      warning: lastWarning,
    });
    return { allocationId: allocation?.allocationId, warning: lastWarning };
  }

  async function report(record, expectedBinding) {
    assertBinding(record, expectedBinding);
    const allocations = Array.isArray(record?.allocations) ? record.allocations : [];
    if (!endpoint || !secret) {
      const warning = 'agent index reporting is not configured';
      logger?.warn?.('[relayer] non-custodial agent index warning', {
        networkId: record?.networkId,
        runId: record?.runId,
        warning,
      });
      return { ok: false, reported: 0, warnings: [{ warning }] };
    }
    const results = await Promise.all(
      allocations.map((allocation) => postAllocation(record, allocation))
    );
    const warnings = results.filter(Boolean);
    return {
      ok: warnings.length === 0,
      reported: allocations.length - warnings.length,
      warnings,
    };
  }

  return { report };
}
