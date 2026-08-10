import { describe, expect, it } from 'vitest';
import * as deploymentFactsModule from '../src/deploymentFacts.mjs';

const { loadDeploymentFacts, validateDeploymentFacts } = deploymentFactsModule;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const HARDENED_ROUTER = '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD';
const HARDENED_SWEEPER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
const ADMIN_SAFE = '0x1234567890AbcdEF1234567890aBcdef12345678';
const SAFE_IMPLEMENTATION = '0xCafEBAbECAFEbAbEcaFEbabECAfebAbEcAFEBaBe';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const POOLS = [
  '0x389250872044368759D3db5C09b2706A6628d4e0',
  '0x5E843A639F0555E2A6669601621befC887Bdb479',
  '0xadD3c1A75c7Cef2516b51750959BD829a4AD4761',
];

function hardenedRecord() {
  return {
    generation: 'hardened-v2',
    chainId: 84532,
    adminSafe: {
      address: ADMIN_SAFE,
      proxyImplementation: SAFE_IMPLEMENTATION,
      runtimeCodeHash: `0x${'11'.repeat(32)}`,
      threshold: 2,
      owners: [
        '0x389250872044368759D3db5C09b2706A6628d4e0',
        '0x5E843A639F0555E2A6669601621befC887Bdb479',
      ],
    },
    yieldRouter: {
      address: HARDENED_ROUTER,
      deployTxHash: `0x${'21'.repeat(32)}`,
      deployBlockNumber: '21000123',
      deployBlockHash: `0x${'22'.repeat(32)}`,
      rawRuntimeCodeHash: `0x${'23'.repeat(32)}`,
      normalizedRuntimeCodeHash: `0x${'24'.repeat(32)}`,
    },
    baseExitSweeper: {
      address: HARDENED_SWEEPER,
      deployTxHash: `0x${'31'.repeat(32)}`,
      deployBlockNumber: '21000129',
      deployBlockHash: `0x${'32'.repeat(32)}`,
      rawRuntimeCodeHash: `0x${'33'.repeat(32)}`,
      normalizedRuntimeCodeHash: `0x${'34'.repeat(32)}`,
    },
    route: {
      usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarDomain: 27,
      mintRecipient: `0x${'41'.repeat(32)}`,
      destinationCaller: `0x${'42'.repeat(32)}`,
      finalityThreshold: 1000,
    },
    selectors: {
      exitAllAndBurn: '0x4c9d247b',
      absent: ['0x0d390c9e', '0x9abaf267'],
    },
    pools: {
      enabled: [...POOLS],
      known: [...POOLS],
    },
    verification: {
      blockNumber: '21000150',
      blockHash: `0x${'51'.repeat(32)}`,
    },
  };
}

function validatedHardenedFacts(mutate = () => {}) {
  const loaded = loadDeploymentFacts();
  const stellar = clone(loaded.raw.stellar);
  const base = clone(loaded.raw.base);
  const approvedHardenedDeployment = hardenedRecord();
  base.hardenedDeployment = clone(approvedHardenedDeployment);
  mutate(base.hardenedDeployment);
  return validateDeploymentFacts(
    { stellar, base },
    { approvedHardenedDeployment },
  );
}

function validatedIdenticallyMalformedFacts(mutate) {
  const loaded = loadDeploymentFacts();
  const stellar = clone(loaded.raw.stellar);
  const base = clone(loaded.raw.base);
  const malformed = hardenedRecord();
  mutate(malformed);
  const approvedHardenedDeployment = structuredClone(malformed);
  base.hardenedDeployment = structuredClone(malformed);
  return validateDeploymentFacts(
    { stellar, base },
    { approvedHardenedDeployment },
  );
}

