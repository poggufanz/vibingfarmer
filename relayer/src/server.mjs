// Thin composition layer: wires the relayer's existing watcher/orchestrator/farm-flow modules
// into the pure httpRouter and exposes a node:http listener. Holds no request-handling logic of
// its own — see httpRouter.mjs for that. NOT mounted as Vite middleware: the in-memory
// jobs/mandates Maps need one long-lived process (CF Pages isolates don't share memory across
// requests), and running standalone keeps relayer secrets out of the Vite dev process.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWatcher } from './cctp/watcher.mjs';
import { createOrchestrator } from './base/orchestrator.mjs';
import { createFarmFlow } from './flows/farm.mjs';
import { createRelayerRouter } from './httpRouter.mjs';
import { createMandateStore } from './mandateStore.mjs';

const MANDATE_SWEEP_MS = 10 * 60 * 1000; // evict expired session keys every 10 min

/**
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {{ handler: Function, listen: (port: number) => import('node:http').Server }}
 */
export function createRelayerServer(config) {
  const watcher = createWatcher(config);
  const jobs = new Map();
  // serializedApproval -> sessionPrivateKey. Process memory ONLY — never persisted, never logged.
  // TTL store (not a bare Map) so session keys don't linger in memory past the mandate's lifetime.
  const mandates = createMandateStore();

  // Per-request: each /farm call brings its own ephemeral session key, so the orchestrator (and
  // the kernel client it reconstructs) is built fresh per key rather than shared/cached.
  function buildFarm(sessionPrivateKey) {
    const orchestrator = createOrchestrator({
      chain: config.base.chain,
      rpcUrl: config.base.rpcUrl,
      bundlerRpcUrl: config.base.bundlerRpcUrl,
      yieldRouterAddress: config.base.yieldRouterAddress,
      usdcAddress: config.base.usdcAddress,
      sessionPrivateKey,
    });
    return createFarmFlow({ watcher, orchestrator, domains: config.domains });
  }

  // Reverse leg: relay ONLY the mint. `stellarRecipient` is already encoded in the burn's
  // hookData (see cctp/reverse.mjs) — accepted here for logging/idempotency, not for routing.
  // unwind.mjs (the withdraw+burn flow) stays relayer-internal and is never wired to this route.
  function relayUnwindMint({ unwindTxHash }) {
    return watcher.relayMint({ sourceDomain: config.domains.base, burnTxHash: unwindTxHash, execId: unwindTxHash });
  }

  // Sanitize client-facing error messages unless explicitly debugging (RELAYER_DEBUG_ERRORS=1),
  // so a public deploy never leaks internal error strings via GET /status. The smoke harness runs
  // localhost and sets the flag to keep full detail.
  const handler = createRelayerRouter({
    buildFarm,
    relayUnwindMint,
    jobs,
    mandates,
    genId: randomUUID,
    sanitizeErrors: process.env.RELAYER_DEBUG_ERRORS !== '1',
  });

  function listen(port) {
    const server = createServer(handler);
    server.listen(port);
    // Periodically drop expired session keys so they don't wait for a matching /farm to be evicted.
    const sweep = setInterval(() => mandates.sweep(), MANDATE_SWEEP_MS);
    sweep.unref?.(); // never keep the process alive just for the sweep
    server.on('close', () => clearInterval(sweep));
    return server;
  }

  return { handler, listen };
}
