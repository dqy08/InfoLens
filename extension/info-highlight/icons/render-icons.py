#!/usr/bin/env python3
"""Render Info Highlight toolbar icons: red heatmap tiles, no letters.

Modes:
  off  — default red (idle)
  on   — idle tiles + green check badge (analysis done)
  busy — same geometry, neutral gray (analyzing)
"""

from pathlib import Path

from PIL import Image, ImageDraw

RGB = (255, 71, 64)
BUSY_RGB = (148, 148, 148)
DOT_RGB = (10, 132, 255)  # #0A84FF，与选项页蓝点一致
CHECK_RGB = (52, 199, 89)  # #34C759
# Same 16-step ramp as content.css --ih-token-* (weaken max 0.5); boost to 0.95 so 16px stays readable.
TOKEN_MAX = 0.5
ICON_MAX = 0.95
PAD = 1
ROW_H = 2
ROW_GAP = 2
WORD_GAP = 1

# (width, token_level) per row. Ragged right like lines of text.
ROWS = (
    ((5, 6), (7, 13)),
    ((4, 14), (8, 5)),
    ((7, 7), (5, 13)),
    ((6, 15), (4, 7)),
)

SIZES = (16, 32, 48, 128)
# Toolbar action sizes only (same as -dot / -on).
ACTION_SIZES = (16, 32)


def token_alpha(level: int) -> float:
    return ((level + 1) / 16) * TOKEN_MAX


def icon_alpha(level: int) -> float:
    return token_alpha(level) * (ICON_MAX / TOKEN_MAX)


def paint_unit(mode: str = "off") -> Image.Image:
    side = PAD * 2 + len(ROWS) * ROW_H + (len(ROWS) - 1) * ROW_GAP
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    px = img.load()
    rgb = BUSY_RGB if mode == "busy" else RGB
    y = PAD
    for words in ROWS:
        x = PAD
        for width, level in words:
            a = round(icon_alpha(level) * 255)
            for dy in range(ROW_H):
                for dx in range(width):
                    px[x + dx, y + dy] = (*rgb, a)
            x += width + WORD_GAP
        y += ROW_H + ROW_GAP
    return img


def paint_dot(img: Image.Image) -> Image.Image:
    """右上角圆点按目标尺寸画，避免 nearest 把 16px 点放大成加号。"""
    out = img.convert("RGBA")
    w, h = out.size
    scale = 8
    layer = Image.new("RGBA", (w * scale, h * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    r = w * 2.2 / 16
    cx = w - r - 0.4
    cy = r + 0.2
    draw.ellipse(
        ((cx - r) * scale, (cy - r) * scale, (cx + r) * scale, (cy + r) * scale),
        fill=(*DOT_RGB, 255),
    )
    return Image.alpha_composite(out, layer.resize((w, h), Image.Resampling.LANCZOS))


def paint_check(img: Image.Image) -> Image.Image:
    """右下角绿底白勾，按目标尺寸画。"""
    out = img.convert("RGBA")
    w, h = out.size
    scale = 8
    layer = Image.new("RGBA", (w * scale, h * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    r = w * 4.15 / 16
    cx = (w - r - 0.35) * scale
    cy = (h - r - 0.35) * scale
    r *= scale
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*CHECK_RGB, 255))
    cr = r * 0.78
    pts = (
        (cx - cr * 0.42, cy + cr * 0.05),
        (cx - cr * 0.08, cy + cr * 0.38),
        (cx + cr * 0.48, cy - cr * 0.36),
    )
    width = max(1, round(r * 0.28))
    draw.line(pts, fill=(255, 255, 255, 255), width=width, joint="curve")
    cap = max(1, round(width / 2))
    for x, y in (pts[0], pts[2]):
        draw.ellipse((x - cap, y - cap, x + cap, y + cap), fill=(255, 255, 255, 255))
    return Image.alpha_composite(out, layer.resize((w, h), Image.Resampling.LANCZOS))


def main() -> None:
    out = Path(__file__).resolve().parent
    unit = paint_unit("off")
    if unit.size != (16, 16):
        raise SystemExit(f"unit canvas must be 16×16, got {unit.size}")
    for size in SIZES:
        unit.resize((size, size), Image.Resampling.NEAREST).save(out / f"icon{size}.png")
        print(f"wrote icon{size}.png")
    busy = paint_unit("busy")
    for size in ACTION_SIZES:
        busy.resize((size, size), Image.Resampling.NEAREST).save(out / f"icon{size}-busy.png")
        print(f"wrote icon{size}-busy.png")
        base = unit.resize((size, size), Image.Resampling.NEAREST)
        paint_check(base).save(out / f"icon{size}-on.png")
        print(f"wrote icon{size}-on.png")
        paint_dot(base).save(out / f"icon{size}-dot.png")
        print(f"wrote icon{size}-dot.png")


if __name__ == "__main__":
    main()
