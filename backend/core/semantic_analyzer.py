"""
Semantic analysis：基于 instruct 模型提取原文 token 与 query 的相关度

- analyze_relevance：全文相关度 full_match_degree（仅前向）。hybrid 门控用。
- analyze_keywords：填空式关键词归因 token_attention（前向+反向）。hybrid 染色用。

关键词归因按概率加权（Σ pᵢ·zᵢ）。提示词语言见模块常量（不经 API）。

模型由 --instruct_model 参数指定，默认 qwen3-0.6b-instruct
"""

import math
from typing import Callable, Dict, List, Optional, Tuple

import torch

from backend.platform.format import round_to_sig_figs
from backend.models.device import DeviceManager
from backend.models.model_manager import ensure_instruct_slot_ready, get_instruct_model_display_name
from .next_token_topk import decode_topk_ids_to_strings_and_rounded_probs, DEFAULT_NEXT_TOKEN_TOPK
from backend.platform.runtime_config import get_semantic_max_token_length

# 提示词语言：en | zh（改这里即可；不经 API）
RELEVANCE_PROMPT_LANG = "en"
KEYWORDS_PROMPT_LANG = "en"
# relevance 用「相关词个数」问法（neg=0）。曾对比 yes/no、0/1：count 明显最优；0/1 拒识更稳但易漏检；yes/no 假阳多（neg=No 易被 no/not 分流）

ProgressCallback = Optional[Callable[[int, int, str, Optional[int]], None]]


def _truncate_text_by_tokens(tokenizer, text: str, max_tokens: int) -> tuple[str, int]:
    """
    将 text 截断至最多 max_tokens 个 token；超长时打印提示。
    返回 (截断后文本, 实际 token 数)，token 数供调用方复用（日志等），避免重复分词。

    已知问题：截断是静默的，响应里没有任何字段告知调用方发生过截断。前端按字节数切 chunk
    （extension/config.js chunkBytes=800），与这里的 token 上限没有联动；数字/标点/代码等
    token 密度高的内容，800 字节可能远超 max_tokens，导致相关度判断和 keywords 高亮只覆盖
    截断后的前缀。后果是漏检（chunk 被判无关或部分内容不高亮），不是误报。调大 max_tokens
    只能缓解、不能根治（数字等本就按字符/短片段单独分词，token 密度上限很高）。
    """
    text_ids = tokenizer.encode(text, add_special_tokens=False)
    if len(text_ids) > max_tokens:
        print(f"⚠️  原文过长，已截断至前 {max_tokens} token")
        return tokenizer.decode(text_ids[:max_tokens]), max_tokens
    return text, len(text_ids)


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


def _sync_device(device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    elif device.type == "mps":
        torch.mps.synchronize()


def _relevance_prompt_parts(query: str, prompt_lang: str) -> Tuple[str, str, str]:
    """(instruction, generation_guide, neg_token)。neg_token 用于 full_match_degree=1-P(neg)。"""
    if prompt_lang == "en":
        return (
            f"How many words in the text below are related to the query topic ({query})? Text:\n\n",
            f"The number of words in the text related to the query topic ({query}) = **",
            "0",
        )
    if prompt_lang == "zh":
        return (
            f"请问下面文字中有多少个词与查询主题（{query}）相关？文字内容：\n\n",
            f"原文中与查询主题（{query}）相关的词的数量 = **",
            "0",
        )
    raise ValueError(f"Unknown prompt_lang: {prompt_lang}")


def _keywords_prompt_parts(query: str, prompt_lang: str) -> Tuple[str, str]:
    """(instruction, generation_guide)。"""
    if prompt_lang == "en":
        return (
            f"Which word in the text below is most related to the query topic ({query})? Text:\n\n",
            # Leading quote prevents the model from emitting a quote as the answer
            f"The word in the text most related to the query topic ({query}) is: **\"",
        )
    if prompt_lang == "zh":
        return (
            f"请问下面文字中哪个词与查询主题（{query}）最相关？文字内容：\n\n",
            # “引号是特意为了防止模型生成引号
            f"原文中与查询主题（{query}）最相关的一个词是：**“",
        )
    raise ValueError(f"Unknown prompt_lang: {prompt_lang}")


def _format_user_prompt(tokenizer, instruction: str, truncated_text: str, generation_guide: str) -> str:
    messages = [{"role": "user", "content": instruction + truncated_text}]
    formatted = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
    )
    return formatted + generation_guide


