"""
预测归因：对任意上下文的下一个 token 预测，计算指定候选 token 的 logit
对输入各 token embedding 的梯度，以梯度 L2 范数作为归因分。

由请求参数 `model` 选择权重槽位：base 为主槽位（--base_model），instruct 为 instruct 槽位（--instruct_model）。
"""

import math
from typing import Dict, Optional

import torch

from backend.platform.format import round_to_sig_figs
from backend.models.device import DeviceManager
from backend.models.model_manager import (
    ModelSlot,
    ensure_slot_weights_loaded,
    get_base_model_display_name,
    get_instruct_model_display_name,
)
from .next_token_topk import decode_topk_ids_to_strings_and_rounded_probs, DEFAULT_NEXT_TOKEN_TOPK


def _get_gradient_checkpointing() -> bool:
    """默认 True；``--no-gradient-checkpointing`` 关闭。"""
    try:
        from backend.platform.app_context import get_args

        return getattr(get_args(), "gradient_checkpointing", True)
    except RuntimeError:
        return True


# 归因输入长度上限（token 数）；超长则报错
ATTRIBUTION_MAX_TOKEN_LENGTH = 500

# 与 API 请求体 `model` 一致：base=主槽位，instruct=语义槽位
PREDICTION_ATTR_MODEL_BASE = "base"
PREDICTION_ATTR_MODEL_INSTRUCT = "instruct"


def slot_for_prediction_attr_model(model: str) -> ModelSlot:
    if model == PREDICTION_ATTR_MODEL_BASE:
        return ModelSlot.BASE
    if model == PREDICTION_ATTR_MODEL_INSTRUCT:
        return ModelSlot.INSTRUCT
    raise ValueError(
        f"Unsupported model {model!r}; only {PREDICTION_ATTR_MODEL_BASE!r} and "
        f"{PREDICTION_ATTR_MODEL_INSTRUCT!r} are supported."
    )


