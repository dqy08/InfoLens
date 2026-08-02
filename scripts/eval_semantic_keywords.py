#!/usr/bin/env python3
"""
关键词归因评测：只打 /api/analyze-semantic-keywords（默认本地）。

真值约定：
  - 每条须有 expect_relevant
  - 仅 expect_relevant=true 的用例参与本脚本；无关例跳过（expect_keywords 无意义）
  - 相关例对照 expect_keywords 与 top scored raw（粗匹配）

相关性门控请用 scripts/eval_semantic_relevance_remote.py（云端 Chat）。

用法（项目根目录）:
  python scripts/eval_semantic_keywords.py \\
    -c scripts/cases/林黛玉哭-1_plugin.json \\
    -o scripts/results/林黛玉哭-1_kw.jsonl \\
    --review-md scripts/results/林黛玉哭-1_kw_review.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

HF_TOKEN_ENV = "HF_TOKEN"

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)

DEFAULT_API_BASE = "http://localhost:5001"
PATH_KEYWORDS = "/api/analyze-semantic-keywords"


def analyze_keywords_http(
    api_base: str,
    query: str,
    text: str,
    token: Optional[str] = None,
    timeout: int = 300,
) -> dict:
    url = f"{api_base.rstrip('/')}{PATH_KEYWORDS}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.post(
        url,
        json={"query": query, "text": text, "debug_info": True},
        headers=headers,
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(data.get("message", "分析失败"))
    return data


def _load_jsonl(path: Path) -> list:
    if not path.exists():
        return []
    results = []
    for line in path.read_text(encoding="utf-8").strip().split("\n"):
        if not line:
            continue
        try:
            results.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return results


def _append_record(path: Path, record: dict) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _top_scored_from_attention(token_attention: list, k: int = 10) -> List[dict]:
    if not token_attention:
        return []
    score_max = max(a["score"] for a in token_attention)
    denom = score_max if score_max > 0 else 1
    sorted_attn = sorted(token_attention, key=lambda x: x["score"], reverse=True)[:k]
    out = []
    for a in sorted_attn:
        out.append({
            "raw": a.get("raw"),
            "score": round(a["score"], 6),
            "score_norm": round(a["score"] / denom, 6),
            "offset": a.get("offset"),
        })
    return out


def _keyword_hits(expect_keywords: List[str], top_scored: List[dict]) -> List[str]:
    if not expect_keywords:
        return []
    tops = [str(x.get("raw") or "") for x in (top_scored or [])[:10]]
    blob = " ".join(tops).lower()
    hits = []
    for kw in expect_keywords:
        kl = kw.lower()
        if kl in blob or any(kl in t.lower() or t.lower() in kl for t in tops if t.strip()):
            hits.append(kw)
            continue
        parts = [
            p for p in kw.replace("（", " ").replace("）", " ").replace("(", " ").replace(")", " ").split()
            if len(p) >= 2
        ]
        if parts and any(p.lower() in blob for p in parts):
            hits.append(kw)
    return hits


def _top5_raw(top_scored: List[dict]) -> str:
    if not top_scored:
        return "(无)"
    return ", ".join(repr(x.get("raw", "")) for x in top_scored[:5])


def load_cases(path: Path) -> tuple[List[dict], int]:
    """返回 (相关用例, 跳过的无关条数)。无关例的 expect_keywords 忽略。"""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"用例文件须为 JSON 数组: {path}")
    cases = []
    skipped = 0
    for c in raw:
        if "name" not in c or "query" not in c or "text" not in c:
            raise ValueError(f"用例缺少 name/query/text: {c.get('name')}")
        if c.get("expect_relevant") is None:
            raise ValueError(f"用例 {c['name']} 的 expect_relevant 未填写（勿提交 skeleton）")
        if not bool(c.get("expect_relevant")):
            skipped += 1
            continue
        if not isinstance(c.get("expect_keywords"), list):
            raise ValueError(f"相关用例 {c['name']} 须有 expect_keywords 数组")
        cases.append(c)
    return cases, skipped


def run_one(
    api_base: str,
    case: dict,
    token: Optional[str],
    timeout: int,
    max_retries: int,
) -> dict:
    name = case["name"]
    query = case["query"]
    text = case["text"]
    expect_kw = case.get("expect_keywords") or []
    disputed = bool(case.get("disputed"))
    dispute_note = case.get("dispute_note") or ""

    def _base(**extra: Any) -> dict:
        rec: Dict[str, Any] = {
            "case": name,
            "chunk_index": case.get("chunk_index"),
            "query": query,
            "expect_relevant": True,
            "expect_keywords": expect_kw,
            "source": case.get("source"),
            **extra,
        }
        if disputed:
            rec["disputed"] = True
            if dispute_note:
                rec["dispute_note"] = dispute_note
        return rec

    last_error: Optional[BaseException] = None
    r2 = None
    for attempt in range(max_retries + 1):
        try:
            r2 = analyze_keywords_http(api_base, query, text, token=token, timeout=timeout)
            break
        except Exception as e:
            last_error = e
            if attempt < max_retries:
                wait = 3 * (attempt + 1)
                print(f"  keywords 重试 {attempt + 1}/{max_retries}，{wait}s… {e}", flush=True)
                time.sleep(wait)
    if r2 is None:
        return _base(error=f"keywords: {last_error}")

    top = _top_scored_from_attention(r2.get("token_attention") or [])
    hits = _keyword_hits(expect_kw, top)
    return _base(
        model=r2.get("model", ""),
        top10_scored_raw=top,
        keyword_hits=hits,
        keywords_ok=(not expect_kw) or bool(hits),
    )


def enrich_results_from_cases(results: List[dict], cases: List[dict]) -> None:
    by_name = {c["name"]: c for c in cases}
    for r in results:
        c = by_name.get(r.get("case") or "")
        if not c:
            continue
        if c.get("disputed"):
            r["disputed"] = True
            if c.get("dispute_note"):
                r["dispute_note"] = c["dispute_note"]
        else:
            r.pop("disputed", None)
            r.pop("dispute_note", None)


def write_review_markdown(results: List[dict], path: Path) -> None:
    lines = [
        "# 关键词归因对照表（仅相关例）",
        "",
        "只评 `/api/analyze-semantic-keywords`；无关例不跑本主题。",
        "`disputed=true`：边界争议，汇总仍按 expect 计；报告里点评实测。",
        "",
        "| case | chunk | disputed | hits | verdict |",
        "|---|---:|---|---|---|",
    ]
    ok = miss = err = 0
    disputed_rows: List[dict] = []

    for r in results:
        name = r.get("case", "?")
        ci = r.get("chunk_index", "")
        disp = "yes" if r.get("disputed") else ""
        if r.get("disputed"):
            disputed_rows.append(r)
        if r.get("error"):
            lines.append(f"| {name} | {ci} | {disp} | — | **error**: {r['error']} |")
            err += 1
            continue
        expect_kw = r.get("expect_keywords") or []
        hits = r.get("keyword_hits") or []
        top = _top5_raw(r.get("top10_scored_raw") or [])
        if expect_kw and not hits:
            lines.append(
                f"| {name} | {ci} | {disp} | [] top5={top} | **词未命中** expect={expect_kw} |"
            )
            miss += 1
        else:
            lines.append(
                f"| {name} | {ci} | {disp} | "
                f"hits={hits or '(无 expect_kw)'} top5={top} | **OK** |"
            )
            ok += 1

    lines.extend([
        "",
        "# 汇总",
        "",
        "| 词命中OK | 词未命中 | error |",
        "|---:|---:|---:|",
        f"| {ok} | {miss} | {err} |",
        "",
    ])
    if disputed_rows:
        lines.extend([
            "# 争议 case（disputed）",
            "",
            "| case | note | hits |",
            "|---|---|---|",
        ])
        for r in disputed_rows:
            note = (r.get("dispute_note") or "").replace("|", "\\|")
            hits = r.get("keyword_hits", "—")
            lines.append(f"| {r.get('case')} | {note} | {hits} |")
        lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"✅ 对照表已写入 {path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="关键词归因评测（仅 expect_relevant=true；打本地 keywords API）"
    )
    parser.add_argument("-c", "--cases", type=Path, required=True, help="用例 JSON 数组")
    parser.add_argument("-o", "--output", type=Path, default=None, help="结果 JSONL（可续跑）")
    parser.add_argument("--review-md", type=Path, default=None, help="对照表 Markdown")
    parser.add_argument("--review-only", action="store_true", help="仅从 JSONL 生成对照表")
    parser.add_argument("--url", default=DEFAULT_API_BASE, help=f"keywords API 根，默认 {DEFAULT_API_BASE}")
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    if args.review_only:
        if not args.output or not args.review_md:
            print("错误: --review-only 需要 -o 与 --review-md")
            sys.exit(1)
        results = _load_jsonl(args.output)
        if args.cases:
            cases, _ = load_cases(args.cases)
            enrich_results_from_cases(results, cases)
        write_review_markdown(results, args.review_md)
        return

    cases, skipped = load_cases(args.cases)
    print(f"已加载 {len(cases)} 个相关用例（跳过无关 {skipped}）")
    if not cases:
        print("无相关用例可跑")
        sys.exit(0)

    api_base = args.url.rstrip("/")
    token = args.hf_token or os.environ.get(HF_TOKEN_ENV)

    completed = set()
    all_results: list = []
    if args.output and args.output.exists():
        all_results = _load_jsonl(args.output)
        completed = {r["case"] for r in all_results if "case" in r}
        print(f"已加载 {len(all_results)} 条历史，跳过 {len(completed)} 个 case")

    for i, case in enumerate(cases):
        name = case["name"]
        prog = f"[{i + 1}/{len(cases)}]"
        if name in completed:
            print(f"{prog} ⏭ {name}", flush=True)
            continue
        print(f"{prog} 执行 {name}", flush=True)
        record = run_one(api_base, case, token, args.timeout, args.retries)
        if record.get("error"):
            print(f"{prog} ✗ {name}: {record['error']}", flush=True)
            all_results.append(record)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                _append_record(args.output, record)
            print("⚠ 失败中断后续", flush=True)
            break
        print(
            f"{prog} ✓ {name} hits={record['keyword_hits']} "
            f"ok={record['keywords_ok']}",
            flush=True,
        )
        all_results.append(record)
        completed.add(name)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            _append_record(args.output, record)

    if args.output:
        print(f"\n✅ 结果已写入 {args.output}（共 {len(all_results)} 条）")
    if args.review_md and all_results:
        enrich_results_from_cases(all_results, cases)
        write_review_markdown(all_results, args.review_md)


if __name__ == "__main__":
    main()
