import { createHash, randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { concatHex, keccak256 } from 'viem';
import {
  canonicalizeExpectation,
  expectationDigest,
  relayEnqueueDecision,
  relayIdentityConflicts,
  assertCanonicalRelayRecord,
} from './store.mjs';

const JOB_ID_RE = /^[0-9a-f]{32}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const LOWER_HASH_RE = /^0x[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const EVEN_HEX_RE = /^0x(?:[0-9a-f]{2})*$/;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const LOG_NAMES = Object.freeze([
  'messageSent', 'depositForBurn', 'swept', 'userOperationEvent',
]);
const PROOF_KEYS = Object.freeze([
  'version', 'chainId', 'userOpHash', 'jobCommitment', 'unwindTxHash', 'entryPointAddress',
  'kernelAddress', 'blockNumber', 'blockHash', 'userOpNonce', 'burned', 'exited',
  'skipped', 'maxFee', 'hookData', 'sourceMessageHex', 'sourceMessageDigest',
  'logIndices', 'logDigests',
]);
const PROOF_DIGEST_DOMAIN = 'vf-unwind-proof-v1';
const UNWIND_JOB_DOMAIN = '0x76662d756e77696e642d6a6f622d7631';

export const UNWIND_PUBLIC_REASON_CODES = Object.freeze([
  'attested_evidence_changed',
  'destination_reverted',
  'legacy_record_unrecoverable',
  'message_ambiguous',
  'message_mismatch',
  'submission_lease_expired',
  'submission_unknown',
  'submitted_checkpoint_failed',
]);

const UNWIND_STATES = Object.freeze([
  'awaiting_burn', 'relay_pending', 'relay_running',
  'done', 'blocked', 'uncertain', 'expired',
]);

const UNWIND_COLUMNS = Object.freeze([
  'job_id', 'capability_hash', 'kernel_address', 'recipient_hint', 'request_digest',
  'reserve_json', 'expires_at', 'capability_expires_at', 'state',
  'candidate_user_op_hash', 'candidate_unwind_tx_hash', 'evidence_retry_until',
  'user_op_hash', 'unwind_tx_hash', 'chain_id',
  'entry_point', 'sweeper_address', 'block_number', 'block_hash',
  'user_operation_log_index', 'user_operation_log_digest', 'swept_log_index',
  'swept_log_digest', 'deposit_log_index', 'deposit_log_digest',
  'message_sent_log_index', 'message_sent_log_digest', 'burned', 'exited', 'skipped',
  'max_fee', 'hook_data', 'source_message_hex', 'source_message_digest', 'proof_json',
  'proof_digest', 'expectation_json', 'expectation_digest', 'relay_exec_id',
  'mint_tx_hash', 'reason_code', 'attempts', 'lease_token', 'lease_expires_at',
  'created_at', 'updated_at',
]);

const UNWIND_TABLE_SCHEMA = `
  CREATE TABLE unwind_jobs (
    job_id TEXT PRIMARY KEY CHECK (
      typeof(job_id)='text' AND length(job_id)=32
      AND job_id NOT GLOB '*[^0-9a-f]*'
    ),
    capability_hash TEXT NOT NULL CHECK (
      typeof(capability_hash)='text' AND length(capability_hash)=64
      AND capability_hash NOT GLOB '*[^0-9a-f]*'
    ),
    kernel_address TEXT NOT NULL CHECK (
      typeof(kernel_address)='text' AND length(kernel_address)=42
      AND substr(kernel_address,1,2)='0x'
      AND substr(kernel_address,3) NOT GLOB '*[^0-9a-f]*'
      AND kernel_address<>'0x0000000000000000000000000000000000000000'
    ),
    recipient_hint TEXT NOT NULL CHECK (
      typeof(recipient_hint)='text' AND length(recipient_hint)=56
      AND substr(recipient_hint,1,1) IN ('G','C')
      AND recipient_hint NOT GLOB '*[^ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]*'
    ),
    request_digest TEXT NOT NULL CHECK (
      typeof(request_digest)='text' AND length(request_digest)=64
      AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    reserve_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL CHECK (typeof(expires_at)='integer' AND expires_at>=0),
    capability_expires_at INTEGER NOT NULL CHECK (
      typeof(capability_expires_at)='integer' AND capability_expires_at>expires_at
    ),
    state TEXT NOT NULL CHECK (state IN (
      'awaiting_burn','relay_pending','relay_running','done','blocked','uncertain','expired'
    )),
    candidate_user_op_hash TEXT CHECK (candidate_user_op_hash IS NULL OR (
      typeof(candidate_user_op_hash)='text' AND length(candidate_user_op_hash)=66
      AND substr(candidate_user_op_hash,1,2)='0x'
      AND substr(candidate_user_op_hash,3) NOT GLOB '*[^0-9a-f]*'
    )),
    candidate_unwind_tx_hash TEXT CHECK (candidate_unwind_tx_hash IS NULL OR (
      typeof(candidate_unwind_tx_hash)='text' AND length(candidate_unwind_tx_hash)=66
      AND substr(candidate_unwind_tx_hash,1,2)='0x'
      AND substr(candidate_unwind_tx_hash,3) NOT GLOB '*[^0-9a-f]*'
    )),
    evidence_retry_until INTEGER CHECK (evidence_retry_until IS NULL OR (
      typeof(evidence_retry_until)='integer' AND evidence_retry_until>expires_at
      AND evidence_retry_until<=capability_expires_at
    )),
    user_op_hash TEXT CHECK (user_op_hash IS NULL OR (
      typeof(user_op_hash)='text' AND length(user_op_hash)=66
      AND substr(user_op_hash,1,2)='0x'
      AND substr(user_op_hash,3) NOT GLOB '*[^0-9a-f]*'
    )),
    unwind_tx_hash TEXT CHECK (unwind_tx_hash IS NULL OR (
      typeof(unwind_tx_hash)='text' AND length(unwind_tx_hash)=66
      AND substr(unwind_tx_hash,1,2)='0x'
      AND substr(unwind_tx_hash,3) NOT GLOB '*[^0-9a-f]*'
    )),
    chain_id INTEGER CHECK (chain_id IS NULL OR chain_id=84532),
    entry_point TEXT CHECK (entry_point IS NULL OR (
      typeof(entry_point)='text' AND length(entry_point)=42
      AND substr(entry_point,1,2)='0x'
      AND substr(entry_point,3) NOT GLOB '*[^0-9a-f]*'
      AND entry_point<>'0x0000000000000000000000000000000000000000'
    )),
    sweeper_address TEXT CHECK (sweeper_address IS NULL OR (
      typeof(sweeper_address)='text' AND length(sweeper_address)=42
      AND substr(sweeper_address,1,2)='0x'
      AND substr(sweeper_address,3) NOT GLOB '*[^0-9a-f]*'
      AND sweeper_address<>'0x0000000000000000000000000000000000000000'
    )),
    block_number TEXT CHECK (block_number IS NULL OR (
      typeof(block_number)='text' AND block_number NOT GLOB '*[^0-9]*'
      AND (block_number='0' OR (substr(block_number,1,1) BETWEEN '1' AND '9'))
    )),
    block_hash TEXT CHECK (block_hash IS NULL OR (
      typeof(block_hash)='text' AND length(block_hash)=66
      AND substr(block_hash,1,2)='0x'
      AND substr(block_hash,3) NOT GLOB '*[^0-9a-f]*'
    )),
    user_operation_log_index INTEGER CHECK (
      user_operation_log_index IS NULL OR (
        typeof(user_operation_log_index)='integer' AND user_operation_log_index>=0
      )
    ),
    user_operation_log_digest TEXT CHECK (user_operation_log_digest IS NULL OR (
      typeof(user_operation_log_digest)='text' AND length(user_operation_log_digest)=64
      AND user_operation_log_digest NOT GLOB '*[^0-9a-f]*'
    )),
    swept_log_index INTEGER CHECK (swept_log_index IS NULL OR (
      typeof(swept_log_index)='integer' AND swept_log_index>=0
    )),
    swept_log_digest TEXT CHECK (swept_log_digest IS NULL OR (
      typeof(swept_log_digest)='text' AND length(swept_log_digest)=64
      AND swept_log_digest NOT GLOB '*[^0-9a-f]*'
    )),
    deposit_log_index INTEGER CHECK (deposit_log_index IS NULL OR (
      typeof(deposit_log_index)='integer' AND deposit_log_index>=0
    )),
    deposit_log_digest TEXT CHECK (deposit_log_digest IS NULL OR (
      typeof(deposit_log_digest)='text' AND length(deposit_log_digest)=64
      AND deposit_log_digest NOT GLOB '*[^0-9a-f]*'
    )),
    message_sent_log_index INTEGER CHECK (message_sent_log_index IS NULL OR (
      typeof(message_sent_log_index)='integer' AND message_sent_log_index>=0
    )),
    message_sent_log_digest TEXT CHECK (message_sent_log_digest IS NULL OR (
      typeof(message_sent_log_digest)='text' AND length(message_sent_log_digest)=64
      AND message_sent_log_digest NOT GLOB '*[^0-9a-f]*'
    )),
    burned TEXT CHECK (burned IS NULL OR (
      typeof(burned)='text' AND burned NOT GLOB '*[^0-9]*'
      AND (burned='0' OR (substr(burned,1,1) BETWEEN '1' AND '9'))
    )),
    exited TEXT CHECK (exited IS NULL OR (
      typeof(exited)='text' AND exited NOT GLOB '*[^0-9]*'
      AND (exited='0' OR (substr(exited,1,1) BETWEEN '1' AND '9'))
    )),
    skipped TEXT CHECK (skipped IS NULL OR (
      typeof(skipped)='text' AND skipped NOT GLOB '*[^0-9]*'
      AND (skipped='0' OR (substr(skipped,1,1) BETWEEN '1' AND '9'))
    )),
    max_fee TEXT CHECK (max_fee IS NULL OR (
      typeof(max_fee)='text' AND max_fee NOT GLOB '*[^0-9]*'
      AND (max_fee='0' OR (substr(max_fee,1,1) BETWEEN '1' AND '9'))
    )),
    hook_data TEXT CHECK (hook_data IS NULL OR (
      typeof(hook_data)='text' AND length(hook_data)>=2
      AND substr(hook_data,1,2)='0x' AND (length(hook_data)-2)%2=0
      AND substr(hook_data,3) NOT GLOB '*[^0-9a-f]*'
    )),
    source_message_hex TEXT CHECK (source_message_hex IS NULL OR (
      typeof(source_message_hex)='text' AND length(source_message_hex)>2
      AND substr(source_message_hex,1,2)='0x' AND (length(source_message_hex)-2)%2=0
      AND substr(source_message_hex,3) NOT GLOB '*[^0-9a-f]*'
    )),
    source_message_digest TEXT CHECK (source_message_digest IS NULL OR (
      typeof(source_message_digest)='text' AND length(source_message_digest)=64
      AND source_message_digest NOT GLOB '*[^0-9a-f]*'
    )),
    proof_json TEXT,
    proof_digest TEXT CHECK (proof_digest IS NULL OR (
      typeof(proof_digest)='text' AND length(proof_digest)=64
      AND proof_digest NOT GLOB '*[^0-9a-f]*'
    )),
    expectation_json TEXT,
    expectation_digest TEXT CHECK (expectation_digest IS NULL OR (
      typeof(expectation_digest)='text' AND length(expectation_digest)=64
      AND expectation_digest NOT GLOB '*[^0-9a-f]*'
    )),
    relay_exec_id TEXT CHECK (relay_exec_id IS NULL OR relay_exec_id='unwind:'||job_id),
    mint_tx_hash TEXT CHECK (mint_tx_hash IS NULL OR (
      typeof(mint_tx_hash)='text' AND length(mint_tx_hash)=64
      AND mint_tx_hash NOT GLOB '*[^0-9a-f]*'
    )),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
      'attested_evidence_changed','destination_reverted','legacy_record_unrecoverable',
      'message_ambiguous','message_mismatch','submission_lease_expired',
      'submission_unknown','submitted_checkpoint_failed'
    )),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token TEXT,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at>=0),
    updated_at INTEGER NOT NULL CHECK (typeof(updated_at)='integer' AND updated_at>=created_at),
    CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)),
    CHECK (lease_token IS NULL OR (
      typeof(lease_token)='text' AND length(lease_token)>0
      AND typeof(lease_expires_at)='integer' AND lease_expires_at>=0
      AND state='awaiting_burn' AND proof_digest IS NULL
    )),
    CHECK ((candidate_user_op_hash IS NULL AND candidate_unwind_tx_hash IS NULL
      AND evidence_retry_until IS NULL)
      OR (candidate_user_op_hash IS NOT NULL AND candidate_unwind_tx_hash IS NOT NULL
      AND evidence_retry_until IS NOT NULL AND state<>'expired')),
    CHECK ((proof_digest IS NULL AND user_op_hash IS NULL AND unwind_tx_hash IS NULL
      AND chain_id IS NULL AND entry_point IS NULL AND sweeper_address IS NULL
      AND block_number IS NULL AND block_hash IS NULL
      AND user_operation_log_index IS NULL AND user_operation_log_digest IS NULL
      AND swept_log_index IS NULL AND swept_log_digest IS NULL
      AND deposit_log_index IS NULL AND deposit_log_digest IS NULL
      AND message_sent_log_index IS NULL AND message_sent_log_digest IS NULL
      AND burned IS NULL AND exited IS NULL AND skipped IS NULL AND max_fee IS NULL
      AND hook_data IS NULL AND source_message_hex IS NULL AND source_message_digest IS NULL
      AND proof_json IS NULL AND expectation_json IS NULL AND expectation_digest IS NULL
      AND relay_exec_id IS NULL AND mint_tx_hash IS NULL)
      OR
      (proof_digest IS NOT NULL AND user_op_hash IS NOT NULL AND unwind_tx_hash IS NOT NULL
      AND chain_id=84532 AND entry_point IS NOT NULL AND sweeper_address IS NOT NULL
      AND block_number IS NOT NULL AND block_hash IS NOT NULL
      AND user_operation_log_index IS NOT NULL AND user_operation_log_digest IS NOT NULL
      AND swept_log_index IS NOT NULL AND swept_log_digest IS NOT NULL
      AND deposit_log_index IS NOT NULL AND deposit_log_digest IS NOT NULL
      AND message_sent_log_index IS NOT NULL AND message_sent_log_digest IS NOT NULL
      AND burned IS NOT NULL AND exited IS NOT NULL AND skipped IS NOT NULL AND max_fee IS NOT NULL
      AND hook_data IS NOT NULL AND source_message_hex IS NOT NULL AND source_message_digest IS NOT NULL
      AND proof_json IS NOT NULL AND expectation_json IS NOT NULL AND expectation_digest IS NOT NULL
      AND relay_exec_id IS NOT NULL)),
    CHECK (proof_digest IS NULL OR (
      candidate_user_op_hash=user_op_hash AND candidate_unwind_tx_hash=unwind_tx_hash
    )),
    CHECK (state NOT IN ('relay_pending','relay_running','done') OR proof_digest IS NOT NULL),
    CHECK (state NOT IN ('awaiting_burn','expired') OR proof_digest IS NULL),
    CHECK (state<>'expired' OR candidate_user_op_hash IS NULL),
    CHECK ((state IN ('blocked','uncertain'))=(reason_code IS NOT NULL)),
    CHECK (state<>'done' OR mint_tx_hash IS NOT NULL)
  )`;

const UNWIND_INDEX_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unwind_user_op_hash ON unwind_jobs(user_op_hash);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unwind_relay_exec_id ON unwind_jobs(relay_exec_id);
  CREATE INDEX IF NOT EXISTS idx_unwind_tx_hash
    ON unwind_jobs(unwind_tx_hash);
  CREATE INDEX IF NOT EXISTS idx_unwind_recovery
    ON unwind_jobs(created_at,job_id,state,expires_at,evidence_retry_until,lease_expires_at);
  CREATE INDEX IF NOT EXISTS idx_unwind_expiry
    ON unwind_jobs(created_at,job_id)
    WHERE state='awaiting_burn' OR lease_token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_unwind_resume
    ON unwind_jobs(updated_at,created_at,job_id)
    WHERE state IN ('relay_pending','relay_running') AND proof_digest IS NOT NULL;
`;

const UNWIND_TRIGGER_SCHEMA = `
  CREATE TRIGGER unwind_jobs_reserve_immutable
  BEFORE UPDATE OF
    job_id,capability_hash,kernel_address,recipient_hint,request_digest,reserve_json,
    expires_at,capability_expires_at,created_at
  ON unwind_jobs
  BEGIN
    SELECT RAISE(ABORT,'immutable unwind reservation');
  END;
  CREATE TRIGGER unwind_jobs_candidate_immutable
  BEFORE UPDATE OF candidate_user_op_hash,candidate_unwind_tx_hash,evidence_retry_until
  ON unwind_jobs
  WHEN OLD.candidate_user_op_hash IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,'immutable unwind receipt candidate');
  END;
  CREATE TRIGGER unwind_jobs_proof_immutable
  BEFORE UPDATE OF
    user_op_hash,unwind_tx_hash,chain_id,entry_point,sweeper_address,block_number,
    block_hash,user_operation_log_index,user_operation_log_digest,swept_log_index,
    swept_log_digest,deposit_log_index,deposit_log_digest,message_sent_log_index,
    message_sent_log_digest,burned,exited,skipped,max_fee,hook_data,source_message_hex,
    source_message_digest,proof_json,proof_digest,expectation_json,expectation_digest,relay_exec_id
  ON unwind_jobs
  WHEN OLD.proof_digest IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,'immutable unwind proof');
  END;
  CREATE TRIGGER unwind_jobs_no_delete
  BEFORE DELETE ON unwind_jobs
  BEGIN
    SELECT RAISE(ABORT,'immutable unwind authority');
  END;
