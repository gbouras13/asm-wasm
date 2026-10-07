#!/usr/bin/env bash
# Build Flye 2.9.6 (C++ core + bundled minimap2 + bundled samtools) to WebAssembly
# for Node.js, and lay out a run tree where Flye's unchanged Python driver calls
# the WASM binaries:
#
#   ./build.sh
#   python3 "$WORK/dist/bin/flye" --nano-hq reads.fastq.gz -o out -t 8
#
# Env: WORK (default ~/.cache/asm-wasm/flye), EMSDK_DIR (default ~/.cache/asm-wasm/emsdk,
#      shared with the other asm-wasm builds), EMSDK_VERSION, JOBS,
#      FLYE_WASM32=1 at run time selects the wasm32 flye-modules (default: wasm64).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HOME/.cache/asm-wasm/flye}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/.cache/asm-wasm/emsdk}"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.11}"
FLYE_TAG=2.9.6
JOBS="${JOBS:-8}"
mkdir -p "$WORK"
cd "$WORK"

# --- toolchain ---------------------------------------------------------------
if [[ ! -d "$EMSDK_DIR" ]]; then
  git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
(cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION") >/dev/null
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
NODE="$(command -v node)"

# --- sources + patches ---------------------------------------------------------
if [[ ! -d flye ]]; then
  git clone -q --depth 1 --branch "$FLYE_TAG" https://github.com/mikolmogorov/Flye.git flye
  for p in "$HERE"/patches/0*.patch; do git -C flye apply --whitespace=nowarn "$p"; done
fi
SRC="$WORK/flye"
OUT="$WORK/dist"
SHIM="$WORK/shim"
mkdir -p "$OUT/bin" "$SHIM"

# emscripten (musl) has no execinfo.h; Flye only uses it for a SIGSEGV backtrace
cat > "$SHIM/execinfo.h" <<'EOF'
#pragma once
static inline int backtrace(void** buf, int size) { (void)buf; (void)size; return 0; }
static inline char** backtrace_symbols(void* const* buf, int size) { (void)buf; (void)size; return 0; }
EOF

# --- flags -------------------------------------------------------------------
CFLAGS_W="-O3 -pthread -msimd128 -sUSE_ZLIB=1"
# Node CLI target: real filesystem (NODERAWFS); main() runs on a worker so it can
# block in pthread_join; native-like stack sizes; node_stdio.js makes piped
# stdin/stdout behave (EAGAIN retry, non-seekable) for Flye's minimap2 | samtools.
# mimalloc: the default dlmalloc has one global lock - Flye's multithreaded
# polisher ran 35x slower with 8 threads (28 s vs 0.8 s).
LDFLAGS_W="-O3 -pthread -sUSE_ZLIB=1 -sPROXY_TO_PTHREAD -sNODERAWFS=1 -sEXIT_RUNTIME=1 \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=0 -sMALLOC=mimalloc \
  --pre-js $HERE/node_stdio.js"
MEM32="-sMAXIMUM_MEMORY=4GB"
MEM64="-sMEMORY64=1 -sMAXIMUM_MEMORY=16GB"

# --- minimap2 (SSE2 kernels -> wasm SIMD128 via emscripten's emmintrin.h) -------
# sse2only avoids ksw2_dispatch.c (x86 cpuid); arm_neon/aarch64 must stay unset.
build_mm2() {   # <dir> <extra cflags>
  rm -rf "$1" && cp -R "$SRC/lib/minimap2" "$1"
  emmake make -C "$1" -j"$JOBS" sse2only=1 arm_neon= aarch64= CC=emcc AR=emar \
    CFLAGS="-g0 -Wall $CFLAGS_W $2 -msse2" libminimap2.a main.o >/dev/null
}
build_mm2 "$WORK/mm2-32" ""
build_mm2 "$WORK/mm2-64" "-sMEMORY64=1"
emcc $LDFLAGS_W $MEM32 -o "$OUT/flye-minimap2.js" \
  "$WORK/mm2-32/main.o" -L"$WORK/mm2-32" -lminimap2 -lm

# --- flye-modules ---------------------------------------------------------------
# wasm64 (Memory64): same LP64 data model as native; Chrome/Edge >= 133, Firefox >= 134.
# wasm32: needs patch 02 (explicit 64-bit k-mer/hash types); also runs in Safari.
build_modules() {   # <name> <mem flags> <minimap2 lib dir>
  local objdir="$WORK/obj-$1" objs=() pids=()
  local cxx="$CFLAGS_W -DNDEBUG -std=c++11 -fwasm-exceptions -Wno-missing-field-initializers \
    -I$SHIM -I$SRC/lib/libcuckoo -I$SRC/lib/interval_tree -I$SRC/lib/lemon -I$SRC/lib/minimap2"
  [[ "$2" == *MEMORY64* ]] && cxx="$cxx -sMEMORY64=1"
  mkdir -p "$objdir"
  for f in "$SRC"/src/main.cpp "$SRC"/src/{sequence,assemble,repeat_graph,contigger,polishing}/*.cpp; do
    local o="$objdir/$(basename "$(dirname "$f")")_$(basename "${f%.cpp}").o"
    objs+=("$o")
    em++ -c $cxx "$f" -o "$o" &
    pids+=($!)
    if (( ${#pids[@]} >= JOBS )); then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
  done
  for p in "${pids[@]}"; do wait "$p"; done
  em++ $LDFLAGS_W $2 -fwasm-exceptions -o "$OUT/$1.js" "${objs[@]}" -L"$3" -lminimap2
}
build_modules flye-modules   "$MEM64" "$WORK/mm2-64"
build_modules flye-modules32 "$MEM32" "$WORK/mm2-32"

# --- samtools 1.9 (+ bundled htslib) --------------------------------------------
SAM="$WORK/samtools"
rm -rf "$SAM" && cp -R "$SRC/lib/samtools-1.9" "$SAM"
(
  cd "$SAM"
  emconfigure ./configure --host=wasm32-unknown-emscripten --without-curses \
    --disable-bz2 --disable-lzma --disable-libcurl --disable-plugins \
    CFLAGS="$CFLAGS_W" LDFLAGS="-sUSE_ZLIB=1" >/dev/null
  # the Makefiles hardcode AR=ar; macOS ar/ranlib corrupt archives of wasm objects
  emmake make -j"$JOBS" samtools AR=emar RANLIB=emranlib LDFLAGS="$LDFLAGS_W $MEM32" >/dev/null
)
cp "$SAM/samtools" "$OUT/flye-samtools.js"
cp "$SAM/samtools.wasm" "$OUT/samtools.wasm"

# --- run tree: Flye's Python driver + wrappers that run the binaries in Node -------
rm -rf "$OUT/flye" && cp -R "$SRC/flye" "$OUT/flye"
cp "$SRC/bin/flye" "$OUT/bin/flye"
cat > "$OUT/bin/flye-modules" <<EOF
#!/bin/bash
if [[ -n "\${FLYE_WASM32:-}" ]]; then m=flye-modules32; else m=flye-modules; fi
exec "$NODE" "$OUT/\$m.js" "\$@"
EOF
printf '#!/bin/bash\nexec "%s" "%s/flye-minimap2.js" "$@"\n' "$NODE" "$OUT" > "$OUT/bin/flye-minimap2"
printf '#!/bin/bash\nexec "%s" "%s/flye-samtools.js" "$@"\n' "$NODE" "$OUT" > "$OUT/bin/flye-samtools"
chmod +x "$OUT"/bin/*
ls -la "$OUT" "$OUT/bin"
