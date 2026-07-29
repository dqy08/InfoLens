"""model_routing CLI 解析与启动校验。"""
import os
from argparse import Namespace

import pytest

from backend.models.model_manager import ModelSlot
from backend.platform import model_routing


@pytest.fixture(autouse=True)
def _reset_routing_state():
    model_routing._configured_slots = (ModelSlot.BASE, ModelSlot.INSTRUCT)
    model_routing._remote_origins = {}
    model_routing._worker_mode = False
    yield


def test_default_slots_both_local():
    args = Namespace(slots=None, remote=None, worker=False)
    model_routing.configure_from_args(args)
    assert model_routing.configured_slots() == (ModelSlot.BASE, ModelSlot.INSTRUCT)
    assert model_routing.is_local(ModelSlot.BASE)
    assert model_routing.is_local(ModelSlot.INSTRUCT)


def test_remote_requires_token(monkeypatch):
    monkeypatch.delenv("INFORADAR_REMOTE_HF_TOKEN", raising=False)
    args = Namespace(
        slots="base,instruct",
        remote=["base=https://example.hf.space"],
        worker=False,
    )
    with pytest.raises(ValueError, match="INFORADAR_REMOTE_HF_TOKEN"):
        model_routing.configure_from_args(args)


def test_remote_base_with_token(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "test-token")
    args = Namespace(
        slots="base,instruct",
        remote=["base=https://example.hf.space"],
        worker=False,
    )
    model_routing.configure_from_args(args)
    assert model_routing.is_local(ModelSlot.INSTRUCT)
    assert not model_routing.is_local(ModelSlot.BASE)
    assert model_routing.remote_origin(ModelSlot.BASE) == "https://example.hf.space"


def test_remote_origin_without_scheme(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "test-token")
    args = Namespace(
        slots="base,instruct",
        remote=["base=dqy08-infolens.hf.space"],
        worker=False,
    )
    model_routing.configure_from_args(args)
    assert model_routing.remote_origin(ModelSlot.BASE) == "https://dqy08-infolens.hf.space"


def test_worker_and_remote_mutually_exclusive(monkeypatch):
    monkeypatch.setenv("INFORADAR_REMOTE_HF_TOKEN", "test-token")
    args = Namespace(
        slots="base",
        remote=["base=https://example.hf.space"],
        worker=True,
    )
    with pytest.raises(ValueError, match="mutually exclusive"):
        model_routing.configure_from_args(args)


def test_worker_slots_only_base():
    args = Namespace(slots="base", remote=None, worker=True)
    model_routing.configure_from_args(args)
    assert model_routing.is_worker()
    assert model_routing.slot_enabled(ModelSlot.BASE)
    assert not model_routing.slot_enabled(ModelSlot.INSTRUCT)
