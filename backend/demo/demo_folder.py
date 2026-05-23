"""
Demo文件夹操作模块
提供文件夹和文件的列表、移动、重命名、删除等功能
"""
import os
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional

from backend.demo.path_utils import (
    normalize_path,
    check_path_in_demo_dir,
    validate_demo_path,
    resolve_demo_path
)


# ==================== 辅助函数 ====================

def _normalize_path(path: str) -> str:
    """统一处理路径：将空字符串转换为 "/" （向后兼容包装器）"""
    return normalize_path(path)


def _build_api_path(parent_path: str, item_name: str) -> str:
    """构建API路径格式（统一使用 "/" 开头的格式）"""
    if parent_path and parent_path != "/":
        return f"{parent_path}/{item_name}"
    return f"/{item_name}"


def _error_response(message: str) -> Dict[str, any]:
    """统一错误响应格式"""
    return {"success": False, "message": message}


def _success_response(message: str) -> Dict[str, any]:
    """统一成功响应格式"""
    return {"success": True, "message": message}


def _get_timestamped_name(base_name: str, extension: str = "") -> str:
    """生成带时间戳的名称"""
    timestamp = int(time.time())
    return f"{base_name}_{timestamp}{extension}"


def _ensure_deleted_dir(demo_dir: Path) -> Path:
    """确保.deleted目录存在并返回路径"""
    deleted_dir = demo_dir.resolve() / '.deleted'
    deleted_dir.mkdir(parents=True, exist_ok=True)
    return deleted_dir


def _validate_json_file(file_path: Path) -> Optional[str]:
    """验证文件存在且为JSON文件，返回错误消息或None"""
    if not file_path.exists():
        return "文件不存在"
    if not file_path.is_file():
        return "路径不是文件"
    if file_path.suffix != '.json':
        return "只能操作JSON文件"
    return None


def _validate_folder(folder_path: Path) -> Optional[str]:
    """验证文件夹存在，返回错误消息或None"""
    if not folder_path.exists():
        return "文件夹不存在"
    if not folder_path.is_dir():
        return "路径不是文件夹"
    return None


# ==================== 文件系统操作函数 ====================
# 核心路径处理函数已移至 backend/path_utils.py

def list_demo_items(demo_dir: Path, path: str = "") -> Dict[str, any]:
    """返回指定路径下的文件夹和文件列表，自动忽略隐藏文件夹"""
    normalized_path = _normalize_path(path)
    target_dir = resolve_demo_path(demo_dir, normalized_path)
    
    if not target_dir or not target_dir.exists():
        return {"path": normalized_path, "items": []}
    
    items = []
    
    try:
        for item_path in target_dir.iterdir():
            if item_path.name.startswith('.'):
                continue
            
            if item_path.is_dir():
                items.append({
                    "type": "folder",
                    "name": item_path.name,
                    "path": _build_api_path(normalized_path, item_path.name)
                })
            elif item_path.is_file() and item_path.suffix == '.json':
                items.append({
                    "type": "file",
                    "name": item_path.stem,
                    "path": _build_api_path(normalized_path, item_path.name)
                })
    except Exception as e:
        import traceback
        print(f"❌ 扫描目录失败: {e}")
        traceback.print_exc()
        return {"path": normalized_path, "items": []}
    
    # 排序：文件夹在前，文件在后，各自按名称排序
    folders = sorted([item for item in items if item["type"] == "folder"], key=lambda x: x["name"])
    files = sorted([item for item in items if item["type"] == "file"], key=lambda x: x["name"])
    
    return {"path": path, "items": folders + files}


def get_all_folders(demo_dir: Path, exclude_path: Optional[str] = None) -> List[str]:
    """递归获取所有文件夹列表（用于移动操作），自动忽略隐藏文件夹"""
    folders = []
    
    def _scan_directory(current_dir: Path, current_path: str):
        """递归扫描目录"""
        try:
            for item in current_dir.iterdir():
                if item.name.startswith('.'):
                    continue
                
                if item.is_dir():
                    folder_path = _build_api_path(current_path, item.name)
                    
                    if exclude_path and (folder_path == exclude_path or folder_path.startswith(exclude_path + "/")):
                        continue
                    
                    folders.append(folder_path)
                    _scan_directory(item, folder_path)
        except Exception as e:
            import traceback
            print(f"❌ 扫描文件夹失败: {e}")
            traceback.print_exc()
    
    _scan_directory(demo_dir, "/")
    folders.insert(0, "/")
    return folders


def move_demo_file(demo_dir: Path, source_path: str, target_path: str) -> Dict[str, any]:
    """移动demo文件"""
    source_file = resolve_demo_path(demo_dir, source_path)
    if not source_file:
        return _error_response(f"源文件不存在: {source_path}")
    
    error_msg = _validate_json_file(source_file)
    if error_msg:
        return _error_response(f"源文件{error_msg}: {source_path}" if "不存在" not in error_msg else error_msg)
    
    target_dir = resolve_demo_path(demo_dir, target_path)
    if not target_dir:
        return _error_response(f"无效的目标路径: {target_path}")
    
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / source_file.name
    
    if target_file.exists() and target_file != source_file:
        return _error_response(f"目标位置已存在同名文件: {source_file.name}")
    
    try:
        shutil.move(str(source_file), str(target_file))
        return _success_response(f"文件已移动到 {target_path}")
    except Exception as e:
        return _error_response(f"移动失败: {str(e)}")


