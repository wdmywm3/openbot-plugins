"""Adaptive sampling, immutable storyboard addressing and real FFmpeg evidence."""
import base64
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/watch/tools"))
from common import Cancelled, Runner, WatchError, read_json, write_json
from jobs import Jobs, import_video
import media
import server
import storyboard
from watch_test import wait_job


class PlanningTests(unittest.TestCase):
    def test_dense_section_gets_more_samples_without_losing_quiet_tail(self):
        cuts = [8 + i * 0.3 for i in range(21)]
        ranges = storyboard.plan_ranges(0, 20, 12, cuts)
        self.assertEqual(ranges[0]["start_seconds"], 0)
        self.assertEqual(ranges[-1]["end_seconds"], 20)
        for previous, current in zip(ranges, ranges[1:]):
            self.assertEqual(previous["end_seconds"], current["start_seconds"])
        dense = [r for r in ranges if 8 <= (r["start_seconds"] + r["end_seconds"]) / 2 < 14]
        self.assertGreater(len(dense), 12 * 6 / 20)
        self.assertLess(max(r["end_seconds"] - r["start_seconds"] for r in ranges), 20 / 12 * 2.5)
        self.assertEqual(storyboard.candidate_points(ranges)[0], [0])
        self.assertGreater(storyboard.candidate_points(ranges)[-1][0], 19.5)

    def test_short_static_and_offset_ranges_are_ordered(self):
        for start, end in ((12.3, 12.4), (100, 130), (0, 600)):
            ranges = storyboard.plan_ranges(start, end, 24)
            self.assertEqual(ranges[0]["start_seconds"], start)
            self.assertEqual(ranges[-1]["end_seconds"], end)
            for window in ranges:
                self.assertGreater(window["end_seconds"], window["start_seconds"])

    def test_speech_density_also_affects_static_video(self):
        plain = storyboard.plan_ranges(0, 30, 9)
        speech = storyboard.plan_ranges(0, 30, 9, segments=[{"start": 12, "end": 18, "text": "字幕" * 100}])
        self.assertNotEqual(plain, speech)
        self.assertEqual(speech[-1]["end_seconds"], 30)

    def test_scene_threshold_ignores_constant_motion_but_retains_short_cuts(self):
        samples = [(i / 30, 0.02) for i in range(300)]
        self.assertEqual(media.adaptive_cuts(samples), [])
        for index in (90, 91, 100, 130):
            samples[index] = (index / 30, 0.5)
        self.assertEqual(len(media.adaptive_cuts(samples)), 3)

    def test_caption_excerpt_preserves_times_and_marks_truncation(self):
        segments = [{"start": 8, "end": 13, "text": "字" * 500}, {"start": 14, "end": 15, "text": "后续"}]
        excerpt = storyboard.align_transcript({"start_seconds": 10, "end_seconds": 16}, segments)
        self.assertEqual(excerpt["lines"][0]["start"], 8)
        self.assertEqual(excerpt["segment_count"], 2)
        self.assertTrue(excerpt["truncated"])
        self.assertEqual(len(excerpt["lines"][0]["text"]), 400)
        self.assertEqual(segments[0]["text"], "字" * 500)

    def test_laplacian_prefers_clear_text_to_blurred_candidate(self):
        image = Image.new("RGB", (320, 180), "white")
        draw = ImageDraw.Draw(image)
        for x in range(10, 300, 10):
            draw.line((x, 10, x, 160), fill="black", width=2)
        self.assertGreater(storyboard.sharpness(image), storyboard.sharpness(image.filter(ImageFilter.GaussianBlur(4))) * 5)

    def test_missing_interval_is_not_assigned_an_outside_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Image.new("RGB", (160, 90), "blue").save(root / "frame.jpg")
            frames = [{"index": 0, "file": "frame.jpg", "observations": [
                {"requested_seconds": 0, "timestamp_seconds": 0}, {"requested_seconds": 1, "timestamp_seconds": 2}]}]
            ranges = [{"start_seconds": 0, "end_seconds": 1}, {"start_seconds": 1, "end_seconds": 2}]
            result = storyboard.render(root, ranges, [0, 1], frames, [], {"width": 160, "height": 90}, None, Runner(root, root))
            self.assertEqual(result["cells"], 1)
            self.assertEqual(result["missing_cells"][0]["cell_id"], 2)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class StoryboardMediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.jobs = Jobs(self.data)

    def tearDown(self):
        self.jobs.close()
        self.temporary.cleanup()

    def video(self, name="clip", filter="testsrc2=size=640x360:rate=10:duration=8", extra=()):
        path = self.root / (name + ".mp4")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", filter,
                        *extra, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True, capture_output=True, timeout=30)
        return path

    def start(self, source, **kwargs):
        job_id = self.jobs.start({"source": source, **kwargs})["job_id"]
        state = wait_job(self.jobs, job_id, timeout=45)
        self.assertEqual(state["status"], "ready", state)
        return job_id, state["result"]

    def test_storyboard_zoom_reuses_original_source_and_survives_new_jobs_and_restart(self):
        video = self.video()
        captions = self.root / "captions.srt"
        captions.write_text("1\n00:00:00,000 --> 00:00:04,000\n第一步\n\n2\n00:00:04,000 --> 00:00:08,000\n第二步\n", encoding="utf-8")
        source = import_video(self.data, video, captions)["source"]
        job_id, result = self.start(source, frame_count=6)
        self.assertEqual(result["sampling"], "adaptive_clear")
        self.assertTrue(result["storyboard"]["available"], result)
        response = server.call(self.jobs, "watch_storyboard", {"job_id": job_id})
        self.assertFalse(response["isError"], response)
        board = response["structuredContent"]
        self.assertEqual(len(board["cells"]), 6)
        self.assertEqual(board["transcript_source"], "imported_subtitles")
        self.assertTrue(any(c["transcript"]["lines"] for c in board["cells"]))
        self.assertNotIn(str(self.data), str(board))
        image = Image.open(io.BytesIO(base64.b64decode(response["content"][1]["data"])))
        self.assertEqual(image.size, (board["width"], board["height"]))
        # A later overview of the same file must not replace the first one's cells.
        other, _ = self.start("watch:" + job_id, start_seconds=4, end_seconds=8, frame_count=2)
        self.jobs.close()
        self.jobs = Jobs(self.data)
        crop = {"x": 100, "y": 100, "width": 180, "height": 100}
        request_id = uuid.uuid4().hex
        with patch("media.expand_short_url", side_effect=AssertionError("zoom accessed network")):
            zoom = server.call(self.jobs, "watch_zoom", {"job_id": job_id, "cell_id": 2, "frame_count": 3,
                                                       "crop": crop, "request_id": request_id})
            self.assertFalse(zoom["isError"], zoom)
            zoom_id = zoom["structuredContent"]["job_id"]
            focused = wait_job(self.jobs, zoom_id)
            self.assertEqual(focused["status"], "ready", focused)
            self.assertEqual(focused["result"]["range"], board["cells"][1]["range"])
            self.assertEqual(focused["result"]["focus_cell"], {"job_id": job_id, "cell_id": 2})
            self.assertEqual(focused["result"]["frame_view"]["crop"], crop)
            self.assertEqual(self.jobs.zoom(job_id, 2, 3, crop, request_id)["job_id"], zoom_id)
            with self.assertRaises(WatchError):
                self.jobs.zoom(other, 2, 3, crop, request_id)
        for args in ({"job_id": job_id, "cell_id": 24}, {"job_id": job_id, "cell_id": True},
                     {"job_id": job_id, "cell_id": 1, "crop": {"x": -1, "y": 0, "width": 2, "height": 2}},
                     {"job_id": "a" * 32, "cell_id": 1}):
            self.assertTrue(server.call(self.jobs, "watch_zoom", args)["isError"], args)
        self.assertTrue(server.call(self.jobs, "watch_storyboard", {"job_id": job_id, "page": 1})["isError"])

    def test_static_dedup_keeps_each_cell_and_second_sheet(self):
        source = import_video(self.data, self.video(filter="color=blue:size=160x90:rate=10:duration=8"))["source"]
        job_id, result = self.start(source, frame_count=24, sampling="uniform")
        self.assertEqual(result["frame_count"], 1)
        first, _ = self.jobs.storyboard(job_id)
        second, _ = self.jobs.storyboard(job_id, 1)
        self.assertEqual(first["next_page"], 1)
        self.assertIsNone(second["next_page"])
        cells = first["cells"] + second["cells"]
        self.assertEqual(len(cells), 24)
        self.assertEqual([c["cell_id"] for c in cells], list(range(1, 25)))
        self.assertGreaterEqual(cells[-1]["timestamp_seconds"], 7.5)
        self.assertEqual(len({c["timestamp_seconds"] for c in cells}), 24)

    def test_portrait_edges_survive_contact_sheet_and_crop_coordinates_remain_original(self):
        filter = "color=black:size=180x320:rate=5:duration=3,drawbox=x=0:y=0:w=8:h=ih:color=red:t=fill,drawbox=x=iw-8:y=0:w=8:h=ih:color=blue:t=fill"
        source = import_video(self.data, self.video(filter=filter))["source"]
        job_id, _ = self.start(source, timestamps=[0, 1, 2])
        board, content = self.jobs.storyboard(job_id)
        self.assertEqual(board["source_view"], {"source_width": 180, "source_height": 320, "crop": None})
        image = Image.open(io.BytesIO(base64.b64decode(content[0]["data"])))
        rect = board["cells"][0]["image_rect"]
        left = image.getpixel((rect["x"] + 3, rect["y"] + rect["height"] // 2))
        right = image.getpixel((rect["x"] + rect["width"] - 4, rect["y"] + rect["height"] // 2))
        self.assertGreater(left[0], left[2] + 100)
        self.assertGreater(right[2], right[0] + 100)

    def test_explicit_timestamps_bypass_automatic_selection(self):
        source = import_video(self.data, self.video())["source"]
        with patch("media.select_clear_points", side_effect=AssertionError("explicit time was moved")), patch("media.scene_times", side_effect=AssertionError("unneeded scan")):
            job_id, result = self.start(source, start_seconds=1, end_seconds=7, timestamps=[1.2, 6.2])
        self.assertEqual(result["sampling"], "explicit")
        self.assertEqual(result["coverage"]["observed_timestamps"], [1.2, 6.2])
        board, _ = self.jobs.storyboard(job_id)
        self.assertEqual([c["timestamp_seconds"] for c in board["cells"]], [1.2, 6.2])

    def test_clear_selection_avoids_blurred_middle_candidate(self):
        filter = "testsrc2=size=320x180:rate=10:duration=6,gblur=sigma=12:enable='between(t,2.5,3.5)'"
        video = self.video(filter=filter)
        ranges = [{"start_seconds": n, "end_seconds": n + 2} for n in (0, 2, 4)]
        chosen = media.select_clear_points(video, ranges, self.root, Runner(self.root, self.root))
        self.assertFalse(2.5 <= chosen[1] <= 3.5, chosen)
        self.assertFalse(list(self.root.glob("candidates-*")))

    def test_vfr_scan_and_sample_times_use_decoded_pts(self):
        video = self.video(filter="color=red:size=160x90:rate=10:duration=6,drawbox=color=blue:t=fill:enable='gte(t,3)',select='if(lt(t,3),1,not(mod(n,4)))'", extra=("-fps_mode", "vfr"))
        cuts = media.scene_times(video, 1, 6, Runner(self.root, self.root))
        self.assertTrue(any(3 <= t <= 3.3 for t in cuts), cuts)
        source = import_video(self.data, video)["source"]
        job_id, result = self.start(source, start_seconds=1, end_seconds=5.5, frame_count=6)
        self.assertEqual(result["sampling"], "adaptive_clear")
        board, _ = self.jobs.storyboard(job_id)
        for cell in board["cells"]:
            self.assertGreaterEqual(cell["timestamp_seconds"], cell["range"]["start_seconds"])
            self.assertLess(cell["timestamp_seconds"], cell["range"]["end_seconds"])

    def test_selection_fallback_is_explicit_and_cancellation_is_not_swallowed(self):
        source = import_video(self.data, self.video())["source"]
        with patch("media.select_clear_points", side_effect=WatchError("fixture selection unavailable")):
            _, result = self.start(source, frame_count=3)
        self.assertEqual(result["sampling"], "uniform_fallback")
        self.assertTrue(any("定时采样" in text for text in result["warnings"]))
        with patch("media.select_clear_points", side_effect=Cancelled("读取已取消")):
            job_id = self.jobs.start({"source": source, "frame_count": 3})["job_id"]
            self.assertEqual(wait_job(self.jobs, job_id)["status"], "cancelled")
        self.jobs.close()  # Wait for the worker's final file cleanup as well.
        self.assertEqual([p.name for p in self.jobs.directory(job_id).iterdir()], ["job.json"])

    def test_legacy_job_without_storyboard_remains_readable(self):
        source = import_video(self.data, self.video())["source"]
        job_id, _ = self.start(source, timestamps=[1])
        (self.jobs.directory(job_id) / "storyboard.json").unlink()
        self.assertTrue(server.call(self.jobs, "watch_storyboard", {"job_id": job_id})["isError"])
        self.assertTrue(server.call(self.jobs, "watch_zoom", {"job_id": job_id, "cell_id": 1})["isError"])
        page, content = self.jobs.frames(job_id)
        self.assertEqual(page["total"], 1)
        self.assertTrue(any(item["type"] == "image" for item in content))


if __name__ == "__main__":
    unittest.main()
