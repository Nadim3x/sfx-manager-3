#!/usr/bin/env python3
"""Compose the Gumroad cover (1280x720 @72 DPI) from REAL panel screenshots.

Run first:  LD_LIBRARY_PATH=/tmp/al2023/lib node tools/shoot.js
Then:       python3 tools/compose_cover.py

Layout (designer spec):
  • top brand strip: logo + wordmark (left), feature chips (right)
  • three vertical panel screenshots fanned centre-right:
      left  = light grid view   (rot -6°, dimmed + DOF blur)
      hero  = dark list + waveform player (crisp, straight)
      right = settings / accent swatches (rot +6°, dimmed + DOF blur)
  • accent glow, vignette, drop shadows, rounded corners
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GUM = os.path.join(ROOT, "gumroad")
W, H = 1280, 720

ACCENT = (6, 108, 231)
BG_TOP = (13, 13, 15)
BG_BOT = (19, 19, 22)
TEXT = (250, 250, 250)
MUTED = (161, 161, 170)
CHIP = (212, 212, 216)
CHIP_BORDER = (58, 58, 64)

FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
fB = lambda s: ImageFont.truetype(FB, s)
fR = lambda s: ImageFont.truetype(FR, s)


def vgrad(w, h, top, bot):
    im = Image.new("RGB", (1, h))
    px = im.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    return im.resize((w, h))


def round_corners(im, r):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1],
                                           radius=r, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def drop_shadow(canvas, panel, at, offset=(0, 24), blur=30, alpha=150):
    """Soft shadow UNDER a panel that is about to be pasted at `at`."""
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    a = panel.getchannel("A")
    solid = Image.new("RGBA", panel.size, (0, 0, 0, alpha))
    sh.paste(solid, (at[0] + offset[0], at[1] + offset[1]), a)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(sh)


def chip(d, x, y, text, font, pad=16, h=40):
    bb = d.textbbox((0, 0), text, font=font)
    w = bb[2] - bb[0]
    d.rounded_rectangle([x, y, x + w + pad * 2, y + h], radius=h // 2,
                        outline=CHIP_BORDER, width=2)
    d.text((x + pad, y + h // 2), text, font=font, fill=CHIP, anchor="lm")
    return w + pad * 2 + 12


def load_panel(name, h, rot=0, dim=1.0, blur=0.0):
    im = Image.open(os.path.join(GUM, name)).convert("RGBA")
    w = round(im.size[0] * h / im.size[1])
    im = im.resize((w, h), Image.LANCZOS)
    if dim != 1.0:
        rgb = im.convert("RGB")
        rgb = rgb.point(lambda p: int(p * dim))
        im = rgb.convert("RGBA")
        im.putalpha(Image.new("L", im.size, 255))
        im.putalpha(round_corners_mask(im.size, 0))  # no-op alpha restore
    if rot:
        im = im.rotate(rot, expand=True, resample=Image.BICUBIC)
    if blur:
        r, g, b, a = im.split()
        rgb = Image.merge("RGB", (r, g, b)).filter(ImageFilter.GaussianBlur(blur))
        im = Image.merge("RGBA", (*rgb.split(), a))
    return round_corners(im, 16 if rot else 18)


def round_corners_mask(size, r):
    m = Image.new("L", size, 255)
    return m


def paste_center(canvas, panel, cx, cy):
    x = int(cx - panel.size[0] / 2)
    y = int(cy - panel.size[1] / 2)
    drop_shadow(canvas, panel, (x, y))
    canvas.alpha_composite(panel, (x, y))
    return (x, y, x + panel.size[0], y + panel.size[1])


def main():
    assert os.path.exists(os.path.join(GUM, "shot-list-dark.png")), "run tools/shoot.js first"
    canvas = vgrad(W, H, BG_TOP, BG_BOT).convert("RGBA")

    # accent glow behind the fan
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([640, 60, 1240, 660], fill=ACCENT + (34,))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(130)))

    # vignette
    vg = Image.new("L", (W, H), 0)
    dv = ImageDraw.Draw(vg)
    dv.rectangle([0, 0, W, H], fill=90)
    dv.ellipse([-260, -200, W + 260, H + 200], fill=0)
    vg = vg.filter(ImageFilter.GaussianBlur(120))
    canvas.paste(Image.new("RGBA", (W, H), (0, 0, 0, 255)),
                 (0, 0), vg)

    d = ImageDraw.Draw(canvas)

    # ── top brand strip ─────────────────────────────────────────────
    logo = Image.open(os.path.join(GUM, "logo-512.png")).convert("RGBA") \
        .resize((76, 76), Image.LANCZOS)
    canvas.alpha_composite(logo, (64, 42))
    d.text((156, 52), "SFX Manager", font=fB(44), fill=TEXT)
    d.text((157, 112), "Sound FX manager for After Effects & Premiere Pro",
           font=fR(21), fill=MUTED)

    # chips, right-aligned in the top band
    labels = ["Waveform preview", "Add at playhead", "Signed ZXP"]
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    widths = []
    for t in labels:
        bb = probe.textbbox((0, 0), t, font=fR(17))
        widths.append(bb[2] - bb[0] + 32 + 12)
    total = sum(widths) - 12
    x = W - 64 - total
    for t in labels:
        x += chip(d, x, 60, t, fR(17))

    # ── the panel fan ───────────────────────────────────────────────
    left = load_panel("shot-grid-light.png", 490, rot=-6, dim=0.92, blur=0.9)
    right = load_panel("shot-settings-dark.png", 490, rot=6, dim=0.92, blur=0.9)
    hero = load_panel("shot-list-dark.png", 534)

    b1 = paste_center(canvas, left, 388, 412)
    b2 = paste_center(canvas, right, 952, 412)
    hero_pos = (520, 152)
    drop_shadow(canvas, hero, hero_pos, offset=(0, 28), blur=36, alpha=170)
    canvas.alpha_composite(hero, hero_pos)
    b3 = (hero_pos[0], hero_pos[1],
          hero_pos[0] + hero.size[0], hero_pos[1] + hero.size[1])

    # ── brand line + footer ─────────────────────────────────────────
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, W, 6], fill=ACCENT)
    d.text((64, 664), "nadim.3x  ·  Instagram", font=fR(16), fill=(113, 113, 122))

    out = os.path.join(GUM, "cover-1280x720.png")
    canvas.convert("RGB").save(out, dpi=(72, 72))

    # numeric QA
    im = Image.open(out)
    px = im.load()
    print("size", im.size, "dpi", im.info.get("dpi"))
    print("top-line", px[640, 3], "| bg", px[20, 400])
    for tag, bb in (("left", b1), ("right", b2), ("hero", b3)):
        print(tag, "bbox", bb)
    # edges should be clean background
    edge = [px[x, 715] for x in range(0, W, 40)]
    print("bottom-edge max", max(sum(c) for c in edge))
    print("saved →", out)


if __name__ == "__main__":
    main()
