// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TweaksPanel } from './tweaks-panel.jsx'

const here = path.dirname(fileURLToPath(import.meta.url))
const panelCss = fs.readFileSync(path.join(here, 'tweaks-panel.css'), 'utf8')
const panelSource = fs.readFileSync(path.join(here, 'tweaks-panel.jsx'), 'utf8')

afterEach(cleanup)

function activatePanel() {
  fireEvent(window, new MessageEvent('message', { data: { type: '__activate_edit_mode' } }))
}

async function renderOpenPanel() {
  render(
    <TweaksPanel title="Tweaks">
      <button type="button">First control</button>
      <label>
        Second control
        <input aria-label="Second control" />
      </label>
    </TweaksPanel>
  )
  activatePanel()
  return screen.findByRole('complementary', { name: 'Tweaks' })
}

describe('TweaksPanel CAP-19 visual contract', () => {
  it('mounts one labelled landmark and keeps controls in reading order', async () => {
    const panel = await renderOpenPanel()

    expect(screen.getByRole('heading', { level: 2, name: 'Tweaks' })).toBeTruthy()
    const controls = [...panel.querySelectorAll('button, input, select, textarea, a[href]')]
    expect(
      controls.map((control) => control.getAttribute('aria-label') || control.textContent)
    ).toEqual(['Close tweaks', 'First control', 'Second control'])
    for (const control of controls) {
      control.focus()
      expect(document.activeElement).toBe(control)
    }
  })

  it('uses the Pocket Crew focus, narrow-viewport, and reduced-motion contracts', () => {
    expect(panelCss).toContain('inline-size: min(280px, calc(100vw - (2 * var(--pc-space-4))))')
    expect(panelCss).toContain('@media (max-width: 360px)')
    expect(panelCss).toMatch(
      /\.twk-panel :where\(button, input, select, textarea\):focus-visible\s*\{[\s\S]*outline: 3px solid var\(--pc-focus\)/
    )
    expect(panelCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(panelCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.twk-panel[\s\S]*transition: none/
    )
    expect(panelCss).not.toMatch(/linear-gradient|radial-gradient|backdrop-filter|2147483646/)
  })

  it('stays a visual-only conditional panel without route or data readers', () => {
    expect(panelSource).not.toMatch(/useNavigate|useLocation|fetch\(|localStorage|sessionStorage/)
    expect(panelSource).not.toContain('<style>')
    expect(panelSource).toContain("type: '__edit_mode_available'")
    expect(panelSource).toContain("type: '__edit_mode_set_keys'")
    expect(panelSource).toContain("type: '__edit_mode_dismissed'")
  })

  it('still responds to the existing host deactivation protocol', async () => {
    await renderOpenPanel()
    fireEvent(window, new MessageEvent('message', { data: { type: '__deactivate_edit_mode' } }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Tweaks' })).toBeNull())
  })
})
