import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import aiProxy from './api/ai.js'
import searchProxy from './api/search.js'
import stellarRelayProxy from './api/stellar-relay.js'

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

  const apiProxyPlugin = {
    name: 'api-proxy',
    configureServer(s) {
      s.middlewares.use('/api/ai', aiProxy)
      s.middlewares.use('/api/search', searchProxy)
      s.middlewares.use('/api/stellar-relay', stellarRelayProxy)
    },
    configurePreviewServer(s) {
      s.middlewares.use('/api/ai', aiProxy)
      s.middlewares.use('/api/search', searchProxy)
      s.middlewares.use('/api/stellar-relay', stellarRelayProxy)
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
    },
    preview: {
      historyApiFallback: true,
    },
    optimizeDeps: {
      include: ['react-force-graph-2d'],
    },
  }
})
