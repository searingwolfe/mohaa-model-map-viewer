"""Compiling a .map into a .bsp with ommap, the map compiler built from OpenMoHAA's
code/tools/ommap (GPL; the source, with this project's changes, is in tools/ommap and
tools/build_ommap.py builds it).

The compiler reads a game folder: scripts/ (the shaders) and maps/ (the .map). The paks
hold the shaders, so a folder is made in the launcher's workspace with every shader script
from the loaded paks and a copy of the map, and ommap is pointed at it (-gamedir). Its
results are copied back beside the map, as EA's Q3map leaves them: the .bsp written
atomically (an older one kept as .bak), the portal file .prt (a sealed map) or the leak trail
.lin (a leaking one), the old of either removed first, and the .vis (the visibility lump on
its own, see vis_file).

The steps are ommap's own: bsp (the .bsp from the .map, with the entities, brushes,
patches, terrain and static models), vis (which areas see which; fastvis is quicker and
draws more than it needs to), then light (the lightmaps, the terrain's, the light grid
models are lit by, the lights the game lights models with, and each static model's light
per vertex). For that last, ommap can't read the models: before light, the static models'
vertices (posed as the game draws them, in its own order) are written beside the map copy
as <name>.smv, which ommap's light step reads.
"""
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time

import mohaa_common as MC

HERE = os.path.dirname(os.path.abspath(__file__))
OMMAP_DIR = os.path.join(HERE, "ommap")
STEPS = ("bsp", "vis", "fastvis", "light")
STEP_ARGS = {"bsp": [], "vis": ["-vis"], "fastvis": ["-vis", "-fast"], "light": ["-light"]}
STEP_TIMEOUT = 3600                     # seconds a step may take before it is stopped
NOWIN = dict(creationflags=0x08000000) if sys.platform.startswith("win") else {}
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def platform_dir():
    """The folder under bin/ommap holding this system's build."""
    import platform
    m = platform.machine().lower()
    arch = "arm64" if m in ("arm64", "aarch64") else "x86_64"
    if sys.platform.startswith("win"):
        return "windows-" + arch
    if sys.platform == "darwin":
        return "macos-" + arch
    return "linux-" + arch


def ommap_path():
    """This system's ommap, or None when there is no build for it."""
    p = os.path.join(OMMAP_DIR, platform_dir(), "ommap.exe" if sys.platform.startswith("win") else "ommap")
    if not os.path.isfile(p):
        return None
    if not sys.platform.startswith("win") and not os.access(p, os.X_OK):
        try:
            os.chmod(p, 0o755)              # a copy or an unzip can drop the program's x bit
        except OSError:
            MC.swallowed()
    return p


def write_scripts(vfs, scripts_dir):
    """Every shader script in the paks (and shaderlist.txt) into scripts_dir. The count."""
    os.makedirs(scripts_dir, exist_ok=True)
    n = 0
    for name in sorted(vfs.names()):
        low = name.lower()
        if not low.startswith("scripts/") or "/" in low[8:]:
            continue
        if not (low.endswith(".shader") or low == "scripts/shaderlist.txt"):
            continue
        data = vfs.read(name)
        if data is None:
            continue
        base = os.path.basename(low)
        if not NAME_RE.match(base):
            continue
        with open(os.path.join(scripts_dir, base), "wb") as f:
            f.write(data)
        n += 1
    return n


# ---- what EA's compiler adds to the map before it builds it ---------------------------------
# EA's Q3map (MOH:AA's own compiler, the reference for ommap's output) does two things to a
# map before building it, which ommap's code from OpenMoHAA doesn't: it stamps worldspawn
# with the time of the compile ("map_time", as ctime() writes it), which the game compares
# with a map's .pth (PathSearch::ArchiveLoadNodes: the AI paths are rebuilt when it
# differs) and a .dcl decal file; and it gives each static prop (a static_* entity) the
# collision brushes the paks keep for its model, models/<model>.map, turned, scaled and
# moved with it, so the prop is solid in the game. Both are done here on the map's copy.
# Checked against Q3map.exe on a test room with two props (one pitched, rolled and scaled):
# every brush plane the same.

def _top_blocks(text):
    """(start, end) of each top-level { } block (an entity): end is the index of its }.
    Quoted strings and // comments are skipped."""
    out, depth, start, i, n = [], 0, 0, 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = text.find('"', i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}" and depth:
            depth -= 1
            if depth == 0:
                out.append((start, i))
        i += 1
    return out


def _entity_keys(block):
    """The "key" "value" pairs at an entity's own level (not inside its brushes)."""
    keys, depth, i, n = {}, 0, 0, len(block)
    while i < n:
        c = block[i]
        if c == "/" and block.startswith("//", i):
            j = block.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == '"' and depth == 1:
            m = re.match(r'"([^"]*)"\s*"([^"]*)"', block[i:])
            if m:
                keys.setdefault(m.group(1).lower(), m.group(2))
                i += m.end()
                continue
        i += 1
    return keys


def _axes(angles):
    """The game's AnglesToAxis: forward, left, up for pitch yaw roll in degrees."""
    p, y, r = (math.radians(a) for a in angles)
    sp, cp, sy, cy, sr, cr = math.sin(p), math.cos(p), math.sin(y), math.cos(y), math.sin(r), math.cos(r)
    fwd = (cp * cy, cp * sy, -sp)
    right = (-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp)
    up = (cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp)
    return fwd, tuple(-v for v in right), up


def _num(v):
    r = round(v, 6)
    return ("%d" % r) if r == int(r) else ("%.6f" % r).rstrip("0").rstrip(".")


_FACE = re.compile(r"^(\s*)\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)"
                   r"\s*\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)(.*)$")


