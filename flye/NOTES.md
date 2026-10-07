# Flye → WebAssembly: feasibility spike

2026-10-07 · Flye 2.9.6 · Emscripten 6.0.11 · Node 24.19 · Apple M1 Pro (8 cores, 16 GB), macOS 15.7

## Bottom line

* **It works.** Flye's C++ core (`flye-modules`: assemble / repeat / contigger / polisher), the
  bundled minimap2 2.24 and the bundled samtools 1.9 all compile to WebAssembly. The full Flye
  pipeline runs under Node with every binary in WASM; Flye's own Python driver is unchanged.
* **It is correct.** With Flye's platform-dependent tie-breaking made deterministic (patch 01),
  native, WASM-wasm64 and WASM-wasm32 builds give **bit-identical output at every pipeline stage**.
  minimap2 and samtools outputs are byte-identical to native. On a real phage the all-WASM
  assembly is identical to native Flye's.
* **Speed: 1.5× native.** Real phage (92 kb, 455×, 8 threads): 6 min 48 s vs 4 min 32 s. With
  Flye's `--asm-coverage 50`: **112 s vs 89 s**, same genome. Peak memory < 0.9 GB per process.
* **A browser app is feasible, but it is a port, not a recompile**: the Python layer (subprocess,
  multiprocessing, ~700 lines of pure-Python consensus/bubble code) has to be replaced, the tools
  need a shared virtual filesystem, threads need cross-origin isolation, and Safari needs the
  wasm32 build.

## Update — single-process pipeline and the browser (later on 2026-10-07)

The Python layer is now ported to C++ (`flye-modules pipeline`, in the fork at `Flye/`,
`src/pipeline/`): configure (read stats, N90-based min overlap, `--asm-coverage` cutoff),
consensus, polishing (bubbles, compose, coverage stats/BED, coverage filter, polished GFA)
and finalize (scaffolds, assembly_info). minimap2 runs in-process through a small output
hook (`mm_output_hook`); the minimap2 → `samtools view/sort` → region-query round trip is
emulated in memory (coordinate-sorted stable order, BAM SEQ normalisation, CG-tag long
CIGARs, htslib region semantics, `samtools depth -a -m 0 -Q 10 -l 100`). Python
semantics that change results are reproduced exactly: `random.Random(42).shuffle` of the
records of each region (CPython MT19937), stable sorts, dict insertion order,
`max(sorted(d), key=d.get)` tie-breaking, the defaultdict access that drops uncovered
positions, banker's rounding, Python's negative indexing. The C++ modules run in-process
(`--resume`, `--resume-from`, `--stop-after` behave as in Flye). One WASM module, 1.5 MB,
no Python / samtools / subprocesses.

Validation (md5 / SHA-256 of every output):

| Run | Result |
|---|---|
| sample B, native C++ pipeline vs Python pipeline, `-t 1` | all content files identical (only vertex numbering in `repeat_graph_dump`/`.gv` differs — it differs between two native Python runs too) |
| phage A 455×, native C++ vs Python, `-t 8` | identical assembly, assembly_info, GFA, stats |
| phage A + 2nd file = **1,634×**, `--resume-from` on a Python run dir | configure params, consensus, all polishing outputs, BED, GFA, assembly_info identical (exercises the 1000× cap + shuffle and the samtools-depth path) |
| sample B, WASM (Node) pipeline vs Python, `-t 1` | all outputs identical |
| sample B, **WASM in the browser** (Chromium, CSP + COOP/COEP), `-t 1` | assembly.fasta, assembly_info.txt, assembly_graph.gfa SHA-256 identical to native |
| phage A via `/assemble` on the local annotation server, 7 threads | identical to native up to circular rotation (as between native multithreaded runs) |

Speed (single thread, sample B): Python pipeline 41 s, native C++ pipeline 24 s, WASM
pipeline under Node 32.5 s. Browser, 4 threads: sample B in 12 s; phage A subsampled
(`-g 92k --asm-coverage 50`) in 78 s while 6 compiler processes were competing for the CPU.

**Upstream Flye bug found:** in the bundled minimap2, `--secondary-seq` is registered as
option code 354 but handled as 347 (the code of `--rmq`): the flag is a no-op, secondary
alignments are written with `SEQ=*`, and Flye's Python consensus/polishing silently drop
them (624 of 5,605 records on sample B). One-line fix in `lib/minimap2/main.c:242`, but it
would change Flye's results, so the port reproduces the current behaviour.

## What was built

| Binary | Source | Target | .wasm | Source changes needed |
|---|---|---|---|---|
| `flye-modules` | `src/` (~17.7k lines C++) | wasm64 (Memory64) | 1.2 MB | none (only an `execinfo.h` stub header) |
| `flye-modules32` | same | wasm32 | 1.1 MB | patch 02 |
| `flye-minimap2` | `lib/minimap2` 2.24 | wasm32, SSE2 → SIMD128 | 0.3 MB | none |
| `flye-samtools` | `lib/samtools-1.9` + htslib | wasm32 | 0.9 MB | patch 04 (32-bit overflow) |

