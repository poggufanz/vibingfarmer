import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { readUnwindEvidence } from '../src/unwindEvidence.mjs';

const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const KERNEL = `0x${'11'.repeat(20)}`;
const SWEEPER = `0x${'22'.repeat(20)}`;
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const TOKEN_MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const MESSAGE_TRANSMITTER = '0xe737e5cebeeba77efe34d4aa090756590b1ce275';
const STELLAR_TOKEN_MESSENGER =
  '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8';
const CCTP_FORWARDER =
  '0x3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e';
const RECIPIENT_HINT = 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK';
const JOB_ID = 'ab'.repeat(16);
const JOB_COMMITMENT =
  '0x2a8c851ab65e5f08fe5af4d1b09eaf2bbd7156fe6561f537d30454905de12cb7';
const USER_OP_HASH =
  '0xded211dbb07894cd67b9e2a040516cf0405ca2a40d10cb5ffd6fe2792a0f6fa4';
const SPONSORED_USER_OP_HASH =
  '0x492e5828fcf5a988be343c53d83e13ffbea76f153b7692915458cd9c1cd43009';
const UNWIND_TX_HASH = `0x${'44'.repeat(32)}`;
const BLOCK_HASH = `0x${'55'.repeat(32)}`;
const PAYMASTER = `0x${'00'.repeat(20)}`;
const SPONSORED_PAYMASTER = `0x${'33'.repeat(20)}`;
const USER_OP_NONCE = 7n;
const BURNED = 1_234_567n;
const EXITED = 3n;
const SKIPPED = 1n;
const MAX_FEE = 10_000n;
const USER_OPERATION = Object.freeze({
  sender: KERNEL,
  nonce: USER_OP_NONCE,
  callData: `0x12345678${JOB_COMMITMENT.slice(2)}`,
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  signature: `0x${'99'.repeat(65)}`,
});
const SPONSORED_USER_OPERATION = Object.freeze({
  ...USER_OPERATION,
  paymaster: SPONSORED_PAYMASTER,
  paymasterData: '0xa1b2c3d4',
  paymasterVerificationGasLimit: 30_000n,
  paymasterPostOpGasLimit: 40_000n,
});

const TOPIC = Object.freeze({
  swept: '0x4f2d11fb664b5f2f436d0d6acfed89a492c2f8fde20a4811da677150003332eb',
  deposit: '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5',
  message: '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036',
  userOp: '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
});

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const u32 = (value) => BigInt(value).toString(16).padStart(8, '0');
const addressWord = (address) => address.slice(2).padStart(64, '0');
const bytes32Topic = (value) => `0x${String(value).replace(/^0x/, '').padStart(64, '0')}`;
const addressTopic = (address) => bytes32Topic(address);

const HOOK_DATA = `0x${'00'.repeat(24)}0000000000000038${Buffer.from(RECIPIENT_HINT, 'utf8').toString('hex')}`;

function sourceMessage({
  headerVersion = 1,
  sourceDomain = 6,
  destinationDomain = 27,
  nonce = `0x${'00'.repeat(32)}`,
  sender = addressWord(TOKEN_MESSENGER),
  recipient = STELLAR_TOKEN_MESSENGER,
  destinationCaller = CCTP_FORWARDER,
  minFinalityThreshold = 1000,
  finalityThresholdExecuted = 0,
  bodyVersion = 1,
  burnToken = addressWord(USDC),
  mintRecipient = CCTP_FORWARDER,
  amount = BURNED,
  messageSender = addressWord(SWEEPER),
  maxFee = MAX_FEE,
  feeExecuted = 0,
  expirationBlock = 0,
  hookData = HOOK_DATA,
} = {}) {
  return `0x${[
    u32(headerVersion),
    u32(sourceDomain),
    u32(destinationDomain),
    nonce.slice(2),
    sender.replace(/^0x/, ''),
    recipient.slice(2),
    destinationCaller.slice(2),
    u32(minFinalityThreshold),
    u32(finalityThresholdExecuted),
    u32(bodyVersion),
    burnToken.replace(/^0x/, ''),
    mintRecipient.slice(2),
    word(amount),
    messageSender.replace(/^0x/, ''),
    word(maxFee),
    word(feeExecuted),
    word(expirationBlock),
    hookData.slice(2),
  ].join('')}`;
}

