"""Optional local media MCP. Install explicitly; never downloads model weights.

MCP SDK is imported only by main(), keeping normalization testable without it.
Each server process owns its work directory and serial GPU queue.
"""
from __future__ import annotations
import base64
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import threading
import urllib.parse


def source_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Expected a public HTTPS video URL")
    if parsed.hostname not in ("www.bilibili.com", "bilibili.com", "www.youtube.com", "youtube.com", "youtu.be"):
        raise ValueError("Only Bilibili and YouTube video URLs are supported")
    query = urllib.parse.parse_qs(parsed.query)
    if parsed.hostname.endswith("bilibili.com"):
        match = re.fullmatch(r"/video/(BV[A-Za-z0-9]{10})/?", parsed.path)
        part = query.get("p", ["1"])[0]
        if not match or not re.fullmatch(r"[1-9][0-9]{0,3}", part):
            raise ValueError("Expected a BV video and valid part number")
        return f"https://www.bilibili.com/video/{match[1]}/?p={part}"
    video = parsed.path.lstrip("/") if parsed.hostname == "youtu.be" else query.get("v", [""])[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
        raise ValueError("Expected one YouTube video")
    return f"https://www.youtube.com/watch?v={video}"


def normalize_segments(segments, offset: float, end: float):
    return [{"start": round(max(offset, offset + s.start), 3),
             "end": round(min(end, offset + s.end), 3), "text": s.text.strip()}
            for s in segments if s.text.strip() and offset + s.start < end and s.end >= s.start]


class MediaJobs:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.model = None
        self.pending = set()
        # Jobs interrupted by service restart are not silently rerun.
        for file in self.root.glob("*/job.json"):
            data = json.loads(file.read_text("utf-8"))
            if data.get("status") in ("queued", "running"):
                self.write(file.parent.name, {**data, "status": "failed", "error": "Service restarted; start a new analysis to retry"})

    def write(self, job_id, data):
        directory = self.root / job_id
        directory.mkdir(exist_ok=True)
        temporary = directory / "job.tmp"
        temporary.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        temporary.replace(directory / "job.json")

    def status(self, job_id):
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise ValueError("Invalid job ID")
        with self.lock:
            return json.loads((self.root / job_id / "job.json").read_text("utf-8"))

    def start(self, kind, url, start, end, request_id, max_frames=12, language="auto", namespace=""):
        url = source_url(url)
        if kind not in ("transcribe", "frames", "backup") or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", request_id):
            raise ValueError("Invalid media request")
        if not 0 <= start < end or end - start > 600 or not 1 <= max_frames <= 12:
            raise ValueError("Invalid time/frame budget")
        if kind == 'backup' and not re.fullmatch(r'[a-f0-9]{64}', namespace):
            raise ValueError('Backup requires the host instance namespace')
        config = [kind, url, start, end, max_frames, language, os.environ.get("OPENBOT_ASR_MODEL_DIR", ""), namespace]
        job_id = hashlib.sha256((namespace + request_id).encode()).hexdigest()[:32]
        fingerprint = hashlib.sha256(json.dumps(config).encode()).hexdigest()
        with self.lock:
            directory = self.root / job_id
            if (directory / "job.json").exists():
                prior = json.loads((directory / "job.json").read_text("utf-8"))
                if prior.get("fingerprint") and prior["fingerprint"] != fingerprint:
                    raise ValueError("Request ID already belongs to different input")
                if kind == 'backup' and prior.get('status') == 'completed' and not self.valid_backup(prior.get('backup')):
                    return {'status': 'failed', 'error': 'Backup file is missing or changed; explicitly retry the backup'}
                return {"status": prior["status"], "jobId": job_id} if prior["status"] in ("queued", "running") else prior
            if len(self.pending) >= 8:
                raise ValueError("Media queue is full")
            self.write(job_id, {"status": "queued", "jobId": job_id, "fingerprint": fingerprint})
            self.pending.add(job_id)
            self.pool.submit(self.run, job_id, fingerprint, *config[:6], namespace)
            return {"status": "queued", "jobId": job_id}

    def command(self, args):
        try:
            return subprocess.run(args, check=True, capture_output=True, timeout=180,
                                  creationflags=0x08000000 if os.name == "nt" else 0)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(error.stderr.decode(errors="replace")[-1500:]) from error

    def download(self, url, kind, directory, start, end):
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import download_range_func
        options = {
            "format": "bestaudio/best" if kind == "transcribe" else "bestvideo[height<=720]/best[height<=720]",
            "outtmpl": str(directory / "source.%(ext)s"), "noplaylist": True, "playlist_items": "1",
            "quiet": True, "no_warnings": True, "logger": SilentLogger(),
            "retries": 0, "fragment_retries": 0, "extractor_retries": 0,
            "concurrent_fragment_downloads": 1, "socket_timeout": 30,
            "sleep_interval_requests": random.uniform(3, 7),
            "sleep_interval": 3, "max_sleep_interval": 7,
            "download_ranges": download_range_func(None, [(start, end)]),
            "force_keyframes_at_cuts": True,
            "max_filesize": 300 * 1024 * 1024,
        }
        with YoutubeDL(options) as downloader:
            downloader.download([url])
        files = [p for p in directory.glob("source.*") if p.suffix not in (".part", ".ytdl")]
        if len(files) != 1:
            raise ValueError("Expected one video part; specify its part in the source URL")
        return files[0]

    def process(self, directory, kind, url, start, end, max_frames, language):
        if kind == "transcribe":
            model_path = Path(os.environ.get("OPENBOT_ASR_MODEL_DIR", ""))
            if not os.environ.get("OPENBOT_ASR_MODEL_DIR") or not (model_path / "model.bin").is_file():
                raise ValueError("Choose and download an ASR model explicitly, then set OPENBOT_ASR_MODEL_DIR")
        source = self.download(url, kind, directory, start, end)
        probe = self.command([os.environ.get("OPENBOT_FFPROBE", "ffprobe"), "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=noprint_wrappers=1:nokey=1", str(source)])
        duration = float(probe.stdout.decode().strip())
        if not duration > 0:
            raise ValueError("Downloaded media has no measurable duration")
        incomplete = duration + 2 < end - start
        notes = f"Only {start:.1f}–{start + duration:.1f}s obtained; requested through {end:.1f}s" if incomplete else ""
        if kind == "transcribe":
            if self.model is None:
                from faster_whisper import WhisperModel
                self.model = WhisperModel(str(model_path.resolve()), device=os.environ.get("OPENBOT_ASR_DEVICE", "cpu"),
                                          compute_type=os.environ.get("OPENBOT_ASR_COMPUTE", "int8"), local_files_only=True)
            segments, info = self.model.transcribe(str(source), language=None if language == "auto" else language,
                                                   vad_filter=True, word_timestamps=False)
            return {"segments": normalize_segments(segments, start, end), "language": info.language, "incomplete": incomplete, "notes": notes}
        frames = []
        duration = min(duration, end - start)
        # Keep uniform coverage even when scene cuts cluster near the beginning.
        # Scene candidates are bounded and the caller can focus on a short range.
        scene = self.command([os.environ.get("OPENBOT_FFMPEG", "ffmpeg"), "-hide_banner", "-loglevel", "info", "-y",
                              "-i", str(source), "-vf", r"select=eq(n\,0)+gt(scene\,0.25),showinfo,scale=768:-2,format=yuvj420p",
                              "-fps_mode", "vfr", "-frames:v", "36", str(directory / "scene-%03d.jpg")])
        times = [float(t) for t in re.findall(r"pts_time:([0-9.eE+-]+)", scene.stderr.decode(errors="replace"))]
        scenes = [(at, file) for at, file in zip(times, sorted(directory.glob("scene-*.jpg"))) if at > 0]
        scene_count = min(len(scenes), max_frames // 2)
        chosen = [scenes[int(i * len(scenes) / scene_count)] for i in range(scene_count)] if scene_count else []
        uniform_count = max_frames - len(chosen)
        for i in range(uniform_count):
            at = duration * (i + .5) / uniform_count
            image = directory / f"frame-{i}.jpg"
            self.command([os.environ.get("OPENBOT_FFMPEG", "ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
                          "-ss", str(at), "-i", str(source), "-frames:v", "1", "-vf", "scale=768:-2", str(image)])
            if image.exists():
                chosen.append((at, image))
        seen = set()
        for at, image in sorted(chosen):
            data = image.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            frames.append({"timestamp": round(start + at, 3), "mimeType": "image/jpeg", "data": base64.b64encode(data).decode()})
        return {"frames": frames, "incomplete": incomplete,
                "notes": notes or "Scene-change and uniform samples, identical frames deduplicated; intermediate actions may be missing"}

    @staticmethod
    def digest(file):
        value = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                value.update(block)
        return value.hexdigest()

    def valid_backup(self, backup):
        if not isinstance(backup, dict):
            return False
        file = Path(backup.get('path', '')).resolve()
        root = Path(os.environ.get('OPENBOT_BACKUP_DIR', str(self.root / 'backups'))).resolve()
        return file.is_relative_to(root) and file.is_file() and file.stat().st_size == backup.get('bytes') and self.digest(file) == backup.get('sha256')

    def backup(self, job_id, url, namespace):
        from yt_dlp import YoutubeDL
        root = Path(os.environ.get('OPENBOT_BACKUP_DIR', str(self.root / 'backups'))).resolve() / namespace
        root.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(url.encode()).hexdigest()
        manifest = root / (key + '.json')
        if manifest.is_file():
            prior = json.loads(manifest.read_text('utf-8'))
            if prior.get('url') == url and self.valid_backup(prior.get('backup')):
                return {'backup': prior['backup']}
        directory = (root / job_id).resolve()
        if not directory.is_relative_to(root.resolve()):
            raise ValueError('Invalid backup directory')
        directory.mkdir(exist_ok=True)
        max_bytes = int(os.environ.get('OPENBOT_BACKUP_MAX_FILE_MB', '2048')) * 1024 * 1024
        max_total = int(os.environ.get('OPENBOT_BACKUP_MAX_TOTAL_GB', '20')) * 1024 ** 3
        reserve = 1024 ** 3
        if max_bytes <= 0 or max_total <= 0:
            raise ValueError('Backup size limits must be positive')
        def budget(_=None):
            used = sum(f.stat().st_size for f in root.rglob('*') if f.is_file())
            current = sum(f.stat().st_size for f in directory.iterdir() if f.is_file())
            if used >= max_total or current >= max_bytes or shutil.disk_usage(root).free < reserve:
                raise ValueError('Backup disk/size budget reached; existing backups are retained')
        budget()
        options = {'format': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', 'merge_output_format': 'mkv',
                   'outtmpl': str(directory / 'video.%(ext)s'), 'noplaylist': True, 'playlist_items': '1',
                   'quiet': True, 'no_warnings': True, 'logger': SilentLogger(), 'retries': 0, 'fragment_retries': 0,
                   'extractor_retries': 0, 'concurrent_fragment_downloads': 1, 'socket_timeout': 30,
                   'sleep_interval_requests': random.uniform(3, 7), 'sleep_interval': 3, 'max_sleep_interval': 7,
                   'max_filesize': max_bytes, 'progress_hooks': [budget]}
        # Optional user-managed Netscape cookie file; never return credentials.
        if os.environ.get('OPENBOT_MEDIA_COOKIE_FILE'):
            options['cookiefile'] = os.environ['OPENBOT_MEDIA_COOKIE_FILE']
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=True)
        if info.get('entries'):
            entries = [entry for entry in info['entries'] if entry]
            if len(entries) != 1:
                raise ValueError('Expected one video part')
            info = entries[0]
        files = [f for f in directory.glob('video.*') if f.suffix in ('.mp4', '.mkv', '.webm', '.flv')]
        if len(files) != 1 or files[0].stat().st_size <= 0:
            raise ValueError('A complete merged video was not produced')
        file = files[0]
        probe = self.command([os.environ.get('OPENBOT_FFPROBE', 'ffprobe'), '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(file)])
        media = json.loads(probe.stdout)
        duration = float(media.get('format', {}).get('duration', 0))
        expected = float(info.get('duration') or 0)
        if duration <= 0 or (expected and duration + max(3, expected * 0.01) < expected) or not any(s.get('codec_type') == 'video' for s in media.get('streams', [])):
            raise ValueError('Downloaded video is incomplete')
        if info.get('acodec') != 'none' and not any(s.get('codec_type') == 'audio' for s in media.get('streams', [])):
            raise ValueError('Downloaded video has no audio track')
        budget()
        receipt = {'path': str(file), 'sha256': self.digest(file), 'bytes': file.stat().st_size}
        temporary = manifest.with_suffix('.tmp')
        temporary.write_text(json.dumps({'url': url, 'title': info.get('title', ''), 'duration': duration, 'backup': receipt}, ensure_ascii=False), 'utf-8')
        temporary.replace(manifest)
        return {'backup': receipt}

    def run(self, job_id, fingerprint, kind, url, start, end, max_frames, language, namespace):
        directory = self.root / job_id
        with self.lock:
            self.write(job_id, {"status": "running", "jobId": job_id, "fingerprint": fingerprint})
        try:
            data = self.backup(job_id, url, namespace) if kind == 'backup' else self.process(directory, kind, url, start, end, max_frames, language)
            result = {"status": "completed", **data}
        except Exception as error:
            result = {"status": "failed", "error": str(error)[:1000]}
        finally:
            # Keep normalized evidence and receipt, remove temporary media.
            for file in directory.iterdir():
                if file.name.startswith(("source.", "frame-", "scene-")) and file.is_file():
                    try:
                        file.unlink(missing_ok=True)
                    except OSError:
                        pass
        with self.lock:
            self.write(job_id, {**result, "jobId": job_id, "fingerprint": fingerprint})
            self.pending.discard(job_id)


class SilentLogger:
    # MCP stdio stdout must contain protocol messages only.
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass


def main():
    from mcp.server.fastmcp import FastMCP
    service = FastMCP("openbot-media")
    # Set a distinct work directory for every instance when configuring MCP.
    jobs = MediaJobs(Path(os.environ.get("OPENBOT_MEDIA_WORK", "./media-work")))

    @service.tool()
    def media_start(kind: str, url: str, start: float, end: float, request_id: str,
                    max_frames: int = 12, language: str = "auto", namespace: str = "") -> dict:
        """Start caption-independent audio transcription or timestamped frame sampling. No model downloads."""
        return jobs.start(kind, url, start, end, request_id, max_frames, language, namespace)

    @service.tool()
    def media_status(job_id: str) -> dict:
        """Read a previously returned job receipt and its timestamped result."""
        return jobs.status(job_id)

    service.run(transport="stdio")


if __name__ == "__main__":
    main()
