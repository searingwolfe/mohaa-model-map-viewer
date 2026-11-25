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
import struct, math, zipfile, argparse, re

_CHAN_RE = re.compile(r"^(.*?\S)\s+(pos|rot|rotFK)$")
def chan_key(name):
    """A channel name keyed like the viewer's stripped bone names. The engine names a bone's
    channels from its exact 32-byte name + " pos" / " rot", so a bone padded with spaces
    (opel.skd "tire_tilt_back_right  ") has channels "tire_tilt_back_right   pos"; the viewer
    strips bone names, so it reads that as "tire_tilt_back_right pos". write_skc writes names
    as given, so a caller that wants the exact spelling back passes it (the page's
    savePayload does, from each bone's rawName)."""
    m = _CHAN_RE.match(name)
    return m.group(1) + " " + m.group(2) if m else name

def chan_keys(names):
    """chan_key for a whole channel table. A name whose key another channel already took
    keeps its exact spelling, so no two channels share a key (opel_opening.skc has
    "exhaust   pos" and "exhaust  pos", for its bones "exhaust  " and "exhaust ")."""
    out, seen = [], set(names)
    for n in names:
        k = chan_key(n)
        if k != n and k in seen: k = n
        seen.add(k); out.append(k)
    return out

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
    names = chan_keys([r.split(b"\x00")[0].decode("latin-1", "replace").rstrip() for r in rawNames])
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
    if raw and len(raw) == nc and chan_keys(
            [r.split(b"\x00")[0].decode("latin-1", "replace").rstrip() for r in raw]) == chan_keys(names):
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


# ---- baked-in features: what an animation carries besides the body's pose -----------------
# A clip can carry more than the body's motion: the face's blend shapes (eye look, blinks,
# lip sync, brows and mouth), the head turning and nodding, the body turning (Bip01's yaw,
# the frames' angleDelta) and moving (the frames' delta). These are found by channel name
# (bonetable.cpp GetBoneChannelType: a name without " pos" / " rot" is a morph value) and
# can be scaled, 0 taking one out. The Model Viewer's Baked in panel previews the same
# changes (BAKE_JS in mohaa_view.py) and saves through apply_baked.
BAKE_GROUPS = ("eyes", "blink", "lips", "face", "head", "body", "move")
_EYES_RE = re.compile(r"^eyes_(left|right|up|down)", re.I)


def bake_group(name):
    """The baked-in group a channel belongs to, or None (the body's own motion)."""
    n = name.lower()
    if _EYES_RE.match(n): return "eyes"
    if n.startswith("eye_blink"): return "blink"
    if n.startswith(("viseme_", "visme_")): return "lips"
    if n.startswith(("brow_", "mouth_", "jaw_", "lips_", "eyes_")): return "face"
    if n in ("bip01 head rot", "bip01 neck rot"): return "head"
    if n == "bip01 rot": return "body"
    return None


def _qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]


def _qnorm(q):
    l = math.sqrt(sum(c * c for c in q)) or 1.0
    return [c / l for c in q]


def _qpow(q, s):
    """q (a unit quaternion) turned s times as far: the same axis, s x the angle."""
    q = _qnorm(q)
    if q[3] < 0: q = [-c for c in q]
    a = math.acos(max(-1.0, min(1.0, q[3])))
    if a < 1e-9: return [0.0, 0.0, 0.0, 1.0]
    k = math.sin(a * s) / math.sin(a)
    return [q[0] * k, q[1] * k, q[2] * k, math.cos(a * s)]


def _qyaw(q):
    x, y, z, w = q
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def _qangle(a, b):
    d = abs(sum(x * y for x, y in zip(_qnorm(a), _qnorm(b))))
    return 2 * math.degrees(math.acos(min(1.0, d)))


def baked_features(anim):
    """What the clip carries, by group: {"eyes": {"chans": {name: largest weight}}, "head":
    {"deg": largest turn from frame 1}, "body": {"yaw": yaw range, "turn": sum of
    angleDelta (degrees)}, "move": {"dist": length of the total delta}, ...}. Only groups
    actually used are listed."""
    out = {}
    fr = anim["frames"]
    if not fr: return out
    for ci, n in enumerate(anim["names"]):
        g = bake_group(n)
        if g in ("eyes", "blink", "lips", "face"):
            m = max(abs(f["values"][ci][0]) for f in fr)
            if m > 0.5: out.setdefault(g, {"chans": {}})["chans"][n] = round(m, 1)
        elif g == "head":
            q0 = fr[0]["values"][ci]
            d = max(_qangle(q0, f["values"][ci]) for f in fr)
            if d > 2.0: out["head"] = {"deg": round(max(d, out.get("head", {}).get("deg", 0)), 1)}
        elif g == "body":
            y = [math.degrees(_qyaw(f["values"][ci])) for f in fr]
            y0 = y[0]; dy = [((v - y0 + 180) % 360) - 180 for v in y]
            r = max(dy) - min(dy)
            if r > 2.0: out.setdefault("body", {})["yaw"] = round(r, 1)
    turn = sum(float(f.get("angleDelta", 0.0)) for f in fr)
    if abs(turn) > 0.5 and abs(turn) < 1e6: out.setdefault("body", {})["turn"] = round(turn, 1)
    td = [sum(float(f.get("delta", (0, 0, 0))[k]) for f in fr) for k in range(3)]
    dist = math.sqrt(sum(c * c for c in td))
    if dist > 0.1: out["move"] = {"dist": round(dist, 1)}
    return out


def apply_baked(anim, amounts):
    """Scale each baked-in group by its amount (1 keeps it, 0 takes it out, 2 doubles it):
    a morph value times the amount; the head and neck turned that much of the way from their
    frame-1 pose; Bip01's yaw kept that much of its turn from frame 1 (its lean stays) and
    each frame's angleDelta scaled; each frame's delta scaled. The totals are worked out
    again. Bounds and radius are kept (the body's place hardly changes)."""
    am = {g: float(amounts[g]) for g in BAKE_GROUPS if g in amounts and amounts[g] is not None}
    for g, v in am.items():
        if not (0.0 <= v <= 4.0) or v != v: raise ValueError(f"{g}: amount {v} is out of range (0 to 4)")
    fr = anim["frames"]
    if not fr: return anim
    for ci, n in enumerate(anim["names"]):
        g = bake_group(n)
        s = am.get(g)
        if s is None or s == 1.0: continue
        if g in ("eyes", "blink", "lips", "face"):
            for f in fr: f["values"][ci][0] = f["values"][ci][0] * s
        elif g == "head":
            q0 = _qnorm(fr[0]["values"][ci]); inv = [-q0[0], -q0[1], -q0[2], q0[3]]
            for f in fr:
                q = _qnorm(f["values"][ci])
                if sum(a * b for a, b in zip(q, q0)) < 0: q = [-c for c in q]
                f["values"][ci] = _qmul(q0, _qpow(_qmul(inv, q), s))
        elif g == "body":
            y0 = _qyaw(_qnorm(fr[0]["values"][ci]))
            for f in fr:
                q = _qnorm(f["values"][ci])
                dy = ((_qyaw(q) - y0 + math.pi) % (2 * math.pi)) - math.pi
                a = -(1.0 - s) * dy
                f["values"][ci] = _qmul([0.0, 0.0, math.sin(a / 2), math.cos(a / 2)], q)
    if "body" in am:
        for f in fr: f["angleDelta"] = float(f.get("angleDelta", 0.0)) * am["body"]
    if "move" in am:
        for f in fr: f["delta"] = [float(c) * am["move"] for c in f.get("delta", (0, 0, 0))]
    recompute_totals(anim)
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
