#!/usr/bin/env python3
"""Tests for the Map Viewer's map editor (Edit map): bin/mohaa_map_edit.py (New map's starter room and
its check), the editor's code dormant in every map page and switched in place, page
names, and the page's messages. Needs tkinter (the launcher modules import it).
Run: python3 tests/test_map_editor.py"""
import json, os, re, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(os.path.dirname(HERE), "bin")
sys.path.insert(0, BIN)
import mohaa_bsp as MB                  # noqa: E402
import mohaa_map_view as MV             # noqa: E402
import mohaa_map_edit as E              # noqa: E402
import mohaa_map_launcher as MM         # noqa: E402


class StarterMap(unittest.TestCase):
    def test_checks_out(self):
        ok, why, counts = E.check_map_text(E.starter_map("room"))
        self.assertTrue(ok, why)
        self.assertEqual(counts, {"entities": 4, "brushes": 6})

    def test_textured_faces_face_the_room(self):
        """Every textured (not caulk) face's plane looks into the room and lies on its
        inside: floor up at z 0, ceiling down at the room's height, walls inward."""
        h, top = E.ROOM_HALF, E.ROOM_HEIGHT
        want = {((0, 0, 1), 0), ((0, 0, -1), -top), ((1, 0, 0), -h), ((-1, 0, 0), -h),
                ((0, 1, 0), -h), ((0, -1, 0), -h)}
        got = set()
        for ln in E.starter_map("room").splitlines():
            m = E._FACE_RE.match(ln.strip())
            if m and m.group(10) != E.CAULK:
                v = [float(x) for x in m.groups()[:9]]
                n, d = MB.plane_from_points(v[0:3], v[3:6], v[6:9])
                got.add((tuple(int(round(c)) for c in n), int(round(d))))
        self.assertEqual(got, want)

    def test_title_cannot_break_out_of_its_value(self):
        t = E.starter_map('a"b}{c\nd')
        self.assertIn('"message" "abcd"', t)
        self.assertTrue(E.check_map_text(t)[0])

    def test_bad_text_is_refused(self):
        flat = "{\n{\n( 0 0 0 ) ( 1 0 0 ) ( 2 0 0 ) a 0 0 0 1 1 0 0 0\n}\n}\n"
        self.assertFalse(E.check_map_text(flat)[0])
        self.assertFalse(E.check_map_text("{\n")[0])
        self.assertFalse(E.check_map_text("}\n")[0])
        self.assertFalse(E.check_map_text("{\n{\nnot a face\n}\n}\n")[0])
        # an open brush: a box with one side missing doesn't close
        lines = E.starter_map("room").splitlines()
        i = next(k for k, ln in enumerate(lines) if ln.startswith("( "))
        self.assertFalse(E.check_map_text("\n".join(lines[:i] + lines[i + 1:]))[0])


class _On:
    """Edit map's on/off variable, for a window made without __init__."""
    def __init__(self, v): self.v = v
    def get(self): return self.v
    def set(self, v): self.v = v


def _editor(on=True):
    app = E.EditApp.__new__(E.EditApp)
    app._editor_on = _On(on)
    return app


class Pages(unittest.TestCase):
    def test_page_names(self):
        # one page whether Edit map is on or off: the editor is in every page, dormant
        self.assertEqual(MV.page_name("mohdm6.bsp"), "mohdm6_bsp_view.html")
        self.assertEqual(MV.page_name("mohdm6.bsp", True), "mohdm6_bsp_view.html")
        for on in (True, False):
            app = _editor(on)
            self.assertEqual(app._viewer_html_name("x/obj_team2.map"), "obj_team2_map_view.html")
            self.assertEqual(app._builder_extra_args(), [])
            self.assertEqual(app._editor_hash(), "&edit=1" if on else "")
        # the older editor's pages are still cleared as built files
        self.assertTrue(MM.MapApp._is_built_file("/o/obj_team2_map_edit_view.html"))
        self.assertFalse(MM.MapApp._is_built_file("/o/obj_team2_edit.html"))

    def test_args(self):
        self.assertTrue(MV.parse_args(["m.bsp", "--editor"])[1]["editor"])
        self.assertFalse(MV.parse_args(["m.bsp"])[1]["editor"])

    def _page(self, editor):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "p.html")
            MV.write_html(p, "t", "", {"name": "t"}, None, editor)
            with open(p, encoding="utf-8") as f:
                return f.read()

    def test_every_page_has_the_editor_dormant(self):
        for editor in (False, True):
            page = self._page(editor)
            self.assertNotIn("__EDITOR_JS__", page)
            i, j = page.find("window.MOHAA_EDITOR=true"), page.rfind("\nmain();")
            self.assertTrue(0 < i < j)
            # nothing in the inlined code can close the page's <script> early
            body = page[page.find("try{gridLoad();}catch(_e){}"):j]
            self.assertIsNone(re.search(r"</script", body, re.I))
            # the mode comes from the URL (#edit=1) and setEditorMode, in the page head
            head = page[:page.find("</head>")]
            self.assertIn("window.__EDITON__=", head)
            self.assertIn("window.setEditorMode=", head)

    def test_editor_set_switches_in_place(self):
        app = _editor(False)
        app._cfg = {}; app._save_config = lambda: None; app._editor_btn_show = lambda: None
        app._log_line = lambda *a, **k: None
        sent = []
        app._embed_js = sent.append
        app._embed_url = "file:///o/m_bsp_view.html#embed&theme=dark"
        app._load = lambda *a: self.fail("toggling must not rebuild or reload the page")
        app._close_viewer = lambda: self.fail("toggling must not close the page")
        app._editor_set(True)
        self.assertTrue(app._cfg["editor_mode"])
        self.assertEqual(app._embed_url, "file:///o/m_bsp_view.html#embed&theme=dark&edit=1")
        self.assertIn("setEditorMode(true)", sent[-1])
        app._editor_set(False)
        self.assertEqual(app._embed_url, "file:///o/m_bsp_view.html#embed&theme=dark")
        self.assertIn("setEditorMode(false)", sent[-1])

    def test_messages(self):
        app = _editor()
        app._page_requests = []
        self.assertTrue(app._page_message("mohaa-edit-new"))
        self.assertEqual(len(app._page_requests), 1)
        self.assertIsNone(app._page_message("mohaa-edit-new extra"))
        self.assertIsNone(app._page_message("mohaa-something-else"))


