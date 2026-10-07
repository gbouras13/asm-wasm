// Page-side API for in-browser assembly (ES module, no dependencies).
//
//   import {runAssembly, filterContigs} from "./asm-client.js";
//   const job = runAssembly({assembler: "flye", files, options: {mode: "nano-hq", threads: 8},
//                            onLog: (line) => ..., onStage: (name) => ...,
//                            onStages: ([[name, label], ...]) => ...});
//   (assembler "spades": Illumina reads, one file = single-end, two = R1 + R2)
//   const {outputs} = await job.result;     // outputs["assembly.fasta"], ...
//   job.cancel();                            // terminates the worker
//
// Multithreading needs a cross-origin isolated page (COOP: same-origin,
// COEP: require-corp) for SharedArrayBuffer.

export function isSupported() {
  return typeof WebAssembly === "object" && typeof Worker === "function" &&
         self.crossOriginIsolated === true;
}

// The SPAdes build uses 64-bit WebAssembly memory (Memory64: Chrome/Edge >= 133,
// Firefox >= 134); the Flye build is wasm32 and runs in any browser with threads.
// The bytes are the smallest module with a 64-bit memory: (module (memory i64 0)).
export function memory64Supported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]));
  } catch (e) {
    return false;
  }
}

export function defaultThreads(max = 8) {
  const n = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(max, n - 1));
}

export function runAssembly({assembler = "flye", files, options = {}, onLog, onStage, onStages} = {}) {
  const worker = new Worker(new URL("./asm-worker.js", import.meta.url), {type: "module"});
  let settled = false;
  const result = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "log") {
        if (onLog) onLog(msg.line);
      } else if (msg.type === "stage") {
        if (onStage) onStage(msg.name);
      } else if (msg.type === "stages") {
        if (onStages) onStages(msg.stages);
      } else if (msg.type === "done") {
        settled = true;
        worker.terminate();
        if (msg.code !== 0) reject(new Error(msg.error || `assembler exited with code ${msg.code}`));
        else resolve({outputs: msg.outputs});
      } else if (msg.type === "error") {
        settled = true;
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(event.message || "worker error"));
    };
  });
  worker.postMessage({type: "run", assembler, files: Array.from(files), options});
  return {
    result,
    cancel() {
      if (!settled) {
        settled = true;
        worker.terminate();
      }
    },
  };
}

export function parseFasta(text) {
  const records = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(">")) {
      current = {header: line.slice(1), seq: ""};
      records.push(current);
    } else if (current) {
      current.seq += line;
    }
  }
  return records;
}

export function formatFasta(records, width = 60) {
  const out = [];
  for (const {header, seq} of records) {
    out.push(`>${header}`);
    for (let i = 0; i < seq.length; i += width) out.push(seq.slice(i, i + width));
  }
  return out.join("\n") + "\n";
}

// Keep the contigs worth annotating: longest first, at least minLength bp,
// at most maxContigs and maxTotal bp (the annotation server's limits).
export function filterContigs(fastaText, {minLength = 1000, maxContigs = 20, maxTotal = 2000000} = {}) {
  const kept = [];
  let total = 0;
  const records = parseFasta(fastaText).sort((a, b) => b.seq.length - a.seq.length);
  for (const rec of records) {
    if (rec.seq.length < minLength) continue;
    if (kept.length >= maxContigs || total + rec.seq.length > maxTotal) break;
    kept.push(rec);
    total += rec.seq.length;
  }
  return {records: kept, dropped: records.length - kept.length, totalLength: total};
}
