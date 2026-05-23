"""文本 tokenize API：不做模型推理，仅返回各 token 的字符 offset 与原文。"""
from backend.core.prediction_attributor import slot_for_prediction_attr_model
from backend.models.model_manager import ensure_slot_weights_loaded


def tokenize(tokenize_request):
    """
    对 context 用指定 model 的 tokenizer 分词，返回各 token 的字符 offset 与原文。
    不持有推理锁，不做前向 / 梯度计算。
    """
    context = tokenize_request.get("context")
    model = tokenize_request.get("model")

    if context is None or not isinstance(context, str) or context == "":
        return {"success": False, "message": "Missing required field: context"}, 400
    if model is None or not isinstance(model, str):
        return {"success": False, "message": "Missing required field: model"}, 400

    try:
        slot = slot_for_prediction_attr_model(model)
    except ValueError as e:
        return {"success": False, "message": str(e)}, 400

    tokenizer, _, _ = ensure_slot_weights_loaded(slot)

    enc = tokenizer(context, return_offsets_mapping=True)
    token_ids = enc["input_ids"]
    if token_ids and isinstance(token_ids[0], list):
        token_ids = token_ids[0]
    spans = [
        {"offset": [s, e], "raw": context[s:e], "token_id": int(tid)}
        for (s, e), tid in zip(enc["offset_mapping"], token_ids)
        if s < e  # 过滤 BOS/EOS 等长度为 0 的特殊 token
    ]

    return {"success": True, "spans": spans}, 200
