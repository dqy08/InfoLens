"""
运行时配置管理模块

负责管理不同模型在不同平台下的运行时参数配置，包括：
- max_token_length: 文本分析的最大 token 数限制（信息密度分析）
- chunk_size: 推理时的分块大小
- 语义分析有独立的 SEMANTIC_RUNTIME_CONFIGS，仅含 max_token_length

平台 ID 说明：
- local_mps: 本地 Apple Silicon（M1/M2/M3）
- cloud_cuda: 云端 CUDA GPU
- cloud_cpu_16g: 云端大内存 CPU（如 HF Space 免费层，16G RAM）
- cloud_cpu_32g: 云端大内存 CPU（如 HF Space CPU upgrade，32G RAM）
- default_cpu_machine: 默认 CPU 机器（未知或未识别的 CPU 环境）
- 未来可扩展: cloud_cuda_a100, cloud_cuda_24g 等
"""

import os
import torch
import sys
from typing import Dict, Optional


# ============= 平台级常量 =============

# 分析接口的 pred_topk 默认数量（候选词数量）
# 前端 ToolTip 显示数量与此保持一致
DEFAULT_TOPK = 10

# MPS 单次 TopK 操作的安全序列长度上限（避免 MPS bug）
# chunk_size 必须小于此值以确保每个 chunk 的 TopK 计算安全
MPS_TOPK_BUG_THRESHOLD = 2048


# ============= 运行时参数配置表 (Model × Platform) =============
# 
# 二维表结构：每个模型针对每个平台配置 max_token_length 和 chunk_size
# 
# 四层覆盖优先级（从高到低）：
#   1. (model_name, platform)        - 模型在该平台的专用配置（最精确）
#   2. (model_name, "default_cpu_machine") - 模型的通用配置（跨平台）
#   3. ("default_model", platform)   - 平台的通用配置（跨模型）
#   4. ("default_model", "default_cpu_machine") - 全局兜底配置
#
# 每层支持部分覆盖：只填 max_token_length 或 chunk_size 均可

RUNTIME_CONFIGS = {
    # 全局默认模型配置
    "default_model": {
        # 默认 CPU 机器配置（最保守，用于未识别的 CPU 环境）
        "default_cpu_machine": {
            "max_token_length": 2000,
            "chunk_size": 256
        },
        # 云端 CPU（16G），如 HF Spaces CPU basic
        "cloud_cpu_16g": {
            "max_token_length": 2000,
            "chunk_size": 256
        },
        # 云端 CPU（32G），如 HF Spaces CPU upgrade
        "cloud_cpu_32g": {
            "max_token_length": 5000,
            "chunk_size": 512
        },
        # 云端 GPU 显存充足
        "cloud_cuda": {
            # "max_token_length": 10000,
            "max_token_length": 5000,
            "chunk_size": 1024
        },
        # 本地 Apple Silicon
        "local_mps": {
            "max_token_length": 2000,
            "chunk_size": 512
        }
    },
    # # Qwen3-1.7B
    # "qwen3-1.7b": {
    #     "local_mps": {
    #         "max_token_length": 2000,
    #         "chunk_size": 128
    #     }
    # }
}


# ============= 语义分析运行时配置（仅 max_token_length） =============
# 按平台配置，语义分析独立于信息密度模型

SEMANTIC_RUNTIME_CONFIGS = {
    "default_cpu_machine": {"max_token_length": 300},
    "cloud_cpu_16g": {"max_token_length": 300},
    "cloud_cpu_32g": {"max_token_length": 1000},
    "cloud_cuda": {"max_token_length": 1000},
    "local_mps": {"max_token_length": 300},
}


# ============= 平台检测与配置解析 =============

def detect_platform(verbose: bool = True) -> str:
    """
    自动检测当前运行平台
    
    优先级：
      1. 环境变量 FORCE_CPU（显式强制 CPU 模式）
      2. 自动探测硬件（cuda/mps/cpu）
      3. 细分 CPU 类型（如 cloud_cpu_16g）
    
    Args:
        verbose: 是否打印检测信息
    
    Returns:
        平台 ID 字符串（如 'local_mps', 'cloud_cuda', 'cloud_cpu_16g', 'cloud_cpu_32g', 'default_cpu_machine'）
    """
    # 1. 显式强制 CPU（可通过环境变量 FORCE_CPU=1 启用）
    if os.environ.get("FORCE_CPU") == "1":
        print(f"🔧 强制 CPU 模式")
        return _detect_cpu_variant()
    
    # 2. 自动探测 GPU/MPS
    if torch.cuda.is_available():
        platform = "cloud_cuda"
    elif torch.backends.mps.is_available():
        platform = "local_mps"
    else:
        # 3. 细分 CPU 类型
        platform = _detect_cpu_variant()
    
    print(f"🔍 自动检测平台配置: {platform}")
    return platform


