import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, 'approval.css'), 'utf8')
const html = readFileSync(path.join(here, 'approve.html'), 'utf8')
const viewSource = readFileSync(path.join(here, 'approvalView.js'), 'utf8')

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('VF Wallet approval visual contract', () => {
  it('loads only the local approval stylesheet and keeps raw disclosure labelled', () => {
    expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="\.\/approval\.css"\s*\/>/)
    expect(html).not.toMatch(/style\s*=/i)
    expect(viewSource).toMatch(/Technical details/)
    expect(viewSource).toMatch(/id:\s*['"]raw-details['"]/)
  })

  it('keeps critical approval CSS calm and local', () => {
    const declarations = withoutComments(css)
    expect(declarations).not.toMatch(/gradient|glow|shimmer|pulse|@keyframes/i)
    expect(css).not.toMatch(/https?:\/\//i)
    expect(css).toMatch(/\[data-pocket-critical\][\s\S]*animation:\s*none\s*!important/)
    expect(css).toMatch(/prefers-reduced-motion\s*:\s*reduce/)
  })

  it('keeps controls keyboard/touch reachable and action buttons equal', () => {
    expect(css).toMatch(/--pc-touch-target:\s*44px/)
    expect(css).toMatch(
      /\.pc-wallet-approval-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    )
    expect(css).toMatch(/\.pc-button\s*\{[\s\S]*min-height:\s*var\(--pc-control-height\)/)
    expect(css).toMatch(/\.pc-input\s*\{[\s\S]*min-height:\s*var\(--pc-control-height\)/)
    expect(css).toMatch(
      /:where\(a,\s*button,\s*input,\s*select,\s*textarea,\s*summary\):focus-visible/
    )
  })

  it('wraps the 320px shell and long security values without an inline style escape hatch', () => {
    expect(css).toMatch(/min-width:\s*320px/)
    expect(css).toMatch(/\.pc-wallet-origin \.pc-technical\s*\{[\s\S]*overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.pc-wallet-consequence p\s*\{[\s\S]*overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.pc-approval-table td\s*\{[\s\S]*word-break:\s*break-word/)
    expect(viewSource).not.toMatch(/\.style\s*\./)
    expect(viewSource).toMatch(/pc-technical-wrap--hidden/)
  })
})
