"""Persistent bounded queue. Job/import IDs are private bearer capabilities."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
import re
from pathlib import Path
import shutil
import threading
import time
import uuid

from common import (Cancelled, MAX_FRAME_EDGE, MAX_MEDIA, MAX_STORAGE, MAX_WINDOW, PREFERRED_RESOLUTION, VERSION, Runner, WatchError,
                    canonical_source, contained, dependencies, integer, number,
                    read_json, token, tree_size, write_json)
import media

TTL = 24 * 60 * 60
TERMINAL = {"ready", "failed", "cancelled", "interrupted"}


def validate_request(args):
    allowed = {"source", "source_type", "start_seconds", "end_seconds", "frame_count", "sampling", "timestamps", "crop", "request_id", "media_kind", "media_scope", "media_origin", "focus_cell"}
    if not isinstance(args, dict) or set(args) - allowed or "source" not in args:
        raise WatchError("watch_start 参数无效")
    result = {"source": canonical_source(args["source"]),
              "start_seconds": number(args.get("start_seconds", 0), "start_seconds"),
              "frame_count": integer(args.get("frame_count", 12), "frame_count", 2, 24),
              "sampling": args.get("sampling", "balanced")}
    if result["sampling"] not in {"balanced", "uniform"}:
        raise WatchError("sampling 必须是 balanced 或 uniform")
    if "source_type" in args:
        if args["source_type"] not in {"auto", "direct", "page"}:
            raise WatchError("source_type 必须是 auto、direct 或 page")
        result["source_type"] = args["source_type"]
    if "crop" in args:
        crop = args["crop"]
        if not isinstance(crop, dict) or set(crop) != {"x", "y", "width", "height"}:
            raise WatchError("crop 需包含原视频像素坐标 x、y、width、height")
        result["crop"] = {key: integer(crop[key], "crop." + key, 0 if key in {"x", "y"} else 2, 16384) for key in ("x", "y", "width", "height")}
    start = result["start_seconds"]
    if "end_seconds" in args:
        end = number(args["end_seconds"], "end_seconds")
        if not 0 < end - start <= MAX_WINDOW:
            raise WatchError("每次读取区间需大于 0 且不超过 600 秒")
        result["end_seconds"] = end
    if "timestamps" in args:
        points = args["timestamps"]
        if not isinstance(points, list) or not 1 <= len(points) <= 24:
            raise WatchError("补看时间戳需为 1 到 24 项")
        end = result.get("end_seconds", start + MAX_WINDOW)
        points = sorted(set(number(p, "timestamps") for p in points))
        if any(not start <= point < end for point in points):
            raise WatchError("补看时间戳必须位于读取区间内")
        result["timestamps"] = points
    if "request_id" in args:
        try:
            value = args["request_id"]
            if not isinstance(value, str) or len(value) not in {32, 36}:
                raise ValueError()
            result["request_id"] = uuid.UUID(value).hex
        except (ValueError, AttributeError):
            raise WatchError("request_id 必须是新生成的 UUID；重试同一请求时复用") from None
    if "media_kind" in args:
        if args["media_kind"] == "transcribe" and "crop" in result:
            raise WatchError("语音转写不使用裁剪区域")
        if args["media_kind"] not in {"transcribe", "frames"} or not isinstance(args.get("media_scope"), str) or not re.fullmatch(r"[a-f0-9]{64}", args["media_scope"]):
            raise WatchError("媒体桥接范围无效")
        result.update(media_kind=args["media_kind"], media_scope=args["media_scope"], media_origin=canonical_source(args.get("media_origin")))
    elif "media_scope" in args or "media_origin" in args:
        raise WatchError("媒体桥接参数缺失")
    if "focus_cell" in args:
        focus = args["focus_cell"]
        if not isinstance(focus, dict) or set(focus) != {"job_id", "cell_id"} or "media_kind" in result:
            raise WatchError("分镜来源无效")
        result["focus_cell"] = {"job_id": token(focus["job_id"]), "cell_id": integer(focus["cell_id"], "cell_id", 1, 24)}
    return result


class Jobs:
    def __init__(self, root, processor=media.process):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        contained(self.root, "jobs").mkdir(exist_ok=True)
        contained(self.root, "imports").mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.events, self.records, self.closed = {}, {}, False
        self.processor = processor
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="watch")
        self.settings = {}
        settings = contained(self.root, "settings.json")
        if settings.is_file():
            value = read_json(settings)
            model = value.get("asr_model_path")
            if model and isinstance(model, str):
                self.settings["asr_model_path"] = str(Path(model).expanduser().resolve())
        for path in (self.root / "jobs").iterdir():
            if not path.is_dir():
                continue
            try:
                job_id = token(path.name)
                record = read_json(contained(self.root, "jobs", job_id, "job.json"))
                if record["job_id"] != job_id:
                    continue
                if record["status"] not in TERMINAL:
                    record.update(status="interrupted", stage="服务重启，读取已中断", finished_at=time.time())
                    write_json(path / "job.json", record)
                    for child in path.iterdir():
                        if child.is_file() and not child.is_symlink() and child.name != "job.json":
                            child.unlink(missing_ok=True)
                self.records[job_id] = record
            except (WatchError, OSError, ValueError, KeyError, TypeError):
                continue
        self.prune()

    def directory(self, job_id):
        return contained(self.root, "jobs", token(job_id))

    def prune(self):
        with self.lock:
            from ingest import prune as prune_uploads
            prune_uploads(self.root)
            # Reuse may be copying a cached file. Wait for the queue to drain.
            if any(r["status"] not in TERMINAL for r in self.records.values()):
                return
            now = time.time()
            for job_id, record in list(self.records.items()):
                if now - record.get("finished_at", now) > TTL:
                    folder = self.directory(job_id)
                    shutil.rmtree(folder)
                    del self.records[job_id]
                    self.events.pop(job_id, None)
            for path in (self.root / "imports").iterdir():
                if path.is_dir() and not path.is_symlink() and not getattr(path, "is_junction", lambda: False)():
                    try:
                        path = contained(self.root, "imports", token(path.name))
                        if now - (path / "source.json").stat().st_mtime > TTL:
                            shutil.rmtree(path)
                    except (WatchError, FileNotFoundError):
                        continue

    def info(self):
        model = self.settings.get("asr_model_path")
        return {"version": VERSION, "dependencies": dependencies(),
                "storyboard": {"available": importlib.util.find_spec("PIL") is not None, "cells_per_sheet": 12, "max_sheets": 2},
                "preview": {"available": importlib.util.find_spec("PIL") is not None, "sources": ["Bilibili"], "max_frames": 3},
                "download_runtime": {"python_package": importlib.util.find_spec("yt_dlp") is not None,
                                     "youtube_ejs": importlib.util.find_spec("yt_dlp_ejs") is not None,
                                     "deno": bool(shutil.which("deno"))},
                "asr": {"configured": bool(model), "model_available": bool(model and all((Path(model) / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json"))),
                        "runtime_available": importlib.util.find_spec("faster_whisper") is not None},
                "cookies_configured": contained(self.root, "cookies.txt").is_file(),
                "sources": ["HTTP/HTTPS direct media", "yt-dlp supported video pages", "chat attachments via native watch_start", "configured local video roots", "import:<token>", "watch:<job_id>"],
                "limits": {"window_seconds": MAX_WINDOW, "frames_per_job": 24, "images_per_call": 4,
                           "preferred_resolution": PREFERRED_RESOLUTION, "frame_max_edge": MAX_FRAME_EDGE,
                           "media_bytes": MAX_MEDIA, "storage_bytes": MAX_STORAGE, "retention_hours": 24},
                "note": "任务标识是读取凭证，只在原任务中使用；工具不列出其他任务或本地文件。"}

    def _record(self, job_id):
        record = self.records.get(token(job_id))
        if record is None:
            raise WatchError("任务不存在或已过期")
        return record

    def _save(self, record):
        write_json(self.directory(record["job_id"]) / "job.json", record)

    def status(self, job_id):
        with self.lock:
            record = self._record(job_id)
            public = {k: copy.deepcopy(v) for k, v in record.items() if k != "request"}
            if record["status"] == "ready":
                result = read_json(self.directory(job_id) / "result.json")
                public["result"] = {k: v for k, v in result.items() if k != "frames"}
                public["reuse_source"] = "watch:" + job_id
            elif record["status"] not in TERMINAL:
                public["retry_after_seconds"] = 5
            return public

    def start(self, args):
        request = validate_request(args)
        with self.lock:
            if self.closed:
                raise WatchError("服务正在关闭")
            self.prune()
            if request.get("request_id"):
                for job_id, record in self.records.items():
                    if record["request"].get("request_id") == request["request_id"]:
                        if record["request"] != request:
                            raise WatchError("同一 request_id 不能提交不同参数")
                        return self.status(job_id)
            if sum(r["status"] not in TERMINAL for r in self.records.values()) >= 4:
                raise WatchError("读取队列已满，请稍后再试")
            if len(self.records) >= 64 or tree_size(self.root) + MAX_MEDIA > MAX_STORAGE:
                raise WatchError("读取缓存已满；等待过期清理，或由主人清理插件数据")
            source = request["source"]
            if source.startswith("watch:") and self._record(source[6:])["status"] != "ready":
                raise WatchError("只能复用已经就绪的读取任务")
            if source.startswith("import:"):
                if not contained(self.root, "imports", source[7:], "source.json").is_file():
                    raise WatchError("导入标识不存在或已过期")
            from sources import remote_source
            needs_downloader = remote_source(source) and not media.direct_source(source, request.get("source_type", "auto"))
            missing = [name for name, ready in dependencies().items() if not ready and (name != "yt-dlp" or needs_downloader)]
            if needs_downloader and not importlib.util.find_spec("yt_dlp") and "yt-dlp" not in missing:
                missing.append("当前 Python 环境的 yt-dlp（requirements-media.txt）")
            if missing:
                raise WatchError("缺少运行依赖：" + "、".join(missing))
            job_id = uuid.uuid4().hex
            folder = self.directory(job_id)
            folder.mkdir()
            record = {"job_id": job_id, "status": "queued", "stage": "等待读取", "created_at": time.time(), "request": request}
            self.records[job_id] = record
            self.events[job_id] = threading.Event()
            self._save(record)
            self.executor.submit(self._run, job_id)
            return self.status(job_id)

    def _run(self, job_id):
        with self.lock:
            record = self.records[job_id]
            if record["status"] in TERMINAL:
                return
            record.update(status="running", stage="开始读取")
            self._save(record)
        runner = Runner(self.directory(job_id), self.root, self.events[job_id])
        def stage(value):
            runner.check()
            with self.lock:
                record["stage"] = value
                self._save(record)
        try:
            self.processor(record["request"], self.directory(job_id), self.root, runner, stage, self.settings)
            runner.check()
            with self.lock:
                # Serialize completion with cancellation to avoid a late success.
                runner.check()
                record.update(status="ready", stage="读取完成", finished_at=time.time())
                self._save(record)
        except BaseException as exc:
            with self.lock:
                record.update(status="cancelled" if isinstance(exc, Cancelled) else "failed", finished_at=time.time(),
                              stage=str(exc) if isinstance(exc, WatchError) else "读取失败，请检查视频来源、格式与运行依赖")
                self._save(record)
            # Failed downloads and cancelled processing must not fill the cache.
            for child in self.directory(job_id).iterdir():
                if child.is_file() and child.name != "job.json":
                    child.unlink(missing_ok=True)

    def cancel(self, job_id):
        with self.lock:
            record = self._record(job_id)
            if record["status"] not in TERMINAL:
                self.events[job_id].set()
                if record["status"] == "queued":
                    record.update(status="cancelled", stage="读取已取消", finished_at=time.time())
                else:
                    record.update(status="cancelling", stage="正在停止读取")
                self._save(record)
            return self.status(job_id)

    def ready(self, job_id):
        if self._record(job_id)["status"] != "ready":
            raise WatchError("任务尚未就绪；先查询 watch_status")
        return self.directory(job_id)

    def frames(self, job_id, offset=0, limit=4):
        integer(offset, "offset", 0, 1000)
        integer(limit, "limit", 1, 4)
        with self.lock:
            folder = self.ready(job_id)
            result = read_json(folder / "result.json")
            frames = result["frames"][offset:offset + limit]
            content = []
            for frame in frames:
                path = contained(folder, frame["file"])
                if path.stat().st_size > 1500000:
                    raise WatchError("单张画面过大")
                metadata = {"frame_index": frame["index"], "observations": frame["observations"]}
                if result.get("frame_view"):
                    metadata["view"] = {**result["frame_view"], "source_width": result["media"]["width"], "source_height": result["media"]["height"]}
                content += [{"type": "text", "text": json.dumps(metadata, ensure_ascii=False)},
                            {"type": "image", "mimeType": "image/jpeg", "data": base64.b64encode(path.read_bytes()).decode("ascii")}]
            next_offset = offset + len(frames)
            return {"job_id": job_id, "total": len(result["frames"]), "offset": offset,
                    "next_offset": next_offset if next_offset < len(result["frames"]) else None}, content

    def _storyboard(self, job_id):
        folder = self.ready(job_id)
        path = contained(folder, "storyboard.json")
        if not path.is_file():
            raise WatchError("本任务没有分镜；可读取 watch_frames，或复用 watch:<job_id> 开始新的读取")
        return folder, read_json(path)

    def storyboard(self, job_id, page=0):
        integer(page, "page", 0, 1)
        with self.lock:
            folder, board = self._storyboard(job_id)
            if page >= len(board["sheets"]):
                raise WatchError("分镜页码不存在")
            sheet = board["sheets"][page]
            path = contained(folder, sheet["file"])
            if path.stat().st_size > 1_500_000:
                raise WatchError("分镜图片过大")
            result = read_json(folder / "result.json")
            value = {"job_id": job_id, "page": page, "total_pages": len(board["sheets"]),
                     "next_page": page + 1 if page + 1 < len(board["sheets"]) else None,
                     "width": sheet["width"], "height": sheet["height"], "cells": sheet["cells"],
                     "source_view": board["source_view"], "range": result["range"],
                     "coverage": result["coverage"], "transcript_source": result["transcript"]["source"],
                     "missing_cells": result.get("storyboard", {}).get("missing_cells", []),
                     "warnings": result["warnings"],
                     "note": "每格是区间中的一个采样瞬间；区间字幕不等于画面发生时刻。小字或动作细节用 watch_zoom 补看；字幕截断时用 watch_transcript。"}
            return value, [{"type": "image", "mimeType": "image/jpeg", "data": base64.b64encode(path.read_bytes()).decode("ascii")}]

    def zoom(self, job_id, cell_id, frame_count=6, crop=None, request_id=None):
        integer(cell_id, "cell_id", 1, 24)
        with self.lock:
            _, board = self._storyboard(job_id)
            cell = next((cell for sheet in board["sheets"] for cell in sheet["cells"] if cell["cell_id"] == cell_id), None)
            if cell is None:
                raise WatchError("该任务中不存在这个分镜编号")
            args = {"source": "watch:" + job_id, **cell["range"], "frame_count": frame_count,
                    "focus_cell": {"job_id": job_id, "cell_id": cell_id}}
            if crop is not None:
                args["crop"] = crop
            if request_id is not None:
                args["request_id"] = request_id
            return self.start(args)

    def transcript(self, job_id, offset=0, limit=40):
        integer(offset, "offset", 0, 30000)
        integer(limit, "limit", 1, 80)
        with self.lock:
            data = read_json(self.ready(job_id) / "transcript.json")
            segments, chars = [], 0
            for segment in data["segments"][offset:offset + limit]:
                size = len(json.dumps(segment, ensure_ascii=False))
                if segments and chars + size > 12000:
                    break
                segments.append(segment)
                chars += size
            end = offset + len(segments)
            return {"job_id": job_id, "source": data["source"], "language": data.get("language"),
                    "total": len(data["segments"]), "offset": offset, "segments": segments,
                    "next_offset": end if end < len(data["segments"]) else None}

    def close(self):
        with self.lock:
            self.closed = True
            for event in self.events.values():
                event.set()
        self.executor.shutdown(wait=True, cancel_futures=False)


def import_video(root, file, subtitles=None):
    root, source = Path(root).resolve(), Path(file).resolve(strict=True)
    if source.suffix.lower() not in media.MEDIA_EXTENSIONS or not 0 < source.stat().st_size <= MAX_MEDIA:
        raise WatchError("请导入不超过 256 MiB 的常见视频文件")
    if tree_size(root) + source.stat().st_size > MAX_STORAGE:
        raise WatchError("导入后缓存将超过 2 GiB")
    identity = uuid.uuid4().hex
    directory = contained(root, "imports", identity)
    directory.mkdir(parents=True)
    try:
        target = directory / ("media" + source.suffix.lower())
        shutil.copyfile(source, target)
        # Local access is authorized by the CLI owner or by the scoped ingest entry.
        captions = {"segments": media.parse_captions(subtitles), "source": "imported_subtitles"} if subtitles else {"segments": [], "source": "unavailable"}
        write_json(directory / "captions.json", captions)
        write_json(directory / "source.json", {"file": target.name, "title": source.stem[:300]})
        return {"source": "import:" + identity, "retention_hours": 24}
    except BaseException:
        shutil.rmtree(contained(root, "imports", identity))
        raise
