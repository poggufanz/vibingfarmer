import { createHash } from 'node:crypto';
import { decodeEventLog } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { assertHookData, buildForwarderHookData } from './cctp/reverse.mjs';
import { parseCctpV2Message } from './cctp/messageV2.mjs';
import { canonicalizeExpectation } from './store.mjs';
import { unwindJobCommitment } from './unwindCommitment.mjs';

const BASE_DOMAIN = 6;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export const UNWIND_EVENT_TOPICS = Object.freeze({
  swept: '0x4f2d11fb664b5f2f436d0d6acfed89a492c2f8fde20a4811da677150003332eb',
  depositForBurn: '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5',
  messageSent: '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036',
  userOperationEvent: '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
});

const SWEPT_ABI = [{
  type: 'event',
  name: 'Swept',
  inputs: [
    { name: 'owner', type: 'address', indexed: true },
    { name: 'burned', type: 'uint256', indexed: false },
    { name: 'exited', type: 'uint256', indexed: false },
    { name: 'skipped', type: 'uint256', indexed: false },
  ],
}];

const DEPOSIT_FOR_BURN_ABI = [{
  type: 'event',
  name: 'DepositForBurn',
  inputs: [
    { name: 'burnToken', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'depositor', type: 'address', indexed: true },
    { name: 'mintRecipient', type: 'bytes32', indexed: false },
    { name: 'destinationDomain', type: 'uint32', indexed: false },
    { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
    { name: 'destinationCaller', type: 'bytes32', indexed: false },
    { name: 'maxFee', type: 'uint256', indexed: false },
    { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
    { name: 'hookData', type: 'bytes', indexed: false },
  ],
}];

const MESSAGE_SENT_ABI = [{
  type: 'event',
  name: 'MessageSent',
  inputs: [{ name: 'message', type: 'bytes', indexed: false }],
}];

const USER_OPERATION_EVENT_ABI = [{
  type: 'event',
  name: 'UserOperationEvent',
  inputs: [
    { name: 'userOpHash', type: 'bytes32', indexed: true },
    { name: 'sender', type: 'address', indexed: true },
    { name: 'paymaster', type: 'address', indexed: true },
    { name: 'nonce', type: 'uint256', indexed: false },
    { name: 'success', type: 'bool', indexed: false },
    { name: 'actualGasCost', type: 'uint256', indexed: false },
    { name: 'actualGasUsed', type: 'uint256', indexed: false },
  ],
}];

const FACT_KEYS = Object.freeze([
  'generation', 'chainId', 'entryPointAddress', 'baseExitSweeperAddress', 'usdcAddress',
  'tokenMessengerV2Address', 'messageTransmitterV2Address', 'stellarDomain',
  'stellarTokenMessenger', 'cctpForwarder', 'finalityThreshold',
]);
const INPUT_KEYS = Object.freeze([
  'publicClient', 'bundlerClient', 'jobId', 'userOpHash', 'unwindTxHash',
  'kernelAddress', 'recipientHint', 'facts',
]);

function evidenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const validation = (message) => evidenceError('UNWIND_EVIDENCE_VALIDATION', message);
const retryable = () => evidenceError('UNWIND_EVIDENCE_RETRYABLE', 'unwind receipt evidence is not available yet');
const mismatch = (message = 'unwind receipt evidence does not match the reservation') =>
  evidenceError('UNWIND_EVIDENCE_MISMATCH', message);
const ambiguous = (message = 'unwind receipt evidence is ambiguous') =>
  evidenceError('UNWIND_EVIDENCE_AMBIGUOUS', message);
const reverted = () => evidenceError('UNWIND_EVIDENCE_REVERTED', 'unwind execution reverted');

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizeHash(value, label) {
  if (typeof value !== 'string' || !HASH32_RE.test(value)) throw validation(`${label} is invalid`);
  return value.toLowerCase();
}

function normalizeAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)
      || /^0x0{40}$/i.test(value)) throw validation(`${label} is invalid`);
  return value.toLowerCase();
}