`;

export const UNWIND_SCHEMA = `${UNWIND_TABLE_SCHEMA};\n${UNWIND_INDEX_SCHEMA}\n${UNWIND_TRIGGER_SCHEMA}`;

export function unwindError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const validationError = () => unwindError('UNWIND_VALIDATION', 'unwind request is invalid');
const conflictError = () => unwindError('UNWIND_CONFLICT', 'unwind request conflicts with durable authority');

function canonicalJobId(value) {
  if (typeof value !== 'string' || !JOB_ID_RE.test(value)) throw validationError();
  return value;
}

function canonicalDigest(value) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw validationError();
  return value;
}

function canonicalAddress(value) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw validationError();
  const normalized = value.toLowerCase();
  if (normalized === ZERO_ADDRESS) throw validationError();
  return normalized;
}

function canonicalRecipient(value) {
  if (typeof value !== 'string'
      || (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value))) {
    throw validationError();
  }
  return value;
}

function requireTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw validationError();
  return value;
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)));
}

function canonicalHash(value) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw validationError();
  return value.toLowerCase();
}

function canonicalDecimal(value) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) throw validationError();
  return value;
}

function canonicalEvenHex(value) {
  if (typeof value !== 'string' || !EVEN_HEX_RE.test(value)) throw validationError();
  return value;
}

function canonicalProof(proof, expectation, authority) {
  if (!exactKeys(proof, PROOF_KEYS) || proof.version !== 1 || proof.chainId !== 84532) {
    throw validationError();
  }
  if (!exactKeys(proof.logIndices, LOG_NAMES) || !exactKeys(proof.logDigests, LOG_NAMES)) {
    throw validationError();
  }
  const logIndices = Object.fromEntries(LOG_NAMES.map((name) => {
    const value = proof.logIndices[name];
    if (!Number.isSafeInteger(value) || value < 0) throw validationError();
    return [name, value];
  }));
  const logDigests = Object.fromEntries(LOG_NAMES.map((name) => (
    [name, canonicalDigest(proof.logDigests[name])]
  )));
  const canonical = {
    version: 1,
    chainId: 84532,
    userOpHash: canonicalHash(proof.userOpHash),
    jobCommitment: canonicalHash(proof.jobCommitment),
    unwindTxHash: canonicalHash(proof.unwindTxHash),
    entryPointAddress: canonicalAddress(proof.entryPointAddress),
    kernelAddress: canonicalAddress(proof.kernelAddress),
    blockNumber: canonicalDecimal(proof.blockNumber),
    blockHash: canonicalHash(proof.blockHash),
    userOpNonce: canonicalDecimal(proof.userOpNonce),
    burned: canonicalDecimal(proof.burned),
    exited: canonicalDecimal(proof.exited),
    skipped: canonicalDecimal(proof.skipped),
    maxFee: canonicalDecimal(proof.maxFee),
    hookData: canonicalEvenHex(proof.hookData),
    sourceMessageHex: canonicalEvenHex(proof.sourceMessageHex),
    sourceMessageDigest: canonicalDigest(proof.sourceMessageDigest),
    logIndices,
    logDigests,
  };
  const expectedJobCommitment = keccak256(concatHex([
    UNWIND_JOB_DOMAIN, `0x${canonicalJobId(authority.jobId)}`,
  ]));
  if (canonical.kernelAddress !== authority.kernelAddress
      || canonical.jobCommitment !== expectedJobCommitment
      || canonical.burned === '0'
      || canonical.burned !== expectation.amount
      || canonical.maxFee !== expectation.maxFee
      || canonical.hookData !== expectation.hookData) {
    throw conflictError();
  }
  return Object.freeze(canonical);
}

function proofDigest(proof) {
  return createHash('sha256')
    .update(`${PROOF_DIGEST_DOMAIN}\0${JSON.stringify(proof)}`, 'utf8')
    .digest('hex');
}

function publicReserve(row) {
  const reserve = {
    jobId: row.job_id,
    status: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(reserve, 'expiresAt', {
    value: row.expires_at,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(reserve, 'capabilityExpiresAt', {
    value: row.capability_expires_at,
    enumerable: false,
    writable: false,
  });
  return reserve;
}

function publicStatus(row) {
  if (!row) return null;
  const projection = { jobId: row.job_id, status: row.state };
  if (row.unwind_tx_hash !== null
      && ['relay_pending', 'relay_running', 'done', 'blocked', 'uncertain'].includes(row.state)) {
    projection.unwindTxHash = row.unwind_tx_hash;
  }
  if (row.mint_tx_hash !== null && ['relay_running', 'done', 'uncertain'].includes(row.state)) {
    projection.mintTxHash = row.mint_tx_hash;
  }
  if (row.state === 'blocked' || row.state === 'uncertain') projection.reasonCode = row.reason_code;
  return projection;
}

function relayProjection(relay) {
  return {
    attestation_pending: { state: 'relay_pending', mintTxHash: null, reasonCode: null },
    attested: { state: 'relay_running', mintTxHash: null, reasonCode: null },
    mint_submitting: { state: 'relay_running', mintTxHash: null, reasonCode: null },
    mint_submitted: {
      state: 'relay_running', mintTxHash: relay.mintTxHash, reasonCode: null,
    },
    minted: { state: 'done', mintTxHash: relay.mintTxHash, reasonCode: null },
    blocked: { state: 'blocked', mintTxHash: relay.mintTxHash, reasonCode: relay.reasonCode },
    uncertain: { state: 'uncertain', mintTxHash: relay.mintTxHash, reasonCode: relay.reasonCode },
  }[relay.state] ?? null;
}

function normalizedSchemaSql(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/;\s*$/, '').replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1').toLowerCase();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function indexFacts(db, tableName) {
  return db.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all().map((row) => ({
    name: row.name,
    unique: row.unique,
    origin: row.origin,
    partial: row.partial,
    columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(row.name)})`).all()
      .map(({ name }) => name),
    sql: normalizedSchemaSql(db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    ).get(row.name)?.sql),
  }));
}

