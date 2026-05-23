"""prediction_attribute API 的 source_page slug 规范化（含旧客户端兼容）。"""

ALLOWED_SOURCE_PAGES = frozenset({"analysis", "chat", "attribution", "causal_flow"})


def normalize_source_page(raw: str) -> str | None:
    """剥离 ``.html`` 后缀；``gen_attribute`` → ``causal_flow``；不在白名单则返回 None。"""
    s = raw.strip()
    if not s:
        return None
    if s.endswith(".html"):
        s = s[:-5]
    if s == "gen_attribute":
        s = "causal_flow"
    return s if s in ALLOWED_SOURCE_PAGES else None
