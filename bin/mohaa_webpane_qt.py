#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ==============================================================================
#  mohaa_webpane_qt.py  --  the embedded 3D pane on Linux (Qt WebEngine)
#
#  The Windows launcher hosts its viewer pages in Microsoft Edge WebView2. On Linux this
#  helper does the same job with Qt WebEngine (Chromium, like WebView2): it runs as its
#  own process and puts its browser view inside a window the launcher gives it (the Tk
#  pane's X11 window id), so Qt's and Tk's event loops never meet.
#
#  X11 only: under a Wayland session Tk runs on XWayland, and this helper is forced onto
#  X11 too (QT_QPA_PLATFORM=xcb), so both windows live in the same X server.
#
#  Pages talk to it exactly as they talk to WebView2: window.chrome.webview.postMessage
#  (a stand-in injected into every page, carried by QWebChannel), and the launcher runs
#  script in the page (WebView2's ExecuteScriptAsync) with the "eval" command.
#
#  The browser profile is off the record (nothing kept on disk), like the Windows pane's
#  private mode.
#
#  The launcher's side is mohaa_webpane_linux.py.
#
#  Protocol: one JSON object per line.
#    stdin  (launcher -> helper): {"op":"load","url":U} {"op":"resize","w":W,"h":H}
#                                 {"op":"eval","js":S} {"op":"addscript","js":S}
#                                 {"op":"nodrop"} {"op":"nonav"} {"op":"focus"} {"op":"quit"}
#                                 {"op":"grab","path":P}  (save a picture of the view; tests)
#      addscript: run S in every page from now on, as it is created
#      nodrop:    refuse files dropped on the view
#      nonav:     no Reload / Back / Forward (keys or the right-click menu)
#    stdout (helper -> launcher): {"ev":"ready"} {"ev":"loaded","ok":B,"url":U}
#                                 {"ev":"msg","data":S}  (a page's postMessage)
#                                 {"ev":"focused"}  (a click gave the view the keyboard)
#                                 {"ev":"grabbed","ok":B} {"ev":"error","what":S}
#  The helper exits when stdin closes (the launcher went away).
#
#  Usage: python3 mohaa_webpane_qt.py --parent=<X11 window id> [--url=<url>]
# ==============================================================================
import sys
import os
_LIBS_NAME = "libs" if sys.platform.startswith("win") else ("libs-mac" if sys.platform == "darwin" else "libs-linux")
_libs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), _LIBS_NAME)
if os.path.isdir(_libs_dir) and _libs_dir not in sys.path:
    sys.path.insert(0, _libs_dir)
os.environ["QT_QPA_PLATFORM"] = "xcb"          # must match Tk's X11 (XWayland under Wayland)
import json, threading, queue, ctypes, ctypes.util

from PySide6.QtCore import QObject, Slot, QTimer, QUrl, QFile, QIODevice, Qt, QEvent
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage, QWebEngineScript, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebChannel import QWebChannel

_out_lock = threading.Lock()


def emit(**kw):
    """One event line to the launcher."""
    line = json.dumps(kw, separators=(",", ":"))
    with _out_lock:
        try:
            sys.stdout.write(line + "\n"); sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            os._exit(0)                        # the launcher is gone