describe('Base deployment availability', () => {
  it('loads the tracked legacy deployment as historical facts while Base execution stays closed', () => {
    const facts = loadDeploymentFacts();

    expect(facts.base.yieldRouterAddress).toBe('0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d');
    expect(facts.base.baseCrossChainAvailable).toBe(false);
    expect(facts.base.unavailableReason).toBe('Hardened Base deployment is not active.');
    expect(facts.stellar.networkId).toBe('stellar-testnet');
  });

  it('does not let a hardened-v2 generation label enable the tracked legacy contracts', () => {
    const loaded = loadDeploymentFacts();
    const stellar = clone(loaded.raw.stellar);
    const base = clone(loaded.raw.base);
    base.generation = 'hardened-v2';

    const facts = validateDeploymentFacts({ stellar, base });

    expect(facts.base.baseCrossChainAvailable).toBe(false);
    expect(facts.base.unavailableReason).toBe('Hardened Base deployment is not active.');
  });

  it('enables only an exact separately approved and verified hardened deployment record', () => {
    const facts = validatedHardenedFacts();

    expect(facts.base.baseCrossChainAvailable).toBe(true);
    expect(facts.base.unavailableReason).toBeNull();
    expect(facts.base.yieldRouterAddress).toBe(HARDENED_ROUTER);
    expect(facts.base.baseExitSweeperAddress).toBe(HARDENED_SWEEPER);
    expect(facts.base.allowedPools).toEqual(POOLS);
    expect(facts.base.mandatePolicy).toMatchObject({
      chainId: 84532,
      usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      yieldRouterAddress: HARDENED_ROUTER,
    });
    expect(Object.isFrozen(facts.base.hardenedDeployment)).toBe(true);
  });

  it('accepts the exact serialized verifier envelope and rejects outer schema expansion', () => {
    const approvedHardenedDeployment = hardenedRecord();
    const envelope = JSON.parse(JSON.stringify({
      base: { hardenedDeployment: approvedHardenedDeployment },
    }));
    const evaluateEnvelope = deploymentFactsModule.evaluateHardenedBaseDeploymentEnvelope;

    expect(evaluateEnvelope?.(envelope, approvedHardenedDeployment)).toMatchObject({
      baseCrossChainAvailable: true,
      unavailableReason: null,
    });
    envelope.base.verifierRpcBody = { result: 'private' };
    expect(evaluateEnvelope?.(envelope, approvedHardenedDeployment)).toMatchObject({
      baseCrossChainAvailable: false,
      unavailableReason: 'Hardened Base deployment verification failed.',
    });
  });

  it.each([
    ['numeric router deploy block', (record) => { record.yieldRouter.deployBlockNumber = 21000123; }],
    ['numeric sweeper deploy block', (record) => { record.baseExitSweeper.deployBlockNumber = 21000129; }],
    ['numeric verification block', (record) => { record.verification.blockNumber = 21000150; }],
    ['zero router deploy block', (record) => { record.yieldRouter.deployBlockNumber = '0'; }],
    ['zero sweeper deploy block', (record) => { record.baseExitSweeper.deployBlockNumber = '0'; }],
    ['zero verification block', (record) => { record.verification.blockNumber = '0'; }],
    ['sweeper deployment before router deployment', (record) => {
      record.yieldRouter.deployBlockNumber = '21000130';
    }],
    ['verification before sweeper deployment', (record) => {
      record.verification.blockNumber = '21000125';
    }],
    ['boxed admin hash', (record) => {
      record.adminSafe.runtimeCodeHash = new String(record.adminSafe.runtimeCodeHash);
    }],
    ['boxed router hash', (record) => {
      record.yieldRouter.rawRuntimeCodeHash = new String(record.yieldRouter.rawRuntimeCodeHash);
    }],
    ['boxed sweeper hash', (record) => {
      record.baseExitSweeper.normalizedRuntimeCodeHash = new String(
        record.baseExitSweeper.normalizedRuntimeCodeHash,
      );
    }],
    ['boxed route bytes32', (record) => {
      record.route.mintRecipient = new String(record.route.mintRecipient);
    }],
    ['boxed verification hash', (record) => {
      record.verification.blockHash = new String(record.verification.blockHash);
    }],
    ['zero admin Safe', (record) => { record.adminSafe.address = ZERO_ADDRESS; }],
    ['zero Safe implementation', (record) => {
      record.adminSafe.proxyImplementation = ZERO_ADDRESS;
    }],
    ['zero router', (record) => { record.yieldRouter.address = ZERO_ADDRESS; }],
    ['zero sweeper', (record) => { record.baseExitSweeper.address = ZERO_ADDRESS; }],
    ['zero Safe owner', (record) => { record.adminSafe.owners[0] = ZERO_ADDRESS; }],
    ['zero enabled and known pool', (record) => {
      record.pools.enabled[0] = ZERO_ADDRESS;
      record.pools.known[0] = ZERO_ADDRESS;
    }],
    ['zero admin runtime hash', (record) => { record.adminSafe.runtimeCodeHash = ZERO_HASH; }],
    ['zero router deploy transaction hash', (record) => { record.yieldRouter.deployTxHash = ZERO_HASH; }],
    ['zero router deploy block hash', (record) => { record.yieldRouter.deployBlockHash = ZERO_HASH; }],
    ['zero router raw runtime hash', (record) => { record.yieldRouter.rawRuntimeCodeHash = ZERO_HASH; }],
    ['zero router normalized runtime hash', (record) => {
      record.yieldRouter.normalizedRuntimeCodeHash = ZERO_HASH;
    }],
    ['zero sweeper deploy transaction hash', (record) => {
      record.baseExitSweeper.deployTxHash = ZERO_HASH;
    }],
    ['zero sweeper deploy block hash', (record) => {
      record.baseExitSweeper.deployBlockHash = ZERO_HASH;
    }],
    ['zero sweeper raw runtime hash', (record) => {
      record.baseExitSweeper.rawRuntimeCodeHash = ZERO_HASH;
    }],
    ['zero sweeper normalized runtime hash', (record) => {
      record.baseExitSweeper.normalizedRuntimeCodeHash = ZERO_HASH;
    }],
    ['zero verification block hash', (record) => { record.verification.blockHash = ZERO_HASH; }],
    ['non-EIP55 admin Safe', (record) => {
      record.adminSafe.address = record.adminSafe.address.toLowerCase();
    }],
    ['non-EIP55 Safe implementation', (record) => {
      record.adminSafe.proxyImplementation = record.adminSafe.proxyImplementation.toLowerCase();
    }],
    ['non-EIP55 router', (record) => {
      record.yieldRouter.address = record.yieldRouter.address.toLowerCase();
    }],
    ['non-EIP55 sweeper', (record) => {
      record.baseExitSweeper.address = record.baseExitSweeper.address.toLowerCase();
    }],
    ['non-EIP55 Safe owner', (record) => {
      record.adminSafe.owners[0] = record.adminSafe.owners[0].toLowerCase();
    }],
    ['non-EIP55 pool', (record) => {
      record.pools.enabled[0] = record.pools.enabled[0].toLowerCase();
      record.pools.known[0] = record.pools.known[0].toLowerCase();
    }],
    ['uppercase admin bytes32', (record) => {
      record.adminSafe.runtimeCodeHash = `0x${'AB'.repeat(32)}`;
    }],
    ['uppercase router bytes32', (record) => {
      record.yieldRouter.deployTxHash = `0x${'AB'.repeat(32)}`;
    }],
    ['uppercase route bytes32', (record) => {
      record.route.destinationCaller = `0x${'AB'.repeat(32)}`;
    }],
    ['uppercase verification bytes32', (record) => {
      record.verification.blockHash = `0x${'AB'.repeat(32)}`;
    }],
    ['emitted router owner field', (record) => { record.yieldRouter.owner = ADMIN_SAFE; }],
    ['emitted router pending-owner field', (record) => {
      record.yieldRouter.pendingOwner = ZERO_ADDRESS;
    }],
    ['expanded route schema', (record) => { record.route.verifierRpcBody = {}; }],
    ['duplicate Safe owner set', (record) => {
      record.adminSafe.owners[1] = record.adminSafe.owners[0];
    }],
    ['unsorted Safe owner set', (record) => { record.adminSafe.owners.reverse(); }],
    ['duplicate enabled/known pool sets', (record) => {
      record.pools.enabled[1] = record.pools.enabled[0];
      record.pools.known[1] = record.pools.known[0];
    }],
    ['unsorted enabled/known pool sets', (record) => {
      record.pools.enabled.reverse();
      record.pools.known.reverse();
    }],
    ['verification before router deployment', (record) => {
      record.verification.blockNumber = '21000122';
    }],
  ])('rejects an identically approved invalid %s', (_label, mutate) => {
    const facts = validatedIdenticallyMalformedFacts(mutate);
    expect(facts.base.baseCrossChainAvailable).toBe(false);
    expect(facts.base.unavailableReason).toBe('Hardened Base deployment verification failed.');
  });

  it.each([
    ['generation', (record) => { record.generation = 'HARDENED-V2'; }],
    ['chain', (record) => { record.chainId = 8453; }],
    ['admin checksum', (record) => { record.adminSafe.address = record.adminSafe.address.toLowerCase(); }],
    ['admin code', (record) => { record.adminSafe.runtimeCodeHash = `0x${'91'.repeat(32)}`; }],
    ['Safe implementation', (record) => { record.adminSafe.proxyImplementation = HARDENED_ROUTER; }],
    ['Safe threshold', (record) => { record.adminSafe.threshold = 1; }],
    ['Safe owners', (record) => { record.adminSafe.owners.pop(); }],
    ['router address', (record) => { record.yieldRouter.address = HARDENED_SWEEPER; }],
    ['emitted router owner', (record) => { record.yieldRouter.owner = ADMIN_SAFE; }],
    ['emitted router pending owner', (record) => {
      record.yieldRouter.pendingOwner = '0x0000000000000000000000000000000000000000';
    }],
    ['router deploy tx', (record) => { record.yieldRouter.deployTxHash = `0x${'92'.repeat(32)}`; }],
    ['router deploy block', (record) => { record.yieldRouter.deployBlockNumber = '021000123'; }],
    ['router raw runtime hash', (record) => { record.yieldRouter.rawRuntimeCodeHash = `0x${'93'.repeat(32)}`; }],
    ['router normalized runtime hash', (record) => { record.yieldRouter.normalizedRuntimeCodeHash = `0x${'94'.repeat(32)}`; }],
    ['sweeper address', (record) => { record.baseExitSweeper.address = HARDENED_ROUTER; }],
    ['sweeper deploy tx', (record) => { record.baseExitSweeper.deployTxHash = `0x${'95'.repeat(32)}`; }],
    ['sweeper raw runtime hash', (record) => { record.baseExitSweeper.rawRuntimeCodeHash = `0x${'96'.repeat(32)}`; }],
    ['sweeper normalized runtime hash', (record) => { record.baseExitSweeper.normalizedRuntimeCodeHash = `0x${'97'.repeat(32)}`; }],
    ['USDC', (record) => { record.route.usdcAddress = HARDENED_ROUTER; }],
    ['messenger', (record) => { record.route.tokenMessengerAddress = HARDENED_ROUTER; }],
    ['domain', (record) => { record.route.stellarDomain = 6; }],
    ['mint recipient', (record) => { record.route.mintRecipient = `0x${'98'.repeat(32)}`; }],
    ['forwarder', (record) => { record.route.destinationCaller = `0x${'99'.repeat(32)}`; }],
    ['finality', (record) => { record.route.finalityThreshold = 2000; }],
    ['five-argument selector', (record) => { record.selectors.exitAllAndBurn = '0x0d390c9e'; }],
    ['absent selectors', (record) => { record.selectors.absent = ['0x9abaf267']; }],
    ['disabled pool', (record) => { record.pools.enabled.pop(); }],
    ['unknown pool', (record) => { record.pools.known.pop(); }],
    ['extra pool', (record) => { record.pools.enabled.push('0x389250872044368759D3db5C09b2706A6628d4e0'); }],
    ['extra enabled and known pool', (record) => {
      record.pools.enabled.push('0x389250872044368759D3db5C09b2706A6628d4e0');
      record.pools.known.push('0x389250872044368759D3db5C09b2706A6628d4e0');
    }],
    ['pool order', (record) => { record.pools.enabled.reverse(); record.pools.known.reverse(); }],
    ['verification block mismatch', (record) => { record.verification.blockNumber = '21000149'; }],
    ['verification block hash', (record) => { record.verification.blockHash = `0x${'90'.repeat(32)}`; }],
    ['unexpected field', (record) => { record.route.rpcBody = 'secret verifier detail'; }],
  ])('keeps Base unavailable when the approved hardened %s fact is mutated', (_label, mutate) => {
    const facts = validatedHardenedFacts(mutate);

    expect(facts.base.baseCrossChainAvailable).toBe(false);
    expect(facts.base.unavailableReason).toBe('Hardened Base deployment verification failed.');
    expect(JSON.stringify(facts.base)).not.toContain('secret verifier detail');
  });
});
