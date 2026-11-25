#!/usr/bin/env python3
"""Regression tests for the 1.0.001 hardening pass (stdlib unittest; no pytest needed).

Run from the project folder:   python tests/test_hardening.py
Needs tkinter (the launcher modules import it). Pillow is used if bin/libs* has it.

What is real and what is simulated:
  * file writes, zips, settings files, .bsp files and child processes are all REAL
    (temp folders, the real code paths);
  * three failures are SIMULATED, because they can't be caused on demand: a crash in the
    middle of a write (os.replace / a read raising), a file that can't be written during
    an update, and the network (the updater's download is served from a local zip by
    replacing mohaa_common.http_get). Each such test says so in its docstring."""
import io
import json
import logging
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")
sys.path.insert(0, BIN)
for _l in ("libs", "libs-linux", "libs-mac"):
    if os.path.isdir(os.path.join(BIN, _l)):
        sys.path.insert(0, os.path.join(BIN, _l))

import mohaa_common as MC          # noqa: E402
import mohaa_bsp as MB             # noqa: E402


def bsp_seed(ver=19):
    """A tiny but valid .bsp: one 6-sided brush in worldspawn plus one path node."""
    lumps = [b""] * 29
    lumps[0] = b"common/caulk".ljust(64, b"\0") + struct.pack("<3i", 0, 1, 0) + b"\0" * 64
    lumps[1] = b"".join(struct.pack("<4f", *p) for p in
                        ((1, 0, 0, 64), (-1, 0, 0, 64), (0, 1, 0, 64), (0, -1, 0, 64), (0, 0, 1, 64), (0, 0, -1, 64)))
    lumps[11] = b"".join(struct.pack("<3i", i, 0, 0) for i in range(6))
    lumps[12] = struct.pack("<3i", 0, 6, 0)
    mi = 13 + (1 if ver <= 18 else 0)
    ei = 14 + (1 if ver <= 18 else 0)
    lumps[mi] = struct.pack("<6f4i", -64, -64, -64, 64, 64, 64, 0, 0, 0, 1)
    lumps[ei] = b'{\n"classname" "worldspawn"\n}\n{\n"classname" "info_pathnode"\n"origin" "0 0 0"\n}\n\0'
    hdr = b"2015" + struct.pack("<ii", ver, 0)
    ofs = 12 + 8 * 29
    body = b""
    dirs = b""
    for lump in lumps:
        dirs += struct.pack("<ii", ofs + len(body), len(lump))
        body += lump
        body += b"\0" * ((-len(body)) % 4)
    return hdr + dirs + body


