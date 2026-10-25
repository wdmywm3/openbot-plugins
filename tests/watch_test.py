"""Watch contract and real-media tests; network and installed ASR are optional."""
import base64
import ctypes
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import wave

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "watch"
sys.path.insert(0, str(PLUGIN / "tools"))
from common import (Cancelled, DOWNLOAD_FORMAT, DOWNLOAD_SORT, Runner, WatchError,
                    canonical_source, contained, download_error, read_json, write_json)
from jobs import Jobs, import_video, validate_request
import media
import server
from download_info import video_state, bili_extractor
from transcribe import load_pcm_audio
from media_bridge import read_media


def wait_job(jobs, identity, timeout=30):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        state = jobs.status(identity)
        if state["status"] in {"ready", "failed", "cancelled", "interrupted"}:
            return state
        time.sleep(0.05)
    raise AssertionError("Watch job did not finish")


class ValidationTests(unittest.TestCase):
    def test_sources_are_fixed_and_queries_are_canonical(self):
        self.assertEqual(canonical_source("https://www.bilibili.com/video/BV1BFHN6PEfi/?spm_id_from=x&p=2"), "https://www.bilibili.com/video/BV1BFHN6PEfi/?p=2")
        self.assertEqual(canonical_source("https://youtu.be/abcdefghijk?t=90"), "https://www.youtube.com/watch?v=abcdefghijk")
        self.assertEqual(canonical_source("https://m.youtube.com/shorts/abcdefghijk"), "https://www.youtube.com/watch?v=abcdefghijk")
        for bad in ("D:/Videos/private.mp4", "file:///etc/passwd", "http://127.0.0.1/", "https://youtube.com@127.0.0.1/watch?v=abcdefghijk",
                    "https://youtube.com.evil.test/watch?v=abcdefghijk", "https://user:pass@www.bilibili.com/video/BV1BFHN6PEfi/",
                    "https://www.youtube.com:8000/watch?v=abcdefghijk", "https://youtu.be/../abcdefghijk", "import:../../secret", "watch:x",
                    "https://www.bilibili.com/video/BV1BFHN6PEfi/?p=0"):
            with self.subTest(bad=bad), self.assertRaises(WatchError):
                canonical_source(bad)

    def test_invalid_numeric_and_shell_arguments(self):
        source = "https://youtu.be/abcdefghijk"
        for extra in ({"start_seconds": True}, {"end_seconds": float("nan")}, {"frame_count": 2.5}, {"frame_count": 25},
                      {"end_seconds": 601}, {"timestamps": [float("inf")]}, {"timestamps": [600]}, {"timestamps": []},
                      {"command": "whoami"}, {"cookies": "secret.txt"}, {"request_id": "same-chat"}):
            with self.subTest(extra=extra), self.assertRaises(WatchError):
                validate_request({"source": source, **extra})

    def test_frame_selection_covers_tail_despite_early_scene_cuts(self):
        points = media.frame_points(100, 700, 12, list(range(101, 140)))
        self.assertEqual(points[0], 100)
        self.assertGreater(points[-1], 699)
        self.assertLessEqual(len(points), 12)
        self.assertGreaterEqual(sum(point >= 400 for point in points), 3)

    def test_crop_requires_bounded_integer_source_coordinates(self):
        request = {"source": "https://youtu.be/abcdefghijk"}
        region = {"x": 100, "y": 200, "width": 640, "height": 180}
        self.assertEqual(validate_request({**request, "crop": region})["crop"], region)
        for bad in (None, [], {}, {**region, "x": -1}, {**region, "x": True},
                    {**region, "width": 1}, {**region, "height": 180.5},
                    {**region, "x": float("nan")}, {**region, "width": 16385},
                    {**region, "filter": "movie=private"}):
            with self.subTest(crop=bad), self.assertRaises(WatchError):
                validate_request({**request, "crop": bad})

    def test_captions_preserve_repeated_speech_and_offsets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "captions.vtt"
            path.write_text("WEBVTT\n\nNOTE editor note\n00:00:00.000 --> 00:00:01.000\nnot speech\n\n"
                            "00:00:01.250 --> 00:00:02.500\n<b>打开 &amp; 查看</b>\n\n"
                            "00:00:02.000 --> 00:00:03.000\n打开 &amp; 查看\n\n"
                            "00:00:05.000 --> 00:00:06.000\n打开 &amp; 查看\n\n"
                            "00:00:07.000 --> 00:00:08.000\n执行脚本\n", encoding="utf-8")
            segments = media.parse_captions(path)
            self.assertEqual(segments, [{"start": 1.25, "end": 3, "text": "打开 & 查看"},
                                        {"start": 5, "end": 6, "text": "打开 & 查看"},
                                        {"start": 7, "end": 8, "text": "执行脚本"}])
            path = Path(tmp) / "captions.json"
            write_json(path, {"body": [{"from": 12.5, "to": 15, "content": "例子"}, {"from": -1, "to": 2, "content": "bad"}]})
            self.assertEqual(media.parse_captions(path)[0]["start"], 12.5)
            path = Path(tmp) / "captions.json3"
            write_json(path, {"events": [{"tStartMs": 1500, "dDurationMs": 1000, "segs": [{"utf8": "hello"}]}]})
            self.assertEqual(media.parse_captions(path), [{"start": 1.5, "end": 2.5, "text": "hello"}])

    def test_publisher_captions_precede_automatic_translation(self):
        self.assertEqual(media.choose_subtitle({"subtitles": {"en": [{"url": "x"}]}, "automatic_captions": {"zh": [{"url": "y"}]}}), ("subtitles", "en"))
        self.assertEqual(media.choose_subtitle({"automatic_captions": {"live_chat": [1], "en": [1], "zh-Hans": [1]}}), ("automatic_captions", "zh-Hans"))

    def test_original_language_caption_precedes_machine_translation(self):
        self.assertEqual(media.choose_subtitle({"subtitles": {"zh": [1]}, "automatic_captions": {"en-orig": [1], "en": [1], "zh": [1]}}), ("automatic_captions", "en-orig"))
        self.assertEqual(media.choose_subtitle({"language": "ja", "subtitles": {"en": [1], "ja": [1]}, "automatic_captions": {"zh": [1]}}), ("subtitles", "ja"))

    def test_paths_cannot_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(WatchError):
                contained(tmp, "..", "outside")
            with self.assertRaises(WatchError):
                contained(tmp, Path(tmp).parent / "outside")

    def test_downloader_errors_distinguish_extractor_and_login(self):
        self.assertIn("更新", download_error("Unable to extract initial state https://secret.example/token"))
        self.assertNotIn("secret", download_error("Unable to extract initial state https://secret.example/token"))
        self.assertIn("登录", download_error("Please sign in"))
        self.assertIn("频率", download_error("HTTP Error 429"))


