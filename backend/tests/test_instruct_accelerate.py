"""instruct 加速：TTL 登记、in-flight、熔断、回退；提供方与日常口同质。"""
from __future__ import annotations

from argparse import Namespace
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

from backend.models.model_manager import ModelSlot
from backend.platform import instruct_accelerate, model_routing
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
    )
    base.update(kwargs)
    return Namespace(**base)


def _enable_origin(origin: str = "https://accel.example") -> None:
    instruct_accelerate.set_accelerate_origin(origin)


def test_accelerate_origin_keeps_instruct_local(monkeypatch):
    model_routing.configure_from_args(_args(slots="base,instruct"))
    instruct_accelerate.configure()
    _enable_origin()
    assert model_routing.is_local(ModelSlot.INSTRUCT)
    assert instruct_accelerate.accelerate_origin() == "https://accel.example"


def test_set_origin_immediately_eligible():
    instruct_accelerate.configure()
    _enable_origin()
    assert instruct_accelerate.is_accelerate_eligible()
    assert instruct_accelerate.acquire()
    instruct_accelerate.release()


def test_inflight_cap(monkeypatch):
    monkeypatch.setenv("INFORADAR_ACCELERATE_INSTRUCT_MAX_INFLIGHT", "2")
    instruct_accelerate.configure()
    _enable_origin()
    assert instruct_accelerate.acquire()
    assert instruct_accelerate.acquire()
    assert not instruct_accelerate.acquire()
    instruct_accelerate.release()
    assert instruct_accelerate.acquire()


def test_circuit_trips_until_reregister():
    instruct_accelerate.configure()
    _enable_origin()
    assert instruct_accelerate.acquire()
    instruct_accelerate.release()
    instruct_accelerate.trip_circuit()
    assert not instruct_accelerate.acquire()
    _enable_origin()
    assert instruct_accelerate.acquire()
    instruct_accelerate.release()


def test_ttl_expiry(monkeypatch):
    monkeypatch.setenv("INFORADAR_ACCELERATE_INSTRUCT_TTL_SEC", "1")
    instruct_accelerate.configure()
    _enable_origin()
    assert instruct_accelerate.is_accelerate_eligible()
    with patch("backend.platform.instruct_accelerate.time.monotonic", return_value=1e9):
        assert instruct_accelerate.accelerate_origin() is None
        assert not instruct_accelerate.is_accelerate_eligible()


def test_health():
    body, status = health()
    assert status == 200
    assert body == {"ok": True}


def test_set_accelerate_origin_runtime(capsys):
    instruct_accelerate.configure()
    assert instruct_accelerate.accelerate_origin() is None

    assert (
        instruct_accelerate.set_accelerate_origin("https://x.accel.example")
        == "https://x.accel.example"
    )
    assert instruct_accelerate.is_accelerate_eligible()
    assert "accelerate origin set: https://x.accel.example" in capsys.readouterr().out

    # 同 origin 续期：不重复打印
    instruct_accelerate.set_accelerate_origin("https://x.accel.example")
    assert capsys.readouterr().out == ""

    instruct_accelerate.set_accelerate_origin("https://y.accel.example")
    assert instruct_accelerate.accelerate_origin() == "https://y.accel.example"
    assert not instruct_accelerate.is_circuit_open()
    assert "accelerate origin set: https://y.accel.example" in capsys.readouterr().out

    assert instruct_accelerate.set_accelerate_origin("") is None
    assert instruct_accelerate.accelerate_origin() is None
    assert "accelerate origin cleared" in capsys.readouterr().out

    # 已清空再 clear：不重复打印
    instruct_accelerate.set_accelerate_origin("")
    assert capsys.readouterr().out == ""


def test_set_accelerate_origin_without_remote_token(monkeypatch):
    monkeypatch.delenv("INFORADAR_REMOTE_HF_TOKEN", raising=False)
    instruct_accelerate.configure()
    assert (
        instruct_accelerate.set_accelerate_origin("https://x.example")
        == "https://x.example"
    )


def test_put_accelerate_instruct_origin_api(monkeypatch):
    from backend.api.accelerate_instruct_origin import (
        get_accelerate_instruct_origin,
        put_accelerate_instruct_origin,
    )

    monkeypatch.setenv("INFORADAR_ADMIN_TOKEN", "admin")
    instruct_accelerate.configure()

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
    assert body["ttl_sec"] == 90

    with app.test_request_context(headers={"X-Admin-Token": "admin"}):
        body, status = get_accelerate_instruct_origin()
    assert status == 200
    assert body["origin"] == "https://z.accel.example"
    assert body["eligible"] is True
    assert "median_rtt_ms" not in body

    with app.test_request_context(headers={"X-Admin-Token": "nope"}):
        body, status = put_accelerate_instruct_origin({"origin": None})
    assert status == 403


def test_ingress_fallback_on_unwritten_failure():
    model_routing.configure_from_args(_args())
    instruct_accelerate.configure()
    _enable_origin()

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


def test_ingress_accelerate_before_remote(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    model_routing.configure_from_args(
        _args(slots="base,instruct", remote=["instruct=https://fixed.hf.space"])
    )
    instruct_accelerate.configure()
    _enable_origin("https://accel.example")

    local_fn = MagicMock()
    with patch(
        "backend.platform.inference_ingress.proxy_request",
        return_value=({"ok": "accel"}, 200),
    ) as proxy:
        out = ingress_inference(
            slot=ModelSlot.INSTRUCT,
            api_path="/api/analyze-semantic",
            local_fn=local_fn,
        )
    assert out == ({"ok": "accel"}, 200)
    assert proxy.call_args.args[0] == "https://accel.example"
    local_fn.assert_not_called()


def test_ingress_fallback_to_remote_when_not_local(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    model_routing.configure_from_args(
        _args(slots="base,instruct", remote=["instruct=https://fixed.hf.space"])
    )
    instruct_accelerate.configure()
    _enable_origin("https://accel.example")

    local_fn = MagicMock()
    with patch(
        "backend.platform.inference_ingress.proxy_request",
        side_effect=[
            ({"success": False, "message": "up"}, 502),
            ({"ok": "remote"}, 200),
        ],
    ) as proxy:
        out = ingress_inference(
            slot=ModelSlot.INSTRUCT,
            api_path="/api/analyze-semantic",
            local_fn=local_fn,
        )
    assert out == ({"ok": "remote"}, 200)
    assert [c.args[0] for c in proxy.call_args_list] == [
        "https://accel.example",
        "https://fixed.hf.space",
    ]
    local_fn.assert_not_called()
    assert instruct_accelerate.is_circuit_open()
    assert instruct_accelerate.inflight_count() == 0


def test_ingress_no_fallback_on_stream_response():
    model_routing.configure_from_args(_args())
    instruct_accelerate.configure()
    _enable_origin()

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
    close_cb = proxy.call_args.kwargs.get("on_stream_close")
    assert close_cb is not None
    close_cb()
    assert instruct_accelerate.inflight_count() == 0


def test_completions_stop_uses_accelerate_origin():
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
