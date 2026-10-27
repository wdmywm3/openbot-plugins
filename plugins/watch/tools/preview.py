"""Read public Bilibili storyboards without downloading or decoding a video."""
from __future__ import annotations

import base64
import io
import json
import math
import struct
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlencode, urlparse

from common import WatchError, canonical_source, number


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def cdn_url(value):
    if not isinstance(value, str):
        raise WatchError("预览图地址缺失")
    value = "https:" + value if value.startswith("//") else value.replace("http://", "https://", 1)
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443)
            or not (host == "hdslb.com" or host.endswith(".hdslb.com"))):
        raise WatchError("预览图来源不可用")
    return value


class PreviewClient:
    def __init__(self):
        self.deadline, self.used, self.last_api = time.monotonic() + 35, 0, 0
        self.opener = urllib.request.build_opener(NoRedirect())

    def __call__(self, url, limit):
        if urlparse(url).hostname == "api.bilibili.com":
            delay = max(0, 3 - (time.monotonic() - self.last_api))
            if delay:
                time.sleep(delay)
            self.last_api = time.monotonic()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise WatchError("预览读取超时")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
        try:
            with self.opener.open(req, timeout=min(8, remaining)) as response:
                chunks, size = [], 0
                while True:
                    if time.monotonic() >= self.deadline:
                        raise WatchError("预览读取超时")
                    chunk = response.read(min(65536, limit - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    self.used += len(chunk)
                    if size > limit or self.used > 20 * 1024 * 1024:
                        raise WatchError("预览资料超过读取大小限制")
                    chunks.append(chunk)
                return b"".join(chunks)
        except urllib.error.HTTPError as error:
            if error.code in (412, 429):
                raise WatchError("平台暂时限制预览访问，请稍后再试") from None
            raise WatchError("平台预览暂不可用") from None
        except (urllib.error.URLError, OSError):
            raise WatchError("平台预览暂不可用") from None


def timeline(snapshot, duration, fetch):
    values = snapshot.get("index") or []
    if not values and snapshot.get("pvdata"):
        raw = fetch(cdn_url(snapshot["pvdata"]), 40000)
        if not raw or len(raw) % 2:
            raise WatchError("预览时间索引无效")
        values = list(struct.unpack(f">{len(raw) // 2}H", raw))
    if not isinstance(values, list) or not 1 <= len(values) <= 20000:
        raise WatchError("没有可用的预览时间索引")
    times = [v.get("timestamp") if isinstance(v, dict) else v for v in values]
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in times):
        raise WatchError("预览时间索引无效")
    scale = 1000 if max(times) > duration * 1.5 else 1
    times = [v / scale for v in times]
    if any(a > b for a, b in zip(times, times[1:])) or max(times) > duration:
        raise WatchError("预览时间索引与分P时长不符")
    return list(enumerate(times))


def read_preview(args, fetch=None):
    """Return only observed timestamps; an unavailable preview never downloads media."""
    try:
        from PIL import Image
    except ImportError:
        return {"status": "unavailable", "reason": "视频预览需要 Pillow，请更新 Watch 的 requirements-media.txt 依赖"}
    try:
        source = canonical_source(args.get("url"))
        parsed = urlparse(source)
        if parsed.hostname != "www.bilibili.com":
            return {"status": "unavailable", "reason": "该来源未提供轻量视频预览"}
        start = number(args.get("start", 0), "start", hi=43200)
        end = number(args.get("end", start + 120), "end", hi=43200)
        if not 0 < end - start <= 600:
            raise WatchError("预览区间需大于0且不超过600秒")
        bvid, part = parsed.path.split("/")[2], int(parse_qs(parsed.query)["p"][0])
        fetch = fetch or PreviewClient()

        def api(path, params):
            data = json.loads(fetch("https://api.bilibili.com" + path + "?" + urlencode(params), 2 * 1024 * 1024))
            if not isinstance(data, dict) or data.get("code") != 0 or not isinstance(data.get("data"), dict):
                raise WatchError("平台未提供可用的视频预览")
            return data["data"]

        view = api("/x/web-interface/view", {"bvid": bvid})
        pages = view.get("pages") or []
        if view.get("bvid") != bvid or not 1 <= part <= len(pages):
            raise WatchError("预览视频或分P不匹配")
        page = pages[part - 1]
        cid = page.get("cid")
        if not isinstance(cid, int) or isinstance(cid, bool) or cid <= 0:
            raise WatchError("预览缺少分P标识")
        duration = number(page.get("duration"), "分P时长", lo=0.01, hi=43200)
        end = min(end, duration)
        if start >= end:
            raise WatchError("预览区间超出分P时长")
        shot = api("/x/player/videoshot", {"bvid": bvid, "cid": cid, "index": 1})
        if shot.get("cid") is not None and str(shot["cid"]) != str(cid):
            raise WatchError("预览返回了其他分P")
        entries = [(tile, at) for tile, at in timeline(shot, duration, fetch) if start <= at < end]
        sheets = shot.get("image")
        if not entries or not isinstance(sheets, list) or not sheets:
            raise WatchError("指定区间没有预览图")
        width, height = shot.get("img_x_size"), shot.get("img_y_size")
        if any(type(v) is not int or not 1 <= v <= 2048 for v in (width, height)):
            raise WatchError("预览图尺寸无效")
        targets = [start + (end - start) * fraction for fraction in (0.25, 0.5, 0.75)]
        selected = {}
        for wanted in targets:
            tile, actual = min(entries, key=lambda entry: abs(entry[1] - wanted))
            selected.setdefault(tile, (wanted, actual))
        cache = {}

        def sheet(index):
            if index not in cache:
                if index >= len(sheets):
                    raise WatchError("预览图与时间索引不匹配")
                image = Image.open(io.BytesIO(fetch(cdn_url(sheets[index]), 5 * 1024 * 1024)))
                if image.width * image.height > 36_000_000 or image.width % width or image.height % height:
                    raise WatchError("预览拼图尺寸无效")
                image.load()
                cache[index] = image
            return cache[index]

        first = sheet(0)
        columns = shot.get("img_x_len") or first.width // width
        rows = shot.get("img_y_len") or first.height // height
        if any(type(v) is not int or not 1 <= v <= 100 for v in (columns, rows)):
            raise WatchError("预览拼图排列无效")
        frames, mappings = [], []
        for tile, (wanted, actual) in selected.items():
            index, position = divmod(tile, columns * rows)
            image = sheet(index)
            x, y = position % columns * width, position // columns * height
            if x + width > image.width or y + height > image.height:
                raise WatchError("预览图位置超出拼图")
            cropped = image.crop((x, y, x + width, y + height)).convert("RGB")
            cropped.thumbnail((480, 480))
            output = io.BytesIO()
            cropped.save(output, format="JPEG", quality=80)
            frames.append({"timestamp": actual, "mimeType": "image/jpeg", "data": base64.b64encode(output.getvalue()).decode("ascii")})
            mappings.append({"requested": round(wanted, 3), "actual": actual})
        return {"status": "completed", "source": "B站平台预览图", "frames": frames, "incomplete": True,
                "bvid": bvid, "part": part, "cid": cid, "samples": mappings,
                "notes": f"仅第{part}P（cid={cid}）的离散低清预览，不含语音，不代表连续观看。"
                         + "请求与实际秒数：" + json.dumps(mappings, ensure_ascii=False)
                         + "；细节或连续动作不足时再读取原视频相关片段。"}
    except WatchError as error:
        return {"status": "unavailable", "reason": str(error)}
    except (ValueError, TypeError, KeyError, IndexError, OSError, Image.DecompressionBombError):
        return {"status": "unavailable", "reason": "未取得该分P与区间的有效预览，可按需读取原视频画面"}
