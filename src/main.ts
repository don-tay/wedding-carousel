/** App wiring: state, ingest, animation clock, controls and settings drawer. */
import '@fontsource/pinyon-script/latin-400.css';
import '@fontsource/great-vibes/latin-400.css';
import '@fontsource/allura/latin-400.css';
import '@fontsource/cormorant-garamond/latin-500-italic.css';
import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-500.css';
import './style.css';

import { adopt, CONFIG_NAME, mergeConfigs, serializeConfig, type PhotoMap } from './config';
import { askToWrite, canWrite, downloadConfig, droppedHandles, hasFolderPicker, pickFolder, readRoots, writeConfig } from './folder';
import { collectDropped, decodeAll, fromFileList, isImage, walkHandle, type FileEntry, type IngestError, type Photo } from './ingest';
import { buildLayout, type Layout } from './layout';
import { findDuplicates, isSimilar, shuffle, spreadSimilar } from './order';
import { Renderer } from './renderer';
import { BACKGROUNDS, DEFAULTS, FONTS, setKey, store, titleColor, type FontKey, type PhotoFlags, type Settings } from './settings';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const app = $('#app');
const stage = $('#stage');

// ---------- state ----------
const photos = new Map<string, Photo>();
let errors: IngestError[] = [];
let flags = store.loadFlags();
let key: string | null = null;
let settings: Settings = store.loadSettings('');
let dupOf = new Map<string, string>();
let layout: Layout = buildLayout([], 1);
let phase = 0;
let playing = true;
let scrubbing = false;

/** Where wedding-carousel.json is saved: the first dropped folder. */
interface Target {
  name: string;
  handle?: FileSystemDirectoryHandle; // Chrome only
  writable: boolean;
  broken: boolean; // its existing file is unreadable: never overwrite without asking
}
const file = {
  target: null as Target | null,
  carried: {} as PhotoMap, // entries from the file for photos not currently loaded (kept on save)
  loaded: false, // settings came from a file
  dirty: false, // changes not yet in the folder
  saving: false,
  downloaded: false,
  error: '',
  warnings: [] as string[],
};

const renderer = new Renderer($<HTMLCanvasElement>('#canvas'), styleFrom(settings));

function styleFrom(s: Settings) {
  return { background: s.background, titleColor: titleColor(s), title: s.title, showTitle: s.showTitle, font: s.font };
}

function update(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  store.saveSettings(key, settings);
  renderer.style = styleFrom(settings);
  document.body.style.background = settings.background;
  if ('seed' in patch) rebuild();
  syncControls();
  if (Object.keys(patch).length) changed();
}

function setFlag(id: string, patch: Partial<PhotoFlags>) {
  flags = { ...flags, [id]: { ...flags[id], ...patch } };
  store.saveFlags(flags);
  rebuild();
  changed();
}

