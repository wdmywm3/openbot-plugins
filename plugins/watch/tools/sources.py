"""Video sources: public URLs and explicitly configured local file roots."""
from __future__ import annotations

import ipaddress
from pathlib import Path, PureWindowsPath
import re
import socket
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit

from common import WatchError, contained, read_json, token


def remote_source(value):
    return isinstance(value, str) and urlsplit(value).scheme.lower() in {"http", "https"}


def public_address(value, allow_fake_ip=False):
    address = ipaddress.ip_address(value.split("%", 1)[0])
    if address.version == 6 and address.ipv4_mapped:
        return public_address(str(address.ipv4_mapped), allow_fake_ip)
    # TUN proxies can resolve public hostnames into their benchmark-range map.
    # This is only allowed for DNS results, never a literal source URL.
    fake_ip = allow_fake_ip and address.version == 4 and address in ipaddress.ip_network("198.18.0.0/15")
    return (address.is_global or fake_ip) and not address.is_multicast


def validate_url(value, resolve=False):
    try:
        u = urlsplit(value)
        if u.scheme not in {"http", "https"} or not u.hostname or u.username or u.password:
            raise ValueError()
        if u.port is not None and not 1 <= u.port <= 65535:
            raise ValueError()
        host = u.hostname.rstrip(".").lower()
        if host == "localhost" or host.endswith((".localhost", ".local")):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not public_address(str(address)):
            raise ValueError()
        if resolve:
            addresses = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80), type=socket.SOCK_STREAM)
            if not addresses or any(not public_address(row[4][0], allow_fake_ip=address is None) for row in addresses):
                raise ValueError()
        return urlunsplit((u.scheme, u.netloc, u.path or "/", u.query, ""))
    except (ValueError, OSError, TypeError):
        raise WatchError("需要可访问的 HTTP/HTTPS 视频地址；不接受凭据、回环或内网地址") from None


def normalize_source(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 8192 or any(ord(c) < 32 for c in value):
        raise WatchError("请提供视频网址、附件来源、本地文件或已有任务标识")
    value = value.strip()
    for prefix in ("import:", "watch:"):
        if value.startswith(prefix):
            return prefix + token(value[len(prefix):])
    if value.startswith("file:"):
        u = urlsplit(value)
        if u.netloc not in {"", "localhost"} or u.query or u.fragment:
            raise WatchError("本地文件 URI 无效")
        value = unquote(u.path)
        if re.match(r"^/[A-Za-z]:/", value):
            value = value[1:]
    if Path(value).is_absolute() or PureWindowsPath(value).is_absolute():
        return value
    value = validate_url(value)
    u = urlsplit(value)
    host = u.hostname.lower() if u.port in {None, 80, 443} else ""
    if host in {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}:
        match = re.fullmatch(r"/video/(BV[A-Za-z0-9]{10})/?", u.path)
        if match:
            page = parse_qs(u.query).get("p", ["1"])[0]
            if not re.fullmatch(r"[1-9][0-9]{0,3}", page):
                raise WatchError("B 站分 P 编号无效")
            return f"https://www.bilibili.com/video/{match[1]}/?p={page}"
    video_id = None
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        if u.path == "/watch":
            video_id = parse_qs(u.query).get("v", [None])[0]
        else:
            match = re.fullmatch(r"/(?:shorts|embed)/([\w-]{11})/?", u.path)
            video_id = match[1] if match else None
    elif host == "youtu.be":
        video_id = u.path.strip("/")
    if video_id and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return "https://www.youtube.com/watch?v=" + video_id
    return value


def local_file(source, roots):
    if not isinstance(roots, list) or len(roots) > 32 or any(not isinstance(p, str) or not p for p in roots):
        raise WatchError("本地视频目录配置无效")
    try:
        requested = Path(normalize_source(source)).expanduser()
        if not requested.is_absolute():
            raise ValueError()
        file = requested.resolve(strict=True)
        permitted = [Path(p).expanduser().resolve(strict=True) for p in roots]
        if not file.is_file() or not any(file == root or file.is_relative_to(root) for root in permitted):
            raise ValueError()
        # Resolving before the root check keeps symlinks/junctions from escaping.
        return file
    except (ValueError, TypeError, OSError, RuntimeError):
        raise WatchError("本地视频不在配置的可读目录内，或文件不存在；请提供附件或配置该文件所在目录") from None


def configured_local_file(source, root):
    settings = contained(root, "settings.json")
    config = read_json(settings) if settings.is_file() else {}
    return local_file(source, config.get("local_roots", []))
