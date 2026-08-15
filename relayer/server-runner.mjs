// Import-safe standalone entry point.  Tests and local tooling can import this module without
// reading secrets, opening a socket, or changing process state.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './src/config.mjs';
import { createRelayerServer } from './src/server.mjs';
import { runtimePreflight } from './src/runtimePreflight.mjs';
import { createSafeLogger } from './src/safeLogger.mjs';

export async function runRelayer({
  env = process.env,
  port = Number(env.RELAYER_PORT || 8788),
  loadConfigFn = loadConfig,
  createServerFn = createRelayerServer,
  preflightFn = runtimePreflight,
  logger = createSafeLogger({ mode: env.NODE_ENV || 'development' }),
  processLike = process,
} = {}) {
  let server = null;
  let serverClosed = false;
  const closeServer = () => {
    if (!server || serverClosed) return;
    serverClosed = true;
    try { server.close?.(); } catch {}
  };
  try {
    const config = loadConfigFn(env);
    // The production composition owns the durable stores and reporter client. Construct that
    // resource graph without workers/listener, then hand its real probes to the fail-closed gate.
    // Injected test/tool factories retain the simpler preflight-before-construction ordering.
    const composedDefault = createServerFn === createRelayerServer && preflightFn === runtimePreflight;
    if (composedDefault) {
      await preflightFn({ config, env, logger, staticOnly: true });
      server = createServerFn(config);
      try {
        await preflightFn({
          config,
          env,
          logger,
          dependencies: server.preflightDependencies,
        });
      } catch (error) {
        closeServer();
        throw error;
      }
    } else {
      await preflightFn({ config, env, logger });
      server = createServerFn(config);
    }
    const listener = await server.listen(port);
    try { logger.info('RELAYER_LISTENING', { port }); } catch {}
    return { ok: true, config, server, listener };
  } catch (error) {
    closeServer();
    const code = error?.code === 'RUNTIME_PREFLIGHT_FAILED'
      ? error.reasonCode || 'RUNTIME_PREFLIGHT_FAILED'
      : 'RELAYER_STARTUP_FAILED';
    try { logger.error(code, {}); } catch {}
    processLike.exitCode = 1;
    return { ok: false, code };
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  void runRelayer();
}