function normalizeFacts(value) {
  if (!exactKeys(value, FACT_KEYS)
      || value.generation !== 'hardened-v2'
      || value.chainId !== 84532
      || value.stellarDomain !== 27
      || value.finalityThreshold !== 1000
      || typeof value.stellarTokenMessenger !== 'string'
      || !BYTES32_RE.test(value.stellarTokenMessenger)
      || /^0x0{64}$/.test(value.stellarTokenMessenger)
      || typeof value.cctpForwarder !== 'string'
      || !BYTES32_RE.test(value.cctpForwarder)
      || /^0x0{64}$/.test(value.cctpForwarder)) {
    throw validation('unwind deployment facts are invalid');
  }
  return Object.freeze({
    ...value,
    entryPointAddress: normalizeAddress(value.entryPointAddress, 'EntryPoint'),
    baseExitSweeperAddress: normalizeAddress(value.baseExitSweeperAddress, 'BaseExitSweeper'),
    usdcAddress: normalizeAddress(value.usdcAddress, 'Base USDC'),
    tokenMessengerV2Address: normalizeAddress(value.tokenMessengerV2Address, 'TokenMessengerV2'),
    messageTransmitterV2Address: normalizeAddress(
      value.messageTransmitterV2Address,
      'MessageTransmitterV2',
    ),
  });
}

function integer(value, label) {
  try {
    if (typeof value === 'bigint' && value >= 0n) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && (/^(0|[1-9][0-9]*)$/.test(value)
        || /^0x[0-9a-fA-F]+$/.test(value))) return BigInt(value);
  } catch {
    // fall through to the stable mismatch below
  }
  throw mismatch(`${label} is not a canonical non-negative integer`);
}

function canonicalLog(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) throw mismatch('receipt log is malformed');
  const address = normalizeAddressForEvidence(log.address);
  if (!Array.isArray(log.topics) || log.topics.length === 0
      || !log.topics.every((topic) => typeof topic === 'string' && HASH32_RE.test(topic))) {
    throw mismatch('receipt log topics are malformed');
  }
  if (typeof log.data !== 'string' || !DATA_RE.test(log.data)) {
    throw mismatch('receipt log data is malformed');
  }
  const index = integer(log.logIndex, 'receipt log index');
  if (index > BigInt(Number.MAX_SAFE_INTEGER)) throw mismatch('receipt log index is too large');
  return Object.freeze({
    address,
    topics: Object.freeze(log.topics.map((topic) => topic.toLowerCase())),
    data: log.data.toLowerCase(),
    logIndex: Number(index),
  });
}

function normalizeAddressForEvidence(value) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw mismatch('receipt address is malformed');
  return value.toLowerCase();
}

function canonicalLogs(value) {
  if (!Array.isArray(value)) throw mismatch('receipt logs are missing');
  return value.map(canonicalLog);
}

function sameLog(left, right) {
  return left.logIndex === right.logIndex
    && left.address === right.address
    && left.data === right.data
    && JSON.stringify(left.topics) === JSON.stringify(right.topics);
}

function singleRaw(logs, address, topic, label) {
  const found = logs.filter((log) => log.address === address && log.topics[0] === topic);
  if (found.length === 0) throw mismatch(`${label} is missing`);
  if (found.length !== 1) throw ambiguous(`${label} is duplicated`);
  return found[0];
}

function decode(log, abi, eventName, label) {
  try {
    return decodeEventLog({ abi, eventName, topics: log.topics, data: log.data, strict: true }).args;
  } catch {
    throw mismatch(`${label} is malformed`);
  }
}

