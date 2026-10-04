/** The portable settings file that lives next to the photos: wedding-carousel.json. */
import { DEFAULTS, FONTS, type PhotoFlags, type Settings } from './settings';

export const CONFIG_NAME = 'wedding-carousel.json';
/** iCloud / Finder / browser-download conflict copies: "wedding-carousel 2.json", "wedding-carousel (1).json". */
export const CONFLICT_COPY = /^wedding-carousel[\s_-]*\(?\d+\)?\.json$/i;

export type PhotoMap = Record<string, PhotoFlags>; // key: "name|size"

export interface ConfigFile {
  settings: Settings;
  photos: PhotoMap;
}

const FLAG_KEYS = ['featured', 'hidden', 'keepDuplicate'] as const;

export function parseConfig(text: string): ConfigFile {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || typeof raw.settings !== 'object' || typeof raw.photos !== 'object') {
    throw new Error('not a wedding-carousel settings file');
  }
  const settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = raw.settings[k];
    const ok =
      k === 'titleColor' ? v === null || /^#[0-9a-f]{6}$/i.test(v) : k === 'font' ? v in FONTS : typeof v === typeof DEFAULTS[k];
    if (v !== undefined && ok) (settings as Record<string, unknown>)[k] = v;
  }
  return { settings, photos: cleanPhotos(raw.photos) };
}

function cleanPhotos(raw: Record<string, unknown>): PhotoMap {
  const out: PhotoMap = {};
  for (const [id, f] of Object.entries(raw ?? {})) {
    const flags: PhotoFlags = {};
    for (const k of FLAG_KEYS) if ((f as PhotoFlags)?.[k] === true) flags[k] = true;
    if (Object.keys(flags).length) out[id] = flags;
  }
  return out;
}

export function serializeConfig(settings: Settings, photos: PhotoMap): string {
  const sorted = Object.fromEntries(Object.entries(cleanPhotos(photos)).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify({ app: 'wedding-carousel', version: 1, settings, photos: sorted }, null, 2) + '\n';
}

/** First file sets the look; photo choices from all files combine (earlier files win per photo). */
export function mergeConfigs(files: readonly ConfigFile[]): ConfigFile {
  const photos: PhotoMap = {};
  for (const f of [...files].reverse()) Object.assign(photos, f.photos);
  return { settings: files[0].settings, photos };
}

export const nameOf = (id: string) => id.slice(0, id.lastIndexOf('|'));

/**
 * Re-key entries to the photos actually present: exact "name|size" first, then the same name with a
 * different size (re-exported photo). Returns flags for present photos and the entries left over.
 */
export function adopt(photos: PhotoMap, ids: readonly string[]): { matched: PhotoMap; rest: PhotoMap } {
  const rest = { ...photos };
  const matched: PhotoMap = {};
  for (const id of ids) {
    if (rest[id]) {
      matched[id] = rest[id];
      delete rest[id];
    }
  }
  const byName = new Map<string, string>();
  for (const key of Object.keys(rest)) if (!byName.has(nameOf(key))) byName.set(nameOf(key), key);
  for (const id of ids) {
    const key = matched[id] ? undefined : byName.get(nameOf(id));
    if (key && rest[key]) {
      matched[id] = rest[key];
      delete rest[key];
    }
  }
  return { matched, rest };
}