`build.sh` reproduces everything from a fresh clone in ~70 s (once emsdk is installed).
Node link flags: `-pthread -sPROXY_TO_PTHREAD` (main() on a worker so it can block in
`pthread_join`), `-sNODERAWFS` (real filesystem), `-sALLOW_MEMORY_GROWTH`, `-sMALLOC=mimalloc`,
8 MB / 2 MB stacks, `-fwasm-exceptions` (Flye throws C++ exceptions), `--pre-js node_stdio.js`.
For end-to-end runs, `dist/bin/` holds `flye-modules`, `flye-minimap2`, `flye-samtools` wrappers
that `exec node <tool>.js "$@"`, so Flye's Python driver uses them transparently.

## Correctness

Method: run the pipeline at `-t 1` (at `-t 8` two *native* runs already differ from each
other on messy data) and md5 every intermediate file.

| Stage output | stock native vs stock WASM | patched native vs WASM-64 vs WASM-32 |
|---|---|---|
| `00-assembly/draft_assembly.fasta` | identical | identical |
| `10-consensus/consensus.fasta` | identical | identical |
| `20-repeat/read_alignment_dump`, `graph_before_rr.*` | differ | identical |
| `30-contigger/contigs.fasta`, `graph_final.gfa` | differ (78 vs 77 contigs) | identical |
| `assembly.fasta`, `assembly_info.txt`, `assembly_graph.gfa` | differ | identical |

(Sample B, a messy low-coverage ONT sample, makes a sensitive test: 338 disjointigs, 78 contigs.)
Also identical to native: minimap2 PAF/SAM (10,375 / 14,041 records), samtools sorted BAM and
CSI index (byte-identical), region `view`, `depth`; and the phage A assembly at `-t 8`
(full run and `--asm-coverage 50` run).

The stock differences trace to **three platform dependences in Flye itself**, none WASM-specific
(native Linux vs macOS builds are exposed to the same ones):

