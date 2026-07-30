"""model_routing CLI 解析与启动校验。"""
from argparse import Namespace

import pytest

from backend.models.model_manager import ModelSlot
from backend.platform import model_routing


@pytest.fixture(autouse=True)
def _reset_routing_state():
    model_routing._configured_slots = (ModelSlot.BASE, ModelSlot.INSTRUCT)
    model_routing._worker_mode = False
    yield


def test_default_slots_both_local():
    args = Namespace(slots=None, worker=False)
    model_routing.configure_from_args(args)
    assert model_routing.configured_slots() == (ModelSlot.BASE, ModelSlot.INSTRUCT)
    assert model_routing.is_local(ModelSlot.BASE)
    assert model_routing.is_local(ModelSlot.INSTRUCT)


def test_worker_slots_only_base():
    args = Namespace(slots="base", worker=True)
    model_routing.configure_from_args(args)
    assert model_routing.is_worker()
    assert model_routing.slot_enabled(ModelSlot.BASE)
    assert not model_routing.slot_enabled(ModelSlot.INSTRUCT)
