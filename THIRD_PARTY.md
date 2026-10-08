# Third-party software in the WebAssembly builds

This repository (build scripts, patches, the JavaScript runtime in `web/`) is licensed
under GPL-2.0 (see `LICENSE`). The modules it builds contain the following software,
each under its own license.

## Flye — `flye.wasm` / `flye.mjs` (and the Node builds in `dist/node/`)

| Component | License | Source |
|---|---|---|
| Flye 2.9.6 with the `asm-wasm` commits (single-process pipeline, determinism/wasm32 fixes) | BSD-3-Clause | [gbouras13/Flye, branch `asm-wasm`](https://github.com/gbouras13/Flye/tree/asm-wasm) (submodule `flye/Flye`), forked from [mikolmogorov/Flye](https://github.com/mikolmogorov/Flye) |
| minimap2 2.24 (bundled with Flye) | MIT | `flye/Flye/lib/minimap2` |
| interval_tree (bundled with Flye) | MIT | `flye/Flye/lib/interval_tree` |
| libcuckoo (bundled with Flye) | Apache-2.0 | `flye/Flye/lib/libcuckoo` |
| LEMON (bundled with Flye) | Boost Software License 1.0 | `flye/Flye/lib/lemon` |
| zlib (Emscripten port) | zlib | <https://zlib.net> |

## SPAdes — `spades.wasm` / `spades.mjs`

| Component | License | Source |
|---|---|---|
| SPAdes 4.2.0 `spades-core`, with the patches in `spades/patches/` | GPL-2.0 | [ablab/spades v4.2.0](https://github.com/ablab/spades/tree/v4.2.0) + this repository |
| Third-party libraries bundled in SPAdes' `ext/` directory that `spades-core` links | their respective licenses (see the SPAdes source tree) | SPAdes v4.2.0 `ext/` |
| LLVM OpenMP runtime (libomp, from Emscripten) | Apache-2.0 WITH LLVM-exception | <https://github.com/llvm/llvm-project> |

**Corresponding source (GPL-2.0).** The SPAdes builds are made from SPAdes v4.2.0 with the
patches in `spades/patches/`, compiled and linked by `spades/build.sh` and
`spades/build_web.sh` with the link-time files `spades/omp_env.js` and
`spades/mmap_alloc.js`, using Emscripten 6.0.11. `web/spades-driver.js` reimplements the
parts of SPAdes' `spades.py` that `--isolate` uses.

## In every module (Emscripten 6.0.11 toolchain and runtime)

| Component | License |
|---|---|
| Emscripten JavaScript runtime and system libraries | MIT / University of Illinois NCSA |
| musl libc | MIT |
| libc++, libc++abi, compiler-rt (LLVM) | Apache-2.0 WITH LLVM-exception |
| mimalloc (allocator, `-sMALLOC=mimalloc`) | MIT |

Please cite Flye and SPAdes when you use assemblies made with these builds:

* Kolmogorov M, Yuan J, Lin Y, Pevzner PA. Assembly of long, error-prone reads using repeat
  graphs. *Nature Biotechnology* 37, 540–546 (2019).
* Prjibelski A, Antipov D, Meleshko D, Lapidus A, Korobeynikov A. Using SPAdes de novo
  assembler. *Current Protocols in Bioinformatics* 70, e102 (2020).
