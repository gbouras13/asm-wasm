# asm-wasm — phage genome assembly in the browser

[Flye](https://github.com/mikolmogorov/Flye) (long reads) and
[SPAdes](https://github.com/ablab/spades) (Illumina reads) compiled to WebAssembly, so reads
can be assembled **on the user's own computer**: nothing is uploaded. This is what runs on
[phage-annotation.org/assemble](https://phage-annotation.org/assemble), where the assembled
contigs can then be annotated with pharokka → phold → phynteny.

| Component | Status |
|---|---|
| Flye 2.9.6 → WebAssembly | Whole pipeline in one module (Python layer ported to C++); output bit-identical to native Flye. Runs in all current browsers (wasm32). |
| SPAdes 4.2.0 `--isolate` → WebAssembly | `spades.py` reimplemented in JS; all outputs byte-identical to native SPAdes (1–8 threads, up to 1000× coverage). Needs 64-bit WebAssembly memory (Chrome/Edge ≥ 133, Firefox ≥ 134). |
| phage-annotation.org `/assemble` | Live: assemble → choose contigs → annotate. |

Details, validation and benchmarks: [`flye/NOTES.md`](flye/NOTES.md),
[`spades/NOTES.md`](spades/NOTES.md).

## Layout

```
flye/
  Flye/              submodule: Flye 2.9.6 + 5 commits (gbouras13/Flye, branch asm-wasm),
                     including the single-process pipeline in src/pipeline/
  build_wasm.sh      builds it for Node (CLI) and the web (ES module)
  node_stdio.js      --pre-js fixing piped stdio under Node
spades/
  build.sh           spades-core → wasm64 for Node, plus a run tree driven by the unchanged
                     spades.py (used for validation); also builds the objects build_web.sh relinks
  build_web.sh       relinks spades-core as an ES module for the browser
  patches/           Emscripten patches for SPAdes 4.2.0
  omp_env.js, mmap_alloc.js   link-time fixes (OpenMP locks, heap growth)
web/
  asm-client.js      page API: runAssembly(), memory64Supported(), filterContigs(), ...
  asm-worker.js      Web Worker that runs an assembler (WORKERFS input, MEMFS output)
  spades-driver.js   spades.py --isolate in JS + Unicycler-style circular-overlap trimming
  reads.js           streaming (gzip) read access, seeded paired subsampling
  demo.html/js/css   standalone test page; serve.py serves it with the required headers
  sync_to_server.sh  copies the runtime and builds into a phage-annotation-server checkout
  package.sh         makes the release tarball (runtime + web builds + licences)
  tests/
dist/                build outputs (not in git; prebuilt modules are attached to releases)
```

## How it works

* **One WebAssembly module per assembler.** Flye normally runs Python that shells out to
  `flye-modules`, `minimap2` and `samtools`; browsers cannot spawn processes, so the Python
  stages are ported to C++ inside `flye-modules pipeline`, minimap2 runs in-process and the
  SAM/BAM round trip is emulated in memory, with identical results. SPAdes' `--isolate`
  path runs `spades-core` once per k-mer size; `spades-driver.js` does what `spades.py` does
  around it (k-mer sizes from the read length, per-iteration configs, carrying contigs from
  one k to the next), with each k in a fresh module instance.
* **Web Worker + threads.** `asm-worker.js` loads the module (Emscripten ES module, pthreads
  via `PROXY_TO_PTHREAD`), mounts the user's read files read-only with WORKERFS (read
  lazily from disk, not copied into memory), runs the assembler and returns the output files.
* **Circular genomes.** SPAdes writes a circular contig with its first k bases repeated at
  the end; they are trimmed (as Unicycler does), so a phage genome appears exactly once.
* **Deep Illumina runs.** SPAdes' temporary files live in memory in the browser, so
  `reads.js` can subsample to a fixed number of read pairs (seeded; mates stay together).
  `/assemble` uses 200,000 pairs by default.

## Using it in a web page

Serve `web/asm-client.js`, `asm-worker.js`, `spades-driver.js`, `reads.js` and the built
`flye/` and `spades/` directories from one directory (the `asm-wasm-web-*.tar.gz` file of a
[release](https://github.com/gbouras13/asm-wasm/releases) is exactly that), then:

```js
import {runAssembly, isSupported, memory64Supported, parseFasta} from "./asm-client.js";

const job = runAssembly({
  assembler: "spades",                 // or "flye" with options.mode "nano-hq" | "nano-corr" | "pacbio-hifi"
  files: [r1File, r2File],             // File objects; one file = single-end
  options: {threads: 4, maxPairs: 200000},
  onLog: (line) => console.log(line),
  onStages: (stages) => {}, onStage: (name) => {},
});
const {outputs} = await job.result;    // outputs["assembly.fasta"], ["assembly_info.txt"], ...
```

The page and these files must be served with:

* `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  (threads need `SharedArrayBuffer`, i.e. a cross-origin isolated page);
* a CSP that allows `'wasm-unsafe-eval'` in `script-src` and `worker-src 'self'`, if you use
  a CSP;
* `application/wasm` for `.wasm` and a JavaScript MIME type for `.mjs`.

`web/serve.py` is a minimal server that does all of this.

## Build

Requirements: bash, git, Python 3, CMake and make (for SPAdes); the scripts install the
Emscripten SDK (6.0.11, ~1.8 GB) under `~/.cache/asm-wasm/emsdk` on first use.

```bash
git clone --recursive https://github.com/gbouras13/asm-wasm.git
cd asm-wasm
flye/build_wasm.sh node web    # → dist/node, dist/web/flye   (≈1 min after the first build)
spades/build.sh                # spades-core for Node; sources and objects in ~/.cache/asm-wasm/spades
spades/build_web.sh            # → dist/web/spades (relinks, ≈30 s)
```

## Tests

```bash
python3 web/serve.py --data /path/to/reads     # http://127.0.0.1:8765/demo.html
# automated: demo.html?auto=/data/reads.fastq.gz&threads=4
#            demo.html?auto=/data/R1.fastq.gz,/data/R2.fastq.gz&mode=illumina&threads=4
node web/tests/reads.test.mjs                                  # subsampling
node web/tests/spades-driver.test.mjs <native SPAdes run dir> <SPAdes config templates dir>
node web/tests/spades-node-run.mjs R1.fq.gz R2.fq.gz OUT [threads]   # SPAdes web module under Node
python3 web/tests/compare_circular.py truth.fasta assembly.fasta     # same genome up to rotation?
```

Use Node ≥ 24 (Emscripten's, in `~/.cache/asm-wasm/emsdk/node/`, works).
`web/tests/annot_dev_server.py --repo <phage-annotation-server checkout>` runs the annotation
server locally (its pipeline is mocked) with test reads served at `/devdata`.

## phage-annotation-server

`web/sync_to_server.sh <checkout>` copies the runtime and the web builds into the server's
`web/static/asm/`. The server's `/assemble` page (`web/templates/assemble.html`,
`web/static/js/assemble.js`) submits the chosen contigs to `POST /jobs` with the same options
as its submit page.

## License

GPL-2.0 (see [`LICENSE`](LICENSE)). The builds contain Flye (BSD-3-Clause), SPAdes
(GPL-2.0) and other components under their own licenses: see
[`THIRD_PARTY.md`](THIRD_PARTY.md). If you use assemblies made with these builds, please cite
Flye and SPAdes (references in `THIRD_PARTY.md`).
