"""
pred_topk 列表的格式化：与 language_checker 中 batch_decode + round_to_sig_figs 语义一致，供信息密度与续写共用。
"""

from typing import List, Tuple

import torch

from backend.platform.format import round_to_sig_figs


def pred_topk_pairs_from_flat_ids_and_probs(
    ids_flat: List[int],
    probs_flat: List[float],
    tokenizer,
) -> List[Tuple[str, float]]:
    """
    对 torch.topk 展平后的 id / 概率序列解码为 [(token 文本, 概率), ...]。
    与 QwenLM._decode_topk_tokens 内层逻辑一致（单次 batch_decode）。
    """
    if len(ids_flat) != len(probs_flat):
        raise ValueError("ids_flat 与 probs_flat 长度须一致")
    if not ids_flat:
        return []
    decoded = tokenizer.batch_decode([[tid] for tid in ids_flat], skip_special_tokens=False)
    return [
        (decoded[j], round_to_sig_figs(float(probs_flat[j])))
        for j in range(len(ids_flat))
    ]


def pred_topk_pairs_from_probs_1d(
    probs: torch.Tensor,
    tokenizer,
    top_k: int,
) -> List[Tuple[str, float]]:
    """单步 1D softmax 概率向量上的 top-k，用于续写 generate 的每步 scores。"""
    top_k = min(int(top_k), int(probs.numel()))
    if top_k <= 0:
        return []
    topk_probs, topk_ids = torch.topk(probs, top_k, dim=-1)
    ids_flat = topk_ids.cpu().flatten().tolist()
    probs_flat = topk_probs.detach().cpu().float().numpy().flatten().tolist()
    return pred_topk_pairs_from_flat_ids_and_probs(ids_flat, probs_flat, tokenizer)
