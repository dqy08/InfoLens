"""语义评测用例加载（两条脚本共用）。

磁盘格式：

1) 完整用例（按 chunk）
  必填: name, source, chunk_index, text, query
  query: 非空数组；每项必填 query(str)、expect_relevant；相关例须显式有 expect_keywords，无关例可 []
  同一 chunk 内 query 文案不得重复
  每项可选: disputed, dispute_note；扩展如 lang, pair

2) 索引（字符串数组；放在 cases/subsets/，指向 cases/ 下完整用例）
  每项必须是 "chunkName#query文案"（精确到一条 query；文案必须存在且唯一）

加载后展平为「一条 query × 一个 chunk」供评测脚本使用（此时 query 为 str）。
多 query 时展平 name 为 "chunkName#query文案"。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

_CHUNK_REQUIRED = ("name", "source", "chunk_index", "text", "query")
_QUERY_OPTIONAL = ("disputed", "dispute_note", "lang", "pair")


def _validate_query_entry(chunk_name: str, qe: Dict[str, Any], idx: int) -> None:
    if not isinstance(qe, dict):
        raise ValueError(f"用例 {chunk_name} query[{idx}] 须为对象")
    if not isinstance(qe.get("query"), str) or not qe["query"]:
        raise ValueError(f"用例 {chunk_name} query[{idx}] 缺少非空 query 字符串")
    if qe.get("expect_relevant") is None:
        raise ValueError(
            f"用例 {chunk_name} query[{idx}] 的 expect_relevant 未填写（勿提交 skeleton）"
        )
    # 相关例须显式写 expect_keywords，避免漏标后静默成 []
    if bool(qe.get("expect_relevant")) and "expect_keywords" not in qe:
        raise ValueError(
            f"相关用例 {chunk_name} query[{idx}] 须有 expect_keywords 数组"
        )
    if "expect_keywords" in qe and not isinstance(qe["expect_keywords"], list):
        raise ValueError(f"用例 {chunk_name} query[{idx}] 的 expect_keywords 须为数组")


def _check_unique_query_texts(c: Dict[str, Any]) -> None:
    texts = [qe["query"] for qe in c["query"]]
    if len(texts) != len(set(texts)):
        raise ValueError(f"用例 {c['name']} 的 query 文案有重复，无法用文案索引")


def _validate_chunk(c: Dict[str, Any]) -> None:
    for k in _CHUNK_REQUIRED:
        if k not in c:
            raise ValueError(f"用例缺少 {k}: {c.get('name')}")
    qlist = c["query"]
    if not isinstance(qlist, list) or not qlist:
        raise ValueError(f"用例 {c['name']} 的 query 须为非空数组")
    for i, qe in enumerate(qlist):
        _validate_query_entry(c["name"], qe, i)
    _check_unique_query_texts(c)


def _flat_name(chunk_name: str, qtext: str, *, multi: bool) -> str:
    return chunk_name if not multi else f"{chunk_name}#{qtext}"


def _flatten_query_entry(c: Dict[str, Any], qe: Dict[str, Any]) -> Dict[str, Any]:
    multi = len(c["query"]) > 1
    item: Dict[str, Any] = {
        "name": _flat_name(c["name"], qe["query"], multi=multi),
        "source": c["source"],
        "chunk_index": c["chunk_index"],
        "text": c["text"],
        "query": qe["query"],
        "expect_relevant": qe["expect_relevant"],
        "expect_keywords": list(qe.get("expect_keywords") or []),
    }
    for k in _QUERY_OPTIONAL:
        if k in qe:
            item[k] = qe[k]
    return item


def _flatten_chunk(c: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [_flatten_query_entry(c, qe) for qe in c["query"]]


def _parse_index_ref(ref: str) -> Tuple[str, str]:
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError(f"索引项须为非空字符串，得到 {ref!r}")
    if "#" not in ref:
        raise ValueError(f"索引须为 chunkName#query文案，不能省略 query: {ref!r}")
    name, qtext = ref.split("#", 1)
    if not name:
        raise ValueError(f"索引缺少 chunk name: {ref!r}")
    if not qtext:
        raise ValueError(f"索引 '#' 后 query 文案为空: {ref!r}")
    return name, qtext


def _is_chunk_corpus(raw: Any) -> bool:
    return (
        isinstance(raw, list)
        and bool(raw)
        and all(isinstance(x, dict) for x in raw)
    )


def _is_index(raw: Any) -> bool:
    return (
        isinstance(raw, list)
        and bool(raw)
        and all(isinstance(x, str) for x in raw)
    )


def _load_corpus_by_name(cases_dir: Path) -> Dict[str, Dict[str, Any]]:
    """cases_dir 下所有完整用例文件 → name 唯一映射（不递归子目录）。"""
    by_name: Dict[str, Dict[str, Any]] = {}
    for p in sorted(cases_dir.glob("*.json")):
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not _is_chunk_corpus(raw):
            continue
        for c in raw:
            _validate_chunk(c)
            n = c["name"]
            if n in by_name:
                raise ValueError(f"chunk name 重复: {n!r}（文件 {p.name}）")
            by_name[n] = c
    return by_name


def _corpus_dir_for_index(index_path: Path) -> Path:
    """索引在 cases/subsets/ 时，完整用例在上一级 cases/。"""
    parent = index_path.parent
    if parent.name == "subsets":
        return parent.parent
    return parent


def _resolve_index(path: Path, refs: List[str]) -> List[Dict[str, Any]]:
    corpus = _load_corpus_by_name(_corpus_dir_for_index(path))
    if not corpus:
        raise ValueError(f"索引 {path} 对应目录下没有完整用例可供解析")

    flat: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for ref in refs:
        if ref in seen:
            raise ValueError(f"索引重复: {ref!r}（{path}）")
        seen.add(ref)
        name, qtext = _parse_index_ref(ref)
        chunk = corpus.get(name)
        if chunk is None:
            raise ValueError(f"索引找不到 chunk {name!r}（{ref!r} @ {path}）")
        matches = [qe for qe in chunk["query"] if qe["query"] == qtext]
        if not matches:
            available = [qe["query"] for qe in chunk["query"]]
            raise ValueError(
                f"索引 {ref!r}: chunk {name!r} 无 query 文案 {qtext!r}；已有 {available}"
            )
        # 文案唯一已在 _validate_chunk 保证
        flat.append(_flatten_query_entry(chunk, matches[0]))
    return flat


def load_case_file(path: Path) -> List[Dict[str, Any]]:
    """读取完整用例或索引，展平为 list[评测用例]（query 为 str）。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if _is_index(raw):
        return _resolve_index(path, raw)
    if _is_chunk_corpus(raw):
        flat: List[Dict[str, Any]] = []
        for c in raw:
            _validate_chunk(c)
            flat.extend(_flatten_chunk(c))
        return flat
    raise ValueError(
        f"用例文件须为「chunk 对象数组」或「索引字符串数组」: {path}"
    )


def load_all_cases(path: Path) -> List[Dict[str, Any]]:
    """相关性评测：全部（chunk×query）用例。"""
    return load_case_file(path)


def load_relevant_cases(path: Path) -> Tuple[List[Dict[str, Any]], int]:
    """关键词评测：仅 expect_relevant=true；返回 (相关用例, 跳过的无关条数)。"""
    raw = load_case_file(path)
    cases: List[Dict[str, Any]] = []
    skipped = 0
    for c in raw:
        if not bool(c.get("expect_relevant")):
            skipped += 1
            continue
        if not isinstance(c.get("expect_keywords"), list):
            raise ValueError(f"相关用例 {c['name']} 须有 expect_keywords 数组")
        cases.append(c)
    return cases, skipped
