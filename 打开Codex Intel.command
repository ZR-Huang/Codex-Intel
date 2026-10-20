#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
if [[ ! -d 'dist/Codex Intel.app' ]]; then
  python3 convert.py
fi
open "$PWD/dist/Codex Intel.app"