def analyze_prediction_attribution(
    context: str,
    target_prediction: Optional[str] = None,
    *,
    model: str,
    target_token_id: Optional[int] = None,
) -> Dict:
    """
    计算 context 中各 token 对 target_prediction 首 token 预测的归因分。

    Args:
        context: 输入上下文文本（token 数不得超过 ATTRIBUTION_MAX_TOKEN_LENGTH，否则抛 ValueError）
        target_prediction: 目标预测文本；tokenize 后取第一个 token 作为归因目标。
        target_token_id: 目标 token id；用于 teacher forcing 按 tokenizer 词表精确指定目标。
        target_prediction 与 target_token_id 仅可二选一；两者均省略时自动使用 top-1（贪心解码）。
        model: ``base`` 为主槽位权重，``instruct`` 为语义槽位权重（与 API 请求体一致）

    Returns:
        {
            "model": str,
            "target_token": str,       # 归因目标 token 的字符串
            "target_prob": float,      # 该 token 在 next-token 分布中的预测概率
            "token_attribution": [{"offset": [s, e], "raw": str, "score": float}, ...],
            "debug_info": {"topk_tokens": [...], "topk_probs": [...]},  # 与语义分析同形（下一 token top10）
            "is_eos": bool,            # target_token 是否为 EOS token
        }
    """
    slot = slot_for_prediction_attr_model(model)
    tokenizer, hf_model, device = ensure_slot_weights_loaded(slot)
    model_display = (
        get_base_model_display_name() if slot == ModelSlot.BASE else get_instruct_model_display_name()
    )

    if target_prediction is not None and target_token_id is not None:
        raise ValueError("target_prediction and target_token_id are mutually exclusive")

    # 归因目标 id 仅在前向得到 logits 后解析：
    # top-1 用 argmax；显式 target 用 encode；显式 token id 直接使用请求值。
    use_top1 = target_prediction is None and target_token_id is None

    # 对 context 编码，保留 offset_mapping 用于还原字符位置
    enc = tokenizer(context, return_tensors="pt", return_offsets_mapping=True)
    input_ids = enc["input_ids"].to(device)
    offset_mapping = enc["offset_mapping"][0].tolist()
    n_tokens = input_ids.shape[1]
    if n_tokens > ATTRIBUTION_MAX_TOKEN_LENGTH:
        raise ValueError(
            "Context exceeds attribution length limit "
            f"({ATTRIBUTION_MAX_TOKEN_LENGTH} tokens); current length is {n_tokens} tokens."
        )

    # 通过 embedding 层获取可微输入
    embed_layer = hf_model.get_input_embeddings()
    embeds = embed_layer(input_ids).detach().clone().requires_grad_(True)

    use_gc = _get_gradient_checkpointing()
    try:
        hf_model.eval()
        if use_gc:
            hf_model.gradient_checkpointing_enable()
        with torch.set_grad_enabled(True):
            # 归因只需最后一步 logits，不需要 KV cache；关闭可显著降低长上下文内存峰值。
            outputs = hf_model(inputs_embeds=embeds, output_attentions=False, use_cache=False)

        # 显式同步，确保前向已完成（与 semantic logits_gradient 一致）
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        elif device.type == "mps":
            torch.mps.synchronize()

        logits = outputs.logits[0, -1, :]  # next-token logits，shape: [vocab_size]
        probs = torch.softmax(logits, dim=-1)
        _, topk_ids = torch.topk(logits, DEFAULT_NEXT_TOKEN_TOPK)
        topk_tokens, topk_probs = decode_topk_ids_to_strings_and_rounded_probs(
            probs, tokenizer, topk_ids
        )

        if use_top1:
            target_token_id = int(topk_ids[0].item())
            target_token = tokenizer.decode([target_token_id])
        elif target_token_id is not None:
            if target_token_id < 0 or target_token_id >= logits.shape[-1]:
                raise ValueError(
                    f"target_token_id out of range: {target_token_id} (vocab_size={int(logits.shape[-1])})"
                )
            target_token = tokenizer.decode([int(target_token_id)])
        else:
            assert target_prediction is not None
            target_ids = tokenizer.encode(target_prediction, add_special_tokens=False)
            if not target_ids:
                raise ValueError(f"Cannot tokenize target_prediction: {target_prediction!r}")
            target_token_id = target_ids[0]
            target_token = tokenizer.decode([target_token_id])

        assert target_token_id is not None
        target_prob = round_to_sig_figs(probs[int(target_token_id)].item())

        # 对目标 token 的 raw logit 反传（不经 softmax，避免饱和与竞争污染）
        logits[int(target_token_id)].backward()

        grad = embeds.grad
        if grad is None:
            raise RuntimeError(
                "Gradient did not propagate; this model may not support attribution (e.g. int8 quantization)."
            )

        # 显式同步，确保反向已完成后再读梯度（与 semantic logits_gradient 一致）
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        elif device.type == "mps":
            torch.mps.synchronize()

        norms = grad[0].float().norm(dim=-1).cpu().tolist()

        # 按 offset 过滤特殊 token（BOS/EOS 的 span 长度为 0）
        token_attribution = []
        nan_count = 0
        for (s, e), norm in zip(offset_mapping, norms):
            if s >= e:
                continue
            if not math.isfinite(norm):
                score = 0.0
                nan_count += 1
            else:
                score = round_to_sig_figs(norm)
            token_attribution.append({
                "offset": [s, e],
                "raw": context[s:e],
                "score": score,
            })
        if nan_count > 0:
            print(f"⚠️ token_attribution 中有 {nan_count} 个 score 为 NaN/Inf，已替换为 0。")

        eos_id = tokenizer.eos_token_id
        is_eos = eos_id is not None and int(target_token_id) == int(eos_id)

        return {
            "model": model_display,
            "target_token": target_token,
            "target_prob": target_prob,
            "token_attribution": token_attribution,
            "debug_info": {"topk_tokens": topk_tokens, "topk_probs": topk_probs},
            "is_eos": is_eos,
        }
    finally:
        if use_gc:
            hf_model.gradient_checkpointing_disable()
        # 与 semantic_analyzer._analyze_logits_gradient 一致：每次推理后清理，避免 MPS/CUDA 累积
        DeviceManager.clear_cache(device)
