"""模型切换 API"""
import gc
import os
from typing import Optional

import torch
from backend.models import REGISTERED_MODELS
from backend.models.model_manager import project_registry
from backend.platform.app_context import get_app_context
from backend.api.utils import require_admin


def get_available_models():
    """获取所有可用的模型列表"""
    return {
        'success': True,
        'models': list(REGISTERED_MODELS.keys())
    }, 200


def _get_device_type() -> str:
    """获取当前设备类型"""
    if torch.cuda.is_available():
        return "cuda"
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return "mps"
    else:
        return "cpu"


def _restore_env_vars(old_force_int8: Optional[str], old_force_bfloat16: Optional[str]) -> None:
    """恢复环境变量配置"""
    if old_force_int8 is not None:
        os.environ['FORCE_INT8'] = old_force_int8
    else:
        os.environ.pop('FORCE_INT8', None)
    
    if old_force_bfloat16 is not None:
        os.environ['CPU_FORCE_BFLOAT16'] = old_force_bfloat16
    else:
        os.environ.pop('CPU_FORCE_BFLOAT16', None)


def get_current_model():
    """获取当前使用的模型及量化配置"""
    # 使用模块级上下文以获取持久化的模型状态
    context = get_app_context(prefer_module_context=True)
    device_type = _get_device_type()
    
    return {
        'success': True,
        'model': context.base_model_id,
        'loading': context.model_loading,
        'device_type': device_type,
        'use_int8': os.environ.get('FORCE_INT8') == '1',
        'use_bfloat16': os.environ.get('CPU_FORCE_BFLOAT16') == '1'
    }, 200


@require_admin
def switch_model(switch_request):
    """
    切换模型（需要管理员权限）
    
    Args:
        switch_request: 切换请求字典，包含：
            - model: 目标模型名称
            - use_int8: 是否使用 INT8 量化（可选）
            - use_bfloat16: 是否使用 bfloat16（可选，仅CPU）
    
    Returns:
        (响应字典, 状态码) 元组
    """
    if False:  # 原在线切换逻辑保留，不执行；恢复时请删除此守卫并测试
        target_model = switch_request.get('model')
        use_int8 = switch_request.get('use_int8', False)
        use_bfloat16 = switch_request.get('use_bfloat16', False)

        # 验证请求
        if not target_model:
            return {
                'success': False,
                'message': 'Missing model parameter'
            }, 400

        # 检查模型是否可用
        if target_model not in REGISTERED_MODELS:
            available_models = list(REGISTERED_MODELS.keys())
            return {
                'success': False,
                'message': f'Model {target_model} does not exist. Available models: {", ".join(available_models)}'
            }, 404

        # 获取设备类型
        device_type = _get_device_type()

        # 验证量化参数与设备兼容性
        if use_int8 and device_type == "mps":
            return {
                'success': False,
                'message': 'INT8 quantization is not supported on MPS device'
            }, 400

        if use_bfloat16 and device_type != "cpu":
            return {
                'success': False,
                'message': 'bfloat16 quantization is only supported on CPU device'
            }, 400

        if use_int8 and use_bfloat16:
            return {
                'success': False,
                'message': 'Cannot enable both INT8 and bfloat16 quantization'
            }, 400

        # 使用模块级上下文以确保状态修改持久化（不会被后续请求重置）
        context = get_app_context(prefer_module_context=True)
        current_model = context.base_model_id

        # 保存当前环境变量配置（用于回滚）
        old_force_int8 = os.environ.get('FORCE_INT8')
        old_force_bfloat16 = os.environ.get('CPU_FORCE_BFLOAT16')

        # 检查是否已经是目标模型且量化配置相同
        current_int8 = os.environ.get('FORCE_INT8') == '1'
        current_bfloat16 = os.environ.get('CPU_FORCE_BFLOAT16') == '1'

        if (current_model == target_model and
                current_int8 == use_int8 and
                current_bfloat16 == use_bfloat16):
            return {
                'success': True,
                'message': f'Already using model {target_model} (same quantization configuration)',
                'model': target_model
            }, 200

        # 检查模型是否正在加载中（初始加载或切换）
        if context.model_loading:
            return {
                'success': False,
                'message': 'Model is currently loading, please try again later'
            }, 503

        try:
            # 标记开始加载
            context.set_model_loading(True)
            print(f"🔄 开始切换模型: {current_model} -> {target_model}")

            # 设置新的量化环境变量
            if use_int8:
                os.environ['FORCE_INT8'] = '1'
                print("   设置量化: INT8")
            else:
                os.environ.pop('FORCE_INT8', None)

            if use_bfloat16:
                os.environ['CPU_FORCE_BFLOAT16'] = '1'
                print("   设置量化: bfloat16")
            else:
                os.environ.pop('CPU_FORCE_BFLOAT16', None)

            # 卸载旧模型
            if current_model and current_model in project_registry:
                print(f"   卸载旧模型: {current_model}")
                project_registry.unload(current_model)
                gc.collect()
                if device_type == "cuda":
                    torch.cuda.empty_cache()
                elif device_type == "mps":
                    torch.mps.empty_cache()

            # 加载新模型
            print(f"   加载新模型: {target_model}")
            project_registry.ensure_loaded(target_model)

            # 更新当前模型
            context.set_current_model(target_model)

            print(f"✅ 模型切换成功: {target_model}")

            return {
                'success': True,
                'message': f'Model switched to {target_model}',
                'model': target_model
            }, 200

        except KeyError:
            # 模型不存在（虽然前面已经检查过，但以防万一）
            print(f"❌ 模型切换失败: 模型 {target_model} 未注册")
            # 回滚：恢复旧模型名称和环境变量
            context.set_current_model(current_model)
            _restore_env_vars(old_force_int8, old_force_bfloat16)
            return {
                'success': False,
                'message': f'Model {target_model} is not registered'
            }, 404

        except Exception as e:
            # 加载失败，尝试回滚
            print(f"❌ 模型切换失败: {e}")
            print(f"   尝试回滚到旧模型: {current_model}")

            try:
                # 回滚：恢复环境变量和重新加载旧模型
                _restore_env_vars(old_force_int8, old_force_bfloat16)
                if current_model:
                    project_registry.ensure_loaded(current_model)
                    context.set_current_model(current_model)
                    print(f"✅ 已回滚到旧模型: {current_model}")
            except Exception as rollback_error:
                print(f"⚠️  回滚失败: {rollback_error}")

            return {
                'success': False,
                'message': f'Model switch failed: {str(e)}'
            }, 500

        finally:
            # 无论成功还是失败，都要清除加载标志
            context.set_model_loading(False)
            gc.collect()

    return (
        {
            'success': False,
            'message': '在线模型切换已禁用，请通过命令行 --base_model / --instruct_model 指定后重启服务',
        },
        501,
    )
