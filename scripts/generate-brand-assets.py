#!/usr/bin/env python3
"""
Derive the macOS iconset from the approved Chunky artwork.

This script contains NO artwork. Its only input is the approved, immutable
raster committed at assets/brand/chunky-minimal-purple.png, and its only
operations are mechanical:

  1. uniform scale (aspect ratio preserved, no crop, no stretch)
  2. centre on a square, fully transparent canvas
  3. write the canonical Apple .iconset PNGs

Nothing is recoloured, redrawn, padded asymmetrically, composited onto a tile,
or otherwise reinterpreted. The alpha channel of the approved artwork is
carried through untouched, including the artwork's own bottom edge, which is
part of the approved composition.

Every size is resampled directly from the approved PNG in a single LANCZOS
step (never from an intermediate master), so no size accumulates resampling
error from another.

Layout follows Apple's icon grid: the artwork is fitted inside an 824x824
content box centred on a 1024x1024 canvas, i.e. the content box is
824/1024 = 0.8046875 of each edge at every size.

Usage
    python3 scripts/generate-brand-assets.py                 # write the iconset
    python3 scripts/generate-brand-assets.py --check         # verify, exit 1 on drift
    python3 scripts/generate-brand-assets.py --contact-sheet # QA sheet outside the repo
"""

from __future__ import annotations

import argparse
import filecmp
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: python3 -m pip install --user Pillow")

ROOT = Path(__file__).resolve().parent.parent

# The approved artwork. This file is a byte-identical copy of the Chunky asset
# package's chunky-minimal-purple.png and must never be edited in place.
SOURCE = ROOT / "assets" / "brand" / "chunky-minimal-purple.png"
# The in-app mark is the approved artwork's SVG container, used verbatim.
MARK_SOURCE = ROOT / "assets" / "brand" / "chunky-minimal-purple-exact.svg"
MARK_DEST = ROOT / "src" / "mainview" / "public" / "chunky-mark.svg"
ICONSET = ROOT / "assets" / "icon.iconset"

# Apple's content box: 824 of 1024 per edge.
CONTENT_RATIO = 824 / 1024

ICONSET_SIZES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def load_source() -> Image.Image:
    if not SOURCE.exists():
        sys.exit(f"missing approved artwork: {SOURCE}")
    art = Image.open(SOURCE)
    if art.mode != "RGBA":
        art = art.convert("RGBA")
    return art


def render(art: Image.Image, size: int) -> Image.Image:
    """Uniformly scale the approved artwork into `size`'s content box and
    centre it on a transparent square canvas."""
    box = size * CONTENT_RATIO
    w, h = art.size
    scale = min(box / w, box / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(art.resize((nw, nh), Image.LANCZOS), ((size - nw) // 2, (size - nh) // 2))
    return canvas


def write_iconset(art: Image.Image) -> None:
    ICONSET.mkdir(parents=True, exist_ok=True)
    for name, size in ICONSET_SIZES:
        render(art, size).save(ICONSET / name)
    print(f"wrote {len(ICONSET_SIZES)} files to {ICONSET}")


def check(art: Image.Image) -> int:
    """Fail if anything committed differs from what the approved source
    produces, or if the in-app mark is not the approved SVG verbatim."""
    failures: list[str] = []

    if not MARK_DEST.exists() or not filecmp.cmp(MARK_SOURCE, MARK_DEST, shallow=False):
        failures.append(f"{MARK_DEST.relative_to(ROOT)} is not byte-identical to "
                        f"{MARK_SOURCE.relative_to(ROOT)}")
    else:
        print(f"  ok  {MARK_DEST.relative_to(ROOT)} == {MARK_SOURCE.relative_to(ROOT)}")

    for name, size in ICONSET_SIZES:
        path = ICONSET / name
        if not path.exists():
            failures.append(f"missing {path.relative_to(ROOT)}")
            continue
        expected = render(art, size)
        actual = Image.open(path)
        if actual.mode != "RGBA":
            actual = actual.convert("RGBA")
        if actual.size != expected.size:
            failures.append(f"{name}: size {actual.size} != {expected.size}")
        # Compare the raw RGBA buffers. ImageChops.difference(...).getbbox() is
        # NOT usable here: on an RGBA difference the alpha band is all zero, and
        # getbbox() treats that as an empty image, so colour-only drift would
        # silently pass.
        elif actual.tobytes() != expected.tobytes():
            failures.append(f"{name}: pixels differ from source-derived output")
        else:
            print(f"  ok  {name} ({size}px) matches source-derived output")

    if failures:
        print("\nFAIL: committed assets are out of sync with the approved artwork:")
        for f in failures:
            print(f"  - {f}")
        print("\nRun `bun run icons` to regenerate.")
        return 1
    print("\nOK: every committed asset is derived from the approved artwork.")
    return 0


def contact_sheet(art: Image.Image, path: Path) -> None:
    """QA sheet on light and dark bands. Written outside the repo."""
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    pad = 24
    height = 1024 + 2 * pad
    width = sum(s + pad for s in sizes) + pad
    sheet = Image.new("RGBA", (width, height * 2), (244, 244, 247, 255))
    sheet.paste(Image.new("RGBA", (width, height), (26, 18, 38, 255)), (0, height))
    x = pad
    for s in sizes:
        tile = render(art, s)
        sheet.alpha_composite(tile, (x, pad + (1024 - s) // 2))
        sheet.alpha_composite(tile, (x, height + pad + (1024 - s) // 2))
        x += s + pad
    sheet.convert("RGB").save(path)
    print(f"contact sheet: {path}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--check", action="store_true",
                    help="verify committed assets match the approved artwork; exit 1 on drift")
    ap.add_argument("--contact-sheet", nargs="?", const="", metavar="PATH",
                    help="write a QA contact sheet (defaults to a temp dir, never the repo)")
    args = ap.parse_args()

    art = load_source()
    print(f"approved artwork: {SOURCE.relative_to(ROOT)} {art.size[0]}x{art.size[1]} {art.mode}")

    if args.contact_sheet is not None:
        target = Path(args.contact_sheet) if args.contact_sheet else \
            Path(tempfile.gettempdir()) / "chunky-icon-contact-sheet.png"
        contact_sheet(art, target)

    if args.check:
        return check(art)

    write_iconset(art)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
