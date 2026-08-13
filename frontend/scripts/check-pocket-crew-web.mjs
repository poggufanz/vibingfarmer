// Secondary Pocket Crew boundary. This scanner owns only the explicitly listed web route and
// shared sources. Foundation and Core surfaces keep their own enforcement boundaries; Wallet and
// extension sources are outside this walk by design.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FOUNDATION_FILES } from './check-pocket-crew-foundation.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')

// Keep this inventory explicit. A broad src/** scan would trespass into Core, Wallet, extension,
// fixtures, and dormant feature code owned by another worker. Every path here is relative to the
// frontend root and is intentionally production-only.
export const WEB_PRODUCTION_FILES = Object.freeze([
  'src/components/LandingHero.css',
  'src/components/LandingHero.jsx',
  'src/components/LandingFx.jsx',
  'src/components/NavBar.jsx',
  'src/components/NavBar.css',
  'src/components/OnboardingFlow.jsx',
  'src/components/OnboardingFlow.css',
  'src/components/ExplorerPage.jsx',
  'src/components/ExplorerPage.css',
  'src/components/EcosystemPage.jsx',
  'src/components/EcosystemPage.css',
  'src/components/ReplayPage.jsx',
  'src/components/ReplayPage.css',
  'src/components/HistoryPanel.jsx',
  'src/components/HistoryPanel.css',
  'src/components/VaultDetailPage.jsx',
  'src/components/VaultDetailPage.css',
  'src/components/TxDetailPage.jsx',
  'src/components/TxDetailPage.css',
  'src/developers/DevelopersLayout.jsx',
  'src/developers/OverviewSection.jsx',
  'src/developers/UsageSection.jsx',
  'src/developers/DocsSection.jsx',
  'src/developers/KeysSection.jsx',
  'src/developers/CodeBlock.jsx',
  'src/developers/Developers.css',
  'src/components/SkillDrawer.jsx',
  'src/components/SkillEditModal.jsx',
  'src/components/SkillDetailModal.jsx',
  'src/components/SettingsPage.jsx',
  'src/skills.jsx',
  'src/screens.jsx',
  'src/sparkline.js',
  'src/components/NotificationCenter.jsx',
  'src/components/AlertCard.jsx',
  'src/components/SecondaryDialogs.css',
  'src/agents.jsx',
  'style.css',
])

export const WEB_EXCLUDED_PATHS = Object.freeze(['frontend/src/wallet/**', 'frontend/extension/**'])

const FOUNDATION_RELATIVE_FILES = Object.freeze(
  FOUNDATION_FILES.map(([, filePath]) => relative(DEFAULT_ROOT, filePath).replaceAll('\\', '/'))
)

const ALLOWED_Z_INDEXES = new Set([0, 20, 40, 80, 90, 100])
const ESSENTIAL_ANIMATION_SELECTORS = new Set([
  '.think-spin',
  '.exec-row.active .exec-marker::after',
  '.wd-stage--running .wd-stage-dot',
  '.notif-live-dot',
  '.legend-item .dot.running',
  '.agent-tile-head .dot.running',
  '.memory-row.running .memory-row-marker',
  '.loop-pulse.live::after, .loop-pulse.cycling::after',
  '.loop-rail.sleeping .loop-stage',
])
const COMPATIBILITY_TOKENS = Object.freeze([
  '--text',
  '--text-primary',
  '--bg-canvas',
  '--bg-base',
  '--bg-input',
  '--accent',
  '--accent-fg',
  '--accent-soft',
  '--border-accent',
  '--text-faint',
  '--text-muted',
  '--info',
  '--warn',
  '--warning',
  '--ok',
  '--danger',
])

const escapeRegExp = (value) => value.replace(/[\\^$*+?.()|[\]{}]/gu, '\\$&')
const COMPATIBILITY_FALLBACK_PATTERN = new RegExp(
  `var\\(\\s*(?:${COMPATIBILITY_TOKENS.map(escapeRegExp).join('|')})\\s*,`,
  'giu'
)