def static_collision(vfs, model, origin, angles, scale):
    """The brushes of models/<model>.map (a static prop's collision) placed as the prop is:
    the .map text of its brushes, or None when the paks have none for it."""
    name = (model or "").replace("\\", "/").lower()
    name = re.sub(r"/+", "/", name).lstrip("/")
    if not name.endswith(".tik"):
        return None
    if not name.startswith("models/"):
        name = "models/" + name
    data = vfs.read(name[:-4] + ".map") if vfs is not None else None
    if not data:
        return None
    text = data.decode("latin-1")
    A = _axes(angles)
    brushes = []
    for a, b in _top_blocks(text):
        ent = text[a:b + 1]
        for ba, bb in _top_blocks(ent[1:-1]):
            body = ent[1:-1][ba + 1:bb]
            if "patchDef" in body or "terrainDef" in body:
                continue
            faces = []
            for line in body.splitlines():
                m = _FACE.match(line)
                if not m:
                    continue
                try:
                    v = [float(x) for x in m.groups()[1:10]]
                except ValueError:
                    continue
                pts = []
                for q in (v[0:3], v[3:6], v[6:9]):
                    pts.append([origin[i] + scale * (q[0] * A[0][i] + q[1] * A[1][i] + q[2] * A[2][i]) for i in range(3)])
                faces.append(" ".join("( %s )" % " ".join(_num(c) for c in p) for p in pts) + m.group(11).rstrip())
            if len(faces) >= 4:
                brushes.append("{\n" + "\n".join(faces) + "\n}")
    return "\n".join(brushes) if brushes else None


# ---- MoHAA's manual vis, restored for a decompiled map ---------------------------------------
# EA's maps keep vis brushes (common/vis) in vis_leafgroup entities, each with a targetname
# and a "target" naming the groups it never sees: the compiler prunes the vis work by them
# (BasePortalVis in tools/ommap, as EA's Q3map does), which is what makes full vis of a big
# outdoor map take minutes rather than many hours. The compiler consumes those entities, so
# a .bsp, and a map decompiled from it, has the vis brushes loose in the world (where they
# only split the BSP as hint brushes). The groups come back from the original .bsp: each vis
# brush is one group (as in every one of EA's released maps), and a group targets another
# when, in that .bsp's vis data, no cluster inside the first sees any inside the second.
# Checked against EA's sources: mohdm3's 4,103 targets come back as 3,838 found and 1 extra,
# obj_team1's 5,194 as 5,140 found (the shipped maps were changed after their sources).

def _bsp_lumps(data):
    if len(data) < 12 + 8 * 28 or data[:4] != b"2015":
        raise ValueError("not a MOH:AA .bsp")
    out = []
    for k in range(28):
        o, l = struct.unpack_from("<ii", data, 12 + 8 * k)
        if o < 0 or l < 0 or o + l > len(data):
            raise ValueError("a lump lies outside the file")
        out.append(data[o:o + l])
    return out