class BilibiliTests(unittest.TestCase):
    def test_wbi_rejects_failed_or_mismatched_video(self):
        for data in ({"code": -403}, {"code": 0, "data": {"View": {"bvid": "wrong", "cid": 123}}},
                     {"code": 0, "data": {"View": {"bvid": "BV1BFHN6PEfi", "cid": True}}}):
            with self.assertRaises(WatchError):
                video_state(data, "BV1BFHN6PEfi")

    def test_wbi_fallback_preserves_rights_and_selected_part_duration(self):
        import re
        detail = {"code": 0, "data": {"View": {"bvid": "BV1BFHN6PEfi", "cid": 10, "duration": 70,
                  "rights": {"ugc_pay": 1}, "pages": [{"cid": 10, "duration": 30}, {"cid": 11, "duration": 40}]}}}
        class Extractor:
            def __init__(self):
                self.page = "<html>client-rendered page</html>"
                self.calls = 0
            def suitable(self, url):
                return url.startswith("https://www.bilibili.com/video/")
            def _download_webpage_handle(self, *args, **kwargs):
                return self.page, "handle"
            def _match_valid_url(self, url):
                return re.search(r"/(?P<prefix>BV)(?P<id>[A-Za-z0-9]{10})", url)
            def _sign_wbi(self, query, video_id):
                return query
            def _download_json(self, *args, **kwargs):
                self.calls += 1
                return detail
        adapter = bili_extractor(Extractor)()
        page, handle = adapter._download_webpage_handle("https://www.bilibili.com/video/BV1BFHN6PEfi/?p=2", "id")
        self.assertEqual(handle, "handle")
        self.assertEqual(adapter.watch_source_duration, 40)
        self.assertEqual(adapter.calls, 1)
        parsed = json.loads(page.split("window.__INITIAL_STATE__=")[1].split(";</script>")[0])
        self.assertEqual(parsed["videoData"]["rights"]["ugc_pay"], 1)
        adapter.page = 'window.__INITIAL_STATE__={"error":{"trueCode":-403}}'
        unchanged, _ = adapter._download_webpage_handle("https://www.bilibili.com/video/BV1BFHN6PEfi/", "id")
        self.assertEqual(unchanged, adapter.page)
        self.assertEqual(adapter.calls, 1)
        adapter.page = "client-rendered page"
        with self.assertRaises(WatchError):
            adapter._download_webpage_handle("https://www.bilibili.com/video/BV1BFHN6PEfi/?p=3", "id")


