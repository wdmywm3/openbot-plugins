"""Expose Watch reads through the host's generic asynchronous media contract."""
from __future__ import annotations

import json
import re
import uuid

from common import WatchError, canonical_source
from jobs import validate_request


def read_media(jobs, args):
    kind = args.get("kind")
    scope = args.get("namespace", "")
    request_id = args.get("request_id", "")
    if kind not in {"transcribe", "frames"} or not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope):
        raise WatchError("需要有效媒体类型及任务范围")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", request_id):
        raise WatchError("需要稳定的媒体请求编号")
    source = canonical_source(args.get("url"))
    identity = uuid.uuid5(uuid.NAMESPACE_URL, scope + ":" + request_id).hex
    desired = validate_request({"source": source, "start_seconds": args.get("start", 0), "end_seconds": args.get("end", 600),
                                "frame_count": 12, "request_id": identity, "media_kind": kind,
                                "media_scope": scope, "media_origin": source})
    with jobs.lock:
        jobs.prune()
        record = jobs._record(args["job_id"]) if args.get("job_id") else next(
            (row for row in jobs.records.values() if row["request"].get("request_id") == identity), None)
        if record:
            original = dict(record["request"])
            original["source"] = original.get("media_origin", original["source"])
            if original != desired:
                raise WatchError("媒体回执与当前来源、范围或请求不匹配")
            status = jobs.status(record["job_id"])
        else:
            # Reuse only this caller's ready source. No other chat's bearer
            # tokens, credentials, files or evidence are discovered by the bridge.
            reusable = next((row for row in reversed(list(jobs.records.values())) if row["status"] == "ready"
                             and row["request"].get("media_scope") == scope
                             and row["request"].get("media_origin") == source), None)
            request = dict(desired)
            if reusable:
                request["source"] = "watch:" + reusable["job_id"]
            status = jobs.start(request)
    job_id = status["job_id"]
    if status["status"] in {"queued", "running", "cancelling"}:
        return {"status": "running" if status["status"] == "cancelling" else status["status"], "jobId": job_id}
    if status["status"] != "ready":
        return {"status": "failed", "error": status.get("stage", "Watch 读取失败"), "jobId": job_id}
    result = status["result"]
    start, end = desired["start_seconds"], desired["end_seconds"]
    actual = result["range"]
    missing = bool(result.get("coverage", {}).get("source_incomplete")) or actual["end_seconds"] + 0.1 < end
    notes = list(result.get("warnings", []))
    if kind == "transcribe":
        segments, offset, size, language = [], 0, 0, ""
        while True:
            page = jobs.transcript(job_id, offset, 80)
            language = page.get("language") or ""
            for value in page["segments"]:
                segment = {"start": max(start, value["start"]), "end": min(end, value["end"]), "text": value["text"]}
                if segment["end"] > segment["start"]:
                    size += len(json.dumps(segment, ensure_ascii=False))
                    if size > 2_500_000:
                        raise WatchError("转写结果过大，请缩短读取区间")
                    segments.append(segment)
            next_offset = page["next_offset"]
            if next_offset is None:
                break
            if next_offset <= offset:
                raise WatchError("转写分页未前进")
            offset = next_offset
        covered = start
        for segment in sorted(segments, key=lambda value: value["start"]):
            if segment["start"] > covered + 0.1:
                missing = True
            covered = max(covered, segment["end"])
        missing = missing or covered + 0.1 < end
        if not segments:
            return {"status": "unavailable", "reason": "；".join(notes) or "Watch 未取得语音转写，请配置本地转写模型"}
        return {"status": "completed", "segments": segments, "language": language, "source": "Watch 本地语音转写",
                "incomplete": missing, "notes": "；".join(notes + (["只记录实际取得的语音区间"] if missing else []))}
    frames, offset, size = [], 0, 0
    while True:
        page, content = jobs.frames(job_id, offset, 4)
        observations = []
        for part in content:
            if part["type"] == "text":
                observations = json.loads(part["text"])["observations"]
            elif part["type"] == "image":
                for observation in observations:
                    timestamp = observation["timestamp_seconds"]
                    if not start <= timestamp <= end:
                        raise WatchError("画面时间戳超出请求范围")
                    size += len(part["data"])
                    if len(frames) >= 12 or size > 16_000_000:
                        raise WatchError("画面结果过大，请缩短读取区间")
                    frames.append({"timestamp": timestamp, "mimeType": part["mimeType"], "data": part["data"]})
        next_offset = page["next_offset"]
        if next_offset is None:
            break
        if next_offset <= offset:
            raise WatchError("画面分页未前进")
        offset = next_offset
    notes.append("抽样画面不代表连续观看；最大未采样间隔：" + str(result.get("coverage", {}).get("max_gap_seconds", "未知")) + "秒")
    return {"status": "completed", "frames": frames, "source": "Watch 抽样画面", "incomplete": True, "notes": "；".join(notes)}
