import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugins/memewiki/tools"))
from library import Library, card, remote_entry, normalize
from server import dispatch
from PIL import Image


class DictionaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memewiki-test-")
        self.library = Library(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_offline_snapshot_and_unknown(self):
        with patch("library.get_json", side_effect=AssertionError("offline must not fetch")):
            self.assertEqual(self.library.snapshot["entries"], 6668)
            value = self.library.lookup("大水理论")
            self.assertTrue(value["found"])
            self.assertIn("喝", value["entry"]["usage"])
            self.assertIn("长安二求", value["entry"]["origin"])
            self.assertFalse(self.library.lookup("未收录测试词ZXQ九七")['found'])

    def test_normalization(self):
        self.assertEqual(normalize("杂鱼杂鱼"), "杂鱼")
        self.assertEqual(normalize("666666"), "666")
        self.assertEqual(self.library.lookup("大水理论是什么梗")["entry"]["title"], "大水理论")

    def test_online_detail_and_persistence(self):
        title = "测试新梗ZXQ"
        detail = {"title": title, "slug": "new", "content_html": "<h2>来源</h2><p>真实出处</p><h2>用法</h2><p>这是用法</p>"}
        with patch("library.get_json", side_effect=[{"items": [{"title": title, "slug": "new"}]}, {"item": detail}]) as fetch:
            value = self.library.lookup(title, online=True)
            self.assertEqual(value["entry"]["usage"], "这是用法")
            self.assertEqual(fetch.call_count, 2)
        with patch("library.get_json", side_effect=AssertionError("cached")):
            self.assertTrue(Library(self.temp.name).lookup(title, True)["found"])

    def test_online_does_not_substitute_related_word(self):
        with patch("library.get_json", return_value={"items": [{"title": "土鸡", "slug": "土鸡"}]}) as fetch:
            self.assertFalse(self.library.lookup("测试未知词ZXQ", True)["found"])
            self.assertFalse(self.library.lookup("测试未知词ZXQ", True)["found"])
            self.assertEqual(fetch.call_count, 1)

    def test_outage_does_not_poison_cache(self):
        with patch("library.get_json", side_effect=TimeoutError):
            self.assertTrue(self.library.lookup("测试未知词ZXQ", True)["unavailable"])
        with patch("library.get_json", return_value={"items": []}) as fetch:
            self.assertFalse(self.library.lookup("测试未知词ZXQ", True)["found"])
            fetch.assert_called_once()

    def test_sync_keeps_snapshot_and_resumes(self):
        before = hashlib.sha256(self.library.base.read_bytes()).hexdigest()
        new = {"title": "新词ZXQ", "slug": "new", "content_html": "<h2>用法</h2><p>新词含义</p>"}
        with patch("library.get_json", side_effect=[{"items": [{"title": new["title"], "slug": "new"}], "has_more": True}, {"item": new}]):
            state = self.library.sync_step()
            self.assertEqual(state, {"offset": 1, "added": 1, "done": False})
        restarted = Library(self.temp.name)
        with patch("library.get_json", return_value={"items": [], "has_more": False}) as fetch:
            self.assertTrue(restarted.sync_step()["done"])
            self.assertIn("offset=1", fetch.call_args.args[0])
        self.assertEqual(hashlib.sha256(self.library.base.read_bytes()).hexdigest(), before)
        self.assertTrue(restarted.lookup(new["title"])["found"])

    def test_bad_sync_is_non_destructive(self):
        with patch("library.get_json", return_value={"items": [], "has_more": True}):
            with self.assertRaises(ValueError):
                self.library.sync_step()
        self.assertTrue(self.library.lookup("大水理论")["found"])

    def test_render_png(self):
        raw = base64.b64decode(card(self.library.lookup("大水理论")["entry"]))
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.width, 840)
            self.assertLessEqual(image.height, 2200)

    def test_mcp_validation_and_tools(self):
        tools = dispatch(self.library, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
        self.assertEqual(len(tools), 4)
        bad = dispatch(self.library, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "memewiki_lookup", "arguments": {"query": "x", "online": "false"}}})
        self.assertTrue(bad["result"]["isError"])
        self.assertIsNone(dispatch(self.library, {"jsonrpc": "2.0", "method": "notifications/initialized"}))


if __name__ == "__main__":
    unittest.main()
