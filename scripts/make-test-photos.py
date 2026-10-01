#!/usr/bin/env python3
"""Generate a nested synthetic test set covering the layout's edge cases.

Usage:  python3 scripts/make-test-photos.py test-photos      (needs Pillow; HEIC via macOS `sips`)

Produces portrait / landscape / panorama / very tall / square / tiny photos in nested folders,
EXIF-rotated JPEGs (stored sideways, tagged orientation 6/8), PNG + WebP, near-duplicates
(re-encoded + resized copies), HEIC files, a corrupt file and a non-image file.
Each photo shows its name, intended orientation and an "UP ↑" marker so rotation bugs are obvious.
"""
import random
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "test-photos")
rng = random.Random(7)
PASTELS = [(233, 196, 190), (196, 214, 200), (205, 214, 233), (240, 222, 190), (220, 200, 225), (190, 220, 222)]


def font(size):
    for p in ["/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"]:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def picture(w, h, label, seed):
    r = random.Random(seed)
    base = r.choice(PASTELS)
    img = Image.new("RGB", (w, h), base)
    d = ImageDraw.Draw(img)
    for _ in range(14):  # distinct content per photo so fingerprints differ
        c = tuple(max(0, min(255, v + r.randint(-70, 40))) for v in base)
        x, y = r.randint(0, w), r.randint(0, h)
        s = r.randint(min(w, h) // 8, min(w, h) // 2)
        (d.ellipse if r.random() < 0.5 else d.rectangle)([x - s, y - s, x + s, y + s], fill=c)
    d.rectangle([0, 0, w - 1, h - 1], outline=(120, 90, 80), width=max(4, min(w, h) // 80))  # crop detector
    f = font(max(18, min(w, h) // 12))
    d.text((w / 2, h / 2), label, fill=(70, 50, 45), font=f, anchor="mm")
    d.text((w / 2, max(20, h // 14)), "UP ↑", fill=(70, 50, 45), font=f, anchor="mt")
    return img


def save(img, rel, **kw):
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, **kw)
    return path


def rotated_jpeg(w, h, label, rel, orientation):
    """Upright w×h picture stored sideways with an EXIF tag that rotates it back."""
    img = picture(w, h, label, rel)
    stored = img.transpose(Image.ROTATE_90 if orientation == 6 else Image.ROTATE_270)
    exif = Image.Exif()
    exif[0x0112] = orientation
    save(stored, rel, quality=90, exif=exif.tobytes())


if OUT.exists():
    shutil.rmtree(OUT)

specs = [  # (folder, w, h, label)
    ("dinner", 3000, 2000, "landscape 3:2"), ("dinner", 4032, 3024, "landscape 4:3"),
    ("dinner", 1920, 1080, "landscape 16:9"), ("dinner", 2000, 3000, "portrait 2:3"),
    ("dinner", 3024, 4032, "portrait 3:4"), ("dinner", 1080, 1920, "portrait 9:16"),
    ("dinner/speeches", 2400, 2400, "square"), ("dinner/speeches", 6000, 1400, "panorama 4.3:1"),
    ("dinner/speeches", 900, 2700, "very tall 1:3"), ("dinner/speeches", 640, 480, "tiny 640"),
    ("ceremony", 5000, 1500, "wide 3.3:1"), ("ceremony", 1200, 1500, "portrait 4:5"),
    ("ceremony/family", 2048, 1365, "landscape small"), ("ceremony/family", 1365, 2048, "portrait small"),
]
for i in range(36):  # bulk so the strip is long enough to exercise lazy loading
    w, h = rng.choice([(3000, 2000), (4032, 3024), (2000, 3000), (3024, 4032), (1920, 1080), (2400, 2400)])
    specs.append((rng.choice(["dinner", "ceremony", "ceremony/family", "party/late"]), w, h, f"bulk {i}"))

for n, (folder, w, h, label) in enumerate(specs):
    ext = [".jpg", ".jpg", ".png", ".webp"][n % 4]
    rel = f"{folder}/{n:03d}-{label.replace(' ', '_').replace(':', 'x')}{ext}"
    save(picture(w, h, label, n), rel, **({"quality": 88} if ext == ".jpg" else {}))

# EXIF orientation: stored sideways, displayed upright.
rotated_jpeg(2000, 3000, "EXIF 6 portrait", "rotated/exif6-portrait.jpg", 6)
rotated_jpeg(3000, 2000, "EXIF 8 landscape", "rotated/exif8-landscape.jpg", 8)

# Near-duplicates: same picture re-encoded smaller (kept: the original, higher resolution).
orig = picture(3000, 2000, "dup original", "dup")
save(orig, "phones/don/dup-original.jpg", quality=92)
save(orig.resize((1200, 800)), "phones/pam/dup-whatsapp.jpg", quality=60)

# HEIC via macOS sips (skipped elsewhere).
if shutil.which("sips"):
    for i, (w, h) in enumerate([(4032, 3024), (3024, 4032)]):
        src = save(picture(w, h, f"HEIC {w}x{h}", f"heic{i}"), f"iphone/IMG_{1000 + i}.png")
        subprocess.run(["sips", "-s", "format", "heic", str(src), "--out", str(src.with_suffix(".HEIC"))],
                       check=True, capture_output=True)
        src.unlink()

(OUT / "broken").mkdir(parents=True, exist_ok=True)
(OUT / "broken" / "corrupt.jpg").write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")
(OUT / "broken" / "notes.txt").write_text("not an image")
print(f"wrote {sum(1 for p in OUT.rglob('*') if p.is_file())} files to {OUT}")