def _make_embeds(model, input_ids, *, requires_grad: bool):
    embeds = model.get_input_embeddings()(input_ids).detach().clone()
    if requires_grad:
        embeds.requires_grad_(True)
    return embeds


def _encode_for_analysis(
    tokenizer,
    model,
    device,
    instruction: str,
    generation_guide: str,
    text: str,
    max_length: int,
    *,
    requires_grad: bool,
) -> dict:
    truncated_text, input_token_count = _truncate_text_by_tokens(tokenizer, text, max_length)
    formatted = _format_user_prompt(tokenizer, instruction, truncated_text, generation_guide)

    idx = formatted.find(instruction)
    instruction_start_char = idx if idx >= 0 else 0
    text_start_char = instruction_start_char + len(instruction)
    text_end_char = text_start_char + len(truncated_text)
    lines = truncated_text.splitlines()
    abbrev_text = truncated_text if len(lines) <= 2 else f"{lines[0]}\n...\n{lines[-1]}"
    abbrev = formatted[:text_start_char] + abbrev_text + formatted[text_end_char:]

    enc = tokenizer(formatted, return_tensors="pt", return_offsets_mapping=True)
    input_ids = enc["input_ids"].to(device)
    offset_mapping = enc["offset_mapping"][0].tolist()

    prompt_end = len(offset_mapping)
    for i, (s, _) in enumerate(offset_mapping):
        if s >= text_start_char:
            prompt_end = i
            break

    embeds = _make_embeds(model, input_ids, requires_grad=requires_grad)
    return {
        "truncated_text": truncated_text,
        "input_token_count": input_token_count,
        "embeds": embeds,
        "offset_mapping": offset_mapping,
        "prompt_end": prompt_end,
        "text_start_char": text_start_char,
        "text_end_char": text_end_char,
        "abbrev": abbrev,
    }


def _forward_logits(
    model,
    embeds,
    device,
    tokenizer,
    *,
    with_grad: bool,
    topk: int = DEFAULT_NEXT_TOKEN_TOPK,
):
    """前向：返回 logits, probs, topk_vals, topk_ids, topk_tokens, topk_probs。"""
    with torch.set_grad_enabled(with_grad):
        outputs = model(inputs_embeds=embeds, output_attentions=False)
    _sync_device(device)

    logits = outputs.logits[:, -1, :]
    topk_vals, topk_ids = torch.topk(logits, topk, dim=-1)
    probs = torch.softmax(logits, dim=-1)
    topk_tokens, topk_probs = decode_topk_ids_to_strings_and_rounded_probs(
        probs[0], tokenizer, topk_ids[0]
    )
    if _get_verbose():
        print(f"top{topk}: {[f'{t}({p*100:.1f}%)' for t, p in zip(topk_tokens, topk_probs)]}")
    return logits, probs, topk_vals, topk_ids, topk_tokens, topk_probs


def _debug_payload(abbrev, topk_tokens, topk_probs) -> dict:
    return {"abbrev": abbrev, "topk_tokens": topk_tokens, "topk_probs": topk_probs}


