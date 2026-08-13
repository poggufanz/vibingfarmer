import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

describe('VF Wallet stylesheet boundary', () => {
  it('links the local wallet stylesheet and removes the dark Acid prepaint', () => {
    const html = read('extension/popup.html')
    expect(html).toContain('<link rel="stylesheet" href="./wallet.css">')
    expect(html).toContain('data-theme="forest"')
    expect(html).not.toContain('#0e0f0c')
    expect(html).not.toMatch(/<style[ >]/i)
  })

  it('keeps WalletShell structural and the stylesheet owns locked geometry', () => {
    const source = read('src/wallet/ui/WalletShell.jsx')
    const css = read('extension/wallet.css')
    expect(source).not.toMatch(/const STYLE|<style|\{STYLE\}/)
    expect(css).toMatch(/\.pc-wallet\s*\{[\s\S]*width:\s*360px/)
    expect(css).toMatch(/min-height:\s*560px/)
    expect(css).toMatch(/\.pc-wallet-header[\s\S]*min-height:\s*56px/)
    expect(css).toMatch(/\.pc-wallet-main[\s\S]*padding:\s*20px\s+18px\s+24px/)
    expect(css).toMatch(/\.pc-wallet h1[\s\S]*font-size:\s*28px/)
    expect(css).toMatch(/\.pc-balance[\s\S]*font-size:\s*44px/)
    expect(css).toMatch(/--pc-control-height:\s*48px/)
    expect(css).toMatch(/max-width:\s*359px/)
    expect(css).toMatch(/prefers-reduced-motion/)
    expect(css).not.toMatch(/gradient|glow|shimmer|@keyframes|https?:\/\//i)
  })
})
