"""Optional local ASR worker. Model installation is an explicit owner action."""
import argparse
import json
import math
import os
from pathlib import Path
import wave


def load_pcm_audio(path):
    """FFmpeg already decoded the media; do not decode that WAV again via PyAV."""
    with wave.open(str(path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("ASR requires prepared mono 16 kHz PCM16 WAV")
        count = audio.getnframes()
        if not 0 < count <= 16000 * 600:
            raise ValueError("ASR audio duration is outside the reading window limit")
        pcm = audio.readframes(count)
        if len(pcm) != count * 2:
            raise ValueError("Prepared ASR audio is truncated")
    import numpy as np
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not all((Path(args.model) / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
        raise ValueError("Local ASR model requires model.bin, config.json and tokenizer.json")
    # Tokenizers can otherwise download their own fallback even when the model
    # was opened with local_files_only=True. Validate files and stay offline.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=True, cpu_threads=4)
    segments, info = model.transcribe(load_pcm_audio(args.audio), beam_size=3, vad_filter=True, condition_on_previous_text=False)
    result = []
    for segment in segments:
        if not math.isfinite(segment.start) or not math.isfinite(segment.end) or not 0 <= segment.start < segment.end:
            continue
        text = segment.text.strip()
        if text:
            result.append({"start": segment.start, "end": segment.end, "text": text[:4000]})
    Path(args.output).write_text(json.dumps({"segments": result, "language": info.language}, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
