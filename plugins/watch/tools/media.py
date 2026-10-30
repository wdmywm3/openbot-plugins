"""Video reading; all source, caption and evidence rules live in the plugin.

Timestamp extraction is adapted from bradautomates/claude-video (MIT).
See ../THIRD_PARTY_NOTICES.md. No upstream setup or credential loading is used.
"""
from __future__ import annotations

import hashlib
import html
import importlib.util
import json
import math
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from common import (Cancelled, DOWNLOAD_FORMAT, DOWNLOAD_SORT, MAX_DURATION, MAX_FRAME_EDGE,
                    MAX_MEDIA, MAX_WINDOW, PREFERRED_RESOLUTION, WatchError,
                    canonical_source, contained, read_json, write_json)
import storyboard
import asr
from sources import configured_local_file, remote_source

TIMESTAMP = re.compile(r"pts_time:([^\s]+)")
FRAME_SIZE = re.compile(r"\bs:(\d+)x(\d+)\b")
TIMING = re.compile(r"^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})")
MEDIA_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".wmv", ".mpg", ".mpeg", ".ts", ".m2ts", ".ogv", ".3gp", ".3g2",
                    ".mp3", ".m4a", ".wav", ".ogg", ".opus", ".flac", ".aac", ".aiff", ".aif"}
LOCAL_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,flv,asf,mpeg,mpegts,ogg,mp3,wav,flac,aac,aiff"]


def seconds(value):
    return sum(float(part) * 60 ** i for i, part in enumerate(reversed(value.replace(",", ".").split(":"))))


def parse_captions(path):
    path = Path(path)
    if path.stat().st_size > 4 * 1024 * 1024:
        raise WatchError("字幕文件过大")
    text = path.read_text(encoding="utf-8-sig")
    raw = []
    if path.suffix in {".json", ".json3"}:
        data = json.loads(text)
        for item in data.get("body", []):
            raw.append((item.get("from"), item.get("to"), item.get("content")))
        for item in data.get("events", []):
            if "tStartMs" in item and "dDurationMs" in item:
                raw.append((item["tStartMs"] / 1000, (item["tStartMs"] + item["dDurationMs"]) / 1000,
                            "".join(s.get("utf8", "") for s in item.get("segs", []))))
    else:
        lines, i = text.splitlines(), 0
        while i < len(lines):
            if re.match(r"^(NOTE(?:\s|$)|STYLE$|REGION$)", lines[i]):
                i += 1
                while i < len(lines) and lines[i].strip():
                    i += 1
                continue
            match = TIMING.match(lines[i])
            i += 1
            if not match:
                continue
            payload = []
            while i < len(lines) and lines[i].strip() and not TIMING.match(lines[i]):
                payload.append(lines[i])
                i += 1
            raw.append((seconds(match[1]), seconds(match[2]), " ".join(payload)))
    segments = []
    for start, end, content in raw:
        if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or not isinstance(content, str):
            continue
        content = html.unescape(re.sub(r"<[^>]*>", "", content)).strip()
        if content:
            segments.append({"start": round(start, 6), "end": round(end, 6), "text": content[:4000]})
    segments.sort(key=lambda s: (s["start"], s["end"]))
    result = []
    for seg in segments:
        if result and seg["start"] < result[-1]["end"] and seg["text"] == result[-1]["text"]:
            result[-1]["end"] = max(result[-1]["end"], seg["end"])
        else:
            result.append(seg)
    return result[:30000]


