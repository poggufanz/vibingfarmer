import { describe, it, expect } from 'vitest'
import { shortAddr, agoText, remainText, mandateRemaining } from './consoleUtils.js'

describe('consoleUtils', () => {
  it('shortAddr 6…4', () => {
    expect(shortAddr('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD4F2A')).toBe('GABCDE…4F2A')
    expect(shortAddr(null)).toBe('')
  })
  it('agoText buckets', () => {
    const now = 1_000_000_000_000
    expect(agoText(null, now)).toBe('-')
    expect(agoText(now - 12_000, now)).toBe('12s ago')
    expect(agoText(now - 3 * 60_000, now)).toBe('3 min ago')
    expect(agoText(now - 2 * 3_600_000, now)).toBe('2 hr ago')
  })
  it('remainText buckets', () => {
    expect(remainText(0)).toBe('now')
    expect(remainText(45_000)).toBe('45s')
    expect(remainText(3 * 60_000 + 12_000)).toBe('3m 12s')
    expect(remainText(23 * 3_600_000 + 12 * 60_000)).toBe('23h 12m')
  })
  it('mandateRemaining frac of 24h', () => {
    const nowS = 1_000_000
    expect(mandateRemaining({ mandateExpiry: nowS + 43_200 }, nowS)).toEqual({
      leftS: 43_200,
      frac: 0.5,
    })
    expect(mandateRemaining({ mandateExpiry: nowS - 1 }, nowS)).toEqual({ leftS: 0, frac: 0 })
    expect(mandateRemaining(null, nowS)).toEqual({ leftS: 0, frac: 0 })
  })
})
