"""Watch-owned browser evidence, planning, transcription, and storyboard output."""
from __future__ import annotations
from pathlib import Path
import re
import shutil
import sys
import uuid
from common import Cancelled, MAX_STORAGE, WatchError, canonical_source, contained, integer, number, read_json, token, tree_size, write_json
import storyboard
import asr


def plan(request, duration):
    from jobs import validate_request
    from media import frame_points
    request = validate_request(request)
    duration = number(duration, "duration", 0, 7200)
    start = request["start_seconds"]
    end = min(duration, request.get("end_seconds", start + 60), start + 60)
    if end <= start:
        raise WatchError("指定区间超出在线播放器长度")
    warnings = []
    if request.get("end_seconds", end) > end:
        warnings.append("在线读取每次最多60秒；本次已截取范围，后续可按原视频时间继续读取")
    points = request.get("timestamps") or frame_points(start, end, request["frame_count"], [])
    if any(not start <= point < end for point in points):
        raise WatchError("补看时间须位于本次在线读取的60秒范围内")
    return {"request": request, "start": start, "end": end, "points": points, "warnings": warnings}


def source(jobs, args):
    folder = jobs.ready(args.get("job_id"))
    file = contained(folder, "browser.json")
    if not file.is_file():
        return {"browser": False}
    data = read_json(file)
    if data["namespace"] != args["namespace"]:
        raise WatchError("浏览器资料不属于当前会话")
    result = {"browser": True, "source": data["url"], "tab_id": data["tab_id"], "media_id": data["media_id"],
              "start_seconds": data["range"]["start_seconds"], "end_seconds": data["range"]["end_seconds"]}
    if "cell_id" in args:
        _, board = jobs._storyboard(args["job_id"])
        cell = next((c for sheet in board["sheets"] for c in sheet["cells"] if c["cell_id"] == args["cell_id"]), None)
        if not cell:
            raise WatchError("没有这个分镜编号")
        result.update(cell["range"])
    return result


def imported_asset(jobs, identity, namespace, kind):
    folder = contained(jobs.root, "uploads", token(identity))
    record = read_json(contained(folder, "upload.json"))
    if record.get("namespace") != namespace or record.get("kind") != kind or not record.get("result"):
        raise WatchError("页面媒体尚未完整传入或不属于当前会话")
    return contained(folder, "media" + Path(record["name"]).suffix.lower())


