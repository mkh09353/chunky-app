#!/usr/bin/env python3
"""
Chunky brand asset generator — the single parametric source of truth for the
Chunky logo, macOS app icon, and in-app mark.

The artwork is defined here as geometry (no hand-tuned raster is ever edited),
and every deliverable is emitted from that one definition, so a design tweak
here regenerates a byte-consistent set:

    assets/brand/chunky-icon.svg      vector master, 1024x1024 icon tile + mark
    assets/brand/chunky-icon-1024.png 1024x1024 raster master (RGBA, alpha
                                      outside the rounded tile)
    assets/icon.iconset/*.png         the 10 canonical Apple iconset files,
                                      each resampled from the 1024 master
    src/mainview/public/chunky-mark.svg  glyph-only vector mark used by the UI
                                      (Sidebar, OnboardingWizard, favicon)

The mark: a chunky geometric "C" (a heavy open ring) with a terminal block
caret seated in its mouth — Chunky's initial doubling as a shell prompt.

Rasterisation is done with Pillow only (no SVG rendering dependency): shapes
are flattened to polygons at 4x supersampling and resolved with LANCZOS, which
is what keeps the 16px rendering clean.

Usage
    python3 scripts/generate-brand-assets.py            # write all assets
    python3 scripts/generate-brand-assets.py --check    # + geometry/legibility report
    python3 scripts/generate-brand-assets.py --preview /tmp/chunky-icons.png
    python3 scripts/generate-brand-assets.py --dry-run  # report only, write nothing

Then, for the macOS bundle icon (Electrobun does this during `bun run build`):
    iconutil -c icns -o /tmp/AppIcon.icns assets/icon.iconset
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: python3 -m pip install --user Pillow")

ROOT = Path(__file__).resolve().parent.parent

# ── Canvas ───────────────────────────────────────────────────────────────────
S = 1024  # master canvas edge, in design units == px
SS = 4  # supersampling factor used while rasterising

# macOS app icons draw into an 824x824 content box inside a 1024 canvas; the
# 100px inset is the optical margin Finder/Dock expect, and the canvas outside
# the tile stays fully transparent.
TILE_INSET = 100
TILE_HALF = (S - 2 * TILE_INSET) / 2  # 412
# Superellipse exponent. n=5 puts the 45-degree point at 0.871*half, i.e. an
# effective corner radius of ~0.442*half (~182 of 412) — the macOS "squircle",
# with continuous curvature rather than a circular-cornered rectangle.
SQUIRCLE_N = 5.0

# ── Mark geometry (ring-centred design units, scaled by GLYPH_SCALE) ─────────
GLYPH_SCALE = 1.12
R_OUT = 248 * GLYPH_SCALE  # outer radius of the C
STROKE = 116 * GLYPH_SCALE  # ring thickness — ~23% of the outer diameter
R_IN = R_OUT - STROKE
# Half-angle of the C's opening (faces +x). 54deg (a 108deg mouth) is the
# tightest aperture that still keeps ~1.5px of daylight between the caret and
# the ring terminals at 16px; tighter reads as a better C but fuses when small.
MOUTH_HALF_DEG = 54.0
# Caret width tracks the ring stroke (~1:1) so the two forms share a rhythm;
# 1:1.7 proportions read as a terminal block cursor rather than a dot.
CARET_W = 112 * GLYPH_SCALE
CARET_H = 190 * GLYPH_SCALE
CARET_R = 24 * GLYPH_SCALE  # caret corner radius
CARET_CX = 222 * GLYPH_SCALE  # caret centre, out along the mouth axis

# Centring. Bounding-box centring alone leaves the composition left-heavy: the
# ring carries ~82% of the ink and its mass sits left of the box centre, while
# the caret is a small outrider on the right. We split the difference between
# the bounding-box centre and the true area centroid — the standard optical
# centring compromise — so the tile looks balanced without the caret crowding
# the right margin.
CENTER_BIAS = 0.5  # 0 = bounding box, 1 = area centroid


def _mark_centroid_x() -> float:
    """Area centroid of (ring + caret) about the ring centre, analytically."""
    theta = math.radians(180.0 - MOUTH_HALF_DEG)  # half-angle about the bisector
    ring_area = theta * (R_OUT**2 - R_IN**2)
    # Annular-sector centroid, along the bisector (pointing -x here).
    ring_x = -(2 * math.sin(theta) / (3 * theta)) * (R_OUT**3 - R_IN**3) / (R_OUT**2 - R_IN**2)
    caret_area = CARET_W * CARET_H - (4 - math.pi) * CARET_R**2
    return (ring_area * ring_x + caret_area * CARET_CX) / (ring_area + caret_area)


_GX0, _GX1 = -R_OUT, CARET_CX + CARET_W / 2
_GY0, _GY1 = -R_OUT, R_OUT
_BOX_CX = (_GX0 + _GX1) / 2
_ANCHOR_X = _BOX_CX + CENTER_BIAS * (_mark_centroid_x() - _BOX_CX)
RING_CX = S / 2 - _ANCHOR_X
RING_CY = S / 2
GLYPH_BOX = (RING_CX + _GX0, RING_CY + _GY0, RING_CX + _GX1, RING_CY + _GY1)

# ── Palette ──────────────────────────────────────────────────────────────────
# Tile: deep, near-black purple, lit from the top-left.
BG_STOPS = [(0.0, "#33225E"), (0.52, "#1B1233"), (1.0, "#0D0817")]
BG_P1 = (TILE_INSET, TILE_INSET)
BG_P2 = (S - TILE_INSET, S - TILE_INSET)

# Primary-purple bloom behind the mark, so the tile is not flat.
GLOW_COLOR = "#7C4DDB"
GLOW_STOPS = [(0.0, 0.34), (0.55, 0.13), (1.0, 0.0)]
GLOW_R = 0.52 * S

# The C: lighter violet highlight -> Chunky primary -> deep violet shadow.
MARK_STOPS = [(0.0, "#B394FF"), (0.46, "#7C4DDB"), (1.0, "#5A2EB6")]
# The caret is the brightest element so the motif survives at 16px.
CARET_STOPS = [(0.0, "#F4EEFF"), (1.0, "#BCA1FF")]

# The in-app mark is the same geometry on an *unknown* surface: it sits in a
# bg-primary/10 chip that is near-white in the light theme and near-black in
# the dark one, with no tile to guarantee contrast. The icon's ramp fails there
# at both ends (the near-white caret disappears on light, the #5A2EB6 tail
# disappears on dark), so the UI mark is confined to the mid band -- lighter
# violet highlight to Chunky primary -- which stays legible on both themes, and
# the caret shares that one gradient instead of being a bright highlight.
MARK_UI_STOPS = [(0.0, "#A98CFF"), (1.0, "#7C4DDB")]

# Hairline top-edge highlight; reads as a lit bevel, invisible below 32px.
EDGE_COLOR = "#FFFFFF"
EDGE_ALPHA = 0.13
EDGE_WIDTH = 3.5

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


# ── Geometry helpers ─────────────────────────────────────────────────────────
def squircle_points(cx: float, cy: float, half: float, n: float, steps: int = 2048):
    """Superellipse |x/a|^n + |y/a|^n = 1, sampled as a closed polygon."""
    e = 2.0 / n
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = math.copysign(abs(ct) ** e, ct)
        y = math.copysign(abs(st) ** e, st)
        pts.append((cx + half * x, cy + half * y))
    return pts


def polar(cx: float, cy: float, r: float, deg: float):
    """Math-convention angle (CCW, 0 = +x) in a y-down canvas."""
    a = math.radians(deg)
    return (cx + r * math.cos(a), cy - r * math.sin(a))


def ring_points(step: float = 0.4):
    """The open C as one simple closed polygon (outer arc, cut, inner arc)."""
    a0, a1 = MOUTH_HALF_DEG, 360.0 - MOUTH_HALF_DEG
    pts = []
    n = int((a1 - a0) / step)
    for i in range(n + 1):
        pts.append(polar(RING_CX, RING_CY, R_OUT, a0 + (a1 - a0) * i / n))
    for i in range(n + 1):
        pts.append(polar(RING_CX, RING_CY, R_IN, a1 - (a1 - a0) * i / n))
    return pts


def caret_box():
    x = RING_CX + CARET_CX - CARET_W / 2
    y = RING_CY - CARET_H / 2
    return (x, y, x + CARET_W, y + CARET_H)


def caret_points(per_corner: int = 48):
    x0, y0, x1, y1 = caret_box()
    r = CARET_R
    pts = []
    corners = [  # (centre, start angle) walking clockwise in screen space
        ((x1 - r, y0 + r), -90.0),
        ((x1 - r, y1 - r), 0.0),
        ((x0 + r, y1 - r), 90.0),
        ((x0 + r, y0 + r), 180.0),
    ]
    for (ccx, ccy), a0 in corners:
        for i in range(per_corner + 1):
            a = math.radians(a0 + 90.0 * i / per_corner)
            pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))
    return pts


def mouth_clearance() -> float:
    """Shortest distance between the caret and the C's cut terminals, in design
    units. This is the detail that decides 16px legibility: below ~1.2px at
    16px (~80 units) the caret fuses into the ring and the motif dies."""
    a = math.radians(MOUTH_HALF_DEG)
    best = float("inf")
    # Sample the caret outline against both radial cut faces of the ring.
    for px, py in caret_points(96):
        dx, dy = px - RING_CX, RING_CY - py  # to math orientation
        for sign in (1.0, -1.0):
            ux, uy = math.cos(a), sign * math.sin(a)
            proj = dx * ux + dy * uy
            if R_IN <= proj <= R_OUT:
                d = abs(dx * -uy + dy * ux)  # perpendicular to the cut face
            else:
                end = R_IN if proj < R_IN else R_OUT
                d = math.hypot(dx - ux * end, dy - uy * end)
            best = min(best, d)
    return best


# ── Colour / gradient helpers ────────────────────────────────────────────────
def hex_rgb(value: str):
    v = value.lstrip("#")
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def _lut(stops, n=1025):
    """Pre-sample colour (or scalar) stops into a lookup table."""
    scalar = isinstance(stops[0][1], (int, float))
    vals = [(o, (float(c) if scalar else hex_rgb(c))) for o, c in stops]
    out = []
    for i in range(n):
        t = i / (n - 1)
        if t <= vals[0][0]:
            out.append(vals[0][1])
            continue
        if t >= vals[-1][0]:
            out.append(vals[-1][1])
            continue
        for (o0, c0), (o1, c1) in zip(vals, vals[1:]):
            if o0 <= t <= o1:
                k = 0.0 if o1 == o0 else (t - o0) / (o1 - o0)
                if scalar:
                    out.append(c0 + (c1 - c0) * k)
                else:
                    out.append(tuple(round(a + (b - a) * k) for a, b in zip(c0, c1)))
                break
    return out


def linear_gradient(size: int, p1, p2, stops, res: int = 512) -> Image.Image:
    """RGB linear gradient in canvas coordinates (matches SVG userSpaceOnUse)."""
    lut = _lut(stops)
    img = Image.new("RGB", (res, res))
    px = img.load()
    scale = S / res
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    denom = dx * dx + dy * dy or 1.0
    for j in range(res):
        y = (j + 0.5) * scale
        base = (y - p1[1]) * dy
        for i in range(res):
            x = (i + 0.5) * scale
            t = ((x - p1[0]) * dx + base) / denom
            px[i, j] = lut[max(0, min(1024, int(t * 1024)))]
    return img.resize((size, size), Image.BICUBIC)


def radial_alpha(size: int, center, radius: float, stops, res: int = 512) -> Image.Image:
    """L-mode radial alpha ramp in canvas coordinates."""
    lut = _lut(stops)
    img = Image.new("L", (res, res))
    px = img.load()
    scale = S / res
    for j in range(res):
        y = (j + 0.5) * scale
        for i in range(res):
            x = (i + 0.5) * scale
            t = math.hypot(x - center[0], y - center[1]) / radius
            px[i, j] = int(255 * lut[max(0, min(1024, int(t * 1024)))])
    return img.resize((size, size), Image.BICUBIC)


def vertical_alpha(size: int, y0: float, y1: float, a0: float, a1: float) -> Image.Image:
    img = Image.new("L", (1, 256))
    px = img.load()
    for j in range(256):
        px[0, j] = int(255 * (a0 + (a1 - a0) * (j / 255)))
    top = int(size * y0 / S)
    bottom = int(size * y1 / S)
    ramp = img.resize((size, max(1, bottom - top)), Image.BICUBIC)
    out = Image.new("L", (size, size), 0)
    out.paste(ramp, (0, top))
    if bottom < size:
        out.paste(Image.new("L", (size, size - bottom), int(255 * a1)), (0, bottom))
    return out


# ── Rasteriser ───────────────────────────────────────────────────────────────
def _mask(size: int, points, scale: float) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).polygon([(x * scale, y * scale) for x, y in points], fill=255)
    return m


def render_master(ss: int = SS):
    """Composite the icon at S*ss and return (master_rgba_at_S, part_masks)."""
    size = S * ss
    scale = float(ss)

    tile_mask = _mask(size, squircle_points(S / 2, S / 2, TILE_HALF, SQUIRCLE_N), scale)
    ring_mask = _mask(size, ring_points(), scale)
    caret_mask = _mask(size, caret_points(), scale)

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    bg = linear_gradient(size, BG_P1, BG_P2, BG_STOPS).convert("RGBA")
    img.paste(bg, (0, 0), tile_mask)

    glow = radial_alpha(size, (RING_CX, RING_CY), GLOW_R, GLOW_STOPS)
    glow_layer = Image.new("RGBA", (size, size), hex_rgb(GLOW_COLOR) + (0,))
    glow_layer.putalpha(ImageChops.multiply(glow, tile_mask))
    img = Image.alpha_composite(img, glow_layer)

    edge = Image.new("L", (size, size), 0)
    ed = ImageDraw.Draw(edge)
    pts = [(x * scale, y * scale) for x, y in squircle_points(S / 2, S / 2, TILE_HALF, SQUIRCLE_N, 1024)]
    ed.line(pts + [pts[0]], fill=255, width=int(EDGE_WIDTH * scale), joint="curve")
    edge = ImageChops.multiply(edge, tile_mask)
    edge = ImageChops.multiply(edge, vertical_alpha(size, TILE_INSET, S * 0.62, EDGE_ALPHA, 0.0))
    edge_layer = Image.new("RGBA", (size, size), hex_rgb(EDGE_COLOR) + (0,))
    edge_layer.putalpha(edge)
    img = Image.alpha_composite(img, edge_layer)

    mark_grad = linear_gradient(size, (GLYPH_BOX[0], GLYPH_BOX[1]), (GLYPH_BOX[2], GLYPH_BOX[3]), MARK_STOPS)
    img.paste(mark_grad.convert("RGBA"), (0, 0), ring_mask)

    cx0, cy0, cx1, cy1 = caret_box()
    caret_grad = linear_gradient(size, (cx0, cy0), (cx1, cy1), CARET_STOPS)
    img.paste(caret_grad.convert("RGBA"), (0, 0), caret_mask)

    master = img.resize((S, S), Image.LANCZOS)
    return master, {"tile": tile_mask, "ring": ring_mask, "caret": caret_mask}


# ── SVG emitters ─────────────────────────────────────────────────────────────
def f(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def svg_tile_path() -> str:
    pts = squircle_points(S / 2, S / 2, TILE_HALF, SQUIRCLE_N, 512)
    d = f"M{f(pts[0][0])} {f(pts[0][1])}"
    d += "".join(f"L{f(x)} {f(y)}" for x, y in pts[1:])
    return d + "Z"


def svg_ring_path() -> str:
    a0, a1 = MOUTH_HALF_DEG, 360.0 - MOUTH_HALF_DEG
    o0 = polar(RING_CX, RING_CY, R_OUT, a0)
    o1 = polar(RING_CX, RING_CY, R_OUT, a1)
    i1 = polar(RING_CX, RING_CY, R_IN, a1)
    i0 = polar(RING_CX, RING_CY, R_IN, a0)
    return (
        f"M{f(o0[0])} {f(o0[1])}"
        f"A{f(R_OUT)} {f(R_OUT)} 0 1 0 {f(o1[0])} {f(o1[1])}"
        f"L{f(i1[0])} {f(i1[1])}"
        f"A{f(R_IN)} {f(R_IN)} 0 1 1 {f(i0[0])} {f(i0[1])}Z"
    )


def _stops_svg(stops, indent="      ") -> str:
    return "\n".join(f'{indent}<stop offset="{f(o)}" stop-color="{c}"/>' for o, c in stops)


def _mark_defs(indent="    ", mark_stops=None, caret_stops=None) -> str:
    cx0, cy0, cx1, cy1 = caret_box()
    out = (
        f'{indent}<linearGradient id="chunkyMark" gradientUnits="userSpaceOnUse"'
        f' x1="{f(GLYPH_BOX[0])}" y1="{f(GLYPH_BOX[1])}" x2="{f(GLYPH_BOX[2])}" y2="{f(GLYPH_BOX[3])}">\n'
        f"{_stops_svg(mark_stops or MARK_STOPS, indent + '  ')}\n"
        f"{indent}</linearGradient>"
    )
    if caret_stops:
        out += (
            f'\n{indent}<linearGradient id="chunkyCaret" gradientUnits="userSpaceOnUse"'
            f' x1="{f(cx0)}" y1="{f(cy0)}" x2="{f(cx1)}" y2="{f(cy1)}">\n'
            f"{_stops_svg(caret_stops, indent + '  ')}\n"
            f"{indent}</linearGradient>"
        )
    return out


def _mark_shapes(indent="  ", caret_fill="chunkyCaret") -> str:
    cx0, cy0, _, _ = caret_box()
    return (
        f'{indent}<path fill="url(#chunkyMark)" d="{svg_ring_path()}"/>\n'
        f'{indent}<rect fill="url(#{caret_fill})" x="{f(cx0)}" y="{f(cy0)}"'
        f' width="{f(CARET_W)}" height="{f(CARET_H)}" rx="{f(CARET_R)}"/>'
    )


def icon_svg() -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}" role="img" aria-label="Chunky">
  <title>Chunky — app icon</title>
  <desc>Generated by scripts/generate-brand-assets.py. Edit the geometry there, not this file.</desc>
  <defs>
    <linearGradient id="chunkyTile" gradientUnits="userSpaceOnUse" x1="{f(BG_P1[0])}" y1="{f(BG_P1[1])}" x2="{f(BG_P2[0])}" y2="{f(BG_P2[1])}">
{_stops_svg(BG_STOPS)}
    </linearGradient>
    <radialGradient id="chunkyGlow" gradientUnits="userSpaceOnUse" cx="{f(RING_CX)}" cy="{f(RING_CY)}" r="{f(GLOW_R)}">
{chr(10).join(f'      <stop offset="{f(o)}" stop-color="{GLOW_COLOR}" stop-opacity="{f(a)}"/>' for o, a in GLOW_STOPS)}
    </radialGradient>
    <linearGradient id="chunkyEdge" gradientUnits="userSpaceOnUse" x1="0" y1="{TILE_INSET}" x2="0" y2="{f(S * 0.62)}">
      <stop offset="0" stop-color="{EDGE_COLOR}" stop-opacity="{f(EDGE_ALPHA)}"/>
      <stop offset="1" stop-color="{EDGE_COLOR}" stop-opacity="0"/>
    </linearGradient>
{_mark_defs(caret_stops=CARET_STOPS)}
    <clipPath id="chunkyTileClip"><path d="{svg_tile_path()}"/></clipPath>
  </defs>
  <path fill="url(#chunkyTile)" d="{svg_tile_path()}"/>
  <g clip-path="url(#chunkyTileClip)">
    <rect x="0" y="0" width="{S}" height="{S}" fill="url(#chunkyGlow)"/>
    <path fill="none" stroke="url(#chunkyEdge)" stroke-width="{f(EDGE_WIDTH)}" d="{svg_tile_path()}"/>
  </g>
{_mark_shapes()}
</svg>
"""


