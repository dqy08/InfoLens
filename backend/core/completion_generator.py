"""
OpenAI /v1/completions：core_generate_from_text 为唯一续写入口。

Chat 模板拼装见 apply_chat_template_for_completion（供 POST /v1/completions/prompt）；
POST /v1/completions 的 prompt 须为已确定的模型输入字符串。
整段上下文 token 上限（prompt + 续写合计）为本模块 ``completion_max_token_length``；
可选 max_tokens 限制续写长度，且与 prompt 之和不超过该上限。
"""

import signal
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import torch
from transformers import StoppingCriteria, StoppingCriteriaList, TextStreamer

from backend.platform.format import round_to_sig_figs
from backend.platform.app_context import get_verbose
from backend.models.device import DeviceManager
from backend.models.model_manager import ModelSlot, ensure_slot_ready, ensure_slot_weights_loaded
from .pred_topk_format import pred_topk_pairs_from_probs_1d
from backend.platform.runtime_config import DEFAULT_TOPK

# 续写路径：prompt + 续写合计不得超过该 token 数（与语义分析 runtime 无关）。
completion_max_token_length = 300


def _model_context_token_limit(tokenizer, model) -> int:
    """管理员续写路径：须能解析模型上下文，否则抛错（不回退站点 500）。"""
    pe = getattr(getattr(model, "config", None), "max_position_embeddings", None)
    if isinstance(pe, int) and pe > 0:
        return pe
    ml = getattr(tokenizer, "model_max_length", None)
    if isinstance(ml, int) and 0 < ml < 1_000_000:
        return ml
    raise ModelContextLimitUnknownError(
        "无法从模型 config.max_position_embeddings 或 tokenizer.model_max_length "
        "确定上下文长度；管理员续写已拒绝。"
    )


# 特殊 token 亦视为分析/展示内容，故不跳过。
_COMPLETION_DECODE_SKIP_SPECIAL = False

# 进程收到 SIGTERM / SIGINT 时置位。
inference_shutdown_event = threading.Event()

# 单用户串行：用户 POST /v1/completions/stop、或 SSE 墙钟超时，与 inference_shutdown 一起在续写路径检查。
# 新一次 POST /v1/completions（SSE 入口）时由 openai_completions clear。
global_completion_stop_event = threading.Event()


def completion_cancel_requested() -> bool:
    """是否应停止当前续写（进程退出或全局停止）。"""
    return inference_shutdown_event.is_set() or global_completion_stop_event.is_set()


def register_inference_shutdown_handlers() -> None:
    """注册 SIGTERM / SIGINT：置位 inference_shutdown_event，使 model.generate 尽快在下一步停止。

    应在主线程、进程启动早期调用一次（如 server 加载时）。SIGINT 在置位后抛出 KeyboardInterrupt，便于开发态 Ctrl+C 退出。
    """

    def _on_sigterm(signum: int, frame: Any) -> None:
        inference_shutdown_event.set()

    def _on_sigint(signum: int, frame: Any) -> None:
        inference_shutdown_event.set()
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):
        pass
    try:
        signal.signal(signal.SIGINT, _on_sigint)
    except (ValueError, OSError):
        pass


class PromptTooLongError(ValueError):
    """prompt 过长或占满上下文导致无法续写（``input_len >= ctx_limit`` 时由 ``core_generate_from_text`` 抛出）。"""


class ModelContextLimitUnknownError(ValueError):
    """管理员 bypass 站点上限时无法解析模型上下文长度。"""


def _completion_without_generate(
    prompt_tokens: int,
) -> Tuple[str, str, int, int, List[Dict[str, Any]], Optional[float]]:
    """取消续写时未进入 ``model.generate`` 的返回（与前端 ``abort`` 展示一致）。"""
    return "", "abort", prompt_tokens, 0, [], None


def _print_completion_stream_delta(text: str, stream_end: bool) -> None:
    """接收 TextStreamer 切分好的增量片段，由本模块打印（与默认 TextStreamer 输出一致）。"""
    print(text, flush=True, end="" if not stream_end else None)


def _compose_stream_delta(
    stream_delta: Optional[Callable[[str, bool], None]],
) -> Callable[[str, bool], None]:
    """
    将可选的 SSE/外部 stream_delta 与本地 verbose 打印组合：二者互不替代，可同时生效。
    """
    def on_delta(text: str, stream_end: bool) -> None:
        if stream_delta is not None:
            stream_delta(text, stream_end)
        _print_completion_stream_delta(text, stream_end)

    return on_delta


