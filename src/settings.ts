/** User settings, fonts, colours, and localStorage persistence (per photo set). */

export const FONTS = {
  formal: { label: 'Formal script', css: '400 1em "Pinyon Script"', size: 1 },
  flowing: { label: 'Flowing script', css: '400 1em "Great Vibes"', size: 1 },
  soft: { label: 'Soft script', css: '400 1em "Allura"', size: 1.05 },
  serif: { label: 'Romantic serif', css: 'italic 500 1em "Cormorant Garamond"', size: 0.85 },
  clean: { label: 'Clean', css: '400 1em "Jost"', size: 0.68 },
} as const;
export type FontKey = keyof typeof FONTS;

export const BACKGROUNDS = [
  { label: 'Warm beige', color: '#f4ede2' },
  { label: 'Blush', color: '#f6e8e4' },
  { label: 'Sage', color: '#e9ede3' },
  { label: 'Ivory', color: '#fbf8f1' },
  { label: 'Dusty blue', color: '#e6ecf1' },
  { label: 'Champagne', color: '#f3e9d8' },
];

export interface Settings {
  title: string;
  showTitle: boolean;
  font: FontKey;
  background: string;
  titleColor: string | null; // null = automatic
  secondsPerScreen: number;
  seed: number;
}

export const DEFAULTS: Settings = {
  title: 'Before the Vows',
  showTitle: true,
  font: 'formal',
  background: BACKGROUNDS[0].color,
  titleColor: null,
  secondsPerScreen: 25,
  seed: 1,
};

export interface PhotoFlags {
  featured?: boolean;
  hidden?: boolean;
  keepDuplicate?: boolean;
}

/** A muted, darker tone of the background's hue: warm brown on beige, deep rose on blush, etc. */
export function autoTitleColor(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return hslToHex(h, max === min ? 0 : 0.3, l > 0.5 ? 0.36 : 0.86);
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function titleColor(s: Settings): string {
  return s.titleColor ?? autoTitleColor(s.background);
}

/** Stable key for a set of photos, so each set remembers its own settings. */
export function setKey(ids: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const id of ids.slice().sort()) {
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 10, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};
const write = (key: string, v: unknown) => localStorage.setItem(key, JSON.stringify(v));

export const store = {
  /** Settings for this set; a new set inherits the last-used settings. */
  loadSettings(key: string): Settings {
    return { ...DEFAULTS, ...read<Settings>('wc:last'), ...read<Settings>(`wc:set:${key}`) };
  },
  saveSettings(key: string | null, s: Settings) {
    write('wc:last', s);
    if (key) write(`wc:set:${key}`, s);
  },
  loadFlags: (): Record<string, PhotoFlags> => read('wc:flags') ?? {},
  saveFlags: (f: Record<string, PhotoFlags>) => write('wc:flags', f),
};
