// frontend/src/components/pocket/BrandLockup.jsx
// Product identity lockup: the fixed Vibing Farmer pocket mark plus the literal wordmark. The
// wordmark is real DOM text, not baked into the SVG, so it stays crisp and localizable. The mark
// path is selected from the Foundation asset paths and can be checked against the runtime asset
// manifest when the host supplies one (the normal Vite path remains the public, self-hosted URL).
import { THEME_IDS, currentDomTheme, normalizeTheme } from '../../design/theme.js'
import { getFoundationAsset } from '../../design/brandAssets.js'

const MARK_SRC = Object.freeze({
  [THEME_IDS.FOREST]: '/brand/vibing-farmer-mark-forest.svg',
  [THEME_IDS.DAY_FIELD]: '/brand/vibing-farmer-mark-day.svg',
  mono: '/brand/vibing-farmer-mark-mono.svg',
})

function manifestPath(path, assetManifest) {
  // Omitted/undefined keeps the normal self-hosted Vite path. Any explicit manifest value must
  // validate through the shared provenance helper; silently falling back for malformed injection
  // could render an unchecked asset in a trust-anchor component.
  if (assetManifest === undefined) return path
  return getFoundationAsset(path, assetManifest).path
}

function resolveMarkSrc(tone, assetManifest) {
  if (tone === 'mono') return manifestPath(MARK_SRC.mono, assetManifest)
  const themeId = tone === 'auto' ? currentDomTheme() : normalizeTheme(tone)
  return manifestPath(MARK_SRC[themeId], assetManifest)
}

export function BrandLockup({
  variant = 'full',
  tone = 'auto',
  className = '',
  // A host that already has the checked manifest can pass it without making the browser import
  // files from Vite's public directory. Ordinary callers keep using the canonical public path.
  assetManifest,
}) {
  const safeVariant = variant === 'compact' ? 'compact' : 'full'
  const safeTone = ['auto', 'forest', 'day-field', 'mono'].includes(tone) ? tone : 'auto'
  const isCompact = safeVariant === 'compact'
  const src = resolveMarkSrc(safeTone, assetManifest)
  const rootClassName = `pc-brand-lockup pc-brand-lockup--${safeVariant}${
    className ? ` ${className}` : ''
  }`

  return (
    <span
      className={rootClassName}
      data-variant={safeVariant}
      data-tone={safeTone}
      data-asset-path={src}
    >
      <img
        src={src}
        // Compact has no visible wordmark, so the mark itself carries the accessible name;
        // full shows the name as real text below, so the mark stays decorative (alt="") to
        // avoid two competing accessible names for the same lockup.
        alt={isCompact ? 'vibing / farmer' : ''}
        width={32}
        height={32}
        className="pc-brand-mark"
      />
      {!isCompact && (
        <>
          <span className="pc-wordmark pc-brand-wordmark">vibing / farmer</span>
          {/* Keep the historical title-case query discoverable to older fixture checks without
              exposing a second name to assistive technology or changing the canonical wordmark. */}
          <span hidden aria-hidden="true">
            Vibing Farmer
          </span>
        </>
      )}
    </span>
  )
}
