"""Plugin-owned storyboard planning and rendering.

Density integration and Laplacian candidate ranking are adapted from
SAOS-3624/dsh-video-storyboard (MIT), e32f9f66b61b7ac579481f6ddf458cc8b00d3bbe.
See ../THIRD_PARTY_NOTICES.md. No DSH runtime, credentials or storage are used.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
import math

from common import contained, write_json

CELLS_PER_SHEET = 12


def plan_ranges(start, end, count, cuts=(), segments=()):
    """Equal density mass, bounded to 2.5x; ranges describe context, not observation."""
    duration = end - start
    count = min(count, max(1, int(duration / 0.15)))
    bins = max(1, math.ceil(duration / 0.1))
    step = duration / bins
    cuts = sorted(t for t in cuts if start < t < end)
    mean = len(cuts) / duration
    speech = [0.0] * bins
    for segment in segments:
        a, b = max(start, segment["start"]), min(end, segment["end"])
        if b <= a:
            continue
        rate = len(segment["text"]) / (segment["end"] - segment["start"])
        for i in range(max(0, int((a - start) / step)), min(bins, math.ceil((b - start) / step))):
            speech[i] += rate
    speech_mean = sum(speech) / bins
    # Smooth local cut density; a baseline of 1 keeps quiet sections represented.
    raw = []
    for i in range(bins):
        t = start + (i + 0.5) * step
        a, b = max(start, t - 2), min(end, t + 2)
        raw.append((bisect_right(cuts, b) - bisect_left(cuts, a)) / (b - a))
    prefix = [0.0]
    for value in raw:
        prefix.append(prefix[-1] + value)
    cumulative = [0.0]
    half = max(1, round(2 / step))
    for i in range(bins):
        lo, hi = max(0, i - half), min(bins, i + half + 1)
        smooth = (prefix[hi] - prefix[lo]) / (hi - lo)
        density = max(1.0, smooth / mean) if mean else 1.0
        if speech_mean:
            density *= min(1.4, max(0.75, speech[i] / speech_mean))
        cumulative.append(cumulative[-1] + min(2.5, max(1.0, density)) * step)
    bounds = [start]
    for i in range(1, count):
        target = cumulative[-1] * i / count
        index = max(1, bisect_left(cumulative, target))
        fraction = (target - cumulative[index - 1]) / (cumulative[index] - cumulative[index - 1])
        value = start + (index - 1 + fraction) * step
        # Small boundary shifts only, so snapping cannot erase the coverage floor.
        closest = min(cuts, key=lambda t: abs(t - value), default=value)
        if abs(closest - value) <= min(0.5, duration / count * 0.15):
            value = closest
        value = min(end - 0.05 * (count - i), max(bounds[-1] + 0.05, value))
        bounds.append(round(value, 6))
    bounds.append(end)
    return [{"start_seconds": a, "end_seconds": b} for a, b in zip(bounds, bounds[1:])]


def point_ranges(start, end, points):
    """Context windows for explicit/uniform samples; never claim continuous viewing."""
    bounds = [start, *[(a + b) / 2 for a, b in zip(points, points[1:])], end]
    return [{"start_seconds": a, "end_seconds": b} for a, b in zip(bounds, bounds[1:])]


def candidate_points(ranges):
    groups = []
    for i, cell in enumerate(ranges):
        a, b = cell["start_seconds"], cell["end_seconds"]
        if i == 0:
            points = [a]  # Preserve the start anchor even if it is a fade-in.
        elif i == len(ranges) - 1:
            points = [max(a, b - min(0.5, (b - a) / 10))]
        else:
            points = [a + (b - a) * ratio for ratio in (0.2, 0.5, 0.8)]
        groups.append([round(p, 6) for p in points])
    return groups


def sharpness(image):
    """Laplacian variance on a bounded thumbnail, without a NumPy dependency."""
    gray = image.convert("L")
    gray.thumbnail((160, 160))
    width, height = gray.size
    pixels = gray.tobytes()
    total = squares = count = 0
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            i = y * width + x
            value = pixels[i - 1] + pixels[i + 1] + pixels[i - width] + pixels[i + width] - 4 * pixels[i]
            total += value
            squares += value * value
            count += 1
    return squares / count - (total / count) ** 2 if count else 0


def align_transcript(cell, segments, max_chars=400, max_lines=6):
    hits = [s for s in segments if s["end"] > cell["start_seconds"] and s["start"] < cell["end_seconds"]]
    lines, chars = [], 0
    truncated = False
    for segment in hits:
        if len(lines) >= max_lines or chars >= max_chars:
            truncated = True
            break
        text = segment["text"][:max_chars - chars]
        truncated |= len(text) < len(segment["text"])
        lines.append({**segment, "text": text})
        chars += len(text)
    return {"lines": lines, "segment_count": len(hits), "truncated": truncated}


def stamp(seconds):
    milliseconds = round(seconds * 1000)
    minutes, remainder = divmod(milliseconds, 60000)
    return f"{minutes:02d}:{remainder / 1000:06.3f}"


def render(directory, ranges, points, frames, segments, meta, crop, runner):
    """Persist immutable per-job cells. Duplicate images retain distinct time cells."""
    from PIL import Image, ImageDraw, ImageFont
    cells, missing = [], []
    for cell_id, (window, point) in enumerate(zip(ranges, points), 1):
        match = next(((frame, observation) for frame in frames for observation in frame["observations"]
                      if abs(observation["requested_seconds"] - point) < 0.00001), None)
        if not match or not window["start_seconds"] <= match[1]["timestamp_seconds"] < window["end_seconds"]:
            missing.append({"cell_id": cell_id, "range": window})
            continue
        frame, observation = match
        cells.append({"cell_id": cell_id, "range": window,
                      "frame_index": frame["index"], "timestamp_seconds": observation["timestamp_seconds"],
                      "transcript": align_transcript(window, segments)})
    if not cells:
        return {"available": False, "reason": "没有可用于分镜的画面"}
    sheets = []
    source_width = crop["width"] if crop else meta["width"]
    source_height = crop["height"] if crop else meta["height"]
    scale = min(1.0, 320 / max(source_width, source_height), 240 / min(source_width, source_height))
    tile_w, tile_h = max(180, round(source_width * scale)), max(100, round(source_height * scale))
    # Letterboxing keeps edge text and controls; no cover/crop of the source.
    gutter, label_h = 6, 26
    font = ImageFont.load_default(size=16)
    by_index = {frame["index"]: frame for frame in frames}
    for page, offset in enumerate(range(0, len(cells), CELLS_PER_SHEET)):
        runner.check()
        part = cells[offset:offset + CELLS_PER_SHEET]
        cols = math.ceil(math.sqrt(len(part)))
        rows = math.ceil(len(part) / cols)
        canvas = Image.new("RGB", (cols * (tile_w + gutter) + gutter, rows * (tile_h + label_h + gutter) + gutter), (22, 23, 27))
        draw = ImageDraw.Draw(canvas)
        for index, cell in enumerate(part):
            runner.check()
            x = gutter + (index % cols) * (tile_w + gutter)
            y = gutter + (index // cols) * (tile_h + label_h + gutter)
            frame = by_index[cell["frame_index"]]
            with Image.open(contained(directory, frame["file"])) as source:
                tile = source.convert("RGB")
                tile.thumbnail((tile_w, tile_h), Image.Resampling.LANCZOS)
                dx, dy = x + (tile_w - tile.width) // 2, y + (tile_h - tile.height) // 2
                canvas.paste(tile, (dx, dy))
                cell["image_rect"] = {"x": dx, "y": dy, "width": tile.width, "height": tile.height}
            label = f"{cell['cell_id']}  {stamp(cell['timestamp_seconds'])}"
            draw.text((x + 3, y + tile_h + 4), label, fill=(245, 229, 150), font=font)
        filename = f"storyboard-{page:02d}.jpg"
        canvas.save(contained(directory, filename), format="JPEG", quality=88, optimize=True)
        sheets.append({"page": page, "file": filename, "width": canvas.width, "height": canvas.height, "cells": part})
    write_json(contained(directory, "storyboard.json"), {"sheets": sheets, "source_view": {
        "source_width": meta["width"], "source_height": meta["height"], "crop": crop}})
    return {"available": True, "sheets": len(sheets), "cells": len(cells), "missing_cells": missing}
