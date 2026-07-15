#!/usr/bin/env python3
"""Create full-resolution vertical page strips for visual DOCX QA."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("render_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--per-strip", type=int, default=5)
    args = parser.parse_args()

    pages = sorted(
        args.render_dir.glob("page-*.png"),
        key=lambda path: int(path.stem.split("-")[-1]),
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 26)
    for start in range(0, len(pages), args.per_strip):
        chunk = pages[start:start + args.per_strip]
        images = [Image.open(path).convert("RGB") for path in chunk]
        width = max(image.width for image in images)
        label_height = 48
        gap = 18
        height = sum(image.height + label_height for image in images) + gap * (len(images) - 1)
        strip = Image.new("RGB", (width, height), "#B7B7BD")
        draw = ImageDraw.Draw(strip)
        y = 0
        for path, page in zip(chunk, images):
            page_number = int(path.stem.split("-")[-1])
            draw.rectangle((0, y, width, y + label_height), fill="#17181C")
            draw.text((20, y + 7), f"PAGE {page_number}", font=font, fill="#FFFFFF")
            y += label_height
            strip.paste(page, (0, y))
            y += page.height + gap
        end_page = int(chunk[-1].stem.split("-")[-1])
        output = args.output_dir / f"pages-{start + 1:02d}-{end_page:02d}.png"
        strip.save(output, optimize=True)
        print(output)


if __name__ == "__main__":
    main()
