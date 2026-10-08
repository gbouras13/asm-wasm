# Flye 2.9.6 → WebAssembly

Emscripten 6.0.11 · Node 24.19 · measured on an Apple M1 Pro (8 cores, 16 GB), macOS 15.7

## Summary

* **The whole Flye pipeline is one WebAssembly module** (`flye-modules pipeline`, 1.5 MB as
  wasm32). Flye's Python layer is ported to C++, minimap2 runs in-process, and the
  minimap2 → samtools round trip is emulated in memory, so there is no Python, no samtools and
  no subprocess. It runs in a Web Worker in every current browser (wasm32), or under Node.
* **Output is bit-identical to native Flye** at `-t 1` (and identical up to circular rotation
  at `-t 8`, as between two native multithreaded runs), after making Flye's platform-dependent
  tie-breaking deterministic (commit 1 below).
* **Speed: 1.3–1.5× native.** Phage A (92 kb, 455×, 8 threads): 408 s vs 272 s; with
  `--asm-coverage 50`, 112 s vs 89 s; under 0.9 GB of memory (measured with the earlier
  multi-binary build, which runs the same C++ code; see History).

The code is in the fork at `Flye/` (submodule; [gbouras13/Flye, branch
`asm-wasm`](https://github.com/gbouras13/Flye/tree/asm-wasm)), five commits on top of 2.9.6:

1. `065a7ff` Make results deterministic across platforms (stable_sort, portable rand, double log)
2. `0bc2ac2` Use explicit 64-bit types for k-mers, hashes and positions (wasm32 support)
3. `565c83d` Polisher: avoid a flush per bubble line
4. `a4ae998` samtools sort: avoid size_t overflow of the memory limit on 32-bit targets
5. `1ebee2d` Add `flye-modules pipeline`: the full pipeline in one process

Commits 1–4 are small, self-contained fixes that make sense upstream on their own.

## The single-process pipeline (`src/pipeline/`)

The Python stages are ported to C++: configure (read statistics, N90-based minimum overlap,
the `--asm-coverage` cutoff), consensus, polishing (bubbles, compose, coverage statistics and
BED, the coverage filter, the polished GFA) and finalize (scaffolds, `assembly_info.txt`).
The existing C++ modules (assemble, repeat, contigger, polisher) run in the same process
(`--resume`, `--resume-from` and `--stop-after` behave as in Flye; per-module global state is
reset between modules).

* minimap2 runs in-process through a small output hook (`mm_output_hook`), configured exactly
  as Flye calls it.
* The minimap2 → `samtools view/sort` → region query round trip is emulated in memory:
  coordinate-sorted stable order, BAM SEQ normalisation, CG-tag long CIGARs, htslib region
  semantics, `samtools depth -a -m 0 -Q 10 -l 100`.
* Python semantics that change results are reproduced exactly: `random.Random(42).shuffle` of
  the records of each region (CPython's MT19937), stable sorts, dict insertion order,
  `max(sorted(d), key=d.get)` tie-breaking, the defaultdict access that drops uncovered
  positions, banker's rounding, negative indexing.

## Validation

Method: md5/SHA-256 of every output (and every intermediate file for the stage-by-stage
comparisons), at `-t 1` unless stated (at `-t 8` two *native* runs already differ from each
other on messy data). Datasets: **phage A**, an ONT R10 phage isolate (44 Mb of reads, N50
9 kb, 92 kb circular genome, 455×); **sample B**, a messy low-coverage ONT sample that makes a
sensitive test (338 disjointigs, 78 contigs).

| Run | Result |
|---|---|
| sample B, native C++ pipeline vs Flye's Python pipeline | all content files identical (only vertex numbering in `repeat_graph_dump`/`.gv` differs, as between two native Python runs) |
| phage A, native C++ vs Python, `-t 8` | identical assembly, assembly_info, GFA, stats |
| phage A + a second read file = **1,634×**, `--resume-from` on a Python run directory | configure parameters, consensus, all polishing outputs, BED, GFA, assembly_info identical (exercises the 1000× cap + shuffle and the samtools-depth path) |
| sample B, WASM (Node) vs Python | all outputs identical |
| sample B, **WASM in the browser** (Chromium, CSP + COOP/COEP) | assembly.fasta, assembly_info.txt, assembly_graph.gfa identical to native |
| phage A in the browser via phage-annotation.org's `/assemble`, 7 threads | identical to native up to circular rotation |

Speed (1 thread, sample B): Python pipeline 41 s, native C++ pipeline 24 s, WASM under Node
32.5 s. Browser, 4 threads: sample B in 12 s.

**Upstream Flye bug found:** in the bundled minimap2, `--secondary-seq` is registered as
option code 354 but handled as 347 (the code of `--rmq`), so the flag is a no-op: secondary
alignments are written with `SEQ=*`, and Flye's consensus/polishing silently drop them (624 of
5,605 records on sample B). The fix is one line in `lib/minimap2/main.c:242`, but it would
change Flye's results, so the port reproduces the current behaviour.

## Determinism (commit 1)

Stock Flye built natively and as WebAssembly gave different contigs on sample B (78 vs 77)
from the repeat stage on. The cause is three platform dependences in Flye itself, none of them
WebAssembly-specific (native Linux and macOS builds are exposed to the same ones):

1. **`std::sort` tie order** — the actual cause. k-mer match chaining (`overlap.cpp`) sorts by
   `(extId, curPos)` / `extPos` with ties; the order of equal elements is unspecified and
   differs between C++ standard libraries (Apple's libc++, Emscripten's newer libc++,
   libstdc++). The chaining DP breaks score ties by visiting order, so the same overlap gets a
   different, equally scored chain → different divergence → slightly different alignments.
2. **Unseeded `rand()`** for read sampling (divergence estimate, chimera coverage, N
   replacement): the sequence is libc-specific (glibc ≠ macOS ≠ musl).
3. **`logf` rounding**: Apple's libm and musl disagree by 1 ULP on 0.27% of inputs in the range
   used by `std::log(1 / matchRate)`.

Commit 1 removes all three (`std::stable_sort`; `portableRand()` reproducing glibc's default
`rand()` sequence, so results should match Linux builds; double-precision log). It changes
tie-breaking relative to stock Flye, so a dataset may assemble slightly differently from stock
(as it already does across platforms), but identically everywhere.

## Performance — phage A, 8 threads

| Stage | Native (conda 2.9.6) | WASM, dlmalloc | WASM, mimalloc |
|---|---|---|---|
| assembly (disjointigs) | 232 s | 368 s | 357 s (1.54×) |
| consensus | 16 s | 19 s | 18 s |
| repeat + contigger | 4 s | 5 s | 6 s |
| polishing | 20 s | 51 s | 25 s |
| **total (wall)** | **272 s** | 445 s | **408 s (1.50×)** |
| with `-g 92k --asm-coverage 50` | 89 s | — | 112 s (1.26×) |

(Measured with the first, multi-binary build under Node; see History.) C++ stages run at
1.2–1.6× native, minimap2 at ~1.3×. The polisher was the outlier with Emscripten's default
allocator: 28 s vs 0.6 s native, because dlmalloc has a single global lock; `-sMALLOC=mimalloc`
→ 0.8 s. High coverage is the main cost for phages: `--asm-coverage 50` gave the same genome 3×
faster, and the `/assemble` page uses it whenever a genome size is given.

## Gotchas (and fixes)

1. **64-bit `size_t` assumption.** `kmer.h` has `static_assert(sizeof(size_t) == 8)`; 62-bit
   k-mers, splitmix hashes and 40-bit global positions live in `size_t`, and the hashes drive
   algorithm choices (minimizer selection, read-extension order). Build for **wasm64**
   (Memory64: LP64 like native, no changes) or use **commit 2** (explicit `uint64_t`) for wasm32.
   The wasm32 build is the default: Memory64 is missing from some browsers (it shipped in
   Chrome/Edge 133 and Firefox 134), and 4 GB is ample for phages.
2. **Raw-read modes allocate an 8 GiB array.** `--nano-raw` / `--pacbio-raw` count k-mers in a
   flat 4^17/2-byte array regardless of genome size. `--nano-hq`, `--nano-corr` and
   `--pacbio-hifi` use a minimizer index and are unaffected; commit 2 falls back to the exact
   hash counter in 32-bit builds. The browser offers only the three minimizer modes.
3. **Allocator contention**: link with `-sMALLOC=mimalloc` (see Performance).
4. **Per-line flushes in the polisher.** `writeBubbles` used `std::endl` (two `write()`s per
   bubble, under a mutex); under Emscripten threads every syscall is proxied to one thread.
   Commit 3 writes `'\n'`.
5. **Node non-blocking stdio pipes (macOS)** — Node builds only. Once Node initialises
   `process.stdout` the pipe is non-blocking and `fs.writeSync` hits `EAGAIN`; `node_stdio.js`
   retries.
6. **Emscripten `lseek` on piped stdin "succeeds"** (NODERAWFS) — Node builds only;
   `node_stdio.js` makes stdio report `ESPIPE`.
7. **`samtools sort` memory on 32-bit**: `max_mem = _max_mem * n_threads` wraps to 0 for
   `-@ 4 -m 1G` → one temporary file per record. Commit 4 caps it (only relevant to the
   multi-binary build).
8. `execinfo.h` (Flye's SIGSEGV backtrace) does not exist in Emscripten/musl → stub header.

## Build

`build_wasm.sh` (installs emsdk 6.0.11 under `~/.cache/asm-wasm/emsdk` if needed):

* `./build_wasm.sh node` → `dist/node/flye-modules{,32}.{js,wasm}` and a `flye-wasm` wrapper:
  `dist/node/flye-wasm --nano-hq reads.fastq.gz --out-dir out --threads 8`
* `./build_wasm.sh web` → `dist/web/flye/flye.{mjs,wasm}` (wasm32, the browser default) and
  `flye64.{mjs,wasm}` (wasm64): ES modules for a Web Worker, with Flye's config files embedded.

Native build of the fork, for comparisons (macOS arm64; drop the minimap2 flags on x86-64):

```bash
cd Flye && N=$PWD
make -C lib/minimap2 -j8 arm_neon=1 aarch64=1
CXXFLAGS="-I$N/lib/libcuckoo -I$N/lib/interval_tree -I$N/lib/lemon -I$N/lib/minimap2" \
  LDFLAGS="-lz -L$N/lib/minimap2 -lminimap2" BIN_DIR=$N/bin make release -C src -j8
bin/flye-modules pipeline --nano-hq reads.fastq.gz --out-dir out --threads 8
```

## History

The first step was a recompile rather than a port: upstream Flye 2.9.6 plus patch files
(equivalent to commits 1–4), with `flye-modules`, minimap2 and samtools each built as a
separate WebAssembly binary and Flye's unchanged Python driver calling them under Node. That
showed the C++ was portable and the output identical, but the browser cannot run Python or
spawn processes, which led to the single-process pipeline. The scripts and patch files of that
first build are in this repository's first commit (`flye/build.sh`, `flye/patches/`).
