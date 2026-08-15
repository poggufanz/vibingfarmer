import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiItem,
  parseAbiParameters,
  toFunctionSelector,
} from 'viem';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const HARDENED_SELECTOR = '0x4c9d247b';
const ABSENT_SELECTORS = ['0x0d390c9e', '0x9abaf267'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
export const CIRCLE_BASE_SEPOLIA_USDC = getAddress(
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
);
export const CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER = getAddress(
  '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
);
export const ERC4626_ASSET_ABI = [{
  type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }],
}];
const VALID_HOOK = `0x${'00'.repeat(24)}0000000000000038${Buffer.from(
  'GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M',
).toString('hex')}`;
const LEGACY_CALLDATA = new Map([
  [
    '0x0d390c9e',
    `0x0d390c9e${encodeAbiParameters(
      parseAbiParameters('address[] pools, uint256[] floors, uint256 maxFee, bytes hookData'),
      [[], [], 0n, VALID_HOOK],
    ).slice(2)}`,
  ],
  [
    '0x9abaf267',
    `0x9abaf267${encodeAbiParameters(
      parseAbiParameters(
        'address[] pools, uint256[] floors, bytes32 mintRecipient, bytes32 destinationCaller, uint32 destinationDomain, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData',
      ),
      [[], [], `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, 27, 0n, 1000, VALID_HOOK],
    ).slice(2)}`,
  ],
]);

const ownableAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pendingOwner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const safeAbi = [
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'masterCopy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

function exactAddress(value, label) {
  let address;
  try { address = getAddress(value); } catch { throw new Error(`${label} is not an address`); }
  if (address !== value || address === ZERO_ADDRESS) throw new Error(`${label} must be nonzero exact EIP-55`);
  return address;
}

function exactHash(value, label) {
  if (!/^0x[0-9a-f]{64}$/.test(value || '')) throw new Error(`${label} must be a lowercase bytes32 hash`);
  if (value === ZERO_HASH) {
    throw new Error(`${label} must be a lowercase bytes32 hash and nonzero`);
  }
  return value;
}

function sortedAddresses(values) {
  return [...values].map((value) => getAddress(value)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function refsArray(immutableReferences = {}) {
  return Object.values(immutableReferences).flat().sort((a, b) => a.start - b.start);
}

export function normalizeRuntimeBytecode(bytecode, immutableReferences = {}) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(bytecode || '')) throw new Error('runtime bytecode must be hex bytes');
  const bytes = Buffer.from(bytecode.slice(2), 'hex');
  let previousEnd = 0;
  for (const ref of refsArray(immutableReferences)) {
    if (!Number.isInteger(ref.start) || !Number.isInteger(ref.length) || ref.start < previousEnd || ref.length <= 0 || ref.start + ref.length > bytes.length) {
      throw new Error('invalid or overlapping immutable reference');
    }
    bytes.fill(0, ref.start, ref.start + ref.length);
    previousEnd = ref.start + ref.length;
  }
  return `0x${bytes.toString('hex')}`;
}

export function replayPoolRegistry(events) {
  const enabled = new Map();
  const known = new Map();
  for (const event of events) {
    const pool = getAddress(event.pool);
    if (typeof event.allowed !== 'boolean') throw new Error('PoolAllowedSet allowed value must be boolean');
    enabled.set(pool.toLowerCase(), event.allowed ? pool : null);
    if (event.allowed) known.set(pool.toLowerCase(), pool);
  }
  return {
    enabled: sortedAddresses([...enabled.values()].filter(Boolean)),
    known: sortedAddresses([...known.values()]),
  };
}

function equalAddress(actual, expected, label) {
  if (getAddress(actual) !== expected) throw new Error(`${label} mismatch`);
}

function equalSet(actual, expected, label) {
  const a = sortedAddresses(actual);
  const e = sortedAddresses(expected);
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label} exact set mismatch`);
  return e;
}

async function codeAt(publicClient, address, blockNumber, label) {
  const code = await publicClient.getBytecode({ address, blockNumber });
  if (!code || code === '0x') throw new Error(`${label} has no code`);
  return code.toLowerCase();
}

async function read(publicClient, address, abi, functionName, blockNumber, args = []) {
  return publicClient.readContract({ address, abi, functionName, args, blockNumber });
}

async function verifyArtifact(publicClient, address, artifact, blockNumber, label) {
  const runtime = await codeAt(publicClient, address, blockNumber, label);
  const template = artifact?.deployedBytecode?.object;
  const refs = artifact?.deployedBytecode?.immutableReferences || {};
  if (!template) throw new Error(`${label} artifact missing deployed bytecode`);
  const normalizedRuntime = normalizeRuntimeBytecode(runtime, refs);
  const normalizedTemplate = normalizeRuntimeBytecode(template, refs);
  if (normalizedRuntime !== normalizedTemplate) throw new Error(`${label} runtime differs outside immutable slots`);
  return {
    rawRuntimeCodeHash: keccak256(runtime).toLowerCase(),
    normalizedRuntimeCodeHash: keccak256(normalizedTemplate).toLowerCase(),
    runtime,
  };
}

