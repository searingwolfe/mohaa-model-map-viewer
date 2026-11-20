#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ==============================================================================
#  mohaa_webpane_linux.py  --  the launcher's side of the embedded 3D pane on Linux.
#
#  On Windows the launchers embed Microsoft Edge WebView2 through tkwebview2. On Linux the
#  page runs in Qt WebEngine inside a helper process (mohaa_webpane_qt.py) that puts its
#  view in this Tk frame's X11 window. QtPane is that frame. It offers the parts of
#  tkwebview2's WebView2 the launchers use, under the same names, so their code is shared:
#      pane.load_url(url)
#      pane.core.ExecuteScriptAsync(js)                       run script in the page
#      pane.core.AddScriptToExecuteOnDocumentCreatedAsync(js)  ... and in every page after
#      pane.core.WebMessageReceived += handler                handler(sender, args), where
#                                                             args.TryGetWebMessageAsString()
#      pane.core.Settings.AreBrowserAcceleratorKeysEnabled = False   no Reload / Back / Forward
#      pane.web.AllowExternalDrop = False                     refuse dropped files
#      pane.web.Dispose()                                     stop the helper
#  `core` stays None until the helper is up, like WebView2's async start-up, and the page
#  message handlers run on the Tk thread.
#
#  The helper is started with this process's Python and the program's libs-linux folder on
#  its PYTHONPATH. If it stops before it is up (Qt missing a system library, no X11
#  display), `on_fail(reason)` is called on the Tk thread so the launcher can fall back to
#  the browser.
#
#  Standard library only (Qt is imported by the helper, never here).
# ==============================================================================
import sys
import os
_bin_dir = os.path.dirname(os.path.abspath(__file__))
if _bin_dir not in sys.path:
    sys.path.insert(0, _bin_dir)
import json, queue, subprocess, threading, importlib.util
import tkinter as tk

import mohaa_common as MC

LOG = MC.get_logger("webpane")
HELPER = os.path.join(_bin_dir, "mohaa_webpane_qt.py")
LIBS = os.path.join(_bin_dir, "libs-linux")
POLL_MS = 30                     # how often the helper's events are read on the Tk thread
START_TIMEOUT_MS = 60000         # the helper must be up by then
STDERR_KEEP = 40                 # helper stderr lines kept for the failure message


def why_unavailable():
    """Why the pane can't be used on this system, or "" when it can. Doesn't import Qt."""
    if not sys.platform.startswith("linux"):
        return "the Qt pane is for Linux"
    if not os.path.isfile(HELPER):
        return "bin/mohaa_webpane_qt.py is missing"
    if not os.environ.get("DISPLAY"):
        return "no X11 display (DISPLAY is not set)"
    if LIBS not in sys.path and os.path.isdir(LIBS):
        sys.path.insert(0, LIBS)
    try:
        spec = importlib.util.find_spec("PySide6")
    except (ImportError, ValueError):
        MC.swallowed(); spec = None
    if spec is None or not spec.submodule_search_locations:
        return "PySide6 6.11.1 is not installed"
    for d in spec.submodule_search_locations:
        if any(n.startswith("QtWebEngineWidgets.") for n in os.listdir(d)):
            return ""
    return "PySide6 is installed without Qt WebEngine (PySide6-Addons 6.11.1)"


def _hint(lines, code=None):
    """A short reason from the helper's stderr, with the fix when it is a known one."""
    if code is not None and code < 0:
        return "the helper was stopped (signal %d)" % -code
    text = "\n".join(lines)
    if "xcb-cursor" in text:
        return "Qt needs libxcb-cursor0: sudo apt install libxcb-cursor0"
    if "could not connect to display" in text or "can't open the X display" in text:
        return "no X11 display for the pane"
    if "No module named 'PySide6" in text:
        return "PySide6 is not installed (the RUN file installs it)"
    for l in reversed(lines):
        if l.strip():
            return l.strip()[:200]
    return "the helper stopped"


class _Args:
    """What a WebMessageReceived handler gets, as from WebView2."""
    def __init__(self, data): self._data = data
    def TryGetWebMessageAsString(self): return self._data


class _Event:
    """`event += handler` / `event -= handler`, as pythonnet gives .NET events. Messages
    that come before any handler is added (a page that loads and posts before the launcher
    has hooked the pane) are kept, at most EARLY_MAX, and given to the first handler added."""
    EARLY_MAX = 200

    def __init__(self, pane=None):
        self.handlers = []; self._pane = pane; self.early = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        early, self.early = self.early, []
        for data in early:
            try: fn(self._pane, _Args(data))
            except Exception:
                LOG.error("embedded pane: a page message handler failed", exc_info=True)
        return self
    def __isub__(self, fn):
        if fn in self.handlers: self.handlers.remove(fn)
        return self


class _Settings:
    def __init__(self, pane): object.__setattr__(self, "_pane", pane)
    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)
        if name == "AreBrowserAcceleratorKeysEnabled" and not value:
            self._pane._send(op="nonav")


class _Core:
    def __init__(self, pane):
        self._pane = pane
        self.WebMessageReceived = _Event(pane)
        self.Settings = _Settings(pane)
    def ExecuteScriptAsync(self, js): self._pane._send(op="eval", js=str(js))
    def AddScriptToExecuteOnDocumentCreatedAsync(self, js): self._pane._send(op="addscript", js=str(js))


class _Web:
    def __init__(self, pane): object.__setattr__(self, "_pane", pane)
    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)
        if name == "AllowExternalDrop" and not value:
            self._pane._send(op="nodrop")
    def Dispose(self): self._pane.stop()


