#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ==============================================================================
#  mohaa_skc_write.py  --  read and write MOHAA .skc (SKAN v13) animation files.
#
#  Foundation for the animation tools: a lossless reader (keeps every header
#  field, frame record, channel value and raw name bytes) and a writer that lays
#  the file out exactly as the engine's loader expects it.
#
#  Engine references (OpenMOHAA):
#    skeletor_animation_file_format.h   skelAnimDataFileHeader_t / skelAnimFileFrame_t
#    tiki_files.cpp  SkeletorCacheFileCallback   ident "SKAN", version 13 (raw) or 14
#                                                 (pre-processed; not written here)
#    skeletor_loadanimation.cpp  ConvertSkelFileToGame
#        - frame i's channel block is read from a FIXED offset,
#          48 + 48*numFrames + 16*numChannels*i; the frame record's own
#          iOfsChannels field is ignored, so data must be contiguous, frame order
#        - channel names: numChannels x 32 bytes at ofsChannelNames
#    bonetable.cpp  GetBoneChannelType   " rot" quaternion, " pos" position,
#                                        " rotFK" ignored, anything else a value
#
#  Usage (round-trip check, read-only on the inputs):
#     python3 mohaa_skc_write.py --roundtrip FILE.skc|FOLDER|PAK.pk3 [...]
# ==============================================================================
import sys
import os
_bin_dir = os.path.dirname(os.path.abspath(__file__))
if _bin_dir not in sys.path:
    sys.path.insert(0, _bin_dir)
import struct, math, zipfile, argparse

SKC_IDENT = b"SKAN"
SKC_VERSION = 13                 # TIKI_SKC_HEADER_OLD_VERSION: the raw format the engine converts
HEADER_SIZE = 0x30               # sizeof(skelAnimDataFileHeader_t) minus its frame[1]
FRAME_SIZE = 48                  # sizeof(skelAnimFileFrame_t)
CHANNEL_SIZE = 16                # skelAnimChannel_t: float[4]
NAME_SIZE = 32                   # skelChannelName_t
MAX_NAME_CHARS = NAME_SIZE - 1   # one byte for the terminator

_HDR = struct.Struct("<4siiif3ffiii")   # ident version flags nBytesUsed frameTime totalDelta[3]
                                        # totalAngleDelta numChannels ofsChannelNames numFrames
_FRM = struct.Struct("<6ff3ffi")        # bounds[2][3] radius delta[3] angleDelta iOfsChannels
assert _HDR.size == HEADER_SIZE and _FRM.size == FRAME_SIZE


class SkcError(ValueError):
    pass


def channel_type(name):
    """Mirror of GetBoneChannelType (bonetable.cpp): 'rot', 'pos', 'none' or 'value'."""
    if len(name) < 4:
        return "value"
    if name.endswith(" rot"):
        return "rot"
    if name.endswith(" pos"):
        return "pos"
    if name.endswith(" rotFK"):
        return "none"
    return "value"


def read_skc_bytes(b, path="<bytes>"):
    """Parse a v13 .skc into a dict that write_skc() turns back into the same bytes.

    Keys: version, flags, nBytesUsed, frameTime, totalDelta, totalAngleDelta,
    names (decoded), rawNames (exact 32-byte fields), frames (list of dicts with
    bounds, radius, delta, angleDelta, ofsChannels, values = [[4 floats] per channel]),
    tail (bytes after the name table, normally empty)."""
    n = len(b)
    if n < HEADER_SIZE or b[0:4] != SKC_IDENT:
        raise SkcError(f"{path}: not an SKC (ident {b[0:4]!r})")
    (ident, version, flags, nBytesUsed, frameTime, tdx, tdy, tdz, tad,
     numChan, ofsNames, numFrames) = _HDR.unpack_from(b, 0)
    if version != SKC_VERSION:
        raise SkcError(f"{path}: SKC version {version} not supported (only {SKC_VERSION})")
    dataStart = HEADER_SIZE + FRAME_SIZE * numFrames if 0 < numFrames <= 200000 else -1
    if not (0 <= numChan <= 8192 and dataStart > 0
            and dataStart + CHANNEL_SIZE * numChan * numFrames <= n
            and 0 <= ofsNames and ofsNames + NAME_SIZE * numChan <= n):
        raise SkcError(f"{path}: bad SKC layout (numChan={numChan} numFrames={numFrames} "
                       f"ofsChannelNames={ofsNames} size={n})")
    rawNames = [bytes(b[ofsNames + i * NAME_SIZE: ofsNames + (i + 1) * NAME_SIZE]) for i in range(numChan)]
    names = [r.split(b"\x00")[0].decode("latin-1", "replace").rstrip() for r in rawNames]
    frames = []
    for f in range(numFrames):
        v = _FRM.unpack_from(b, HEADER_SIZE + f * FRAME_SIZE)
        base = dataStart + CHANNEL_SIZE * numChan * f          # where the engine reads it
        vals = [list(struct.unpack_from("<4f", b, base + c * CHANNEL_SIZE)) for c in range(numChan)]
        frames.append({"bounds": [list(v[0:3]), list(v[3:6])], "radius": v[6],
                       "delta": list(v[7:10]), "angleDelta": v[10], "ofsChannels": v[11],
                       "values": vals})
    tailStart = ofsNames + NAME_SIZE * numChan
    return {"version": version, "flags": flags, "nBytesUsed": nBytesUsed, "frameTime": frameTime,
            "totalDelta": [tdx, tdy, tdz], "totalAngleDelta": tad,
            "names": names, "rawNames": rawNames, "frames": frames,
            "ofsChannelNames": ofsNames, "tail": bytes(b[tailStart:])}


