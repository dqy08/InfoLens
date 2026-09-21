#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$root" config core.hooksPath .githooks
echo "已启用仓库钩子：$root/.githooks（push 前会检查 LFS）"
