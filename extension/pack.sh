#!/bin/bash
# 打商店 zip：按 background.js 的 CONTENT_JS/CSS + manifest 自动收集文件，不维护白名单。
# 打包后校验 staged 目录与 zip 内容一致。
# 用法：./pack.sh
# 产出：extension/dist/info-lens-semantic-highlight-v<version>.zip
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

./run-tests.sh

pack_tool() {
  python3 - "$@" <<'PY'
import json
import re
import shutil
import sys
import zipfile
from fnmatch import fnmatch
from pathlib import Path

ROOT = Path(".")


def parse_background_lists() -> tuple[list[str], list[str]]:
    text = (ROOT / "background.js").read_text(encoding="utf-8")

    def parse_array(name: str) -> list[str]:
        m = re.search(rf"const {re.escape(name)}\s*=\s*\[(.*?)\];", text, re.S)
        if not m:
            sys.exit(f"pack: cannot parse {name} in background.js")
        items = re.findall(r"'([^']+)'", m.group(1))
        if not items:
            sys.exit(f"pack: {name} is empty in background.js")
        return items

    return parse_array("CONTENT_JS"), parse_array("CONTENT_CSS")


def runtime_files() -> list[str]:
    content_js, content_css = parse_background_lists()
    return sorted(set(content_js + content_css + ["background.js"]))


# 扩展页 / PDF 入口随包发布（不在 CONTENT_JS 推导链上，须显式列入）。
# pdf/viewer.html 还通过 <script> 引用 config.js / splitTextToChunks.js（已在 CONTENT_JS，会随 runtime 打包）。
# options.html 引用 semantic/analyzeCache.js（已在 CONTENT_JS）。
OPTIONS_FILES = [
    "options.html",
    "options.js",
]
PDF_VIEWER_FILES = [
    "pdf/entry.js",
    "pdf/stash-db.js",
    "pdf/viewer.html",
    "pdf/viewer.css",
    "pdf/viewer.js",
    "pdf/search.js",
    "pdf/file-access.html",
    "pdf/file-access.js",
    "semantic/pdf-document.js",
    "semantic/analyzeCache.js",
    "semantic/find.js",
    "vendor/pdfjs/pdf.min.js",
    "vendor/pdfjs/pdf.worker.min.js",
    "vendor/pdfjs/LICENSE",
]


def source_path(runtime_path: str) -> Path:
    """工作区里 CONTENT_JS 的 config.js 对应 config.prod.js。"""
    if runtime_path == "config.js":
        return ROOT / "config.prod.js"
    return ROOT / runtime_path


def manifest_source_path(manifest_rel: str) -> Path:
    """dev manifest 的 icons/dev/ 对应上架用的 icons/。"""
    if manifest_rel.startswith("icons/dev/"):
        return ROOT / manifest_rel.replace("icons/dev/", "icons/", 1)
    if manifest_rel == "config.js":
        return ROOT / "config.prod.js"
    return ROOT / manifest_rel


def store_manifest_text() -> str:
    return (ROOT / "manifest.json").read_text(encoding="utf-8").replace("icons/dev/", "icons/")


KNOWN_TOP_KEYS = {
    "manifest_version", "default_locale", "name", "version", "description",
    "icons", "permissions", "host_permissions", "optional_host_permissions", "background", "commands",
    "action", "options_ui", "web_accessible_resources",
}
KNOWN_BACKGROUND_KEYS = {"service_worker", "type"}
KNOWN_ACTION_KEYS = {"default_title", "default_icon"}
KNOWN_OPTIONS_UI_KEYS = {"page", "open_in_tab"}


def verify_manifest_shape(manifest: dict) -> None:
    """白名单校验 manifest.json 结构。
    出现未知字段（如 chrome_url_overrides/content_scripts/sandbox 等）说明
    引入了 pack.sh 尚未处理的资源引用方式，直接报错，而非静默漏打包。
    """
    errors: list[str] = []
    unknown_top = set(manifest) - KNOWN_TOP_KEYS
    if unknown_top:
        errors.append(f"manifest.json 出现未知字段 {sorted(unknown_top)}，pack.sh 不知道其中是否有需要打包的文件引用")

    unknown_bg = set(manifest.get("background", {})) - KNOWN_BACKGROUND_KEYS
    if unknown_bg:
        errors.append(f"manifest.json background 出现未知字段 {sorted(unknown_bg)}")

    unknown_action = set(manifest.get("action", {})) - KNOWN_ACTION_KEYS
    if unknown_action:
        errors.append(f"manifest.json action 出现未知字段 {sorted(unknown_action)}（如 default_popup 需要额外打包该页面）")

    unknown_options = set(manifest.get("options_ui", {})) - KNOWN_OPTIONS_UI_KEYS
    if unknown_options:
        errors.append(f"manifest.json options_ui 出现未知字段 {sorted(unknown_options)}")

    if errors:
        print("pack: manifest.json 结构超出 pack.sh 已知范围：", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("  请人工确认是否需要新增文件引用，并相应更新 pack.sh 后重试。", file=sys.stderr)
        sys.exit(1)


def verify_manifest_transform(dev_text: str, store_text: str) -> None:
    """确保 icons/dev/ -> icons/ 替换只改了图标路径，没有意外改动其它内容。"""
    dev_manifest = json.loads(dev_text)
    store_manifest = json.loads(store_text)
    dev_norm = json.loads(dev_text.replace("icons/dev/", "icons/"))
    if dev_norm != store_manifest:
        print("pack: manifest.json 的 icons/dev/ -> icons/ 替换产生了意外差异，需人工检查 pack.sh", file=sys.stderr)
        sys.exit(1)
    _ = dev_manifest  # 仅用于确认 dev_text 本身也是合法 JSON


def expand_glob(root: Path, pattern: str) -> list[str]:
    if "*" not in pattern and "?" not in pattern and "[" not in pattern:
        return [pattern]
    return sorted(
        p.relative_to(root).as_posix()
        for p in root.glob(pattern)
        if p.is_file()
    )


def manifest_asset_paths(manifest: dict) -> list[str]:
    paths: list[str] = []
    for rel in manifest.get("icons", {}).values():
        paths.append(rel)
    action = manifest.get("action", {})
    for rel in action.get("default_icon", {}).values():
        paths.append(rel)
    for entry in manifest.get("web_accessible_resources", []):
        for pattern in entry.get("resources", []):
            paths.extend(expand_glob(ROOT, pattern))
    return sorted(set(paths))


def locale_files() -> list[str]:
    return sorted(
        p.relative_to(ROOT).as_posix()
        for p in ROOT.glob("_locales/*/messages.json")
        if p.is_file()
    )


def package_destinations() -> dict[str, Path]:
    """包内相对路径 -> 工作区源文件。名单由 CONTENT_JS/CSS 与 manifest 推导。"""
    mapping: dict[str, Path] = {}

    for rel in runtime_files():
        mapping[rel] = source_path(rel)

    for rel in locale_files():
        mapping[rel] = ROOT / rel

    for rel in OPTIONS_FILES:
        mapping[rel] = ROOT / rel

    for rel in PDF_VIEWER_FILES:
        mapping[rel] = ROOT / rel

    dev_manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    for rel in manifest_asset_paths(dev_manifest):
        dest = rel.replace("icons/dev/", "icons/", 1) if rel.startswith("icons/dev/") else rel
        mapping[dest] = manifest_source_path(rel)

    return mapping


def expected_package_files() -> list[str]:
    return sorted(set(package_destinations()) | {"manifest.json"})


CALL_OPENERS = (
    ("getURL", re.compile(r"chrome\.runtime\.getURL\(")),
    ("importScripts", re.compile(r"importScripts\(")),
)
LITERAL_CALL_PATTERNS = {
    "getURL": re.compile(r"chrome\.runtime\.getURL\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    "importScripts": re.compile(r"importScripts\(\s*['\"]([^'\"]+)['\"]\s*\)"),
}


def line_at(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def iter_pack_js_sources() -> list[Path]:
    """扩展源码里的 .js（含 semantic/）；排除 vendor 与打包产物。"""
    skip_parts = {"vendor", "dist", "node_modules"}
    out: list[Path] = []
    for path in sorted(ROOT.rglob("*.js")):
        if any(part in skip_parts for part in path.parts):
            continue
        out.append(path)
    return out


def find_source_calls() -> tuple[list[tuple[str, str, str]], list[tuple[str, str, int]]]:
    """扫扩展源码 .js 里的 getURL()/importScripts() 调用（含 semantic/）。
    返回 (能识别为纯字面量的引用, 无法识别参数形式的调用位置)。
    调用总数（不管参数形式）与字面量命中数不一致，说明有非字面量参数（拼接/变量），需人工确认。
    """
    literal_refs: list[tuple[str, str, str]] = []
    unresolved: list[tuple[str, str, int]] = []
    for js_file in iter_pack_js_sources():
        rel = js_file.relative_to(ROOT).as_posix()
        text = js_file.read_text(encoding="utf-8")
        for kind, opener in CALL_OPENERS:
            total = len(opener.findall(text))
            literal_matches = list(LITERAL_CALL_PATTERNS[kind].finditer(text))
            for m in literal_matches:
                literal_refs.append((rel, kind, m.group(1)))
            if len(literal_matches) < total:
                literal_starts = {m.start() for m in literal_matches}
                for m in opener.finditer(text):
                    if m.start() not in literal_starts:
                        unresolved.append((rel, kind, line_at(text, m.start())))
    return literal_refs, unresolved


def verify_source_references(
    dev_manifest: dict,
    literal_refs: list[tuple[str, str, str]],
    unresolved: list[tuple[str, str, int]],
) -> None:
    """importScripts 的路径必须在打包名单里。
    getURL：网页上下文可读的资源须被 web_accessible_resources 覆盖；
    仅扩展上下文使用的包内资源（如 pdf/viewer.html）只需已列入打包名单，不必进 WAR。
    参数不是纯字符串字面量时无法静态判断，直接报错要求人工确认。
    """
    errors: list[str] = []
    for js_file, kind, line in unresolved:
        errors.append(
            f"{js_file}:{line}: {kind}() 参数不是纯字符串字面量，无法静态校验是否被打包覆盖，需人工确认后调整检查逻辑"
        )

    packaged = set(package_destinations())
    war_patterns = [
        pattern
        for entry in dev_manifest.get("web_accessible_resources", [])
        for pattern in entry.get("resources", [])
    ]
    for js_file, kind, ref in literal_refs:
        if kind == "importScripts":
            if ref not in packaged:
                errors.append(f"{js_file}: importScripts('{ref}') 未列入打包名单（检查 CONTENT_JS/CONTENT_CSS）")
        elif kind == "getURL":
            in_war = any(fnmatch(ref, pattern) for pattern in war_patterns)
            if in_war:
                continue
            if ref in packaged:
                # 扩展页 / 后台用 getURL 打开包内文件，不经过网页，无需 WAR
                continue
            errors.append(
                f"{js_file}: chrome.runtime.getURL('{ref}') 既未列入打包名单，也不在 web_accessible_resources"
            )

    if errors:
        print("pack: 发现未覆盖 / 无法校验的资源引用：", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)


def verify_files(root: Path, rel_paths: list[str], label: str) -> None:
    missing = [p for p in rel_paths if not (root / p).is_file()]
    if missing:
        print(f"pack: {label} missing:", file=sys.stderr)
        for p in missing:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)


def verify_zip(zip_path: Path, rel_paths: list[str]) -> None:
    with zipfile.ZipFile(zip_path) as zf:
        names = {n for n in zf.namelist() if not n.endswith("/")}
    expected = set(rel_paths)
    missing = sorted(expected - names)
    if missing:
        print("pack: zip missing:", file=sys.stderr)
        for p in missing:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)
    extra = sorted(names - expected)
    if extra:
        print("pack: zip 里出现未预期文件（可能是开发遗留文件混入）：", file=sys.stderr)
        for p in extra:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)


def stage_tree(stage: Path) -> None:
    dev_text = (ROOT / "manifest.json").read_text(encoding="utf-8")
    dev_manifest = json.loads(dev_text)

    verify_manifest_shape(dev_manifest)
    literal_refs, unresolved = find_source_calls()
    verify_source_references(dev_manifest, literal_refs, unresolved)
    print(f"pack: manifest 结构与 {len(literal_refs)} 处资源引用校验通过")

    mapping = package_destinations()
    for dest, src in sorted(mapping.items()):
        if not src.is_file():
            print(f"pack: source missing: {dest} <- {src}", file=sys.stderr)
            sys.exit(1)
        out = stage / dest
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out)

    store_text = store_manifest_text()
    verify_manifest_transform(dev_text, store_text)
    (stage / "manifest.json").write_text(store_text, encoding="utf-8")
    print(f"pack: 已拷贝 {len(expected_package_files())} 个文件到打包目录")


def main() -> None:
    mode = sys.argv[1]

    if mode == "stage":
        stage_tree(Path(sys.argv[2]))
        return

    if mode == "post":
        stage = Path(sys.argv[2])
        zip_path = Path(sys.argv[3])
        expected = expected_package_files()
        verify_files(stage, expected, "staged tree")
        verify_zip(zip_path, expected)
        print(f"pack: zip 内容核对一致（{len(expected)} 个文件，不多不少）")
        return

    sys.exit(f"pack: unknown mode {mode}")


if __name__ == "__main__":
    main()
PY
}

version="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
name="info-lens-semantic-highlight-v${version}"
mkdir -p dist
out="$(pwd)/dist/${name}.zip"

stage="$(mktemp -d "${TMPDIR:-/tmp}/il-ext-pack.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

pack_tool stage "$stage"

# staged 文件语法自检：拷贝/替换环节若意外破坏代码，语法错误在此处直接暴露
if ! command -v node >/dev/null 2>&1; then
  echo "pack: 需要 node 校验打包后 JS 语法（brew install node 或用 nvm）" >&2
  exit 1
fi
js_count=0
while IFS= read -r -d '' f; do
  node --check "$f" || { echo "pack: 语法错误 $f" >&2; exit 1; }
  js_count=$((js_count + 1))
done < <(find "$stage" -name '*.js' -print0)
echo "pack: ${js_count} 个 .js 文件语法通过（node --check）"

rm -f "$out"
( cd "$stage" && zip -qr "$out" . )

pack_tool post "$stage" "$out"

echo "pack: 已打包（商店图标）：$out"
