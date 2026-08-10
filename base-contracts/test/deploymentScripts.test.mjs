import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, keccak256 } from 'viem';
import {
  FOUNDRY_ARTIFACT_PATHS,
  deployHardenedStaging,
  loadValidatedFoundryArtifacts,
  validateDeploymentInputs,
} from '../scripts/deploy-hardened.mjs';
import {
  normalizeRuntimeBytecode,
  replayPoolRegistry,
  verifyHardenedDeployment,
  writeStagingRecord,
} from '../scripts/verify-hardened-deployment.mjs';

const A = (hex) => getAddress(`0x${hex.padStart(40, '0')}`);
const HASH = (byte) => `0x${byte.repeat(64)}`;
const CIRCLE_BASE_SEPOLIA_USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER = getAddress(
  '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
);
const ASSET_ABI = [{
  type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}];
const hashText = (value) => keccak256(new TextEncoder().encode(value));

function provenanceFixture() {
  const makeArtifact = ({ id, source, contract, bytecode, runtime, refs, viaIR }) => ({
    abi: contract === 'BaseExitSweeper' ? [{
      type: 'function', name: 'exitAllAndBurn', stateMutability: 'nonpayable',
      inputs: [{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
      outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    }] : [],
    bytecode: { object: bytecode },
    deployedBytecode: { object: runtime, immutableReferences: refs },
    id,
    metadata: {
      compiler: { version: '0.8.23+commit.f704f362' },
      settings: {
        optimizer: { enabled: false, runs: 200 },
        metadata: { bytecodeHash: 'ipfs' },
        compilationTarget: { [source]: contract },
        evmVersion: 'shanghai',
        libraries: {},
        ...(viaIR ? { viaIR: true } : {}),
      },
      sources: { [source]: { keccak256: HASH(contract === 'YieldRouter' ? 'a' : 'b') } },
    },
  });
  const artifacts = {
    yieldRouter: makeArtifact({
      id: 7, source: 'src/YieldRouter.sol', contract: 'YieldRouter', bytecode: '0x6000',
      runtime: '0x60aa', refs: { 10: [{ start: 1, length: 1 }] }, viaIR: false,
    }),
    baseExitSweeper: makeArtifact({
      id: 9, source: 'src/BaseExitSweeper.sol', contract: 'BaseExitSweeper', bytecode: '0x6001',
      runtime: '0x634c9d247b00', refs: {}, viaIR: true,
    }),
  };
  const buildInfoFileIds = {
    yieldRouter: '1111111111111111',
    baseExitSweeper: '2222222222222222',
  };
  const buildInfo = {
    yieldRouter: { id: buildInfoFileIds.yieldRouter, source_id_to_path: { 7: 'src/YieldRouter.sol' }, language: 'Solidity' },
    baseExitSweeper: { id: buildInfoFileIds.baseExitSweeper, source_id_to_path: { 9: 'src/BaseExitSweeper.sol' }, language: 'Solidity' },
  };
  const provenanceFor = (key, buildInfoId) => {
    const artifact = artifacts[key];
    const artifactText = JSON.stringify(artifact);
    const buildInfoText = JSON.stringify(buildInfo[key]);
    return {
      buildInfoId,
      artifactHash: hashText(artifactText),
      buildInfoHash: hashText(buildInfoText),
      sourceHash: artifact.metadata.sources[Object.keys(artifact.metadata.sources)[0]].keccak256,
      immutableReferences: structuredClone(artifact.deployedBytecode.immutableReferences),
      creationBytecodeHash: keccak256(artifact.bytecode.object),
      rawRuntimeTemplateHash: keccak256(artifact.deployedBytecode.object),
      normalizedRuntimeTemplateHash: keccak256(normalizeRuntimeBytecode(
        artifact.deployedBytecode.object,
        artifact.deployedBytecode.immutableReferences,
      )),
    };
  };
  const provenance = {
    yieldRouter: provenanceFor('yieldRouter', buildInfo.yieldRouter.id),
    baseExitSweeper: provenanceFor('baseExitSweeper', buildInfo.baseExitSweeper.id),
  };
  const reads = [];
  const readFile = async (path) => {
    const name = String(path);
    reads.push(name);
    if (name.endsWith(FOUNDRY_ARTIFACT_PATHS.yieldRouter)) return JSON.stringify(artifacts.yieldRouter);
    if (name.endsWith(FOUNDRY_ARTIFACT_PATHS.baseExitSweeper)) return JSON.stringify(artifacts.baseExitSweeper);
    if (name.endsWith(`${buildInfoFileIds.yieldRouter}.json`)) return JSON.stringify(buildInfo.yieldRouter);
    if (name.endsWith(`${buildInfoFileIds.baseExitSweeper}.json`)) return JSON.stringify(buildInfo.baseExitSweeper);
    throw new Error(`unexpected provenance read ${name}`);
  };
  return { artifacts, buildInfo, provenance, readFile, reads };
}

function fixture() {
  const foundry = provenanceFixture();
  const adminSafe = A('5afe');
  const usdc = CIRCLE_BASE_SEPOLIA_USDC;
  const messenger = CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER;
  const poolA = A('2001');
  const poolB = A('2002');
  const router = A('3001');
  const sweeper = A('3002');
  const calls = [];
  const config = {
    privateKey: `0x${'11'.repeat(32)}`,
    rpcUrl: 'http://offline.invalid',
    chainId: 84532,
    deployer: A('d00d'),
    adminSafe,
    pools: [poolA, poolB],
    route: {
      usdcAddress: usdc,
      tokenMessengerAddress: messenger,
      stellarDomain: 27,
      mintRecipient: `0x${'01'.repeat(32)}`,
      destinationCaller: `0x${'02'.repeat(32)}`,
      finalityThreshold: 1000,
    },
    artifactProvenance: foundry.provenance,
    artifacts: {
      yieldRouter: { abi: [], bytecode: { object: '0x6000' }, deployedBytecode: { object: '0x6000', immutableReferences: {} }, metadata: { compiler: {}, settings: {} } },
      baseExitSweeper: {
        abi: [{
          type: 'function', name: 'exitAllAndBurn', stateMutability: 'nonpayable',
          inputs: [{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
          outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        }],
        bytecode: { object: '0x6001' },
        deployedBytecode: { object: '0x634c9d247b00', immutableReferences: {} },
        metadata: { compiler: {}, settings: {} },
      },
    },
  };
  const receiptByHash = new Map([
    [HASH('1'), { status: 'success', contractAddress: router, blockNumber: 10n, blockHash: HASH('a') }],
    [HASH('2'), { status: 'success', blockNumber: 11n, blockHash: HASH('b') }],
    [HASH('3'), { status: 'success', blockNumber: 12n, blockHash: HASH('c') }],
    [HASH('4'), { status: 'success', contractAddress: sweeper, blockNumber: 13n, blockHash: HASH('d') }],
    [HASH('5'), { status: 'success', blockNumber: 14n, blockHash: HASH('e') }],
  ]);
  let deploys = 0;
  let writes = 0;
  let ownershipProposed = false;
  const deps = {
    readFile: foundry.readFile,
    publicClient: {
      async getChainId() { calls.push('validate:chain'); return 84532; },
      async getBytecode({ address }) { calls.push(`validate:code:${address}`); return address === sweeper ? '0x634c9d247b00' : '0x6000'; },
      async call() { const error = new Error('unknown selector'); error.data = '0x'; throw error; },
      async readContract({ address, functionName, args = [] }) {
        calls.push(`read:${functionName}:${address}:${args.join(',')}`);
        if (functionName === 'asset') return usdc;
        if (functionName === 'allowedPool' || functionName === 'knownPool') return true;
        if (functionName === 'owner') return config.deployer;
        if (functionName === 'pendingOwner') return ownershipProposed ? adminSafe : A('0');
        if (functionName === 'canonicalAsset' || functionName === 'usdc') return usdc;
        if (functionName === 'router') return router;
        if (functionName === 'tokenMessenger') return messenger;
        if (functionName === 'stellarDomain') return 27;
        if (functionName === 'mintRecipient') return config.route.mintRecipient;
        if (functionName === 'destinationCaller') return config.route.destinationCaller;
        if (functionName === 'FINALITY_THRESHOLD') return 1000;
        throw new Error(`unexpected read ${functionName}`);
      },
      async waitForTransactionReceipt({ hash }) { calls.push(`receipt:${hash}`); return receiptByHash.get(hash); },
    },
    walletClient: {
      async deployContract() { deploys++; calls.push(`write:deploy:${deploys}`); return deploys === 1 ? HASH('1') : HASH('4'); },
      async writeContract({ functionName }) {
        writes++;
        calls.push(`write:${functionName}`);
        if (functionName === 'transferOwnership') ownershipProposed = true;
        return [HASH('2'), HASH('3'), HASH('5')][writes - 1];
      },
    },
  };
  return { config, deps, calls, router, sweeper };
}

test('deployment modules are import-safe and never broadcast at top level', async () => {
  await assert.doesNotReject(import('../scripts/deploy.mjs?import-safe-test'));
});

test('artifact provenance loads only fixed Foundry outputs and pins build identity', async (t) => {
  const success = provenanceFixture();
  const loaded = await loadValidatedFoundryArtifacts(success.provenance, { readFile: success.readFile });
  assert.deepEqual(loaded.yieldRouter, success.artifacts.yieldRouter);
  assert.deepEqual(loaded.baseExitSweeper, success.artifacts.baseExitSweeper);
  assert.equal(success.reads.length, 4);
  assert.equal(success.reads.some((path) => path.endsWith(FOUNDRY_ARTIFACT_PATHS.yieldRouter)), true);
  assert.equal(success.reads.some((path) => path.endsWith(FOUNDRY_ARTIFACT_PATHS.baseExitSweeper)), true);

  const cases = [
    ['compiler', (x) => { x.artifacts.yieldRouter.metadata.compiler.version = '0.8.24'; }, /compiler version mismatch/],
    ['profile', (x) => { x.artifacts.baseExitSweeper.metadata.settings.viaIR = false; }, /compiler profile mismatch/],
    ['optimizer', (x) => { x.artifacts.yieldRouter.metadata.settings.optimizer.enabled = true; }, /optimizer settings mismatch/],
    ['EVM version', (x) => { x.artifacts.yieldRouter.metadata.settings.evmVersion = 'paris'; }, /EVM version mismatch/],
    ['metadata bytecode hash', (x) => { x.artifacts.yieldRouter.metadata.settings.metadata.bytecodeHash = 'none'; }, /metadata bytecode hash mismatch/],
    ['source', (x) => { x.artifacts.yieldRouter.metadata.settings.compilationTarget = { 'src/Fake.sol': 'YieldRouter' }; }, /compilation target mismatch/],
    ['contract', (x) => { x.artifacts.yieldRouter.metadata.settings.compilationTarget = { 'src/YieldRouter.sol': 'Fake' }; }, /compilation target mismatch/],
    ['source hash', (x) => { x.provenance.yieldRouter.sourceHash = HASH('c'); }, /source hash mismatch/],
    ['zero source identity', (x) => {
      x.artifacts.yieldRouter.metadata.sources['src/YieldRouter.sol'].keccak256 = HASH('0');
      x.provenance.yieldRouter.sourceHash = HASH('0');
      x.provenance.yieldRouter.artifactHash = hashText(JSON.stringify(x.artifacts.yieldRouter));
    }, /nonzero/],
    ['immutable references', (x) => { x.provenance.yieldRouter.immutableReferences = {}; }, /immutable references mismatch/],
    ['creation template', (x) => { x.provenance.yieldRouter.creationBytecodeHash = HASH('c'); }, /creation bytecode hash mismatch/],
    ['raw runtime template', (x) => { x.provenance.yieldRouter.rawRuntimeTemplateHash = HASH('c'); }, /raw runtime template hash mismatch/],
    ['normalized runtime template', (x) => { x.provenance.yieldRouter.normalizedRuntimeTemplateHash = HASH('c'); }, /normalized runtime template hash mismatch/],
    ['artifact file hash', (x) => { x.provenance.yieldRouter.artifactHash = HASH('c'); }, /artifact file hash mismatch/],
    ['build-info file hash', (x) => { x.provenance.yieldRouter.buildInfoHash = HASH('c'); }, /build-info file hash mismatch/],
    ['build-info ID', (x) => { x.buildInfo.yieldRouter.id = '3333333333333333'; }, /build-info ID mismatch/],
    ['build-info source map', (x) => { x.buildInfo.yieldRouter.source_id_to_path[7] = 'src/Fake.sol'; }, /build-info source mismatch/],
  ];
  for (const [name, mutate, expectedError] of cases) {
    await t.test(name, async () => {
      const input = provenanceFixture();
      mutate(input);
      await assert.rejects(
        loadValidatedFoundryArtifacts(input.provenance, { readFile: input.readFile }),
        expectedError,
      );
    });
  }
});

test('prevalidation rejects every invalid input class before the first wallet write', async (t) => {
  const checksumAddress = getAddress('0x1234567890abcdef1234567890abcdef12345678');
  const cases = [
    ['missing private key', /private key/i, ({ config }) => { delete config.privateKey; }],
    ['FILL_ME private key', /private key/i, ({ config }) => { config.privateKey = 'FILL_ME'; }],
    ['zero private key', /private key/i, ({ config }) => { config.privateKey = `0x${'00'.repeat(32)}`; }],
    ['missing RPC URL', /RPC URL/i, ({ config }) => { delete config.rpcUrl; }],
    ['blank RPC URL', /RPC URL/i, ({ config }) => { config.rpcUrl = '   '; }],
    ['FILL_ME RPC URL', /RPC URL/i, ({ config }) => { config.rpcUrl = 'FILL_ME'; }],
    ['missing admin Safe', /BASE_ADMIN_SAFE/i, ({ config }) => { delete config.adminSafe; }],
    ['FILL_ME admin Safe', /BASE_ADMIN_SAFE/i, ({ config }) => { config.adminSafe = 'FILL_ME'; }],
    ['zero admin Safe', /BASE_ADMIN_SAFE.*zero/i, ({ config }) => { config.adminSafe = A('0'); }],
    ['non-checksummed admin Safe', /BASE_ADMIN_SAFE.*checksum/i, ({ config }) => {
      config.adminSafe = checksumAddress.toLowerCase();
    }],
    ['missing pools', /at least one pool/i, ({ config }) => { delete config.pools; }],
    ['empty pools', /at least one pool/i, ({ config }) => { config.pools = []; }],
    ['FILL_ME pool', /pool\[0\].*missing/i, ({ config }) => { config.pools = ['FILL_ME']; }],
    ['zero pool', /pool\[0\].*zero/i, ({ config }) => { config.pools = [A('0')]; }],
    ['non-checksummed pool', /pool\[0\].*checksum/i, ({ config }) => {
      config.pools = [checksumAddress.toLowerCase()];
    }],
    ['duplicate pool', /duplicate pool/i, ({ config }) => {
      config.pools = [config.pools[0], config.pools[0]];
    }],
    ['wrong configured chain', /chain ID must be Base Sepolia/i, ({ config }) => {
      config.chainId = 1;
    }],
    ['wrong live chain', /RPC chain ID .* is not 84532/i, ({ deps }) => {
      deps.publicClient.getChainId = async () => 1;
    }],
    ['codeless admin Safe', /BASE_ADMIN_SAFE has no runtime code/i, ({ config, deps }) => {
      const original = deps.publicClient.getBytecode;
      deps.publicClient.getBytecode = async (request) =>
        request.address === config.adminSafe ? '0x' : original.call(deps.publicClient, request);
    }],
    ['codeless pool', /pool .* has no runtime code/i, ({ config, deps }) => {
      const original = deps.publicClient.getBytecode;
      deps.publicClient.getBytecode = async (request) =>
        request.address === config.pools[0] ? '0x' : original.call(deps.publicClient, request);
    }],
    ['pool with wrong asset', /pool .* has wrong asset/i, ({ config, deps }) => {
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) =>
        request.functionName === 'asset'
          ? config.route.tokenMessengerAddress
          : original.call(deps.publicClient, request);
    }],
  ];
  for (const [name, expectedError, mutate] of cases) {
    await t.test(name, async () => {
      const input = fixture();
      mutate(input);
      await assert.rejects(deployHardenedStaging(input.config, input.deps), expectedError);
      assert.equal(input.calls.some((entry) => entry.startsWith('write:')), false);
    });
  }
});

test('prevalidation hard-pins both Circle Base Sepolia contracts before any wallet write', async (t) => {
  const cases = [
    ['USDC', A('7001'), null],
    ['TokenMessenger', null, A('7002')],
    ['USDC and TokenMessenger', A('7001'), A('7002')],
  ];
  for (const [name, wrongUsdc, wrongMessenger] of cases) {
    await t.test(name, async () => {
      const { config, deps, calls } = fixture();
      if (wrongUsdc) config.route.usdcAddress = wrongUsdc;
      if (wrongMessenger) config.route.tokenMessengerAddress = wrongMessenger;
      const originalRead = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) => {
        if (
          request.functionName === 'asset'
            || request.functionName === 'canonicalAsset'
            || request.functionName === 'usdc'
        ) return config.route.usdcAddress;
        if (request.functionName === 'tokenMessenger') return config.route.tokenMessengerAddress;
        return originalRead.call(deps.publicClient, request);
      };

      await assert.rejects(
        deployHardenedStaging(config, deps),
        new RegExp(`Circle Base Sepolia ${name.replace(' and ', '|')}`, 'i'),
      );
      assert.equal(calls.some((entry) => entry.startsWith('write:')), false);
    });
  }
});

test('artifact provenance failure stops before the first wallet write', async () => {
  const { config, deps, calls } = fixture();
  config.artifactProvenance.yieldRouter.creationBytecodeHash = HASH('c');
  await assert.rejects(
    deployHardenedStaging(config, deps),
    /YieldRouter creation bytecode hash mismatch/,
  );
  assert.equal(calls.some((entry) => entry.startsWith('write:')), false);
});

test('pool asset prevalidation uses the exact ERC-4626 asset ABI', async () => {
  const { config, deps } = fixture();
  const originalRead = deps.publicClient.readContract;
  deps.publicClient.readContract = async (request) => {
    if (request.functionName === 'asset') assert.deepEqual(request.abi, ASSET_ABI);
    return originalRead.call(deps.publicClient, request);
  };
  await validateDeploymentInputs(config, deps);
});

test('staged deployment configures pools then pins sweeper and stops before Safe acceptance', async () => {
  const { config, deps, calls, router, sweeper } = fixture();
  const result = await deployHardenedStaging(config, deps);
  assert.equal(result.status, 'awaiting-safe-acceptance');
  assert.equal(result.router.address, router);
  assert.equal(result.sweeper.address, sweeper);
  assert.deepEqual(
    calls.filter((entry) => entry.startsWith('write:')),
    ['write:deploy:1', 'write:setPool', 'write:setPool', 'write:deploy:2', 'write:transferOwnership'],
  );
  assert.equal(calls.some((entry) => entry === 'write:acceptOwnership'), false);
});

test('staged deployment stops before ownership transfer on runtime identity mismatch', async () => {
  const { config, deps, calls, sweeper } = fixture();
  const originalGetBytecode = deps.publicClient.getBytecode;
  deps.publicClient.getBytecode = async ({ address }) => address === sweeper ? '0xdead' : originalGetBytecode.call(deps.publicClient, { address });
  await assert.rejects(deployHardenedStaging(config, deps), /runtime identity/i);
  assert.equal(calls.includes('write:transferOwnership'), false);
});

test('staged deployment rejects a callable legacy selector before ownership transfer', async () => {
  const { config, deps, calls } = fixture();
  deps.publicClient.call = async ({ data }) => {
    if (data.startsWith('0x0d390c9e')) return { data: '0x' };
    const error = new Error('execution reverted');
    error.data = '0x';
    throw error;
  };
  await assert.rejects(deployHardenedStaging(config, deps), /legacy selector 0x0d390c9e is callable/);
  assert.equal(calls.includes('write:transferOwnership'), false);
});

test('staged deployment fresh-reads every router and pool fact before ownership transfer', async (t) => {
  const cases = [
    ['router canonical asset', /router canonical asset mismatch/, ({ config, deps }) => {
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) =>
        request.functionName === 'canonicalAsset'
          ? config.route.tokenMessengerAddress
          : original.call(deps.publicClient, request);
    }],
    ['router owner', /router owner mismatch/, ({ config, deps }) => {
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) =>
        request.functionName === 'owner'
          ? config.adminSafe
          : original.call(deps.publicClient, request);
    }],
    ['router pending owner', /router pending owner mismatch/, ({ config, deps }) => {
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) =>
        request.functionName === 'pendingOwner'
          ? config.adminSafe
          : original.call(deps.publicClient, request);
    }],
    ['pool asset drift', /pool .* asset mismatch/, ({ config, deps }) => {
      const reads = new Map();
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) => {
        if (request.functionName === 'asset') {
          const count = (reads.get(request.address) || 0) + 1;
          reads.set(request.address, count);
          if (count > 1) return config.route.tokenMessengerAddress;
        }
        return original.call(deps.publicClient, request);
      };
    }],
    ['allowed pool drift', /pool .* not allowed/, ({ deps }) => {
      let reads = 0;
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) => {
        if (request.functionName === 'allowedPool') {
          reads++;
          if (reads > 2) return false;
        }
        return original.call(deps.publicClient, request);
      };
    }],
    ['known pool drift', /pool .* not known/, ({ deps }) => {
      let reads = 0;
      const original = deps.publicClient.readContract;
      deps.publicClient.readContract = async (request) => {
        if (request.functionName === 'knownPool') {
          reads++;
          if (reads > 2) return false;
        }
        return original.call(deps.publicClient, request);
      };
    }],
  ];
  for (const [name, expectedError, mutate] of cases) {
    await t.test(name, async () => {
      const input = fixture();
      mutate(input);
      await assert.rejects(deployHardenedStaging(input.config, input.deps), expectedError);
      assert.equal(input.calls.includes('write:transferOwnership'), false);
    });
  }
});

