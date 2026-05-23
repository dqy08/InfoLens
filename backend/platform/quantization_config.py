"""
量化配置（语义分析、信息密度分析共用）

从环境变量读取并返回设备相关的量化策略：
- FORCE_INT8=1: INT8 量化（CPU/CUDA 支持，MPS 不支持）
- CPU_FORCE_BFLOAT16=1: CPU 使用 bfloat16
"""

import os
from typing import NamedTuple

import torch


class QuantizationConfig(NamedTuple):
    """量化配置，语义模型和信息密度模型共用"""
    use_int8: bool
    dtype: torch.dtype


def get_quantization_config(device: torch.device) -> QuantizationConfig:
    """
    根据设备和环境变量返回量化配置。

    Returns:
        QuantizationConfig: use_int8, dtype
    """
    force_int8 = os.environ.get("FORCE_INT8") == "1"
    force_bfloat16 = os.environ.get("CPU_FORCE_BFLOAT16") == "1"

    if device.type == "cpu":
        use_int8 = force_int8
        dtype = torch.bfloat16 if force_bfloat16 else torch.float32
    elif device.type == "cuda":
        use_int8 = force_int8
        dtype = torch.float16
    else:
        # MPS 不支持 INT8
        use_int8 = False
        dtype = torch.float16

    return QuantizationConfig(use_int8=use_int8, dtype=dtype)
