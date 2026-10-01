/** Canvas renderer: draws the strip for a given loop phase and lazily decodes nearby photos. */
import { loadImage, scaleTo, type Photo } from './ingest';
import type { Layout } from './layout';
import { FONTS, type FontKey } from './settings';

export interface Style {
  background: string;
  titleColor: string;
  title: string;
  showTitle: boolean;
  font: FontKey;
}
export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const RADIUS = 6; // strip units
const MAX_DECODE_PX = 2200; // photo height cap (≈ 4K)
const PIXEL_BUDGET = 90e6; // decoded pixels kept in memory (~360 MB)
const PREFETCH_SCREENS = 1.5; // decode this far ahead of the right edge

interface Cached {
  img: CanvasImageSource;
  px: number;
  pixels: number;
  used: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layout: Layout | null = null;
  private photos = new Map<string, Photo>();
  private cache = new Map<string, Cached>();
  private queue: { id: string; px: number; radius: number }[] = [];
  private inflight = new Set<string>();
  private frame = 0;
  style: Style;
  featured = new Set<string>();
  showBadges = false;
  width = 0;
  height = 0;
  dpr = 1;

  constructor(canvas: HTMLCanvasElement, style: Style) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.style = style;
  }

  setLayout(layout: Layout, photos: Map<string, Photo>) {
    this.layout = layout;
    this.photos = photos;
  }

  clearCache() {
    this.cache.clear();
    this.queue = [];
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  geometry() {
    const H = this.height;
    const hasPhotos = !!this.layout?.columns.length;
    const titleBand = hasPhotos && this.style.showTitle && this.style.title.trim() ? 0.085 * H : 0;
    const top = 0.035 * H + titleBand;
    const scale = (H - top - 0.035 * H) / (this.layout?.height ?? 1000);
    return { top, titleBand, scale, loopPx: (this.layout?.length ?? 0) * scale };
  }

  /** Seconds for one full loop at the given speed (seconds per screen width). */
  loopSeconds(secondsPerScreen: number): number {
    return this.width ? (this.geometry().loopPx / this.width) * secondsPerScreen : 0;
  }

  /** Photos whose rectangles intersect [from, to] (CSS px) at this phase, left to right. */
  *placements(phase: number, from = 0, to = this.width): Generator<Placement> {
    const L = this.layout;
    if (!L || !L.columns.length) return;
    const { top, scale, loopPx } = this.geometry();
    const offset = phase * loopPx;
    for (let base = -offset; base <= to; base += loopPx) {
      for (const col of L.columns) {
        const cx = base + col.x * scale;
        if (cx > to) break;
        if (cx + col.w * scale < from) continue;
        for (const c of col.cells) {
          yield { id: c.id, x: cx + c.dx * scale, y: top + c.y * scale, w: c.w * scale, h: c.h * scale };
        }
      }
    }
  }

  hitTest(x: number, y: number, phase: number): Placement | null {
    for (const p of this.placements(phase)) if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return p;
    return null;
  }

  draw(phase: number) {
    const { ctx, width: W, height: H } = this;
    const { titleBand, scale } = this.geometry();
    this.frame++;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.style.background;
    ctx.fillRect(0, 0, W, H);

    if (titleBand) {
      const f = FONTS[this.style.font];
      ctx.font = f.css.replace('1em', `${(0.06 * H * f.size).toFixed(1)}px`);
      ctx.fillStyle = this.style.titleColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.style.title, W / 2, 0.035 * H + titleBand / 2);
    }

    const r = RADIUS * scale;
    for (const p of this.placements(phase)) {
      const cached = this.cache.get(p.id);
      if (cached) {
        cached.used = this.frame;
        ctx.drawImage(cached.img, p.x, p.y, p.w, p.h);
      } else {
        const photo = this.photos.get(p.id);
        if (!photo) continue;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(p.x, p.y, p.w, p.h, r);
        ctx.clip();
        ctx.drawImage(photo.thumb, p.x, p.y, p.w, p.h);
        ctx.restore();
      }
      if (this.showBadges && this.featured.has(p.id)) this.badge(p, scale);
    }
    this.prefetch(phase, scale);
  }

  private badge(p: Placement, scale: number) {
    const { ctx } = this;
    const size = Math.max(22, 34 * scale);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(p.x + size * 0.8, p.y + size * 0.8, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b8860b';
    ctx.font = `${size * 0.6}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', p.x + size * 0.8, p.y + size * 0.83);
  }

  private prefetch(phase: number, scale: number) {
    const want: { id: string; px: number; radius: number }[] = [];
    const seen = new Set<string>();
    for (const p of this.placements(phase, -0.25 * this.width, (1 + PREFETCH_SCREENS) * this.width)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const photo = this.photos.get(p.id);
      if (!photo) continue;
      const px = Math.min(Math.round(p.h * this.dpr), MAX_DECODE_PX, photo.h);
      const c = this.cache.get(p.id);
      if (c) c.used = this.frame;
      if ((!c || c.px < px * 0.9) && !this.inflight.has(p.id)) want.push({ id: p.id, px, radius: RADIUS * scale * (px / p.h) });
    }
    this.queue = want;
    while (this.inflight.size < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.inflight.add(job.id);
      this.decode(job.id, job.px, job.radius)
        .catch((e) => console.warn('decode failed', job.id, e))
        .finally(() => this.inflight.delete(job.id));
    }
    this.evict(seen);
  }

  /** radius is in the decoded bitmap's pixels. */
  private async decode(id: string, px: number, radius: number) {
    const photo = this.photos.get(id);
    if (!photo) return;
    const th = px;
    const tw = Math.max(1, Math.round(px * photo.aspect));
    const img = await loadImage(photo.url);
    let scaled: CanvasImageSource;
    try {
      const bmp = await createImageBitmap(img, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      if (bmp.width !== tw || bmp.height !== th) throw new Error('resize unsupported');
      scaled = bmp;
    } catch {
      scaled = scaleTo(img, photo.w, photo.h, tw, th);
    }
    // Bake rounded corners so each frame is a single drawImage per photo.
    const c = document.createElement('canvas');
    [c.width, c.height] = [tw, th];
    const ctx = c.getContext('2d')!;
    ctx.beginPath();
    ctx.roundRect(0, 0, tw, th, radius);
    ctx.clip();
    ctx.drawImage(scaled, 0, 0, tw, th);
    if (scaled instanceof ImageBitmap) scaled.close();
    const bitmap = await createImageBitmap(c);
    if (!this.photos.has(id)) return bitmap.close();
    this.cache.set(id, { img: bitmap, px, pixels: tw * th, used: this.frame });
  }

  private evict(wanted: Set<string>) {
    let total = 0;
    for (const c of this.cache.values()) total += c.pixels;
    if (total <= PIXEL_BUDGET) return;
    const victims = [...this.cache].filter(([id]) => !wanted.has(id)).sort((a, b) => a[1].used - b[1].used);
    for (const [id, c] of victims) {
      if (total <= PIXEL_BUDGET) break;
      total -= c.pixels;
      if (c.img instanceof ImageBitmap) c.img.close();
      this.cache.delete(id);
    }
  }
}
