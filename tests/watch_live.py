"""Explicit live acceptance. Never part of the network-free default tests.

Run with the Python environment containing requirements-media.txt and
requirements-asr.txt. Models/audio are prepared separately; this script never
reads browser credentials or downloads a model implicitly.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "watch"
sys.path.insert(0, str(PLUGIN / "tools"))
from common import read_json, write_json
from jobs import Jobs, import_video


def wait(jobs, request, label):
    state = jobs.start(request)
    job_id, last = state["job_id"], ""
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        state = jobs.status(job_id)
        if state["stage"] != last:
            print(json.dumps({"case": label, "status": state["status"], "stage": state["stage"]}, ensure_ascii=False), flush=True)
            last = state["stage"]
        if state["status"] in {"ready", "failed", "cancelled", "interrupted"}:
            return state
        time.sleep(1)
    jobs.cancel(job_id)
    raise TimeoutError(label)


def evidence(jobs, state, require_asr=False):
    assert state["status"] == "ready", state
    job_id = state["job_id"]
    count, offset = 0, 0
    while offset is not None:
        page, blocks = jobs.frames(job_id, offset)
        images = [b for b in blocks if b["type"] == "image"]
        assert 0 < len(images) <= 4
        count += len(images)
        offset = page["next_offset"]
    assert count == state["result"]["frame_count"]
    transcript = jobs.transcript(job_id)
    if require_asr:
        assert transcript["source"] == "local_asr" and transcript["segments"], transcript
        bounds = state["result"]["range"]
        assert all(bounds["start_seconds"] <= s["start"] < s["end"] <= bounds["end_seconds"] + 0.05 for s in transcript["segments"])
    return {"state": state, "first_transcript_page": transcript, "images_read": count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--model")
    parser.add_argument("--bilibili", action="append", default=[])
    parser.add_argument("--youtube")
    parser.add_argument("--source", action="append", default=[], help="Public direct video URL or supported platform page")
    parser.add_argument("--jfk", help="Local openai/whisper tests/jfk.flac sample")
    args = parser.parse_args()
    root = Path(args.data_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.model:
        write_json(root / "settings.json", {"asr_model_path": str(Path(args.model).resolve())})
    report = {"plugin_version": read_json(PLUGIN / "plugin.json")["version"], "cases": []}
    jobs = Jobs(root)
    try:
        for source in [*args.source, *args.bilibili, *([args.youtube] if args.youtube else [])]:
            state = wait(jobs, {"source": source, "end_seconds": 20, "frame_count": 6}, source)
            item = {"source": source, **evidence(jobs, state)}
            if args.model and state["result"]["media"]["has_audio"]:
                assert item["first_transcript_page"]["segments"], item
            item["metadata_origin"] = read_json(jobs.directory(state["job_id"]) / "source.json").get("metadata_origin")
            report["cases"].append(item)
            write_json(root / "acceptance.json", report)
        if args.jfk:
            if not args.model:
                parser.error("--jfk requires --model")
            video = root / "speech-sample.mp4"
            subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=4",
                            "-i", str(Path(args.jfk).resolve()), "-af", "adelay=2000:all=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(video)], check=True, timeout=30)
            imported = import_video(root, video)
            state = wait(jobs, {"source": imported["source"], "start_seconds": 2, "frame_count": 2, "sampling": "uniform"}, "JFK speech + 2 second offset")
            item = evidence(jobs, state, require_asr=True)
            text = " ".join(s["text"] for s in item["first_transcript_page"]["segments"]).lower()
            assert all(word in text for word in ("americans", "ask", "country")), text
            report["cases"].append({"source": "openai/whisper tests/jfk.flac; 2s leading silence", **item})
        write_json(root / "acceptance.json", report)
        print(json.dumps({"passed": len(report["cases"]), "report": str(root / "acceptance.json")}), flush=True)
    finally:
        jobs.close()


if __name__ == "__main__":
    main()
