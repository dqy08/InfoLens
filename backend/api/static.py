"""静态文件路由"""
import mimetypes
from pathlib import Path
from urllib.parse import unquote

from flask import Response, redirect, abort, request
from werkzeug.utils import safe_join

from backend.platform.access_log import log_cached_demo, log_json_demo, log_page_load


def _read_static_file(directory: str, path: str) -> Response:
    """读取静态文件并返回 Response，避免 send_from_directory 在 ASGI/a2wsgi 下
    流式传输导致的 Content-Length 不匹配（RuntimeError: Response content shorter than Content-Length）。
    """
    base = Path(directory).resolve()
    safe_path = safe_join(str(base), path)
    if safe_path is None:
        abort(404)
    full_path = Path(safe_path)
    if not full_path.is_file() or not str(full_path.resolve()).startswith(str(base)):
        abort(404)
    content = full_path.read_bytes()
    mimetype, _ = mimetypes.guess_type(path)
    mimetype = mimetype or "application/octet-stream"
    return Response(content, mimetype=mimetype, headers={"Content-Length": str(len(content))})


def register_static_routes(app):
    """注册静态文件路由"""
    
    @app.route('/')
    def redir():
        target = 'client/index.html'
        if request.query_string:
            target += '?' + request.query_string.decode()
        return redirect(target)

    @app.route('/client/<path:path>')
    def send_static(path):
        """serves all files from ./client/dist/ to ``/client/<path:path>``"""
        if path == 'gen_attribute.html':
            target = 'causal_flow.html'
            if request.query_string:
                target += '?' + request.query_string.decode()
            return redirect(f'/client/{target}', code=301)
        if path.endswith('.html'):
            log_page_load(path)
        if path.endswith('.json'):
            log_cached_demo(path)
        return _read_static_file('client/dist', path)

    @app.route('/demo/<path:path>')
    def send_demo(path):
        """serves all demo files from the demo dir to ``/demo/<path:path>``"""
        from backend.platform.app_context import get_data_dir
        data_dir = get_data_dir()
        log_json_demo(path)
        try:
            decoded_path = unquote(path)
            return _read_static_file(str(data_dir), decoded_path)
        except Exception:
            try:
                return _read_static_file(str(data_dir), path)
            except Exception:
                abort(404)