def read_skc(path):
    with open(path, "rb") as fh:
        return read_skc_bytes(fh.read(), path)


def _name_field(name):
    raw = name.encode("latin-1")
    if len(raw) > MAX_NAME_CHARS:
        raise SkcError(f"channel name too long ({len(raw)} > {MAX_NAME_CHARS}): {name!r}")
    return raw + b"\x00" * (NAME_SIZE - len(raw))


def _finite(x, what):
    x = float(x)
    if not math.isfinite(x):
        raise SkcError(f"{what} is not finite ({x})")
    return x


def write_skc(anim, keep_raw=True, allow_duplicates=False):
    """dict (as from read_skc / new_anim) -> .skc bytes, laid out the way ConvertSkelFileToGame reads.

    keep_raw=True reuses rawNames, ofsChannels and tail when present and consistent, so an
    unedited file comes back byte-for-byte. Edited or new animations get clean fields:
    zero-padded names, correct per-frame offsets, nBytesUsed = file size.

    allow_duplicates: some shipping .skc repeat a channel name (e.g. "Base head pos" in
    dialogue/ and scripted/level_m1l1/ clips); the engine loads them, RegisterChannel/AddChannel
    reusing the existing slot. Pass True to rewrite such a file; new animations stay unique."""
    names = list(anim["names"])
    frames = anim["frames"]
    nc, nf = len(names), len(frames)
    if nf <= 0:
        raise SkcError("an animation needs at least one frame (the engine rejects numFrames <= 0)")
    if not allow_duplicates and len(set(names)) != nc:
        dup = sorted({x for x in names if names.count(x) > 1})
        raise SkcError(f"duplicate channel names: {dup}")
    raw = anim.get("rawNames") if keep_raw else None
    if raw and len(raw) == nc and all(
            r.split(b"\x00")[0].decode("latin-1", "replace").rstrip() == nm for r, nm in zip(raw, names)):
        nameBlock = b"".join(raw)
    else:
        nameBlock = b"".join(_name_field(nm) for nm in names)
    dataStart = HEADER_SIZE + FRAME_SIZE * nf
    frameBytes = CHANNEL_SIZE * nc
    ofsNames = dataStart + frameBytes * nf
    tail = anim.get("tail", b"") if keep_raw else b""
    total = ofsNames + len(nameBlock) + len(tail)

    out = bytearray()
    used = anim.get("nBytesUsed") if keep_raw else None
    out += _HDR.pack(SKC_IDENT, SKC_VERSION, int(anim.get("flags", 0)),
                     int(used) if used is not None and used == total else total,
                     _finite(anim["frameTime"], "frameTime"),
                     *[_finite(x, "totalDelta") for x in anim.get("totalDelta", (0, 0, 0))],
                     _finite(anim.get("totalAngleDelta", 0.0), "totalAngleDelta"),
                     nc, ofsNames, nf)
    for i, fr in enumerate(frames):
        if len(fr["values"]) != nc:
            raise SkcError(f"frame {i}: {len(fr['values'])} channel values, expected {nc}")
        want = dataStart + frameBytes * i
        ofs = fr.get("ofsChannels") if keep_raw else None
        out += _FRM.pack(*[_finite(x, f"frame {i} bounds") for x in fr["bounds"][0]],
                         *[_finite(x, f"frame {i} bounds") for x in fr["bounds"][1]],
                         _finite(fr.get("radius", 0.0), f"frame {i} radius"),
                         *[_finite(x, f"frame {i} delta") for x in fr.get("delta", (0, 0, 0))],
                         _finite(fr.get("angleDelta", 0.0), f"frame {i} angleDelta"),
                         int(ofs) if ofs is not None else want)
    for i, fr in enumerate(frames):
        for c, v in enumerate(fr["values"]):
            if len(v) != 4:
                raise SkcError(f"frame {i} channel {names[c]!r}: {len(v)} floats, expected 4")
            out += struct.pack("<4f", *[_finite(x, f"frame {i} {names[c]}") for x in v])
    out += nameBlock
    out += tail
    assert len(out) == total
    return bytes(out)


