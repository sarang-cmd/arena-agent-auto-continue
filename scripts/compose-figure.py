"""Builds docs/images/pill-and-settings.png: the pill with its settings open, and
the defaults table from the landing page, as one figure.

The pill is captured with a transparent surround and its own shadow, so it can
sit on the stone background directly. It is scaled to well under the height of
the table, because it is a small piece of the page rather than a whole panel.

    node scripts/shots.js && python3 scripts/compose-figure.py
"""
import os
from collections import Counter

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "docs", "images")

STONE = (233, 230, 223)      # page base, matches site/styles.css --stone
PAD = 44                     # outer breathing room
GAP = 64                     # space between the two panels
HEIGHT = 1000                # height of the table panel
PILL_SCALE = 0.56            # the pill's height as a share of the table's
RADIUS = 16


def plate_bbox(im):
    """Bounding box of the raised plate inside a page screenshot.

    The settings shot is a section of the landing page: flat stone with a lighter
    raised plate on it. Selecting only pixels that are lighter than the page
    finds the plate and ignores the darker heading and intro copy, which the
    README already carries as text.
    """
    px = im.load()
    w, h = im.size
    small = im.resize((w // 4, h // 4))
    bg = Counter(small.get_flattened_data()).most_common(1)[0][0]
    bg_sum = sum(bg)

    def lighter(x, y):
        return sum(px[x, y]) >= bg_sum + 10

    rows = [y for y in range(h) if sum(1 for x in range(0, w, 4) if lighter(x, y)) > (w / 4) * 0.5]
    if not rows:
        raise SystemExit("could not find the plate")
    top, bottom = rows[0], rows[-1]

    cols = [x for x in range(w)
            if sum(1 for y in range(top, bottom, 4) if lighter(x, y)) > ((bottom - top) / 4) * 0.5]
    left, right = cols[0], cols[-1]

    m = 6  # keep the plate's soft shadow inside the crop
    return (max(0, left - m), max(0, top - m), min(w, right + m), min(h, bottom + m))


def with_shadow(im, blur=18, offset=(0, 10), alpha=54):
    """A single soft shadow, the same one the plates on the page use."""
    w, h = im.size
    canvas = Image.new("RGBA", (w + 2 * blur, h + 2 * blur), (0, 0, 0, 0))
    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [blur + offset[0], blur + offset[1], blur + offset[0] + w - 1, blur + offset[1] + h - 1],
        RADIUS, fill=alpha)
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(blur)))
    shadow.paste((60, 55, 45, 255), (0, 0), shadow.split()[3])
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(im.convert("RGBA"), (blur, blur))
    return canvas


def fit(im, height):
    w, h = im.size
    return im.resize((round(w * height / h), height), Image.LANCZOS)


def rounded(im, radius=RADIUS):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def main():
    pill = Image.open(os.path.join(IMG, "pill-settings.png")).convert("RGBA")
    table_src = Image.open(os.path.join(IMG, "settings.png")).convert("RGB")
    table = table_src.crop(plate_bbox(table_src))

    table = fit(table, HEIGHT)
    pill = fit(pill, round(HEIGHT * PILL_SCALE))

    table = with_shadow(rounded(table))
    table = table.crop(table.split()[3].getbbox())

    width = PAD * 2 + pill.size[0] + GAP + table.size[0]
    height = PAD * 2 + table.size[1]

    canvas = Image.new("RGBA", (width, height), STONE + (255,))
    # the pill sits level with the table's lower half, the way it sits on a page
    canvas.alpha_composite(pill, (PAD, height - PAD - pill.size[1]))
    canvas.alpha_composite(table, (PAD + pill.size[0] + GAP, PAD))

    out = os.path.join(IMG, "pill-and-settings.png")
    canvas.convert("RGB").save(out, optimize=True)

    print("pill", pill.size, "table", table.size)
    print("figure", canvas.size, "->", out, str(round(os.path.getsize(out) / 1024)) + "KB")
    print("pill is %.0f%% of the table's height, %.0f%% of its width"
          % (100 * pill.size[1] / table.size[1], 100 * pill.size[0] / table.size[0]))


if __name__ == "__main__":
    main()
