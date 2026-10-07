// SPAdes `--isolate` pipeline without Python: a port of the parts of spades.py
// that --isolate uses (k-mer selection, per-k config generation, one
// spades-core run per k, copying the final outputs), for the spades-core
// WebAssembly module. Each k runs in a fresh module instance (no state shared
// between runs); only K<k>/simplified_contigs is carried to the next k, as in
// spades.py. Works in the browser (Web Worker) and in Node (tests).
//
//   import {runSpadesIsolate} from "./spades-driver.js";
//   const outputs = await runSpadesIsolate({createModule, libraries, threads, mountInputs, onLine});

export const K_MERS_SHORT = [21, 33, 55];
export const K_MERS_150 = [21, 33, 55, 77];
export const K_MERS_250 = [21, 33, 55, 77, 99, 127];
const GAP_CLOSER_ENABLE_MIN_K = 55;
const CONFIG_DIR = "/spades/configs/debruijn";	// embedded templates
const OUT = "/out";

// stages.spades_stage: default k-mer sizes for --isolate
export function chooseKmers(readLength) {
  let kmers = K_MERS_SHORT;
  if (readLength >= 250) kmers = K_MERS_250;
  else if (readLength >= 150) kmers = K_MERS_150;
  if (readLength <= Math.max(...kmers)) kmers = kmers.filter((k) => k < readLength);
  return kmers;
}

// support.get_max_reads_length: longest of the first `numChecked` records
export async function maxReadLength(stream, numChecked = 10000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let lineNo = 0;
  let records = 0;
  let longest = 0;
  let fasta = null;
  let current = 0;
  const finish = () => { if (fasta && current > 0) longest = Math.max(longest, current); };
  while (records < numChecked) {
    const {value, done} = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, {stream: true});
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0 && records < numChecked) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (fasta === null && line) fasta = line[0] === ">";
      if (fasta) {
        if (line.startsWith(">")) {
          if (current > 0) { longest = Math.max(longest, current); records++; }
          current = 0;
        } else {
          current += line.length;
        }
      } else {
        if (lineNo % 4 === 1) { longest = Math.max(longest, line.length); records++; }
        lineNo++;
      }
    }
  }
  if (records < numChecked) finish();
  await reader.cancel().catch(() => {});
  return longest;
}

// process_cfg.vars_from_lines: the variable name a config line defines, or null
function varFromLine(line) {
  let l = line.split(";")[0].trim();				// skip_info_comment
  if (l.endsWith('"')) {							// skip_double_quotes
    l = l.slice(0, -1).trim().replace('"', "");
  }
  const tokens = l.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0][0];						// valid_var_name only checks the first symbol
  if (!(/[A-Za-z]/.test(first) || first === "_")) return null;
  return tokens[0];
}

// process_cfg.substitute_params: rewrite "key value" lines, keeping indentation;
// when a name occurs several times, the last occurrence is the one replaced
export function substituteParams(text, values) {
  const lines = text.split("\n");
  const index = new Map();
  lines.forEach((line, i) => {
    const name = varFromLine(line);
    if (name !== null) index.set(name, {i, indent: line.slice(0, line.length - line.trimStart().length)});
  });
  for (const [key, value] of Object.entries(values)) {
    const hit = index.get(key);
    if (!hit) throw new Error(`Couldn't find ${key} in config`);
    lines[hit.i] = `${hit.indent}${key} ${value}`;
  }
  return lines.join("\n");
}

const bool = (b) => (b ? "true" : "false");

// stages.spades_iteration_stage.prepare_config_spades for --isolate defaults
export function configForK(template, {k, lastOne, prevK, tmpDir, threads, memoryGb, outDir = OUT,
                                      sewageMatrix = "/spades/sewage/usher_barcodes.csv"}) {
  const values = {
    K: k,
    dataset: `${outDir}/dataset.info`,
    output_base: outDir,
    tmp_dir: tmpDir,
    use_additional_contigs: bool(Boolean(prevK)),
    main_iteration: bool(lastOne),
    entry_point: "read_conversion",
    load_from: `${outDir}/K${k}/saves`,
    developer_mode: "false",
    sewage: "false",
    sewage_matrix: sewageMatrix,
    time_tracer_enabled: "false",
    gap_closer_enable: bool(lastOne || k >= GAP_CLOSER_ENABLE_MIN_K),
    rr_enable: bool(lastOne),
    gfa11: "false",
    max_threads: threads,
    max_memory: memoryGb,
    save_gp: "false",
    use_coverage_threshold: "false",
  };
  if (prevK) values.additional_contigs = `${outDir}/K${prevK}/simplified_contigs`;
  if (!lastOne) values.correct_mismatches = "false";
  return substituteParams(template, values);
}

