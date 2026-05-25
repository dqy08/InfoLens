"""
Semantic analysis：基于 instruct 模型提取原文 token 与 query 的相关度

使用 logits_gradient 梯度归因策略（与预测更一致），子策略由 --logits_gradient_submode 指定：
- count：top-10 logits 梯度（排除 0），prompt 引导「数量」。0.6b下只适合用于判断文章整体是否有关联，1.7b下全能
- match_score：目标 token logit 梯度，prompt 引导「相关度打分」。0.6b/1.7b下都不太有竞争力。【已废弃】
- fill_blank：填空式，top-10 logits 梯度（排除 无），prompt 引导「最相关的一个词」。0.6b下只适合用于给token打分，1.7b下全能

count/fill_blank 按概率加权（Σ pᵢ·zᵢ）。

模型由 --instruct_model 参数指定，默认 qwen3-0.6b-instruct
"""

import gc
import math
from typing import Callable, Dict, List, Optional

import torch

from backend.platform.format import round_to_sig_figs
from backend.models.device import DeviceManager
from backend.models.model_manager import ensure_instruct_slot_ready, get_instruct_model_display_name
from .next_token_topk import decode_topk_ids_to_strings_and_rounded_probs, DEFAULT_NEXT_TOKEN_TOPK
from backend.platform.runtime_config import get_semantic_max_token_length



def _get_logits_gradient_submode() -> str:
    """logits_gradient 子策略：count / match_score(已废弃) / fill_blank"""
    try:
        from backend.platform.app_context import get_args
        return getattr(get_args(), "logits_gradient_submode", "fill_blank")
    except RuntimeError:
        return "fill_blank"


def _truncate_text_by_tokens(tokenizer, text: str, max_tokens: int) -> str:
    """将 text 截断至最多 max_tokens 个 token；超长时打印提示。"""
    text_ids = tokenizer.encode(text, add_special_tokens=False)
    if len(text_ids) > max_tokens:
        print(f"⚠️  原文过长，已截断至前 {max_tokens} token")
        return tokenizer.decode(text_ids[:max_tokens])
    return text


def _get_gradient_checkpointing() -> bool:
    """默认 True（run.py）；``--no-gradient-checkpointing`` 关闭。"""
    try:
        from backend.platform.app_context import get_args
        return getattr(get_args(), "gradient_checkpointing", True)
    except RuntimeError:
        return True


def _get_verbose() -> bool:
    """是否输出详细调试信息（由 --verbose 控制）"""
    from backend.platform.app_context import get_verbose
    return get_verbose()


