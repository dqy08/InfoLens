"""本机加速提供口：Bearer 闸 + 第二监听。"""
from __future__ import annotations

import threading

from flask import request

from backend.platform.model_routing import remote_hf_token

_provider_port: int | None = None


def register_provider_bearer_guard(connexion_app, port: int) -> None:
    """仅当请求落在加速口时校验 Bearer。"""
    global _provider_port
    _provider_port = int(port)

    @connexion_app.app.before_request
    def _accelerate_provider_bearer():  # noqa: ANN202
        if _provider_port is None:
            return None
        server_port = request.environ.get("SERVER_PORT")
        if server_port is None:
            return None
        try:
            if int(server_port) != _provider_port:
                return None
        except (TypeError, ValueError):
            return None

        token = remote_hf_token()
        auth = request.headers.get("Authorization", "")
        expected = f"Bearer {token}" if token else ""
        if not token or auth != expected:
            return {"success": False, "message": "unauthorized"}, 401
        return None


def start_provider_listener(asgi_app, port: int) -> None:
    """在 127.0.0.1:port 再起一个 uvicorn（与主口同 app）。"""
    import uvicorn

    config = uvicorn.Config(
        asgi_app,
        host="127.0.0.1",
        port=int(port),
        access_log=False,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    threading.Thread(
        target=server.run,
        daemon=True,
        name="AccelerateProviderListener",
    ).start()
    print(
        f"[inforadar] accelerate provider listening on 127.0.0.1:{port} (Bearer required)",
        flush=True,
    )
