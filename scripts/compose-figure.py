"""Builds docs/images/popup-and-settings.png: the popup and the settings table
as one figure, side by side, with matched heights so the pair reads as a single
composition rather than two unrelated screenshots.

    python3 scripts/compose-figure.py
"""
import os
from collections import Counter

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "docs", "images")

STONE = (233, 230, 223)      # page base, matches site/styles.css --stone
PAD = 44                     # outer breathing room
GAP = 56                     # space between the two panels
HEIGHT = 1000                # shared height of both panels
RADIUS = 16


def load(name):
    return Image.open(os.path.join(IMG, name)).convert("RGB")


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
        c = px[x, y]
        return sum(c) >= bg_sum + 10

    rows = [y for y in range(h) if sum(1 for x in range(0, w, 4) if lighter(x, y)) > (w / 4) * 0.5]
    if not rows:
        raise SystemExit("could not find the plate")
    top, bottom = rows[0], rows[-1]

    cols = [x for x in range(w) if sum(1 for y in range(top, bottom, 4) if lighter(x, y)) > ((bottom - top) / 4) * 0.5]
    left, right = cols[0], cols[-1]

    # keep a little room so the plate's soft shadow is not clipped
    m = 6
    return (max(0, left - m), max(0, top - m), min(w, right + m), min(h, bottom + m))


def rounded(im, radius=RADIUS):
    mask = Image.new("L", im.size, 0)
    from PIL import ImageDraw

    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def with_shadow(im, blur=18, offset=(0, 10), alpha=54):
    """A single soft shadow, the same one the plates on the page use."""
    w, h = im.size
    canvas = Image.new("RGBA", (w + 2 * blur, h + 2 * blur), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    mask = Image.new("L", canvas.size, 0)
    from PIL import ImageDraw

    ImageDraw.Draw(mask).rounded_rectangle(
        [blur + offset[0], blur + offset[1], blur + offset[0] + w - 1, blur + offset[1] + h - 1],
        RADIUS, fill=alpha)
    shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(blur)))
    shadow.paste((60, 55, 45, 255), (0, 0), shadow.split()[3])
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.alpha_composite(im, (blur, blur))
    return canvas


def fit(im, height):
    w, h = im.size
    return im.resize((round(w * height / h), height), Image.LANCZOS)


def main():
    popup = load("popup.png")
    settings = load("settings.png").crop(plate_bbox(load("settings.png")))

    popup = fit(popup, HEIGHT)
    settings = fit(settings, HEIGHT)

    popup = with_shadow(rounded(popup))
    settings = with_shadow(rounded(settings))

    width = PAD * 2 + popup.size[0] + GAP + settings.size[0]
    height = PAD * 2 + max(popup.size[1], settings.size[1])

    canvas = Image.new("RGBA", (width, height), STONE + (255,))
    canvas.alpha_composite(popup, (PAD, PAD))
    canvas.alpha_composite(settings, (PAD + popup.size[0] + GAP, PAD))

    out = os.path.join(IMG, "popup-and-settings.png")
    canvas.convert("RGB").save(out, optimize=True)

    print("popup", popup.size, "settings", settings.size)
    print("figure", canvas.size, "->", out,
          str(round(os.path.getsize(out) / 1024)) + "KB")
    print("ratio popup:settings = %.1f%% : %.1f%%" % (
        100 * popup.size[0] / (popup.size[0] + settings.size[0]),
        100 * settings.size[0] / (popup.size[0] + settings.size[0])))


if __name__ == "__main__":
    main()
