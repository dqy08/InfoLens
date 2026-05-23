import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_DATA_DIR = Path(os.path.abspath("data/demo/public"))


def resolve_data_dir(dir_arg: Optional[str]) -> Path:
    """
    Resolve the base data directory from CLI args or fall back to demo/public.
    """
    if dir_arg:
        return Path(dir_arg).expanduser().absolute()
    return DEFAULT_DATA_DIR


def get_demo_dir(data_dir: Path, create: bool = False) -> Path:
    """Return the demo directory under the given data dir, optionally creating it."""
    # data_dir 此时默认就是 data/demo/public 的绝对路径
    demo_dir = data_dir
    if create:
        demo_dir.mkdir(parents=True, exist_ok=True)
    return demo_dir


def list_demo_files(demo_dir: Path) -> List[Dict[str, str]]:
    """Return sorted demo metadata from a directory. Missing dirs result in empty list."""
    if not demo_dir.exists():
        return []

    demo_list = []
    for file_path in demo_dir.glob("*.json"):
        demo_list.append(
            {
                "name": file_path.stem,
                "file": file_path.name,
            }
        )
    demo_list.sort(key=lambda item: item["name"])
    return demo_list


def sanitize_demo_name(name: str) -> str:
    """Remove unsafe characters from a demo name to create a safe filename."""
    unsafe_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
    safe_name = name or ""
    for char in unsafe_chars:
        safe_name = safe_name.replace(char, '_')
    safe_name = safe_name.strip(' .')
    return safe_name[:200]


def save_demo_payload(demo_dir: Path, name: str, data: Dict[str, Any], path: str = "", overwrite: bool = False) -> Dict[str, Any]:
    """
    Persist an AnalyzeResponse payload as a demo JSON file.
    
    Args:
        demo_dir: demo目录的绝对路径
        name: demo文件名（不含扩展名）
        data: 要保存的数据
        path: 保存路径，可以是 ""、"/" 或以 "/" 开头的路径，默认为根目录
        overwrite: 是否覆盖已存在的文件，默认为False
    """
    from backend.demo.path_utils import resolve_demo_path
    
    safe_name = sanitize_demo_name(name)
    if not safe_name:
        return {"success": False, "message": "文件名无效"}

    # 解析目标路径
    target_dir = resolve_demo_path(demo_dir, path)
    if target_dir is None:
        return {"success": False, "message": f"无效的保存路径: {path}"}

    # 确保目标目录存在
    target_dir.mkdir(parents=True, exist_ok=True)
    file_path = target_dir / f"{safe_name}.json"
    
    # 检查文件是否存在
    if file_path.exists() and not overwrite:
        return {
            "success": False,
            "exists": True,
            "message": f'文件 "{safe_name}.json" 已存在',
            "file": file_path.name,
        }
    
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return {
        "success": True,
        "message": f'Demo "{name}" 保存成功',
        "file": file_path.name,
    }

