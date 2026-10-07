// Read files in the browser (Web Worker) and Node: streaming, optionally gunzipped
// File/Blob access, and seeded random subsampling of FASTQ reads or read pairs.

export function readStream(file) {
  const stream = file.stream();
  return /\.gz$/i.test(file.name) ? stream.pipeThrough(new DecompressionStream("gzip")) : stream;
}

// mulberry32: a small seeded PRNG. Replaying the same sequence over R1 and R2 makes the
// same keep/drop decision for both reads of a pair.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function firstByte(file) {
  const reader = readStream(file).getReader();
  const {value} = await reader.read();
  await reader.cancel().catch(() => {});
  return value && value.length ? value[0] : -1;
}

export async function countLines(file) {
  const reader = readStream(file).getReader();
  let lines = 0;
  let last = 10;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    for (let i = value.indexOf(10); i >= 0; i = value.indexOf(10, i + 1)) lines++;
    if (value.length) last = value[value.length - 1];
  }
  return last === 10 ? lines : lines + 1;
}

// Writes the FASTQ records for which keep() is true to a new (uncompressed) file. Kept bytes
// are copied into compact blocks: slices of the decompressed chunks would keep them all alive.
export async function sampleFastq(file, keep, name) {
  const BLOCK = 4 << 20;
  const parts = [];
  let block = new Uint8Array(BLOCK);
  let used = 0;
  let kept = 0;
  const emit = (bytes) => {
    let off = 0;
    while (off < bytes.length) {
      const n = Math.min(bytes.length - off, BLOCK - used);
      block.set(bytes.subarray(off, off + n), used);
      used += n;
      off += n;
      if (used === BLOCK) {
        parts.push(new Blob([block]));
        block = new Uint8Array(BLOCK);
        used = 0;
      }
    }
  };
  const reader = readStream(file).getReader();
  let lineInRecord = 0;
  let keepThis = keep();
  let endsWithNewline = true;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    let start = 0;
    for (let i = value.indexOf(10); i >= 0; i = value.indexOf(10, i + 1)) {
      if (++lineInRecord === 4) {
        if (keepThis) { emit(value.subarray(start, i + 1)); kept++; }
        start = i + 1;
        lineInRecord = 0;
        keepThis = keep();
      }
    }
    if (keepThis) emit(value.subarray(start));
    if (value.length) endsWithNewline = value[value.length - 1] === 10;
  }
  if (lineInRecord === 3 && !endsWithNewline && keepThis) { emit(new Uint8Array([10])); kept++; }
  parts.push(new Blob([block.subarray(0, used)]));
  return {file: new File(parts, name), kept};
}

// Illumina runs often hold far more reads than a phage assembly needs, and here SPAdes keeps
// its temporary files in memory: keep a random subset of about maxPairs reads/pairs.
export async function subsampleReads(files, maxPairs, onLine = () => {}) {
  if (await firstByte(files[0]) !== 64) {	// '@'
    onLine("[asm-worker] reads are not FASTQ: not subsampled");
    return files;
  }
  const records = Math.floor(await countLines(files[0]) / 4);
  const what = files.length === 2 ? "read pairs" : "reads";
  if (records <= maxPairs) {
    onLine(`[asm-worker] ${records.toLocaleString("en")} ${what}: using all`);
    return files;
  }
  const p = maxPairs / records;
  onLine(`[asm-worker] ${records.toLocaleString("en")} ${what}: keeping a random ` +
         `${(100 * p).toFixed(1)}% (about ${maxPairs.toLocaleString("en")})`);
  const out = [];
  for (const [i, file] of files.entries()) {
    const random = seededRandom(42);
    const name = files.length === 2 ? `R${i + 1}_subsampled.fastq` : "subsampled.fastq";
    const {file: sampled, kept} = await sampleFastq(file, () => random() < p, name);
    onLine(`[asm-worker] ${file.name}: kept ${kept.toLocaleString("en")} reads`);
    out.push(sampled);
  }
  return out;
}