def mark_svg() -> str:
    """Glyph-only mark for in-app use: transparent, self-padded, no tile."""
    pad = 0.07 * max(GLYPH_BOX[2] - GLYPH_BOX[0], GLYPH_BOX[3] - GLYPH_BOX[1])
    x0, y0 = GLYPH_BOX[0] - pad, GLYPH_BOX[1] - pad
    w = (GLYPH_BOX[2] - GLYPH_BOX[0]) + 2 * pad
    h = (GLYPH_BOX[3] - GLYPH_BOX[1]) + 2 * pad
    side = max(w, h)  # square viewBox so `object-contain` never distorts it
    x0 -= (side - w) / 2
    y0 -= (side - h) / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x0)} {f(y0)} {f(side)} {f(side)}" role="img" aria-label="Chunky">
  <title>Chunky</title>
  <desc>Generated by scripts/generate-brand-assets.py. Edit the geometry there, not this file.</desc>
  <defs>
{_mark_defs(mark_stops=MARK_UI_STOPS)}
  </defs>
{_mark_shapes(caret_fill="chunkyMark")}
</svg>
"""


# ── Reporting ────────────────────────────────────────────────────────────────
RAMP = " .:-=+*#%@"


def ascii_preview(master: Image.Image, size: int) -> str:
    im = master.resize((size, size), Image.LANCZOS)
    px = im.load()
    lines = []
    for y in range(size):
        row = []
        for x in range(size):
            r, g, b, a = px[x, y]
            luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            v = (a / 255) * (0.12 + 0.88 * luma)
            row.append(RAMP[max(0, min(len(RAMP) - 1, int(v * (len(RAMP) - 1) + 0.5)))])
        lines.append("".join(row))
    return "\n".join(lines)


def measured_gap(masks, probe: int = 512) -> float:
    """Dilate the ring until it touches the caret; returns design units."""
    a = masks["ring"].resize((probe, probe), Image.LANCZOS).point(lambda v: 255 if v > 127 else 0)
    b = masks["caret"].resize((probe, probe), Image.LANCZOS).point(lambda v: 255 if v > 127 else 0)
    cur = a
    for k in range(1, 120):
        cur = cur.filter(ImageFilter.MaxFilter(3))
        if ImageChops.multiply(cur, b).getextrema()[1] > 0:
            return k * (S / probe)
    return float("inf")


def report(master: Image.Image, masks) -> None:
    gap = mouth_clearance()
    print("── geometry ───────────────────────────────────────────────")
    print(f"canvas            {S}x{S}, tile {S - 2 * TILE_INSET}px squircle (n={SQUIRCLE_N})")
    print(f"ring              R_out={R_OUT:.1f}  stroke={STROKE:.1f}  counter={2 * R_IN:.1f}")
    print(f"mouth             {2 * MOUTH_HALF_DEG:.0f}deg")
    print(f"caret             {CARET_W:.1f}x{CARET_H:.1f} r={CARET_R:.1f}")
    print(f"glyph box         {GLYPH_BOX[2] - GLYPH_BOX[0]:.1f}x{GLYPH_BOX[3] - GLYPH_BOX[1]:.1f}"
          f"  ({100 * (GLYPH_BOX[2] - GLYPH_BOX[0]) / (S - 2 * TILE_INSET):.0f}% of tile)")
    print(f"box centre        {(GLYPH_BOX[0] + GLYPH_BOX[2]) / 2:.1f}   "
          f"ink centroid {RING_CX + _mark_centroid_x():.1f}   (tile centre {S / 2:.0f})")
    print(f"margins L/R/T/B   {GLYPH_BOX[0] - TILE_INSET:.0f}/{S - TILE_INSET - GLYPH_BOX[2]:.0f}/"
          f"{GLYPH_BOX[1] - TILE_INSET:.0f}/{S - TILE_INSET - GLYPH_BOX[3]:.0f}")
    print(f"caret/ring gap    {gap:.1f}u euclidean ({measured_gap(masks):.0f}u chebyshev floor)"
          f"  → {gap * 16 / S:.2f}px @16  {gap * 32 / S:.2f}px @32")
    print(f"stroke @16/@32    {STROKE * 16 / S:.2f}px / {STROKE * 32 / S:.2f}px")
    alpha = master.getchannel("A")
    print(f"alpha corner      {alpha.getpixel((2, 2))} (must be 0)")
    print(f"tile coverage     {sum(alpha.histogram()[200:]) / (S * S) * 100:.1f}% of canvas")
    for size in (16, 32, 64):
        print(f"\n── {size}px ───")
        print(ascii_preview(master, size))


def contact_sheet(master: Image.Image, path: Path) -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    pad, top = 24, 300
    width = sum(s + pad for s in sizes) + pad + top + pad
    sheet = Image.new("RGBA", (width, top + 2 * pad), (245, 245, 247, 255))
    dark = Image.new("RGBA", (width, (top + 2 * pad) // 2), (24, 22, 30, 255))
    sheet.paste(dark, (0, (top + 2 * pad) // 2))
    sheet.alpha_composite(master.resize((top, top), Image.LANCZOS), (pad, pad))
    x = pad + top + pad
    for s in sizes:
        sheet.alpha_composite(master.resize((s, s), Image.LANCZOS), (x, pad + (top - s) // 2))
        x += s + pad
    sheet.convert("RGB").save(path)
    print(f"contact sheet     {path}")


# ── Entry point ──────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="Generate Chunky brand assets.")
    ap.add_argument("--check", action="store_true", help="print geometry + ASCII legibility report")
    ap.add_argument("--preview", metavar="PATH", help="write a contact sheet PNG (not a committed asset)")
    ap.add_argument("--dry-run", action="store_true", help="render and report without writing assets")
    args = ap.parse_args()

    master, masks = render_master()

    if not args.dry_run:
        brand = ROOT / "assets" / "brand"
        iconset = ROOT / "assets" / "icon.iconset"
        brand.mkdir(parents=True, exist_ok=True)
        iconset.mkdir(parents=True, exist_ok=True)

        (brand / "chunky-icon.svg").write_text(icon_svg())
        (ROOT / "src" / "mainview" / "public" / "chunky-mark.svg").write_text(mark_svg())

        master_png = brand / "chunky-icon-1024.png"
        master.save(master_png)

        # Every iconset entry is resampled from the single 1024 master.
        for name, size in ICONSET_SIZES:
            out = master if size == S else master.resize((size, size), Image.LANCZOS)
            out.save(iconset / name)

        print(f"wrote {brand / 'chunky-icon.svg'}")
        print(f"wrote {ROOT / 'src' / 'mainview' / 'public' / 'chunky-mark.svg'}")
        print(f"wrote {master_png}")
        print(f"wrote {len(ICONSET_SIZES)} files to {iconset}")

    if args.preview:
        contact_sheet(master, Path(args.preview))
    if args.check:
        report(master, masks)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
