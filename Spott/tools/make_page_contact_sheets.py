#!/usr/bin/env python3
"""Create numbered contact sheets for rapid visual QA of rendered document pages."""

from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def page_number(path: Path) -> int:
    match = re.search(r"(\d+)$", path.stem)
    return int(match.group(1)) if match else 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--pages-per-sheet", type=int, default=6)
    parser.add_argument("--columns", type=int, default=3)
    parser.add_argument("--thumb-width", type=int, default=430)
    args = parser.parse_args()

    pages = sorted(args.input_dir.glob("page-*.png"), key=page_number)
    if not pages:
        raise SystemExit(f"no rendered pages found in {args.input_dir}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default()
    rows = math.ceil(args.pages_per_sheet / args.columns)
    gutter = 20
    label_height = 30

    for offset in range(0, len(pages), args.pages_per_sheet):
        batch = pages[offset:offset + args.pages_per_sheet]
        with Image.open(batch[0]) as first:
            thumb_height = round(args.thumb_width * first.height / first.width)
        sheet_width = gutter + args.columns * (args.thumb_width + gutter)
        sheet_height = gutter + rows * (label_height + thumb_height + gutter)
        sheet = Image.new("RGB", (sheet_width, sheet_height), "#D5D5D5")
        draw = ImageDraw.Draw(sheet)

        for index, page_path in enumerate(batch):
            row, column = divmod(index, args.columns)
            x = gutter + column * (args.thumb_width + gutter)
            y = gutter + row * (label_height + thumb_height + gutter)
            number = page_number(page_path)
            draw.text((x, y + 6), f"PAGE {number}", fill="#111111", font=font)
            with Image.open(page_path) as image:
                image = image.convert("RGB")
                image.thumbnail((args.thumb_width, thumb_height), Image.Resampling.LANCZOS)
                sheet.paste(image, (x, y + label_height))

        start = page_number(batch[0])
        end = page_number(batch[-1])
        sheet.save(args.output_dir / f"pages-{start:02d}-{end:02d}.jpg", quality=90)


if __name__ == "__main__":
    main()
