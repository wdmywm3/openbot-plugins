"""Launch the optional MCP with a local settings file and venv CUDA DLLs."""
import argparse
import json
import os
from pathlib import Path
import sys


def configure(config_file):
    config = json.loads(Path(config_file).read_text(encoding="utf-8-sig"))
    allowed = {"OPENBOT_ASR_MODEL_DIR", "OPENBOT_ASR_DEVICE", "OPENBOT_ASR_COMPUTE",
               "OPENBOT_FFMPEG", "OPENBOT_FFPROBE", "OPENBOT_BACKUP_DIR", "OPENBOT_BACKUP_MAX_FILE_MB",
               "OPENBOT_BACKUP_MAX_TOTAL_GB", "OPENBOT_MEDIA_COOKIE_FILE"}
    if not isinstance(config, dict) or set(config) - allowed or any(not isinstance(v, str) for v in config.values()):
        raise ValueError("Invalid local media settings")
    os.environ.update(config)
    # The host supplies a different MCP data directory for each instance.
    root = Path(os.environ.get("OPENBOT_MCP_DATA_DIR", Path.cwd()))
    os.environ.setdefault("OPENBOT_MEDIA_WORK", str(root / "media-jobs"))
    os.environ.setdefault("PYTHONUTF8", "1")
    handles = []
    if os.name == "nt":
        bins = sorted((Path(sys.prefix) / "Lib" / "site-packages" / "nvidia").glob("*/bin"))
        for directory in bins:
            handles.append(os.add_dll_directory(str(directory)))
        os.environ["PATH"] = os.pathsep.join([*(str(p) for p in bins), os.environ.get("PATH", "")])
    ffmpeg = config.get("OPENBOT_FFMPEG")
    if ffmpeg:
        os.environ["PATH"] = str(Path(ffmpeg).parent) + os.pathsep + os.environ.get("PATH", "")
    return handles


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    dll_handles = configure(args.config)
    from server import main
    main()
