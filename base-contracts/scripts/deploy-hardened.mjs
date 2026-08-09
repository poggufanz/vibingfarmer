import { getAddress, keccak256 } from 'viem';
import { readFile as readFileDefault } from 'node:fs/promises';
import {
  CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER,
  CIRCLE_BASE_SEPOLIA_USDC,
  ERC4626_ASSET_ABI,
  assertLegacySelectorsRejected,
  normalizeRuntimeBytecode,
  verifySweeperAbi,
} from './verify-hardened-deployment.mjs';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const COMPILER_VERSION = '0.8.23+commit.f704f362';

export const FOUNDRY_ARTIFACT_PATHS = Object.freeze({
  yieldRouter: '/out/YieldRouter.sol/YieldRouter.json',
  baseExitSweeper: '/out/BaseExitSweeper.sol/BaseExitSweeper.json',
});

const CONTRACT_PROFILES = Object.freeze({
  yieldRouter: Object.freeze({
    label: 'YieldRouter',
    source: 'src/YieldRouter.sol',
    contract: 'YieldRouter',
    profile: 'default',
    viaIR: false,
  }),
  baseExitSweeper: Object.freeze({
    label: 'BaseExitSweeper',
    source: 'src/BaseExitSweeper.sol',
    contract: 'BaseExitSweeper',
    profile: 'via-ir',
    viaIR: true,
  }),
});

function exactHash(value, label) {
  if (!/^0x[0-9a-f]{64}$/.test(value || '')) throw new Error(`${label} must be a lowercase bytes32 hash`);
  if (value === ZERO_HASH) {
    throw new Error(`${label} must be a lowercase bytes32 hash and nonzero`);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readJsonFile(path, readFile, label) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) {
    throw new Error(`${label} could not be read`, { cause: error });
  }
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  try { return { value: JSON.parse(text), text }; } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function validateFoundryArtifact(artifact, artifactText, buildInfo, buildInfoText, approved, spec) {
  const { label, source, contract, profile, viaIR } = spec;
  if (!artifact || !Array.isArray(artifact.abi) || !artifact.bytecode?.object || !artifact.deployedBytecode?.object) {
    throw new Error(`${label} artifact is incomplete`);
  }
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  if (metadata?.compiler?.version !== COMPILER_VERSION) throw new Error(`${label} compiler version mismatch`);
  const settings = metadata?.settings;
  if (Boolean(settings?.viaIR) !== viaIR) throw new Error(`${label} compiler profile mismatch: expected ${profile}`);
  if (settings?.optimizer?.enabled !== false || settings?.optimizer?.runs !== 200) {
    throw new Error(`${label} optimizer settings mismatch`);
  }
  if (settings?.evmVersion !== 'shanghai') throw new Error(`${label} EVM version mismatch`);
  if (settings?.metadata?.bytecodeHash !== 'ipfs') throw new Error(`${label} metadata bytecode hash mismatch`);
  if (!settings?.libraries || Object.keys(settings.libraries).length !== 0) {
    throw new Error(`${label} linked-library settings mismatch`);
  }
  if (
    Object.keys(settings?.compilationTarget || {}).length !== 1
      || settings.compilationTarget[source] !== contract
  ) throw new Error(`${label} compilation target mismatch`);

  const metadataSourceHash = exactHash(metadata?.sources?.[source]?.keccak256, `${label} metadata source hash`);
  if (metadataSourceHash !== exactHash(approved?.sourceHash, `${label} approved source hash`)) {
    throw new Error(`${label} source hash mismatch`);
  }
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 0) throw new Error(`${label} artifact source ID is invalid`);
  if (buildInfo?.language !== 'Solidity') throw new Error(`${label} build-info language mismatch`);
  if (buildInfo?.id !== approved.buildInfoId) throw new Error(`${label} build-info ID mismatch`);
  if (buildInfo?.source_id_to_path?.[String(artifact.id)] !== source) {
    throw new Error(`${label} build-info source mismatch`);
  }

  const refs = artifact.deployedBytecode.immutableReferences || {};
  if (stableJson(refs) !== stableJson(approved.immutableReferences)) {
    throw new Error(`${label} immutable references mismatch`);
  }
  const creationHash = keccak256(artifact.bytecode.object.toLowerCase());
  if (creationHash !== exactHash(approved.creationBytecodeHash, `${label} approved creation bytecode hash`)) {
    throw new Error(`${label} creation bytecode hash mismatch`);
  }
  const rawRuntimeHash = keccak256(artifact.deployedBytecode.object.toLowerCase());
  if (rawRuntimeHash !== exactHash(approved.rawRuntimeTemplateHash, `${label} approved raw runtime template hash`)) {
    throw new Error(`${label} raw runtime template hash mismatch`);
  }
  const normalizedRuntimeHash = keccak256(
    normalizeRuntimeBytecode(artifact.deployedBytecode.object, refs),
  );
  if (
    normalizedRuntimeHash
      !== exactHash(approved.normalizedRuntimeTemplateHash, `${label} approved normalized runtime template hash`)
  ) throw new Error(`${label} normalized runtime template hash mismatch`);
  if (keccak256(new TextEncoder().encode(artifactText)) !== exactHash(approved.artifactHash, `${label} approved artifact file hash`)) {
    throw new Error(`${label} artifact file hash mismatch`);
  }
  if (keccak256(new TextEncoder().encode(buildInfoText)) !== exactHash(approved.buildInfoHash, `${label} approved build-info file hash`)) {
    throw new Error(`${label} build-info file hash mismatch`);
  }
  if (contract === 'BaseExitSweeper') verifySweeperAbi(artifact.abi);
  return artifact;
}

