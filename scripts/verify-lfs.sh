#!/usr/bin/env bash
# pre-push: outgoing commits must have local LFS blobs; then upload via git lfs pre-push.
set -euo pipefail

LFS_SPEC='version https://git-lfs.github.com/spec/v1'

command -v git-lfs >/dev/null || {
  echo "verify-lfs: 需要安装 Git LFS（https://git-lfs.com），并执行 git lfs install" >&2
  exit 1
}

stdin_data="$(cat)"
[[ -n "$stdin_data" ]] || exit 0

remote="$1"
url="$2"

missing=0
while read -r local_ref local_oid remote_ref remote_oid; do
  [[ -z "${local_oid:-}" || "$local_oid" =~ ^0+$ ]] && continue
  local range
  if [[ "${remote_oid:-}" =~ ^0+$ ]]; then
    range="$local_oid"
  else
    range="${remote_oid}..${local_oid}"
  fi
  while read -r blob path; do
    [[ -z "$path" ]] && continue
    local tmp
    tmp="$(mktemp)"
    if ! git cat-file blob "$blob" >"$tmp" 2>/dev/null; then
      echo "verify-lfs: 无法读取 $path" >&2
      missing=1
      rm -f "$tmp"
      continue
    fi
    if [[ "$(head -c "${#LFS_SPEC}" "$tmp" 2>/dev/null || true)" != "$LFS_SPEC" ]]; then
      rm -f "$tmp"
      continue
    fi
    local oid
    oid="$(grep '^oid sha256:' "$tmp" | awk '{print $2}')"
    rm -f "$tmp"
    if [[ -z "$oid" ]]; then
      echo "verify-lfs: $path 的 LFS 指针无效" >&2
      missing=1
      continue
    fi
    local obj=".git/lfs/objects/${oid:0:2}/${oid:2:2}/$oid"
    if [[ ! -f "$obj" ]]; then
      echo "verify-lfs: $path 缺少本地 LFS 对象（oid $oid）" >&2
      missing=1
    fi
  done < <(git rev-list --objects "$range")
done <<<"$stdin_data"

if [[ "$missing" -ne 0 ]]; then
  echo "verify-lfs: push 已中止" >&2
  exit 1
fi

printf '%s\n' "$stdin_data" | git lfs pre-push "$remote" "$url"
