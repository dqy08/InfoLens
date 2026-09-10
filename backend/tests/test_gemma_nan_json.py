"""Gemma fp16 → NaN logits 不得写成非法 JSON。"""
import pytest
import torch

from backend.api.sse_utils import send_result_event
from backend.core.language_checker import require_finite_probs
from backend.models.model_loader import get_device_load_strategy


def test_send_result_event_rejects_nan():
    with pytest.raises(ValueError, match="JSON"):
        send_result_event(
            {
                "request": {"text": "第"},
                "result": {"bpe_strings": [{"real_topk": [0, float("nan")]}]},
            }
        )


def test_require_finite_probs_raises():
    require_finite_probs([0.1, 0.2], what="token probability")
    with pytest.raises(RuntimeError, match="non-finite"):
        require_finite_probs([0.1, float("nan")], what="token probability")


def test_load_strategy_gemma_mps_bfloat16():
    gemma = get_device_load_strategy(
        torch.device("mps"), model_path="google/gemma-3-270m"
    )
    qwen = get_device_load_strategy(
        torch.device("mps"), model_path="Qwen/Qwen3-0.6B-Base"
    )
    cpu = get_device_load_strategy(
        torch.device("cpu"), model_path="google/gemma-3-270m"
    )
    assert gemma["dtype"] == torch.bfloat16
    assert qwen["dtype"] == torch.float16
    assert cpu["dtype"] == torch.float32
