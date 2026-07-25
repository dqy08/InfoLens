"""轻量健康检查：供 Master 加速探针使用。"""


def health():
    return {"ok": True}, 200