/** Recompute duplicates, order and layout from the current photos, flags and seed. */
function rebuild() {
  const all = [...photos.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const shown = all.filter((p) => !flags[p.id]?.hidden);
  const keep = new Set(shown.filter((p) => flags[p.id]?.keepDuplicate).map((p) => p.id));
  dupOf = findDuplicates(shown.map((p) => ({ ...p, pixels: p.w * p.h })), keep);
  const visible = spreadSimilar(
    shuffle(shown.filter((p) => !dupOf.has(p.id)), settings.seed),
    isSimilar,
  );
  layout = buildLayout(
    visible.map((p) => ({ id: p.id, aspect: p.aspect, featured: !!flags[p.id]?.featured })),
    settings.seed,
    (a, b) => isSimilar(photos.get(a)!, photos.get(b)!),
  );
  renderer.setLayout(layout, photos);
  renderer.featured = new Set(visible.filter((p) => flags[p.id]?.featured).map((p) => p.id));
  document.body.classList.toggle('has-photos', layout.columns.length > 0);
  hideHover();
  renderLists();
}

// ---------- adding photos ----------
async function addEntries(entries: FileEntry[], handles: FileSystemDirectoryHandle[] = []) {
  const seen = new Set(photos.keys());
  const fresh = entries.filter(({ file, path }) => {
    const id = `${file.name}|${file.size}`;
    return isImage(path) && !seen.has(id) && !!seen.add(id);
  });
  const { roots, warnings } = await readRoots(entries);
  if (fresh.length) {
    const box = $('#progress');
    const heic = fresh.some((e) => /\.hei[cf]$/i.test(e.path));
    box.hidden = false;
    document.body.classList.add('loading');
    const res = await decodeAll(fresh, (done, total) => {
      $('#progress .label').textContent =
        `Reading photos… ${done} / ${total}` + (heic ? ' — HEIC photos can take a moment in Chrome' : '');
      $('#progress .fill').style.width = `${(100 * done) / total}%`;
    });
    box.hidden = true;
    document.body.classList.remove('loading');
    for (const p of res.photos) photos.set(p.id, p);
    errors = [...errors, ...res.errors];
  }
  if (!photos.size) return;
  file.warnings = [...new Set([...file.warnings, ...warnings])];

  const ids = [...photos.keys()];
  key = setKey(ids);
  const configs = roots.flatMap((r) => (r.config ? [r.config] : []));
  if (configs.length) {
    // The folder's file wins: its look, and its choice (or no choice) for every loaded photo.
    const merged = mergeConfigs(configs);
    const { matched, rest } = adopt({ ...merged.photos, ...file.carried }, ids);
    flags = { ...flags };
    for (const id of ids) {
      if (matched[id]) flags[id] = matched[id];
      else delete flags[id];
    }
    file.carried = rest;
    settings = { ...DEFAULTS, ...merged.settings };
    Object.assign(file, { loaded: true, dirty: false, downloaded: false });
  } else {
    const { matched, rest } = adopt(file.carried, ids.filter((id) => !flags[id]));
    flags = { ...flags, ...matched };
    file.carried = rest;
    settings = store.loadSettings(key);
    if (!file.loaded) file.dirty = true; // first save/download puts this browser's settings in the folder
  }
  store.saveFlags(flags);
  store.saveSettings(key, settings);

  if (!file.target && roots.length) {
    const first = roots[0];
    const handle = handles.find((h) => h.name === first.name) ?? (handles.length === 1 ? handles[0] : undefined);
    await useTarget({ name: first.name, handle, writable: false, broken: !!first.broken });
  }
  update({});
  rebuild();
  renderFileStatus();
}

async function useTarget(t: Target) {
  file.target = t;
  if (t.handle && !t.broken && (await canWrite(t.handle))) {
    t.writable = true;
    if (file.dirty) saveSoon(0);
  }
  renderFileStatus();
}

function clearAll() {
  for (const p of photos.values()) URL.revokeObjectURL(p.url);
  photos.clear();
  errors = [];
  key = null;
  Object.assign(file, { target: null, carried: {}, loaded: false, dirty: false, downloaded: false, error: '', warnings: [] });
  renderer.clearCache();
  phase = 0;
  rebuild();
  renderFileStatus();
}

// ---------- the settings file ----------
function configText(): string {
  const mine: PhotoMap = {};
  for (const id of photos.keys()) if (flags[id]) mine[id] = flags[id];
  return serializeConfig(settings, { ...file.carried, ...mine });
}

let saveTimer = 0;
function changed() {
  if (!photos.size) return;
  file.dirty = true;
  file.downloaded = false;
  saveSoon(1000);
  renderFileStatus();
}
function saveSoon(ms: number) {
  if (!file.target?.writable) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, ms);
}
async function saveNow() {
  const t = file.target;
  if (!t?.handle || !t.writable) return;
  file.saving = true;
  renderFileStatus();
  try {
    await writeConfig(t.handle, configText());
    Object.assign(file, { dirty: false, error: '' });
  } catch (e) {
    file.error = e instanceof Error ? e.message : String(e);
  }
  file.saving = false;
  renderFileStatus();
}
async function allowSaving() {
  const t = file.target;
  if (!t?.handle) return;
  if (t.broken && !confirm(`Replace the unreadable ${CONFIG_NAME} in “${t.name}” with the current settings?`)) return;
  if (!(await askToWrite(t.handle))) return;
  Object.assign(t, { writable: true, broken: false });
  file.warnings = file.warnings.filter((w) => !w.includes("couldn't be read"));
  await saveNow();
}

