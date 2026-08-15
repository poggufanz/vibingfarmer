// Rasterize the frozen Foundation product mark (extension/vibing_farmer.logo.svg, a
// byte-identical compatibility copy of public/brand/vibing-farmer-mark.svg -- see
// brandAssets.test.js) into the PNG sizes Chrome needs for the MV3 toolbar/action icon (SVG is
// not accepted there). Re-run after the mark changes: `node scripts/gen-ext-icons.mjs` from the
// frontend/ dir.
//
// Uses @resvg/resvg-js (Foundation's raster tool -- the same one build-brand-assets.mjs uses for
// public/brand/*.png) instead of sharp: one deterministic, already-installed render pipeline for
// every Pocket Crew raster, web app and extension alike. Fails closed if the source SVG's hash
// has drifted from assets.manifest.json's frozen record for it -- a hand-edited or stale
// extension logo must never silently get rasterized as if it were the reviewed mark.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const here = dirname(fileURLToPath(import.meta.url))
const extDir = resolve(here, '../extension')
const publicDir = resolve(here, '../public')

const svg = readFileSync(resolve(extDir, 'vibing_farmer.logo.svg'))

const manifest = JSON.parse(readFileSync(resolve(publicDir, 'brand/assets.manifest.json'), 'utf8'))
const markEntry = manifest.find((entry) => entry.path === '/brand/vibing-farmer-mark.svg')
if (!markEntry) {
  throw new Error('assets.manifest.json has no entry for /brand/vibing-farmer-mark.svg')
}
const actualHash = createHash('sha256').update(svg).digest('hex')
if (actualHash !== markEntry.sha256) {
  throw new Error(
    'extension/vibing_farmer.logo.svg does not match the frozen mark hash in ' +
      `assets.manifest.json (expected ${markEntry.sha256}, got ${actualHash}). Copy ` +
      'public/brand/vibing-farmer-mark.svg over it rather than hand-editing.'
  )
}

const outDir = resolve(extDir, 'icons')
mkdirSync(outDir, { recursive: true })

const SIZES = [16, 32, 48, 128]
for (const size of SIZES) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(resolve(outDir, `icon-${size}.png`), png)
}
console.log(`extension icons generated (${SIZES.join(', ')}) -> ${outDir}`)
