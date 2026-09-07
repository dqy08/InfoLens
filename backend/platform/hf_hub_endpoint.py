"""Hugging Face Hub endpoint：始终走官方 huggingface.co。"""

_HF_OFFICIAL = "https://huggingface.co"


def hf_hub_endpoint() -> str:
    return _HF_OFFICIAL


def hf_api():
    from huggingface_hub import HfApi

    return HfApi(endpoint=hf_hub_endpoint())
