"""Isolated yt-dlp metadata worker, including Bilibili's WBI page fallback.

Some Bilibili pages are client-rendered shells with no INITIAL_STATE assignment.
Use the same signed view API as the site; retain yt-dlp's access/format checks.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from urllib.parse import parse_qs, urlparse

from common import DOWNLOAD_FORMAT, DOWNLOAD_SORT, WatchError, canonical_source, write_json


def video_state(detail, bvid):
    if not isinstance(detail, dict) or detail.get("code") != 0:
        raise WatchError("B 站视频信息不可用或需要登录")
    view = (detail.get("data") or {}).get("View") or {}
    if view.get("bvid") != bvid or isinstance(view.get("cid"), bool) or not isinstance(view.get("cid"), int) or view["cid"] <= 0:
        raise WatchError("B 站返回的视频身份或分 P 信息不匹配")
    return {"videoData": view, "upData": view.get("owner") or {}}


def bili_extractor(base):
    class WatchBiliIE(base):
        def _download_webpage_handle(self, url, video_id, *args, **kwargs):
            page, handle = super()._download_webpage_handle(url, video_id, *args, **kwargs)
            if not isinstance(url, str) or not self.suitable(url) or re.search(r"window\.__INITIAL_STATE__\s*=", page):
                return page, handle
            match = self._match_valid_url(url)
            bvid = match.group("prefix").upper() + match.group("id")
            detail = self._download_json(
                "https://api.bilibili.com/x/web-interface/wbi/view/detail", bvid,
                query=self._sign_wbi({"bvid": bvid, "platform": "web"}, bvid),
                headers={"Referer": "https://www.bilibili.com/", "Origin": "https://www.bilibili.com"})
            state = video_state(detail, bvid)
            part = int(parse_qs(urlparse(url).query).get("p", ["1"])[0])
            pages = state["videoData"].get("pages") or [state["videoData"]]
            if not 1 <= part <= len(pages):
                raise WatchError("指定的 B 站分 P 不存在")
            self.watch_metadata_origin = "bilibili_wbi"
            self.watch_source_duration = pages[part - 1].get("duration")
            # This string is only parsed by yt-dlp's JSON parser, never executed.
            return page + "\n<script>window.__INITIAL_STATE__=" + json.dumps(state) + ";</script>", handle
    return WatchBiliIE


def extract(source, output, cookies=None):
    source = canonical_source(source)
    if not source.startswith("https://"):
        raise WatchError("元数据读取需要视频链接")
    from yt_dlp import YoutubeDL
    from yt_dlp.extractor.bilibili import BiliBiliIE
    from yt_dlp.globals import plugin_dirs, all_plugins_loaded
    # The worker loads only the adapter bundled with this package.
    plugin_dirs.value = []
    all_plugins_loaded.value = True
    options = {"quiet": True, "noprogress": True, "cachedir": False, "noplaylist": True,
               "socket_timeout": 20, "retries": 1, "extractor_retries": 1,
               "format": DOWNLOAD_FORMAT, "format_sort": [DOWNLOAD_SORT]}
    if cookies:
        options["cookiefile"] = cookies
    with YoutubeDL(options) as ydl:
        adapter = bili_extractor(BiliBiliIE)(ydl)
        ydl.add_info_extractor(adapter)
        info = ydl.extract_info(source, download=False, ie_key="WatchBili" if adapter.suitable(source) else None)
        data = ydl.sanitize_info(info)
        if getattr(adapter, "watch_metadata_origin", None):
            data["watch_metadata_origin"] = adapter.watch_metadata_origin
            data["watch_source_duration"] = adapter.watch_source_duration
        if not isinstance(data, dict) or data.get("_type") in {"playlist", "multi_video"} or "entries" in data:
            raise WatchError("请提供一个明确的视频或分 P 链接")
        write_json(output, data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cookies")
    args = parser.parse_args()
    try:
        extract(args.source, args.output, args.cookies)
    except WatchError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