def _detect_cpu_variant() -> str:
    """
    检测具体的 CPU 环境变体（内部函数）
    根据内存大小识别不同的 CPU 环境：
    - >= 30GB: cloud_cpu_32g（32G 内存环境）
    - >= 15GB: cloud_cpu_16g（16G 内存环境）
    - 其他: default_cpu_machine（默认配置）
    
    优先检测容器内存限制（cgroup），如果不可用则回退到系统内存检测。
    """
    total_memory = 0
    
    try:
        # 优先检测容器内存限制（cgroup）
        # cgroup v2: /sys/fs/cgroup/memory.max
        # cgroup v1: /sys/fs/cgroup/memory/memory.limit_in_bytes
        cgroup_paths = [
            "/sys/fs/cgroup/memory.max",  # cgroup v2
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",  # cgroup v1
        ]
        
        for cgroup_path in cgroup_paths:
            try:
                if os.path.exists(cgroup_path):
                    with open(cgroup_path, 'r') as f:
                        limit_str = f.read().strip()
                        # cgroup v2 可能返回 "max" 表示无限制
                        if limit_str == "max":
                            break
                        limit_bytes = int(limit_str)
                        if limit_bytes > 0 and limit_bytes < (2 ** 63):  # 合理范围
                            total_memory = limit_bytes
                            print(f"🔍 从 cgroup 检测到容器内存限制: {total_memory / (1024 ** 3):.2f} GB")
                            break
            except (ValueError, IOError, OSError):
                continue
        
        # 如果 cgroup 检测失败，回退到系统内存检测
        if total_memory == 0 and sys.platform != "win32":
            try:
                page_size = os.sysconf('SC_PAGE_SIZE')
                phys_pages = os.sysconf('SC_PHYS_PAGES')
                total_memory = page_size * phys_pages
                print(f"🔍 从系统配置检测到内存: {total_memory / (1024 ** 3):.2f} GB")
            except (ValueError, AttributeError):
                pass
        
        # 转换为 GB
        total_memory_gb = total_memory / (1024 ** 3)
        
        # 判断标准：
        # - >= 30GB: cloud_cpu_32g（HF Spaces CPU upgrade 通常会有 30.x GB 可见）
        # - >= 15GB: cloud_cpu_16g（HF Spaces CPU basic 通常会有 15.x GB 可见）
        if total_memory_gb >= 30.0:
            return "cloud_cpu_32g"
        elif total_memory_gb >= 15.0:
            return "cloud_cpu_16g"
            
    except Exception as e:
        print(f"⚠️  CPU 环境检测失败，回退到默认配置: {e}")
    
    return "default_cpu_machine"


def merge_runtime_config(model_name: str, platform: str, verbose: bool = True) -> Dict[str, int]:
    """
    四层配置合并：支持部分覆盖，并追踪配置来源
    
    优先级（从高到低）：
      1. (model_name, platform)        - 模型在该平台的专用配置
      2. (model_name, "default_cpu_machine") - 模型通用配置
      3. ("default_model", platform)   - 平台通用配置
      4. ("default_model", "default_cpu_machine") - 全局兜底
    
    Args:
        model_name: 模型名称（如 'qwen3-1.7b'）
        platform: 平台 ID（如 'local_mps'）
        verbose: 是否打印配置来源提示
    
    Returns:
        合并后的配置字典 {"max_token_length": int, "chunk_size": int}
    
    Raises:
        ValueError: 配置不完整时抛出
    """
    # 准备四层配置（从低优先级到高优先级）
    layers = [
        {
            "name": "default_model.default_cpu_machine",
            "config": RUNTIME_CONFIGS.get("default_model", {}).get("default_cpu_machine", {})
        },
        {
            "name": f"default_model.{platform}",
            "config": RUNTIME_CONFIGS.get("default_model", {}).get(platform, {})
        },
        {
            "name": f"{model_name}.default_cpu_machine",
            "config": RUNTIME_CONFIGS.get(model_name, {}).get("default_cpu_machine", {})
        },
        {
            "name": f"{model_name}.{platform}",
            "config": RUNTIME_CONFIGS.get(model_name, {}).get(platform, {})
        }
    ]
    
    # 追踪每个配置项的来源
    config_sources = {}  # {"max_token_length": "层级名称", "chunk_size": "层级名称"}
    merged = {}
    
    # 依次合并（后面的覆盖前面的）
    for layer in layers:
        layer_config = layer["config"]
        for key, value in layer_config.items():
            merged[key] = value
            config_sources[key] = layer["name"]
    
    # 确保必需字段存在
    if "max_token_length" not in merged or "chunk_size" not in merged:
        raise ValueError(
            f"配置不完整: model={model_name}, platform={platform}, "
            f"merged={merged}. 缺少必需字段！"
        )
    
    # 打印当前使用的配置项的配置来源
    for key, source in config_sources.items():
        actual_value = merged[key]
        print(f"\t{key}={actual_value} ( {source})")
    
    return merged


