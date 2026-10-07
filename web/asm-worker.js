// Runs a WebAssembly assembler inside a Web Worker.
//
// Message in:  {type: "run", assembler: "flye" | "spades", files: [File...], options: {...}}
// Messages out: {type: "log", line} | {type: "stages", stages: [[name, label]...]} |
//               {type: "stage", name} | {type: "done", code, outputs: {name: text}} |
//               {type: "error", message}
//
// Both assemblers return the same core outputs: assembly.fasta, assembly_info.txt
// (Flye's column layout) and assembly_graph.gfa, plus their own extra files.
// The assembler modules (Emscripten, ES modules) are loaded from this
// directory. Reads are mounted read-only with WORKERFS, so they are read
// lazily from the user's disk rather than copied into memory.

import {runSpadesIsolate, maxReadLength, trimCircularOverlaps} from "./spades-driver.js";
import {readStream, subsampleReads} from "./reads.js";

const FLYE_STAGES = [
  ["configure", "Read statistics"], ["assembly", "Disjointigs"], ["consensus", "Consensus"],
  ["repeat", "Repeat graph"], ["contigger", "Contigs"], ["polishing", "Polishing"],
  ["finalize", "Finalise"],
];
const FLYE_MODES = {
  "nano-hq": "--nano-hq", "nano-raw": "--nano-raw", "nano-corr": "--nano-corr",
  "pacbio-hifi": "--pacbio-hifi", "pacbio-raw": "--pacbio-raw", "pacbio-corr": "--pacbio-corr",
};

// SPAdes: the k-mer sizes depend on the read length, so the real list (one stage
// per k) replaces this placeholder once the reads have been checked
const SPADES_INITIAL_STAGES = [["reads", "Read length"], ["kmers", "de Bruijn graphs"], ["finalize", "Finalise"]];
// k-mer splitting buffer per thread (SPAdes' own default is 512 MB per thread, which
// only inflates the WebAssembly heap; the assembly does not depend on it)
const SPADES_READ_BUFFER_MB = 64;

const STAGE_RE = />>>STAGE: (\S+)/;
const KMER_RE = /^===== K(\d+) =====$/;
const ERROR_RE = /\bERROR:? (.*)$/;
let lastError = "";

function post(message) {
  self.postMessage(message);
}

function onLine(line) {
  post({type: "log", line});
  const m = STAGE_RE.exec(line);
  if (m) post({type: "stage", name: m[1]});
  const k = KMER_RE.exec(line);
  if (k) post({type: "stage", name: `k${k[1]}`});
  const e = ERROR_RE.exec(line);
  if (e && e[1] !== "Pipeline aborted") lastError = e[1];
}

// keep the original extension (the assemblers detect the format from it) but
// give each file a safe name: paths with spaces are rejected
function inputName(file, index) {
  const match = /\.(fasta|fa|fastq|fq)(\.gz)?$/i.exec(file.name);
  if (!match) throw new Error(`unsupported file type: ${file.name} (expected .fastq/.fq/.fasta/.fa, optionally .gz)`);
  return `reads_${index + 1}${match[0].toLowerCase()}`;
}

function mountReads(mod, blobs) {
  mod.FS.mkdir("/input");
  mod.FS.mount(mod.FS.filesystems.WORKERFS, {blobs}, "/input");
}

function reportMemory(mod) {
  // WebAssembly memory only grows, so its final size is the peak
  if (mod.HEAPU8) {
    onLine(`[asm-worker] peak WebAssembly memory: ${Math.round(mod.HEAPU8.buffer.byteLength / 1048576)} MB`);
  }
}

