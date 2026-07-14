import { describe, expect, it, vi } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { main as mintMandate } from '../../smoke/mint-mandate.mjs';

const FIXED_NOW = 1_800_000_000;
const YIELD_ROUTER = '0x00000000000000000000000000000000000000f1';

function makeDeps() {
  let capturedValidatorArgs;
  return {
    deps: {
      http: vi.fn(() => ({ transport: true })),
      createPublicClient: vi.fn(() => ({ client: true })),
      isAddress: vi.fn(() => true),
      privateKeyToAccount: vi.fn((key) => ({
        address: key.endsWith('22')
          ? '0x0000000000000000000000000000000000000022'
          : '0x0000000000000000000000000000000000000011',
      })),
      signerToEcdsaValidator: vi.fn(async () => ({ validator: 'owner' })),
      addressToEmptyAccount: vi.fn((address) => ({ address, empty: true })),
      toECDSASigner: vi.fn(async () => ({ signer: 'session' })),
      toPermissionValidator: vi.fn(async (_client, args) => {
        capturedValidatorArgs = args;
        return { validator: 'permission' };
      }),
      createKernelAccount: vi.fn(async () => ({
        address: '0x0000000000000000000000000000000000000033',
      })),
      serializePermissionAccount: vi.fn(async () => 'serialized-smoke-approval'),
    },
    getCapturedValidatorArgs: () => capturedValidatorArgs,
  };
}

describe('smoke farm mandate', () => {
  it('installs an actual SDK call policy plus an SDK-encoded finite timestamp policy', async () => {
    const harness = makeDeps();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await mintMandate({
        env: {
          ZERODEV_PROJECT_ID: 'project-id',
          RELAYER_BASE_PRIVKEY: `0x${'11'.repeat(32)}`,
          SMOKE_SESSION_PRIVKEY: `0x${'22'.repeat(32)}`,
          YIELD_ROUTER_ADDRESS: YIELD_ROUTER,
          BASE_SEPOLIA_RPC_URL: 'https://example.test',
        },
        nowSeconds: FIXED_NOW,
        deps: harness.deps,
      });
    } finally {
      log.mockRestore();
    }

    const policies = harness.getCapturedValidatorArgs().policies;
    expect(policies).toHaveLength(2);
    expect(policies.map((policy) => policy.policyParams.type)).toEqual(['call', 'timestamp']);
    expect(policies[0].getPolicyData()).not.toBe('0x');

    const timestamp = policies[1];
    expect(timestamp.policyParams).toMatchObject({
      validAfter: 0,
      validUntil: FIXED_NOW + 3600,
    });
    expect(
      decodeAbiParameters(
        [
          { type: 'uint48', name: 'validAfter' },
          { type: 'uint48', name: 'validUntil' },
        ],
        timestamp.getPolicyData(),
      ),
    ).toEqual([0, FIXED_NOW + 3600]);
  });
});
