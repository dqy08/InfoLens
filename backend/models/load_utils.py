"""HuggingFace 模型下载与加载：下载独立，加载仅考虑本地"""

import json
import os
from typing import Callable, TypeVar

T = TypeVar("T")

# 与 transformers 的 checkpoint 命名一致
_SAFE_WEIGHTS = "model.safetensors"
_SAFE_WEIGHTS_INDEX = "model.safetensors.index.json"
_WEIGHTS = "pytorch_model.bin"
_WEIGHTS_INDEX = "pytorch_model.bin.index.json"


def _is_model_cache_complete(local_path: str) -> bool:
    """
    本地检查模型权重是否完整。与 transformers 的 _get_resolved_checkpoint_files 逻辑一致。
    """
    def _p(f: str) -> str:
        return os.path.join(local_path, f)

    if os.path.isfile(_p(_SAFE_WEIGHTS)):
        return True
    index_file = _p(_SAFE_WEIGHTS_INDEX)
    if os.path.isfile(index_file):
        with open(index_file) as f:
            index = json.load(f)
        shards = set(index.get("weight_map", {}).values())
        return all(os.path.isfile(_p(s)) for s in shards)
    if os.path.isfile(_p(_WEIGHTS)):
        return True
    index_file = _p(_WEIGHTS_INDEX)
    if os.path.isfile(index_file):
        with open(index_file) as f:
            index = json.load(f)
        shards = set(index.get("weight_map", {}).values())
        return all(os.path.isfile(_p(s)) for s in shards)
    return False


def ensure_model_local(model_path: str, *, force_download: bool = False) -> str:
    """
    确保模型在本地可用，返回本地路径。
    - 本地目录：直接返回
    - HuggingFace ID：优先用本地缓存（不联网），缓存不完整时 force_download 可触发下载
    """
    if os.path.isdir(model_path):
        return model_path
    if "/" in model_path and not os.path.exists(model_path):
        from huggingface_hub import snapshot_download

        from backend.platform.hf_hub_endpoint import hf_hub_endpoint

        dl_kw = {"endpoint": hf_hub_endpoint(mirror=True)}
        if force_download:
            return snapshot_download(model_path, **dl_kw)
        try:
            path = snapshot_download(model_path, local_files_only=True, **dl_kw)
            if not _is_model_cache_complete(path):
                return snapshot_download(model_path, **dl_kw)
            return path
        except Exception:
            return snapshot_download(model_path, **dl_kw)
    return model_path


def resolve_and_load(model_path: str, loader: Callable[[str, bool], T]) -> T:
    """
    先确保模型本地可用，再加载。加载时始终使用 local_files_only=True。
    """
    path = ensure_model_local(model_path)
    return loader(path, True)