@unittest.skipUnless(importlib.util.find_spec("yt_dlp"), "Download runtime not installed")
class DownloadQualityTests(unittest.TestCase):
    def select(self, sizes):
        from yt_dlp import YoutubeDL
        formats = [{"format_id": str(i), "url": f"https://example.com/video-{i}.mp4", "ext": "mp4",
                    "width": width, "height": height, "vcodec": "avc1.640028", "acodec": "none", "fps": 30}
                   for i, (width, height) in enumerate(sizes)]
        formats.append({"format_id": "audio", "url": "https://example.com/audio.m4a", "ext": "m4a",
                        "vcodec": "none", "acodec": "mp4a.40.2", "abr": 128})
        # Exercise the real downloader's format selection without making requests.
        with YoutubeDL({"quiet": True, "no_warnings": True, "cachedir": False,
                        "format": DOWNLOAD_FORMAT, "format_sort": [DOWNLOAD_SORT]}, auto_init=False) as downloader:
            return downloader.process_ie_result({"id": "quality", "title": "quality", "formats": formats}, download=False)

    def test_prefers_1080p_for_landscape_and_portrait(self):
        for portrait in (False, True):
            sizes = [(640, 360), (1280, 720), (1920, 1080), (3840, 2160)]
            if portrait:
                sizes = [(height, width) for width, height in sizes]
            selected = self.select(sizes)
            self.assertEqual((selected["width"], selected["height"]), (1080, 1920) if portrait else (1920, 1080))
            self.assertEqual(len(selected["requested_formats"]), 2)

    def test_uses_available_resolution_without_requiring_1080p(self):
        for sizes, expected in (([(640, 360), (1280, 720)], (1280, 720)),
                                ([(2560, 1440), (3840, 2160)], (2560, 1440))):
            selected = self.select(sizes)
            self.assertEqual((selected["width"], selected["height"]), expected)


