"""预测归因 API"""
import gc
import time

from backend.model_manager import _inference_lock
from backend.oom import exit_if_oom
from backend.prediction_attributor import analyze_prediction_attribution
from backend.api.analyze import LOCK_WAIT_TIMEOUT
from backend.access_log import get_client_ip, log_prediction_attribute_request


def prediction_attribute(attribution_request):
    """
    对上下文文本的下一 token 预测做归因分析。

    Args:
        attribution_request: 须含 ``context``、``model``。归因目标二选一：
            省略 ``target_prediction`` 且省略 ``target_token_id`` 时为 top-1；
            或传非空 ``target_prediction``（字符串首 token）；
            或传 ``target_token_id``（非负整数词表 id）；二者不可同时出现。

    Returns:
        (响应字典, 状态码) 元组
    """
    context = attribution_request.get("context")
    target_prediction = attribution_request.get("target_prediction")
    target_token_id = attribution_request.get("target_token_id")
    model = attribution_request.get("model")
    source_page = attribution_request.get("source_page")
    flow_id = attribution_request.get("flow_id")
    flow_step = attribution_request.get("flow_step")

    if context is None:
        return {"success": False, "message": "Missing required field: context"}, 400
    if not isinstance(context, str):
        return {"success": False, "message": "context must be a string"}, 400
    if context == "":
        return {"success": False, "message": "Missing required field: context"}, 400

    if target_prediction is not None and not isinstance(target_prediction, str):
        return {"success": False, "message": "target_prediction must be a string"}, 400
    if target_prediction == "":
        return {"success": False, "message": "target_prediction must not be empty"}, 400
    if target_token_id is not None and not isinstance(target_token_id, int):
        return {"success": False, "message": "target_token_id must be an integer"}, 400
    if target_token_id is not None and target_token_id < 0:
        return {"success": False, "message": "target_token_id must be >= 0"}, 400
    if target_prediction is not None and target_token_id is not None:
        return {"success": False, "message": "target_prediction and target_token_id are mutually exclusive"}, 400

    if model is None:
        return {"success": False, "message": "Missing required field: model"}, 400
    if not isinstance(model, str):
        return {"success": False, "message": "model must be a string"}, 400
    if model not in ("base", "instruct"):
        return {"success": False, "message": 'model must be "base" or "instruct"'}, 400

    allowed_source_pages = {
        "analysis.html",
        "chat.html",
        "attribution.html",
        "gen_attribute.html",
    }

    if source_page is None:
        return {"success": False, "message": "Missing required field: source_page"}, 400
    if not isinstance(source_page, str):
        return {"success": False, "message": "source_page must be a string"}, 400
    if source_page == "":
        return {"success": False, "message": "source_page must not be empty"}, 400
    if source_page not in allowed_source_pages:
        return {
            "success": False,
            "message": "source_page must be one of: analysis.html, chat.html, attribution.html, gen_attribute.html",
        }, 400

    if flow_id is not None and not isinstance(flow_id, str):
        return {"success": False, "message": "flow_id must be a string"}, 400
    if flow_id == "":
        return {"success": False, "message": "flow_id must not be empty"}, 400
    if flow_step is not None and not isinstance(flow_step, int):
        return {"success": False, "message": "flow_step must be an integer"}, 400
    if flow_step is not None and flow_step < 0:
        return {"success": False, "message": "flow_step must be >= 0"}, 400

    is_causal_flow = source_page == "gen_attribute.html"
    if is_causal_flow:
        if flow_id is None:
            return {"success": False, "message": "Missing required field: flow_id for causal flow"}, 400
        if flow_step is None:
            return {"success": False, "message": "Missing required field: flow_step for causal flow"}, 400
    elif flow_id is not None or flow_step is not None:
        return {
            "success": False,
            "message": "flow_id/flow_step are only allowed when source_page is gen_attribute.html",
        }, 400

    client_ip = get_client_ip()
    start_time = time.perf_counter()
    request_id = log_prediction_attribute_request(
        context=context,
        target_prediction=target_prediction,
        target_token_id=target_token_id,
        model=model,
        source_page=source_page,
        flow_id=flow_id,
        flow_step=flow_step,
        client_ip=client_ip,
    )

    lock_acquired = _inference_lock.acquire(timeout=LOCK_WAIT_TIMEOUT)
    if not lock_acquired:
        return {
            "success": False,
            "message": (
                f"Queue wait exceeded {LOCK_WAIT_TIMEOUT} seconds; "
                "server is busy, please try again later."
            ),
        }, 503

    try:
        result = analyze_prediction_attribution(
            context,
            target_prediction,
            model=model,
            target_token_id=target_token_id,
        )
    except ValueError as e:
        return {"success": False, "message": str(e)}, 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        exit_if_oom(e, defer_seconds=1)
        return {"success": False, "message": str(e)}, 500
    finally:
        _inference_lock.release()
        gc.collect()

    elapsed = time.perf_counter() - start_time
    tokens = len(result.get("token_attribution", []))
    target_token = result.get("target_token")
    if flow_id is None:
        print(
            f"\t📤 API prediction_attribute response: req_id={request_id}, "
            f"target={target_token!r}, tokens={tokens}, response_time={elapsed:.4f}s"
        )
    else:
        print(
            f"\t📤 API prediction_attribute response: req_id={request_id}, "
            f"flow_id={flow_id!r}, flow_step={flow_step}, "
            f"target={target_token!r}, tokens={tokens}, response_time={elapsed:.4f}s"
        )

    return {"success": True, **result}, 200
