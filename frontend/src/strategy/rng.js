// frontend/src/strategy/rng.js
// Deterministic seeded PRNG for reproducible Monte Carlo runs. mulberry32 gives a
// uniform [0,1) stream; Box-Muller turns two uniforms into a standard normal sample.
// Pure — never touches global Math.random, so every simulated future is replayable
// from its seed and unit tests can assert exact values. No dependencies.

/**
 * mulberry32 — tiny fast 32-bit PRNG.
 * @param {number} seed integer seed
 * @returns {() => number} function yielding the next uniform in [0, 1)
 */
export function makeRng(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * One standard-normal sample via Box-Muller, scaled to (mean, stdDev).
 * @param {() => number} rng a uniform [0,1) generator from makeRng
 * @param {number} [mean]
 * @param {number} [stdDev]
 * @returns {number}
 */
export function gaussian(rng, mean = 0, stdDev = 1) {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return mean + z * stdDev
}