class TempDirCase(unittest.TestCase):
    """Gives each test a fresh temp folder in self.d."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="mohaa_test_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def p(self, *parts):
        return os.path.join(self.d, *parts)


class AtomicWrites(TempDirCase):
    def test_write_and_backup(self):
        f = self.p("a.json")
        MC.atomic_write_bytes(f, b"one")
        MC.atomic_write_bytes(f, b"two", backup=True)
        self.assertEqual(open(f, "rb").read(), b"two")
        self.assertEqual(open(f + ".bak", "rb").read(), b"one")
        self.assertEqual([n for n in os.listdir(self.d) if n.endswith(".tmp")], [])

    def test_crash_during_replace_keeps_original(self):
        """SIMULATED crash: os.replace raises; the original must be untouched, no temp left."""
        f = self.p("a.txt")
        MC.atomic_write_bytes(f, b"original")
        with mock.patch.object(MC.os, "replace", side_effect=OSError("simulated crash")):
            with self.assertRaises(OSError):
                MC.atomic_write_bytes(f, b"new data that must not land")
        self.assertEqual(open(f, "rb").read(), b"original")
        self.assertEqual(sorted(os.listdir(self.d)), ["a.txt"])

    def test_stream_short_copy_never_lands(self):
        f = self.p("x.skd")
        with self.assertRaises(OSError):
            MC.atomic_write_stream(f, io.BytesIO(b"12345"), expected_size=10)
        self.assertFalse(os.path.exists(f))
        self.assertEqual(os.listdir(self.d), [])

    def test_text_newlines_match_open_w(self):
        f = self.p("t.txt")
        MC.atomic_write_text(f, "a\nb\n")
        self.assertEqual(open(f, "rb").read(), ("a" + os.linesep + "b" + os.linesep).encode())
        MC.atomic_write_text(f, "a\nb\n", newline="\n")
        self.assertEqual(open(f, "rb").read(), b"a\nb\n")

    def test_json_writes_forward_slashes(self):
        f = self.p("c.json")
        MC.atomic_write_json(f, {"pk3s": ["E:\\Games\\MOHAA\\main\\Pak0.pk3"], "n": 3})
        self.assertIn("E:/Games/MOHAA/main/Pak0.pk3", open(f, encoding="utf-8").read())


class Settings(TempDirCase):
    def test_hand_typed_backslashes_are_repaired(self):
        f = self.p("cfg.json")
        with open(f, "w", encoding="utf-8") as h:     # how a user types it in Notepad
            h.write('{"outdir": "E:\\Files\\new\\maps", "theme": "dark"}')
        cfg, notice = MC.load_settings(f)
        self.assertEqual(cfg["outdir"], "E:/Files/new/maps")
        self.assertIsNotNone(notice)
        self.assertTrue(os.path.isfile(f + ".bak"))
        self.assertEqual(json.load(open(f, encoding="utf-8"))["outdir"], "E:/Files/new/maps")

    def test_control_char_corruption_is_repaired(self):
        f = self.p("cfg.json")
        with open(f, "w", encoding="utf-8") as h:     # parses, but \n and \t become control chars
            h.write('{"outdir": "C:\\new\\tex"}')
        cfg, notice = MC.load_settings(f)
        self.assertEqual(cfg["outdir"], "C:/new/tex")
        self.assertIsNotNone(notice)

    def test_damaged_file_restored_from_bak(self):
        f = self.p("cfg.json")
        MC.atomic_write_json(f, {"pk3s": ["a.pk3"]}, backup=False)
        MC.atomic_write_json(f, {"pk3s": ["a.pk3", "b.pk3"]}, backup=True)
        with open(f, "w", encoding="utf-8") as h:
            h.write('{"pk3s": ["a.pk3", "b.p')        # truncated by a crash
        cfg, notice = MC.load_settings(f)
        self.assertEqual(cfg, {"pk3s": ["a.pk3"]})
        self.assertIn("restored", notice)
        self.assertTrue(any(".corrupt-" in n for n in os.listdir(self.d)))

    def test_damaged_file_without_bak_is_kept_aside(self):
        f = self.p("cfg.json")
        with open(f, "w", encoding="utf-8") as h:
            h.write("\x00\x00garbage")
        cfg, notice = MC.load_settings(f)
        self.assertEqual(cfg, {})
        self.assertIn("damaged", notice)
        self.assertFalse(os.path.exists(f))
        self.assertTrue(any(".corrupt-" in n for n in os.listdir(self.d)))

    def test_missing_file_is_first_run(self):
        self.assertEqual(MC.load_settings(self.p("none.json")), ({}, None))


class Logging(TempDirCase):
    def test_swallowed_logs_traceback_then_counts(self):
        lg = logging.getLogger("mohaa")
        stream = io.StringIO()
        h = logging.StreamHandler(stream)
        h.setLevel(logging.DEBUG)
        lg.addHandler(h)
        old = lg.level
        lg.setLevel(logging.DEBUG)
        try:
            for _ in range(MC.SWALLOW_LOG_LIMIT + 3):
                try:
                    raise ValueError("boom")
                except ValueError:
                    MC.swallowed()
        finally:
            lg.removeHandler(h)
            lg.setLevel(old)
        out = stream.getvalue()
        self.assertEqual(out.count("Traceback"), MC.SWALLOW_LOG_LIMIT)
        self.assertIn("counted, not logged", out)

    def test_swallowed_outside_except_is_a_no_op(self):
        MC.swallowed()


class PillowGuard(unittest.TestCase):
    def setUp(self):
        try:
            self.Image = MC.pil_image()
        except ImportError as e:
            self.skipTest("Pillow not available: %s" % e)

    def test_floor_and_limit(self):
        ok, why = MC.pil_status()
        self.assertTrue(ok, why)
        self.assertEqual(self.Image.MAX_IMAGE_PIXELS, MC.IMAGE_MAX_PIXELS)

    def test_oversized_image_is_refused(self):
        """A 9000 x 9000 image (81 Mpx > the 67 Mpx limit) must raise, not decode."""
        buf = io.BytesIO()
        old = self.Image.MAX_IMAGE_PIXELS
        self.Image.MAX_IMAGE_PIXELS = None              # allow building the test file itself
        try:
            self.Image.new("1", (9000, 9000)).save(buf, "PNG")
        finally:
            self.Image.MAX_IMAGE_PIXELS = old
        buf.seek(0)
        with self.assertRaises((self.Image.DecompressionBombError, self.Image.DecompressionBombWarning)):
            self.Image.open(buf).load()

    def test_old_pillow_is_refused(self):
        saved = dict(MC._pil_state)
        MC._pil_state.clear()
        try:
            import PIL
            with mock.patch.object(PIL, "__version__", "10.2.0"):
                with self.assertRaises(ImportError) as cm:
                    MC.pil_image()
            self.assertIn("older than", str(cm.exception))
        finally:
            MC._pil_state.clear()
            MC._pil_state.update(saved)


class LauncherPieces(TempDirCase):
    @classmethod
    def setUpClass(cls):
        try:
            import tkinter  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("tkinter missing")
        import mohaa_launcher as ML
        cls.ML = ML

    def stub(self):
        """An object with just what App._extract_one / _safe_target use."""
        import queue
        ML = self.ML

        class Stub:
            _EXTRACT_OK = ML.App._EXTRACT_OK
            _WIN_RESERVED = ML.App._WIN_RESERVED
            _safe_target = ML.App._safe_target
            _extract_one = ML.App._extract_one
        s = Stub()
        s._tmp = self.p("ws")
        os.makedirs(s._tmp)
        s._log_q = queue.Queue()
        return s

    def pak(self, entries):
        z = self.p("test.pk3")
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for n, d in entries.items():
                zf.writestr(n, d)
        return z

    def test_truncated_cache_is_extracted_again(self):
        """Bug 1: a short file left by an earlier crash used to be reused forever."""
        s = self.stub()
        data = os.urandom(50000)
        z = self.pak({"models/a/b.skd": data})
        target = os.path.join(s._tmp, "models", "a", "b.skd")
        os.makedirs(os.path.dirname(target))
        with open(target, "wb") as f:
            f.write(data[:1234])                         # what an interrupted extract left
        with zipfile.ZipFile(z) as zf:
            self.assertEqual(s._extract_one(zf, "models/a/b.skd"), target)
        self.assertEqual(open(target, "rb").read(), data)

    def test_interrupted_extract_leaves_nothing(self):
        """SIMULATED crash mid-extract: the read fails part-way; no file may appear."""
        s = self.stub()
        z = self.pak({"models/a/c.tga": os.urandom(300000)})

        class Dying(io.RawIOBase):
            def __init__(self, inner):
                self.inner, self.n = inner, 0

            def read(self, k=-1):
                self.n += 1
                if self.n > 1:
                    raise OSError("simulated crash")
                return self.inner.read(1000)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        with zipfile.ZipFile(z) as zf:
            real_open = zf.open
            with mock.patch.object(zf, "open", side_effect=lambda n: Dying(real_open(n))):
                with self.assertRaises(OSError):
                    s._extract_one(zf, "models/a/c.tga")
        self.assertFalse(os.path.exists(os.path.join(s._tmp, "models", "a", "c.tga")))

    def test_unsafe_entries_still_refused(self):
        s = self.stub()
        for bad in ("../x.tga", "models/../../x.tga", "C:/x.tga", "models/con.tga", "models/a.exe", "a/b:c.tga"):
            self.assertIsNone(s._safe_target(bad), bad)

    def test_import_has_no_side_effects(self):
        """Importing mohaa_launcher (as the Map Viewer does) must not create output/."""
        root = self.p("inst")
        shutil.copytree(BIN, os.path.join(root, "bin"),
                        ignore=shutil.ignore_patterns("libs*", "__pycache__"))
        code = ("import sys; sys.path.insert(0, %r); import mohaa_launcher, os; "
                "print(os.path.isdir(%r))" % (os.path.join(root, "bin"), os.path.join(root, "output")))
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "False")


class Updater(TempDirCase):
    """The update check and installer, against a fake GitHub.
    SIMULATED: the network (mohaa_common.http_get answers from a dict of files: the ref
    and tree API calls, the raw version file, and the commit zip)."""

    COMMIT = "c" * 40
    HEAD_DATE = "2100-01-01T00:00:00Z"   # when GitHub's commit was made (far ahead: nothing is "newer here")
    FILE_DATES = {}                      # path: when GitHub last committed it (else HEAD_DATE)

    @classmethod
    def setUpClass(cls):
        try:
            import tkinter  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("tkinter missing")
        import mohaa_launcher as ML
        cls.ML = ML

    def make_install(self):
        self.lookups = []
        root = self.p("install")
        for rp, txt in (("bin/mohaa_launcher.py", b"old launcher"), ("bin/mohaa_view.py", b"same view\n"),
                        ("docs/version.txt", b"1.0.000\n"), ("output/keep.json", b"user data"),
                        ("README.md", b"line one\r\nline two\r\n")):     # CRLF checkout of an LF file
            f = os.path.join(root, rp)
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with open(f, "wb") as h:
                h.write(txt)
        return root

    def github(self, extra=None):
        """The files on the fake GitHub (bytes as Git stores them)."""
        files = {"bin/mohaa_launcher.py": b"new launcher", "bin/mohaa_view.py": b"same view\n",
                 "bin/mohaa_common.py": b"new module", "docs/version.txt": b"1.0.001\n",
                 "README.md": b"line one\nline two\n", "output/evil.json": b"must never be written",
                 "bin/libs/evil.py": b"must never be written", "../evil.txt": b"must never be written"}
        files.update(extra or {})
        return files

    def fake_get(self, files, zip_override=None, offline=False):
        ML = self.ML
        sha = self.COMMIT

        def get(url, ua, timeout=None, dest=None, max_bytes=None, attempts=3):
            if offline:
                import urllib.error
                raise urllib.error.URLError("no route to host")
            if url == ML.UPDATE_REF_URL:
                return json.dumps({"object": {"sha": sha}}).encode()
            if url == ML.UPDATE_TREE_FMT.format(sha=sha):
                tree = [{"path": rp, "type": "blob", "mode": "100644", "sha": ML._git_blob_sha(b), "size": len(b)}
                        for rp, b in files.items()]
                tree.append({"path": "bin", "type": "tree", "mode": "040000", "sha": "d" * 40})
                return json.dumps({"sha": sha, "tree": tree, "truncated": False}).encode()
            if url == ML.UPDATE_COMMIT_FMT.format(sha=sha):
                self.lookups.append("head")
                return json.dumps({"sha": sha, "committer": {"date": self.HEAD_DATE}}).encode()
            if url.startswith(ML.UPDATE_API + "/commits?sha=" + sha + "&path="):
                import urllib.parse
                rp = urllib.parse.unquote(url.split("&path=", 1)[1].split("&", 1)[0])
                self.lookups.append(rp)
                return json.dumps([{"commit": {"committer": {"date": self.FILE_DATES.get(rp, self.HEAD_DATE)}}}]).encode()
            if url == ML.UPDATE_RAW_FMT.format(sha=sha, path="docs/version.txt"):
                return files["docs/version.txt"]
            if url == ML.UPDATE_ZIP_FMT.format(sha=sha):
                z = zip_override or self.make_zip(files)
                shutil.copyfile(z, dest)
                return dest
            raise AssertionError("unexpected URL " + url)
        return get

    def make_zip(self, files):
        z = self.p("release.zip")
        with zipfile.ZipFile(z, "w") as zf:
            for rp, b in files.items():
                if ".." not in rp:
                    zf.writestr("mohaa-model-map-viewer-" + self.COMMIT + "/" + rp, b)
        return z

    def env(self, root, get, fail_on=None):
        ML = self.ML
        real_write = MC.atomic_write_bytes

        def maybe_fail(path, data, backup=False):
            if fail_on and path.endswith(fail_on + ".new"):
                raise OSError("simulated write failure")
            return real_write(path, data, backup=backup)
        stack = [mock.patch.object(ML, "_install_root", return_value=root),
                 mock.patch.object(ML, "DATADIR", os.path.join(root, "output")),
                 mock.patch.object(MC, "http_get", side_effect=get),
                 mock.patch.object(MC, "atomic_write_bytes", side_effect=maybe_fail)]
        for s in stack:
            s.start()
        self.addCleanup(lambda: [s.stop() for s in reversed(stack)])

    def check(self, root, files, **kw):
        self.env(root, self.fake_get(files, **kw))
        return self.ML.update_check()

    def install(self, res, paths=None):
        app = self.ML.App.__new__(self.ML.App)
        return app._update_download_and_apply(res, paths)

    def read(self, root, rp):
        with open(os.path.join(root, rp), "rb") as f:
            return f.read()

    def test_check_finds_new_and_changed_files(self):
        root = self.make_install()
        res = self.check(root, self.github())
        self.assertTrue(res["ok"], res)
        got = {f["path"]: f["status"] for f in res["files"]}
        self.assertEqual(got, {"bin/mohaa_common.py": "new", "bin/mohaa_launcher.py": "changed",
                               "docs/version.txt": "changed"})       # README differs only in CRLF
        self.assertEqual(res["version"], "1.0.001")

    def test_offline_check_is_quiet(self):
        root = self.make_install()
        res = self.check(root, self.github(), offline=True)
        self.assertFalse(res["ok"])
        self.assertTrue(res["offline"])

    def test_install_then_up_to_date(self):
        root = self.make_install()
        files = self.github()
        res = self.check(root, files)
        out = self.install(res)
        self.assertTrue(out["ok"], out)
        self.assertEqual(self.read(root, "bin/mohaa_launcher.py"), b"new launcher")
        self.assertEqual(self.read(root, "bin/mohaa_common.py"), b"new module")
        self.assertEqual(self.read(root, "output/keep.json"), b"user data")
        self.assertFalse(os.path.exists(os.path.join(root, "output", "evil.json")))
        self.assertFalse(os.path.exists(os.path.join(root, "bin", "libs")))
        self.assertEqual({rp for rp, _s, _d in out["installed"]},
                         {"bin/mohaa_common.py", "bin/mohaa_launcher.py", "docs/version.txt"})
        bak = os.path.join(root, "output", "previous-versions", "1")
        self.assertEqual(self.read(bak, "bin/mohaa_launcher.py"), b"old launcher")
        log = self.read(os.path.join(root, "output", "previous-versions"), "changelog.txt").decode()
        self.assertTrue(log.startswith("1 - version "), log)
        again = self.ML.update_check()
        self.assertTrue(again["ok"])
        self.assertEqual(again["files"], [])

    def test_local_edit_after_an_update_is_kept(self):
        root = self.make_install()
        files = self.github()
        self.install(self.check(root, files))
        with open(os.path.join(root, "bin", "mohaa_common.py"), "wb") as f:
            f.write(b"my own edit")
        res = self.ML.update_check()
        self.assertEqual(res["files"], [])
        self.assertEqual(res["kept"], ["bin/mohaa_common.py"])

    def _age(self, root, rp, when):
        os.utime(os.path.join(root, rp), (when, when))

    def test_newer_here_than_github_is_not_offered(self):
        """A file that differs from GitHub's, with nothing in the manifest to say which side
        changed it, is kept when it was saved here after GitHub committed its copy (work not
        pushed yet), and offered when GitHub's copy is the newer."""
        import time as _t
        root = self.make_install()
        self.HEAD_DATE = "2026-11-10T12:00:00Z"
        head = self.ML._github_time(self.HEAD_DATE)
        self._age(root, "bin/mohaa_launcher.py", head + 3600)          # saved here after GitHub's commit
        self._age(root, "docs/version.txt", head - 86400)              # older than GitHub's
        res = self.check(root, self.github())
        got = {f["path"]: f["status"] for f in res["files"]}
        self.assertEqual(got, {"bin/mohaa_common.py": "new", "docs/version.txt": "changed"})
        self.assertEqual(res["newer"], ["bin/mohaa_launcher.py"])
        # the launcher needed no per-file lookup (newer than GitHub's newest commit); the
        # version file was looked up once, and the answer is kept for the next check
        self.assertEqual(self.lookups, ["head", "docs/version.txt"])
        self.lookups.clear()
        self.ML.update_check()
        self.assertEqual(self.lookups, ["head"])

    def test_file_older_than_the_head_but_newer_than_its_own_commit(self):
        root = self.make_install()
        self.HEAD_DATE = "2026-11-10T12:00:00Z"
        self.FILE_DATES = {"docs/version.txt": "2026-11-01T00:00:00Z"}
        head = self.ML._github_time(self.HEAD_DATE)
        self._age(root, "docs/version.txt", head - 86400)              # after its own commit, before the head
        self._age(root, "bin/mohaa_launcher.py", head - 86400 * 30)
        res = self.check(root, self.github())
        self.assertEqual(res["newer"], ["docs/version.txt"])
        self.assertIn("bin/mohaa_launcher.py", {f["path"] for f in res["files"]})

    def test_installed_copy_is_updated_whatever_the_times(self):
        """A file still as the updater installed it is offered when GitHub changes it, even
        if GitHub's new commit is dated before the install (committed, pushed later)."""
        root = self.make_install()
        files = self.github()
        self.install(self.check(root, files))
        self.HEAD_DATE = "2000-01-01T00:00:00Z"
        self.env(root, self.fake_get(dict(files, **{"bin/mohaa_common.py": b"newer module"})))
        res = self.ML.update_check()
        self.assertEqual([f["path"] for f in res["files"]], ["bin/mohaa_common.py"])
        self.assertEqual(res["newer"], [])

    def test_unticked_files_are_left_alone(self):
        root = self.make_install()
        res = self.check(root, self.github())
        out = self.install(res, {"bin/mohaa_common.py"})
        self.assertTrue(out["ok"], out)
        self.assertEqual(self.read(root, "bin/mohaa_launcher.py"), b"old launcher")
        self.assertEqual(self.read(root, "bin/mohaa_common.py"), b"new module")

    def test_failed_file_rolls_everything_back(self):
        """SIMULATED: one file can't be written; every file already replaced must come back."""
        root = self.make_install()
        files = self.github()
        self.env(root, self.fake_get(files), fail_on="version.txt")
        res = self.ML.update_check()
        out = self.ML.App.__new__(self.ML.App)._update_download_and_apply(res)
        self.assertFalse(out["ok"])
        self.assertIn("undone", out["error"])
        self.assertEqual(self.read(root, "bin/mohaa_launcher.py"), b"old launcher")
        self.assertEqual(self.read(root, "docs/version.txt"), b"1.0.000\n")
        self.assertFalse(os.path.exists(os.path.join(root, "bin", "mohaa_common.py")))

    def test_damaged_zip_is_refused(self):
        root = self.make_install()
        files = self.github()
        z = self.make_zip(files)
        b = bytearray(open(z, "rb").read())
        i = b.find(b"new launcher")
        b[i:i + 3] = b"XXX"                             # CRC no longer matches
        with open(z, "wb") as f:
            f.write(b)
        res = self.check(root, files, zip_override=z)
        out = self.install(res)
        self.assertFalse(out["ok"])
        self.assertEqual(self.read(root, "bin/mohaa_launcher.py"), b"old launcher")

    def test_download_not_matching_the_list_is_refused(self):
        root = self.make_install()
        files = self.github()
        z = self.make_zip(dict(files, **{"bin/mohaa_common.py": b"something else"}))
        res = self.check(root, files, zip_override=z)
        out = self.install(res)
        self.assertFalse(out["ok"])
        self.assertIn("doesn't match", out["error"])
        self.assertFalse(os.path.exists(os.path.join(root, "bin", "mohaa_common.py")))

    def test_startup_choice_is_shared_and_kept(self):
        """Both programs read one startup choice; saving file fingerprints keeps it."""
        root = self.make_install()
        files = self.github()
        self.env(root, self.fake_get(files))
        ML = self.ML
        self.assertTrue(ML.update_check_at_startup())
        ML._update_manifest_save(startup=False)
        ML.update_check()                                 # writes fingerprints
        self.assertFalse(ML.update_check_at_startup())
        ML._update_manifest_save(startup=True)
        self.assertTrue(ML.update_check_at_startup())

    def test_unsafe_paths(self):
        ok = self.ML._update_path_ok
        for rp in ("bin/mohaa_view.py", "README.md", "docs/changelog/CHANGELOG.md"):
            self.assertTrue(ok(rp), rp)
        for rp in ("output/x.json", "bin/libs/PIL/x.py", "../x", "a/./b", "/etc/x", "C:/x", "a\\b",
                   "bin/__pycache__/x.pyc", ".git/config", "", "a//b",
                   "Claude outputs/notes.diff", "claude outputs/x.md", ".claude/settings.local.json"):
            self.assertFalse(ok(rp), rp)


