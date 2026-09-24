"""分块打分：CPU 和 MPS 右补到固定 chunk_size，CUDA 按真实长度。"""
from types import SimpleNamespace

import pytest
import torch
from transformers import Gemma3ForCausalLM, Gemma3TextConfig

from backend.core.language_checker import QwenLM, right_pad_chunk
from backend.models.device import DeviceManager
from backend.models.model_loader import (
    attn_implementation_for_device,
    load_causal_lm,
    load_tokenizer,
)
from model_paths import resolve_hf_path


def _checker(model, tokenizer, device, chunk_size: int) -> QwenLM:
    checker = object.__new__(QwenLM)
    checker.model = model
    checker.tokenizer = tokenizer
    checker.device = device
    checker.chunk_size = chunk_size
    return checker


def _fake_tokenizer(**kwargs):
    defaults = dict(
        pad_token_id=0,
        eos_token_id=1,
        batch_decode=lambda ids, skip_special_tokens=False: ["x"] * len(ids),
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


@torch.inference_mode()
def _unpadded_chunked_probs(model, token_ids, chunk_size: int) -> torch.Tensor:
    """改前的切块：按真实长度前向。只取真实 token 概率，便于对照 padding。"""
    seq_len = token_ids.shape[1]
    real = []
    past_key_values = None
    total_chunks = (seq_len + chunk_size - 1) // chunk_size
    for i in range(total_chunks):
        start_idx = i * chunk_size
        end_idx = min((i + 1) * chunk_size, seq_len)
        outputs = model(
            input_ids=token_ids[:, start_idx:end_idx],
            past_key_values=past_key_values,
            use_cache=True,
        )
        past_key_values = outputs.past_key_values
        chunk_targets = token_ids[:, 1 + start_idx : 1 + end_idx]
        valid_len = chunk_targets.shape[1]
        if valid_len == 0:
            continue
        probs = torch.softmax(outputs.logits[:, :valid_len, :], dim=2)
        gathered = torch.gather(probs, 2, chunk_targets.unsqueeze(-1))
        real.extend(gathered.flatten().detach().cpu().float().tolist())
    return torch.tensor(real)


@torch.inference_mode()
def _full_forward_probs(model, token_ids) -> torch.Tensor:
    logits = model(input_ids=token_ids, use_cache=False).logits
    probs = torch.softmax(logits[:, :-1, :], dim=-1)
    gathered = torch.gather(probs, 2, token_ids[:, 1:].unsqueeze(-1))
    return gathered.flatten().detach().cpu().float()


def _assert_probs_close(got, ref, *, rtol: float, atol: float, what: str) -> None:
    a = got if torch.is_tensor(got) else torch.tensor(got, dtype=torch.float32)
    b = ref if torch.is_tensor(ref) else torch.tensor(ref, dtype=torch.float32)
    assert a.shape == b.shape, f"{what}: shape {tuple(a.shape)} != {tuple(b.shape)}"
    if torch.allclose(a, b, rtol=rtol, atol=atol):
        return
    absd = (a - b).abs().max().item()
    reld = ((a - b).abs() / b.abs().clamp_min(1e-12)).max().item()
    raise AssertionError(f"{what}: max abs={absd:.3e} max rel={reld:.3e}")


def test_right_pad_chunk_pads_and_masks():
    ids = torch.tensor([[1, 2, 3]])
    padded, mask = right_pad_chunk(ids, 5, pad_id=0)
    assert padded.tolist() == [[1, 2, 3, 0, 0]]
    assert mask.tolist() == [[1, 1, 1, 0, 0]]


def test_right_pad_chunk_full_is_unchanged():
    ids = torch.tensor([[4, 5, 6]])
    padded, mask = right_pad_chunk(ids, 3, pad_id=9)
    assert torch.equal(padded, ids)
    assert mask.tolist() == [[1, 1, 1]]


def test_right_pad_chunk_rejects_overflow():
    with pytest.raises(ValueError, match="exceeds chunk_size"):
        right_pad_chunk(torch.tensor([[1, 2, 3]]), 2, pad_id=0)


class _FakeCache:
    def __init__(self, seq=0):
        self._seq = seq

    def get_seq_length(self):
        return self._seq


class _FakeModel:
    def __init__(self, vocab=16):
        self.vocab = vocab
        self.shapes = []

    def __call__(self, input_ids, attention_mask=None, past_key_values=None, use_cache=True):
        self.shapes.append(
            (
                tuple(input_ids.shape),
                tuple(attention_mask.shape),
                int(attention_mask[0, -input_ids.shape[1] :].sum().item()),
            )
        )
        b, length = input_ids.shape
        past = 0 if past_key_values is None else past_key_values.get_seq_length()
        return SimpleNamespace(
            logits=torch.zeros(b, length, self.vocab),
            past_key_values=_FakeCache(past + length),
        )


def test_cpu_chunk_pads_to_chunk_size():
    checker = _checker(_FakeModel(), _fake_tokenizer(), torch.device("cpu"), 8)

    token_ids = torch.tensor([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]])
    pred_topk, real_probs = checker._run_inference_and_process_chunked(token_ids, effective_topk=3)

    assert [shape[0] for shape in checker.model.shapes] == [(1, 8), (1, 8)]
    # 第一块满 8；第二块真实 2 token，mask 上只有这 2 个 1
    assert checker.model.shapes[0][2] == 8
    assert checker.model.shapes[1][2] == 2
    assert checker.model.shapes[1][1] == (1, 16)
    # 因果 LM：10 token 打 9 个分
    assert len(real_probs) == 9
    assert len(pred_topk) == 9


