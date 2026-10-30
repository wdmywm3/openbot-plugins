"""Browser capture evidence keeps original timestamps, scope and existing readers."""
import base64
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
import wave
import struct
import shutil
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/watch/tools"))
from common import WatchError, Runner
from jobs import Jobs
from ingest import ingest
import browser_media
import server
from PIL import Image


class BrowserEvidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.jobs = Jobs(self.temp.name)
        self.jobs.host_bridge = True
        self.namespace = "d" * 64

    def tearDown(self):
        self.jobs.close()
        self.temp.cleanup()

    def asset(self, color):
        output = io.BytesIO()
        Image.new("RGB", (320, 180), color).save(output, format="JPEG")
        data = output.getvalue()
        upload = ingest(self.jobs, {"action": "begin", "namespace": self.namespace, "kind": "image", "name": "frame.jpg", "size": len(data)})
        args = {"namespace": self.namespace, "upload_id": upload["upload_id"]}
        ingest(self.jobs, {**args, "action": "append", "offset": 0, "base64": base64.b64encode(data).decode()})
        return ingest(self.jobs, {**args, "action": "finish"})["asset_id"]

    def request(self):
        return {"source": "https://example.org/player", "start_seconds": 10, "end_seconds": 15,
                "timestamps": [10.5, 13.5], "request_id": str(uuid.uuid4())}

    def args(self):
        return {"action": "finish", "namespace": self.namespace, "request": self.request(), "info": {
            "duration": 90, "title": "Page video", "tab_id": "tab", "media_id": "media",
            "captions": {"language": "en", "segments": [{"start": 10.2, "end": 12, "text": "Actual caption"}]},
            "frames": [{"asset_id": self.asset("red"), "requested": 10.5, "timestamp": 10.5, "view": "element"},
                       {"asset_id": self.asset("blue"), "requested": 13.5, "timestamp": 13.6, "view": "element"}]}}

    def wait(self, identity):
        until = time.monotonic() + 10
        while time.monotonic() < until:
            state = self.jobs.status(identity)
            if state["status"] in {"ready", "failed"}: return state
            time.sleep(0.05)
        self.fail("Browser evidence did not finish")

    def test_capture_storyboard_transcript_revisit_and_idempotency(self):
        args = self.args()
        started = browser_media.dispatch(self.jobs, args)
        state = self.wait(started["job_id"])
        self.assertEqual(state["status"], "ready", state)
        result = state["result"]
        self.assertEqual(result["coverage"]["observed_timestamps"], [10.5, 13.6])
        self.assertEqual(result["mode"], "browser")
        self.assertEqual(result["transcript"]["source"], "browser_text_track")
        page, images = self.jobs.storyboard(started["job_id"])
        self.assertEqual(len(page["cells"]), 2)
        self.assertTrue(any(b["type"] == "image" for b in images))
        self.assertEqual(self.jobs.transcript(started["job_id"])["segments"][0]["start"], 10.2)
        self.assertEqual(browser_media.dispatch(self.jobs, args)["job_id"], started["job_id"])
        prior = browser_media.dispatch(self.jobs, {"action": "source", "namespace": self.namespace, "job_id": started["job_id"], "cell_id": 1})
        self.assertEqual(prior["source"], args["request"]["source"])
        self.assertLess(prior["end_seconds"], 15)
        with self.assertRaises(WatchError):
            browser_media.dispatch(self.jobs, {"action": "source", "namespace": "a" * 64, "job_id": started["job_id"]})

    def test_boundaries_and_scoped_assets(self):
        planned = browser_media.plan({"source": "https://example.org/page", "end_seconds": 300}, 600)
        self.assertEqual(planned["end"], 60)
        self.assertTrue(planned["warnings"])
        args = self.args(); args["namespace"] = "a" * 64
        with self.assertRaises(WatchError): browser_media.dispatch(self.jobs, args)
        args = self.args(); args["info"]["frames"][0]["timestamp"] = 20
        with self.assertRaises(WatchError): browser_media.dispatch(self.jobs, args)
        self.jobs.host_bridge = False
        self.assertTrue(server.call(self.jobs, "watch_browser", {"action": "plan", "namespace": self.namespace, "request": self.request(), "duration": 90})["isError"])

    def test_browser_crop_uses_captured_pixels(self):
        args = self.args(); args["request"]["crop"] = {"x": 10, "y": 20, "width": 50, "height": 40}
        state = self.wait(browser_media.dispatch(self.jobs, args)["job_id"])
        self.assertEqual(state["status"], "ready", state)
        self.assertEqual(state["result"]["frame_view"]["width"], 50)
        self.assertEqual(state["result"]["frame_view"]["coordinate_space"], "browser_capture")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
    def test_audio_decode_and_transcript_offset(self):
        args = self.args(); args["info"]["captions"] = {"segments": []}
        raw = io.BytesIO()
        with wave.open(raw, "wb") as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
            audio.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(33600)))
        data = raw.getvalue()
        upload = ingest(self.jobs, {"action": "begin", "namespace": self.namespace, "kind": "audio", "name": "audio.wav", "size": len(data)})
        fields = {"namespace": self.namespace, "upload_id": upload["upload_id"]}
        for offset in range(0, len(data), 36000):
            ingest(self.jobs, {**fields, "action": "append", "offset": offset, "base64": base64.b64encode(data[offset:offset+36000]).decode()})
        asset = ingest(self.jobs, {**fields, "action": "finish"})["asset_id"]
        args["info"]["audio"] = [{"asset_id": asset, "start": 10.2, "end": 12.2, "leadSeconds": 0.1}]
        self.jobs.settings["asr_model_path"] = "fixture-model"
        original = Runner.run
        def run(runner, command, timeout=120):
            if any(str(a).endswith("transcribe.py") for a in command):
                with wave.open(command[command.index("--audio")+1], "rb") as audio:
                    self.assertEqual(audio.getframerate(), 16000)
                    self.assertAlmostEqual(audio.getnframes()/16000, 2, delta=0.02)
                Path(command[command.index("--output")+1]).write_text(json.dumps({"segments": [{"start": 0.25, "end": 0.75, "text": "Audio evidence"}], "language": "en"}))
                return "", ""
            return original(runner, command, timeout)
        with patch.object(Runner, "run", run):
            state = self.wait(browser_media.dispatch(self.jobs, args)["job_id"])
        self.assertEqual(state["status"], "ready", state)
        transcript = self.jobs.transcript(state["job_id"])
        self.assertEqual(transcript["source"], "browser_audio_asr")
        self.assertEqual(transcript["segments"][0]["start"], 10.45)
        self.assertEqual(transcript["segments"][0]["end"], 10.95)


if __name__ == "__main__": unittest.main()
