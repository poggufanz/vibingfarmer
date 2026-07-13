import { describe, expect, it, vi } from 'vitest';
import { main as smokeUnwind } from '../../smoke/smoke-unwind.mjs';

const CONFIG = {
  domains: {},
  base: {
    chain: { id: 84532 },
    rpcUrl: 'https://example.test',
    bundlerRpcUrl: 'https://bundler.example.test',
    yieldRouterAddress: '0x00000000000000000000000000000000000000F1',
    usdcAddress: '0x00000000000000000000000000000000000000DD',
    tokenMessengerV2Address: '0x00000000000000000000000000000000000000CC',
  },
  stellar: { forwarderAddress: 'CFAKEFORWARDER' },
};

describe('smoke unwind credential isolation', () => {
  it('uses namespace isolation to reject accidental farm-credential reuse before loading config', async () => {
    const loadConfig = vi.fn(() => {
      throw new Error('config must not load before credential isolation');
    });

    await expect(
      smokeUnwind({
        env: {
          SMOKE_SESSION_APPROVAL: 'farm-only-approval',
          SMOKE_SESSION_PRIVKEY: 'farm-only-private-key',
          SMOKE_STELLAR_PUBLIC: 'GRECIPIENT',
        },
        deps: { loadConfig },
      }),
    ).rejects.toThrow(
      /namespace.*accidental reuse.*does not validate.*on-chain policy.*SMOKE_UNWIND_SESSION_APPROVAL/is,
    );
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('forwards separately named credentials without claiming their serialized policy was inspected', async () => {
    const unwind = vi.fn(async () => ({
      withdrawResults: [],
      burnResult: { txHash: '0xburn' },
      mintResult: { mintTxHash: 'stellar-mint', status: 'SUCCESS' },
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await smokeUnwind({
        env: {
          SMOKE_UNWIND_SESSION_APPROVAL: 'reverse-only-approval',
          SMOKE_UNWIND_SESSION_PRIVKEY: 'reverse-only-private-key',
          SMOKE_STELLAR_PUBLIC: 'GRECIPIENT',
        },
        deps: {
          loadConfig: vi.fn(() => CONFIG),
          createWatcher: vi.fn(() => ({ watcher: true })),
          createUnwindFlow: vi.fn(() => ({ unwind })),
          reconstructSessionClient: vi.fn(),
          contractStrkeyToBytes32: vi.fn(() => '0xrecipient'),
          writeFileSync: vi.fn(),
        },
      });
    } finally {
      log.mockRestore();
    }

    expect(unwind).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: 'reverse-only-approval',
        signerPrivateKey: 'reverse-only-private-key',
      }),
    );
  });
});