export async function loadValidatedFoundryArtifacts(
  provenance,
  { readFile = readFileDefault } = {},
) {
  const artifacts = {};
  for (const [key, spec] of Object.entries(CONTRACT_PROFILES)) {
    const approved = provenance?.[key];
    if (!approved || !/^[0-9a-f]{16}$/.test(approved.buildInfoId || '')) {
      throw new Error(`${spec.label} approved build-info ID must be 16 lowercase hex characters`);
    }
    const artifactUrl = new URL(`..${FOUNDRY_ARTIFACT_PATHS[key]}`, import.meta.url);
    const buildInfoUrl = new URL(`../out/build-info/${approved.buildInfoId}.json`, import.meta.url);
    const artifactFile = await readJsonFile(artifactUrl, readFile, `${spec.label} fixed Foundry artifact`);
    const buildInfoFile = await readJsonFile(buildInfoUrl, readFile, `${spec.label} fixed Foundry build-info`);
    artifacts[key] = validateFoundryArtifact(
      artifactFile.value,
      artifactFile.text,
      buildInfoFile.value,
      buildInfoFile.text,
      approved,
      spec,
    );
  }
  return artifacts;
}

function requireValue(value, label) {
  if (
    !value
      || (typeof value === 'string' && value.trim().length === 0)
      || /FILL_ME/i.test(String(value))
  ) throw new Error(`${label} missing`);
}

function exactAddress(value, label) {
  requireValue(value, label);
  let normalized;
  try { normalized = getAddress(value); } catch { throw new Error(`${label} is not an address`); }
  if (normalized !== value) throw new Error(`${label} must be exact EIP-55 checksum form`);
  if (normalized === ZERO_ADDRESS) throw new Error(`${label} is zero`);
  return normalized;
}

async function requireCode(publicClient, address, label) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === '0x') throw new Error(`${label} has no runtime code`);
}

