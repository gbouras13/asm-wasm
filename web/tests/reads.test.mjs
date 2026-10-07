// Tests for reads.js (paired subsampling, line counting) under Node.
//
//   node tests/reads.test.mjs [R1.fastq.gz R2.fastq.gz maxPairs]
//
// Without arguments: synthetic FASTQ (plain and gzipped, with and without a final newline).
// With arguments: subsamples real files and checks that the mates stay paired.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {countLines, sampleFastq, seededRandom, subsampleReads} from "../reads.js";

function fastq(n, mate, {finalNewline = true} = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const seq = "ACGT".repeat(10 + (i % 7)).slice(0, 37 + (i % 5));
    out.push(`@read${i}/${mate}\n${seq}\n+\n${"I".repeat(seq.length)}`);
  }
  return out.join("\n") + (finalNewline ? "\n" : "");
}

function records(text) {
  const lines = text.split("\n").filter((l, i, a) => i < a.length - 1 || l !== "");
  assert.equal(lines.length % 4, 0, "whole records");
  const recs = [];
  for (let i = 0; i < lines.length; i += 4) {
    assert.ok(lines[i].startsWith("@") && lines[i + 2] === "+", `record ${i / 4} well-formed`);
    assert.equal(lines[i + 1].length, lines[i + 3].length);
    recs.push(lines.slice(i, i + 4).join("\n"));
  }
  return recs;
}

const name = (rec) => rec.split("\n")[0].replace(/\/[12]$/, "");

async function synthetic() {
  const n = 5000;
  const r1 = fastq(n, 1);
  const r2 = fastq(n, 2, {finalNewline: false});
  const files = [
    new File([zlib.gzipSync(r1)], "s_R1.fastq.gz"),
    new File([r2], "s_R2.fastq"),
  ];
  assert.equal(await countLines(files[0]), 4 * n);
  assert.equal(await countLines(files[1]), 4 * n, "a last line without newline still counts");

  const logs = [];
  const out = await subsampleReads(files, 500, (l) => logs.push(l));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.name), ["R1_subsampled.fastq", "R2_subsampled.fastq"]);
  const k1 = records(await out[0].text());
  const k2 = records(await out[1].text());
  assert.equal(k1.length, k2.length, "same number of reads kept in R1 and R2");
  assert.deepEqual(k1.map(name), k2.map(name), "mates stay paired");
  const expected = (() => { const r = seededRandom(42); let c = 0; for (let i = 0; i < n; i++) if (r() < 500 / n) c++; return c; })();
  assert.equal(k1.length, expected, "kept exactly the PRNG's choice");
  const all1 = new Set(records(r1));
  for (const rec of k1) assert.ok(all1.has(rec), "records copied verbatim");
  // gzipped and plain inputs give the same subsample
  const plain = await subsampleReads([new File([r1], "p_R1.fastq"), new File([r2], "p_R2.fastq")], 500);
  assert.equal(await plain[0].text(), await out[0].text());
  // no subsampling when there are few enough reads
  const same = await subsampleReads(files, n);
  assert.equal(same[0], files[0]);
  // single-end
  const single = await subsampleReads([files[0]], 100);
  assert.equal(single[0].name, "subsampled.fastq");
  // blocks of the output must not alias input chunks: check a block boundary case
  const big = fastq(60000, 1);
  const {file, kept} = await sampleFastq(new File([big], "big.fastq"), () => true, "all.fastq");
  assert.equal(kept, 60000);
  assert.equal(await file.text(), big, "keeping everything reproduces the input byte for byte");
  console.log(`synthetic: ok (kept ${k1.length} of ${n} pairs; ${logs.join(" | ")})`);
}

async function real(r1, r2, maxPairs) {
  const t0 = Date.now();
  const files = [r1, r2].map((p) => new File([fs.readFileSync(p)], path.basename(p)));
  const out = await subsampleReads(files, maxPairs, (l) => console.log(l));
  const k1 = records(await out[0].text());
  const k2 = records(await out[1].text());
  assert.equal(k1.length, k2.length);
  for (let i = 0; i < k1.length; i++) assert.equal(name(k1[i]), name(k2[i]), `pair ${i}`);
  console.log(`real: ok, ${k1.length} pairs kept, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return out;
}

const [r1, r2, maxPairs, outDir] = process.argv.slice(2);
if (r1) {
  const out = await real(r1, r2, Number(maxPairs || 100000));
  if (outDir) {
    fs.mkdirSync(outDir, {recursive: true});
    for (const f of out) fs.writeFileSync(path.join(outDir, f.name), Buffer.from(await f.arrayBuffer()));
  }
} else {
  await synthetic();
}
