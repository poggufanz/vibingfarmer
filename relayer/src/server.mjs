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

/**
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {{ handler: Function, listen: (port: number) => import('node:http').Server }}
 */
export function createRelayerServer(config) {
  const watcher = createWatcher(config);
  const jobs = new Map();
  // serializedApproval -> sessionPrivateKey. Process memory ONLY — never persisted, never logged.
  const mandates = new Map();

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

  const handler = createRelayerRouter({ buildFarm, relayUnwindMint, jobs, mandates, genId: randomUUID });

  function listen(port) {
    const server = createServer(handler);
    server.listen(port);
    return server;
  }

  return { handler, listen };
}