def choose_subtitle(info):
    automatic = info.get("automatic_captions") or {}
    originals = sorted(key for key in automatic if key.endswith("-orig") and automatic[key])
    original_language = originals[0][:-5] if len(originals) == 1 else info.get("language")
    fallback = []
    for kind in ("subtitles", "automatic_captions"):
        tracks = info.get(kind) or {}
        languages = [key for key, value in tracks.items() if key != "live_chat" and value and re.fullmatch(r"[\w.-]{1,40}", key)]
        languages.sort(key=lambda key: (0 if key.removeprefix("ai-").startswith("zh") else 1 if key.removeprefix("ai-").startswith("en") else 2, key))
        if languages:
            fallback.append((kind, languages[0]))
        if original_language:
            languages = [key for key in languages if key.removeprefix("ai-").removesuffix("-orig").split("-")[0] == original_language.split("-")[0]]
        if kind == "automatic_captions" and originals:
            languages = [key for key in originals if key in languages] or languages
        if languages:
            return kind, languages[0]
    return fallback[0] if fallback else (None, None)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def expand_short_url(url):
    for _ in range(4):
        if not url.startswith("https://b23.tv/"):
            return canonical_source(url)
        try:
            with build_opener(NoRedirect).open(Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"}), timeout=15) as response:
                target = response.headers.get("Location")
        except HTTPError as exc:
            target = exc.headers.get("Location") if exc.code in {301, 302, 303, 307, 308} else None
            exc.close()
        if not target:
            raise WatchError("短链接未解析为可读取的视频")
        url = canonical_source(urljoin(url, target))
    raise WatchError("短链接跳转过多")


def probe(path, runner):
    out, _ = runner.run(["ffprobe", "-v", "error", *LOCAL_INPUT, "-show_streams", "-show_format", "-of", "json", str(path)], 30)
    data = json.loads(out)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video and not audio:
        raise WatchError("没有可读取的视频或音频流")
    fmt = data.get("format", {})
    duration = float((video or audio).get("duration") or fmt.get("duration") or 0)
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION + 1:
        raise WatchError(f"支持最长 {MAX_DURATION // 60} 分钟的视频")
    if video and (not 0 < int(video.get("width", 0)) <= 16384 or not 0 < int(video.get("height", 0)) <= 16384):
        raise WatchError("视频画面尺寸无效")
    return {"duration_seconds": duration, "width": video["width"] if video else 0, "height": video["height"] if video else 0,
            "has_video": bool(video), "has_audio": bool(audio),
            "subtitle_streams": [{"index": s["index"], "codec": s.get("codec_name"), "language": s.get("tags", {}).get("language"),
                                  "default": bool(s.get("disposition", {}).get("default"))} for s in streams if s.get("codec_type") == "subtitle"]}


def embedded_captions(video, meta, directory, runner, warnings):
    tracks = sorted(meta.get("subtitle_streams", []), key=lambda s: not s["default"])
    for track in tracks:
        if track["codec"] not in {"subrip", "ass", "ssa", "webvtt", "mov_text", "text"}:
            continue
        path = directory / "embedded.vtt"
        try:
            runner.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *LOCAL_INPUT,
                        "-i", str(video), "-map", f"0:{track['index']}", "-c:s", "webvtt", "-fs", str(4 * 1024 * 1024), str(path)], 60)
            rows = parse_captions(path)
            if rows:
                return {"segments": rows, "source": "embedded_subtitles", "language": track["language"]}
        except Cancelled:
            raise
        except (WatchError, OSError, ValueError):
            warnings.append("一条内嵌字幕未能读取")
        finally:
            path.unlink(missing_ok=True)
    if tracks:
        warnings.append("没有取得可用的内嵌文字字幕；图片字幕未转换为文字")
    return {"segments": [], "source": "unavailable"}


def link_copy(source, target):
    try:
        Path(target).hardlink_to(source)
    except OSError:
        shutil.copyfile(source, target)


def direct_source(source, source_type="auto"):
    return remote_source(source) and (source_type == "direct" or source_type == "auto" and Path(urlsplit(source).path).suffix.lower() in MEDIA_EXTENSIONS)


def single_video_info(info):
    # Generic HTML pages may be represented as one-entry playlists by yt-dlp.
    for _ in range(4):
        if not isinstance(info, dict):
            break
        if info.get("_type") not in {"playlist", "multi_video"} and "entries" not in info:
            return info
        entries = info.get("entries")
        if not isinstance(entries, list) or len(entries) != 1:
            break
        info = entries[0]
    raise WatchError("页面包含多个视频或未指定视频，请打开需要观看的具体视频链接")