def bsp_leafgroups(data):
    """The vis brushes of a .bsp's world and the blocks between them: ([(planes, clusters)],
    [(a, b)]). planes: each side's (normal, dist), rounded."""
    L = _bsp_lumps(data)
    shaders = [L[0][i * 140:i * 140 + 64].split(b"\0")[0].decode("latin-1").lower() for i in range(len(L[0]) // 140)]
    planes = [struct.unpack_from("<4f", L[1], i * 16) for i in range(len(L[1]) // 16)]
    sides = [struct.unpack_from("<iii", L[11], i * 12) for i in range(len(L[11]) // 12)]
    brushes = [struct.unpack_from("<iii", L[12], i * 12) for i in range(len(L[12]) // 12)]
    nworld = struct.unpack_from("<iiiiiiiiii", L[13], 0)[9] if len(L[13]) >= 40 else len(brushes)
    first = struct.unpack_from("<iiiiiiiiii", L[13], 0)[8] if len(L[13]) >= 40 else 0
    leafbrushes = struct.unpack("<%di" % (len(L[6]) // 4), L[6])
    vis = [i for i in range(first, first + nworld)
           if 0 <= brushes[i][2] < len(shaders) and shaders[brushes[i][2]].endswith("common/vis")]
    index = {b: k for k, b in enumerate(vis)}
    clusters = [set() for _ in vis]
    for i in range(len(L[8]) // 64):
        lf = struct.unpack_from("<16i", L[8], i * 64)
        if lf[0] < 0:
            continue
        for k in range(lf[10], lf[10] + lf[11]):
            if 0 <= k < len(leafbrushes) and leafbrushes[k] in index:
                clusters[index[leafbrushes[k]]].add(lf[0])
    groups = []
    for b in vis:
        fs, ns, _sh = brushes[b]
        pl = []
        for k in range(fs, fs + ns):
            if 0 <= sides[k][0] < len(planes):
                n = planes[sides[k][0]]
                pl.append((round(n[0], 2), round(n[1], 2), round(n[2], 2), round(n[3], 1)))
        groups.append(sorted(pl))
    blocks = []
    v = L[15]
    if len(v) >= 8:
        ncl, bpc = struct.unpack_from("<ii", v, 0)
        if ncl > 0 and bpc > 0 and len(v) >= 8 + ncl * bpc:
            row = lambda c: int.from_bytes(v[8 + c * bpc:8 + (c + 1) * bpc], "little")
            mask = [sum(1 << c for c in cs if c < ncl) for cs in clusters]
            sees = []
            for cs in clusters:
                m = 0
                for c in cs:
                    if c < ncl:
                        m |= row(c)
                sees.append(m)
            for a in range(len(vis)):
                if not mask[a]:
                    continue
                for b in range(len(vis)):
                    if a != b and mask[b] and not (sees[a] & mask[b]):
                        blocks.append((a, b))
    return [(groups[k], clusters[k]) for k in range(len(vis))], blocks


def _brush_planes(body):
    """A .map brush's sides as rounded (normal, dist), sorted; None when it isn't all vis."""
    pl = []
    for line in body.splitlines():
        m = _FACE.match(line)
        if not m:
            continue
        rest = m.group(11).split()
        if not rest or not rest[0].lower().endswith("common/vis"):
            return None
        v = [float(x) for x in m.groups()[1:10]]
        a = [v[0] - v[3], v[1] - v[4], v[2] - v[5]]
        b = [v[6] - v[3], v[7] - v[4], v[8] - v[5]]
        n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
        ln = math.sqrt(sum(c * c for c in n))
        if ln < 1e-9:
            return None
        n = [c / ln for c in n]
        pl.append((round(n[0], 2), round(n[1], 2), round(n[2], 2), round(n[0] * v[3] + n[1] * v[4] + n[2] * v[5], 1)))
    return sorted(pl) if len(pl) >= 4 else None


def _planes_match(a, b):
    """The .map brush's planes are among the .bsp brush's (the compiler adds bevels)."""
    if len(a) > len(b):
        return False
    for p in a:
        if not any(all(abs(p[i] - q[i]) <= (0.02 if i < 3 else 0.6) for i in range(4)) for q in b):
            return False
    return True


def restore_leafgroups(text, bsp_data, log=print):
    """A decompiled map's loose vis brushes put back in the vis_leafgroup entities they came
    from (one each, named mv1, mv2 ...), with the blocks read from the original .bsp."""
    if '"vis_leafgroup"' in text:
        return text                                   # the map has its own
    blocks = _top_blocks(text)
    if not blocks:
        return text
    try:
        groups, pairs = bsp_leafgroups(bsp_data)
    except (ValueError, struct.error):
        MC.swallowed()
        log("(vis groups not restored: the original .bsp can't be read)")
        return text
    if not groups:
        return text
    w0, w1 = blocks[0]
    world = text[w0:w1 + 1]
    inner = world[1:-1]
    found, cut = {}, []
    for ba, bb in _top_blocks(inner):
        body = inner[ba + 1:bb]
        if "patchDef" in body or "terrainDef" in body:
            continue
        pl = _brush_planes(body)
        if pl is None:
            continue
        for k, (gp, _cl) in enumerate(groups):
            if k not in found and _planes_match(pl, gp):
                found[k] = body
                # the brush's comment line goes with it
                start = inner.rfind("\n", 0, ba)
                ln = inner[start + 1:ba]
                cut.append((start + 1 if ln.strip().startswith("//") else ba, bb + 1))
                break
    if not found:
        return text
    for a, b in sorted(cut, reverse=True):
        inner = inner[:a] + inner[b:].lstrip("\r\n")
    names = {k: "mv%d" % (i + 1) for i, k in enumerate(sorted(found))}
    targets = {k: [] for k in found}
    for a, b in pairs:
        if a in found and b in found:
            targets[a].append(names[b])
    ents = []
    for k in sorted(found):
        ents.append("// vis_leafgroup (restored from the original .bsp's vis data for MoHAA's manual vis)\n{\n"
                    '"classname" "vis_leafgroup"\n"targetname" "%s"\n' % names[k]
                    + _target_keys(targets[k])
                    + "{" + found[k].rstrip() + "\n}\n}")
    n_blocks = sum(len(t) for t in targets.values())
    log("(manual vis: %d vis brushes put back in their vis_leafgroups, %d blocks from the original .bsp's vis)"
        % (len(found), n_blocks))
    return text[:w0] + "{" + inner + "}" + text[w1 + 1:] + "\n" + "\n".join(ents) + "\n"


def _target_keys(names, limit=1000):
    """The "target" key of a vis_leafgroup, split over "target", "target2", "target3"...
    when the names don't fit one key (the compiler's map reader takes 1023 characters a
    value, and a group can block hundreds of others); ommap joins them back."""
    keys, cur = [], ""
    for n in names:
        if cur and len(cur) + 1 + len(n) > limit:
            keys.append(cur)
            cur = n
        else:
            cur = cur + " " + n if cur else n
    if cur:
        keys.append(cur)
    return "".join('"target%s" "%s"\n' % ("" if i == 0 else i + 1, v) for i, v in enumerate(keys))


# ---- the worldspawn's keys (the Compile window's MAP box) --------------------------------
_KV_LINE = re.compile(r'^\s*"([^"]*)"\s+"([^"]*)"\s*$')


def _worldspawn_span(text):
    """(start, end) of the worldspawn's key lines in a .map: from the line after its "{" up
    to its first brush, patch or terrain block (a line starting with "{") or its "}". None
    when the map has no first entity."""
    pos = 0
    opened = None
    while pos < len(text):
        n = text.find("\n", pos)
        n = len(text) if n < 0 else n + 1
        ln = text[pos:n].strip()
        if opened is None:
            if ln.startswith("{"):
                opened = n
        elif ln.startswith("{") or ln.startswith("}"):
            return opened, pos
        pos = n
    return (opened, len(text)) if opened is not None else None


def worldspawn_keys(text):
    """The worldspawn's "key" "value" pairs, in order."""
    sp = _worldspawn_span(text or "")
    if not sp:
        return []
    out = []
    for ln in text[sp[0]:sp[1]].splitlines():
        m = _KV_LINE.match(ln)
        if m:
            out.append((m.group(1), m.group(2)))
    return out


def parse_key_lines(s):
    """"key" "value" lines (blank and // lines skipped) as pairs; ValueError naming the line
    that isn't one (a key or value can't hold a quote, a brace or a line break)."""
    out = []
    for i, ln in enumerate(str(s or "").splitlines(), 1):
        t = ln.strip()
        if not t or t.startswith("//"):
            continue
        m = _KV_LINE.match(ln)
        if not m:
            raise ValueError('line %d isn\'t "key" "value": %s' % (i, t[:60]))
        k, v = m.group(1), m.group(2)
        if not k.strip():
            raise ValueError("line %d has an empty key" % i)
        if any(c in k + v for c in "{}"):
            raise ValueError("line %d: a key or value can't hold { or }" % i)
        out.append((k, v))
    return out


def set_worldspawn_keys(text, kv):
    """The .map with the worldspawn's key lines replaced by kv (after its "{"); its comments,
    brushes, patches and terrain stay as they are."""
    sp = _worldspawn_span(text)
    if not sp:
        raise ValueError("the map has no worldspawn")
    if not any(k.lower() == "classname" and v.lower() == "worldspawn" for k, v in kv):
        raise ValueError('the world\'s keys need "classname" "worldspawn"')
    nl = "\r\n" if "\r\n" in text else "\n"
    keep = [ln for ln in text[sp[0]:sp[1]].splitlines() if ln.strip() and not _KV_LINE.match(ln)]
    lines = ['"%s" "%s"' % (k, v) for k, v in kv] + keep
    return text[:sp[0]] + nl.join(lines) + nl + text[sp[1]:]


def decompiled_from(text):
    """The .bsp a decompiled map was rebuilt from (its first line), or None."""
    first = text[:300].split("\n", 1)[0]
    m = re.match(r"// MOHAA map source rebuilt from (\S+?\.bsp)\b", first)
    return m.group(1) if m else None


def find_origin_bsp(text, map_path, vfs, hint=None):
    """The original .bsp of a decompiled map: the one given, else one of its name beside the
    map, else the paks' maps/.../<name>.bsp. Its bytes, or None."""
    if hint and os.path.isfile(hint):
        with open(hint, "rb") as f:
            return f.read()
    name = decompiled_from(text)
    if not name:
        return None
    base = os.path.basename(name)
    if map_path:
        p = os.path.join(os.path.dirname(os.path.abspath(map_path)), base)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                return f.read()
    if vfs is not None:
        want = base.lower()
        for n in vfs.names():
            if n.lower().startswith("maps/") and n.lower().rsplit("/", 1)[-1] == want:
                return vfs.read(n)
    return None


def origin_bsp_candidates(text, map_path, vfs, hint=None):
    """Every .bsp find_origin_bsp could take, in its order: the one given, the one beside
    the map, the paks' copy. Bytes, without repeats."""
    out, seen = [], set()
    def add(data):
        if data and hash(data) not in seen:
            seen.add(hash(data)); out.append(data)
    if hint and os.path.isfile(hint):
        with open(hint, "rb") as f:
            add(f.read())
    name = decompiled_from(text)
    if name:
        base = os.path.basename(name)
        if map_path:
            p = os.path.join(os.path.dirname(os.path.abspath(map_path)), base)
            if os.path.isfile(p):
                with open(p, "rb") as f:
                    add(f.read())
        if vfs is not None:
            want = base.lower()
            for n in vfs.names():
                if n.lower().startswith("maps/") and n.lower().rsplit("/", 1)[-1] == want:
                    add(vfs.read(n))
    return out


def _has_nodetail(data):
    """Whether a .bsp's terrain has any never-split node (0x4000): a .bsp compiled from a
    map that lost its nodetail words has none, so the next candidate is tried."""
    import mohaa_bsp as MB
    for t in MB.Bsp(data).terrain:
        for tree in t["var"]:
            if any(v & 0x4000 for v in tree):
                return True
    return False


def ea_prepare(text, vfs, log=print, now=None):
    """The map's text as EA's compiler builds it: worldspawn's map_time set to the time of
    this compile, and each static prop's collision brushes added to the world."""
    blocks = _top_blocks(text)
    if not blocks:
        return text
    w0, w1 = blocks[0]
    stamp = time.asctime(time.localtime(now))
    world = text[w0:w1 + 1]
    # map_time: replaced where worldspawn has one, else the first key (as EA writes it)
    keys_end = world.find("\n{", 0)
    head = world if keys_end < 0 else world[:keys_end]
    m = re.search(r'"map_time"\s*"[^"]*"', head)
    if m:
        world = world[:m.start()] + '"map_time" "%s"' % stamp + world[m.end():]
    else:
        world = world[:1] + '\n"map_time" "%s"' % stamp + world[1:]
    added, missing = [], 0
    for a, b in blocks[1:]:
        k = _entity_keys(text[a:b + 1])
        if not k.get("classname", "").lower().startswith("static_") or not k.get("model"):
            continue
        try:
            org = [float(x) for x in (k.get("origin") or "0 0 0").split()[:3]]
            if k.get("angles"):
                ang = [float(x) for x in k["angles"].split()[:3]]
            else:
                ang = [0.0, float(k.get("angle") or 0), 0.0]
            sc = float(k.get("scale") or 1) or 1.0
            if len(org) != 3 or len(ang) != 3:
                raise ValueError
        except ValueError:
            continue
        brushes = static_collision(vfs, k["model"], org, ang, sc)
        if brushes:
            added.append("// collision of %s at %s (from its model's .map, as EA's compiler adds it)\n%s"
                         % (k["model"], " ".join(_num(c) for c in org), brushes))
        else:
            missing += 1
    if added:
        world = world[:-1].rstrip() + "\n" + "\n".join(added) + "\n}"
    if added or missing:
        log("(static props: %d given their collision brushes from the paks, %d without any)" % (len(added), missing))
    return text[:w0] + world + text[w1 + 1:]


def prepare(vfs, work, map_path):
    """The game folder for one compile: (gamedir, the map's copy in it). The scripts are
    written once per workspace."""
    stem = os.path.splitext(os.path.basename(map_path))[0]
    if not NAME_RE.match(stem):
        raise ValueError("the map's name must be letters, digits, _ . or - (the game finds maps by file name)")
    gamedir = os.path.join(work, "ommap_game", "main")
    scripts = os.path.join(gamedir, "scripts")
    if not os.path.isdir(scripts) or not os.listdir(scripts):
        if vfs is None:
            raise ValueError("no paks are loaded: the compiler needs the game's shaders")
        write_scripts(vfs, scripts)
    maps = os.path.join(gamedir, "maps")
    if os.path.isdir(maps):
        shutil.rmtree(maps)
    os.makedirs(maps)
    copy = os.path.join(maps, stem + ".map")
    shutil.copyfile(map_path, copy)
    return gamedir, copy


_TERRAIN_HEAD = re.compile(r"terrainDef\s*\{\s*9 9 0\s*\n\s*(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\s*\n")
# a terrain vertex line already naming one of EA's other face words
_TERRAIN_WORDS = re.compile(r"^\s*-?[\d.]+ \([^)\n]*\b(nodetail|trivial|important|invisible)\b", re.M)
_TERRAIN_VERT = re.compile(r"^(\s*\S+) \(([^)]*)\) \(([^)]*)\)\s*$")


def restore_terrain_detail(text, bsp_data, log=print):
    """A decompiled map's terrain given back the "nodetail" triangles and "invisible" holes
    of its original .bsp (made before the decompiler wrote them): for each 9 x 9 terrainDef
    at the place of one of the .bsp's patches, each triangle whose deepest node never splits
    (0x4000) gets nodetail, and each nodraw hole the original doesn't split the land down to
    becomes invisible. Without them steep land is split to full detail in the game and its
    texture drawn out into stripes. A map that already names either is left as it is."""
    if "terrainDef" not in text or _TERRAIN_WORDS.search(text):
        return text
    import mohaa_bsp as MB
    patches = {(int(t["x"]) * 64, int(t["y"]) * 64): t for t in MB.Bsp(bsp_data).terrain}
    out, pos, n_tri, n_inv, n_blocks = [], 0, 0, 0, 0
    for m in _TERRAIN_HEAD.finditer(text):
        key = (int(round(float(m.group(1)))), int(round(float(m.group(2)))))
        tp = patches.get(key)
        if tp is None:
            continue
        nd = MB.terrain_lod_words(tp)
        iv = MB.terrain_invisible(tp)
        if not nd and not iv:
            continue
        # the heights block: the second { after the head, then 81 vertex lines
        k = text.find("{", text.find("}", m.end()))
        if k < 0:
            continue
        line_start = text.find("\n", k) + 1
        vlines, q = [], line_start
        for _ in range(81):
            e = text.find("\n", q)
            if e < 0:
                break
            vlines.append((q, e))
            q = e + 1
        if len(vlines) != 81:
            continue
        out.append(text[pos:line_start])
        for idx, (a, e) in enumerate(vlines):
            line = text[a:e]
            i, j = idx % 9, idx // 9
            n0, n1 = nd.get((i, j), ((), ()))
            i0, i1 = iv.get((i, j), (False, False))
            mv = _TERRAIN_VERT.match(line.rstrip("\r"))
            if mv and (n0 or n1 or i0 or i1):
                g0, g1 = mv.group(2), mv.group(3)
                # a hole the original has as invisible (no land split down to it), still a
                # hole here: invisible again
                if i0 and re.search(r"\bnodraw\b", g0):
                    g0 = re.sub(r"\bnodraw\b", "invisible", g0, 1); n_inv += 1
                if i1 and re.search(r"\bnodraw\b", g1):
                    g1 = re.sub(r"\bnodraw\b", "invisible", g1, 1); n_inv += 1
                for wd in n0:
                    if wd not in g0.split():
                        g0 = (g0.strip() + " " + wd + " ").lstrip(); n_tri += 1
                for wd in n1:
                    if wd not in g1.split():
                        g1 = (g1.strip() + " " + wd + " ").lstrip(); n_tri += 1
                cr = "\r" if line.endswith("\r") else ""
                line = "%s ( %s) ( %s)%s" % (mv.group(1), g0, g1, cr)
            out.append(line + "\n")
        pos = vlines[-1][1] + 1
        n_blocks += 1
    if not n_blocks:
        return text
    out.append(text[pos:])
    log("(terrain: %d level-of-detail words (nodetail, trivial, important) and %d invisible holes in %d "
        "patches put back from the original .bsp)"
        % (n_tri, n_inv, n_blocks))
    return "".join(out)


def prepare_ea(vfs, copy, log=print, origin_bsp=None, map_path=None):
    """The map's copy made as EA's compiler takes it (ea_prepare), with a decompiled map's
    vis_leafgroups restored from its original .bsp (restore_leafgroups)."""
    with open(copy, "r", encoding="latin-1", newline="") as f:
        text = f.read()
    out = ea_prepare(text, vfs, log)
    if '"vis_leafgroup"' not in out and re.search(r"\)\s+common/vis\s", out):
        data = find_origin_bsp(out, map_path, vfs, origin_bsp)
        if data:
            try:
                out = restore_leafgroups(out, data, log)
            except (ValueError, IndexError, struct.error) as e:
                MC.swallowed()     # a damaged .bsp: compile without the groups
                log("(the original .bsp's vis groups can't be read (%s): compiling without them)" % str(e)[:120])
        else:
            log("(this map's vis brushes have no vis_leafgroups and its original .bsp wasn't found: "
                "full vis may take very long; fast vis doesn't)")
    if "terrainDef" in out and not _TERRAIN_WORDS.search(out) and decompiled_from(out):
        for data in origin_bsp_candidates(out, map_path, vfs, origin_bsp):
            try:
                if _has_nodetail(data):
                    out = restore_terrain_detail(out, data, log)
                    break
            except Exception as e:
                MC.swallowed()     # a damaged .bsp: try the next, else the terrain as it is
                log("(a .bsp's terrain detail can't be read (%s))" % str(e)[:120])
    if out != text:
        with open(copy, "w", encoding="latin-1", newline="") as f:
            f.write(out)


# Switches a step may be given besides its own (Compile's options, as MBuilder offers them):
# a word of letters, digits, _ . and -, or a number; never one that points the compiler
# somewhere else.
OPTION_RE = re.compile(r"^(-[A-Za-z][A-Za-z0-9_.]*|-?[0-9]+(\.[0-9]+)?)$")
OPTION_DENY = {"-gamedir", "-tempname", "-tmpin", "-tmpout", "-moddir"}
# ommap's own progress: "0...1...2..." on one line, one digit a tenth done
_PROGRESS = re.compile(r"(\d)\.\.\.")


def check_options(words):
    """The extra switches for a step, checked: (list, None) or (None, why)."""
    out = []
    for w in words or ():
        w = str(w).strip()
        if not w:
            continue
        if not OPTION_RE.match(w) or w.lower() in OPTION_DENY:
            return None, "%r isn't a switch Compile passes on (a word starting with -, or a number)" % w[:40]
        out.append(w)
    return out, None


def run_step(exe, step, gamedir, map_copy, log, procs=None, extra=()):
    """One ommap step; each line of its output goes to log(line), its progress dots as
    "  20%" lines while they come. Its exit code."""
    cmd = [exe] + STEP_ARGS[step] + list(extra) + ["-gamedir", gamedir, map_copy]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         cwd=os.path.dirname(map_copy), env=MC.child_env(), **NOWIN)
    if procs is not None:
        procs.append(p)
    buf, shown = "", set()
    try:
        while True:
            chunk = p.stdout.read1(4096) if hasattr(p.stdout, "read1") else p.stdout.read(4096)
            if not chunk:
                break
            buf += chunk.decode("latin-1", "replace").replace("\r", "\n")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                if _PROGRESS.search(line) and not _PROGRESS.sub("", line).strip(" ()0123456789"):
                    for d in _PROGRESS.findall(line):
                        if d not in shown and d != "0":
                            log("  %s0%%" % d)
                    shown.clear()
                    continue
                log(line.rstrip())
            for d in _PROGRESS.findall(buf):
                if d not in shown:
                    shown.add(d)
                    if d != "0":
                        log("  %s0%%" % d)
        if buf.strip():
            log(buf.rstrip())
        p.wait(timeout=STEP_TIMEOUT)
    except subprocess.TimeoutExpired:
        MC.swallowed()
        p.kill()
        log("(stopped: the step took more than %d minutes)" % (STEP_TIMEOUT // 60))
        return -1
    finally:
        p.stdout.close()
    return p.returncode


def read_lin(path, limit=4096):
    """The leak trail: the points ommap wrote, from the void to an entity."""
    pts = []
    with open(path, "r", encoding="latin-1") as f:
        for line in f:
            v = line.split()
            if len(v) >= 3:
                try:
                    pts.append([float(v[0]), float(v[1]), float(v[2])])
                except ValueError:
                    MC.swallowed()
            if len(pts) >= limit:
                break
    return pts


IMAGE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*\.tga$")


def _shader_blocks(text):
    """(name, body) of each top-level shader in a script."""
    text = re.sub(r"//[^\n]*", "", text)
    out = []
    i, n = 0, len(text)
    while i < n:
        m = re.compile(r"\s*([^\s{}]+)\s*\{").match(text, i)
        if not m:
            j = text.find("{", i)
            if j < 0:
                break
            i = j + 1
            depth = 1
            while i < n and depth:
                depth += {"{": 1, "}": -1}.get(text[i], 0)
                i += 1
            continue
        start = m.end()
        depth, i = 1, start
        while i < n and depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        out.append((m.group(1).lower(), text[start:i - 1]))
    return out


def alpha_shadow_images(vfs, gamedir, used, log=print):
    """The light step needs the images of the map's alphashadow shaders (foliage, tree
    lines, fences: light passes through their clear texels): ommap reads plain files, not
    the paks, so their .tga images are copied into the game folder. A missing image makes
    ommap treat the whole surface as solid. The count copied."""
    want = {}
    sdir = os.path.join(gamedir, "scripts")
    for base in sorted(os.listdir(sdir)):
        if not base.endswith(".shader"):
            continue
        with open(os.path.join(sdir, base), encoding="latin-1") as f:
            text = f.read()
        for name, body in _shader_blocks(text):
            if name not in used or name in want:
                continue
            low = body.lower()
            if "alphashadow" not in low:
                continue
            cands = []
            for key in ("q3map_lightimage", "qer_editorimage"):
                m = re.search(key + r"\s+(\S+)", body, re.I)
                if m:
                    cands.append(m.group(1))
            cands.append(name + ".tga")
            want[name] = cands
    n = 0
    for name, cands in want.items():
        for img in cands:
            img = img.replace("\\", "/")
            if not img.lower().endswith(".tga"):
                img += ".tga"
            if ".." in img or not IMAGE_RE.match(img):
                continue
            data = vfs.read(img) if vfs.exists(img) else None
            if data is None:
                continue
            dest = os.path.join(gamedir, *img.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if not os.path.exists(dest):
                with open(dest, "wb") as f:
                    f.write(data)
            n += 1
            break
        else:
            log("(no image for %s: light can't pass through it)" % name)
    return n


IMAGE_ANY_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(tga|jpg)$", re.I)


def map_shaders(text):
    """The shaders a .map names, as it writes them (ommap looks for their images by these
    names, and a file system can tell case apart), with textures/ as ommap adds it: its
    brush faces, patches and terrain."""
    out = set()
    lines = text.splitlines()
    for i, line in enumerate(lines):
        t = line.strip()
        if t.startswith("(") and ")" in t:
            rest = t[t.rfind(")") + 1:].split()
            if rest and not rest[0][0].isdigit() and rest[0][0] not in "-(":
                out.add(rest[0] if rest[0].lower().startswith("textures/") else "textures/" + rest[0])
        elif t.lower().startswith("patchdef"):
            j = i + 1
            while j < len(lines) and lines[j].strip() in ("", "{"):
                j += 1
            if j < len(lines) and lines[j].strip():
                name = lines[j].split()[0]
                out.add(name if name.lower().startswith("textures/") else "textures/" + name)
        for m in re.finditer(r"\(\s*(textures/[^\s()]+)", t):
            out.add(m.group(1))
    return out


def texture_images(vfs, gamedir, used, log=print):
    """The bsp step lays each surface's texture out by its image's size, and the fence
    equations too: ommap reads plain files, not the paks, and takes a missing image as
    64 by 64, so every other size came out stretched or squeezed. The image ommap would
    use for each shader the map names (its q3map_lightimage, then its qer_editorimage,
    then the shader's own name; .tga, else .jpg, as ommap tries them) is copied into the
    game folder. The count copied."""
    blocks = {}
    sdir = os.path.join(gamedir, "scripts")
    for base in sorted(os.listdir(sdir)):
        if not base.endswith(".shader"):
            continue
        with open(os.path.join(sdir, base), encoding="latin-1") as f:
            for name, body in _shader_blocks(f.read()):
                blocks.setdefault(name, body)
    n = 0
    for name in sorted(used):
        body = blocks.get(name.lower(), "")
        cands = []
        for key in ("q3map_lightimage", "qer_editorimage"):
            m = re.search(key + r"\s+(\S+)", body, re.I)
            if m:
                cands.append(m.group(1))
        cands.append(name + ".tga")
        found = False
        for img in cands:
            img = img.replace("\\", "/")
            if not os.path.splitext(img)[1]:
                img += ".tga"
            for path in (img, os.path.splitext(img)[0] + ".jpg"):
                if ".." in path or not IMAGE_ANY_RE.match(path) or not vfs.exists(path):
                    continue
                dest = os.path.join(gamedir, *path.split("/"))
                if not os.path.exists(dest):
                    data = vfs.read(path)
                    if data is None:
                        continue
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with open(dest, "wb") as f:
                        f.write(data)
                    n += 1
                found = True
                break
            if found:
                break
    return n


def _bsp_shaders(data):
    """The shader names a .bsp uses (lower case)."""
    off, ln = struct.unpack_from("<ii", data, 12)
    return {data[off + i * 140:off + i * 140 + 64].split(b"\0")[0].decode("latin-1").lower()
            for i in range(ln // 140)}


def _axis(angles):
    """forward, left, up of "pitch yaw roll" (AngleVectorsLeft, q_math.c)."""
    p, y, r = (math.radians(a) for a in angles)
    sp, cp, sy, cy, sr, cr = math.sin(p), math.cos(p), math.sin(y), math.cos(y), math.sin(r), math.cos(r)
    fwd = (cp * cy, cp * sy, -sp)
    left = (-(-sr * sp * cy + cr * sy), -(-sr * sp * sy - cr * cy), sr * cp)
    up = (cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp)
    return fwd, left, up


def static_model_vertices(vfs, bsp_data, log=print):
    """The .smv for ommap's light step: "SMV1", the static model count, then for each (in
    the .bsp's order) its vertex count and each vertex's world position and normal (6
    floats). A model whose vertices can't be had gets 0, and then ommap writes no vertex
    light at all (the game reads one model's light where another's starts otherwise)."""
    import mohaa_bsp as MB
    import mohaa_map_view as MMV
    bsp = MB.Bsp(bsp_data)
    builder = MMV.ModelBuilder(vfs, None, None, say=lambda *a: None)
    cache = {}
    out = [b"SMV1", struct.pack("<i", len(bsp.static_models))]
    missing = 0
    for sm in bsp.static_models:
        path = MMV._norm_model_path(sm["model"])
        if path not in cache:
            try:
                cache[path] = builder.engine_vertices(path)
            except Exception as e:
                MC.swallowed()
                log("(no vertex light for %s: %s)" % (sm["model"], str(e)[:120]))
                cache[path] = None
        verts = cache[path]
        if not verts or len(verts) > 32767:
            missing += 1
            out.append(struct.pack("<i", 0))
            continue
        fwd, left, up = _axis(sm["angles"])
        o, k = sm["origin"], sm["scale"]
        buf = bytearray(struct.pack("<i", len(verts)))
        for (x, y, z), (nx, ny, nz) in verts:
            w = [o[i] + k * (x * fwd[i] + y * left[i] + z * up[i]) for i in range(3)]
            n = [nx * fwd[i] + ny * left[i] + nz * up[i] for i in range(3)]
            buf += struct.pack("<6f", w[0], w[1], w[2], n[0], n[1], n[2])
        out.append(bytes(buf))
    return b"".join(out), missing


# ---- the files EA's Q3map leaves beside the .bsp ------------------------------------------
# Q3map (MBuilder runs it, then MOHlight, which only rewrites the .bsp) works in the game's
# maps folder, so what it writes stays beside the map:
#   <map>.prt  the portal file its vis step reads (written when the map is sealed); the game
#              reads it only for r_showportal (tr_vis.cpp)
#   <map>.lin  the leak trail (written when the map leaks)
#   <map>.vis  a BSP-format file (ident "2015", version 19) holding only the visibility lump,
#              written after every .bsp it writes, with the header's checksum
#              (Com_BlockChecksum) set; Q3map has a reader for it that nothing calls, and
#              the game doesn't read it
# Before a build it deletes the old .prt and .lin, so neither outlives the map it was for.
# The others beside a map are the game's own: the .dcl (the decals placed with its decal
# editor, kept only while the .bsp's map_time matches: re-save them in the game after a
# compile, R_LevelMarksLoad), the .pth (the AI's paths, rebuilt by the game when the
# map_time changes) and the .min (the loading screen's map info).

def _md4(data):
    """MD4 (RFC 1320): hashlib's isn't there on most systems now (OpenSSL 3)."""
    import struct as st
    msg = bytearray(data)
    n = len(msg) * 8
    msg.append(0x80)
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += st.pack("<Q", n & 0xFFFFFFFFFFFFFFFF)
    a, b, c, d = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476
    rl = lambda x, k: ((x << k) | (x >> (32 - k))) & 0xFFFFFFFF
    for o in range(0, len(msg), 64):
        X = st.unpack("<16I", bytes(msg[o:o + 64]))
        A, B, C, D = a, b, c, d
        F = lambda x, y, z: (x & y) | (~x & z)
        G = lambda x, y, z: (x & y) | (x & z) | (y & z)
        H = lambda x, y, z: x ^ y ^ z
        for i in range(16):
            k, sh = i, (3, 7, 11, 19)[i % 4]
            A = rl((A + F(B, C, D) + X[k]) & 0xFFFFFFFF, sh); A, B, C, D = D, A, B, C
        for i in range(16):
            k, sh = (i % 4) * 4 + i // 4, (3, 5, 9, 13)[i % 4]
            A = rl((A + G(B, C, D) + X[k] + 0x5A827999) & 0xFFFFFFFF, sh); A, B, C, D = D, A, B, C
        for i in range(16):
            k, sh = (0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15)[i], (3, 9, 11, 15)[i % 4]
            A = rl((A + H(B, C, D) + X[k] + 0x6ED9EBA1) & 0xFFFFFFFF, sh); A, B, C, D = D, A, B, C
        a, b, c, d = (a + A) & 0xFFFFFFFF, (b + B) & 0xFFFFFFFF, (c + C) & 0xFFFFFFFF, (d + D) & 0xFFFFFFFF
    return st.pack("<4I", a, b, c, d)


def block_checksum(data):
    """Com_BlockChecksum (common/md4.c): the MD4 digest's four words XORed."""
    w = struct.unpack("<4i", _md4(data))
    return (w[0] ^ w[1] ^ w[2] ^ w[3]) & 0xFFFFFFFF


def vis_file(bsp_data):
    """The <map>.vis Q3map writes beside a .bsp (FUN_0043f38c in the decompile): a header of
    28 lumps with only the visibility lump (15) set, its bytes after the header (padded to 4),
    and the header's checksum (Com_BlockChecksum of the header with the field 0)."""
    nl = 28
    ident, ver = bsp_data[:4], struct.unpack_from("<i", bsp_data, 4)[0]
    if ident != b"2015" or ver != 19 or len(bsp_data) < 12 + nl * 8:
        return None
    ofs, ln = struct.unpack_from("<ii", bsp_data, 12 + 15 * 8)
    if ofs < 0 or ln < 0 or ofs + ln > len(bsp_data):
        return None
    vis = bsp_data[ofs:ofs + ln]
    head = bytearray(12 + nl * 8)
    head[0:4] = b"2015"
    struct.pack_into("<ii", head, 4, 19, 0)
    struct.pack_into("<ii", head, 12 + 15 * 8, len(head), len(vis))
    struct.pack_into("<I", head, 8, block_checksum(bytes(head)))
    return bytes(head) + vis + b"\0" * ((4 - len(vis) % 4) % 4)


def compile_map(map_path, vfs, work, steps=STEPS, log=print, procs=None, origin_bsp=None, options=None):
    """Compile map_path: the steps in order, the results beside it. A dict: ok, bsp (its
    path), leak (the trail's points, or None), steps (those that ran), why (when not ok),
    times ({step: seconds}). options: extra switches {"bsp": [...], "vis": [...], "light":
    [...]} (vis's go to fast vis too)."""
    extra = {}
    for k in ("bsp", "vis", "light"):
        extra[k], why = check_options((options or {}).get(k))
        if why:
            return dict(ok=False, why=why, steps=[])
    extra["fastvis"] = extra["vis"]
    times = {}
    exe = ommap_path()
    if not exe:
        return dict(ok=False, why="there is no ommap build for this system (%s) in bin/ommap" % platform_dir(), steps=[])
    gamedir, copy = prepare(vfs, work, map_path)
    if "bsp" in steps:
        prepare_ea(vfs, copy, log, origin_bsp, map_path)
    stem = os.path.splitext(os.path.basename(map_path))[0]
    out_bsp = os.path.join(os.path.dirname(copy), stem + ".bsp")
    out_lin = os.path.join(os.path.dirname(copy), stem + ".lin")
    out_prt = os.path.join(os.path.dirname(copy), stem + ".prt")
    side = os.path.splitext(os.path.abspath(map_path))[0]      # <map> beside the .map
    onlyents = "bsp" in steps and "-onlyents" in extra["bsp"]
    if onlyents:
        # MBuilder's Entities only: ommap rewrites the entity lump of the .bsp compiled before
        old = os.path.splitext(os.path.abspath(map_path))[0] + ".bsp"
        if not os.path.isfile(old) and origin_bsp and os.path.isfile(origin_bsp):
            old = origin_bsp
        if not os.path.isfile(old):
            return dict(ok=False, why="Entities only (-onlyents) rewrites the entities of a .bsp compiled before, "
                                      "and there is no %s.bsp beside the map" % stem, steps=[])
        shutil.copyfile(old, out_bsp)
        log("(entities only: the entities of %s are replaced, its brushes, vis and light kept)" % old)
    done, leak = [], None
    for step in steps:
        if step not in STEPS:
            return dict(ok=False, why="unknown step %r" % step, steps=done)
        if step in ("vis", "fastvis") and leak is not None:
            log("(vis skipped: the map leaks, so it has no inside to divide)")
            continue
        if step in ("vis", "fastvis") and onlyents:
            log("(vis skipped: entities only keeps the .bsp's vis)")
            continue
        log("---- %s ----" % step)
        if step == "bsp":
            try:
                with open(copy, encoding="latin-1") as f:
                    used = map_shaders(f.read())
                log("(%d texture images copied for the compiler)" % texture_images(vfs, gamedir, used, log))
            except Exception as e:
                MC.swallowed()
                log("(texture images not copied, so textures may be laid out wrongly: %s)" % str(e)[:160])
        if step == "light":
            smv = os.path.splitext(copy)[0] + ".smv"
            try:
                if os.path.exists(smv):
                    os.remove(smv)          # never an older compile's models
                with open(out_bsp, "rb") as f:
                    bsp_data = f.read()
                alpha_shadow_images(vfs, gamedir, _bsp_shaders(bsp_data), log)
                data, missing = static_model_vertices(vfs, bsp_data, log)
                with open(smv, "wb") as f:
                    f.write(data)
                if missing:
                    log("(static models: %d can't be read, so none get vertex light)" % missing)
            except Exception as e:
                MC.swallowed()
                log("(static models get no vertex light: %s)" % str(e)[:160])
        t0 = time.time()
        rc = run_step(exe, step, gamedir, copy, log, procs, extra.get(step, ()))
        times[step] = time.time() - t0
        log("(%s: %s)" % (step, _duration(times[step])))
        if rc != 0:
            why = ("ommap's %s step was stopped" % step) if rc < 0 else ("ommap's %s step stopped with code %d" % (step, rc))
            return dict(ok=False, why=why, steps=done)
        done.append(step)
        if step == "bsp" and os.path.isfile(out_lin):
            leak = read_lin(out_lin)
    if not os.path.isfile(out_bsp):
        return dict(ok=False, why="ommap wrote no .bsp", steps=done)
    dest = os.path.splitext(os.path.abspath(map_path))[0] + ".bsp"
    with open(out_bsp, "rb") as f:
        data = f.read()
    MC.atomic_write_bytes(dest, data, backup=True)
    with open(dest, "rb") as f:
        if f.read() != data:
            return dict(ok=False, why="%s reads back differently from what was written" % dest, steps=done)
    wrote = []
    if "bsp" in done and not onlyents:
        # as Q3map: the old .prt and .lin go, then this build's (one or the other) is kept
        for ext in (".lin", ".prt"):
            try:
                if os.path.isfile(side + ext):
                    os.remove(side + ext)
                    log("(removed the old %s%s)" % (stem, ext))
            except OSError as e:
                log("(couldn't remove the old %s%s: %s)" % (stem, ext, e))
        for src_f, ext in ((out_lin if leak is not None else None, ".lin"), (out_prt, ".prt")):
            if src_f and os.path.isfile(src_f):
                shutil.copyfile(src_f, side + ext)
                wrote.append(stem + ext)
    vf = vis_file(data)
    if vf is not None:
        try:
            MC.atomic_write_bytes(side + ".vis", vf)
            wrote.append(stem + ".vis")
        except OSError as e:
            log("(couldn't write %s.vis: %s)" % (stem, e))
    if wrote:
        log("(also beside the map, as Q3map leaves them: %s)" % ", ".join(wrote))
    return dict(ok=True, bsp=dest, leak=leak, steps=done, times=times, side=wrote)


def _duration(sec):
    """"8 s", "4 min 10 s", "2 h 05 min"."""
    sec = int(round(sec))
    if sec < 60:
        return "%d s" % sec
    if sec < 3600:
        return "%d min %02d s" % (sec // 60, sec % 60)
    return "%d h %02d min" % (sec // 3600, sec % 3600 // 60)
