"""
模型路径配置（共享配置文件）
用于 Docker 构建阶段预下载和运行时加载
"""

# 默认模型（供 run.py 帮助信息等轻量场景使用，避免导入 torch/transformers）
DEFAULT_MODEL = "qwen3-0.6b"
DEFAULT_SEMANTIC_MODEL = "qwen3-0.6b-instruct"

# Semantic analysis 模型（instruct 版本，用于 chat template 与指令理解）
SEMANTIC_MODEL_PATHS = {
    "qwen3-0.6b-instruct": "Qwen/Qwen3-0.6B",
    "qwen3-1.7b-instruct": "Qwen/Qwen3-1.7B",
    "qwen3-4b-instruct": "Qwen/Qwen3-4B-Instruct-2507",
    "qwen3-8b-instruct": "Qwen/Qwen3-8B",
    # qwen3.5，目前只支持CPU。MPS上有反向传播不支持fp16问题，CUDA上有transformers 5.x版本报错问题。
    "qwen3.5-0.8b-instruct": "Qwen/Qwen3.5-0.8B",
    "qwen3.5-2b-instruct": "Qwen/Qwen3.5-2B",
    "qwen3.5-4b-instruct": "Qwen/Qwen3.5-4B"
}

# 所有可用模型的 HuggingFace 路径映射
MODEL_PATHS = {
    # 标准模型（FP16/BF16）
    'qwen2.5-0.5b': 'Qwen/Qwen2.5-0.5B',
    # qwen3 base
    'qwen3-0.6b': 'Qwen/Qwen3-0.6B-Base',
    'qwen3-1.7b': 'Qwen/Qwen3-1.7B-Base',
    'qwen3-4b': 'Qwen/Qwen3-4B-Base',
    'qwen3-8b': 'Qwen/Qwen3-8B-Base',
    'qwen3-14b': 'Qwen/Qwen3-14B-Base',
    # qwen3.5
    'qwen3.5-0.8b': 'Qwen/Qwen3.5-0.8B-Base',
    'qwen3.5-2b': 'Qwen/Qwen3.5-2B-Base',
    'qwen3.5-4b': 'Qwen/Qwen3.5-4B-Base',
}

# run.py --model / 模型注册表使用的全部 id（base + instruct，顺序：先 base 后 semantic）
CLI_MODEL_IDS = tuple(MODEL_PATHS.keys()) + tuple(SEMANTIC_MODEL_PATHS.keys())


def resolve_hf_path(cli_id: str) -> str:
    """
    将 CLI 模型 id 解析为 HuggingFace 仓库 id（或本地路径字符串）。
    查找顺序：MODEL_PATHS → SEMANTIC_MODEL_PATHS（键不区分大小写）→ 未命中则原样返回（视为 HF id）。
    """
    raw = cli_id.strip()
    if not raw:
        raise ValueError("cli_id must be non-empty")
    lk = raw.lower()
    return MODEL_PATHS.get(lk) or SEMANTIC_MODEL_PATHS.get(lk) or raw