function renderFileStatus() {
  const t = file.target;
  const where = t?.name ? `“${t.name}”` : 'your photo folder';
  let bar = '';
  let info = '';
  if (!photos.size) info = '';
  else if (file.saving) bar = info = 'Saving…';
  else if (file.error) {
    bar = 'Save failed ●';
    info = `Couldn't save to ${where}: ${file.error}. Use “Download settings file” instead.`;
  } else if (t?.writable) {
    bar = file.dirty ? 'Saving…' : 'Saved to folder ✓';
    info = `Changes save automatically to ${CONFIG_NAME} in ${where}, so any computer that opens this folder gets them.`;
  } else if (file.dirty) {
    bar = 'Unsaved changes ●';
    info = t?.handle
      ? `Changes are only in this browser. Click “Allow saving to this folder” to keep them in ${where}.`
      : `Changes are only in this browser. Download the settings file and move it into ${where}.`;
  } else if (file.downloaded) {
    info = `Downloaded ${CONFIG_NAME}. Move it from Downloads into ${where} so other computers pick it up.`;
  } else if (file.loaded) info = `Settings loaded from ${CONFIG_NAME} in ${where}.`;

  const status = $('#saveStatus');
  status.textContent = bar;
  status.hidden = !bar;
  status.classList.toggle('warn', bar.includes('●'));
  $('#configInfo').textContent = info;
  $('#fileBox').hidden = !photos.size;
  const allow = $('#allowSave');
  allow.hidden = !(t?.handle && !t.writable);
  allow.textContent = t?.broken ? `Replace unreadable ${CONFIG_NAME}…` : 'Allow saving to this folder';
  $('#configWarnings').replaceChildren(
    ...file.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })),
  );
}

// ---------- animation clock ----------
let last = performance.now();
let lastUi = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const loop = renderer.loopSeconds(settings.secondsPerScreen);
  if (playing && !scrubbing && loop > 0) phase = (phase + dt / loop) % 1;
  renderer.draw(phase);
  if (now - lastUi > 250) {
    lastUi = now;
    if (!scrubbing) $<HTMLInputElement>('#scrub').value = String(Math.round(phase * 10000));
    $('#time').textContent = `${clock(phase * loop)} / ${clock(loop)}`;
    $('#time').title = `Full loop: ${clock(loop)}`;
  }
  requestAnimationFrame(frame);
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

new ResizeObserver(() => renderer.resize()).observe(stage);
renderer.resize();
requestAnimationFrame(frame);

// ---------- controls ----------
function setPlaying(p: boolean) {
  playing = p;
  renderer.showBadges = !p;
  $('#play').textContent = p ? '❚❚' : '▶';
  if (p) hideHover();
}
function nudge(screens: number) {
  const loopPx = renderer.geometry().loopPx;
  if (loopPx) phase = (((phase + (screens * renderer.width) / loopPx) % 1) + 1) % 1;
}

const isFullscreen = () => !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
function toggleFullscreen() {
  const d = document as any;
  const el = app as any;
  if (isFullscreen()) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
}
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    $('#fsBtn').textContent = isFullscreen() ? 'Exit full screen' : 'Full screen';
    if (isFullscreen()) $('#drawer').hidden = true;
    wake();
  });
}

let idleTimer = 0;
function wake() {
  app.classList.remove('idle');
  clearTimeout(idleTimer);
  if (isFullscreen()) idleTimer = window.setTimeout(() => $('#drawer').hidden && app.classList.add('idle'), 2000);
}
document.addEventListener('mousemove', wake);

