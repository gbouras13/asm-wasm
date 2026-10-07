#!/usr/bin/env bash
# Build SPAdes 4.2.0's assembler core (spades-core) to WebAssembly for Node.js and lay out a
# run tree in which SPAdes' unchanged Python driver runs the WASM binary:
#
#   ./build.sh
#   python3 "$WORK/dist/bin/spades.py" --isolate -1 R1.fq.gz -2 R2.fq.gz -t 1 -o out
#
# --isolate (like --only-assembler) only runs spades-core (once per k) plus two small Python
# scripts; no read error correction (spades-hammer), no BWA mismatch corrector.
#
# Env: WORK (default ~/.cache/asm-wasm/spades), EMSDK_DIR (default ~/.cache/asm-wasm/emsdk,
#      shared with the other asm-wasm builds), EMSDK_VERSION (6.0.11), JOBS (6),
#      OPENMP=0 skips the multithreaded variant (built by default; see NOTES.md).
#      At run time SPADES_WASM_ST=1 makes the wrapper use the single-threaded build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HOME/.cache/asm-wasm/spades}"
EMSDK_DIR="${EMSDK_DIR:-$HOME/.cache/asm-wasm/emsdk}"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.11}"
SPADES_TAG=v4.2.0
JOBS="${JOBS:-6}"
OPENMP="${OPENMP:-1}"
mkdir -p "$WORK"
cd "$WORK"

# --- toolchain ---------------------------------------------------------------------
if [[ ! -d "$EMSDK_DIR" ]]; then
  git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
