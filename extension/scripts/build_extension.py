#!/usr/bin/env python3
"""Assemble a loadable MV3 extension into extension/dist/<name>."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

EXTENSIONS = Path(__file__).resolve().parents[1]
SHARED = EXTENSIONS / "shared"
LOCALES = "_locales"  # 由 merge_locales 独占产出，不走通用拷贝
FLATTEN = "page/"  # 注入宿主页的脚本平铺到包根，迁就 background.js 里 CONTENT_JS 的路径
SKIP_DIRS = {LOCALES, "dist", "e2e", "node_modules", "test"}
SKIP_NAMES = {
    ".DS_Store", "package.json", "package-lock.json",
    "config.js", "config.secrets.js",
}
SKIP_SUFFIXES = {".md", ".mjs", ".py", ".sh"}  # 文档与开发脚本不进扩展


def copy(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)


def is_extension_source(rel: Path) -> bool:
    return (
        not any(part in SKIP_DIRS for part in rel.parts)
        and rel.name not in SKIP_NAMES
        and rel.suffix not in SKIP_SUFFIXES
    )


def shared_payload() -> dict[str, str]:
    """shared/ 下除 _locales 之外全是运行时载荷；返回 共享源 -> 包内路径。"""
    payload: dict[str, str] = {}
    for path in sorted(SHARED.rglob("*")):
        rel = path.relative_to(SHARED)
        if path.is_file() and is_extension_source(rel):
            payload[rel.as_posix()] = rel.as_posix().removeprefix(FLATTEN)
    return payload


def merge_locales(source: Path, output: Path) -> None:
    """shared/pdf 等共享代码的文案放在 shared/_locales，按 locale 合并进产物。
    插件自己的同名 key 优先，便于单个插件改写共享文案。
    """
    roots = (SHARED / LOCALES, source / LOCALES)
    names = {p.name for root in roots if root.is_dir() for p in root.iterdir() if p.is_dir()}
    for locale in sorted(names):
        messages: dict = {}
        for root in roots:
            path = root / locale / "messages.json"
            if path.is_file():
                messages |= json.loads(path.read_text(encoding="utf-8"))
        dest = output / LOCALES / locale / "messages.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(messages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"build: _locales <- {len(names)} locale(s)")


def extension_names() -> list[str]:
    return sorted(p.name for p in EXTENSIONS.iterdir() if (p / "manifest.json").is_file())


def copy_info_highlight_transformers(source: Path, output: Path) -> None:
    """Info Highlight 本机 WebGPU：transformers.web.js + 官方非压缩 ORT（勿打 *.min.js / *.min.mjs）。"""
    if source.name != "info-highlight":
        return
    tf_web = source / "node_modules" / "@huggingface" / "transformers" / "dist" / "transformers.web.js"
    ort_dist = source / "node_modules" / "onnxruntime-web" / "dist"
    dest = output / "vendor" / "transformers"
    dest.mkdir(parents=True, exist_ok=True)
    if not tf_web.is_file():
        raise SystemExit(
            "build: info-highlight 缺少 @huggingface/transformers，"
            "请先在 extension/info-highlight 执行 npm install"
        )
    text = tf_web.read_text(encoding="utf-8")
    old_common = 'from "onnxruntime-common"'
    old_web = 'from "onnxruntime-web"'
    if old_common not in text or old_web not in text:
        raise SystemExit("build: transformers.web.js 不再把 ORT 作为 external，无法换成非压缩包")
    (dest / "transformers.js").write_text(
        text.replace(old_common, 'from "./ort.webgpu.mjs"').replace(old_web, 'from "./ort.webgpu.mjs"'),
        encoding="utf-8",
    )
    missing = []
    for name in (
        "ort.webgpu.mjs",
        "ort-wasm-simd-threaded.jsep.wasm",
        "ort-wasm-simd-threaded.jsep.mjs",
    ):
        src = ort_dist / name
        if not src.is_file():
            missing.append(name)
            continue
        copy(src, dest / name)
    if missing:
        raise SystemExit(
            "build: info-highlight 缺少 onnxruntime-web 非压缩产物"
            f"（缺 {', '.join(missing)}）"
        )
    print("build: vendor/transformers <- transformers.web.js + onnxruntime-web/ort.webgpu.mjs")


EMPTY_CONFIG = {
    "info-highlight": "var IH_CONFIG = {};\n",
    "semantic-highlight": "var IL_CONFIG = {};\n",
}


def write_config(name: str, source: Path, output: Path, release: bool) -> None:
    body = EMPTY_CONFIG.get(name)
    if body is None:
        return
    dest = output / "config.js"
    local = source / "config.js"
    if release or not local.is_file():
        dest.write_text(body, encoding="utf-8")
        print("build: config.js <- empty")
        return
    copy(local, dest)
    print("build: config.js <- config.js")


def build(name: str, release: bool) -> Path:
    source = EXTENSIONS / name
    output = EXTENSIONS / "dist" / name
    shutil.rmtree(output, ignore_errors=True)
    shared = shared_payload()
    packaged = set(shared.values())
    for path in source.rglob("*"):
        rel = path.relative_to(source)
        if not (path.is_file() and is_extension_source(rel)):
            continue
        if rel.as_posix() in packaged:
            raise SystemExit(f"build: {name}/{rel} 与 shared/ 同名，无法判断该用哪份；改名或删掉一份")
        copy(path, output / rel)
    for shared_rel, packaged_rel in shared.items():
        copy(SHARED / shared_rel, output / packaged_rel)
    merge_locales(source, output)
    copy_info_highlight_transformers(source, output)
    # 上架写空配置，不带本地 config.js。本地构建有这份才拷进去，没有也写空的。
    write_config(name, source, output, release)
    print(output)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("name", choices=extension_names())
    parser.add_argument(
        "--release", action="store_true",
        help="上架构建：写入空 config.js，不带本地调试配置",
    )
    args = parser.parse_args()
    build(args.name, args.release)
