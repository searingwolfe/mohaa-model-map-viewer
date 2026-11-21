"""Write bin/data/class_specs.json: the keys each game class takes from a map, for the Map
Editor's Class specs.

Read from OpenMoHAA's game code (code/fgame/*.cpp, GPLv2 like this program):
  - every Event definition: Event EV_x ( "name", flags, "format", "argument names",
    "documentation", type ), and the version comment on its line ("// Added in 2.0" for
    Spearhead, "2.30" / "2.40" for Breakthrough, "OPM" for OpenMoHAA's own);
  - every CLASS_DECLARATION(Parent, Class, "classname") and the events in its response table.

A map's key becomes an event of the same name, its value the event's arguments
(SpawnArgs::Spawn in g_spawn.cpp: ev = new Event(key); ev->AddToken(value)), so a class
takes as keys the events it and its parents respond to. Kept here: normal and setter events
whose arguments a key can hold (no entity arguments); getters and return events are left
out. Optionally, an Allied Assault "dumpallclasses" listing (g_allclasses.html) is read to
mark the events of each class that Allied Assault itself doesn't have, where OpenMoHAA's
comments don't say.

    python tools/make_class_specs.py <openmohaa>/code/fgame [g_allclasses.html]
"""
import glob
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "bin", "data", "class_specs.json")

_TOK = re.compile(r'"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_|]*)|(-?\d+)|([,()])|(\s+)|(//[^\n]*)|(/\*.*?\*/)', re.S)


def _args(text):
    """The comma-separated arguments of an Event(...) definition (adjacent strings joined)."""
    out, cur, depth = [], None, 0
    for m in _TOK.finditer(text):
        s, ident, num, punct = m.group(1), m.group(2), m.group(3), m.group(4)
        if s is not None:
            s = bytes(s, "latin-1").decode("unicode_escape", "replace") if "\\" in s else s
            cur = (cur or "") + s if isinstance(cur, str) or cur is None else s
        elif ident is not None:
            cur = None if ident == "NULL" else ident
            if cur is not None:
                cur = ("@" + ident)
        elif num is not None:
            cur = "@" + num
        elif punct == "(":
            depth += 1
        elif punct == ")":
            depth -= 1
        elif punct == ",":
            out.append(cur)
            cur = None
    out.append(cur)
    return out


def _version(comment):
    c = comment or ""
    m = re.search(r"Added in\s+(OPM|[\d.]+[\w-]*)", c)
    if not m:
        return ""
    v = m.group(1)
    if v == "OPM":
        return "OPM"
    try:
        major = float(re.match(r"\d+(\.\d+)?", v).group(0))
    except (AttributeError, ValueError):
        return "SH"
    return "BT" if major >= 2.3 else "SH"


def read_events(files):
    """var -> {n: name, a: format, an: argument names, d: doc, t: type, v: version}."""
    ev = {}
    pat = re.compile(r"^Event\s+(EV_\w+)\s*(//[^\n]*)?\s*\(\s*(.*?)\)\s*;", re.M | re.S)
    for f in files:
        text = open(f, encoding="latin-1").read()
        for m in pat.finditer(text):
            a = _args(m.group(3))
            if not a or not isinstance(a[0], str) or a[0].startswith("@"):
                continue
            fmt = a[2] if len(a) > 2 and a[2] and not a[2].startswith("@") else ""
            names = a[3] if len(a) > 3 and a[3] and not a[3].startswith("@") else ""
            doc = a[4] if len(a) > 4 and a[4] and not a[4].startswith("@") else ""
            typ = a[5][1:] if len(a) > 5 and a[5] and a[5].startswith("@") else "EV_NORMAL"
            flags = a[1][1:] if len(a) > 1 and a[1] and a[1].startswith("@") else ""
            ev[m.group(1)] = {"n": a[0], "a": fmt, "an": names, "d": " ".join(doc.split()), "t": typ,
                              "f": flags, "v": _version(m.group(2))}
    return ev


def read_classes(files):
    """Class -> {p: parent, id: classname or "", ev: [event vars], v: version}."""
    cls = {}
    pat = re.compile(r"CLASS_DECLARATION\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\"[^\"]*\"|NULL)\s*\)\s*(//[^\n]*)?\s*\{(.*?)\n\s*\{\s*NULL", re.S)
    for f in files:
        text = open(f, encoding="latin-1").read()
        for m in pat.finditer(text):
            vars_ = re.findall(r"\{\s*&(EV_\w+)\s*,", m.group(5))
            cls[m.group(2)] = {"p": m.group(1), "id": m.group(3).strip('"') if m.group(3) != "NULL" else "",
                               "ev": vars_, "v": _version(m.group(4))}
    return cls


def read_aa_dump(path):
    """Class -> set of event names in an Allied Assault dumpallclasses listing."""
    t = open(path, encoding="latin-1").read()
    out = {}
    for m in re.finditer(r'<h2>\s*<a name="?(\w+)"?>.*?</h2>(.*?)</BLOCKQUOTE>', t, re.S | re.I):
        names = set(re.findall(r"<P><tt><B>([^<]+)</B>", m.group(2), re.I))
        out[m.group(1)] = {n.strip().lower() for n in names}
    return out


_ARGTYPE = {"s": "string", "f": "float", "i": "integer", "b": "boolean", "v": "vector", "e": "entity"}


def key_ok(e):
    """A key a map can give: an event of normal or setter type, no entity arguments, not
    one only the game code sends (EV_CODEONLY, or named with a leading _: _ladder_setup...)."""
    if e["t"] not in ("EV_NORMAL", "EV_SETTER") or "EV_CODEONLY" in e.get("f", "") or e["n"].startswith("_"):
        return False
    fmt = e["a"].lower()
    return "e" not in fmt and "l" not in fmt


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    src = argv[1]
    files = sorted(glob.glob(os.path.join(src, "*.cpp")))
    if not files:
        print("no .cpp files in", src)
        return 1
    ev = read_events(files)
    cls = read_classes(files)
    aa = read_aa_dump(argv[2]) if len(argv) > 2 else None
    events, classes, unmarked = {}, {}, 0
    for c, d in sorted(cls.items()):
        keys = []
        if not d["v"] and aa is not None and c not in aa:
            d["v"] = "SH"                     # a class Allied Assault doesn't have
        for var in d["ev"]:
            e = ev.get(var)
            if not e or not key_ok(e):
                continue
            ver = e["v"] or d["v"]
            # an event Allied Assault's own listing doesn't give this class (or one it has)
            if not ver and aa is not None and c in aa and e["n"].lower() not in aa[c]:
                ver = "SH"
                unmarked += 1
            k = e["n"]
            rec = events.setdefault(k.lower(), {})
            sig = e["a"] + "|" + e["an"]
            if sig not in rec:
                rec[sig] = {"n": k, "a": e["a"], "an": e["an"], "d": e["d"][:400]}
            keys.append([k, sig, ver])
        classes[c] = {"p": d["p"], "id": d["id"], "k": keys, "v": d["v"]}
    out = {"src": "OpenMoHAA code/fgame (GPLv2)", "types": _ARGTYPE, "classes": classes,
           "events": {k: list(v.values()) for k, v in events.items()}}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)
    print("wrote %s: %d classes, %d key names%s" % (os.path.normpath(OUT), len(classes), len(events),
          ("; %d more marked not in Allied Assault from its listing" % unmarked) if aa is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
