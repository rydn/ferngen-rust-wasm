#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. "$HOME/.cargo/env" 2>/dev/null || true

wasm-pack build --target web --release --out-dir ../web/pkg fern-wasm

echo
echo "Build complete. Serve with:"
echo "  python3 -m http.server 8000 --directory web"
