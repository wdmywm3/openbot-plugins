"""General sources and the private attachment bridge, without network access."""
import base64
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/watch/tools"))
from common import WatchError, write_json
from sources import normalize_source, local_file, validate_url, public_address
from jobs import Jobs
from ingest import ingest
import download
import media
import server


class Sources(unittest.TestCase):
    def test_single_video_generic_pages_and_ambiguous_playlists(self):
        info = {"title": "Single HTML video", "duration": 10, "url": "https://example.org/video.mp4"}
        self.assertEqual(media.single_video_info({"_type": "playlist", "entries": [info]}), info)
        for entries in [[], [info, info]]:
            with self.assertRaises(WatchError): media.single_video_info({"_type": "playlist", "entries": entries})

    def test_general_urls_keep_signed_parameters(self):
        for url in ["http://media.example.org/a.webm?token=a%2F%2Bb&n=1", "https://vimeo.com/1234", "https://archive.org/details/example", "https://example.org:8443/get?file=video"]:
            self.assertEqual(normalize_source(url), url)
        for url in ["http://localhost/a", "http://10.0.0.1/a", "https://[::1]/a", "http://[::ffff:127.0.0.1]/a", "http://169.254.169.254/a", "ftp://example.org/a", "https://a:b@example.org/a", "https://example.org/\nabc"]:
            with self.subTest(url=url), self.assertRaises(WatchError):
                normalize_source(url)
        self.assertFalse(public_address("224.0.0.1"))
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch("socket.getaddrinfo", return_value=rows), self.assertRaises(WatchError):
            validate_url("https://public-name.example/", resolve=True)
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.18.2.30", 443))]
        with patch("socket.getaddrinfo", return_value=rows):
            self.assertEqual(validate_url("https://public-name.example/", resolve=True), "https://public-name.example/")
            with self.assertRaises(WatchError): validate_url("https://198.18.2.30/", resolve=True)

    def test_local_roots_and_file_uri(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            allowed = root / "allowed"
            allowed.mkdir()
            file = allowed / "video file.mp4"
            file.write_bytes(b"video")
            other = root / "outside.mp4"
            other.write_bytes(b"private")
            self.assertEqual(local_file(file.as_uri(), [str(allowed)]), file.resolve())
            for source, roots in [(str(file), []), (str(other), [str(allowed)]), (str(allowed / "../outside.mp4"), [str(allowed)]), (None, [str(allowed)])]:
                with self.assertRaises(WatchError):
                    local_file(source, roots)
            try:
                (allowed / "escape.mp4").symlink_to(other)
            except OSError:
                pass
            else:
                with self.assertRaises(WatchError):
                    local_file(str(allowed / "escape.mp4"), [str(allowed)])

    def test_direct_worker_rejects_oversize_and_preserves_existing_file(self):
        class Headers(dict):
            def get_content_type(self): return "video/mp4"
        class Response(io.BytesIO):
            url = "https://example.org/video.mp4"
            headers = Headers()
        class Opener:
            def open(self, *_args, **_kwargs): return Response(b"123456")
        with tempfile.TemporaryDirectory() as work, patch("download.validate_url", side_effect=lambda value, **kw: value), patch("download.build_opener", return_value=Opener()):
            target = Path(work) / "file.mp4"
            with patch("download.MAX_MEDIA", 5), self.assertRaises(WatchError):
                download.direct(Response.url, target)
            self.assertFalse(target.exists())
            target.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                download.direct(Response.url, target)
            self.assertEqual(target.read_bytes(), b"keep")

    def test_socket_guard_blocks_private_redirect_destination(self):
        # Install only inside patches: never leave socket hooks in the test runner.
        with patch.object(socket, "getaddrinfo", wraps=socket.getaddrinfo), patch.object(socket.socket, "connect"), patch.object(socket.socket, "connect_ex"):
            download.guard_network()
            with socket.socket() as sock, self.assertRaises(OSError):
                sock.connect(("127.0.0.1", 80))

    def test_direct_and_local_do_not_need_ytdlp(self):
        with tempfile.TemporaryDirectory() as work:
            jobs = Jobs(work, processor=lambda *args: {})
            try:
                with patch("jobs.dependencies", return_value={"ffmpeg": True, "ffprobe": True, "yt-dlp": False}):
                    jobs.start({"source": "https://example.org/video.mp4"})
                    jobs.start({"source": "https://example.org/get?id=1", "source_type": "direct"})
                    with self.assertRaises(WatchError):
                        jobs.start({"source": "http://example.org/video-page"})
            finally:
                jobs.close()


class Ingest(unittest.TestCase):
    def test_chunks_scoping_retries_and_completion(self):
        with tempfile.TemporaryDirectory() as work:
            jobs = Jobs(work)
            try:
                ns = "a" * 64
                begin = {"action": "begin", "namespace": ns, "name": "clip.webm", "size": 7, "request_id": str(uuid.uuid4()), "source_id": "event:0"}
                upload = ingest(jobs, begin)
                args = {"namespace": ns, "upload_id": upload["upload_id"]}
                append = {**args, "action": "append", "offset": 0, "base64": base64.b64encode(b"abcdef").decode()}
                self.assertEqual(ingest(jobs, append)["offset"], 6)
                self.assertEqual(ingest(jobs, append)["offset"], 6)
                self.assertEqual(ingest(jobs, begin)["offset"], 6)
                for bad in [{**append, "namespace": "b" * 64}, {**append, "offset": 7}, {**append, "base64": "????"}, {**args, "action": "finish"}]:
                    with self.assertRaises(WatchError): ingest(jobs, bad)
                ingest(jobs, {**append, "offset": 6, "base64": base64.b64encode(b"g").decode()})
                result = ingest(jobs, {**args, "action": "finish"})
                self.assertEqual(ingest(jobs, {**args, "action": "finish"}), result)
                self.assertEqual(ingest(jobs, begin)["result"], result)
                file = Path(work) / "imports" / result["source"][7:] / "media.webm"
                self.assertEqual(file.read_bytes(), b"abcdefg")
                with self.assertRaises(WatchError): ingest(jobs, {**begin, "size": 9})
            finally:
                jobs.close()

    def test_local_bridge_and_standalone_access(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            file = root / "clip.mp4"
            file.write_bytes(b"fixture")
            jobs = Jobs(root / "data")
            args = {"action": "local", "namespace": "c" * 64, "source": file.as_uri(), "roots": [str(root)], "request_id": str(uuid.uuid4())}
            try:
                self.assertTrue(server.call(jobs, "watch_ingest", args)["isError"])
                jobs.host_bridge = True
                result = server.call(jobs, "watch_ingest", args)
                self.assertFalse(result["isError"], result)
                self.assertEqual(server.call(jobs, "watch_ingest", args), result)
                with self.assertRaises(WatchError): ingest(jobs, {**args, "roots": []})
            finally:
                jobs.close()


if __name__ == "__main__":
    unittest.main()
