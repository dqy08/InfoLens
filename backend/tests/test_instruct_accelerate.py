"""instruct 本机加速：门控、回退、provider Bearer。"""
from __future__ import annotations

from argparse import Namespace
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

from backend.models.model_manager import ModelSlot
from backend.platform import instruct_accelerate, model_routing
from backend.platform.accelerate_provider import register_provider_bearer_guard
from backend.platform.inference_ingress import ingress_inference
from backend.api.health import health


@pytest.fixture(autouse=True)
def _reset_state():
    instruct_accelerate.reset_for_tests()
    model_routing._configured_slots = (ModelSlot.BASE, ModelSlot.INSTRUCT)
    model_routing._remote_origins = {}
    model_routing._worker_mode = False
    yield
    instruct_accelerate.reset_for_tests()


def _args(**kwargs):
    base = dict(
        slots=None,
        remote=None,
        worker=False,
        accelerate_instruct_provider_port=None,
    )
    base.update(kwargs)
    return Namespace(**base)


def _enable_origin(origin: str = "https://accel.example") -> None:
    instruct_accelerate.set_accelerate_origin(origin)


def test_accelerate_origin_keeps_instruct_local(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    model_routing.configure_from_args(_args(slots="base,instruct"))
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    assert model_routing.is_local(ModelSlot.INSTRUCT)
    assert instruct_accelerate.accelerate_origin() == "https://accel.example"


def test_provider_port_requires_token(monkeypatch):
    monkeypatch.delenv("INFORADAR_REMOTE_HF_TOKEN", raising=False)
    with pytest.raises(ValueError, match="INFORADAR_REMOTE_HF_TOKEN"):
        instruct_accelerate.configure_from_args(
            _args(accelerate_instruct_provider_port="5002")
        )


def test_cold_start_not_eligible(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    assert not instruct_accelerate.is_accelerate_eligible()
    assert not instruct_accelerate.acquire()


def test_rtt_gate_and_inflight(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    monkeypatch.setenv("INFORADAR_ACCELERATE_INSTRUCT_MAX_INFLIGHT", "2")
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    instruct_accelerate.record_probe_success(100.0)
    assert instruct_accelerate.acquire()
    assert instruct_accelerate.acquire()
    assert not instruct_accelerate.acquire()
    instruct_accelerate.release()
    assert instruct_accelerate.acquire()


def test_high_rtt_not_eligible(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    monkeypatch.setenv("INFORADAR_ACCELERATE_INSTRUCT_MAX_RTT_MS", "50")
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    instruct_accelerate.record_probe_success(200.0)
    assert not instruct_accelerate.is_accelerate_eligible()


def test_circuit_trips_until_probe_success(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    instruct_accelerate.record_probe_success(10.0)
    assert instruct_accelerate.acquire()
    instruct_accelerate.release()
    instruct_accelerate.trip_circuit()
    assert not instruct_accelerate.acquire()
    instruct_accelerate.record_probe_success(12.0)
    assert instruct_accelerate.acquire()
    instruct_accelerate.release()


def test_health():
    body, status = health()
    assert status == 200
    assert body == {"ok": True}


def test_set_accelerate_origin_runtime(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    instruct_accelerate.configure_from_args(_args())
    assert instruct_accelerate.accelerate_origin() is None

    assert (
        instruct_accelerate.set_accelerate_origin("https://x.accel.example")
        == "https://x.accel.example"
    )
    instruct_accelerate.record_probe_success(20.0)
    assert instruct_accelerate.is_accelerate_eligible()

    instruct_accelerate.set_accelerate_origin("https://y.accel.example")
    assert instruct_accelerate.accelerate_origin() == "https://y.accel.example"
    assert instruct_accelerate.median_rtt_ms() is None
    assert not instruct_accelerate.is_circuit_open()

    assert instruct_accelerate.set_accelerate_origin("") is None
    assert instruct_accelerate.accelerate_origin() is None


def test_set_accelerate_origin_requires_token(monkeypatch):
    monkeypatch.delenv("INFORADAR_REMOTE_HF_TOKEN", raising=False)
    instruct_accelerate.configure_from_args(_args())
    with pytest.raises(ValueError, match="INFORADAR_REMOTE_HF_TOKEN"):
        instruct_accelerate.set_accelerate_origin("https://x.example")


def test_put_accelerate_instruct_origin_api(monkeypatch):
    from backend.api.accelerate_instruct_origin import (
        get_accelerate_instruct_origin,
        put_accelerate_instruct_origin,
    )

    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    monkeypatch.setenv("INFORADAR_ADMIN_TOKEN", "admin")
    instruct_accelerate.configure_from_args(_args())

    app = Flask(__name__)
    with app.test_request_context(
        "/api/accelerate_instruct_origin",
        method="PUT",
        headers={"X-Admin-Token": "admin"},
        json={"origin": "https://z.accel.example"},
    ):
        body, status = put_accelerate_instruct_origin(
            {"origin": "https://z.accel.example"}
        )
    assert status == 200
    assert body["origin"] == "https://z.accel.example"

    with app.test_request_context(headers={"X-Admin-Token": "admin"}):
        body, status = get_accelerate_instruct_origin()
    assert status == 200
    assert body["origin"] == "https://z.accel.example"

    with app.test_request_context(headers={"X-Admin-Token": "nope"}):
        body, status = put_accelerate_instruct_origin({"origin": None})
    assert status == 403


def test_ingress_fallback_on_unwritten_failure(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    model_routing.configure_from_args(_args())
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    instruct_accelerate.record_probe_success(5.0)

    local_fn = MagicMock(return_value=({"ok": "local"}, 200))
    with patch(
        "backend.platform.inference_ingress.proxy_request",
        return_value=({"success": False, "message": "up"}, 502),
    ):
        out = ingress_inference(
            slot=ModelSlot.INSTRUCT,
            api_path="/api/analyze-semantic",
            local_fn=local_fn,
        )
    assert out == ({"ok": "local"}, 200)
    local_fn.assert_called_once()
    assert instruct_accelerate.is_circuit_open()
    assert instruct_accelerate.inflight_count() == 0


def test_ingress_no_fallback_on_stream_response(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    model_routing.configure_from_args(_args())
    instruct_accelerate.configure_from_args(_args())
    _enable_origin()
    instruct_accelerate.record_probe_success(5.0)

    from flask import Response

    streamed = Response(b"data: {}\n\n", status=200, mimetype="text/event-stream")
    local_fn = MagicMock()
    with patch(
        "backend.platform.inference_ingress.proxy_request",
        return_value=streamed,
    ) as proxy:
        out = ingress_inference(
            slot=ModelSlot.INSTRUCT,
            api_path="/api/v1/completions",
            stream=True,
            local_fn=local_fn,
        )
    assert out is streamed
    local_fn.assert_not_called()
    # stream close not invoked by mock; release left to on_stream_close — simulate
    close_cb = proxy.call_args.kwargs.get("on_stream_close")
    assert close_cb is not None
    close_cb()
    assert instruct_accelerate.inflight_count() == 0


def test_completions_stop_uses_accelerate_origin(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    from backend.platform import inference_proxy
    from backend.api.openai_completions import completions_stop

    inference_proxy.set_active_remote_completion_slot(
        ModelSlot.INSTRUCT, origin="https://accel.example"
    )
    with patch(
        "backend.platform.inference_proxy.proxy_request",
        return_value=({"ok": True}, 200),
    ) as proxy:
        out = completions_stop()
    assert out == ({"ok": True}, 200)
    assert proxy.call_args.args[0] == "https://accel.example"
    assert proxy.call_args.args[2] == "/api/v1/completions/stop"
    inference_proxy.clear_active_remote_completion_slot()


def test_provider_bearer_guard(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "secret")
    app = Flask(__name__)

    class _Conn:
        def __init__(self, flask_app):
            self.app = flask_app

    register_provider_bearer_guard(_Conn(app), 5002)

    @app.route("/api/health")
    def _h():
        return {"ok": True}

    client = app.test_client()
    # main port — no bearer
    with app.test_request_context("/api/health", environ_overrides={"SERVER_PORT": "5001"}):
        # use test client with environ
        pass
    rv = client.get("/api/health", environ_overrides={"SERVER_PORT": "5001"})
    assert rv.status_code == 200

    rv = client.get("/api/health", environ_overrides={"SERVER_PORT": "5002"})
    assert rv.status_code == 401

    rv = client.get(
        "/api/health",
        headers={"Authorization": "Bearer secret"},
        environ_overrides={"SERVER_PORT": "5002"},
    )
    assert rv.status_code == 200