export async function validateDeploymentInputs(
  config,
  { publicClient, readFile = readFileDefault },
) {
  requireValue(config?.privateKey, 'private key');
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) throw new Error('private key is malformed');
  if (/^0x0{64}$/i.test(config.privateKey)) throw new Error('private key is zero');
  requireValue(config.rpcUrl, 'RPC URL');
  if (config.chainId !== 84532) throw new Error('chain ID must be Base Sepolia 84532');
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== 84532) throw new Error(`RPC chain ID ${liveChainId} is not 84532`);

  exactAddress(config.deployer, 'deployer');
  exactAddress(config.adminSafe, 'BASE_ADMIN_SAFE');
  const usdcAddress = exactAddress(config.route?.usdcAddress, 'USDC');
  const messengerAddress = exactAddress(config.route?.tokenMessengerAddress, 'TokenMessenger');
  if (usdcAddress !== CIRCLE_BASE_SEPOLIA_USDC) {
    throw new Error('USDC must equal Circle Base Sepolia USDC');
  }
  if (messengerAddress !== CIRCLE_BASE_SEPOLIA_TOKEN_MESSENGER) {
    throw new Error('TokenMessenger must equal Circle Base Sepolia TokenMessenger');
  }
  if (config.route?.stellarDomain !== 27) throw new Error('Stellar domain must be 27');
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.route?.mintRecipient || '') || /^0x0{64}$/.test(config.route.mintRecipient)) {
    throw new Error('mintRecipient must be nonzero bytes32');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.route?.destinationCaller || '') || /^0x0{64}$/.test(config.route.destinationCaller)) {
    throw new Error('destinationCaller must be nonzero bytes32');
  }
  if (config.route?.finalityThreshold !== 1000) throw new Error('finality threshold must be 1000');
  if (!Array.isArray(config.pools) || config.pools.length === 0) throw new Error('at least one pool is required');

  const pools = config.pools.map((pool, index) => exactAddress(pool, `pool[${index}]`));
  if (new Set(pools.map((pool) => pool.toLowerCase())).size !== pools.length) throw new Error('duplicate pool');
  const artifacts = await loadValidatedFoundryArtifacts(config.artifactProvenance, { readFile });

  await requireCode(publicClient, config.adminSafe, 'BASE_ADMIN_SAFE');
  await requireCode(publicClient, config.route.usdcAddress, 'USDC');
  await requireCode(publicClient, config.route.tokenMessengerAddress, 'TokenMessenger');
  for (const pool of pools) {
    await requireCode(publicClient, pool, `pool ${pool}`);
    const asset = await publicClient.readContract({
      address: pool,
      abi: ERC4626_ASSET_ABI,
      functionName: 'asset',
    });
    if (getAddress(asset) !== config.route.usdcAddress) throw new Error(`pool ${pool} has wrong asset`);
  }
  return { ...config, pools, artifacts };
}

async function successfulReceipt(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt || receipt.status !== 'success') throw new Error(`${label} transaction failed`);
  return receipt;
}

async function assertCode(publicClient, address, label) {
  await requireCode(publicClient, address, label);
  return address;
}

async function assertRuntimeIdentity(publicClient, address, artifact, label) {
  const runtime = await publicClient.getBytecode({ address });
  const refs = artifact.deployedBytecode.immutableReferences || {};
  if (
    normalizeRuntimeBytecode(runtime, refs)
      !== normalizeRuntimeBytecode(artifact.deployedBytecode.object, refs)
  ) throw new Error(`${label} runtime identity mismatch`);
  return runtime.toLowerCase();
}

