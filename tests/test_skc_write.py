#!/usr/bin/env python3
"""Tests for bin/mohaa_skc_write.py.  Run: python3 tests/test_skc_write.py [extra .skc/.pk3 ...]"""
import os, sys, struct, glob, tempfile, unittest, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(os.path.dirname(HERE), "bin")
sys.path.insert(0, BIN)
import mohaa_skc_write as W
import mohaa_view as V

# OpenMOHAA's own test animations (build/main/models/omtests) - set MOHAA_OMTESTS to their folder
OMTESTS = os.environ.get("MOHAA_OMTESTS", "")
EXTRA = [a for a in sys.argv[1:] if not a.startswith("-")]
sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a.startswith("-")]


def sample_files():
    out = sorted(glob.glob(os.path.join(OMTESTS, "**", "*.skc"), recursive=True)) if OMTESTS else []
    return out


def make_anim():
    names = ["Bip01 pos", "Bip01 rot", "Bip01 Spine rot", "Bip01 Spine1 rot", "VISEME_Bump"]
    frames = []
    for i in range(5):
        t = i / 4.0
        frames.append([[0.0, 0.0, 40.0 + t, 0.0],
                       [0.0, 0.0, 0.0, 1.0],
                       [0.0, 0.2 * t, 0.0, (1 - (0.2 * t) ** 2) ** 0.5],
                       [0.1, 0.0, 0.0, 0.99498744],
                       [t, 0.0, 0.0, 0.0]])
    a = W.new_anim(names, frames, frameTime=0.05)
    a["frames"][2]["delta"] = [3.0, 0.0, 0.0]
    return a


class TestChannelType(unittest.TestCase):
    def test_suffixes(self):
        self.assertEqual(W.channel_type("Bip01 Spine rot"), "rot")
        self.assertEqual(W.channel_type("Bip01 pos"), "pos")
        self.assertEqual(W.channel_type("Bip01 L Thigh rotFK"), "none")
        self.assertEqual(W.channel_type("VISEME_Bump"), "value")
        self.assertEqual(W.channel_type("rot"), "value")      # len < 4 handled like the engine


class TestNewAnim(unittest.TestCase):
    def test_layout_matches_engine_reader(self):
        a = make_anim()
        b = W.write_skc(a)
        nc, nf = 5, 5
        hdr = struct.unpack_from("<4siiif3ffiii", b, 0)
        self.assertEqual(hdr[0], b"SKAN")
        self.assertEqual(hdr[1], 13)
        self.assertEqual(hdr[3], len(b))                       # nBytesUsed = file size
        self.assertEqual(hdr[-3], nc)
        self.assertEqual(hdr[-1], nf)
        self.assertEqual(hdr[-2], 48 + 48 * nf + 16 * nc * nf)  # names right after the data
        for i in range(nf):                                     # ConvertSkelFileToGame's fixed offsets
            base = 96 + 48 * (nf - 1) + 16 * nc * i
            self.assertEqual(struct.unpack_from("<i", b, 48 + 48 * i + 44)[0], base)
            got = struct.unpack_from("<4f", b, base + 16 * 4)  # VISEME_Bump
            self.assertAlmostEqual(got[0], i / 4.0, places=6)
        self.assertEqual(len(b), hdr[-2] + 32 * nc)

    def test_viewer_parser_reads_it(self):
        a = make_anim()
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "new.skc")
            W.save_skc(p, a, backup=False)
            s = V.parse_skc(p)
        self.assertEqual(s["names"], a["names"])
        self.assertEqual(s["numFrames"], 5)
        self.assertAlmostEqual(s["frameTime"], 0.05, places=6)
        self.assertAlmostEqual(s["frames"][4]["Bip01 pos"][2], 41.0, places=5)
        self.assertEqual(list(s["fdelta"][2]), [3.0, 0.0, 0.0])

    def test_rewrite_is_stable(self):
        b = W.write_skc(make_anim())
        self.assertEqual(W.write_skc(W.read_skc_bytes(b)), b)

    def test_rejects_bad_input(self):
        a = make_anim()
        a["names"][1] = "Bip01 pos"
        self.assertRaises(W.SkcError, W.write_skc, a)                    # duplicate channel
        a = make_anim(); a["names"][0] = "x" * 32
        self.assertRaises(W.SkcError, W.write_skc, a)                    # name too long
        a = make_anim(); a["frames"][1]["values"].pop()
        self.assertRaises(W.SkcError, W.write_skc, a)                    # ragged frame
        a = make_anim(); a["frames"][3]["values"][0][1] = float("nan")
        self.assertRaises(W.SkcError, W.write_skc, a)                    # NaN
        a = make_anim(); a["frames"] = []
        self.assertRaises(W.SkcError, W.write_skc, a)                    # engine rejects 0 frames

    def test_duplicates_allowed_only_on_request(self):
        a = make_anim(); a["names"][4] = "Bip01 pos"           # like the shipping dialogue clips
        b = W.write_skc(a, allow_duplicates=True)
        self.assertEqual(W.read_skc_bytes(b)["names"].count("Bip01 pos"), 2)
        self.assertEqual(W.roundtrip_bytes(b, "dup")[0], "identical")

    def test_recompute_totals(self):
        a = make_anim(); a["frames"][4]["delta"] = [1.0, -2.0, 0.5]; a["frames"][1]["angleDelta"] = 4.0
        W.recompute_totals(a)
        self.assertEqual(a["totalDelta"], [4.0, -2.0, 0.5])
        self.assertEqual(a["totalAngleDelta"], 4.0)

    def test_name_limit_31(self):
        a = make_anim(); a["names"][4] = "y" * 31
        self.assertEqual(W.read_skc_bytes(W.write_skc(a))["names"][4], "y" * 31)


