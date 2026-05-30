"""
convert_frames.py — Convert 192 TIFF animation frames to dual-resolution WebP.

Outputs:
  assets/frames/1x/frame-001.webp  ...  frame-192.webp  (1920x1080)
  assets/frames/2x/frame-001.webp  ...  frame-192.webp  (2560x1440)
  assets/frames/poster.webp                              (2560x1440, frame 192)

Usage:
  python scripts/convert_frames.py
  python scripts/convert_frames.py --src "G:/Mój dysk/pics_upscale/upscaled123" --quality 80
"""

import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

RESOLUTIONS = {
    "1x": (1920, 1080),
    "2x": (2560, 1440),
}

DEFAULT_SRC = "G:/Mój dysk/pics_upscale/upscaled123"
DEFAULT_DST = str(Path(__file__).parent.parent / "assets" / "frames")
DEFAULT_QUALITY = 80


def convert_frame(args):
    src_path, dst_1x, dst_2x, quality = args
    try:
        with Image.open(src_path) as img:
            # Normalize to RGB (drop alpha channel if present)
            if img.mode != "RGB":
                img = img.convert("RGB")

            stem = src_path.stem  # e.g. "00042"
            frame_num = int(stem)
            out_name = f"frame-{frame_num:03d}.webp"

            for tier, (w, h), dst_dir in [
                ("1x", RESOLUTIONS["1x"], dst_1x),
                ("2x", RESOLUTIONS["2x"], dst_2x),
            ]:
                out_path = Path(dst_dir) / out_name
                resized = img.resize((w, h), Image.LANCZOS)
                resized.save(str(out_path), "WEBP", quality=quality, method=6)

        return frame_num, None
    except Exception as exc:
        return None, f"{src_path}: {exc}"


def main():
    parser = argparse.ArgumentParser(description="Convert TIFF frames to dual-res WebP")
    parser.add_argument("--src", default=DEFAULT_SRC, help="Source directory of .tiff files")
    parser.add_argument("--dst", default=DEFAULT_DST, help="Output base directory")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY, help="WebP quality (0-100)")
    parser.add_argument("--workers", type=int, default=os.cpu_count(), help="Parallel workers")
    args = parser.parse_args()

    src_dir = Path(args.src)
    dst_1x = Path(args.dst) / "1x"
    dst_2x = Path(args.dst) / "2x"

    dst_1x.mkdir(parents=True, exist_ok=True)
    dst_2x.mkdir(parents=True, exist_ok=True)

    tiffs = sorted(src_dir.glob("*.tiff"))
    if not tiffs:
        print(f"ERROR: No .tiff files found in {src_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(tiffs)} TIFF frames in {src_dir}")
    print(f"Output: {args.dst}  |  Quality: {args.quality}  |  Workers: {args.workers}")
    print(f"  1x -> {RESOLUTIONS['1x'][0]}x{RESOLUTIONS['1x'][1]}")
    print(f"  2x -> {RESOLUTIONS['2x'][0]}x{RESOLUTIONS['2x'][1]}")
    print()

    tasks = [(t, dst_1x, dst_2x, args.quality) for t in tiffs]
    done = 0
    errors = []
    t0 = time.time()

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(convert_frame, task): task for task in tasks}
        for future in as_completed(futures):
            frame_num, err = future.result()
            if err:
                errors.append(err)
            else:
                done += 1
                elapsed = time.time() - t0
                rate = done / elapsed
                eta = (len(tiffs) - done) / rate if rate > 0 else 0
                print(
                    f"\r  {done}/{len(tiffs)} frames  "
                    f"[{elapsed:.0f}s elapsed, ~{eta:.0f}s remaining]",
                    end="",
                    flush=True,
                )

    print()

    # Generate poster from the last frame (frame 192 = fully open laptop)
    last_tiff = sorted(tiffs)[-1]
    poster_path = Path(args.dst) / "poster.webp"
    print(f"\nGenerating poster from {last_tiff.name} -> {poster_path}")
    with Image.open(last_tiff) as img:
        if img.mode != "RGB":
            img = img.convert("RGB")
        resized = img.resize(RESOLUTIONS["2x"], Image.LANCZOS)
        resized.save(str(poster_path), "WEBP", quality=args.quality, method=6)

    # Report totals
    size_1x = sum(f.stat().st_size for f in dst_1x.glob("*.webp"))
    size_2x = sum(f.stat().st_size for f in dst_2x.glob("*.webp"))
    count_1x = len(list(dst_1x.glob("*.webp")))
    count_2x = len(list(dst_2x.glob("*.webp")))

    print()
    print("=" * 50)
    print(f"Done in {time.time() - t0:.1f}s")
    print(f"  1x: {count_1x} files  {size_1x / 1e6:.1f} MB  (avg {size_1x / max(count_1x,1) / 1e3:.0f} KB/frame)")
    print(f"  2x: {count_2x} files  {size_2x / 1e6:.1f} MB  (avg {size_2x / max(count_2x,1) / 1e3:.0f} KB/frame)")
    print(f"  poster: {poster_path.stat().st_size / 1e3:.0f} KB")

    if errors:
        print(f"\n{len(errors)} ERROR(S):")
        for e in errors:
            print(f"  {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
