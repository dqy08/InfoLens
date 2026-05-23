"""
下一 token 的 top-k 解码：与语义分析 logits_gradient 一致，供 semantic / attribution 复用。
"""
from typing import List, Tuple

import torch

from backend.platform.format import round_to_sig_figs

DEFAULT_NEXT_TOKEN_TOPK = 10


def decode_topk_ids_to_strings_and_rounded_probs(
    probs_1d: torch.Tensor,
    tokenizer,
    topk_ids_1d: torch.Tensor,
) -> Tuple[List[str], List[float]]:
    """
    probs_1d: 对单位置 logits 的 softmax，shape [vocab_size]。
    topk_ids_1d: torch.topk(logits, k) 返回的 indices，shape [k]。
    返回与语义分析 debug_info 相同形态的 topk_tokens、topk_probs（概率已 round_to_sig_figs）。
    """
    ids_list = topk_ids_1d.tolist()
    topk_tokens = [tokenizer.decode([int(tid)]) for tid in ids_list]
    topk_probs = [round_to_sig_figs(probs_1d[int(tid)].item()) for tid in ids_list]
    return topk_tokens, topk_probs