test('immutable-aware normalization accepts only mutations inside declared slots', () => {
  const template = '0x6001600260036004';
  const deployed = '0x6001ffff60036004';
  const refs = { 1: [{ start: 2, length: 2 }] };
  assert.equal(normalizeRuntimeBytecode(template, refs), normalizeRuntimeBytecode(deployed, refs));
  const outsideMutation = '0x6101ffff60036004';
  assert.notEqual(normalizeRuntimeBytecode(template, refs), normalizeRuntimeBytecode(outsideMutation, refs));
});

test('pool event replay requires an exact enabled set while preserving ever-known history', () => {
  const poolA = A('2001');
  const poolB = A('2002');
  const poolC = A('2003');
  const state = replayPoolRegistry([
    { pool: poolA, allowed: true },
    { pool: poolB, allowed: true },
    { pool: poolA, allowed: false },
    { pool: poolC, allowed: true },
  ]);
  assert.deepEqual(state.enabled, [poolB, poolC]);
  assert.deepEqual(state.known, [poolA, poolB, poolC]);
});

function verifierFixture({ extraPool = false } = {}) {
  const safe = A('5afe');
  const safeImpl = A('5100');
  const safeOwner = A('5101');
  const router = A('3001');
  const sweeper = A('3002');
  const usdc = CIRCLE_BASE_SEPOLIA_USDC;
  const messenger = CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER;
  const poolA = A('2001');
  const poolB = A('2002');
  const poolC = A('2003');
  const safeRuntime = '0x6002';
  const routerRuntime = '0x6000';
  const sweeperRuntime = '0x634c9d247b00';
  const routerTx = HASH('1');
  const sweeperTx = HASH('4');
  const route = {
    usdcAddress: usdc,
    tokenMessengerAddress: messenger,
    stellarDomain: 27,
    mintRecipient: `0x${'01'.repeat(32)}`,
    destinationCaller: `0x${'02'.repeat(32)}`,
    finalityThreshold: 1000,
  };
  const artifacts = {
    yieldRouter: { abi: [], deployedBytecode: { object: routerRuntime, immutableReferences: {} } },
    baseExitSweeper: {
      abi: [{
        type: 'function', name: 'exitAllAndBurn', stateMutability: 'nonpayable',
        inputs: [{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
        outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      }],
      deployedBytecode: { object: sweeperRuntime, immutableReferences: {} },
    },
  };
  const candidate = {
    generation: 'hardened-v2', chainId: 84532, verificationBlockNumber: '20', verificationBlockHash: HASH('f'), adminSafe: safe,
    yieldRouter: { address: router, deployTxHash: routerTx },
    baseExitSweeper: { address: sweeper, deployTxHash: sweeperTx },
  };
  const expected = {
    adminSafe: { address: safe, proxyImplementation: safeImpl, runtimeCodeHash: keccak256(safeRuntime), threshold: 1, owners: [safeOwner] },
    route,
    pools: [poolA, poolB],
    verification: { maxAgeSeconds: 120 },
    codeHashes: {
      yieldRouter: { rawRuntimeCodeHash: keccak256(routerRuntime), normalizedRuntimeCodeHash: keccak256(routerRuntime) },
      baseExitSweeper: { rawRuntimeCodeHash: keccak256(sweeperRuntime), normalizedRuntimeCodeHash: keccak256(sweeperRuntime) },
    },
  };
  const code = new Map([
    [safe, safeRuntime], [router, routerRuntime], [sweeper, sweeperRuntime], [usdc, '0x6003'],
    [messenger, '0x6004'], [poolA, '0x6005'], [poolB, '0x6006'], [poolC, '0x6007'],
  ]);
  const deps = { nowSeconds: 1_000n, publicClient: {
    async getChainId() { return 84532; },
    async getBlock() { return { number: 20n, hash: HASH('f'), timestamp: 950n }; },
    async getBytecode({ address }) { return code.get(address) || '0x'; },
    async call() { const error = new Error('unknown selector'); error.data = '0x'; throw error; },
    async getTransactionReceipt({ hash }) {
      if (hash === routerTx) return { status: 'success', contractAddress: router, blockNumber: 10n, blockHash: HASH('a') };
      return { status: 'success', contractAddress: sweeper, blockNumber: 12n, blockHash: HASH('b') };
    },
    async getLogs() {
      const logs = [poolA, poolB].map((pool) => ({ args: { pool, allowed: true } }));
      if (extraPool) logs.push({ args: { pool: poolC, allowed: true } });
      return logs;
    },
    async readContract({ address, functionName }) {
      if (address === safe && functionName === 'getThreshold') return 1n;
      if (address === safe && functionName === 'getOwners') return [safeOwner];
      if (address === safe && functionName === 'masterCopy') return safeImpl;
      if (address === router && functionName === 'canonicalAsset') return usdc;
      if (address === router && functionName === 'owner') return safe;
      if (address === router && functionName === 'pendingOwner') return A('0');
      if (address === router && (functionName === 'allowedPool' || functionName === 'knownPool')) return true;
      if ((address === poolA || address === poolB || address === poolC) && functionName === 'asset') return usdc;
      if (address === sweeper && functionName === 'usdc') return usdc;
      if (address === sweeper && functionName === 'router') return router;
      if (address === sweeper && functionName === 'tokenMessenger') return messenger;
      if (address === sweeper && functionName === 'stellarDomain') return 27;
      if (address === sweeper && functionName === 'mintRecipient') return route.mintRecipient;
      if (address === sweeper && functionName === 'destinationCaller') return route.destinationCaller;
      if (address === sweeper && functionName === 'FINALITY_THRESHOLD') return 1000;
      throw new Error(`unexpected read ${address} ${functionName}`);
    },
  } };
  return {
    candidate, expected, artifacts, deps, safe, safeImpl, safeOwner, router, sweeper, usdc,
    messenger, poolA, poolB, poolC, safeRuntime, routerRuntime, sweeperRuntime,
  };
}

test('verifier emits the exact canonical hardened schema from fresh reads', async () => {
  const input = verifierFixture();
  const record = await verifyHardenedDeployment(input, input.deps);
  const hardened = record.base.hardenedDeployment;
  assert.equal(hardened.generation, 'hardened-v2');
  assert.deepEqual(hardened.selectors, { exitAllAndBurn: '0x4c9d247b', absent: ['0x0d390c9e', '0x9abaf267'] });
  assert.deepEqual(hardened.pools.enabled, [input.poolA, input.poolB]);
  assert.deepEqual(hardened.pools.known, [input.poolA, input.poolB]);
  assert.equal(hardened.verification.blockNumber, '20');
  assert.deepEqual(Object.keys(hardened), [
    'generation', 'chainId', 'adminSafe', 'yieldRouter', 'baseExitSweeper', 'route',
    'selectors', 'pools', 'verification',
  ]);
  assert.deepEqual(Object.keys(hardened.adminSafe), [
    'address', 'proxyImplementation', 'runtimeCodeHash', 'threshold', 'owners',
  ]);
  assert.deepEqual(Object.keys(hardened.yieldRouter), [
    'address', 'deployTxHash', 'deployBlockNumber', 'deployBlockHash',
    'rawRuntimeCodeHash', 'normalizedRuntimeCodeHash',
  ]);
  assert.deepEqual(Object.keys(hardened.baseExitSweeper), Object.keys(hardened.yieldRouter));
  assert.equal(typeof hardened.yieldRouter.deployBlockNumber, 'string');
  assert.equal(typeof hardened.baseExitSweeper.deployBlockNumber, 'string');
  assert.equal(typeof hardened.verification.blockNumber, 'string');
});

test('verifier rejects separately and jointly mismatched Circle Base Sepolia contracts', async (t) => {
  const cases = [
    ['USDC', A('7001'), null],
    ['TokenMessenger', null, A('7002')],
    ['USDC and TokenMessenger', A('7001'), A('7002')],
  ];
  for (const [name, wrongUsdc, wrongMessenger] of cases) {
    await t.test(name, async () => {
      const input = verifierFixture();
      if (wrongUsdc) input.expected.route.usdcAddress = wrongUsdc;
      if (wrongMessenger) input.expected.route.tokenMessengerAddress = wrongMessenger;
      const originalCode = input.deps.publicClient.getBytecode;
      input.deps.publicClient.getBytecode = async (request) => {
        if (request.address === wrongUsdc || request.address === wrongMessenger) return '0x6008';
        return originalCode.call(input.deps.publicClient, request);
      };
      const originalRead = input.deps.publicClient.readContract;
      input.deps.publicClient.readContract = async (request) => {
        if (
          request.functionName === 'asset'
            || request.functionName === 'canonicalAsset'
            || request.functionName === 'usdc'
        ) return input.expected.route.usdcAddress;
        if (request.functionName === 'tokenMessenger') {
          return input.expected.route.tokenMessengerAddress;
        }
        return originalRead.call(input.deps.publicClient, request);
      };

      await assert.rejects(
        verifyHardenedDeployment(input, input.deps),
        new RegExp(`Circle Base Sepolia ${name.replace(' and ', '|')}`, 'i'),
      );
    });
  }
});

test('verifier rejects every all-zero deployment identity hash explicitly', async (t) => {
  const zeroHash = HASH('0');
  const cases = [
    ['verification hash', (x) => {
      x.candidate.verificationBlockHash = zeroHash;
      x.deps.publicClient.getBlock = async () => ({ number: 20n, hash: zeroHash, timestamp: 950n });
    }],
    ['router deploy transaction hash', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.candidate.yieldRouter.deployTxHash = zeroHash;
      x.deps.publicClient.getTransactionReceipt = async (request) =>
        request.hash === zeroHash
          ? { status: 'success', contractAddress: x.router, blockNumber: 10n, blockHash: HASH('a') }
          : original.call(x.deps.publicClient, request);
    }],
    ['sweeper deploy transaction hash', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.candidate.baseExitSweeper.deployTxHash = zeroHash;
      x.deps.publicClient.getTransactionReceipt = async (request) =>
        request.hash === zeroHash
          ? { status: 'success', contractAddress: x.sweeper, blockNumber: 12n, blockHash: HASH('b') }
          : original.call(x.deps.publicClient, request);
    }],
    ['router deployment block hash', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.deps.publicClient.getTransactionReceipt = async (request) => {
        const receipt = await original.call(x.deps.publicClient, request);
        return request.hash === x.candidate.yieldRouter.deployTxHash
          ? { ...receipt, blockHash: zeroHash }
          : receipt;
      };
    }],
    ['sweeper deployment block hash', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.deps.publicClient.getTransactionReceipt = async (request) => {
        const receipt = await original.call(x.deps.publicClient, request);
        return request.hash === x.candidate.baseExitSweeper.deployTxHash
          ? { ...receipt, blockHash: zeroHash }
          : receipt;
      };
    }],
    ['approved Safe runtime hash', (x) => { x.expected.adminSafe.runtimeCodeHash = zeroHash; }],
    ['approved router raw runtime hash', (x) => {
      x.expected.codeHashes.yieldRouter.rawRuntimeCodeHash = zeroHash;
    }],
    ['approved router normalized runtime hash', (x) => {
      x.expected.codeHashes.yieldRouter.normalizedRuntimeCodeHash = zeroHash;
    }],
    ['approved sweeper raw runtime hash', (x) => {
      x.expected.codeHashes.baseExitSweeper.rawRuntimeCodeHash = zeroHash;
    }],
    ['approved sweeper normalized runtime hash', (x) => {
      x.expected.codeHashes.baseExitSweeper.normalizedRuntimeCodeHash = zeroHash;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const input = verifierFixture();
      mutate(input);
      await assert.rejects(verifyHardenedDeployment(input, input.deps), /nonzero/i);
    });
  }
});

