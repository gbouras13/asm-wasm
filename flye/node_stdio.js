// --pre-js for the Node (NODERAWFS) builds: make stdio pipes behave like pipes.
//
// 1. Node switches stdio pipes to non-blocking mode on macOS once process.stdout /
//    process.stdin are initialised (worker threads forward their stdio through
//    them). A full or empty pipe then makes fs.writeSync / fs.readSync throw
//    EAGAIN, which NODERAWFS reports to C as an I/O error: minimap2 aborted with
//    "failed to write the results: Resource temporarily unavailable" when piping
//    into samtools. Retry with a short sleep instead; partial writes are already
//    handled by the C stdio layer.
//
// 2. NODERAWFS lets lseek() "succeed" on stdin/stdout/stderr without moving the
//    real file offset (Node has no lseek): for a pipe, SEEK_END uses the buffered
//    byte count as the size; for a redirected file, later reads ignore the new
//    position. htslib's BGZF EOF check seeks, so binary input from a pipe
//    (samtools sort -) was corrupted. Report the stdio streams as non-seekable
//    (ESPIPE, like a pipe), which programs handle by reading sequentially.
if (globalThis.process?.versions?.node) {
  const nodeFs = require("node:fs");
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  const retryOnEagain = (fn) => function (...args) {
    for (;;) {
      try {
        return fn.apply(this, args);
      } catch (e) {
        if (e.code !== "EAGAIN") throw e;
        Atomics.wait(sleepCell, 0, 0, 1);
      }
    }
  };
  if (!nodeFs.writeSync.__eagainRetry) {
    nodeFs.writeSync = retryOnEagain(nodeFs.writeSync);
    nodeFs.readSync = retryOnEagain(nodeFs.readSync);
    nodeFs.writeSync.__eagainRetry = true;
  }

  Module.preRun = [].concat(Module.preRun || [], () => {
    const createStandardStreams = FS.createStandardStreams;
    FS.createStandardStreams = function (...args) {
      const ret = createStandardStreams.apply(this, args);
      for (let fd = 0; fd < 3; fd++) {
        if (FS.streams[fd]) FS.streams[fd].seekable = false;
      }
      return ret;
    };
    // NODERAWFS replaces FS.llseek with a version that ignores stream.seekable
    const llseek = FS.llseek;
    FS.llseek = function (stream, offset, whence) {
      if (stream.seekable === false) throw new FS.ErrnoError(70);  // ESPIPE
      return llseek.call(this, stream, offset, whence);
    };
  });
}
