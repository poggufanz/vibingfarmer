// frontend/src/mergeFlowHelpers.js
// The two small decision points that wire the merged Stellar+Base flow into app.jsx: what the
// strategy step tells the strategist about Base availability, and what the dispatch step tells
// the orchestrator about the connected wallet's Base leg signer. Extracted so both are unit-
// testable without rendering the 126KB app.jsx.
import { isVfWallet } from './wallet/passkeyBridge.js'

// One place that decides what the strategy step tells the strategist about Base. Returns the
// health-check PROMISE (not its resolved value) so the ~3s relayer probe overlaps the caller's own
// concurrent work (the strategy DAG fetch) instead of serializing before it — the caller awaits
// `baseAvailable` only once it actually needs the boolean (generateStrategy does this after its
// own DAG fetch, so the two waits run in parallel).
export function resolveBaseAvailability({ checkHealth }) {
  return { baseAvailable: checkHealth() }
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
