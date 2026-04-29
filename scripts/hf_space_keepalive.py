#!/usr/bin/env python3
"""
HF Space 保活脚本

每隔一定时间向 Space 发起一次小分析请求，防止长时间无请求导致首次调用变慢。
适用于公开 Space，无需 HF Token。
"""

import argparse
import sys
import time

try:
    import requests
except ImportError:
    print("错误: 需要安装 requests 库")
    print("请运行: pip install requests")
    sys.exit(1)

API_ENDPOINT = "/api/analyze"
# 保活用极短文本，减少计算量
KEEPALIVE_TEXT = "just for keep hf space hot"


def main():
    parser = argparse.ArgumentParser(description="HF Space 保活 - 定期发起小分析请求防止冷启动")
    parser.add_argument(
        "url",
        nargs="?",
        default="https://dqy08-inforadar.hf.space",
        help="Space 地址（默认: dqy08-inforadar）",
    )
    parser.add_argument(
        "-i", "--interval",
        type=int,
        default=20,
        help="请求间隔（分钟），默认 20",
    )
    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="安静模式，仅输出错误",
    )
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    api_url = f"{base_url}{API_ENDPOINT}"
    interval_sec = args.interval * 60

    if not args.quiet:
        print(f"保活目标: {api_url}")
        print(f"间隔: {args.interval} 分钟")
        print("按 Ctrl+C 停止\n")

    while True:
        try:
            r = requests.post(
                api_url,
                json={"text": KEEPALIVE_TEXT, "model": "default"},
                headers={"Content-Type": "application/json"},
                timeout=120,
            )
            status = "✓" if r.ok else "✗"
            if not args.quiet:
                print(f"{time.strftime('%H:%M:%S')} {status} {r.status_code}")
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')} ✗ 请求失败: {e}")

        time.sleep(interval_sec)


if __name__ == "__main__":
    main()
