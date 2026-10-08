#!/usr/bin/env bash
# Build the Flye fork (flye/Flye, a submodule: Flye 2.9.6 + fixes + the
# single-process `flye-modules pipeline`) to WebAssembly.
#
#   ./build_wasm.sh [node] [web]      (default: both)
#
# node: $OUT/node/flye-modules{,32}.js  Node CLI (real filesystem), e.g.
#         $OUT/node/flye-wasm --nano-hq reads.fastq.gz -o out -t 8
# web:  $OUT/web/flye/flye{,64}.mjs     ES modules for asm_wasm/web/asm-worker.js
#
# Env: OUT (default asm_wasm/dist), WORK (default ~/.cache/asm-wasm/flye-fork),
#      EMSDK_DIR (default ~/.cache/asm-wasm/emsdk), EMSDK_VERSION, JOBS
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/Flye"
OUT="${OUT:-$(cd "$HERE/.." && pwd)/dist}"
WORK="${WORK:-$HOME/.cache/asm-wasm/flye-fork}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/.cache/asm-wasm/emsdk}"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.11}"
JOBS="${JOBS:-8}"
TARGETS="${*:-node web}"

if [[ ! -d "$EMSDK_DIR" ]]; then
  git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
(cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION") >/dev/null
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
NODE="$(command -v node)"
mkdir -p "$WORK" "$OUT"

# emscripten (musl) has no execinfo.h; Flye only uses it for a SIGSEGV backtrace
SHIM="$WORK/shim"
mkdir -p "$SHIM"
cat > "$SHIM/execinfo.h" <<'EOF'
#pragma once
static inline int backtrace(void** buf, int size) { (void)buf; (void)size; return 0; }
static inline char** backtrace_symbols(void* const* buf, int size) { (void)buf; (void)size; return 0; }
EOF

CFLAGS_W="-O3 -pthread -msimd128 -sUSE_ZLIB=1"
# common link flags. mimalloc: dlmalloc's global lock made Flye's
# multithreaded polisher 35x slower.
LDFLAGS_COMMON="-O3 -pthread -sUSE_ZLIB=1 -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sPTHREAD_POOL_SIZE_STRICT=0 -sMALLOC=mimalloc -fwasm-exceptions"

# --- minimap2 library (SSE2 kernels -> wasm SIMD128) -------------------------
build_mm2() {   # <arch: 32|64>
  local dir="$WORK/mm2-$1" extra=""
  [[ "$1" == 64 ]] && extra="-sMEMORY64=1"
  if [[ ! -f "$dir/libminimap2.a" || "$SRC/lib/minimap2/misc.c" -nt "$dir/libminimap2.a" ]]; then
    rm -rf "$dir" && cp -R "$SRC/lib/minimap2" "$dir"
    make -C "$dir" clean >/dev/null 2>&1 || true
    emmake make -C "$dir" -j"$JOBS" sse2only=1 arm_neon= aarch64= CC=emcc AR=emar \
      CFLAGS="-g0 -Wall $CFLAGS_W $extra -msse2" libminimap2.a >/dev/null
  fi
}

# --- Flye C++ objects (incremental) --------------------------------------------
build_objs() {   # <arch: 32|64>
  local objdir="$WORK/obj-$1" pids=() extra=""
  [[ "$1" == 64 ]] && extra="-sMEMORY64=1"
  local cxx="$CFLAGS_W $extra -DNDEBUG -std=c++11 -fwasm-exceptions -Wno-missing-field-initializers \
    -I$SHIM -I$SRC/lib/libcuckoo -I$SRC/lib/interval_tree -I$SRC/lib/lemon -I$SRC/lib/minimap2"
  mkdir -p "$objdir"
  OBJS=()
  for f in "$SRC"/src/main.cpp "$SRC"/src/{sequence,assemble,repeat_graph,contigger,polishing,pipeline}/*.cpp; do
    local o="$objdir/$(basename "$(dirname "$f")")_$(basename "${f%.cpp}").o"
    OBJS+=("$o")
    # rebuild if the source or any header is newer than the object
    if [[ ! -f "$o" || "$f" -nt "$o" || -n "$(find "$SRC/src" -name '*.h' -newer "$o" -print -quit)" ]]; then
      em++ -c $cxx "$f" -o "$o" &
      pids+=($!)
      if (( ${#pids[@]} >= JOBS )); then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
    fi
  done
  for p in ${pids[@]+"${pids[@]}"}; do wait "$p"; done
}

CONFIG="$SRC/flye/config/bin_cfg"
EMBED_CONFIG=""
for f in asm_defaults.cfg asm_raw_reads.cfg asm_corrected_reads.cfg asm_hifi.cfg asm_nano_hq.cfg \
         asm_subasm.cfg nano_r94_substitutions.mat pacbio_chm13_substitutions.mat; do
  EMBED_CONFIG="$EMBED_CONFIG --embed-file $CONFIG/$f@/flye/config/bin_cfg/$f"
done

for arch in 32 64; do
  build_mm2 "$arch"
done

for target in $TARGETS; do
  case "$target" in
    node)
      mkdir -p "$OUT/node"
      for arch in 32 64; do
        build_objs "$arch"
        name="flye-modules"; mem="-sMAXIMUM_MEMORY=16GB -sMEMORY64=1"
        [[ "$arch" == 32 ]] && name="flye-modules32" && mem="-sMAXIMUM_MEMORY=4GB"
        em++ $LDFLAGS_COMMON $mem -sNODERAWFS=1 -sPTHREAD_POOL_SIZE=8 \
          --pre-js "$HERE/node_stdio.js" -o "$OUT/node/$name.js" "${OBJS[@]}" \
          -L"$WORK/mm2-$arch" -lminimap2
      done
      # pipeline wrapper: wasm32 by default (FLYE_WASM64=1 for the Memory64 build)
      cat > "$OUT/node/flye-wasm" <<EOF
#!/bin/bash
# Flye (single-process pipeline) as WebAssembly under Node
dir="\$(cd "\$(dirname "\$0")" && pwd)"
m=flye-modules32; [[ -n "\${FLYE_WASM64:-}" ]] && m=flye-modules
exec "$NODE" "\$dir/\$m.js" pipeline --config-dir "$CONFIG" "\$@"
EOF
      chmod +x "$OUT/node/flye-wasm"
      ;;
    web)
      mkdir -p "$OUT/web/flye"
      for arch in 32 64; do
        build_objs "$arch"
        name="flye64"; mem="-sMAXIMUM_MEMORY=16GB -sMEMORY64=1"
        [[ "$arch" == 32 ]] && name="flye" && mem="-sMAXIMUM_MEMORY=4GB"
        em++ $LDFLAGS_COMMON $mem -sENVIRONMENT=web,worker -sMODULARIZE=1 -sEXPORT_ES6=1 \
          -sEXPORT_NAME=createFlye -sINVOKE_RUN=0 -sPTHREAD_POOL_SIZE=0 \
          -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8 -lworkerfs.js $EMBED_CONFIG \
          -o "$OUT/web/flye/$name.mjs" "${OBJS[@]}" -L"$WORK/mm2-$arch" -lminimap2
      done
      ;;
    *) echo "unknown target: $target" >&2; exit 1 ;;
  esac
done
find "$OUT" -name '*.wasm' -o -name '*.mjs' -o -name 'flye-modules*.js' | xargs ls -la
