"""remote_keepalive：有 --remote 时对 Worker 发保活 analyze。"""
from argparse import Namespace
from unittest.mock import MagicMock

import pytest

from backend.models.model_manager import ModelSlot
from backend.platform import model_routing, remote_keepalive


@pytest.fixture(autouse=True)
def _reset_routing_state():
    model_routing._configured_slots = (ModelSlot.BASE, ModelSlot.INSTRUCT)
    model_routing._remote_origins = {}
    model_routing._worker_mode = False
    yield


def test_remote_origins_empty_without_remote():
    model_routing.configure_from_args(Namespace(slots=None, remote=None, worker=False))
    assert remote_keepalive._remote_origins() == []


def test_remote_origins_dedupes(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    model_routing.configure_from_args(
        Namespace(
            slots="base,instruct",
            remote=["base=https://w.hf.space", "instruct=https://w.hf.space"],
            worker=False,
        )
    )
    assert remote_keepalive._remote_origins() == ["https://w.hf.space"]


def test_ping_posts_analyze(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "tok")
    mock_post = MagicMock()
    mock_post.return_value.ok = True
    mock_post.return_value.status_code = 200
    monkeypatch.setattr(remote_keepalive.requests, "post", mock_post)

    remote_keepalive._ping("https://w.hf.space")

    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert args[0] == "https://w.hf.space/api/analyze"
    assert kwargs["json"] == {
        "text": remote_keepalive._KEEPALIVE_TEXT,
        "model": "default",
    }
    assert kwargs["headers"]["Authorization"] == "Bearer tok"


def test_start_noop_without_remote(monkeypatch):
    started = []
    monkeypatch.setattr(
        remote_keepalive.threading,
        "Thread",
        lambda **kwargs: started.append(kwargs) or MagicMock(),
    )
    model_routing.configure_from_args(Namespace(slots=None, remote=None, worker=False))
    remote_keepalive.start_remote_keepalive()
    assert started == []