def analyze_relevance(
    query: str,
    text: str,
    progress_callback: ProgressCallback = None,
    debug_info: bool = False,
) -> Dict:
    """全文相关度：仅前向，返回 full_match_degree（无 token_attention）。"""
    TOTAL_STEPS = 2
    tokenizer, model, device = ensure_instruct_slot_ready()
    max_length = get_semantic_max_token_length()

    if progress_callback:
        progress_callback(1, TOTAL_STEPS, "encoding", None)
    instruction, generation_guide, neg_token = _relevance_prompt_parts(query, RELEVANCE_PROMPT_LANG)
    enc = _encode_for_analysis(
        tokenizer, model, device, instruction, generation_guide, text, max_length,
        requires_grad=False,
    )
    if _get_verbose():
        print(f"📌 relevance: 推理原文 (tokens={len(enc['offset_mapping'])}):\n{enc['abbrev']}")

    if progress_callback:
        progress_callback(2, TOTAL_STEPS, "inference", None)
    model.eval()
    try:
        _, probs, _, _, topk_tokens, topk_probs = _forward_logits(
            model, enc["embeds"], device, tokenizer, with_grad=False,
        )
        neg_id = tokenizer.encode(neg_token, add_special_tokens=False)[0]
        full_match_degree = round(1.0 - probs[0, neg_id].item(), 4)
        out = {
            "model": get_instruct_model_display_name(),
            "full_match_degree": full_match_degree,
            "input_token_count": enc["input_token_count"],
        }
        if debug_info:
            out["debug_info"] = _debug_payload(enc["abbrev"], topk_tokens, topk_probs)
        return out
    finally:
        DeviceManager.clear_cache(device)


def analyze_relevance_batch(
    query: str,
    texts: List[str],
    progress_callback: ProgressCallback = None,
) -> List[Dict]:
    """
    批量相关度前向：多条 text 一次 forward，仅 full_match_degree。

    性能结论（本地 CPU/线上服务器实测）：
    batching 对本函数内前向计算的加速有限，batch=4 约 1.3~1.5x，batch=8 约 1.6x，
    边际递减明显；MPS 上则几乎无收益。线上用客户端总耗时测得的更高"加速比"，
    大头来自摊薄了每次 HTTP 请求固定的网络/SSE 开销（约 1.2~1.7s，与 batch 无关），
    并非本函数计算变快。
    """
    TOTAL_STEPS = 2
    tokenizer, model, device = ensure_instruct_slot_ready()
    max_length = get_semantic_max_token_length()

    if progress_callback:
        progress_callback(1, TOTAL_STEPS, "encoding", None)
    instruction, generation_guide, neg_token = _relevance_prompt_parts(query, RELEVANCE_PROMPT_LANG)

    formatted_list = []
    input_token_counts = []
    for text in texts:
        truncated_text, input_token_count = _truncate_text_by_tokens(tokenizer, text, max_length)
        input_token_counts.append(input_token_count)
        formatted_list.append(_format_user_prompt(tokenizer, instruction, truncated_text, generation_guide))

    # 左 padding：批内各序列长度不同，取 logits[:, -1, :] 时需保证最后一列都是各自真实末尾 token
    # pad_token / padding_side 都是共享 tokenizer 上的可变状态，用完必须还原
    original_pad_token = tokenizer.pad_token
    original_padding_side = tokenizer.padding_side
    try:
        if tokenizer.pad_token_id is None:
            tokenizer.pad_token = tokenizer.eos_token
        tokenizer.padding_side = "left"
        enc = tokenizer(formatted_list, return_tensors="pt", padding=True)
    finally:
        tokenizer.padding_side = original_padding_side
        tokenizer.pad_token = original_pad_token

    input_ids = enc["input_ids"].to(device)
    attention_mask = enc["attention_mask"].to(device)

    if progress_callback:
        progress_callback(2, TOTAL_STEPS, "inference", None)
    model.eval()
    with torch.no_grad():
        outputs = model(input_ids=input_ids, attention_mask=attention_mask, output_attentions=False)
    _sync_device(device)

    probs = torch.softmax(outputs.logits[:, -1, :], dim=-1)
    neg_id = tokenizer.encode(neg_token, add_special_tokens=False)[0]
    full_match_degrees = (1.0 - probs[:, neg_id]).tolist()

    DeviceManager.clear_cache(device)
    return [
        {
            "model": get_instruct_model_display_name(),
            "full_match_degree": round(fmd, 4),
            "input_token_count": input_token_count,
        }
        for fmd, input_token_count in zip(full_match_degrees, input_token_counts)
    ]


