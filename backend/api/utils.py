"""API 工具函数"""
import os
import traceback
from functools import wraps

from flask import request, jsonify

from backend.platform.format import round_to_sig_figs

__all__ = ["round_to_sig_figs"]


def get_demo_directory(create=False):
    """获取 demo 目录路径"""
    from backend.platform.app_context import get_demo_directory as _get_demo_dir
    return _get_demo_dir(create=create)


def handle_api_error(operation_name: str, error: Exception) -> dict:
    """
    统一的 API 错误处理
    
    Args:
        operation_name: 操作名称（如 'Save failed'、'Delete failed'）
        error: 异常对象
        
    Returns:
        标准错误响应字典
    """
    error_msg = f'{operation_name}: {str(error)}'
    print(f"❌ {error_msg}")
    traceback.print_exc()
    return {
        'success': False,
        'message': error_msg
    }


def handle_api_success(result: dict, operation_name: str = None) -> dict:
    """
    处理 API 成功响应，打印日志
    
    Args:
        result: 操作结果字典
        operation_name: 可选的操作名称，用于日志
        
    Returns:
        结果字典
    """
    if result.get('success'):
        if operation_name:
            print(f"✓ {operation_name}")
        elif result.get('message'):
            print(f"✓ {result.get('message')}")
    else:
        message = result.get('message', 'Operation failed')
        print(f"❌ {message}")
    return result


def get_admin_token() -> str:
    """
    获取管理员token（从环境变量读取）
    
    Returns:
        管理员token字符串，如果未设置则返回None
    """
    return os.environ.get('INFORADAR_ADMIN_TOKEN')


def request_has_valid_admin() -> bool:
    """当前 HTTP 请求是否携带有效的 X-Admin-Token。"""
    token = request.headers.get('X-Admin-Token') or ''
    is_valid, _ = validate_admin_token(token)
    return is_valid


def validate_admin_token(request_token: str) -> tuple[bool, str]:
    """
    验证管理员token是否有效
    
    Args:
        request_token: 要验证的token
    
    Returns:
        (是否有效, 错误信息)
    """
    admin_token = get_admin_token()
    
    # 如果未配置INFORADAR_ADMIN_TOKEN，返回未启用状态
    if admin_token is None:
        return False, 'Admin features are not enabled'
    
    # 验证token
    if request_token == admin_token:
        return True, ''
    else:
        return False, 'Invalid admin token'


def require_admin(f):
    """
    装饰器：要求管理员权限才能访问的API
    
    检查请求头中的 X-Admin-Token 是否与配置的 INFORADAR_ADMIN_TOKEN 匹配
    如果未配置 INFORADAR_ADMIN_TOKEN，视为全是普通用户，拒绝所有写操作
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        request_token = request.headers.get('X-Admin-Token')
        is_valid, error_message = validate_admin_token(request_token)
        
        if not is_valid:
            return {
                'success': False,
                'message': 'Admin permission required'
            }, 403
        
        return f(*args, **kwargs)
    return wrapper

