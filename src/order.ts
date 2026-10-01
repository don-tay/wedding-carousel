/** Deterministic ordering: seeded shuffle, near-duplicate detection, similar-photo spreading. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Visual fingerprint computed from a small thumbnail at ingest. */
export interface Fingerprint {
  hash: Uint8Array; // 64-bit difference hash, one bit per entry
  color: Float32Array; // 4×4 grid of mean RGB in 0..1
  aspect: number;
}

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] ^ b[i];
  return d;
}

export function colorDistance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

/** Same shot (re-encode, resize, or near-identical burst frame). */
export function isDuplicate(a: Fingerprint, b: Fingerprint): boolean {
  return (
    Math.abs(Math.log(a.aspect / b.aspect)) < 0.06 &&
    hamming(a.hash, b.hash) <= 6 &&
    colorDistance(a.color, b.color) < 0.06
  );
}

/** Same scene / similar look: kept apart in the shuffle, but both shown. */
export function isSimilar(a: Fingerprint, b: Fingerprint): boolean {
  return hamming(a.hash, b.hash) <= 14 && colorDistance(a.color, b.color) < 0.12;
}

export interface Candidate extends Fingerprint {
  id: string;
  pixels: number;
  bytes: number;
}

/**
 * Map of duplicate id → id of the copy that is kept (highest resolution, then largest file).
 * Photos in `keep` are never treated as duplicates.
 */
export function findDuplicates(items: readonly Candidate[], keep: ReadonlySet<string>): Map<string, string> {
  const ranked = items
    .slice()
    .sort((a, b) => b.pixels - a.pixels || b.bytes - a.bytes || (a.id < b.id ? -1 : 1));
  const kept: Candidate[] = [];
  const dupOf = new Map<string, string>();
  for (const p of ranked) {
    const orig = keep.has(p.id) ? undefined : kept.find((k) => isDuplicate(k, p));
    if (orig) dupOf.set(p.id, orig.id);
    else kept.push(p);
  }
  return dupOf;
}

/** Swap forward so no photo sits next to (or one away from) a similar one, when possible. */
export function spreadSimilar<T>(items: readonly T[], similar: (a: T, b: T) => boolean): T[] {
  const out = items.slice();
  const clash = (x: T, i: number) =>
    (i >= 1 && similar(x, out[i - 1])) || (i >= 2 && similar(x, out[i - 2]));
  for (let i = 1; i < out.length; i++) {
    if (!clash(out[i], i)) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (!clash(out[j], i)) {
        [out[i], out[j]] = [out[j], out[i]];
        break;
      }
    }
  }
  return out;
}
