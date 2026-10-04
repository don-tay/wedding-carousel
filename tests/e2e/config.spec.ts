/** The portable settings file: loading it, its warnings, Safari's download path and Chrome's write-back. */
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = pathToFileURL(resolve('dist/index.html')).href;
const SRC = resolve('test-photos/dinner');
const PICS = readdirSync(SRC).filter((f) => /\.(jpg|png|webp)$/.test(f)).sort().slice(0, 6);
const size = (f: string) => statSync(join(SRC, f)).size;
const base = mkdtempSync(join(tmpdir(), 'wc-config-'));

/** A fresh "album" folder with the same six photos, plus extra files. */
function album(name: string, extra: Record<string, string> = {}) {
  const dir = join(base, name, 'album');
  mkdirSync(dir, { recursive: true });
  for (const f of PICS) copyFileSync(join(SRC, f), join(dir, f));
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text);
  return dir;
}

const fileConfig = JSON.stringify({
  app: 'wedding-carousel',
  version: 1,
  settings: { title: 'From the folder', font: 'clean', background: '#e9ede3', seed: 7, secondsPerScreen: 30 },
  photos: {
    [`${PICS[0]}|${size(PICS[0])}`]: { hidden: true },
    [`${PICS[1]}|1`]: { featured: true }, // wrong size: matched by name alone
    'gone.jpg|5': { hidden: true }, // not in the folder: kept on save
  },
});

async function open(page: Page, browserSettings?: object, url = APP) {
  await page.goto(url);
  await page.evaluate((s) => {
    localStorage.clear();
    if (s) localStorage.setItem('wc:last', JSON.stringify(s));
  }, browserSettings);
  await page.reload();
}
async function drop(page: Page, dir: string) {
  await page.locator('#pickFolder').setInputFiles(dir);
  await expect(page.locator('body')).toHaveClass(/has-photos/, { timeout: 60_000 });
  await expect(page.locator('#progress')).toBeHidden({ timeout: 60_000 });
}
const state = (page: Page) =>
  page.evaluate(() => {
    const wc = (window as any).__wc;
    return { flags: wc.flags(), text: wc.configText(), dirty: wc.file.dirty };
  });

test('the folder file wins in a fresh browser; name-only match, leftovers kept, conflict copy flagged', async ({ page }) => {
  const dir = album('loads', { 'wedding-carousel.json': fileConfig, 'wedding-carousel 2.json': '{}' });
  await open(page, { title: 'Browser title', font: 'soft' });
  await drop(page, dir);
  await page.click('#settingsBtn');
  await expect(page.locator('#title')).toHaveValue('From the folder');
  await expect(page.locator('[data-font=clean]')).toHaveClass(/on/);
  await expect(page.locator('#speedVal')).toHaveText('30 s / screen');
  await expect(page.locator('#configInfo')).toContainText('Settings loaded from wedding-carousel.json');
  await expect(page.locator('#configWarnings')).toContainText('conflict copy');
  await expect(page.locator('#saveStatus')).toBeHidden();

  const s = await state(page);
  expect(s.flags[`${PICS[0]}|${size(PICS[0])}`]).toEqual({ hidden: true });
  expect(s.flags[`${PICS[1]}|${size(PICS[1])}`]).toEqual({ featured: true });
  expect(s.dirty).toBe(false);
  const saved = JSON.parse(s.text);
  expect(saved.photos['gone.jpg|5']).toEqual({ hidden: true });
  expect(saved.photos[`${PICS[1]}|1`]).toBeUndefined(); // re-keyed to the real size
  expect(saved.settings.title).toBe('From the folder');
  await expect(page.locator('#count')).toHaveText('5 shown of 6');
});

test('an unreadable file is reported, browser settings are used, and it is not overwritten', async ({ page }) => {
  const dir = album('broken', { 'wedding-carousel.json': '{ this is not json' });
  await open(page, { title: 'Browser title' });
  await drop(page, dir);
  await page.click('#settingsBtn');
  await expect(page.locator('#title')).toHaveValue('Browser title');
  await expect(page.locator('#configWarnings')).toContainText("couldn't be read");
  await expect(page.locator('#saveStatus')).toHaveText('Unsaved changes ●');
});

test('Safari path: changes show as unsaved until the settings file is downloaded', async ({ page }) => {
  const dir = album('download');
  await open(page);
  await drop(page, dir);
  await expect(page.locator('#saveStatus')).toHaveText('Unsaved changes ●'); // nothing in the folder yet
  await page.click('#settingsBtn');
  await page.fill('#title', 'Don & Pamela');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadConfig')]);
  expect(download.suggestedFilename()).toBe('wedding-carousel.json');
  const path = join(base, 'downloaded.json');
  await download.saveAs(path);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.settings.title).toBe('Don & Pamela');
  await expect(page.locator('#saveStatus')).toBeHidden();
  await expect(page.locator('#configInfo')).toContainText('Move it from Downloads');
});

test('Chrome path: autosaves into the folder, and another computer picks it up', async ({ page, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'writing to folders is Chrome-only');
  const dir = album('autosave');
  await open(page, { title: 'Set up on laptop A' }, 'http://localhost:4173/');
  await drop(page, dir);
  // Stand-in for the folder: browser-private storage behaves like an approved folder handle.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('album', { recursive: true }).catch(() => {});
    await (window as any).__wc.useFolder(await root.getDirectoryHandle('album', { create: true }));
  });
  await expect(page.locator('#saveStatus')).toHaveText('Saved to folder ✓'); // existing settings written at once
  await page.click('#settingsBtn');
  await page.fill('#title', 'Don & Pamela');
  await page.click('[data-font=flowing]');
  await page.click('#closeDrawer');
  await page.evaluate(() => (window as any).__wc.pause()); // pause, then hide a photo via its hover button
  await page.mouse.move(300, 500);
  await page.mouse.move(310, 520);
  await page.click('#hover [data-act=hide]');
  await expect(page.locator('#saveStatus')).toHaveText('Saved to folder ✓');
  await page.waitForTimeout(300);
  const written = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('album');
    return (await (await dir.getFileHandle('wedding-carousel.json')).getFile()).text();
  });
  const cfg = JSON.parse(written);
  expect(cfg.settings).toMatchObject({ title: 'Don & Pamela', font: 'flowing' });
  expect(Object.values(cfg.photos)).toContainEqual({ hidden: true });

  // Laptop B: a brand-new browser profile opening the folder with that file in it.
  const b = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await open(b, { title: 'Laptop B default' });
  await drop(b, album('laptop-b', { 'wedding-carousel.json': written }));
  await b.click('#settingsBtn');
  await expect(b.locator('#title')).toHaveValue('Don & Pamela');
  await expect(b.locator('[data-font=flowing]')).toHaveClass(/on/);
  await expect(b.locator('#count')).toHaveText('5 shown of 6');
  await b.context().close();
});
