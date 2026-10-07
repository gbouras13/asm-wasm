#!/usr/bin/env bash
# Relink SPAdes' spades-core (OpenMP, wasm64) as an ES module for the browser
# (Web Worker) and Node, for asm_wasm/web/spades-driver.js. Reuses the objects
# of an existing build.sh build; no recompilation.
#
#   ./build_web.sh            → asm_wasm/dist/web/spades/spades.{mjs,wasm}
#
# Env: WORK (as for build.sh, default ~/.cache/asm-wasm/spades), BUILD (default
#      <WORK>/build-wasm64-omp), SRC (spades source tree, default <BUILD>/../spades-src), OUT, EMSDK_DIR,
#      MALLOC (default mimalloc), EXTRA_LDFLAGS (e.g. --profiling-funcs)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HOME/.cache/asm-wasm/spades}"
BUILD="${BUILD:-$WORK/build-wasm64-omp}"
OUT="${OUT:-$(cd "$HERE/.." && pwd)/dist/web/spades}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/.cache/asm-wasm/emsdk}"
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$OUT"

LINK_TXT="$BUILD/projects/spades/CMakeFiles/spades-core.dir/link.txt"
[[ -f "$LINK_TXT" ]] || { echo "no spades-core build in $BUILD (run build.sh, or set WORK/BUILD)" >&2; exit 1; }
SRC="${SRC:-$(cd "$BUILD/.." && pwd)/spades-src}"
# objects and static libraries, in CMake's order (paths relative to projects/spades)
INPUTS=$(tr ' ' '\n' < "$LINK_TXT" | grep -E '\.o"?$|\.a$' | tr -d '"' | tr '\n' ' ')

# the k-mer iteration config templates, read by the driver from /spades/configs/debruijn
EMBED=""
for f in "$SRC"/src/projects/spades/configs/*.info; do
  EMBED="$EMBED --embed-file $f@/spades/configs/debruijn/$(basename "$f")"
done

# web,worker for the browser; node for automated tests of the driver.
# omp_env.js: KMP_LOCK_KIND=tas (libomp's queuing locks hang with >= 6 contending threads).
# mmap_alloc.js: mmap() of MEMFS files with plain 16-byte-aligned blocks; with Emscripten's
#   64 KiB-aligned default, mimalloc never reused them (+6 GB heap per k-mer size at 8 threads).
cd "$BUILD/projects/spades"
em++ -m64 -pthread -fwasm-exceptions -fopenmp=libomp -O3 \
  -sENVIRONMENT=web,worker,node -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSpades \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=0 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=16GB -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sMALLOC="${MALLOC:-mimalloc}" -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8,ENV -lworkerfs.js -lnodefs.js \
  --pre-js "$HERE/omp_env.js" --js-library "$HERE/mmap_alloc.js" ${EXTRA_LDFLAGS:-} $EMBED \
  $INPUTS -o "$OUT/spades.mjs"
ls -la "$OUT"
