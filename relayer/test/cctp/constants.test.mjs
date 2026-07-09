import { describe, it, expect } from 'vitest';
import {
  CCTP_DOMAIN, STELLAR_TESTNET, BASE_SEPOLIA, IRIS_SANDBOX_URL,
  MIN_FINALITY_STANDARD, MAX_FEE_STANDARD,
} from '../../src/cctp/constants.mjs';

describe('CCTP constants', () => {
  it('has the correct domain IDs (Circle-issued, not chain IDs)', () => {
    expect(CCTP_DOMAIN.STELLAR).toBe(27);
    expect(CCTP_DOMAIN.BASE).toBe(6);
  });

  it('Stellar contract addresses are well-formed StrKeys (56-char, C-prefixed)', () => {
    for (const key of ['tokenMessengerMinter', 'messageTransmitter', 'cctpForwarder', 'usdcSac']) {
      expect(STELLAR_TESTNET[key]).toMatch(/^C[A-Z0-9]{55}$/);
    }
    expect(STELLAR_TESTNET.usdcDecimals).toBe(7);
  });

  it('Base addresses are well-formed 0x addresses (40 hex chars)', () => {
    for (const key of ['tokenMessengerV2', 'messageTransmitterV2', 'tokenMinterV2', 'messageV2', 'usdc']) {
      expect(BASE_SEPOLIA[key]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(BASE_SEPOLIA.usdcDecimals).toBe(6);
  });

  it('defaults to Standard finality (>=2000) with zero max fee, matching the proven SP0 recipe', () => {
    expect(MIN_FINALITY_STANDARD).toBe(2000);
    expect(MAX_FEE_STANDARD).toBe(0n);
  });

  it('Iris sandbox URL is set', () => {
    expect(IRIS_SANDBOX_URL).toBe('https://iris-api-sandbox.circle.com');
  });
});
