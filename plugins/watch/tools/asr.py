"""Local speech fallback: cheap status, isolated preparation, verified warm-up.

Follows claude-video's setup/captions/fallback lifecycle. OpenBot owns the
Python environment; Watch owns its model cache and never loads another app's
configuration or selects a cloud provider.
"""
from __future__ import annotations
import importlib.metadata
import importlib.util
import math
from pathlib import Path
import re
import sys
from common import WatchError, contained, read_json

PACKAGES = {"faster-whisper": "faster_whisper", "ctranslate2": "ctranslate2", "onnxruntime": "onnxruntime", "numpy": "numpy"}
MANIFEST = Path(__file__).resolve().parents[1] / "asr-model.json"


def configured(settings):
    return settings.get("asr_backend", "local" if settings.get("asr_model_path") else "none") == "local"


def validate_settings(value):
    result = {}
    if value.get("asr_backend", "none") not in {"local", "none"}:
        raise WatchError("转写方式必须是 local 或 none")
    if "asr_backend" in value:
        result["asr_backend"] = value["asr_backend"]
    model = value.get("asr_model_path")
    if model:
        if not isinstance(model, str) or len(model) > 2048 or not Path(model).expanduser().is_absolute():
            raise WatchError("本地转写模型必须使用绝对目录")
        result["asr_model_path"] = str(Path(model).expanduser().resolve())
    language = value.get("asr_language", "")
    if not isinstance(language, str) or language and not re.fullmatch(r"[a-z]{2,3}", language):
        raise WatchError("口述语言使用 zh、en 等语言代码，留空自动识别")
    result["asr_language"] = language
    return result


def model_path(root, settings):
    return Path(settings["asr_model_path"]) if settings.get("asr_model_path") else contained(root, "models", read_json(MANIFEST)["id"])


def signature(root, settings):
    model = model_path(root, settings)
    names = ("model.bin", "config.json", "tokenizer.json") if settings.get("asr_model_path") else [f["path"] for f in read_json(MANIFEST)["files"]]
    try:
        files = {name: [p.stat().st_size, p.stat().st_mtime_ns] for name in names if (p := model / name).is_file()}
        versions = {name: importlib.metadata.version(name) for name in PACKAGES}
        if len(files) != len(names):
            return None
        return {"model": str(model), "files": files, "packages": versions, "revision": read_json(MANIFEST)["revision"], "format": 1}
    except (OSError, importlib.metadata.PackageNotFoundError):
        return None


def status(root, settings):
    enabled = configured(settings)
    runtime = all(importlib.util.find_spec(module) is not None for module in PACKAGES.values())
    model = model_path(root, settings)
    present = all((model / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json"))
    receipt = contained(root, "models", "ready.json")
    ready = False
    if enabled and runtime and present and receipt.is_file():
        try:
            current = signature(root, settings)
            ready = current is not None and read_json(receipt) == current
        except (OSError, ValueError, WatchError):
            pass
    state = "disabled" if not enabled else "runtime_missing" if not runtime else "ready" if ready else "needs_warmup" if present else "model_missing"
    return {"configured": enabled, "backend": "local" if enabled else "none", "state": state,
            "runtime_available": runtime, "model_available": present, "ready": ready,
            "can_prepare": enabled and runtime, "managed_model": not bool(settings.get("asr_model_path")),
            "download_bytes": sum(f["size"] for f in read_json(MANIFEST)["files"]),
            "language": settings.get("asr_language") or "auto"}


def prepare(root, settings, runner, stage):
    current = status(root, settings)
    if not current["configured"]:
        raise WatchError("本地转写未启用；可在插件配置中选择本地转写")
    if not current["runtime_available"]:
        raise WatchError("本地转写依赖不完整，请重新准备插件运行环境")
    if not current["ready"]:
        stage("初始化本地转写：准备模型并试运行（首次约486 MB）" if not current["model_available"] else "验证本地转写模型和语音检测")
        command = [sys.executable, "-B", str(Path(__file__).with_name("setup_asr.py")), "--data-dir", str(root)]
        if settings.get("asr_model_path"):
            command += ["--model", settings["asr_model_path"]]
        runner.run(command, 1200)
        if not status(root, settings)["ready"]:
            raise WatchError("本地转写初始化未完成，可重试继续准备")
    return model_path(root, settings)


def transcribe(audio, output, model, settings, runner):
    command = [sys.executable, "-B", str(Path(__file__).with_name("transcribe.py")), "--model", str(model),
               "--audio", str(audio), "--output", str(output)]
    if settings.get("asr_language"):
        command += ["--language", settings["asr_language"]]
    runner.run(command, 600)
    data = read_json(output)
    rows = data.get("segments")
    if not isinstance(rows, list) or len(rows) > 30000:
        raise WatchError("转写结果无效")
    for row in rows:
        if not isinstance(row, dict) or any(isinstance(row.get(k), bool) or not isinstance(row.get(k), (int, float)) or not math.isfinite(row[k]) for k in ("start", "end")):
            raise WatchError("转写时间无效")
        if not 0 <= row["start"] < row["end"] <= 601 or not isinstance(row.get("text"), str) or len(row["text"]) > 4000:
            raise WatchError("转写内容无效")
    return data
