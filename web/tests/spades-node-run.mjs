// Runs SPAdes --isolate through spades-driver.js (no Python) with the web
// build of spades-core under Node, for comparison with native spades.py.
//
//   node tests/spades-node-run.mjs R1.fastq.gz R2.fastq.gz OUT_DIR [threads] [read_buffer_mb]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {Readable} from "node:stream";
import {runSpadesIsolate, maxReadLength} from "../spades-driver.js";

// SPADES_MJS: another build of the module (default: asm_wasm/dist/web/spades/spades.mjs)
const {default: createSpades} = await import(process.env.SPADES_MJS
  ? path.resolve(process.env.SPADES_MJS) : "../../dist/web/spades/spades.mjs");
const [r1, r2, outDir, threadsArg, bufferArg] = process.argv.slice(2);
const threads = Number(threadsArg || 1);
const readBufferMb = Number(bufferArg || 0);
const dataDir = path.dirname(path.resolve(r1));
if (path.dirname(path.resolve(r2)) !== dataDir) throw new Error("R1 and R2 must be in one directory");

const streamOf = (file) => {
  let s = fs.createReadStream(file);
  if (file.endsWith(".gz")) s = s.pipe(zlib.createGunzip());
  return Readable.toWeb(s);
};

const t0 = Date.now();
let peak = 0;
let current = null;
const notePeak = () => { if (current) peak = Math.max(peak, current.HEAPU8.buffer.byteLength); current = null; };
const outputs = await runSpadesIsolate({
  // OMP_* / KMP_* from the host environment reach libomp (the module has its own environment)
  createModule: async (args) => {
    notePeak();
    const omp = Object.entries(process.env).filter(([k]) => /^(OMP|KMP)_/.test(k));
    const preRun = (mod) => { for (const [k, v] of omp) mod.ENV[k] = v; };
    return (current = await createSpades({...args, preRun}));
  },
  readBufferMb,
  libraries: [{type: "paired-end", left: [`/input/${path.basename(r1)}`],
               right: [`/input/${path.basename(r2)}`]}],
  threads,
  mountInputs: (mod) => {
    mod.FS.mkdir("/input");
    mod.FS.mount(mod.FS.filesystems.NODEFS, {root: dataDir}, "/input");
  },
  readLengthOf: async () => Math.min(await maxReadLength(streamOf(r1)), await maxReadLength(streamOf(r2))),
  onLine: (line) => process.stderr.write(line + "\n"),
});
fs.mkdirSync(outDir, {recursive: true});
for (const [name, text] of Object.entries(outputs)) fs.writeFileSync(path.join(outDir, name), text);
notePeak();
console.log(`wrote ${Object.keys(outputs).length} files to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)} s; ` +
            `peak WebAssembly memory ${Math.round(peak / 1048576)} MB`);