def save_skc(path, anim, backup=True, allow_duplicates=False):
    """Write an animation to disk atomically (the launcher's write helper when available)."""
    data = write_skc(anim, allow_duplicates=allow_duplicates)
    read_skc_bytes(data, path)          # refuse to save anything the reader would reject
    try:
        import mohaa_common as MC
        MC.atomic_write_bytes(path, data, backup=backup)
    except ImportError:
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    return len(data)


def recompute_totals(anim):
    """Set totalDelta / totalAngleDelta from the frames. Checked against the shipping .skc:
    totalDelta == sum of every frame's delta (879/879 moving clips), totalAngleDelta == sum of
    every frame's angleDelta (64/64 turning clips; the other 60 hold exporter junk such as 1e28,
    all in dialogue/ plus projectiles/m2fgrenade/grenade_air.skc)."""
    fr = anim["frames"]
    anim["totalDelta"] = [sum(float(f.get("delta", (0, 0, 0))[k]) for f in fr) for k in range(3)]
    anim["totalAngleDelta"] = sum(float(f.get("angleDelta", 0.0)) for f in fr)
    return anim


def new_anim(names, frame_values, frameTime=0.05, flags=0):
    """Build a fresh animation dict. frame_values: per frame, one [4 floats] per channel
    (' rot' = quaternion x,y,z,w; ' pos' = x,y,z,0). Bounds/radius/deltas start at zero
    and are filled in by the editor once it can pose the mesh."""
    frames = [{"bounds": [[0.0] * 3, [0.0] * 3], "radius": 0.0, "delta": [0.0] * 3,
               "angleDelta": 0.0, "values": [list(map(float, v)) for v in fv]}
              for fv in frame_values]
    return {"flags": flags, "frameTime": float(frameTime), "totalDelta": [0.0] * 3,
            "totalAngleDelta": 0.0, "names": list(names), "frames": frames}


# ------------------------------------------------------------------------------
#  Round-trip check
# ------------------------------------------------------------------------------
def roundtrip_bytes(b, path):
    """Returns (status, detail). status: 'identical', 'equivalent' (same values the engine
    reads, different bytes, e.g. stale frame offsets) or raises."""
    anim = read_skc_bytes(b, path)
    w = write_skc(anim, allow_duplicates=True)
    if w == b:
        return "identical", ""
    again = read_skc_bytes(w, path)
    clean = read_skc_bytes(write_skc(anim, keep_raw=False, allow_duplicates=True), path)
    for chk in (again, clean):
        if chk["names"] != anim["names"] or len(chk["frames"]) != len(anim["frames"]):
            raise SkcError(f"{path}: names/frame count changed on rewrite")
        for fa, fb in zip(anim["frames"], chk["frames"]):
            for k in ("bounds", "radius", "delta", "angleDelta", "values"):
                if fa[k] != fb[k]:
                    raise SkcError(f"{path}: {k} changed on rewrite")
    diff = next(i for i in range(min(len(w), len(b))) if w[i] != b[i]) if len(w) == len(b) else None
    return "equivalent", (f"first differing byte 0x{diff:X}" if diff is not None
                          else f"size {len(b)} -> {len(w)}")


def _iter_sources(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                for f in sorted(files):
                    full = os.path.join(root, f)
                    if f.lower().endswith(".skc"):
                        with open(full, "rb") as fh:
                            yield full, fh.read()
                    elif f.lower().endswith(".pk3"):
                        yield from _iter_pk3(full)
        elif p.lower().endswith(".pk3"):
            yield from _iter_pk3(p)
        else:
            with open(p, "rb") as fh:
                yield p, fh.read()


def _iter_pk3(path):
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.filename.lower().endswith(".skc"):
                yield f"{path}:{info.filename}", z.read(info)


def main(argv=None):
    ap = argparse.ArgumentParser(description="MOHAA .skc reader/writer round-trip check")
    ap.add_argument("--roundtrip", nargs="+", required=True, metavar="PATH",
                    help=".skc files, folders, or .pk3 paks (read only)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    counts = {"identical": 0, "equivalent": 0, "skipped": 0, "FAILED": 0}
    for name, data in _iter_sources(a.roundtrip):
        try:
            st, detail = roundtrip_bytes(data, name)
        except SkcError as e:
            msg = str(e)
            st = "skipped" if ("version" in msg or "bad SKC layout" in msg or "not an SKC" in msg) else "FAILED"
            detail = msg
        except Exception as e:  # noqa: BLE001 - report and keep sweeping
            st, detail = "FAILED", f"{type(e).__name__}: {e}"
        counts[st] += 1
        if st != "identical" or a.verbose:
            print(f"[{st}] {name} {detail}")
    print("summary: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 1 if counts["FAILED"] else 0


if __name__ == "__main__":
    sys.exit(main())