def finish(jobs, args):
    from PIL import Image
    info = args.get("info")
    if not isinstance(info, dict):
        raise WatchError("浏览器资料缺失")
    planned = plan(args.get("request"), info.get("duration"))
    namespace = args["namespace"]
    frames, audio, captions = info.get("frames", []), info.get("audio", []), info.get("captions", {})
    if not isinstance(frames, list) or not 0 <= len(frames) <= 24 or not isinstance(audio, list) or len(audio) > 4:
        raise WatchError("页面媒体数量无效")
    if not isinstance(captions, dict) or not isinstance(captions.get("segments", []), list) or len(captions.get("segments", [])) > 200:
        raise WatchError("页面字幕无效")
    segments, text_size = [], 0
    for row in captions.get("segments", []):
        start, end = number(row.get("start"), "caption.start"), number(row.get("end"), "caption.end")
        text = row.get("text")
        if not isinstance(text, str) or len(text) > 2000 or end <= start or end <= planned["start"] or start >= planned["end"]:
            raise WatchError("页面字幕时间或内容无效")
        text_size += len(text)
        if text_size > 12000:
            raise WatchError("页面字幕过长")
        segments.append({"start": start, "end": end, "text": text})
    if tree_size(jobs.root) > MAX_STORAGE - 64 * 1024 * 1024:
        raise WatchError("视频缓存空间不足")
    request_id = planned["request"].get("request_id")
    identity = uuid.uuid5(uuid.NAMESPACE_URL, namespace + ":browser:" + request_id).hex if request_id else uuid.uuid4().hex
    folder = contained(jobs.root, "imports", identity)
    if folder.exists():
        previous = read_json(folder / "browser.json")
        if previous.get("request") != planned["request"] or previous.get("namespace") != namespace:
            raise WatchError("同一请求不能用于不同浏览器参数")
        return jobs.start({**planned["request"], "source": "import:" + identity, **previous["range"]})
    folder.mkdir()
    try:
        items = []
        for i, row in enumerate(frames):
            requested = number(row.get("requested"), "requested")
            actual = number(row.get("timestamp"), "timestamp")
            if not any(abs(requested - p) < 0.0001 for p in planned["points"]) or not planned["start"] - 0.1 <= actual < planned["end"]:
                raise WatchError("画面时间不属于所选范围")
            original = imported_asset(jobs, row.get("asset_id"), namespace, "image")
            with Image.open(original) as image:
                if image.format not in {"JPEG", "PNG"} or image.width * image.height > 16_000_000:
                    raise WatchError("页面图片格式或尺寸无效")
                image.verify()
            target = f"browser-frame-{i:03d}.jpg"
            with Image.open(original) as image:
                if image.format == "JPEG":
                    shutil.copyfile(original, folder / target)
                else:
                    image.convert("RGB").save(folder / target, format="JPEG", quality=90)
                items.append({"file": target, "width": image.width, "height": image.height,
                              "requested": requested, "timestamp": actual, "view": row.get("view", "element")})
        sounds = []
        for i, row in enumerate(audio):
            start, end = number(row.get("start"), "audio.start"), number(row.get("end"), "audio.end")
            lead = number(row.get("leadSeconds", 0), "audio.lead", 0, 1)
            if start < planned["start"] - 0.2 or end > planned["end"] + 0.75 or not 0 < end - start <= 21:
                raise WatchError("音频时间不属于所选范围")
            original = imported_asset(jobs, row.get("asset_id"), namespace, "audio")
            name = f"browser-audio-{i:03d}" + original.suffix
            shutil.copyfile(original, folder / name)
            sounds.append({"file": name, "start": start, "end": end, "lead": lead})
        for field in ("tab_id", "media_id"):
            if not isinstance(info.get(field), str) or not 0 < len(info[field]) <= 100:
                raise WatchError("播放器编号无效")
        data = {"namespace": namespace, "request": planned["request"], "url": canonical_source(planned["request"]["source"]),
                "title": str(info.get("title", "在线视频"))[:200], "duration": info["duration"],
                "tab_id": info["tab_id"], "media_id": info["media_id"], "kind": "audio" if info.get("kind") == "audio" else "video", "frames": items, "audio": sounds,
                "captions": {"segments": segments, "track_available": bool(segments or captions.get("track_available")),
                             "language": str(captions.get("language") or "")[:32], "truncated": bool(captions.get("truncated"))},
                "range": {"start_seconds": planned["start"], "end_seconds": planned["end"]},
                "points": planned["points"], "warnings": planned["warnings"] + [str(x)[:300] for x in info.get("warnings", [])[:16]]}
        write_json(folder / "browser.json", data)
        write_json(folder / "source.json", {"kind": "browser", "title": data["title"], "url": data["url"]})
        request = {**planned["request"], "source": "import:" + identity, **data["range"]}
        return jobs.start(request)
    except BaseException:
        shutil.rmtree(folder)
        raise


def dispatch(jobs, args):
    if not isinstance(args.get("namespace"), str) or not re.fullmatch(r"[a-f0-9]{64}", args["namespace"]):
        raise WatchError("浏览器读取缺少会话范围")
    action = args.get("action")
    if action == "plan":
        return plan(args.get("request"), args.get("duration"))
    with jobs.lock:
        if action == "source":
            return source(jobs, args)
        if action == "finish":
            return finish(jobs, args)
    raise WatchError("未知浏览器读取操作")


