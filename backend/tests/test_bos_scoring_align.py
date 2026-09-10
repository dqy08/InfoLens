"""信息密度打分：BOS / 空 span 前缀与 payload offset 对齐。"""
import torch

from backend.core.language_checker import ensure_bos_prefix, scoring_payload_offsets


def test_qwen_offsets_insert_first():
    offsets = [(0, 2), (2, 4), (4, 5)]
    payload, insert_first = scoring_payload_offsets(offsets)
    assert insert_first is True
    assert payload == offsets


def test_gemma_bos_empty_span_skips_insert():
    offsets = [(0, 0), (0, 3), (3, 11), (11, 14)]
    payload, insert_first = scoring_payload_offsets(offsets)
    assert insert_first is False
    assert payload == [(0, 3), (3, 11), (11, 14)]


def test_strips_trailing_empty_eos():
    offsets = [(0, 0), (0, 3), (3, 5), (5, 5)]
    payload, insert_first = scoring_payload_offsets(offsets)
    assert insert_first is False
    assert payload == [(0, 3), (3, 5)]


def test_bos_only_sequence_empty_payload():
    payload, insert_first = scoring_payload_offsets([(0, 0)])
    assert insert_first is False
    assert payload == []


def test_ensure_bos_prefix_skips_non_gemma():
    ids = torch.tensor([[10, 11, 12]])
    offsets = [(0, 2), (2, 4), (4, 5)]
    out_ids, out_off = ensure_bos_prefix(
        ids, offsets, bos_id=2, model_type="qwen3", max_length=2000
    )
    assert torch.equal(out_ids, ids)
    assert out_off == offsets


def test_ensure_bos_prefix_skips_when_empty_span_already_present():
    ids = torch.tensor([[2, 10, 11]])
    offsets = [(0, 0), (0, 2), (2, 4)]
    out_ids, out_off = ensure_bos_prefix(
        ids, offsets, bos_id=2, model_type="gemma3_text", max_length=2000
    )
    assert torch.equal(out_ids, ids)
    assert out_off == offsets


def test_ensure_bos_prefix_prepends_for_gemma_without_bos():
    ids = torch.tensor([[10, 11]])
    offsets = [(0, 2), (2, 4)]
    out_ids, out_off = ensure_bos_prefix(
        ids, offsets, bos_id=2, model_type="gemma3_text", max_length=2000
    )
    assert out_ids.tolist() == [[2, 10, 11]]
    assert out_off == [(0, 0), (0, 2), (2, 4)]
