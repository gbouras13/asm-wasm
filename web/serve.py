#!/usr/bin/env python3
"""
Local static server for the in-browser assembler.

Sends the headers the assembler needs (cross-origin isolation for
SharedArrayBuffer / threads) together with the same strict CSP as
phage-annotation.org, extended only by 'wasm-unsafe-eval'.

    python3 serve.py [--port 8765] [--data DIR]

--data exposes DIR read-only under /data/ (for automated test runs).
"""

import argparse
import functools
import http.server
import os
import posixpath
import urllib.parse

CSP = (
    "default-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval'; "
    "style-src 'self'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "worker-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".gz": "application/octet-stream",
    }

    def __init__(self, *args, data_dir=None, **kwargs):
        self.data_dir = data_dir
        super().__init__(*args, **kwargs)

    def translate_path(self, path):
        parsed = urllib.parse.urlparse(path).path
        if self.data_dir and parsed.startswith("/data/"):
            rel = posixpath.normpath(urllib.parse.unquote(parsed[len("/data/"):]))
            if rel.startswith("..") or rel.startswith("/"):
                return os.path.join(self.data_dir, "__forbidden__")
            return os.path.join(self.data_dir, rel)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument("--data", default=None)
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=args.root,
                                data_dir=os.path.abspath(args.data) if args.data else None)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Serving {args.root} on http://127.0.0.1:{args.port}/ (data: {args.data})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