test('verifier enforces positive staged deployment chronology', async (t) => {
  const replaceReceipts = (input, routerBlock, sweeperBlock) => {
    input.deps.publicClient.getTransactionReceipt = async ({ hash }) =>
      hash === input.candidate.yieldRouter.deployTxHash
        ? {
          status: 'success',
          contractAddress: input.router,
          blockNumber: routerBlock,
          blockHash: HASH('a'),
        }
        : {
          status: 'success',
          contractAddress: input.sweeper,
          blockNumber: sweeperBlock,
          blockHash: HASH('b'),
        };
  };
  const cases = [
    ['zero verification block', /verification block number must be greater than zero/, (x) => {
      x.candidate.verificationBlockNumber = '0';
      x.deps.publicClient.getBlock = async () => ({ number: 0n, hash: HASH('f'), timestamp: 950n });
      replaceReceipts(x, 0n, 0n);
    }],
    ['zero router deployment block', /router deployment block must be greater than zero/, (x) => {
      replaceReceipts(x, 0n, 12n);
    }],
    ['zero sweeper deployment block', /sweeper deployment block must be greater than zero/, (x) => {
      replaceReceipts(x, 10n, 0n);
    }],
    ['router deployed after sweeper', /router deployment block must not be after sweeper/, (x) => {
      replaceReceipts(x, 13n, 12n);
    }],
  ];
  for (const [name, expectedError, mutate] of cases) {
    await t.test(name, async () => {
      const input = verifierFixture();
      mutate(input);
      await assert.rejects(verifyHardenedDeployment(input, input.deps), expectedError);
    });
  }
});

