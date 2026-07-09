// Ported from spikes/cctp-corridor/addresses.md (CCTP V2, Stellar Testnet <-> Base Sepolia).
// Confirmed live via spikes/cctp-corridor/roundtrip.mjs + reverse.mjs (spikes/SP0-GATE.md).

export const CCTP_DOMAIN = Object.freeze({
  STELLAR: 27,
  BASE: 6,
});

export const STELLAR_TESTNET = Object.freeze({
  tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
  messageTransmitter: 'CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY',
  cctpForwarder: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  usdcDecimals: 7,
});

export const BASE_SEPOLIA = Object.freeze({
  tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  tokenMinterV2: '0xb43db544E2c27092c107639Ad201b3dEfAbcF192',
  messageV2: '0xbaC0179bB358A8936169a63408C8481D582390C4',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  usdcDecimals: 6,
});

export const IRIS_SANDBOX_URL = 'https://iris-api-sandbox.circle.com';

// minFinalityThreshold: <=1000 = Fast, >=2000 = Standard (finalized). Default Standard (SP0).
export const MIN_FINALITY_STANDARD = 2000;
export const MAX_FEE_STANDARD = 0n;
