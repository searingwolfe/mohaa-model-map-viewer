"""Build ommap, the map compiler the Map Editor runs, from tools/ommap.

    python tools/build_ommap.py                 this system, with its C compiler (cc / gcc / clang)
    python tools/build_ommap.py --target all    every system, with Zig's C compiler
    python tools/build_ommap.py --target windows-x86_64

The program goes to bin/ommap/<system>/ommap (ommap.exe on Windows), where the editor
looks for it. Zig builds for the other systems from any one of them: install it with
    python -m pip install ziglang
Exit code 0 when every build asked for was made.
"""
import os
import platform
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "ommap")
OUT = os.path.join(ROOT, "bin", "ommap")
# gldraw.c draws with OpenGL (nodraw.c stands in for it) and l3dslib.c reads 3DS models
# the compiler doesn't use
SKIP = {"gldraw.c", "l3dslib.c"}
# Zig target names, and the glibc each Linux build asks for (old, so it runs on old systems)
TARGETS = {
    "linux-x86_64": "x86_64-linux-gnu.2.17",
    "linux-arm64": "aarch64-linux-gnu.2.17",
    "windows-x86_64": "x86_64-windows-gnu",
    "macos-x86_64": "x86_64-macos",
    "macos-arm64": "aarch64-macos",
}
CFLAGS = ["-O2", "-s", "-fcommon", "-w", "-Wno-incompatible-pointer-types", "-Wno-int-conversion"]


def sources():
    out = []
    for d in (SRC, os.path.join(SRC, "common")):
        out += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".c") and f not in SKIP]
    return out


def native_target():
    m = platform.machine().lower()
    arch = "arm64" if m in ("arm64", "aarch64") else "x86_64"
    if sys.platform.startswith("win"):
        return "windows-" + arch
    return ("macos-" if sys.platform == "darwin" else "linux-") + arch


def build(target, use_zig):
    win = target.startswith("windows")
    dest_dir = os.path.join(OUT, target)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "ommap.exe" if win else "ommap")
    tmp = dest + ".new"
    if use_zig:
        cc = [sys.executable, "-m", "ziglang", "cc", "-target", TARGETS[target]]
    else:
        cc = [os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc") or shutil.which("clang") or "cc"]
    cmd = cc + CFLAGS + (["-DWIN32", "-D_WIN32"] if win else []) + \
        ["-I" + SRC, "-I" + os.path.join(SRC, "common"), "-o", tmp] + sources() + (["-lm"] if win else ["-lm", "-lpthread"])
    print("building %s ..." % target, flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isfile(tmp):
        print(r.stdout[-4000:] + r.stderr[-4000:])
        print("FAILED: %s" % target)
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    for junk in (tmp[:-4] + ".pdb", os.path.splitext(tmp)[0] + ".pdb"):
        if os.path.exists(junk):
            os.remove(junk)
    os.replace(tmp, dest)
    if not win:
        os.chmod(dest, 0o755)
    print("  %s (%d bytes)" % (dest, os.path.getsize(dest)))
    return True


def main(argv):
    target = None
    if "--target" in argv:
        i = argv.index("--target")
        target = argv[i + 1] if i + 1 < len(argv) else None
        if target != "all" and target not in TARGETS:
            print("targets: all, " + ", ".join(TARGETS))
            return 2
    if target is None:
        return 0 if build(native_target(), use_zig=False) else 1
    names = list(TARGETS) if target == "all" else [target]
    ok = all([build(t, use_zig=True) for t in names])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