function addressBytes32(address) {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function sourceMatches(parsed, expectation) {
  return parsed.headerVersion === 1n
    && parsed.sourceDomain === 6n
    && parsed.destinationDomain === 27n
    && parsed.nonce === ZERO_BYTES32
    && parsed.sender === expectation.sender
    && parsed.recipient === expectation.recipient
    && parsed.destinationCaller === expectation.destinationCaller
    && parsed.minFinalityThreshold === 1000n
    && parsed.finalityThresholdExecuted === 0n
    && parsed.bodyVersion === 1n
    && parsed.burnToken === expectation.burnToken
    && parsed.mintRecipient === expectation.mintRecipient
    && parsed.amount === BigInt(expectation.amount)
    && parsed.messageSender === expectation.messageSender
    && parsed.maxFee === BigInt(expectation.maxFee)
    && parsed.feeExecuted === 0n
    && parsed.expirationBlock === 0n
    && parsed.hookData === expectation.hookData;
}

function decodeSourceMessage(log) {
  const args = decode(log, MESSAGE_SENT_ABI, 'MessageSent', 'MessageSent');
  if (typeof args.message !== 'string') throw mismatch('MessageSent payload is malformed');
  try {
    return { messageHex: args.message.toLowerCase(), parsed: parseCctpV2Message(args.message) };
  } catch {
    throw mismatch('MessageSent CCTP payload is malformed');
  }
}

function sha256Bytes(hex) {
  return createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
}

function logDigest(log) {
  return createHash('sha256')
    .update(`vf-unwind-log-v1\0${JSON.stringify(log)}`, 'utf8')
    .digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

async function rpcRead(action) {
  try {
    return await action();
  } catch {
    throw retryable();
  }
}

/**
 * Read-only authority chain for one owner-signed Base unwind. Request JSON supplies identities
 * only; every amount, route field, event, and CCTP expectation is re-derived from canonical chain
 * evidence and independently approved deployment facts.
 */
export async function readUnwindEvidence(input) {
  if (!exactKeys(input, INPUT_KEYS)) throw validation('unwind evidence request is invalid');
  const {
    publicClient,
    bundlerClient,
    jobId,
    userOpHash,
    unwindTxHash,
    kernelAddress,
    recipientHint,
    facts: rawFacts,
  } = input;
  const facts = normalizeFacts(rawFacts);
  let jobCommitment;
  try {
    jobCommitment = unwindJobCommitment(jobId);
  } catch {
    throw validation('unwind jobId is invalid');
  }
  const canonicalUserOpHash = normalizeHash(userOpHash, 'UserOperation hash');
  const canonicalUnwindTxHash = normalizeHash(unwindTxHash, 'unwind transaction hash');
  const canonicalKernel = normalizeAddress(kernelAddress, 'Kernel address');
  let hookData;
  try {
    hookData = buildForwarderHookData(recipientHint).toLowerCase();
    assertHookData(hookData);
  } catch {
    throw validation('recipient hint is invalid');
  }
  if (!publicClient || typeof publicClient.getChainId !== 'function'
      || typeof publicClient.getTransactionReceipt !== 'function'
      || !bundlerClient || typeof bundlerClient.getUserOperation !== 'function'
      || typeof bundlerClient.getUserOperationReceipt !== 'function') {
    throw validation('unwind receipt clients are unavailable');
  }

  const chainId = await rpcRead(() => publicClient.getChainId());
  if (chainId !== facts.chainId) throw mismatch('Base chain identity differs');

  const publicReceipt = await rpcRead(() => publicClient.getTransactionReceipt({
    hash: canonicalUnwindTxHash,
  }));
  if (!publicReceipt) throw retryable();
  if (publicReceipt.status !== 'success') {
    if (publicReceipt.status === 'reverted') throw reverted();
    throw mismatch('public transaction receipt status is malformed');
  }
  if (normalizeHashForEvidence(publicReceipt.transactionHash) !== canonicalUnwindTxHash
      || normalizeAddressForEvidence(publicReceipt.to) !== facts.entryPointAddress) {
    throw mismatch('public transaction receipt identity differs');
  }
  const blockHash = normalizeHashForEvidence(publicReceipt.blockHash);
  const blockNumber = integer(publicReceipt.blockNumber, 'public receipt block number');
  const publicLogs = canonicalLogs(publicReceipt.logs);

  const fullUserOperation = await rpcRead(() => bundlerClient.getUserOperation({
    hash: canonicalUserOpHash,
  }));
  if (!fullUserOperation) throw retryable();
  if (!fullUserOperation.userOperation || typeof fullUserOperation.userOperation !== 'object'
      || Array.isArray(fullUserOperation.userOperation)) {
    throw mismatch('full UserOperation is malformed');
  }
  const signedUserOperation = fullUserOperation.userOperation;
  const fullBlockHash = normalizeHashForEvidence(fullUserOperation.blockHash);
  const fullBlockNumber = integer(fullUserOperation.blockNumber, 'full UserOperation block number');
  const fullEntryPoint = normalizeAddressForEvidence(fullUserOperation.entryPoint);
  const fullTransactionHash = normalizeHashForEvidence(fullUserOperation.transactionHash);
  const fullSender = normalizeAddressForEvidence(signedUserOperation.sender);
  const fullNonce = integer(signedUserOperation.nonce, 'full UserOperation nonce');
  const signedCallData = normalizeData(signedUserOperation.callData);
  const commitmentHex = jobCommitment.slice(2);
  const callDataHex = signedCallData.slice(2);
  if (fullBlockHash !== blockHash
      || fullBlockNumber !== blockNumber
      || fullEntryPoint !== facts.entryPointAddress
      || fullTransactionHash !== canonicalUnwindTxHash
      || fullSender !== canonicalKernel
      || callDataHex.length <= commitmentHex.length
      || !callDataHex.endsWith(commitmentHex)
      || callDataHex.indexOf(commitmentHex) !== callDataHex.length - commitmentHex.length) {
    throw mismatch('full UserOperation identity or job commitment differs');
  }
  let recomputedUserOpHash;
  try {
    recomputedUserOpHash = getUserOperationHash({
      chainId: facts.chainId,
      entryPointAddress: facts.entryPointAddress,
      entryPointVersion: '0.7',
      userOperation: signedUserOperation,
    }).toLowerCase();
  } catch {
    throw mismatch('full UserOperation is malformed');
  }
  if (recomputedUserOpHash !== canonicalUserOpHash) {
    throw mismatch('full UserOperation hash differs');
  }

  const userOpReceipt = await rpcRead(() => bundlerClient.getUserOperationReceipt({
    hash: canonicalUserOpHash,
  }));
  if (!userOpReceipt) throw retryable();
  if (userOpReceipt.success !== true || userOpReceipt.receipt?.status !== 'success') {
    if (userOpReceipt.success === false || userOpReceipt.receipt?.status === 'reverted') {
      throw reverted();
    }
    throw mismatch('bundler receipt success fields are malformed');
  }
  if (normalizeHashForEvidence(userOpReceipt.userOpHash) !== canonicalUserOpHash
      || normalizeAddressForEvidence(userOpReceipt.entryPoint) !== facts.entryPointAddress
      || normalizeAddressForEvidence(userOpReceipt.sender) !== canonicalKernel
      || normalizeHashForEvidence(userOpReceipt.receipt.transactionHash) !== canonicalUnwindTxHash) {
    throw mismatch('bundler receipt identity differs');
  }
  const bundlerNonce = integer(userOpReceipt.nonce, 'bundler UserOperation nonce');
  if (fullNonce !== bundlerNonce) throw mismatch('full UserOperation nonce differs');
  const topLevelLogs = canonicalLogs(userOpReceipt.logs);

  const topMessage = singleRaw(
    topLevelLogs,
    facts.messageTransmitterV2Address,
    UNWIND_EVENT_TOPICS.messageSent,
    'MessageSent',
  );
  const topDeposit = singleRaw(
    topLevelLogs,
    facts.tokenMessengerV2Address,
    UNWIND_EVENT_TOPICS.depositForBurn,
    'DepositForBurn',
  );
  const topSwept = singleRaw(
    topLevelLogs,
    facts.baseExitSweeperAddress,
    UNWIND_EVENT_TOPICS.swept,
    'Swept',
  );
  const topUserOperation = singleRaw(
    topLevelLogs,
    facts.entryPointAddress,
    UNWIND_EVENT_TOPICS.userOperationEvent,
    'UserOperationEvent',
  );
  for (const relied of [topMessage, topDeposit, topSwept, topUserOperation]) {
    const matches = publicLogs.filter((candidate) => sameLog(candidate, relied));
    if (matches.length !== 1) throw mismatch('per-UserOperation log is not canonical public evidence');
  }

  const swept = decode(topSwept, SWEPT_ABI, 'Swept', 'Swept');
  const deposit = decode(topDeposit, DEPOSIT_FOR_BURN_ABI, 'DepositForBurn', 'DepositForBurn');
  const userOperation = decode(
    topUserOperation,
    USER_OPERATION_EVENT_ABI,
    'UserOperationEvent',
    'UserOperationEvent',
  );
  const burned = integer(swept.burned, 'Swept burned amount');
  const exited = integer(swept.exited, 'Swept exited count');
  const skipped = integer(swept.skipped, 'Swept skipped count');
  if (normalizeAddressForEvidence(swept.owner) !== canonicalKernel || burned <= 0n) {
    throw mismatch('Swept owner or amount differs');
  }
  if (normalizeHashForEvidence(userOperation.userOpHash) !== canonicalUserOpHash
      || normalizeAddressForEvidence(userOperation.sender) !== canonicalKernel
      || integer(userOperation.nonce, 'UserOperationEvent nonce') !== bundlerNonce
      || userOperation.success !== true) {
    throw mismatch('UserOperationEvent identity or outcome differs');
  }

  const depositAmount = integer(deposit.amount, 'DepositForBurn amount');
  const maxFee = integer(deposit.maxFee, 'DepositForBurn maxFee');
  if (normalizeAddressForEvidence(deposit.burnToken) !== facts.usdcAddress
      || normalizeAddressForEvidence(deposit.depositor) !== facts.baseExitSweeperAddress
      || depositAmount !== burned
      || normalizeBytes32(deposit.mintRecipient) !== facts.cctpForwarder
      || integer(deposit.destinationDomain, 'DepositForBurn destination domain') !== 27n
      || normalizeBytes32(deposit.destinationTokenMessenger) !== facts.stellarTokenMessenger
      || normalizeBytes32(deposit.destinationCaller) !== facts.cctpForwarder
      || integer(deposit.minFinalityThreshold, 'DepositForBurn finality') !== 1000n
      || normalizeData(deposit.hookData) !== hookData) {
    throw mismatch('DepositForBurn route or amount differs');
  }

  if (!(topMessage.logIndex < topDeposit.logIndex
      && topDeposit.logIndex < topSwept.logIndex
      && topSwept.logIndex < topUserOperation.logIndex)) {
    throw mismatch('unwind event order differs');
  }

  const expectation = canonicalizeExpectation({
    version: 1,
    direction: 'base-to-stellar',
    sourceDomain: BASE_DOMAIN,
    destinationDomain: facts.stellarDomain,
    sender: addressBytes32(facts.tokenMessengerV2Address),
    recipient: facts.stellarTokenMessenger,
    destinationCaller: facts.cctpForwarder,
    burnToken: addressBytes32(facts.usdcAddress),
    mintRecipient: facts.cctpForwarder,
    messageSender: addressBytes32(facts.baseExitSweeperAddress),
    amount: burned.toString(),
    burnUnits7: null,
    maxFee: maxFee.toString(),
    minFinalityThreshold: facts.finalityThreshold,
    hookData,
  });

  const publicSourceLogs = publicLogs.filter((log) =>
    log.address === facts.messageTransmitterV2Address
      && log.topics[0] === UNWIND_EVENT_TOPICS.messageSent);
  const matchingSources = publicSourceLogs.flatMap((log) => {
    try {
      const decoded = decodeSourceMessage(log);
      return sourceMatches(decoded.parsed, expectation) ? [{ log, ...decoded }] : [];
    } catch (error) {
      if (error?.code === 'UNWIND_EVIDENCE_MISMATCH') return [];
      throw error;
    }
  });
  if (matchingSources.length === 0) throw mismatch('matching source MessageSent is missing');
  if (matchingSources.length !== 1) throw ambiguous('matching source MessageSent is duplicated');
  const [source] = matchingSources;
  if (!sameLog(source.log, topMessage)) {
    throw mismatch('per-UserOperation MessageSent is not the matching source message');
  }

  const publicUserOperations = publicLogs.filter((log) =>
    log.address === facts.entryPointAddress
      && log.topics[0] === UNWIND_EVENT_TOPICS.userOperationEvent)
    .map((log) => ({
      log,
      args: decode(log, USER_OPERATION_EVENT_ABI, 'UserOperationEvent', 'UserOperationEvent'),
    }))
    .filter(({ args }) => normalizeHashForEvidence(args.userOpHash) === canonicalUserOpHash
      && normalizeAddressForEvidence(args.sender) === canonicalKernel);
  if (publicUserOperations.length === 0) throw mismatch('matching UserOperationEvent is missing');
  if (publicUserOperations.length !== 1) throw ambiguous('matching UserOperationEvent is duplicated');
  if (!sameLog(publicUserOperations[0].log, topUserOperation)) {
    throw mismatch('bundler UserOperationEvent differs from public evidence');
  }

  const namedLogs = {
    messageSent: topMessage,
    depositForBurn: topDeposit,
    swept: topSwept,
    userOperationEvent: topUserOperation,
  };
  const proof = {
    version: 1,
    chainId: facts.chainId,
    userOpHash: canonicalUserOpHash,
    jobCommitment,
    unwindTxHash: canonicalUnwindTxHash,
    entryPointAddress: facts.entryPointAddress,
    kernelAddress: canonicalKernel,
    blockNumber: blockNumber.toString(),
    blockHash,
    userOpNonce: bundlerNonce.toString(),
    burned: burned.toString(),
    exited: exited.toString(),
    skipped: skipped.toString(),
    maxFee: maxFee.toString(),
    hookData,
    sourceMessageHex: source.messageHex,
    sourceMessageDigest: sha256Bytes(source.messageHex),
    logIndices: Object.fromEntries(
      Object.entries(namedLogs).map(([name, log]) => [name, log.logIndex]),
    ),
    logDigests: Object.fromEntries(
      Object.entries(namedLogs).map(([name, log]) => [name, logDigest(log)]),
    ),
  };
  return deepFreeze({ proof, expectation });
}

function normalizeHashForEvidence(value) {
  if (typeof value !== 'string' || !HASH32_RE.test(value)) throw mismatch('receipt hash is malformed');
  return value.toLowerCase();
}

function normalizeBytes32(value) {
  if (typeof value !== 'string' || !HASH32_RE.test(value)) throw mismatch('receipt bytes32 is malformed');
  return value.toLowerCase();
}

function normalizeData(value) {
  if (typeof value !== 'string' || !DATA_RE.test(value)) throw mismatch('receipt bytes are malformed');
  return value.toLowerCase();
}
