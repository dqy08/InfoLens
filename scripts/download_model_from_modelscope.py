#!/usr/bin/env python3
"""从 ModelScope 拉取模型，写入 Hugging Face 本地缓存。

清单仍读官方 Hub（文件名、sha256），权重走 ModelScope。

用法（项目根目录）:
  python scripts/download_model_from_modelscope.py qwen3-1.7b
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from model_paths import CLI_MODEL_IDS, resolve_hf_path

_HF_API = "https://huggingface.co/api/models"
_MS = "https://www.modelscope.cn/models"


def _hub_root() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    home = os.environ.get("HF_HOME", str(Path.home() / ".cache/huggingface"))
    return Path(home) / "hub"


def _get_json(url: str):
    with urlopen(url, timeout=60) as resp:
        return json.load(resp)


def _curl(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    incomplete = dest.with_name(dest.name + ".incomplete")
    cmd = [
        "curl",
        "-L",
        "--fail",
        "--retry",
        "8",
        "--retry-all-errors",
        "--retry-delay",
        "2",
        "--connect-timeout",
        "20",
        "-o",
        str(incomplete),
        url,
    ]
    print(f"↓ {url}")
    subprocess.run(cmd, check=True)
    incomplete.replace(dest)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _lfs_oid(info: dict) -> str | None:
    lfs = info.get("lfs") or {}
    oid = lfs.get("oid") or ""
    if oid.startswith("sha256:"):
        return oid.split(":", 1)[1]
    if len(oid) == 64:
        return oid
    return None


def download(cli_id: str) -> Path:
    repo = resolve_hf_path(cli_id)
    print(f"model={cli_id} repo={repo}")
    meta = _get_json(f"{_HF_API}/{repo}")
    sha = meta["sha"]
    siblings = meta.get("siblings") or []
    if not siblings:
        raise RuntimeError(f"Hub 未返回文件列表: {repo}")

    repo_dir = _hub_root() / f"models--{repo.replace('/', '--')}"
    blobs = repo_dir / "blobs"
    snap = repo_dir / "snapshots" / sha
    refs = repo_dir / "refs"
    blobs.mkdir(parents=True, exist_ok=True)
    snap.mkdir(parents=True, exist_ok=True)
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "main").write_text(sha + "\n")

    for info in siblings:
        name = info.get("rfilename")
        if not name:
            continue
        size = int((info.get("lfs") or {}).get("size") or info.get("size") or 0)
        oid = _lfs_oid(info)
        dest = snap / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = f"{_MS}/{repo}/resolve/master/{name}"

        if dest.is_file() and (size == 0 or dest.stat().st_size == size):
            print(f"skip {name}")
            continue

        if oid:
            blob = blobs / oid
            if not (blob.is_file() and blob.stat().st_size == size):
                _curl(url, blob)
                if size and blob.stat().st_size != size:
                    raise RuntimeError(f"{name}: 大小不符 {blob.stat().st_size} != {size}")
                actual = _sha256(blob)
                if actual != oid:
                    blob.unlink(missing_ok=True)
                    raise RuntimeError(f"{name}: sha256 不符")
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            dest.symlink_to(os.path.relpath(blob, dest.parent))
        else:
            _curl(url, dest)
            if size and dest.stat().st_size != size:
                raise RuntimeError(f"{name}: 大小不符 {dest.stat().st_size} != {size}")
        print(f"ok {name}")

    print(f"cache {snap}")
    return snap


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        ids = ", ".join(CLI_MODEL_IDS)
        print(f"用法: python scripts/download_model_from_modelscope.py <model>\n已知 id: {ids}", file=sys.stderr)
        sys.exit(0 if len(sys.argv) == 2 else 2)
    download(sys.argv[1])


if __name__ == "__main__":
    main()
