#!/usr/bin/env bash
# Package the browser runtime and the web builds for a GitHub release:
#
#   web/package.sh v0.1.0   → dist/asm-wasm-web-v0.1.0.tar.gz and .sha256
#
# The tarball unpacks to a directory that can be served as is (see README, "Using it
# in a web page"). Build first: flye/build_wasm.sh web and spades/build_web.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${1:?usage: package.sh <version>}"
NAME="asm-wasm-web-$VERSION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] \
  || { echo "commit your changes first: SOURCE.txt names the commit" >&2; exit 1; }

D="$STAGE/$NAME"
mkdir -p "$D/flye" "$D/spades"
cp "$HERE/asm-client.js" "$HERE/asm-worker.js" "$HERE/spades-driver.js" "$HERE/reads.js" "$D/"
cp "$ROOT"/dist/web/flye/flye.mjs "$ROOT"/dist/web/flye/flye.wasm \
   "$ROOT"/dist/web/flye/flye64.mjs "$ROOT"/dist/web/flye/flye64.wasm "$D/flye/"
cp "$ROOT"/dist/web/spades/spades.mjs "$ROOT"/dist/web/spades/spades.wasm "$D/spades/"
cp "$ROOT/LICENSE" "$D/LICENSE.txt"
cp "$ROOT/THIRD_PARTY.md" "$D/THIRD_PARTY.txt"
{
  echo "asm-wasm $VERSION: built from https://github.com/gbouras13/asm-wasm (GPL-2.0),"
  echo "which contains the complete corresponding source; see THIRD_PARTY.txt."
  echo
  echo "asm-wasm commit:  $(git -C "$ROOT" rev-parse HEAD)"
  echo "Flye fork commit: $(git -C "$ROOT/flye/Flye" rev-parse HEAD) (https://github.com/gbouras13/Flye)"
  echo "SPAdes:           v4.2.0 (https://github.com/ablab/spades) + asm-wasm spades/patches/"
} > "$D/SOURCE.txt"

mkdir -p "$ROOT/dist"
tar -C "$STAGE" -czf "$ROOT/dist/$NAME.tar.gz" "$NAME"
(cd "$ROOT/dist" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
ls -la "$ROOT/dist/$NAME.tar.gz" "$ROOT/dist/$NAME.tar.gz.sha256"
