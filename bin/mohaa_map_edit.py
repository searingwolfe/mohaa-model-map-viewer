#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ==============================================================================
#  mohaa_map_edit.py  --  the Map Viewer's map editor (Edit map)
#
#  EditApp is the Map Viewer's window (mohaa_map_launcher.MapApp) with the map editor built
#  in; mohaa_map_launcher.py runs it. With Edit map off (the toolbar button or View > Edit
#  map, Ctrl+Shift+E) it is the Map Viewer exactly, but for File > New map... and Compile map...,
#  which are always there. Every map page carries the editor's page code
#  (bin/mohaa_map_editor.js), dormant; the toggle turns it on or off in the open page, in
#  place (setEditorMode; the page URL carries #edit=1 while it is on).
#    - a cached page is reused only if it is newer than the editor's own files;
#    - the page's requests (the level script, the texture browser, compiling, New map) are
#      answered here.
#  File > New map... (and the page's New map button, `mohaa-edit-new`) writes a starter
#  .map where you choose: a sealed room with a player start and a light, checked by reading
#  it back and rebuilding every brush from its planes, then opens it with Edit map on.
# ==============================================================================
# --- Vendored dependencies (bin/libs on Windows, bin/libs-linux on Linux, bin/libs-mac on macOS)
import sys
import os
_LIBS_NAME = "libs" if sys.platform.startswith("win") else ("libs-mac" if sys.platform == "darwin" else "libs-linux")
_libs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), _LIBS_NAME)
if os.path.isdir(_libs_dir) and _libs_dir not in sys.path:
    sys.path.insert(0, _libs_dir)
_bin_dir = os.path.dirname(os.path.abspath(__file__))
if _bin_dir not in sys.path:
    sys.path.insert(0, _bin_dir)
import mohaa_common as MC                       # logging, atomic writes, settings, Pillow guard
import mohaa_launcher as ML                     # the shared launcher window
import mohaa_map_launcher as MM                 # the Map Viewer's window, which this one is
from mohaa_launcher import filedialog, _mi, _MSEP, tk, ttk
import json, re, shlex, shutil, subprocess, threading
import mohaa_compile as MCO                     # running ommap, the map compiler
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = MC.get_logger("map_edit")
try:
    import mohaa_bsp as MB                      # plane maths, to check a written map's brushes
except Exception:
    # the Map Viewer's launcher logs the same import failure; New map says it can't check
    LOG.error("mohaa_bsp could not be imported; New map can't check what it writes", exc_info=True)
    MB = None
EDITOR_JS = os.path.join(HERE, "mohaa_map_editor.js")
# Files the editor page is built from besides the Map Viewer's (MapApp._html_current
# already checks the Map Viewer's scripts).
EDITOR_SOURCES = [os.path.abspath(__file__), EDITOR_JS]
NEW_MAPS_DIR = "my_maps"                        # New map's first folder, in DATADIR
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$")
SCR_MAX = 4 * 1024 * 1024                       # a level script the page may save (characters)
REQ_MAX = SCR_MAX + 64 * 1024                   # a page request carrying one
# the level script a map without one starts from (the game runs maps/<name>.scr's main
# thread when the map loads)
SCR_START = ("// {name}.scr: the level script, run when the map loads.\n"
             "main:\n"
             "\tlevel waittill prespawn\n"
             "\t// what runs before the players spawn\n"
             "\tlevel waittill spawn\n"
             "\t// what runs once they have\n"
             "end\n")


# ---- New map: the starter room ------------------------------------------------------
# Inside: 512 x 512 x 256 units, the floor at z 0; walls, floor and ceiling 16 thick. Each
# slab's face toward the room carries a texture the retail maps use, its other faces caulk
# (never drawn, as mappers hide the outsides).
ROOM_HALF = 256
ROOM_HEIGHT = 256
WALL = 16
CAULK = "common/caulk"
FLOOR_TEX = "general_structure/jh_conc512b"
WALL_TEX = "mohtest/stonewall1grim"
CEILING_TEX = "general_structure/plank_flat"


def _box_faces(mins, maxs):
    """The six faces of an axis-aligned box: (outward normal, dist, three points). The
    points are ordered so q3map's MapPlaneFromPoints (normal = cross(p0-p1, p2-p1), see
    mohaa_bsp.plane_from_points) gives back this normal and dist."""
    out = []
    for axis in range(3):
        for sign in (-1, 1):
            n = [0, 0, 0]
            n[axis] = sign
            v = maxs[axis] if sign > 0 else mins[axis]
            u, w = [a for a in range(3) if a != axis]
            pts = []
            for cu, cw in ((mins[u], mins[w]), (maxs[u], mins[w]), (mins[u], maxs[w])):
                p = [0, 0, 0]
                p[axis], p[u], p[w] = v, cu, cw
                pts.append(tuple(p))
            # cross(p0-p1, p2-p1) for these corners points along -axis when (u, w) are in
            # order: flip the winding for the faces that look the other way
            c = _cross3(_sub3(pts[0], pts[1]), _sub3(pts[2], pts[1]))
            if c[axis] * sign < 0:
                pts = [pts[2], pts[1], pts[0]]
            out.append((tuple(n), sign * v, pts))
    return out


