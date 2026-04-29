"""应用上下文管理

使用类级别单例模式，提供进程级共享状态。
"""

import sys
from pathlib import Path
from typing import Optional
from argparse import Namespace


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
        self._current_model_name = getattr(args, 'model', None)
    
    @property
    def model_name(self) -> str:
        """当前模型名称"""
        return self._current_model_name
    
    @property
    def model_loading(self) -> bool:
        """模型是否正在加载"""
        return self._model_loading
    
    def set_current_model(self, model_name: str):
        """设置当前模型名称"""
        self._current_model_name = model_name
    
    def set_model_loading(self, loading: bool):
        """设置模型加载状态"""
        self._model_loading = loading
    
    def get_demo_dir(self, create: bool = False) -> Path:
        """获取 demo 目录路径"""
        from backend.data_utils import get_demo_dir
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
