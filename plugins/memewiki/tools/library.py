"""Public meme dictionary and cards. No dependency on another bot application."""
from __future__ import annotations

import base64
import hashlib
import html
import io
import json
from contextlib import contextmanager
from pathlib import Path
import re
import sqlite3
import time
import urllib.parse
import urllib.request

API = "https://cnmeme.wiki/api/v1/public/memes"
ROOT = Path(__file__).resolve().parents[1]


def clean(value, limit=4000):
    return str(value or "").strip()[:limit]


def normalize(query):
    q = clean(query, 80)
    for size in range(min(4, len(q) // 2), 1, -1):
        if len(q) % size == 0 and q[:size] * (len(q) // size) == q:
            return q[:size]
    return q


def entry(row):
    value = dict(row)
    tags = value.get("tags") or []
    if isinstance(tags, str):
        try:
            tags = json.loads(tags) if tags.startswith("[") else tags.split("、")
        except ValueError:
            tags = tags.split("、")
    return {**{k: clean(value.get(k)) for k in ("title", "slug", "usage", "origin", "other", "summary")},
            "tags": [clean(t, 40) for t in tags[:10]] if isinstance(tags, list) else [],
            "source": "cnmeme.wiki", "url": "https://cnmeme.wiki/词条/" + urllib.parse.quote(clean(value.get("slug")), safe="")}


def remote_entry(item):
    # The public detail API returns HTML content; never interpret it as instructions.
    raw = clean(item.get("content_html") or item.get("content") or item.get("body"), 100000)
    raw = re.sub(r"<h[12][^>]*>", "\n## ", raw, flags=re.I)
    raw = re.sub(r"</h[12]>|</p>|<br\s*/?>|</li>", "\n", raw, flags=re.I)
    raw = html.unescape(re.sub(r"<[^>]*>", "", raw))
    sections = {"usage": [], "origin": [], "other": []}
    for part in re.split(r"\n##\s*", raw):
        head, _, body = part.strip().partition("\n")
        key = "usage" if any(w in head for w in ("用法", "怎么用", "如何用", "例句", "接梗")) else "origin" if any(w in head for w in ("来源", "出处", "背景", "起源")) else "other"
        sections[key].append(body if key != "other" and body else part.strip())
    return entry({**item, **{k: item.get(k) or "\n".join(v) for k, v in sections.items()}})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("词库接口重定向已停止")


def get_json(url):
    if not url.startswith(API) or urllib.parse.urlsplit(url).hostname != "cnmeme.wiki":
        raise ValueError("无效的词库地址")
    request = urllib.request.Request(url, headers={"User-Agent": "OpenBot-MemeWiki/0.1", "Accept": "application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=2.0) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError("词库响应过大")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("词库响应无效")
    return value


class Library:
    def __init__(self, data_dir, packaged=ROOT / "data"):
        self.directory = Path(data_dir).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.snapshot = json.loads((packaged / "snapshot.json").read_text(encoding="utf-8"))
        self.base = (packaged / "memes.db").resolve()
        if self.base.stat().st_size != self.snapshot["bytes"] or hashlib.sha256(self.base.read_bytes()).hexdigest() != self.snapshot["sha256"]:
            raise ValueError("词库快照校验失败")
        with self.open_base() as db:
            if db.execute("pragma quick_check").fetchone()[0] != "ok":
                raise ValueError("词库快照损坏")
        self.cache = self.directory / "online.sqlite"
        with self.open_cache() as db:
            db.execute("CREATE TABLE IF NOT EXISTS entries (title TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS queries (query TEXT PRIMARY KEY, expires REAL, value TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)")

    @contextmanager
    def open_base(self):
        db = sqlite3.connect(self.base.as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def open_cache(self):
        db = sqlite3.connect(self.cache, timeout=3)
        try:
            with db:
                yield db
        finally:
            db.close()

    def local(self, query):
        q = normalize(query)
        with self.open_cache() as db:
            row = db.execute("SELECT value FROM entries WHERE title=?", (q,)).fetchone()
        if row:
            return json.loads(row[0])
        with self.open_base() as db:
            row = db.execute("SELECT * FROM memes WHERE title=?", (q,)).fetchone()
            if row is None:
                row = db.execute("SELECT * FROM memes WHERE length(title)>=2 AND instr(?,title)>0 ORDER BY length(title) DESC,title LIMIT 1", (q,)).fetchone()
            return entry(row) if row else None

    def lookup(self, query, online=False):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 80:
            raise ValueError("查询词须为 1–80 个字")
        q = normalize(query)
        found = self.local(q)
        if found:
            return {"found": True, "entry": found, "via": "local"}
        if not online:
            return {"found": False, "query": q}
        with self.open_cache() as db:
            row = db.execute("SELECT value FROM queries WHERE query=? AND expires>?", (q, time.time())).fetchone()
        if row:
            return json.loads(row[0])
        try:
            response = get_json(API + "?" + urllib.parse.urlencode({"q": q, "limit": 10}))
            items = response.get("items")
            if not isinstance(items, list):
                raise ValueError("词库列表格式无效")
            # Online fallback must not substitute a vaguely related entry.
            item = next((i for i in items if isinstance(i, dict) and i.get("title", "").strip() == q), None)
            if item:
                detail = get_json(API + "/" + urllib.parse.quote(clean(item.get("slug")), safe=""))
                if not isinstance(detail.get("item"), dict) or detail["item"].get("slug") != item.get("slug"):
                    raise ValueError("词条详情不匹配")
                found = remote_entry({**item, **detail["item"]})
                self.save_entry(found)
            value = {"found": bool(found), **({"entry": found, "via": "online"} if found else {"query": q})}
        except Exception:
            # Keep transport failure distinguishable from a real negative lookup.
            return {"found": False, "query": q, "unavailable": True}
        with self.open_cache() as db:
            db.execute("INSERT OR REPLACE INTO queries VALUES (?,?,?)", (q, time.time() + 600, json.dumps(value, ensure_ascii=False)))
            db.execute("DELETE FROM queries WHERE expires<?", (time.time(),))
        return value

    def save_entry(self, value):
        if not value.get("title") or not value.get("slug") or not any(value.get(k) for k in ("usage", "origin", "other", "summary")):
            raise ValueError("词条缺少标题、来源或正文")
        with self.open_cache() as db:
            db.execute("INSERT OR REPLACE INTO entries VALUES (?,?)", (value["title"], json.dumps(value, ensure_ascii=False)))

    def sync_step(self):
        """One resumable page, additive only; never replaces the bundled snapshot."""
        with self.open_cache() as db:
            row = db.execute("SELECT value FROM metadata WHERE key='sync' ").fetchone()
        state = json.loads(row[0]) if row else {"offset": 0, "added": 0}
        response = get_json(API + "?" + urllib.parse.urlencode({"limit": 30, "offset": state["offset"]}))
        items, more = response.get("items"), response.get("has_more")
        if not isinstance(items, list) or not isinstance(more, bool) or (more and not items):
            raise ValueError("词库列表不完整，已保留原词库")
        consumed, added = 0, 0
        for item in items:
            if not isinstance(item, dict) or not item.get("title") or not item.get("slug"):
                raise ValueError("词库列表格式无效")
            existing = self.local(item["title"])
            if existing and existing["title"] == item["title"]:
                consumed += 1
                continue
            detail = get_json(API + "/" + urllib.parse.quote(item["slug"], safe=""))
            if not isinstance(detail.get("item"), dict) or detail["item"].get("slug") != item["slug"]:
                raise ValueError("词条详情不匹配")
            self.save_entry(remote_entry({**item, **detail["item"]}))
            state["added"] += 1
            consumed += 1
            added += 1
            if added >= 2:
                break
        more = more or consumed < len(items)
        state["offset"] += consumed
        value = {**state, "done": not more}
        with self.open_cache() as db:
            if more:
                db.execute("INSERT OR REPLACE INTO metadata VALUES ('sync',?)", (json.dumps(state),))
            else:
                db.execute("DELETE FROM metadata WHERE key='sync'")
        return value


def card(data):
    from PIL import Image, ImageDraw, ImageFont
    paths = ["C:/Windows/Fonts/msyh.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/System/Library/Fonts/PingFang.ttc"]
    font_path = next((p for p in paths if Path(p).is_file()), None)
    if not font_path:
        raise ValueError("未找到中文字体，请使用文字回复或安装 Noto Sans CJK")
    font, title_font = ImageFont.truetype(font_path, 25), ImageFont.truetype(font_path, 38)
    canvas = Image.new("RGB", (840, 2200), "#f5f3ed")
    draw = ImageDraw.Draw(canvas)
    draw.text((40, 32), clean(data.get("title"), 16), font=title_font, fill="#262923")
    y = 102
    fields = [("含义 / 用法", data.get("usage") or data.get("summary")), ("出处", data.get("origin")), ("补充", data.get("other"))]
    for label, value in fields:
        if not value:
            continue
        draw.text((40, y), label, font=font, fill="#55715c")
        y += 40
        lines, line = [], ""
        for char in clean(value, 450):
            if char == "\n" or draw.textlength(line + char, font=font) > 760:
                lines.append(line)
                line = "" if char == "\n" else char
            else:
                line += char
        lines.append(line)
        for line in lines[:12]:
            if y > 2020:
                break
            draw.text((40, y), line, font=font, fill="#262923")
            y += 36
        y += 22
    draw.text((40, min(y, 2100)), clean(data.get("source") or "cnmeme.wiki", 40), font=font, fill="#697167")
    output = io.BytesIO()
    canvas.crop((0, 0, 840, min(y + 75, 2200))).save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode("ascii")
