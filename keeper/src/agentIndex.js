// keeper/src/agentIndex.js — calls the protected /api/agent-index ingest endpoint for bounded
// catch-up pages, on the SAME 15-min cron the money-moving compound/rebalance/derisk tick already
// runs on, but wired independently (see index.js's `ctx.waitUntil`): an index failure must never
// stop the money-path actions, and a money-path failure must never be read as index unhealthiness
// — this module owns nothing but its own fetch + log, never throws out of `syncAgentIndex` itself.

/**
 * POST one bounded ingest tick to the agent-index endpoint. Never throws — every failure mode
 * (not configured, non-OK response, network error) is logged and swallowed, matching index.js's
 * own "never throw out of scheduled" discipline.
 * @param {{AGENT_INDEX_URL?: string, AGENT_INDEX_INGEST_SECRET?: string}} env
 * @param {typeof fetch} [fetchImpl] test seam
 */
export async function syncAgentIndex(env, fetchImpl = fetch) {
  const url = env?.AGENT_INDEX_URL;
  const secret = env?.AGENT_INDEX_INGEST_SECRET;
  if (!url || !secret) {
    console.log(JSON.stringify({ tick: 'agent-index-skip', reason: 'not-configured' }));
    return;
  }
  try {
    const res = await fetchImpl(`${url}?action=ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body — status alone still tells the log the outcome */
    }
    if (!res.ok) {
      console.log(JSON.stringify({ tick: 'agent-index-failed', status: res.status, body }));
      return;
    }
    console.log(JSON.stringify({ tick: 'agent-index-synced', ok: body.ok, failed: body.failed }));
  } catch (err) {
    console.log(JSON.stringify({ tick: 'agent-index-error', error: String(err?.message || err) }));
  }
}
