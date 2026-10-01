/**
 * End-to-end checks against the built single file (run `npm run build` and `npm run test-photos` first).
 * Set REAL_PHOTOS=/path/to/folder to also smoke-test a real collection (read-only).
 */
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const APP = pathToFileURL(resolve('dist/index.html')).href;

async function load(page: Page, dir: string) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const t0 = Date.now();
  await page.locator('#pickFolder').setInputFiles(dir);
  await expect(page.locator('body')).toHaveClass(/has-photos/, { timeout: 200_000 });
  await expect(page.locator('#progress')).toBeHidden({ timeout: 200_000 });
  return (Date.now() - t0) / 1000;
}

/** Pause at `phase` and wait until the photos near the viewport have finished decoding. */
async function settleAt(page: Page, phase: number) {
  await page.evaluate(async (phase) => {
    const wc = (window as any).__wc;
    wc.pause();
    wc.phase = phase;
    const r = wc.renderer;
    const tick = () => new Promise(requestAnimationFrame);
    for (let i = 0; i < 600 && (i < 5 || r.inflight.size || r.queue.length); i++) await tick();
    await tick();
  }, phase);
}

test('synthetic set: ingest, orientation, duplicates, no crop, seamless loop', async ({ page }, info) => {
  const secs = await load(page, 'test-photos');
  const s = await page.evaluate(() => {
    const wc = (window as any).__wc;
    const photos = [...wc.photos.values()];
    const byName = (n: string) => photos.find((p: any) => p.name === n);
    const L = wc.layout();
    const cells = L.columns.flatMap((c: any) => c.cells);
    const worstCrop = Math.max(
      ...cells.map((c: any) => Math.abs(c.w / c.h / wc.photos.get(c.id).aspect - 1)),
    );
    return {
      total: photos.length,
      shown: cells.length,
      errors: wc.errors().map((e: any) => e.path),
      dups: [...wc.dupOf()].map(([a, b]: string[]) => [wc.photos.get(a).name, wc.photos.get(b).name]),
      exif6: [byName('exif6-portrait.jpg').w, byName('exif6-portrait.jpg').h],
      exif8: [byName('exif8-landscape.jpg').w, byName('exif8-landscape.jpg').h],
      heic: photos.filter((p: any) => /heic$/i.test(p.name)).map((p: any) => [p.w, p.h]),
      worstCrop,
      padded: L.padded.map((id: string) => wc.photos.get(id).name),
      columns: L.columns.map((c: any) => c.cells.length),
      loop: wc.renderer.loopSeconds(25),
    };
  });
  console.log(info.project.name, `ingest ${secs.toFixed(1)}s`, JSON.stringify(s));

  expect(s.total).toBe(56); // 57 image files, 1 corrupt
  expect(s.errors).toEqual(['test-photos/broken/corrupt.jpg']);
  expect(s.dups).toEqual([['dup-whatsapp.jpg', 'dup-original.jpg']]);
  expect(s.shown).toBe(55);
  expect(s.exif6).toEqual([2000, 3000]);
  expect(s.exif8).toEqual([3000, 2000]);
  expect(s.heic.sort()).toEqual([[3024, 4032], [4032, 3024]]);
  expect(s.worstCrop).toBeLessThan(1e-9);
  expect(new Set(s.columns).size).toBeGreaterThan(1);

  await page.waitForTimeout(500);
  await page.screenshot({ path: `test-results/${info.project.name}-synthetic.png` });

  // Seamless loop: the frame just before the wrap, shifted by δ, must equal the first frame.
  const { W, H, loopPx, top } = await page.evaluate(() => {
    const r = (window as any).__wc.renderer;
    const g = r.geometry();
    return { W: r.canvas.width, H: r.canvas.height, loopPx: g.loopPx, top: Math.ceil(g.top * r.dpr) };
  });
  const delta = 300;
  await settleAt(page, 0);
  await page.evaluate(() => {
    const c = (window as any).__wc.renderer.canvas as HTMLCanvasElement;
    (window as any).__frameA = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  });
  await settleAt(page, 1 - delta / loopPx);
  const { maxDiff, sum, n } = await page.evaluate(({ W, H, top, delta }) => {
    const c = (window as any).__wc.renderer.canvas as HTMLCanvasElement;
    const a = (window as any).__frameA as Uint8ClampedArray;
    const b = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let maxDiff = 0, sum = 0, n = 0;
    for (let y = top; y < H; y++) { // below the (static) title band
      for (let x = 0; x < W - delta; x++) {
        const i = (y * W + x) * 4, j = (y * W + x + delta) * 4;
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(a[i + k] - b[j + k]);
          if (d > maxDiff) maxDiff = d;
          sum += d; n++;
        }
      }
    }
    return { maxDiff, sum, n };
  }, { W, H, top, delta });
  console.log(info.project.name, `seam: max channel diff ${maxDiff}, mean ${(sum / n).toFixed(4)}`);
  expect(sum / n).toBeLessThan(0.5);
  expect(maxDiff).toBeLessThanOrEqual(8);
});

test('playback is smooth', async ({ page }, info) => {
  await load(page, 'test-photos');
  const stats = await page.evaluate(async () => {
    const times: number[] = [];
    let last = performance.now();
    const end = last + 4000;
    while (performance.now() < end) {
      const t = await new Promise<number>(requestAnimationFrame);
      times.push(t - last);
      last = t;
    }
    times.sort((a, b) => a - b);
    return { frames: times.length, p50: times[times.length >> 1], p99: times[Math.floor(times.length * 0.99)] };
  });
  console.log(info.project.name, 'frame times ms', JSON.stringify(stats));
  expect(stats.p50).toBeLessThan(25);
});

test('settings persist per set and restore after reload', async ({ page }) => {
  await load(page, 'test-photos');
  await page.click('#settingsBtn');
  await page.fill('#title', 'Don & Pamela');
  await page.click('[data-font=flowing]');
  await page.click('[data-color="#e9ede3"]');
  await page.reload();
  await page.locator('#pickFolder').setInputFiles('test-photos');
  await expect(page.locator('#progress')).toBeHidden({ timeout: 200_000 });
  await page.click('#settingsBtn');
  await expect(page.locator('#title')).toHaveValue('Don & Pamela');
  await expect(page.locator('[data-font=flowing]')).toHaveClass(/on/);
});

test('real photo folder smoke test', async ({ page }, info) => {
  const dir = process.env.REAL_PHOTOS;
  test.skip(!dir, 'set REAL_PHOTOS to run');
  const secs = await load(page, dir!);
  const s = await page.evaluate(() => {
    const wc = (window as any).__wc;
    const L = wc.layout();
    const name = (id: string) => wc.photos.get(id).path;
    return {
      total: wc.photos.size,
      shown: L.columns.reduce((n: number, c: any) => n + c.cells.length, 0),
      errors: wc.errors(),
      dups: [...wc.dupOf()].map(([a, b]: string[]) => `${name(a)} → ${name(b)}`),
      padded: L.padded.map(name),
      columns: L.columns.map((c: any) => c.cells.length).join(''),
      loopMin: (wc.renderer.loopSeconds(25) / 60).toFixed(1),
    };
  });
  console.log(info.project.name, `real set ingest ${secs.toFixed(1)}s`, JSON.stringify(s, null, 1));
  expect(s.errors).toEqual([]);
  for (const p of [0, 0.3, 0.6]) {
    await settleAt(page, p);
    await page.screenshot({ path: `test-results/${info.project.name}-real-${p}.png` });
  }
});
