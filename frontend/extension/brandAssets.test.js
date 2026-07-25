// Wallet Task 8 asset-contract tests: proves the MV3 extension boundary consumes the frozen
// Foundation product mark + reviewed network marks, renders deterministic icons from them, and
// ships no remote font/script/image dependency anywhere in popup/approve/ceremony. Companion to
// src/design/brandAssets.test.js (the web app's own asset contract) -- same spirit, scoped to
// extension/.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND_DIR = resolve(import.meta.dirname, '..')
const EXT_DIR = resolve(FRONTEND_DIR, 'extension')
const PUBLIC_DIR = resolve(FRONTEND_DIR, 'public')
const DIST_DIR = resolve(FRONTEND_DIR, 'extension-dist')
const GEN_SCRIPT = resolve(FRONTEND_DIR, 'scripts/gen-ext-icons.mjs')
const MANIFEST_JSON = resolve(EXT_DIR, 'manifest.json')
const MARK_SVG = resolve(PUBLIC_DIR, 'brand/vibing-farmer-mark.svg')
const LOGO_SVG = resolve(EXT_DIR, 'vibing_farmer.logo.svg')
const ASSETS_MANIFEST = resolve(PUBLIC_DIR, 'brand/assets.manifest.json')

// Fixed pocket body + V geometry (see src/design/brandAssets.test.js) -- proves the extension
// mark is the same frozen Foundation product mark, not a redrawn wallet-only shape.
const POCKET_D = 'M8 11H21L25 17H39L43 11H56V50C56 55 52 59 47 59H17C12 59 8 55 8 50Z'
const V_D = 'M18 24L31 48L43 24'

// AgentMark's capsule body + tail (src/components/pocket/AgentMark.jsx) -- the product mark must
// never share this geometry. AgentMark exists so "one crew mark always means one actually
// deployed account"; a wallet-only respray of it would defeat that contract.
const AGENT_MARK_BODY_D =
  'M16 4C10.477 4 6 8.477 6 14V20C6 25.523 10.477 30 16 30C21.523 30 26 25.523 26 20V14C26 8.477 21.523 4 16 4Z'
const AGENT_MARK_TAIL_D = 'M9 25L9 30L4 28Z'

const PAGES = ['popup.html', 'approve.html', 'ceremony.html']
const ICON_SIZES = [16, 32, 48, 128]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// Minimal PNG IHDR reader: width/height live at bytes 16-24 of any valid PNG.
function readPngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

