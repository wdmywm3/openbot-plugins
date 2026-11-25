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
import os
import re
import sys
from common import WatchError, contained, read_json

PACKAGES = {"faster-whisper": "faster_whisper", "ctranslate2": "ctranslate2", "onnxruntime": "onnxruntime", "numpy": "numpy"}
MODEL = read_json(Path(__file__).resolve().parents[1] / "plugin.json")["extensions"]["com.openbot"]["dependencies"]["modelFiles"]


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
    path = settings.get("asr_model_path") or os.environ.get("OPENBOT_MODEL_DIR")
    return Path(path) if path else contained(root, "models", "whisper-small")


def signature(root, settings):
    model = model_path(root, settings)
    names = ("model.bin", "config.json", "tokenizer.json") if settings.get("asr_model_path") else [f["path"] for f in MODEL["files"]]
    try:
        files = {name: [p.stat().st_size, p.stat().st_mtime_ns] for name in names if (p := model / name).is_file()}
        versions = {name: importlib.metadata.version(name) for name in PACKAGES}
        if len(files) != len(names):
            return None
        return {"model": str(model), "files": files, "packages": versions, "revision": MODEL["revision"], "format": 1}
    except (OSError, importlib.metadata.PackageNotFoundError):
        return None


def status(root, settings):
    enabled = configured(settings)
    runtime = all(importlib.util.find_spec(module) is not None for module in PACKAGES.values())
    model = model_path(root, settings)
    present = all((model / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json"))
    receipt = contained(root, "models", "ready.json")
    ready = False
    model_error = None
    if os.environ.get("OPENBOT_MODEL_DIR") and not settings.get("asr_model_path"):
        for item in MODEL["files"]:
            try:
                size = (model / item["path"]).stat().st_size
            except FileNotFoundError:
                present = False
                break
            except OSError:
                model_error = "本地语音模型文件状态读取失败"
                break
            if size == 0:
                model_error = "本地语音模型文件为空"
                break
            if size != item["size"]:
                model_error = f"本地语音模型文件为 {size} 字节，声明大小为 {item['size']} 字节"
                break
        ready = present and not model_error and enabled and runtime
    elif enabled and runtime and present and receipt.is_file():
        try:
            current = signature(root, settings)
            ready = current is not None and read_json(receipt) == current
        except (OSError, ValueError, WatchError):
            pass
    state = "disabled" if not enabled else "runtime_missing" if not runtime else "ready" if ready else "needs_warmup" if present else "model_missing"
    if enabled and runtime and model_error:
        state = "model_invalid"
    return {**({"error": model_error} if model_error else {}), "configured": enabled, "backend": "local" if enabled else "none", "state": state,
            "runtime_available": runtime, "model_available": present, "ready": ready,
            "can_prepare": state == "needs_warmup" and bool(settings.get("asr_model_path")), "managed_model": not bool(settings.get("asr_model_path")),
            "download_bytes": sum(f["size"] for f in MODEL["files"]),
            "language": settings.get("asr_language") or "auto"}


def prepare(root, settings, runner, stage):
    current = status(root, settings)
    if not current["configured"]:
        raise WatchError("本地转写未启用；可在插件配置中选择本地转写")
    if not current["runtime_available"]:
        raise WatchError("本地转写依赖不完整，请重新准备插件运行环境")
    if not current["ready"]:
        if current.get("error"):
            raise WatchError(current["error"])
        if not current["model_available"]:
            raise WatchError("本地语音模型缺失，请重新准备插件依赖")
        if not settings.get("asr_model_path"):
            raise WatchError("本地语音模型尚未验证，请运行模型准备程序")
        stage("验证已配置的本地语音模型")
        runner.run([sys.executable, "-B", str(Path(__file__).with_name("setup_asr.py")),
                    "--data-dir", str(root), "--model", settings["asr_model_path"]], 600)
        if not status(root, settings)["ready"]:
            raise WatchError("本地语音模型验证未完成")
    return model_path(root, settings)


def transcribe(audio, output, model, settings, runner):
    runner.asr_worker.transcribe(model, audio, output, settings.get("asr_language") or None, runner)
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
