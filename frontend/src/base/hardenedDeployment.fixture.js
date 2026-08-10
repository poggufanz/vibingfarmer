// Complete synthetic verifier output used by frontend execution-path tests. Keeping the fixture
// closed and realistic prevents a generation label or address-only stub from becoming test
// authority.
export const HARDENED_BASE_DEPLOYMENT_FIXTURE = Object.freeze({
  base: {
    hardenedDeployment: {
      generation: 'hardened-v2',
      chainId: 84532,
      adminSafe: {
        address: '0x1111111111111111111111111111111111111111',
        proxyImplementation: '0x2222222222222222222222222222222222222222',
        runtimeCodeHash: `0x${'11'.repeat(32)}`,
        threshold: 1,
        owners: ['0x7777777777777777777777777777777777777777'],
      },
      yieldRouter: {
        address: '0x1111111111111111111111111111111111111111',
        deployTxHash: `0x${'22'.repeat(32)}`,
        deployBlockNumber: '12345',
        deployBlockHash: `0x${'33'.repeat(32)}`,
        rawRuntimeCodeHash: `0x${'44'.repeat(32)}`,
        normalizedRuntimeCodeHash: `0x${'55'.repeat(32)}`,
      },
      baseExitSweeper: {
        address: '0x4444444444444444444444444444444444444444',
        deployTxHash: `0x${'66'.repeat(32)}`,
        deployBlockNumber: '12346',
        deployBlockHash: `0x${'77'.repeat(32)}`,
        rawRuntimeCodeHash: `0x${'88'.repeat(32)}`,
        normalizedRuntimeCodeHash: `0x${'99'.repeat(32)}`,
      },
      route: {
        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        stellarDomain: 27,
        mintRecipient: `0x${'aa'.repeat(32)}`,
        destinationCaller: `0x${'bb'.repeat(32)}`,
        finalityThreshold: 1000,
      },
      selectors: {
        exitAllAndBurn: '0x4c9d247b',
        absent: ['0x0d390c9e', '0x9abaf267'],
      },
      pools: {
        enabled: [
          '0x1111111111111111111111111111111111111112',
          '0x1111111111111111111111111111111111111113',
          '0x1111111111111111111111111111111111111114',
        ],
        known: [
          '0x1111111111111111111111111111111111111112',
          '0x1111111111111111111111111111111111111113',
          '0x1111111111111111111111111111111111111114',
        ],
      },
      verification: { blockNumber: '12360', blockHash: `0x${'cc'.repeat(32)}` },
    },
  },
})
