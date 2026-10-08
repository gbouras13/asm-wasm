# SPAdes 4.2.0 → WebAssembly

Goal: assemble Illumina phage reads in the browser (phage-annotation.org `/assemble`), next to
Flye for long reads. Mode: `spades.py --isolate` (the recommended mode for high-coverage
isolates), plus Unicycler-style trimming of the overlap SPAdes leaves on circular contigs.

**Status (2026-10-08): working in the browser; live on phage-annotation.org/assemble.** Outputs
are byte-identical to native SPAdes (all 8 output files; 1, 4 and 8 threads; 100× and 1000×
phage data and a mixed sample). A 100× phage assembles in ~10 s at 4 threads; WASM takes
1.6–2× native time.

## What `--isolate` runs, and the JS driver

`spades.py --isolate` skips read error correction (BayesHammer) and the BWA mismatch
corrector: it runs `spades-core <K>/configs/config.info <K>/configs/isolate_mode.info` once per
k-mer size, then copies the last iteration's outputs. Python is not available in the browser,
so `web/spades-driver.js` ports the parts of spades.py that this path uses:

* **k-mer sizes** (`chooseKmers`): 21,33,55 for reads < 150 bp; +77 for ≥ 150 bp; up to 127 for
  ≥ 250 bp; sizes ≥ the read length are dropped. The read length is the minimum over files of
  the longest of the first 10,000 reads (`maxReadLength`, as `support.get_max_reads_length`).
* **Configs** (`configForK`): `process_cfg.substitute_params` semantics (last occurrence wins,
  `;` comments, its quote quirk), the per-iteration values of `prepare_config_spades`
  (`use_additional_contigs`, `gap_closer_enable`, `rr_enable`, `main_iteration`,
  `correct_mismatches`, …), and the dataset YAML exactly as pyyaml writes it.
  `tests/spades-driver.test.mjs` checks configs and YAML byte-for-byte against a native run.
* **Iterations**: each k runs in a **fresh module instance** (no global state shared between
  runs, as with separate processes). Only `K<prev>/simplified_contigs` is carried to the next
  k, which is all spades.py passes on (`copy_files.py` and `breaking_scaffolds_script.py` only
  copy outputs / write a misc file).
* The browser worker compiles `spades.wasm` once and instantiates it per k
  (`instantiateWasm`), so later iterations reuse the engine's optimised code.
* `readBufferMb` sets `construction.info`'s `read_buffer_size` (the browser uses 64 MB per
  thread; see Findings).

Circular contigs: SPAdes writes a circular component as one sequence whose last k bases repeat
its first ones (GFA self-loop `L x + x + 77M`, path tag `TP:Z:circular`).
`trimCircularOverlaps` removes that overlap when the path is a single segment with a self-loop
and the bases match, and renames `NODE_1_length_92215_…` to the new length. Verified on the
test phage: trimmed contig = true genome up to rotation (`web/tests/compare_circular.py`).

**Subsampling** (`web/reads.js`, on by default on `/assemble`: at most 200,000 pairs): counts
R1's records, then keeps each pair with probability cap/total using a seeded PRNG replayed
identically over R1 and R2 (mates stay together), copying kept records into compact blocks
that become `File`s for WORKERFS. 300k pairs → 1.3 s. Native SPAdes keeps its temporary files
on disk; here they are in memory, so deep runs need a cap (see Benchmarks).
`tests/reads.test.mjs` covers pairing, determinism, gz vs plain input and missing final newlines.

## Build

```bash
./build.sh          # spades-core (wasm64; single-threaded + OpenMP) for Node + a run tree in which
                    # the unchanged spades.py drives it ($WORK/dist/bin/spades.py) — for validation
./build_web.sh      # relinks the OpenMP objects as an ES module for the browser/Node
                    # → asm_wasm/dist/web/spades/spades.{mjs,wasm} (5.8 MB)
```

`WORK` defaults to `~/.cache/asm-wasm/spades` for both. Toolchain: Emscripten 6.0.11 (LLVM 24), shared with
the Flye build. `build_web.sh` only relinks (~30 s); `MALLOC=dlmalloc` and
`EXTRA_LDFLAGS=--profiling-funcs` make diagnostic variants (with `OUT=` elsewhere).