function maskComments(source) {
  const chars = source.split('')
  let quote = null

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    const next = chars[index + 1]

    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }

    if (char === '/' && next === '/') {
      chars[index] = ' '
      index += 1
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' '
        index += 1
      }
      index -= 1
      continue
    }

    if (char === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 2
      while (index < chars.length) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          chars[index] = ' '
          chars[index + 1] = ' '
          index += 1
          break
        }
        if (chars[index] !== '\n') chars[index] = ' '
        index += 1
      }
    }
  }

  return chars.join('')
}

function maskStrings(source) {
  const chars = source.split('')
  let quote = null

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (!quote) {
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        chars[index] = ' '
      }
      continue
    }

    if (char === '\\') {
      chars[index] = ' '
      if (index + 1 < chars.length && chars[index + 1] !== '\n') chars[index + 1] = ' '
      index += 1
      continue
    }

    if (char === quote) {
      chars[index] = ' '
      quote = null
    } else if (char !== '\n') {
      chars[index] = ' '
    }
  }

  return chars.join('')
}

function sourceLocation(source, index) {
  const before = source.slice(0, index)
  const line = before.split('\n').length
  const lastNewline = before.lastIndexOf('\n')
  return { line, column: index - lastNewline }
}

function makeFinding(code, path, source, index, message) {
  const location = sourceLocation(source, Math.max(0, index))
  return Object.freeze({ code, path, line: location.line, column: location.column, message })
}

function collectMatches(findings, source, path, code, pattern, message) {
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(source)) !== null) {
    findings.push(makeFinding(code, path, source, match.index, message))
    if (match[0].length === 0) pattern.lastIndex += 1
  }
}

function isEssentialAnimation(source, declarationIndex) {
  const openingBrace = source.lastIndexOf('{', declarationIndex)
  if (openingBrace < 0) return false

  const selectorStart = source.lastIndexOf('}', openingBrace) + 1
  const selector = source
    .slice(selectorStart, openingBrace)
    .replace(/\s+/gu, ' ')
    .split('{')
    .at(-1)
    .trim()
  return ESSENTIAL_ANIMATION_SELECTORS.has(selector)
}

function collectInfiniteAnimationFindings(findings, source, path) {
  const pattern = /\banimation(?:-[a-z-]+)?\s*:[^;{}\n]*\binfinite\b/giu
  let match
  while ((match = pattern.exec(source)) !== null) {
    if (!isEssentialAnimation(source, match.index)) {
      findings.push(
        makeFinding(
          'INFINITE_ANIMATION',
          path,
          source,
          match.index,
          'infinite animation is not allowed on web routes'
        )
      )
    }
    if (match[0].length === 0) pattern.lastIndex += 1
  }
}

function normalizedPath(path) {
  return typeof path === 'string' ? path.replaceAll('\\', '/') : ''
}

function pathIsExcluded(path) {
  const normalized = normalizedPath(path).replace(/^\.\//u, '')
  return (
    /(?:^|\/)frontend\/extension(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)extension(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)frontend\/src\/wallet(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)src\/wallet(?:\/|$)/iu.test(normalized)
  )
}

function isTestOrFixturePath(path) {
  return (
    /(?:^|\/)(?:__tests__|tests?|fixtures?|build|dist|coverage|test-results|node_modules)(?:\/|$)/iu.test(
      path
    ) || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/iu.test(path)
  )
}

function collectJsxInlineLayerFindings(findings, source, path) {
  const layerPattern = /\b(?:z-index|zIndex)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)/giu
  let match
  layerPattern.lastIndex = 0
  while ((match = layerPattern.exec(source)) !== null) {
    const literal = match[1]
    const value = Number(literal)
    if (ALLOWED_Z_INDEXES.has(value)) continue
    findings.push(
      makeFinding(
        'LAYER_LITERAL',
        path,
        source,
        match.index,
        `literal z-index ${literal} is outside the Pocket Crew layer scale`
      )
    )
  }
}

