"""
路径处理工具模块
统一管理路径验证、规范化、解析等逻辑
"""

import os
from pathlib import Path
from typing import Optional


def normalize_path(path: str) -> str:
    """
    统一处理路径：将空字符串转换为 "/"
    
    Args:
        path: 输入路径
        
    Returns:
        规范化后的路径
    """
    return path if path else "/"


def check_path_in_demo_dir(path: Path, demo_dir: Path) -> bool:
    """
    检查路径是否在demo目录内（Python 3.8兼容）
    
    Args:
        path: 要检查的路径
        demo_dir: demo目录路径
        
    Returns:
        True 如果路径在demo目录内
    """
    try:
        return path.is_relative_to(demo_dir)
    except AttributeError:
        # Python 3.8兼容性：使用os.path.commonpath
        path_str = str(path)
        demo_dir_str = str(demo_dir)
        common = os.path.commonpath([path_str, demo_dir_str])
        return common == demo_dir_str


def validate_demo_path(path: str, demo_dir: Path) -> bool:
    """
    验证路径安全性，防止路径遍历攻击
    
    Args:
        path: 要验证的相对路径
        demo_dir: demo目录的绝对路径
        
    Returns:
        True 如果路径安全
    """
    if not path or path == "/":
        return True
    
    # 移除首尾斜杠并规范化路径
    normalized_path = path.strip('/').replace('\\', '/')
    
    # 检查路径是否包含 ".." 或其他危险字符
    if '..' in normalized_path.split('/'):
        return False
    
    try:
        resolved_path = (demo_dir / normalized_path).resolve()
        demo_dir_resolved = demo_dir.resolve()
        return check_path_in_demo_dir(resolved_path, demo_dir_resolved)
    except Exception:
        return False


def resolve_demo_path(demo_dir: Path, path: str) -> Optional[Path]:
    """
    解析并验证路径，返回绝对路径
    
    Args:
        demo_dir: demo目录的绝对路径
        path: 要解析的相对路径
        
    Returns:
        解析后的绝对路径，验证失败则返回 None
    """
    if not validate_demo_path(path, demo_dir):
        return None
    
    if not path or path == "/":
        return demo_dir
    
    return (demo_dir / path.lstrip('/')).resolve()

