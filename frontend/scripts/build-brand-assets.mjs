// Deterministic Pocket Crew brand asset builder (Foundation Task 3).
//
// Renders the fixed, hand-authored mark SVGs in public/brand/ into the
// raster sizes the web/app chrome needs, composes the social-card PNG, and
// writes assets.manifest.json with a sha256 for every asset. Never fetches
// the network — every input already lives in this repo.
//
// Re-run after any brand SVG changes: `npm run brand:build` from frontend/.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '../public')
const brandDir = resolve(publicDir, 'brand')

// Every asset in this wave was authored/rendered on the same date and never
// fetched from a network source — see CLAUDE.md's Task 3 binding decisions.
const RETRIEVED_AT = '2026-07-22'
const SOURCE = 'Vibing Farmer Pocket Crew design system (original artwork)'
const TRADEMARK_TREATMENT =
  'Vibing Farmer™ Pocket Crew mark — geometry is frozen; recolor only within the ' +
  'approved theme variants (forest, day, mono). No distortion, rotation, or recombination ' +
  'with other symbols.'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function readBrand(name) {
  return readFileSync(resolve(brandDir, name))
}

function writeBrand(name, buffer) {
  writeFileSync(resolve(brandDir, name), buffer)
}

// Pulls the child markup out of a source SVG so it can be re-embedded inside
// a differently sized composition (used for the social card).
function innerMarkup(svgText) {
  const match = svgText.match(/<svg[^>]*>([\s\S]*)<\/svg>/)
  if (!match) throw new Error('could not extract inner SVG markup')
  return match[1]
}

// --- App icon rasters: the default keylined mark, resized. ---------------
const markSvg = readBrand('vibing-farmer-mark.svg')

const ICON_RENDERS = [
  { file: 'apple-touch-icon.png', size: 180, kind: 'apple-touch-icon' },
  { file: 'icon-192.png', size: 192, kind: 'icon-192' },
  { file: 'icon-512.png', size: 512, kind: 'icon-512' },
]

for (const { file, size } of ICON_RENDERS) {
  const png = new Resvg(markSvg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeBrand(file, png)
}

// --- Social card: Forest canvas + the Forest mark, centered. -------------
const forestMarkInner = innerMarkup(readBrand('vibing-farmer-mark-forest.svg').toString('utf8'))
const SOCIAL_CARD_SIZE = { width: 1200, height: 630 }
const markBoxSize = 64 * 4 // 4x the 64x64 mark canvas
const markOffsetX = (SOCIAL_CARD_SIZE.width - markBoxSize) / 2
const markOffsetY = (SOCIAL_CARD_SIZE.height - markBoxSize) / 2
const socialCardSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SOCIAL_CARD_SIZE.width} ${SOCIAL_CARD_SIZE.height}" ` +
  `width="${SOCIAL_CARD_SIZE.width}" height="${SOCIAL_CARD_SIZE.height}">` +
  `<rect width="${SOCIAL_CARD_SIZE.width}" height="${SOCIAL_CARD_SIZE.height}" fill="#17251F"/>` +
  `<g transform="translate(${markOffsetX},${markOffsetY}) scale(4)">${forestMarkInner}</g>` +
  `</svg>`
const socialCardPng = new Resvg(socialCardSvg).render().asPng()
writeBrand('social-card.png', socialCardPng)

// --- Compatibility aliases: legacy paths now carry the compact mark. -----
// vibing_farmer.logo.svg is byte-identical to the compact mark (see
// brandAssets.test.js); vibing_farmer.logo.png mirrors the 512px raster.
writeFileSync(resolve(publicDir, 'vibing_farmer.logo.svg'), markSvg)
writeFileSync(resolve(publicDir, 'vibing_farmer.logo.png'), readBrand('icon-512.png'))

// --- Manifest ---------------------------------------------------------
// This script only knows how to author/render the Vibing Farmer mark family
// below — it must NOT clobber manifest entries for assets it doesn't own
// (e.g. the hand-recorded third-party network marks under public/brand/networks/,
// added by a later task). Regenerate the entries this script owns, then merge
// in any existing entries whose path isn't one of them, preserved verbatim.
const MANIFEST_ENTRIES = [
  { path: '/brand/vibing-farmer-mark.svg', kind: 'mark' },
  { path: '/brand/vibing-farmer-mark-forest.svg', kind: 'mark-forest' },
  { path: '/brand/vibing-farmer-mark-day.svg', kind: 'mark-day' },
  { path: '/brand/vibing-farmer-mark-mono.svg', kind: 'mark-mono' },
  { path: '/brand/vibing-farmer-lockup-forest.svg', kind: 'lockup-forest' },
  { path: '/brand/vibing-farmer-lockup-day.svg', kind: 'lockup-day' },
  { path: '/brand/vibing-farmer-lockup-mono.svg', kind: 'lockup-mono' },
  { path: '/brand/favicon.svg', kind: 'favicon' },
  { path: '/brand/icon-192.png', kind: 'icon-192' },
  { path: '/brand/icon-512.png', kind: 'icon-512' },
  { path: '/brand/apple-touch-icon.png', kind: 'apple-touch-icon' },
  { path: '/brand/social-card.png', kind: 'social-card' },
]

const generated = MANIFEST_ENTRIES.map(({ path, kind }) => ({
  path,
  kind,
  sha256: sha256(readFileSync(resolve(publicDir, path.replace(/^\//, '')))),
  source: SOURCE,
  sourceUrl: '',
  retrievedAt: RETRIEVED_AT,
  trademarkTreatment: TRADEMARK_TREATMENT,
}))

const manifestPath = resolve(brandDir, 'assets.manifest.json')
const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : []
const generatedPaths = new Set(generated.map((entry) => entry.path))
const preserved = existing.filter((entry) => !generatedPaths.has(entry.path))

const manifest = [...generated, ...preserved]

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `brand assets built: ${generated.length} generated + ${preserved.length} preserved = ${manifest.length} manifest entries -> ${brandDir}`
)
