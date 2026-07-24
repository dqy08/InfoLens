#!/bin/bash
# 打商店 zip：临时目录里用正式图标 + config.prod.js，不改动本目录（unpacked 仍是 icons/dev）。
# 用法：./pack.sh
# 产出：extension/dist/info-lens-semantic-highlight-v<version>.zip
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

version="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
name="info-lens-semantic-highlight-v${version}"
mkdir -p dist
out="$(pwd)/dist/${name}.zip"

stage="$(mktemp -d "${TMPDIR:-/tmp}/il-ext-pack.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

# 运行时文件（不含 README、脚本、config 源头、dev 图标）
cp articleRoot.js background.js content.js content.css \
  mergeTokenSpans.js splitTextToChunks.js \
  "$stage/"
cp -R ui vendor "$stage/"
mkdir -p "$stage/icons"
cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png "$stage/icons/"
cp config.prod.js "$stage/config.js"
# 商店图标路径（去掉 icons/dev/）
sed 's|icons/dev/|icons/|g' manifest.json > "$stage/manifest.json"

rm -f "$out"
( cd "$stage" && zip -qr "$out" . )
echo "已打包（商店图标）：$out"
echo "工作树未改动；unpacked 仍用 icons/dev/。"