// Literal source MessageSent bytes captured from the independently specified event fixture.
// Keep this separate from sourceMessage(), which exists only to generate one-field mutations.
const SOURCE_MESSAGE = [
  '0x00000001000000060000001b0000000000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daada6f9ee0786c812344d82817ef19b648b4af12',
  '0f8bd10bf658e6b99eacff24b83de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e000003',
  'e80000000000000001000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e3de86ac50b47ea',
  'f2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e0000000000000000000000000000000000000000000000',
  '00000000000012d687000000000000000000000000222222222222222222222222222222222222222200000000000000',
  '000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000384743584d5a434456595441414e42524153554757533547',
  '444b52475351574e4d3558485642344a4937505845435a594b4247354f5454524b',
].join('');

const EXPECTED_SOURCE_MESSAGE_DIGEST =
  'c99fb1d6de4d8e2338fa1872ec9cfb8dca0de28a7c17e8cc2c2a06e1cb692df3';
const EXPECTED_LOG_DIGESTS = Object.freeze({
  messageSent: 'a7683b8ee299a61d37cb40f678800f5fd6e748e567c4f6837b3659a3c12e5e58',
  depositForBurn: '6097dea1993b5e541208064f8aee9f1b8e5c121608032ce962c8825f882a2c88',
  swept: 'cde5d181907743b8464b6849f5e502ef69e853558f8c2395e9993a0f7bd5288d',
  userOperationEvent: 'd42c83aa138cf3d23fcce7588ad01171274c9ac37aa00ecad11d7095d6ae98de',
});

function makeSweptLog({
  address = SWEEPER,
  owner = KERNEL,
  burned = BURNED,
  exited = EXITED,
  skipped = SKIPPED,
  logIndex = 12,
} = {}) {
  return Object.freeze({
    address,
    topics: [TOPIC.swept, addressTopic(owner)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [burned, exited, skipped],
    ),
    logIndex,
  });
}

function makeDepositLog({
  address = TOKEN_MESSENGER,
  burnToken = USDC,
  amount = BURNED,
  depositor = SWEEPER,
  mintRecipient = CCTP_FORWARDER,
  destinationDomain = 27,
  destinationTokenMessenger = STELLAR_TOKEN_MESSENGER,
  destinationCaller = CCTP_FORWARDER,
  maxFee = MAX_FEE,
  finality = 1000,
  hookData = HOOK_DATA,
  logIndex = 11,
} = {}) {
  return Object.freeze({
    address,
    topics: [TOPIC.deposit, addressTopic(burnToken), addressTopic(depositor), `0x${word(finality)}`],
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes' },
      ],
      [
        amount,
        mintRecipient,
        destinationDomain,
        destinationTokenMessenger,
        destinationCaller,
        maxFee,
        hookData,
      ],
    ),
    logIndex,
  });
}

function makeMessageLog({
  address = MESSAGE_TRANSMITTER,
  message = SOURCE_MESSAGE,
  logIndex = 10,
  data,
} = {}) {
  return Object.freeze({
    address,
    topics: [TOPIC.message],
    data: data ?? encodeAbiParameters([{ type: 'bytes' }], [message]),
    logIndex,
  });
}

function makeUserOpLog({
  address = ENTRY_POINT,
  userOpHash = USER_OP_HASH,
  sender = KERNEL,
  paymaster = PAYMASTER,
  nonce = USER_OP_NONCE,
  success = true,
  logIndex = 13,
} = {}) {
  return Object.freeze({
    address,
    topics: [TOPIC.userOp, userOpHash, addressTopic(sender), addressTopic(paymaster)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [nonce, success, 50_000n, 75_000n],
    ),
    logIndex,
  });
}

const sweptLog = makeSweptLog();
const depositLog = makeDepositLog();
const messageLog = makeMessageLog();
const userOpLog = makeUserOpLog();

const perUserOpLogs = Object.freeze([messageLog, depositLog, sweptLog, userOpLog]);

function evidenceLogs({
  message = messageLog,
  deposit = depositLog,
  swept = sweptLog,
  userOp = userOpLog,
  extras = [],
} = {}) {
  return [message, deposit, swept, userOp, ...extras].filter(Boolean);
}

