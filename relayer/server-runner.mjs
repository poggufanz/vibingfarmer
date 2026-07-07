// Entry point: node --env-file=.dev.vars relayer/server-runner.mjs
// Loads relayer secrets from process.env and starts the /api/vf-cross HTTP surface on :8788.
// Kept separate from src/server.mjs so createRelayerServer stays importable — and its module
// load stays side-effect-free — without this file's env read / socket open running along with it.

import { loadConfig } from './src/config.mjs';
import { createRelayerServer } from './src/server.mjs';

const PORT = 8788;
const config = loadConfig(process.env);
createRelayerServer(config).listen(PORT);
console.log(`vf-cross relayer listening on :${PORT}`);