def test_cuda_chunk_forwards_actual_length():
    checker = _checker(_FakeModel(), _fake_tokenizer(), torch.device("cuda"), 8)

    token_ids = torch.tensor([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]])
    pred_topk, real_probs = checker._run_inference_and_process_chunked(token_ids, effective_topk=3)

    assert [shape[0] for shape in checker.model.shapes] == [(1, 8), (1, 2)]
    assert checker.model.shapes[1][1] == (1, 10)
    assert len(real_probs) == 9
    assert len(pred_topk) == 9


def _tiny_gemma():
    cfg = Gemma3TextConfig(
        vocab_size=32,
        hidden_size=32,
        intermediate_size=64,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=8,
        max_position_embeddings=128,
        sliding_window=16,
        query_pre_attn_scalar=8,
        pad_token_id=0,
        eos_token_id=1,
        bos_token_id=2,
    )
    torch.manual_seed(0)
    return Gemma3ForCausalLM(cfg).eval()


@pytest.mark.parametrize(
    "seq_len,chunk_size",
    [
        (6, 8),   # 短于一块
        (10, 4),  # 跨两块，最后一块有余数
        (9, 4),   # 满块 + 余数 1
    ],
)
def test_tiny_gemma_padding_matches_unpadded_and_full_forward(seq_len, chunk_size):
    model = _tiny_gemma()
    ids = torch.arange(2, 2 + seq_len).unsqueeze(0).clamp(max=31)
    checker = _checker(model, _fake_tokenizer(), torch.device("cpu"), chunk_size)
    _, padded_probs = checker._run_inference_and_process_chunked(ids, effective_topk=3)
    unpadded = _unpadded_chunked_probs(model, ids, chunk_size)
    full = _full_forward_probs(model, ids)
    _assert_probs_close(padded_probs, unpadded, rtol=1e-5, atol=1e-6, what="pad vs unpadded chunk")
    _assert_probs_close(padded_probs, full, rtol=1e-5, atol=1e-6, what="pad vs full forward")


@pytest.fixture(scope="module")
def gemma_270m():
    device = DeviceManager.get_device()
    path = resolve_hf_path("gemma-3-270m")
    tokenizer = load_tokenizer(path)
    model = load_causal_lm(
        path, device, attn_implementation=attn_implementation_for_device(device)
    )
    return model, tokenizer, device


@pytest.mark.parametrize(
    "text",
    [
        "语言模型对下一个词的预测概率。",
        "语言模型对下一个词的预测概率，可以用来衡量这个词携带的信息量。" * 3,
        "Surprisal theory holds that processing difficulty is proportional to negative log probability. " * 8,
    ],
)
def test_gemma_270m_padding_matches_unpadded_chunk(gemma_270m, text):
    model, tokenizer, device = gemma_270m
    enc = tokenizer(text, return_tensors="pt")
    ids = enc["input_ids"].to(device)
    # 故意用较小块长，保证有余数块走 padding
    chunk_size = 64
    checker = _checker(model, tokenizer, device, chunk_size)
    _, padded_probs = checker._run_inference_and_process_chunked(ids, effective_topk=5)
    unpadded = _unpadded_chunked_probs(model, ids, chunk_size)
    # MPS bf16 不同形状的 GEMM 可能有约 1e-2 量级差；mask 错了会远大于这个
    rtol, atol = (2e-2, 1e-4) if device.type != "cpu" else (1e-4, 1e-6)
    _assert_probs_close(
        padded_probs, unpadded, rtol=rtol, atol=atol, what=f"gemma pad vs unpadded n={ids.shape[1]}"
    )
