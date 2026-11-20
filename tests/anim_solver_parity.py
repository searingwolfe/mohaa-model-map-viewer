#!/usr/bin/env python3
"""Parity check: bin/mohaa_anim_solver.js against mohaa_view.py's solver.

Python solves each animation with solve_anim (rounding switched off), dumps rig + raw
frames + expected per-frame records to JSONL, then tests/anim_solver_parity.js re-solves
them in Node and reports the largest difference.

Usage:
  python3 tests/anim_solver_parity.py --models <folder holding models/> [--limit N] [--tol 1e-9]
    Human clips (models/human/animation/**) are solved on several human rigs; every other
    folder's .skc are solved on the .skd beside them. Needs `node` on PATH.
"""
import os, sys, glob, json, argparse, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(os.path.dirname(HERE), "bin")
sys.path.insert(0, BIN)
import mohaa_view as V

V.round = lambda x, n=None: x          # solve_anim rounds its output; compare full precision

RIG_KEYS = ("name", "parentIdx", "boneType", "bindOffset", "refIdx", "solvable",
            "bendRatio", "bendMax", "spinRatio", "avWeight", "hoseType")
HUMAN_RIGS = [  # player rig, soldier with leg helpers, French Resistance cullpants, officer, merged body+head
    ["human/allied_pilot/allied_pilot.skd"],
    ["human/german_wehrmact_soldier/heerprivate.skd"],
    ["human/french_resistance/resistance.skd"],
    ["human/german_wehrmact_officer/*.skd"],
    ["human/german_wehrmact_soldier/heerprivate.skd", "human/heads/head1.skd"],
]


MOVE_RIG = "human/german_wehrmact_soldier/heerprivate.skd ["
MOVE_CLIP = "human/animation/walks_runs/rifle_walk_forward.skc"    # movement donor (frame 0, like the viewer)


def rig_json(bones):
    return [{k: b.get(k) for k in RIG_KEYS if b.get(k) is not None} for b in bones]


def load_rig(mroot, parts):
    paths = []
    for p in parts:
        hits = sorted(glob.glob(os.path.join(mroot, "models", p)))
        if not hits:
            return None, None
        paths.append(hits[0])
    skds = [V.parse_skd(p) for p in paths]
    skd = skds[0] if len(skds) == 1 else V.merge_skds(skds)
    return skd, "+".join(os.path.relpath(p, os.path.join(mroot, "models")) for p in paths)


def cases(mroot, limit):
    models = os.path.join(mroot, "models")
    human = sorted(glob.glob(os.path.join(models, "human", "animation", "**", "*.skc"), recursive=True))
    if limit:
        human = human[:limit]
    for parts in HUMAN_RIGS:
        skd, label = load_rig(mroot, parts)
        if skd:
            yield label + " [human clips]", skd, human
    # co-located: each folder's own .skd and .skc (vehicles, weapons, props, ...)
    for d in sorted({os.path.dirname(p) for p in glob.glob(os.path.join(models, "**", "*.skc"), recursive=True)}):
        if os.sep + "animation" in d:
            continue
        skds = sorted(glob.glob(os.path.join(d, "*.skd")))
        if not skds:
            continue
        try:
            skd = V.parse_skd(skds[0])
        except Exception:
            continue
        skcs = sorted(glob.glob(os.path.join(d, "*.skc")))
        yield os.path.relpath(skds[0], models), skd, skcs[:limit] if limit else skcs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--limit", type=int, default=0, help="clips per rig (0 = all)")
    ap.add_argument("--tol", type=float, default=1e-9)
    ap.add_argument("--keep", help="write the JSONL here instead of a temp file")
    a = ap.parse_args()
    out = a.keep or os.path.join(tempfile.mkdtemp(), "parity.jsonl")
    n_cases = n_frames = n_skip = 0
    mvp = os.path.join(a.models, "models", MOVE_CLIP)
    mv = V.parse_skc(mvp)["frames"][0] if os.path.isfile(mvp) else None
    t0 = time.time()
    with open(out, "w") as fh:
        for label, skd, skcs in cases(a.models, a.limit):
            bones = skd["bones"]
            names = {b["name"] for b in bones}
            hi, lc = V.anim_solver_ctx(bones)
            fh.write(json.dumps({"rig": label, "bones": rig_json(bones)}) + "\n")
            for p in skcs:
                try:
                    d = V.parse_skc(p)
                except Exception:
                    n_skip += 1
                    continue
                if not ({n.rsplit(" ", 1)[0] for n in d["names"]} & names):
                    continue                     # drives nothing on this rig
                rec = V.solve_anim(bones, {"name": "x", "data": d}, hi, lc)
                exp = [{str(k): v for k, v in fr.items()} for fr in rec["frames"]]
                fh.write(json.dumps({"case": os.path.relpath(p, a.models), "names": d["names"],
                                     "frames": d["frames"], "expect": exp}) + "\n")
                n_cases += 1
                n_frames += len(exp)
                # movement-slot overlay (action over movement): upper-body clips on the soldier rig
                if mv is not None and label.startswith(MOVE_RIG) and "Bip01 pos" not in d["names"]:
                    rec = V.solve_anim(bones, {"name": "x", "data": d}, hi, lc, mv)
                    exp = [{str(k): v for k, v in fr.items()} for fr in rec["frames"]]
                    fh.write(json.dumps({"case": os.path.relpath(p, a.models) + " +movement",
                                         "names": d["names"], "frames": d["frames"],
                                         "movement": mv, "expect": exp}) + "\n")
                    n_cases += 1
                    n_frames += len(exp)
    print(f"python: {n_cases} clip/rig cases, {n_frames} frames, {n_skip} unreadable .skc "
          f"skipped, {time.time() - t0:.0f}s")
    r = subprocess.run(["node", os.path.join(HERE, "anim_solver_parity.js"), out, str(a.tol)])
    if not a.keep:
        os.remove(out)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
