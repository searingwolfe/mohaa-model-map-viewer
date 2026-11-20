"""Compare two MOHAA .bsp files lump by lump: what a map compiler wrote against a
reference (the game's own .bsp of the same map, or EA's compiler's output for a test map).

    python tools/bsp_compare.py ours.bsp reference.bsp [--json]

Prints, for each lump, its size and record count in both files, then what the records
hold where that is comparable without matching them one to one: the shaders used and
their flags, the world's bounds, the brush entities, the entity classes, the surfaces by
type, the terrain patches, the static models, the light grid's size. Exit code 0.
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
import mohaa_bsp as MB  # noqa: E402

# lump number: (name, record size on disk; 1 for byte lumps)
LUMPS = {
    0: ("shaders", 140), 1: ("planes", 16), 2: ("lightmaps", 128 * 128 * 3), 3: ("surfaces", 108),
    4: ("drawverts", 44), 5: ("drawindexes", 4), 6: ("leafbrushes", 4), 7: ("leafsurfaces", 4),
    8: ("leafs", 64), 9: ("nodes", 36), 10: ("sideequations", 32), 11: ("brushsides", 12),
    12: ("brushes", 12), 13: ("models", 40), 14: ("entities", 1), 15: ("visibility", 1),
    16: ("lightgridpalette", 1), 17: ("lightgridoffsets", 2), 18: ("lightgriddata", 1),
    19: ("spherelights", 56), 20: ("spherelightvis", 1), 21: ("lightdefs", 52),
    22: ("terrain", 388), 23: ("terrainindexes", 2), 24: ("staticmodeldata", 3),
    25: ("staticmodeldef", 164), 26: ("staticmodelindexes", 2), 27: ("dummy", 1),
}
SURF_TYPES = {1: "planar", 2: "patch", 3: "triangles", 4: "flare"}


def lump_table(data):
    """(offset, length) of each of the 28 lumps."""
    return [struct.unpack_from("<ii", data, 12 + 8 * i) for i in range(28)]


def summary(path):
    data = open(path, "rb").read()
    b = MB.Bsp(data, os.path.basename(path))
    lumps = lump_table(data)
    out = {"file": path, "bytes": len(data), "version": b.version, "lumps": {}}
    for n, (name, rec) in LUMPS.items():
        ln = lumps[n][1]
        out["lumps"][name] = {"bytes": ln, "records": ln // rec if rec > 1 else ln,
                              "odd": bool(rec > 1 and ln % rec)}
    out["shaders"] = {s["name"].lower(): [s["surface"], s["contents"]] for s in b.shaders}
    ents = MB.parse_entity_string(MB.bsp_entity_text(data))
    out["entities"] = len(ents)
    cls = {}
    for e in ents:
        c = MB.ent_get(e, "classname", "?")
        cls[c] = cls.get(c, 0) + 1
    out["classes"] = cls
    st = {}
    for s in b.surfaces:
        k = SURF_TYPES.get(s["type"], str(s["type"]))
        st[k] = st.get(k, 0) + 1
    out["surface_types"] = st
    out["terrain_patches"] = len(b.terrain)
    if b.terrain:
        out["terrain_bounds"] = [min(p["x"] for p in b.terrain), min(p["y"] for p in b.terrain),
                                 max(p["x"] for p in b.terrain), max(p["y"] for p in b.terrain)]
    models = struct.iter_unpack("<6f4i", data[lumps[13][0]:lumps[13][0] + lumps[13][1]])
    out["models"] = [[round(v, 1) for v in m[:6]] + list(m[6:]) for m in models]
    return out


def compare(a, b):
    lines = ["%-20s %12s %12s   %10s %10s" % ("lump", "ours bytes", "ref bytes", "ours n", "ref n")]
    for name in (v[0] for v in LUMPS.values()):
        x, y = a["lumps"][name], b["lumps"][name]
        flag = "  <- not a whole number of records" if x["odd"] or y["odd"] else ""
        lines.append("%-20s %12d %12d   %10d %10d%s" % (name, x["bytes"], y["bytes"], x["records"], y["records"], flag))
    lines.append("")
    sa, sb = set(a["shaders"]), set(b["shaders"])
    lines.append("shaders: %d ours, %d reference, %d in both" % (len(sa), len(sb), len(sa & sb)))
    for n in sorted(sa - sb)[:30]:
        lines.append("  only ours: " + n)
    for n in sorted(sb - sa)[:30]:
        lines.append("  only reference: " + n)
    flag_diff = [(n, a["shaders"][n], b["shaders"][n]) for n in sorted(sa & sb) if a["shaders"][n] != b["shaders"][n]]
    lines.append("shaders in both with different flags (surface, contents): %d" % len(flag_diff))
    for n, x, y in flag_diff[:40]:
        lines.append("  %s: ours 0x%x 0x%x, reference 0x%x 0x%x" % (n, x[0] & 0xffffffff, x[1] & 0xffffffff,
                                                                     y[0] & 0xffffffff, y[1] & 0xffffffff))
    lines.append("")
    lines.append("surfaces by type: ours %s, reference %s" % (a["surface_types"], b["surface_types"]))
    lines.append("entities: ours %d, reference %d" % (a["entities"], b["entities"]))
    ca, cb = a["classes"], b["classes"]
    for c in sorted(set(ca) | set(cb)):
        if ca.get(c, 0) != cb.get(c, 0):
            lines.append("  %s: ours %d, reference %d" % (c, ca.get(c, 0), cb.get(c, 0)))
    lines.append("terrain patches: ours %d, reference %d" % (a["terrain_patches"], b["terrain_patches"]))
    if a.get("terrain_bounds") or b.get("terrain_bounds"):
        lines.append("  patch x/y range: ours %s, reference %s" % (a.get("terrain_bounds"), b.get("terrain_bounds")))
    lines.append("models (brush entities + world): ours %d, reference %d" % (len(a["models"]), len(b["models"])))
    if a["models"] and b["models"]:
        lines.append("  world bounds: ours %s, reference %s" % (a["models"][0][:6], b["models"][0][:6]))
    return "\n".join(lines)


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    a, b = summary(argv[1]), summary(argv[2])
    if "--json" in argv:
        print(json.dumps({"ours": a, "reference": b}, indent=1))
    else:
        print(compare(a, b))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