export async function deployHardenedStaging(config, deps) {
  const validated = await validateDeploymentInputs(config, deps);
  const { publicClient, walletClient } = deps;
  const routerArtifact = validated.artifacts.yieldRouter;
  const sweeperArtifact = validated.artifacts.baseExitSweeper;

  const routerHash = await walletClient.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode.object,
    args: [validated.deployer, validated.route.usdcAddress],
  });
  const routerReceipt = await successfulReceipt(publicClient, routerHash, 'router deployment');
  const routerAddress = exactAddress(routerReceipt.contractAddress, 'deployed router');
  await assertCode(publicClient, routerAddress, 'deployed router');
  await assertRuntimeIdentity(publicClient, routerAddress, routerArtifact, 'router');

  const poolTransactions = [];
  for (const pool of validated.pools) {
    const hash = await walletClient.writeContract({
      address: routerAddress,
      abi: routerArtifact.abi,
      functionName: 'setPool',
      args: [pool, true],
    });
    const receipt = await successfulReceipt(publicClient, hash, `setPool ${pool}`);
    const allowed = await publicClient.readContract({ address: routerAddress, abi: routerArtifact.abi, functionName: 'allowedPool', args: [pool] });
    const known = await publicClient.readContract({ address: routerAddress, abi: routerArtifact.abi, functionName: 'knownPool', args: [pool] });
    if (allowed !== true || known !== true) throw new Error(`pool ${pool} did not become allowed and known`);
    poolTransactions.push({ pool, hash, receipt });
  }

  const sweeperHash = await walletClient.deployContract({
    abi: sweeperArtifact.abi,
    bytecode: sweeperArtifact.bytecode.object,
    args: [
      validated.route.usdcAddress,
      routerAddress,
      validated.route.tokenMessengerAddress,
      validated.route.stellarDomain,
      validated.route.mintRecipient,
      validated.route.destinationCaller,
    ],
  });
  const sweeperReceipt = await successfulReceipt(publicClient, sweeperHash, 'sweeper deployment');
  const sweeperAddress = exactAddress(sweeperReceipt.contractAddress, 'deployed sweeper');
  await assertCode(publicClient, sweeperAddress, 'deployed sweeper');
  const sweeperRuntime = await assertRuntimeIdentity(publicClient, sweeperAddress, sweeperArtifact, 'sweeper');
  if (!sweeperRuntime.includes('4c9d247b') || sweeperRuntime.includes('0d390c9e') || sweeperRuntime.includes('9abaf267')) {
    throw new Error('sweeper selector set mismatch');
  }
  await assertLegacySelectorsRejected(publicClient, sweeperAddress);

  const expectedReads = [
    ['usdc', validated.route.usdcAddress],
    ['router', routerAddress],
    ['tokenMessenger', validated.route.tokenMessengerAddress],
    ['stellarDomain', 27],
    ['mintRecipient', validated.route.mintRecipient],
    ['destinationCaller', validated.route.destinationCaller],
    ['FINALITY_THRESHOLD', 1000],
  ];
  for (const [functionName, expected] of expectedReads) {
    const actual = await publicClient.readContract({ address: sweeperAddress, abi: sweeperArtifact.abi, functionName });
    if (typeof expected === 'string' ? String(actual).toLowerCase() !== expected.toLowerCase() : Number(actual) !== expected) {
      throw new Error(`sweeper ${functionName} mismatch`);
    }
  }

  const canonicalAsset = await publicClient.readContract({
    address: routerAddress,
    abi: routerArtifact.abi,
    functionName: 'canonicalAsset',
  });
  if (getAddress(canonicalAsset) !== validated.route.usdcAddress) {
    throw new Error('router canonical asset mismatch');
  }
  const ownerBeforeTransfer = await publicClient.readContract({
    address: routerAddress,
    abi: routerArtifact.abi,
    functionName: 'owner',
  });
  if (getAddress(ownerBeforeTransfer) !== validated.deployer) {
    throw new Error('router owner mismatch before ownership transfer');
  }
  const pendingOwnerBeforeTransfer = await publicClient.readContract({
    address: routerAddress,
    abi: routerArtifact.abi,
    functionName: 'pendingOwner',
  });
  if (getAddress(pendingOwnerBeforeTransfer) !== ZERO_ADDRESS) {
    throw new Error('router pending owner mismatch before ownership transfer');
  }
  for (const pool of validated.pools) {
    const currentAsset = await publicClient.readContract({
      address: pool,
      abi: ERC4626_ASSET_ABI,
      functionName: 'asset',
    });
    if (getAddress(currentAsset) !== validated.route.usdcAddress) {
      throw new Error(`pool ${pool} asset mismatch before ownership transfer`);
    }
    const currentAllowed = await publicClient.readContract({
      address: routerAddress,
      abi: routerArtifact.abi,
      functionName: 'allowedPool',
      args: [pool],
    });
    if (currentAllowed !== true) throw new Error(`pool ${pool} not allowed before ownership transfer`);
    const currentKnown = await publicClient.readContract({
      address: routerAddress,
      abi: routerArtifact.abi,
      functionName: 'knownPool',
      args: [pool],
    });
    if (currentKnown !== true) throw new Error(`pool ${pool} not known before ownership transfer`);
  }

  const transferHash = await walletClient.writeContract({
    address: routerAddress,
    abi: routerArtifact.abi,
    functionName: 'transferOwnership',
    args: [validated.adminSafe],
  });
  const transferReceipt = await successfulReceipt(publicClient, transferHash, 'ownership proposal');
  const owner = await publicClient.readContract({ address: routerAddress, abi: routerArtifact.abi, functionName: 'owner' });
  const pendingOwner = await publicClient.readContract({ address: routerAddress, abi: routerArtifact.abi, functionName: 'pendingOwner' });
  if (getAddress(owner) !== validated.deployer || getAddress(pendingOwner) !== validated.adminSafe) {
    throw new Error('ownership proposal state mismatch');
  }

  return {
    status: 'awaiting-safe-acceptance',
    router: { address: routerAddress, deployTxHash: routerHash, receipt: routerReceipt },
    sweeper: { address: sweeperAddress, deployTxHash: sweeperHash, receipt: sweeperReceipt },
    poolTransactions,
    ownershipProposal: { hash: transferHash, receipt: transferReceipt },
  };
}
