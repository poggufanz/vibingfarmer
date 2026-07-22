// frontend/src/components/pocket/BrandLockup.jsx
// Product identity lockup -- the fixed Vibing Farmer pocket mark (Foundation Task 3 SVGs) plus
// an optional wordmark. The wordmark is real DOM text, not baked into the SVG, so it stays crisp
// and localizable (Foundation Task 5, brief Step 2). `tone='auto'` reads the theme the same way
// pocket-crew.css already does -- document.documentElement's `data-theme` attribute -- so this
// component needs no theme prop or context of its own; it just asks the DOM the same question
// CSS already asks.
import { THEME_IDS, currentDomTheme, normalizeTheme } from '../../design/theme.js'

const MARK_SRC = Object.freeze({
  [THEME_IDS.FOREST]: '/brand/vibing-farmer-mark-forest.svg',
  [THEME_IDS.DAY_FIELD]: '/brand/vibing-farmer-mark-day.svg',
  mono: '/brand/vibing-farmer-mark-mono.svg',
})

function resolveMarkSrc(tone) {
  if (tone === 'mono') return MARK_SRC.mono
  const themeId = tone === 'auto' ? currentDomTheme() : normalizeTheme(tone)
  return MARK_SRC[themeId]
}

export function BrandLockup({ variant = 'full', tone = 'auto', className = '' }) {
  const isCompact = variant === 'compact'
  const src = resolveMarkSrc(tone)
  const rootClassName = `pc-brand-lockup pc-brand-lockup--${variant}${
    className ? ` ${className}` : ''
  }`

  return (
    <span className={rootClassName}>
      <img
        src={src}
        // Compact has no visible wordmark, so the mark itself carries the accessible name;
        // full shows the name as real text below, so the mark stays decorative (alt="") to
        // avoid two competing accessible names for the same lockup.
        alt={isCompact ? 'Vibing Farmer' : ''}
        width={32}
        height={32}
        className="pc-brand-mark"
      />
      {!isCompact && <span className="pc-wordmark pc-brand-wordmark">Vibing Farmer</span>}
    </span>
  )
}