class UpdaterGit(TempDirCase):
    """_update_git_sync against real Git repositories: a bare "origin" standing in for
    GitHub and a clone whose files the updater has just replaced. Skipped without git."""

    @classmethod
    def setUpClass(cls):
        if not shutil.which("git"):
            raise unittest.SkipTest("git missing")
        try:
            import tkinter  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("tkinter missing")
        import mohaa_launcher as ML
        cls.ML = ML

    def git(self, cwd, *a):
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                   GIT_COMMITTER_EMAIL="t@t", GIT_CONFIG_NOSYSTEM="1", HOME=self.d)
        r = subprocess.run(["git", "-C", cwd] + list(a), capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def setup_repos(self):
        """origin with commit A, a clone at A ("here"), then commit B pushed to origin from
        another clone ("laptop"). Returns (here, sha of B)."""
        origin, laptop, here = self.p("origin.git"), self.p("laptop"), self.p("here")
        self.git(self.d, "init", "-q", "--bare", "-b", "main", origin)
        self.git(self.d, "clone", "-q", origin, laptop)
        with open(os.path.join(laptop, "a.txt"), "w") as f: f.write("one\n")
        self.git(laptop, "add", "a.txt"); self.git(laptop, "commit", "-q", "-m", "A")
        self.git(laptop, "push", "-q", "origin", "HEAD:main")
        self.git(self.d, "clone", "-q", origin, here)
        with open(os.path.join(laptop, "a.txt"), "w") as f: f.write("two\n")
        self.git(laptop, "commit", "-q", "-am", "B"); self.git(laptop, "push", "-q", "origin", "HEAD:main")
        return here, self.git(laptop, "rev-parse", "HEAD")

    def test_branch_moves_to_the_installed_commit(self):
        here, b = self.setup_repos()
        with open(os.path.join(here, "a.txt"), "w") as f: f.write("two\n")    # what the updater wrote
        msg = self.ML._update_git_sync(here, b)
        self.assertIn("now points at", msg)
        self.assertEqual(self.git(here, "rev-parse", "HEAD"), b)
        self.assertEqual(self.git(here, "status", "--porcelain"), "")         # nothing to commit, push is clean

    def test_a_file_kept_here_stays_a_local_change(self):
        here, b = self.setup_repos()
        with open(os.path.join(here, "a.txt"), "w") as f: f.write("mine\n")   # unticked: the file here kept
        self.ML._update_git_sync(here, b)
        self.assertEqual(self.git(here, "rev-parse", "HEAD"), b)
        self.assertIn("a.txt", self.git(here, "status", "--porcelain"))
        with open(os.path.join(here, "a.txt")) as f: self.assertEqual(f.read(), "mine\n")

    def test_commits_made_here_leave_the_branch_alone(self):
        here, b = self.setup_repos()
        with open(os.path.join(here, "c.txt"), "w") as f: f.write("local\n")
        self.git(here, "add", "c.txt"); self.git(here, "commit", "-q", "-m", "local")
        head = self.git(here, "rev-parse", "HEAD")
        msg = self.ML._update_git_sync(here, b)
        self.assertIn("git pull", msg)
        self.assertEqual(self.git(here, "rev-parse", "HEAD"), head)

    def test_not_a_checkout(self):
        self.assertIsNone(self.ML._update_git_sync(self.d, "c" * 40))


class ShaderTexMods(unittest.TestCase):
    """Base-stage tcmods the model page animates (scripts/opel.shader)."""
    def test_rotate_coef_and_scroll(self):
        import mohaa_textures as MTX
        props = MTX.parse_shader_props_file(
            "opelhub\n{\n{\nmap a.tga\ntcmod rotate 5 0 -20\n}\n}\n"
            "opeltread\n{\n{\nmap b.tga\ntcmod scroll 0.2 0\n}\n}\n"
            "prop\n{\n{\nclampmap c.tga\ntcmod rotate 5000\n}\n}\n")
        self.assertEqual(props["opelhub"]["texrotate"], -100.0)   # speed * coef (tr_shade_calc.c:1608)
        self.assertEqual(props["opeltread"]["texscroll"], [0.2, 0.0])
        self.assertEqual(props["prop"]["texrotate"], 5000.0)
        self.assertTrue(props["prop"].get("clamp"))

    def test_beam_bundle_and_dot(self):
        import mohaa_textures as MTX
        props = MTX.parse_shader_props_file(
            "opellights\n{\n{\nmap textures/common/airdust.tga\ntcmod scroll 0 0.15\n"
            "nextbundle\nclampmap textures/models/items/beam.tga\nrgbGen dot 0 1.5\nblendfunc add\n}\n}\n"
            "glanternglass\n{\n{\nmap a.tga\nalphagen oneminusdot 0.2 1.2\nblendfunc blend\n}\n}\n"
            "addbundle\n{\n{\nmap a.tga\nnextbundle add\nmap b.tga\n}\n}\n")
        p = props["opellights"]
        self.assertTrue(p["additive"])
        self.assertEqual(p["texscroll"], [0.0, 0.15])          # the base (dust) scroll only
        self.assertEqual(p["bundle"]["map"], "textures/models/items/beam.tga")
        self.assertTrue(p["bundle"].get("clamp"))
        self.assertNotIn("scroll", p["bundle"])
        self.assertEqual(p["rgbdot"], [0.0, 1.5, 0])
        self.assertEqual(props["glanternglass"]["adot"], [0.2, 1.2, 1])
        self.assertEqual(props["addbundle"]["bundle"].get("env"), "add")


class WaterAndScriptStart(unittest.TestCase):
    """m3l1a's water: flap keeps its spread, tCoord alpha, and what the level script hides
    and sets as the level starts."""
    def test_flap_and_tcoord(self):
        import mohaa_map_view as MV
        d = MV._fx_deform("flap t 10 sin 0 10 0 .10 0 10".split())
        self.assertEqual(d[0], 5)                               # along t
        self.assertEqual(d[-3:], [0.0, 10.0, 0.1])              # min, max, 1 / div (the spread)
        self.assertEqual(MV._fx_alpha(["tcoord", "1.8", "-0.01"], ["c"]), ["tc", 1.8, -0.01, 0.0, 1.0])
        self.assertEqual(MV._fx_rgb(["scoord", "0", "1", "0.2", "0.9"], False), ["sc", 0.0, 1.0, 0.2, 0.9])

    def _read(self, text, names):
        import mohaa_map_view as MV
        ents = [{"kvd": {}}] + [{"kvd": {"targetname": n}} for n in names]
        ls = MV.LevelScript(lambda p: (text, "x") if p.endswith("t.scr") else (None, None), ents)
        ls.read("maps/t.scr")
        return ls

    def test_start_hide_and_fog(self):
        ls = self._read(
            "main:\nlevel waittill prespawn\n$world farplane 3500\n$world farplane_color (.62 .62 .61)\n"
            "$world farplane local.x\nthread prep\nlevel waittill spawn\nthread later\nend\n"
            "prep:\n$wavy hide\n$calm show\nwait 2\n$calm hide\nend\n"
            "later:\nwait 1\n$wavy show\nend\n"
            "event:\n$calm hide\nend\n", ["wavy", "calm"])
        self.assertEqual({k: v[0] for k, v in ls.prehide.items()}, {1: 1, 2: 0})
        out = ls.payload(3)
        self.assertEqual([h[0] for h in out["prehide"]], [1])
        self.assertEqual(out["prewld"]["farplane"][0], "3500")     # local.x isn't a value
        self.assertEqual(out["prewld"]["farplane_color"][0], ".62 .62 .61")


class BspSave(TempDirCase):
    def test_save_verifies_then_keeps_bak(self):
        out = self.p("m_mod.bsp")
        node = '{\n"classname" "info_pathnode"\n"origin" "8 8 8"\n}\n'
        MB.write_bsp_entities(bsp_seed(), node, out)
        first = open(out, "rb").read()
        MB.write_bsp_entities(bsp_seed(), node + node, out)
        self.assertEqual(open(out + ".bak", "rb").read(), first)
        self.assertEqual(len(MB.parse_entity_string(MB.bsp_entity_text(open(out, "rb").read()))), 4)

    def test_lumps_stay_in_header_order(self):
        """Inside a .pk3 the game can't seek back to a lump ("CM_LoadLump: Error seeking to
        lump."): a saved .bsp keeps its lumps in the header's order, the new entities in place."""
        out = self.p("m_order.bsp")
        node = '{\n"classname" "info_pathnode"\n"origin" "8 8 8"\n}\n'
        MB.write_bsp_entities(bsp_seed(), node, out)
        d = open(out, "rb").read()
        self.assertTrue(MB.lumps_in_order(d))
        # a shuffled .bsp (entities and planes moved to the end) is put back in order, every lump kept
        src = bytearray(bsp_seed())
        _v, lumps, _le = MB._bsp_header(bytes(src))
        for i in (14, 1):
            o, n = lumps[i]
            while len(src) % 4:
                src.append(0)
            struct.pack_into("<ii", src, 12 + 8 * i, len(src), n)
            src += bytes(src[o:o + n])
        src = bytes(src)
        self.assertFalse(MB.lumps_in_order(src))
        fixed = MB.canonical_layout(src)
        self.assertTrue(MB.lumps_in_order(fixed))
        _v, l1, _le = MB._bsp_header(src)
        _v, l2, _le = MB._bsp_header(fixed)
        for (a, n), (b, m) in zip(l1, l2):
            self.assertEqual(src[a:a + n], fixed[b:b + m])

    def test_failed_check_never_reaches_destination(self):
        """SIMULATED: the read-back check fails; the destination must not be created."""
        out = self.p("bad.bsp")
        with mock.patch.object(MB, "parse_entity_string", side_effect=[[], [], []]):
            with self.assertRaises(MB.BspError):
                MB.write_bsp_entities(bsp_seed(), '{\n"classname" "info_pathnode"\n}\n', out)
        self.assertFalse(os.path.exists(out))
        self.assertEqual(os.listdir(self.d), [])


class ChildBuilds(TempDirCase):
    def test_map_build_end_to_end(self):
        """Build a real page from a synthetic .bsp with the real child process and env."""
        src = self.p("tiny.bsp")
        with open(src, "wb") as f:
            f.write(bsp_seed())
        out = self.p("out")
        r = subprocess.run([sys.executable, os.path.join(BIN, "mohaa_map_view.py"), src,
                            "--outdir=" + out, "--no-open"],
                           capture_output=True, text=True, encoding="utf-8", env=MC.child_env())
        self.assertEqual(r.returncode, 0, r.stdout[-800:] + r.stderr[-800:])
        names = os.listdir(out)
        self.assertTrue(any(n.endswith(".html") for n in names), names)
        self.assertTrue(any(n.endswith(".map") for n in names), names)
        self.assertFalse(any(n.endswith(".tmp") for n in names), names)

    def test_non_ascii_name_builds(self):
        """Bug 5: a file name outside the Windows code page must not crash the build.
        SIMULATED Windows console: the child's stdout is forced to cp1252, which is what a
        Windows child gets when its output is piped. Old behaviour (no PYTHONIOENCODING)
        is run first to show the failure, then the launcher's env (MC.child_env)."""
        src = self.p("карта_地图.bsp")
        with open(src, "wb") as f:
            f.write(bsp_seed())
        cmd = [sys.executable, os.path.join(BIN, "mohaa_map_view.py"), src,
               "--outdir=" + self.p("out2"), "--no-open"]
        old_env = dict(os.environ, PYTHONIOENCODING="cp1252")
        r_old = subprocess.run(cmd, capture_output=True, env=old_env)
        r_new = subprocess.run(cmd, capture_output=True, env=MC.child_env())
        self.assertNotEqual(r_old.returncode, 0, "expected the cp1252 child to fail on this name")
        self.assertEqual(r_new.returncode, 0, r_new.stderr[-800:])


if __name__ == "__main__":
    unittest.main(verbosity=2)