test('verifier accepts constructor changes only inside approved immutable slots with matching getters', async () => {
  const input = verifierFixture();
  const template = '0x600000';
  const runtime = '0x60ff00';
  const refs = { 1: [{ start: 1, length: 1 }] };
  input.artifacts.yieldRouter.deployedBytecode = { object: template, immutableReferences: refs };
  input.expected.codeHashes.yieldRouter.rawRuntimeCodeHash = keccak256(runtime);
  input.expected.codeHashes.yieldRouter.normalizedRuntimeCodeHash = keccak256(
    normalizeRuntimeBytecode(template, refs),
  );
  const originalCode = input.deps.publicClient.getBytecode;
  input.deps.publicClient.getBytecode = async (request) =>
    request.address === input.router ? runtime : originalCode.call(input.deps.publicClient, request);
  await assert.doesNotReject(verifyHardenedDeployment(input, input.deps));
});

test('verifier rejects a runtime mutation outside every declared immutable slot', async () => {
  const input = verifierFixture();
  const template = '0x600000';
  const outsideMutation = '0x60ff01';
  const refs = { 1: [{ start: 1, length: 1 }] };
  input.artifacts.yieldRouter.deployedBytecode = { object: template, immutableReferences: refs };
  input.expected.codeHashes.yieldRouter.rawRuntimeCodeHash = keccak256(outsideMutation);
  input.expected.codeHashes.yieldRouter.normalizedRuntimeCodeHash = keccak256(
    normalizeRuntimeBytecode(template, refs),
  );
  const originalCode = input.deps.publicClient.getBytecode;
  input.deps.publicClient.getBytecode = async (request) =>
    request.address === input.router
      ? outsideMutation
      : originalCode.call(input.deps.publicClient, request);

  await assert.rejects(
    verifyHardenedDeployment(input, input.deps),
    /YieldRouter runtime differs outside immutable slots/,
  );
});

