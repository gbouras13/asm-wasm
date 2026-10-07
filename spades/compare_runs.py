#!/usr/bin/env python3
"""Compare every output file of two SPAdes runs byte-for-byte.

    compare_runs.py RUN_A RUN_B [--stages]

Logs, configs, params, time.txt and other files that embed timestamps or command lines are
skipped. lib_data files (also inside --checkpoints graph packs) embed the absolute output
directory: they are a LEB128 length prefix + YAML text, so the prefix is dropped and RUN_B's
path replaced by RUN_A's before comparing.
With --stages, prints a per-K / per-stage table (first differing stage is what matters).
"""
import hashlib
import os
import sys

SKIP_NAMES = {"spades.log", "warnings.log", "params.txt", "run_spades.sh", "run_spades.yaml",
              "pipeline_state", "input_dataset.yaml", "dataset.info", "time.txt"}


def files(root):
    out = set()
    for d, dirs, fs in os.walk(root):
        rel = os.path.relpath(d, root)
        if "/configs" in "/" + rel or rel.startswith("configs") or "pipeline_state" in rel:
            continue
        for f in fs:
            if f in SKIP_NAMES or f.endswith(".log"):
                continue
            out.add(os.path.normpath(os.path.join(rel, f)))
    return out


def strip_leb128_prefix(data):
    n, shift, i = 0, 0, 0
    while i < len(data) and i < 10:
        b = data[i]; n |= (b & 0x7F) << shift; shift += 7; i += 1
        if not b & 0x80:
            break
    return data[i:] if n == len(data) - i else data


def read(path, old=None, new=None):
    with open(path, "rb") as fh:
        data = fh.read()
    if path.endswith(".lib_data"):
        data = strip_leb128_prefix(data)
    if old is not None and old != new:
        data = data.replace(old, new)
    return data


def main():
    a, b = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    stages = "--stages" in sys.argv
    fa, fb = files(a), files(b)
    same, diff = [], []
    for f in sorted(fa & fb):
        da = read(os.path.join(a, f))
        db = read(os.path.join(b, f), b.encode(), a.encode())
        (same if da == db else diff).append(f)
    for f in sorted(fa - fb):
        print("only in A:", f)
    for f in sorted(fb - fa):
        print("only in B:", f)
    for f in diff:
        print("DIFF:", f)
    print(f"{len(same)} identical, {len(diff)} differ, {len(fa - fb)} only in A, {len(fb - fa)} only in B")
    if stages:
        table = {}
        for f in same + diff:
            parts = f.split(os.sep)
            if len(parts) >= 3 and parts[1] == "saves":
                key = (parts[0], parts[2] if len(parts) > 3 else parts[2].split(".")[0])
            else:
                key = (parts[0] if len(parts) > 1 else ".", "outputs")
            ok, bad = table.get(key, (0, 0))
            table[key] = (ok + (f in same), bad + (f in diff))
        for (k, st), (ok, bad) in sorted(table.items()):
            print(f"  {k:6s} {st:28s} {'identical' if not bad else 'DIFFER'} ({ok} same, {bad} differ)")
    sys.exit(1 if diff or fa != fb else 0)


if __name__ == "__main__":
    main()