def acquire(source, directory, root, runner, stage, source_type="auto", transcript_only=False):
    """Returns a local immutable media file, metadata and full-source captions."""
    warnings = []
    if source.startswith(("watch:", "import:")):
        prefix, identity = source.split(":")
        folder = contained(root, "jobs" if prefix == "watch" else "imports", identity)
        manifest = read_json(contained(folder, "source.json"))
        if manifest.get("kind") == "captions":
            if transcript_only:
                captions = read_json(contained(folder, "captions.json"))
                write_json(directory / "source.json", manifest)
                write_json(directory / "captions.json", captions)
                return None, manifest, captions, list(manifest.get("warnings", []))
            return acquire(manifest["url"], directory, root, runner, stage, "page", transcript_only)
        if manifest.get("audio_only") and not transcript_only and manifest.get("url"):
            return acquire(manifest["url"], directory, root, runner, stage, "page", False)
        video = contained(folder, manifest["file"])
        target = directory / ("media" + video.suffix)
        link_copy(video, target)
        manifest = {**manifest, "file": target.name}
        captions = read_json(contained(folder, "captions.json")) if (folder / "captions.json").exists() else {"segments": [], "source": "unavailable"}
        write_json(directory / "source.json", manifest)
        write_json(directory / "captions.json", captions)
        return target, manifest, captions, list(manifest.get("warnings", []))
    if not remote_source(source):
        source_file = configured_local_file(source, root)
        if source_file.suffix.lower() not in MEDIA_EXTENSIONS or not 0 < source_file.stat().st_size <= MAX_MEDIA:
            raise WatchError("请选择不超过 256 MiB 的视频文件")
        target = directory / ("media" + source_file.suffix.lower())
        shutil.copyfile(source_file, target)
        manifest = {"file": target.name, "title": source_file.name[:300], "source_type": "local"}
        captions = {"segments": [], "source": "unavailable"}
        write_json(directory / "source.json", manifest)
        write_json(directory / "captions.json", captions)
        return target, manifest, captions, warnings
    if direct_source(source, source_type):
        stage("下载视频文件")
        suffix = Path(urlsplit(source).path).suffix.lower()
        target = directory / ("media" + (suffix if suffix in MEDIA_EXTENSIONS else ".mp4"))
        runner.run([sys.executable, "-B", str(Path(__file__).with_name("download.py")), "--direct", source, str(target)], 600)
        manifest = {"file": target.name, "title": "视频附件", "source_type": "direct"}
        captions = {"segments": [], "source": "unavailable"}
        write_json(directory / "source.json", manifest)
        write_json(directory / "captions.json", captions)
        return target, manifest, captions, warnings
    source = expand_short_url(source)
    base = [sys.executable, "-B", str(Path(__file__).with_name("download.py")), "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-playlist", "--proxy", "", "--downloader", "native",
            "--no-progress", "--socket-timeout", "20", "--retries", "1", "--fragment-retries", "1",
            "-f", DOWNLOAD_FORMAT, "-S", DOWNLOAD_SORT]
    cookies = contained(root, "cookies.txt")
    if cookies.is_file():
        base += ["--cookies", str(cookies)]
    stage("读取视频信息")
    info_file = directory / "download.info.json"
    if urlsplit(source).hostname in {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}:
        if not importlib.util.find_spec("yt_dlp"):
            raise WatchError("B 站读取需要当前 Python 环境中的 yt-dlp，请安装 requirements-media.txt")
        command = [sys.executable, "-B", str(Path(__file__).with_name("download_info.py")), "--source", source, "--output", str(info_file)]
        if cookies.is_file():
            command += ["--cookies", str(cookies)]
        runner.run(command, 120)
        info = read_json(info_file)
    else:
        raw, _ = runner.run(base + ["--dump-single-json", "--skip-download", source], 120)
        info = single_video_info(json.loads(raw))
        write_json(info_file, info)
    reported = info.get("watch_source_duration") or info.get("duration")
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
        raise WatchError("请提供已结束并完成处理的视频，暂不读取直播")
    if reported is not None and (not isinstance(reported, (int, float)) or not math.isfinite(reported) or not 0 < reported <= MAX_DURATION):
        raise WatchError(f"支持最长 {MAX_DURATION // 60} 分钟的视频")
    # Reuse the extracted manifest for download and captions, as upstream Watch
    # does. Do not repeat the page/API extraction for each processing stage.
    from_info = ["--load-info-json", str(info_file)]
    prefix = str(directory).replace("%", "%%")
    manifest = {"url": source, "title": str(info.get("title") or "视频")[:300], "reported_duration_seconds": reported,
                "metadata_origin": info.get("watch_metadata_origin", "yt_dlp"), "preferred_resolution": PREFERRED_RESOLUTION}
    captions = {"segments": [], "source": "unavailable"}
    kind, language = choose_subtitle(info)
    if language:
        stage("读取字幕")
        try:
            runner.run(base + ["--skip-download", "--write-subs" if kind == "subtitles" else "--write-auto-subs",
                              "--sub-langs", "-all,^" + re.escape(language) + "$", "--sub-format", "json3/vtt/srt/json/best",
                              "-o", prefix + "/subtitle.%(ext)s", *from_info], 90)
            for path in sorted(directory.glob("subtitle.*")):
                if path.suffix in {".vtt", ".srt", ".json", ".json3"}:
                    segments = parse_captions(path)
                    if segments:
                        automatic = kind == "automatic_captions" or language.startswith("ai-")
                        captions = {"segments": segments, "source": "automatic_subtitles" if automatic else "publisher_subtitles", "language": language}
                        break
        except Cancelled:
            raise
        except (WatchError, ValueError, TypeError, KeyError):
            warnings.append("字幕下载或解析失败；画面仍可读取")
    video = None
    if not (transcript_only and captions["segments"]):
        stage("下载音频" if transcript_only else "下载视频")
        try:
            runner.run(base + (["-f", "ba/b"] if transcript_only else []) + ["--no-part", "--max-filesize", str(MAX_MEDIA),
                              "--merge-output-format", "mp4", "--no-write-subs", "--no-write-auto-subs",
                              "-o", prefix + "/media.%(ext)s", *from_info], 600)
            files = [p for p in directory.glob("media.*") if p.suffix in MEDIA_EXTENSIONS and not re.search(r"\.f\d+\.", p.name)]
            if len(files) != 1 or not 0 < files[0].stat().st_size <= MAX_MEDIA:
                raise WatchError("没有取得完整媒体文件，或文件超过 256 MiB 限制")
            video = files[0]
        except Cancelled:
            raise
        except WatchError:
            if not captions["segments"]:
                raise
            warnings.append("媒体下载失败，已保留可用字幕；本次没有画面或声音证据")
    manifest.update({"file": video.name} if video else {"kind": "captions"})
    if video and transcript_only:
        manifest["audio_only"] = True
    manifest["warnings"] = warnings
    write_json(directory / "source.json", manifest)
    write_json(directory / "captions.json", captions)
    return video, manifest, captions, warnings