test('verifier rejects an extra enabled pool discovered by event replay', async () => {
  const input = verifierFixture({ extraPool: true });
  await assert.rejects(verifyHardenedDeployment(input, input.deps), /enabled pools exact set mismatch/);
});

test('verifier rejects a candidate that is not the fresh finalized head', async () => {
  const input = verifierFixture();
  input.deps.publicClient.getBlock = async ({ blockTag }) => blockTag === 'finalized'
    ? { number: 21n, hash: HASH('e'), timestamp: 990n }
    : { number: 20n, hash: HASH('f'), timestamp: 950n };
  await assert.rejects(verifyHardenedDeployment(input, input.deps), /candidate is not the finalized head/);
});

test('verifier rejects a finalized head older than the explicit age bound', async () => {
  const input = verifierFixture();
  input.deps.publicClient.getBlock = async () => ({ number: 20n, hash: HASH('f'), timestamp: 800n });
  await assert.rejects(verifyHardenedDeployment(input, input.deps), /finalized head is stale/);
});

test('verifier requires the candidate verification block number as canonical decimal text', async () => {
  const input = verifierFixture();
  input.candidate.verificationBlockNumber = 20;
  await assert.rejects(
    verifyHardenedDeployment(input, input.deps),
    /verification block number must be a canonical decimal string/,
  );
});

