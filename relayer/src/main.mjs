// Standalone entry: node --env-file=.dev.vars src/main.mjs
// (The VM runs the same thing via docker-compose; locally dev-tunnel.sh wraps this.)
import { loadConfig } from './config.mjs'
import { createRelayerServer } from './server.mjs'

const port = Number(process.env.RELAYER_PORT || 8788)
const { listen } = createRelayerServer(loadConfig(process.env))
listen(port)
console.log(`relayer listening on :${port}`)
