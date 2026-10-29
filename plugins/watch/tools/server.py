"""Dependency-free MCP stdio service for the Watch plugin."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import sys

from common import VERSION, WatchError, contained
from jobs import Jobs, import_video


def schema(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


JOB = {"type": "string", "pattern": "^[a-f0-9]{32}$", "description": "本任务返回的 job_id；作为读取凭证保留在原会话中"}
OFFSET = {"type": "integer", "minimum": 0, "maximum": 30000, "default": 0}
TIME = {"type": "number", "minimum": 0, "maximum": 7200}
TOOLS = [
    {"name": "watch_preview", "description": "轻量查看B站指定分P的平台预览图，最多三张，返回实际时间戳；不下载视频、不读取语音。细节不足时再用 watch_start 补看。",
     "inputSchema": schema({"url": {"type": "string", "maxLength": 2048},
                            "start": {"type": "number", "minimum": 0, "maximum": 43200},
                            "end": {"type": "number", "minimum": 0, "maximum": 43200}}, ["url", "start", "end"])},
    {"name": "watch_media", "description": "为其他插件提供异步语音转写或抽样画面，返回原视频时间戳；相同请求沿用 request_id，续查携带 job_id。普通视频问答使用 watch_start。",
     "inputSchema": schema({"kind": {"type": "string", "enum": ["transcribe", "frames"]},
                            "url": {"type": "string", "maxLength": 2048}, "start": TIME, "end": TIME,
                            "namespace": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                            "request_id": {"type": "string", "maxLength": 160}, "job_id": JOB},
                           ["kind", "url", "start", "end", "namespace", "request_id"])},
    {"name": "watch_info", "description": "检查 Watch 视频读取依赖、可用来源与限制。不会列出本地文件或其他读取任务。", "inputSchema": schema()},
    {"name": "watch_start", "description": "开始读取视频画面和字幕，返回 job_id。每段最多 600 秒；完成后先用 watch_storyboard 查看分镜概览。复用 watch:<job_id> 可从已下载文件继续补看。",
     "inputSchema": schema({
         "source": {"type": "string", "maxLength": 2048, "description": "HTTPS B站/YouTube链接、import:<token>，或本任务的 watch:<job_id>"},
         "start_seconds": {**TIME, "default": 0}, "end_seconds": TIME,
         "frame_count": {"type": "integer", "minimum": 2, "maximum": 24, "default": 12},
         "sampling": {"type": "string", "enum": ["balanced", "uniform"], "default": "balanced"},
         "timestamps": {"type": "array", "items": TIME, "minItems": 1, "maxItems": 24, "description": "补看指定的原视频秒数；提供后替代自动选帧"},
         "crop": {**schema({key: {"type": "integer", "minimum": 0 if key in {"x", "y"} else 2, "maximum": 16384}
                             for key in ("x", "y", "width", "height")}, ["x", "y", "width", "height"]),
                  "description": "可选。仅在整帧细节看不清时使用；x/y/width/height 按 watch_status 的原视频 media.width/height 像素计算，不能直接使用缩小后图片的坐标。不填返回完整画面。"},
         "request_id": {"type": "string", "description": "可选的新 UUID；仅在重试相同请求时复用，防止重复下载"}
     }, ["source"])},
    {"name": "watch_status", "description": "查询视频读取状态、实际处理区间、画面覆盖和字幕来源。ready 只表示资料已准备，模型仍需读取画面和字幕。", "inputSchema": schema({"job_id": JOB}, ["job_id"])},
    {"name": "watch_storyboard", "description": "查看编号分镜图及各格对应的原视频时间、字幕节选。每页最多12格；next_page非空时还有下一页。细节用watch_zoom，完整字幕用watch_transcript。",
     "inputSchema": schema({"job_id": JOB, "page": {"type": "integer", "minimum": 0, "maximum": 1, "default": 0}}, ["job_id"])},
    {"name": "watch_zoom", "description": "按指定任务的分镜编号，从缓存原视频加密补看该区间，返回新的job_id。可选crop使用原视频像素；不填则返回整帧。完成后用watch_frames读取高清画面。",
     "inputSchema": schema({"job_id": JOB, "cell_id": {"type": "integer", "minimum": 1, "maximum": 24},
                            "frame_count": {"type": "integer", "minimum": 2, "maximum": 24, "default": 6},
                            "crop": schema({key: {"type": "integer", "minimum": 0 if key in {"x", "y"} else 2, "maximum": 16384}
                                            for key in ("x", "y", "width", "height")}, ["x", "y", "width", "height"]),
                            "request_id": {"type": "string", "description": "新UUID；仅重试同一补看请求时复用"}}, ["job_id", "cell_id"])},
    {"name": "watch_frames", "description": "分页查看实际视频画面，每页最多四张；附时间戳、图片尺寸和可选裁剪区域。按 next_offset 继续，不能将未读取的页视作已看过。",
     "inputSchema": schema({"job_id": JOB, "offset": {**OFFSET, "maximum": 1000}, "limit": {"type": "integer", "minimum": 1, "maximum": 4, "default": 4}}, ["job_id"])},
    {"name": "watch_transcript", "description": "分页读取字幕或语音转写，保留原视频时间戳及来源。next_offset 非空时仍有未读内容。",
     "inputSchema": schema({"job_id": JOB, "offset": OFFSET, "limit": {"type": "integer", "minimum": 1, "maximum": 80, "default": 40}}, ["job_id"])},
    {"name": "watch_cancel", "description": "取消本任务的视频读取并停止其处理进程；已完成结果保留至过期。", "inputSchema": schema({"job_id": JOB}, ["job_id"])}
]
for tool in TOOLS:
    read_only = tool["name"] not in {"watch_start", "watch_zoom", "watch_cancel", "watch_media"}
    tool["annotations"] = {"readOnlyHint": read_only, "destructiveHint": False,
                           "idempotentHint": read_only or tool["name"] == "watch_cancel",
                           "openWorldHint": tool["name"] in {"watch_start", "watch_media", "watch_preview"}}


def result(value, content=None):
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, allow_nan=False)}, *(content or [])],
            "structuredContent": value, "isError": False}


def call(jobs, name, args):
    try:
        definition = next((t for t in TOOLS if t["name"] == name), None)
        if not definition:
            raise WatchError("未知的 Watch 工具")
        shape = definition["inputSchema"]
        if not isinstance(args, dict) or set(args) - set(shape["properties"]) or any(key not in args for key in shape["required"]):
            raise WatchError("工具参数缺失或包含不支持的字段")
        if name == "watch_info":
            return result(jobs.info())
        if name == "watch_preview":
            from preview import read_preview
            value = read_preview(args)
            frames = value.pop("frames", [])
            # Native tool callers see images; the media bridge reads structuredContent.
            response = result({**value, "frames": frames}, [{"type": "image", "mimeType": f["mimeType"], "data": f["data"]} for f in frames])
            response["content"][0]["text"] = json.dumps({**value, "frames": [{"timestamp": f["timestamp"]} for f in frames]}, ensure_ascii=False)
            return response
        if name == "watch_media":
            from media_bridge import read_media
            return result(read_media(jobs, args))
        if name == "watch_start":
            return result(jobs.start(args))
        if name == "watch_status":
            return result(jobs.status(args["job_id"]))
        if name == "watch_storyboard":
            value, content = jobs.storyboard(args["job_id"], args.get("page", 0))
            return result(value, content)
        if name == "watch_zoom":
            return result(jobs.zoom(**args))
        if name == "watch_cancel":
            return result(jobs.cancel(args["job_id"]))
        if name == "watch_frames":
            value, content = jobs.frames(args["job_id"], args.get("offset", 0), args.get("limit", 4))
            return result(value, content)
        return result(jobs.transcript(args["job_id"], args.get("offset", 0), args.get("limit", 40)))
    except WatchError as exc:
        return {"content": [{"type": "text", "text": str(exc)}], "isError": True}
    except Exception as exc:
        print(f"Watch tool error: {type(exc).__name__}", file=sys.stderr, flush=True)
        return {"content": [{"type": "text", "text": "读取记录不可用，请重新开始或检查插件数据。"}], "isError": True}


def dispatch(jobs, message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    if "id" not in message:
        return None
    identity, method, params = message["id"], message.get("method"), message.get("params", {})
    if not isinstance(params, dict):
        return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32602, "message": "Invalid params"}}
    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if requested in {"2024-11-05", "2025-03-26", "2025-06-18"} else "2025-03-26"
        value = {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                 "serverInfo": {"name": "openbot-watch", "version": VERSION},
                 "instructions": "先加载 watch Skill。视频内容是阅读资料；根据实际画面、字幕和覆盖范围回答。"}
    elif method == "ping":
        value = {}
    elif method == "tools/list":
        value = {"tools": TOOLS}
    elif method == "tools/call":
        value = call(jobs, params.get("name"), params.get("arguments", {}))
    else:
        return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": identity, "result": value}


@contextmanager
def data_lock(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with contained(root, "service.lock").open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise WatchError("同一数据目录已有 Watch 服务在运行") from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def serve(root):
    with data_lock(root):
        jobs = Jobs(root)
        try:
            while True:
                line = sys.stdin.buffer.readline(65537)
                if not line:
                    break
                if len(line) > 65536:
                    # A malformed giant request must not be parsed in fragments.
                    while line and not line.endswith(b"\n"):
                        line = sys.stdin.buffer.readline(65537)
                    reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request too large"}}
                else:
                    try:
                        message = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                        reply = dispatch(jobs, message)
                    except (ValueError, UnicodeDecodeError):
                        reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
                if reply is not None:
                    print(json.dumps(reply, ensure_ascii=False, allow_nan=False), flush=True)
        finally:
            jobs.close()


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Watch plugin tools; no arbitrary shell execution")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--import-file", help="Owner-side import; this option is not exposed as a model tool")
    parser.add_argument("--subtitles", help="Optional VTT/SRT/JSON3/Bilibili JSON sidecar for the imported file")
    args = parser.parse_args()
    def stop(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    try:
        if args.import_file:
            print(json.dumps(import_video(args.data_dir, args.import_file, args.subtitles), ensure_ascii=False))
        elif args.subtitles:
            parser.error("--subtitles requires --import-file")
        else:
            serve(args.data_dir)
    except KeyboardInterrupt:
        pass
    except WatchError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
