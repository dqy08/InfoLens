#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

python3 ../scripts/build_extension.py semantic-highlight --release
./run-tests.sh
version="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
python3 ../scripts/package_extension.py ../dist/semantic-highlight "../dist/info-lens-semantic-highlight-v${version}.zip"