function collectQuotedJsxLayerFindings(findings, source, path) {
  const stylePattern = /\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/giu
  const layerPattern = /\b(?:z-index|zIndex)\s*[:=]\s*(?:(['"])([-+]?\d+(?:\.\d+)?)\1)/giu
  let styleMatch
  while ((styleMatch = stylePattern.exec(source)) !== null) {
    layerPattern.lastIndex = 0
    let layerMatch
    while ((layerMatch = layerPattern.exec(styleMatch[1])) !== null) {
      const literal = layerMatch[2]
      const value = Number(literal)
      if (ALLOWED_Z_INDEXES.has(value)) continue
      findings.push(
        makeFinding(
          'LAYER_LITERAL',
          path,
          source,
          styleMatch.index + styleMatch[0].indexOf(styleMatch[1]) + layerMatch.index,
          `literal z-index ${literal} is outside the Pocket Crew layer scale`
        )
      )
    }
  }
}

function collectRadiusFindings(findings, source, path) {
  const declaration = /\bborder-radius(?:-[a-z-]+)?\s*:\s*([^;{}\n]+)/giu
  const offLock = /(?<![\w.-])(?:4|8|14|18)(?:px|rem|em|%)\b/giu
  let declarationMatch
  while ((declarationMatch = declaration.exec(source)) !== null) {
    offLock.lastIndex = 0
    let radiusMatch
    while ((radiusMatch = offLock.exec(declarationMatch[1])) !== null) {
      findings.push(
        makeFinding(
          'OFF_LOCK_RADIUS',
          path,
          source,
          declarationMatch.index +
            declarationMatch[0].indexOf(declarationMatch[1]) +
            radiusMatch.index,
          'border radii must use the 12/16/24/999 shape lock'
        )
      )
    }
  }
}

/**
 * Scan one explicit web source against the Secondary Pocket Crew boundary.
 *
 * Comments and string contents are masked before declaration checks so historical explanations and
 * fixture prose do not become style hits. JSX class attributes are checked separately for retired
 * selectors before string masking.
 *
 * @param {string} text
 * @param {string} path
 * @returns {Array<{code:string,path:string,line:number,column:number,message:string}>}
 */
export function scanWebSource(text, path) {
  const normalized = normalizedPath(path)
  if (
    typeof text !== 'string' ||
    !normalized ||
    pathIsExcluded(normalized) ||
    isTestOrFixturePath(normalized)
  ) {
    return []
  }

  const commentMasked = maskComments(text)
  const active = maskStrings(commentMasked)
  const findings = []

  collectMatches(
    findings,
    active,
    normalized,
    'RETIRED_STYLE',
    /\bacid(?:-yield)?\b|#cfff3d\b|#0e0f0c\b|#1a1b16\b|\bbtn-lava\b/giu,
    'retired Acid-Yield selector or color is not allowed'
  )
  collectMatches(
    findings,
    commentMasked,
    normalized,
    'RETIRED_STYLE',
    /\b(?:class|className)\s*=\s*(['"])[^'"\n]*?(?:acid(?:-yield)?|btn-lava)[^'"\n]*?\1/giu,
    'retired Acid-Yield selector or color is not allowed'
  )
  collectMatches(
    findings,
    active,
    normalized,
    'UNAPPROVED_EFFECT',
    /(?:\b(?:linear|radial|conic)-gradient\s*\(|\b(?:glow|shimmer)\b|\bbox-shadow\s*:(?!\s*(?:none|inset)\b)\s*[^;{}\n]*\b0\s+0\s+\d+(?:px|rem|em)\b|\bbackdrop-filter\s*:\s*(?!none\b))/giu,
    'gradient, glow, shimmer, and backdrop effects are not allowed on web routes'
  )
  collectMatches(
    findings,
    active,
    normalized,
    'REPEAT_FOREVER',
    /\brepeat\s*:\s*-1\b/giu,
    'repeat: -1 is not allowed'
  )
  collectInfiniteAnimationFindings(findings, active, normalized)
  collectMatches(
    findings,
    active,
    normalized,
    'COMPAT_FALLBACK',
    COMPATIBILITY_FALLBACK_PATTERN,
    'hardcoded compatibility-token fallbacks are not allowed'
  )

  collectRadiusFindings(findings, active, normalized)

  const literalLayerPattern = /\bz-index\s*:\s*([-+]?\d+(?:\.\d+)?)/giu
  let layerMatch
  while ((layerMatch = literalLayerPattern.exec(active)) !== null) {
    const value = Number(layerMatch[1])
    if (ALLOWED_Z_INDEXES.has(value)) continue
    findings.push(
      makeFinding(
        'LAYER_LITERAL',
        normalized,
        active,
        layerMatch.index,
        `literal z-index ${layerMatch[1]} is outside the Pocket Crew layer scale`
      )
    )
  }
  collectJsxInlineLayerFindings(findings, active, normalized)
  collectQuotedJsxLayerFindings(findings, commentMasked, normalized)

  if (/\.jsx?$/iu.test(normalized) && !isTestOrFixturePath(normalized)) {
    collectMatches(
      findings,
      active,
      normalized,
      'EMBEDDED_STYLE',
      /<style\b/giu,
      'production route sources must not embed a <style> block'
    )
  }

  const order = new Map(
    [
      'RETIRED_STYLE',
      'UNAPPROVED_EFFECT',
      'REPEAT_FOREVER',
      'INFINITE_ANIMATION',
      'OFF_LOCK_RADIUS',
      'LAYER_LITERAL',
      'COMPAT_FALLBACK',
      'EMBEDDED_STYLE',
    ].map((code, index) => [code, index])
  )
  findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      (order.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
      left.message.localeCompare(right.message)
  )

  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.path}\u0000${finding.line}\u0000${finding.column}\u0000${finding.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveFrontendRoot(root) {
  const candidate = resolve(root)
  if (existsSync(resolve(candidate, 'src'))) return candidate
  const nested = resolve(candidate, 'frontend')
  if (existsSync(resolve(nested, 'src'))) return nested
  return candidate
}

function missingFinding(path, message) {
  return makeFinding('LEGACY_SCOPE', path, '', 0, message)
}

/**
 * Run the Secondary web check against WEB_PRODUCTION_FILES. Foundation's ten files are reported
 * as delegated rather than scanned a second time.
 *
 * @param {{root?:string}} input
 * @returns {{ok:boolean,findings:Array,filesChecked:number,delegatedFoundationFiles:Array<string>,excludedPaths:Array<string>,report:string}}
 */
export function runWebCheck(input) {
  const { root = DEFAULT_ROOT } = input ?? {}
  if (typeof root !== 'string' || root.trim().length === 0) {
    const finding = missingFinding('(root)', 'web check requires a non-empty frontend root')
    return {
      ok: false,
      findings: [finding],
      filesChecked: 0,
      delegatedFoundationFiles: [...FOUNDATION_RELATIVE_FILES],
      excludedPaths: [...WEB_EXCLUDED_PATHS],
      report: 'web production files checked: 0; delegated Foundation files: 10',
    }
  }

  const frontendRoot = resolveFrontendRoot(root)
  const findings = []
  for (const relativePath of WEB_PRODUCTION_FILES) {
    const normalized = normalizedPath(relativePath)
    if (pathIsExcluded(normalized) || isTestOrFixturePath(normalized)) continue
    const filePath = resolve(frontendRoot, normalized)
    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch (error) {
      findings.push(
        missingFinding(
          normalized,
          `web production source is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      continue
    }
    findings.push(...scanWebSource(source, normalized))
  }

  const report = `web production files checked: ${WEB_PRODUCTION_FILES.length}; delegated Foundation files: ${FOUNDATION_RELATIVE_FILES.length}`
  return {
    ok: findings.length === 0,
    findings,
    filesChecked: WEB_PRODUCTION_FILES.length,
    delegatedFoundationFiles: [...FOUNDATION_RELATIVE_FILES],
    excludedPaths: [...WEB_EXCLUDED_PATHS],
    report,
  }
}

const THIS_FILE = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  const result = runWebCheck({ root: DEFAULT_ROOT })
  if (!result.ok) {
    console.error(`web:check FAILED — ${result.report}`)
    for (const finding of result.findings) {
      console.error(
        `  - ${finding.code} ${finding.path}:${finding.line}:${finding.column} — ${finding.message}`
      )
    }
    process.exitCode = 1
  } else {
    console.log(`web:check OK — ${result.report}`)
  }
}
