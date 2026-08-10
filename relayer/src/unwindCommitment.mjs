import { concatHex, keccak256 } from 'viem';

const UNWIND_JOB_DOMAIN = '0x76662d756e77696e642d6a6f622d7631';
const JOB_ID_RE = /^[0-9a-f]{32}$/;

export function unwindJobCommitment(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new TypeError('unwind jobId must be exactly 32 lowercase hex characters');
  }
  return keccak256(concatHex([UNWIND_JOB_DOMAIN, `0x${jobId}`]));
}
