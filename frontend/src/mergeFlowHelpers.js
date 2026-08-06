// frontend/src/mergeFlowHelpers.js
// The two small decision points that wire the merged Stellar+Base flow into app.jsx: what the
// strategy step tells the strategist about Base availability, and what the dispatch step tells
// the orchestrator about the connected wallet's Base leg signer. Extracted so both are unit-
// testable without rendering the 126KB app.jsx.
import { isVfWallet, ensureBaseOwner as defaultEnsureBaseOwner } from './wallet/passkeyBridge.js'
import { createMandate as defaultCreateMandate } from './wallet/mandate.js'
import {
  postMandate as defaultPostMandate,
  waitForMandateActivation as defaultWaitForMandateActivation,
} from './base/relayerClient.js'
import { BASE_POOL_CATALOG } from './config.js'
import {
  baseOwnerStorageKey,
  baseMandateStorageKey,
  readBaseOwner,
  readBaseMandate,
  validateBaseMandate,
} from './wallet/baseBinding.js'
import { toBaseMandateView } from './strategy/baseMandateView.js'
import {
  isVerifiedBaseMandateStatus,
  materialBaseMandateStatusChange,
  publicBaseMandateEvidence,
} from './base/mandateStatus.js'

export function baseMandateRequiresReview(previous, next) {
  return (
    !isVerifiedBaseMandateStatus(previous) ||
    !isVerifiedBaseMandateStatus(next) ||
    materialBaseMandateStatusChange(previous, next)
  )
}

// One place every module reads the durable Base mandate record from — baseLeg.js (spends it)
// and orchestrator.js (needs kernelAddress to pin the bridge agent's mint_recipient at grant
// time) both read the owner-scoped v3 record via wallet/baseBinding.js's readBaseMandate. There
// is deliberately NO global `vf_base_mandate` reader left: that key carried a serialized
// approval, and readBaseMandate removes it (and the v2 owner record) on encounter.
// Window a fresh mandate stays reusable for (design spec §5: "selaras grant expiry, default 7
// hari") — matches the window Task 6's run-time ceremony used to request before the rework moved
// ceremony out of the run path.
const MANDATE_WINDOW_SECONDS = 7 * 24 * 3600
// ponytail: a setup-time mandate doesn't know any future run's allocation yet, so every catalog
// pool gets the same flat ceiling (used only to derive the CallPolicy's single aggregate per-call
// cap — see policyEngine.js's module note; the pool allowlist itself is enforced on-chain by
// YieldRouter, not this policy). Signed off 2026-07-22 for TESTNET: 10,000 keeps demos clear of
// the ceiling. Before MAINNET cutover, lower to ~2,500 (≈2x the largest planned run + a repeat;
// research note: no AA vendor documents a sizing formula — Safe/Coinbase precedent is bounded
// per-period caps, and incident data (LI.FI 2024) shows bounded approvals contain the damage).
const MANDATE_SETUP_CAP_UNITS = 10_000_000_000n // 10,000 USDC at 6dp

// Legacy mandate storage shapes that carried a serialized approval. setupBaseMandate removes
// them instead of dual-writing (readBaseMandate does the same on the read path).
const LEGACY_MANDATE_GLOBAL_KEY = 'vf_base_mandate'
const LEGACY_MANDATE_V2_PREFIX = 'vf_base_mandate_v2:'