def rename_demo_file(demo_dir: Path, file_path: str, new_name: str) -> Dict[str, any]:
    """重命名demo文件"""
    from backend.demo.data_utils import sanitize_demo_name
    
    source_file = resolve_demo_path(demo_dir, file_path)
    if not source_file:
        return _error_response(f"文件不存在: {file_path}")
    
    error_msg = _validate_json_file(source_file)
    if error_msg:
        return _error_response(error_msg)
    
    safe_name = sanitize_demo_name(new_name)
    if not safe_name:
        return _error_response("新名称无效")
    
    target_file = source_file.parent / f"{safe_name}.json"
    
    if target_file.exists() and target_file != source_file:
        return _error_response(f"文件 '{safe_name}.json' 已存在")
    
    try:
        source_file.rename(target_file)
        return _success_response(f"文件已重命名为 '{safe_name}.json'")
    except Exception as e:
        return _error_response(f"重命名失败: {str(e)}")


def move_folder(demo_dir: Path, source_path: str, target_path: str) -> Dict[str, any]:
    """移动文件夹（递归）"""
    source_folder = resolve_demo_path(demo_dir, source_path)
    if not source_folder:
        return _error_response(f"源文件夹不存在: {source_path}")
    
    error_msg = _validate_folder(source_folder)
    if error_msg:
        return _error_response(f"源{error_msg}: {source_path}" if "不存在" not in error_msg else error_msg)
    
    target_dir = resolve_demo_path(demo_dir, target_path)
    if not target_dir:
        return _error_response(f"无效的目标路径: {target_path}")
    
    target_dir.mkdir(parents=True, exist_ok=True)
    target_folder = target_dir / source_folder.name
    
    if target_folder.exists():
        return _error_response(f"目标位置已存在同名文件夹: {source_folder.name}")
    
    # 检查是否尝试移动到自己的子目录
    if check_path_in_demo_dir(target_folder.resolve(), source_folder.resolve()):
        return _error_response("不能将文件夹移动到自己的子目录")
    
    try:
        shutil.move(str(source_folder), str(target_folder))
        return _success_response(f"文件夹已移动到 {target_path}")
    except Exception as e:
        return _error_response(f"移动失败: {str(e)}")


def rename_folder(demo_dir: Path, folder_path: str, new_name: str) -> Dict[str, any]:
    """重命名文件夹"""
    from backend.demo.data_utils import sanitize_demo_name
    
    source_folder = resolve_demo_path(demo_dir, folder_path)
    if not source_folder:
        return _error_response(f"文件夹不存在: {folder_path}")
    
    error_msg = _validate_folder(source_folder)
    if error_msg:
        return _error_response(error_msg)
    
    safe_name = sanitize_demo_name(new_name)
    if not safe_name:
        return _error_response("新名称无效")
    
    target_folder = source_folder.parent / safe_name
    
    if target_folder.exists():
        return _error_response(f"文件夹 '{safe_name}' 已存在")
    
    try:
        source_folder.rename(target_folder)
        return _success_response(f"文件夹已重命名为 '{safe_name}'")
    except Exception as e:
        return _error_response(f"重命名失败: {str(e)}")


def create_folder(demo_dir: Path, parent_path: str, folder_name: str) -> Dict[str, any]:
    """创建新文件夹"""
    from backend.demo.data_utils import sanitize_demo_name
    
    parent_dir = resolve_demo_path(demo_dir, parent_path)
    if not parent_dir:
        return _error_response(f"无效的父路径: {parent_path}")
    
    safe_name = sanitize_demo_name(folder_name)
    if not safe_name:
        return _error_response("文件夹名称无效")
    
    target_folder = parent_dir / safe_name
    
    if target_folder.exists():
        return _error_response(f"文件夹 '{safe_name}' 已存在")
    
    try:
        target_folder.mkdir(parents=True, exist_ok=False)
        return _success_response(f"文件夹 '{safe_name}' 已创建")
    except Exception as e:
        return _error_response(f"创建失败: {str(e)}")


def delete_folder(demo_dir: Path, folder_path: str) -> Dict[str, any]:
    """删除文件夹（移动到 .deleted 隐藏目录）"""
    source_folder = resolve_demo_path(demo_dir, folder_path)
    if not source_folder:
        return _error_response(f"文件夹不存在: {folder_path}")
    
    error_msg = _validate_folder(source_folder)
    if error_msg:
        return _error_response(error_msg)
    
    deleted_dir = _ensure_deleted_dir(demo_dir)
    target_folder = deleted_dir / source_folder.name
    
    if target_folder.exists():
        target_folder = deleted_dir / _get_timestamped_name(source_folder.name)
    
    try:
        shutil.move(str(source_folder), str(target_folder))
        return _success_response("文件夹已移动到 .deleted 目录")
    except Exception as e:
        return _error_response(f"删除失败: {str(e)}")


def delete_demo_file(demo_dir: Path, file_path: str) -> Dict[str, any]:
    """删除demo文件（移动到 .deleted 隐藏目录）"""
    demo_dir_resolved = demo_dir.resolve()
    source_file = resolve_demo_path(demo_dir_resolved, file_path)
    
    if not source_file:
        return _error_response(f"文件不存在: {file_path}")
    
    error_msg = _validate_json_file(source_file)
    if error_msg:
        return _error_response(error_msg)
    
    try:
        relative_path = source_file.relative_to(demo_dir_resolved)
    except ValueError:
        return _error_response("无效的文件路径")
    
    deleted_dir = _ensure_deleted_dir(demo_dir_resolved)
    target_file = deleted_dir / relative_path
    target_parent = target_file.parent
    target_parent.mkdir(parents=True, exist_ok=True)
    
    if target_file.exists():
        target_file = target_parent / _get_timestamped_name(source_file.stem, ".json")
    
    try:
        shutil.move(str(source_file), str(target_file))
        return _success_response(f"文件已移动到 .deleted 目录: {relative_path.as_posix()}")
    except Exception as e:
        return _error_response(f"删除失败: {str(e)}")

