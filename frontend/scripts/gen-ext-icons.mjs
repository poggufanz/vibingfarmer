// Rasterize the brand logo (extension/vibing_farmer.logo.svg) into the PNG sizes Chrome
// needs for the MV3 toolbar/action icon (SVG is not accepted there). Re-run after the
// logo changes: `node scripts/gen-ext-icons.mjs` from the frontend/ dir.
import sharp from 'sharp'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const extDir = resolve(here, '../extension')
const svg = readFileSync(resolve(extDir, 'vibing_farmer.logo.svg'))
const outDir = resolve(extDir, 'icons')
mkdirSync(outDir, { recursive: true })

const SIZES = [16, 32, 48, 128]
for (const size of SIZES) {
  // density 384 renders the 173px SVG at ~4x before downscaling, so even 128px stays crisp.
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(resolve(outDir, `icon-${size}.png`))
}
console.log(`extension icons generated (${SIZES.join(', ')}) -> ${outDir}`)
