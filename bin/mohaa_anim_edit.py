#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ==============================================================================
#  mohaa_anim_edit.py  --  the Model Viewer's animation editor (Edit animations)
#
#  AnimApp is the Model Viewer's window (mohaa_launcher.App) with the animation editor
#  built in; mohaa_launcher.py runs it. With Edit animations off (the toolbar button or
#  View > Edit animations, Ctrl+Shift+E) it is the Model Viewer exactly. Every model page
#  carries the rig, the raw .skc channels and the editor (bin/mohaa_anim_solver.js plus
#  its panel), dormant; the toggle shows or hides the editor in the open page, in place.
#    - a cached page is reused only if it is newer than the editor's own files;
#    - the page's "Save .skc..." arrives as `mohaa-anim-save` + JSON: the file is written by
#      mohaa_skc_write.py, read back and checked, and the result goes back to the page;
#    - "Add to game..." (`mohaa-anim-addgame`) puts a saved human animation in a mod pak,
#      <output folder>/mod/zzz_mohaa_custom_anims.pk3: the .skc under
#      models/human/animation/custom/, a custom_anims.tik listing every custom animation, and
#      the game's own models/human/new_generic_human.tik (which every human .tik includes)
#      with one $include line added. The pak is read back through mohaa_textures' Vfs and
#      animation catalogue before it is reported.
#  Turning it on or off changes the open page in place (setEditorMode); nothing is rebuilt.
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
from mohaa_launcher import filedialog
import json, math, queue, re, struct, io, zipfile
import mohaa_skc_write as SKW                   # .skc writer
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = MC.get_logger("anim_edit")
try:
    import mohaa_textures as MTX                # pak file system and the animation catalogue
except Exception:
    # the launcher already logged this import failure and runs without textures; Add to
    # game says it can't check the game's names without it
    LOG.error("mohaa_textures could not be imported; Add to game is unavailable", exc_info=True)
    MTX = None
# Files the editor page is built from besides the Model Viewer's (App._html_current
# already checks mohaa_launcher.py, mohaa_view.py and mohaa_textures.py).
# the mod pak (see _anim_addgame)
MOD_PK3 = "zzz_mohaa_custom_anims.pk3"           # zzz: later paks override earlier ones
GENERIC_TIK = "models/human/new_generic_human.tik"
CUSTOM_DIR = "models/human/animation/custom"
CUSTOM_TIK = CUSTOM_DIR + "/custom_anims.tik"
INCLUDE_LINE = "$include " + CUSTOM_TIK
ALIAS_RE = re.compile(r"^[A-Za-z0-9_]{1,47}$")    # the engine's alias is char[48]
# limits on a save request from the page (its text is treated as untrusted)
MAX_SAVE_BYTES = 64 * 1024 * 1024
MAX_SAVE_FRAMES = 4000
MAX_SAVE_CHANNELS = 8192
EDITOR_SOURCES = [os.path.abspath(__file__), os.path.join(HERE, "mohaa_anim_solver.js"),
                  os.path.join(HERE, "mohaa_skc_write.py")]


