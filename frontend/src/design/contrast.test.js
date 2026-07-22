import { describe, expect, it } from 'vitest'
import { CONTRAST_REQUIREMENTS, contrastRatio, relativeLuminance } from './contrast.js'

const EXPECTED_REQUIREMENTS = [
  ['forest.text/canvas', '#F2F5EF', '#17251F', 4.5],
  ['forest.text/workspace', '#F2F5EF', '#20342B', 4.5],
  ['forest.muted/canvas', '#A8B5AD', '#17251F', 4.5],
  ['forest.muted/workspace', '#A8B5AD', '#20342B', 4.5],
  ['forest.ownedInk/owned', '#17251F', '#F2F5EF', 4.5],
  ['forest.ownedMuted/owned', '#536159', '#F2F5EF', 4.5],
  ['forest.harvestInk/harvest', '#17251F', '#DFF56C', 4.5],
  ['forest.danger/canvas', '#E26E67', '#17251F', 4.5],
  ['forest.dangerBoundary/workspace', '#E26E67', '#20342B', 3],
  ['forest.dangerOnLight/owned', '#A8403C', '#F2F5EF', 4.5],
  ['forest.dangerInk/danger', '#17251F', '#E26E67', 4.5],
  ['forest.disabledOnDark/canvas', '#8C9B93', '#17251F', 4.5],
  ['forest.disabledOnDark/workspace', '#8C9B93', '#20342B', 4.5],
  ['forest.disabledOnLight/owned', '#5F6C65', '#F2F5EF', 4.5],
  ['forest.focusOnDark/canvas', '#DFF56C', '#17251F', 3],
  ['forest.focusOnDark/workspace', '#DFF56C', '#20342B', 3],
  ['forest.focusOnLight/owned', '#17251F', '#F2F5EF', 3],
  ['forest.focusOnLight/harvest', '#17251F', '#DFF56C', 3],
  ['day.text/canvas', '#17251F', '#E9EEE8', 4.5],
  ['day.text/workspace', '#17251F', '#F7F9F5', 4.5],
  ['day.text/owned', '#17251F', '#F2F5EF', 4.5],
  ['day.muted/canvas', '#536159', '#E9EEE8', 4.5],
  ['day.muted/workspace', '#536159', '#F7F9F5', 4.5],
  ['day.muted/owned', '#536159', '#F2F5EF', 4.5],
  ['day.harvestInk/harvest', '#17251F', '#DFF56C', 4.5],
  ['day.danger/canvas', '#A8403C', '#E9EEE8', 4.5],
  ['day.danger/workspace', '#A8403C', '#F7F9F5', 4.5],
  ['day.danger/owned', '#A8403C', '#F2F5EF', 4.5],
  ['day.dangerInk/danger', '#F2F5EF', '#A8403C', 4.5],
  ['day.disabled/canvas', '#5F6C65', '#E9EEE8', 4.5],
  ['day.disabled/workspace', '#5F6C65', '#F7F9F5', 4.5],
  ['day.disabled/owned', '#5F6C65', '#F2F5EF', 4.5],
  ['day.focus/canvas', '#17251F', '#E9EEE8', 3],
  ['day.focus/workspace', '#17251F', '#F7F9F5', 3],
  ['day.focus/owned', '#17251F', '#F2F5EF', 3],
  ['day.focus/harvest', '#17251F', '#DFF56C', 3],
]

describe('Pocket Crew contrast contract', () => {
  it('keeps the exhaustive requirements immutable and exact', () => {
    expect(CONTRAST_REQUIREMENTS).toEqual(EXPECTED_REQUIREMENTS)
    expect(Object.isFrozen(CONTRAST_REQUIREMENTS)).toBe(true)
    CONTRAST_REQUIREMENTS.forEach((requirement) => expect(Object.isFrozen(requirement)).toBe(true))
  })

  it.each(EXPECTED_REQUIREMENTS)(
    '%s meets its minimum ratio',
    (_name, foreground, background, minimum) => {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minimum)
    }
  )

  it('calculates standards-correct luminance and symmetric contrast', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#FFFFFF')).toBe(1)
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21)
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21)
  })

  it.each([['red'], ['#fff'], ['#FFFFFG'], ['#12345678'], [''], [null], [undefined], [42]])(
    'rejects malformed color %s',
    (color) => {
      expect(() => relativeLuminance(color)).toThrow(TypeError)
      expect(() => contrastRatio(color, '#FFFFFF')).toThrow(TypeError)
      expect(() => contrastRatio('#FFFFFF', color)).toThrow(TypeError)
    }
  )

  it('throws TypeError without coercing hostile malformed values', () => {
    const hostile = {
      toString() {
        throw new Error('must not coerce')
      },
    }

    expect(() => relativeLuminance(hostile)).toThrow(TypeError)
    expect(() => contrastRatio(hostile, '#FFFFFF')).toThrow(TypeError)
    expect(() => contrastRatio('#FFFFFF', hostile)).toThrow(TypeError)
  })
})