class LevelScript(unittest.TestCase):
    """Which .scr the page may read and write: only beside the map the launcher has open,
    from disk (not a pak's copy in the workspace), a .bsp or .map."""
    def _app(self, d, opened):
        app = _editor()
        app._tmp = os.path.join(d, "ws"); os.makedirs(app._tmp)
        app._last_build = (opened, None, None, None, None)
        return app

    def test_target(self):
        with tempfile.TemporaryDirectory() as d:
            m = os.path.join(d, "x.bsp"); open(m, "wb").close()
            app = self._app(d, m)
            self.assertEqual(app._edit_scr_target({"src": m}), (m, os.path.join(d, "x.scr")))
            other = os.path.join(d, "y.map"); open(other, "w").close()
            self.assertIsNone(app._edit_scr_target({"src": other})[0])        # not the open map
            pak = os.path.join(app._tmp, "z.bsp"); open(pak, "wb").close()
            app._last_build = (pak, None, None, None, None)
            self.assertIsNone(app._edit_scr_target({"src": pak})[0])          # a pak's copy
            bak = os.path.join(d, "x.bak"); open(bak, "wb").close()
            app._last_build = (bak, None, None, None, None)
            self.assertIsNone(app._edit_scr_target({"src": bak})[0])
            self.assertIsNone(app._edit_scr_target({"src": os.path.join(d, "none.bsp")})[0])

    def test_start_script(self):
        s = E.SCR_START.replace("{name}", "50%_map")
        self.assertTrue(s.startswith("// 50%_map.scr") and "main:" in s and s.rstrip().endswith("end"))


class Pane(unittest.TestCase):
    """The Linux pane keeps a page's messages that come before the launcher's handler."""
    def test_early_messages(self):
        try:
            import mohaa_webpane_linux as WL
        except Exception:
            self.skipTest("the Linux pane module can't be loaded here")
        got = []
        ev = WL._Event("pane")
        ev.early += ["a", "b"]
        ev += (lambda s, a: got.append((s, a.TryGetWebMessageAsString())))
        self.assertEqual(got, [("pane", "a"), ("pane", "b")])
        self.assertEqual(ev.early, [])


class BspBrushModel(unittest.TestCase):
    """A changed brush entity written into a .bsp keeps its "model" "*N" (the page's keys
    come from the decompiled .map, which has none). Needs MOHAA_GAMEFOLDER (main/Pak5.pk3)."""
    def test_door_keeps_model(self):
        gf = os.environ.get("MOHAA_GAMEFOLDER", "")
        pk = next((os.path.join(gf, "main", n) for n in ("Pak5.pk3", "pak5.pk3") if gf and os.path.isfile(os.path.join(gf, "main", n))), None)
        if not pk: self.skipTest("set MOHAA_GAMEFOLDER to the game folder")
        import zipfile
        with zipfile.ZipFile(pk) as z:
            n = next((x for x in z.namelist() if x.lower() == "maps/m4l0.bsp"), None)
            if not n: self.skipTest("no maps/m4l0.bsp in Pak5")
            data = z.read(n)
        ents = MB.parse_entity_string(MB.bsp_entity_text(data))
        ei = next(i for i, e in enumerate(ents) if MB._ent_class(e) == "func_rotatingdoor")
        kv = [(k, v) for k, v in ents[ei] if k.lower() != "model"]
        o = [float(x) for x in MB.ent_get(ents[ei], "origin").split()]
        kv = [(k, ("%g %g %g" % (o[0] + 48, o[1], o[2] + 8)) if k.lower() == "origin" else v) for k, v in kv]
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "m.bsp")
            MB.write_bsp_entities(data, "", out, None, replace=[{"ei": ei, "cls": "func_rotatingdoor", "origin": o, "kv": kv}])
            back = MB.parse_entity_string(MB.load(out).entity_text)[ei]
        self.assertEqual(MB.ent_get(back, "model"), MB.ent_get(ents[ei], "model"))
        self.assertEqual(MB.ent_get(back, "origin"), "%g %g %g" % (o[0] + 48, o[1], o[2] + 8))


class Brushes(unittest.TestCase):
    """The launcher's side of brush editing: the recovery copy, texture names, the close question."""
    def _app(self, d):
        app = _editor()
        app._js = []; app._page_js = app._js.append
        app._modify_backup_path = lambda info: os.path.join(d, "rec", "%s.json" % info.get("map"))
        app._log_line = lambda *a, **k: None
        return app

    def test_backup_keeps_brush_only_work(self):
        with tempfile.TemporaryDirectory() as d:
            app = self._app(d)
            good = {"map": "m", "mt": "1", "ents": [], "brush": {"ops": [{"at": 10, "del": "a", "ins": "b"}]}}
            app._modify_backup(json.dumps(good))
            p = os.path.join(d, "rec", "m.json")
            with open(p) as f: self.assertEqual(json.load(f)["brush"]["ops"][0]["ins"], "b")
            for bad in ({"ops": [{"at": "x", "del": "", "ins": ""}]}, {"ops": []}, {"ops": "no"}, ["x"]):
                info = dict(good, brush=bad)
                app._modify_backup(json.dumps(info))
                self.assertFalse(os.path.isfile(p), bad)     # no entities and no valid brush work

    def test_texture_names(self):
        app = self._app("")
        app._vfs = None; app._tex_ready = False
        for n in ("../etc/passwd", "textures/a/../../b", "models/x", 'textures/a"b', "textures/" + "x" * 300):
            app._js.clear(); app._edit_tex(n)
            self.assertIn("not a texture name", app._js[-1], n)
        app._js.clear(); app._edit_tex("textures/ok/name")
        self.assertIn("still loading", app._js[-1])

    def test_close_ask_names_brushes(self):
        app = self._app("")
        seen = []
        for choice, want in (("map", "modSaveThenClose('map')"), ("discard", "modDiscardClose()"), ("cancel", None)):
            app._js.clear()
            app._unsaved_dialog = lambda *a, c=choice: (seen.append(a), c)[1]
            app._close_ask({"new": 1, "changed": 0, "brushes": 3, "isBsp": False, "name": "room"})
            if want: self.assertIn(want, app._js[-1])
            else: self.assertEqual(app._js, [])
        self.assertIn("3 geometry changes (brushes, patches, terrain) and 1 new entity", seen[0][1])
        self.assertEqual([c[0] for c in seen[0][3]], ["map", "discard", "cancel"])

    def test_open_asks_the_page_first(self):
        """Opening another map with one in the pane asks that page (as Esc does) instead of
        navigating away, so the browser's own "Leave site?" never comes up; the new map opens
        when the page lets go, and not at all after Cancel."""
        app = self._app("")
        loaded = []
        class WV:
            def load_url(self, u): loaded.append(u)
        app._webview = WV(); app._embed_url = "file:///o/old_map_view.html#embed"
        app._ensure_webview = lambda: True
        app._set_status = lambda *a: None
        app.after = lambda ms, fn: None
        app._embed_merge_ui = lambda: None
        app._editor_hash = lambda: ""; app._theme = "dark"
        app._open_file("/o/new_bsp_view.html")
        self.assertEqual(loaded, [])
        self.assertIn("closeViewer()", app._js[-1])
        self.assertEqual(app._open_after, "/o/new_bsp_view.html")
        # unsaved: the question names the map waiting; Cancel keeps the old page
        seen = []
        app._unsaved_dialog = lambda *a: (seen.append(a), "cancel")[1]
        app._close_ask({"new": 0, "changed": 0, "brushes": 2, "isBsp": False, "name": "room"})
        self.assertIn("before opening new_bsp_view.html", seen[0][2])
        self.assertIsNone(app._open_after)
        app._open_file("/o/new_bsp_view.html")
        # saved / discarded / nothing unsaved: the page's close opens the new map
        app._close_viewer()
        self.assertEqual(len(loaded), 1)
        self.assertTrue(loaded[0].startswith("file:///o/new_bsp_view.html#embed"))
        self.assertIsNone(app._open_after)