async function runFlye(files, options) {
  const flag = FLYE_MODES[options.mode || "nano-hq"];
  if (!flag) throw new Error(`unknown read mode: ${options.mode}`);
  post({type: "stages", stages: FLYE_STAGES});

  const {default: createFlye} = await import("./flye/flye.mjs");
  let finished;
  const exited = new Promise((resolve) => { finished = resolve; });
  const mod = await createFlye({
    noInitialRun: true,
    print: onLine,
    printErr: onLine,
    onExit: (code) => finished(code),
    onAbort: (what) => finished({abort: String(what)}),
  });

  const blobs = files.map((file, i) => ({name: inputName(file, i), data: file}));
  mountReads(mod, blobs);
  const args = ["pipeline", flag, ...blobs.map((b) => `/input/${b.name}`), "--out-dir", "/out",
                "--threads", String(options.threads || 1)];
  if (options.genomeSize) args.push("--genome-size", String(options.genomeSize));
  if (options.asmCoverage) args.push("--asm-coverage", String(options.asmCoverage));
  if (options.meta) args.push("--meta");
  if (options.iterations !== undefined) args.push("--iterations", String(options.iterations));
  if (options.minOverlap) args.push("--min-overlap", String(options.minOverlap));
  onLine(`[asm-worker] flye ${args.join(" ")}`);

  // with PROXY_TO_PTHREAD main() runs on its own thread; completion arrives via onExit
  mod.callMain(args);
  const code = await exited;
  if (typeof code === "object") throw new Error(`assembler aborted: ${code.abort}`);
  reportMemory(mod);

  const outputs = {};
  for (const name of ["assembly.fasta", "assembly_info.txt", "assembly_graph.gfa", "flye.log"]) {
    try {
      outputs[name] = mod.FS.readFile(`/out/${name}`, {encoding: "utf8"});
    } catch (e) {
      // missing outputs are reported by the absence of the key
    }
  }
  return {code, outputs};
}

// assembly_info.txt in Flye's layout for SPAdes contigs (k-mer coverage, circularity
// from the TP:Z:circular paths of the assembly graph)
function spadesInfo(fasta, gfa, trimmedNames) {
  const circular = new Set();
  const paths = new Map();
  for (const line of gfa.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "P") {
      paths.set(f[1], f[2].replace(/[+-]/g, ""));
      if (line.includes("TP:Z:circular")) circular.add(f[1]);
    }
  }
  const rows = ["#seq_name\tlength\tcov.\tcirc.\trepeat\tmult.\talt_group\tgraph_path"];
  let name = null;
  let length = 0;
  const flush = () => {
    if (name === null) return;
    const original = trimmedNames.get(name) || name;
    const cov = /_cov_([\d.]+)/.exec(name);
    rows.push([name, length, cov ? Math.round(Number(cov[1])) : 0,
               circular.has(original) ? "Y" : "N", "N", 1, "*", paths.get(original) || "*"].join("\t"));
  };
  for (const line of fasta.split("\n")) {
    if (line.startsWith(">")) { flush(); name = line.slice(1).trim().split(/\s/)[0]; length = 0; }
    else length += line.trim().length;
  }
  flush();
  return rows.join("\n") + "\n";
}

// Illumina reads: one file = single-end, two files = a pair (R1 = the name that sorts first)
function orderReads(files) {
  if (files.length === 1) return files;
  if (files.length === 2) return [...files].sort((a, b) => (a.name < b.name ? -1 : 1));
  throw new Error("SPAdes: select one file (single-end reads) or two files (paired-end R1 and R2)");
}

function spadesLibraries(blobs) {
  if (blobs.length === 1) return [{type: "single", single: [`/input/${blobs[0].name}`]}];
  return [{type: "paired-end", left: [`/input/${blobs[0].name}`], right: [`/input/${blobs[1].name}`]}];
}

