import { describe, expect, it, vi } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { privateKeyToAccount } from 'viem/accounts';

vi.mock('@zerodev/permissions', () => ({
  deserializePermissionAccount: vi.fn().mockResolvedValue({ address: '0xAccount' }),
}));
vi.mock('@zerodev/permissions/signers', () => ({
  toECDSASigner: vi.fn().mockResolvedValue({ account: { address: '0xSessionKey' } }),
}));
vi.mock('@zerodev/sdk', () => ({
  createKernelAccountClient: vi.fn((args) => ({ ...args, account: args.account })),
  createZeroDevPaymasterClient: vi.fn(() => ({ sponsorUserOperation: vi.fn() })),
}));
vi.mock('@zerodev/sdk/constants', () => ({
  getEntryPoint: () => ({ address: '0xEntryPoint', version: '0.7' }),
  KERNEL_V3_1: '0.3.1',
}));

const { reconstructSessionClient, deriveSessionAddress, isStellarStrKey } = await import('../../src/base/session.mjs');
const { deserializePermissionAccount } = await import('@zerodev/permissions');
const { createKernelAccountClient } = await import('@zerodev/sdk');

describe('reconstructSessionClient', () => {
  it('uses only the supplied session signer to reconstruct the approved account', async () => {
    const chain = { id: 84532, name: 'baseSepolia' };
    const sessionPrivateKey = `0x${'11'.repeat(32)}`;
    const client = await reconstructSessionClient({
      chain,
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://bundler.example',
      approval: 'serialized-approval-blob',
      sessionPrivateKey,
    });

    expect(deserializePermissionAccount).toHaveBeenCalledWith(
      expect.anything(),
      { address: '0xEntryPoint', version: '0.7' },
      '0.3.1',
      'serialized-approval-blob',
      expect.objectContaining({ account: expect.objectContaining({ address: '0xSessionKey' }) }),
    );
    expect(createKernelAccountClient).toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ address: '0xAccount' }), chain }),
    );
    expect(client.account.address).toBe('0xAccount');
  });
});

describe('identity helpers', () => {
  it('derives the exact EVM session address', () => {
    const key = `0x${'22'.repeat(32)}`;
    expect(deriveSessionAddress(key)).toBe(privateKeyToAccount(key).address);
  });

  it('validates full Stellar G/C checksums', () => {
    const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
    const contract = StrKey.encodeContract(Buffer.alloc(32, 10));
    const bad = `${owner.slice(0, -1)}${owner.endsWith('A') ? 'B' : 'A'}`;
    expect(isStellarStrKey(owner)).toBe(true);
    expect(isStellarStrKey(contract)).toBe(true);
    expect(isStellarStrKey(bad)).toBe(false);
  });
});
