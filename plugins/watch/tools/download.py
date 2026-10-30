"""Bounded network worker for direct media and yt-dlp-supported pages."""
from __future__ import annotations
import json
import ipaddress
from pathlib import Path
import socket
import sys
from urllib.request import ProxyHandler, Request, build_opener
from common import MAX_MEDIA, WatchError
from sources import public_address, validate_url


def guard_network():
    original_dns = socket.getaddrinfo
    original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex
    mapped_addresses = set()

    def addresses(host, port, *args, **kwargs):
        rows = original_dns(host, port, *args, **kwargs)
        try:
            ipaddress.ip_address(host)
            allow_fake_ip = host in mapped_addresses
        except ValueError:
            allow_fake_ip = True
        if not rows or any(not public_address(row[4][0], allow_fake_ip) for row in rows):
            raise OSError("Watch download cannot access private network addresses")
        mapped_addresses.update(row[4][0] for row in rows)
        return rows

    def destination(sock, address):
        if sock.family not in (socket.AF_INET, socket.AF_INET6):
            raise OSError("Watch download requires an Internet socket")
        return addresses(address[0], address[1], sock.family, socket.SOCK_STREAM)[0][4]

    socket.getaddrinfo = addresses
    socket.socket.connect = lambda sock, address: original_connect(sock, destination(sock, address))
    socket.socket.connect_ex = lambda sock, address: original_connect_ex(sock, destination(sock, address))


def guard_downloader():
    from yt_dlp import YoutubeDL
    from yt_dlp.downloader.external import FFmpegFD
    from yt_dlp.utils import DownloadError
    original = YoutubeDL.build_request_director

    def build(self, handlers, preferences=None):
        # Native HTTP transports do not pass through guarded Python sockets.
        return original(self, [h for h in handlers if h.RH_KEY in {"Urllib", "Requests"}], preferences)

    def external_download(*_args, **_kwargs):
        raise DownloadError("This source needs an external network downloader; provide a video file or direct media URL")

    YoutubeDL.build_request_director = build
    FFmpegFD.real_download = external_download


def direct(url, output):
    url = validate_url(url, resolve=True)
    target = Path(output)
    created = False
    try:
        with build_opener(ProxyHandler({})).open(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as response:
            validate_url(response.url)
            length = response.headers.get("Content-Length")
            if length and (not length.isdigit() or not 0 < int(length) <= MAX_MEDIA):
                raise WatchError("视频为空或超过 256 MiB")
            if response.headers.get_content_type() in {"text/html", "application/json"}:
                raise WatchError("来源返回了网页或错误信息，请使用平台页面读取或更新附件地址")
            count = 0
            with target.open("xb") as stream:
                created = True
                while chunk := response.read(256 * 1024):
                    count += len(chunk)
                    if count > MAX_MEDIA:
                        raise WatchError("视频超过 256 MiB")
                    stream.write(chunk)
            if not count:
                raise WatchError("视频文件为空")
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise


def main():
    guard_network()
    if len(sys.argv) == 4 and sys.argv[1] == "--direct":
        direct(sys.argv[2], sys.argv[3])
        print(json.dumps({"downloaded": True}))
        return
    guard_downloader()
    import yt_dlp
    yt_dlp.main(sys.argv[1:])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc) if isinstance(exc, WatchError) else f"Video download failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)