_semantic_max_token_length_cache: Optional[int] = None


def get_semantic_max_token_length(verbose: bool = False) -> int:
    """
    获取语义分析的 max_token_length（从 SEMANTIC_RUNTIME_CONFIGS 按平台读取）
    平台检测结果会缓存，避免每次分析重复检测。
    """
    global _semantic_max_token_length_cache
    if _semantic_max_token_length_cache is not None:
        return _semantic_max_token_length_cache
    platform = detect_platform(verbose=verbose)
    config = SEMANTIC_RUNTIME_CONFIGS.get(platform, SEMANTIC_RUNTIME_CONFIGS["default_cpu_machine"])
    _semantic_max_token_length_cache = config["max_token_length"]
    return _semantic_max_token_length_cache


def validate_platform_config(platform: str, chunk_size: int, verbose: bool = True) -> None:
    """
    平台级安全校验（前置到初始化阶段）
    
    Args:
        platform: 平台 ID
        chunk_size: 配置的 chunk_size
        verbose: 是否打印校验信息
    
    Raises:
        ValueError: 配置不符合平台限制时抛出
    """
    # MPS 平台的特殊限制
    if "mps" in platform.lower():
        if chunk_size > MPS_TOPK_BUG_THRESHOLD:
            raise ValueError(
                f"❌ MPS 平台配置错误: chunk_size ({chunk_size}) "
                f"超过安全上限 ({MPS_TOPK_BUG_THRESHOLD})\n"
                f"   平台: {platform}\n"
                f"   建议: 调整 RUNTIME_CONFIGS 中 {platform} 的 chunk_size"
            )
        if verbose:
            print(f"✓ MPS 平台安全检查通过: chunk_size={chunk_size} (上限={MPS_TOPK_BUG_THRESHOLD})")


def _get_cpu_info() -> Optional[str]:
    """
    读取 CPU 型号信息（仅用于显示）
    
    Returns:
        model_name, if None, return "未知"
    """
    model_name = None
    
    try:
        if sys.platform == 'linux':
            with open('/proc/cpuinfo', 'r') as f:
                for line in f:
                    # 读取 model name
                    if model_name is None and 'model name' in line.lower():
                        model_name = line.split(':', 1)[1].strip()
                    
                    # 如果已经读取到所需信息，可以提前退出
                    if model_name:
                        break
    except Exception:
        pass
    
    return model_name


def _print_cpu_info() -> None:
    """
    打印 CPU 型号信息（所有平台都打印）
    """
    try:
        cpu_model = _get_cpu_info()
        model = cpu_model or "未知"
        
        print(f"💻 CPU 型号: {model}")
    except Exception as e:
        print(f"⚠️  CPU 信息获取失败: {e}")


def _print_cpu_thread_info() -> None:
    """打印 CPU 线程配置信息（PyTorch 默认配置）"""
    try:
        intra_threads = torch.get_num_threads()
        inter_threads = torch.get_num_interop_threads()
        print(f"🧵 PyTorch 线程配置: intra-op={intra_threads}, inter-op={inter_threads}")
    except Exception as e:
        print(f"⚠️  CPU 线程信息获取失败: {e}")


def load_runtime_config(model_name: str, verbose: bool = False) -> tuple[str, int, int]:
    """
    加载运行时配置的完整流程：检测平台 -> 合并配置 -> 校验 -> CPU调试信息
    
    这是配置加载的主入口函数，封装了完整的配置加载逻辑。
    
    Args:
        model_name: 模型标识符（如 'qwen3-1.7b'）
        verbose: 是否打印详细的配置信息
    
    Returns:
        tuple[platform, max_token_length, chunk_size]
    
    Raises:
        ValueError: 配置不完整或不符合平台限制时抛出
    """
    # 1. 检测平台
    platform = detect_platform(verbose=verbose)
    
    # 2. 四层配置合并（支持部分覆盖，并追踪配置来源）
    config = merge_runtime_config(
        model_name=model_name or "default_model",
        platform=platform,
        verbose=verbose
    )
    
    # 3. 提取配置
    max_token_length = config["max_token_length"]
    chunk_size = config["chunk_size"]
    
    # 4. 平台级安全校验（MPS 限制等）
    validate_platform_config(platform, chunk_size, verbose=verbose)
    
    # 5. 打印 CPU 信息（所有平台都打印）
    _print_cpu_info()
    
    # 6. CPU 线程配置信息打印（仅针对 CPU 平台）
    if "cpu" in platform.lower():
        _print_cpu_thread_info()  # 打印调试信息
    
    # 7. 打印配置摘要
    print(
        f"⚙️  运行时配置已加载 [model={model_name}, platform={platform}]: "
        f"max_token_length={max_token_length}, chunk_size={chunk_size}"
    )
    
    return platform, max_token_length, chunk_size
