"""Caption-first reading, local setup recovery, and audio evidence regressions."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/watch/tools"))
import asr
import media
import setup_asr
from common import Runner, WatchError, write_json
from jobs import Jobs, import_video


class ModelSetup(unittest.TestCase):
    def test_resume_integrity_and_ignored_range(self):
        raw = b"trusted model bytes"
        spec = {"path": "model.bin", "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        class Opener:
            def __init__(self, payload, status): self.payload, self.status = payload, status
            def open(self, request, timeout):
                self.request = request
                stream = io.BytesIO(self.payload)
                stream.status = self.status
                stream.headers = {"Content-Range": f"bytes 4-{len(raw)-1}/{len(raw)}"}
                return stream
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            for code in (206, 200):
                (folder / "model.bin.part").write_bytes(raw[:4])
                (folder / "model.bin").unlink(missing_ok=True)
                opener = Opener(raw[4:] if code == 206 else raw, code)
                setup_asr.download_file(folder, spec, "test/model", "pinned", opener)
                self.assertEqual(opener.request.get_header("Range"), "bytes=4-")
                self.assertEqual((folder / "model.bin").read_bytes(), raw)
                self.assertFalse((folder / "model.bin.part").exists())
            (folder / "model.bin").write_bytes(b"corrupt")
            with self.assertRaises(WatchError):
                setup_asr.download_file(folder, spec, "test/model", "pinned", Opener(b"x" * len(raw), 200))
            self.assertFalse((folder / "model.bin.part").exists())

    def test_failed_warmup_does_not_mark_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            with patch("asr.status", return_value={"ready": False}), patch("transcribe.run", side_effect=ValueError("bad model")):
                with self.assertRaises(ValueError): setup_asr.prepare(folder, folder / "custom")
            self.assertFalse((folder / "models/ready.json").exists())

    def test_owner_config_and_legacy_model_are_independent_of_chat_input(self):
        with tempfile.TemporaryDirectory() as temp:
            write_json(Path(temp) / "settings.json", {"asr_model_path": str(Path(temp) / "custom"), "local_roots": [temp]})
            jobs = Jobs(temp, owner_config={"asrBackend": "none", "asrLanguage": "zh"})
            try:
                self.assertFalse(asr.configured(jobs.settings))
                self.assertEqual(jobs.settings["asr_model_path"], str(Path(temp) / "custom"))
                self.assertEqual(jobs.info()["asr"]["state"], "disabled")
            finally: jobs.close()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class Pipeline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.jobs = Jobs(self.root / "data")
        self.wav = self.root / "sound.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", str(self.wav)], check=True)

    def tearDown(self):
        self.jobs.close(); self.temp.cleanup()

    def wait(self, args):
        identity = self.jobs.start(args)["job_id"]
        until = time.monotonic() + 20
        while time.monotonic() < until:
            state = self.jobs.status(identity)
            if state["status"] in {"ready", "failed"}: return state
            time.sleep(0.02)
        self.fail("job timed out")

    def test_audio_only_is_accepted_without_making_up_frames(self):
        source = import_video(self.jobs.root, self.wav)["source"]
        state = self.wait({"source": source, "audio": "off"})
        self.assertEqual(state["status"], "ready", state)
        result = state["result"]
        self.assertFalse(result["media"]["has_video"])
        self.assertTrue(result["media"]["has_audio"])
        self.assertEqual(result["frame_count"], 0)
        self.assertEqual(result["transcript"]["state"], "disabled")

    def test_embedded_subtitles_and_quiet_focus_do_not_start_asr(self):
        subtitles = self.root / "captions.srt"
        subtitles.write_text("1\n00:00:00,000 --> 00:00:01,000\nA known subtitle\n", encoding="utf-8")
        video = self.root / "captioned.mkv"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=64x64:d=4", "-i", str(self.wav),
                        "-i", str(subtitles), "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-c:s", "srt", str(video)], check=True)
        self.jobs.settings["asr_backend"] = "local"
        source = import_video(self.jobs.root, video)["source"]
        with patch("asr.prepare", side_effect=AssertionError("captions must avoid ASR")):
            full = self.wait({"source": source, "detail": "transcript"})
            quiet = self.wait({"source": "watch:" + full["job_id"], "start_seconds": 2, "end_seconds": 3, "detail": "transcript"})
        self.assertEqual(full["status"], "ready", full)
        self.assertEqual(full["result"]["transcript"]["source"], "embedded_subtitles")
        self.assertEqual(full["result"]["transcript"]["segment_count"], 1)
        self.assertEqual(quiet["result"]["transcript"]["state"], "no_speech")
        self.assertEqual(quiet["result"]["transcript"]["source"], "embedded_subtitles")

    def test_caption_first_skips_download_or_preserves_text_on_failure(self):
        original = Runner.run
        calls = []
        def fake(runner, args, timeout=120):
            if not any(str(a).endswith("download.py") for a in args): return original(runner, args, timeout)
            if "--dump-single-json" in args:
                return json.dumps({"duration": 4, "title": "Test", "subtitles": {"en": [{"url": "unused"}]}}), ""
            if "--skip-download" in args:
                calls.append("captions")
                (runner.directory / "subtitle.en.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nPreserved evidence\n", encoding="utf-8")
                return "", ""
            calls.append("media")
            raise WatchError("media download failed")
        with patch.object(Runner, "run", fake):
            text = self.wait({"source": "https://example.org/video", "detail": "transcript"})
            self.assertEqual(calls, ["captions"])
            cached = self.wait({"source": "watch:" + text["job_id"], "detail": "transcript"})
            self.assertEqual(cached["result"]["transcript"]["segment_count"], 1)
            self.assertEqual(calls, ["captions"], "cached text must not require the source to be online again")
            partial = self.wait({"source": "https://example.org/video"})
        self.assertEqual(calls, ["captions", "captions", "media"])
        for state in (text, partial):
            self.assertEqual(state["status"], "ready", state)
            self.assertEqual(state["result"]["transcript"]["source"], "publisher_subtitles")
            self.assertEqual(state["result"]["frame_count"], 0)


if __name__ == "__main__": unittest.main()
