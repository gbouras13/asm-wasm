#!/usr/bin/env bash
# Copy the in-browser assemblers (runtime JS + WebAssembly builds) into a
# phage-annotation-server checkout, under web/static/asm/.
#
#   ./sync_to_server.sh ../../phage-annotation-server
#
# Build first: asm_wasm/flye/build_wasm.sh web (Flye) and asm_wasm/spades/build_web.sh (SPAdes).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$(cd "$HERE/.." && pwd)/dist/web"
SERVER="${1:?usage: sync_to_server.sh <phage-annotation-server checkout>}"
DEST="$SERVER/web/static/asm"

[[ -f "$SERVER/api/main.py" ]] || { echo "not a phage-annotation-server checkout: $SERVER" >&2; exit 1; }
[[ -f "$DIST/flye/flye.wasm" ]] || { echo "no Flye web build in $DIST (run flye/build_wasm.sh web)" >&2; exit 1; }
[[ -f "$DIST/spades/spades.wasm" ]] || { echo "no SPAdes web build in $DIST (run spades/build_web.sh)" >&2; exit 1; }

mkdir -p "$DEST/flye" "$DEST/spades"
cp "$HERE/asm-client.js" "$HERE/asm-worker.js" "$HERE/spades-driver.js" "$HERE/reads.js" "$DEST/"
cp "$DIST/flye/flye.mjs" "$DIST/flye/flye.wasm" "$DEST/flye/"
cp "$DIST/spades/spades.mjs" "$DIST/spades/spades.wasm" "$DEST/spades/"
ls -la "$DEST" "$DEST/flye" "$DEST/spades"