export function verifySweeperAbi(abi) {
  const exits = (abi || []).filter((item) => item.type === 'function' && item.name === 'exitAllAndBurn');
  if (exits.length !== 1) throw new Error('sweeper ABI must expose exactly one exitAllAndBurn');
  const signature = `exitAllAndBurn(${exits[0].inputs.map((input) => input.type).join(',')})`;
  if (signature !== 'exitAllAndBurn(address[],uint256[],uint256,uint256,bytes)') {
    throw new Error('sweeper ABI exposes redirect or obsolete exit arguments');
  }
  if (toFunctionSelector(signature).toLowerCase() !== HARDENED_SELECTOR) throw new Error('hardened selector mismatch');
}

function extractRevertData(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (typeof value.data === 'string' && /^0x[0-9a-fA-F]*$/.test(value.data)) return value.data.toLowerCase();
    if (value.data && typeof value.data === 'object') queue.push(value.data);
    if (value.cause) queue.push(value.cause);
  }
  return undefined;
}

export async function assertLegacySelectorsRejected(publicClient, sweeper, blockNumber) {
  for (const selector of ABSENT_SELECTORS) {
    let returned = false;
    try {
      await publicClient.call({ to: sweeper, data: LEGACY_CALLDATA.get(selector), blockNumber });
      returned = true;
    } catch (error) {
      const data = extractRevertData(error);
      if (data !== '0x') throw new Error(`legacy selector ${selector} dispatched with revert data ${data ?? 'missing'}`);
    }
    if (returned) throw new Error(`legacy selector ${selector} is callable`);
  }
}