if ! "$EMSDK_DIR/upstream/emscripten/emcc" --version 2>/dev/null | grep -q " $EMSDK_VERSION "; then
  (cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION") >/dev/null
fi
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
NODE="$(command -v node)"

# --- sources + patches ---------------------------------------------------------------
SRC="$WORK/spades-src"
if [[ ! -d "$SRC" ]]; then
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$SPADES_TAG" \
    https://github.com/ablab/spades.git "$SRC"
  for p in "$HERE"/patches/0*.patch; do git -C "$SRC" apply --whitespace=nowarn "$p"; done
fi

# Shim headers: emscripten/musl has no <execinfo.h> (SPAdes includes it for stack traces);
# easel includes <x86intrin.h>, which clang refuses on non-x86 (emscripten's <immintrin.h>
# implements the SSE intrinsics on SIMD128); deps.cmake requires BZip2 but nothing uses it.
SHIM="$WORK/shim"
mkdir -p "$SHIM"
cat > "$SHIM/execinfo.h" <<'EOF'
#pragma once
static inline int backtrace(void** buf, int size) { (void)buf; (void)size; return 0; }
static inline char** backtrace_symbols(void* const* buf, int size) { (void)buf; (void)size; return 0; }
EOF
printf '#pragma once\n#include <immintrin.h>\n' > "$SHIM/x86intrin.h"
echo '/* placeholder: SPAdes CMake requires BZip2, nothing links it */' > "$SHIM/bzlib.h"
rm -f "$SHIM/libbz2.a" && emar rcs "$SHIM/libbz2.a"

# --- flags ---------------------------------------------------------------------------
# wasm64 (Memory64): LP64 like native. -msimd128 lets clang auto-vectorise; SSE emulation is
# enabled only for C (bwa ksw, ssw, easel/hmmer intrinsics) and two C++ targets (patch 02), so
# phmap/boost hash tables keep the portable layout native arm64 uses.
# BOOST_MATH_PROMOTE_DOUBLE_POLICY=false: boost::math otherwise evaluates double functions in
# long double, which is software binary128 on wasm (the k-mer coverage model fit was 25x
# slower); on arm64 long double == double, so this also matches native numerics.
CF="-m64 -pthread -msimd128 -isystem $SHIM"
CFLAGS_W="$CF -msse4.1"
CXXFLAGS_W="$CF -fwasm-exceptions -DBOOST_MATH_PROMOTE_DOUBLE_POLICY=false"
# Node CLI target: real filesystem (NODERAWFS); main() on a worker (PROXY_TO_PTHREAD) so it may
# block; mimalloc (dlmalloc has one global lock); native-like stack sizes; NODE_HOST_ENV passes
# the host environment (OMP_*/KMP_* knobs); node_stdio.js fixes piped stdio under Node (EAGAIN,
# lseek on pipes).
LDFLAGS_W="-m64 -pthread -fwasm-exceptions -sPROXY_TO_PTHREAD -sNODERAWFS=1 -sEXIT_RUNTIME=1 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=16GB -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sMALLOC=mimalloc -sNODE_HOST_ENV=1 --pre-js $HERE/node_stdio.js"

configure() {   # <build dir> <extra cmake args...>
  local b="$1"; shift
  emcmake cmake -S "$SRC/src" -B "$b" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DSPADES_ENABLE_PROJECTS=spades \
    -DSPADES_USE_MIMALLOC=OFF -DSPADES_USE_JEMALLOC=OFF \
    -DCMAKE_C_FLAGS="$CFLAGS_W" -DCMAKE_CXX_FLAGS="$CXXFLAGS_W" \
    -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS_W" \
    -DBoost_INCLUDE_DIR="$SRC/ext/include" \
    -DBZIP2_INCLUDE_DIR="$SHIM" -DBZIP2_LIBRARY_RELEASE="$SHIM/libbz2.a" \
    -DeslENABLE_SSE=1 -DeslENABLE_SSE4=1 -DeslENABLE_NEON=0 -DeslHAVE_NEON_AARCH64=0 \
    "$@" > "$b.configure.log" 2>&1 || { tail -30 "$b.configure.log"; exit 1; }
}

# Single-threaded: no OpenMP (SPAdes' openmp_wrapper.h provides 1-thread stubs).
configure "$WORK/build-wasm64" -DCMAKE_DISABLE_FIND_PACKAGE_OpenMP=TRUE
make -C "$WORK/build-wasm64" -j"$JOBS" spades-core > "$WORK/build-wasm64.make.log" 2>&1 \
  || { grep -E "error" "$WORK/build-wasm64.make.log" | head -30; exit 1; }

# Multithreaded: emscripten >= 6.0.11 ships LLVM's libomp (pthreads-backed, wasm64-capable);
# -fopenmp at compile and link time makes em++ link libopenmp. The flags are given explicitly:
# FindOpenMP's own probe parses the implicit link line of a -O0 test link and would add the
# *debug* libc/libc++abi variants to every link (undefined __throw_exception_with_stack_trace).
# omp_env.js defaults KMP_LOCK_KIND=tas: emscripten's libomp queuing locks hang in contended
# critical sections with >= 6 threads (see NOTES.md).
if [[ "$OPENMP" == 1 ]]; then
  configure "$WORK/build-wasm64-omp" \
    -DOpenMP_C_FLAGS=-fopenmp=libomp -DOpenMP_CXX_FLAGS=-fopenmp=libomp \
    -DOpenMP_C_LIB_NAMES= -DOpenMP_CXX_LIB_NAMES= \
    -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS_W --pre-js $HERE/omp_env.js"
  make -C "$WORK/build-wasm64-omp" -j"$JOBS" spades-core > "$WORK/build-wasm64-omp.make.log" 2>&1 \
    || { grep -E "error" "$WORK/build-wasm64-omp.make.log" | head -30; exit 1; }
fi

# --- run tree: SPAdes' Python driver + wrapper that runs spades-core under Node ------------
OUT="$WORK/dist"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/libexec" "$OUT/share/spades/configs"/{debruijn,hammer,corrector,ionhammer} \
  "$OUT/share/spades/pyyaml3"
P="$SRC/src/projects"
cp "$P"/spades/pipeline/*.py "$OUT/bin/"
cp -R "$P/spades/pipeline/spades_pipeline" "$OUT/share/spades/"
cp "$P"/spades/configs/*.info "$OUT/share/spades/configs/debruijn/"
cp "$P"/hammer/configs/*.info "$OUT/share/spades/configs/hammer/"
cp "$P"/corrector/configs/*.info "$OUT/share/spades/configs/corrector/"
cp "$P"/ionhammer/configs/*.cfg "$OUT/share/spades/configs/ionhammer/"
cp "$SRC"/ext/src/python_libs/pyyaml3/*.py "$OUT/share/spades/pyyaml3/"
cp "$SRC"/{VERSION,LICENSE,GPLv2.txt,README.md} "$OUT/share/spades/"
cp "$WORK"/build-wasm64/bin/spades-core.{js,wasm} "$OUT/libexec/"
if [[ "$OPENMP" == 1 ]]; then
  mkdir -p "$OUT/libexec/omp"
  cp "$WORK"/build-wasm64-omp/bin/spades-core.{js,wasm} "$OUT/libexec/omp/"
fi
cat > "$OUT/bin/spades-core" <<EOF
#!/bin/bash
d="$OUT/libexec"
if [[ -z "\${SPADES_WASM_ST:-}" && -f "\$d/omp/spades-core.js" ]]; then d="\$d/omp"; fi
exec "$NODE" "\$d/spades-core.js" "\$@"
EOF
# spades.py refuses to start unless these exist; --isolate never calls them.
for b in spades-hammer spades-ionhammer spades-bwa; do
  printf '#!/bin/bash\necho "%s: not built for WebAssembly (only spades-core is; use --isolate or --only-assembler)" >&2\nexit 1\n' "$b" > "$OUT/bin/$b"
done
chmod +x "$OUT"/bin/*
ls -la "$OUT/bin" "$OUT/libexec"
[[ "$OPENMP" == 1 ]] && ls -la "$OUT/libexec/omp"
exit 0
