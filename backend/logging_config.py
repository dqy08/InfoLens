"""
日志配置模块
统一管理应用的日志配置
"""

import logging


def configure_logging(app=None):
    """
    配置应用日志：完全屏蔽所有连接和请求相关的日志
    
    Args:
        app: Connexion/Flask 应用实例（可选）
    """
    # 屏蔽第三方库的日志
    logging.getLogger('werkzeug').setLevel(logging.CRITICAL)
    logging.getLogger('connexion').setLevel(logging.CRITICAL)
    logging.getLogger('flask_cors').setLevel(logging.CRITICAL)
    logging.getLogger('flask').setLevel(logging.CRITICAL)
    logging.getLogger('urllib3').setLevel(logging.CRITICAL)
    logging.getLogger('transformers').setLevel(logging.CRITICAL)
    logging.getLogger('torch').setLevel(logging.CRITICAL)
    
    # 设置根日志级别，只显示严重错误
    logging.basicConfig(level=logging.CRITICAL, format='%(message)s')
    
    # 配置 Flask app logger（如果提供了应用实例）
    if app:
        try:
            app.app.logger.setLevel(logging.CRITICAL)
            # 禁用 Werkzeug 的访问日志
            import werkzeug.serving
            werkzeug.serving.WSGIRequestHandler.log_request = lambda *args, **kwargs: None
        except Exception:
            pass

