"""应用上下文管理

使用类级别单例模式，提供进程级共享状态。
"""

import sys
from pathlib import Path
from typing import Optional
from argparse import Namespace

from model_paths import DEFAULT_BASE_MODEL, DEFAULT_INSTRUCT_MODEL


class AppContext:
    """
    应用上下文（进程级单例）
    
    通过 AppContext.init() 初始化，通过 AppContext.get() 获取。
    单例模式确保整个进程共享同一个上下文，避免模块重新导入导致的状态不一致。
    """
    
    _instance: Optional['AppContext'] = None
    
    @classmethod
    def get(cls) -> 'AppContext':
        """获取上下文单例（必须先调用 init）"""
        if cls._instance is None:
            raise RuntimeError("AppContext 未初始化，请先调用 AppContext.init()")
        return cls._instance
    
    @classmethod
    def init(cls, args: Namespace, data_dir: Path) -> 'AppContext':
        """
        初始化上下文单例（幂等操作）
        
        如果已初始化则返回现有实例，确保模块重新导入时不会覆盖状态。
        """
        if cls._instance is not None:
            return cls._instance
        cls._instance = cls(args, data_dir)
        gc = getattr(args, "gradient_checkpointing", True)
        print(
            f"[Info Radar] gradient_checkpointing={'on' if gc else 'off'}",
            file=sys.stderr,
            flush=True,
        )
        return cls._instance
    
    @classmethod
    def is_initialized(cls) -> bool:
        """检查上下文是否已初始化"""
        return cls._instance is not None
    
    def __init__(self, args: Namespace, data_dir: Path):
        """私有构造函数，请使用 AppContext.init()"""
        self.args = args
        self.data_dir = data_dir
        self._model_loading = True  # 初始时处于加载状态
        self._base_model_id = getattr(args, "base_model", None) or DEFAULT_BASE_MODEL
        self._instruct_model_id = getattr(args, "instruct_model", None) or DEFAULT_INSTRUCT_MODEL
    
    @property
    def base_model_id(self) -> str:
        """当前 base 槽位 CLI 模型 id（信息密度主模型）。"""
        return self._base_model_id

    @property
    def instruct_model_id(self) -> str:
        """当前 instruct 槽位 CLI 模型 id（语义 / 续写）。"""
        return self._instruct_model_id
    
    @property
    def model_loading(self) -> bool:
        """模型是否正在加载"""
        return self._model_loading
    
    def set_base_model_id(self, model_id: str):
        """设置 base 槽位 CLI 模型 id（如在线切换）。"""
        self._base_model_id = model_id

    def set_current_model(self, model_id: str):
        """兼容旧名：同 set_base_model_id。"""
        self.set_base_model_id(model_id)
    
    def set_model_loading(self, loading: bool):
        """设置模型加载状态"""
        self._model_loading = loading
    
    def get_demo_dir(self, create: bool = False) -> Path:
        """获取 demo 目录路径"""
        from backend.demo.data_utils import get_demo_dir
        return get_demo_dir(self.data_dir, create=create)


# ============= 兼容性接口（供旧代码平滑迁移）=============

def get_app_context(prefer_module_context: bool = False) -> AppContext:
    """获取应用上下文（兼容旧接口，prefer_module_context 参数已忽略）"""
    return AppContext.get()


def get_args() -> Namespace:
    """获取命令行参数"""
    return AppContext.get().args


def get_verbose() -> bool:
    """是否输出详细调试信息（由 --verbose 控制）"""
    try:
        return getattr(get_args(), "verbose", False)
    except RuntimeError:
        return False


def get_data_dir() -> Path:
    """获取数据目录"""
    return AppContext.get().data_dir


def get_demo_directory(create: bool = False) -> Path:
    """获取 demo 目录"""
    return AppContext.get().get_demo_dir(create=create)