class AnimApp(ML.App):
    """The Model Viewer's launcher window with the animation editor (see the top of this
    file). Its state is set in App.__init__ (_editor_on, _anim_q, _anim_saved), which the
    Map Viewer repeats, so tests/check_init_attrs.py holds."""
    EDITOR_LABEL = "Edit animations"
    EDITOR_TIP = ("Edit animations (Ctrl+Shift+E): open models in the animation editor - pose a character\n"
                  "and make new .skc animations, save them and add them to the game.\n"
                  "Off: the Model Viewer's panel. Switching changes the open page in place.")

    def __init__(self, initial_file=None):
        ML.App.__init__(self, initial_file=initial_file)
        self.after(200, self._anim_poll)

    def _editor_active(self):
        return bool(self._editor_on.get())

    def _anim_poll(self):
        """Run the editor page's requests on the Tk thread."""
        try:
            while True:
                kind, data = self._anim_q.get_nowait()
                if kind == "save":
                    try: self._anim_save(data)
                    except Exception as e:
                        MC.swallowed()
                        self._anim_reply(False, f"save failed: {e}")
                elif kind == "addgame":
                    try: self._anim_addgame(data)
                    except Exception as e:
                        MC.swallowed()
                        self._anim_added(False, f"could not add it to the game: {e}")
        except queue.Empty:
            pass
        try: self.after(150, self._anim_poll)
        except Exception: MC.swallowed()

    def _anim_reply(self, ok, msg, fname="", fpath=""):
        """Tell the page how the save went, and log it."""
        self._log_line(("Saved: " if ok else "Editor: ") + msg, "ok" if ok else "err")
        self._embed_js("window.MOHAA_ANIMED_SAVED&&MOHAA_ANIMED_SAVED(%s,%s,%s,%s)"
                       % (json.dumps(ok), json.dumps(msg), json.dumps(fname), json.dumps(fpath)))

    def _anim_added(self, ok, msg):
        """Tell the page how "Add to game" went, and log it."""
        self._log_line(("Added to game: " if ok else "Editor: ") + msg, "ok" if ok else "err")
        self._embed_js("window.MOHAA_ANIMED_ADDED&&MOHAA_ANIMED_ADDED(%s,%s)" % (json.dumps(ok), json.dumps(msg)))

    def _anim_save_dir(self):
        """Where saved animations go by default: <output folder>/skc."""
        return os.path.join(self._outdir, "skc")

    def _anim_save(self, text):
        """Write the page's animation (see savePayload in the page) as a .skc."""
        if len(text) > MAX_SAVE_BYTES: raise ValueError("the request is too large")
        p = json.loads(text)
        names = [str(n) for n in p["names"]]
        frames = p["frames"]
        if not frames: raise ValueError("no frames")
        if len(frames) > MAX_SAVE_FRAMES or len(names) > MAX_SAVE_CHANNELS:
            raise ValueError(f"{len(frames)} frames x {len(names)} channels is more than an animation can hold here "
                             f"({MAX_SAVE_FRAMES} x {MAX_SAVE_CHANNELS})")
        anim = {"flags": int(p.get("flags") or 0), "frameTime": float(p["frameTime"]),
                "names": names, "frames": []}
        for i, fr in enumerate(frames):
            vals = [[float(x) for x in v] for v in fr["v"]]
            if len(vals) != len(names): raise ValueError(f"frame {i}: {len(vals)} values for {len(names)} channels")
            mn, mx = [float(x) for x in fr["b"][0]], [float(x) for x in fr["b"][1]]
            anim["frames"].append({"bounds": [mn, mx], "radius": float(fr["r"]),
                                   "delta": [float(x) for x in fr["d"]], "angleDelta": float(fr["a"]),
                                   "values": vals})
        SKW.recompute_totals(anim)
        data = SKW.write_skc(anim)              # validates: names, lengths, finite numbers
        # where: a Save dialog, starting in <output folder>/skc with the animation's name
        stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(p.get("name") or "animation")).strip("._") or "animation"
        initdir = self._anim_save_dir()
        try: os.makedirs(initdir, exist_ok=True)
        except OSError: MC.swallowed(); initdir = self._outdir
        path = filedialog.asksaveasfilename(parent=self, title="Save the animation as a .skc",
                                            initialdir=initdir, initialfile=stem + ".skc",
                                            defaultextension=".skc", filetypes=[("MOHAA animation", "*.skc")])
        if not path:
            self._anim_reply(False, "save cancelled"); return
        SKW.save_skc(path, anim, backup=True)
        ok, msg, name = self._anim_verify(path, anim, data)
        if ok: self._anim_saved.add(os.path.abspath(path))
        self._anim_reply(ok, msg, name, os.path.abspath(path) if ok else "")

    def _anim_verify(self, path, anim, data):
        """Read the file back two ways (the writer's reader and mohaa_view.parse_skc) and
        compare every value with what was sent, at float32. Returns (ok, message, name)."""
        name = os.path.basename(path)
        with open(path, "rb") as f: back = f.read()
        if back != data:
            return False, f"{name}: the file on disk differs from what was written", name
        r = SKW.read_skc_bytes(back, path)
        f32 = lambda x: struct.unpack("<f", struct.pack("<f", x))[0]
        worst = 0.0
        for fa, fb in zip(anim["frames"], r["frames"]):
            for va, vb in zip(fa["values"], fb["values"]):
                for x, y in zip(va, vb):
                    if f32(x) != y: worst = max(worst, abs(x - y))
        keys = SKW.chan_keys(anim["names"])     # the readers key padded bone names stripped
        if r["names"] != keys or len(r["frames"]) != len(anim["frames"]) or worst:
            return False, f"{name}: read back with different contents (largest difference {worst})", name
        try:
            import mohaa_view as MV
            v = MV.parse_skc(path)
            if v["numFrames"] != len(anim["frames"]) or v["names"] != keys:
                return False, f"{name}: mohaa_view.parse_skc reads it differently", name
        except Exception as e:
            MC.swallowed()
            return False, f"{name}: mohaa_view.parse_skc can't read it ({e})", name
        nf, nc = len(anim["frames"]), len(anim["names"])
        return True, (f"{path} - {nf} frame{'s' if nf != 1 else ''}, {nc} channels, "
                      f"{1/anim['frameTime']:.4g} fps, {len(back)} bytes; read back and checked"), name

    # ---- Add to game: the mod pak -------------------------------------------------------
    def _anim_mod_dir(self):
        """<output folder>/mod: the pak, the registry and the registered .skc copies."""
        return os.path.join(self._outdir, "mod")

    def _anim_registry(self):
        """The custom animations in the pak: [{"name", "file"}] (file: the copy in mod/files)."""
        p = os.path.join(self._anim_mod_dir(), "custom_anims.json")
        try:
            with open(p, "r", encoding="utf-8") as f: reg = json.load(f)
            return [e for e in reg if isinstance(e, dict) and ALIAS_RE.match(str(e.get("name", "")))]
        except FileNotFoundError:
            return []

    def _anim_game_paks(self):
        """The loaded paks without this program's own mod pak, so the game's own files are read."""
        return [p for p in self._pk3_paths if os.path.basename(p).lower() != MOD_PK3.lower()]

    @staticmethod
    def _anim_human_tiks(vfs):
        """Every character .tik that includes new_generic_human.tik: [(path, text)]. Some
        declare animations of their own (e.g. the den_actor dialogue), so a new name is
        checked against all of them."""
        out = []
        for n in sorted(vfs.names()):
            if n.startswith("models/human/") and n.endswith(".tik") and n.count("/") == 2:
                t = (vfs.read(n) or b"").decode("latin-1", "replace")
                if "new_generic_human.tik" in t.lower():
                    out.append((n, t))
        return out

    @staticmethod
    def _anim_custom_tik(reg, eol):
        """custom_anims.tik: one animations{} block with every registered animation."""
        lines = ["// Custom animations, written by the MOHAA Animation Editor.",
                 "// Included from models/human/new_generic_human.tik, so every human has them.",
                 "", "animations", "{", "\t$path " + CUSTOM_DIR, ""]
        lines += ["\t%-32s %s.skc" % (e["name"], e["name"]) for e in reg]
        lines += ["}", ""]
        return eol.join(lines)

    @staticmethod
    def _anim_build_pak(base_generic, reg, files_dir):
        """The mod pak's bytes: new_generic_human.tik (the game's own + one $include line),
        custom_anims.tik and each animation's .skc."""
        txt = base_generic.decode("latin-1")
        eol = "\r\n" if "\r\n" in txt else "\n"
        if INCLUDE_LINE.lower() not in txt.lower():
            if not txt.endswith(("\n", "\r")): txt += eol
            txt += eol + "// Custom animations (MOHAA Animation Editor)" + eol + INCLUDE_LINE + eol
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(GENERIC_TIK, txt.encode("latin-1"))
            z.writestr(CUSTOM_TIK, AnimApp._anim_custom_tik(reg, eol).encode("latin-1"))
            for e in reg:
                with open(os.path.join(files_dir, e["name"] + ".skc"), "rb") as f:
                    z.writestr(CUSTOM_DIR + "/" + e["name"] + ".skc", f.read())
        return buf.getvalue()

    def _anim_addgame(self, text):
        """Put a saved animation in the mod pak, then check the pak the way the viewer reads paks."""
        if len(text) > 64 * 1024: raise ValueError("the request is too large")
        p = json.loads(text)
        src = os.path.abspath(str(p.get("path") or ""))
        if src not in self._anim_saved or not os.path.isfile(src):
            self._anim_added(False, "save the animation first (only files saved in this session can be added)"); return
        if MTX is None:
            self._anim_added(False, "mohaa_textures.py could not be loaded"); return
        paks = self._anim_game_paks()
        if not paks:
            self._anim_added(False, "add the game's paks first (File > Add .pk3 paks): the mod is built from them"); return
        data = open(src, "rb").read()
        anim = SKW.read_skc_bytes(data, src)
        if not any(n.startswith("Bip01") for n in anim["names"]):
            self._anim_added(False, "only human (Bip01) animations can be added"); return
        vfs = MTX.Vfs(paks)
        try:
            base = vfs.read(GENERIC_TIK)
            if base is None:
                self._anim_added(False, f"the loaded paks have no {GENERIC_TIK}"); return
            tiks = self._anim_human_tiks(vfs)
            if not tiks:
                self._anim_added(False, "no human .tik in the loaded paks includes new_generic_human.tik"); return
            taken = set()                       # every animation name any human .tik can reach
            for tn, tt in tiks:
                taken |= {a["n"].lower() for a in MTX.build_anim_catalog(tt, vfs, tn)["anims"]}
        finally:
            vfs.close()
        reg = self._anim_registry()
        ours = {e["name"].lower() for e in reg}
        # the name: what scripts call it by
        from tkinter import simpledialog
        stem = re.sub(r"[^A-Za-z0-9_]+", "_", os.path.splitext(os.path.basename(src))[0]).strip("_")[:47] or "custom_anim"
        name = simpledialog.askstring("Add to game", "Animation name (letters, digits and _; scripts use it):",
                                      initialvalue=stem, parent=self)
        if name is None:
            self._anim_added(False, "cancelled"); return
        name = name.strip()
        if not ALIAS_RE.match(name):
            self._anim_added(False, f"'{name}' isn't a usable name: 1 to 47 letters, digits or _"); return
        if name.lower() in taken - ours:
            self._anim_added(False, f"'{name}' is already a human animation in the game: pick another name"); return
        # the registry, with this animation's own copy of the .skc
        mdir = self._anim_mod_dir(); fdir = os.path.join(mdir, "files")
        os.makedirs(fdir, exist_ok=True)
        reg = [e for e in reg if e["name"].lower() != name.lower()] + [{"name": name, "from": src}]
        MC.atomic_write_bytes(os.path.join(fdir, name + ".skc"), data)
        pak = self._anim_build_pak(base, reg, fdir)
        out = os.path.join(mdir, MOD_PK3)
        MC.atomic_write_bytes(out, pak, backup=True)
        MC.atomic_write_json(os.path.join(mdir, "custom_anims.json"), reg)
        ok, why = self._anim_check_pak(paks, out, name)
        if not ok:
            self._anim_added(False, f"{MOD_PK3} was written but doesn't check out: {why}"); return
        main = next((os.path.dirname(x) for x in paks if os.path.basename(x).lower() == "pak0.pk3"), None)
        where = f" Copy it into the game's main folder ({main}) to play it." if main else \
                " Copy it into the game's main folder (beside pak0.pk3) to play it."
        self._anim_added(True, f"'{name}' is in {out} ({len(reg)} custom animation{'s' if len(reg) != 1 else ''}; "
                               f"checked: {why}).{where} Every human .tik can now play it by that name.")

    @staticmethod
    def _anim_check_pak(paks, pak, name):
        """Read the game's paks plus the mod pak like the viewer does: every human .tik's
        animation catalogue must list `name` once, with our .skc, and that .skc must load."""
        vfs = MTX.Vfs(list(paks) + [pak])
        try:
            want = (CUSTOM_DIR + "/" + name + ".skc").lower()
            tiks = AnimApp._anim_human_tiks(vfs)
            if not tiks:
                return False, "no human .tik found"
            for tn, tt in tiks:
                hit = [a for a in MTX.build_anim_catalog(tt, vfs, tn)["anims"] if a["n"].lower() == name.lower()]
                if len(hit) != 1:
                    return False, f"{tn} lists '{name}' {len(hit)} times"
                if hit[0]["s"].lower() != want:
                    return False, f"{tn}: '{name}' points at {hit[0]['s']}, not {want}"
            b = vfs.read(want)
            if not b:
                return False, f"{want} isn't in the paks"
            a = SKW.read_skc_bytes(b, want)
            return True, f"all {len(tiks)} human .tik files list it, {len(a['frames'])} frames"
        finally:
            vfs.close()

    def _html_current(self, hp):
        """Every model page carries the editor (dormant until Edit animations is on): reuse
        a cached page only if it is newer than the editor's own files too, then apply the
        Model Viewer's checks (its scripts, viewer revision)."""
        try:
            newest = max((os.path.getmtime(s) for s in EDITOR_SOURCES if os.path.exists(s)), default=0)
            if os.path.getmtime(hp) < newest:
                self._log_line(f"({os.path.basename(hp)} is older than the editor's files - rebuilding)", "dim")
                return False
        except OSError:
            MC.swallowed()
            return False
        return ML.App._html_current(self, hp)

    def _page_message(self, m):
        """The editor page's own messages (WebView2 thread: only queue work here)."""
        if m.startswith("mohaa-anim-save\n"):
            self._anim_q.put(("save", m.split("\n", 1)[1]))
            return True
        if m.startswith("mohaa-anim-addgame\n"):
            self._anim_q.put(("addgame", m.split("\n", 1)[1]))
            return True
        if m.startswith("mohaa-anim-edit-check "):
            # "<ok|bad> <animation> <largest difference> [<bone>]": the page re-solved a built
            # animation; a difference only means the edit's preview may be a little off there
            p = m.split(" ", 4)
            if len(p) >= 4 and p[1] != "ok":
                try: d = "%.2f" % float(p[3])
                except ValueError: d = p[3]
                where = (" at " + p[4]) if len(p) > 4 and p[4] else ""
                self._log_q.put(("dim", f"(Edit animations: the editor's preview of {p[2]} differs from the "
                                        f"viewer's playback{where} by {d}; saved files aren't affected)"))
            return True
        return None