const EXPECTED_UNWIND_INDEXES = Object.freeze({
  idx_unwind_user_op_hash: Object.freeze({
    unique: 1, partial: 0, columns: Object.freeze(['user_op_hash']),
  }),
  idx_unwind_relay_exec_id: Object.freeze({
    unique: 1, partial: 0, columns: Object.freeze(['relay_exec_id']),
  }),
  idx_unwind_tx_hash: Object.freeze({
    unique: 0, partial: 0, columns: Object.freeze(['unwind_tx_hash']),
  }),
  idx_unwind_recovery: Object.freeze({
    unique: 0, partial: 0,
    columns: Object.freeze([
      'created_at', 'job_id', 'state', 'expires_at', 'evidence_retry_until', 'lease_expires_at',
    ]),
  }),
  idx_unwind_expiry: Object.freeze({
    unique: 0, partial: 1,
    columns: Object.freeze(['created_at', 'job_id']),
    where: "where state='awaiting_burn' or lease_token is not null",
  }),
  idx_unwind_resume: Object.freeze({
    unique: 0, partial: 1,
    columns: Object.freeze(['updated_at', 'created_at', 'job_id']),
    where: "where state in('relay_pending','relay_running')and proof_digest is not null",
  }),
});

function expectedTriggerSql() {
  return new Map(UNWIND_TRIGGER_SCHEMA.trim()
    .split(/;\s*(?=CREATE TRIGGER)/i)
    .map((statement) => {
      const sql = normalizedSchemaSql(statement);
      const name = /^create trigger ([a-z0-9_]+)/.exec(sql)?.[1];
      return [name, sql];
    }));
}

