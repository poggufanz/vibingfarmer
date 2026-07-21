// frontend/src/mergeFlowHelpers.js
// The two small decision points that wire the merged Stellar+Base flow into app.jsx: what the
// strategy step tells the strategist about Base availability, and what the dispatch step tells
// the orchestrator about the connected wallet's Base leg signer. Extracted so both are unit-
// testable without rendering the 126KB app.jsx.
import { isVfWallet, ensureBaseOwner as defaultEnsureBaseOwner } from './wallet/passkeyBridge.js'
import { createMandate as defaultCreateMandate } from './wallet/mandate.js'
import { postMandate as defaultPostMandate } from './base/relayerClient.js'
import { BASE_POOL_CATALOG } from './config.js'

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
export function resolveBaseAvailability({ checkHealth, checkMandate, checkFunding }) {
  const baseAvailable = (async () => {
    try {
      if (!(await checkHealth())) return false
      if (checkMandate && !(await checkMandate())) return false
      if (checkFunding && !(await checkFunding())) return false
      return true
    } catch {
      return false
    }
  })()
  return { baseAvailable }
}

// Drives app.jsx's "Activate Base (1 tap)" affordance: worth showing only when the 1-tap ceremony
// would actually fix the gate — a relayer outage or missing Circle USDC funding are not fixed by
// setupBaseMandate, so the button stays hidden for those (no dead-end tap).
export function needsBaseMandateSetup({ healthy, mandateOk }) {
  return !!healthy && !mandateOk
}

// The one place every module reads the durable Base mandate record from — baseLeg.js (spends it)
// and orchestrator.js (needs kernelAddress to pin the bridge agent's mint_recipient at grant time)
// both import this instead of each keeping a private copy. Self-heals a missing/corrupt record to
// null rather than throwing (same posture as the rest of this module's localStorage reads).
const MANDATE_STORAGE_KEY = 'vf_base_mandate'
// Window a fresh mandate stays reusable for (design spec §5: "selaras grant expiry, default 7
// hari") — matches the window Task 6's run-time ceremony used to request before the rework moved
// ceremony out of the run path.
const MANDATE_WINDOW_SECONDS = 7 * 24 * 3600
// ponytail: a setup-time mandate doesn't know any future run's allocation yet, so every catalog
// pool gets the same flat ceiling (used only to derive the CallPolicy's single aggregate per-call
// cap — see policyEngine.js's module note; the pool allowlist itself is enforced on-chain by
// YieldRouter, not this policy). Bump this — or make it configurable — if a real run's Base
// allocation would ever exceed it.
const MANDATE_SETUP_CAP_UNITS = 10_000_000_000n // 10,000 USDC at 6dp

/**
 * @param {object} [storage] injectable storage (tests); defaults to the global localStorage, and
 *   to null (not a throw) when no global localStorage exists (e.g. a plain Node test env).
 * @returns {{serializedApproval:string, sessionKeyAddress:string, kernelAddress:string, expiry:number}|null}
 */
export function readStoredBaseMandate(storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!store) return null
  try {
    return JSON.parse(store.getItem(MANDATE_STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

/**
 * `checkMandate` factory for resolveBaseAvailability. INVERTED from the first draft per the design
 * spec: mandate setup is its own per-window ceremony, never something a run performs — so "nothing
 * stored yet" is exactly as gating as a stored-and-invalid one. true only for a stored mandate the
 * relayer confirms is still valid.
 * @param {{getMandateStatus: (approval:string) => Promise<{valid:boolean}>, storage?: object}} p
 * @returns {() => Promise<boolean>}
 */
export function checkStoredBaseMandate({ getMandateStatus, storage } = {}) {
  return async () => {
    const stored = readStoredBaseMandate(storage)
    if (!stored) return false
    const status = await getMandateStatus(stored.serializedApproval)
    return !!status?.valid
  }
}

/**
 * The "Setup / per window mandate: 1 tap" ceremony (design spec §4/§5) — a Base owner login (VF
 * reuse | passkey ceremony) + ONE passkey-signed session-key policy, reused by every run until it
 * expires. This is the ONLY writer of vf_base_mandate: baseLeg.js's run path never calls it (a run
 * only ever re-validates + spends an already-stored mandate — see baseLeg.js's module doc).
 * app.jsx calls this from a 1-tap affordance shown when the relayer is healthy but no valid
 * mandate is stored; never called automatically by a run.
 * @param {{connectedAddress:string, deps?:{ensureBaseOwner?:Function, createMandate?:Function,
 *          postMandate?:Function, storage?:object}}} p
 * @returns {Promise<{kernelAddress:string, expiry:number}>}
 */
export async function setupBaseMandate({ connectedAddress, deps = {} }) {
  const {
    ensureBaseOwner = defaultEnsureBaseOwner,
    createMandate = defaultCreateMandate,
    postMandate = defaultPostMandate,
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
  await postMandate({
    serializedApproval: mandate.serializedApproval,
    sessionPrivateKey: mandate.sessionPrivateKey, // crosses the wire exactly once, then dropped
    expiry: mandate.expiry,
  })
  // NON-secret metadata only (binding constraint: NEVER the private key) — same write shape the
  // run path's old (now-removed) ceremony branch used.
  if (storage) {
    storage.setItem(
      MANDATE_STORAGE_KEY,
      JSON.stringify({
        serializedApproval: mandate.serializedApproval,
        sessionKeyAddress: mandate.sessionKeyAddress,
        kernelAddress: owner.address,
        expiry: mandate.expiry,
      })
    )
  }
  return { kernelAddress: owner.address, expiry: mandate.expiry }
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
          meta: `Job ${data.jobId}: attest → mint → deposit`,
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

// One place that turns the settled Base leg summary into the dashboard's owner-address write
// plus an HONEST log line. finalStatus is pollFarmStatus's last word: 'done' = deposits landed,
// 'error' = relay failed AFTER the burn (funds are minted/recoverable on Base — never imply
// they're gone), anything else = polling gave up while the job was still settling. The old
// message claimed "deposited" for every success:true leg, which lied whenever polling timed out.
// The localStorage write mirrors passkeyBridge's own persist (same keys the dashboard's
// loadBasePositions gates on) — proven live 2026-07-19: a run whose markers were missing left a
// fully-deposited position invisible in the UI with no code path to ever show it.
export function applyBaseLegOutcome(baseLeg, { storage } = {}) {
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