$('#play').onclick = () => setPlaying(!playing);
$('#fsBtn').onclick = toggleFullscreen;
$('#settingsBtn').onclick = () => ($('#drawer').hidden = !$('#drawer').hidden);
$('#closeDrawer').onclick = () => ($('#drawer').hidden = true);
const scrub = $<HTMLInputElement>('#scrub');
scrub.oninput = () => {
  scrubbing = true;
  phase = Number(scrub.value) / 10000;
};
scrub.onchange = () => (scrubbing = false);
const speed = $<HTMLInputElement>('#speed');
speed.oninput = () => update({ secondsPerScreen: Number(speed.value) });

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input[type=text]')) return;
  if (e.code === 'Space') setPlaying(!playing);
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'ArrowRight') nudge(0.1);
  else if (e.key === 'ArrowLeft') nudge(-0.1);
  else if (e.key === 'Escape') $('#drawer').hidden = true;
  else return;
  e.preventDefault();
});

// ---------- feature / hide on hover (while paused) ----------
const hover = $('#hover');
let hoverId: string | null = null;
function hideHover() {
  hover.hidden = true;
  hoverId = null;
}
stage.addEventListener('mousemove', (e) => {
  if (playing || e.target !== renderer.canvas) return;
  const r = stage.getBoundingClientRect();
  const hit = renderer.hitTest(e.clientX - r.left, e.clientY - r.top, phase);
  if (!hit) return hideHover();
  hoverId = hit.id;
  hover.hidden = false;
  hover.style.left = `${Math.max(8, hit.x + hit.w - hover.offsetWidth - 10)}px`;
  hover.style.top = `${hit.y + 10}px`;
  hover.querySelector('[data-act=feature]')!.classList.toggle('on', !!flags[hit.id]?.featured);
});
stage.addEventListener('mouseleave', hideHover);
hover.onclick = (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (!hoverId || !act) return;
  if (act === 'feature') setFlag(hoverId, { featured: !flags[hoverId]?.featured });
  else setFlag(hoverId, { hidden: true });
};

