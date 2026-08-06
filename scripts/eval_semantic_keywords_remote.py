#!/usr/bin/env python3
"""
远程 Chat API 关键词匹配评测（默认 OpenRouter；与门面 keywords v2 同契约）。

定位：评测模型「抽词 + 排序」能力（对照 expect_keywords 的集合/顺序指标）。
不跑线上渲染路径：不定位、不 uniquifyHighScores、不 REPEAT_DIM 压分——那些是
keywords_remote_v2.js 里为上色观感做的 Workaround，与模型能力无关。

契约（SYNC: cf/facade/src/keywords_remote_v2.js）：
  - Task：抽取与 query 相关、且出现在正文中的关键词，按重要性排序；用 submit_keywords 提交
  - Tool schema：keywords[{keyword, score}]，score 1–5
  - 版式：Task/Query → Text → Task Reminder/Query（三明治）
对照 expect_keywords 打分时先忽略 score，只用关键词列表。仅跑 expect_relevant=true。

打分（子串互含）：
  - 集合：召回 / 精确 / F1 —— 对外展示必须带括号释义，见下方 METRIC_*
  - 成对顺序正确率（两边都命中的 expect 词对，相对先后是否与 gold 一致）

用法（项目根目录）:
  python scripts/eval_semantic_keywords_remote.py \\
    -c scripts/cases/subsets/keywords.typical10.json \\
    -o scripts/results/keywords_typical10_remote_hy3.jsonl \\
    --review-md scripts/results/keywords_typical10_remote_hy3_review.md \\
    -j 8
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from semantic_case_load import load_relevant_cases

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)

OPENROUTER_TOKEN_ENV = "OPENROUTER_API_KEY"
HF_TOKEN_ENV = "HF_TOKEN"
DEFAULT_API_BASE = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "tencent/hy3"
DEFAULT_MAX_TOKENS = 256

# ---------------------------------------------------------------------------
# 虚拟提交工具契约（SYNC: cf/facade/src/keywords_remote_v2.js）
# Task：做什么 + 用哪个 tool；字段格式只在 tool schema。
# ---------------------------------------------------------------------------
TOOL_NAME = "submit_keywords"

KEYWORDS_TASK = (
    "Extract all keywords related to the query topic. "
    "A keyword can be a word or short phrase. "
    "Make sure to only extract keywords that appear in the text. "
    "Order them from most important to least important. "
    f"Submit with {TOOL_NAME}."
)

SUBMIT_KEYWORDS_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": "Submit extracted keywords with scores.",
        "parameters": {
            "type": "object",
            "required": ["keywords"],
            "properties": {
                "keywords": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["keyword", "score"],
                        "properties": {
                            "keyword": {"type": "string"},
                            "score": {
                                "type": "integer",
                                "description": "1 (slightly related) to 5 (strongly related).",
                            },
                        },
                    },
                }
            },
        },
    },
}

# ---------------------------------------------------------------------------
# 对外展示约定（强制生效）：对照表表头、汇总行、日志打印里的 R/P/F1/pair
# 一律引用下列常量，禁止裸写 "R"/"P"/"F1"/"pair"。
# ---------------------------------------------------------------------------
METRIC_R = "R(召回：该出的出了多少)"
METRIC_P = "P(精确：抽出的有多少对)"
METRIC_F1 = "F1(综合)"
METRIC_PAIR = "pair(成对顺序：命中词相对先后是否一致)"
METRIC_LEGEND = f"{METRIC_R}；{METRIC_P}；{METRIC_F1}；{METRIC_PAIR}"


def format_rpf1(recall: float, precision: float, f1: float, *, pct: bool = True) -> str:
    """格式化 R/P/F1，强制带括号释义（与表头/汇总同一套 METRIC_*）。"""
    if pct:
        return (
            f"{METRIC_R}={recall:.0%} {METRIC_P}={precision:.0%} {METRIC_F1}={f1:.0%}"
        )
    return f"{METRIC_R}={recall} {METRIC_P}={precision} {METRIC_F1}={f1}"


def build_keywords_user_content(query: str, text: str) -> str:
    """三明治：Task/Query → Text → Task Reminder/Query。SYNC: keywords_remote_v2.js"""
    query_line = f"Query: {query}"
    head = f"Task: {KEYWORDS_TASK}\n{query_line}"
    reminder = f"Task Reminder: {KEYWORDS_TASK}\n{query_line}"
    return f"{head}\nText:\n\n{text}\n\n{reminder}"


def build_keywords_chat_body(
    query: str,
    text: str,
    *,
    model: str = DEFAULT_MODEL,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> Dict[str, Any]:
    return {
        "model": model,
        "messages": [{"role": "user", "content": build_keywords_user_content(query, text)}],
        "tools": [SUBMIT_KEYWORDS_TOOL],
        "tool_choice": {
            "type": "function",
            "function": {"name": TOOL_NAME},
        },
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
        "reasoning": {"effort": "none"},
    }


def parse_submit_keywords_arguments(arguments: str) -> Optional[List[Tuple[str, int]]]:
    """从 tool_calls[].function.arguments 得到 [(kw, score), ...]；失败返回 None。"""
    try:
        data = json.loads(arguments)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    items = data.get("keywords")
    if not isinstance(items, list):
        return None
    out: List[Tuple[str, int]] = []
    for x in items:
        if not isinstance(x, dict):
            continue
        kw = x.get("keyword")
        score = x.get("score")
        if not isinstance(kw, str) or not kw.strip():
            continue
        if not isinstance(score, (int, float)) or score != score:  # NaN
            continue
        s = int(round(float(score)))
        s = max(1, min(5, s))
        out.append((kw.strip(), s))
    # 空数组 = 合法零词；非空却 0 条有效 = 契约外，当解析失败
    if len(items) > 0 and len(out) == 0:
        return None
    return out


def is_keywords_length_stop(choice: Optional[dict]) -> bool:
    """OpenRouter 常把 finish_reason 归一成 tool_calls；超长截断看 native_finish_reason=length。"""
    if not isinstance(choice, dict):
        return False
    return choice.get("finish_reason") == "length" or choice.get("native_finish_reason") == "length"


def salvage_partial_submit_keywords_arguments(
    arguments: str,
) -> Optional[List[Tuple[str, int]]]:
    """从 length 截断的残缺 arguments 捞已写完的 {keyword,score}；一个都没有 → None。
    SYNC: cf/facade/src/keywords_remote_v2.js → salvagePartialKeywordsArguments
    """
    if not isinstance(arguments, str) or not arguments:
        return None
    found: List[Tuple[int, str, int]] = []

    def push(i: int, kw_raw: str, score_raw: str) -> None:
        try:
            kw = json.loads(f'"{kw_raw}"')
        except json.JSONDecodeError:
            return
        if not isinstance(kw, str) or not kw.strip():
            return
        try:
            score = float(score_raw)
        except ValueError:
            return
        if score != score:  # NaN
            return
        s = int(round(score))
        s = max(1, min(5, s))
        found.append((i, kw.strip(), s))

    for m in re.finditer(
        r'\{\s*"keyword"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"score"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}',
        arguments,
    ):
        push(m.start(), m.group(1), m.group(2))
    for m in re.finditer(
        r'\{\s*"score"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"keyword"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}',
        arguments,
    ):
        push(m.start(), m.group(2), m.group(1))
    if not found:
        return None
    found.sort(key=lambda x: x[0])
    return [(kw, score) for _i, kw, score in found]


def resolve_submit_keywords_arguments(
    arguments: str,
    choice: Optional[dict] = None,
) -> Optional[List[Tuple[str, int]]]:
    """严格解析；失败且为 length 截断时再 salvage。"""
    scored = parse_submit_keywords_arguments(arguments)
    if scored is not None:
        return scored
    if is_keywords_length_stop(choice):
        return salvage_partial_submit_keywords_arguments(arguments)
    return None


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


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


def _norm(s: str) -> str:
    return s.strip().casefold()


def _soft_match(a: str, b: str) -> bool:
    """子串互含（已 norm 后）。"""
    return bool(a and b and (a in b or b in a))


def match_keywords(expect: List[str], got: List[str]) -> Dict[str, Any]:
    """集合 + 成对顺序打分。

    - recall / precision / f1：子串互含（集合，允许多 expect 命中同一 got）
      对外打印用 format_rpf1 / METRIC_*，勿只写裸 R/P/F1
    - pairwise_acc：一对一对齐后，命中词对的相对先后是否与 gold 一致
    """
    expect_n = [_norm(e) for e in expect]
    got_n = [_norm(g) for g in got]

    hit: List[str] = []
    miss: List[str] = []
    for ei, en in enumerate(expect_n):
        ok = any(_soft_match(en, gn) for gn in got_n if gn)
        (hit if ok else miss).append(expect[ei])

    got_hit: List[str] = []
    got_extra: List[str] = []
    for gi, gn in enumerate(got_n):
        ok = any(_soft_match(gn, en) for en in expect_n if en)
        (got_hit if ok else got_extra).append(got[gi])

    n_exp = len(expect)
    n_got = len(got)
    n_hit_exp = len(hit)
    n_hit_got = len(got_hit)
    recall = n_hit_exp / n_exp if n_exp else 0.0
    precision = n_hit_got / n_got if n_got else 0.0
    if precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)
    else:
        f1 = 0.0

    used_got: set = set()
    expect_to_got: Dict[int, int] = {}
    for ei, en in enumerate(expect_n):
        for gi, gn in enumerate(got_n):
            if gi in used_got or not gn:
                continue
            if _soft_match(en, gn):
                used_got.add(gi)
                expect_to_got[ei] = gi
                break

    aligned = sorted(expect_to_got.items())
    pair_ok = 0
    pair_n = 0
    for a in range(len(aligned)):
        for b in range(a + 1, len(aligned)):
            _ei, gi = aligned[a]
            _ej, gj = aligned[b]
            pair_n += 1
            if gi < gj:
                pair_ok += 1
    pairwise_acc = pair_ok / pair_n if pair_n else None

    return {
        "hit": hit,
        "miss": miss,
        "got_hit": got_hit,
        "got_extra": got_extra,
        "hit_n": n_hit_exp,
        "miss_n": len(miss),
        "expect_n": n_exp,
        "got_n": n_got,
        "recall": round(recall, 4),
        "precision": round(precision, 4),
        "f1": round(f1, 4),
        "pairwise_ok": pair_ok,
        "pairwise_n": pair_n,
        "pairwise_acc": None if pairwise_acc is None else round(pairwise_acc, 4),
        "ok": len(miss) == 0 and n_exp > 0,
    }


def _chat_headers(api_base: str, token: str) -> Dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if "openrouter.ai" in api_base:
        headers["HTTP-Referer"] = "https://info-radar.local"
        headers["X-Title"] = "info-radar-keywords-eval"
    return headers


def chat_keywords(
    api_base: str,
    model: str,
    query: str,
    text: str,
    *,
    token: str,
    timeout: int,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """submit_keywords 虚拟提交工具 → scored 关键词列表。"""
    url = f"{api_base.rstrip('/')}/chat/completions"
    body = build_keywords_chat_body(query, text, model=model, max_tokens=max_tokens)
    if "openrouter.ai" not in api_base:
        body.pop("reasoning", None)
        body["thinking"] = {"type": "disabled"}
    prompt = build_keywords_user_content(query, text)

    resp = requests.post(url, headers=_chat_headers(api_base, token), json=body, timeout=timeout)
    data = resp.json()
    if resp.status_code >= 400:
        err = data.get("error") or data
        raise RuntimeError(f"HTTP {resp.status_code}: {err}")
    if data.get("error"):
        raise RuntimeError(str(data["error"]))
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}

    tool_calls = msg.get("tool_calls") or []
    if not tool_calls:
        raise RuntimeError(
            f"no tool_calls: content={msg.get('content')!r} finish={choice.get('finish_reason')!r}"
        )
    raw_args = (tool_calls[0].get("function") or {}).get("arguments") or ""
    scored = resolve_submit_keywords_arguments(raw_args, choice)
    if scored is None:
        raise RuntimeError(f"unparseable tool arguments: {raw_args!r}")

    keywords = [k for k, _s in scored]
    return {
        "prompt": prompt,
        "content": raw_args,
        "keywords": keywords,
        "scored": [{"keyword": k, "score": s} for k, s in scored],
        "finish_reason": choice.get("finish_reason"),
        "native_finish_reason": choice.get("native_finish_reason"),
        "usage": data.get("usage"),
        "raw_model": data.get("model") or model,
    }


def run_one(
    api_base: str,
    model: str,
    case: dict,
    *,
    token: str,
    timeout: int,
    max_retries: int,
) -> dict:
    name = case["name"]
    query = case["query"]
    text = case["text"]
    expect = list(case.get("expect_keywords") or [])

    def _base(**extra: Any) -> dict:
        return {
            "case": name,
            "chunk_index": case.get("chunk_index"),
            "query": query,
            "expect_keywords": expect,
            "model": model,
            "source": case.get("source"),
            **extra,
        }

    last_error: Optional[BaseException] = None
    for attempt in range(max_retries + 1):
        try:
            r = chat_keywords(
                api_base, model, query, text,
                token=token, timeout=timeout,
            )
            m = match_keywords(expect, r["keywords"])
            return _base(
                prompt=r["prompt"],
                content=r["content"],
                keywords=r["keywords"],
                scored=r.get("scored"),
                match=m,
                finish_reason=r.get("finish_reason"),
                usage=r.get("usage"),
            )
        except Exception as e:
            last_error = e
            if attempt < max_retries:
                wait = 3 * (attempt + 1)
                print(f"  重试 {attempt + 1}/{max_retries}，{wait}s… {e}", flush=True)
                time.sleep(wait)
    return _base(error=f"keywords: {last_error}")


def write_review_markdown(results: List[dict], path: Path) -> None:
    err_n = 0
    sum_r = sum_p = sum_f1 = 0.0
    scored_n = 0
    pair_ok_all = pair_n_all = 0
    lines = [
        "# 远程 keywords 对照表",
        "",
        f"打分：子串互含。{METRIC_LEGEND}。",
        "",
        f"| case | query | expect | got | {METRIC_R} | {METRIC_P} | {METRIC_F1} | {METRIC_PAIR} | miss | extra |",
        "|---|---|---|---|---:|---:|---:|---:|---|---|",
    ]
    for r in results:
        if r.get("error"):
            err_n += 1
            lines.append(
                f"| {r.get('case')} | {r.get('query')} | {r.get('expect_keywords')} "
                f"| — | — | — | — | — | — | error |"
            )
            continue
        # 用 expect/got 重算，便于旧 JSONL 用新指标 --review-only
        expect = list(r.get("expect_keywords") or [])
        got = list(r.get("keywords") or [])
        m = match_keywords(expect, got)
        r["match"] = m
        scored_n += 1
        sum_r += float(m["recall"])
        sum_p += float(m["precision"])
        sum_f1 += float(m["f1"])
        pair_ok_all += int(m["pairwise_ok"])
        pair_n_all += int(m["pairwise_n"])
        expect_s = ", ".join(expect)
        got_s = ", ".join(got)
        miss_s = ", ".join(m["miss"]) or "—"
        extra_s = ", ".join(m["got_extra"]) or "—"
        pair = m["pairwise_acc"]
        pair_s = "—" if pair is None else f"{pair:.0%}"
        lines.append(
            f"| {r.get('case')} | {r.get('query')} | {expect_s} | {got_s} | "
            f"{m['recall']:.0%} | {m['precision']:.0%} | "
            f"{m['f1']:.0%} | {pair_s} | {miss_s} | {extra_s} |"
        )
    if scored_n:
        macro_r = sum_r / scored_n
        macro_p = sum_p / scored_n
        macro_f1 = sum_f1 / scored_n
    else:
        macro_r = macro_p = macro_f1 = 0.0
    micro_pair = pair_ok_all / pair_n_all if pair_n_all else None
    pair_summary = "—" if micro_pair is None else f"{micro_pair:.1%}"
    lines[3:3] = [
        f"汇总（macro）：{METRIC_R}={macro_r:.1%} {METRIC_P}={macro_p:.1%} "
        f"{METRIC_F1}={macro_f1:.1%}；"
        f"{METRIC_PAIR}（micro）={pair_summary}（{pair_ok_all}/{pair_n_all}）；"
        f"n={scored_n} error={err_n}",
        "",
    ]
    lines += ["", "## 原始提示词 / 输出", ""]
    for r in results:
        lines.append(f"### {r.get('case')}")
        lines.append("")
        if r.get("error"):
            lines.append(f"error: `{r['error']}`")
            lines.append("")
            continue
        m = r.get("match") or {}
        pair = m.get("pairwise_acc")
        pair_s = "n/a" if pair is None else f"{pair:.0%} ({m.get('pairwise_ok')}/{m.get('pairwise_n')})"
        lines.append(
            f"{format_rpf1(float(m.get('recall') or 0), float(m.get('precision') or 0), float(m.get('f1') or 0), pct=False)} "
            f"{METRIC_PAIR}={pair_s} miss={m.get('miss')} extra={m.get('got_extra')}"
        )
        lines.append("")
        lines.append("**prompt**")
        lines.append("")
        lines.append("```")
        lines.append(r.get("prompt") or "")
        lines.append("```")
        lines.append("")
        lines.append("**content**（tool arguments）")
        lines.append("")
        lines.append("```")
        lines.append(r.get("content") or "")
        lines.append("```")
        lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"✅ 对照表已写入 {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="远程 Chat API 关键词匹配评测（submit_keywords）")
    parser.add_argument("-c", "--cases", type=Path, default=None, help="用例 JSON / 索引")
    parser.add_argument("-o", "--output", type=Path, default=None, help="结果 JSONL（可续跑）")
    parser.add_argument("--review-md", type=Path, default=None, help="对照表 Markdown")
    parser.add_argument("--review-only", action="store_true", help="仅从 JSONL 生成对照表")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"模型 id（默认 {DEFAULT_MODEL}）")
    parser.add_argument("--url", default=DEFAULT_API_BASE, help=f"API base（默认 {DEFAULT_API_BASE}）")
    parser.add_argument("--token", default=None, help="API token")
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--sleep", type=float, default=0.2, help="每条请求前额外等待秒（每 worker）")
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=8,
        help="并发数（用例彼此独立；默认 8）",
    )
    args = parser.parse_args()

    _load_env_file(Path(__file__).resolve().parents[1] / ".env")
    _load_env_file(Path(__file__).resolve().parents[1] / "cf" / "facade" / ".dev.vars")

    if args.review_only:
        if not args.output or not args.review_md:
            print("错误: --review-only 需要 -o 与 --review-md")
            sys.exit(1)
        write_review_markdown(_load_jsonl(args.output), args.review_md)
        return

    if not args.cases:
        print("错误: 需要 -c/--cases")
        sys.exit(1)
    cases, skipped = load_relevant_cases(args.cases)
    token = (
        args.token
        or os.environ.get(OPENROUTER_TOKEN_ENV)
        or os.environ.get(HF_TOKEN_ENV)
    )
    if not token:
        print(f"错误: 需要 --token / {OPENROUTER_TOKEN_ENV} / {HF_TOKEN_ENV}")
        sys.exit(1)

    jobs = max(1, int(args.jobs))
    print(
        f"已加载 {len(cases)} 条相关用例（跳过无关 {skipped}）；"
        f"model={args.model}；jobs={jobs}"
    )

    completed = set()
    all_results: list = []
    if args.output and args.output.exists():
        all_results = _load_jsonl(args.output)
        completed = {r["case"] for r in all_results if "case" in r}
        print(f"已加载 {len(all_results)} 条历史，跳过 {len(completed)} 个 case")

    pending: List[Tuple[int, dict]] = [
        (i, case) for i, case in enumerate(cases) if case["name"] not in completed
    ]
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
    write_lock = threading.Lock()
    done_n = len(cases) - len(pending)

    def _work(item: Tuple[int, dict]) -> Tuple[int, dict, dict]:
        i, case = item
        if args.sleep > 0:
            time.sleep(args.sleep)
        record = run_one(
            args.url, args.model, case,
            token=token, timeout=args.timeout, max_retries=args.retries,
        )
        return i, case, record

    def _commit(i: int, case: dict, record: dict) -> None:
        nonlocal done_n
        done_n += 1
        prog = f"[{done_n}/{len(cases)}]"
        all_results.append(record)
        if args.output:
            with write_lock:
                _append_record(args.output, record)
        if record.get("error"):
            print(f"{prog} ❌ {case['name']}: {record['error']}", flush=True)
            return
        m = record["match"]
        pair = m.get("pairwise_acc")
        pair_s = "n/a" if pair is None else f"{pair:.0%}({m['pairwise_ok']}/{m['pairwise_n']})"
        print(
            f"{prog} ✓ {case['name']} "
            f"{format_rpf1(m['recall'], m['precision'], m['f1'])} "
            f"{METRIC_PAIR}={pair_s} miss={m['miss']} extra={m['got_extra']}",
            flush=True,
        )
        if jobs == 1:
            print("  --- prompt ---", flush=True)
            print(record.get("prompt") or "", flush=True)
            print("  --- content ---", flush=True)
            print(record.get("content") or "", flush=True)

    if jobs == 1:
        for item in pending:
            _commit(*_work(item))
    else:
        with ThreadPoolExecutor(max_workers=jobs) as ex:
            futures = [ex.submit(_work, item) for item in pending]
            for fut in as_completed(futures):
                _commit(*fut.result())

    if args.output:
        print(f"\n✅ 结果已写入 {args.output}（共 {len(all_results)} 条）")
    if args.review_md and all_results:
        order = {c["name"]: i for i, c in enumerate(cases)}
        ordered = sorted(
            all_results,
            key=lambda r: order.get(r.get("case") or "", 10**9),
        )
        write_review_markdown(ordered, args.review_md)


if __name__ == "__main__":
    main()
