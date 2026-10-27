"""Storyboard fixtures use real image crops and never request a video download."""
import io
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/watch/tools"))
from PIL import Image
from preview import read_preview, timeline, cdn_url
from common import WatchError
import server

BV = "BV1234567890"


class Fixture:
    def __init__(self):
        self.calls = []
        self.view = {"bvid": BV, "pages": [{"cid": 11, "duration": 90}, {"cid": 22, "duration": 40}]}
        self.shot = {"index": [0, 10, 20, 30], "image": ["https://i0.hdslb.com/bfs/videoshot/sheet.jpg"],
                     "img_x_size": 20, "img_y_size": 10, "img_x_len": 2, "img_y_len": 2}
        image = Image.new("RGB", (40, 20))
        for i, color in enumerate(("red", "green", "blue", "white")):
            image.paste(color, (i % 2 * 20, i // 2 * 10, (i % 2 + 1) * 20, (i // 2 + 1) * 10))
        output = io.BytesIO()
        image.save(output, "PNG")
        self.image = output.getvalue()

    def fetch(self, url, limit):
        self.calls.append(url)
        if "/view?" in url:
            return json.dumps({"code": 0, "data": self.view}).encode()
        if "/videoshot?" in url:
            return json.dumps({"code": 0, "data": self.shot}).encode()
        if url.endswith(".bin"):
            return struct.pack(">4H", 0, 10, 20, 30)
        return self.image

    def read(self, **kwargs):
        return read_preview({"url": f"https://www.bilibili.com/video/{BV}?p=2", "start": 0, "end": 40, **kwargs}, self.fetch)


class PreviewTests(unittest.TestCase):
    def test_part_and_real_tiles(self):
        f = Fixture()
        result = f.read()
        self.assertEqual(result["status"], "completed")
        self.assertEqual((result["part"], result["cid"]), (2, 22))
        query = parse_qs(urlparse(f.calls[1]).query)
        self.assertEqual(query["cid"], ["22"])
        self.assertEqual([frame["timestamp"] for frame in result["frames"]], [10, 20, 30])
        import base64
        tile = Image.open(io.BytesIO(base64.b64decode(result["frames"][1]["data"])))
        self.assertEqual(tile.size, (20, 10))
        self.assertGreater(tile.getpixel((5, 5))[2], 240, "second returned frame is the blue tile at 20s")
        self.assertEqual(len(f.calls), 3, "two API requests and one shared sheet, without video transfer")

    def test_request_time_is_distinct_from_actual_time(self):
        result = Fixture().read(start=11, end=29)
        self.assertEqual(len(result["frames"]), 1)
        self.assertEqual(result["frames"][0]["timestamp"], 20)
        self.assertNotEqual(result["samples"][0]["requested"], result["samples"][0]["actual"])
        self.assertTrue(result["incomplete"])

    def test_millisecond_and_binary_indices(self):
        f = Fixture()
        f.shot["index"] = [0, 10000, 20000, 30000]
        self.assertEqual([frame["timestamp"] for frame in f.read()["frames"]], [10, 20, 30])
        f.shot["index"] = []
        f.shot["pvdata"] = "https://i0.hdslb.com/bfs/videoshot/index.bin"
        self.assertEqual([frame["timestamp"] for frame in f.read()["frames"]], [10, 20, 30])
        self.assertEqual(timeline({"index": [0, 20000, 30000]}, 40000, f.fetch)[-1][1], 30000)

    def test_later_sheet_keeps_global_index(self):
        f = Fixture()
        f.view["pages"][1]["duration"] = 80
        f.shot["index"] = list(range(0, 80, 10))
        f.shot["image"].append("https://i1.hdslb.com/bfs/videoshot/second.jpg")
        result = f.read(start=40, end=80)
        self.assertEqual([frame["timestamp"] for frame in result["frames"]], [50, 60, 70])
        self.assertEqual(len(f.calls), 4)

    def test_unavailable_never_switches_part_or_downloads(self):
        f = Fixture()
        self.assertEqual(f.read(url=f"https://www.bilibili.com/video/{BV}?p=3")["status"], "unavailable")
        self.assertEqual(len(f.calls), 1)
        f = Fixture()
        f.shot["cid"] = 11
        self.assertEqual(f.read()["status"], "unavailable")
        self.assertEqual(len(f.calls), 2)
        f = Fixture()
        self.assertEqual(f.read(start=31, end=39)["status"], "unavailable")
        self.assertEqual(len(f.calls), 2)

    def test_unsupported_source_and_bad_cdn_do_not_fetch(self):
        f = Fixture()
        self.assertEqual(f.read(url="https://www.youtube.com/watch?v=abcdefghijk")["status"], "unavailable")
        self.assertEqual(f.calls, [])
        for url in ("https://hdslb.com.evil.test/a", "https://localhost/a", "https://user:pass@i0.hdslb.com/a", "https://i0.hdslb.com:8080/a"):
            with self.assertRaises(WatchError):
                cdn_url(url)
        f.shot["image"] = ["https://localhost/file"]
        self.assertEqual(f.read()["status"], "unavailable")
        self.assertEqual(len(f.calls), 2)

    def test_invalid_index_and_crop_fail_closed(self):
        for values in ([0, 20, 10], [0, float("nan")], [0, "10"]):
            f = Fixture()
            f.shot["index"] = values
            self.assertEqual(f.read()["status"], "unavailable")
        f = Fixture()
        f.shot["img_x_size"] = 21
        self.assertEqual(f.read()["status"], "unavailable")

    def test_mcp_images_and_structured_media_contract(self):
        value = Fixture().read()
        with patch("preview.read_preview", return_value=value):
            result = server.call(None, "watch_preview", {"url": f"https://www.bilibili.com/video/{BV}", "start": 0, "end": 40})
        self.assertFalse(result["isError"])
        self.assertEqual(len(result["structuredContent"]["frames"]), 3)
        self.assertEqual(len([block for block in result["content"] if block["type"] == "image"]), 3)
        self.assertNotIn('"data"', result["content"][0]["text"], "base64 stays out of model text")


if __name__ == "__main__":
    unittest.main()
