// frontend/src/dev/devDispatch.js
// DEV-ONLY escape hatch for scripts/smoke-mandate.mjs scenarios 4-7 (wrong-selector /
// wrong-target / over-cap / expired): no product UI issues an out-of-policy call, so the smoke
// script drives one directly through window.__vfDevDispatchRawCall({ scenario }). Reconstructs
// the session client (base/session.js) and fires a raw kernelClient.sendUserOperation with a
// deliberately out-of-policy {to, data} — rejection (executed:false) is the EXPECTED outcome.
// Imported ONLY behind `import.meta.env.DEV` (see main.jsx) + verified absent from production
// output by scripts/assert-no-dev-dispatch.mjs (wired as the `postbuild` npm hook).
import { encodeFunctionData, zeroAddress } from 'viem'
import { reconstructSessionClient } from '../base/session.js'
import { YIELD_ROUTER_ADDRESS, YIELD_ROUTER_ABI } from '../base/config.js'

// Comfortably beyond any realistic per-pool deposit cap — used to trigger the LESS_THAN_OR_EQUAL
// arg-policy rejection without needing to know the real mandate's cap value.
const OVER_CAP_AMOUNT = 10n ** 30n

/** @returns {{to: string, data: string}} the out-of-policy call for one smoke scenario. */
export function buildScenarioCall(scenario, pool = zeroAddress) {
  const dep = (functionName, args) =>
    encodeFunctionData({ abi: YIELD_ROUTER_ABI, functionName, args })
  switch (scenario) {
    case 'sweep': // wrong selector: withdraw is not in the deposit-only session policy
      return { to: YIELD_ROUTER_ADDRESS, data: dep('withdraw', [pool, 1n, 0n]) }
    case 'wrong-target': // right selector/args, deliberately not YIELD_ROUTER_ADDRESS
      return { to: zeroAddress, data: dep('deposit', [pool, 1n, 0n]) }
    case 'over-cap': // right target/selector, amount far past the per-pool cap
      return { to: YIELD_ROUTER_ADDRESS, data: dep('deposit', [pool, OVER_CAP_AMOUNT, 0n]) }
    case 'expired': // an otherwise-valid call — rejection must come from the timestamp policy
      return { to: YIELD_ROUTER_ADDRESS, data: dep('deposit', [pool, 1n, 0n]) }
    default:
      throw new Error(`__vfDevDispatchRawCall: unknown scenario "${scenario}"`)
  }
}

/**
 * @param {{scenario: string, publicClient?: object, serializedApproval?: string,
 *   sessionPrivateKey?: string, pool?: string, deps?: object}} p Session material may be passed
 *   directly, or (matching smoke-mandate.mjs's `{ scenario }`-only call) read from
 *   `window.__vfDevMandateFixture`; an `expired` sub-object there overrides for that one scenario
 *   so it can point at a separately-issued, already-expired approval.
 * @returns {Promise<{executed: boolean, userOpHash?: string, error?: string}>}
 */
export async function dispatchRawCall({
  scenario,
  publicClient,
  serializedApproval,
  sessionPrivateKey,
  pool,
  deps = {},
} = {}) {
  const fixture = (typeof window !== 'undefined' && window.__vfDevMandateFixture) || {}
  const src =
    scenario === 'expired' && fixture.expired ? { ...fixture, ...fixture.expired } : fixture

  const client = publicClient ?? src.publicClient
  const approval = serializedApproval ?? src.serializedApproval
  const sessionKey = sessionPrivateKey ?? src.sessionPrivateKey
  const poolAddress = pool ?? src.pool ?? zeroAddress

  if (!client || !approval || !sessionKey) {
    return {
      executed: false,
      error:
        'Session material is missing. Pass publicClient, serializedApproval, and sessionPrivateKey, or set window.__vfDevMandateFixture.',
    }
  }

  try {
    const { reconstruct = reconstructSessionClient } = deps
    const kernelClient = await reconstruct({
      publicClient: client,
      serializedApproval: approval,
      sessionPrivateKey: sessionKey,
    })
    const { to, data } = buildScenarioCall(scenario, poolAddress)
    const callData = await kernelClient.account.encodeCalls([{ to, value: 0n, data }])
    const userOpHash = await kernelClient.sendUserOperation({ callData })
    return { executed: true, userOpHash }
  } catch (err) {
    return { executed: false, error: err?.shortMessage || err?.message || String(err) }
  }
}

export function registerDevDispatch(target = globalThis) {
  target.__vfDevDispatchRawCall = dispatchRawCall
  return target.__vfDevDispatchRawCall
}

if (typeof window !== 'undefined') registerDevDispatch(window)
