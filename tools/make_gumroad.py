#!/usr/bin/env python3
"""Generate the Gumroad marketing kit for SFX Manager.

Outputs (72 DPI):
  gumroad/logo-1024.png      transparent brand mark (master)
  gumroad/logo-512.png       description-sized mark
  gumroad/cover-1280x720.png Gumroad cover  (>=1280x720)
  gumroad/thumb-600x600.png  Gumroad thumbnail (>=600x600)

The mark is the panel's brand: accent-blue rounded square with the white
waveform polyline from the in-app logo. Palette matches the app UI:
accent #066ce7, unplayed waveform #3f3f46, dark surfaces #0f0f10.
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ACCENT = (6, 108, 231)          # #066ce7
ACCENT_HI = (24, 130, 250)      # gradient top
ACCENT_LO = (4, 84, 190)        # gradient bottom
BG_TOP = (13, 13, 15)           # #0d0d0f
BG_BOT = (19, 19, 22)           # #131316
UNPLAYED = (63, 63, 70)         # #3f3f46
TEXT = (250, 250, 250)
MUTED = (161, 161, 170)         # #a1a1aa
CHIP = (212, 212, 216)          # #d4d4d8
CHIP_BORDER = (58, 58, 64)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "gumroad")
os.makedirs(OUT, exist_ok=True)

FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def f(path, size):
    return ImageFont.truetype(path, size)


def vgrad(w, h, top, bot):
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    return img.resize((w, h))


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1],
                                        radius=radius, fill=255)
    return m


def polyline(g, pts, width, fill=(255, 255, 255, 255)):
    """Open polyline with round caps/joints."""
    g.line(pts, fill=fill, width=width, joint="curve")
    r = width // 2
    for x, y in (pts[0], pts[-1]):
        g.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def draw_mark(d, ox, oy, L, radius_frac=0.225):
    """Draw the SFX Manager brand mark (accent tile + white waveform)."""
    r = int(L * radius_frac)
    tile = vgrad(L, L, ACCENT_HI, ACCENT_LO).convert("RGBA")
    tile.putalpha(rounded_mask((L, L), r))
    layer = Image.new("RGBA", (ox + L + 4, oy + L + 4), (0, 0, 0, 0))
    layer.paste(tile, (ox, oy), tile)
    g = ImageDraw.Draw(layer)

    s = L / 24.0
    P = lambda x, y: (ox + x * s, oy + y * s)
    pts = [P(3.5, 14.8), P(7.2, 9.4), P(10.3, 13.1), P(13.7, 6.0),
           P(16.4, 10.9), P(18.2, 8.6), P(20.5, 14.5)]
    polyline(g, pts, max(2, int(round(1.5 * s))))
    polyline(g, [P(3.5, 18), P(20.5, 18)], max(2, int(round(1.5 * s))),
             fill=(255, 255, 255, 140))
    d._image.alpha_composite(layer)


def glow(img, cx, cy, rad, color, alpha):
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    g = ImageDraw.Draw(ov)
    g.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=color + (alpha,))
    ov = ov.filter(ImageFilter.GaussianBlur(rad * 0.55))
    img.alpha_composite(ov)


def chip(d, x, y, text, font, pad=18, h=46):
    bb = d.textbbox((0, 0), text, font=font)
    w = bb[2] - bb[0]
    d.rounded_rectangle([x, y, x + w + pad * 2, y + h], radius=h // 2,
                        outline=CHIP_BORDER, width=2)
    d.text((x + pad, y + h // 2), text, font=font, fill=CHIP, anchor="lm")
    return w + pad * 2 + 14


def bg(w, h):
    im = Image.new("RGBA", (w, h))
    im.paste(vgrad(w, h, BG_TOP, BG_BOT).convert("RGBA"), (0, 0))
    return im


# ───────────────────────── master logo (transparent) ─────────────────────
def logo(size, name):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(im), 0, 0, size, radius_frac=0.225)
    im.save(os.path.join(OUT, name), dpi=(72, 72))
    print(name, im.size, "dpi", im.info.get("dpi"))


# ───────────────────────── cover 1280×720 ─────────────────────────────────
def cover():
    W, H = 1280, 720
    im = bg(W, H)
    d = ImageDraw.Draw(im)
    glow(im, 210, 237, 240, ACCENT, 46)          # soft accent behind logo
    d.rectangle([0, 0, W, 6], fill=ACCENT)        # brand line
    draw_mark(d, 96, 132, 210)

    title = f(FB, 84)
    d.text((96, 410), "SFX Manager", font=title, fill=TEXT)
    d.text((96, 520), "Browse · preview · add at playhead",
           font=f(FR, 30), fill=MUTED)
    d.text((96, 562), "For After Effects & Premiere Pro",
           font=f(FR, 26), fill=(113, 113, 122))

    x = 96
    for label in ("Waveform preview", "One-click add", "Signed ZXP"):
        x += chip(d, x, 630, label, f(FR, 24))

    # flat waveform (played = accent, unplayed = #3f3f46) — app style
    cx, cy = 1010, 270
    heights = [44, 88, 132, 96, 168, 120, 74, 140, 186, 110, 64, 152, 128,
               84, 172, 138, 92, 60, 148, 116, 176, 104, 70, 134, 158, 90,
               124, 166, 78, 142, 108, 188, 96]
    bw, gap = 7, 6
    total = len(heights) * (bw + gap) - gap
    x0 = cx - total // 2
    n_play = int(len(heights) * 0.62)
    # played-region tint: accent @10% pre-blended onto the bg (alpha would be
    # dropped by the final RGBA→RGB save and render as solid blue)
    d.rounded_rectangle([x0 - 10, cy - 104, x0 + n_play * (bw + gap) + 2,
                         cy + 104], radius=10, fill=(15, 26, 42))
    for i, h in enumerate(heights):
        xx = x0 + i * (bw + gap)
        col = ACCENT if i < n_play else UNPLAYED
        d.rounded_rectangle([xx, cy - h // 2, xx + bw, cy + h // 2],
                            radius=bw // 2, fill=col)

    im.convert("RGB").save(os.path.join(OUT, "cover-1280x720.png"),
                           dpi=(72, 72))
    print("cover-1280x720.png", (W, H), "dpi 72")


# ───────────────────────── thumbnail 600×600 ──────────────────────────────
def thumb():
    W, H = 600, 600
    im = bg(W, H)
    d = ImageDraw.Draw(im)
    glow(im, W // 2, 250, 220, ACCENT, 52)
    d.rectangle([0, 0, W, 4], fill=ACCENT)
    draw_mark(d, (W - 300) // 2, 100, 300)
    d.text((W // 2, 470), "SFX Manager", font=f(FB, 54), fill=TEXT, anchor="mm")
    d.text((W // 2, 524), "After Effects  ·  Premiere Pro",
           font=f(FR, 24), fill=MUTED, anchor="mm")
    # small waveform underline
    hs = [16, 30, 46, 34, 58, 42, 26, 50, 62, 38, 24, 54, 44, 30, 60, 40]
    bw, gap, y0 = 5, 4, 560
    x = W // 2 - (len(hs) * (bw + gap) - gap) // 2
    for i, h in enumerate(hs):
        col = ACCENT if i < 10 else UNPLAYED
        d.rounded_rectangle([x + i * (bw + gap), y0 - h // 2,
                             x + i * (bw + gap) + bw, y0 + h // 2],
                            radius=bw // 2, fill=col)
    im.convert("RGB").save(os.path.join(OUT, "thumb-600x600.png"),
                           dpi=(72, 72))
    print("thumb-600x600.png", (W, H), "dpi 72")


logo(1024, "logo-1024.png")
logo(512, "logo-512.png")
cover()
thumb()
print("done →", OUT)
