import { describe, it, expect } from 'vitest';
import { interpolateExit, summarize, run } from './monteCarlo.js';

const ground = { delay_2: 600, delay_15: 580, delay_50: 540, delay_150: 480, delay_600: 300 };

describe('monteCarlo', () => {
  it('interpolates between two ground-truth delay points', () => {
    // halfway between delay 2 (600) and delay 15 (580) ≈ ~590
    const v = interpolateExit(ground, 8.5);
    expect(v).toBeGreaterThan(580);
    expect(v).toBeLessThan(600);
  });

  it('clamps below min / above max delay to the endpoints', () => {
    expect(interpolateExit(ground, 0)).toBe(600);
    expect(interpolateExit(ground, 10_000)).toBe(300);
  });

  it('summarize returns ordered P5 <= P50 <= P95', () => {
    const samples = [300, 350, 400, 450, 500, 550, 600];
    const s = summarize(samples);
    expect(s.p5).toBeLessThanOrEqual(s.p50);
    expect(s.p50).toBeLessThanOrEqual(s.p95);
  });

  it('manual leg is a real distribution (P5 < P95)', () => {
    const r = run(ground, 1000, 123);
    expect(r.manual.p5).toBeLessThan(r.manual.p95); // genuine spread, not a constant
  });

  it('agentic leg is a single deterministic value (no MC theater)', () => {
    const r = run(ground, 1000, 123);
    expect(typeof r.agentic.deterministic).toBe('number');
    expect(r.agentic.deterministic).toBe(600); // first block after signal → clamps to delay_2
  });

  it('is reproducible for a fixed seed', () => {
    const a = run(ground, 200, 7);
    const b = run(ground, 200, 7);
    expect(a.manual).toEqual(b.manual);
  });
});