class AudioTests(unittest.TestCase):
    def test_unprepared_audio_format_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audio.wav"
            with wave.open(str(path), "wb") as audio:
                audio.setparams((2, 2, 44100, 0, "NONE", "not compressed"))
                audio.writeframes(b"\x00" * 100)
            with self.assertRaisesRegex(ValueError, "mono 16 kHz PCM16"):
                load_pcm_audio(path)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "Optional ASR runtime not installed")
    def test_prepared_pcm_uses_samples_without_pyav_decoder(self):
        import struct
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audio.wav"
            with wave.open(str(path), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(struct.pack("<hhh", -32768, 0, 16384))
            # Regression: PyAV 19 no longer accepts metadata_errors in av.open.
            with patch.dict(sys.modules, {"av": None}):
                samples = load_pcm_audio(path)
            self.assertEqual(samples.tolist(), [-1.0, 0.0, 0.5])


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dep = patch("jobs.dependencies", return_value={"ffmpeg": True, "ffprobe": True, "yt-dlp": True})
        self.dep.start()
        self.services = []

    def tearDown(self):
        for jobs in self.services:
            jobs.close()
        self.dep.stop()
        self.tmp.cleanup()

    def make(self, processor):
        jobs = Jobs(self.root, processor)
        self.services.append(jobs)
        return jobs

    def test_idempotency_rejects_changed_request_and_cancels_active_and_queued(self):
        started = threading.Event()
        def blocking(request, directory, root, runner, stage, settings):
            started.set()
            while True:
                runner.check()
                time.sleep(0.01)
        jobs = self.make(blocking)
        args = {"source": "https://youtu.be/abcdefghijk", "request_id": str(uuid.uuid4())}
        first = jobs.start(args)["job_id"]
        self.assertTrue(started.wait(2))
        self.assertEqual(jobs.start(args)["job_id"], first)
        with self.assertRaises(WatchError):
            jobs.start({**args, "frame_count": 8})
        with self.assertRaises(WatchError):
            jobs.start({**args, "crop": {"x": 0, "y": 0, "width": 100, "height": 100}})
        second = jobs.start({"source": "https://youtu.be/abcdefghijk"})["job_id"]
        self.assertEqual(jobs.cancel(second)["status"], "cancelled")
        jobs.cancel(first)
        self.assertEqual(wait_job(jobs, first)["status"], "cancelled")
        self.assertNotIn("request", jobs.status(first))

    def test_restart_marks_work_interrupted_and_does_not_replay(self):
        identity = uuid.uuid4().hex
        folder = self.root / "jobs" / identity
        folder.mkdir(parents=True)
        write_json(folder / "job.json", {"job_id": identity, "status": "running", "created_at": time.time(), "request": {}})
        (folder / "media.partial").write_bytes(b"unfinished download")
        def forbidden(*args):
            self.fail("Restart must not replay work")
        jobs = self.make(forbidden)
        self.assertEqual(jobs.status(identity)["status"], "interrupted")
        self.assertFalse((folder / "media.partial").exists())
        with self.assertRaises(WatchError):
            jobs.frames(identity)

    def test_queue_capacity_and_request_does_not_accept_arbitrary_paths(self):
        release = threading.Event()
        def blocking(request, directory, root, runner, stage, settings):
            while not release.wait(0.01):
                runner.check()
            raise WatchError("finished fixture")
        jobs = self.make(blocking)
        for _ in range(4):
            jobs.start({"source": "https://youtu.be/abcdefghijk"})
        with self.assertRaisesRegex(WatchError, "队列"):
            jobs.start({"source": "https://youtu.be/abcdefghijk"})
        release.set()
        self.assertTrue(server.call(jobs, "watch_start", {"source": "C:/Users/private.mp4"})["isError"])
        self.assertTrue(server.call(jobs, "watch_info", {"shell": "whoami"})["isError"])

    def test_transcript_paging_returns_every_segment_without_overflow(self):
        def fixture(request, directory, root, runner, stage, settings):
            write_json(directory / "transcript.json", {"source": "imported_subtitles", "segments": [
                {"start": i, "end": i + 1, "text": "字" * 1800} for i in range(40)]})
            write_json(directory / "result.json", {"frames": [], "frame_count": 0})
        jobs = self.make(fixture)
        identity = jobs.start({"source": "https://youtu.be/abcdefghijk"})["job_id"]
        self.assertEqual(wait_job(jobs, identity)["status"], "ready")
        offset, got = 0, []
        while offset is not None:
            page = jobs.transcript(identity, offset, 80)
            self.assertLess(len(json.dumps(page, ensure_ascii=False)), 13000)
            got.extend(page["segments"])
            offset = page["next_offset"]
        self.assertEqual([s["start"] for s in got], list(range(40)))

    def test_service_lock_prevents_concurrent_ownership(self):
        with server.data_lock(self.root):
            with self.assertRaises(WatchError):
                with server.data_lock(self.root):
                    self.fail("Two servers cannot own the same data directory")

    def test_media_bridge_paging_retries_scope_and_source_reuse(self):
        def fixture(request, directory, root, runner, stage, settings):
            write_json(directory / "transcript.json", {"source": "local_asr", "segments": [
                {"start": i, "end": i + 1, "text": "字" * 1800} for i in range(120)]})
            (directory / "frame.jpg").write_bytes(b"fixture-image")
            write_json(directory / "result.json", {"range": {"start_seconds": 0, "end_seconds": 120},
                "coverage": {"source_incomplete": False, "max_gap_seconds": 10}, "warnings": [],
                "frames": [{"index": i, "file": "frame.jpg", "observations": [{"timestamp_seconds": i * 10}]} for i in range(12)]})
        jobs = self.make(fixture)
        args = {"kind": "transcribe", "url": "https://www.bilibili.com/video/BV1234567890/", "start": 0, "end": 120,
                "namespace": "a" * 64, "request_id": "speech"}
        first = read_media(jobs, args)
        self.assertEqual(wait_job(jobs, first["jobId"])["status"], "ready")
        speech = read_media(jobs, {**args, "job_id": first["jobId"]})
        self.assertEqual(len(speech["segments"]), 120)
        self.assertEqual(speech["segments"][-1]["end"], 120)
        self.assertFalse(speech["incomplete"])
        self.assertEqual(read_media(jobs, args), speech)
        for change in ({"namespace": "b" * 64}, {"end": 100}, {"kind": "frames"}, {"url": "https://youtu.be/abcdefghijk"}):
            with self.subTest(change=change), self.assertRaises(WatchError):
                read_media(jobs, {**args, "job_id": first["jobId"], **change})
        frames_args = {**args, "kind": "frames", "request_id": "pictures"}
        frames = read_media(jobs, frames_args)
        self.assertEqual(wait_job(jobs, frames["jobId"])["status"], "ready")
        self.assertEqual(jobs.records[frames["jobId"]]["request"]["source"], "watch:" + first["jobId"])
        pictures = read_media(jobs, frames_args)
        self.assertEqual(len(pictures["frames"]), 12)
        self.assertEqual(pictures["frames"][-1]["timestamp"], 110)
        self.assertTrue(pictures["incomplete"])
        self.assertIn("10秒", pictures["notes"])
        self.assertTrue(server.call(jobs, "watch_start", {"source": args["url"], "media_kind": "frames"})["isError"])
        for row in jobs.records.values():
            row["finished_at"] = time.time() - 25 * 3600
        fresh = read_media(jobs, {**frames_args, "request_id": "after-expiry"})
        self.assertEqual(jobs.records[fresh["jobId"]]["request"]["source"], args["url"].rstrip("/") + "/?p=1")

    def test_media_bridge_keeps_failed_receipt_without_restarting(self):
        calls = []
        def broken(*args):
            calls.append(1)
            raise WatchError("fixture unavailable")
        jobs = self.make(broken)
        args = {"kind": "frames", "url": "https://youtu.be/abcdefghijk", "start": 0, "end": 10,
                "namespace": "c" * 64, "request_id": "failure"}
        first = read_media(jobs, args)
        wait_job(jobs, first["jobId"])
        failed = read_media(jobs, args)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("fixture unavailable", failed["error"])
        self.assertEqual(calls, [1])


class ProcessTests(unittest.TestCase):
    def test_cancellation_stops_process_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            stop = threading.Event()
            runner = Runner(tmp, tmp, stop)
            pid_file = Path(tmp) / "child.json"
            code = ("import subprocess,sys,json,time,os; from pathlib import Path; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                    "Path(sys.argv[1]).write_text(json.dumps([os.getpid(),p.pid])); time.sleep(30)")
            def cancel_when_ready():
                for _ in range(100):
                    if pid_file.exists():
                        break
                    time.sleep(0.02)
                stop.set()
            thread = threading.Thread(target=cancel_when_ready)
            thread.start()
            try:
                with self.assertRaises(Cancelled):
                    runner.run([sys.executable, "-c", code, str(pid_file)], 10)
            finally:
                thread.join()
            identities = json.loads(pid_file.read_text())
            if os.name == "nt":
                kernel = ctypes.windll.kernel32
                kernel.OpenProcess.restype = ctypes.c_void_p
                for identity in identities:
                    handle = kernel.OpenProcess(0x1000, False, identity)
                    if handle:
                        status = ctypes.c_ulong()
                        kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(status))
                        kernel.CloseHandle(ctypes.c_void_p(handle))
                        self.assertNotEqual(status.value, 259)
            else:
                # A reparented zombie is no longer running; Linux exposes its state.
                for identity in identities:
                    stat = Path(f"/proc/{identity}/stat")
                    if stat.exists():
                        self.assertEqual(stat.read_text().split()[2], "Z")

    def test_error_does_not_leak_subprocess_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(WatchError) as error:
                Runner(tmp, tmp).run([sys.executable, "-c", "raise RuntimeError('signed-secret-url')"])
            self.assertNotIn("signed-secret-url", str(error.exception))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg not installed")
class RealMediaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.video = self.root / "input.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=4:duration=9",
                        "-f", "lavfi", "-i", "sine=frequency=500:duration=9", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(self.video)], check=True, capture_output=True, timeout=30)
        self.subtitles = self.root / "input.vtt"
        self.subtitles.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n第一步\n\n00:00:05.000 --> 00:00:08.000\n第二步\n", encoding="utf-8")
        self.data = self.root / "data"
        self.source = import_video(self.data, self.video, self.subtitles)["source"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_real_frames_timestamps_transcript_and_cache_reuse(self):
        jobs = Jobs(self.data)
        try:
            identity = jobs.start({"source": self.source, "start_seconds": 1.2, "end_seconds": 8.2, "frame_count": 8})["job_id"]
            state = wait_job(jobs, identity)
            self.assertEqual(state["status"], "ready", state)
            self.assertEqual(state["result"]["range"], {"start_seconds": 1.2, "end_seconds": 8.2})
            observed = state["result"]["coverage"]["observed_timestamps"]
            self.assertGreaterEqual(observed[0], 1.2)
            self.assertLessEqual(observed[0], 1.5)
            self.assertGreater(observed[-1], 7.5)
            page, blocks = jobs.frames(identity)
            self.assertLessEqual(sum(b["type"] == "image" for b in blocks), 4)
            for item in blocks:
                if item["type"] == "image":
                    self.assertTrue(base64.b64decode(item["data"]).startswith(b"\xff\xd8"))
            self.assertEqual(jobs.transcript(identity)["segments"][0]["start"], 1)
            self.assertEqual(jobs.transcript(identity)["source"], "imported_subtitles")
            with patch("media.expand_short_url", side_effect=AssertionError("Cache reuse must not access network")):
                second = jobs.start({"source": "watch:" + identity, "start_seconds": 4, "end_seconds": 8.8, "timestamps": [4.1, 8.5]})["job_id"]
                focused = wait_job(jobs, second)
                self.assertEqual(focused["status"], "ready", focused)
                times = focused["result"]["coverage"]["observed_timestamps"]
                self.assertEqual(len(times), 2)
                self.assertGreaterEqual(times[0], 4.1)
                self.assertGreaterEqual(times[-1], 8.5)
        finally:
            jobs.close()
        reopened = Jobs(self.data)
        try:
            self.assertEqual(reopened.status(identity)["status"], "ready")
            self.assertEqual(len(reopened.transcript(identity)["segments"]), 2)
        finally:
            reopened.close()

    def test_identical_frame_dedup_keeps_all_observation_times(self):
        static = self.root / "static.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=blue:size=160x90:rate=4:duration=3", str(static)], check=True, capture_output=True, timeout=20)
        folder = self.root / "frames"
        folder.mkdir()
        frames = media.extract_frames(static, [0, 1, 2], 3, folder, Runner(folder, self.root))
        self.assertEqual(len(frames), 1)
        self.assertEqual([o["timestamp_seconds"] for o in frames[0]["observations"]], [0, 1, 2])

    def image_size(self, image):
        raw = subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(image)], timeout=15)
        stream = json.loads(raw)["streams"][0]
        return stream["width"], stream["height"]

    def test_full_hd_frames_are_not_reduced_to_720p(self):
        video = self.root / "full-hd.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc2=size=1920x1080:rate=1:duration=1", "-c:v", "libx264", str(video)],
                       check=True, capture_output=True, timeout=30)
        frames = media.extract_frames(video, [0], 1, self.root, Runner(self.root, self.root))
        self.assertEqual(self.image_size(self.root / frames[0]["file"]), (1920, 1080))
        self.assertEqual((frames[0]["width"], frames[0]["height"]), (1920, 1080))

    def test_crop_reuses_original_pixels_and_reports_source_coordinates(self):
        video = self.root / "fine-lines.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "nullsrc=size=3840x2160:rate=1:duration=1,geq=lum='if(mod(X,2),235,16)':cb=128:cr=128",
                        "-c:v", "libx264", "-crf", "0", str(video)], check=True, capture_output=True, timeout=30)
        source = import_video(self.data, video)["source"]
        jobs = Jobs(self.data)
        try:
            first = jobs.start({"source": source, "timestamps": [0]})["job_id"]
            whole = wait_job(jobs, first)
            self.assertEqual(whole["status"], "ready", whole)
            self.assertEqual(whole["result"]["frame_view"], {"crop": None, "width": 1920, "height": 1080})
            crop = {"x": 321, "y": 300, "width": 160, "height": 80}
            with patch("media.expand_short_url", side_effect=AssertionError("Crop must reuse the cached source")):
                response = server.call(jobs, "watch_start", {"source": "watch:" + first, "timestamps": [0], "crop": crop})
                self.assertFalse(response["isError"], response)
                second = response["structuredContent"]["job_id"]
                focused = wait_job(jobs, second)
            self.assertEqual(focused["status"], "ready", focused)
            image = jobs.directory(second) / "frame-000.jpg"
            self.assertEqual(self.image_size(image), (160, 80))
            # One-pixel alternating lines disappear if we crop the reduced overview.
            pixels = subprocess.check_output(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(image),
                                              "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"], timeout=15)
            self.assertGreater(abs(pixels[40 * 160 + 70] - pixels[40 * 160 + 71]), 180)
            page, content = jobs.frames(second)
            view = json.loads(content[0]["text"])["view"]
            self.assertEqual(view, {"crop": crop, "width": 160, "height": 80, "source_width": 3840, "source_height": 2160})
            self.assertEqual(focused["result"]["coverage"]["observed_timestamps"], [0])
            self.assertEqual(page["total"], 1)
        finally:
            jobs.close()

    def test_crop_outside_source_is_rejected_before_frame_extraction(self):
        jobs = Jobs(self.data)
        try:
            with patch("media.extract_frames", side_effect=AssertionError("Invalid crop must not be extracted")):
                identity = jobs.start({"source": self.source, "crop": {"x": 310, "y": 0, "width": 20, "height": 20}})["job_id"]
                state = wait_job(jobs, identity)
            self.assertEqual(state["status"], "failed", state)
            self.assertIn("裁剪区域超出原视频 320×180", state["stage"])
        finally:
            jobs.close()

    def test_preview_reports_available_range_and_missing_audio_evidence(self):
        source = import_video(self.data, self.video)["source"]
        folder = self.data / "imports" / source[7:]
        manifest = read_json(folder / "source.json")
        manifest["reported_duration_seconds"] = 90
        write_json(folder / "source.json", manifest)
        jobs = Jobs(self.data)
        try:
            identity = jobs.start({"source": source, "end_seconds": 20, "frame_count": 2, "sampling": "uniform"})["job_id"]
            state = wait_job(jobs, identity)
            self.assertEqual(state["status"], "ready", state)
            result = state["result"]
            self.assertAlmostEqual(result["range"]["end_seconds"], 9, places=1)
            self.assertTrue(result["coverage"]["source_incomplete"])
            self.assertFalse(result["coverage"]["more_video_after_range"])
            self.assertEqual(result["transcript"]["source"], "unavailable")
            self.assertGreaterEqual(len(result["warnings"]), 2)
        finally:
            jobs.close()

    def test_remote_acquisition_contract_without_live_credentials(self):
        calls = []
        original = Runner.run
        def downloader(runner, args, timeout=120):
            if args[0] != "yt-dlp":
                return original(runner, args, timeout)
            calls.append(args)
            if "--dump-single-json" in args:
                return json.dumps({"title": "远程测试", "duration": 9, "subtitles": {"ai-zh": [{"url": "not-requested-by-plugin"}]}}), ""
            if "--skip-download" in args:
                shutil.copyfile(self.subtitles, runner.directory / "subtitle.ai-zh.vtt")
            else:
                shutil.copyfile(self.video, runner.directory / "media.mp4")
            return "", ""
        jobs = Jobs(self.data)
        try:
            with patch.object(Runner, "run", downloader), patch("media.downloader_command", return_value=["yt-dlp"]), patch("jobs.dependencies", return_value={"ffmpeg": True, "ffprobe": True, "yt-dlp": True}):
                identity = jobs.start({"source": "https://youtu.be/abcdefghijk", "frame_count": 2, "sampling": "uniform"})["job_id"]
                state = wait_job(jobs, identity)
            self.assertEqual(state["status"], "ready", state)
            self.assertEqual(state["result"]["title"], "远程测试")
            self.assertTrue(any("低于优先选择的 1080p" in warning for warning in state["result"]["warnings"]))
            self.assertEqual(jobs.transcript(identity)["source"], "automatic_subtitles")
            self.assertEqual(len(calls), 3)
            for args in calls:
                self.assertIn("--ignore-config", args)
                self.assertIn("--no-plugin-dirs", args)
                self.assertNotIn("--cookies-from-browser", args)
                self.assertEqual(args[args.index("-S") + 1], "res:1080")
            self.assertEqual(calls[0][-1], "https://www.youtube.com/watch?v=abcdefghijk")
            for args in calls[1:]:
                self.assertIn("--load-info-json", args)
                self.assertEqual(Path(args[-1]).name, "download.info.json")
                self.assertNotIn("https://www.youtube.com/watch?v=abcdefghijk", args)
        finally:
            jobs.close()

    def test_mislabelled_playlist_is_rejected_as_media(self):
        fake = self.root / "playlist.mp4"
        fake.write_text("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nfile:///secret\n#EXT-X-ENDLIST\n", encoding="utf-8")
        with self.assertRaises(WatchError):
            media.probe(fake, Runner(self.root, self.root))

    def test_native_images_through_stdio_protocol(self):
        child = subprocess.Popen([sys.executable, "-B", "-u", str(PLUGIN / "tools" / "server.py"), "--data-dir", str(self.data)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        sequence = 0
        def rpc(method, params=None):
            nonlocal sequence
            sequence += 1
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sequence, "method": method, "params": params or {}}) + "\n")
            child.stdin.flush()
            response = json.loads(child.stdout.readline())
            self.assertEqual(response["id"], sequence)
            return response["result"]
        try:
            self.assertEqual(rpc("initialize", {"protocolVersion": "2025-03-26", "clientInfo": {"name": "test", "version": "1"}, "capabilities": {}})["protocolVersion"], "2025-03-26")
            names = {tool["name"] for tool in rpc("tools/list")["tools"]}
            self.assertEqual(len(names), 7)
            self.assertNotIn("shell", names)
            start = rpc("tools/call", {"name": "watch_start", "arguments": {"source": self.source, "frame_count": 6, "sampling": "uniform"}})
            self.assertFalse(start["isError"], start)
            identity = start["structuredContent"]["job_id"]
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                status = rpc("tools/call", {"name": "watch_status", "arguments": {"job_id": identity}})["structuredContent"]
                if status["status"] in {"ready", "failed"}:
                    break
                time.sleep(0.1)
            self.assertEqual(status["status"], "ready", status)
            page = rpc("tools/call", {"name": "watch_frames", "arguments": {"job_id": identity}})
            self.assertEqual(sum(item["type"] == "image" for item in page["content"]), 4)
            self.assertEqual(page["structuredContent"]["next_offset"], 4)
            bad = rpc("tools/call", {"name": "watch_start", "arguments": {"source": str(self.video)}})
            self.assertTrue(bad["isError"])
        finally:
            child.stdin.close()
            child.wait(timeout=15)
            stderr = child.stderr.read()
            child.stdout.close()
            child.stderr.close()
            self.assertEqual(child.returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