test('verifier pins every mutable code/read/log/call observation to the finalized block', async () => {
  const input = verifierFixture();
  const client = input.deps.publicClient;
  for (const method of ['getBytecode', 'readContract', 'call']) {
    const original = client[method];
    client[method] = async (request) => {
      assert.equal(request.blockNumber, 20n, `${method} escaped the finalized block`);
      return original.call(client, request);
    };
  }
  const originalLogs = client.getLogs;
  client.getLogs = async (request) => {
    assert.equal(request.toBlock, 20n);
    return originalLogs.call(client, request);
  };
  await verifyHardenedDeployment(input, input.deps);
});

test('verifier uses the exact asset ABI and rejects both behaviorally callable legacy selectors', async (t) => {
  for (const selector of ['0x0d390c9e', '0x9abaf267']) {
    await t.test(selector, async () => {
      const input = verifierFixture();
      const originalRead = input.deps.publicClient.readContract;
      input.deps.publicClient.readContract = async (request) => {
        if (request.functionName === 'asset') assert.deepEqual(request.abi, ASSET_ABI);
        return originalRead.call(input.deps.publicClient, request);
      };
      input.deps.publicClient.call = async ({ data }) => {
        if (data.startsWith(selector)) return { data: '0x' };
        const error = new Error('execution reverted');
        error.data = '0x';
        throw error;
      };
      await assert.rejects(
        verifyHardenedDeployment(input, input.deps),
        new RegExp(`legacy selector ${selector} is callable`),
      );
    });
  }
});

