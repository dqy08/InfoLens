"""
Causal LM 模型加载：设备策略与加载逻辑统一封装

供 language_checker.QwenLM（信息密度分析）与 model_manager.ensure_model_loaded 共用，
消除重复的设备分支、量化配置、加载后处理等逻辑。

加载策略说明：
- INT8 量化：bitsandbytes 8bit，device_map="cpu"/"auto"，减少约 4 倍内存
- CPU 手动模式：无 device_map，.to(device)，默认 float32
- GPU/MPS 自动模式：device_map="auto"，float16

dtype/设备与因果 LM 在「仅前缀 forward」vs「整段 forward」同位置 logits 的逐元素对比：
float32（CPU）常完全一致；float16（MPS/CUDA）可能因实现路径出现约 1e-2 量级差，非掩码错误。
复现与说明见 scripts/reproduce_logits_triple_path.py、scripts/prove_fp16_gemm_shape_sensitivity.py。
"""

import os
import time
from typing import Any, Dict, Optional

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.utils import is_flash_attn_2_available

from .device import DeviceManager
from .load_utils import resolve_and_load
from backend.platform.quantization_config import get_quantization_config


def get_device_load_strategy(device: torch.device) -> Dict[str, Any]:
    """
    根据设备推断加载策略（device_map、dtype、use_int8 等）。

    打印设备模式说明，与 QwenLM 风格一致。
    环境变量：FORCE_INT8=1 / CPU_FORCE_BFLOAT16=1
    返回供 load_causal_lm 使用的参数字典。
    """
    qconfig = get_quantization_config(device)
    use_int8 = qconfig.use_int8
    device_map = None
    dtype = qconfig.dtype
    use_low_cpu_mem = False

    if device.type == "cpu":
        print("🔧 CPU 模式：手动控制设备分配")
        if use_int8:
            device_map = "cpu"
            print("⚠️  启用 INT8 量化（FORCE_INT8=1，实验性，在某些情况下会降低性能）")
        elif dtype == torch.bfloat16:
            use_low_cpu_mem = True
            print("⚠️  启用 bfloat16（CPU_FORCE_BFLOAT16=1，需硬件支持 AVX-512_BF16 或 AMX，否则可能极慢）")
        else:
            use_low_cpu_mem = True
            print("🔧 dtype: float32")  # 默认: float32
    elif device.type == "cuda":
        print("🔧 CUDA 模式：自动设备分配")
        device_map = "auto"
        use_low_cpu_mem = True
        if use_int8:
            print("⚠️  启用 INT8 量化（FORCE_INT8=1）")
        else:
            print("🔧 dtype: float16")
        print("🔧 device_map: auto")
    else:
        # MPS 模式：自动设备分配 + float16（MPS 不支持 INT8 量化）
        print(f"🔧 {device.type.upper()} 模式：自动设备分配")
        if os.environ.get("FORCE_INT8") == "1":
            print("⚠️  MPS 不支持 INT8 量化，已忽略 FORCE_INT8=1 环境变量")
        device_map = "auto"
        use_low_cpu_mem = True
        print("🔧 dtype: float16")
        print("🔧 device_map: auto")

    return {
        "device_map": device_map,
        "dtype": dtype,
        "use_low_cpu_mem": use_low_cpu_mem,
        "use_int8": use_int8,
    }


def attn_implementation_for_device(device: torch.device) -> str:
    """
    非 CUDA：eager，兼容性最好（CPU / MPS 等）。
    CUDA：已安装 flash-attn 时用 flash_attention_2；否则 eager（不使用 sdpa）。
    """
    if device.type != "cuda":
        return "eager"
    if is_flash_attn_2_available():
        return "flash_attention_2"
    return "eager"


def load_causal_lm(
    model_path: str,
    device: torch.device,
    *,
    attn_implementation: Optional[str] = None,
    extra_model_kwargs: Optional[Dict[str, Any]] = None,
) -> torch.nn.Module:
    """
    加载 Causal LM 模型，统一处理设备策略、量化、加载后处理。

    Args:
        model_path: HuggingFace 模型路径或本地路径
        device: 目标设备
        attn_implementation: 可选；未传时可在外层用 attn_implementation_for_device(device)
        extra_model_kwargs: 可选，额外传给 from_pretrained 的参数

    Returns:
        已 eval() 的模型
    """
    strategy = get_device_load_strategy(device)
    device_map = strategy["device_map"]
    dtype = strategy["dtype"]
    use_low_cpu_mem = strategy["use_low_cpu_mem"]
    use_int8 = strategy["use_int8"]

    load_kw: Dict[str, Any] = {
        "trust_remote_code": True,
        "low_cpu_mem_usage": use_low_cpu_mem or use_int8,
    }
    if attn_implementation is not None:
        load_kw["attn_implementation"] = attn_implementation
    if extra_model_kwargs:
        load_kw.update(extra_model_kwargs)

    def _load(path: str, lf: bool):
        kw = dict(local_files_only=lf, **load_kw)
        if use_int8:
            from transformers import BitsAndBytesConfig
            return AutoModelForCausalLM.from_pretrained(
                path,
                quantization_config=BitsAndBytesConfig(load_in_8bit=True),
                device_map=device_map,
                **kw,
            )
        if device_map:
            return AutoModelForCausalLM.from_pretrained(
                path,
                device_map=device_map,
                dtype=dtype,
                **kw,
            )
        return AutoModelForCausalLM.from_pretrained(
            path, dtype=dtype, **kw
        ).to(device)

    t0 = time.perf_counter()
    model = resolve_and_load(model_path, _load)
    load_time = time.perf_counter() - t0

    DeviceManager.print_model_load_stats(model, load_time)
    model.eval()
    if device.type == "cuda":
        device_idx = device.index if device.index is not None else 0
        DeviceManager.print_cuda_memory_summary(device=device_idx)
    return model


def load_tokenizer(model_path: str):
    """加载 tokenizer。本地优先时先解析为缓存路径，避免 tokenizer 内部 model_info 联网。"""

    def _load(path: str, lf: bool):
        return AutoTokenizer.from_pretrained(
            path, trust_remote_code=True, local_files_only=lf
        )

    return resolve_and_load(model_path, _load)
