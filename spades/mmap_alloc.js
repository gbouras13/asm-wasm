// --js-library: mmap() of an in-memory (MEMFS) file copies the file into the heap via
// mmapAlloc, which by default asks for 64 KiB-aligned blocks (emscripten_builtin_memalign).
// SPAdes maps every k-mer bucket file this way. Emscripten's mimalloc (v3) serves each such
// aligned request from fresh memory instead of reusing freed blocks, so the heap grew by
// ~6 GB per k-mer iteration (8 threads) for 100 KB files. A plain 16-byte-aligned block
// (freed by munmap like before) is all SPAdes needs.
addToLibrary({
  $mmapAlloc__deps: ['$zeroMemory', 'emscripten_builtin_memalign'],
  $mmapAlloc: (size) => {
    var ptr = _emscripten_builtin_memalign(16, size);
    if (ptr) zeroMemory(ptr, size);
    return ptr;
  },
});
