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
        attribution_request: 包含 context 和 target_prediction 的字典

    Returns:
        (响应字典, 状态码) 元组
    """
    context = attribution_request.get("context")
    target_prediction = attribution_request.get("target_prediction")
    model = attribution_request.get("model")

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

    if model is None:
        return {"success": False, "message": "Missing required field: model"}, 400
    if not isinstance(model, str):
        return {"success": False, "message": "model must be a string"}, 400
    if model not in ("base", "instruct"):
        return {"success": False, "message": 'model must be "base" or "instruct"'}, 400

    client_ip = get_client_ip()
    start_time = time.perf_counter()
    request_id = log_prediction_attribute_request(context, target_prediction, model, client_ip)

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
        result = analyze_prediction_attribution(context, target_prediction, model=model)
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
    print(
        f"\t📤 API prediction_attribute response: req_id={request_id}, "
        f"target={target_token!r}, tokens={tokens}, response_time={elapsed:.4f}s"
    )

    return {"success": True, **result}, 200
