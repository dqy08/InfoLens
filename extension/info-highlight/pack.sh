#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

npm test

version="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
python3 ../scripts/build_extension.py info-highlight --release
python3 ../scripts/package_extension.py ../dist/info-highlight "../dist/info-highlight-v${version}.zip"