def _sub3(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross3(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _n(v):
    """A coordinate as the decompiler writes it: an integer without a decimal point."""
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def _brush_lines(mins, maxs, inner_normal, tex):
    """One brush: the face whose normal is inner_normal gets tex, the others caulk."""
    lines = ["{"]
    for n, _d, pts in _box_faces(mins, maxs):
        t = tex if n == inner_normal else CAULK
        lines.append("( %s ) ( %s ) ( %s ) %s 0 0 0 0.5 0.5 0 0 0" % (
            " ".join(_n(c) for c in pts[0]), " ".join(_n(c) for c in pts[1]),
            " ".join(_n(c) for c in pts[2]), t))
    lines.append("}")
    return lines


def starter_map(title):
    """The .map text New map writes: worldspawn with the room's six brushes, a player
    start in the middle of the floor and a light under the ceiling."""
    h, top, t = ROOM_HALF, ROOM_HEIGHT, WALL
    slabs = [
        ((-h - t, -h - t, -t), (h + t, h + t, 0), (0, 0, 1), FLOOR_TEX),
        ((-h - t, -h - t, top), (h + t, h + t, top + t), (0, 0, -1), CEILING_TEX),
        ((-h - t, -h, 0), (-h, h, top), (1, 0, 0), WALL_TEX),
        ((h, -h, 0), (h + t, h, top), (-1, 0, 0), WALL_TEX),
        ((-h - t, -h - t, 0), (h + t, -h, top), (0, 1, 0), WALL_TEX),
        ((-h - t, h, 0), (h + t, h + t, top), (0, -1, 0), WALL_TEX),
    ]
    safe = re.sub(r'["{}\r\n]', "", str(title))[:60] or "new map"
    out = ["// MOHAA map source written by the MOHAA Map Editor's New map.",
           "// entity 0", "{", '"classname" "worldspawn"', '"message" "%s"' % safe]
    for i, (mn, mx, inner, tex) in enumerate(slabs):
        out.append("// brush %d" % i)
        out.extend(_brush_lines(mn, mx, inner, tex))
    out += ["}",
            "// entity 1", "{", '"classname" "info_player_start"', '"origin" "0 0 16"', '"angle" "90"', "}",
            "// entity 2", "{", '"classname" "info_player_deathmatch"', '"origin" "-128 0 16"', '"angle" "0"', "}",
            "// entity 3", "{", '"classname" "light"', '"origin" "0 0 %d"' % (top - 32), '"light" "400"', "}", ""]
    return "\n".join(out)


_FACE_RE = re.compile(r"^\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)\s*"
                      r"\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)\s*"
                      r"\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)\s+(\S+)")


def check_map_text(text):
    """Check .map text made only of entities and plain brushes (what New map writes) the
    way the compiler reads its brushes: braces balance, and every brush's planes (from its
    three points) close into a solid with a face on each plane. Patches and terrain are
    refused (a brace three deep). Returns (ok, message, counts)."""
    depth, brushes, ents, faces = 0, [], 0, None
    for ln in text.splitlines():
        s = ln.strip()
        if not s or s.startswith("//"):
            continue
        if s == "{":
            depth += 1
            if depth == 1: ents += 1
            elif depth == 2: faces = []
            else: return False, "a brace three deep", None
        elif s == "}":
            if depth == 2:
                brushes.append(faces); faces = None
            depth -= 1
            if depth < 0: return False, "a closing brace without an opening one", None
        elif depth == 2:
            m = _FACE_RE.match(s)
            if not m: return False, "a brush line that isn't a face: %r" % s[:60], None
            v = [float(x) for x in m.groups()[:9]]
            faces.append(((v[0], v[1], v[2]), (v[3], v[4], v[5]), (v[6], v[7], v[8]), m.group(10)))
    if depth != 0:
        return False, "the braces don't balance", None
    if MB is not None:
        for bi, fs in enumerate(brushes):
            planes = []
            for p0, p1, p2, _tex in fs:
                pl = MB.plane_from_points(p0, p1, p2)
                if pl is None: return False, "brush %d has a face whose points are in a line" % bi, None
                planes.append(pl)
            ws = MB.brush_windings(planes)
            if len(ws) < 4 or any(len(w) < 3 or MB.winding_area(w) <= 0 for w in ws):
                return False, "brush %d doesn't close into a solid" % bi, None
            # closed: every corner inside the world (q3map's MAX_WORLD_COORD), and the faces'
            # area-weighted normals add up to nothing (a side missing leaves a hole)
            if any(abs(c) > MB.MAX_WORLD_COORD for w in ws for p in w for c in p):
                return False, "brush %d is open or reaches past the edge of the world" % bi, None
            tot, area = [0.0, 0.0, 0.0], 0.0
            for (n, _d), w in zip(planes, ws):
                a = MB.winding_area(w); area += a
                for k in range(3): tot[k] += n[k] * a
            if max(abs(x) for x in tot) > 1e-6 * max(area, 1.0):
                return False, "brush %d doesn't close into a solid" % bi, None
    return True, "%d entities, %d brushes" % (ents, len(brushes)), {"entities": ents, "brushes": len(brushes)}


class EditApp(MM.MapApp):
    """The Map Viewer's launcher window with the map editor (see the top of this file)."""
    EDITOR_LABEL = "Edit map"
    EDITOR_TIP = ("Edit map (Ctrl+Shift+E): open maps in the map editor - brushes, patches, terrain,\n"
                  "brush entities and the level script, as well as Modify. File > New map... and\n"
                  "Compile map... (F9) work either way. Off: the Map Viewer's panel.\n"
                  "Switching changes the open page in place; nothing is rebuilt.")

    def _editor_active(self):
        return bool(self._editor_on.get())

    def _html_current(self, hp):
        """Every map page carries the editor's code (dormant until Edit map is on): reuse a
        cached page only if it is newer than the editor's own files too, then apply the Map
        Viewer's checks (its scripts, page revision, loose files)."""
        try:
            newest = max((os.path.getmtime(s) for s in EDITOR_SOURCES if os.path.exists(s)), default=0)
            if os.path.getmtime(hp) < newest:
                self._log_line(f"({os.path.basename(hp)} is older than the editor's files - rebuilding)", "dim")
                return False
        except OSError:
            MC.swallowed()
            return False
        return MM.MapApp._html_current(self, hp)

    def _menu_items_file(self):
        """The Map Viewer's File menu with New map... first."""
        return ([_mi("New map...", self._edit_new, "Ctrl+N"), _mi("Compile map...", self._edit_compile, "F9"), _MSEP]
                + MM.MapApp._menu_items_file(self))

    def _build_ui(self):
        MM.MapApp._build_ui(self)
        self.bind_all("<Control-n>", lambda e: (self._edit_new(), "break"))
        self.bind_all("<F9>", lambda e: (self._edit_compile(), "break"))

    # ---- New map ------------------------------------------------------------------
    def _new_maps_dir(self):
        """Where New map's file box starts: output/my_maps (made when first used)."""
        return os.path.join(ML.DATADIR, NEW_MAPS_DIR)

    def _edit_new(self):
        """File > New map...: write the starter room as a .map where the user chooses,
        check it, and open it in the editor."""
        initdir = self._new_maps_dir()
        try: os.makedirs(initdir, exist_ok=True)
        except OSError: MC.swallowed(); initdir = ML.DATADIR
        path = filedialog.asksaveasfilename(parent=self, title="New map: save the starter map as",
                                            initialdir=initdir, initialfile="newmap.map",
                                            defaultextension=".map", filetypes=[("MOHAA map source", "*.map")])
        if not path:
            self._log_line("New map: cancelled.", "dim"); return
        stem = os.path.splitext(os.path.basename(path))[0]
        if not path.lower().endswith(".map") or not NAME_RE.match(stem):
            self._log_line(f"New map: '{os.path.basename(path)}' isn't a usable name: a .map whose name is "
                           "letters, digits, _ . or - (the game finds maps by file name)", "err"); return
        text = starter_map(stem)
        ok, why, _counts = check_map_text(text)
        if not ok:
            self._log_line(f"New map: the starter map didn't check out ({why}); nothing was written", "err"); return
        try:
            MC.atomic_write_text(path, text, newline="\n", backup=True)
            with open(path, "r", encoding="utf-8", newline="") as f: back = f.read()
        except OSError as e:
            MC.swallowed()
            self._log_line(f"New map: could not write {path}: {e}", "err"); return
        if back != text:
            self._log_line(f"New map: {path} reads back differently from what was written", "err"); return
        ok, why, _counts = check_map_text(back)
        if not ok:
            self._log_line(f"New map: {path} was written but doesn't check out: {why}", "err"); return
        self._log_line(f"New map: {path} - {why}; read back and checked. Opening it.", "ok")
        self._path_var.set(path)
        if not self._editor_active():
            self._editor_set(True, reopen=False)
            self._log_line("Edit map: on (a new map opens in the map editor).", "ok")
        self._load(path)

    # ---- compiling ----------------------------------------------------------------
    # Compile... builds a .bsp from what the page shows, changes and all: the page sends the
    # map's text (a .bsp's decompiled .map with every edit in it), the user picks where the
    # .bsp goes, the text is written beside it as <name>.map (kept, to open and edit later)
    # and ommap compiles that.
    # The options MBuilder (MOHRadiant's compile window) offers, as ommap takes them:
    # (key, label, switch, step(s), tip). "manvis" is on by default and passes -nomanvis off.
    COMPILE_SWITCHES = (
        ("bsp_v", "Verbose", "-v", ("bsp",), "Every message the bsp step can give"),
        ("bsp_nocurves", "No curves", "-nocurves", ("bsp",), "Leave the curved patches out (a quick test of the brushes)"),
        ("bsp_nodetail", "No detail brushes", "-nodetail", ("bsp",), "Leave the detail brushes out"),
        ("bsp_nohint", "No hint brushes", "-nohint", ("bsp",),
         "Hint and vis brushes don't split the map: far fewer portals and a much quicker vis, but\n"
         "the game draws more than it needs to (a quick test compile)"),
        ("bsp_onlyents", "Entities only", "-onlyents", ("bsp",),
         "Only the entities are written into the .bsp compiled before (lights, spawns, triggers\n"
         "moved or changed): seconds instead of a whole compile. The brushes must be as they\n"
         "were. Vis is skipped; light runs again if chosen"),
        ("bsp_fulldetail", "Detail as structural", "-fulldetail", ("bsp",),
         "Detail brushes split the map like structural ones (more portals: vis is much slower)"),
        ("vis_v", "Verbose", "-v", ("vis",), "Every message vis can give"),
        ("vis_passage", "Passage vis only", "-passageOnly", ("vis",),
         "A quicker full vis that lets the game draw a little more than it needs to"),
        ("vis_merge", "Merge leafs", "-merge", ("vis",), "Merge small leafs first: fewer clusters, quicker vis"),
        ("vis_derived", "Vis groups skip the work", "-derived", ("vis",),
         "The vis groups' blocks also leave their portals out of the vis work, not only out of the\n"
         "result (EA's vis_derived key). A little quicker; what is seen only through a blocked\n"
         "group is left out too"),
        ("vis_nofarplane", "Ignore the farplane", "-nofarplane", ("vis",),
         "Vis skips portals further apart than the map's farplane (worldspawn \"farplane\"), as EA's\n"
         "compiler does; this turns that off"),
        ("light_v", "Verbose", "-v", ("light",), "Every message light can give"),
        ("light_extra", "Extra detail", "-extra", ("light",), "Sharper shadows, sampled more finely (slower)"),
        ("light_notrace", "No shadows", "-notrace", ("light",), "Light passes through everything (a very quick test)"),
    )
    # The Compile window's step choices, with what each takes (m3l1b, Omaha's bunker, a large
    # outdoor map: bsp 1 s, vis 23 s, light 16 s on the developer's PC with the vis cap on)
    COMPILE_STEP_TIPS = {
        "all": "The .bsp to play: the map split up (bsp), which areas see which (vis) and the lighting\n"
               "baked (light). A small map: well under a minute; a large one such as m3l1b: about a\n"
               "minute (bsp 1 s, vis 25 s, light 15 s) with the vis cap on. With the cap off, vis of a big\n"
               "outdoor map can take hours.",
        "fast": "Like Full, but vis only floods through the portals (seconds), so the game draws more\n"
                "than it needs to: fine for testing, slower to play on a big map. m3l1b: about 20 s.",
        "bsp": "Only the map split up and written, no vis and no light: seconds. For a look in this\n"
               "viewer only; in the game it would be unlit and slow.",
        "map": "No compile: only the .map is written, with the page's changes and the MAP box's\n"
               "worldspawn keys, where you choose (or in the game's maps folder).",
    }
    SUN_SCALE = 0.77   # the Compile window's sun scale: the game's own maps were lit this much darker
    VIS_CAP = 100000   # the vis work cap's default: flow steps for each portal (ommap -cap)
    GAMETYPES = (("sp", "Single player", "maps", "0"), ("dm", "Deathmatch / team / round based", "maps/dm", "1"),
                 ("obj", "Objective", "maps/obj", "4"))
    GAME_CMDLINE = "+set developer 1 +set cheats 1 +set thereisnomonkey 1 +set ui_console 1 +set logfile 2"
    GAME_PROGRAMS = ("mohaa.exe", "moh_spearhead.exe", "moh_breakthrough.exe", "openmohaa.exe",
                     "launch_openmohaa_base.exe", "openmohaa")

    def _game_folder(self):
        """The game's folder (the one holding main/Pak0.pk3), from the paks loaded, else None."""
        for p in getattr(self, "_pk3_paths", []) or []:
            d = os.path.dirname(os.path.abspath(p))
            if os.path.basename(d).lower() == "main":
                try:
                    if any(n.lower() == "pak0.pk3" for n in os.listdir(d)):
                        return os.path.dirname(d)
                except OSError:
                    MC.swallowed()
        return None

    def _game_program(self, game):
        """The game's program: the one chosen before, else one of GAME_PROGRAMS in its folder."""
        p = self._cfg.get("game_exe")
        if p and os.path.isfile(p):
            return p
        if game:
            try:
                names = {n.lower(): n for n in os.listdir(game)}
            except OSError:
                MC.swallowed(); names = {}
            for n in self.GAME_PROGRAMS:
                if n in names:
                    return os.path.join(game, names[n])
        return None

    # the Compile window's "more switches" boxes: ommap's other switches for each step
    MORE_SWITCH_TIPS = {
        "bsp": "More of ommap's bsp switches, separated by spaces:\n"
               "-threads N  CPU threads to use (default: all)\n"
               "-samplesize N  units a lightmap texel (16; smaller is sharper, bigger files)\n"
               "-nowater  leave water surfaces out\n"
               "-nofog  leave fog volumes out\n"
               "-notjunc  no T-junction fixing (quicker; cracks can show)\n"
               "-nosubdivide  don't cut big faces up\n"
               "-noopt  don't merge faces\n"
               "-nofill  don't fill the void (a leak isn't found)\n"
               "-leaktest  stop when the map leaks\n"
               "-micro N  brushes smaller than this volume are left out\n"
               "-verboseentities  messages for every entity",
        "vis": "More of ommap's vis switches, separated by spaces:\n"
               "-threads N  CPU threads to use (default: all)\n"
               "-farplane N  cull portals further apart than N (instead of worldspawn's farplane)\n"
               "-noderived  ignore worldspawn's vis_derived\n"
               "-nopassage  the older portal flow (slower)\n"
               "-nosort  don't sort the portals first\n"
               "-saveprt  keep the .prt and .lgv files",
        "light": "More of ommap's light switches, separated by spaces:\n"
                 "-threads N  CPU threads to use (default: all)\n"
                 "-samplesize N  units a lightmap texel (16)\n"
                 "-sunscale N  scale the sun's baked light (0.77 matched m3l1b's own .bsp with\n"
                 "    sundiffuse 1); the game's sun for models keeps suncolor\n"
                 "-skyscale N  scale the sky's light (sundiffuse) by N\n"
                 "-point N  scale every light by N (2: twice as bright)\n"
                 "-area N  scale surface lights by N\n"
                 "-extrawide  as Extra detail, smoothed more\n"
                 "-patchshadows  curved patches cast shadows\n"
                 "-nogrid  no light grid (players and models unlit)\n"
                 "-novertex  no vertex light\n"
                 "-nosurf  only brushes cast shadows (quicker)\n"
                 "-border  a debug border round each lightmap",
    }
    # The worldspawn keys the MAP box offers (OpenMoHAA fgame/worldspawn.cpp, and the
    # compiler's own): what each does
    WORLD_KEY_TIPS = (
        ("message", "the level's title"),
        ("ambientlight", "r g b (0-255): light everywhere (light step)"),
        ("suncolor", "r g b (0-255): the sun's light (light step), and its colour for models in the game"),
        ("sundirection", "pitch yaw roll: the way to the sun (pitch -90 or 270: straight up)"),
        ("sundiffuse", "how much light the whole sky gives, in parts of suncolor (light step); 0: none"),
        ("sundiffusecolor", "r g b: the sky's colour for sundiffuse instead of suncolor"),
        ("sunlight", "whether models get the sun's light in the game"),
        ("overbright", "EA's light step: which lightmaps keep the overbright cutoff (none, world, entities)"),
        ("lightmapdensity", "the default lightmap density for the world's surfaces"),
        ("sunflarename", "the sun flare's shader (none: no flare)"),
        ("sunflaredirection", "angles: where the sun flare is drawn"),
        ("farplane", "the fog's distance: past it nothing is drawn (vis culls by it too)"),
        ("farplane_color", "r g b (0-1): the fog's colour"),
        ("farplane_cull", "1: what is past the farplane isn't drawn at all"),
        ("farplane_bias", "the fog's distance bias"),
        ("skybox_farplane", "the skybox's own farplane"),
        ("skyalpha", "the sky portal's alpha"),
        ("render_terrain", "0: terrain isn't drawn"),
        ("vis_derived", "1: the vis groups also skip their portals' vis work"),
        ("soundtrack", "the level's music (.mus)"),
        ("gravity", "the world's gravity"),
        ("northyaw", "the yaw the compass takes as north"),
        ("ai_visiondistance", "the AI's default vision distance"),
        ("nextmap", "the map to change to next"),
        ("watercolor", "r g b: the screen blend under water"),
        ("wateralpha", "the water screen blend's alpha"),
    )

    def _game_program_ask(self, game, parent=None):
        """The game's program, or one the user picks (kept for next time); None if not."""
        exe = self._game_program(game)
        if exe:
            return exe
        exe = filedialog.askopenfilename(parent=parent or self, title="Where is the game's program (MOHAA.exe, or OpenMoHAA's)?",
                                         initialdir=game or None,
                                         filetypes=[("Programs", "*.exe"), ("All files", "*")] if sys.platform.startswith("win")
                                         else [("All files", "*")])
        if not exe:
            return None
        self._cfg["game_exe"] = os.path.abspath(exe); self._save_config()
        return self._cfg["game_exe"]

    def _compile_dialog(self, what, game, world=None):
        """The compile window: steps (or the .map only), MBuilder's switches for each step,
        the worldspawn's keys (MAP), where the file goes and whether to start the game after.
        A dict, or None when cancelled."""
        opts = dict(self._cfg.get("compile_opts") or {})
        w = tk.Toplevel(self); w.title("Compile map"); w.transient(self); w.resizable(False, False)
        old = ML.OLD_POPUPS
        if not old:
            w.configure(bg=ML.PANEL)
            st = ttk.Style(w)
            for k in ("Panel.TCheckbutton", "Panel.TRadiobutton"):
                st.configure(k, background=ML.PANEL, foreground=ML.TXT, font=ML.FONT_SMALL)
                st.map(k, background=[("active", ML.PANEL)], foreground=[("disabled", ML.DIM)])
            st.configure("Panel.TLabelframe", background=ML.PANEL, bordercolor=ML.LINE)
            st.configure("Panel.TLabelframe.Label", background=ML.PANEL, foreground=ML.ACCENT, font=ML.FONT_SMALL)
            # the MAP box's key list: the theme's entry colours, not the system's light ones
            st.configure("Panel.TCombobox", fieldbackground=ML.ENTRY_BG or ML.BG, background=ML.PANEL,
                         foreground=ML.TXT, arrowcolor=ML.TXT, bordercolor=ML.LINE)
            st.map("Panel.TCombobox", fieldbackground=[("readonly", ML.ENTRY_BG or ML.BG)],
                   foreground=[("readonly", ML.TXT), ("disabled", ML.DIM)], selectbackground=[("readonly", ML.ENTRY_BG or ML.BG)],
                   selectforeground=[("readonly", ML.TXT)])
        F = (lambda parent, **k: ttk.Frame(parent, style="Panel.TFrame", **k))
        dim = (lambda parent, text, **k: ttk.Label(parent, text=text, style="PanelDim.TLabel", **k))
        chk = (lambda parent, text, var: ttk.Checkbutton(parent, text=text, variable=var, style="Panel.TCheckbutton"))
        rad = (lambda parent, text, var, val: ttk.Radiobutton(parent, text=text, variable=var, value=val,
                                                              style="Panel.TRadiobutton"))
        res = {"ok": False}
        body = F(w); body.pack(fill="both", expand=True, padx=14, pady=12)
        ttk.Label(body, text="Compile " + what, style="Panel.TLabel", foreground=ML.ACCENT).pack(anchor="w")
        steps = tk.StringVar(value=opts.get("steps", "all"))
        if steps.get() not in self.COMPILE_STEP_TIPS:
            steps.set("all")
        r = F(body); r.pack(fill="x", pady=(8, 4))
        last = self._cfg.get("compile_last") or {}
        for val, text in (("all", "Full: bsp + vis + light"), ("fast", "Quick test: bsp + fast vis + light"),
                          ("bsp", "bsp only (for viewer only)"), ("map", "map file only")):
            rb_ = rad(r, text, steps, val); rb_.pack(side="left", padx=(0, 14))
            tip = self.COMPILE_STEP_TIPS[val]
            lt = last.get(val)
            if isinstance(lt, list) and len(lt) == 2 and isinstance(lt[1], (int, float)):
                tip += "\nLast time here: %s (%s)" % (MCO._duration(lt[1]), str(lt[0])[:60])
            self._tip(rb_, tip)
        # the four boxes, BSP VIS LIGHT MAP, side by side; the row scrolls sideways when
        # they don't fit (MAP alone with "map file only")
        bg = ML.PANEL if not old else None
        holder = F(body); holder.pack(fill="x", pady=(4, 0))
        cv = tk.Canvas(holder, highlightthickness=0, bd=0, **({"bg": bg} if bg else {}))
        cv.pack(fill="x")
        sb = ttk.Scrollbar(holder, orient="horizontal", command=cv.xview)
        cv.configure(xscrollcommand=sb.set)
        cols = F(cv)
        cv.create_window((0, 0), window=cols, anchor="nw")
        vars_ = {}
        extra = {}
        capent = [None]
        sunent = [None]
        boxes = {}
        widgets = {}           # key -> widget, to grey out
        for i, (step, title) in enumerate((("bsp", "BSP"), ("vis", "VIS"), ("light", "LIGHT"))):
            fr = boxes[step] = ttk.LabelFrame(cols, text=title, style="Panel.TLabelframe", padding=(8, 4))
            fr.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            for key, label, sw, which, tip in self.COMPILE_SWITCHES:
                if which[0] != step:
                    continue
                v = vars_[key] = tk.BooleanVar(value=bool(opts.get(key)))
                cb = widgets[key] = chk(fr, "%s  (%s)" % (label, sw), v); cb.pack(anchor="w")
                self._tip(cb, tip)
            if step == "vis":
                v = vars_["manvis"] = tk.BooleanVar(value=opts.get("manvis", True))
                cb = widgets["manvis"] = chk(fr, "Vis groups (vis_leafgroup)", v); cb.pack(anchor="w")
                self._tip(cb, "MoHAA's manual vis: areas marked by vis_leafgroup entities that never see each\n"
                              "other are left out of what the game draws. A map decompiled from a .bsp gets its\n"
                              "groups back from the original .bsp. Off: -nomanvis")
                cf = F(fr); cf.pack(anchor="w", fill="x")
                v = vars_["viscap"] = tk.BooleanVar(value=opts.get("viscap", True))
                cb = widgets["viscap"] = chk(cf, "Cap the work per portal:", v); cb.pack(side="left")
                ce = capent[0] = widgets["viscap_n"] = ttk.Entry(cf, width=9)
                ce.insert(0, str(opts.get("viscap_n") or self.VIS_CAP)); ce.pack(side="left", padx=(4, 0))
                tip = ("Full vis of an open map (a beach, a town) can run for many hours: each portal\n"
                       "follows every path it might see through. With a cap, a portal that has used up\n"
                       "its steps counts whatever its paths might still see as seen, so vis ends in\n"
                       "minutes. A capped portal can only see more than it would have, never less: the\n"
                       "game draws a little more (on m3l1b, 12% more than vis run to the end). Off: vis\n"
                       "runs to the end, as EA's compiler does (-cap N)")
                self._tip(cb, tip); self._tip(ce, tip)
            if step == "light":
                sf_ = F(fr); sf_.pack(anchor="w", fill="x", pady=(2, 0))
                v = vars_["light_sunon"] = tk.BooleanVar(value=opts.get("light_sunon", True))
                sl_ = widgets["light_sunon"] = chk(sf_, "Sun scale  (-sunscale):", v); sl_.pack(side="left")
                se_ = sunent[0] = widgets["light_sunscale"] = ttk.Entry(sf_, width=6)
                se_.insert(0, str(opts.get("sunscale", self.SUN_SCALE))); se_.pack(side="left", padx=(4, 0))
                tip = ("The sun's light baked into the lightmaps, times this (-sunscale; 1: as the map's keys\n"
                       "say, which is what EA's MOHTools light step gives). The game's own maps were lit\n"
                       "darker than MOHTools lights them: %s matches them (m3l1b, m2l1). The map's\n"
                       "keys aren't changed, so the game's sun on models keeps suncolor. Unticked: 1." % self.SUN_SCALE)
                self._tip(se_, tip); self._tip(sl_, tip)
            ml = dim(fr, "more switches:"); ml.pack(anchor="w", pady=(4, 0))
            e = extra[step] = widgets[step + "_more"] = ttk.Entry(fr, width=24)
            e.insert(0, opts.get(step + "_more", "")); e.pack(anchor="w", fill="x")
            self._tip(e, self.MORE_SWITCH_TIPS[step]); self._tip(ml, self.MORE_SWITCH_TIPS[step])
        # MAP: the worldspawn's keys, as "key" "value" lines
        mf = boxes["map"] = ttk.LabelFrame(cols, text="MAP ($world)", style="Panel.TLabelframe", padding=(8, 4))
        mf.grid(row=0, column=3, sticky="nsew", padx=(8, 0))
        wtext0 = "\n".join('"%s" "%s"' % kv for kv in (world or []))
        txt = tk.Text(mf, width=40, height=8, wrap="none", undo=True, font=ML.FONT_MONO,
                      **({"bg": ML.ENTRY_BG or ML.BG, "fg": ML.TXT, "insertbackground": ML.TXT, "relief": "flat",
                          "highlightthickness": 1, "highlightbackground": ML.LINE, "highlightcolor": ML.ACCENT}
                         if not old else {}))
        txt.insert("1.0", wtext0); txt.edit_reset(); txt.pack(anchor="w", fill="both", expand=True)
        self._tip(txt, "The world's keys (worldspawn: entity 0 in the .map, $world in the game), as \"key\" \"value\"\n"
                       "lines: change a value, delete a line, or add one (the list below adds a key). Written into\n"
                       "the .map the .bsp is built from (and the .map only, with \"map file only\").\n\n"
                       + "\n".join("%s: %s" % kd for kd in self.WORLD_KEY_TIPS))
        af = F(mf); af.pack(anchor="w", fill="x", pady=(4, 0))
        dim(af, "add:").pack(side="left")
        known = [k for k, _d in self.WORLD_KEY_TIPS]
        addk = ttk.Combobox(af, values=known, width=18, state="readonly", **({} if old else {"style": "Panel.TCombobox"}))
        addk.pack(side="left", padx=(4, 0))
        addtip = self._tip(addk, "Pick a key to add a line for it (its current line, if it has one, is selected)")
        werr = dim(mf, "", wraplength=300); werr.pack(anchor="w")
        def add_key(_e=None):
            k = addk.get()
            if not k:
                return
            body_ = txt.get("1.0", "end-1c")
            m = re.search(r'^\s*"%s"\s+"[^"]*"\s*$' % re.escape(k), body_, re.M | re.I)
            if m:
                a0 = "1.0+%dc" % m.start(); a1 = "1.0+%dc" % m.end()
                txt.tag_remove("sel", "1.0", "end"); txt.tag_add("sel", a0, a1); txt.mark_set("insert", a1); txt.see(a0)
            else:
                if body_ and not body_.endswith("\n"):
                    txt.insert("end", "\n")
                txt.insert("end", '"%s" ""' % k); txt.mark_set("insert", "end-2c"); txt.see("end")
            addtip.set_text(dict(self.WORLD_KEY_TIPS).get(k, ""))
            txt.focus_set()
        addk.bind("<<ComboboxSelected>>", add_key)
        if world is None:
            txt.configure(state="disabled"); addk.configure(state="disabled")
            werr.configure(text="(the map's text wasn't sent: its keys can't be changed here)")
        where = tk.StringVar(value=opts.get("where", "ask") if game else "ask")
        gt = tk.StringVar(value=opts.get("gametype", "sp"))
        wf = ttk.LabelFrame(body, text="THE .BSP", style="Panel.TLabelframe", padding=(8, 4)); wf.pack(fill="x", pady=(10, 0))
        rad(wf, "Choose where to save it", where, "ask").pack(anchor="w")
        g1 = F(wf); g1.pack(anchor="w", fill="x")
        rb = rad(g1, "In the game's maps folder:", where, "game"); rb.pack(side="left")
        for key, label, sub, _n in self.GAMETYPES:
            rad(g1, "%s (%s)" % (label, sub), gt, key).pack(side="left", padx=(8, 0))
        if not game:
            rb.configure(state="disabled")
            dim(wf, "(load the game's paks from its main folder to use its maps folders)").pack(anchor="w")
        else:
            dim(wf, game).pack(anchor="w")
        launch = tk.BooleanVar(value=bool(opts.get("launch")))
        lf = F(wf); lf.pack(anchor="w", fill="x", pady=(6, 0))
        lcb = chk(lf, "Start the game with the map when it's done:", launch); lcb.pack(side="left")
        cmd = ttk.Entry(lf, width=56); cmd.insert(0, opts.get("cmdline", self.GAME_CMDLINE)); cmd.pack(side="left", padx=(6, 0))
        self._tip(cmd, "The game's command line, as a shortcut's target would give it: +set cvar value and\n"
                       "+command words (\"quotes\" for a value with spaces). The map's own +set g_gametype and\n"
                       "+devmap maps/<name> are added after it. The game starts in its own folder.")
        pf = F(wf); pf.pack(anchor="w", fill="x", pady=(2, 0))
        prog = dim(pf, ""); prog.pack(side="left")
        def show_prog():
            exe = self._game_program(game)
            prog.configure(text=("program: " + exe) if exe else
                           ("(MOHAA.exe wasn't found in %s: Browse... to pick the game's program)" % game if game
                            else "(the game's program: Browse... to pick it)"))
        def browse():
            exe = filedialog.askopenfilename(parent=w, title="Where is the game's program (MOHAA.exe, or OpenMoHAA's)?",
                                             initialdir=os.path.dirname(self._game_program(game) or "") or game or None)
            if exe:
                self._cfg["game_exe"] = os.path.abspath(exe); self._save_config(); show_prog()
        pbtn = ttk.Button(pf, text="Browse...", command=browse, cursor="hand2"); pbtn.pack(side="left", padx=(8, 0))
        self._tip(pbtn, "Pick the game's program to start (it is kept for next time)")
        show_prog()
        note = dim(body, "", wraplength=760); note.pack(anchor="w", pady=(8, 0))
        row = F(w); row.pack(fill="x", padx=14, pady=(0, 12))
        def ok():
            res["ok"] = True; w.destroy()
        ttk.Button(row, text="Cancel", command=w.destroy, cursor="hand2").pack(side="right")
        go = ttk.Button(row, text="Compile", command=ok, cursor="hand2", style="Accent.TButton")
        go.pack(side="right", padx=(0, 8))

        # what each step choice uses: the rest greyed out (MAP alone for "map file only")
        def state(wd, on):
            try:
                wd.state(["!disabled"] if on else ["disabled"])
            except (AttributeError, tk.TclError):
                try: wd.configure(state="normal" if on else "disabled")
                except tk.TclError: MC.swallowed()
        FAST_OFF = {"vis_passage", "vis_derived", "vis_nofarplane", "viscap", "viscap_n"}
        SHOWN = {"all": ("bsp", "vis", "light"), "fast": ("bsp", "vis", "light"), "bsp": ("bsp",), "map": ()}
        def refresh(*_a):
            m = steps.get()
            # a box all of whose choices don't apply is hidden: "bsp only" shows BSP (and
            # MAP), "map file only" MAP alone
            for st_ in ("bsp", "vis", "light"):
                if st_ in SHOWN[m]:
                    boxes[st_].grid()
                else:
                    boxes[st_].grid_remove()
            for key, wd in widgets.items():
                st_ = key.split("_")[0] if key not in ("manvis", "viscap", "viscap_n") else "vis"
                on = {"all": True, "fast": key not in FAST_OFF, "bsp": st_ == "bsp", "map": False}[m]
                state(wd, on)
            boxes["map"].grid_configure(padx=(0 if not SHOWN[m] else 8, 0))
            wf.configure(text="THE .MAP" if m == "map" else "THE .BSP")
            for wd in (lcb, cmd, pbtn):
                state(wd, m != "map")
            go.configure(text="Save" if m == "map" else "Compile")
            note.configure(text={
                "map": "Only the .map is written (with the page's changes and the MAP box's keys); no compile. "
                       "The game folder choice puts it in maps (as EA's tools keep a .map beside its .bsp).",
                "bsp": "Only the bsp step (so no VIS or LIGHT choices). No lightmaps: for a look in this viewer.",
                "fast": "Fast vis floods through the portals only, so Passage vis, Vis groups skip the work, "
                        "the farplane and the cap don't apply (greyed out).",
            }.get(m, "vis works out which areas see which; light bakes the lighting. Each step's time is shown "
                     "in the Output pane. The MAP box (scroll right) changes the world's keys."))
            fit()
        def fit():
            try:
                w.update_idletasks()
                cw = cols.winfo_reqwidth(); ch = cols.winfo_reqheight()
                shown = SHOWN[steps.get()]
                # the width of BSP, VIS and LIGHT (MAP scrolled to); with fewer boxes, all of them
                view = (sum(boxes[s_].winfo_reqwidth() + 8 for s_ in shown) if len(shown) == 3
                        else sum(boxes[s_].winfo_reqwidth() + 8 for s_ in shown + ("map",)))
                view = min(cw, max(view, 300))
                cv.configure(width=view, height=ch, scrollregion=(0, 0, cw, ch))
                if cw > view + 2:
                    sb.pack(fill="x")
                else:
                    sb.pack_forget(); cv.xview_moveto(0)
            except tk.TclError:
                MC.swallowed()
        steps.trace_add("write", refresh)
        cv.bind("<Shift-MouseWheel>", lambda e: cv.xview_scroll(-1 if e.delta > 0 else 1, "units"))
        refresh()
        w.protocol("WM_DELETE_WINDOW", w.destroy)
        w.bind("<Escape>", lambda e: w.destroy())
        w.bind("<Return>", lambda e: ok() if w.focus_get() is not txt else None)
        try:
            w.update_idletasks()
            x = self.winfo_rootx() + (self.winfo_width() - w.winfo_width()) // 2
            y = self.winfo_rooty() + (self.winfo_height() - w.winfo_height()) // 2
            w.geometry(f"+{max(0, x)}+{max(0, y)}")
        except Exception: MC.swallowed()
        if not old:
            try: self._apply_titlebar(w)
            except Exception: MC.swallowed()
        try: w.grab_set()
        except Exception: MC.swallowed()
        go.focus_set()
        # read the choices before the window goes
        out = {}
        def keep(*_a):
            try:
                out.update({k: v.get() for k, v in vars_.items()})
                out.update(steps=steps.get(), where=where.get(), gametype=gt.get(), launch=launch.get(),
                           cmdline=cmd.get().strip())
                out.update({s_ + "_more": e.get().strip() for s_, e in extra.items()})
                if capent[0] is not None:
                    out["viscap_n"] = capent[0].get().strip()
                if sunent[0] is not None:
                    out["sunscale"] = sunent[0].get().strip()
                out["_world"] = txt.get("1.0", "end-1c")
            except tk.TclError:
                MC.swallowed()
        def go_now():
            keep()
            # the MAP box's lines must read before the window goes
            if world is not None and out.get("_world", wtext0).strip() != wtext0.strip():
                try:
                    kv = MCO.parse_key_lines(out["_world"])
                    if not any(k.lower() == "classname" and v.lower() == "worldspawn" for k, v in kv):
                        raise ValueError('keep "classname" "worldspawn"')
                except ValueError as e_:
                    werr.configure(text="MAP: %s" % e_, foreground=ML.ERR_C)
                    if steps.get() != "map":
                        cv.xview_moveto(1.0)
                    return
            if launch.get() and steps.get() != "map" and not self._game_program_ask(game, w):
                note.configure(text="Start the game: pick the game's program (Browse...), or untick it.", foreground=ML.ERR_C)
                return
            ok()
        go.configure(command=go_now)
        w.bind("<Return>", lambda e: go_now() if w.focus_get() is not txt else None)
        self.wait_window(w)
        if not res["ok"]:
            return None
        wt = out.pop("_world", None)
        self._cfg["compile_opts"] = dict(out)
        if world is not None and wt is not None and wt.strip() != wtext0.strip():
            out["world"] = MCO.parse_key_lines(wt)
        return out

    def _compile_switches(self, o):
        """A dialog's choices as each step's switches: {"bsp": [...], "vis": [...], "light": [...]}."""
        sw = {"bsp": [], "vis": [], "light": []}
        for key, _label, s_, which, _tip in self.COMPILE_SWITCHES:
            if o.get(key):
                for st_ in which:
                    sw[st_].append(s_)
        if not o.get("manvis", True):
            sw["bsp"].append("-nomanvis"); sw["vis"].append("-nomanvis")
        try:
            sc = float(str(o.get("sunscale", self.SUN_SCALE)).strip().replace(",", "."))
        except ValueError:
            sc = self.SUN_SCALE                      # not a number: the default
        # (a -sunscale typed in the LIGHT box's more switches wins over the field)
        if (o.get("light_sunon", True) and 0 < sc < 100 and abs(sc - 1) > 1e-6
                and "-sunscale" not in str(o.get("light_more") or "").split()):
            sw["light"] += ["-sunscale", "%g" % sc]
        if o.get("viscap", True):
            n = str(o.get("viscap_n") or "").strip().replace(",", "")
            if not (n.isdigit() and 0 < int(n) < 4000000000):
                n = str(self.VIS_CAP)   # not a number: the default
            sw["vis"] += ["-cap", str(int(n))]
        for st_ in sw:
            sw[st_] += str(o.get(st_ + "_more") or "").split()
        return sw

    def _edit_save_map_only(self, src, dest, text, is_map, saved_info, o):
        """Compile's "map file only": the .map (the page's text, with the MAP box's keys)
        written where chosen, nothing compiled. Never over the map it came from without asking."""
        stem = os.path.splitext(os.path.basename(dest))[0]
        if not dest.lower().endswith(".map") or not NAME_RE.match(stem):
            self._log_line(f"Save .map: '{os.path.basename(dest)}' isn't a usable name: a .map whose name is letters, "
                           "digits, _ . or -", "err"); return
        same = os.path.normcase(os.path.abspath(dest)) == os.path.normcase(os.path.abspath(src))
        made = set(self._cfg.get("compile_written") or [])
        if os.path.exists(dest) and os.path.normcase(dest) not in made:
            head = (f"Write into {os.path.basename(dest)}, the map you opened?" if same
                    else f"Replace {os.path.basename(dest)}?")
            if self._unsaved_dialog("Save .map", head, f"The one there now is kept as {os.path.basename(dest)}.bak.",
                                    [("yes", "Replace it", True), ("cancel", "Cancel", True)]) != "yes":
                self._log_line("Save .map: cancelled.", "dim"); return
        try:
            if text is None:
                with open(src, "r", encoding="latin-1", newline="") as f:
                    text = f.read()
            MC.atomic_write_text(dest, text, encoding="latin-1", errors="replace", newline="",
                                 backup=os.path.exists(dest))
        except OSError as e:
            MC.swallowed(); self._log_line(f"Save .map: could not write {dest}: {e}", "err"); return
        made.add(os.path.normcase(dest))
        self._cfg["compile_written"] = sorted(made)[-200:]
        if o.get("where") != "game":
            self._cfg["compile_dir"] = os.path.dirname(dest)
        self._save_config()
        if saved_info:
            self._page_js("try{edCompiledSaved(%s,%s,%s)}catch(e){}" % (json.dumps(saved_info.get("edN")),
                                                                       json.dumps(saved_info.get("modKey")), json.dumps(dest)))
        self._log_line(f"Save .map: wrote {dest} (nothing compiled).", "ok")

    def _start_game(self, bsp, gametype, cmdline):
        """Start the game with the map just compiled, as MBuilder does: its command line, then
        the gametype and +devmap with the map's name under maps/."""
        game = self._game_folder()
        exe = self._game_program_ask(game)
        if not exe:
            self._log_line("Compile: the game wasn't started (no program chosen).", "dim"); return
        rel = os.path.splitext(os.path.basename(bsp))[0]
        maps = os.path.join(game, "main", "maps") if game else None
        if maps:
            try:
                r = os.path.relpath(os.path.splitext(bsp)[0], maps).replace("\\", "/")
                if not r.startswith(".."):
                    rel = r
            except ValueError:
                MC.swallowed()
        num = next((n for k, _l, _s, n in self.GAMETYPES if k == gametype), "0")
        try:
            words = [w for w in shlex.split(cmdline or "", posix=True) if w]
        except ValueError:
            self._log_line("Compile: the game's command line has a quote that isn't closed; not started.", "err"); return
        if any(w.startswith(("-", "/")) or ";" in w or "&" in w for w in words):
            self._log_line("Compile: the game's command line takes +set / + commands only; not started.", "err"); return
        cmd = [exe] + words + ["+set", "g_gametype", num, "+devmap", rel]
        if exe.lower().endswith(".exe") and not sys.platform.startswith("win"):
            wine = shutil.which("wine")
            if not wine:
                self._log_line("Compile: the game is a Windows program and Wine isn't installed; not started.", "err"); return
            cmd = [wine] + cmd
        try:
            subprocess.Popen(cmd, cwd=os.path.dirname(exe), **({"creationflags": 0x00000008} if sys.platform.startswith("win") else {}))
            self._log_line("Compile: started %s with +devmap %s (g_gametype %s)." % (os.path.basename(exe), rel, num), "ok")
        except OSError as e:
            MC.swallowed()
            self._log_line("Compile: the game couldn't be started: %s" % e, "err")

    def _edit_compile(self, body=None):
        """File > Compile map... (F9), or the page's Compile button: what the page shows
        (changes included) into a .bsp where the user chooses, on a worker thread."""
        if getattr(self, "_compiling", False):
            # F9 again while it runs: offer to stop it (vis can take an hour on a big map)
            if self._unsaved_dialog("Compile", "A compile is running.", "Stop it? Nothing is written until a "
                                    "compile finishes.",
                                    [("stop", "Stop it", True), ("keep", "Keep going", True)]) == "stop":
                for p in list(getattr(self, "_compile_procs", [])):
                    try: p.kill()
                    except OSError: MC.swallowed()
                self._log_line("Compile: stopping.", "dim")
            return
        src = self._last_build[0] if self._last_build else None
        if not src or not os.path.isfile(src):
            self._log_line("Compile: open a map first.", "err"); return
        if body is None:
            # F9 or the menu: the page sends its text (with any changes) and comes back here
            wv = getattr(self, "_webview", None)
            if wv is not None and getattr(wv, "core", None) is not None:
                self._page_js("try{edCompileAsk()}catch(e){window.chrome.webview.postMessage('mohaa-edit-compile')}")
                return
            body = ""
        info = {}
        if body:
            try: info = json.loads(body)
            except ValueError: MC.swallowed(); info = {}
            if not isinstance(info, dict): info = {}
        src = os.path.abspath(src)
        from_pak = bool(self._tmp) and os.path.normcase(src).startswith(os.path.normcase(os.path.abspath(self._tmp)))
        is_map = src.lower().endswith(".map")
        text = info.get("mapText") if isinstance(info.get("mapText"), str) else None
        changed = bool(info.get("changed"))
        if text is None and not is_map:
            self._log_line("Compile: the page didn't send the map's text (open the map in the viewer's own pane "
                           "and try again).", "err"); return
        if self._vfs is None or not self._tex_ready or not self._tmp:
            self._log_line("Compile: the paks are still loading; try again in a moment.", "dim"); return
        name = os.path.splitext(os.path.basename(src))[0]
        what = f"{name}{'.map' if is_map else '.bsp'} " + ("as you see it here, with your changes" if changed else "as it is")
        game = self._game_folder()
        # the world's keys for the MAP box: from the page's text, else the .map itself
        base = text
        if base is None and is_map:
            try:
                with open(src, "r", encoding="latin-1", newline="") as f:
                    base = f.read()
            except OSError:
                MC.swallowed(); base = None
        world = MCO.worldspawn_keys(base) if base else None
        o = self._compile_dialog(what, game, world or None)
        if not o:
            self._log_line("Compile: cancelled.", "dim"); return
        if o.get("world") is not None and base:
            # the MAP box changed the world's keys: they go into the .map that is written
            try:
                text = MCO.set_worldspawn_keys(base, o["world"])
            except ValueError as e:
                MC.swallowed(); self._log_line(f"Compile: the world's keys: {e}", "err"); return
            changed = True
            self._log_line("Compile: the world's keys: " + ", ".join('"%s" "%s"' % kv for kv in o["world"]
                                                                     if kv not in (world or []))[:400] + " (as the MAP box has them)", "dim")
        map_only = o.get("steps") == "map"
        exe = MCO.ommap_path()
        if not exe and not map_only:
            self._log_line(f"Compile: there is no ommap build for this system ({MCO.platform_dir()}) in bin/ommap; "
                           "tools/build_ommap.py builds one.", "err"); return
        steps = {"all": ("bsp", "vis", "light"), "fast": ("bsp", "fastvis", "light"), "bsp": ("bsp",),
                 "map": ()}.get(o.get("steps"))
        switches = self._compile_switches(o)
        for st_, words in switches.items():
            if MCO.check_options(words)[1]:
                self._log_line("Compile: " + MCO.check_options(words)[1], "err"); return
        if steps is None:
            self._log_line("Compile: cancelled.", "dim"); return
        # where the .bsp goes: the game's maps folder for the gametype, or where the user says
        if o.get("where") == "game" and game:
            sub = next((sb for k, _l, sb, _n in self.GAMETYPES if k == o.get("gametype")), "maps")
            dest = os.path.join(game, "main", *sub.split("/"), name + (".map" if map_only else ".bsp"))
            try: os.makedirs(os.path.dirname(dest), exist_ok=True)
            except OSError as e:
                MC.swallowed(); self._log_line(f"Compile: {os.path.dirname(dest)} can't be made: {e}", "err"); return
            made0 = set(self._cfg.get("compile_written") or [])
            if os.path.exists(dest) and os.path.normcase(dest) not in made0 and os.path.normcase(dest) != os.path.normcase(src):
                if self._unsaved_dialog("Compile", f"Replace {dest}?",
                                        f"A {os.path.basename(dest)} is already in the game's maps folder (Compile didn't "
                                        f"write it). It is kept as {os.path.basename(dest)}.bak.",
                                        [("yes", "Replace it", True), ("cancel", "Cancel", True)]) != "yes":
                    self._log_line("Compile: cancelled.", "dim"); return
        else:
            loose_dir = os.path.dirname(src) if not from_pak else None
            init = self._cfg.get("compile_dir") or loose_dir or self._new_maps_dir()
            try: os.makedirs(init, exist_ok=True)
            except OSError: MC.swallowed(); init = ML.DATADIR
            if map_only:
                dest = filedialog.asksaveasfilename(parent=self, title="Save the .map as",
                                                    initialdir=init, initialfile=name + ".map", defaultextension=".map",
                                                    filetypes=[("MOHAA map source", "*.map")])
            else:
                dest = filedialog.asksaveasfilename(parent=self, title="Compile: save the .bsp as",
                                                    initialdir=init, initialfile=name + ".bsp", defaultextension=".bsp",
                                                    filetypes=[("MOHAA compiled map", "*.bsp")])
            if not dest:
                self._log_line("Compile: cancelled.", "dim"); return
        dest = os.path.abspath(dest)
        if map_only:
            return self._edit_save_map_only(src, dest, text, is_map, info if changed else None, o)
        stem = os.path.splitext(os.path.basename(dest))[0]
        if not dest.lower().endswith(".bsp") or not NAME_RE.match(stem):
            self._log_line(f"Compile: '{os.path.basename(dest)}' isn't a usable name: a .bsp whose name is letters, "
                           "digits, _ . or - (the game finds maps by file name)", "err"); return
        same = lambda a, b: os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
        map_out = os.path.splitext(dest)[0] + ".map"
        made = set(self._cfg.get("compile_written") or [])
        if os.path.exists(dest) and same(dest, src):
            if self._unsaved_dialog("Compile", f"Replace {os.path.basename(dest)}, the map you opened?",
                                    f"The one there now is kept as {os.path.basename(dest)}.bak.",
                                    [("yes", "Replace it", True), ("cancel", "Cancel", True)]) != "yes":
                self._log_line("Compile: cancelled.", "dim"); return
        write_text = text
        if text is None:
            write_text = None if same(map_out, src) else ""          # "": copy the file as it is
        if write_text is not None and os.path.exists(map_out) and os.path.normcase(map_out) not in made:
            head = (f"Write your changes into {os.path.basename(map_out)}, the map you opened?" if same(map_out, src)
                    else f"Replace {os.path.basename(map_out)} beside it?")
            if self._unsaved_dialog("Compile", head, f"The .bsp is built from a {os.path.basename(map_out)} beside it. "
                                    f"The one there now is kept as {os.path.basename(map_out)}.bak.",
                                    [("yes", "Replace it", True), ("cancel", "Cancel", True)]) != "yes":
                self._log_line("Compile: cancelled.", "dim"); return
        try:
            if write_text == "":
                with open(src, "r", encoding="latin-1", newline="") as f:
                    write_text = f.read()
            if write_text is not None:
                MC.atomic_write_text(map_out, write_text, encoding="latin-1", errors="replace", newline="",
                                     backup=os.path.exists(map_out))
                made.add(os.path.normcase(map_out))
                self._cfg["compile_written"] = sorted(made)[-200:]
        except OSError as e:
            MC.swallowed()
            self._log_line(f"Compile: could not write {map_out}: {e}", "err"); return
        if o.get("where") != "game":
            self._cfg["compile_dir"] = os.path.dirname(dest)
        made.add(os.path.normcase(dest))
        self._cfg["compile_written"] = sorted(made)[-200:]
        self._save_config()
        self._compiling = True
        self._log_line(f"Compile: {map_out} ({' + '.join(steps)}) with {exe}", "ok")
        vfs, work = self._vfs, self._tmp
        procs = self._compile_procs = []
        saved = (info.get("edN"), info.get("modKey")) if changed else None
        origin = src if not is_map else None              # a .bsp's page: its own .bsp, for the vis groups
        after = (o.get("gametype"), o.get("cmdline")) if o.get("launch") else None
        def log(line):
            if line.startswith("entering ") or line.startswith("Unknown surfaceparm"):
                return                                    # one per shader file: too many to show
            self._log_q.put(("dim", "  " + line))
        def work_fn():
            try:
                res = MCO.compile_map(map_out, vfs, work, steps, log, procs, origin_bsp=origin, options=switches)
            except Exception as e:
                MC.swallowed()
                res = dict(ok=False, why=str(e), steps=[])
            self._page_requests.append(lambda r=res: self._edit_compiled(map_out, r, saved, after))
        threading.Thread(target=work_fn, daemon=True).start()

    def _edit_compiled(self, src, res, saved=None, after=None):
        """A compile finished (main thread): say how, show the leak trail, start the game when
        asked, offer the .bsp."""
        self._compiling = False
        if not res.get("ok"):
            self._log_line(f"Compile: {os.path.basename(src)} not compiled: {res.get('why')}", "err"); return
        if saved:
            # the changes are in the .map written beside the .bsp: the page counts them saved
            self._page_js("try{edCompiledSaved(%s,%s,%s)}catch(e){}" % (json.dumps(saved[0]), json.dumps(saved[1]),
                                                                       json.dumps(src)))
        leak = res.get("leak")
        if leak is not None:
            self._log_line(f"Compile: {os.path.basename(src)} LEAKS: the void reaches an entity through a gap in the "
                           f"outer walls. The trail ({len(leak)} points, from the void to the entity) is in "
                           f"{os.path.splitext(src)[0]}.lin and drawn on the page; the .bsp was written without vis.", "err")
            self._page_js("try{MOHAA_EDIT_LEAK(%s)}catch(e){}" % json.dumps(leak[:2000]))
        tm = res.get("times") or {}
        took = ", ".join("%s %s" % (k, MCO._duration(v)) for k, v in tm.items())
        kind = {("bsp", "vis", "light"): "all", ("bsp", "fastvis", "light"): "fast", ("bsp",): "bsp"}.get(
            tuple(res.get("steps") or ()))
        if kind and tm:
            # the Compile window's step tooltips show how long the last compile of each kind took
            lc = dict(self._cfg.get("compile_last") or {})
            lc[kind] = [os.path.basename(src), round(sum(tm.values()), 1)]
            self._cfg["compile_last"] = lc
            self._save_config()
        self._log_line(f"Compile: wrote {res['bsp']} ({' + '.join(res.get('steps') or [])}"
                       + (f"; {took}" if took else "") + ").", "ok")
        if after and leak is None:
            self._start_game(res["bsp"], after[0], after[1])
        if "light" not in (res.get("steps") or []):
            self._log_line("Compile: no light step, so the .bsp has no lightmaps or light grid: "
                           "view it here, but compile with light before playing it in the game.", "warn")
        choice = self._unsaved_dialog("Compiled", f"{os.path.basename(res['bsp'])} is written.",
                                      f"Open it here in the Map Viewer now, with its baked light? (This doesn't start "
                                      f"the game. {os.path.basename(src)}, the .map it was built from, is beside it.)",
                                      [("open", "Open the .bsp", True), ("stay", "Not now", True)])
        if choice == "open":
            self._path_var.set(res["bsp"])
            self._load(res["bsp"])

    # ---- the level script ---------------------------------------------------------
    def _edit_scr_target(self, req):
        """The .scr beside the map the page shows: (map path, .scr path), or (None, why).
        Only a map opened from disk: a pak's map is a copy in the workspace."""
        src = os.path.abspath(str(req.get("src") or ""))
        if not src or not os.path.isfile(src):
            return None, "the map's file wasn't found"
        if self._tmp and os.path.normcase(src).startswith(os.path.normcase(os.path.abspath(self._tmp))):
            return None, ("this map is opened from the paks: save it with Modify's Save as .bsp / .map, open "
                          "the copy, and its level script can be edited beside it")
        if not src.lower().endswith((".bsp", ".map")):
            return None, "only a .bsp or .map's level script can be edited (a .bak is a backup)"
        cur = self._last_build[0] if self._last_build else None
        if not cur or os.path.normcase(os.path.abspath(cur)) != os.path.normcase(src):
            return None, "the page isn't the map the launcher has open: open it again"
        return src, os.path.splitext(src)[0] + ".scr"

    def _edit_scr_reply(self, ok, **kw):
        self._page_js("window.MOHAA_EDIT_SCR&&MOHAA_EDIT_SCR(%s)" % json.dumps(dict(ok=ok, **kw)))

    def _edit_scr_load(self, body):
        """The page's Level script...: the .scr beside the map, or a starting script."""
        try: req = json.loads(body[:64 * 1024])
        except ValueError: MC.swallowed(); self._edit_scr_reply(False, msg="a request the launcher can't read"); return
        if not isinstance(req, dict): return
        src, scr = self._edit_scr_target(req)
        if not src:
            self._log_line(f"Level script: {scr}", "err"); self._edit_scr_reply(False, msg=scr); return
        stem = os.path.splitext(os.path.basename(src))[0]
        if os.path.isfile(scr):
            if os.path.getsize(scr) > SCR_MAX:
                self._edit_scr_reply(False, msg=f"{os.path.basename(scr)} is larger than {SCR_MAX // 1048576} MB"); return
            with open(scr, "r", encoding="latin-1", newline="") as f: text = f.read()
            text = text.replace("\r\n", "\n")
            note = f"{scr} - Save writes it again (the old file kept as {os.path.basename(scr)}.bak)."
        else:
            text = SCR_START.replace("{name}", stem)
            note = (f"{scr} - there is none yet: this is a starting script, written when you save. "
                    f"The game runs it when {stem}.bsp loads.")
        self._log_line(f"Level script: {scr}" + ("" if os.path.isfile(scr) else " (new)"), "dim")
        self._edit_scr_reply(True, path=scr, text=text, note=note)

    def _edit_scr_save(self, body):
        """The page's Save: write the .scr beside the map (atomically, the old one kept as
        .bak), read it back, then tell the page (which asks for the rebuild)."""
        def tell(ok, msg):
            self._log_line(("Level script: " if ok else "Level script not saved: ") + msg, "ok" if ok else "err")
            self._page_js("window.MOHAA_EDIT_SCR_SAVED&&MOHAA_EDIT_SCR_SAVED(%s,%s)" % (json.dumps(ok), json.dumps(msg)))
        if len(body) > REQ_MAX: tell(False, "the script is too large"); return
        try: req = json.loads(body)
        except ValueError: MC.swallowed(); tell(False, "a request the launcher can't read"); return
        if not isinstance(req, dict) or not isinstance(req.get("text"), str): tell(False, "no script text"); return
        src, scr = self._edit_scr_target(req)
        if not src: tell(False, scr); return
        text = req["text"]
        if len(text) > SCR_MAX: tell(False, f"the script is larger than {SCR_MAX // 1048576} MB"); return
        if "\0" in text: tell(False, "the script holds a NUL character"); return
        bad = sorted({c for c in text if ord(c) > 255})
        if bad:
            tell(False, "the game reads scripts as single-byte text: these characters can't be written: " + "".join(bad[:10])); return
        eol = "\n"
        if os.path.isfile(scr):
            with open(scr, "rb") as f: old = f.read(65536)
            if b"\r\n" in old: eol = "\r\n"
        data = text.replace("\r\n", "\n").replace("\n", eol).encode("latin-1")
        try:
            MC.atomic_write_bytes(scr, data, backup=True)
            with open(scr, "rb") as f: back = f.read()
        except OSError as e:
            MC.swallowed(); tell(False, f"could not write {scr}: {e}"); return
        if back != data: tell(False, f"{scr} reads back differently from what was written"); return
        n = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
        tell(True, f"saved {scr} ({n} lines, {len(data)} bytes; read back and checked) - building the page again")

    def _edit_scr_reload(self, body=""):
        """After a script save: build the page again (its .scr changed) and show it. The
        page is closed first, so the new one really loads (as Rebuild does); the camera it
        sent comes back once the new page says it is ready (mohaa-edit-ready)."""
        lb = self._last_build
        if not lb or not lb[0] or not os.path.isfile(lb[0]): return
        try:
            c = json.loads(body[:2000]) if body else None
            if isinstance(c, dict) and all(isinstance(x, (int, float)) for x in c.get("pos", ())[:3]) \
                    and len(c.get("pos", ())) == 3:
                self._edit_cam = {"map": str(c.get("map") or ""), "pos": [float(x) for x in c["pos"]],
                                  "yaw": float(c.get("yaw") or 0), "pitch": float(c.get("pitch") or 0),
                                  "roll": float(c.get("roll") or 0)}
        except (ValueError, TypeError):
            MC.swallowed()
        if self._viewer_open_busy(): return
        self._close_viewer()
        self._load(*lb)

    def _edit_ready(self, body):
        """An editor page has loaded: give it back the camera a script save kept."""
        cam = getattr(self, "_edit_cam", None)
        self._edit_cam = None
        try: name = str(json.loads(body[:2000]).get("map") or "")
        except (ValueError, AttributeError): MC.swallowed(); return
        if cam and cam.get("map") == name:
            self._page_js("window.MOHAA_EDIT_CAM&&MOHAA_EDIT_CAM(%s)" % json.dumps(cam))

    # ---- textures for brush faces -----------------------------------------------------
    def _edit_texlist(self):
        """The page's texture browser: every texture in the loaded paks (images under
        textures/ and the shaders named there), as the .map names them with textures/."""
        if self._vfs is None or not self._tex_ready:
            self._page_js("try{MOHAA_EDIT_TEXLIST(null,%s)}catch(e){}" % json.dumps("The paks are still loading: open the list again in a moment"))
            return
        try:
            names = set()
            for k in self._vfs.names():
                if k.startswith("textures/") and k.endswith((".jpg", ".tga", ".png")):
                    names.add(os.path.splitext(k)[0])
            for k in (self._SH or {}):
                if isinstance(k, str) and k.startswith("textures/"):
                    names.add(k.lower())
        except Exception as e:
            MC.swallowed()
            self._page_js("try{MOHAA_EDIT_TEXLIST(null,%s)}catch(e){}" % json.dumps("No texture list: %s" % e))
            return
        self._page_js("try{MOHAA_EDIT_TEXLIST(%s)}catch(e){}" % json.dumps(sorted(names), separators=(",", ":")))

    def _edit_tex(self, name):
        """One texture's picture for the page (as a map build packs it), on a worker thread.
        The name comes from the page: textures/..., no '..', no control characters."""
        n = (name or "").strip().replace("\\", "/").lower()
        fail = lambda why: self._page_js("try{MOHAA_EDIT_TEX_FAIL(%s,%s)}catch(e){}" % (json.dumps(n), json.dumps(why)))
        if not n.startswith("textures/") or ".." in n or len(n) > 200 or any(ord(c) < 32 or c in '"(){}' for c in n):
            fail("not a texture name"); return
        if self._vfs is None or not self._tex_ready:
            fail("the paks are still loading"); return
        try: texsize = int(self._texsize.get())
        except (TypeError, ValueError): texsize = 256
        vfs, shaders, cache = self._vfs, self._SH, self._index_cache
        def work():
            try:
                import mohaa_map_view as MMV
                blobs = MMV.Blobs()
                tcache = MMV.TextureCache(os.path.join(cache, "tex")) if cache else None
                texs = MMV.TextureTable(vfs, shaders, blobs, max(32, min(1024, texsize)), tcache)
                texs.add(n)
                if n in texs.missing:
                    raise ValueError("not found in the loaded paks")
                b64, _raw, _gz = MMV.pack_payload({"tex": texs.entries}, blobs)
                js = "try{MOHAA_EDIT_TEX(%s,%s)}catch(e){}" % (json.dumps(n), json.dumps(b64))
            except Exception as e:
                MC.swallowed()
                js = "try{MOHAA_EDIT_TEX_FAIL(%s,%s)}catch(e){}" % (json.dumps(n), json.dumps(str(e)[:200]))
            self._page_requests.append(lambda j=js: self._page_js(j))
        threading.Thread(target=work, daemon=True).start()

    def _close_ask(self, info):
        """As the Map Viewer's, naming the brush changes too (the page sends "brushes"):
        those save only as a .map, so the page then sends isBsp false."""
        try: nb = max(0, int(info.get("brushes") or 0))
        except (TypeError, ValueError): nb = 0
        if not nb:
            return MM.MapApp._close_ask(self, info)
        def num(k):
            try: return max(0, int(info.get(k) or 0))
            except (TypeError, ValueError): return 0
        nw, ch = num("new"), num("changed")
        parts = [f"{nb} geometry change{'' if nb == 1 else 's'} (brushes, patches, terrain)"]
        if nw: parts.append(f"{nw} new entit{'y' if nw == 1 else 'ies'}")
        if ch: parts.append(f"{ch} changed entit{'y' if ch == 1 else 'ies'}")
        name = str(info.get("name") or "this map")[:80]
        choice = self._unsaved_dialog(
            "Unsaved changes",
            f"{name} has {' and '.join(parts)} not saved.",
            "Save them as a .map before closing? (Changed geometry needs compiling to become a .bsp.)",
            [("map", "Save as .map", True), ("discard", "Discard changes", True), ("cancel", "Cancel", True)])
        if choice == "map":
            self._page_js("try{modSaveThenClose('map')}catch(e){}")
        elif choice == "discard":
            self._log_line("  (the unsaved brush and MODIFY changes were discarded)", "dim")
            self._page_js("try{modDiscardClose()}catch(e){}")

    # ---- the recovery file also keeps brush changes -------------------------------------
    BRUSH_OPS_MAX = 20000                       # brush changes a recovery file may carry

    def _modify_backup(self, body):
        """As the Map Viewer's, and a copy is kept when only brushes changed (Modify's
        entities none): the page's "brush" part is a list of text changes, checked here."""
        if len(body) > self.MODIFY_BACKUP_MAX: return
        try: info = json.loads(body)
        except ValueError: MC.swallowed(); return
        if not isinstance(info, dict): return
        br = info.get("brush")
        ok = (isinstance(br, dict) and isinstance(br.get("ops"), list) and 0 < len(br["ops"]) <= self.BRUSH_OPS_MAX
              and all(isinstance(o, dict) and isinstance(o.get("at"), int) and isinstance(o.get("del"), str)
                      and isinstance(o.get("ins"), str) for o in br["ops"]))
        if not ok:
            info.pop("brush", None)
            return MM.MapApp._modify_backup(self, json.dumps(info))
        p = self._modify_backup_path(info)
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            MC.atomic_write_text(p, json.dumps(info, separators=(",", ":")))
        except OSError:
            MC.swallowed()

    def _page_message(self, m):
        """The editor page's own messages (WebView2 thread: only queue work here)."""
        if m == "mohaa-edit-new":
            self._page_requests.append(self._edit_new)
            return True
        if m.startswith("mohaa-edit-scr-load\n"):
            body = m.split("\n", 1)[1]
            self._page_requests.append(lambda b=body: self._edit_scr_load(b))
            return True
        if m.startswith("mohaa-edit-scr-save\n"):
            body = m.split("\n", 1)[1]
            self._page_requests.append(lambda b=body: self._edit_scr_save(b))
            return True
        if m.startswith("mohaa-edit-scr-reload\n"):
            body = m.split("\n", 1)[1]
            self._page_requests.append(lambda b=body: self._edit_scr_reload(b))
            return True
        if m == "mohaa-edit-texlist":
            self._page_requests.append(self._edit_texlist)
            return True
        if m.startswith("mohaa-edit-tex\n"):
            name = m.split("\n", 1)[1][:300]
            self._page_requests.append(lambda n=name: self._edit_tex(n))
            return True
        if m == "mohaa-edit-compile" or m.startswith("mohaa-edit-compile\n"):
            body = m.split("\n", 1)[1] if "\n" in m else ""
            self._page_requests.append(lambda b=body: self._edit_compile(b))
            return True
        if m.startswith("mohaa-edit-ready\n"):
            body = m.split("\n", 1)[1]
            self._page_requests.append(lambda b=body: self._edit_ready(b))
            return True
        return None