Patches (`patches/`, applied by build.sh; no behaviour change on native platforms):

* **01 platform guards** — `<endian.h>`, `getMainExecutable()`, XSI `strerror_r`, easel's
  `cpuid`, scalar XXH3 under Emscripten, a missing `<cstddef>`, and folly `PackedSyncPtr`
  (packs a pointer into 48 bits: fine for wasm64).
* **02 CMake** — no `-lsupc++`; SSE emulation flags only for the two C++ targets that
  include x86 intrinsics (ssw, hmmer), so phmap/boost hash-table layouts stay the portable
  ones (as on native arm64).
* **03 log memory** — Emscripten's `getrusage()` leaves `ru_maxrss` unset (random numbers in
  every log line); report the WebAssembly heap size instead.

Link-time pieces: `omp_env.js` (libomp defaults, below), `mmap_alloc.js` (below),
`node_stdio.js` (Node CLI target only: EAGAIN / lseek on pipes, as for Flye),
`-DBOOST_MATH_PROMOTE_DOUBLE_POLICY=false`, `-sMALLOC=mimalloc`, `ENV` exported (so a page or
test can set OMP_*/KMP_* in a `preRun`).

## Findings

* **wasm64 (Memory64) only.** SPAdes assumes LP64 in several places (folly `PackedSyncPtr`,
  k-mer storage types); wasm64 needs no source changes. Memory64 is in Chrome/Edge ≥ 133 and
  Firefox ≥ 134; the page detects support (`memory64Supported()` in `asm-client.js`) and
  explains when it is missing. A wasm32 build (other browsers, e.g. Safari until it ships
  Memory64) would need changes like Flye's wasm32 commit (`flye/NOTES.md`).
* **libomp hangs with ≥ 6 threads** in contended `omp critical` / `omp_set_lock` with its
  default queuing locks (reproduced with a 20-line program; independent of Memory64, allocator,
  pool size, KMP_BLOCKTIME). Test-and-set locks work: `omp_env.js` sets `KMP_LOCK_KIND=tas`.
  SPAdes hits it in graph construction (`ReclaimingIdDistributor::acquire()`).
* **`KMP_BLOCKTIME=0`** (also in `omp_env.js`): idle OpenMP threads sleep at once instead of
  spinning 200 ms. 8 threads: 100× 15.2 → 12.5 s, 1000× 174 → 164 s; 4 threads unchanged.
* **Filesystem calls are proxied to one thread.** Every MEMFS/WORKERFS call from a pthread
  runs on the runtime thread, and k-mer counting writes and mmaps 10 bucket files per thread.
  So for small data 8 threads are slower than 4 (12.5 s vs 10.3 s, the difference all in graph
  construction); for deep data 8 still win (164 s vs 190 s at 1000×). WasmFS (in-wasm
  filesystem, no proxying) might remove this; untested.
* **`long double` is software binary128 on wasm**: boost::math promotes double to long
  double by default, which made the k-mer coverage model fit 25× slower.
  `BOOST_MATH_PROMOTE_DOUBLE_POLICY=false` fixes it and matches native arm64, where
  long double == double.
* **Heap bloat from MEMFS `mmap` + mimalloc** (fixed by `mmap_alloc.js`). SPAdes mmaps every
  k-mer bucket file. For an in-memory (MEMFS) file Emscripten copies it into a 64 KiB-aligned
  heap block (`mmapAlloc` → `emscripten_builtin_memalign(65536, …)`, on the runtime thread);
  Emscripten's mimalloc (v3.5) served each of these from fresh memory, so the heap grew by
  ~6 GB per k-mer size at 8 threads (peak 14.4 GB, near the 16 GB cap; a 16-thread machine
  would abort). `mmap_alloc.js` overrides `mmapAlloc` to use a 16-byte-aligned block (still
  freed by `munmap`). Found by logging `WebAssembly.Memory.grow` with wasm stack traces
  (`--profiling-funcs` build + a `node --import` hook that patches `Memory.prototype.grow`,
  which also loads in the pthread workers).