1. **`std::sort` tie order** — the actual cause. k-mer match chaining (`overlap.cpp`) sorts by
   `(extId, curPos)` / `extPos` with ties; the order of equal elements is unspecified and differs
   between C++ standard libraries (Apple libc++ vs emscripten's newer libc++, libstdc++ on Linux).
   The chaining DP breaks score ties by visiting order, so the same overlap gets a different,
   equally scored chain → different divergence → slightly different read-to-graph alignments.
2. **Unseeded `rand()`** for read sampling (divergence estimate, chimera coverage, N
   replacement): the sequence is libc-specific (glibc ≠ macOS ≠ musl).
3. **`logf` rounding**: Apple libm and musl disagree by 1 ULP on 0.27% of inputs in the range used
   by `std::log(1 / matchRate)`.

Patch 01 removes all three (`std::stable_sort`; `portableRand()` reproducing glibc's default
`rand()` sequence, so results should match Linux builds; double-precision log). It changes
tie-breaking relative to stock Flye, so a given dataset may assemble slightly differently from
stock (as it already does across platforms) — but identically everywhere. Small and upstreamable
on its own merits.

## Performance — phage A (ONT R10, 44 Mb reads, N50 9 kb, 92 kb circular genome, 455×), `-t 8`

| Stage | Native (conda 2.9.6) | WASM, dlmalloc | WASM, mimalloc (final) |
|---|---|---|---|
| assembly (disjointigs) | 232 s | 368 s | 357 s (1.54×) |
| consensus | 16 s | 19 s | 18 s |
| repeat + contigger | 4 s | 5 s | 6 s |
| polishing | 20 s | 51 s | 25 s |
| **total (wall)** | **272 s** | 445 s | **408 s (1.50×)** |
| with `-g 92k --asm-coverage 50` | 89 s | — | 112 s (1.26×) |

* C++ stages run at 1.2–1.6× native; minimap2 at ~1.3× (2.9 s vs 2.2 s on 44 Mb of reads).
* The polisher was the outlier: 28 s vs 0.6 s native at 8 threads (and 4.6 s on 1 thread!) —
  dlmalloc's single global lock. `-sMALLOC=mimalloc` → 0.8 s.
* Peak RSS per process (Node incl. V8): `flye-modules` 874 MB, minimap2 395 MB, samtools 329 MB.
* High coverage is the main cost for phages; `--asm-coverage 50` gave the same genome 3× faster.

## Gotchas found (and fixes)

1. **64-bit `size_t` assumption.** `kmer.h` has `static_assert(sizeof(size_t) == 8)`; 62-bit
   k-mers, splitmix hashes and 40-bit global positions live in `size_t`, and the hashes drive
   algorithm choices (minimizer selection, read-extension order). Build for **wasm64**
   (Memory64: LP64 like native, no changes) or apply **patch 02** (explicit `uint64_t`) for wasm32.
2. **Raw-read modes allocate an 8 GiB array.** `--nano-raw` / `--pacbio-raw` (`use_minimizers = 0`)
   count k-mers in a flat 4^17/2-byte array regardless of genome size. `--nano-hq`,
   `--nano-corr`, `--pacbio-hifi` use a minimizer index and are unaffected. Patch 02 falls back to
   the exact hash counter in 32-bit builds.
3. **Allocator contention.** Emscripten's default dlmalloc has one global lock; the polisher's
   many small allocations across 8 threads were 35× slower than with `-sMALLOC=mimalloc`.
4. **Per-line flushes in the polisher.** `writeBubbles` used `std::endl` (two `write()`s per
   bubble, under a mutex); under Emscripten threads each syscall is proxied to the main JS thread.
   Patch 03 writes `'\n'`.
5. **Node non-blocking stdio pipes (macOS).** Once Node initialises `process.stdout` (worker
   threads forward stdio through it), the pipe is non-blocking and `fs.writeSync` hits `EAGAIN`
   when samtools reads slower than minimap2 writes → minimap2 died with "failed to write the
   results: Resource temporarily unavailable" on the 455× phage (not on small inputs).
   `node_stdio.js` retries on `EAGAIN`.
6. **Emscripten `lseek` on piped stdin "succeeds"** (NODERAWFS uses `fstat` size = buffered bytes
   and never moves the real offset). htslib's BGZF EOF check seeks, so `samtools sort -` got a
   corrupted stream ("Invalid BAM binary header"). `node_stdio.js` makes stdio report `ESPIPE`.
7. **samtools sort memory on 32-bit**: `max_mem = _max_mem * n_threads` wraps to 0 for Flye's
   `-@ 4 -m 1G` → one temp file per record → out of file descriptors. Patch 04 caps it (the buffer
   is malloc'ed up front, so a cap is wise in a browser anyway).
8. samtools/htslib Makefiles hardcode `AR = ar`; macOS `ar -s` writes a symbol table `wasm-ld`
   cannot parse ("malformed uleb128") → build with `AR=emar RANLIB=emranlib`.
9. `execinfo.h` (SIGSEGV backtrace) does not exist in emscripten/musl → stub header.
10. Node CLI only: each tool invocation pays ~100 ms (Node start + wasm compile). Flye's Python
    calls samtools once per region, so fragmented assemblies pay for it (sample B `-t 1`: 99 s vs
    41 s native). A browser app compiles each module once and re-instantiates it in milliseconds.

## What a browser version would need (not done here)

1. **Web link target**: no `NODERAWFS`; `-sENVIRONMENT=web,worker -sMODULARIZE -sEXPORT_ES6`, run
   tools in Web Workers, mount input `File`s read-only with WORKERFS, and give all tools **one
   shared filesystem** (each Emscripten module has its own by default: link a multi-call binary,
   use PROXYFS, or WasmFS + OPFS).
2. **Threads need cross-origin isolation** (`COOP: same-origin`, `COEP: require-corp`) for
   `SharedArrayBuffer`. Hosts that can't set headers need a service-worker shim; otherwise ship a
   single-threaded build.
3. **Safari**: Memory64 ships in Chrome/Edge ≥ 133 and Firefox ≥ 134 but **not Safari (macOS or
   iOS)** as of Oct 2026 → ship the wasm32 build (patch 02; bit-identical here). The 4 GB cap is
   ample for phages (< 0.9 GB peak per process measured).
4. **Replace the Python layer** — the real work. 13 subprocess call sites; `multiprocessing` in the
   consensus and polishing steps; ~700 lines of pure-Python compute (`consensus.py`, `bubbles.py`)
   plus BAM parsing via samtools. Two routes:
   * **Pyodide**: run Flye's Python as-is, swap subprocess for calls into the WASM modules and run
     the multiprocessing loops serially. Quickest prototype, but a heavy download, single-threaded
     Python compute, and synchronous JS calls from Python need JSPI (Chromium) or a worker bridge.
   * **Port to C++ (recommended)**: add `consensus` and `bubbles` subcommands to `flye-modules`
     that call the already-linked libminimap2 in-process (no SAM/BAM, no samtools, no Python), plus
     a ~200-line JS driver. More work (rough guess: 1–2 weeks including validation), but faster and
     smaller — and the per-stage bit-identity harness used here makes validating the port
     mechanical.
5. Restrict modes to `--nano-hq` / `--nano-corr` / `--pacbio-hifi` (gotcha 2), and default to
   `--asm-coverage 50` for high-coverage phage data.

## Files

* `build.sh` — reproducible build: pins emsdk 6.0.11, clones Flye 2.9.6, applies the patches,
  builds all binaries (wasm64 and wasm32 `flye-modules`) and writes a run tree:
  `python3 $WORK/dist/bin/flye --nano-hq reads.fastq.gz -o out -t 8` (`FLYE_WASM32=1` for wasm32).
  Default `WORK=~/.cache/asm-wasm/flye` (emsdk alone is ~1.8 GB).
* `node_stdio.js` — `--pre-js` fixing piped stdio under Node (gotchas 5–6).
* `patches/01-deterministic-across-platforms.patch` — stable sort, portable rand, double log.
* `patches/02-wasm32-explicit-64bit-types.patch` — wasm32 / Safari support.
* `patches/03-polisher-no-per-line-flush.patch`
* `patches/04-samtools-sort-32bit-overflow.patch`
