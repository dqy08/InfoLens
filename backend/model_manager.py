"""模型管理模块：主槽位与语义槽位对称配置，权重缓存共用。"""
from enum import Enum
import threading

from backend import REGISTERED_MODELS
from backend.project_registry import ModelRegistry
from backend.device import DeviceManager
from backend.model_loader import attn_implementation_for_device, load_causal_lm, load_tokenizer

from model_paths import DEFAULT_MODEL, DEFAULT_SEMANTIC_MODEL, resolve_hf_path

project_registry = ModelRegistry(REGISTERED_MODELS)
_init_lock = threading.Lock()

# 统一推理锁：信息密度分析与 Semantic 分析共用，确保模型推理串行执行
_inference_lock = threading.Lock()

# 按 HuggingFace 路径去重的已加载模型缓存（主分析 / 语义 / 续写共用）
_hf_load_lock = threading.Lock()
_hf_loaded: dict[str, tuple] = {}


class ModelSlot(str, Enum):
    """与 CLI --model / --semantic_model 对应的两个对等槽位。"""

    MAIN = "main"
    SEMANTIC = "semantic"


# 启动预载与「全部权重」枚举时使用的槽位顺序（对等、无主次）
CONFIGURED_SLOTS: tuple[ModelSlot, ...] = (ModelSlot.MAIN, ModelSlot.SEMANTIC)


def _resolved_hf_path_for_slot(slot: ModelSlot) -> str:
    """由应用上下文解析槽位对应的 HuggingFace 路径（或本地路径字符串）。"""
    if slot == ModelSlot.MAIN:
        try:
            from backend.app_context import get_app_context

            context = get_app_context(prefer_module_context=True)
            model_name = context.model_name or DEFAULT_MODEL
        except RuntimeError:
            model_name = DEFAULT_MODEL
        return resolve_hf_path(model_name)
    if slot == ModelSlot.SEMANTIC:
        try:
            from backend.app_context import get_args

            raw = getattr(get_args(), "semantic_model", DEFAULT_SEMANTIC_MODEL)
        except RuntimeError:
            raw = DEFAULT_SEMANTIC_MODEL
        return resolve_hf_path(raw)
    raise ValueError(f"unknown ModelSlot: {slot!r}")


def ensure_slot_weights_loaded(slot: ModelSlot):
    """
    加载指定槽位权重（若未缓存）；主 / 语义完全相同的入口。
    返回 (tokenizer, model, device)。
    """
    return ensure_model_loaded(_resolved_hf_path_for_slot(slot))


def ensure_model_loaded(resolved_hf_path: str):
    """
    唯一底层加载入口：保证 resolved_hf_path 对应权重已加载。
    返回 (tokenizer, model, device)，其中 device 为模型参数所在 device。
    """
    with _hf_load_lock:
        hit = _hf_loaded.get(resolved_hf_path)
        if hit is not None:
            return hit

        device = DeviceManager.get_device()
        display = resolved_hf_path.split("/")[-1] if "/" in resolved_hf_path else resolved_hf_path
        print(f"📦 正在加载模型权重: {display}")
        tokenizer = load_tokenizer(resolved_hf_path)
        model = load_causal_lm(
            resolved_hf_path,
            device,
            attn_implementation=attn_implementation_for_device(device),
        )
        for p in model.parameters():
            p.requires_grad_(False)
        model_device = next(model.parameters()).device
        device_name = DeviceManager.get_device_name(device)
        print(f"✓ {display} 已加载 ({device_name})")
        out = (tokenizer, model, model_device)
        _hf_loaded[resolved_hf_path] = out
        return out


def ensure_project_loaded(project_name: str):
    """确保项目已加载，如果未加载则加载它"""
    if not project_name:
        raise ValueError("model name is required")
    if not project_registry.is_available(project_name):
        raise KeyError(project_name)
    try:
        return project_registry.ensure_loaded(project_name)
    except KeyError:
        # Re-raise to allow caller to format message uniformly.
        raise
    except Exception as exc:  # noqa: BLE001 - propagate detailed message
        raise RuntimeError(f"模型 '{project_name}' 加载失败: {exc}") from exc


