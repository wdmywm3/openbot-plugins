"""Prepare one pinned local model and warm up Whisper + bundled Silero VAD."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import tempfile
from urllib.request import ProxyHandler, Request, build_opener
import wave
from common import WatchError, contained, read_json, write_json
import asr


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download_file(folder, spec, repository, revision, opener=None):
    target = contained(folder, spec["path"])
    if target.is_file() and target.stat().st_size == spec["size"] and digest(target) == spec["sha256"]:
        return
    partial = contained(folder, spec["path"] + ".part")
    offset = partial.stat().st_size if partial.is_file() else 0
    if offset > spec["size"]:
        partial.unlink(); offset = 0
    if offset == spec["size"]:
        if digest(partial) == spec["sha256"]:
            partial.replace(target); return
        partial.unlink(); offset = 0
    url = f"https://huggingface.co/{repository}/resolve/{revision}/{spec['path']}"
    request = Request(url, headers={"User-Agent": "OpenBot-Watch", **({"Range": f"bytes={offset}-"} if offset else {})})
    with (opener or build_opener(ProxyHandler({}))).open(request, timeout=30) as response:
        if response.status == 206:
            if response.headers.get("Content-Range") != f"bytes {offset}-{spec['size'] - 1}/{spec['size']}":
                raise WatchError("模型续传范围无效")
        elif response.status == 200:
            offset = 0
        else:
            raise WatchError("模型下载响应无效")
        with partial.open("ab" if offset else "wb") as stream:
            while block := response.read(1024 * 1024):
                offset += len(block)
                if offset > spec["size"]:
                    raise WatchError("模型文件大小不符")
                stream.write(block)
    if offset != spec["size"]:
        raise WatchError("模型下载未完成；重试可继续下载")
    if digest(partial) != spec["sha256"]:
        partial.unlink()
        raise WatchError("模型校验失败；重试将重新下载")
    partial.replace(target)


def prepare(root, model=None):
    from filelock import FileLock
    from transcribe import run
    root = Path(root).resolve()
    cache = contained(root, "models")
    cache.mkdir(parents=True, exist_ok=True)
    settings = {"asr_backend": "local", **({"asr_model_path": str(Path(model).resolve())} if model else {})}
    with FileLock(str(contained(cache, "setup.lock")), timeout=120):
        if asr.status(root, settings)["ready"]:
            return
        receipt = contained(cache, "ready.json")
        receipt.unlink(missing_ok=True)
        directory = asr.model_path(root, settings)
        if not model:
            from download import guard_network
            guard_network()
            directory.mkdir(exist_ok=True)
            manifest = read_json(asr.MANIFEST)
            for spec in manifest["files"]:
                print(f"Preparing {spec['path']}", flush=True)
                download_file(directory, spec, manifest["repository"], manifest["revision"])
        with tempfile.TemporaryDirectory(prefix="warmup-", dir=cache) as temporary:
            audio = Path(temporary) / "silence.wav"
            with wave.open(str(audio), "wb") as stream:
                stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                stream.writeframes(b"\0" * 64000)
            # Loads the runtime and model and executes bundled VAD; no download
            # is permitted during this offline inference stage.
            run(directory, audio, Path(temporary) / "result.json")
        receipt_value = asr.signature(root, settings)
        if receipt_value is None:
            raise WatchError("模型或依赖不完整")
        write_json(receipt, receipt_value)
        print("Local transcription ready", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--model")
    args = parser.parse_args()
    prepare(args.data_dir, args.model)
