import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Second build target: emits the unpacked MV3 extension into ../extension-dist.
// root = this dir so the HTML entries emit flat at the dist root (not nested under extension/),
// keeping each page's relative script refs valid and the manifest's popup.html / ceremony.html
// paths correct. A closeBundle hook copies manifest.json in (publicDir is off).
const OUT = resolve(__dirname, '../extension-dist')
const BRAND_SRC = resolve(__dirname, '../public/brand')
const BRAND_OUT = resolve(OUT, 'brand')

// Reviewed subset only (Wallet Task 8) -- the product mark family + lockups the wallet may show,
// and the reviewed Stellar/Base network marks. NOT the web-app-only PWA/social assets
// (favicon.svg, icon-192/512.png, apple-touch-icon.png, social-card.png) -- those never render
// inside the extension boundary, so they never ship in its bundle.
const BRAND_FILES = [
  'vibing-farmer-mark.svg',
  'vibing-farmer-mark-forest.svg',
  'vibing-farmer-mark-day.svg',
  'vibing-farmer-mark-mono.svg',
  'vibing-farmer-lockup-forest.svg',
  'vibing-farmer-lockup-day.svg',
  'vibing-farmer-lockup-mono.svg',
]
const BRAND_NETWORK_FILES = ['stellar.svg', 'stellar-white.svg', 'base.svg']

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
          const clean = content.replace(
            /^export (?=(?:async function|function|const|class)\b)/gm,
            ''
          )
          writeFileSync(resolve(OUT, file), clean)
        }

        cpSync(resolve(__dirname, 'icons'), resolve(OUT, 'icons'), { recursive: true })

        // Reviewed brand mark/lockup/network subset (Wallet Task 8) -- MV3 pages reference these
        // as local relative paths (./brand/...), never a CDN, so they must ship inside the bundle.
        mkdirSync(resolve(BRAND_OUT, 'networks'), { recursive: true })
        for (const file of BRAND_FILES) {
          copyFileSync(resolve(BRAND_SRC, file), resolve(BRAND_OUT, file))
        }
        for (const file of BRAND_NETWORK_FILES) {
          copyFileSync(resolve(BRAND_SRC, 'networks', file), resolve(BRAND_OUT, 'networks', file))
        }
      },
    },
  ],
  publicDir: false,
  // Inline the backend origin so the packed chrome-extension:// pages call absolute /api/* URLs
  // instead of relative ones (which resolve to the extension origin and 404). Build with
  // VF_API_BASE=http://localhost:5173 (dev); unset defaults to the deployed Pages origin —
  // an empty define let stellar/config.js fall back to localhost:8788, which broke passkey
  // registration ("Failed to fetch") for every packed-build user.
  // import.meta.env key (not process.env): stellar/config.js reads it un-gated by any runtime
  // `process` global, so the override holds even before/without the process polyfill chunk.
  define: {
    'import.meta.env.VITE_VF_API_BASE': JSON.stringify(
      process.env.VF_API_BASE || 'https://vibing-farmer.pages.dev'
    ),
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
        approve: resolve(__dirname, 'approve.html'),
      },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
})
