import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import aiProxy from './api/ai.js'
import searchProxy from './api/search.js'
import stellarRelayProxy from './api/stellar-relay.js'
import faucetProxy from './api/faucet.js'
import vfRouter from './api/vf/_router.js'

// Repo root (parent of frontend/) — needed below so the dev server's fs.allow boundary covers
// frontend/src/stellar/vaultReads.js's cross-package import of keeper/src/apr.js.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '') // all vars (incl. non-VITE server-side)
  if (env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
  if (env.TAVILY_API_KEY) process.env.TAVILY_API_KEY = env.TAVILY_API_KEY
  if (env.ALLOWED_ORIGIN) process.env.ALLOWED_ORIGIN = env.ALLOWED_ORIGIN

  // Soroban gasless relay (sub-project 2) — server-side only, never in the client bundle.
  if (env.STELLAR_RELAYER_SECRET) process.env.STELLAR_RELAYER_SECRET = env.STELLAR_RELAYER_SECRET
  if (env.SOROBAN_RPC_URL) process.env.SOROBAN_RPC_URL = env.SOROBAN_RPC_URL
  if (env.STELLAR_NETWORK_PASSPHRASE)
    process.env.STELLAR_NETWORK_PASSPHRASE = env.STELLAR_NETWORK_PASSPHRASE
  if (env.SOROBAN_VAULT_ADDRESS) process.env.SOROBAN_VAULT_ADDRESS = env.SOROBAN_VAULT_ADDRESS
  if (env.VF_FAUCET_SECRET) process.env.VF_FAUCET_SECRET = env.VF_FAUCET_SECRET
  if (env.SOROBAN_TOKEN_ADDRESS) process.env.SOROBAN_TOKEN_ADDRESS = env.SOROBAN_TOKEN_ADDRESS
  if (env.SOROBAN_AGENT_ALLOWLIST) process.env.SOROBAN_AGENT_ALLOWLIST = env.SOROBAN_AGENT_ALLOWLIST

  // VF API gate (SEP-10 portal + gateway) — server-side only, never in the client bundle.
  if (env.VF_AUTH_SIGNING_KEY) process.env.VF_AUTH_SIGNING_KEY = env.VF_AUTH_SIGNING_KEY
  if (env.VF_JWT_SECRET) process.env.VF_JWT_SECRET = env.VF_JWT_SECRET
  if (env.VF_HOME_DOMAIN) process.env.VF_HOME_DOMAIN = env.VF_HOME_DOMAIN
  if (env.VF_GLOBAL_DAILY_CAP) process.env.VF_GLOBAL_DAILY_CAP = env.VF_GLOBAL_DAILY_CAP
  if (env.VF_VAULT_CATALOG) process.env.VF_VAULT_CATALOG = env.VF_VAULT_CATALOG

  const apiProxyPlugin = {
    name: 'api-proxy',
    configureServer(s) {
      s.middlewares.use('/api/vf', vfRouter)
      s.middlewares.use('/api/ai', aiProxy)
      s.middlewares.use('/api/search', searchProxy)
      s.middlewares.use('/api/stellar-relay', stellarRelayProxy)
      s.middlewares.use('/api/faucet', faucetProxy)
    },
    configurePreviewServer(s) {
      s.middlewares.use('/api/vf', vfRouter)
      s.middlewares.use('/api/ai', aiProxy)
      s.middlewares.use('/api/search', searchProxy)
      s.middlewares.use('/api/stellar-relay', stellarRelayProxy)
      s.middlewares.use('/api/faucet', faucetProxy)
    },
  }

  return {
    plugins: [react(), apiProxyPlugin],
    root: '.',
    build: {
      outDir: 'dist',
      rollupOptions: {
        external: [],
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            // Split only the heavy, self-contained motion cluster. The force-graph cluster
            // (react-force-graph -> kapsule -> force-graph -> d3-*) plus React are left to
            // Rollup's automatic chunking: hand-cut 'graph' vs catch-all 'vendor' chunks formed a
            // graph<->vendor import cycle, which crashed at runtime with a TDZ ReferenceError
            // ("Cannot access 'zn' before initialization"). Auto-chunking keeps force-graph in the
            // lazy route chunks that import it and orders initializers correctly.
            if (id.includes('framer-motion')) return 'motion'
            return undefined
          },
        },
      },
    },
    server: {
      historyApiFallback: true,
      // frontend/src/stellar/vaultReads.js imports keeper/src/apr.js via a relative cross-package
      // path (T2 Fix 3 dedup) — that file lives outside this Vite root ('.' == frontend/), so the
      // default fs.allow boundary 403s it under `vite dev`. Widen to the repo root so /@fs/ can
      // reach it; `vite build` (Rollup) and vitest are unaffected — this only bounds the dev server.
      fs: {
        allow: [repoRoot],
      },
    },
    preview: {
      historyApiFallback: true,
    },
    optimizeDeps: {
      include: ['react-force-graph-2d'],
    },
  }
})
