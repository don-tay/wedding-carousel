/** Reading wedding-carousel.json from dropped folders, and writing it back (Chrome) or downloading it (Safari). */
import { CONFIG_NAME, CONFLICT_COPY, parseConfig, type ConfigFile } from './config';
import type { FileEntry } from './ingest';

export interface Root {
  name: string; // top-level dropped folder ('' for loose files)
  config?: ConfigFile;
  broken?: string; // why its wedding-carousel.json couldn't be read
}

export const rootOf = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '');
const isTopLevel = (path: string) => path.split('/').length <= 2;
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Dropped roots in drop order, with their settings files, plus warnings about conflict copies / broken files. */
export async function readRoots(entries: FileEntry[]): Promise<{ roots: Root[]; warnings: string[] }> {
  const roots = new Map<string, Root>();
  const warnings: string[] = [];
  for (const e of entries) if (!roots.has(rootOf(e.path))) roots.set(rootOf(e.path), { name: rootOf(e.path) });
  for (const e of entries) {
    if (!e.path.endsWith('.json') || !isTopLevel(e.path)) continue;
    const root = roots.get(rootOf(e.path))!;
    const name = baseName(e.path);
    if (name === CONFIG_NAME) {
      try {
        root.config = parseConfig(await e.file.text());
      } catch (err) {
        root.broken = err instanceof Error ? err.message : String(err);
        warnings.push(`${e.path} couldn't be read (${root.broken}). Using this browser's settings; the file won't be overwritten.`);
      }
    } else if (CONFLICT_COPY.test(name)) {
      warnings.push(`Ignored ${e.path}: it looks like a conflict copy made by iCloud. Delete it once you've checked ${CONFIG_NAME}.`);
    }
  }
  return { roots: [...roots.values()], warnings };
}

type Permission = 'granted' | 'denied' | 'prompt';
const perm = (h: FileSystemDirectoryHandle, ask: boolean): Promise<Permission> => {
  const api = h as any;
  if (!api.queryPermission) return Promise.resolve('granted'); // e.g. browser-private storage
  return ask ? api.requestPermission({ mode: 'readwrite' }) : api.queryPermission({ mode: 'readwrite' });
};
export const canWrite = (h: FileSystemDirectoryHandle) => perm(h, false).then((p) => p === 'granted');
export const askToWrite = (h: FileSystemDirectoryHandle) => perm(h, true).then((p) => p === 'granted');

export async function writeConfig(dir: FileSystemDirectoryHandle, text: string) {
  const file = await dir.getFileHandle(CONFIG_NAME, { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
}

export function downloadConfig(text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = CONFIG_NAME;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const hasFolderPicker = () => 'showDirectoryPicker' in window;
export const pickFolder = (): Promise<FileSystemDirectoryHandle> => (window as any).showDirectoryPicker({ id: 'photos' });

/** Must be called synchronously in the drop handler. Chrome only; elsewhere resolves to []. */
export function droppedHandles(dt: DataTransfer): Promise<FileSystemDirectoryHandle[]> {
  const pending = [...dt.items]
    .filter((i) => i.kind === 'file' && 'getAsFileSystemHandle' in i)
    .map((i) => (i as any).getAsFileSystemHandle() as Promise<FileSystemHandle | null>);
  return Promise.all(pending)
    .then((hs) => hs.filter((h): h is FileSystemDirectoryHandle => h?.kind === 'directory'))
    .catch(() => []);
}
