/**
 * Pure strip layout. The strip is LAYOUT.height units tall; the renderer scales it to the screen.
 * Each column is one photo at full height or a stack of 2–3 photos. A stack of photos with aspect
 * ratios a_i fits the height exactly at width W = (H − (k−1)·gap) / Σ(1/a_i), so nothing is cropped
 * and no padding is needed. Padding only happens for a lone photo wider than maxColumnWidth.
 */
import { mulberry32 } from './order';

export const LAYOUT = {
  height: 1000,
  gap: 14,
  lookahead: 6, // how far ahead a stack partner may be pulled from the shuffled order
  maxColumnWidth: 2400,
  minPhotoHeight: 300,
  minColumnWidth: 380,
};

export interface LayoutItem {
  id: string;
  aspect: number; // width / height, after EXIF orientation
  featured?: boolean;
}
export interface Cell {
  id: string;
  y: number;
  w: number;
  h: number;
  dx: number; // horizontal offset inside the column (non-zero only when padded)
}
export interface Column {
  x: number;
  w: number;
  cells: Cell[];
}
export interface Layout {
  columns: Column[];
  length: number; // one full loop, including the gap after the last column
  height: number;
  gap: number;
  padded: string[];
}

type Kind = 'P' | 'L' | 'S2' | 'S3';
const KIND_COST: Record<Kind, number> = { P: 0, L: 0.9, S2: 0.35, S3: 1.1 };

function shape(items: LayoutItem[]) {
  const { height: H, gap: G, maxColumnWidth } = LAYOUT;
  if (items.length === 1) {
    const a = items[0].aspect;
    const w = Math.min(a * H, maxColumnWidth);
    return { w, heights: [w / a], kind: (a < 1 ? 'P' : 'L') as Kind, overflow: a * H - w };
  }
  const w = (H - (items.length - 1) * G) / items.reduce((s, p) => s + 1 / p.aspect, 0);
  return { w, heights: items.map((p) => w / p.aspect), kind: `S${items.length}` as Kind, overflow: 0 };
}

export function buildLayout(
  items: readonly LayoutItem[],
  seed: number,
  similar: (a: string, b: string) => boolean = () => false,
): Layout {
  const { height: H, gap: G, lookahead, minPhotoHeight, minColumnWidth } = LAYOUT;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const queue = items.slice();
  const columns: Column[] = [];
  const padded: string[] = [];
  const kinds: Kind[] = [];
  let prevIds: string[] = [];
  let x = 0;

  const cost = (idx: number[]) => {
    const ps = idx.map((i) => queue[i]);
    const s = shape(ps);
    let c = KIND_COST[s.kind] + rng() * 0.6;
    if (s.overflow > 0) c += 3 + s.overflow / 300;
    if (ps.length > 1) {
      for (const h of s.heights) if (h < minPhotoHeight) c += (minPhotoHeight - h) / 50;
      if (s.w < minColumnWidth) c += (minColumnWidth - s.w) / 60;
    }
    if (s.kind === kinds.at(-1)) c += kinds.at(-2) === s.kind ? 1.9 : 0.7;
    c += idx.reduce((sum, i) => sum + i, 0) * 0.06;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) if (similar(ps[i].id, ps[j].id)) c += 1.5;
      for (const prev of prevIds) if (similar(ps[i].id, prev)) c += 1.5;
    }
    return c;
  };

  while (queue.length) {
    const options: number[][] = [[0]];
    if (!queue[0].featured) {
      const pool: number[] = [];
      for (let j = 1; j < queue.length && j <= lookahead; j++) if (!queue[j].featured) pool.push(j);
      for (const a of pool) {
        options.push([0, a]);
        for (const b of pool) if (b > a) options.push([0, a, b]);
      }
    }
    let best = options[0];
    let bestCost = Infinity;
    for (const o of options) {
      const c = cost(o);
      if (c < bestCost) [best, bestCost] = [o, c];
    }

    const picked = best.map((i) => queue[i]);
    for (const i of best.slice().sort((a, b) => b - a)) queue.splice(i, 1);
    const s = shape(picked);
    const total = s.heights.reduce((a, b) => a + b, 0) + (picked.length - 1) * G;
    let y = (H - total) / 2; // 0 except for a padded lone panorama
    const cells = picked.map((p, i) => {
      const cell = { id: p.id, y, w: s.w, h: s.heights[i], dx: 0 };
      y += s.heights[i] + G;
      return cell;
    });
    if (s.overflow > 0) padded.push(picked[0].id);
    columns.push({ x, w: s.w, cells });
    kinds.push(s.kind);
    prevIds = picked.map((p) => p.id);
    x += s.w + G;
  }
  return { columns, length: x, height: H, gap: G, padded };
}
