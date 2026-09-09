#!/bin/bash
# 级别 1 + 2（不跑打真实接口的级别 3）。供本机与 pack.sh 共用。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "run-tests: 需要 node" >&2
  exit 1
fi

npm test
(cd ../../cf/facade && npm test)

if [[ ! -f ../dist/semantic-highlight/manifest.json ]]; then
  echo "run-tests: 先执行 python3 ../scripts/build_extension.py semantic-highlight（e2e 加载构建产物）" >&2
  exit 1
fi
if [[ ! -d node_modules/@playwright/test ]]; then
  echo "run-tests: 先在 extension/semantic-highlight/ 执行 npm ci && npx playwright install chromium" >&2
  exit 1
fi
IL_E2E_HEADLESS=1 npm run test:e2e
