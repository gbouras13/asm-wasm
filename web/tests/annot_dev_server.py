"""Local dev launcher for phage-annotation-server (mock pipeline, the server's
default) that also serves test reads at /devdata, so browser tests can feed
the /assemble page without a file picker.

    <server venv>/bin/python annot_dev_server.py --repo DIR [--data DIR] [--port 8010]

--repo: a phage-annotation-server checkout (default: $PHAGE_ANNOTATION_SERVER).
--data: a directory of test reads, served at /devdata (default ~/.cache/asm-wasm/webdata).
"""

import argparse
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--repo", default=os.environ.get("PHAGE_ANNOTATION_SERVER"))
parser.add_argument("--data", default=str(Path.home() / ".cache/asm-wasm/webdata"))
parser.add_argument("--port", type=int, default=8010)
args = parser.parse_args()
if not args.repo:
    parser.error("--repo (or $PHAGE_ANNOTATION_SERVER) is required")
sys.path.insert(0, args.repo)

import uvicorn  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from api.main import app  # noqa: E402

app.mount("/devdata", StaticFiles(directory=args.data, follow_symlink=True), name="devdata")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
