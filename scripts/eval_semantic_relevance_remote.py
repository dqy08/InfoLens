#!/usr/bin/env python3
"""
远程 Chat API 相关性门控评测（默认 OpenRouter；与门面 Worker 同提示词基线）。

提示词字段为 Query: / Text: 冒号行（与 keywords 远程实验同风格）。

主题：只评 expect_relevant（云端）；不管 expect_keywords / 本地 instruct relevance。
（磁盘上 query 为数组且真值在项内；加载后展平为 query:str。）
关键词归因请用 scripts/eval_semantic_keywords.py。

提示词相对基线只保留一个变量：是否追加
  "If the text is not clearly related to the query topic, reply 0."

用法（项目根目录）:
  python scripts/eval_semantic_relevance_remote.py \\
    -c scripts/cases/红楼-第3回.json \\
    -o scripts/results/红楼-第3回_hy3_rel.jsonl

  # 并发（用例彼此独立；默认 jobs=1）
  python scripts/eval_semantic_relevance_remote.py \\
    -c scripts/cases/论文.json \\
    -o scripts/results/论文_rel.jsonl \\
    -j 8

  # 开启 clearly→0
  python scripts/eval_semantic_relevance_remote.py \\
    -c scripts/cases/红楼-第3回.json \\
    -o scripts/results/红楼-第3回_hy3_clearly_rel.jsonl \\
    --clearly-zero
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
from semantic_case_load import load_all_cases

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)

HF_TOKEN_ENV = "HF_TOKEN"
OPENROUTER_TOKEN_ENV = "OPENROUTER_API_KEY"  # SYNC: Worker secret / .dev.vars 同名
DEFAULT_API_BASE = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "tencent/hy3"
DEFAULT_MAX_TOKENS = 8  # SYNC: cf/facade/src/relevance_remote.js RELEVANCE_MAX_TOKENS
SEMANTIC_MATCH_THRESHOLD = 0.1  # SYNC: count>0 映射为 degree=1.0，否则 0.0

CLEARLY_ZERO_SENTENCE = (
    "If the text is not clearly related to the query topic, reply 0."
)
# clearly_zero 对两模型的总体影响（cases/subsets/红楼.smoke20、相对基线）：
# - DeepSeek-V4-Flash：拒识明显变好、召回下降（假阳↓、漏检↑），acc 净升
# - Hy3：两边都略伤，acc 净降；基线已较好时不必开


def build_relevance_user_content(query: str, text: str, *, clearly_zero: bool) -> str:
    """相关性 user 正文。clearly_zero 为唯一提示词变量。
    版式：Task/Query 各一行；Text: 后空一行接正文，正文后再空一行；
    文尾 Task Reminder:+Query: 再各一行。"""
    task = "How many words in the text are related to the query topic?"
    if clearly_zero:
        task += " " + CLEARLY_ZERO_SENTENCE
    task += " Reply with a single non-negative integer only, nothing else."
    query_line = f"Query: {query}"
    head = f"Task: {task}\n{query_line}"
    reminder = f"Task Reminder: {task}\n{query_line}"
    return f"{head}\nText:\n\n{text}\n\n{reminder}"


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


def load_cases(path: Path) -> List[dict]:
    return load_all_cases(path)


def parse_count(content: Optional[str]) -> Optional[int]:
    """从开头：可选空白 + 非负整数字前缀；不扫后面。失败返回 None。SYNC: facade parseCount"""
    if not content or not isinstance(content, str):
        return None
    m = re.match(r"\s*(\d+)", content)
    return int(m.group(1)) if m else None


def chat_relevance(
    api_base: str,
    model: str,
    query: str,
    text: str,
    *,
    clearly_zero: bool,
    token: str,
    timeout: int,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    url = f"{api_base.rstrip('/')}/chat/completions"
    body: Dict[str, Any] = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": build_relevance_user_content(query, text, clearly_zero=clearly_zero),
            }
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
    }
    # OpenRouter 统一用 reasoning.effort；HF/DeepSeek 原生用 thinking.disabled
    if "openrouter.ai" in api_base:
        body["reasoning"] = {"effort": "none"}
    else:
        body["thinking"] = {"type": "disabled"}
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if "openrouter.ai" in api_base:
        headers["HTTP-Referer"] = "https://info-radar.local"
        headers["X-Title"] = "info-radar-relevance-eval"
    resp = requests.post(url, headers=headers, json=body, timeout=timeout)
    data = resp.json()
    if resp.status_code >= 400:
        err = data.get("error") or data
        raise RuntimeError(f"HTTP {resp.status_code}: {err}")
    if data.get("error"):
        raise RuntimeError(str(data["error"]))
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = msg.get("content")
    count = parse_count(content)
    if count is None:
        raise RuntimeError(f"unparseable model output: content={content!r}")
    # 远程无 logprobs 时：count>0 → 1.0，否则 0.0（与门控 count>0 一致）
    degree = 1.0 if count > 0 else 0.0
    return {
        "content": content,
        "count": count,
        "full_match_degree": degree,
        "finish_reason": choice.get("finish_reason"),
        "usage": data.get("usage"),
        "raw_model": data.get("model") or model,
    }


def run_one(
    api_base: str,
    model: str,
    case: dict,
    *,
    clearly_zero: bool,
    token: str,
    timeout: int,
    max_retries: int,
) -> dict:
    name = case["name"]
    query = case["query"]
    text = case["text"]
    expect_relevant = bool(case.get("expect_relevant"))
    disputed = bool(case.get("disputed"))
    dispute_note = case.get("dispute_note") or ""

    def _base(**extra: Any) -> dict:
        rec: Dict[str, Any] = {
            "case": name,
            "chunk_index": case.get("chunk_index"),
            "query": query,
            "expect_relevant": expect_relevant,
            "model": model,
            "source": case.get("source"),
            "clearly_zero": clearly_zero,
            **extra,
        }
        if disputed:
            rec["disputed"] = True
            if dispute_note:
                rec["dispute_note"] = dispute_note
        return rec

    last_error: Optional[BaseException] = None
    for attempt in range(max_retries + 1):
        try:
            r = chat_relevance(
                api_base, model, query, text,
                clearly_zero=clearly_zero, token=token, timeout=timeout,
            )
            degree = r["full_match_degree"]
            return _base(
                full_match_degree=degree,
                gate_passed=degree >= SEMANTIC_MATCH_THRESHOLD,
                count=r["count"],
                content=r["content"],
                finish_reason=r.get("finish_reason"),
                usage=r.get("usage"),
            )
        except Exception as e:
            last_error = e
            if attempt < max_retries:
                wait = 3 * (attempt + 1)
                print(f"  重试 {attempt + 1}/{max_retries}，{wait}s… {e}", flush=True)
                time.sleep(wait)
    return _base(error=f"relevance: {last_error}")


def write_review_markdown(results: List[dict], path: Path, clearly_zero: bool) -> None:
    tn = tp = fp = fn = 0
    lines = [
        "# 远程 relevance 对照表",
        "",
        f"提示词变量 `clearly_zero` = **{clearly_zero}**",
        f"门控：解析 count 后 `full_match_degree = 1.0 if count > 0 else 0.0`，阈值 `{SEMANTIC_MATCH_THRESHOLD}`。",
        "",
        "| case | expect | disputed | gate | count | degree | verdict |",
        "|---|---|---|---|---:|---:|---|",
    ]
    for r in results:
        if r.get("error"):
            lines.append(
                f"| {r.get('case')} | {r.get('expect_relevant')} |  | — | — | — | error |"
            )
            continue
        expect = bool(r.get("expect_relevant"))
        passed = bool(r.get("gate_passed"))
        if expect and passed:
            tp += 1
            verdict = "OK"
        elif expect and not passed:
            fn += 1
            verdict = "**门控漏检**"
        elif (not expect) and not passed:
            tn += 1
            verdict = "**拒识OK**"
        else:
            fp += 1
            verdict = "**误放行**"
        note = "yes" if r.get("disputed") else ""
        lines.append(
            f"| {r.get('case')} | {expect} | {note} | "
            f"{'PASS' if passed else 'fail'} | {r.get('count', '—')} | "
            f"{r.get('full_match_degree', '—')} | {verdict} |"
        )
    total = tn + tp + fp + fn
    acc = (tn + tp) / total if total else 0.0
    lines[4:4] = [
        f"汇总：TN（拒识对）={tn} TP（正检）={tp} "
        f"FP（误检）={fp} FN（漏检）={fn} acc={acc:.1%}（n={total}）",
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"✅ 对照表已写入 {path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="远程 Chat API 相关性评测（唯一提示词变量：--clearly-zero）"
    )
    parser.add_argument("-c", "--cases", type=Path, required=True, help="用例 JSON 数组")
    parser.add_argument("-o", "--output", type=Path, default=None, help="结果 JSONL（可续跑）")
    parser.add_argument("--review-md", type=Path, default=None, help="对照表 Markdown")
    parser.add_argument("--review-only", action="store_true", help="仅从 JSONL 生成对照表")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"模型 id（默认 {DEFAULT_MODEL}；OpenRouter / HF / 官方写法可能不同）",
    )
    parser.add_argument(
        "--clearly-zero",
        action="store_true",
        help=f'提示词追加: "{CLEARLY_ZERO_SENTENCE}"',
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_API_BASE,
        help=f"OpenAI 兼容 API base（默认 {DEFAULT_API_BASE}）",
    )
    parser.add_argument("--hf-token", default=None, help="API token（兼容旧参数名）")
    parser.add_argument("--token", default=None, help="API token（优先于环境变量）")
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--sleep", type=float, default=0.2, help="每条请求前额外等待秒（每 worker）")
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=1,
        help="并发数（用例彼此独立；默认 1；可试 4/8）",
    )
    args = parser.parse_args()

    _load_env_file(Path(__file__).resolve().parents[1] / ".env")

    if args.review_only:
        if not args.output or not args.review_md:
            print("错误: --review-only 需要 -o 与 --review-md")
            sys.exit(1)
        results = _load_jsonl(args.output)
        cz = bool(results[0].get("clearly_zero")) if results else args.clearly_zero
        write_review_markdown(results, args.review_md, cz)
        return

    cases = load_cases(args.cases)
    token = (
        args.token
        or args.hf_token
        or os.environ.get(OPENROUTER_TOKEN_ENV)
        or os.environ.get(HF_TOKEN_ENV)
    )
    if not token:
        print(f"错误: 需要 --token / {OPENROUTER_TOKEN_ENV} / {HF_TOKEN_ENV}")
        sys.exit(1)

    jobs = max(1, int(args.jobs))
    print(
        f"已加载 {len(cases)} 条用例；model={args.model}；"
        f"clearly_zero={args.clearly_zero}；jobs={jobs}"
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
    skipped = len(cases) - len(pending)
    if skipped:
        print(f"⏭ 跳过已完成 {skipped} 条", flush=True)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
    write_lock = threading.Lock()
    stop = threading.Event()
    done_n = skipped

    def _work(item: Tuple[int, dict]) -> Tuple[int, dict, dict]:
        i, case = item
        if stop.is_set():
            return i, case, {"case": case["name"], "error": "skipped after failure"}
        if args.sleep > 0:
            time.sleep(args.sleep)
        record = run_one(
            args.url,
            args.model,
            case,
            clearly_zero=args.clearly_zero,
            token=token,
            timeout=args.timeout,
            max_retries=args.retries,
        )
        return i, case, record

    def _commit(i: int, case: dict, record: dict) -> bool:
        """写入并打印；返回是否应继续（False=失败中断）。"""
        nonlocal done_n
        name = case["name"]
        done_n += 1
        prog = f"[{done_n}/{len(cases)}]"
        all_results.append(record)
        if args.output:
            with write_lock:
                _append_record(args.output, record)
        if record.get("error"):
            print(f"{prog} ✗ {name}: {record['error']}", flush=True)
            return False
        gate = "PASS" if record["gate_passed"] else "fail"
        print(
            f"{prog} ✓ {name} gate={gate} count={record['count']} "
            f"degree={record['full_match_degree']}",
            flush=True,
        )
        completed.add(name)
        return True

    if jobs == 1:
        for item in pending:
            if stop.is_set():
                break
            i, case, record = _work(item)
            if not _commit(i, case, record):
                print("⚠ 失败中断后续", flush=True)
                stop.set()
                break
    else:
        with ThreadPoolExecutor(max_workers=jobs) as ex:
            futures = {ex.submit(_work, item): item for item in pending}
            for fut in as_completed(futures):
                i, case, record = fut.result()
                if record.get("error") == "skipped after failure":
                    continue
                if not _commit(i, case, record):
                    print("⚠ 失败中断后续（已提交的 in-flight 仍会跑完）", flush=True)
                    stop.set()
                    for f in futures:
                        f.cancel()
                    break

    if args.output:
        print(f"\n✅ 结果已写入 {args.output}（共 {len(all_results)} 条）")
    if args.review_md and all_results:
        order = {c["name"]: i for i, c in enumerate(cases)}
        ordered = sorted(
            all_results,
            key=lambda r: order.get(r.get("case") or "", 10**9),
        )
        write_review_markdown(ordered, args.review_md, args.clearly_zero)


if __name__ == "__main__":
    main()
