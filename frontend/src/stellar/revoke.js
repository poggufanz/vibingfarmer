// Agent kill switch on Stellar. The owner calls revoke() ON THE AGENT ACCOUNT — the contract
// whose __check_auth actually enforces the scope — flipping scope.revoked and clearing the
// vault allowance on-chain. The UI subscribes to live agent_revoked events to confirm
// (AgentAccount emits the same topic/shape the Registry's metadata mirror uses).
import { buildInvokeTx, submitUserTx, rpcServer } from './client.js'
import { signTxXdr } from './walletKit.js'
import { pollEvents } from './events.js'
import { symbolScVal } from './scval.js'

// agent_revoked now fires from each per-run AgentAccount contract (not the Registry), so we
// poll by TOPIC across all contracts — the agents' fresh addresses are never in the indexer's
// WATCHED contract list.
const AGENT_REVOKED_TOPIC = symbolScVal('agent_revoked').toXDR('base64')

/**
 * Revoke an agent — user-signed AgentAccount.revoke() on the agent contract itself. One user tx,
 * submitted directly (NOT via the gasless relay) so the kill switch still works when the relayer
 * is down — that independence is what backs the "user can revoke any time" guarantee.
 * @param {{ owner: string, agent: string }} p
 * @returns {Promise<{ hash: string, status: string }>}
 */
export async function revokeAgentOnChain({ owner, agent }) {
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: agent,
    method: 'revoke',
    args: [],
  })
  const signed = await signTxXdr(xdr)
  return submitUserTx({ signedXdr: signed })
}

/**
 * From a batch of decoded events, the agents revoked by `owner` (case-insensitive match on the
 * AgentRevoked.owner field). Pure — the testable core of the subscription.
 * @param {Array<{type:string, data?:{owner?:string, agent?:string}}>} events
 * @param {string} owner
 * @returns {string[]} revoked agent addresses owned by `owner`
 */
export function revokedAgentsForOwner(events, owner) {
  const o = String(owner).toLowerCase()
  return events
    .filter((e) => e.type === 'agent_revoked' && String(e.data?.owner).toLowerCase() === o)
    .map((e) => e.data.agent)
}

/**
 * Subscribe to live agent_revoked events for `owner`, firing `cb(agent)` per revocation (whether
 * triggered from this UI or elsewhere). Reuses the events.js indexer (already decode/dedup tested);
 * this layer owns only the poll loop + owner filter + teardown.
 * @param {string} owner connected wallet address to filter revocations by
 * @param {(agent: string) => void} cb
 * @param {{ server?: object, intervalMs?: number, startLedger?: number, poll?: typeof pollEvents }} [opts]
 *   `poll` is an injectable seam for tests; production uses the real pollEvents.
 * @returns {() => void} unsubscribe — stops the loop
 */
export function subscribeAgentRevoked(
  owner,
  cb,
  { server, intervalMs = 4000, startLedger, poll = pollEvents } = {}
) {
  let stopped = false
  let seen = new Set()
  ;(async () => {
    const s = server || (await rpcServer())
    // Start from "now" so we don't replay historical revocations on mount.
    let from = startLedger || (await s.getLatestLedger()).sequence
    while (!stopped) {
      try {
        const out = await poll({
          server: s,
          startLedger: from,
          seen,
          topics: [[AGENT_REVOKED_TOPIC]],
        })
        seen = out.seen || seen
        if (out.latestLedger) from = out.latestLedger + 1 // next window starts after this one
        if (stopped) break
        for (const agent of revokedAgentsForOwner(out.events || [], owner)) cb(agent)
      } catch {
        // transient RPC failure — keep polling, the next window catches up.
      }
      if (stopped) break
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  })()
  return () => {
    stopped = true
  }
}