describe('extension brand asset contract', () => {
  it('vibing_farmer.logo.svg is byte-identical to the Foundation product mark (no alternate wallet logo geometry)', () => {
    const logo = readFileSync(LOGO_SVG)
    const mark = readFileSync(MARK_SVG)
    expect(sha256(logo)).toBe(sha256(mark))
  })

  it('the extension ships exactly one logo SVG and it carries the frozen pocket/V geometry, never the AgentMark capsule+tail', () => {
    const svgFiles = readdirSync(EXT_DIR).filter((f) => f.endsWith('.svg'))
    expect(svgFiles).toEqual(['vibing_farmer.logo.svg'])
    const content = readFileSync(LOGO_SVG, 'utf8')
    expect(content).toContain(POCKET_D)
    expect(content).toContain(V_D)
    expect(content).not.toContain(AGENT_MARK_BODY_D)
    expect(content).not.toContain(AGENT_MARK_TAIL_D)
  })

  it('gen-ext-icons.mjs renders 16/32/48/128 PNGs from a source whose hash matches the frozen manifest entry', () => {
    execFileSync('node', [GEN_SCRIPT], { cwd: FRONTEND_DIR })
    const manifest = JSON.parse(readFileSync(ASSETS_MANIFEST, 'utf8'))
    const markEntry = manifest.find((e) => e.path === '/brand/vibing-farmer-mark.svg')
    expect(markEntry, 'manifest must record the mark entry').toBeTruthy()
    expect(sha256(readFileSync(LOGO_SVG))).toBe(markEntry.sha256)

    for (const size of ICON_SIZES) {
      const png = readFileSync(resolve(EXT_DIR, `icons/icon-${size}.png`))
      expect(readPngSize(png), `icon-${size}.png`).toEqual({ width: size, height: size })
    }
  })

  it('gen-ext-icons.mjs fails closed when the source SVG no longer hashes to the manifest entry', () => {
    const original = readFileSync(LOGO_SVG)
    writeFileSync(LOGO_SVG, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>\n')
    try {
      expect(() =>
        execFileSync('node', [GEN_SCRIPT], { cwd: FRONTEND_DIR, stdio: 'pipe' })
      ).toThrow()
    } finally {
      writeFileSync(LOGO_SVG, original)
    }
  })

  it('manifest.json reports the bumped MV3 version and defines no remote-origin CSP override', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_JSON, 'utf8'))
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.version).toBe('0.3.0')
    if (manifest.content_security_policy) {
      expect(JSON.stringify(manifest.content_security_policy)).not.toMatch(/https?:\/\//)
    }
  })

  it('popup/approve/ceremony HTML declare no remote font, script, image, or stylesheet dependency', () => {
    for (const file of PAGES) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(html, file).not.toMatch(/https?:\/\//)
    }
  })

  it('popup/approve/ceremony authored markup carries no em/en-dash design separator', () => {
    for (const file of PAGES) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(html, file).not.toMatch(/[–—]/)
    }
  })

  it('ceremony.html carries no decorative status dot and no generic eyebrow label', () => {
    const html = readFileSync(resolve(EXT_DIR, 'ceremony.html'), 'utf8')
    expect(html).not.toMatch(/class="[^"]*\bdot\b[^"]*"/)
    expect(html).not.toMatch(/class="[^"]*\beyebrow\b[^"]*"/)
  })

  it('approve.html and ceremony.html mark their root as a critical wallet screen (no entry animation)', () => {
    for (const file of ['approve.html', 'ceremony.html']) {
      const html = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(html, file).toMatch(/data-pocket-critical/)
    }
  })

  it('wallet.css and approval.css define the Pocket Crew tokens verbatim and fetch no remote font', () => {
    for (const file of ['wallet.css', 'approval.css']) {
      const css = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(css, file).not.toMatch(/url\(\s*['"]?https?:/)
      expect(css, file).not.toMatch(/@import\s+url\(\s*['"]?https?:/)
      // Locked hex values, copied verbatim from the visual contract -- never approximated.
      expect(css, file).toContain('--pc-field: #17251f')
      expect(css, file).toContain('--pc-grove: #20342b')
      expect(css, file).toContain('--pc-harvest: #dff56c')
      expect(css, file).toContain('--pc-rice: #f2f5ef')
      expect(css, file).toContain('--pc-danger: #e26e67')
      expect(css, file).toContain('--pc-radius-control: 12px')
      expect(css, file).toContain('--pc-radius-support: 16px')
      expect(css, file).toContain('--pc-radius-dominant: 24px')
      expect(css, file).toContain('--pc-touch-target: 44px')
      expect(css, file).toContain('--pc-control-height: 48px')
      // Day Field theme must exist too -- both themes ship in every extension page.
      expect(css, file).toMatch(/:root\[data-theme=['"]day-field['"]\]/)
    }
  })

  it('wallet.css declares the 360px wallet geometry verbatim', () => {
    const wallet = readFileSync(resolve(EXT_DIR, 'wallet.css'), 'utf8')
    expect(wallet).toMatch(/\.pc-wallet\s*\{[^}]*width:\s*360px/)
    expect(wallet).toMatch(/\.pc-wallet\s*\{[^}]*min-height:\s*560px/)
  })

  it('approval.css declares the shared wallet approval action grid verbatim', () => {
    const approval = readFileSync(resolve(EXT_DIR, 'approval.css'), 'utf8')
    expect(approval).toMatch(/\.pc-wallet-approval-actions\s*\{[^}]*grid-template-columns:\s*1fr 1\.35fr/)
  })

  it('no critical-screen stylesheet defines a gradient, glow, shimmer, pulse, or infinite animation', () => {
    for (const file of ['wallet.css', 'approval.css']) {
      const css = readFileSync(resolve(EXT_DIR, file), 'utf8')
      expect(css, file).not.toMatch(/@keyframes/)
      // `animation: none !important` is the contract's own critical-screen kill switch
      // ([data-pocket-critical]) -- only an actual non-"none" animation value is a violation, so
      // capture each declared value and check it directly rather than pattern-exclude "none"
      // (a bare negative lookahead here is defeatable by \s* backtracking to zero-width).
      const animationDecls = [...css.matchAll(/\banimation\s*:\s*([^;]+);/g)].map((m) =>
        m[1].trim()
      )
      for (const decl of animationDecls) {
        expect(decl, `${file}: animation: ${decl}`).toBe('none !important')
      }
      expect(css, file).not.toMatch(/linear-gradient|radial-gradient/)
    }
  })

  it('extension-dist ships the reviewed brand mark and network subset with no remote resource in the built HTML', () => {
    execFileSync('npm', ['run', 'build:ext'], { cwd: FRONTEND_DIR, stdio: 'pipe' })

    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-mark.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-mark-forest.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-mark-day.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/vibing-farmer-lockup-forest.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/networks/stellar.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/networks/stellar-white.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'brand/networks/base.svg'))).toBe(true)
    expect(existsSync(resolve(DIST_DIR, 'manifest.json'))).toBe(true)
    for (const size of ICON_SIZES) {
      expect(existsSync(resolve(DIST_DIR, `icons/icon-${size}.png`))).toBe(true)
    }

    for (const file of PAGES) {
      const html = readFileSync(resolve(DIST_DIR, file), 'utf8')
      // A built page may legitimately embed a data:image/svg+xml,... URI whose payload contains
      // the SVG namespace string "http://www.w3.org/2000/svg" -- that is a fully-inlined asset,
      // not a fetch. Only a real fetchable attribute/url() pointed at a remote origin counts.
      expect(html, file).not.toMatch(/(?:href|src)\s*=\s*["']https?:\/\//)
      expect(html, file).not.toMatch(/url\(\s*['"]?https?:\/\//)
    }
  }, 30000)
})