test('verifier rejects legacy selector calls that dispatch into any nonempty revert', async (t) => {
  for (const selector of ['0x0d390c9e', '0x9abaf267']) {
    await t.test(selector, async () => {
      const input = verifierFixture();
      input.deps.publicClient.call = async ({ data }) => {
        const error = new Error('dispatched');
        error.data = data.startsWith(selector) ? '0xdead' : '0x';
        throw error;
      };
      await assert.rejects(
        verifyHardenedDeployment(input, input.deps),
        new RegExp(`legacy selector ${selector} dispatched with revert data 0xdead`),
      );
    });
  }
});

test('verifier rejects otherwise-valid runtime templates containing either legacy selector', async (t) => {
  for (const selector of ['0x0d390c9e', '0x9abaf267']) {
    await t.test(selector, async () => {
      const input = verifierFixture();
      const mutatedRuntime = `${input.sweeperRuntime}${selector.slice(2)}`;
      input.artifacts.baseExitSweeper.deployedBytecode.object = mutatedRuntime;
      input.expected.codeHashes.baseExitSweeper.rawRuntimeCodeHash = keccak256(mutatedRuntime);
      input.expected.codeHashes.baseExitSweeper.normalizedRuntimeCodeHash = keccak256(mutatedRuntime);
      const originalCode = input.deps.publicClient.getBytecode;
      input.deps.publicClient.getBytecode = async (request) =>
        request.address === input.sweeper ? mutatedRuntime : originalCode.call(input.deps.publicClient, request);

      await assert.rejects(
        verifyHardenedDeployment(input, input.deps),
        new RegExp(`legacy selector ${selector} present in sweeper runtime`),
      );
    });
  }
});

