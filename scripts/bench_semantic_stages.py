#!/usr/bin/env python3
"""
语义分析各阶段耗时基准测试（encoding → inference → backward → processing）

用法（从项目根目录运行）：
  python scripts/bench_semantic_stages.py
  python scripts/bench_semantic_stages.py --no-gradient-checkpointing
  FORCE_CPU=1 python scripts/bench_semantic_stages.py
"""

import argparse
import json
import sys
import time
from pathlib import Path

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
        return tokenizer.decode(ids[:target_tokens])
    return text


def run_benchmark(
    target_tokens: int = 500,
    repeats: int = 3,
    gradient_checkpointing: bool = True,
) -> dict:
    from argparse import Namespace

    from backend.platform.app_context import AppContext
    from backend.demo.data_utils import resolve_data_dir
    from backend.models.device import DeviceManager
    from backend.models.model_manager import ensure_instruct_slot_ready
    from backend.core.semantic_analyzer import analyze_semantic

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
    print(f"\n设备: {device_name} ({device})")
    print(f"目标: {target_tokens} tokens，重复 {repeats} 次，gradient_checkpointing={gradient_checkpointing}\n")

    tokenizer, _, _ = ensure_instruct_slot_ready()
    text = _make_text_for_tokens(tokenizer, target_tokens)
    actual_tokens = len(tokenizer.encode(text, add_special_tokens=False))
    print(f"实际原文 tokens: {actual_tokens}")

    stage_times = {
        "encoding": [],
        "inference": [],
        "backward": [],
        "processing": [],
    }

    for run in range(repeats):
        timestamps = {}

        def progress_callback(step: int, total_steps: int, stage: str, percentage):
            timestamps[stage] = time.perf_counter()

        t_start = time.perf_counter()
        analyze_semantic("人工智能", text, progress_callback=progress_callback)
        t_end = time.perf_counter()

        # 回调时机：encoding 开始前 → inference 开始前 → backward 开始前 → processing 开始前
        t1 = timestamps.get("encoding", t_start)
        t2 = timestamps.get("inference", t1)
        t3 = timestamps.get("backward", t2)
        t4 = timestamps.get("processing", t3)

        stage_times["encoding"].append(t2 - t1)
        stage_times["inference"].append(t3 - t2)
        stage_times["backward"].append(t4 - t3)
        stage_times["processing"].append(t_end - t4)

        total = t_end - t_start
        print(f"  第 {run + 1} 次: 总 {total:.3f}s | encoding {t2-t1:.3f}s | inference {t3-t2:.3f}s | backward {t4-t3:.3f}s | processing {t_end-t4:.3f}s")

    result = {
        "device": device_name,
        "target_tokens": target_tokens,
        "actual_tokens": actual_tokens,
        "repeats": repeats,
        "gradient_checkpointing": gradient_checkpointing,
        "stages": {
            name: {
                "times": [round(t, 4) for t in times],
                "avg": round(sum(times) / len(times), 4),
                "min": round(min(times), 4),
                "max": round(max(times), 4),
            }
            for name, times in stage_times.items()
        },
        "total_avg": round(
            sum(
                stage_times["encoding"][i] + stage_times["inference"][i]
                + stage_times["backward"][i] + stage_times["processing"][i]
                for i in range(repeats)
            )
            / repeats,
            4,
        ),
    }

    print("\n--- 汇总 ---")
    for name, data in result["stages"].items():
        print(f"  {name}: avg={data['avg']:.3f}s  min={data['min']:.3f}s  max={data['max']:.3f}s")
    print(f"  总耗时平均: {result['total_avg']:.3f}s")

    return result


def main():
    parser = argparse.ArgumentParser(description="语义分析各阶段耗时基准测试")
    parser.add_argument("--target_tokens", type=int, default=500, help="目标 token 数")
    parser.add_argument("--repeats", type=int, default=3, help="重复次数")
    parser.add_argument(
        "--no-gradient-checkpointing",
        dest="gradient_checkpointing",
        action="store_false",
        help="关闭 GC（默认开启，用于对比）",
    )
    parser.set_defaults(gradient_checkpointing=True)
    args = parser.parse_args()

    result = run_benchmark(
        target_tokens=args.target_tokens,
        repeats=args.repeats,
        gradient_checkpointing=args.gradient_checkpointing,
    )
    out = PROJECT_ROOT / "scripts" / "results" / "bench_semantic_stages.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ 结果已写入 {out}")


if __name__ == "__main__":
    main()