// Compiles a WebAssembly module once (each SPAdes k-mer iteration instantiates it
// afresh, and the instances share the engine's optimised code).
async function compileWasm(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url.pathname}: HTTP ${response.status}`);
  if (typeof WebAssembly.compileStreaming === "function" &&
      (response.headers.get("content-type") || "").startsWith("application/wasm")) {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function runSpades(files, options) {
  files = orderReads(files);
  files.forEach((file, i) => inputName(file, i));	// reject unsupported files early
  post({type: "stages", stages: SPADES_INITIAL_STAGES});
  post({type: "stage", name: "reads"});
  if (files.length === 2) onLine(`[asm-worker] paired-end reads: R1 = ${files[0].name}, R2 = ${files[1].name}`);
  else onLine(`[asm-worker] single-end reads: ${files[0].name}`);
  if (options.maxPairs) files = await subsampleReads(files, options.maxPairs, onLine);
  const blobs = files.map((file, i) => ({name: inputName(file, i), data: file}));
  const libraries = spadesLibraries(blobs);
  const [{default: createSpades}, wasm] = await Promise.all([
    import("./spades/spades.mjs"),
    compileWasm(new URL("./spades/spades.wasm", import.meta.url)),
  ]);

  const log = [];
  let peakBytes = 0;
  let current = null;
  // WebAssembly memory only grows: a finished instance's size is its peak
  const notePeak = () => {
    if (current && current.HEAPU8) peakBytes = Math.max(peakBytes, current.HEAPU8.buffer.byteLength);
    current = null;
  };
  const outputs = await runSpadesIsolate({
    createModule: async (args) => {
      notePeak();
      current = await createSpades({
        ...args,
        instantiateWasm: (imports, receive) => {
          WebAssembly.instantiate(wasm, imports).then((instance) => receive(instance, wasm));
          return {};
        },
      });
      return current;
    },
    libraries,
    threads: options.threads || 1,
    readBufferMb: SPADES_READ_BUFFER_MB,
    mountInputs: (mod) => mountReads(mod, blobs),
    readLengthOf: async () => {
      const lengths = [];
      for (const file of files) lengths.push(await maxReadLength(readStream(file)));
      return Math.min(...lengths);
    },
    onLine: (line) => {
      log.push(line);
      const m = /k-mer sizes ([\d,]+)/.exec(line);
      if (m) {
        post({type: "stages", stages: [["reads", "Read length"],
          ...m[1].split(",").map((k) => [`k${k}`, `k = ${k}`]), ["finalize", "Finalise"]]});
        post({type: "stage", name: "reads"});
      }
      onLine(line);
    },
  });
  notePeak();
  onLine(`[asm-worker] peak WebAssembly memory: ${Math.round(peakBytes / 1048576)} MB`);
  post({type: "stage", name: "finalize"});

  const gfa = outputs["assembly_graph_with_scaffolds.gfa"] || "";
  const trimmed = trimCircularOverlaps(outputs["contigs.fasta"] || "", gfa);
  const trimmedNames = new Map();
  for (const t of trimmed.trimmed) {
    onLine(`[asm-worker] ${t.name}: circular, removed the ${t.overlap} bp overlap at the end ` +
           `(now ${t.length} bp, renamed ${t.newName})`);
    trimmedNames.set(t.newName, t.name);
  }
  return {
    code: 0,
    outputs: {
      "assembly.fasta": trimmed.fasta,
      "assembly_info.txt": spadesInfo(trimmed.fasta, gfa, trimmedNames),
      "assembly_graph.gfa": gfa,
      "contigs.fasta": outputs["contigs.fasta"],
      "scaffolds.fasta": outputs["scaffolds.fasta"],
      "spades.log": log.join("\n") + "\n",
    },
  };
}

async function run({assembler, files, options}) {
  if (!files || !files.length) throw new Error("no input files");
  let result;
  if (assembler === "flye") result = await runFlye(files, options || {});
  else if (assembler === "spades") result = await runSpades(files, options || {});
  else throw new Error(`unknown assembler: ${assembler}`);
  post({type: "done", code: result.code, outputs: result.outputs,
        error: result.code === 0 ? "" : lastError});
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== "run") return;
  run(msg).catch((err) => {
    const message = String(err && err.message || err);
    post({type: "error", message: lastError && !message.includes(lastError) ? `${message}: ${lastError}` : message});
  });
};