def process(request, directory, root, runner, stage, settings, source_folder):
    from PIL import Image
    data = read_json(source_folder / "browser.json")
    warnings = list(data["warnings"])
    crop, frames = request.get("crop"), []
    start, end = data["range"]["start_seconds"], data["range"]["end_seconds"]
    for row in data["frames"]:
        runner.check()
        with Image.open(contained(source_folder, row["file"])) as image:
            width, height = image.size
            if crop:
                if crop["x"] + crop["width"] > width or crop["y"] + crop["height"] > height:
                    raise WatchError("裁剪区域超出浏览器返回画面的尺寸")
                image = image.crop((crop["x"], crop["y"], crop["x"] + crop["width"], crop["y"] + crop["height"]))
            filename = f"frame-{len(frames):03d}.jpg"
            if crop:
                image.save(directory / filename, format="JPEG", quality=90)
            else:
                shutil.copyfile(contained(source_folder, row["file"]), directory / filename)
            frames.append({"index": len(frames), "file": filename, "width": image.width, "height": image.height,
                           "observations": [{"requested_seconds": row["requested"], "timestamp_seconds": row["timestamp"]}]})
    segments = list(data["captions"]["segments"])
    language = data["captions"].get("language")
    track_available = bool(segments or data["captions"].get("track_available"))
    transcript_source = "browser_text_track" if track_available else "unavailable"
    transcript_state = "available" if segments else "no_speech" if track_available else "unavailable"
    audio_ranges = []
    model = None
    if not track_available and data["audio"] and asr.configured(settings) and request.get("audio") != "off":
        try:
            model = asr.prepare(root, settings, runner, stage)
        except Cancelled:
            raise
        except (WatchError, ValueError, OSError):
            transcript_state = "failed"
            warnings.append("本地转写初始化未完成，可重试继续准备；画面仍可读取")
    if model:
        stage("转写页面音频")
        for row in data["audio"]:
            runner.check()
            try:
                wav, result = directory / "audio.wav", directory / "asr.json"
                runner.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", str(row["lead"]),
                            "-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,ogg,wav",
                            "-i", str(contained(source_folder, row["file"])), "-t", str(row["end"] - row["start"]),
                            "-vn", "-ac", "1", "-ar", "16000", str(wav)], 60)
                transcript = asr.transcribe(wav, result, model, settings, runner)
                for segment in transcript["segments"]:
                    a, b = max(start, row["start"] + segment["start"]), min(end, row["start"] + segment["end"])
                    if b > a:
                        segments.append({"start": round(a, 6), "end": round(b, 6), "text": segment["text"]})
                audio_ranges.append({"start": row["start"], "end": row["end"]})
                transcript_source, language = "browser_audio_asr", transcript.get("language")
            except Cancelled:
                raise
            except (WatchError, ValueError, KeyError, TypeError, OSError):
                warnings.append("部分页面音频转写失败，其时间范围不能当作已听到")
            finally:
                (directory / "audio.wav").unlink(missing_ok=True)
        transcript_state = "failed" if not audio_ranges else "partial" if len(audio_ranges) < len(data["audio"]) else "available" if segments else "no_speech"
    if not track_available and not model and transcript_state != "failed":
        transcript_state = "disabled" if not asr.configured(settings) or request.get("audio") == "off" else "unavailable"
    if not segments and transcript_state != "no_speech":
        warnings.append("没有取得可用字幕或语音转写，请只依据已看到的画面")
    if data["captions"].get("truncated"):
        warnings.append("页面字幕已截断，需缩小范围继续读取")
    if any(row["view"] == "page" for row in data["frames"]):
        warnings.append("嵌入播放器的图片为所在页面的可见区域，可能包含页面其他内容")
    meta = {"duration_seconds": data["duration"], "width": data["frames"][0]["width"] if data["frames"] else 0,
            "height": data["frames"][0]["height"] if data["frames"] else 0, "has_video": data.get("kind") != "audio", "has_audio": bool(data["audio"])}
    ranges = storyboard.point_ranges(start, end, data["points"])
    board = storyboard.render(directory, ranges, data["points"], frames, segments, meta, crop, runner) if frames else {"available": False, "reason": "本次没有画面"}
    observed = sorted({o["timestamp_seconds"] for f in frames for o in f["observations"]})
    bounds = sorted([start, *observed, end])
    result = {"title": data["title"], "source": data["url"], "mode": "browser", "media": meta, "range": data["range"],
              "coverage": {"mode": "sampled_browser_frames", "observed_timestamps": observed,
                           "max_gap_seconds": round(max(b-a for a,b in zip(bounds,bounds[1:])), 3), "more_video_after_range": end < data["duration"] - 0.1,
                           "source_incomplete": False, "audio_ranges": audio_ranges},
              "frames": frames, "frame_count": len(frames), "storyboard": board, "sampling": "browser_uniform" if not request.get("timestamps") else "explicit",
              "frame_view": {"crop": crop, "width": frames[0]["width"], "height": frames[0]["height"], "coordinate_space": "browser_capture"} if frames else None,
              "transcript": {"source": transcript_source, "state": transcript_state, "language": language, "segment_count": len(segments)}, "warnings": warnings}
    write_json(directory / "transcript.json", {"source": transcript_source, "state": transcript_state, "language": language, "segments": sorted(segments, key=lambda s:s["start"])})
    write_json(directory / "browser.json", data)
    write_json(directory / "source.json", {"kind": "browser", "url": data["url"], "title": data["title"]})
    write_json(directory / "result.json", result)
    return result