class QtPane(tk.Frame):
    """A Tk frame showing a page in the Qt WebEngine helper (see the module header)."""
    def __init__(self, master, width, height, on_fail=None):
        super().__init__(master, width=width, height=height, bg="#000000", takefocus=0)
        self.core = None
        self.web = _Web(self)
        self.control = None
        self.on_fail = on_fail
        self.has_keyboard = False            # the page took the keyboard with a click
        self._events = queue.Queue()
        self._stderr = []
        self._proc = None
        self._stopped = False
        self._pending = []                   # commands sent before the helper started
        self._size = (int(width), int(height))
        self.bind("<Configure>", self._on_configure)
        self.after_idle(self._start)

    # ---- helper process ----------------------------------------------------------
    def _start(self):
        if self._stopped: return
        try:
            self.update_idletasks()
            xid = self.winfo_id()
            env = dict(os.environ)
            pp = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = LIBS + (os.pathsep + pp if pp else "")
            self._proc = subprocess.Popen(
                [sys.executable, HELPER, "--parent=%d" % xid], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                errors="replace", bufsize=1, env=env, close_fds=True)
        except Exception as e:
            LOG.error("the embedded pane's helper could not start", exc_info=True)
            self._fail(f"the helper could not start: {e}")
            return
        LOG.info("embedded pane helper started (pid %d)", self._proc.pid)
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        self.after(START_TIMEOUT_MS, self._check_started)
        self.after(POLL_MS, self._poll)

    def _read_out(self):
        p = self._proc
        try:
            for line in p.stdout:
                line = line.strip()
                if not line: continue
                try: self._events.put(json.loads(line))
                except ValueError:
                    LOG.warning("embedded pane: unreadable helper line %r", line[:200])
        except (OSError, ValueError):
            LOG.debug("embedded pane: helper stdout closed", exc_info=True)
        self._events.put({"ev": "exit"})

    def _read_err(self):
        try:
            for line in self._proc.stderr:
                line = line.rstrip()
                self._stderr.append(line); del self._stderr[:-STDERR_KEEP]
                LOG.debug("embedded pane helper: %s", line)
        except (OSError, ValueError):
            LOG.debug("embedded pane: helper stderr closed", exc_info=True)

    def _send(self, **cmd):
        if self._stopped: return
        p = self._proc
        if p is None or self.core is None:
            if cmd.get("op") != "resize": self._pending.append(cmd)
            return
        try:
            p.stdin.write(json.dumps(cmd, separators=(",", ":")) + "\n"); p.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            LOG.warning("embedded pane: the helper is gone (%s not sent)", cmd.get("op"), exc_info=True)

    def _poll(self):
        if self._stopped: return
        while True:
            try: e = self._events.get_nowait()
            except queue.Empty: break
            ev = e.get("ev")
            if ev == "ready":
                self.core = _Core(self)
                self._send(op="resize", w=self._size[0], h=self._size[1])
                pending, self._pending = self._pending, []
                for c in pending: self._send(**c)
            elif ev == "msg":
                self._dispatch(str(e.get("data", "")))
            elif ev == "focused":
                self.has_keyboard = True
            elif ev == "loaded" and not e.get("ok"):
                LOG.warning("embedded pane: a page did not load: %s", e.get("url"))
            elif ev == "error":
                LOG.error("embedded pane helper: %s", e.get("what"))
            elif ev == "exit":
                self._exited(); return
        try: self.after(POLL_MS, self._poll)
        except tk.TclError: MC.swallowed()

    def _dispatch(self, data):
        if self.core is None: return
        ev = self.core.WebMessageReceived
        if not ev.handlers:
            if len(ev.early) < ev.EARLY_MAX: ev.early.append(data)
            else: LOG.warning("embedded pane: a page message came before any handler and was dropped")
            return
        args = _Args(data)
        for fn in list(ev.handlers):
            try: fn(self, args)
            except Exception:
                LOG.error("embedded pane: a page message handler failed", exc_info=True)

    def _check_started(self):
        if self.core is None and not self._stopped:
            LOG.error("embedded pane: the helper didn't start within %d s", START_TIMEOUT_MS // 1000)
            self.stop()
            self._fail("the helper didn't start in time")

    def _exited(self):
        if self._stopped: return
        code = None
        if self._proc is not None:
            try: code = self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                LOG.warning("embedded pane: the helper closed its output but is still running")
        self._stopped = True
        reason = _hint(self._stderr, code)
        if self.core is None:
            LOG.error("embedded pane helper stopped before it was up (exit %s): %s", code, reason)
            self._fail(reason)
        else:
            LOG.error("embedded pane helper stopped (exit %s): %s", code, reason)
            self._fail("the pane stopped: " + reason)

    def _fail(self, reason):
        self.core = None
        cb, self.on_fail = self.on_fail, None
        if cb is not None:
            try: cb(reason)
            except Exception:
                LOG.error("embedded pane: the failure handler failed", exc_info=True)

    # ---- what the launchers call ---------------------------------------------------
    def load_url(self, url):
        self._send(op="load", url=str(url))

    def take_keyboard_back(self):
        """A launcher widget was clicked while the page had the keyboard."""
        self.has_keyboard = False

    def _on_configure(self, ev):
        self._size = (max(1, ev.width), max(1, ev.height))
        self._send(op="resize", w=self._size[0], h=self._size[1])

    def stop(self):
        """Stop the helper (it also stops by itself when this process ends)."""
        if self._stopped and self._proc is None: return
        self._stopped = True
        p, self._proc = self._proc, None
        self.core = None
        if p is None: return
        try:
            p.stdin.write('{"op":"quit"}\n'); p.stdin.flush(); p.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            MC.swallowed()
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            LOG.warning("embedded pane helper didn't quit; stopping it")
            p.kill()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: LOG.error("embedded pane helper (pid %d) would not stop", p.pid)

    def destroy(self):
        self.stop()
        super().destroy()
