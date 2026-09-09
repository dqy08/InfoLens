#!/usr/bin/env python3
"""Render Info Highlight toolbar icons: red heatmap tiles, no letters."""

from pathlib import Path

from PIL import Image

RGB = (255, 71, 64)
# Same 16-step ramp as content.css --ih-token-* (weaken max 0.5); boost to 0.95 so 16px stays readable.
TOKEN_MAX = 0.5
ICON_MAX = 0.95
PAD = 1
ROW_H = 2
ROW_GAP = 1
WORD_GAP = 1

# (width, token_level) per row. Ragged right like lines of text.
ROWS = (
    ((4, 13), (3, 7), (5, 15)),
    ((2, 10), (5, 4), (3, 13)),
    ((5, 15), (2, 7), (4, 10)),
    ((3, 4), (4, 13), (2, 10), (2, 7)),
    ((4, 10), (2, 15), (5, 7)),
)

SIZES = (16, 32, 48, 128)


def token_alpha(level: int) -> float:
    return ((level + 1) / 16) * TOKEN_MAX


def icon_alpha(level: int) -> float:
    return token_alpha(level) * (ICON_MAX / TOKEN_MAX)


def paint_unit() -> Image.Image:
    side = PAD * 2 + len(ROWS) * ROW_H + (len(ROWS) - 1) * ROW_GAP
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    px = img.load()
    y = PAD
    for words in ROWS:
        x = PAD
        for width, level in words:
            a = round(icon_alpha(level) * 255)
            for dy in range(ROW_H):
                for dx in range(width):
                    px[x + dx, y + dy] = (*RGB, a)
            x += width + WORD_GAP
        y += ROW_H + ROW_GAP
    return img


def main() -> None:
    out = Path(__file__).resolve().parent
    unit = paint_unit()
    if unit.size != (16, 16):
        raise SystemExit(f"unit canvas must be 16×16, got {unit.size}")
    for size in SIZES:
        unit.resize((size, size), Image.Resampling.NEAREST).save(out / f"icon{size}.png")
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