export async function verifyHardenedDeployment(
  input,
  { publicClient, nowSeconds = BigInt(Math.floor(Date.now() / 1000)) },
) {
  const { candidate, expected, artifacts } = input;
  if (candidate?.generation !== 'hardened-v2') throw new Error('generation must be hardened-v2');
  if (candidate.chainId !== 84532 || await publicClient.getChainId() !== 84532) throw new Error('chain ID mismatch');
  if (
    typeof candidate.verificationBlockNumber !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(candidate.verificationBlockNumber)
  ) {
    throw new Error('verification block number must be a canonical decimal string');
  }
  const verificationBlockNumber = BigInt(candidate.verificationBlockNumber);
  if (verificationBlockNumber === 0n) {
    throw new Error('verification block number must be greater than zero');
  }
  const maxAgeSeconds = expected.verification?.maxAgeSeconds;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > 3600) {
    throw new Error('explicit finalized-head maxAgeSeconds must be between 1 and 3600');
  }
  const block = await publicClient.getBlock({ blockTag: 'finalized' });
  if (!block || block.number === undefined || block.timestamp === undefined) {
    throw new Error('missing finalized head');
  }
  const finalizedHash = exactHash(block.hash?.toLowerCase(), 'finalized head hash');
  const candidateHash = exactHash(candidate.verificationBlockHash, 'expected verification block hash');
  if (block.number !== verificationBlockNumber) throw new Error('candidate is not the finalized head');
  if (finalizedHash !== candidateHash) {
    throw new Error('verification block hash mismatch: candidate is not the finalized head');
  }
  const finalizedTimestamp = BigInt(block.timestamp);
  if (finalizedTimestamp > nowSeconds || nowSeconds - finalizedTimestamp > BigInt(maxAgeSeconds)) {
    throw new Error('finalized head is stale or from the future');
  }

  const adminSafe = exactAddress(candidate.adminSafe, 'admin Safe');
  if (adminSafe !== exactAddress(expected.adminSafe.address, 'expected admin Safe')) throw new Error('admin Safe mismatch');
  const routerAddress = exactAddress(candidate.yieldRouter.address, 'YieldRouter');
  const sweeperAddress = exactAddress(candidate.baseExitSweeper.address, 'BaseExitSweeper');
  const route = expected.route;
  const usdcAddress = exactAddress(route.usdcAddress, 'USDC');
  const messengerAddress = exactAddress(route.tokenMessengerAddress, 'TokenMessenger');
  if (usdcAddress !== CIRCLE_BASE_SEPOLIA_USDC) {
    throw new Error('USDC must equal Circle Base Sepolia USDC');
  }
  if (messengerAddress !== CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER) {
    throw new Error('TokenMessenger must equal Circle Base Sepolia TokenMessenger');
  }

  const safeCode = await codeAt(publicClient, adminSafe, verificationBlockNumber, 'admin Safe');
  await codeAt(publicClient, usdcAddress, verificationBlockNumber, 'USDC');
  await codeAt(publicClient, messengerAddress, verificationBlockNumber, 'TokenMessenger');
  const routerIdentity = await verifyArtifact(publicClient, routerAddress, artifacts.yieldRouter, verificationBlockNumber, 'YieldRouter');
  verifySweeperAbi(artifacts.baseExitSweeper.abi);
  const sweeperIdentity = await verifyArtifact(publicClient, sweeperAddress, artifacts.baseExitSweeper, verificationBlockNumber, 'BaseExitSweeper');
  await assertLegacySelectorsRejected(publicClient, sweeperAddress, verificationBlockNumber);
  for (const [label, actual, approved] of [
    ['router raw runtime hash', routerIdentity.rawRuntimeCodeHash, expected.codeHashes?.yieldRouter?.rawRuntimeCodeHash],
    ['router normalized runtime hash', routerIdentity.normalizedRuntimeCodeHash, expected.codeHashes?.yieldRouter?.normalizedRuntimeCodeHash],
    ['sweeper raw runtime hash', sweeperIdentity.rawRuntimeCodeHash, expected.codeHashes?.baseExitSweeper?.rawRuntimeCodeHash],
    ['sweeper normalized runtime hash', sweeperIdentity.normalizedRuntimeCodeHash, expected.codeHashes?.baseExitSweeper?.normalizedRuntimeCodeHash],
  ]) {
    if (actual !== exactHash(approved, label)) throw new Error(`${label} mismatch`);
  }

  const threshold = Number(await read(publicClient, adminSafe, safeAbi, 'getThreshold', verificationBlockNumber));
  const owners = sortedAddresses(await read(publicClient, adminSafe, safeAbi, 'getOwners', verificationBlockNumber));
  const proxyImplementation = getAddress(await read(publicClient, adminSafe, safeAbi, 'masterCopy', verificationBlockNumber));
  if (threshold <= 0 || threshold > owners.length) throw new Error('Safe threshold is invalid');
  if (threshold !== expected.adminSafe.threshold) throw new Error('Safe threshold mismatch');
  equalSet(owners, expected.adminSafe.owners, 'Safe owners');
  equalAddress(proxyImplementation, exactAddress(expected.adminSafe.proxyImplementation, 'expected Safe implementation'), 'Safe implementation');
  const safeRuntimeCodeHash = keccak256(safeCode).toLowerCase();
  if (safeRuntimeCodeHash !== exactHash(expected.adminSafe.runtimeCodeHash, 'expected Safe runtime hash')) {
    throw new Error('Safe runtime hash mismatch');
  }

  equalAddress(await read(publicClient, routerAddress, artifacts.yieldRouter.abi, 'canonicalAsset', verificationBlockNumber), usdcAddress, 'router canonical asset');
  equalAddress(await read(publicClient, routerAddress, ownableAbi, 'owner', verificationBlockNumber), adminSafe, 'router owner');
  equalAddress(await read(publicClient, routerAddress, ownableAbi, 'pendingOwner', verificationBlockNumber), ZERO_ADDRESS, 'router pending owner');

  const routerReceipt = await publicClient.getTransactionReceipt({ hash: exactHash(candidate.yieldRouter.deployTxHash, 'router deploy tx') });
  const sweeperReceipt = await publicClient.getTransactionReceipt({ hash: exactHash(candidate.baseExitSweeper.deployTxHash, 'sweeper deploy tx') });
  for (const [receipt, address, label] of [[routerReceipt, routerAddress, 'router'], [sweeperReceipt, sweeperAddress, 'sweeper']]) {
    let receiptAddress;
    try { receiptAddress = getAddress(receipt?.contractAddress); } catch { receiptAddress = undefined; }
    if (
      !receipt || receipt.status !== 'success' || receiptAddress !== address
        || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber > verificationBlockNumber
        || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash || '')
    ) throw new Error(`${label} deployment receipt mismatch`);
    exactHash(receipt.blockHash, `${label} deployment block hash`);
  }
  if (routerReceipt.blockNumber <= 0n) {
    throw new Error('router deployment block must be greater than zero');
  }
  if (sweeperReceipt.blockNumber <= 0n) {
    throw new Error('sweeper deployment block must be greater than zero');
  }
  if (routerReceipt.blockNumber > sweeperReceipt.blockNumber) {
    throw new Error('router deployment block must not be after sweeper deployment block');
  }

  const logs = await publicClient.getLogs({
    address: routerAddress,
    event: parseAbiItem('event PoolAllowedSet(address indexed pool, bool allowed)'),
    fromBlock: routerReceipt.blockNumber,
    toBlock: verificationBlockNumber,
  });
  const replayed = replayPoolRegistry(logs.map((log) => ({ pool: log.args.pool, allowed: log.args.allowed })));
  const expectedPools = equalSet(expected.pools, replayed.enabled, 'enabled pools');
  equalSet(expected.pools, replayed.known, 'known pools');
  for (const pool of expectedPools) {
    await codeAt(publicClient, pool, verificationBlockNumber, `pool ${pool}`);
    equalAddress(
      await read(publicClient, pool, ERC4626_ASSET_ABI, 'asset', verificationBlockNumber),
      usdcAddress,
      `pool ${pool} asset`,
    );
    if (await read(publicClient, routerAddress, artifacts.yieldRouter.abi, 'allowedPool', verificationBlockNumber, [pool]) !== true) throw new Error(`pool ${pool} not allowed`);
    if (await read(publicClient, routerAddress, artifacts.yieldRouter.abi, 'knownPool', verificationBlockNumber, [pool]) !== true) throw new Error(`pool ${pool} not known`);
  }

  const sweeperChecks = [
    ['usdc', usdcAddress], ['router', routerAddress], ['tokenMessenger', messengerAddress],
    ['stellarDomain', 27], ['mintRecipient', route.mintRecipient],
    ['destinationCaller', route.destinationCaller], ['FINALITY_THRESHOLD', 1000],
  ];
  for (const [functionName, expectedValue] of sweeperChecks) {
    const actual = await read(publicClient, sweeperAddress, artifacts.baseExitSweeper.abi, functionName, verificationBlockNumber);
    if (typeof expectedValue === 'string' ? String(actual).toLowerCase() !== expectedValue.toLowerCase() : Number(actual) !== expectedValue) {
      throw new Error(`sweeper ${functionName} mismatch`);
    }
  }
  if (route.stellarDomain !== 27 || route.finalityThreshold !== 1000) throw new Error('route constants mismatch');
  const body = sweeperIdentity.runtime.slice(2);
  if (!body.includes(HARDENED_SELECTOR.slice(2))) throw new Error('hardened exit selector absent');
  for (const selector of ABSENT_SELECTORS) {
    if (body.includes(selector.slice(2))) throw new Error(`legacy selector ${selector} present in sweeper runtime`);
  }

  return {
    base: {
      hardenedDeployment: {
        generation: 'hardened-v2',
        chainId: 84532,
        adminSafe: {
          address: adminSafe,
          proxyImplementation,
          runtimeCodeHash: safeRuntimeCodeHash,
          threshold,
          owners,
        },
        yieldRouter: {
          address: routerAddress,
          deployTxHash: candidate.yieldRouter.deployTxHash,
          deployBlockNumber: routerReceipt.blockNumber.toString(),
          deployBlockHash: routerReceipt.blockHash.toLowerCase(),
          rawRuntimeCodeHash: routerIdentity.rawRuntimeCodeHash,
          normalizedRuntimeCodeHash: routerIdentity.normalizedRuntimeCodeHash,
        },
        baseExitSweeper: {
          address: sweeperAddress,
          deployTxHash: candidate.baseExitSweeper.deployTxHash,
          deployBlockNumber: sweeperReceipt.blockNumber.toString(),
          deployBlockHash: sweeperReceipt.blockHash.toLowerCase(),
          rawRuntimeCodeHash: sweeperIdentity.rawRuntimeCodeHash,
          normalizedRuntimeCodeHash: sweeperIdentity.normalizedRuntimeCodeHash,
        },
        route: {
          usdcAddress,
          tokenMessengerAddress: messengerAddress,
          stellarDomain: 27,
          mintRecipient: route.mintRecipient.toLowerCase(),
          destinationCaller: route.destinationCaller.toLowerCase(),
          finalityThreshold: 1000,
        },
        selectors: { exitAllAndBurn: HARDENED_SELECTOR, absent: ABSENT_SELECTORS },
        pools: { enabled: expectedPools, known: expectedPools },
        verification: { blockNumber: verificationBlockNumber.toString(), blockHash: block.hash.toLowerCase() },
      },
    },
  };
}

export function serializeCanonicalRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function writeStagingRecord(outputPath, record, writer = writeFile) {
  if (!outputPath) throw new Error('explicit staging output path required');
  const absolute = resolve(outputPath);
  if (absolute.endsWith('/deployments/base-sepolia.json')) throw new Error('canonical deployment record is forbidden');
  await writer(absolute, serializeCanonicalRecord(record), { flag: 'wx' });
  return absolute;
}