def analyze_keywords(
    query: str,
    text: str,
    progress_callback: ProgressCallback = None,
    debug_info: bool = False,
) -> Dict:
    """关键词归因：前向+反向，返回 token_attention（无 full_match_degree）。"""
    TOTAL_STEPS = 4
    tokenizer, model, device = ensure_instruct_slot_ready()
    max_length = get_semantic_max_token_length()

    if progress_callback:
        progress_callback(1, TOTAL_STEPS, "encoding", None)
    instruction, generation_guide = _keywords_prompt_parts(query, KEYWORDS_PROMPT_LANG)
    enc = _encode_for_analysis(
        tokenizer, model, device, instruction, generation_guide, text, max_length,
        requires_grad=True,
    )
    if _get_verbose():
        print(f"📌 keywords: 推理原文 (tokens={len(enc['offset_mapping'])}):\n{enc['abbrev']}")

    if progress_callback:
        progress_callback(2, TOTAL_STEPS, "inference", None)
    model.eval()
    use_gc = _get_gradient_checkpointing()
    if use_gc:
        model.gradient_checkpointing_enable()
    try:
        _, probs, topk_vals, topk_ids, topk_tokens, topk_probs = _forward_logits(
            model, enc["embeds"], device, tokenizer, with_grad=True,
        )

        if progress_callback:
            progress_callback(3, TOTAL_STEPS, "backward", None)
        # 归因目标：raw logits（不经过 softmax backward），top-k 按概率加权 Σ pᵢ·zᵢ
        vals = topk_vals[0]
        w = probs[0, topk_ids[0]].detach().clone()
        target_logit = (w * vals).sum()
        target_logit.backward()
        grad = enc["embeds"].grad
        if grad is None:
            raise RuntimeError(
                "keywords: gradients not available (model may not support this, e.g. int8)"
            )
        _sync_device(device)

        if progress_callback:
            progress_callback(4, TOTAL_STEPS, "processing", None)

        offset_mapping = enc["offset_mapping"]
        prompt_end = enc["prompt_end"]
        text_start_char = enc["text_start_char"]
        text_end_char = enc["text_end_char"]
        truncated_text = enc["truncated_text"]
        # 在 GPU 上一次性计算所有 token 的 ‖∇f‖，避免循环内 .item() 导致多次 GPU→CPU 同步
        grad_slice = grad[0, prompt_end:len(offset_mapping)].float()
        norms = grad_slice.norm(dim=-1).cpu().tolist()
        # 响应字段名 token_attention 为历史遗留；值为各 token 归因 score，非 attention 权重
        token_attention: List[Dict] = []
        nan_count = 0
        for i in range(prompt_end, len(offset_mapping)):
            s, e = offset_mapping[i]
            if s >= text_start_char and e <= text_end_char:
                s_rel, e_rel = s - text_start_char, e - text_start_char
                score = norms[i - prompt_end]
                if not math.isfinite(score):
                    score = 0.0
                    nan_count += 1
                else:
                    score = round_to_sig_figs(score)
                token_attention.append({
                    "offset": [s_rel, e_rel],
                    "raw": truncated_text[s_rel:e_rel],
                    "score": score,
                })
        if nan_count > 0:
            print(f"⚠️ token_attention 中有 {nan_count} 个 score 为 NaN/Inf，已替换为 0。")

        out = {
            "model": get_instruct_model_display_name(),
            "token_attention": token_attention,
            "input_token_count": enc["input_token_count"],
        }
        if debug_info:
            out["debug_info"] = _debug_payload(enc["abbrev"], topk_tokens, topk_probs)
        return out
    finally:
        if use_gc:
            model.gradient_checkpointing_disable()
        DeviceManager.clear_cache(device)