def _analyze_logits_gradient(
    query: str,
    text: str,
    tokenizer,
    model,
    device,
    submode_override: Optional[str] = None,
    progress_callback: Optional[Callable[[int, int, str, Optional[int]], None]] = None,
    debug_info: bool = False,
    full_match_degree_only: bool = False,
) -> Dict:
    """
    梯度归因：logits 对输入 embedding 的梯度。
    子策略：count / match_score(已废弃) / fill_blank，由 --logits_gradient_submode 指定。
    submode_override: 评估时可选覆盖，用于同一进程内测试不同子模式。
    """
    TOTAL_STEPS = 4

    submode = submode_override if submode_override is not None else _get_logits_gradient_submode()
    max_length = get_semantic_max_token_length()

    if progress_callback:
        progress_callback(1, TOTAL_STEPS, "encoding", None)
    # 根据submodule来决定不同的instruction
    # 文档前用 \n\n 分隔，避免 tokenizer 将首字符与空格合并，导致 offset_mapping 计算错误
    if submode == "count":
        instruction = f"请问下面文字中有多少个词与查询主题（{query}）相关？文字内容：\n\n"
    elif submode == "match_score":  # 已废弃
        instruction = f"请问下面文字与查询主题（{query}）的相关程度是多少？请回答0/1/2（2为最高相关）。文字内容：\n\n"
    elif submode == "fill_blank":
        instruction = f"请问下面文字中哪个词与查询主题（{query}）最相关？如无相关词则回答“无”。文字内容：\n\n"
    else:
        raise ValueError(f"未知子模式: {submode}")

    # 截断 text 到 max_length token，再拼
    truncated_text = _truncate_text_by_tokens(tokenizer, text, max_length)
    
    messages = [{"role": "user", "content": instruction + truncated_text}]
    formatted = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True,
        enable_thinking=False
    )
    # 生成引导词：chat template 只支持完整消息，引导词需追加到 formatted
    if submode == "count":
        generation_guide = f"原文中与查询主题（{query}）相关的词的数量 = **"
    elif submode == "match_score":  # 已废弃
        generation_guide = f"文章和查询主题（{query}）的相关程度（0-2）打分为：**"
    elif submode == "fill_blank":
        # “引号是特意为了防止模型生成引号
        generation_guide = f"原文中与查询主题（{query}）最相关的一个词是：**“"
    else:
        raise ValueError(f"未知子模式: {submode}")
    formatted += generation_guide

    # logits_gradient count/fill_blank 的 top-k，影响梯度目标覆盖的候选词数量
    LOGITS_GRADIENT_TOPK = DEFAULT_NEXT_TOKEN_TOPK

    idx = formatted.find(instruction)
    instruction_start_char = idx if idx >= 0 else 0
    text_start_char = instruction_start_char + len(instruction)
    text_end_char = text_start_char + len(truncated_text)
    lines = truncated_text.splitlines()
    abbrev_text = truncated_text if len(lines) <= 2 else f"{lines[0]}\n...\n{lines[-1]}"
    abbrev = formatted[:text_start_char] + abbrev_text + formatted[text_end_char:]

    enc = tokenizer(
        formatted,
        return_tensors="pt",
        return_offsets_mapping=True,
    )

    input_ids = enc["input_ids"].to(device)
    offset_mapping = enc["offset_mapping"][0].tolist()

    prompt_end = len(offset_mapping)
    for i, (s, _) in enumerate(offset_mapping):
        if s >= text_start_char:
            prompt_end = i
            break

    embed_layer = model.get_input_embeddings()
    embeds = embed_layer(input_ids).detach().clone().requires_grad_(True)

    use_gc = _get_gradient_checkpointing()
    if _get_verbose():
        print(f"📌 logits_gradient: 推理原文 (tokens={len(offset_mapping)}):\n{abbrev}")
    if progress_callback:
        progress_callback(2, TOTAL_STEPS, "inference", None)
    model.eval()
    if use_gc:
        model.gradient_checkpointing_enable()
    try:
        with torch.set_grad_enabled(not full_match_degree_only):
            outputs = model(
                inputs_embeds=embeds,
                output_attentions=False,
            )
        # 显式同步，确保已完成，progress_callback 时机准确
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        elif device.type == "mps":
            torch.mps.synchronize()

        logits = outputs.logits[:, -1, :]
        topk_vals, topk_ids = torch.topk(logits, LOGITS_GRADIENT_TOPK, dim=-1)
        probs = torch.softmax(logits, dim=-1)
        topk_tokens, topk_probs = decode_topk_ids_to_strings_and_rounded_probs(
            probs[0], tokenizer, topk_ids[0]
        )
        if _get_verbose():
            print(f"top{LOGITS_GRADIENT_TOPK}: {[f'{t}({p*100:.1f}%)' for t, p in zip(topk_tokens, topk_probs)]}")

        neg_token = "无" if submode == "fill_blank" else "0"
        neg_id = tokenizer.encode(neg_token, add_special_tokens=False)[0]
        # 全文匹配度：count/match_score(已废弃) 用 1-P("0")，fill_blank 用 1-P("无")
        p_neg = probs[0, neg_id].item()
        full_match_degree = round(1.0 - p_neg, 4)

        if full_match_degree_only:
            return {
                "model": get_instruct_model_display_name(),
                "token_attention": [],
                "full_match_degree": full_match_degree,
            }

        if progress_callback:
            progress_callback(3, TOTAL_STEPS, "backward", None)
        # 归因目标：raw logits（不经过 softmax backward），避免饱和与竞争污染。
        if submode == "count" or submode == "fill_blank":
            # count/fill_blank 均用 top-10、按概率加权 Σ pᵢ·zᵢ，并排除 neg_token（0/无）以保持梯度方向与「相关」一致。
            vals = topk_vals[0]
            w = probs[0, topk_ids[0]].detach().clone()
            # 排除 neg_token
            w[topk_ids[0] == neg_id] = 0  

            target_logit = (w * vals).sum()
        elif submode == "match_score":  # 已废弃
            target_ids = tokenizer.encode("2", add_special_tokens=False)
            if not target_ids:
                raise ValueError("tokenizer 无法编码 '2'")
            target_logit = logits[0, target_ids[0]]
        else:
            raise ValueError(f"未知 submode: {submode}")
        target_logit.backward()
        grad = embeds.grad
        if grad is None:
            raise RuntimeError("logits_gradient: 梯度未回传，可能模型不支持（如 int8 量化）")

        # 显式同步，确保已完成，progress_callback 时机准确
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        elif device.type == "mps":
            torch.mps.synchronize()
        if progress_callback:
            progress_callback(4, TOTAL_STEPS, "processing", None)
            
        text_token_end = len(offset_mapping)
        # 在 GPU 上一次性计算所有 token 的 ‖∇f‖，避免循环内 .item() 导致 500 次 GPU→CPU 同步
        grad_slice = grad[0, prompt_end:text_token_end].float()
        norms = grad_slice.norm(dim=-1).cpu().tolist()
        token_attention: List[Dict] = []
        nan_count = 0
        for i in range(prompt_end, text_token_end):
            s, e = offset_mapping[i]
            if s >= text_start_char and e <= text_end_char:
                s_rel, e_rel = s - text_start_char, e - text_start_char
                score = norms[i - prompt_end]
                if not math.isfinite(score):
                    score = 0.0
                    nan_count += 1
                else:
                    score = round_to_sig_figs(score)
                token_attention.append({"offset": [s_rel, e_rel], "raw": truncated_text[s_rel:e_rel], "score": score})
        if nan_count > 0:
            print(f"⚠️ token_attention 中有 {nan_count} 个 score 为 NaN/Inf，已替换为 0。")

        out = {
            "model": get_instruct_model_display_name(),
            "token_attention": token_attention,
            "full_match_degree": full_match_degree,
        }
        if debug_info:
            out["debug_info"] = {"abbrev": abbrev, "topk_tokens": topk_tokens, "topk_probs": topk_probs}
        return out
    finally:
        if use_gc:
            model.gradient_checkpointing_disable()
        # 每次推理后清理：避免连续多次调用时 MPS/CUDA 内存累积导致卡死
        DeviceManager.clear_cache(device)


def analyze_semantic(
    query: str,
    text: str,
    submode_override: Optional[str] = None,
    progress_callback: Optional[Callable[[int, int, str, Optional[int]], None]] = None,
    debug_info: bool = False,
    full_match_degree_only: bool = False,
) -> Dict:
    """
    分析原文各 token 与 query 的相关度（使用 logits_gradient 梯度归因）。

    Args:
        query: 查询主题
        text: 原文
        submode_override: 评估时可选覆盖子模式（count/match_score已废弃/fill_blank）
        progress_callback: 可选进度回调 (step, total_steps, stage, percentage)
        debug_info: 为 True 时返回 debug_abbrev（推理原文缩写）；topk_tokens、topk_probs 始终在结果中

    Returns:
        {"model", "token_attention", "full_match_degree"}；debug_info=True 时包含 debug_info 对象
    """
    tokenizer, model, device = ensure_instruct_slot_ready()
    return _analyze_logits_gradient(
        query, text, tokenizer, model, device,
        submode_override=submode_override,
        progress_callback=progress_callback,
        debug_info=debug_info,
        full_match_degree_only=full_match_degree_only,
    )
