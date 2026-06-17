import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import aiProxy from './api/ai.js'
import searchProxy from './api/search.js'
import relayProxy from './api/relay.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '') // all vars (incl. non-VITE server-side)
  if (env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
  if (env.TAVILY_API_KEY) process.env.TAVILY_API_KEY = env.TAVILY_API_KEY
  if (env.ALLOWED_ORIGIN) process.env.ALLOWED_ORIGIN = env.ALLOWED_ORIGIN
  // Propagate the RPC URL to process.env so the server-side relay proxy (api/relay.js)
  // uses the SAME (Alchemy) RPC as the client for its hasCode/executed guards. Without
  // this it falls back to the rate-limited public sepolia.base.org → getCode fails →
  // hasCode fail-opens → the codeless-depositor guard is silently disabled (the no-op
  // relay-to-dead-address bug). RPC_URL is first in api/relay.js rpcUrl() precedence.
  if (env.VITE_RPC_URL) process.env.RPC_URL = env.VITE_RPC_URL
  // 1Shot Managed API creds — server-side only, never exposed to the client bundle.
  if (env.ONESHOT_KEY) process.env.ONESHOT_KEY = env.ONESHOT_KEY
  if (env.ONESHOT_SECRET) process.env.ONESHOT_SECRET = env.ONESHOT_SECRET
  if (env.ONESHOT_BIZ_ID) process.env.ONESHOT_BIZ_ID = env.ONESHOT_BIZ_ID
  if (env.AGENT_VAULT_DEPOSITOR_ADDRESS)
    process.env.AGENT_VAULT_DEPOSITOR_ADDRESS = env.AGENT_VAULT_DEPOSITOR_ADDRESS

  const apiProxyPlugin = {
    name: 'api-proxy',
    configureServer(s) {
      s.middlewares.use('/api/ai', aiProxy)
      s.middlewares.use('/api/search', searchProxy)
      s.middlewares.use('/api/relay', relayProxy)
    },
    configurePreviewServer(s) {
      s.middlewares.use('/api/ai', aiProxy)
      s.middlewares.use('/api/search', searchProxy)
      s.middlewares.use('/api/relay', relayProxy)
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
            // Only split the heavy, self-contained web3 + motion clusters. The
            // force-graph cluster (react-force-graph -> kapsule -> force-graph ->
            // d3-*) plus React are left to Rollup's automatic chunking: hand-cut
            // 'graph' vs catch-all 'vendor' chunks formed a graph<->vendor import
            // cycle, which crashed at runtime with a TDZ ReferenceError
            // ("Cannot access 'zn' before initialization"). Auto-chunking keeps
            // force-graph in the lazy route chunks that import it and orders
            // initializers correctly.
            if (
              id.includes('ethers') ||
              id.includes('viem') ||
              id.includes('@metamask') ||
              id.includes('/ox/') ||
              id.includes('@coinbase') ||
              id.includes('libsodium')
            )
              return 'web3'
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