const facts = Object.freeze({
  generation: 'hardened-v2',
  chainId: 84532,
  entryPointAddress: ENTRY_POINT,
  baseExitSweeperAddress: SWEEPER,
  usdcAddress: USDC,
  tokenMessengerV2Address: TOKEN_MESSENGER,
  messageTransmitterV2Address: MESSAGE_TRANSMITTER,
  stellarDomain: 27,
  stellarTokenMessenger: STELLAR_TOKEN_MESSENGER,
  cctpForwarder: CCTP_FORWARDER,
  finalityThreshold: 1000,
});

function makePublicReceipt(overrides = {}) {
  return {
    transactionHash: UNWIND_TX_HASH,
    blockNumber: 1234n,
    blockHash: BLOCK_HASH,
    status: 'success',
    to: ENTRY_POINT,
    logs: perUserOpLogs,
    ...overrides,
  };
}

function makeBundlerReceipt(overrides = {}) {
  return {
    userOpHash: USER_OP_HASH,
    entryPoint: ENTRY_POINT,
    sender: KERNEL,
    nonce: USER_OP_NONCE,
    success: true,
    logs: perUserOpLogs,
    receipt: { transactionHash: UNWIND_TX_HASH, status: 'success' },
    ...overrides,
  };
}

function makeBundlerUserOperation({ userOperation, ...overrides } = {}) {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: 1234n,
    entryPoint: ENTRY_POINT,
    transactionHash: UNWIND_TX_HASH,
    userOperation: { ...USER_OPERATION, ...userOperation },
    ...overrides,
  };
}

function harness({
  publicReceipt,
  userOpReceipt,
  userOperation = makeBundlerUserOperation(),
} = {}) {
  const trace = [];
  const canonicalPublicReceipt = publicReceipt ?? makePublicReceipt();
  const canonicalUserOpReceipt = userOpReceipt ?? makeBundlerReceipt();
  const canonicalUserOperation = userOperation;
  return {
    trace,
    publicClient: {
      getChainId: vi.fn(async () => { trace.push('chain'); return 84532; }),
      getTransactionReceipt: vi.fn(async () => { trace.push('public'); return canonicalPublicReceipt; }),
    },
    bundlerClient: {
      getUserOperation: vi.fn(async () => { trace.push('userop'); return canonicalUserOperation; }),
      getUserOperationReceipt: vi.fn(async () => { trace.push('bundler'); return canonicalUserOpReceipt; }),
    },
  };
}

function evidenceHarness(logs, { publicLogs = logs, userOpOverrides, publicOverrides } = {}) {
  return harness({
    publicReceipt: makePublicReceipt({ logs: publicLogs, ...publicOverrides }),
    userOpReceipt: makeBundlerReceipt({ logs, ...userOpOverrides }),
  });
}

function inputFor(h, overrides = {}) {
  return {
    publicClient: h.publicClient,
    bundlerClient: h.bundlerClient,
    jobId: JOB_ID,
    userOpHash: USER_OP_HASH,
    unwindTxHash: UNWIND_TX_HASH,
    kernelAddress: KERNEL,
    recipientHint: RECIPIENT_HINT,
    facts,
    ...overrides,
  };
}

function sponsoredHarness(userOperation = SPONSORED_USER_OPERATION) {
  const sponsoredUserOpLog = makeUserOpLog({
    userOpHash: SPONSORED_USER_OP_HASH,
    paymaster: SPONSORED_PAYMASTER,
  });
  const logs = evidenceLogs({ userOp: sponsoredUserOpLog });
  return harness({
    publicReceipt: makePublicReceipt({ logs }),
    userOpReceipt: makeBundlerReceipt({
      userOpHash: SPONSORED_USER_OP_HASH,
      logs,
    }),
    userOperation: makeBundlerUserOperation({ userOperation }),
  });
}

