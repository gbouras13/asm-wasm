# asm_wasm — phage genome assembly in the browser

Long-read (Flye) and short-read (SPAdes) phage assembly compiled to WebAssembly, so
users can assemble reads **on their own computer** and send only the resulting contigs
to [phage-annotation.org](https://phage-annotation.org) for pharokka → phold → phynteny.

Status (2026-10-07):

| Component | State |
|---|---|
| Flye 2.9.6 → WASM | **Working in the browser**, output bit-identical to native Flye (1 thread) |
| Single-process Flye (`flye-modules pipeline`) | Python layer ported to C++; validated identical to stock Flye incl. 1,600× coverage |
| SPAdes 4.2.0 (`--isolate`) → WASM | **Working in the browser**, outputs byte-identical to native SPAdes (1–8 threads, up to 1000× coverage); Python driver replaced by `web/spades-driver.js`; circular overlaps trimmed (Unicycler-style) |
| Server integration (`/assemble`) | **Live on phage-annotation.org** (deployed 2026-10-07, main = `75f9434`): assemble → choose contigs → annotate with the submit page's full options. Verified with a real pharokka → phold → phynteny job |

## Layout

```
asm_wasm/
  flye/
    Flye/            fork of Flye 2.9.6 (git, branch asm-wasm): patches 01-04 + the
                     single-process pipeline (src/pipeline/, ~4k lines C++)
    build_wasm.sh    builds the fork for Node (CLI) and the web (ES module)
    build.sh         earlier approach: upstream Flye + patches, Python driver + WASM binaries
    node_stdio.js    --pre-js fixing piped stdio under Node
    patches/         the four upstreamable patches (also commits in Flye/)
    NOTES.md         findings, validation and benchmarks
  spades/
    build.sh         spades-core → wasm64 for Node + a run tree driven by the unchanged
                     spades.py (validation)
    build_web.sh     relinks it as an ES module for the browser → dist/web/spades
    patches/         three Emscripten patches; omp_env.js, mmap_alloc.js: link-time fixes
    NOTES.md         findings, validation and benchmarks
  web/
    asm-worker.js    Web Worker that runs an assembler module (WORKERFS input, MEMFS output)
    asm-client.js    page API: runAssembly(), memory64Supported(), filterContigs()...
    spades-driver.js spades.py --isolate in JS (k-mer sizes, configs, one run per k) +
                     circular-overlap trimming
    reads.js         streaming (gz) read access + seeded paired subsampling
    demo.html/js/css standalone test page (?auto=URL[,URL2] test hook)
    serve.py         dev server with COOP/COEP + phage-annotation.org's CSP
    sync_to_server.sh  copies the runtime + builds into a phage-annotation-server checkout
    tests/           driver tests, Node runner, circular comparison, dev server for /assemble
  dist/              build outputs (node/, web/)
```

## How it works

* **One WebAssembly module per assembler.** Flye's pipeline normally runs Python, which
  shells out to `flye-modules`, `minimap2` and `samtools`. Browsers can't spawn processes,
  so the Python stages (configure, consensus, polishing, finalize) were ported to C++
  inside `flye-modules pipeline`, minimap2 runs in-process, and the SAM/BAM round trip
  is emulated in memory — with identical results (see `flye/NOTES.md`). The whole
  assembler is a 1.5 MB `.wasm`.
* **Web Worker + threads.** `asm-worker.js` loads the module (Emscripten ES module,
  pthreads via `PROXY_TO_PTHREAD`), mounts the user's read files read-only with WORKERFS
  (no copy into memory), runs the pipeline and returns the output files.
* **Page requirements.** Threads need `SharedArrayBuffer`, i.e. a cross-origin isolated
  page: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` on the page and the assembler's files. Compiling WebAssembly under
  phage-annotation.org's CSP needs `'wasm-unsafe-eval'` (it does not permit JS eval).
* **SPAdes.** spades.py's `--isolate` path is ported to JS (`spades-driver.js`): choose
  k-mer sizes from the read length, write each iteration's configs, run `spades-core` once
  per k in a fresh module instance, carry `simplified_contigs` forward. Circular contigs
  lose SPAdes' duplicated k-bp overlap, so a phage genome appears exactly once. SPAdes'
  temporary files live in memory here, so `/assemble` subsamples to 200,000 read pairs by
  default (a seeded random sample that keeps mates together).
* **Browsers.** Flye's default build is wasm32 (all current browsers incl. Safari);
  `flye64.wasm` (Memory64) is also built for >4 GB use. SPAdes is wasm64 only
  (Chrome/Edge ≥ 133, Firefox ≥ 134); `/assemble` detects Memory64 and explains when
  it is missing.

## Build

```bash
flye/build_wasm.sh node web        # → dist/node, dist/web/flye (≈1 min after the first build)
spades/build.sh                    # spades-core for Node (+ the objects build_web.sh relinks)
spades/build_web.sh                # → dist/web/spades (≈30 s); same WORK as build.sh
web/sync_to_server.sh <phage-annotation-server checkout>
```

Native builds (for debugging / validation): see `flye/NOTES.md` and `spades/NOTES.md`.

## Test locally

```bash
python3 web/serve.py --data /path/to/reads/dir      # http://127.0.0.1:8765/demo.html
# automated: demo.html?auto=/data/reads.fastq.gz&threads=4
#            demo.html?auto=/data/R1.fastq.gz,/data/R2.fastq.gz&mode=illumina&threads=4
node web/tests/spades-driver.test.mjs <native run dir> <config templates dir>
node web/tests/spades-node-run.mjs R1.fq.gz R2.fq.gz OUT [threads]   # SPAdes web module under Node
node web/tests/reads.test.mjs                        # subsampling unit tests
<server venv>/bin/python web/tests/annot_dev_server.py --repo <server checkout>
                                                     # /assemble on :8010, test reads at /devdata
```

Test reads for the dev servers go in `~/.cache/asm-wasm/webdata` (symlinks are fine).

## Server integration (phage-annotation-server)

Merged into the server's `main` and deployed per its HANDOVER.md (rsync `api/` + `web/`,
rebuild the `api` container only):

* `GET /assemble` (`web/templates/assemble.html`, `web/static/js/assemble.js`): pick reads
  and read type (ONT/PacBio → Flye; Illumina paired/single → SPAdes), assemble in the
  browser, tick contigs (pre-selected: long, well-covered; within the 20-contig / 2 Mbp
  limits), then submit them to `POST /jobs` (fetch, JSON) with the same options as the
  submit page: both pages include `web/templates/_annotation_options.html`. Rejections
  show inline; accepted jobs go to My jobs. The local dev server's pipeline is mocked
  (`MOCK_PIPELINE=1`), so real annotations only come from the deployed site.
* `api/main.py`: route; `.wasm`/`.mjs` MIME types; for `/assemble` and `/static/asm/*`
  only: CSP + `'wasm-unsafe-eval'`, COOP/COEP/CORP. All other pages keep the strict CSP.
* `tests/test_assemble.py`: 20 tests (headers scoped to the assembler, MIME types,
  template, option parity with the submit page, JSON rejections); full suite 81 passed.
* Static assets: `web/static/asm/` (~7.5 MB: flye.wasm 1.5 MB, spades.wasm 5.8 MB;
  Caddy's gzip/zstd applies). Not git-ignored: decide whether to commit the builds or
  build them at deploy time.