test('verifier rejects every pinned deployment fact independently', async (t) => {
  const replaceRead = (input, predicate, replacement) => {
    const original = input.deps.publicClient.readContract;
    input.deps.publicClient.readContract = async (request) =>
      predicate(request) ? replacement : original.call(input.deps.publicClient, request);
  };
  const cases = [
    ['generation', (x) => { x.candidate.generation = 'legacy'; }, /generation/],
    ['chain', (x) => { x.candidate.chainId = 1; }, /chain ID/],
    ['live RPC chain', (x) => { x.deps.publicClient.getChainId = async () => 1; }, /chain ID/],
    ['missing age policy', (x) => { delete x.expected.verification.maxAgeSeconds; }, /explicit finalized-head maxAgeSeconds/],
    ['future finalized head', (x) => {
      x.deps.publicClient.getBlock = async () => ({ number: 20n, hash: HASH('f'), timestamp: 1_001n });
    }, /finalized head is stale or from the future/],
    ['missing finalized head', (x) => { x.deps.publicClient.getBlock = async () => null; }, /missing finalized head/],
    ['verification hash', (x) => { x.candidate.verificationBlockHash = HASH('e'); }, /verification block hash mismatch/],
    ['admin address', (x) => { x.expected.adminSafe.address = A('dead'); }, /admin Safe mismatch/],
    ['admin Safe runtime code', (x) => {
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.safe ? '0x' : original.call(x.deps.publicClient, request);
    }, /admin Safe has no code/],
    ['USDC runtime code', (x) => {
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.usdc ? '0x' : original.call(x.deps.publicClient, request);
    }, /USDC has no code/],
    ['TokenMessenger runtime code', (x) => {
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.messenger ? '0x' : original.call(x.deps.publicClient, request);
    }, /TokenMessenger has no code/],
    ['router runtime code', (x) => {
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.router ? '0x' : original.call(x.deps.publicClient, request);
    }, /YieldRouter has no code/],
    ['sweeper runtime code', (x) => {
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.sweeper ? '0x' : original.call(x.deps.publicClient, request);
    }, /BaseExitSweeper has no code/],
    ['Safe implementation', (x) => { x.expected.adminSafe.proxyImplementation = A('dead'); }, /Safe implementation mismatch/],
    ['Safe runtime hash', (x) => { x.expected.adminSafe.runtimeCodeHash = HASH('c'); }, /Safe runtime hash mismatch/],
    ['Safe threshold', (x) => { x.expected.adminSafe.threshold = 2; }, /Safe threshold mismatch/],
    ['invalid live Safe threshold', (x) => replaceRead(x, (r) => r.address === x.safe && r.functionName === 'getThreshold', 2n), /Safe threshold is invalid/],
    ['Safe owners', (x) => { x.expected.adminSafe.owners = [A('dead')]; }, /Safe owners exact set mismatch/],
    ['router owner', (x) => replaceRead(x, (r) => r.address === x.router && r.functionName === 'owner', x.safeOwner), /router owner mismatch/],
    ['router pending owner', (x) => replaceRead(x, (r) => r.address === x.router && r.functionName === 'pendingOwner', x.safeOwner), /router pending owner mismatch/],
    ['router canonical asset', (x) => replaceRead(x, (r) => r.address === x.router && r.functionName === 'canonicalAsset', x.messenger), /router canonical asset mismatch/],
    ['router raw hash', (x) => { x.expected.codeHashes.yieldRouter.rawRuntimeCodeHash = HASH('c'); }, /router raw runtime hash mismatch/],
    ['missing router raw hash', (x) => { delete x.expected.codeHashes.yieldRouter.rawRuntimeCodeHash; }, /router raw runtime hash must be a lowercase bytes32 hash/],
    ['router normalized hash', (x) => { x.expected.codeHashes.yieldRouter.normalizedRuntimeCodeHash = HASH('c'); }, /router normalized runtime hash mismatch/],
    ['sweeper raw hash', (x) => { x.expected.codeHashes.baseExitSweeper.rawRuntimeCodeHash = HASH('c'); }, /sweeper raw runtime hash mismatch/],
    ['sweeper normalized hash', (x) => { x.expected.codeHashes.baseExitSweeper.normalizedRuntimeCodeHash = HASH('c'); }, /sweeper normalized runtime hash mismatch/],
    ['sweeper USDC', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'usdc', x.messenger), /sweeper usdc mismatch/],
    ['sweeper router', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'router', x.safe), /sweeper router mismatch/],
    ['sweeper messenger', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'tokenMessenger', x.usdc), /sweeper tokenMessenger mismatch/],
    ['Stellar domain getter', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'stellarDomain', 26), /sweeper stellarDomain mismatch/],
    ['mint recipient getter', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'mintRecipient', `0x${'03'.repeat(32)}`), /sweeper mintRecipient mismatch/],
    ['destination caller getter', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'destinationCaller', `0x${'03'.repeat(32)}`), /sweeper destinationCaller mismatch/],
    ['finality getter', (x) => replaceRead(x, (r) => r.address === x.sweeper && r.functionName === 'FINALITY_THRESHOLD', 999), /sweeper FINALITY_THRESHOLD mismatch/],
    ['expected route domain', (x) => { x.expected.route.stellarDomain = 26; }, /route constants mismatch/],
    ['expected route finality', (x) => { x.expected.route.finalityThreshold = 999; }, /route constants mismatch/],
    ['hardened selector ABI', (x) => { x.artifacts.baseExitSweeper.abi[0].inputs.splice(3, 1); }, /sweeper ABI exposes redirect or obsolete exit arguments/],
    ['hardened selector runtime', (x) => {
      const runtime = '0x6000';
      x.artifacts.baseExitSweeper.deployedBytecode.object = runtime;
      x.expected.codeHashes.baseExitSweeper.rawRuntimeCodeHash = keccak256(runtime);
      x.expected.codeHashes.baseExitSweeper.normalizedRuntimeCodeHash = keccak256(runtime);
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.sweeper ? runtime : original.call(x.deps.publicClient, request);
    }, /hardened exit selector absent/],
    ['expected pool set', (x) => { x.expected.pools.push(x.poolC); }, /enabled pools exact set mismatch/],
    ['allowed pool getter', (x) => replaceRead(x, (r) => r.address === x.router && r.functionName === 'allowedPool', false), /not allowed/],
    ['known pool getter', (x) => replaceRead(x, (r) => r.address === x.router && r.functionName === 'knownPool', false), /not known/],
    ['pool asset getter', (x) => replaceRead(x, (r) => r.address === x.poolA && r.functionName === 'asset', x.messenger), /pool .* asset mismatch/],
    ['pool runtime code', (x) => {
      const original = x.deps.publicClient.getBytecode;
      x.deps.publicClient.getBytecode = async (request) => request.address === x.poolA ? '0x' : original.call(x.deps.publicClient, request);
    }, /pool .* has no code/],
    ['router deployment receipt', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.deps.publicClient.getTransactionReceipt = async (request) => request.hash === x.candidate.yieldRouter.deployTxHash ? null : original.call(x.deps.publicClient, request);
    }, /router deployment receipt mismatch/],
    ['router failed deployment receipt', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.deps.publicClient.getTransactionReceipt = async (request) => request.hash === x.candidate.yieldRouter.deployTxHash
        ? { status: 'reverted', contractAddress: x.router, blockNumber: 10n, blockHash: HASH('a') }
        : original.call(x.deps.publicClient, request);
    }, /router deployment receipt mismatch/],
    ['router receipt missing block number', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.deps.publicClient.getTransactionReceipt = async (request) => request.hash === x.candidate.yieldRouter.deployTxHash
        ? { status: 'success', contractAddress: x.router, blockHash: HASH('a') }
        : original.call(x.deps.publicClient, request);
    }, /router deployment receipt mismatch/],
    ['sweeper deployment receipt', (x) => {
      const original = x.deps.publicClient.getTransactionReceipt;
      x.deps.publicClient.getTransactionReceipt = async (request) => request.hash === x.candidate.baseExitSweeper.deployTxHash
        ? null
        : original.call(x.deps.publicClient, request);
    }, /sweeper deployment receipt mismatch/],
    ['unexpected ever-known pool from event replay', (x) => {
      x.deps.publicClient.getLogs = async () => [
        { args: { pool: x.poolA, allowed: true } },
        { args: { pool: x.poolB, allowed: true } },
        { args: { pool: x.poolC, allowed: true } },
        { args: { pool: x.poolC, allowed: false } },
      ];
    }, /known pools exact set mismatch/],
    ['missing enabled pool event', (x) => {
      x.deps.publicClient.getLogs = async () => [{ args: { pool: x.poolA, allowed: true } }];
    }, /enabled pools exact set mismatch/],
  ];

  for (const [name, mutate, expectedError] of cases) {
    await t.test(name, async () => {
      const input = verifierFixture();
      mutate(input);
      await assert.rejects(verifyHardenedDeployment(input, input.deps), expectedError);
    });
  }
});

test('verifier exact-hash validates the independently approved Safe runtime hash', async () => {
  const input = verifierFixture();
  input.expected.adminSafe.runtimeCodeHash = input.expected.adminSafe.runtimeCodeHash.toUpperCase();
  await assert.rejects(
    verifyHardenedDeployment(input, input.deps),
    /expected Safe runtime hash must be a lowercase bytes32 hash/,
  );
});

test('staging writer refuses the canonical deployment path', async () => {
  await assert.rejects(writeStagingRecord('../deployments/base-sepolia.json', {}), /canonical deployment record is forbidden/);
});
