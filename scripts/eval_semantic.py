#!/usr/bin/env python3
"""
Semantic analyzer 效果评估脚本

通过 HTTP 调用原生接口评估：
- /api/analyze-semantic-relevance：相关性门控（full_match_degree vs 阈值）
- /api/analyze-semantic-keywords：关键词归因（token_attention / expect_keywords）

默认按生产 hybrid：两段都跑；无关例上 keywords 假阳不计分（生产不会走到染色）。

提示词语言由服务端模块常量决定（RELEVANCE_PROMPT_LANG / KEYWORDS_PROMPT_LANG），不经 API。

用例字段：
- expect_relevant：relevance 是否应放行
- expect_keywords：keywords 应命中的关键词（仅 expect_relevant=true 时判定）

用法（从项目根目录运行）：
  python scripts/eval_semantic.py -c scripts/cases/eval_cases_short.json -o eval_result.jsonl
  python scripts/eval_semantic.py --url http://localhost:5001
  python scripts/eval_semantic.py \\
    -c scripts/cases/eval_cases_bilingual_critical.json \\
    -o scripts/results/bilingual_critical_1.7b.jsonl \\
    --review-md scripts/results/bilingual_critical_1.7b_hybrid_review.md

输出为 JSONL 格式，每完成一例追加一行；中断后可再次运行，从中断处续跑。
旧 JSONL 的 submode=count|fill_blank 在读对照表时仍识别为 relevance|keywords。
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Hugging Face Token（用于Private Space，可通过环境变量HF_TOKEN设置）
HF_TOKEN_ENV = "HF_TOKEN"

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)


# 测试用例：(名称, query, text, meta)
# meta：expect_relevant / expect_keywords（hybrid）
TEST_CASES = [
    ("相关_AI", "人工智能", "人工智能正在改变我们的生活。机器学习、深度学习等技术在医疗、金融等领域广泛应用。",
     {"expect_relevant": True, "expect_keywords": ["人工智能", "机器学习"]}),
    ("相关_天气", "天气", "今天北京天气晴朗，气温适宜，适合户外活动。明天可能有小雨。",
     {"expect_relevant": True, "expect_keywords": ["天气", "晴朗", "小雨"]}),
    ("无关_足球对AI", "足球比赛", "人工智能正在改变我们的生活。机器学习、深度学习等技术在医疗、金融等领域广泛应用。",
     {"expect_relevant": False, "expect_keywords": []}),
    ("无关_烹饪对天气", "红烧肉做法", "今天北京天气晴朗，气温适宜，适合户外活动。明天可能有小雨。",
     {"expect_relevant": False, "expect_keywords": []}),
]

DEFAULT_API_BASE = "http://localhost:5001"
# SYNC: client/src/shared/core/constants.ts → SEMANTIC_MATCH_THRESHOLD；extension/config.js
SEMANTIC_MATCH_THRESHOLD = 0.1

# mode → API path（与生产原生接口一致）
MODE_PATH = {
    "relevance": "/api/analyze-semantic-relevance",
    "keywords": "/api/analyze-semantic-keywords",
}
# 旧 JSONL / 别名 → 规范 mode
_MODE_ALIASES = {
    "relevance": "relevance",
    "keywords": "keywords",
    "count": "relevance",
    "fill_blank": "keywords",
}


def _normalize_mode(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return _MODE_ALIASES.get(value, value)


def analyze_semantic_http(
    api_base: str,
    query: str,
    text: str,
    mode: str,
    token: Optional[str] = None,
    timeout: int = 300,
) -> dict:
    """通过 HTTP 调用 relevance / keywords 原生接口。"""
    mode = _normalize_mode(mode)
    if mode not in MODE_PATH:
        raise ValueError(f"Unknown mode: {mode}")
    url = f"{api_base.rstrip('/')}{MODE_PATH[mode]}"
    payload: dict = {"query": query, "text": text, "debug_info": True}
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(data.get("message", "分析失败"))
    return data


def _load_jsonl(path: Path) -> list:
    """加载 JSONL 文件，用于断点续跑"""
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
    """追加单条记录到 JSONL 文件"""
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _record_mode(record: dict) -> Optional[str]:
    return _normalize_mode(record.get("mode") or record.get("submode"))


def _completed_key(mode: str, name: str) -> Tuple[str, str]:
    return (_normalize_mode(mode) or mode, name)


def run_eval(
    api_base: str,
    mode: str,
    test_cases: list,
    token: Optional[str] = None,
    output_path: Optional[Path] = None,
    all_results: Optional[list] = None,
    completed: Optional[set] = None,
    max_retries: int = 3,
    timeout: int = 300,
) -> Tuple[list, bool]:
    """返回 (results, aborted)，重试后仍失败时 aborted 为 True"""
    mode = _normalize_mode(mode) or mode
    completed = completed or set()
    results = []
    for j, (name, query, text, meta) in enumerate(test_cases):
        prog = f"[{j+1}/{len(test_cases)}]"
        key = _completed_key(mode, name)
        if key in completed:
            print(f"{prog} ⏭ 跳过: {mode} | {name}", flush=True)
            continue
        print(f"{prog} 执行: {mode} | {name}", flush=True)
        res = None
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                res = analyze_semantic_http(
                    api_base, query, text, mode, token=token, timeout=timeout,
                )
                break
            except Exception as e:
                last_error = e
                if attempt < max_retries:
                    wait = 3 * (attempt + 1)
                    print(f"{prog}   重试 {attempt + 1}/{max_retries}，{wait}s 后... - {e}", flush=True)
                    time.sleep(wait)
        if res is None:
            print(f"{prog} ✗ 失败（已重试 {max_retries} 次）: {mode} | {name} - {last_error}", flush=True)
            record = {
                "mode": mode,
                "case": name,
                "case_lang": meta.get("lang"),
                "pair": meta.get("pair"),
                "query": query,
                "error": str(last_error),
            }
            results.append(record)
            if all_results is not None:
                all_results.append(record)
            completed.add(key)
            print(f"\n⚠ 重试后仍失败，中断后续用例", flush=True)
            return results, True

        di = res.get("debug_info", {})
        topk_tokens = di.get("topk_tokens", [])
        topk_probs = di.get("topk_probs", [])
        token_attention = res.get("token_attention") or []

        # 0-max 归一化: score / max ∈ [0, 1]，最大值归一为 1
        score_max = max(a["score"] for a in token_attention) if token_attention else 0
        denom = score_max if score_max > 0 else 1

        # 按 score 排序取 top10
        sorted_attn = sorted(token_attention, key=lambda x: x["score"], reverse=True)[:10]
        top_scored = []
        for a in sorted_attn:
            score_norm = round(a["score"] / denom, 6)
            top_scored.append({
                "raw": a["raw"],
                "score": round(a["score"], 6),
                "score_norm": score_norm,
                "offset": a["offset"],
            })

        record = {
            "model": res.get("model", ""),
            "mode": mode,
            "case": name,
            "case_lang": meta.get("lang"),
            "pair": meta.get("pair"),
            "expect_relevant": meta.get("expect_relevant"),
            "expect_keywords": meta.get("expect_keywords") or [],
            "query": query,
            "text_preview": text[:80] + "..." if len(text) > 80 else text,
            "full_match_degree": res.get("full_match_degree", None),
            "top10_tokens": topk_tokens,
            "top10_probs": [round(p, 6) for p in topk_probs],
            "top10_scored_raw": top_scored,
            "score_stats": {
                "min": round(min(a["score"] for a in token_attention), 6) if token_attention else None,
                "max": round(score_max, 6) if token_attention else None,
                "mean": round(sum(a["score"] for a in token_attention) / len(token_attention), 6) if token_attention else None,
                "mean_norm": round(sum(a["score"] / denom for a in token_attention) / len(token_attention), 6) if token_attention else None,
            },
        }
        results.append(record)
        if all_results is not None:
            all_results.append(record)
        completed.add(key)
        if output_path:
            _append_record(output_path, record)
        print(f"{prog} ✓ 完成: {mode} | {name}", flush=True)

    return results, False


def _top5_raw(record: Dict[str, Any]) -> str:
    scored = record.get("top10_scored_raw") or []
    if not scored:
        return "(无)"
    return ", ".join(repr(x.get("raw", "")) for x in scored[:5])


def _expect_relevant(record: Dict[str, Any]) -> Optional[bool]:
    val = record.get("expect_relevant")
    return bool(val) if val is not None else None


def _relevance_passed(record: Dict[str, Any], threshold: float = SEMANTIC_MATCH_THRESHOLD) -> bool:
    deg = record.get("full_match_degree")
    return deg is not None and deg >= threshold


def _keyword_hits(record: Dict[str, Any]) -> List[str]:
    """粗匹配：expect_keywords 子串是否出现在 top10 scored raw 中（供对照，非严格 gold）。"""
    kws = record.get("expect_keywords") or []
    if not kws:
        return []
    tops = [str(x.get("raw") or "") for x in (record.get("top10_scored_raw") or [])[:10]]
    blob = " ".join(tops).lower()
    hits = []
    for kw in kws:
        kl = kw.lower()
        if kl in blob or any(kl in t.lower() or t.lower() in kl for t in tops if t.strip()):
            hits.append(kw)
            continue
        parts = [p for p in kw.replace("（", " ").replace("）", " ").replace("(", " ").replace(")", " ").split() if len(p) >= 2]
        if parts and any(p.lower() in blob for p in parts):
            hits.append(kw)
    return hits


def _index_by_cell(results: List[dict]) -> Dict[Tuple[str, str, str], dict]:
    """(pair, mode, case_lang) -> record。旧 JSONL 的 count/fill_blank 归一为 relevance/keywords。"""
    out: Dict[Tuple[str, str, str], dict] = {}
    for r in results:
        if r.get("error") or not r.get("pair"):
            continue
        mode = _record_mode(r)
        if not mode:
            continue
        key = (r["pair"], mode, r.get("case_lang") or "?")
        out[key] = r
    return out


def write_hybrid_review_markdown(
    results: List[dict],
    path: Path,
    threshold: float = SEMANTIC_MATCH_THRESHOLD,
) -> None:
    """
    Hybrid 人工对照表：只评 relevance 门控 +（门控放行后的）keywords。
    无关例被 relevance 拦住时，不展示/不计 keywords 假阳。
    """
    idx = _index_by_cell(results)
    pairs = sorted({r["pair"] for r in results if r.get("pair") and not r.get("error")})
    case_langs = sorted({r.get("case_lang") for r in results if r.get("case_lang") and not r.get("error")})
    if not case_langs:
        case_langs = ["?"]

    lines: List[str] = [
        "# Hybrid 对照表（relevance 门控 + keywords 关键词）",
        "",
        f"对齐生产 hybrid：`relevance` 的 `full_match_degree >= {threshold}` 才进入 `keywords` 染色。",
        "无关例只看 relevance 是否拦住；keywords 假阳在门控失败时**不计**。",
        "相关例：relevance 应放行，且 top5 宜覆盖 `expect_keywords`。",
        "提示词语言由服务端常量决定（默认 en）。",
        "",
    ]

    stats: Dict[str, int] = {
        "rel_ok": 0, "rel_miss_gate": 0, "rel_miss_kw": 0,
        "irrel_ok": 0, "irrel_fp": 0,
    }

    for pair in pairs:
        sample = next(
            (r for r in results if r.get("pair") == pair and not r.get("error")),
            None,
        )
        if not sample:
            continue
        want_pass = _expect_relevant(sample)
        lines.append(f"## {pair} · expect_relevant={want_pass}")
        lines.append("")
        if set(case_langs) >= {"zh", "en"}:
            lines.append("| case_lang | result |")
            lines.append("|---|---|")
            col_langs = ["zh", "en"]
        else:
            lines.append("| case_lang | result |")
            lines.append("|---|---|")
            col_langs = case_langs

        for cl in col_langs:
            rc = idx.get((pair, "relevance", cl))
            rf = idx.get((pair, "keywords", cl))
            if not rc:
                lines.append(f"| **{cl}** | _missing relevance_ |")
                continue
            passed = _relevance_passed(rc, threshold)
            deg = rc.get("full_match_degree")
            gate = "PASS" if passed else "fail"
            expect_kw = (rf or rc).get("expect_keywords") or []

            if want_pass is False:
                ok = not passed
                verdict = "拒识OK" if ok else "误放行"
                cell = f"relevance={gate} ({deg}) → **{verdict}**"
                if ok:
                    stats["irrel_ok"] += 1
                else:
                    stats["irrel_fp"] += 1
                    if rf:
                        cell += f"<br>误入后 top5: {_top5_raw(rf)}"
            elif want_pass is True:
                if not passed:
                    cell = f"relevance={gate} ({deg}) → **门控漏检**"
                    stats["rel_miss_gate"] += 1
                else:
                    hits = _keyword_hits(rf) if rf else []
                    top = _top5_raw(rf) if rf else "(无 keywords)"
                    if expect_kw and not hits:
                        cell = (
                            f"relevance={gate} ({deg}) → **词未命中**<br>"
                            f"expect_kw={expect_kw}<br>top5: {top}"
                        )
                        stats["rel_miss_kw"] += 1
                    else:
                        cell = (
                            f"relevance={gate} ({deg}) → **OK**<br>"
                            f"hits={hits or '(无 expect_kw)'}<br>top5: {top}"
                        )
                        stats["rel_ok"] += 1
            else:
                cell = f"relevance={gate} ({deg})（无 expect）"
            lines.append(f"| **{cl}** | {cell} |")
        lines.append("")
        lines.append("人工判定笔记：（留空）")
        lines.append("")

    lines.append("# Hybrid 汇总")
    lines.append("")
    lines.append("| 相关OK | 门控漏 | 门过词差 | 无关拒识OK | 无关误放行 |")
    lines.append("|---:|---:|---:|---:|---:|")
    lines.append(
        f"| {stats['rel_ok']} | {stats['rel_miss_gate']} | {stats['rel_miss_kw']} | "
        f"{stats['irrel_ok']} | {stats['irrel_fp']} |"
    )
    lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"✅ Hybrid 对照表已写入 {path}")


def write_review_markdown(results: List[dict], path: Path, hybrid: bool = True) -> None:
    """默认写 hybrid 对照表；hybrid=False 时按 mode 展开（旧调试用）。"""
    if hybrid:
        write_hybrid_review_markdown(results, path)
        return

    by_pair_mode: Dict[Tuple[str, str], List[dict]] = defaultdict(list)
    for r in results:
        if r.get("error") or not r.get("pair"):
            continue
        mode = _record_mode(r)
        if not mode:
            continue
        by_pair_mode[(r["pair"], mode)].append(r)

    lines: List[str] = [
        "# 对照表（分 mode，非 hybrid）",
        "",
        "调试用：分别看 relevance / keywords。生产请用默认 hybrid 对照表。",
        "",
    ]

    for (pair, mode) in sorted(by_pair_mode.keys()):
        rows = by_pair_mode[(pair, mode)]
        lines.append(f"## {pair} · `{mode}`")
        lines.append("")
        lines.append("| case_lang | result |")
        lines.append("|---|---|")
        for case_lang in ("zh", "en"):
            hit = next((r for r in rows if r.get("case_lang") == case_lang), None)
            if not hit:
                lines.append(f"| **{case_lang}** | _missing_ |")
                continue
            deg = hit.get("full_match_degree")
            kw = hit.get("expect_keywords") or []
            rel = _expect_relevant(hit)
            cell = (
                f"degree={deg}<br>"
                f"expect_relevant={rel}<br>"
                f"expect_kw={kw}<br>"
                f"top5: {_top5_raw(hit)}"
            )
            lines.append(f"| **{case_lang}** | {cell} |")
        lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"✅ 对照表已写入 {path}")


def _load_cases(paths: Optional[List[Path]]) -> list:
    if not paths:
        return TEST_CASES
    test_cases = []
    for path in paths:
        raw = json.loads(path.read_text(encoding="utf-8"))
        for c in raw:
            if "name" not in c or "query" not in c:
                continue
            expect_relevant = c.get("expect_relevant")
            meta = {
                "lang": c.get("lang"),
                "pair": c.get("pair"),
                "expect_keywords": c.get("expect_keywords") if expect_relevant else [],
                "expect_relevant": expect_relevant,
            }
            # strip() 与浏览器语义分析时的 trim() 保持一致，避免 token 数差异
            test_cases.append((c["name"], c["query"], (c["text"] or "").strip(), meta))
    print(f"已加载 {len(test_cases)} 个用例，来自 {len(paths)} 个文件")
    return test_cases


def main():
    parser = argparse.ArgumentParser(
        description="评估 semantic analyzer（默认 hybrid：relevance 门控 + keywords 关键词）"
    )
    parser.add_argument(
        "--mode",
        choices=["relevance", "keywords"],
        nargs="+",
        default=None,
        help="不指定则评估 relevance + keywords（hybrid 两段）",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="结果输出 JSONL 路径（支持断点续跑）",
    )
    parser.add_argument(
        "--review-md",
        type=Path,
        default=None,
        help="人工阅读对照表 Markdown（默认 hybrid 视角）",
    )
    parser.add_argument(
        "--review-only",
        action="store_true",
        help="不跑评测，仅从 --output JSONL 生成 --review-md",
    )
    parser.add_argument(
        "--no-hybrid-review",
        action="store_true",
        help="对照表按 mode 分开展示（旧调试格式）",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=SEMANTIC_MATCH_THRESHOLD,
        help=f"relevance 门控阈值，默认 {SEMANTIC_MATCH_THRESHOLD}",
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_API_BASE,
        help=f"API 地址，默认 {DEFAULT_API_BASE}",
    )
    parser.add_argument(
        "--hf-token",
        type=str,
        default=None,
        help=f"Hugging Face Token（用于Private Space，也可通过环境变量{HF_TOKEN_ENV}设置）",
    )
    parser.add_argument(
        "--cases", "-c",
        type=Path,
        nargs="+",
        default=None,
        help="测试用例 JSON：[{name, query, text, expect_relevant, expect_keywords, ...}]",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="失败时自动重试次数，默认 3",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="单次请求超时秒数，默认 300",
    )
    args = parser.parse_args()
    hybrid_review = not args.no_hybrid_review

    if args.review_only:
        if not args.output or not args.review_md:
            print("错误: --review-only 需要同时指定 -o 与 --review-md")
            sys.exit(1)
        results = _load_jsonl(args.output)
        if hybrid_review:
            write_hybrid_review_markdown(results, args.review_md, threshold=args.threshold)
        else:
            write_review_markdown(results, args.review_md, hybrid=False)
        return

    api_base = args.url.rstrip("/")
    hf_token = args.hf_token or os.environ.get(HF_TOKEN_ENV)
    test_cases = _load_cases(args.cases)

    modes = args.mode if args.mode else ["relevance", "keywords"]
    all_results: list = []
    completed: set = set()
    if args.output and args.output.exists():
        all_results = _load_jsonl(args.output)
        completed = {
            _completed_key(_record_mode(r) or "", r["case"])
            for r in all_results
            if _record_mode(r) and "case" in r
        }
        print(f"已加载 {len(all_results)} 条历史结果，从中断处续跑")

    aborted = False
    for mode in modes:
        _, aborted = run_eval(
            api_base, mode, test_cases, token=hf_token,
            output_path=args.output, all_results=all_results,
            completed=completed, max_retries=args.retries, timeout=args.timeout,
        )
        if aborted:
            break

    if args.output:
        print(f"\n✅ 结果已写入 {args.output}（共 {len(all_results)} 条）")
    if args.review_md and all_results:
        if hybrid_review:
            write_hybrid_review_markdown(all_results, args.review_md, threshold=args.threshold)
        else:
            write_review_markdown(all_results, args.review_md, hybrid=False)


if __name__ == "__main__":
    main()