class TestRoundTrip(unittest.TestCase):
    def check(self, name, data):
        st, detail = W.roundtrip_bytes(data, name)
        self.assertIn(st, ("identical", "equivalent"), detail)
        return st

    def test_reader_rejects_other_versions(self):
        b = bytearray(W.write_skc(make_anim()))
        struct.pack_into("<i", b, 4, 14)
        self.assertRaises(W.SkcError, W.read_skc_bytes, bytes(b))

    def test_stale_frame_offsets_kept_or_cleaned(self):
        b = bytearray(W.write_skc(make_anim()))
        struct.pack_into("<i", b, 48 + 44, 0)          # engine ignores this field
        st, _ = W.roundtrip_bytes(bytes(b), "stale")
        self.assertEqual(st, "identical")               # kept as-is when keep_raw
        clean = W.write_skc(W.read_skc_bytes(bytes(b)), keep_raw=False)
        self.assertEqual(struct.unpack_from("<i", clean, 48 + 44)[0], 48 + 48 * 5)

    def test_space_padded_names_preserved(self):
        b = bytearray(W.write_skc(make_anim()))
        ofs = struct.unpack_from("<i", b, 0x28)[0]
        b[ofs + 9: ofs + 32] = b" " * 23                # "Bip01 pos" then spaces, no NUL
        self.assertEqual(W.read_skc_bytes(bytes(b))["names"][0], "Bip01 pos")
        self.assertEqual(self.check("spaces", bytes(b)), "identical")

    def test_sample_files(self):
        files = sample_files()
        if not files:
            self.skipTest("set MOHAA_OMTESTS to OpenMOHAA build/main/models/omtests")
        for p in files:
            with open(p, "rb") as fh:
                data = fh.read()
            self.assertEqual(self.check(p, data), "identical", p)
            with tempfile.TemporaryDirectory() as d:   # viewer sees the same values after a rewrite
                q = os.path.join(d, "rt.skc")
                W.save_skc(q, W.read_skc(p), backup=False)
                a, b = V.parse_skc(p), V.parse_skc(q)
                self.assertEqual(a["frames"], b["frames"])
                self.assertEqual(a["fbounds"], b["fbounds"])

    def test_extra_files(self):
        if not EXTRA:
            self.skipTest("pass real game .skc/.pk3 paths on the command line")
        n = 0
        for name, data in W._iter_sources(EXTRA):
            try:
                W.read_skc_bytes(data, name)
            except W.SkcError:
                continue                                 # proto/other-version files: viewer skips them too
            self.check(name, data); n += 1
            a = W.read_skc_bytes(data, name)
            td = list(a["totalDelta"]); tad = a["totalAngleDelta"]
            W.recompute_totals(a)
            junk = abs(tad) >= 1e5 or any(abs(f["angleDelta"]) >= 1e5 for f in a["frames"])
            if not junk and "/dialogue/" not in name:          # skip exporter junk values
                self.assertAlmostEqual(a["totalAngleDelta"], tad, places=2, msg=name)
            for x, y in zip(a["totalDelta"], td):
                self.assertAlmostEqual(x, y, places=2, msg=name)
        self.assertGreater(n, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
