#!/usr/bin/env python3
"""
CPU vs MPS 模式下语义分析耗时基准测试

测试 20/200/2000 token 单次语义分析时间，每种情况测 3 次。

用法（从项目根目录运行）：
  # CPU 模式
  FORCE_CPU=1 python scripts/bench_semantic_device.py

  # MPS 模式（Apple Silicon，不设 FORCE_CPU）
  python scripts/bench_semantic_device.py

  # 同时跑两种模式并汇总
  python scripts/bench_semantic_device.py --all
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# 确保项目根在 path 中
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

def _make_text_for_tokens(tokenizer, target_tokens: int) -> str:
    """生成约 target_tokens 个 token 的文本"""
    base = "人工智能正在改变我们的生活。机器学习、深度学习等技术在医疗、金融等领域广泛应用。大模型在自然语言处理、图像识别等方面表现突出。"
    text = base
    while True:
        ids = tokenizer.encode(text, add_special_tokens=False)
        if len(ids) >= target_tokens:
            break
        text += base
    ids = tokenizer.encode(text, add_special_tokens=False)
    if len(ids) > target_tokens:
        truncated = tokenizer.decode(ids[:target_tokens])
        return truncated
    return text


def run_benchmark(repeats: int = 3, gradient_checkpointing: bool = True) -> dict:
    from backend.platform.app_context import AppContext
    from backend.demo.data_utils import resolve_data_dir
    from backend.models.device import DeviceManager
    from backend.models.model_manager import ensure_instruct_slot_ready
    from backend.core.semantic_analyzer import analyze_semantic
    from argparse import Namespace

    data_dir = resolve_data_dir(None)
    init_args = Namespace(
        base_model="qwen3-0.6b",
        instruct_model="qwen3-0.6b-instruct",
        logits_gradient_submode="topk_sum",
        logits_gradient_prob_weighted=False,
        gradient_checkpointing=gradient_checkpointing,
        address="0.0.0.0",
        port="5001",
        dir=None,
        no_cors=False,
        no_auto_load=False,
    )
    AppContext.init(init_args, data_dir)

    device = DeviceManager.get_device()
    device_name = DeviceManager.get_device_name(device)
    print(f"\n{'='*60}")
    print(f"设备: {device_name} ({device})")
    print("=" * 60)

    tokenizer, _, _ = ensure_instruct_slot_ready()
    target_counts = [500]
    results = {}

    for n_tokens in target_counts:
        text = _make_text_for_tokens(tokenizer, n_tokens)
        actual_tokens = len(tokenizer.encode(text, add_special_tokens=False))
        print(f"\n--- {n_tokens} tokens (实际: {actual_tokens}) ---")

        times = []
        for i in range(repeats):
            t0 = time.perf_counter()
            analyze_semantic("人工智能", text)
            elapsed = time.perf_counter() - t0
            times.append(elapsed)
            print(f"  第 {i+1} 次: {elapsed:.3f}s")

        avg = sum(times) / len(times)
        results[str(n_tokens)] = {
            "actual_tokens": actual_tokens,
            "times": [round(t, 4) for t in times],
            "avg": round(avg, 4),
            "min": round(min(times), 4),
            "max": round(max(times), 4),
        }
        print(f"  平均: {avg:.3f}s  最小: {min(times):.3f}s  最大: {max(times):.3f}s")

    return {
        "device": device_name,
        "device_type": device.type,
        "gradient_checkpointing": gradient_checkpointing,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="CPU/MPS 语义分析耗时基准测试")
    parser.add_argument(
        "--repeats",
        type=int,
        default=3,
        help="每种 token 数重复次数",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="依次运行 CPU 和 MPS 模式并汇总",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="结果输出 JSON 路径",
    )
    parser.add_argument(
        "--no-gradient-checkpointing",
        dest="gradient_checkpointing",
        action="store_false",
        help="关闭 GC（默认开启）",
    )
    parser.set_defaults(gradient_checkpointing=True)
    args = parser.parse_args()

    if args.all:
        import tempfile
        all_results = []
        for label, env in [("CPU", {"FORCE_CPU": "1"}), ("MPS", {})]:
            env_copy = os.environ.copy()
            env_copy.update(env)
            if label == "MPS":
                env_copy.pop("FORCE_CPU", None)
            print(f"\n\n{'#'*60}")
            print(f"# 运行 {label} 模式")
            print("#" * 60)
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
                out_path = f.name
            cmd = [sys.executable, __file__, "--repeats", str(args.repeats), "-o", out_path]
            if not args.gradient_checkpointing:
                cmd.append("--no-gradient-checkpointing")
            proc = subprocess.run(cmd, env=env_copy, cwd=PROJECT_ROOT)
            if proc.returncode != 0:
                print(f"❌ {label} 模式运行失败")
                sys.exit(1)
            data = json.loads(Path(out_path).read_text(encoding="utf-8"))
            os.unlink(out_path)
            all_results.append(data)

        print("\n\n" + "=" * 60)
        print("汇总")
        print("=" * 60)
        for r in all_results:
            print(f"\n{r['device']} ({r['device_type']}):")
            for k, v in r["results"].items():
                print(f"  {k} tokens: avg={v['avg']}s  min={v['min']}s  max={v['max']}s  times={v['times']}")
        if args.output:
            args.output.write_text(
                json.dumps({"modes": all_results}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"\n✅ 汇总已写入 {args.output}")
        return

    result = run_benchmark(repeats=args.repeats, gradient_checkpointing=args.gradient_checkpointing)

    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n✅ 结果已写入 {args.output}")

    return result


if __name__ == "__main__":
    main()
