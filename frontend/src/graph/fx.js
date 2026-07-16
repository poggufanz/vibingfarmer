// frontend/src/graph/fx.js
// Time-based animation envelopes + background dust. Pure: (elapsed ms) → view params,
// null when the effect is over.

export const DUST_COUNT = 26
export const WAVE_MS = 2500

export const corePulseScale = (tMs) => 1 + 0.04 * Math.sin(tMs / 600)

export const coronaAlpha = (tMs) => 0.35 + 0.2 * Math.sin(tMs / 300)

export const settleRing = (elapsedMs, durMs = 700) =>
  elapsedMs >= durMs
    ? null
    : { scale: 1 + 2.2 * (elapsedMs / durMs), alpha: 0.8 * (1 - elapsedMs / durMs) }

export const failFlicker = (elapsedMs, durMs = 900) =>
  elapsedMs >= durMs ? null : { alpha: Math.floor(elapsedMs / 150) % 2 === 0 ? 1 : 0.25 }

export const waveT = (elapsedMs, durMs = WAVE_MS) => (elapsedMs >= durMs ? null : elapsedMs / durMs)

export const spawnDust = (w, h, count, rand = Math.random) =>
  Array.from({ length: count }, () => ({
    x: rand() * w,
    y: rand() * h,
    vx: (rand() - 0.5) * 0.12,
    vy: (rand() - 0.5) * 0.08,
    size: 0.6 + rand() * 1.4,
    alpha: 0.05 + rand() * 0.13,
  }))

export const stepDust = (dust, delta, w, h) =>
  dust.map((d) => ({
    ...d,
    x: (((d.x + d.vx * delta) % w) + w) % w,
    y: (((d.y + d.vy * delta) % h) + h) % h,
  }))
