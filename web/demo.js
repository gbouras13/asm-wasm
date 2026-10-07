import {runAssembly, isSupported, memory64Supported, defaultThreads, filterContigs, formatFasta}
  from "./asm-client.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let job = null;
let timer = null;
let objectUrls = [];
let stageNames = [];

const assemblerFor = (mode) => (mode === "illumina" ? "spades" : "flye");

function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

function setRunning(running) {
  $("run").disabled = running;
  $("cancel").disabled = !running;
}

function addDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type: "text/plain"}));
  objectUrls.push(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.textContent = `${name} (${text.length.toLocaleString()} bytes)`;
  $("downloads").appendChild(a);
}

async function start(files) {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  $("downloads").textContent = "";
  $("log").textContent = "";
  $("status").textContent = "";
  $("stage").textContent = "starting";
  window.__asmStatus = "running";

  const assembler = assemblerFor($("mode").value);
  const options = {
    mode: $("mode").value,
    threads: Number($("threads").value) || defaultThreads(),
  };
  if (assembler === "spades" && Number($("maxpairs").value) > 0) options.maxPairs = Number($("maxpairs").value);
  if (assembler === "flye") {
    if ($("gsize").value.trim()) options.genomeSize = $("gsize").value.trim();
    if ($("asmcov").value) options.asmCoverage = Number($("asmcov").value);
  }

  const t0 = performance.now();
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - t0) / 1000)} s`;
  }, 500);
  setRunning(true);
  job = runAssembly({
    assembler, files, options,
    onLog: log,
    onStages: (stages) => { stageNames = stages.map(([name]) => name); },
    onStage: (name) => {
      const i = stageNames.indexOf(name);
      $("stage").textContent = i < 0 ? name : `${name} (${i + 1}/${stageNames.length})`;
    },
  });
  try {
    const {outputs} = await job.result;
    const seconds = (performance.now() - t0) / 1000;
    const fasta = outputs["assembly.fasta"] || "";
    const filtered = filterContigs(fasta);
    for (const [name, text] of Object.entries(outputs)) addDownload(name, text);
    if (filtered.records.length) {
      addDownload("for_annotation.fasta", formatFasta(filtered.records));
    }
    const msg = `done in ${seconds.toFixed(1)} s: ${filtered.records.length} contigs kept ` +
                `(${filtered.totalLength.toLocaleString()} bp), ${filtered.dropped} dropped`;
    $("status").textContent = msg;
    $("stage").textContent = "finished";
    window.__asmResult = {seconds, outputs, filtered};
    window.__asmStatus = "done";
  } catch (err) {
    $("status").textContent = `failed: ${err.message}`;
    $("stage").textContent = "failed";
    window.__asmStatus = "failed: " + err.message;
  } finally {
    clearInterval(timer);
    setRunning(false);
    job = null;
  }
}

function init() {
  $("threads").value = defaultThreads();
  const showFlyeOptions = () => {
    $("flye-options").hidden = $("mode").value === "illumina";
    $("spades-options").hidden = $("mode").value !== "illumina";
  };
  $("mode").addEventListener("change", showFlyeOptions);
  if (isSupported()) {
    $("support").textContent = `Cross-origin isolated: yes. Threads available: ${navigator.hardwareConcurrency}. ` +
      `64-bit WebAssembly memory (needed by SPAdes): ${memory64Supported() ? "yes" : "no"}.`;
  } else {
    $("support").textContent = "This page is not cross-origin isolated (COOP/COEP headers missing), " +
                               "so the multithreaded assembler cannot run.";
  }

  $("asm-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const files = $("reads").files;
    if (!files.length) {
      $("status").textContent = "Choose at least one reads file.";
      return;
    }
    start(Array.from(files));
  });
  $("cancel").addEventListener("click", () => {
    if (job) job.cancel();
    $("status").textContent = "cancelled";
    window.__asmStatus = "cancelled";
    clearInterval(timer);
    setRunning(false);
  });

  // test hook: ?auto=/data/reads.fastq.gz&mode=nano-hq&threads=8&asmcov=50&gsize=100k
  // (several files: ?auto=/data/R1.fastq.gz,/data/R2.fastq.gz&mode=illumina)
  const auto = params.get("auto");
  if (auto) {
    for (const [key, id] of [["mode", "mode"], ["threads", "threads"], ["asmcov", "asmcov"], ["gsize", "gsize"],
                             ["maxpairs", "maxpairs"]]) {
      if (params.has(key)) $(id).value = params.get(key);
    }
    showFlyeOptions();
    Promise.all(auto.split(",").map((url) => fetch(url).then((resp) => {
      if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
      return resp.blob().then((blob) => new File([blob], url.split("/").pop()));
    })))
      .then((files) => start(files))
      .catch((err) => {
        $("status").textContent = `failed: ${err.message}`;
        window.__asmStatus = "failed: " + err.message;
      });
  }
}

init();
