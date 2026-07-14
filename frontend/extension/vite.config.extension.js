import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

// Second build target: emits the unpacked MV3 extension into ../extension-dist.
// root = this dir so the HTML entries emit flat at the dist root (not nested under extension/),
// keeping each page's relative script refs valid and the manifest's popup.html / ceremony.html
// paths correct. A closeBundle hook copies manifest.json in (publicDir is off).
const OUT = resolve(__dirname, '../extension-dist')

export default defineConfig({
  root: __dirname,
  envDir: resolve(__dirname, '..'),
  plugins: [
    react(),
    {
      name: 'copy-manifest',
      closeBundle() {
        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(OUT, 'manifest.json'))
        copyFileSync(
          resolve(__dirname, 'vibing_farmer.logo.svg'),
          resolve(OUT, 'vibing_farmer.logo.svg')
        )
        // background.js + the two content scripts are authored with `export` for
        // unit-testability: strip every top-level `export ` so they run as plain classic
        // scripts (neither service worker nor content scripts are loaded as ES modules here).
        for (const file of ['background.js', 'providerInject.js', 'providerBridge.js']) {
          const content = readFileSync(resolve(__dirname, file), 'utf-8')
          const clean = content.replace(/^export (?=(?:async function|function|const|class)\b)/gm, '')
          writeFileSync(resolve(OUT, file), clean)
        }

        cpSync(resolve(__dirname, 'icons'), resolve(OUT, 'icons'), { recursive: true })
      },
    },
  ],
  publicDir: false,
  // Inline the backend origin so the packed chrome-extension:// pages call absolute /api/* URLs
  // instead of relative ones (which resolve to the extension origin and 404). Build with
  // VF_API_BASE=http://localhost:5173 (dev) or the deployed Pages origin.
  define: {
    'process.env.VF_API_BASE': JSON.stringify(process.env.VF_API_BASE || ''),
    'import.meta.env.VITE_VF_RP_ID': JSON.stringify('origin'),
  },
  resolve: {
    alias: {
      // cipher-base (via ed25519-hd-key → create-hmac) requires the node
      // builtin 'stream', which vite externalizes to an empty stub in browser
      // builds — Transform.call(this) then crashes on first HMAC use.
      // readable-stream implements the same API and is already bundled via
      // hash-base, so alias the builtin onto it.
      stream: 'readable-stream',
    },
  },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        ceremony: resolve(__dirname, 'ceremony.html'),
      },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
})
