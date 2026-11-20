#!/usr/bin/env python3
"""Try the Linux embedded pane (bin/mohaa_webpane_qt.py) before it goes into the launcher.

Opens a Tk window like the launcher's - a Tk side on the left with a text box, the pane
on the right - embeds Qt WebEngine in the pane, loads a viewer page, runs a few automatic
checks, and then stays open so you can try it by hand. Close the window to finish.

    python3 tests/webpane_qt_demo.py <a built viewer page .html> [--software]

Any built page works, opened with its editor mode on (#edit=1); a model page (in
output/models, or output/standalone for a file opened from disk) also exercises Save.
--software: Qt draws the pane without the GPU (try it if the pane stays blank).

Needs PySide6 6.11.1 in bin/libs-linux (the system Python is left alone):
    python3 -m pip install --target bin/libs-linux PySide6-Essentials==6.11.1 PySide6-Addons==6.11.1
"""
import sys, os, json, subprocess, threading, queue, time
import tkinter as tk

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "bin", "mohaa_webpane_qt.py")


def main(argv):
    pages = [a for a in argv[1:] if not a.startswith("--")]
    if not pages or not os.path.isfile(pages[0]):
        print(__doc__); return 2
    url = "file://" + os.path.abspath(pages[0]) + "#edit=1"     # the editor mode on (a no-op on other pages)
    env = dict(os.environ)
    if "--software" in argv:
        env["QT_QUICK_BACKEND"] = "software"
    print("session:", os.environ.get("XDG_SESSION_TYPE", "?"), "| DISPLAY:", os.environ.get("DISPLAY", "(none)"))

    root = tk.Tk(); root.title("Linux embedded pane - demo"); root.geometry("1300x800")
    left = tk.Frame(root, width=220, bg="#222"); left.pack(side="left", fill="y"); left.pack_propagate(False)
    tk.Label(left, text="Tk side\n\ntype here to check the\nkeyboard comes back:", bg="#222", fg="#ccc").pack(pady=(14, 4))
    ent = tk.Entry(left); ent.pack(padx=8, fill="x")
    log = tk.Text(left, height=30, bg="#111", fg="#9c9", wrap="word", font=("monospace", 8)); log.pack(fill="both", expand=True, padx=4, pady=8)
    pane = tk.Frame(root, bg="#400"); pane.pack(side="right", fill="both", expand=True)
    root.update()

    p = subprocess.Popen([sys.executable, HELPER, "--parent=%d" % pane.winfo_id()], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
    events = queue.Queue(); errs = []
    threading.Thread(target=lambda: [events.put(json.loads(l)) for l in p.stdout], daemon=True).start()
    threading.Thread(target=lambda: [errs.append(l.rstrip()) for l in p.stderr], daemon=True).start()

    def say(s):
        print(s); log.insert("end", s + "\n"); log.see("end")

    def send(**kw):
        try: p.stdin.write(json.dumps(kw) + "\n"); p.stdin.flush()
        except (BrokenPipeError, OSError): pass

    seen = []

    def wait(pred, t=40):
        for e in list(seen):
            if pred(e): seen.remove(e); return e
        end = time.time() + t
        while time.time() < end:
            root.update()
            if p.poll() is not None: return None
            try: e = events.get(timeout=0.05)
            except queue.Empty: continue
            if pred(e): return e
            seen.append(e)
        return None

    ok = lambda c: "OK  " if c else "FAIL"
    r = wait(lambda e: e["ev"] == "ready", 60)
    say(f"{ok(r)} helper started")
    if not r:
        say("helper output:\n" + "\n".join(errs[-15:])); root.mainloop(); return 1
    pane.bind("<Configure>", lambda ev: send(op="resize", w=ev.width, h=ev.height))
    send(op="resize", w=pane.winfo_width(), h=pane.winfo_height())
    send(op="load", url=url)
    r = wait(lambda e: e["ev"] == "loaded")
    say(f"{ok(r and r['ok'])} page loaded")
    send(op="eval", js="chrome.webview.postMessage('probe '+(typeof GLR!=='undefined'&&GLR?'WebGL':'2D-canvas')+' '+innerWidth+'x'+innerHeight)")
    r = wait(lambda e: e["ev"] == "msg" and e["data"].startswith("probe "))
    say(f"{ok(r)} page <-> Python messages work; the page draws with {r and r['data'].split()[1]} at {r and r['data'].split()[2]} (pane {pane.winfo_width()}x{pane.winfo_height()})")
    say("\nNow try by hand:\n"
        " - drag in the view: the camera turns\n"
        " - Animation Editor page: New from selected animation, click a joint, drag a ring\n"
        " - open the editor's bone list, click its filter box and type\n"
        " - click the Tk box on the left and type: the keys go there\n"
        " - resize this window: the page follows\n"
        " - Save .skc...: the size of what arrives is shown here\n"
        "Close the window when done.\n")

    def pump():
        while True:
            try: e = events.get_nowait()
            except queue.Empty: break
            if e["ev"] == "msg":
                d = e["data"]
                if d.startswith("mohaa-anim-save\n"):
                    pl = json.loads(d.split("\n", 1)[1])
                    say(f"Save arrived: {len(d)} chars, {len(pl['frames'])} frames x {len(pl['names'])} channels")
                    send(op="eval", js="MOHAA_ANIMED_SAVED&&MOHAA_ANIMED_SAVED(true,'demo: the launcher got it (nothing written)','','')")
                else:
                    say("page says: " + d[:90])
            elif e["ev"] == "error":
                say("helper error: " + e["what"])
        if p.poll() is not None:
            say("the helper stopped (exit %s):\n%s" % (p.returncode, "\n".join(errs[-10:])))
            return
        root.after(50, pump)
    root.after(50, pump)
    root.protocol("WM_DELETE_WINDOW", lambda: (send(op="quit"), root.destroy()))
    root.mainloop()
    try: p.wait(10)
    except subprocess.TimeoutExpired: p.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
