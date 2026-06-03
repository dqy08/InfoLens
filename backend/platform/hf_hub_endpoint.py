"""Hugging Face Hub endpoint：镜像仅 opt-in，鉴权/写入始终走官方。"""

import os

_HF_OFFICIAL = "https://huggingface.co"


def hf_hub_endpoint(*, mirror: bool = False) -> str:
    """mirror=True 且配置了 HF_ENDPOINT_MIRROR 时用镜像；否则官方 huggingface.co。"""
    if mirror:
        url = os.environ.get("HF_ENDPOINT_MIRROR")
        if url:
            return url.rstrip("/")
    return _HF_OFFICIAL


def hf_api(*, mirror: bool = False):
    from huggingface_hub import HfApi

    return HfApi(endpoint=hf_hub_endpoint(mirror=mirror))