// ---------- drop & pick ----------
const hint = $('#dropHint');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  hint.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) hint.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  hint.hidden = true;
  if (!e.dataTransfer) return;
  const handles = droppedHandles(e.dataTransfer); // both must start synchronously in the event
  collectDropped(e.dataTransfer).then(async (entries) => addEntries(entries, await handles));
});
for (const b of document.querySelectorAll<HTMLElement>('[data-pick]')) {
  b.onclick = async () => {
    if (b.dataset.pick !== 'folder') return $('#pickFiles').click();
    if (!hasFolderPicker()) return $('#pickFolder').click(); // Safari
    try {
      const dir = await pickFolder(); // Chrome: a folder handle we can later save into
      await addEntries(await walkHandle(dir), [dir]);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') alert(`Couldn't open that folder: ${(err as Error).message}`);
    }
  };
}
for (const id of ['#pickFolder', '#pickFiles']) {
  const input = $<HTMLInputElement>(id);
  input.onchange = () => {
    if (input.files) addEntries(fromFileList(input.files));
    input.value = '';
  };
}

// ---------- settings drawer ----------
const titleInput = $<HTMLInputElement>('#title');
titleInput.oninput = () => update({ title: titleInput.value });
$<HTMLInputElement>('#showTitle').onchange = (e) => update({ showTitle: (e.target as HTMLInputElement).checked });
$<HTMLInputElement>('#bgColor').oninput = (e) => update({ background: (e.target as HTMLInputElement).value });
$<HTMLInputElement>('#titleColor').oninput = (e) => update({ titleColor: (e.target as HTMLInputElement).value });
$<HTMLInputElement>('#autoTitleColor').onchange = (e) =>
  update({ titleColor: (e.target as HTMLInputElement).checked ? null : titleColor(settings) });
$('#reshuffle').onclick = () => update({ seed: (Math.random() * 2 ** 31) | 0 });
$('#allowSave').onclick = allowSaving;
$('#downloadConfig').onclick = () => {
  downloadConfig(configText());
  Object.assign(file, { dirty: file.target?.writable ? file.dirty : false, downloaded: !file.target?.writable });
  renderFileStatus();
};
$('#saveStatus').onclick = () => ($('#drawer').hidden = false);
$('#clear').onclick = () => confirm('Remove all photos from the carousel?') && clearAll();

const fontBox = $('#fonts');
for (const [k, f] of Object.entries(FONTS)) {
  const b = document.createElement('button');
  b.dataset.font = k;
  b.innerHTML = `<span></span><small>${f.label}</small>`;
  (b.firstChild as HTMLElement).style.font = f.css;
  b.onclick = () => update({ font: k as FontKey });
  fontBox.append(b);
}
const swatchBox = $('#swatches');
for (const bg of BACKGROUNDS) {
  const b = document.createElement('button');
  b.title = bg.label;
  b.dataset.color = bg.color;
  b.style.background = bg.color;
  b.onclick = () => update({ background: bg.color });
  swatchBox.append(b);
}

function syncControls() {
  const s = settings;
  if (document.activeElement !== titleInput) titleInput.value = s.title;
  $<HTMLInputElement>('#showTitle').checked = s.showTitle;
  $<HTMLInputElement>('#bgColor').value = s.background;
  $<HTMLInputElement>('#titleColor').value = titleColor(s);
  $<HTMLInputElement>('#autoTitleColor').checked = s.titleColor === null;
  speed.value = String(s.secondsPerScreen);
  $('#speedVal').textContent = `${s.secondsPerScreen} s / screen`;
  for (const b of fontBox.querySelectorAll<HTMLElement>('button')) {
    b.classList.toggle('on', b.dataset.font === s.font);
    b.querySelector('span')!.textContent = s.title.trim() || 'Before the Vows';
  }
  for (const b of swatchBox.querySelectorAll<HTMLElement>('button'))
    b.classList.toggle('on', b.dataset.color === s.background);
}

function renderLists() {
  const name = (id: string) => photos.get(id)?.path ?? id;
  const hidden = [
    ...[...photos.values()].filter((p) => flags[p.id]?.hidden).map((p) => ({ p, why: 'hidden', restore: { hidden: false } })),
    ...[...dupOf].map(([id, of]) => ({ p: photos.get(id)!, why: `duplicate of ${name(of)}`, restore: { keepDuplicate: true } })),
  ];
  $('#hiddenCount').textContent = String(hidden.length);
  $('#hiddenList').replaceChildren(
    ...hidden.map(({ p, why, restore }) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = p.thumb.toDataURL('image/jpeg', 0.7);
      Object.assign(img.style, { width: '56px', height: '42px', objectFit: 'contain', borderRadius: '4px' });
      const label = document.createElement('span');
      label.textContent = `${p.path} — ${why}`;
      label.title = label.textContent;
      const btn = document.createElement('button');
      btn.textContent = 'Restore';
      btn.onclick = () => setFlag(p.id, restore);
      li.append(img, label, btn);
      return li;
    }),
  );
  const list = (box: string, count: string, ul: string, items: string[]) => {
    $(box).hidden = !items.length;
    $(count).textContent = String(items.length);
    $(ul).replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  };
  list('#errorBox', '#errorCount', '#errorList', errors.map((e) => `${e.path}: ${e.reason}`));
  list('#paddedBox', '#paddedCount', '#paddedList', layout.padded.map(name));
  const shown = layout.columns.reduce((n, c) => n + c.cells.length, 0);
  $('#count').textContent = photos.size ? `${shown} shown of ${photos.size}` : '';
}

document.fonts.ready.then(() => Object.values(FONTS).forEach((f) => document.fonts.load(f.css.replace('1em', '40px'))));
update({});
rebuild();
renderFileStatus();

// Test/debug hook (used by the Playwright suite).
Object.assign(window, {
  __wc: {
    get phase() { return phase; },
    set phase(v: number) { phase = v; },
    pause: () => setPlaying(false),
    layout: () => layout,
    renderer,
    dupOf: () => dupOf,
    flags: () => flags,
    file,
    configText,
    /** Use a folder handle as the save target (tests use browser-private storage, which needs no prompt). */
    useFolder: (handle: FileSystemDirectoryHandle) => useTarget({ name: handle.name, handle, writable: false, broken: false }),
    errors: () => errors,
    photos,
  },
});