class Compile(unittest.TestCase):
    """The compiler: this system's ommap build compiles New map's room, and a room with its
    floor taken away leaks, with the trail read back."""
    class _Vfs:
        def __init__(self, files): self.files = files
        def names(self): return self.files.keys()
        def exists(self, n): return n in self.files
        def read(self, n): return self.files.get(n)

    def setUp(self):
        import mohaa_compile as MCO
        self.MCO = MCO
        if not MCO.ommap_path():
            self.skipTest("no ommap build for " + MCO.platform_dir())

    def _compile(self, d, text, name="room", extra=None):
        src = os.path.join(d, name + ".map")
        with open(src, "w", newline="\n") as f: f.write(text)
        files = {"scripts/common.shader": b"textures/common/caulk\n{\n\tsurfaceparm nodraw\n}\n",
                 "scripts/../evil.shader": b"x", "models/x.tik": b"x"}
        files.update(extra or {})
        vfs = self._Vfs(files)
        work = os.path.join(d, "ws"); os.makedirs(work)
        return src, self.MCO.compile_map(src, vfs, work, ("bsp",), log=lambda line: None), work

    def test_room(self):
        with tempfile.TemporaryDirectory() as d:
            src, res, work = self._compile(d, E.starter_map("room"))
            self.assertTrue(res["ok"], res.get("why"))
            self.assertIsNone(res["leak"])
            with open(res["bsp"], "rb") as f: b = MB.Bsp(f.read())
            self.assertGreater(len(b.surfaces), 0)
            # only the shader scripts went into the compiler's folder, and none outside it
            self.assertEqual(sorted(os.listdir(os.path.join(work, "ommap_game", "main", "scripts"))), ["common.shader"])

    def test_caulk_not_drawn(self):
        """The room's outer faces are caulk: their sides keep caulk's no-draw flag, but no
        drawn surface uses a shader record carrying it."""
        import struct
        with tempfile.TemporaryDirectory() as d:
            src, res, work = self._compile(d, E.starter_map("room"))
            self.assertTrue(res["ok"], res.get("why"))
            with open(res["bsp"], "rb") as f: data = f.read()
            lump = lambda n: struct.unpack_from("<ii", data, 12 + 8 * n)
            so, sl = lump(0)
            flags = [struct.unpack_from("<i", data, so + i * 140 + 64)[0] for i in range(sl // 140)]
            so, sl = lump(3)
            drawn = {struct.unpack_from("<i", data, so + i * 108)[0] for i in range(sl // 108)}
            so, sl = lump(11)
            sides = {struct.unpack_from("<i", data, so + i * 12 + 4)[0] for i in range(sl // 12)}
            self.assertTrue(drawn)
            self.assertFalse([i for i in drawn if flags[i] & 0x80])
            self.assertTrue([i for i in sides if flags[i] & 0x80])

    def test_room_light(self):
        """bsp then light: lightmaps and the light grid in the game's form."""
        import struct
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "lit.map")
            with open(src, "w", newline="\n") as f: f.write(E.starter_map("lit"))
            work = os.path.join(d, "ws"); os.makedirs(work)
            res = self.MCO.compile_map(src, self._Vfs({}), work, ("bsp", "light"), log=lambda line: None)
            self.assertTrue(res["ok"], res.get("why"))
            with open(res["bsp"], "rb") as f: data = f.read()
            lump = lambda n: struct.unpack_from("<ii", data, 12 + 8 * n)
            self.assertGreater(lump(2)[1], 0)                 # lightmaps
            # texels stored to 127 at most, as the game's are (the ceiling over the light
            # is brighter than that)
            lo, ll = lump(2)
            self.assertEqual(max(data[lo:lo + ll]), 127)
            self.assertEqual(lump(16)[1], 768)                # the grid's palette
            off, ln = lump(17); doff, dln = lump(18)
            self.assertGreater(ln, 0); self.assertGreater(dln, 0)
            self.assertTrue(any(data[doff:doff + dln]))       # some light somewhere
            # the room's light as a light for models, listed by the leaves it reaches
            so, sl = lump(19)
            self.assertEqual(sl, 56)
            self.assertEqual(struct.unpack_from("<f", data, so + 24)[0], 400.0)
            vo, vl = lump(20)
            vis = struct.unpack_from("<%di" % (vl // 4), data, vo)
            self.assertEqual(vis.count(-1), lump(8)[1] // 64)  # one list per leaf
            self.assertIn(0, vis)
            # no static models: no vertex light
            self.assertEqual(lump(24)[1], 0)

    def test_entities_only(self):
        """-onlyents (MBuilder's Entities only): the entities of the .bsp compiled before are
        replaced, every other lump kept; vis skipped; no .bsp before: refused."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "ents.map")
            with open(src, "w", newline="\n") as f: f.write(E.starter_map("ents"))
            work = os.path.join(d, "ws"); os.makedirs(work)
            res = self.MCO.compile_map(src, self._Vfs({}), work, ("bsp", "vis"), log=lambda line: None,
                                       options={"bsp": ["-onlyents"]})
            self.assertFalse(res["ok"]); self.assertIn("Entities only", res["why"])
            res = self.MCO.compile_map(src, self._Vfs({}), work, ("bsp",), log=lambda line: None)
            self.assertTrue(res["ok"], res.get("why"))
            with open(res["bsp"], "rb") as f: before = self.MCO._bsp_lumps(f.read())
            with open(src) as f: text = f.read()
            with open(src, "w", newline="\n") as f:
                f.write(text.replace('"classname" "worldspawn"', '"classname" "worldspawn"\n"message" "only ents"', 1))
            logged = []
            res = self.MCO.compile_map(src, self._Vfs({}), work, ("bsp", "vis"), log=logged.append,
                                       options={"bsp": ["-onlyents"]})
            self.assertTrue(res["ok"], res.get("why"))
            self.assertEqual(res["steps"], ["bsp"])
            self.assertTrue(any("entities only keeps" in l for l in logged), logged[-5:])
            with open(res["bsp"], "rb") as f: after = self.MCO._bsp_lumps(f.read())
            self.assertIn(b'"only ents"', after[14])
            self.assertEqual([i for i in range(28) if before[i] != after[i]], [14])

    def test_static_model_light(self):
        """A static model under the room's light, lit as the game lights a model: the
        vertex facing the light takes it, the ones facing away only the light on the whole
        model (here the grid's at its centre, the room having no ambient light), all alike."""
        import struct
        from unittest import mock
        c = (0.0, 0.0, 64.0)
        dirs = [(0, 0, 1), (0, 0, -1), (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)]
        smv = b"SMV1" + struct.pack("<ii", 1, len(dirs)) + b"".join(
            struct.pack("<6f", c[0] + 8 * x, c[1] + 8 * y, c[2] + 8 * z, x, y, z) for x, y, z in dirs)
        text = E.starter_map("lit") + ('{\n"classname" "static_box"\n"model" "static/box.tik"\n'
                                       '"origin" "0 0 64"\n}\n')
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "lit.map")
            with open(src, "w", newline="\n") as f: f.write(text)
            work = os.path.join(d, "ws"); os.makedirs(work)
            with mock.patch.object(self.MCO, "static_model_vertices", lambda vfs, data, log=None: (smv, 0)):
                res = self.MCO.compile_map(src, self._Vfs({}), work, ("bsp", "light"), log=lambda line: None)
            self.assertTrue(res["ok"], res.get("why"))
            with open(res["bsp"], "rb") as f: data = f.read()
            lump = lambda n: struct.unpack_from("<ii", data, 12 + 8 * n)
            vo, vl = lump(24)
            self.assertEqual(vl, 3 * len(dirs))
            v = [sum(data[vo + 3 * i:vo + 3 * i + 3]) for i in range(len(dirs))]
            up, away = v[0], v[1:]
            self.assertEqual(len(set(away)), 1, v)
            self.assertGreater(away[0], 0)
            self.assertGreater(up, away[0] + 30)

    def test_terrain_flags(self):
        """A terrain patch on the room's floor: nodraw and invisible triangles are holes,
        only nodraw and maxdetail ones force the land round them to split (0x8000)."""
        import struct
        rows = []
        for j in range(9):
            for i in range(9):
                a = b = ""
                if (i, j) == (1, 1): a = b = "nodraw"
                if (i, j) == (6, 6): a = "invisible"
                if (i, j) == (3, 6): a = "maxdetail"
                rows.append("   0.000000 ( %s ) ( %s )" % (a, b))
        ter = "\n".join(["// terrain", "{", " terrainDef", " {", "  9 9 0", "  -256 -256 16", "  {",
                         "   0 0 ( textures/common/caulk 0 0 0.00 256 1 1 0 0 0 )", "  }", "  {"]
                        + rows + ["  }", " }", "}"])
        text = E.starter_map("ter").replace("\n}\n// entity 1", "\n" + ter + "\n}\n// entity 1", 1)
        with tempfile.TemporaryDirectory() as d:
            src, res, work = self._compile(d, text, "ter")
            self.assertTrue(res["ok"], res.get("why"))
            with open(res["bsp"], "rb") as f: data = f.read()
            to, tl = struct.unpack_from("<ii", data, 12 + 8 * 22)
            self.assertEqual(tl, 388)                          # the one patch
            var = struct.unpack_from("<126H", data, to + 52)
            deep = [v for t in range(2) for v in var[t * 63 + 31:t * 63 + 63]]
            holes = sum(bool(v & 0x2000) + bool(v & 0x1000) for v in deep)
            self.assertEqual(holes, 3)                         # 2 nodraw, 1 invisible
            self.assertTrue(any(v & 0x8000 for v in var))
            self.assertFalse(any(v & 0x4000 for v in var))

    def test_terrain_texcoords(self):
        """A terrain patch's texture turns and shifts as a floor brush face's does (EA's
        compiler; m4l0's and m3l1b's terrain match the game's .bsp so), and a right-angle
        turn is exact: a corner at -1e-8 sent a clamped texture past its edge in the game."""
        import struct
        rows = ["   0.000000 ( ) ( )"] * 81
        def tc(texline):
            ter = "\n".join(["// terrain", "{", " terrainDef", " {", "  9 9 0", "  -256 -256 16", "  {",
                             "   0 0 ( " + texline + " )", "  }", "  {"] + rows + ["  }", " }", "}"])
            text = E.starter_map("ter").replace("\n}\n// entity 1", "\n" + ter + "\n}\n// entity 1", 1)
            with tempfile.TemporaryDirectory() as d:
                _src, res, _work = self._compile(d, text, "ter")
                self.assertTrue(res["ok"], res.get("why"))
                with open(res["bsp"], "rb") as f: data = f.read()
            to, _tl = struct.unpack_from("<ii", data, 12 + 8 * 22)
            v = struct.unpack_from("<8f", data, to + 4)
            return [(v[0], v[1]), (v[2], v[3]), (v[4], v[5]), (v[6], v[7])]    # [0][0] [0][1] [1][0] [1][1]
        self.assertEqual(tc("common/caulk 0 0 270 512 1 1 0 0 0"), [(0, 0), (-1, 0), (0, -1), (-1, -1)])
        self.assertEqual(tc("common/caulk 0 0 90 512 1 1 0 0 0"), [(0, 0), (1, 0), (0, 1), (1, 1)])
        self.assertEqual(tc("common/caulk 0 256 0 512 1 1 0 0 0"), [(0, .5), (0, -.5), (1, .5), (1, -.5)])

    def test_fence(self):
        """A gate (a fence face, nodraw round it): its brush is a fence to the game, its
        face carries the texture equation the game finds a shot's texel by (in repeats of
        its 64 by 128 image), nodraw is passed through ("ignore"); and the floor's .jpg
        texture is laid out by the .jpg's own size."""
        import struct
        def box(a, b, tex):
            (x0, y0, z0), (x1, y1, z1) = a, b
            pts = [((x0, y0, z0), (x0, y1, z0), (x0, y0, z1)), ((x1, y0, z1), (x1, y1, z0), (x1, y0, z0)),
                   ((x0, y0, z1), (x1, y0, z0), (x0, y0, z0)), ((x0, y1, z0), (x1, y1, z0), (x0, y1, z1)),
                   ((x0, y0, z0), (x1, y0, z0), (x0, y1, z0)), ((x0, y1, z1), (x1, y0, z1), (x0, y0, z1))]
            return "{\n" + "".join("( %d %d %d ) ( %d %d %d ) ( %d %d %d ) %s 0 0 0 1 1 0 0 0\n"
                                   % (p[0] + p[1] + p[2] + (t,)) for p, t in zip(pts, tex)) + "}\n"
        gate = box((-8, -64, 0), (8, 64, 128), ["common/nodraw", "mohcommon/irongate1"] + ["common/nodraw"] * 4)
        text = E.starter_map("gate").replace("\n}\n// entity 1", "\n" + gate + "}\n// entity 1", 1)
        text = text.replace("general_structure/jh_conc512b 0 0 0 0.5 0.5", "general_structure/jh_conc512b 40 0 0 0.5 0.5")
        tga = struct.pack("<BBBHHBHHHHBB", 0, 0, 2, 0, 0, 0, 0, 0, 64, 128, 32, 8) + b"\xff" * (64 * 128 * 4)
        jpg = b"\xff\xd8\xff\xe0\x00\x04\x00\x00\xff\xc0\x00\x11\x08\x02\x00\x02\x00\x03" + b"\x00" * 9 + b"\xff\xd9"
        extra = {"scripts/common.shader": b"textures/common/caulk\n{\n\tsurfaceparm nodraw\n}\n"
                 b"textures/common/nodraw\n{\n\tqer_editorimage textures/common/nodraw.tga\n"
                 b"\tsurfaceparm nodraw\n\tsurfaceparm nonsolid\n\tsurfaceparm trans\n}\n",
                 "scripts/mohcommon.shader": b"textures/mohcommon/irongate1\n{\n\tqer_editorimage "
                 b"textures/mohcommon/irongate_1.tga\n\tsurfaceparm fence\n\tsurfaceparm alphashadow\n"
                 b"\tsurfaceparm playerclip\n\tsurfaceparm nonsolid\n\tcull none\n\t{\n\t\tmap "
                 b"textures/mohcommon/irongate_1.tga\n\t\talphaFunc GE128\n\t}\n}\n",
                 "textures/mohcommon/irongate_1.tga": tga,
                 "textures/general_structure/jh_conc512b.jpg": jpg}
        with tempfile.TemporaryDirectory() as d:
            src, res, work = self._compile(d, text, "gate", extra)
            self.assertTrue(res["ok"], res.get("why"))
            with open(res["bsp"], "rb") as f: data = f.read()
            L = [struct.unpack_from("<ii", data, 12 + i * 8) for i in range(28)]
            o, l = L[0]
            sh = [(data[o + i * 140:o + i * 140 + 64].split(b"\0")[0].decode(),
                   struct.unpack_from("<i", data, o + i * 140 + 68)[0],
                   data[o + i * 140 + 76:o + i * 140 + 140].split(b"\0")[0].decode()) for i in range(l // 140)]
            o, l = L[10]; eqs = [struct.unpack_from("<8f", data, o + i * 32) for i in range(l // 32)]
            o, l = L[11]; sides = [struct.unpack_from("<3i", data, o + i * 12) for i in range(l // 12)]
            o, l = L[12]; brushes = [struct.unpack_from("<3i", data, o + i * 12) for i in range(l // 12)]
            fences = [b for b in brushes if sh[b[2]][1] & 0x2000]
            self.assertEqual(len(fences), 1)                   # the gate, and only it
            fs, ns, _ = fences[0]
            gate_sides = [sides[k] for k in range(fs, fs + ns) if sh[sides[k][1]][0] == "textures/mohcommon/irongate1"]
            self.assertEqual(len(gate_sides), 1)
            self.assertEqual(sh[gate_sides[0][1]][2], "textures/mohcommon/irongate_1.tga")
            e = eqs[gate_sides[0][2]]
            for got, want in zip(e, (0, 1 / 64, 0, 0, 0, 0, -1 / 128, 0)):   # +X face: s along y, t down z
                self.assertAlmostEqual(got, want, places=6)
            self.assertFalse(any(e0 for e0 in eqs[0]))           # equation 0 is the empty one
            for k in range(fs, fs + ns):
                if sh[sides[k][1]][0] == "textures/common/nodraw":
                    self.assertEqual((sh[sides[k][1]][2], sides[k][2]), ("ignore", 0))
            # the floor: 0.5 scale and a 40 shift on a 512-wide .jpg, so its edges (x +-256)
            # are s (+-512 + 40) / 512, .078125 past a whole repeat (ommap shifts coordinates
            # by whole repeats); 64 wide, as when the image went unread, gives .625
            vo, vl = L[4]; so, sl = L[3]
            floor_s = set()
            for i in range(sl // 108):
                t = struct.unpack_from("<12i", data, so + i * 108)
                if sh[t[0]][0] != "textures/general_structure/jh_conc512b":
                    continue
                for k in range(t[4]):
                    p = struct.unpack_from("<5f", data, vo + (t[3] + k) * 44)
                    if abs(abs(p[0]) - 256) < 0.1:
                        floor_s.add(round(p[3] % 1, 6))
            self.assertEqual(floor_s, {0.078125})

    def test_static_model_axis(self):
        """The static models' turn (AngleVectorsLeft): yaw 90 points forward along +y, left
        along -x."""
        fwd, left, up = self.MCO._axis((0.0, 90.0, 0.0))
        for got, want in ((fwd, (0, 1, 0)), (left, (-1, 0, 0)), (up, (0, 0, 1))):
            self.assertTrue(all(abs(a - b) < 1e-6 for a, b in zip(got, want)), (got, want))

    def test_alpha_shadow_images(self):
        """Only the map's alphashadow shaders' .tga images go into the game folder, by the
        lightimage, then the editor image; anything else in the scripts is left alone."""
        class Paks:
            files = {"textures/a/fence.tga": b"T1", "textures/a/edit.tga": b"T2",
                     "textures/a/solid.tga": b"T3"}
            def exists(self, p): return p in self.files
            def read(self, p): return self.files.get(p)
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "scripts"))
            with open(os.path.join(d, "scripts", "a.shader"), "w") as f:
                f.write("// x\ntextures/a/fence\n{\n surfaceparm alphashadow\n q3map_lightimage "
                        "textures/a/fence.tga\n qer_editorimage textures/a/edit.tga\n { map x }\n}\n"
                        "textures/a/solid\n{\n qer_editorimage textures/a/solid.tga\n}\n"
                        "textures/a/unused\n{\n surfaceparm alphashadow\n}\n"
                        "textures/a/bad\n{\n surfaceparm alphashadow\n qer_editorimage ../x.tga\n}\n")
            used = {"textures/a/fence", "textures/a/solid", "textures/a/bad"}
            n = self.MCO.alpha_shadow_images(Paks(), d, used, log=lambda line: None)
            self.assertEqual(n, 1)
            with open(os.path.join(d, "textures", "a", "fence.tga"), "rb") as f:
                self.assertEqual(f.read(), b"T1")
            self.assertFalse(os.path.exists(os.path.join(d, "textures", "a", "solid.tga")))
            self.assertFalse(os.path.exists(os.path.join(os.path.dirname(d), "x.tga")))

    def test_leak(self):
        t = E.starter_map("leaky")
        i = t.index("{", t.index("{") + 1); j = t.index("}", i) + 1
        with tempfile.TemporaryDirectory() as d:
            src, res, _w = self._compile(d, t[:i] + t[j:], "leaky")
            self.assertTrue(res["ok"], res.get("why"))
            self.assertTrue(res["leak"] and all(len(p) == 3 for p in res["leak"]))
            self.assertTrue(os.path.isfile(os.path.join(d, "leaky.lin")))

    def test_bad_name(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                self.MCO.prepare(self._Vfs({}), d, os.path.join(d, "a b.map"))


class CompileFlow(unittest.TestCase):
    """Compile from a .bsp's page: the page's text is written beside the .bsp picked as
    <name>.map and compiled there; the page is told its changes are in it; a .map not
    written by Compile is only replaced when the user says so."""
    def setUp(self):
        import mohaa_compile as MCO
        self.MCO = MCO
        if not MCO.ommap_path():
            self.skipTest("no ommap build for " + MCO.platform_dir())

    def _wait(self, app):
        import time
        for _ in range(600):
            if app._page_requests: break
            time.sleep(0.05)
        app._page_requests.pop(0)()

    def test_from_a_bsp_page(self):
        import queue
        real_save = E.filedialog.asksaveasfilename
        try:
            with tempfile.TemporaryDirectory() as d:
                src = os.path.join(d, "opened", "m3l1b.bsp"); os.makedirs(os.path.dirname(src))
                open(src, "wb").close()
                out = os.path.join(d, "game", "maps"); os.makedirs(out)
                app = E.EditApp.__new__(E.EditApp)
                app.tk = None                   # no window: Tk's attribute lookup stops here
                app._compiling, app._pk3_paths = False, []
                logged, js, answers = [], [], []
                app._last_build = (src, None, None, None, "")
                app._tmp = os.path.join(d, "ws"); os.makedirs(app._tmp)
                app._vfs, app._tex_ready = Compile._Vfs({"scripts/common.shader": b"textures/common/caulk\n{\n}\n"}), True
                app._cfg = {}
                app._log_q, app._page_requests, app._webview = queue.Queue(), [], None
                app._log_line = lambda m, tag="": logged.append(m)
                app._save_config = lambda: None
                app._page_js = js.append
                app._unsaved_dialog = lambda title, head, body, buttons: answers.pop(0) if answers else "cancel"
                app._tip = lambda *a: None
                chosen = []
                app._compile_dialog = lambda what, game, world=None: (chosen.append(what), dict(steps="bsp", where="ask", manvis=True,
                                                                                    bsp_v=True, light_extra=True))[1]
                E.filedialog.asksaveasfilename = lambda **k: os.path.join(out, "m3l1b.bsp")
                body = json.dumps({"changed": True, "unsaved": 2, "edN": 3, "modKey": "k", "isBsp": True,
                                   "mapText": E.starter_map("m3l1b")})
                # an m3l1b.map already there that Compile didn't write: asked, and Cancel keeps it
                with open(os.path.join(out, "m3l1b.map"), "w") as f: f.write("mine")
                answers[:] = ["cancel"]
                app._edit_compile(body)
                with open(os.path.join(out, "m3l1b.map")) as f: self.assertEqual(f.read(), "mine")
                self.assertFalse(app._compiling)
                answers[:] = ["yes", "stay"]
                app._edit_compile(body)
                self._wait(app)
                self.assertTrue(os.path.isfile(os.path.join(out, "m3l1b.bsp")), logged)
                with open(os.path.join(out, "m3l1b.map.bak")) as f: self.assertEqual(f.read(), "mine")
                with open(os.path.join(out, "m3l1b.map")) as f: self.assertIn("worldspawn", f.read())
                self.assertTrue(any("edCompiledSaved(3" in j for j in js), js)
                self.assertEqual(app._compile_switches(app._cfg.get("compile_opts") or {"steps": "bsp", "bsp_v": True,
                                 "light_extra": True, "manvis": True, "viscap": False}),
                                 {"bsp": ["-v"], "vis": [], "light": ["-extra", "-sunscale", "0.82"]})
                self.assertIn("as you see it here", chosen[0])
                # the .map it wrote is replaced next time without asking
                answers[:] = ["stay"]
                app._edit_compile(body)
                self._wait(app)
                self.assertEqual(answers, [])
                # a .bsp page that sent no text can't be compiled
                app._edit_compile(json.dumps({"changed": False}))
                self.assertIn("didn't send the map's text", logged[-1])
                # the opened .bsp moved away after a compile: the page's text still compiles
                os.remove(src)
                answers[:] = ["stay"]
                app._edit_compile(body)
                self.assertTrue(app._compiling, logged)
                self.assertTrue(any("isn't there any more" in m for m in logged), logged)
                self._wait(app)
                self.assertTrue(any("Compile: wrote" in m for m in logged[-3:]), logged)
                app._edit_compile(json.dumps({"changed": False}))
                self.assertIn("open the map again", logged[-1])
                # the launcher forgot the map but the page says which it is
                app._last_build = None
                answers[:] = ["stay"]
                app._edit_compile(json.dumps(dict(json.loads(body), src=os.path.join(out, "m3l1b.map"))))
                self._wait(app)
                self.assertTrue(any("Compile: wrote" in m for m in logged[-3:]), logged)
                app._edit_compile(None)
                self.assertEqual(logged[-1], "Compile: open a map first.")
        finally:
            E.filedialog.asksaveasfilename = real_save

    def test_map_only_with_world_keys(self):
        """"map file only": the .map is written with the MAP box's worldspawn keys (its brushes
        kept), nothing compiled; the MAP box is given the map's own keys."""
        import queue
        real_save = E.filedialog.asksaveasfilename
        try:
            with tempfile.TemporaryDirectory() as d:
                src = os.path.join(d, "m.map")
                with open(src, "w", newline="") as f: f.write(E.starter_map("m"))
                app = E.EditApp.__new__(E.EditApp)
                app.tk = None
                app._compiling, app._pk3_paths = False, []
                logged, js, got = [], [], []
                app._last_build = (src, None, None, None, "")
                app._tmp = os.path.join(d, "ws"); os.makedirs(app._tmp)
                app._vfs, app._tex_ready = Compile._Vfs({}), True
                app._cfg = {}
                app._log_q, app._page_requests, app._webview = queue.Queue(), [], None
                app._log_line = lambda m, tag="": logged.append(m)
                app._save_config = lambda: None
                app._page_js = js.append
                app._unsaved_dialog = lambda *a: "yes"
                def dlg(what, game, world=None):
                    got.append(world)
                    kv = [kv for kv in world if kv[0] != "sundiffuse"] + [("sundiffuse", "1")]
                    return dict(steps="map", where="ask", world=kv)
                app._compile_dialog = dlg
                out = os.path.join(d, "out.map")
                E.filedialog.asksaveasfilename = lambda **k: out
                app._edit_compile(json.dumps({"changed": False}))
                self.assertEqual(app._page_requests, [])            # nothing compiled
                self.assertIn(("classname", "worldspawn"), got[0])
                with open(out) as f: t = f.read()
                self.assertEqual(self.MCO.worldspawn_keys(t)[-1], ("sundiffuse", "1"))
                with open(src) as f: t0 = f.read()
                self.assertEqual(t.count("{"), t0.count("{"))           # every brush kept
                self.assertTrue(any("wrote" in m and "nothing compiled" in m for m in logged), logged)
        finally:
            E.filedialog.asksaveasfilename = real_save

    def test_world_keys(self):
        t = '// x\r\n{\r\n"classname" "worldspawn"\r\n"sundiffuse" "3"\r\n// brush 0\r\n{\r\n( 0 0 0 ) a\r\n}\r\n}\r\n'
        self.assertEqual(self.MCO.worldspawn_keys(t), [("classname", "worldspawn"), ("sundiffuse", "3")])
        t2 = self.MCO.set_worldspawn_keys(t, [("classname", "worldspawn"), ("farplane", "2000")])
        self.assertEqual(self.MCO.worldspawn_keys(t2), [("classname", "worldspawn"), ("farplane", "2000")])
        self.assertIn('"farplane" "2000"\r\n// brush 0\r\n{', t2)
        with self.assertRaises(ValueError):
            self.MCO.set_worldspawn_keys(t, [("farplane", "1")])
        self.assertEqual(self.MCO.parse_key_lines('"a" "1"\n\n// c\n"b" ""'), [("a", "1"), ("b", "")])
        for bad in ('"a" 1', '"a" "x{"', '"" "1"'):
            with self.assertRaises(ValueError):
                self.MCO.parse_key_lines(bad)

class AsEaBuildsIt(unittest.TestCase):
    """What the compile does to the map first, as EA's Q3map does: worldspawn's map_time set
    to the compile's time, and each static prop given its model's collision brushes, turned,
    scaled and moved with it (the planes checked against Q3map.exe's own output)."""
    MASK = (b'{\r\n"classname" "worldspawn"\r\n// brush 0\r\n{\r\n'
            b"( 4 10 0 ) ( -3 10 0 ) ( -3 -9 0 ) common/metalclip 0 0 0.00 1 1 327680 32928 0 +surfaceparm detail \r\n"
            b"( -3 -9 13 ) ( -3 10 13 ) ( 4 10 13 ) common/metalclip 0 0 0.00 1 1 327680 32928 0 +surfaceparm detail \r\n"
            b"( -3 -9 16 ) ( 4 -9 16 ) ( 4 -9 0 ) common/metalclip 0 0 0.00 1 1 327680 32928 0 +surfaceparm detail \r\n"
            b"( 4 -9 16 ) ( 4 10 16 ) ( 4 10 0 ) common/metalclip 0 0 0.00 1 1 327680 32928 0 +surfaceparm detail \r\n"
            b"( 4 10 16 ) ( -3 10 16 ) ( -3 10 0 ) common/metalclip 0 0 0.00 1 1 327680 32928 0 +surfaceparm detail \r\n"
            b"( -3 10 16 ) ( -3 -9 16 ) ( -3 -9 0 ) common/metalclip 0 0 0.00 1 1 327680 32928 0 +surfaceparm detail \r\n}\r\n}\r\n")

    def setUp(self):
        import mohaa_compile as MCO
        self.MCO = MCO

    def _planes(self, text):
        out = []
        for ln in text.splitlines():
            m = E._FACE_RE.match(ln.strip())
            if m:
                v = [float(x) for x in m.groups()[:9]]
                n, d = MB.plane_from_points(v[0:3], v[3:6], v[6:9])
                out.append(tuple(round(c, 2) for c in n) + (round(d, 2),))
        return out

    def test_stamp_and_collision(self):
        room = E.starter_map("r")
        props = ('\n{\n"classname" "static_item_crate"\n"model" "static//30cal_crate.tik"\n"origin" "100 50 0"\n'
                 '"angles" "10 30 20"\n"scale" "2"\n}\n{\n"classname" "static_none"\n"model" "static/nothing.tik"\n}\n')
        vfs = Compile._Vfs({"models/static/30cal_crate.map": self.MASK})
        lines = []
        out = self.MCO.ea_prepare(room + props, vfs, lines.append, now=0)
        world = out[:out.index("}\n", out.index("collision of"))]
        self.assertRegex(out.splitlines()[3] + out, r'"map_time" "\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d 19\d\d"')
        self.assertIn("1 given their collision brushes from the paks, 1 without any", lines[-1])
        got = sorted(self._planes(world[world.index("collision of"):]))
        # Q3map.exe's planes for this crate placed so (its brush's six sides)
        want = sorted([(-0.85, -0.49, 0.17, -103.91), (0.85, 0.49, -0.17, 117.91), (0.42, -0.84, -0.34, 17.67),
                       (-0.42, 0.84, 0.34, 20.33), (-0.31, 0.21, -0.93, -20.5), (0.31, -0.21, 0.93, 46.5)])
        self.assertEqual(len(got), 6)
        for g, w in zip(got, want):
            for a, b in zip(g, w):
                self.assertAlmostEqual(a, b, delta=0.02)
        # an existing map_time is replaced, not doubled
        again = self.MCO.ea_prepare(out, vfs, lambda l: None, now=86400 * 400)
        self.assertEqual(again.count('"map_time"'), 1)
        ok, why, _c = E.check_map_text(out)
        self.assertTrue(ok, why)


class CompileOptions(unittest.TestCase):
    """The switches Compile passes on, and a decompiled map's vis groups put back from its
    original .bsp."""
    def setUp(self):
        import mohaa_compile as MCO
        self.MCO = MCO

    def test_switches_checked(self):
        ok = self.MCO.check_options
        self.assertEqual(ok(["-v", "-samplesize", "32", "", "-passageOnly"])[0], ["-v", "-samplesize", "32", "-passageOnly"])
        for bad in (["-gamedir"], ["C:/x"], ["-v;rm"], ["../x"], ["-tmpout"]):
            self.assertIsNone(ok(bad)[0], bad)
        app = E.EditApp.__new__(E.EditApp)
        app.tk = None
        sw = app._compile_switches({"bsp_nocurves": True, "vis_passage": True, "manvis": False,
                                    "light_extra": True, "vis_more": "-level 3"})
        self.assertEqual(sw, {"bsp": ["-nocurves", "-nomanvis"], "vis": ["-passageOnly", "-nomanvis", "-cap",
                                                                       str(E.EditApp.VIS_CAP), "-level", "3"],
                              "light": ["-extra", "-sunscale", "0.82"]})
        # the sun scale: 0.82 by default, as typed, none at 1, the default for a bad one
        sun = lambda v: app._compile_switches({"sunscale": v, "viscap": False})["light"]
        self.assertEqual(sun("1"), [])
        self.assertEqual(sun("0,9"), ["-sunscale", "0.9"])
        self.assertEqual(sun("x"), ["-sunscale", "0.82"])
        self.assertEqual(app._compile_switches({"sunscale": "0.5", "light_sunon": False, "viscap": False})["light"], [])
        # the vis work cap: on by default, its number as typed, the default for a bad one, off when unticked
        cap = lambda o: app._compile_switches(o)["vis"]
        self.assertEqual(cap({"viscap_n": "250,000"}), ["-cap", "250000"])
        self.assertEqual(cap({"viscap_n": "lots"}), ["-cap", str(E.EditApp.VIS_CAP)])
        self.assertEqual(cap({"viscap": False, "viscap_n": "5"}), [])
        self.assertEqual(app._compile_switches({"bsp_nohint": True})["bsp"], ["-nohint"])

    def _bsp(self, vis_brush, clusters, rows):
        """A tiny .bsp: one world vis brush per entry of vis_brush (its planes), leafs in the
        given clusters listing those brushes, and the vis rows."""
        import struct
        lumps = [b""] * 28
        lumps[0] = (b"textures/common/vis".ljust(64, b"\0") + struct.pack("<ii", 0, 0)).ljust(140, b"\0")
        planes, sides, brushes = [], [], []
        for pl in vis_brush:
            brushes.append(struct.pack("<iii", len(sides), len(pl), 0))
            for n in pl:
                sides.append(struct.pack("<iii", len(planes), 0, 0)); planes.append(struct.pack("<4f", *n))
        lumps[1] = b"".join(planes); lumps[11] = b"".join(sides); lumps[12] = b"".join(brushes)
        lumps[13] = struct.pack("<6f4i", 0, 0, 0, 0, 0, 0, 0, 0, 0, len(brushes))
        leafs, lb = [], []
        for c, b in clusters:
            leafs.append(struct.pack("<16i", c, 0, 0, 0, 0, 0, 0, 0, 0, 0, len(lb), 1, 0, 0, 0, 0)); lb.append(b)
        lumps[8] = b"".join(leafs); lumps[6] = struct.pack("<%di" % len(lb), *lb)
        ncl = len(rows)
        lumps[15] = struct.pack("<ii", ncl, 1) + bytes(rows)
        head = b"2015" + struct.pack("<ii", 19, 0)
        off = 12 + 8 * 28
        table, data = b"", b""
        for l in lumps:
            table += struct.pack("<ii", off + len(data), len(l)); data += l
        return head + table + data

    def test_restore_leafgroups(self):
        box = lambda x0, x1: [(-1, 0, 0, -x0), (1, 0, 0, x1), (0, -1, 0, 0), (0, 1, 0, 64), (0, 0, -1, 0), (0, 0, 1, 64)]
        # clusters 0 and 1 in brush 0, 2 in brush 1; 0 and 1 see each other, nothing sees 2,
        # and 2 sees 0: so group 0 blocks group 1, and group 1 doesn't block group 0
        data = self._bsp([box(0, 64), box(128, 192)], [(0, 0), (1, 0), (2, 1)], [0b011, 0b011, 0b101])
        groups, blocks = self.MCO.bsp_leafgroups(data)
        self.assertEqual([g[1] for g in groups], [{0, 1}, {2}])
        self.assertEqual(blocks, [(0, 1)])
        face = lambda a, b, c: "( %s ) ( %s ) ( %s ) common/vis 0 0 0 0.5 0.5 268435456 1073809808 0" % (a, b, c)
        def brush(x0, x1):
            return "\n".join([face("%d 0 0" % x0, "%d 64 0" % x0, "%d 0 64" % x0), face("%d 0 64" % x1, "%d 64 0" % x1, "%d 0 0" % x1),
                              face("%d 0 64" % x0, "%d 0 0" % x1, "%d 0 0" % x0), face("%d 64 0" % x0, "%d 64 0" % x1, "%d 64 64" % x0),
                              face("%d 0 0" % x0, "%d 0 0" % x1, "%d 64 0" % x0), face("%d 64 64" % x0, "%d 0 64" % x1, "%d 0 64" % x0)])
        text = ('// MOHAA map source rebuilt from t.bsp (.bsp version 19)\n{\n"classname" "worldspawn"\n'
                "// brush 0\n{\n" + brush(0, 64) + "\n}\n// brush 1\n{\n" + brush(128, 192) + "\n}\n}\n")
        self.assertEqual(self.MCO.decompiled_from(text), "t.bsp")
        out = self.MCO.restore_leafgroups(text, data, lambda l: None)
        self.assertEqual(out.count('"classname" "vis_leafgroup"'), 2)
        self.assertIn('"targetname" "mv1"\n"target" "mv2"', out)
        self.assertNotIn("common/vis", out[:out.index("vis_leafgroup")])
        ok, why, _c = E.check_map_text(out)
        self.assertTrue(ok, why)
        self.assertEqual(self.MCO.restore_leafgroups(out, data, lambda l: None), out)   # once only

    def test_long_leafgroup_target_is_split(self):
        # a group can block hundreds of others; the compiler's map reader takes 1023
        # characters a value, so the names go over target, target2, target3...
        names = ["mv%d" % i for i in range(1, 400)]
        keys = self.MCO._target_keys(names)
        vals = re.findall(r'"(target\d*)" "([^"]*)"', keys)
        self.assertEqual([k for k, _v in vals][:3], ["target", "target2", "target3"])
        self.assertTrue(all(len(v) <= 1000 for _k, v in vals))
        self.assertEqual(" ".join(v for _k, v in vals).split(), names)
        self.assertEqual(self.MCO._target_keys(["mv2"]), '"target" "mv2"\n')
        self.assertEqual(self.MCO._target_keys([]), "")


if __name__ == "__main__":
    unittest.main()
