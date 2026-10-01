import { describe, expect, it } from 'vitest';
import { buildLayout, LAYOUT, type LayoutItem } from '../../src/layout';
import { findDuplicates, shuffle, spreadSimilar, type Candidate } from '../../src/order';

const mix = (n: number): LayoutItem[] => {
  const aspects = [1.5, 0.75, 1.78, 1.33, 0.5625, 1.0, 4.2, 0.33, 1.5, 1.5, 0.8, 2.1];
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, aspect: aspects[(i * 7) % aspects.length] }));
};

describe('buildLayout', () => {
  it('places every photo once, uncropped, inside the strip', () => {
    const items = mix(150);
    const L = buildLayout(items, 1);
    const cells = L.columns.flatMap((c) => c.cells);
    expect(cells.map((c) => c.id).sort()).toEqual(items.map((i) => i.id).sort());
    const aspect = new Map(items.map((i) => [i.id, i.aspect]));
    for (const col of L.columns) {
      for (const c of col.cells) {
        expect(c.w / c.h).toBeCloseTo(aspect.get(c.id)!, 6); // no crop, no stretch
        expect(c.y).toBeGreaterThanOrEqual(-1e-6);
        expect(c.y + c.h).toBeLessThanOrEqual(LAYOUT.height + 1e-6);
        expect(c.w).toBeLessThanOrEqual(col.w + 1e-6);
      }
    }
  });

  it('stacks fill the full height exactly with a constant gap', () => {
    const L = buildLayout(mix(80), 3);
    for (const col of L.columns.filter((c) => c.cells.length > 1)) {
      const last = col.cells.at(-1)!;
      expect(col.cells[0].y).toBeCloseTo(0, 6);
      expect(last.y + last.h).toBeCloseTo(LAYOUT.height, 6);
      for (let i = 1; i < col.cells.length; i++) {
        const prev = col.cells[i - 1];
        expect(col.cells[i].y - (prev.y + prev.h)).toBeCloseTo(LAYOUT.gap, 6);
      }
    }
  });

  it('columns tile the loop with uniform gaps, including across the seam', () => {
    const L = buildLayout(mix(60), 9);
    for (let i = 1; i < L.columns.length; i++) {
      const p = L.columns[i - 1];
      expect(L.columns[i].x - (p.x + p.w)).toBeCloseTo(LAYOUT.gap, 6);
    }
    const last = L.columns.at(-1)!;
    expect(L.length - (last.x + last.w)).toBeCloseTo(LAYOUT.gap, 6);
  });

  it('is deterministic and mixes column types', () => {
    const a = buildLayout(mix(100), 42);
    expect(buildLayout(mix(100), 42)).toEqual(a);
    const sizes = new Set(a.columns.map((c) => c.cells.length));
    expect(sizes.has(1) && sizes.has(2)).toBe(true);
    // No long runs of identical column shapes.
    let run = 1;
    for (let i = 1; i < a.columns.length; i++) {
      run = a.columns[i].cells.length === a.columns[i - 1].cells.length ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(4);
    }
  });

  it('gives featured photos a full-height column of their own', () => {
    const items = mix(40).map((p, i) => ({ ...p, featured: i % 5 === 0 }));
    const L = buildLayout(items, 7);
    for (const col of L.columns) {
      if (col.cells.some((c) => items.find((i) => i.id === c.id)!.featured)) {
        expect(col.cells).toHaveLength(1);
      }
    }
  });

  it('pads only a lone photo too wide for one column, and reports it', () => {
    const L = buildLayout([{ id: 'pano', aspect: 5, featured: true }], 1);
    expect(L.padded).toEqual(['pano']);
    expect(L.columns[0].w).toBe(LAYOUT.maxColumnWidth);
    const normal = buildLayout(mix(100).filter((p) => p.aspect < 2.2), 1);
    expect(normal.padded).toEqual([]);
  });

  it('keeps stack partners within the lookahead window', () => {
    const items = mix(120);
    const L = buildLayout(items, 5);
    const pos = new Map(items.map((p, i) => [p.id, i]));
    for (const col of L.columns) {
      const idx = col.cells.map((c) => pos.get(c.id)!);
      expect(Math.max(...idx) - Math.min(...idx)).toBeLessThanOrEqual(LAYOUT.lookahead + 6);
    }
  });
});

describe('ordering', () => {
  const fp = (id: string, bits: number, shade: number, aspect = 1.5, pixels = 1e6): Candidate => ({
    id,
    hash: Uint8Array.from({ length: 64 }, (_, i) => (i < bits ? 1 : 0)),
    color: new Float32Array(48).fill(shade),
    aspect,
    pixels,
    bytes: 1,
  });

  it('shuffle is deterministic per seed', () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffle(xs, 1)).toEqual(shuffle(xs, 1));
    expect(shuffle(xs, 1)).not.toEqual(shuffle(xs, 2));
    expect(shuffle(xs, 1).sort((a, b) => a - b)).toEqual(xs);
  });

  it('keeps the highest-resolution copy of a duplicate', () => {
    const d = findDuplicates([fp('small', 10, 0.5, 1.5, 1e6), fp('big', 11, 0.51, 1.5, 12e6), fp('other', 40, 0.1)], new Set());
    expect([...d]).toEqual([['small', 'big']]);
    expect(findDuplicates([fp('small', 10, 0.5), fp('big', 11, 0.51, 1.5, 12e6)], new Set(['small'])).size).toBe(0);
  });

  it('spreads similar photos apart', () => {
    const items = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'c2', 'd1', 'e1', 'f1'];
    const sim = (x: string, y: string) => x[0] === y[0];
    const out = spreadSimilar(items, sim);
    for (let i = 1; i < out.length; i++) expect(sim(out[i], out[i - 1])).toBe(false);
  });
});