// the dataset YAML as spades.py writes it: pyyaml.dump(default_flow_style=False,
// default_style='"'), i.e. sorted keys, every scalar double-quoted, ints tagged
export function datasetYaml(libraries) {
  const out = [];
  libraries.forEach((lib, i) => {
    const entry = {number: i + 1, type: lib.type};
    if (lib.type === "paired-end") entry.orientation = "fr";
    for (const [key, field] of [["left reads", "left"], ["right reads", "right"],
                                ["interlaced reads", "interlaced"], ["single reads", "single"]]) {
      if (lib[field] && lib[field].length) entry[key] = lib[field];
    }
    Object.keys(entry).sort().forEach((key, j) => {
      const prefix = j === 0 ? "- " : "  ";
      const value = entry[key];
      if (Array.isArray(value)) {
        out.push(`${prefix}"${key}":`);
        for (const f of value) out.push(`  - "${f}"`);
      } else if (typeof value === "number") {
        out.push(`${prefix}"${key}": !!int "${value}"`);
      } else {
        out.push(`${prefix}"${key}": "${value}"`);
      }
    });
  });
  return out.join("\n") + "\n";
}

function mkdirs(FS, path) {
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) {
    cur += "/" + part;
    try { FS.mkdir(cur); } catch (e) { /* exists */ }
  }
}

function readTree(FS, dir) {
  const files = {};
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    const st = FS.stat(path);
    if (FS.isDir(st.mode)) {
      for (const [sub, data] of Object.entries(readTree(FS, path))) files[`${name}/${sub}`] = data;
    } else {
      files[name] = FS.readFile(path);
    }
  }
  return files;
}

function writeTree(FS, dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const path = `${dir}/${rel}`;
    mkdirs(FS, path.slice(0, path.lastIndexOf("/")));
    FS.writeFile(path, data);
  }
}

function randomSuffix() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789_";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// The final outputs of spades.py --isolate (copied from the last K directory)
const FINAL_OUTPUTS = [
  ["before_rr.fasta", "before_rr.fasta"],
  ["assembly_graph_after_simplification.gfa", "assembly_graph_after_simplification.gfa"],
  ["final_contigs.fasta", "contigs.fasta"],
  ["first_pe_contigs.fasta", "first_pe_contigs.fasta"],
  ["strain_graph.gfa", "strain_graph.gfa"],
  ["scaffolds.fasta", "scaffolds.fasta"],
  ["scaffolds.paths", "scaffolds.paths"],
  ["assembly_graph_with_scaffolds.gfa", "assembly_graph_with_scaffolds.gfa"],
  ["assembly_graph.fastg", "assembly_graph.fastg"],
  ["final_contigs.paths", "contigs.paths"],
];

// Runs one spades-core invocation in a fresh module instance.
async function runCore({createModule, args, prepare, collect, onLine}) {
  let finished;
  const exited = new Promise((resolve) => { finished = resolve; });
  const mod = await createModule({
    noInitialRun: true,
    print: onLine,
    printErr: onLine,
    onExit: (code) => finished(code),
    onAbort: (what) => finished({abort: String(what)}),
  });
  prepare(mod);
  mod.callMain(args);
  const code = await exited;
  if (typeof code === "object") throw new Error(`spades-core aborted: ${code.abort}`);
  if (code !== 0) throw new Error(`spades-core exited with code ${code}`);
  return collect(mod);
}

/**
 * libraries: [{type: "paired-end", left: [path], right: [path]} | {type: "single", single: [path]}]
 *   with paths as seen inside the module (mountInputs puts the files there).
 * mountInputs(mod): mounts the read files into a module instance (WORKERFS / NODEFS).
 * readLength: optional; otherwise pass readLengthOf (async () => number).
 * readBufferMb: k-mer splitting buffer per thread (construction.info read_buffer_size).
 *   0 = SPAdes' autodetection, which caps it at 512 MB but sizes it from the free
 *   memory: under Emscripten that reads as unlimited, so it always takes 512 MB per
 *   thread (a 14 GB heap at 8 threads). It only sets how often k-mers are flushed
 *   to the (in-memory) temporary files; the assembly is the same.
 */
