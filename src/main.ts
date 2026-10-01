/** App wiring: state, ingest, animation clock, controls and settings drawer. */
import '@fontsource/pinyon-script/latin-400.css';
import '@fontsource/great-vibes/latin-400.css';
import '@fontsource/allura/latin-400.css';
import '@fontsource/cormorant-garamond/latin-500-italic.css';
import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-500.css';
import './style.css';

import { collectDropped, decodeAll, fromFileList, type FileEntry, type IngestError, type Photo } from './ingest';
import { buildLayout, type Layout } from './layout';
import { findDuplicates, isSimilar, shuffle, spreadSimilar } from './order';
import { Renderer } from './renderer';
import { BACKGROUNDS, FONTS, setKey, store, titleColor, type FontKey, type Settings } from './settings';

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
}

function setFlag(id: string, patch: Partial<(typeof flags)[string]>) {
  flags = { ...flags, [id]: { ...flags[id], ...patch } };
  store.saveFlags(flags);
  rebuild();
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
async function addEntries(entries: FileEntry[]) {
  const seen = new Set(photos.keys());
  const fresh = entries.filter(({ file }) => {
    const id = `${file.name}|${file.size}`;
    return !seen.has(id) && !!seen.add(id);
  });
  if (!fresh.length) return;
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
  key = setKey([...photos.keys()]);
  settings = store.loadSettings(key);
  update({});
  rebuild();
}

function clearAll() {
  for (const p of photos.values()) URL.revokeObjectURL(p.url);
  photos.clear();
  errors = [];
  key = null;
  renderer.clearCache();
  phase = 0;
  rebuild();
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
  if (e.dataTransfer) collectDropped(e.dataTransfer).then(addEntries);
});
for (const b of document.querySelectorAll<HTMLElement>('[data-pick]')) {
  b.onclick = () => $(b.dataset.pick === 'folder' ? '#pickFolder' : '#pickFiles').click();
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

// Test/debug hook (used by the Playwright suite).
Object.assign(window, {
  __wc: {
    get phase() { return phase; },
    set phase(v: number) { phase = v; },
    pause: () => setPlaying(false),
    layout: () => layout,
    renderer,
    dupOf: () => dupOf,
    errors: () => errors,
    photos,
  },
});