def _register_main_qwenlm_if_needed():
    """
    信息密度路径：在 MAIN 槽位权重已就绪后，注册 project_registry 中的 QwenLM 实例。
    语义槽位无对应 registry 包装，故仅此槽位需要。
    """
    from backend.app_context import get_app_context

    context = get_app_context(prefer_module_context=True)
    selected_name = context.model_name

    if not selected_name:
        raise ValueError("未指定模型名称")

    if selected_name in project_registry:
        _ensure_default_project_ready(selected_name)
        return

    if not project_registry.is_available(selected_name):
        raise KeyError(f"模型 '{selected_name}' 未找到，可用模型: {list(REGISTERED_MODELS.keys())}")

    try:
        project_registry.load(selected_name)
        _ensure_default_project_ready(selected_name)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"模型 '{selected_name}' 加载失败: {exc}") from exc


def preload_all_slots():
    """
    启动预载（非 --no_auto_load）：对 CONFIGURED_SLOTS 各解析 HF 路径，去重后加载全部权重，
    再注册主槽位 QwenLM 项目。两槽位在「先加载权重」层面完全对等。
    """
    from backend.app_context import get_app_context

    get_app_context(prefer_module_context=True)

    paths = {_resolved_hf_path_for_slot(s) for s in CONFIGURED_SLOTS}

    with _init_lock:
        for path in paths:
            ensure_model_loaded(path)
        _register_main_qwenlm_if_needed()


def ensure_slot_ready(slot: ModelSlot):
    """
    槽位业务就绪（对称 API）：保证该槽位后续推理所需状态已备好。

    - 两槽位均先保证 HF 权重已加载，返回 (tokenizer, model, device)。
    - MAIN 另需将 QwenLM 挂入 project_registry（信息密度管线）；SEMANTIC 无 registry 步骤。

    懒加载时：信息密度调 ensure_main_slot_ready()；语义/续写调 ensure_semantic_slot_ready()。
    """
    from backend.app_context import get_app_context

    get_app_context(prefer_module_context=True)

    if slot == ModelSlot.MAIN:
        with _init_lock:
            out = ensure_slot_weights_loaded(ModelSlot.MAIN)
            _register_main_qwenlm_if_needed()
            return out
    if slot == ModelSlot.SEMANTIC:
        return ensure_slot_weights_loaded(ModelSlot.SEMANTIC)
    raise ValueError(f"unknown ModelSlot: {slot!r}")


def ensure_main_slot_ready():
    """懒加载首次信息密度：同 ensure_slot_ready(ModelSlot.MAIN)。"""
    return ensure_slot_ready(ModelSlot.MAIN)


def ensure_semantic_slot_ready():
    """懒加载首次语义类请求：同 ensure_slot_ready(ModelSlot.SEMANTIC)。"""
    return ensure_slot_ready(ModelSlot.SEMANTIC)


def get_current_model_max_token_length() -> int:
    """
    查询当前生效模型的 max_token_length 参数。
    优先从已加载的模型实例获取，未加载时取 default_model.default_cpu_machine 配置。
    """
    from backend.app_context import get_app_context
    from backend.runtime_config import RUNTIME_CONFIGS

    try:
        context = get_app_context(prefer_module_context=True)
        model_name = context.model_name or DEFAULT_MODEL
    except RuntimeError:
        model_name = "default_model"

    project = project_registry.get(model_name)
    if project is not None and hasattr(project.lm, "max_length"):
        return project.lm.max_length
    return RUNTIME_CONFIGS["default_model"]["default_cpu_machine"]["max_token_length"]


def _ensure_default_project_ready(selected_name: str):
    """确保默认项目已准备好"""
    if not selected_name:
        return
    if selected_name in project_registry:
        return
    print(f"⚠️ 默认模型未缓存，正在预加载: {selected_name}")
    project_registry.ensure_loaded(selected_name)


# 旧名保留（与槽位就绪 API 等价）
ensure_semantic_loaded = ensure_semantic_slot_ready
ensure_main_project_ready = ensure_main_slot_ready

def get_semantic_model_display_name() -> str:
    """返回 semantic 槽位 HuggingFace 路径（用于结果中的 model 字段）"""
    return _resolved_hf_path_for_slot(ModelSlot.SEMANTIC)


def ensure_main_model_loaded():
    """
    仅需主模型前向、且不必经过 project_registry 时（如 attribution）：MAIN 槽位权重。
    """
    return ensure_slot_weights_loaded(ModelSlot.MAIN)


def get_main_model_display_name() -> str:
    """返回主槽位 HuggingFace 路径（用于结果中的 model 字段）"""
    return _resolved_hf_path_for_slot(ModelSlot.MAIN)
