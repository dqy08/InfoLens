#!/usr/bin/env python3
"""
远程 Chat API 相关性门控评测（默认 OpenRouter；与门面 Worker 同提示词基线）。

主题：只评 expect_relevant（云端）；不管 expect_keywords / 本地 instruct relevance。
关键词归因请用 scripts/eval_semantic_keywords.py。

提示词相对基线只保留一个变量：是否追加
  "If the text is not clearly related to the query topic, reply 0."

用法（项目根目录）:
  python scripts/eval_semantic_relevance_remote.py \\
    -c scripts/cases/林黛玉哭-1_plugin.json \\
    -o scripts/results/林黛玉哭-1_hy3_rel.jsonl

  # 开启 clearly→0
  python scripts/eval_semantic_relevance_remote.py \\
    -c scripts/cases/林黛玉哭-1_plugin.json \\
    -o scripts/results/林黛玉哭-1_hy3_clearly_rel.jsonl \\
    --clearly-zero
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

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
# clearly_zero 对两模型的总体影响（林黛玉哭 20 条子集、相对基线）：
# - DeepSeek-V4-Flash：拒识明显变好、召回下降（假阳↓、漏检↑），acc 净升
# - Hy3：两边都略伤，acc 净降；基线已较好时不必开


def build_relevance_user_content(query: str, text: str, *, clearly_zero: bool) -> str:
    """相关性 user 正文。clearly_zero 为唯一提示词变量。"""
    parts = [
        f"How many words in the text below are related to the query topic ({query})? Text:\n\n",
        text,
        "\n\n",
    ]
    if clearly_zero:
        parts.append(CLEARLY_ZERO_SENTENCE + " ")
    parts.append("Reply with a single non-negative integer only, nothing else.")
    return "".join(parts)


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
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"用例文件须为 JSON 数组: {path}")
    cases = []
    for c in raw:
        if "name" not in c or "query" not in c or "text" not in c:
            raise ValueError(f"用例缺少 name/query/text: {c.get('name')}")
        if c.get("expect_relevant") is None:
            raise ValueError(f"用例 {c['name']} 的 expect_relevant 未填写（勿提交 skeleton）")
        cases.append(c)
    return cases


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
        f"汇总：TN={tn} TP={tp} FP={fp} FN={fn} acc={acc:.1%}（n={total}）",
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
    parser.add_argument("--sleep", type=float, default=0.2, help="请求间隔秒")
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

    print(f"已加载 {len(cases)} 个 chunk；model={args.model}；clearly_zero={args.clearly_zero}")

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
        record = run_one(
            args.url, args.model, case,
            clearly_zero=args.clearly_zero,
            token=token,
            timeout=args.timeout,
            max_retries=args.retries,
        )
        if record.get("error"):
            print(f"{prog} ✗ {name}: {record['error']}", flush=True)
            all_results.append(record)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                _append_record(args.output, record)
            print("⚠ 失败中断后续", flush=True)
            break
        gate = "PASS" if record["gate_passed"] else "fail"
        print(
            f"{prog} ✓ {name} gate={gate} count={record['count']} degree={record['full_match_degree']}",
            flush=True,
        )
        all_results.append(record)
        completed.add(name)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            _append_record(args.output, record)
        if args.sleep > 0:
            time.sleep(args.sleep)

    if args.output:
        print(f"\n✅ 结果已写入 {args.output}（共 {len(all_results)} 条）")
    if args.review_md and all_results:
        write_review_markdown(all_results, args.review_md, args.clearly_zero)


if __name__ == "__main__":
    main()