// 128-bit mandate ID / 256-bit capability from Web Crypto, lowercase canonical hex — the exact
// identity/capability pair the relayer's v3 registration contract requires. `cryptoImpl` is
// injectable so tests can pin deterministic authority without mocking call counts.
function randomHex(byteLength, cryptoImpl) {
  const bytes = new Uint8Array(byteLength)
  cryptoImpl.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `checkMandate` factory for resolveBaseAvailability. INVERTED from the first draft per the design
 * spec: mandate setup is its own per-window ceremony, never something a run performs — so "nothing
 * stored yet" is exactly as gating as a stored-and-invalid one. true only for a stored v3 mandate,
 * BOUND to the current stellarOwner, the relayer also confirms is still active — via ONE
 * amount-free status read naming only the public mandate identity.
 * @param {{getMandateStatus: Function, storage?: object, stellarOwner: string}} p
 * @returns {() => Promise<boolean>}
 */
export function checkStoredBaseMandate({ getMandateStatus, storage, stellarOwner }) {
  return async () => {
    const record = readBaseMandate(stellarOwner, storage)
    if (validateBaseMandate(record, { stellarOwner }) !== 'active') return false
    try {
      const status = await getMandateStatus(record.mandateId, {
        stellarOwner,
        kernelAddress: record.kernelAddress,
      })
      return isVerifiedBaseMandateStatus(status)
    } catch {
      return false
    }
  }
}

/**
 * The "Setup / per window mandate: 1 tap" ceremony (design spec §4/§5), v3 capability transport:
 * a Base owner login (VF reuse | passkey ceremony) + ONE passkey-signed session-key policy, then
 * ONE registration call carrying the freshly generated capability — the capability and the
 * session private key cross the wire exactly once and are dropped from JavaScript state
 * immediately. The relayer activates the mandate asynchronously, so this then polls
 * (`waitForMandateActivation`) until the relayer returns remotely VERIFIED active evidence; only
 * that evidence is persisted. Storage is secret-free throughout: a non-secret
 * `pending_activation` record before polling, an owner-scoped `vf_base_mandate_v3:<owner>`
 * record with only the public evidence allowlist after. Legacy global/v2/approval-bearing
 * records are deleted, never adopted or dual-written. Errors thrown here are fixed public
 * messages — a poisoned dependency error that handled raw secrets is never copied.
 * This is the ONLY writer of the v3 mandate record: baseLeg.js's run path never calls it (a run
 * only ever re-validates + spends an already-stored mandate — see baseLeg.js's module doc).
 * app.jsx calls this from a 1-tap affordance shown when the relayer is healthy but no valid
 * mandate is stored; never called automatically by a run.
 * @param {{connectedAddress:string, deps?:{ensureBaseOwner?:Function, createMandate?:Function,
 *          postMandate?:Function, waitForMandateActivation?:Function, cryptoImpl?:object,
 *          storage?:object}}} p
 * @returns {Promise<object>} the verified active v3 record (public evidence only)
 */
export async function setupBaseMandate({ connectedAddress, deps = {} }) {
  const {
    ensureBaseOwner = defaultEnsureBaseOwner,
    createMandate = defaultCreateMandate,
    postMandate = defaultPostMandate,
    waitForMandateActivation = defaultWaitForMandateActivation,
    cryptoImpl = globalThis.crypto,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = deps
  const owner = await ensureBaseOwner({ connectedAddress })
  const expiry = Math.floor(Date.now() / 1000) + MANDATE_WINDOW_SECONDS
  const mandate = await createMandate({
    kernelAccount: owner.kernelAccount,
    publicClient: owner.publicClient,
    passkeyValidator: owner.passkeyValidator,
    pools: BASE_POOL_CATALOG.map((p) => ({ pool: p.address, cap: MANDATE_SETUP_CAP_UNITS })),
    expiry,
  })
  const mandateId = randomHex(16, cryptoImpl)
  const capability = randomHex(32, cryptoImpl)
  let posted
  try {
    posted = await postMandate({
      mandateId,
      capability, // crosses the wire exactly once, here, then dropped
      serializedApproval: mandate.serializedApproval,
      sessionPrivateKey: mandate.sessionPrivateKey, // likewise: registration only, never stored
      sessionKeyAddress: mandate.sessionKeyAddress,
      expiresAt: mandate.expiry,
      stellarOwner: connectedAddress,
      kernelAddress: owner.address,
    })
  } catch {
    throw new Error('Base mandate setup failed during registration')
  }
  if (storage) {
    // Delete every legacy/approval-bearing shape instead of adopting or dual-writing it.
    storage.removeItem(LEGACY_MANDATE_GLOBAL_KEY)
    storage.removeItem(`${LEGACY_MANDATE_V2_PREFIX}${connectedAddress.trim()}`)
    // NON-secret pending metadata only (exact public allowlist; empty evidence containers until
    // the relayer's activation is remotely verified). Written BEFORE the first poll so a crash
    // mid-activation never leaves a fake-active record behind.
    storage.setItem(
      baseMandateStorageKey(connectedAddress),
      JSON.stringify({
        version: 3,
        mandateId,
        stellarOwner: connectedAddress,
        kernelAddress: owner.address,
        sessionKeyAddress: mandate.sessionKeyAddress,
        relayerOrigin: posted?.relayerOrigin ?? null,
        validUntilSeconds: mandate.expiry,
        status: 'pending_activation',
        bindingId: posted?.bindingId ?? null,
        bindingHash: posted?.bindingHash ?? null,
        reasonCodes: [],
        expected: {},
        observed: {},
        checks: {},
      })
    )
  }
  let evidence
  try {
    evidence = await waitForMandateActivation({
      mandateId,
      stellarOwner: connectedAddress,
      kernelAddress: owner.address,
    })
  } catch {
    throw new Error('Base mandate setup failed during activation')
  }
  if (!isVerifiedBaseMandateStatus(evidence)) {
    throw new Error('Base mandate activation did not return verified active evidence')
  }
  const record = publicBaseMandateEvidence(evidence)
  if (storage) {
    storage.setItem(baseMandateStorageKey(connectedAddress), JSON.stringify(record))
  }
  return record
}

// One place that decides what the strategy step tells the strategist about Base. Returns the
// combined-check PROMISE (not its resolved value) so the ~3s relayer probe (and the optional
// mandate/funding reads alongside it) overlap the caller's own concurrent work (the strategy DAG
// fetch) instead of serializing before it — the caller awaits `baseAvailable` only once it
// actually needs the boolean (generateStrategy does this after its own DAG fetch, so the waits
// run in parallel).
//
// Fail-closed preflight: relayer health AND (no gate to fail if `checkMandate`/`checkFunding` are
// omitted — callers that only care about relayer reachability, e.g. existing tests, are
// unaffected) AND a STORED, valid Base mandate AND Circle USDC funding. ANY check returning
// falsy, or throwing, resolves `baseAvailable` to false — Base pools are simply absent from the
// catalog, never a visible error (per the product's fail-closed contract for this leg).
// Design (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md §4-5): mandate setup is
// its OWN per-window ceremony (a chip + 1-tap renew, not part of a run) — a run NEVER creates a
// mandate on demand, so "nothing stored yet" gates Base off exactly like an invalid one.
//
// Strategy Task 13 (Pocket Crew redesign, decision log #22, obligation D): the legacy
// `{checkHealth, checkMandate, checkFunding}` overload (and its dispatch branch here) is DELETED
// -- app.jsx's Base preflight now calls the `{mandate, connection, health}` contract below
// directly (see app.jsx's `resolveBaseForPlan`). The regression tests that locked the legacy shape
// alive (app.strategy.merge.test.jsx) are deleted in the same commit as this migration, never
// before it -- see that file's own history for the removed `describe` blocks.
export function resolveBaseAvailability(input) {
  const { mandate, connection = {}, health } = input
  const connected = connection.connected === true
  const boundMandateView = toBaseMandateView({ mandate, ...connection })
  // A matching local record is not evidence that this browser is currently connected. Preserve
  // the raw mandate for the supplied adapter, but keep the canonical availability view closed.
  const mandateView = connected
    ? boundMandateView
    : { ...boundMandateView, status: 'unavailable', ready: false }
  const baseAvailable = (async () => {
    try {
      const healthy = await (typeof health === 'function' ? health() : health)
      return connected && healthy === true && mandateView.ready
    } catch {
      return false
    }
  })()
  const action =
    connection.setupSucceeded === true
      ? { label: 'Rebuild plan', invalidatesPlan: true }
      : !connected
        ? { label: 'Connect to check Base testnet', invalidatesPlan: false }
        : null
  return { baseAvailable, mandateView, action }
}

// Drives app.jsx's "Activate Base (1 tap)" affordance: worth showing only when the 1-tap ceremony
// would actually fix the gate — a relayer outage or missing Circle USDC funding are not fixed by
// setupBaseMandate, so the button stays hidden for those (no dead-end tap).
export function needsBaseMandateSetup({ healthy, mandateOk }) {
  return !!healthy && !mandateOk
}

/**
 * `checkFunding` factory for resolveBaseAvailability: does the connected wallet actually hold any
 * of the burn token (Circle USDC's SAC)? A SAC balance() read is 0 for BOTH "no trustline yet" and
 * "trustline but empty" — one read covers what would otherwise be two separate checks.
 * @param {{address:string|null, readTokenBalance:Function, token:string}} p
 * @returns {() => Promise<boolean>}
 */
export function checkCircleUsdcFunding({ address, readTokenBalance, token }) {
  return async () => {
    if (!address) return false
    const bal = await readTokenBalance(address, { token })
    return bal != null && bal > 0n
  }
}

// One place that builds the orchestrator's base leg context from the connected wallet.
export function buildBaseLegContext({ connectedAddress, kitSignTransaction }) {
  if (!connectedAddress) return null
  return {
    connectedAddress,
    signTx: kitSignTransaction, // (xdr) => Promise<signedXdr> via StellarWalletsKit
    isVf: isVfWallet(connectedAddress),
  }
}

const short = (v) => (v && v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v || '')

// The farm dispatch's own pollFarmStatus gives up after ~2 minutes, but a CCTP leg can take
// far longer (standard finality ~15-25 min on testnet). Without a follow-up the run's Base
// nodes and log line freeze on "still settling" forever, even once the deposits have landed —
// the deposit-side twin of the withdraw modal's re-poll (55578ca). Keeps asking slowly until
// the job reports a terminal status or the budget runs out; never throws.
export async function pollBaseLegUntilSettled({
  jobId,
  pollOnce,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  intervalMs = 15_000,
  maxTries = 120, // ~30 min at the default interval
}) {
  if (!jobId || typeof pollOnce !== 'function') return null
  for (let i = 0; i < maxTries; i++) {
    await sleep(intervalMs)
    let last
    try {
      last = await pollOnce(jobId)
    } catch {
      continue // transient failure: keep waiting, next tick retries
    }
    if (last?.status === 'done' || last?.status === 'error') return last.status
  }
  return null
}

// Leg-level Base events (no per-agent hex id) → ONE display recipe the graph applies to every
// Base vault node. Step chips reuse the worker vocabulary: approve = mandate, swap = the CCTP
// burn/bridge, deposit = the relayer's pool deposits. Returns null for events that need no
// node update; `log` names the activity-feed event to emit alongside.
export function mapBaseLegEvent(evName, data = {}) {
  switch (evName) {
    case 'baseleg-owner':
      return data.status === 'done'
        ? {
            status: 'running',
            memory: {
              status: 'confirmed',
              title: 'Base smart account ready',
              meta: data.address ? `Owner ${short(data.address)}` : 'Passkey owner ready',
            },
          }
        : {
            status: 'running',
            memory: {
              status: 'running',
              title: 'Base owner passkey',
              meta: 'Register/login ceremony…',
            },
          }
    case 'baseleg-mandate':
      return {
        step: 'approve',
        stepStatus: 'confirmed',
        memory: {
          status: 'confirmed',
          title: 'Mandate signed',
          meta: `Session key ${short(data.sessionKeyAddress)} (1h TTL)`,
        },
        log: 'ApproveExecuted',
      }
    case 'farm-burn-started':
      return {
        step: 'swap',
        stepStatus: 'running',
        memory: { status: 'running', title: 'CCTP burn', meta: 'Signing the burn on Stellar…' },
      }
    case 'farm-burn-confirmed':
      return {
        step: 'swap',
        stepStatus: 'confirmed',
        hash: data.burnHash,
        memory: {
          status: 'confirmed',
          title: 'Burn confirmed',
          meta: `Tx ${short(data.burnHash)}`,
          hash: data.burnHash,
        },
        log: 'SwapExecuted',
      }
    case 'farm-relay-dispatched':
      return {
        step: 'deposit',
        stepStatus: 'running',
        memory: {
          status: 'running',
          title: 'Relayer dispatched',
          meta: `Job ${data.jobId}: attest to mint to deposit`,
        },
      }
    case 'farm-completed':
      if (data.finalStatus === 'done') {
        return {
          step: 'deposit',
          stepStatus: 'confirmed',
          status: 'completed',
          memory: {
            status: 'confirmed',
            title: 'Deposited on Base',
            meta: `Job ${data.jobId} settled`,
          },
          log: 'DepositExecuted',
        }
      }
      if (data.finalStatus === 'error') {
        return {
          status: 'failed',
          memory: {
            status: 'failed',
            title: 'Relay error on Base',
            meta: `Job ${data.jobId} — burn succeeded, funds recoverable on Base`,
          },
          log: 'AgentFailed',
        }
      }
      return {
        memory: {
          status: 'running',
          title: 'Still settling',
          meta: `Job ${data.jobId} pending on the relayer`,
        },
      }
    case 'farm-failed':
    case 'baseleg-failed':
      return {
        status: 'failed',
        memory: {
          status: 'failed',
          title: 'Cross-chain leg failed',
          meta: `${data.stage}: ${data.error}`,
        },
        log: 'AgentFailed',
      }
    default:
      return null
  }
}

// One place that turns the settled Base leg summary into the dashboard's owner-record backup
// write plus an HONEST log line. finalStatus is pollFarmStatus's last word: 'done' = deposits
// landed, 'error' = relay failed AFTER the burn (funds are minted/recoverable on Base — never
// imply they're gone), anything else = polling gave up while the job was still settling. The old
// message claimed "deposited" for every success:true leg, which lied whenever polling timed out.
//
// VF Wallet Task 6 re-review fix: the legacy vf_base_owner/vf_base_owner_address write below is
// dual-write only now — every real reader (dashboardPositions.js, skills.jsx, HistoryPanel.jsx,
// app.jsx's withdraw guard) gates on the owner-scoped v2 record instead. Passing `stellarOwner`
// ALSO restores/refreshes that v2 record here, so a wiped/corrupt v2 record at settle time can't
// leave a fully-deposited position invisible on the dashboard — the exact 2026-07-19 incident
// this function exists to prevent, just one storage layer down from where it was proven live.
export function applyBaseLegOutcome(baseLeg, { storage, stellarOwner } = {}) {
  if (!baseLeg) return null
  if (!baseLeg.success) {
    return {
      event: 'AgentFailed',
      meta: `Cross-chain leg failed at ${baseLeg.stage}: ${baseLeg.error}`,
    }
  }
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (store && baseLeg.baseAccount) {
    // Marker without passkeyName is fine: passkeyBridge falls back to its deterministic name.
    if (!store.getItem('vf_base_owner')) {
      store.setItem('vf_base_owner', JSON.stringify({ mode: 'ceremony' }))
    }
    store.setItem('vf_base_owner_address', baseLeg.baseAccount)
    if (stellarOwner) {
      const existing = readBaseOwner(stellarOwner, store)
      const now = Date.now()
      store.setItem(
        baseOwnerStorageKey(stellarOwner),
        JSON.stringify({
          version: 2,
          stellarOwner,
          kernelAddress: baseLeg.baseAccount,
          passkeyName: existing?.passkeyName ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
      )
    }
  }
  if (baseLeg.finalStatus === 'done') {
    return {
      event: 'OrchestratorPlanned',
      meta: `Cross-chain leg deposited on Base (job ${baseLeg.jobId}).`,
    }
  }
  if (baseLeg.finalStatus === 'error') {
    return {
      event: 'AgentFailed',
      meta: `Cross-chain relay reported an error (job ${baseLeg.jobId}) — the burn succeeded, funds are recoverable on Base; check the dashboard before retrying.`,
    }
  }
  return {
    event: 'OrchestratorPlanned',
    meta: `Cross-chain leg submitted (job ${baseLeg.jobId}) — still settling on Base; positions appear on the dashboard once done.`,
  }
}