class _X11:
    """Just enough libX11 to keep our window inside the launcher's: Qt's own
    QWindow.setParent(foreign window) doesn't hold, because Qt WebEngine recreates the
    view's native window when it switches it to GPU rendering, as a new top-level window."""
    def __init__(self):
        lib = ctypes.util.find_library("X11")
        if not lib: raise OSError("libX11 not found")
        X = self.X = ctypes.cdll.LoadLibrary(lib)
        X.XOpenDisplay.restype = ctypes.c_void_p; X.XOpenDisplay.argtypes = [ctypes.c_char_p]
        W = ctypes.c_ulong
        X.XQueryTree.argtypes = [ctypes.c_void_p, W, ctypes.POINTER(W), ctypes.POINTER(W),
                                 ctypes.POINTER(ctypes.POINTER(W)), ctypes.POINTER(ctypes.c_uint)]
        X.XReparentWindow.argtypes = [ctypes.c_void_p, W, W, ctypes.c_int, ctypes.c_int]
        X.XMapWindow.argtypes = [ctypes.c_void_p, W]
        X.XMoveResizeWindow.argtypes = [ctypes.c_void_p, W, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
        X.XSetInputFocus.argtypes = [ctypes.c_void_p, W, ctypes.c_int, ctypes.c_ulong]
        X.XFree.argtypes = [ctypes.c_void_p]
        X.XFlush.argtypes = [ctypes.c_void_p]
        self.dpy = X.XOpenDisplay(None)
        if not self.dpy: raise OSError("can't open the X display")

    def parent_of(self, w):
        W = ctypes.c_ulong
        root, parent, kids, n = W(), W(), ctypes.POINTER(W)(), ctypes.c_uint()
        if not self.X.XQueryTree(self.dpy, w, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(n)):
            return None
        if kids: self.X.XFree(kids)
        return parent.value

    def adopt(self, child, parent, w, h):
        """Put `child` inside `parent` at 0,0 with size w x h, and show it."""
        self.X.XReparentWindow(self.dpy, child, parent, 0, 0)
        self.X.XMoveResizeWindow(self.dpy, child, 0, 0, max(1, w), max(1, h))
        self.X.XMapWindow(self.dpy, child)
        self.X.XFlush(self.dpy)

    def focus(self, w):
        self.X.XSetInputFocus(self.dpy, w, 2, 0)          # RevertToParent, CurrentTime
        self.X.XFlush(self.dpy)


class _ClickFocus(QObject):
    """A click in the view takes the keyboard. Our window is a plain child of the
    launcher's (no XEmbed), so the window manager keeps the keyboard on the launcher's
    top-level until we ask for it."""
    def __init__(self, pane):
        super().__init__(); self.pane = pane
    def eventFilter(self, obj, ev):
        if ev.type() == QEvent.MouseButtonPress:
            try:
                self.pane.x11.focus(int(self.pane.view.winId()))
                emit(ev="focused")
            except Exception as e:
                emit(ev="error", what=f"keyboard focus: {e}")
        return False


class Bridge(QObject):
    """What the page's window.chrome.webview.postMessage calls."""
    @Slot(str)
    def post(self, msg):
        emit(ev="msg", data=msg)


# window.chrome.webview, as WebView2 gives it to a page. Messages sent before the channel is
# up are queued, so a page posting during its own load (the boot handshake) loses nothing.
SHIM = r"""
(function(){
  if (window.__mohaaPane) return; window.__mohaaPane = 1;
  var q = [], b = null;
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: function(m){ m = String(m); if (b) b.post(m); else q.push(m); },
    addEventListener: function(){}, removeEventListener: function(){}
  };
  function up(){
    if (typeof qt === 'undefined' || !qt.webChannelTransport) { setTimeout(up, 10); return; }
    new QWebChannel(qt.webChannelTransport, function(ch){
      b = ch.objects.mohaaBridge; var p = q.splice(0); for (var i = 0; i < p.length; i++) b.post(p[i]);
    });
  }
  up();
})();
"""


def _qwebchannel_js():
    f = QFile(":/qtwebchannel/qwebchannel.js")
    if not f.open(QIODevice.ReadOnly):
        return None
    try:
        return bytes(f.readAll()).decode("utf-8")
    finally:
        f.close()


class Pane:
    def __init__(self, parent_xid, url=None):
        self.app = QApplication.instance() or QApplication(sys.argv[:1])
        self.profile = QWebEngineProfile(self.app)     # no storage name: off the record
        self.page = QWebEnginePage(self.profile, self.app)
        s = self.page.settings()
        s.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)   # sidecar <script> files beside the page
        s.setAttribute(QWebEngineSettings.WebGLEnabled, True)
        s.setAttribute(QWebEngineSettings.Accelerated2dCanvasEnabled, True)
        self.bridge = Bridge()
        self.channel = QWebChannel(self.page)
        self.channel.registerObject("mohaaBridge", self.bridge)
        self.page.setWebChannel(self.channel)
        js = _qwebchannel_js()
        if js is None:
            emit(ev="error", what="qwebchannel.js is missing from this Qt")
        else:
            sc = QWebEngineScript()
            sc.setName("mohaa-webview-shim")
            sc.setSourceCode(js + "\n" + SHIM)
            sc.setInjectionPoint(QWebEngineScript.DocumentCreation)
            sc.setWorldId(QWebEngineScript.MainWorld)
            sc.setRunsOnSubFrames(False)
            self.page.scripts().insert(sc)
        self.view = QWebEngineView()
        self.view.setPage(self.page)
        self.view.setAttribute(Qt.WA_NativeWindow, True)
        self.view.setWindowFlags(Qt.FramelessWindowHint)
        self.page.loadFinished.connect(lambda ok: emit(ev="loaded", ok=bool(ok), url=self.page.url().toString()))
        # into the launcher's window: our top-level X11 window becomes a child of its window,
        # and is put back whenever Qt recreates it (see _X11)
        self.parent_xid = int(parent_xid); self.size = (640, 480)
        self.x11 = _X11()
        self.view.setGeometry(0, 0, *self.size)
        self.view.show()
        self._adopt()
        if url: self.page.load(QUrl(url))
        # Only the view's render widget (its focus proxy, where the mouse goes) is watched: a
        # filter on the whole application is called for WebEngine's own internal events too,
        # and crashes PySide6 6.11.
        self.clickfocus = _ClickFocus(self); self._hooked = None
        self.cmds = queue.Queue()
        threading.Thread(target=self._read_stdin, daemon=True).start()
        self.timer = QTimer(); self.timer.timeout.connect(self._pump); self.timer.start(15)
        emit(ev="ready")

    def _read_stdin(self):
        for line in sys.stdin:
            line = line.strip()
            if line: self.cmds.put(line)
        self.cmds.put('{"op":"quit"}')        # stdin closed: the launcher is gone

    def _adopt(self):
        """Keep the view's native window inside the launcher's (cheap when it already is)."""
        try:
            wid = int(self.view.winId())
            if self.x11.parent_of(wid) != self.parent_xid:
                self.x11.adopt(wid, self.parent_xid, *self.size)
        except Exception as e:
            emit(ev="error", what=f"embedding: {e}")

    def _hook_focus(self):
        """Watch the current render widget for clicks (WebEngine can replace it)."""
        fp = self.view.focusProxy()
        if fp is not None and fp is not self._hooked:
            fp.installEventFilter(self.clickfocus); self._hooked = fp

    def _pump(self):
        self._adopt(); self._hook_focus()
        while True:
            try: line = self.cmds.get_nowait()
            except queue.Empty: return
            try: c = json.loads(line)
            except ValueError:
                emit(ev="error", what="bad command line"); continue
            op = c.get("op")
            if op == "load":
                self.page.load(QUrl(str(c.get("url", ""))))
            elif op == "resize":
                w, h = max(1, int(c.get("w", 1))), max(1, int(c.get("h", 1)))
                self.size = (w, h)
                self.view.setGeometry(0, 0, w, h)
                self.x11.adopt(int(self.view.winId()), self.parent_xid, w, h)
            elif op == "eval":
                self.page.runJavaScript(str(c.get("js", "")))
            elif op == "addscript":
                sc = QWebEngineScript()
                sc.setName("mohaa-added-%d" % len(self.page.scripts().toList()))
                sc.setSourceCode(str(c.get("js", "")))
                sc.setInjectionPoint(QWebEngineScript.DocumentCreation)
                sc.setWorldId(QWebEngineScript.MainWorld)
                sc.setRunsOnSubFrames(False)
                self.page.scripts().insert(sc)
            elif op == "nodrop":
                self.view.setAcceptDrops(False)
            elif op == "nonav":
                for a in (QWebEnginePage.Reload, QWebEnginePage.ReloadAndBypassCache,
                          QWebEnginePage.Back, QWebEnginePage.Forward):
                    self.page.action(a).setEnabled(False)
            elif op == "focus":
                self.view.setFocus(); self.x11.focus(int(self.view.winId()))
            elif op == "grab":                  # a picture of the view, for tests
                ok = self.view.grab().save(str(c.get("path", "")))
                emit(ev="grabbed", ok=bool(ok))
            elif op == "quit":
                self.app.quit(); return

    def run(self):
        return self.app.exec()


def main(argv):
    parent = url = None
    for a in argv[1:]:
        if a.startswith("--parent="): parent = a.split("=", 1)[1]
        elif a.startswith("--url="): url = a.split("=", 1)[1]
    if not parent:
        print("usage: mohaa_webpane_qt.py --parent=<X11 window id> [--url=<url>]", file=sys.stderr); return 2
    return Pane(int(parent, 0), url).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
