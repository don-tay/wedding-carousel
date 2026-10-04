/** Turning dropped files and folders into decoded, fingerprinted photos. */
import type { Fingerprint } from './order';

export interface Photo extends Fingerprint {
  id: string; // name|size — stable across re-drops, used for flags
  name: string;
  path: string;
  bytes: number;
  source: Blob; // decodable by <img> (HEIC is converted to JPEG where the browser can't decode it)
  url: string;
  w: number; // oriented pixel size
  h: number;
  thumb: HTMLCanvasElement; // ≤ 320 px, used as a placeholder and in the hidden list
}

export interface FileEntry {
  file: File;
  path: string;
}
export interface IngestError {
  path: string;
  reason: string;
}

const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const ACCEPT = /\.(jpe?g|png|webp|heic|heif|json)$/i; // images + the settings file
export const isImage = (path: string) => IMAGE.test(path);
const HEIC = /\.(heic|heif)$/i;

// ---------- collecting files ----------

/** Must be called synchronously inside the drop handler (entries expire after it returns). */
export function collectDropped(dt: DataTransfer): Promise<FileEntry[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Promise.resolve(fromFileList(dt.files));
  return Promise.all(entries.map(walk)).then((r) => r.flat().filter((f) => ACCEPT.test(f.path)));
}

export function fromFileList(files: FileList | File[]): FileEntry[] {
  return [...files]
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    .filter((f) => ACCEPT.test(f.path));
}

/** Chrome: files under a folder handle (from showDirectoryPicker or a drop). */
export async function walkHandle(dir: FileSystemDirectoryHandle, prefix = dir.name): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for await (const h of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    const path = `${prefix}/${h.name}`;
    if (h.kind === 'directory') out.push(...(await walkHandle(h as FileSystemDirectoryHandle, path)));
    else if (ACCEPT.test(h.name)) out.push({ file: await (h as FileSystemFileHandle).getFile(), path });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function walk(entry: FileSystemEntry): Promise<FileEntry[]> {
  const path = entry.fullPath.replace(/^\//, '');
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [{ file, path }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(walk))).flat();
}

// ---------- decoding ----------

export function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  return img.decode().then(() => img);
}

let heicQueue: Promise<unknown> = Promise.resolve();
/** libheif (WASM) fallback for browsers without native HEIC — Chrome. Serialised: one decoder instance. */
function convertHeic(file: Blob): Promise<Blob> {
  const job = heicQueue.then(async () => {
    const { heicTo } = await import('heic-to');
    return heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  });
  heicQueue = job.catch(() => {});
  return job;
}

/** Downscale in halving steps so large photos stay sharp without moiré. */
export function scaleTo(src: CanvasImageSource, sw: number, sh: number, tw: number, th: number): HTMLCanvasElement {
  let cur: CanvasImageSource = src;
  let [w, h] = [sw, sh];
  while (w / 2 >= tw && h / 2 >= th) {
    [w, h] = [Math.round(w / 2), Math.round(h / 2)];
    cur = draw(cur, w, h);
  }
  return draw(cur, tw, th);
}
function draw(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function fingerprint(thumb: HTMLCanvasElement): Pick<Fingerprint, 'hash' | 'color'> {
  const px = (w: number, h: number) =>
    draw(thumb, w, h).getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const g = px(9, 8);
  const lum = (i: number) => 0.299 * g[i * 4] + 0.587 * g[i * 4 + 1] + 0.114 * g[i * 4 + 2];
  const hash = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash[y * 8 + x] = lum(y * 9 + x) < lum(y * 9 + x + 1) ? 1 : 0;
  const c = px(4, 4);
  const color = new Float32Array(48);
  for (let i = 0; i < 16; i++) for (let k = 0; k < 3; k++) color[i * 3 + k] = c[i * 4 + k] / 255;
  return { hash, color };
}

export async function decodePhoto({ file, path }: FileEntry): Promise<Photo> {
  let source: Blob = file;
  let url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } catch {
    URL.revokeObjectURL(url);
    if (!HEIC.test(path)) throw new Error('not a readable image (corrupt or unsupported)');
    try {
      source = await convertHeic(file);
    } catch (e) {
      throw new Error(`HEIC decode failed: ${e instanceof Error ? e.message : e}`);
    }
    url = URL.createObjectURL(source);
    img = await loadImage(url);
  }
  const [w, h] = [img.naturalWidth, img.naturalHeight]; // already EXIF-oriented
  if (!w || !h) throw new Error('image has no pixels');
  const k = Math.min(1, 320 / Math.max(w, h));
  const thumb = scaleTo(img, w, h, Math.round(w * k), Math.round(h * k));
  return {
    id: `${file.name}|${file.size}`,
    name: file.name,
    path,
    bytes: file.size,
    source,
    url,
    w,
    h,
    aspect: w / h,
    thumb,
    ...fingerprint(thumb),
  };
}

/** Decode many files with limited concurrency, reporting progress; bad files become errors. */
export async function decodeAll(
  entries: FileEntry[],
  onProgress: (done: number, total: number, heic: boolean) => void,
): Promise<{ photos: Photo[]; errors: IngestError[] }> {
  const photos: Photo[] = [];
  const errors: IngestError[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < entries.length) {
      const e = entries[next++];
      try {
        photos.push(await decodePhoto(e));
      } catch (err) {
        errors.push({ path: e.path, reason: err instanceof Error ? err.message : String(err) });
      }
      onProgress(++done, entries.length, HEIC.test(e.path));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { photos, errors };
}
