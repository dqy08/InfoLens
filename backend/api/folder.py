"""文件夹管理 API"""
from backend.demo.demo_folder import (
    get_all_folders,
    move_folder,
    rename_folder,
    delete_folder,
    create_folder,
)
from backend.api.utils import (
    get_demo_directory,
    handle_api_error,
    handle_api_success,
    require_admin,
)


def _move_folder_internal(demo_dir, path, target_path):
    """内部函数：移动文件夹"""
    return move_folder(demo_dir, path, target_path)


@require_admin
def rename_folder_api(rename_request):
    """
    重命名文件夹
    请求格式: { path: string, new_name: string }
    """
    path = rename_request.get('path')
    new_name = rename_request.get('new_name')
    
    if not path or not new_name:
        return {
            'success': False,
            'message': 'Missing required parameter: path or new_name'
        }
    
    try:
        demo_dir = get_demo_directory(create=False)
        result = rename_folder(demo_dir, path, new_name)
        return handle_api_success(result)
    except Exception as e:
        return handle_api_error('Rename failed', e)


@require_admin
def delete_folder_api(delete_request):
    """
    删除文件夹（移动到.deleted目录）
    请求格式: { path: string }
    """
    path = delete_request.get('path')
    
    if not path:
        return {
            'success': False,
            'message': 'Missing required parameter: path'
        }
    
    try:
        demo_dir = get_demo_directory(create=False)
        result = delete_folder(demo_dir, path)
        return handle_api_success(result)
    except Exception as e:
        return handle_api_error('Delete failed', e)


def list_all_folders():
    """
    获取所有文件夹列表（用于移动操作的选择器）
    返回格式: { folders: string[] }
    """
    try:
        demo_dir = get_demo_directory(create=False)
        folders = get_all_folders(demo_dir)
        return {'folders': folders}
    except Exception as e:
        handle_api_error("Failed to get folder list", e)
        return {'folders': []}


@require_admin
def create_folder_api(create_request):
    """
    创建新文件夹
    请求格式: { parent_path: string, folder_name: string }
    """
    parent_path = create_request.get('parent_path', '/')
    folder_name = create_request.get('folder_name')
    
    if not folder_name:
        return {
            'success': False,
            'message': 'Missing required parameter: folder_name'
        }
    
    try:
        demo_dir = get_demo_directory(create=False)
        result = create_folder(demo_dir, parent_path, folder_name)
        return handle_api_success(result)
    except Exception as e:
        return handle_api_error('Create failed', e)