* **k-mer splitting buffers**: with `read_buffer_size 0` SPAdes sizes them from the free
  memory, which reads as unlimited under Emscripten, so it takes its 512 MB-per-thread
  maximum. The browser sets 64 MB. Outputs do not depend on it (checked: 16, 64, 256 MB, auto).
* **Heap size vs resident memory**: mimalloc still reserves more heap than dlmalloc (2.0 GB vs
  0.9 GB at 8 threads), but max RSS is the same (~0.9 GB), and mimalloc is faster (14.3 s vs
  18.0 s at 8 threads; 9.9 s vs 11.5 s at 4). dlmalloc's single lock is the cost (cf. Flye's
  polisher, 35× slower with dlmalloc).
* **Busy machines**: during heavy system load (load average ~19: Spotlight indexing and
  other daemons) the browser's renderer processes got ~8% CPU: Flye on sample B took 2.5 min
  (7 threads, `--asm-coverage 50`), and a 4-thread run spent 18 s on read statistics
  (normally < 1 s). Once the load dropped, the 4-thread run took 11.7 s with the tab hidden,
  as in a visible tab, so this was contention, not background-tab throttling. `/assemble`
  warns before leaving the page while an assembly runs (that kills the worker).

## Validation

Byte-identical to native SPAdes 4.2.0 (`spades.py --isolate`, macOS arm64) for all 8 output
files (contigs, scaffolds, GFA, FASTG, contigs/scaffolds paths, before_rr,
assembly_graph_after_simplification):

| Dataset | Runs compared |
|---|---|
| Phage, 100× (wgsim, 2×150 bp, 30.7k pairs) | Node CLI builds via spades.py: single-threaded and OpenMP t1, OpenMP t8. JS driver + web module: t1, t4, t8; read_buffer_size auto/16/64/256 MB; KMP_BLOCKTIME default/0 |
| Two strains + contamination (`mix_*`, 21 contigs) | JS driver t1 |
| Phage, 1000× (300k pairs, 0.5% errors) | JS driver t8 and t4 (KMP_BLOCKTIME default/0) vs native t8 |

Biology: the 1000× main contig is the true genome exactly (plus the 77 bp overlap, trimmed by
the page); the 38 extra contigs are 228–293 bp error debris at ~1–2× coverage, which the
page's default selection (≥ 1 kb, ≥ 20% of the top coverage) leaves out. Subsamples of 100k,
200k pairs and (in the browser) 10k pairs also give the exact genome.

`web/tests/spades-node-run.mjs R1 R2 OUT [threads] [read_buffer_mb]` runs the browser driver
and module under Node (`SPADES_MJS=` another build; OMP_*/KMP_* are passed through);
`compare_runs.py` compares two run trees.

## Benchmarks (Apple M1 Pro, 8 cores, 16 GB)

100× phage, 2×150 bp (k = 21,33,55,77), wall time:

| | 1 thread | 4 threads | 8 threads |
|---|---|---|---|
| native (spades.py) | 16.3 s | 6.2 s | 5.8 s |
| WASM, JS driver (Node) | 24 s | 10.3 s | 12.5 s |
| WASM, in the browser (`/assemble`, 7 threads) | | | 11 s |

Peak heap (WASM) at 1/4/8 threads: 0.6 / 1.2 / 2.0 GB; resident ~0.8–0.9 GB.

1000× phage (300k pairs), 8 threads: native 99.8 s, peak RSS 1.6 GB; WASM (Node) 164 s, peak
heap 2.7 GB, RSS 2.6 GB (the difference is SPAdes' temporary files, in memory here).
Per k: 21: 13 vs 28 s, 33: 16 vs 29 s, 55: 35 vs 56 s, 77: 36 vs 60 s.

Subsampled (WASM, Node, 8 threads): 100k pairs 51 s (RSS 1.85 GB), 200k pairs 111 s
(RSS 2.09 GB); both give the exact genome.

## Limitations / next steps

* Memory: temporary files live in MEMFS (JS memory), so very deep datasets cost RAM;
  the page subsamples to 200,000 pairs by default.
* Thread scaling is limited by proxied filesystem calls (see Findings); WasmFS is the
  candidate fix.
* wasm32 build for browsers without Memory64.
* Only `--isolate`; no BayesHammer error correction (also off in native `--isolate`).