def even_sample(values, count):
    if len(values) <= count:
        return list(values)
    if count == 1:
        return [values[len(values) // 2]]
    return [values[round(i * (len(values) - 1) / (count - 1))] for i in range(count)]


def scene_times(video, start, end, runner):
    # Keep decoded PTS, including VFR sources. Do not derive timestamps from FPS.
    _, stderr = runner.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "info", "-ss", str(start),
                            *LOCAL_INPUT, "-i", str(video), "-t", str(end - start), "-an",
                            "-vf", "scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score",
                            "-fps_mode", "vfr", "-f", "null", "-"], 120)
    samples, timestamp = [], None
    for line in stderr.splitlines():
        found = TIMESTAMP.search(line)
        if found:
            timestamp = start + float(found[1])
        score = re.search(r"lavfi\.scene_score=([\d.eE+-]+)", line)
        if score and timestamp is not None:
            value = float(score[1])
            if start <= timestamp < end and math.isfinite(value):
                samples.append((timestamp, value))
    return adaptive_cuts(samples)


def adaptive_cuts(samples):
    """Content-relative threshold plus local spikes; suppress nearby transitions."""
    if not samples:
        return []
    values = sorted(score for _, score in samples)
    median = values[len(values) // 2]
    deviations = sorted(abs(value - median) for value in values)
    threshold = min(0.3, max(0.04, median + 6 * deviations[len(deviations) // 2]))
    candidates = []
    for i, (timestamp, score) in enumerate(samples):
        neighbors = [s for _, s in samples[max(0, i - 5):i] + samples[i + 1:i + 6]]
        baseline = sorted(neighbors)[len(neighbors) // 2] if neighbors else median
        if score >= threshold and score >= max(0.04, baseline * 2.5):
            if candidates and timestamp - candidates[-1][0] < 0.15:
                if score > candidates[-1][1]:
                    candidates[-1] = (timestamp, score)
            else:
                candidates.append((timestamp, score))
    return [round(t, 6) for t, _ in candidates]


def select_clear_points(video, ranges, directory, runner):
    """Decode small candidates in one pass; only chosen frames are decoded at full size."""
    from PIL import Image
    groups = storyboard.candidate_points(ranges)
    points = sorted(set(point for group in groups for point in group))
    start, end = ranges[0]["start_seconds"], ranges[-1]["end_seconds"]
    expression = "+".join(f"gte(t,{point - start:.6f})*(isnan(prev_selected_t)+lt(prev_selected_t,{point - start:.6f}))" for point in points)
    with tempfile.TemporaryDirectory(prefix="candidates-", dir=directory) as temporary:
        pattern = str(Path(temporary) / "candidate-%03d.jpg")
        _, stderr = runner.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "info", "-y", "-ss", str(start),
                                *LOCAL_INPUT, "-i", str(video), "-t", str(end - start), "-an",
                                "-vf", f"select='{expression}',scale=320:320:force_original_aspect_ratio=decrease,showinfo",
                                "-fps_mode", "vfr", "-q:v", "3", "-frames:v", str(len(points)), pattern], 120)
        # showinfo runs before the output -t trim; VFR can report a trailing
        # candidate beyond the window which is never written by the muxer.
        stamps = [start + float(s) for s in TIMESTAMP.findall(stderr) if math.isfinite(float(s)) and 0 <= float(s) < end - start]
        files = sorted(Path(temporary).glob("candidate-*.jpg"))
        if len(stamps) != len(files):
            raise WatchError("候选画面缺少实际时间戳")
        candidates = []
        for timestamp, file in zip(stamps, files):
            runner.check()
            if not math.isfinite(timestamp) or not start <= timestamp < end:
                continue
            with Image.open(file) as image:
                candidates.append((timestamp, storyboard.sharpness(image)))
        selected = []
        for window, group in zip(ranges, groups):
            choices = [item for item in candidates if window["start_seconds"] <= item[0] < window["end_seconds"]]
            # Extremely low-FPS cells may contain no frame. The normal extraction
            # path checks the decoded timestamp; missing cells remain visible.
            selected.append(round(max(choices, key=lambda item: item[1])[0], 6) if choices else group[0])
        return selected


def frame_points(start, end, count, scenes):
    # Uniform anchors preserve the tail even when all scene cuts occur early.
    anchors = max(2, (count + 1) // 2) if scenes else count
    last = max(start, end - min(0.5, (end - start) / 10))
    points = [start + (last - start) * i / max(1, anchors - 1) for i in range(anchors)]
    additional = [t for t in scenes if all(abs(t - point) >= 0.25 for point in points)]
    points += even_sample(additional, count - len(points)) if count > len(points) else []
    return sorted(set(round(p, 6) for p in points))


def extract_frames(video, points, end, directory, runner, crop=None):
    frames, hashes = [], {}
    # Crop the decoded source before scaling; never enlarge an already reduced frame.
    filters = ([f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}:exact=1"] if crop else [])
    filters += [f"scale=w='min({MAX_FRAME_EDGE},iw)':h='min({MAX_FRAME_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "showinfo"]
    for point in points:
        runner.check()
        target = directory / f"frame-{len(frames):03d}.jpg"
        _, stderr = runner.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "info", "-y",
                                "-ss", str(point), *LOCAL_INPUT, "-i", str(video), "-an",
                                "-frames:v", "1", "-vf", ",".join(filters),
                                "-fps_mode", "vfr", "-q:v", "3", str(target)], 30)
        stamps = TIMESTAMP.findall(stderr)
        sizes = FRAME_SIZE.findall(stderr)
        if not target.is_file():
            continue
        if not stamps or not math.isfinite(float(stamps[0])):
            raise WatchError("画面缺少实际解码时间戳，不能标记读取位置")
        if not sizes:
            raise WatchError("未取得实际画面尺寸")
        actual = round(point + float(stamps[0]), 6)
        if actual < point - 0.001 or actual >= end + 0.05:
            target.unlink()
            continue
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        observation = {"requested_seconds": point, "timestamp_seconds": actual}
        if digest in hashes:
            # Only byte-identical images are merged. Keep every observed timestamp.
            hashes[digest]["observations"].append(observation)
            target.unlink()
        else:
            item = {"index": len(frames), "file": target.name, "observations": [observation],
                    "width": int(sizes[0][0]), "height": int(sizes[0][1])}
            hashes[digest] = item
            frames.append(item)
    if not frames:
        raise WatchError("选定时间范围内没有提取到画面")
    return frames


def process(request, directory, root, runner, stage, settings):
    if request["source"].startswith(("import:", "watch:")):
        kind, identity = request["source"].split(":")
        folder = contained(root, "imports" if kind == "import" else "jobs", identity)
        if read_json(contained(folder, "source.json")).get("kind") == "browser":
            if kind == "watch":
                raise WatchError("浏览器任务补看需要原生 watch_start/watch_zoom 重新读取页面")
            from browser_media import process as browser_process
            return browser_process(request, directory, root, runner, stage, settings, folder)
    text_only = request.get("media_kind") == "transcribe" or request.get("detail") == "transcript" and not request.get("timestamps")
    video, manifest, captions, warnings = acquire(request["source"], directory, root, runner, stage, request.get("source_type", "auto"), text_only and request.get("media_kind") != "transcribe")
    try:
        meta = probe(video, runner) if video else None
    except Cancelled:
        raise
    except (WatchError, ValueError):
        if not captions["segments"]:
            raise
        meta = None
        warnings.append("媒体无法解码，已保留可用字幕")
    if meta is None:
        meta = {"duration_seconds": manifest.get("reported_duration_seconds") or max(s["end"] for s in captions["segments"]),
                "width": 0, "height": 0, "has_video": False, "has_audio": False}
    if video and not captions["segments"] and meta.get("subtitle_streams"):
        stage("读取内嵌字幕")
        captions = embedded_captions(video, meta, directory, runner, warnings)
        write_json(directory / "captions.json", captions)
    crop = request.get("crop")
    if crop and (crop["x"] + crop["width"] > meta["width"] or crop["y"] + crop["height"] > meta["height"]):
        raise WatchError(f"裁剪区域超出原视频 {meta['width']}×{meta['height']} 的范围；请按原视频像素指定区域")
    if meta["has_video"] and manifest.get("preferred_resolution") and min(meta["width"], meta["height"]) < manifest["preferred_resolution"]:
        warnings.append(f"本次取得 {meta['width']}×{meta['height']} 视频，低于优先选择的 {manifest['preferred_resolution']}p；小字可能不清晰")
    duration = meta["duration_seconds"]
    start = request["start_seconds"]
    end = min(duration, request.get("end_seconds") or start + MAX_WINDOW)
    if start >= end:
        raise WatchError("指定区间超出实际可读视频长度")
    reported = manifest.get("reported_duration_seconds")
    incomplete = bool(reported and duration + max(2, reported * 0.01) < reported)
    if incomplete:
        warnings.append("取得的文件短于平台标注时长，可能仅为预览；不能视为完整观看")
    if request.get("end_seconds") and request["end_seconds"] > duration + 0.1:
        warnings.append("请求终点超过实际文件长度，已按可读取范围截断")
    # The cross-plugin transcribe contract explicitly requests speech evidence.
    track_available = bool(captions["segments"]) and request.get("media_kind") != "transcribe"
    segments = [s for s in captions["segments"] if s["end"] > start and s["start"] < end] if track_available else []
    transcript_source = captions["source"] if track_available else "unavailable"
    transcript_state = "available" if segments else "no_speech" if track_available else "unavailable"
    language = captions.get("language")
    if request.get("media_kind") != "frames" and not track_available and meta["has_audio"] and request.get("audio") != "off" and asr.configured(settings):
        try:
            model = asr.prepare(root, settings, runner, stage)
            stage("转写音频")
            audio = directory / "audio.wav"
            runner.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(start), "-t", str(end - start),
                        *LOCAL_INPUT, "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", str(audio)], 60)
            data = asr.transcribe(audio, directory / "asr.json", model, settings, runner)
            segments = [{"start": round(start + s["start"], 6), "end": round(min(end, start + s["end"]), 6), "text": s["text"]}
                        for s in data["segments"] if s["start"] < end - start]
            transcript_source, language = "local_asr", data.get("language")
            transcript_state = "available" if segments else "no_speech"
        except Cancelled:
            raise
        except (WatchError, ValueError, KeyError, TypeError, OSError):
            transcript_state = "failed"
            warnings.append("本地转写准备或识别失败，可重试；已取得的其他资料仍可读取")
        finally:
            (directory / "audio.wav").unlink(missing_ok=True)
    elif not track_available:
        transcript_state = "disabled" if request.get("audio") == "off" or not asr.configured(settings) else "no_audio" if not meta["has_audio"] else "unavailable"
    if not segments and transcript_state != "no_speech":
        warnings.append("没有取得可用字幕或语音转写，不可根据画面推断具体口述内容")
    if request.get("audio") == "required" and transcript_state not in {"available", "no_speech"}:
        warnings.append("未满足本次要求的语音读取，请明确说明该部分不可用")
    frames, ranges, points = [], [], []
    selection = "explicit" if request.get("timestamps") else request["sampling"]
    if meta["has_video"] and not text_only:
        stage("提取画面")
        points = request.get("timestamps")
        if points is not None:
            if any(not start <= p < end for p in points):
                raise WatchError("补看时间戳必须位于实际读取区间内")
            ranges = storyboard.point_ranges(start, end, points)
        elif request["sampling"] == "balanced":
            try:
                scenes = scene_times(video, start, end, runner)
                ranges = storyboard.plan_ranges(start, end, request["frame_count"], scenes, segments)
                points = select_clear_points(video, ranges, directory, runner)
                selection = "adaptive_clear"
            except Cancelled:
                raise
            except (WatchError, ImportError, OSError, ValueError):
                warnings.append("自动选帧不可用，已改用覆盖整个区间的定时采样")
                selection = "uniform_fallback"
        if points is None:
            points = frame_points(start, end, request["frame_count"], [])
            ranges = storyboard.point_ranges(start, end, points)
        try:
            frames = extract_frames(video, points, end, directory, runner, crop)
        except Cancelled:
            raise
        except WatchError:
            warnings.append("画面提取失败，已保留取得的字幕或转写")
    board = {"available": False, "reason": "仅读取文字" if text_only else "来源没有视频画面" if not meta["has_video"] else "没有取得分镜画面"}
    if frames and not request.get("media_kind"):
        stage("整理分镜")
        try:
            board = storyboard.render(directory, ranges, points, frames, segments, meta, crop, runner)
            if board.get("missing_cells"):
                warnings.append("部分分镜区间没有取得画面，缺口记录在 storyboard.missing_cells；可按时间缩小范围补看")
        except Cancelled:
            raise
        except (ImportError, OSError, ValueError):
            board = {"available": False, "reason": "分镜拼图不可用，可继续使用 watch_frames 和 watch_transcript"}
            warnings.append(board["reason"])
    observations = sorted({o["timestamp_seconds"] for frame in frames for o in frame["observations"]})
    bounds = [start, *observations, end]
    write_json(directory / "transcript.json", {"source": transcript_source, "state": transcript_state, "language": language, "segments": segments})
    result = {"title": manifest["title"], "source": manifest.get("url", request["source"]),
              "media": meta, "reported_duration_seconds": reported,
              "range": {"start_seconds": start, "end_seconds": end},
              "coverage": {"mode": "sampled_frames", "observed_timestamps": observations,
                           "max_gap_seconds": round(max(b - a for a, b in zip(bounds, bounds[1:])), 3),
                           "more_video_after_range": end + 0.1 < duration,
                           "source_incomplete": incomplete},
              "frames": frames, "frame_count": len(frames),
              "sampling": selection, "storyboard": board,
              "frame_view": {"crop": crop, "width": frames[0]["width"], "height": frames[0]["height"]} if frames else None,
              "transcript": {"source": transcript_source, "state": transcript_state, "language": language, "segment_count": len(segments)},
              "warnings": warnings}
    if request.get("focus_cell"):
        result["focus_cell"] = request["focus_cell"]
    write_json(directory / "result.json", result)
    return result
