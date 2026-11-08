"""Generates the Baton icon set from one definition, so the toolbar, the settings
page, the favicon, the touch icon and the social card all carry the same mark.

Stone gradient plate, two deep teal chevrons, one at reduced opacity to suggest
the next turn. Rendered at 4x and downsampled for clean edges at 16px.

    python3 scripts/make-icons.py
"""
import math
import os
import struct
import zlib

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
SITE = os.path.join(ROOT, "site")

# palette, matching site/styles.css
STONE_LIGHT = (244, 242, 236)
STONE_DARK = (214, 209, 198)
TEAL = (42, 95, 99)
TEAL_SOFT = (122, 158, 160)

SS = 4  # supersample factor
SIZES = (16, 32, 48, 128)

# same mark, at the sizes the web asks for: favicon, home screen, manifest
WEB = (
    (32, "icon-32.png"),
    (180, "icon-180.png"),
    (192, "icon-192.png"),
    (512, "icon-512.png"),
)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    """Draw one icon at size * SS, then downsample."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # diagonal gradient plate, clipped to a rounded square
    grad = Image.new("RGB", (s, s))
    px = grad.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * (s - 1)) if s > 1 else 0
            px[x, y] = lerp(STONE_LIGHT, STONE_DARK, t)

    radius = round(s * 0.28)
    plate = Image.new("L", (s, s), 0)
    ImageDraw.Draw(plate).rounded_rectangle([0, 0, s - 1, s - 1], radius, fill=255)
    img.paste(grad, (0, 0), plate)

    # a hairline inner edge, the way a neumorphic plate catches light
    edge = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    ed.rounded_rectangle([0, 0, s - 1, s - 1], radius, outline=(255, 255, 255, 150), width=max(1, s // 64))
    img = Image.alpha_composite(img, edge)

    # chevrons
    def chevron(x0, colour, width):
        layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        half_h = s * 0.285
        run = s * 0.20
        mid = s / 2
        cy = s / 2
        pts = [
            (x0, cy - half_h),
            (x0 + run, cy),
            (x0, cy + half_h),
        ]
        d.line(pts, fill=colour + (255,), width=width, joint="curve")
        # round the ends, since line caps are square
        r = width / 2
        for (px_, py_) in (pts[0], pts[2]):
            d.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill=colour + (255,))
        return layer

    width = max(2, round(s * 0.115))
    img = Image.alpha_composite(img, chevron(s * 0.27, TEAL_SOFT, width))
    img = Image.alpha_composite(img, chevron(s * 0.44, TEAL, width))

    return img.resize((size, size), Image.LANCZOS)


def png_bytes(img):
    """Encode RGBA to PNG without a Pillow version dependency."""
    w, h = img.size
    rows = []
    data = img.convert("RGBA").load()
    for y in range(h):
        row = bytearray(b"\x00")
        for x in range(w):
            row.extend(data[x, y])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, payload):
        c = struct.pack(">I", len(payload)) + tag + payload
        return c + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Baton">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4f2ec"/>
      <stop offset="1" stop-color="#d6d1c6"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="9" fill="url(#plate)"/>
  <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="#ffffff" stroke-opacity="0.55"/>
  <path d="M8.4 11.6 L12 16 L8.4 20.4" fill="none" stroke="#7a9ea0" stroke-width="3.4"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M14.6 11.6 L18.2 16 L14.6 20.4" fill="none" stroke="#2a5f63" stroke-width="3.4"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def main():
    os.makedirs(ICONS, exist_ok=True)
    for size in SIZES:
        img = render(size)
        path = os.path.join(ICONS, f"icon{size}.png")
        with open(path, "wb") as fh:
            fh.write(png_bytes(img))
        print("wrote", os.path.relpath(path, ROOT))

    for size, name in WEB:
        path = os.path.join(SITE, name)
        with open(path, "wb") as fh:
            fh.write(png_bytes(render(size)))
        print("wrote", os.path.relpath(path, ROOT))

    for dest in (os.path.join(ICONS, "icon.svg"), os.path.join(SITE, "icon.svg")):
        with open(dest, "w") as fh:
            fh.write(SVG)
        print("wrote", os.path.relpath(dest, ROOT))


if __name__ == "__main__":
    main()
