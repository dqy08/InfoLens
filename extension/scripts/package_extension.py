#!/usr/bin/env python3
"""为单个 MV3 扩展创建可审计的 ZIP。"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


# 构建产物即最终包内容（取舍由 build_extension.py 负责），这里整棵树照收。
def source_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file())


def check_manifest(root: Path) -> None:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("pack: manifest_version must be 3")
    worker = manifest.get("background", {}).get("service_worker")
    if not isinstance(worker, str) or not (root / worker).is_file():
        raise SystemExit("pack: background service worker missing")
    for section in ("icons",):
        for rel in manifest.get(section, {}).values():
            if not (root / rel).is_file():
                raise SystemExit(f"pack: manifest resource missing: {rel}")
    for rel in manifest.get("action", {}).get("default_icon", {}).values():
        if not (root / rel).is_file():
            raise SystemExit(f"pack: action icon missing: {rel}")
    options = manifest.get("options_ui", {}).get("page")
    if options and not (root / options).is_file():
        raise SystemExit(f"pack: options page missing: {options}")
    # 声明了 default_locale 却没有对应 _locales 时 Chrome 直接拒装
    locale = manifest.get("default_locale")
    if locale and not (root / "_locales" / locale / "messages.json").is_file():
        raise SystemExit(f"pack: default_locale is {locale} but _locales/{locale}/messages.json is missing")


OPENERS = {
    "chrome.runtime.getURL": re.compile(r"chrome\.runtime\.getURL\("),
    "importScripts": re.compile(r"importScripts\("),
}
LITERALS = {
    "chrome.runtime.getURL": re.compile(r"chrome\.runtime\.getURL\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    "importScripts": re.compile(r"importScripts\(\s*['\"]([^'\"]+)['\"]\s*\)"),
}
HTML_REF = re.compile(r"""<(?:script[^>]*\ssrc|link[^>]*\shref)=['"]([^'"]+)['"]""")


def check_references(root: Path, files: list[Path]) -> None:
    """包内脚本与页面引用的资源必须真在包里。
    共享代码平铺进包时路径会变（shared/page/x.js → x.js），页面里的相对路径最容易随之落空。
    JS 侧参数不是纯字符串字面量时无法静态判断，直接报错要求人工确认，而非静默放过。
    """
    packaged = {path.relative_to(root).as_posix() for path in files}
    errors: list[str] = []
    for path in files:
        rel = path.relative_to(root)
        if "vendor" in rel.parts:
            continue
        if path.suffix == ".html":
            for ref in HTML_REF.findall(path.read_text(encoding="utf-8")):
                if ref.startswith(("http:", "https:", "data:")):
                    continue
                target = posixpath.normpath(posixpath.join(rel.parent.as_posix(), ref))
                if target not in packaged:
                    errors.append(f"{rel}: 页面引用 '{ref}' 不在包内")
            continue
        if path.suffix != ".js":
            continue
        text = path.read_text(encoding="utf-8")
        for kind, opener in OPENERS.items():
            literals = list(LITERALS[kind].finditer(text))
            for match in literals:
                if match.group(1) not in packaged:
                    errors.append(f"{rel}: {kind}('{match.group(1)}') 不在包内")
            unresolved = len(opener.findall(text)) - len(literals)
            if unresolved:
                errors.append(f"{rel}: {unresolved} 处 {kind}() 参数不是字符串字面量，需人工确认引用已覆盖")
    if errors:
        raise SystemExit("pack: 资源引用校验失败：\n  - " + "\n  - ".join(errors))


DOM_CONTRACTS = {"pdf/viewer.js": "pdf/viewer.html"}
ELEMENT_ID = re.compile(r"""getElementById\(\s*['"]([^'"]+)['"]\s*\)(?!\s*\?)""")
DECLARED_ID = re.compile(r"""\bid=['"]([^'"]+)['"]""")


def check_dom_contracts(root: Path) -> None:
    """共享脚本按 id 取元素，而页面骨架由各插件自己维护；缺 id 只会在运行时炸，这里提前拦。
    getElementById(...)?. 是运行时可选节点（如插件自己挂的 overlay），不要求写在 html 里。"""
    errors: list[str] = []
    for script_rel, page_rel in DOM_CONTRACTS.items():
        script, page = root / script_rel, root / page_rel
        if not (script.is_file() and page.is_file()):
            raise SystemExit(f"pack: DOM contract needs both {script_rel} and {page_rel}")
        declared = set(DECLARED_ID.findall(page.read_text(encoding="utf-8")))
        for element in sorted(set(ELEMENT_ID.findall(script.read_text(encoding="utf-8"))) - declared):
            errors.append(f"{page_rel}: 缺 id=\"{element}\"（{script_rel} 依赖）")
    if errors:
        raise SystemExit("pack: DOM 契约校验失败：\n  - " + "\n  - ".join(errors))


def check_js(root: Path, files: list[Path]) -> None:
    node = shutil.which("node")
    if not node:
        raise SystemExit("pack: node is required for syntax checking")
    for path in files:
        rel = path.relative_to(root)
        if path.name.endswith(".min.js") or path.name.endswith(".min.mjs"):
            raise SystemExit(f"pack: minified JavaScript is not allowed: {rel}")
        if "vendor" in rel.parts:
            continue
        if path.suffix != ".js":
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"(?m)^(?:import|export)\s", text):
            result = subprocess.run(
                [node, "--check", "--input-type=module"],
                input=text,
                text=True,
                capture_output=True,
            )
        else:
            result = subprocess.run([node, "--check", str(path)], text=True, capture_output=True)
        if result.returncode:
            raise SystemExit(result.stderr.strip() or f"pack: syntax error: {path.relative_to(root)}")


def package(root: Path, output: Path) -> None:
    check_manifest(root)
    files = source_files(root)
    check_references(root, files)
    check_dom_contracts(root)
    check_js(root, files)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="extension-pack-") as temp:
        stage = Path(temp)
        for source in files:
            staged = stage / source.relative_to(root)
            staged.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, staged)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for staged in sorted(stage.rglob("*")):
                if staged.is_file():
                    archive.write(staged, staged.relative_to(stage))
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        if "manifest.json" not in names or "background.js" not in names:
            raise SystemExit("pack: ZIP missing manifest or background worker")
    print(f"pack: {output}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("extension_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    package(args.extension_dir.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
