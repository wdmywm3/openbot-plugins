"""Plugin-owned validation, storage and bounded subprocess execution."""
from __future__ import annotations

import json
import importlib.util
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

MAX_MEDIA = 256 * 1024 * 1024
MAX_STORAGE = 2 * 1024 * 1024 * 1024
MAX_WINDOW = 600
MAX_DURATION = 7200
PREFERRED_RESOLUTION = 1080
DOWNLOAD_FORMAT = "bv*+ba/b/bv*"
# yt-dlp's res sorting uses the shorter side, including portrait video.
DOWNLOAD_SORT = f"res:{PREFERRED_RESOLUTION}"
MAX_FRAME_EDGE = 1920
VERSION = "0.9.0"
TOKEN = re.compile(r"^[a-f0-9]{32}$")


class WatchError(Exception):
    pass


class Cancelled(WatchError):
    pass


def download_error(stderr):
    # Classify without echoing signed URLs, cookies or local paths from logs.
    if "No module named 'yt_dlp'" in stderr:
        return "当前 Python 缺少 yt-dlp，请在插件运行环境安装 requirements-media.txt"
    if "Unable to extract" in stderr or "Unsupported URL" in stderr:
        return "当前 yt-dlp 无法解析此视频页面；更新下载器后重试，或主动导入视频"
    if any(term in stderr.lower() for term in ("javascript runtime", "js runtime", "challenge solver", "ejs")):
        return "YouTube 解析运行依赖不完整，请安装 yt-dlp[default] 和 Deno"
    if "HTTP Error 429" in stderr or "Too Many Requests" in stderr:
        return "来源限制了访问频率，请稍后再试"
    if any(term in stderr.lower() for term in ("login required", "sign in", "log in", "cookies-from-browser", "premium-only", "members-only")):
        return "来源要求登录或访问权限，请由主人配置本插件的登录文件"
    if "Requested format is not available" in stderr:
        return "没有可下载的视频格式，可能需要登录或相应访问权限"
    return "视频当前不可用或网络受限；可稍后重试或主动导入视频"


def number(value, name, lo=0, hi=MAX_DURATION):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
        raise WatchError(f"{name} 必须是 {lo} 到 {hi} 之间的有限数值")
    return float(value)


def integer(value, name, lo, hi):
    number(value, name, lo, hi)
    if not isinstance(value, int):
        raise WatchError(f"{name} 必须是整数")
    return value


def token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        raise WatchError("任务或导入标识无效")
    return value


def canonical_source(value):
    from sources import normalize_source
    return normalize_source(value)


def contained(root, *parts):
    root = Path(root).resolve()
    path = root.joinpath(*parts)
    # Reject reparse points as well as symlinks, including directory junctions.
    current = path
    while current != root:
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise WatchError("数据路径不能包含符号链接或目录联接")
        if current == current.parent:
            raise WatchError("数据路径越界")
        current = current.parent
    if not path.resolve().is_relative_to(root):
        raise WatchError("数据路径越界")
    return path


def read_json(path):
    if Path(path).stat().st_size > 8 * 1024 * 1024:
        raise WatchError("数据文件过大")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temp.replace(path)


def tree_size(root):
    total = 0
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not Path(folder, d).is_symlink()
                   and not getattr(Path(folder, d), "is_junction", lambda: False)()]
        for name in files:
            p = Path(folder, name)
            if not p.is_symlink():
                try:
                    total += p.stat().st_size
                except FileNotFoundError:
                    pass
    return total


def terminate_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        # PID comes only from a child created by this plugin, never tool input.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=10, check=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


class Runner:
    def __init__(self, directory, root, cancelled=None):
        self.directory, self.root = Path(directory), Path(root)
        self.cancelled = cancelled or threading.Event()

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled("读取已取消")

    def run(self, args, timeout=120):
        self.check()
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        # Temporary streams avoid a pipe deadlock and are never returned as paths.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            try:
                child = subprocess.Popen(args, cwd=self.directory, stdin=subprocess.DEVNULL,
                                         stdout=out, stderr=err, shell=False, **flags)
            except OSError:
                raise WatchError(f"无法启动 {Path(args[0]).name}，请检查运行依赖") from None
            deadline = time.monotonic() + timeout
            try:
                while child.poll() is None:
                    self.check()
                    if time.monotonic() > deadline:
                        raise WatchError(f"{Path(args[0]).name} 执行超时")
                    if out.tell() + err.tell() > 12 * 1024 * 1024:
                        raise WatchError("处理输出过大")
                    if tree_size(self.directory) > MAX_MEDIA + 32 * 1024 * 1024 or tree_size(self.root) > MAX_STORAGE:
                        raise WatchError("视频或缓存超过容量限制")
                    self.cancelled.wait(0.2)
                self.check()
                out.seek(0)
                err.seek(0)
                stdout = out.read(12 * 1024 * 1024).decode("utf-8", "replace")
                stderr = err.read(12 * 1024 * 1024).decode("utf-8", "replace")
                if child.returncode:
                    # Raw stderr may contain signed CDN URLs or local paths.
                    is_download = "yt-dlp" in Path(args[0]).name or "yt_dlp" in args or any(str(a).endswith(("download_info.py", "download.py")) for a in args)
                    hint = download_error(stderr) if is_download else "请检查媒体格式与运行依赖"
                    raise WatchError(f"{Path(args[0]).name} 执行失败（{child.returncode}）：{hint}")
                return stdout, stderr
            finally:
                terminate_tree(child)


def dependencies():
    return {"ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe")),
            "yt-dlp": bool(importlib.util.find_spec("yt_dlp") or shutil.which("yt-dlp"))}


def downloader_command():
    # The service's Python environment takes precedence over an older global EXE.
    return [sys.executable, "-B", "-m", "yt_dlp"] if importlib.util.find_spec("yt_dlp") else ["yt-dlp"]
