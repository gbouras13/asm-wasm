"""Compare two single-contig circular assemblies: identical up to rotation/strand?
If not, count differences from a minimap2 asm5 alignment (cs tag; minimap2 from
$MINIMAP2 or PATH). Needs Biopython.

    python3 compare_circular.py a.fasta b.fasta
"""
import os
import re
import shutil
import subprocess
import sys

from Bio import SeqIO
from Bio.Seq import Seq

MINIMAP2 = os.environ.get("MINIMAP2") or shutil.which("minimap2") or "minimap2"


def load(path):
    return [str(r.seq).upper() for r in SeqIO.parse(path, "fasta")]


def same_up_to_rotation(a, b):
    if len(a) != len(b):
        return False
    rc = str(Seq(b).reverse_complement())
    return b in a + a or rc in a + a


a_path, b_path = sys.argv[1], sys.argv[2]
a, b = load(a_path), load(b_path)
print(f"contigs: {len(a)} vs {len(b)}; lengths: {[len(s) for s in a]} vs {[len(s) for s in b]}")
if len(a) == len(b) == 1:
    if a[0] == b[0]:
        print("identical sequence")
        sys.exit(0)
    if same_up_to_rotation(a[0], b[0]):
        print("identical up to rotation/strand")
        sys.exit(0)
out = subprocess.run([MINIMAP2, "-cx", "asm5", "--cs", a_path, b_path],
                     capture_output=True, text=True, check=True).stdout
subs = ins = dels = aligned = 0
for line in out.splitlines():
    cols = line.split("\t")
    aligned += int(cols[3]) - int(cols[2])
    cs = next(c for c in cols if c.startswith("cs:Z:"))[5:]
    subs += len(re.findall(r"\*[acgtn][acgtn]", cs))
    ins += sum(len(x) for x in re.findall(r"\+([acgtn]+)", cs))
    dels += sum(len(x) for x in re.findall(r"-([acgtn]+)", cs))
print(f"aligned query bases: {aligned}; substitutions: {subs}; inserted bases: {ins}; deleted bases: {dels}")