function validatedCctpRow(row) {
  if (!row) return null;
  let expectation;
  try {
    expectation = row.reason_code === 'legacy_record_unrecoverable'
      ? null : JSON.parse(row.expectation_json);
    return assertCanonicalRelayRecord({
      execId: row.exec_id,
      sourceDomain: row.source_domain,
      burnTxHash: row.burn_tx_hash,
      expectation,
      expectationDigest: row.expectation_digest,
      state: row.state,
      messageHex: row.message_hex,
      nonceHex: row.nonce_hex,
      messageDigest: row.message_digest,
      attestationHex: row.attestation_hex,
      attestationDigest: row.attestation_digest,
      evidenceVersion: row.evidence_version,
      mintTxHash: row.mint_tx_hash,
      reasonCode: row.reason_code,
      attempts: row.attempts,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch {
    throw new Error('unwind Task8 authority integrity failed');
  }
}

function validateUnwindRow(db, row, relayRow) {
  if (!row) return null;
    try {
      canonicalRecipient(row.recipient_hint);
    } catch {
      throw new Error('unwind recipient StrKey integrity failed');
    }
    const reserveJson = JSON.stringify({
      jobId: row.job_id,
      kernelAddress: row.kernel_address,
      recipientHint: row.recipient_hint,
    });
    const reserveDigest = createHash('sha256')
      .update(`${'vf-unwind-reserve-v1'}\0${reserveJson}`, 'utf8').digest('hex');
    if (row.reserve_json !== reserveJson || row.request_digest !== reserveDigest) {
      throw new Error('unwind reservation binding integrity failed');
    }
    if (row.proof_digest === null) return row;
    let expectation;
    let parsedProof;
    try {
      expectation = canonicalizeExpectation(JSON.parse(row.expectation_json));
      parsedProof = JSON.parse(row.proof_json);
    } catch {
      throw new Error('unwind proof encoding integrity failed');
    }
    const authority = { jobId: row.job_id, kernelAddress: row.kernel_address };
    let canonicalEvidence;
    try {
      canonicalEvidence = canonicalProof(parsedProof, expectation, authority);
    } catch {
      throw new Error('unwind proof binding integrity failed');
    }
    const expectedStored = {
      user_op_hash: canonicalEvidence.userOpHash,
      unwind_tx_hash: canonicalEvidence.unwindTxHash,
      chain_id: canonicalEvidence.chainId,
      entry_point: canonicalEvidence.entryPointAddress,
      sweeper_address: `0x${expectation.messageSender.slice(-40)}`,
      block_number: canonicalEvidence.blockNumber,
      block_hash: canonicalEvidence.blockHash,
      user_operation_log_index: canonicalEvidence.logIndices.userOperationEvent,
      user_operation_log_digest: canonicalEvidence.logDigests.userOperationEvent,
      swept_log_index: canonicalEvidence.logIndices.swept,
      swept_log_digest: canonicalEvidence.logDigests.swept,
      deposit_log_index: canonicalEvidence.logIndices.depositForBurn,
      deposit_log_digest: canonicalEvidence.logDigests.depositForBurn,
      message_sent_log_index: canonicalEvidence.logIndices.messageSent,
      message_sent_log_digest: canonicalEvidence.logDigests.messageSent,
      burned: canonicalEvidence.burned,
      exited: canonicalEvidence.exited,
      skipped: canonicalEvidence.skipped,
      max_fee: canonicalEvidence.maxFee,
      hook_data: canonicalEvidence.hookData,
      source_message_hex: canonicalEvidence.sourceMessageHex,
      source_message_digest: canonicalEvidence.sourceMessageDigest,
    };
    if (row.expectation_json !== JSON.stringify(expectation)
        || row.expectation_digest !== expectationDigest(expectation)
        || row.proof_json !== JSON.stringify(canonicalEvidence)
        || row.proof_digest !== proofDigest(canonicalEvidence)
        || Object.entries(expectedStored).some(([key, value]) => row[key] !== value)) {
      throw new Error('unwind proof persistence integrity failed');
    }
    const sourceDigest = createHash('sha256')
      .update(Buffer.from(canonicalEvidence.sourceMessageHex.slice(2), 'hex')).digest('hex');
    if (canonicalEvidence.sourceMessageDigest !== sourceDigest) {
      throw new Error('unwind source message digest integrity failed');
    }
    const relay = relayRow === undefined
      ? db.prepare('SELECT * FROM cctp_relay_work WHERE exec_id=?').get(row.relay_exec_id)
      : relayRow;
    validatedCctpRow(relay);
    if (!relay || relay.source_domain !== 6 || relay.burn_tx_hash !== row.unwind_tx_hash
        || relay.expectation_digest !== row.expectation_digest
        || relay.expectation_json !== row.expectation_json) {
      throw new Error('unwind Task8 authority integrity failed');
    }
    const projection = relayProjection({
      state: relay.state,
      mintTxHash: relay.mint_tx_hash,
      reasonCode: relay.reason_code,
    });
    if (!projection) throw new Error('unwind Task8 projection integrity failed');
    if (['done', 'blocked', 'uncertain'].includes(row.state)
        && (row.state !== projection.state
          || row.mint_tx_hash !== projection.mintTxHash
          || row.reason_code !== projection.reasonCode)) {
      throw new Error('unwind terminal Task8 projection integrity failed');
    }
    if (row.state === 'relay_running' && projection.state === 'relay_pending') {
      throw new Error('unwind Task8 projection regressed behind wrapper state');
    }
    return row;
}

export function classifyUnwindSchema(db) {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='unwind_jobs'",
  ).get();
  const expectedNames = new Set([
    'unwind_jobs', ...Object.keys(EXPECTED_UNWIND_INDEXES), ...expectedTriggerSql().keys(),
  ]);
  const targetReference = /(?:^|[^a-z0-9_])unwind_jobs(?:$|[^a-z0-9_])/i;
  const related = db.prepare(`
    SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
  `).all().filter(({ name, tbl_name: tableName, sql }) => (
    name === 'unwind_jobs' || tableName === 'unwind_jobs' || targetReference.test(String(sql))
  ));
  if (!table) {
    if (related.length !== 0) throw new Error('unwind schema has orphaned dependencies');
    const nameCollision = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE name IN (${[...expectedNames].map(() => '?').join(',')}) LIMIT 1
    `).get(...expectedNames);
    if (nameCollision) throw new Error('unwind schema names are incompatible');
    return { kind: 'absent' };
  }
  if (normalizedSchemaSql(table.sql) !== normalizedSchemaSql(UNWIND_TABLE_SCHEMA)) {
    throw new Error('unwind authority table definition is incompatible');
  }
  const columns = db.prepare('PRAGMA table_xinfo(unwind_jobs)').all().map(({ name }) => name);
  if (JSON.stringify(columns) !== JSON.stringify(UNWIND_COLUMNS)) {
    throw new Error('unwind authority columns are incompatible');
  }
  const unexpectedRelated = related.find(({ name }) => !expectedNames.has(name));
  if (unexpectedRelated) throw new Error('unwind schema has an unexpected dependency');

  const indexes = indexFacts(db, 'unwind_jobs');
  const primary = indexes.filter(({ origin }) => origin === 'pk');
  if (primary.length !== 1 || primary[0].unique !== 1 || primary[0].partial !== 0
      || JSON.stringify(primary[0].columns) !== JSON.stringify(['job_id'])) {
    throw new Error('unwind authority primary-key index is incompatible');
  }
  for (const index of indexes.filter(({ origin }) => origin !== 'pk')) {
    if (!Object.hasOwn(EXPECTED_UNWIND_INDEXES, index.name)) {
      throw new Error('unwind schema has an unexpected index');
    }
  }
  const missing = [];
  for (const [name, expected] of Object.entries(EXPECTED_UNWIND_INDEXES)) {
    const actual = indexes.find((index) => index.name === name);
    if (!actual) {
      missing.push(name);
      continue;
    }
    if (actual.unique !== expected.unique || actual.partial !== expected.partial
        || actual.origin !== 'c'
        || JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)
        || (expected.where
          ? !actual.sql?.endsWith(expected.where)
          : actual.sql?.includes(' where '))) {
      throw new Error(`unwind schema index ${name} is incompatible`);
    }
  }

  const expectedTriggers = expectedTriggerSql();
  const actualTriggers = db.prepare(`
    SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='unwind_jobs'
  `).all();
  if (actualTriggers.length !== expectedTriggers.size) {
    throw new Error('unwind schema trigger ensemble is incompatible');
  }
  for (const { name, sql } of actualTriggers) {
    if (normalizedSchemaSql(sql) !== expectedTriggers.get(name)) {
      throw new Error(`unwind schema trigger ${name} is incompatible`);
    }
  }
  return missing.length === 0 ? { kind: 'current' } : { kind: 'current-incomplete', missing };
}

export function prepareUnwindSchema(db) {
  const initial = classifyUnwindSchema(db);
  if (initial.kind === 'current') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = classifyUnwindSchema(db);
    if (locked.kind !== initial.kind) {
      throw new Error('unwind schema changed during initialization');
    }
    db.exec(locked.kind === 'current-incomplete' ? UNWIND_INDEX_SCHEMA : UNWIND_SCHEMA);
    if (classifyUnwindSchema(db).kind !== 'current') {
      throw new Error('unwind schema initialization failed');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createUnwindStore(db, {
  newToken = randomUUID,
  attachFault = () => {},
} = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof newToken !== 'function'
      || typeof attachFault !== 'function') {
    throw new Error('unwind store dependencies are invalid');
  }

  const rawSelect = () => db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?');
  const select = () => ({
    get(jobId) {
      return validateUnwindRow(db, rawSelect().get(jobId));
    },
  });

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function cctpRecord(row) {
    try {
      return validatedCctpRow(row);
    } catch {
      throw conflictError();
    }
  }

  function cctpBind(record) {
    return [
      record.execId, record.sourceDomain, record.burnTxHash,
      JSON.stringify(record.expectation), record.expectationDigest, record.state,
      record.messageHex, record.nonceHex, record.messageDigest, record.attestationHex,
      record.attestationDigest, record.evidenceVersion, record.mintTxHash,
      record.reasonCode, record.attempts, record.leaseToken, record.leaseExpiresAt,
      record.createdAt, record.updatedAt,
    ];
  }

  function authorityFromRow(row) {
    if (!row) return null;
    const authority = {
      jobId: row.job_id,
      kernelAddress: row.kernel_address,
      recipientHint: row.recipient_hint,
      expiresAt: row.expires_at,
      capabilityExpiresAt: row.capability_expires_at,
      state: row.state,
    };
    Object.defineProperty(authority, 'capabilityHash', {
      value: row.capability_hash,
      enumerable: false,
    });
    Object.defineProperties(authority, {
      userOpHash: { value: row.user_op_hash, enumerable: false },
      unwindTxHash: { value: row.unwind_tx_hash, enumerable: false },
      relayExecId: { value: row.relay_exec_id, enumerable: false },
      candidateUserOpHash: { value: row.candidate_user_op_hash, enumerable: false },
      candidateUnwindTxHash: { value: row.candidate_unwind_tx_hash, enumerable: false },
      evidenceRetryUntil: { value: row.evidence_retry_until, enumerable: false },
    });
    return Object.freeze(authority);
  }

  function leaseTokenValue() {
    const token = newToken();
    if (typeof token !== 'string' || token.length === 0) {
      throw unwindError('UNWIND_CAS_CONFLICT', 'unwind evidence lease is unavailable');
    }
    return token;
  }

  function finishTerminal({ jobId, leaseToken = null, reasonCode, now }, state, reasons) {
    const canonicalJob = canonicalJobId(jobId);
    const at = requireTime(now);
    if (typeof leaseToken !== 'string' && leaseToken !== null) throw validationError();
    if (!reasons.includes(reasonCode)) throw validationError();
    return transaction(() => {
      const existing = select().get(canonicalJob);
      if (!existing) throw unwindError('UNWIND_UNAUTHORIZED', 'unwind authority is unavailable');
      if (existing.state === state && existing.reason_code === reasonCode) {
        return publicStatus(existing);
      }
      if (existing.state !== 'awaiting_burn' || existing.proof_digest !== null) {
        throw conflictError();
      }
      const changed = db.prepare(`
        UPDATE unwind_jobs SET state=?,reason_code=?,lease_token=NULL,lease_expires_at=NULL,
          updated_at=?
        WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL
          AND ((lease_token IS NULL AND ? IS NULL AND expires_at>?)
            OR (lease_token=? AND lease_expires_at>?))
      `).run(
        state, reasonCode, at, canonicalJob,
        leaseToken, at, leaseToken, at,
      );
      if (changed.changes !== 1) {
        throw unwindError('UNWIND_CAS_CONFLICT', 'unwind evidence lease is stale');
      }
      return publicStatus(select().get(canonicalJob));
    });
  }

  return {
    reserve({
      jobId, capabilityHash, kernelAddress, recipientHint, requestDigest,
      expiresAt, capabilityExpiresAt, now,
    }) {
      const canonical = {
        jobId: canonicalJobId(jobId),
        capabilityHash: canonicalDigest(capabilityHash),
        kernelAddress: canonicalAddress(kernelAddress),
        recipientHint: canonicalRecipient(recipientHint),
        requestDigest: canonicalDigest(requestDigest),
        expiresAt: requireTime(expiresAt),
        capabilityExpiresAt: requireTime(capabilityExpiresAt),
        now: requireTime(now),
      };
      if (canonical.expiresAt <= canonical.now
          || canonical.capabilityExpiresAt <= canonical.expiresAt) throw validationError();
      const reserveJson = JSON.stringify({
        jobId: canonical.jobId,
        kernelAddress: canonical.kernelAddress,
        recipientHint: canonical.recipientHint,
      });
      const expectedRequestDigest = createHash('sha256')
        .update(`vf-unwind-reserve-v1\0${reserveJson}`, 'utf8').digest('hex');
      if (canonical.requestDigest !== expectedRequestDigest) throw validationError();
      return transaction(() => {
        const existing = select().get(canonical.jobId);
        if (existing) {
          if (existing.capability_hash !== canonical.capabilityHash) {
            throw unwindError('UNWIND_UNAUTHORIZED', 'unwind authority is unavailable');
          }
          if (existing.kernel_address !== canonical.kernelAddress
              || existing.recipient_hint !== canonical.recipientHint
              || existing.request_digest !== canonical.requestDigest
              || existing.reserve_json !== reserveJson) {
            throw conflictError();
          }
          if (existing.state !== 'awaiting_burn'
              || existing.proof_digest !== null
              || existing.expires_at <= canonical.now
              || existing.candidate_user_op_hash !== null
              || existing.lease_token !== null) {
            throw conflictError();
          }
          return publicReserve(existing);
        }
        db.prepare(`
          INSERT INTO unwind_jobs (
            job_id,capability_hash,kernel_address,recipient_hint,request_digest,reserve_json,
            expires_at,capability_expires_at,state,created_at,updated_at
          ) VALUES (?,?,?,?,?,? ,?,?,'awaiting_burn',?,?)
        `).run(
          canonical.jobId, canonical.capabilityHash, canonical.kernelAddress,
          canonical.recipientHint, canonical.requestDigest, reserveJson,
          canonical.expiresAt, canonical.capabilityExpiresAt, canonical.now, canonical.now,
        );
        return publicReserve(select().get(canonical.jobId));
      });
    },

    getAuthority(jobId) {
      const row = select().get(canonicalJobId(jobId));
      return authorityFromRow(row);
    },

    status(jobId) {
      return publicStatus(select().get(canonicalJobId(jobId)));
    },

    attachAndEnqueue({ jobId, proof, expectation, relayExecId, leaseToken = null, now }) {
      const canonicalJob = canonicalJobId(jobId);
      const at = requireTime(now);
      if (relayExecId !== `unwind:${canonicalJob}`) throw validationError();
      const canonicalExpectation = canonicalizeExpectation(expectation);
      if (canonicalExpectation.direction !== 'base-to-stellar'
          || canonicalExpectation.sourceDomain !== 6) throw validationError();
      const expectationHash = expectationDigest(canonicalExpectation);
      return transaction(() => {
        let row = select().get(canonicalJob);
        if (!row) throw unwindError('UNWIND_UNAUTHORIZED', 'unwind authority is unavailable');
        const authority = authorityFromRow(row);
        const canonicalEvidence = canonicalProof(proof, canonicalExpectation, authority);
        const canonicalProofJson = JSON.stringify(canonicalEvidence);
        const canonicalProofDigest = proofDigest(canonicalEvidence);
        if (row.proof_digest !== null) {
          if (row.user_op_hash !== canonicalEvidence.userOpHash
              || row.unwind_tx_hash !== canonicalEvidence.unwindTxHash
              || row.proof_digest !== canonicalProofDigest
              || row.expectation_digest !== expectationHash
              || row.relay_exec_id !== relayExecId) {
            throw conflictError();
          }
          return { duplicate: true, record: publicStatus(row) };
        }
        if (row.state !== 'awaiting_burn') throw conflictError();
        if (row.candidate_user_op_hash === null) {
          if (row.lease_token !== null || leaseToken !== null || row.expires_at <= at) {
            throw conflictError();
          }
          const retryUntil = Math.min(
            row.capability_expires_at,
            Math.max(row.expires_at + 1, at + 1),
          );
          const bound = db.prepare(`
            UPDATE unwind_jobs SET candidate_user_op_hash=?,candidate_unwind_tx_hash=?,
              evidence_retry_until=?,updated_at=?
            WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL
              AND candidate_user_op_hash IS NULL AND expires_at>?
          `).run(
            canonicalEvidence.userOpHash, canonicalEvidence.unwindTxHash,
            retryUntil, at, canonicalJob, at,
          );
          if (bound.changes !== 1) throw conflictError();
          row = select().get(canonicalJob);
        } else if (row.candidate_user_op_hash !== canonicalEvidence.userOpHash
            || row.candidate_unwind_tx_hash !== canonicalEvidence.unwindTxHash) {
          throw conflictError();
        }
        const usesLease = row.lease_token !== null || leaseToken !== null;
        if (usesLease) {
          if (typeof leaseToken !== 'string' || row.lease_token !== leaseToken
              || row.lease_expires_at <= at) {
            throw unwindError('UNWIND_CAS_CONFLICT', 'unwind evidence lease is stale');
          }
        } else if (row.expires_at <= at) {
          throw conflictError();
        }
        const userOpOwner = db.prepare(
          'SELECT 1 FROM unwind_jobs WHERE user_op_hash=? AND job_id<>? LIMIT 1',
        ).get(canonicalEvidence.userOpHash, canonicalJob);
        if (userOpOwner) throw conflictError();
        const existingRelay = cctpRecord(db.prepare(
          'SELECT * FROM cctp_relay_work WHERE exec_id=?',
        ).get(relayExecId));
        let decision;
        try {
          decision = relayEnqueueDecision({
            existing: existingRelay,
            hasIdentityConflict: (candidate) => db.prepare(`
              SELECT * FROM cctp_relay_work
              WHERE source_domain=? AND burn_tx_hash=? AND exec_id<>?
            `).all(candidate.sourceDomain, candidate.burnTxHash, relayExecId)
              .map(cctpRecord)
              .some((record) => relayIdentityConflicts(record, candidate)),
            execId: relayExecId,
            sourceDomain: 6,
            burnTxHash: canonicalEvidence.unwindTxHash,
            expectation: canonicalExpectation,
            now: at,
          });
        } catch (error) {
          if (error?.code === 'RELAY_ENQUEUE_CONFLICT') throw conflictError();
          throw error;
        }
        if (!decision.changed) throw conflictError();
        db.prepare(`
          INSERT INTO cctp_relay_work (
            exec_id,source_domain,burn_tx_hash,expectation_json,expectation_digest,state,
            message_hex,nonce_hex,message_digest,attestation_hex,attestation_digest,
            evidence_version,mint_tx_hash,reason_code,attempts,lease_token,lease_expires_at,
            created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(...cctpBind(decision.record));
        attachFault('relay_insert');
        const sweeperAddress = `0x${canonicalExpectation.messageSender.slice(-40)}`;
        const changed = db.prepare(`
          UPDATE unwind_jobs SET
            state='relay_pending',user_op_hash=?,unwind_tx_hash=?,chain_id=?,entry_point=?,
            sweeper_address=?,block_number=?,block_hash=?,user_operation_log_index=?,
            user_operation_log_digest=?,swept_log_index=?,swept_log_digest=?,
            deposit_log_index=?,deposit_log_digest=?,message_sent_log_index=?,
            message_sent_log_digest=?,burned=?,exited=?,skipped=?,max_fee=?,hook_data=?,
            source_message_hex=?,source_message_digest=?,proof_json=?,proof_digest=?,
            expectation_json=?,expectation_digest=?,relay_exec_id=?,lease_token=NULL,
            lease_expires_at=NULL,updated_at=?
          WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL
            AND candidate_user_op_hash=? AND candidate_unwind_tx_hash=?
        `).run(
          canonicalEvidence.userOpHash, canonicalEvidence.unwindTxHash, canonicalEvidence.chainId,
          canonicalEvidence.entryPointAddress, sweeperAddress, canonicalEvidence.blockNumber,
          canonicalEvidence.blockHash, canonicalEvidence.logIndices.userOperationEvent,
          canonicalEvidence.logDigests.userOperationEvent, canonicalEvidence.logIndices.swept,
          canonicalEvidence.logDigests.swept, canonicalEvidence.logIndices.depositForBurn,
          canonicalEvidence.logDigests.depositForBurn, canonicalEvidence.logIndices.messageSent,
          canonicalEvidence.logDigests.messageSent, canonicalEvidence.burned,
          canonicalEvidence.exited, canonicalEvidence.skipped, canonicalEvidence.maxFee,
          canonicalEvidence.hookData, canonicalEvidence.sourceMessageHex,
          canonicalEvidence.sourceMessageDigest, canonicalProofJson, canonicalProofDigest,
          JSON.stringify(canonicalExpectation), expectationHash, relayExecId, at, canonicalJob,
          canonicalEvidence.userOpHash, canonicalEvidence.unwindTxHash,
        );
        if (changed.changes !== 1) throw unwindError('UNWIND_CAS_CONFLICT', 'unwind attach lost its durable authority');
        attachFault('unwind_update');
        return { duplicate: false, record: publicStatus(select().get(canonicalJob)) };
      });
    },

    claimEvidence({ jobId, userOpHash, unwindTxHash, now, leaseMs, retryMs }) {
      const canonicalJob = canonicalJobId(jobId);
      const candidateUserOpHash = canonicalHash(userOpHash);
      const candidateUnwindTxHash = canonicalHash(unwindTxHash);
      const at = requireTime(now);
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0
          || !Number.isSafeInteger(retryMs) || retryMs <= 0) throw validationError();
      const token = leaseTokenValue();
      return transaction(() => {
        const existing = select().get(canonicalJob);
        if (!existing || existing.state !== 'awaiting_burn'
            || existing.proof_digest !== null || existing.lease_token !== null) return null;
        const bindsCandidate = existing.candidate_user_op_hash === null;
        if (!bindsCandidate
            && (existing.candidate_user_op_hash !== candidateUserOpHash
              || existing.candidate_unwind_tx_hash !== candidateUnwindTxHash)) {
          throw conflictError();
        }
        if (bindsCandidate && existing.expires_at <= at) return null;
        const retryUntil = bindsCandidate
          ? Math.min(
            existing.capability_expires_at,
            existing.expires_at + retryMs,
          )
          : existing.evidence_retry_until;
        if (!Number.isSafeInteger(retryUntil) || retryUntil <= at) return null;
        const leaseExpiresAt = Math.min(at + leaseMs, retryUntil);
        if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= at) return null;
        const changed = bindsCandidate
          ? db.prepare(`
            UPDATE unwind_jobs SET
              candidate_user_op_hash=?,candidate_unwind_tx_hash=?,evidence_retry_until=?,
              attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
            WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL
              AND candidate_user_op_hash IS NULL AND expires_at>? AND lease_token IS NULL
          `).run(
            candidateUserOpHash, candidateUnwindTxHash, retryUntil,
            token, leaseExpiresAt, at, canonicalJob, at,
          )
          : db.prepare(`
            UPDATE unwind_jobs SET attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
            WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL
              AND candidate_user_op_hash=? AND candidate_unwind_tx_hash=?
              AND evidence_retry_until>? AND lease_token IS NULL
          `).run(
            token, leaseExpiresAt, at, canonicalJob,
            candidateUserOpHash, candidateUnwindTxHash, at,
          );
        if (changed.changes !== 1) {
          throw unwindError('UNWIND_CAS_CONFLICT', 'unwind evidence claim lost its authority');
        }
        const row = select().get(canonicalJob);
        return {
          jobId: row.job_id,
          kernelAddress: row.kernel_address,
          recipientHint: row.recipient_hint,
          leaseToken: row.lease_token,
          leaseExpiresAt: row.lease_expires_at,
        };
      });
    },

    renewEvidence({ jobId, leaseToken, now, leaseMs }) {
      const canonicalJob = canonicalJobId(jobId);
      const at = requireTime(now);
      if (typeof leaseToken !== 'string' || !leaseToken
          || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw validationError();
      const row = db.prepare(`
        UPDATE unwind_jobs SET lease_expires_at=MIN(?,evidence_retry_until),updated_at=?
        WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL
          AND lease_token=? AND lease_expires_at>? AND evidence_retry_until>?
        RETURNING *
      `).get(at + leaseMs, at, canonicalJob, leaseToken, at, at);
      if (!row) throw unwindError('UNWIND_CAS_CONFLICT', 'unwind evidence lease is stale');
      return { jobId: row.job_id, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at };
    },

    releaseEvidence({ jobId, leaseToken, now }) {
      const canonicalJob = canonicalJobId(jobId);
      const at = requireTime(now);
      if (typeof leaseToken !== 'string' || !leaseToken) throw validationError();
      const changed = db.prepare(`
        UPDATE unwind_jobs SET lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE job_id=? AND state='awaiting_burn' AND proof_digest IS NULL AND lease_token=?
          AND lease_expires_at>?
      `).run(at, canonicalJob, leaseToken, at);
      if (changed.changes !== 1) throw unwindError('UNWIND_CAS_CONFLICT', 'unwind evidence lease is stale');
      return publicStatus(select().get(canonicalJob));
    },

    finishBlocked(input) {
      return finishTerminal(input, 'blocked', [
        'attested_evidence_changed', 'destination_reverted',
        'legacy_record_unrecoverable', 'message_ambiguous', 'message_mismatch',
      ]);
    },

    finishUncertain(input) {
      return finishTerminal(input, 'uncertain', [
        'submission_lease_expired', 'submission_unknown', 'submitted_checkpoint_failed',
      ]);
    },

    reconcileExpired({ now, limit }) {
      const at = requireTime(now);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw validationError();
      return transaction(() => {
        const rows = db.prepare(`
          SELECT job_id FROM unwind_jobs INDEXED BY idx_unwind_expiry
          WHERE (state='awaiting_burn' OR lease_token IS NOT NULL)
            AND ((state='awaiting_burn'
                    AND ((candidate_user_op_hash IS NULL AND expires_at<=?)
                      OR (candidate_user_op_hash IS NOT NULL AND evidence_retry_until<=?))
                    AND (lease_token IS NULL OR lease_expires_at<=?))
              OR (lease_token IS NOT NULL AND lease_expires_at<=?))
          ORDER BY created_at,job_id LIMIT ?
        `).all(at, at, at, at, limit);
        for (const { job_id: id } of rows) {
          db.prepare(`
            UPDATE unwind_jobs SET
              state=CASE
                WHEN state='awaiting_burn' AND candidate_user_op_hash IS NULL
                  AND expires_at<=? THEN 'expired'
                WHEN state='awaiting_burn' AND candidate_user_op_hash IS NOT NULL
                  AND evidence_retry_until<=? THEN 'uncertain'
                ELSE state END,
              reason_code=CASE
                WHEN state='awaiting_burn' AND candidate_user_op_hash IS NOT NULL
                  AND evidence_retry_until<=? THEN 'submission_unknown'
                ELSE reason_code END,
              lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE job_id=?
          `).run(at, at, at, at, id);
        }
        return rows.map(({ job_id: id }) => publicStatus(select().get(id)));
      });
    },

    listForResume({ now, limit }) {
      const at = requireTime(now);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw validationError();
      const rows = db.prepare(`
        SELECT u.* FROM unwind_jobs AS u INDEXED BY idx_unwind_resume
        JOIN cctp_relay_work AS c
          ON c.exec_id=u.relay_exec_id
         AND c.burn_tx_hash=u.unwind_tx_hash
         AND c.expectation_digest=u.expectation_digest
         AND c.expectation_json=u.expectation_json
        WHERE u.state IN ('relay_pending','relay_running')
          AND u.proof_digest IS NOT NULL
          AND c.source_domain=6
          AND (c.lease_token IS NULL OR c.lease_expires_at<=?)
        ORDER BY u.updated_at,u.created_at,u.job_id LIMIT ?
      `).all(at, limit);
      if (rows.length === 0) return [];
      const relayRows = db.prepare(`
        SELECT * FROM cctp_relay_work
        WHERE exec_id IN (${rows.map(() => '?').join(',')})
      `).all(...rows.map(({ relay_exec_id: execId }) => execId));
      const relays = new Map(relayRows.map((row) => [row.exec_id, row]));
      return rows.map((row) => {
        validateUnwindRow(db, row, relays.get(row.relay_exec_id));
        return {
          jobId: row.job_id,
          relayExecId: row.relay_exec_id,
          state: row.state,
        };
      });
    },

    reconcileFromCctp({ jobId, now }) {
      const canonicalJob = canonicalJobId(jobId);
      const at = requireTime(now);
      return transaction(() => {
        let row;
        try {
          row = select().get(canonicalJob);
        } catch {
          throw conflictError();
        }
        if (!row) return null;
        if (row.state === 'awaiting_burn'
            && ((row.candidate_user_op_hash === null && row.expires_at <= at)
              || (row.candidate_user_op_hash !== null && row.evidence_retry_until <= at))
            && (row.lease_token === null || row.lease_expires_at <= at)) {
          db.prepare(`
            UPDATE unwind_jobs SET
              state=CASE WHEN candidate_user_op_hash IS NULL THEN 'expired' ELSE 'uncertain' END,
              reason_code=CASE WHEN candidate_user_op_hash IS NULL
                THEN NULL ELSE 'submission_unknown' END,
              lease_token=NULL,lease_expires_at=NULL,
              updated_at=?
            WHERE job_id=? AND state='awaiting_burn'
              AND ((candidate_user_op_hash IS NULL AND expires_at<=?)
                OR (candidate_user_op_hash IS NOT NULL AND evidence_retry_until<=?))
              AND (lease_token IS NULL OR lease_expires_at<=?)
          `).run(at, canonicalJob, at, at, at);
          row = select().get(canonicalJob);
        }
        if (row.state === 'expired' || (!row.relay_exec_id
            && ['blocked', 'uncertain'].includes(row.state))) return publicStatus(row);
        if (!row.relay_exec_id) return publicStatus(row);
        const relay = cctpRecord(db.prepare(
          'SELECT * FROM cctp_relay_work WHERE exec_id=?',
        ).get(row.relay_exec_id));
        if (!relay || relay.burnTxHash !== row.unwind_tx_hash
            || relay.expectationDigest !== row.expectation_digest) throw conflictError();
        const projection = relayProjection(relay);
        if (!projection) throw conflictError();
        if (['done', 'blocked', 'uncertain'].includes(row.state)) {
          if (row.state !== projection.state
              || row.mint_tx_hash !== projection.mintTxHash
              || row.reason_code !== projection.reasonCode) throw conflictError();
          return publicStatus(row);
        }
        const rank = { relay_pending: 0, relay_running: 1 };
        if (rank[row.state] > rank[projection.state]) throw conflictError();
        // Even an unchanged projection completed one bounded recovery attempt. Advancing the
        // wrapper age rotates transient heads behind later work without scanning terminal
        // lifetime history or requiring an in-memory cursor.
        db.prepare(`
          UPDATE unwind_jobs SET state=?,mint_tx_hash=?,reason_code=?,updated_at=?
          WHERE job_id=? AND state IN ('relay_pending','relay_running')
        `).run(projection.state, projection.mintTxHash, projection.reasonCode,
          Math.max(at, row.updated_at), canonicalJob);
        return publicStatus(select().get(canonicalJob));
      });
    },

    states: UNWIND_STATES,
  };
}
