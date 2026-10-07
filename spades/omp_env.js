// --pre-js for the OpenMP build: libomp defaults for WebAssembly.
//
// KMP_LOCK_KIND=tas: Emscripten's libomp (6.0.11, LLVM 24) hangs in contended
// `#pragma omp critical` sections / omp_set_lock() with its default *queuing* locks once >= 6
// threads compete (reproduced with a 20-line program: guided parallel-for + allocation +
// critical; 2-4 threads fine, 6-8 hang; independent of Memory64, allocator, pthread pool,
// KMP_BLOCKTIME, OMP_WAIT_POLICY). Test-and-set locks work. SPAdes hits this in graph
// construction (ReclaimingIdDistributor::acquire()).
//
// KMP_BLOCKTIME=0: idle OpenMP threads sleep at once instead of spinning for 200 ms. Every
// filesystem call is proxied to the runtime thread, so spinning workers compete with the
// thread doing the I/O: SPAdes, 8 threads, 100x phage 15.2 -> 12.2 s, 1000x 174 -> 164 s;
// no change at 4 threads.
//
// An explicit value in the environment (Node, -sNODE_HOST_ENV, or Module.ENV set in an
// earlier preRun) wins.
Module.preRun = [].concat(Module.preRun || [], () => {
  const hostEnv = globalThis.process?.env ?? {};
  for (const [key, value] of [["KMP_LOCK_KIND", "tas"], ["KMP_BLOCKTIME", "0"]]) {
    if (!(key in hostEnv) && !(key in ENV)) ENV[key] = value;
  }
});
