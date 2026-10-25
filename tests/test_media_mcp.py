import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
import shutil
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("media_server", Path(__file__).parents[1] / "plugins/bilibili-explorer/media-mcp/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class MediaTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for local synthetic backup verification')
    def test_backup_integrity_and_namespace(self):
        from unittest.mock import patch
        import sys
        with tempfile.TemporaryDirectory(prefix='openbot-backup-test-') as root:
            jobs = server.MediaJobs(Path(root) / 'jobs')
            calls = []
            class Downloader:
                def __init__(self, options): self.options = options
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def extract_info(self, url, download):
                    calls.append(url)
                    self_file = self.options['outtmpl'].replace('%(ext)s', 'mp4')
                    jobs.command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=64x64:rate=5',
                                  '-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '1', '-pix_fmt', 'yuv420p', self_file])
                    return {'title': 'Synthetic only', 'duration': 1, 'acodec': 'aac'}
            with patch.dict(sys.modules, {'yt_dlp': SimpleNamespace(YoutubeDL=Downloader)}), patch.dict(server.os.environ, {'OPENBOT_BACKUP_DIR': str(Path(root) / 'backups')}):
                url = 'https://www.bilibili.com/video/BV1234567890/?p=1'
                first = jobs.backup('1' * 32, url, 'a' * 64)
                second = jobs.backup('2' * 32, url, 'a' * 64)
                self.assertEqual(first, second)
                self.assertEqual(len(calls), 1)
                other = jobs.backup('3' * 32, url, 'b' * 64)
                self.assertNotEqual(first['backup']['path'], other['backup']['path'])
                self.assertTrue(jobs.valid_backup(first['backup']))
                Path(first['backup']['path']).write_bytes(b'corrupted')
                self.assertFalse(jobs.valid_backup(first['backup']))
                repaired = jobs.backup('4' * 32, url, 'a' * 64)
                self.assertTrue(jobs.valid_backup(repaired['backup']))
                self.assertEqual(len(calls), 3)
                with self.assertRaisesRegex(ValueError, 'namespace'):
                    jobs.start('backup', url, 0, 1, 'bad')
                with patch.dict(server.os.environ, {'OPENBOT_BACKUP_MAX_TOTAL_GB': '0'}):
                    with self.assertRaisesRegex(ValueError, 'positive'):
                        jobs.backup('5' * 32, url.replace('p=1', 'p=2'), 'a' * 64)
            jobs.pool.shutdown(wait=True)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg not installed; no automatic installation")
    def test_real_frame_extraction(self):
        with tempfile.TemporaryDirectory(prefix="openbot-media-test-") as root:
            directory = Path(root)
            jobs = server.MediaJobs(directory / "jobs")
            video = directory / "synthetic.mp4"
            jobs.command(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                          "-i", "testsrc=size=320x180:rate=10", "-t", "2", "-pix_fmt", "yuv420p", str(video)])
            jobs.download = lambda *args: video
            result = jobs.process(directory, "frames", "https://www.bilibili.com/video/BV1234567890/", 300, 302, 2, "auto")
            self.assertEqual([f["timestamp"] for f in result["frames"]], [300.5, 301.5])
            self.assertTrue(all(server.base64.b64decode(f["data"]).startswith(b"\xff\xd8") for f in result["frames"]))
            static = directory / "still.mp4"
            jobs.command(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                          "-i", "color=c=blue:size=320x180:rate=10", "-t", "2", "-pix_fmt", "yuv420p", str(static)])
            jobs.download = lambda *args: static
            stable = jobs.process(directory, "frames", "https://www.bilibili.com/video/BV1234567890/", 0, 2, 4, "auto")
            self.assertEqual(len(stable["frames"]), 1, "identical static frames are deduplicated")
            jobs.pool.shutdown(wait=True)

    def test_timestamps_and_source(self):
        result = server.normalize_segments([SimpleNamespace(start=1, end=9, text=" hello ")], 300, 305)
        self.assertEqual(result, [{"start": 301, "end": 305, "text": "hello"}])
        for url in ("http://www.bilibili.com/video/abc", "https://localhost/private", "https://user:secret@www.bilibili.com/video/abc"):
            with self.assertRaises(ValueError):
                server.source_url(url)

    def test_queue_resume_and_dedup(self):
        with tempfile.TemporaryDirectory(prefix="openbot-media-test-") as root:
            jobs = server.MediaJobs(Path(root))
            gate = threading.Event()
            calls = []
            def process(*args):
                calls.append(args)
                gate.wait(3)
                return {"segments": [{"start": 0, "end": 1, "text": "hello"}]}
            jobs.process = process
            first = jobs.start("transcribe", "https://www.bilibili.com/video/BV1234567890/", 0, 10, "stable")
            second = jobs.start("transcribe", "https://www.bilibili.com/video/BV1234567890/", 0, 10, "stable")
            self.assertEqual(first["jobId"], second["jobId"])
            with self.assertRaises(ValueError):
                jobs.start("transcribe", "https://www.bilibili.com/video/BV1234567890/", 0, 20, "stable")
            gate.set()
            jobs.pool.shutdown(wait=True)
            self.assertEqual(len(calls), 1)
            self.assertEqual(jobs.status(first["jobId"])["status"], "completed")
            resumed = server.MediaJobs(Path(root))
            self.assertEqual(resumed.status(first["jobId"])["segments"][0]["text"], "hello")
            resumed.pool.shutdown(wait=True)

    def test_restart_and_no_implicit_model_download(self):
        with tempfile.TemporaryDirectory(prefix="openbot-media-test-") as root:
            jobs = server.MediaJobs(Path(root))
            jobs.write("a" * 32, {"status": "running", "fingerprint": "old"})
            jobs.pool.shutdown(wait=True)
            resumed = server.MediaJobs(Path(root))
            self.assertEqual(resumed.status("a" * 32)["status"], "failed")
            self.assertEqual(resumed.status("a" * 32)["fingerprint"], "old")
            from unittest.mock import patch
            with patch.dict(server.os.environ, {"OPENBOT_ASR_MODEL_DIR": ""}):
                with self.assertRaisesRegex(ValueError, "explicitly"):
                    resumed.process(Path(root), "transcribe", "https://www.bilibili.com/video/BV1234567890/", 0, 10, 12, "auto")
            resumed.pool.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
