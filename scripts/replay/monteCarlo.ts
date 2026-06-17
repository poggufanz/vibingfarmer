// scripts/replay/monteCarlo.ts
// Folds ground-truth fork exits into outcomes. MANUAL exit delay ~ lognormal
// (median ~25 min, p95 ~2 h) → real variance → Monte Carlo band. AGENTIC exit is
// deterministic: the tx lands in the first block after the signal (~12-24s); sub-block
// timing is meaningless, so no MC theater. Output is seeded (reproducible) and carries
// its assumptions in metadata — never hidden.
type Ground = Record<string, number | string>;

// forge's vm.serializeUint emits uint256 values above Number.MAX_SAFE_INTEGER as JSON
// strings (e.g. delay_2 = "700875391021734441116") — coerce via Number() for interpolation.
const DELAY_KEYS = (g: Ground) =>
  Object.keys(g)
    .filter((k) => k.startsWith('delay_'))
    .map((k) => ({ delay: Number(k.slice('delay_'.length)), v: Number(g[k]) }))
    .sort((a, b) => a.delay - b.delay);

export function interpolateExit(ground: Ground, delayBlocks: number): number {
  const pts = DELAY_KEYS(ground);
  if (delayBlocks <= pts[0].delay) return pts[0].v;
  if (delayBlocks >= pts[pts.length - 1].delay) return pts[pts.length - 1].v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (delayBlocks >= a.delay && delayBlocks <= b.delay) {
      const t = (delayBlocks - a.delay) / (b.delay - a.delay);
      return a.v + t * (b.v - a.v);
    }
  }
  return pts[pts.length - 1].v;
}

/** Seedable PRNG so the committed JSON is reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lognormalSample(median: number, p95: number, rnd: () => number): number {
  const mu = Math.log(median);
  const sigma = (Math.log(p95) - mu) / 1.645;
  // Box-Muller
  const u1 = rnd() || 1e-9, u2 = rnd();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}

export function summarize(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95) };
}

export function run(ground: Ground, n = 1000, seed = 0xc0ffee) {
  const BLOCKS_PER_MIN = 5; // ~12s blocks
  const rnd = mulberry32(seed);
  const manual: number[] = [];
  for (let i = 0; i < n; i++) {
    const manualMin = lognormalSample(25, 120, rnd); // minutes
    manual.push(interpolateExit(ground, manualMin * BLOCKS_PER_MIN));
  }
  // Agentic: first available block after the signal. delayBlocks≈1 clamps to the
  // earliest ground-truth point — one honest number, not a fake distribution.
  const agenticValue = interpolateExit(ground, 1);
  return {
    label: 'Historical replay — not a prediction',
    seed,
    assumptions: {
      manualDelay: 'lognormal median 25min p95 2h (Monte Carlo)',
      agenticDelay: 'first block after signal (~12-24s) — deterministic, no MC',
      blocksPerMin: BLOCKS_PER_MIN,
      iterations: n,
      groundTruthSource: 'frontend/public/data/replay-usdc-depeg.json',
    },
    manual: summarize(manual),
    agentic: { deterministic: agenticValue, basis: 'first block after signal (~12-24s)' },
  };
}
