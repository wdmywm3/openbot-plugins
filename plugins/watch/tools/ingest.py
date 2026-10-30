"""Private native-plugin bridge for scoped attachment bytes and local files."""
from __future__ import annotations
import base64
import json
from pathlib import Path
import re
import shutil
import time
import uuid
from common import MAX_MEDIA, MAX_STORAGE, WatchError, contained, integer, read_json, token, tree_size, write_json
from sources import local_file


def prune(root):
    directory = contained(root, "uploads")
    if not directory.exists():
        return
    for item in directory.iterdir():
        if re.fullmatch(r"[a-f0-9]{32}", item.name) and time.time() - item.stat().st_mtime > 86400:
            shutil.rmtree(contained(root, "uploads", item.name))


def ingest(jobs, args):
    from jobs import import_video
    namespace = args.get("namespace")
    if not isinstance(namespace, str) or not re.fullmatch(r"[a-f0-9]{64}", namespace):
        raise WatchError("附件缺少当前会话范围")
    action = args.get("action")
    fields = {"begin": {"size", "name", "request_id", "source_id"},
              "append": {"upload_id", "offset", "base64"}, "finish": {"upload_id"},
              "discard": {"upload_id"}, "local": {"source", "roots", "request_id"}}
    if action not in fields or set(args) - ({"action", "namespace"} | fields[action]):
        raise WatchError("附件导入参数无效")
    with jobs.lock:
        prune(jobs.root)
        if action in {"begin", "local"}:
            try:
                request = uuid.UUID(args["request_id"]).hex if args.get("request_id") else uuid.uuid4().hex
            except (ValueError, TypeError, AttributeError):
                raise WatchError("request_id 必须是 UUID") from None
            identity = uuid.uuid5(uuid.NAMESPACE_URL, namespace + ":" + request).hex
            folder = contained(jobs.root, "uploads", identity)
            if action == "local":
                source = local_file(args.get("source"), args.get("roots", []))
                details = {"source": str(source), "size": source.stat().st_size, "mtime": source.stat().st_mtime_ns}
                if folder.exists():
                    prior = read_json(contained(folder, "upload.json"))
                    if prior.get("namespace") != namespace or prior.get("local") != details:
                        raise WatchError("同一请求的视频已变化，请使用新的 request_id")
                    if prior.get("result"):
                        return prior["result"]
                result = import_video(jobs.root, source)
                folder.mkdir(parents=True, exist_ok=True)
                write_json(folder / "upload.json", {"namespace": namespace, "local": details, "result": result})
                return result
            size = integer(args.get("size"), "size", 1, MAX_MEDIA)
            name = args.get("name", "video.mp4")
            if not isinstance(name, str) or len(name) > 240 or Path(name).name != name or "/" in name or "\\" in name:
                raise WatchError("视频文件名无效")
            from media import MEDIA_EXTENSIONS
            suffix = Path(name).suffix.lower()
            if suffix not in MEDIA_EXTENSIONS:
                raise WatchError("附件不是支持的视频文件")
            description = {"namespace": namespace, "size": size, "name": name, "source_id": args.get("source_id", "")}
            if not isinstance(description["source_id"], str) or len(description["source_id"]) > 300:
                raise WatchError("附件来源编号无效")
            if folder.exists():
                prior = read_json(contained(folder, "upload.json"))
                if any(prior.get(k) != v for k, v in description.items()):
                    raise WatchError("同一请求的附件已变化，请使用新的 request_id")
                return {"upload_id": identity, "offset": contained(folder, "media" + suffix).stat().st_size,
                        **({"result": prior["result"]} if prior.get("result") else {})}
            if tree_size(jobs.root) + size * 2 > MAX_STORAGE:
                raise WatchError("视频缓存空间不足")
            folder.mkdir(parents=True)
            write_json(folder / "upload.json", description)
            contained(folder, "media" + suffix).touch(exist_ok=False)
            return {"upload_id": identity, "offset": 0}
        identity = token(args.get("upload_id"))
        folder = contained(jobs.root, "uploads", identity)
        record = read_json(contained(folder, "upload.json"))
        if record.get("namespace") != namespace or "local" in record:
            raise WatchError("附件不属于当前会话")
        target = contained(folder, "media" + Path(record["name"]).suffix.lower())
        if action == "discard":
            shutil.rmtree(folder)
            return {"discarded": True}
        if action == "finish":
            if record.get("result"):
                return record["result"]
            if target.stat().st_size != record["size"]:
                raise WatchError("视频附件尚未完整传入")
            result = import_video(jobs.root, target)
            write_json(folder / "upload.json", {**record, "result": result})
            return result
        if record.get("result"):
            raise WatchError("附件导入已经完成")
        offset = integer(args.get("offset"), "offset", 0, record["size"])
        data = args.get("base64")
        if not isinstance(data, str) or not 0 < len(data) <= 48000:
            raise WatchError("附件分块大小无效")
        try:
            chunk = base64.b64decode(data, validate=True)
        except (ValueError, TypeError):
            raise WatchError("附件编码无效") from None
        if not chunk or offset + len(chunk) > record["size"]:
            raise WatchError("附件分块超出声明大小")
        with target.open("r+b") as stream:
            length = target.stat().st_size
            if offset < length:
                stream.seek(offset)
                if stream.read(len(chunk)) != chunk:
                    raise WatchError("重试的附件分块内容不一致")
                return {"upload_id": identity, "offset": length}
            if offset != length:
                raise WatchError("附件分块顺序无效")
            if tree_size(jobs.root) + len(chunk) > MAX_STORAGE:
                raise WatchError("视频缓存空间不足")
            stream.seek(offset)
            stream.write(chunk)
        return {"upload_id": identity, "offset": offset + len(chunk)}