async function expectEvidenceCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('readUnwindEvidence', () => {
  it('derives one canonical proof and immutable reverse expectation from the full authority chain', async () => {
    const h = harness();
    const result = await readUnwindEvidence(inputFor(h));

    expect(h.trace).toEqual(['chain', 'public', 'userop', 'bundler']);
    expect(result.expectation).toEqual({
      version: 1,
      direction: 'base-to-stellar',
      sourceDomain: 6,
      destinationDomain: 27,
      sender: `0x${addressWord(TOKEN_MESSENGER)}`,
      recipient: STELLAR_TOKEN_MESSENGER,
      destinationCaller: CCTP_FORWARDER,
      burnToken: `0x${addressWord(USDC)}`,
      mintRecipient: CCTP_FORWARDER,
      messageSender: `0x${addressWord(SWEEPER)}`,
      amount: BURNED.toString(),
      burnUnits7: null,
      maxFee: MAX_FEE.toString(),
      minFinalityThreshold: 1000,
      hookData: HOOK_DATA,
    });
    expect(result.proof).toMatchObject({
      version: 1,
      chainId: 84532,
      userOpHash: USER_OP_HASH,
      jobCommitment: JOB_COMMITMENT,
      unwindTxHash: UNWIND_TX_HASH,
      entryPointAddress: ENTRY_POINT,
      kernelAddress: KERNEL,
      blockNumber: '1234',
      blockHash: BLOCK_HASH,
      userOpNonce: USER_OP_NONCE.toString(),
      burned: BURNED.toString(),
      exited: EXITED.toString(),
      skipped: SKIPPED.toString(),
      maxFee: MAX_FEE.toString(),
      hookData: HOOK_DATA,
      sourceMessageHex: SOURCE_MESSAGE,
      sourceMessageDigest: EXPECTED_SOURCE_MESSAGE_DIGEST,
      logIndices: {
        messageSent: 10,
        depositForBurn: 11,
        swept: 12,
        userOperationEvent: 13,
      },
    });
    expect(result.proof.sourceMessageDigest).toBe(EXPECTED_SOURCE_MESSAGE_DIGEST);
    expect(result.proof.logDigests).toEqual(EXPECTED_LOG_DIGESTS);
    expect(h.bundlerClient.getUserOperation).toHaveBeenCalledWith({ hash: USER_OP_HASH });
  });

  it('rejects an invalid recipient checksum before either receipt authority is queried', async () => {
    const h = harness();
    const invalidRecipient = `${RECIPIENT_HINT.slice(0, -1)}A`;

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h, { recipientHint: invalidRecipient })),
      'UNWIND_EVIDENCE_VALIDATION',
    );

    expect(h.trace).toEqual([]);
  });

  it('isolates an unrelated malformed MessageSent in the same bundle while selecting the unique match', async () => {
    const unrelatedMalformed = makeMessageLog({ data: '0x00', logIndex: 4 });
    const h = harness({
      publicReceipt: makePublicReceipt({ logs: [unrelatedMalformed, ...perUserOpLogs] }),
    });

    const result = await readUnwindEvidence(inputFor(h));

    expect(result.proof.sourceMessageHex).toBe(SOURCE_MESSAGE);
    expect(result.proof.logIndices.messageSent).toBe(messageLog.logIndex);
  });

  it('requires the full UserOperation reader before any RPC authority is consulted', async () => {
    const h = harness();
    delete h.bundlerClient.getUserOperation;

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_VALIDATION',
    );

    expect(h.trace).toEqual([]);
  });

  it('recomputes an independently pinned sponsored v0.7 UserOperation hash', async () => {
    const h = sponsoredHarness();

    const result = await readUnwindEvidence(inputFor(h, {
      userOpHash: SPONSORED_USER_OP_HASH,
    }));

    expect(result.proof.userOpHash).toBe(SPONSORED_USER_OP_HASH);
    expect(result.proof.jobCommitment).toBe(JOB_COMMITMENT);
    expect(h.bundlerClient.getUserOperation).toHaveBeenCalledWith({
      hash: SPONSORED_USER_OP_HASH,
    });
  });

  it.each([
    ['paymaster address', { paymaster: `0x${'34'.repeat(20)}` }],
    ['paymaster data', { paymasterData: '0xa1b2c3d5' }],
    ['paymaster verification gas', { paymasterVerificationGasLimit: 30_001n }],
    ['paymaster post-op gas', { paymasterPostOpGasLimit: 40_001n }],
  ])('rejects a sponsored v0.7 mutation in %s', async (_label, mutation) => {
    const h = sponsoredHarness({ ...SPONSORED_USER_OPERATION, ...mutation });

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h, { userOpHash: SPONSORED_USER_OP_HASH })),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it('rejects a different valid reservation job when the signed UserOperation keeps the first job suffix', async () => {
    const h = harness();

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h, { jobId: 'cd'.repeat(16) })),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it.each([
    ['missing full UserOperation', null, 'UNWIND_EVIDENCE_RETRYABLE'],
    ['wrong inclusion block hash', makeBundlerUserOperation({ blockHash: `0x${'66'.repeat(32)}` }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong inclusion block number', makeBundlerUserOperation({ blockNumber: 1235n }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong inclusion EntryPoint', makeBundlerUserOperation({ entryPoint: SWEEPER }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong inclusion transaction', makeBundlerUserOperation({ transactionHash: `0x${'77'.repeat(32)}` }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong full UserOperation sender', makeBundlerUserOperation({ userOperation: { sender: SWEEPER } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong full UserOperation nonce', makeBundlerUserOperation({ userOperation: { nonce: USER_OP_NONCE + 1n } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['missing signed job suffix', makeBundlerUserOperation({ userOperation: { callData: '0x12345678' } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['different signed job suffix', makeBundlerUserOperation({ userOperation: { callData: `0x12345678${'00'.repeat(32)}` } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['different hashed gas field', makeBundlerUserOperation({ userOperation: { callGasLimit: 100_001n } }), 'UNWIND_EVIDENCE_MISMATCH'],
  ])('rejects %s instead of trusting receipt-only evidence', async (_label, userOperation, code) => {
    const h = harness({ userOperation });

    await expectEvidenceCode(readUnwindEvidence(inputFor(h)), code);
  });

  it.each([
    ['extra client evidence', { burned: BURNED.toString() }],
    ['malformed unwind job', { jobId: JOB_ID.toUpperCase() }],
    ['malformed UserOperation hash', { userOpHash: '0x1234' }],
    ['malformed unwind transaction hash', { unwindTxHash: '44'.repeat(32) }],
    ['zero Kernel', { kernelAddress: `0x${'00'.repeat(20)}` }],
    ['malformed Kernel', { kernelAddress: '0x1234' }],
    ['wrong deployment generation', { facts: { ...facts, generation: 'legacy' } }],
    ['extra deployment fact', { facts: { ...facts, rpcUrl: 'https://secret.invalid' } }],
    ['zero EntryPoint fact', { facts: { ...facts, entryPointAddress: `0x${'00'.repeat(20)}` } }],
    ['zero remote messenger fact', { facts: { ...facts, stellarTokenMessenger: `0x${'00'.repeat(32)}` } }],
  ])('rejects %s before RPC', async (_label, overrides) => {
    const h = harness();

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h, overrides)),
      'UNWIND_EVIDENCE_VALIDATION',
    );

    expect(h.trace).toEqual([]);
  });

  it.each([
    ['chain RPC failure', 'chain', 'UNWIND_EVIDENCE_RETRYABLE'],
    ['public receipt RPC failure', 'public', 'UNWIND_EVIDENCE_RETRYABLE'],
    ['bundler receipt RPC failure', 'bundler', 'UNWIND_EVIDENCE_RETRYABLE'],
    ['full UserOperation RPC failure', 'userop', 'UNWIND_EVIDENCE_RETRYABLE'],
  ])('classifies %s without accepting partial authority', async (_label, boundary, code) => {
    const h = harness();
    const method = boundary === 'chain'
      ? h.publicClient.getChainId
      : boundary === 'public'
        ? h.publicClient.getTransactionReceipt
        : boundary === 'userop'
          ? h.bundlerClient.getUserOperation
          : h.bundlerClient.getUserOperationReceipt;
    method.mockRejectedValueOnce(new Error('private transport failure'));

    await expectEvidenceCode(readUnwindEvidence(inputFor(h)), code);
  });

  it.each([
    ['wrong chain', { chainId: 1 }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['missing public receipt', { publicReceipt: null }, 'UNWIND_EVIDENCE_RETRYABLE'],
    ['reverted public receipt', { public: { status: 'reverted' } }, 'UNWIND_EVIDENCE_REVERTED'],
    ['malformed public status', { public: { status: '0x1' } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong public transaction hash', { public: { transactionHash: `0x${'66'.repeat(32)}` } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong public EntryPoint', { public: { to: SWEEPER } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['malformed public block number', { public: { blockNumber: -1 } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['malformed public block hash', { public: { blockHash: '0x1234' } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['missing bundler receipt', { userOpReceipt: null }, 'UNWIND_EVIDENCE_RETRYABLE'],
    ['outer UserOperation failure', { userOp: { success: false } }, 'UNWIND_EVIDENCE_REVERTED'],
    ['inner receipt revert', { userOp: { receipt: { transactionHash: UNWIND_TX_HASH, status: 'reverted' } } }, 'UNWIND_EVIDENCE_REVERTED'],
    ['missing inner success', { userOp: { receipt: { transactionHash: UNWIND_TX_HASH } } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong returned UserOperation hash', { userOp: { userOpHash: `0x${'77'.repeat(32)}` } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong returned EntryPoint', { userOp: { entryPoint: SWEEPER } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong returned Kernel', { userOp: { sender: SWEEPER } }, 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong nested transaction hash', { userOp: { receipt: { transactionHash: `0x${'88'.repeat(32)}`, status: 'success' } } }, 'UNWIND_EVIDENCE_MISMATCH'],
  ])('rejects %s with a stable class', async (_label, mutation, code) => {
    const publicReceipt = mutation.publicReceipt === null
      ? null
      : makePublicReceipt(mutation.public);
    const userOpReceipt = mutation.userOpReceipt === null
      ? null
      : makeBundlerReceipt(mutation.userOp);
    const h = harness({ publicReceipt, userOpReceipt });
    if (Object.prototype.hasOwnProperty.call(mutation, 'publicReceipt')) {
      h.publicClient.getTransactionReceipt.mockResolvedValueOnce(mutation.publicReceipt);
    }
    if (Object.prototype.hasOwnProperty.call(mutation, 'userOpReceipt')) {
      h.bundlerClient.getUserOperationReceipt.mockResolvedValueOnce(mutation.userOpReceipt);
    }
    if (mutation.chainId !== undefined) h.publicClient.getChainId.mockResolvedValueOnce(mutation.chainId);

    await expectEvidenceCode(readUnwindEvidence(inputFor(h)), code);
  });

  it('rejects a Swept event found only in the nested full-bundle receipt', async () => {
    const topLevel = evidenceLogs({ swept: null });
    const h = evidenceHarness(topLevel, {
      userOpOverrides: {
        receipt: {
          transactionHash: UNWIND_TX_HASH,
          status: 'success',
          logs: perUserOpLogs,
        },
      },
      publicLogs: perUserOpLogs,
    });

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it('requires every relied-on per-UserOperation log to exist byte-for-byte in the public receipt', async () => {
    const alteredPublicSwept = { ...sweptLog, data: makeSweptLog({ burned: BURNED + 1n }).data };
    const publicLogs = evidenceLogs({ swept: alteredPublicSwept });
    const h = evidenceHarness(perUserOpLogs, { publicLogs });

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it.each([
    ['missing Swept', evidenceLogs({ swept: null }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['duplicate Swept', evidenceLogs({ extras: [makeSweptLog({ owner: SWEEPER, logIndex: 14 })] }), 'UNWIND_EVIDENCE_AMBIGUOUS'],
    ['malformed Swept', evidenceLogs({ swept: { ...sweptLog, data: '0x00' } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong Swept emitter', evidenceLogs({ swept: makeSweptLog({ address: TOKEN_MESSENGER }) }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['missing DepositForBurn', evidenceLogs({ deposit: null }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['duplicate DepositForBurn', evidenceLogs({ extras: [makeDepositLog({ logIndex: 14 })] }), 'UNWIND_EVIDENCE_AMBIGUOUS'],
    ['malformed DepositForBurn', evidenceLogs({ deposit: { ...depositLog, data: '0x00' } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong DepositForBurn emitter', evidenceLogs({ deposit: makeDepositLog({ address: SWEEPER }) }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['missing MessageSent', evidenceLogs({ message: null }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['duplicate per-operation MessageSent', evidenceLogs({ extras: [makeMessageLog({ logIndex: 14 })] }), 'UNWIND_EVIDENCE_AMBIGUOUS'],
    ['malformed MessageSent', evidenceLogs({ message: makeMessageLog({ data: '0x00' }) }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong MessageSent emitter', evidenceLogs({ message: makeMessageLog({ address: SWEEPER }) }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['missing UserOperationEvent', evidenceLogs({ userOp: null }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['duplicate UserOperationEvent', evidenceLogs({ extras: [makeUserOpLog({ logIndex: 14 })] }), 'UNWIND_EVIDENCE_AMBIGUOUS'],
    ['malformed UserOperationEvent', evidenceLogs({ userOp: { ...userOpLog, data: '0x00' } }), 'UNWIND_EVIDENCE_MISMATCH'],
    ['wrong UserOperationEvent emitter', evidenceLogs({ userOp: makeUserOpLog({ address: SWEEPER }) }), 'UNWIND_EVIDENCE_MISMATCH'],
  ])('fails closed for %s', async (_label, logs, code) => {
    const h = evidenceHarness(logs);

    await expectEvidenceCode(readUnwindEvidence(inputFor(h)), code);
  });

  it.each([
    ['Swept owner', evidenceLogs({ swept: makeSweptLog({ owner: SWEEPER }) })],
    ['zero burned amount', evidenceLogs({
      swept: makeSweptLog({ burned: 0n }),
      deposit: makeDepositLog({ amount: 0n }),
      message: makeMessageLog({ message: sourceMessage({ amount: 0n }) }),
    })],
    ['burn token', evidenceLogs({ deposit: makeDepositLog({ burnToken: SWEEPER }) })],
    ['depositor', evidenceLogs({ deposit: makeDepositLog({ depositor: KERNEL }) })],
    ['burned amount', evidenceLogs({ deposit: makeDepositLog({ amount: BURNED + 1n }) })],
    ['mint recipient', evidenceLogs({ deposit: makeDepositLog({ mintRecipient: `0x${'99'.repeat(32)}` }) })],
    ['destination domain', evidenceLogs({ deposit: makeDepositLog({ destinationDomain: 26 }) })],
    ['destination TokenMessenger', evidenceLogs({ deposit: makeDepositLog({ destinationTokenMessenger: `0x${'99'.repeat(32)}` }) })],
    ['destination caller', evidenceLogs({ deposit: makeDepositLog({ destinationCaller: `0x${'99'.repeat(32)}` }) })],
    ['finality threshold', evidenceLogs({ deposit: makeDepositLog({ finality: 999 }) })],
    ['hook data', evidenceLogs({ deposit: makeDepositLog({ hookData: '0x1234' }) })],
    ['UserOperation hash', evidenceLogs({ userOp: makeUserOpLog({ userOpHash: `0x${'99'.repeat(32)}` }) })],
    ['UserOperation sender', evidenceLogs({ userOp: makeUserOpLog({ sender: SWEEPER }) })],
    ['UserOperation nonce', evidenceLogs({ userOp: makeUserOpLog({ nonce: USER_OP_NONCE + 1n }) })],
    ['UserOperation success', evidenceLogs({ userOp: makeUserOpLog({ success: false }) })],
  ])('rejects a semantic disagreement in %s', async (_label, logs) => {
    const h = evidenceHarness(logs);

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it.each([
    ['MessageSent after DepositForBurn', evidenceLogs({ message: makeMessageLog({ logIndex: 12 }), swept: makeSweptLog({ logIndex: 14 }), userOp: makeUserOpLog({ logIndex: 15 }) })],
    ['DepositForBurn after Swept', evidenceLogs({ deposit: makeDepositLog({ logIndex: 13 }), swept: makeSweptLog({ logIndex: 12 }), userOp: makeUserOpLog({ logIndex: 14 }) })],
    ['Swept after UserOperationEvent', evidenceLogs({ swept: makeSweptLog({ logIndex: 14 }), userOp: makeUserOpLog({ logIndex: 13 }) })],
  ])('rejects event-order splice: %s', async (_label, logs) => {
    const h = evidenceHarness(logs);

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it.each([
    ['header version', { headerVersion: 2 }],
    ['source domain', { sourceDomain: 7 }],
    ['destination domain', { destinationDomain: 26 }],
    ['zero-nonce sentinel', { nonce: `0x${'01'.repeat(32)}` }],
    ['sender', { sender: addressWord(SWEEPER) }],
    ['recipient', { recipient: `0x${'99'.repeat(32)}` }],
    ['destination caller', { destinationCaller: `0x${'99'.repeat(32)}` }],
    ['minimum finality', { minFinalityThreshold: 999 }],
    ['executed-finality sentinel', { finalityThresholdExecuted: 1000 }],
    ['body version', { bodyVersion: 2 }],
    ['burn token', { burnToken: addressWord(SWEEPER) }],
    ['mint recipient', { mintRecipient: `0x${'99'.repeat(32)}` }],
    ['amount', { amount: BURNED + 1n }],
    ['message sender', { messageSender: addressWord(KERNEL) }],
    ['max fee', { maxFee: MAX_FEE + 1n }],
    ['executed-fee sentinel', { feeExecuted: 1 }],
    ['expiration sentinel', { expirationBlock: 1 }],
    ['hook data', { hookData: '0x1234' }],
  ])('rejects a source-message disagreement in %s', async (_label, mutation) => {
    const logs = evidenceLogs({ message: makeMessageLog({ message: sourceMessage(mutation) }) });
    const h = evidenceHarness(logs);

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it('blocks two immutable-identical source messages anywhere in one public bundle', async () => {
    const duplicate = makeMessageLog({ logIndex: 20 });
    const h = evidenceHarness(perUserOpLogs, {
      publicLogs: [...perUserOpLogs, duplicate],
    });

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_AMBIGUOUS',
    );
  });

  it('ignores a valid but immutable-nonmatching source message elsewhere in the bundle', async () => {
    const unrelated = makeMessageLog({
      message: sourceMessage({ amount: BURNED + 1n }),
      logIndex: 20,
    });
    const h = evidenceHarness(perUserOpLogs, {
      publicLogs: [...perUserOpLogs, unrelated],
    });

    const result = await readUnwindEvidence(inputFor(h));

    expect(result.proof.sourceMessageHex).toBe(SOURCE_MESSAGE);
  });

  it('rejects when the unique matching source belongs outside the submitted UserOperation', async () => {
    const perOperationOtherMessage = makeMessageLog({
      message: sourceMessage({ amount: BURNED + 1n }),
    });
    const logs = evidenceLogs({ message: perOperationOtherMessage });
    const h = evidenceHarness(logs, {
      publicLogs: [...logs, makeMessageLog({ logIndex: 20 })],
    });

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_MISMATCH',
    );
  });

  it('rejects a duplicate matching public UserOperationEvent even when bundler logs contain one', async () => {
    const h = evidenceHarness(perUserOpLogs, {
      publicLogs: [...perUserOpLogs, makeUserOpLog({ logIndex: 20 })],
    });

    await expectEvidenceCode(
      readUnwindEvidence(inputFor(h)),
      'UNWIND_EVIDENCE_AMBIGUOUS',
    );
  });

  it('returns a closed immutable proof without mutating caller-owned receipts or facts', async () => {
    const publicReceipt = makePublicReceipt();
    const userOpReceipt = makeBundlerReceipt();
    const factsSnapshot = JSON.stringify(facts);
    const publicSnapshot = JSON.stringify(publicReceipt, (_key, value) => (
      typeof value === 'bigint' ? `${value}n` : value
    ));
    const userOpSnapshot = JSON.stringify(userOpReceipt, (_key, value) => (
      typeof value === 'bigint' ? `${value}n` : value
    ));
    const h = harness({ publicReceipt, userOpReceipt });

    const result = await readUnwindEvidence(inputFor(h));

    expect(Object.keys(result.proof)).toEqual([
      'version',
      'chainId',
      'userOpHash',
      'jobCommitment',
      'unwindTxHash',
      'entryPointAddress',
      'kernelAddress',
      'blockNumber',
      'blockHash',
      'userOpNonce',
      'burned',
      'exited',
      'skipped',
      'maxFee',
      'hookData',
      'sourceMessageHex',
      'sourceMessageDigest',
      'logIndices',
      'logDigests',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proof)).toBe(true);
    expect(Object.isFrozen(result.proof.logIndices)).toBe(true);
    expect(Object.isFrozen(result.expectation)).toBe(true);
    expect(JSON.stringify(facts)).toBe(factsSnapshot);
    expect(JSON.stringify(publicReceipt, (_key, value) => (
      typeof value === 'bigint' ? `${value}n` : value
    ))).toBe(publicSnapshot);
    expect(JSON.stringify(userOpReceipt, (_key, value) => (
      typeof value === 'bigint' ? `${value}n` : value
    ))).toBe(userOpSnapshot);
  });
});
