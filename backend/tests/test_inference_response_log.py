"""inference_response_log 门户 / worker 分流。"""
from argparse import Namespace

import pytest

from backend.models.model_manager import ModelSlot
from backend.platform import inference_response_log, model_routing


@pytest.fixture(autouse=True)
def _reset_routing():
    model_routing._configured_slots = (ModelSlot.BASE, ModelSlot.INSTRUCT)
    model_routing._remote_origins = {}
    model_routing._worker_mode = False
    model_routing._initialized = False
    yield


def test_portal_analyze_response_not_on_worker(capsys):
    model_routing.configure_from_args(Namespace(slots="base", remote=None, worker=True))
    inference_response_log.log_analyze_response(
        request_id=1,
        char_count=10,
        result={"bpe_strings": [1, 2]},
        elapsed=0.5,
        for_worker=False,
    )
    assert capsys.readouterr().out == ""


def test_worker_analyze_response_same_format_as_portal(capsys):
    model_routing.configure_from_args(Namespace(slots="base", remote=None, worker=True))
    inference_response_log.log_analyze_response(
        request_id=3,
        char_count=10,
        result={"bpe_strings": [1, 2]},
        elapsed=0.3,
        stream=True,
        for_worker=True,
    )
    out = capsys.readouterr().out
    assert "req_id=3" in out
    assert "tokens=2" in out
    assert "API analyze (stream) response" in out
    assert "worker" not in out.lower()


def test_completions_response_no_trailing_comma_without_ttft(capsys):
    inference_response_log.log_openai_completions_response(
        request_id=2,
        prompt_tokens=70,
        completion_tokens=30,
        elapsed=1.0,
        ttft_s=None,
    )
    out = capsys.readouterr().out.rstrip()
    assert not out.endswith(",")
    assert "70 / 30" in out


def test_extract_completions_ttft_from_result():
    data = {
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        "info_radar": {"ttft_s": 0.25, "bpe_strings": []},
    }
    p, c, ttft = inference_response_log.extract_completions_usage(data)
    assert (p, c, ttft) == (10, 5, 0.25)
