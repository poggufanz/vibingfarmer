#!/usr/bin/env node
// frontend/scripts/assert-no-dev-dispatch.mjs
// Build-time assert wired as the `postbuild` npm hook (package.json) — npm runs this
// automatically right after `npm run build`. Proves the dev-only __vfDevDispatchRawCall escape
// hatch (src/dev/devDispatch.js, DEV-gated import in main.jsx) never ships in the production
// bundle. Fails the build (non-zero exit) if the symbol is found anywhere under dist/.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST_DIR = join(process.cwd(), 'dist')
const FORBIDDEN = '__vfDevDispatchRawCall'

function collectFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? collectFiles(full) : [full]
  })
}

let files
try {
  files = collectFiles(DIST_DIR)
} catch {
  console.error(`assert-no-dev-dispatch: ${DIST_DIR} not found — run "vite build" first`)
  process.exit(1)
}

const jsFiles = files.filter((f) => f.endsWith('.js'))
const hits = jsFiles.filter((f) => readFileSync(f, 'utf8').includes(FORBIDDEN))

if (hits.length > 0) {
  console.error(`assert-no-dev-dispatch: FOUND "${FORBIDDEN}" in production bundle:`)
  for (const f of hits) console.error(`  ${f}`)
  process.exit(1)
}

console.log(`assert-no-dev-dispatch: OK — "${FORBIDDEN}" absent from ${jsFiles.length} dist .js file(s)`)
