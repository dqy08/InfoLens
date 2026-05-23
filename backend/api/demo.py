"""Demo 文件管理 API"""
from backend.demo.data_utils import save_demo_payload
from backend.demo.demo_folder import (
    list_demo_items,
    move_demo_file,
    rename_demo_file,
    delete_demo_file,
    move_folder,
)
from backend.api.utils import (
    get_demo_directory,
    handle_api_error,
    handle_api_success,
    require_admin,
    validate_admin_token,
)
from backend.platform.access_log import log_check_admin


def list_demos(path: str = ""):
    """
    扫描demo目录下的文件夹和文件，返回列表
    支持指定路径参数，返回指定路径下的内容
    文件名（去掉.json后缀）作为demo名称
    支持中文文件名和路径
    从data/demo目录读取（更专业的数据目录结构）
    
    Args:
        path: 可选，指定要列出的路径，默认为根目录（空字符串）
    """
    demo_dir = get_demo_directory(create=False)
    try:
        result = list_demo_items(demo_dir, path)
        # if not result.get("items"):
        #     print(f"⚠️  路径 '{path}' 下没有内容: {demo_dir}")
        # else:
        #     items_count = len(result["items"])
        #     folders_count = sum(1 for item in result["items"] if item["type"] == "folder")
        #     files_count = sum(1 for item in result["items"] if item["type"] == "file")
        #     print(f"✓ 路径 '{path}': {folders_count} 个文件夹, {files_count} 个文件 (共 {items_count} 项)")
        return result
    except Exception as e:
        error_result = handle_api_error("Failed to scan demo directory", e)
        return {"path": path, "items": []}


@require_admin
def save_demo(save_request):
    """
    保存demo文件到data/demo目录
    请求格式: { name: string, data: AnalyzeResponse, path?: string, overwrite?: boolean }
    path: 可选，保存路径，默认为根目录（"/"）
    overwrite: 可选，是否覆盖已存在的文件，默认为False
    """
    name = save_request.get('name')
    data = save_request.get('data')
    path = save_request.get('path', '/')  # 默认为根目录
    overwrite = save_request.get('overwrite', False)  # 默认为False
    
    if not name or not data:
        return {
            'success': False,
            'message': 'Missing required parameters: name or data'
        }
    
    try:
        demo_dir = get_demo_directory(create=True)
        result = save_demo_payload(demo_dir, name, data, path, overwrite)
        if result.get('success'):
            print(f"✓ Demo已保存: {demo_dir / result['file']}")
        else:
            print(f"❌ Save failed: {result.get('message')}")
        return result
    except Exception as e:
        return handle_api_error('Save failed', e)


@require_admin
def delete_demo(delete_request):
    """
    将demo文件移动到deleted文件夹（软删除）
    请求格式: { file: string }  # 文件名（包含.json后缀）
    """
    file = delete_request.get('file')
    
    if not file:
        return {
            'success': False,
            'message': 'Missing required parameter: file'
        }
    
    try:
        demo_dir = get_demo_directory(create=False)
        result = delete_demo_file(demo_dir, file)
        return handle_api_success(result)
    except Exception as e:
        return handle_api_error('Delete failed', e)


@require_admin
def move_demo(move_request):
    """
    移动demo文件或文件夹
    请求格式: { file: string, target_path: string } 或 { path: string, target_path: string }
    """
    file = move_request.get('file')
    path = move_request.get('path')
    target_path = move_request.get('target_path', '')
    
    if not target_path and target_path != '':
        return {
            'success': False,
            'message': 'Missing required parameter: target_path'
        }
    
    if not file and not path:
        return {
            'success': False,
            'message': 'Missing required parameter: file or path'
        }
    
    try:
        demo_dir = get_demo_directory(create=False)
        
        if file:
            # 移动文件
            result = move_demo_file(demo_dir, file, target_path)
        else:
            # 移动文件夹
            result = move_folder(demo_dir, path, target_path)
        
        return handle_api_success(result)
    except Exception as e:
        return handle_api_error('Move failed', e)


@require_admin
def rename_demo(rename_request):
    """
    重命名demo文件
    请求格式: { file: string, new_name: string }
    """
    file = rename_request.get('file')
    new_name = rename_request.get('new_name')
    
    if not file or not new_name:
        return {
            'success': False,
            'message': 'Missing required parameter: file or new_name'
        }
    
    try:
        demo_dir = get_demo_directory(create=False)
        result = rename_demo_file(demo_dir, file, new_name)
        return handle_api_success(result)
    except Exception as e:
        return handle_api_error('Rename failed', e)


def check_admin(check_request):
    from flask import request

    request_token = check_request.get('token') or request.headers.get('X-Admin-Token')
    is_valid, error_message = validate_admin_token(request_token)
    log_check_admin(is_valid, token=request_token)

    if is_valid:
        return {"success": True}
    else:
        return {
            'success': False,
            'message': error_message
        }

