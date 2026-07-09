import { describe, it, expect, vi } from 'vitest';

vi.mock('@zerodev/permissions', () => ({
  deserializePermissionAccount: vi.fn().mockResolvedValue({ address: '0xAccount', encodeCalls: vi.fn() }),
}));
vi.mock('@zerodev/permissions/signers', () => ({
  toECDSASigner: vi.fn().mockResolvedValue({ account: { address: '0xSessionKey' } }),
}));
vi.mock('@zerodev/sdk', () => ({
  createKernelAccountClient: vi.fn((args) => ({ ...args, account: args.account })),
  createZeroDevPaymasterClient: vi.fn(() => ({ sponsorUserOperation: vi.fn() })),
}));
vi.mock('@zerodev/sdk/constants', () => ({
  getEntryPoint: () => '0.7',
  KERNEL_V3_1: 'kernel-v3.1',
}));

const { reconstructSessionClient } = await import('../../src/base/session.mjs');
const { deserializePermissionAccount } = await import('@zerodev/permissions');
const { createKernelAccountClient } = await import('@zerodev/sdk');

describe('reconstructSessionClient', () => {
  it('reconstructs the approved account using the session private key, then builds a kernel client bound to it', async () => {
    const chain = { id: 84532, name: 'baseSepolia' };
    const client = await reconstructSessionClient({
      chain,
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/api/v3/proj/chain/84532',
      approval: 'serialized-approval-blob',
      // Valid 32-byte secp256k1 key: toECDSASigner is mocked so the derived account is ignored,
      // but the real viem privateKeyToAccount runs first and rejects a non-hex placeholder.
      sessionPrivateKey: `0x${'11'.repeat(32)}`,
    });

    expect(deserializePermissionAccount).toHaveBeenCalledWith(
      expect.anything(), '0.7', 'kernel-v3.1', 'serialized-approval-blob',
      expect.objectContaining({ account: expect.objectContaining({ address: '0xSessionKey' }) }),
    );
    expect(createKernelAccountClient).toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ address: '0xAccount' }), chain }),
    );
    expect(client.account.address).toBe('0xAccount');
  });
});
