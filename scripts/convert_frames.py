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
import shutil
import sys
import tempfile
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
FRAME_COUNT = 192


def discover_frames(src_dir):
    candidates = sorted(
        (path for path in src_dir.iterdir() if path.is_file() and path.suffix.lower() in {".tif", ".tiff"}),
        key=lambda path: path.name.lower(),
    )
    by_number = {}
    problems = []
    for path in candidates:
        if not path.stem.isdigit():
            problems.append(f"unexpected non-numeric frame name: {path.name}")
            continue
        number = int(path.stem)
        if not 1 <= number <= FRAME_COUNT:
            problems.append(f"frame number outside 1-{FRAME_COUNT}: {path.name}")
            continue
        if number in by_number:
            problems.append(
                f"duplicate frame {number}: {by_number[number].name} and {path.name}"
            )
            continue
        by_number[number] = path

    missing = sorted(set(range(1, FRAME_COUNT + 1)) - set(by_number))
    if missing:
        preview = ", ".join(str(number) for number in missing[:12])
        suffix = "…" if len(missing) > 12 else ""
        problems.append(f"missing frame numbers: {preview}{suffix}")
    if problems:
        raise ValueError("; ".join(problems))
    return [by_number[number] for number in range(1, FRAME_COUNT + 1)]


def validate_outputs(directory):
    expected = {f"frame-{number:03d}.webp" for number in range(1, FRAME_COUNT + 1)}
    actual = {path.name for path in directory.glob("*.webp")}
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise RuntimeError(
            f"invalid output set in {directory}: missing={missing[:5]}, unexpected={unexpected[:5]}"
        )


def publish_frames(staging_root, destination_root):
    destination_root.mkdir(parents=True, exist_ok=True)
    for tier in RESOLUTIONS:
        source = staging_root / tier
        target = destination_root / tier
        target.mkdir(parents=True, exist_ok=True)
        for stale in target.glob("*.webp"):
            stale.unlink()
        for generated in source.glob("*.webp"):
            os.replace(generated, target / generated.name)
    os.replace(staging_root / "poster.webp", destination_root / "poster.webp")


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

    if not 0 <= args.quality <= 100:
        parser.error("--quality must be between 0 and 100")
    if args.workers is None or args.workers < 1:
        parser.error("--workers must be at least 1")

    src_dir = Path(args.src)
    if not src_dir.is_dir():
        print(f"ERROR: Source directory does not exist: {src_dir}", file=sys.stderr)
        sys.exit(1)
    try:
        tiffs = discover_frames(src_dir)
    except ValueError as exc:
        print(f"ERROR: Expected exactly {FRAME_COUNT} uniquely numbered TIFF frames: {exc}", file=sys.stderr)
        sys.exit(1)

    destination_root = Path(args.dst).resolve()
    destination_root.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(
        prefix=f".{destination_root.name}-staging-",
        dir=destination_root.parent,
    ))
    dst_1x = staging_root / "1x"
    dst_2x = staging_root / "2x"
    dst_1x.mkdir()
    dst_2x.mkdir()

    print(f"Validated {len(tiffs)} TIFF frames in {src_dir}")
    print(f"Output: {destination_root}  |  Quality: {args.quality}  |  Workers: {args.workers}")
    print(f"  1x -> {RESOLUTIONS['1x'][0]}x{RESOLUTIONS['1x'][1]}")
    print(f"  2x -> {RESOLUTIONS['2x'][0]}x{RESOLUTIONS['2x'][1]}")
    print()

    tasks = [(t, dst_1x, dst_2x, args.quality) for t in tiffs]
    done = 0
    errors = []
    t0 = time.time()

    try:
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
        if errors:
            print(f"\n{len(errors)} ERROR(S):")
            for error in errors:
                print(f"  {error}")
            sys.exit(1)

        # Frame 192 is the fully open laptop; numeric validation makes this deterministic.
        last_tiff = tiffs[-1]
        poster_path = staging_root / "poster.webp"
        print(f"\nGenerating poster from {last_tiff.name} -> {poster_path}")
        with Image.open(last_tiff) as img:
            if img.mode != "RGB":
                img = img.convert("RGB")
            resized = img.resize(RESOLUTIONS["2x"], Image.LANCZOS)
            resized.save(str(poster_path), "WEBP", quality=args.quality, method=6)

        validate_outputs(dst_1x)
        validate_outputs(dst_2x)
        size_1x = sum(path.stat().st_size for path in dst_1x.glob("*.webp"))
        size_2x = sum(path.stat().st_size for path in dst_2x.glob("*.webp"))
        poster_size = poster_path.stat().st_size
        publish_frames(staging_root, destination_root)

        print()
        print("=" * 50)
        print(f"Done in {time.time() - t0:.1f}s")
        print(f"  1x: {FRAME_COUNT} files  {size_1x / 1e6:.1f} MB  (avg {size_1x / FRAME_COUNT / 1e3:.0f} KB/frame)")
        print(f"  2x: {FRAME_COUNT} files  {size_2x / 1e6:.1f} MB  (avg {size_2x / FRAME_COUNT / 1e3:.0f} KB/frame)")
        print(f"  poster: {poster_size / 1e3:.0f} KB")
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


if __name__ == "__main__":
    main()
