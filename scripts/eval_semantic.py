#!/usr/bin/env python3
"""
Semantic analyzer 效果评估脚本

通过 HTTP 调用 /api/analyze-semantic 接口进行评估。

支持 submode：count / match_score(已废弃) / fill_blank

评估维度：
1. 生成的 top10 (token和概率) 的合理性
2. token_attention score 的合理性
3. 完全无关查询时的结果合理性

用法（从项目根目录运行）：
  python scripts/eval_semantic.py -c scripts/cases/eval_cases_short.json -o eval_result.jsonl
  python scripts/eval_semantic.py --submode count fill_blank -o eval_result.jsonl
  python scripts/eval_semantic.py --url http://localhost:5001

输出为 JSONL 格式，每完成一例追加一行；中断后可再次运行，从中断处续跑。
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional, Tuple

# Hugging Face Token（用于Private Space，可通过环境变量HF_TOKEN设置）
HF_TOKEN_ENV = "HF_TOKEN"

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)


# 测试用例：(名称, query, text)
# 相关：query 与 text 主题一致
# 无关：query 与 text 完全无关
TEST_CASES = [
    ("相关_AI", "人工智能", "人工智能正在改变我们的生活。机器学习、深度学习等技术在医疗、金融等领域广泛应用。"),
    ("相关_天气", "天气", "今天北京天气晴朗，气温适宜，适合户外活动。明天可能有小雨。"),
    ("无关_足球对AI", "足球比赛", "人工智能正在改变我们的生活。机器学习、深度学习等技术在医疗、金融等领域广泛应用。"),
    ("无关_烹饪对天气", "红烧肉做法", "今天北京天气晴朗，气温适宜，适合户外活动。明天可能有小雨。"),
]

DEFAULT_API_BASE = "http://localhost:5001"


def analyze_semantic_http(api_base: str, query: str, text: str, submode: Optional[str] = None, token: Optional[str] = None, timeout: int = 300) -> dict:
    """通过 HTTP 调用 analyze-semantic 接口"""
    url = f"{api_base.rstrip('/')}/api/analyze-semantic"
    payload: dict = {"query": query, "text": text, "debug_info": True}
    if submode is not None:
        payload["submode"] = submode
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


def run_eval(
    api_base: str,
    submode: str,
    test_cases: list,
    token: Optional[str] = None,
    output_path: Optional[Path] = None,
    all_results: Optional[list] = None,
    completed: Optional[set] = None,
    max_retries: int = 3,
    timeout: int = 300,
) -> Tuple[list, bool]:
    """返回 (results, aborted)，重试后仍失败时 aborted 为 True"""
    completed = completed or set()
    results = []
    for j, (name, query, text) in enumerate(test_cases):
        prog = f"[{j+1}/{len(test_cases)}]"
        if (submode, name) in completed:
            print(f"{prog} ⏭ 跳过: {submode} | {name}", flush=True)
            continue
        print(f"{prog} 执行: {submode} | {name}", flush=True)
        res = None
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                res = analyze_semantic_http(api_base, query, text, submode, token=token, timeout=timeout)
                break
            except Exception as e:
                last_error = e
                if attempt < max_retries:
                    wait = 3 * (attempt + 1)
                    print(f"{prog}   重试 {attempt + 1}/{max_retries}，{wait}s 后... - {e}", flush=True)
                    time.sleep(wait)
        if res is None:
            print(f"{prog} ✗ 失败（已重试 {max_retries} 次）: {submode} | {name} - {last_error}", flush=True)
            record = {"submode": submode, "case": name, "query": query, "error": str(last_error)}
            results.append(record)
            if all_results is not None:
                all_results.append(record)
            completed.add((submode, name))
            print(f"\n⚠ 重试后仍失败，中断后续用例", flush=True)
            return results, True

        di = res.get("debug_info", {})
        topk_tokens = di.get("topk_tokens", [])
        topk_probs = di.get("topk_probs", [])
        token_attention = res.get("token_attention", [])

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
            "submode": submode,
            "case": name,
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
        completed.add((submode, name))
        if output_path:
            _append_record(output_path, record)
        print(f"{prog} ✓ 完成: {submode} | {name}", flush=True)

    return results, False


def main():
    parser = argparse.ArgumentParser(description="评估 semantic analyzer 效果（HTTP）")
    parser.add_argument(
        "--submode",
        choices=["count", "match_score", "fill_blank"],
        nargs="+",
        default=None,
        help="instruct 模型子模式（可多个），不指定则依次评估 count/fill_blank；match_score 已废弃",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="结果输出 JSONL 路径（支持断点续跑）",
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
        help="自定义测试用例 JSON 文件，可指定多个，格式 [{name, query, text}, ...]",
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

    api_base = args.url.rstrip("/")
    hf_token = args.hf_token or os.environ.get(HF_TOKEN_ENV)

    if args.cases:
        test_cases = []
        for path in args.cases:
            raw = json.loads(path.read_text(encoding="utf-8"))
            # strip() 与浏览器语义分析时的 trim() 保持一致，避免 token 数差异
            test_cases.extend([(c["name"], c["query"], (c["text"] or "").strip()) for c in raw])
        print(f"已加载 {len(test_cases)} 个用例，来自 {len(args.cases)} 个文件")
    else:
        test_cases = TEST_CASES

    submodes = args.submode if args.submode else ["count", "match_score", "fill_blank"]
    all_results: list = []
    completed: set = set()
    if args.output and args.output.exists():
        all_results = _load_jsonl(args.output)
        completed = {(r["submode"], r["case"]) for r in all_results}
        print(f"已加载 {len(all_results)} 条历史结果，从中断处续跑")
    for sm in submodes:
        _, aborted = run_eval(
            api_base, sm, test_cases, token=hf_token,
            output_path=args.output, all_results=all_results,
            completed=completed, max_retries=args.retries, timeout=args.timeout,
        )
        if aborted:
            break
    if args.output:
        print(f"\n✅ 结果已写入 {args.output}（共 {len(all_results)} 条）")


if __name__ == "__main__":
    main()