class _DeltaTextStreamer(TextStreamer):
    """继承 put/end 的增量切分逻辑，只把片段交给回调，不直接 print。"""

    def __init__(
        self,
        tokenizer,
        on_delta: Callable[[str, bool], None],
        *,
        skip_prompt: bool = False,
        **decode_kwargs: Any,
    ) -> None:
        super().__init__(tokenizer, skip_prompt=skip_prompt, **decode_kwargs)
        self._on_delta = on_delta

    def on_finalized_text(self, text: str, stream_end: bool = False) -> None:
        self._on_delta(text, stream_end)


class _CancelOnEventStoppingCriteria(StoppingCriteria):
    """每步检查 ``completion_cancel_requested()``，尽快结束 generate。"""

    def __call__(
        self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs: Any
    ) -> torch.BoolTensor:
        # StoppingCriteria 约定：返回与 batch 等长的 bool 向量，True 表示该行本步停止生成。
        batch_size = input_ids.shape[0]
        cancel_requested = completion_cancel_requested()
        return torch.full(
            (batch_size,),
            fill_value=cancel_requested,
            device=input_ids.device,
            dtype=torch.bool,
        )


def _stack_scores_to_cpu(
    scores: Tuple[torch.Tensor, ...],
) -> torch.Tensor:
    """将 ``generate(..., output_scores=True)`` 的 scores 元组沿 batch 维拼成 ``[n, vocab]``，并一次搬到 CPU。"""
    if not scores:
        return torch.empty(0, 0)
    # 每步形状为 (batch, vocab)，greedy batch=1 时 cat(dim=0) -> (n, vocab)
    return torch.cat(scores, dim=0).detach().cpu()


