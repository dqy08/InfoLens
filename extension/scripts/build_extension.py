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
    "config.js", "config.dev.js", "config.prod.js", "config.secrets.js",
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
    # config.js 由源头变体生成：--release 固定 prod，否则用 dev-env.sh 生成的 config.js。
    prod = source / "config.prod.js"
    if prod.is_file():
        config = source / "config.js"
        if release or not config.is_file():
            config = prod
        copy(config, output / "config.js")
        print(f"build: config.js <- {config.name}")
    print(output)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("name", choices=extension_names())
    parser.add_argument(
        "--release", action="store_true",
        help="上架构建：固定用 config.prod.js，忽略 dev-env.sh 生成的 config.js",
    )
    args = parser.parse_args()
    build(args.name, args.release)
