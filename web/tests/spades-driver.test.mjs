// Unit check: the driver regenerates spades.py's files byte for byte.
//
//   node tests/spades-driver.test.mjs <native spades.py --isolate run dir> <templates dir>
//
// Uses the native run's own paths, so K<k>/configs/config.info, input_dataset.yaml
// and the k-mer choice must match what spades.py wrote exactly.
import fs from "node:fs";
import path from "node:path";
import {chooseKmers, configForK, datasetYaml} from "../spades-driver.js";

const [runDir, templatesDir] = process.argv.slice(2);
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// k-mer selection (stages.spades_stage)
check("read length 150 -> 21,33,55,77", chooseKmers(150).join() === "21,33,55,77");
check("read length 250 -> 21..127", chooseKmers(250).join() === "21,33,55,77,99,127");
check("read length 100 -> 21,33,55", chooseKmers(100).join() === "21,33,55");
check("read length 50 -> 21,33", chooseKmers(50).join() === "21,33");

const kDirs = fs.readdirSync(runDir).filter((d) => /^K\d+$/.test(d))
  .map((d) => Number(d.slice(1))).sort((a, b) => a - b);
const template = fs.readFileSync(path.join(templatesDir, "config.info"), "utf8");
const first = fs.readFileSync(path.join(runDir, `K${kDirs[0]}`, "configs", "config.info"), "utf8");
const field = (text, key) => (new RegExp(`^\\s*${key} (.*)$`, "m").exec(text) || [])[1];
const tmpDir = field(first, "tmp_dir");
const sewageMatrix = field(first, "sewage_matrix");
const threads = field(first, "max_threads");
const memoryGb = field(first, "max_memory");

kDirs.forEach((k, i) => {
  const expected = fs.readFileSync(path.join(runDir, `K${k}`, "configs", "config.info"), "utf8");
  const got = configForK(template, {
    k, lastOne: i === kDirs.length - 1, prevK: i > 0 ? kDirs[i - 1] : null,
    tmpDir, threads, memoryGb, outDir: runDir, sewageMatrix,
  });
  check(`K${k}/configs/config.info identical`, got === expected);
  if (got !== expected) {
    const a = got.split("\n"), b = expected.split("\n");
    for (let j = 0; j < Math.max(a.length, b.length); j++) {
      if (a[j] !== b[j]) { console.log(`  line ${j + 1}: got ${JSON.stringify(a[j])} want ${JSON.stringify(b[j])}`); }
    }
  }
});

// dataset YAML: rebuild from the native file's own read paths
const yaml = fs.readFileSync(path.join(runDir, "input_dataset.yaml"), "utf8");
const left = [...yaml.matchAll(/"left reads":\n((?:  - ".*"\n)+)/g)].map((m) => [...m[1].matchAll(/"(.*)"/g)].map((x) => x[1]))[0];
const right = [...yaml.matchAll(/"right reads":\n((?:  - ".*"\n)+)/g)].map((m) => [...m[1].matchAll(/"(.*)"/g)].map((x) => x[1]))[0];
check("input_dataset.yaml identical", datasetYaml([{type: "paired-end", left, right}]) === yaml);

process.exit(failures ? 1 : 0);