def _print_completion_warning(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _completion_one_token_debug(tokenizer, token_id: int) -> str:
    """续写路径调试用：单 token 的 id 与 decode（repr 便于观察空白/换行）。"""
    decoded = tokenizer.decode([token_id], skip_special_tokens=False)
    return f"id={token_id}, decode={decoded!r}"


def _warn_decode_reencode_mismatch(
    tokenizer,
    *,
    n: int,
    mismatch_count: int,
    first: int,
    new_cpu: torch.Tensor,
    reencoded: torch.Tensor,
) -> None:
    """token 序列不一致时警告（文案与原 RuntimeError 一致），随后走增量 decode offset。"""
    g0 = int(new_cpu[first].item())
    r0 = int(reencoded[first].item())
    lines = [
        "续写段 decode→encode 与 generate 的 token 序列不一致，无法使用 offset_mapping。",
        f"  共 {n} token，其中 {mismatch_count} 处 id 不同（首处 index={first}）。",
        "  首处:",
        f"    generate  {_completion_one_token_debug(tokenizer, g0)}",
        f"    reencode  {_completion_one_token_debug(tokenizer, r0)}",
    ]
    nxt = first + 1
    if nxt < n:
        g1 = int(new_cpu[nxt].item())
        r1 = int(reencoded[nxt].item())
        lines.extend(
            [
                f"  后一处 (index={nxt}):",
                f"    generate  {_completion_one_token_debug(tokenizer, g1)}",
                f"    reencode  {_completion_one_token_debug(tokenizer, r1)}",
            ]
        )
    _print_completion_warning("\n".join(lines))


def _warn_decode_reencode_length_mismatch(
    new_cpu: torch.Tensor,
    reencoded: torch.Tensor,
) -> None:
    msg = (
        "续写段 decode→encode 与 generate 的 token 序列不一致（长度不同），无法使用 offset_mapping。\n"
        f"  new_ids:   shape={tuple(new_cpu.shape)}\n"
        f"  reencode:  shape={tuple(reencoded.shape)}"
    )
    _print_completion_warning(msg)


def _lcp_prefix_len(a: str, b: str) -> int:
    """``a`` 与 ``b`` 的最长公共前缀长度（Python ``str`` 下标，Unicode 标量）。 """
    k, n = 0, min(len(a), len(b))
    while k < n and a[k] == b[k]:
        k += 1
    return k


def _verbose_incremental_offset_step(
    *,
    step_1based: int,
    n_tokens: int,
    token_id: int,
    tokenizer,
    skip: bool,
    offset: Tuple[int, int],
    matched: int,
    curr_len: int,
    raw: str,
) -> None:
    """verbose：本步 ``offset``/``raw``；LCP 未盖满前缀时附 ``single_decode``。"""
    if not get_verbose():
        return
    s, e = offset
    raw_show = raw if len(raw) <= 240 else raw[:237] + "..."
    line = (
        f"[incremental-offset] step {step_1based}/{n_tokens} id={token_id} "
        f"offset=[{s},{e}) raw={raw_show!r}"
    )
    if matched < curr_len:
        one = tokenizer.decode([token_id], skip_special_tokens=skip)
        line += f" (bpe mismatch) single_decode={one!r}"
    _print_completion_warning(line)


def _print_full_decode_text_mismatch(full_decode: str, text: str) -> None:
    """整段 ``decode(ids)`` 与 ``completion_text`` 不等时打印一行级诊断。"""
    lines = [
        "续写段整段 decode 与 completion_text 不一致：",
        f"  len(decode)={len(full_decode)}, len(text)={len(text)}",
    ]
    n = min(len(full_decode), len(text))
    first_diff = next((k for k in range(n) if full_decode[k] != text[k]), None)
    if first_diff is not None:
        a, b = full_decode[first_diff], text[first_diff]
        lines.append(f"  首处 index={first_diff}: {a!r} vs {b!r}")
    elif len(full_decode) != len(text):
        lines.append("  同源码点前缀一致，仅长度不同。")
    _print_completion_warning("\n".join(lines))


def _completion_incremental_offsets_and_raws(
    tokenizer,
    new_ids: torch.Tensor,
    completion_text: str,
    *,
    skip: bool,
) -> Tuple[List[Tuple[int, int]], List[str]]:
    """
    慢路径：解码器码点。第 ``i`` 步 ``curr = decode(ids[:i+1])``，
    ``matched = LCP(curr, completion_text)``（自 0 全量比较，避免 decode 非单调时增量 LCP 偏差）；
    ``offset``：若 ``matched < len(curr)``（前缀与全文前沿未对齐），则 ``(off_left, off_left)``；
    否则 ``(off_left, len(curr))``。``raw`` 恒为 ``curr[off_left:]``。
    未对齐时 BPE 与全文对不齐，乱码段码点数、``offset`` 无可靠展示语义；右界收拢为左界仅为避免
    前端按 ``completion_text`` 切片校验 ``raw`` 时报错（零宽区间不取切片）。
    ``off_left``：首步 ``0``；若上一步 ``matched == len(curr)``，则 ``off_left = matched``；若上一步
    ``matched < len(curr)``，则冻结 ``off_left`` 直至再次出现完全对齐步。
    须 ``decode(ids) == completion_text``，否则报错。
    """
    ids = [int(t) for t in new_ids.tolist()]
    n_tok = len(ids)

    offsets: List[Tuple[int, int]] = []
    raws: List[str] = []
    off_left = 0

    # 每步对前缀 ``ids[:i+1]`` 整段 decode；重复切片为语义所需，非疏忽。
    for i in range(n_tok):
        curr = tokenizer.decode(ids[: i + 1], skip_special_tokens=skip)
        matched = _lcp_prefix_len(curr, completion_text)
        curr_len = len(curr)
        raw = curr[off_left:]
        # 未对齐：乱码长度与 offset 无可靠意义；右界=左界，避免前端 text[s:e]==raw 类校验失败。
        if matched < curr_len:
            off = (off_left, off_left)
        else:
            off = (off_left, curr_len)
        # _verbose_incremental_offset_step(
        #     step_1based=i + 1,
        #     n_tokens=n_tok,
        #     token_id=ids[i],
        #     tokenizer=tokenizer,
        #     skip=skip,
        #     offset=off,
        #     matched=matched,
        #     curr_len=curr_len,
        #     raw=raw,
        # )
        offsets.append(off)
        raws.append(raw)
        if matched == len(curr):
            off_left = matched

    full = tokenizer.decode(ids, skip_special_tokens=skip)
    if full != completion_text:
        _print_full_decode_text_mismatch(full, completion_text)
        raise RuntimeError(
            "续写段 decode(ids) 与 completion_text 不一致，无法填解码器坐标 offset/raw。"
        )
    return offsets, raws


def _build_generated_bpe_strings(
    tokenizer,
    new_ids: torch.Tensor,
    scores_logits: torch.Tensor,
    top_k: int,
    completion_text: str,
) -> List[Dict[str, Any]]:
    """
    续写段每个生成 token 的信息密度风格条目：offset/raw（相对续写全文）、real_topk、pred_topk。

    new_ids：1D int64，须已在 CPU，与 generate 输出一致。
    scores_logits：float，形状 ``[n, vocab]``，须已在 CPU（避免逐步 GPU softmax / .item() 往返）。
    completion_text：与 ``tokenizer.decode(new_ids, skip_special_tokens=...)`` 使用同一套参数得到的续写原文（调用方已 decode 一次，避免重复）。
    若整段 encode 与 ``new_ids`` 一致则用 ``offset_mapping``（快路径，offset 为 ``completion_text`` 内下标）；
    否则用增量 decode（慢路径）：LCP 未盖满前缀时 ``offset`` 为 ``(off_left, off_left)``（见该函数注释：主要为避免前端切片校验报错），否则 ``(off_left, len(curr))``；``raw`` 恒为 ``curr[off_left:]``。
    """
    n = int(new_ids.numel())
    if n == 0:
        return []
    if scores_logits.dim() != 2 or scores_logits.shape[0] != n:
        raise RuntimeError(
            f"scores_logits 形状与 new_ids 不一致：scores_logits.shape={tuple(scores_logits.shape)}, n={n}"
        )
    top_k = min(top_k, int(scores_logits.shape[-1]))
    new_cpu = new_ids.detach().cpu()
    skip = _COMPLETION_DECODE_SKIP_SPECIAL

    enc = tokenizer(
        completion_text,
        return_tensors="pt",
        return_offsets_mapping=True,
        add_special_tokens=False,
    )
    reencoded = enc["input_ids"][0]
    ids_match = reencoded.shape == new_cpu.shape and torch.equal(reencoded, new_cpu)

    incremental_raws: Optional[List[str]]
    if ids_match:
        offset_mapping = enc["offset_mapping"][0].tolist()
        incremental_raws = None
    else:
        if reencoded.shape != new_cpu.shape:
            _warn_decode_reencode_length_mismatch(new_cpu, reencoded)
        else:
            diff = reencoded != new_cpu
            first = int(torch.where(diff)[0][0].item())
            _warn_decode_reencode_mismatch(
                tokenizer,
                n=n,
                mismatch_count=int(diff.sum().item()),
                first=first,
                new_cpu=new_cpu,
                reencoded=reencoded,
            )
        print("已使用增量 decode 对齐路径；结果不受影响。", flush=True)
        offset_mapping, incremental_raws = _completion_incremental_offsets_and_raws(
            tokenizer, new_cpu, completion_text, skip=skip
        )

    out: List[Dict[str, Any]] = []
    for step in range(n):
        logits = scores_logits[step]
        probs = torch.softmax(logits, dim=-1)
        tid = int(new_ids[step].item())
        s, e = offset_mapping[step]
        if incremental_raws is not None:
            raw = incremental_raws[step]
        else:
            raw = completion_text[s:e] if s < e else ""
        out.append(
            {
                "offset": [s, e],
                "raw": raw,
                "real_topk": [0, round_to_sig_figs(float(probs[tid].item()))],
                "pred_topk": pred_topk_pairs_from_probs_1d(probs, tokenizer, top_k),
            }
        )
    return out


def core_generate_from_text(
    formatted_text: str,
    *,
    stream_delta: Optional[Callable[[str, bool], None]] = None,
    max_tokens: Optional[int] = None,
    bypass_site_context_limit: bool = False,
    slot: ModelSlot = ModelSlot.INSTRUCT,
) -> Tuple[str, str, int, int, List[Dict[str, Any]], Optional[float]]:
    """
    对一段已确定的模型输入字符串做自回归续写（默认贪心；函数内 ``_use_low_temp_sampling`` 可临时切到低温采样）。

    编码后 prompt token 数不得超过上下文上限；续写步数不超过「剩余上下文」且不超过可选 ``max_tokens``。

    中止条件见 ``completion_cancel_requested()``（进程信号、全局停止含用户 Stop / 墙钟超时）。

    Args:
        stream_delta: 可选；若提供则额外调用（如 SSE）。本地 verbose 打印由 ``_print_completion_stream_delta`` 单独控制，与是否传入 stream_delta 无关。
        max_tokens: 可选；正整数，限制本次最多生成多少个新 token（与 ``min(max_tokens, 上限 − prompt)`` 取小）。省略则用尽剩余上下文额度。
        bypass_site_context_limit: 为 True 时（管理员显式 max_tokens）不按站点上限封顶，``ctx_limit`` 为模型上下文上限；无法解析时抛 ``ModelContextLimitUnknownError``。

    Returns:
        (续写文本, finish_reason, prompt_tokens, completion_tokens, 续写段 bpe_strings, ttft_s)。
        ttft_s 为自 ``model.generate`` 起至首次产出续写片段的秒数；仅取消时为 ``None``。
    """
    tokenizer, model, device = ensure_slot_ready(slot)

    model.eval()
    enc = tokenizer(formatted_text, return_tensors="pt")
    input_ids = enc["input_ids"].to(device)
    input_len = input_ids.shape[1]
    n = int(input_len)
    if bypass_site_context_limit and max_tokens is not None:
        ctx_limit = _model_context_token_limit(tokenizer, model)
    else:
        ctx_limit = completion_max_token_length
    if n >= ctx_limit:
        raise PromptTooLongError(
            "Prompt too long: "
            f"{n} tokens (context limit is {ctx_limit} tokens; prompt plus completion must not exceed this limit)."
        )

    remaining = ctx_limit - n
    if max_tokens is None:
        effective_max_new = remaining
    else:
        effective_max_new = min(max_tokens, remaining)

    print(
        f"📌 completion: 推理原文 (tokens={input_len}, ctx_limit={ctx_limit}, max_new={effective_max_new}):\n"
        f"{formatted_text}",
        end="", # 不换行, 用于和后续打印推理结果拼在一起
    )

    prompt_tokens = int(input_len)
    # 主要防止：排队等推理锁期间用户已取消，拿到锁后在此短路，避免无意义进入 generate。
    # 墙钟 / 进程信号等其它情况较少见。
    if completion_cancel_requested():
        return _completion_without_generate(prompt_tokens)

    try:
        base_on_delta = _compose_stream_delta(stream_delta)
        ttft_seconds: Optional[float] = None
        gen_start_t0 = 0.0

        def on_delta_with_ttft(text: str, stream_end: bool) -> None:
            nonlocal ttft_seconds
            if ttft_seconds is None:
                ttft_seconds = time.perf_counter() - gen_start_t0
            base_on_delta(text, stream_end)

        streamer = _DeltaTextStreamer(
            tokenizer,
            on_delta_with_ttft,
            skip_prompt=True,
            skip_special_tokens=_COMPLETION_DECODE_SKIP_SPECIAL,
        )
        # 临时实验：置 True 启用低温采样；默认 False 为贪心解码（可复现）。
        _use_low_temp_sampling = False
        _low_temperature = 0.2

        gen_kw: Dict[str, Any] = {
            "input_ids": input_ids,
            "max_new_tokens": effective_max_new,
            "return_dict_in_generate": True,
            "output_scores": True,
            "streamer": streamer,
            "stopping_criteria": StoppingCriteriaList([_CancelOnEventStoppingCriteria()]),
        }
        if _use_low_temp_sampling:
            gen_kw["do_sample"] = True
            gen_kw["temperature"] = _low_temperature
        else:
            gen_kw["do_sample"] = False

        gen_start_t0 = time.perf_counter()
        with torch.inference_mode():
            outputs = model.generate(**gen_kw)
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        elif device.type == "mps":
            torch.mps.synchronize()

        gen = outputs.sequences
        new_ids = gen[0, input_len:].detach().cpu().contiguous()
        text = tokenizer.decode(new_ids, skip_special_tokens=_COMPLETION_DECODE_SKIP_SPECIAL)

        if outputs.scores is None:
            raise RuntimeError("model.generate 未返回 scores（需 output_scores=True）")

        if new_ids.numel() == 0:
            bpe_strings: List[Dict[str, Any]] = []
        else:
            # [len, vocab_size] 的 float32 logits
            # 内存开销 1000 token x qwen 150k ~= 600MB
            scores_cpu = _stack_scores_to_cpu(outputs.scores)
            bpe_strings = _build_generated_bpe_strings(
                tokenizer, new_ids, scores_cpu, DEFAULT_TOPK, text
            )

        # 续写增量已由 _print_completion_stream_delta 打印，此处不再重复打印全文
        if completion_cancel_requested():
            # 用户 Stop / 进程中止等：StoppingCriteria 提前结束时 new_ids 常少于上限，
            # 勿用 "stop"（OpenAI 语义多为自然结束），否则前端会误显示为 EOS。
            finish_reason = "abort"
        else:
            finish_reason = "length" if new_ids.numel() >= effective_max_new else "stop"
        prompt_tokens = int(input_len)
        completion_tokens = int(new_ids.numel())
        return text, finish_reason, prompt_tokens, completion_tokens, bpe_strings, ttft_seconds
    finally:
        DeviceManager.clear_cache(device)


def apply_chat_template_for_completion(
    messages: List[Dict[str, Any]],
    *,
    slot: ModelSlot = ModelSlot.INSTRUCT,
    enable_thinking: bool = False,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """
    将 messages 套用到 tokenizer chat template，返回实际送入 core_generate_from_text 的字符串。

    ``messages`` 为 OpenAI 形状（role/content；tool 消息可含 name）。长度与上下文上限由
    ``core_generate_from_text`` 在生成前校验。slot 控制使用哪个槽位的 tokenizer（base 传 ModelSlot.BASE）。
    """
    tokenizer, _, _ = ensure_slot_weights_loaded(slot)
    template_kw: Dict[str, Any] = {
        "tokenize": False,
        "add_generation_prompt": True,
        "enable_thinking": enable_thinking,
    }
    if tools:
        template_kw["tools"] = tools
    return tokenizer.apply_chat_template(messages, **template_kw)


_IM_END = "<|im_end|>"

# 不含特殊字符、不会被 template 处理掉的占位串，用于定位 assistant block 边界
_ASSISTANT_PLACEHOLDER = "\x00__DUMMY_ASST__\x00"


def compute_tool_append_suffix(
    tool_content: str,
    *,
    enable_thinking: bool = False,
    tool_name: Optional[str] = None,
    slot: ModelSlot = ModelSlot.INSTRUCT,
) -> str:
    """
    返回多轮 tool use 中，wire 追加 tool response 及下一轮 generation scaffold 的字面量后缀。

    wire 在上一轮模型输出（O₁）结束后已包含 <|im_end|>（因为 _COMPLETION_DECODE_SKIP_SPECIAL=False）。
    本函数返回的 suffix 需紧接 O₁ 追加，形成下一轮完整输入 wire₂ = wire₁ + suffix。

    suffix 仅取决于 tool_content 和 enable_thinking，与 wire 前序历史内容无关。
    """
    tokenizer, _, _ = ensure_slot_weights_loaded(slot)
    tool_msg: Dict[str, Any] = {"role": "tool", "content": tool_content}
    if tool_name:
        tool_msg["name"] = tool_name
    dummy = [
        {"role": "user", "content": "x"},
        {"role": "assistant", "content": _ASSISTANT_PLACEHOLDER},
        tool_msg,
    ]
    full = tokenizer.apply_chat_template(
        dummy, tokenize=False, add_generation_prompt=True, enable_thinking=enable_thinking
    )
    idx = full.find(_ASSISTANT_PLACEHOLDER)
    if idx == -1:
        raise RuntimeError("compute_tool_append_suffix: placeholder not found in template output")
    after_placeholder = full[idx + len(_ASSISTANT_PLACEHOLDER):]
    if not after_placeholder.startswith(_IM_END):
        raise RuntimeError(
            f"compute_tool_append_suffix: expected {_IM_END!r} after placeholder, "
            f"got: {after_placeholder[:80]!r}"
        )
    # O₁ 已包含 <|im_end|>，suffix 从其后开始
    return after_placeholder[len(_IM_END):]


def generate_completion_text(
    prompt: str,
    stream_delta: Optional[Callable[[str, bool], None]] = None,
    *,
    max_tokens: Optional[int] = None,
    bypass_site_context_limit: bool = False,
    slot: ModelSlot = ModelSlot.INSTRUCT,
) -> Tuple[str, str, int, int, List[Dict[str, Any]], Optional[float]]:
    """
    ``prompt`` 须为已确定的完整模型输入（不再在服务端套用 chat template）。

    流式可传 stream_delta；中止由 ``completion_cancel_requested()`` 统一判断。
    ``max_tokens`` 为可选的正整数续写上限（与 API 约定一致）。
    ``slot`` 与 API 请求体 ``model``（base / instruct）对应。
    """
    return core_generate_from_text(
        prompt,
        stream_delta=stream_delta,
        max_tokens=max_tokens,
        bypass_site_context_limit=bypass_site_context_limit,
        slot=slot,
    )