export async function runSpadesIsolate({createModule, libraries, threads = 1, memoryGb = 250,
                                        readBufferMb = 0, mountInputs, readLength, readLengthOf,
                                        onLine = () => {}}) {
  const rl = readLength || await readLengthOf();
  const kmers = chooseKmers(rl);
  onLine(`[spades-driver] read length ${rl}, k-mer sizes ${kmers.join(",")}`);
  if (!kmers.length) throw new Error(`reads are too short for SPAdes (read length ${rl})`);

  const tmpDir = `${OUT}/tmp/spades_${randomSuffix()}`;
  const yaml = datasetYaml(libraries);
  let carried = null;	// K<prev>/simplified_contigs files
  let outputs = null;

  for (let i = 0; i < kmers.length; i++) {
    const k = kmers[i];
    const prevK = i > 0 ? kmers[i - 1] : null;
    const lastOne = i === kmers.length - 1;
    onLine(`===== K${k} =====`);
    const result = await runCore({
      createModule, onLine,
      args: [`${OUT}/K${k}/configs/config.info`, `${OUT}/K${k}/configs/isolate_mode.info`],
      prepare: (mod) => {
        const {FS} = mod;
        mountInputs(mod);
        mkdirs(FS, tmpDir);
        mkdirs(FS, `${OUT}/K${k}/configs`);
        for (const name of FS.readdir(CONFIG_DIR)) {
          if (!name.endsWith(".info")) continue;
          let text = FS.readFile(`${CONFIG_DIR}/${name}`, {encoding: "utf8"});
          if (name === "config.info") {
            text = configForK(text, {k, lastOne, prevK, tmpDir, threads, memoryGb});
          } else if (name === "construction.info" && readBufferMb) {
            text = substituteParams(text, {read_buffer_size: readBufferMb});
          }
          FS.writeFile(`${OUT}/K${k}/configs/${name}`, text);
        }
        FS.writeFile(`${OUT}/input_dataset.yaml`, yaml);
        FS.writeFile(`${OUT}/dataset.info`, `reads\t${OUT}/input_dataset.yaml\n`);
        if (prevK) writeTree(FS, `${OUT}/K${prevK}/simplified_contigs`, carried);
      },
      collect: (mod) => {
        const {FS} = mod;
        if (!lastOne) return {carry: readTree(FS, `${OUT}/K${k}/simplified_contigs`)};
        const files = {};
        for (const [src, dst] of FINAL_OUTPUTS) {
          try {
            files[dst] = FS.readFile(`${OUT}/K${k}/${src}`, {encoding: "utf8"});
          } catch (e) { /* not produced */ }
        }
        try { files["spades.log"] = FS.readFile(`${OUT}/spades.log`, {encoding: "utf8"}); } catch (e) {}
        return {files};
      },
    });
    if (lastOne) outputs = result.files;
    else carried = result.carry;
  }
  return outputs;
}

// Unicycler-style clean-up for circular contigs: SPAdes writes a circular
// component as one sequence whose last (overlap) bases repeat its first ones,
// with a self-loop link "L id + id + <ov>M" in the GFA and the path tagged
// TP:Z:circular. Trims that overlap so circular genomes have no duplicated end.
export function trimCircularOverlaps(contigsFasta, gfaText) {
  const selfLoops = new Map();
  const segments = new Map();
  const circularPaths = new Map();
  for (const line of gfaText.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "S") segments.set(f[1], f[2]);
    else if (f[0] === "L" && f[1] === f[3] && f[2] === f[4]) {
      const m = /^(\d+)M$/.exec(f[5] || "");
      if (m) selfLoops.set(f[1], Number(m[1]));
    } else if (f[0] === "P" && line.includes("TP:Z:circular")) {
      circularPaths.set(f[1], f[2]);
    }
  }
  const trimmed = [];
  const out = [];
  let header = null;
  let seq = [];
  const flush = () => {
    if (header === null) return;
    let s = seq.join("");
    const name = header.split(/\s/)[0];
    const path = circularPaths.get(name);
    if (path && /^[^,]+[+-]$/.test(path)) {
      const seg = path.slice(0, -1);
      const ov = selfLoops.get(seg);
      if (ov && s.length > 2 * ov && s.slice(0, ov) === s.slice(s.length - ov)) {
        s = s.slice(0, s.length - ov);
        // keep SPAdes' naming consistent: NODE_1_length_<new length>_cov_...
        const newName = name.replace(/_length_\d+_/, `_length_${s.length}_`);
        header = newName + header.slice(name.length);
        trimmed.push({name, newName, overlap: ov, length: s.length});
      }
    }
    out.push(`>${header}`);
    for (let i = 0; i < s.length; i += 60) out.push(s.slice(i, i + 60));
  };
  for (const line of contigsFasta.split("\n")) {
    if (line.startsWith(">")) { flush(); header = line.slice(1).trim(); seq = []; }
    else if (line.trim()) seq.push(line.trim());
  }
  flush();
  return {fasta: out.join("\n") + "\n", trimmed};
}
