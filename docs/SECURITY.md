# Security Policy

## Threat model — please read

Both programs exist to open **`.pk3` archives and game files that you supply**:
models in the Model Viewer, `.bsp` and `.map` files in the Map Viewer. A `.pk3` is an
ordinary ZIP file. If you downloaded one (or a map) from a mod site, a Discord server or
a forum, treat it as untrusted input, because that is exactly what it is.

The programs are written on that assumption. Specifically:

| Attack surface | Mitigation |
|---|---|
| Archive entry names (`ZipSlip`) | Every entry is confined to the temporary workspace by `_safe_target()`: components are reduced to plain names, `..`, drive tokens and NTFS alternate-data-stream syntax are rejected, Windows device names are rejected, an extension allow-list is enforced, and the final path is re-checked against the workspace root with `realpath` so symlinks and junctions cannot escape it. |
| Malformed `.skd` / `.skb` / `.skc` / `.lod` files | Every count read from a file header is bounded by what the file can physically hold, and structural advance offsets must be positive, so a hostile file cannot produce an unbounded loop or allocation. A surface's level-of-detail arrays are read only when they lie inside the file, and a `.lod` only as its twelve fixed numbers, when the file holds them. |
| Hostile `.shader` scripts | The block scanner is linear-time and matched with an explicit position, so a crafted shader cannot cause a quadratic parse hang during pak loading. |
| Decompression bombs | Archive entries are capped at 192 MB, whether read into memory or extracted to the workspace, and skipped beyond that. Images are capped at 8192 x 8192 pixels (`mohaa_common.IMAGE_MAX_PIXELS`): Pillow's decompression-bomb warning is turned into an error, so an oversized texture is skipped instead of decoded. |
| Image-decoder vulnerabilities | Pillow 10.3 is a **security floor**, enforced at run time on every platform (`mohaa_common.pil_image()`), not only by the Windows installer: with an older Pillow, textures are disabled and the Output pane says why. The launchers vendor Pillow into `bin/libs` (`bin/libs-linux`, `bin/libs-mac`), so the floor doesn't depend on what the operating system ships. |
| Interrupted or damaged writes | Every file the programs write goes through a temp file, `fsync`, a read-back check and `os.replace` (`mohaa_common.atomic_write_*`), so a crash can't leave a short file behind. Pak entries must match their declared size, both when extracted and when a cached copy is reused. Settings keep a `.bak`; a damaged settings file is repaired, restored from the `.bak`, or set aside, never silently replaced by defaults. |
| Updates (startup check, Help -> Check for updates) | HTTPS only, with retries and size caps; the requests carry only a User-Agent. The check compares each program file with GitHub's file list for one commit (its Git blob SHA-1), and a path from that list is refused unless it is relative, without `.` / `..` / `\` / `:`, and outside `output/` and any `libs*`, `.git` or `__pycache__` folder. The download is the zip of that same commit: every entry's CRC is tested, and every file must match its listed SHA-1, before anything is written; every replaced file is first copied to `output/previous-versions/<n>/`, and a failure part-way restores every file already replaced. The download is not separately signed: its integrity rests on HTTPS and GitHub. |
| `$include` expansion bombs | Cycle guard, depth cap, **and** a total-output budget, so sibling fan-out cannot exhaust memory. |
| Malformed `.bsp` files | Every lump must lie inside the file, record counts come from the lump sizes rather than from count fields, a brush with more sides than the map compiler allows (300) is skipped, and NaN or infinite numbers are skipped or written as 0. A file that still breaks the reader is reported as damaged, and nothing is written for it. |
| Malformed `.map` text | The page's parser skips a broken primitive up to the next one and lists it as a warning, and rejects patch grids over the engine's 129-point limit and terrain blocks far past the 9 x 9 the editor writes, so a crafted file can't make it allocate without bound. |
| Decompiled `.map` files | A decompile never replaces a `.map` the program didn't write (its own start with a marker line); the mapper's source next to a `.bsp` is kept, and the decompile is saved as `<name>_decompiled.map`. Clear built maps deletes only its own pages and the `.map` files carrying that marker, and only inside its `maps` / `maps_standalone` folders (and the older Map Editor's `<stem>_<kind>_edit_view.html` pages). |
| Game-file text reaching the generated HTML | Model payload and title are escaped for inline-`<script>` embedding. A map page carries the map's text, textures and models base64-encoded in a non-executable block, its title and summary escaped, and shows game-file text only through escaping. Both pages carry a Content-Security-Policy that pins every source to `self`/`file`/`data`/`blob` with `connect-src 'none'`. |
| Requests from a map page to its launcher | The Map Viewer's page asks the launcher for a few things (a model or an actor for Simulate, an actor's animation, a Save as copy, the Modify recovery file); a request's text is treated as untrusted. A Simulate model must be a `.tik` under `models/` in the loaded paks, without `..`; an actor's human and weapon a `.tik` directly in `models/human/` or `models/weapons/`; request keys match `[A-Za-z0-9_-]` (64 at most), animation roles come from a fixed list, request bodies are length-capped, and a clip over 600 frames is refused. Save as never writes over the map it came from nor over a file Save as didn't write, and a saved `.bsp` is read back and checked before it is kept. |
| Requests from an Edit animations page to the Model Viewer | The editor's page asks the launcher to save an animation and to add a saved one to the game; a request's text is treated as untrusted and length-capped (64 MB for a save, at most 4,000 frames and 8,192 channels). A save is checked before anything is written (channel names 31 characters at most, every number finite, every frame the same channels), goes only where the Save dialog says, and is read back and compared value by value. "Add to game" takes only a file saved in this session, an animation name matching `[A-Za-z0-9_]` (47 at most) that no human `.tik` in the loaded paks already uses, and writes only into the output folder (`<output>/mod`), never into the game's folders. |
| Requests from an Edit map page to the Map Viewer | The editor's page adds one request to the Map Viewer's, `mohaa-edit-new`, matched exactly and carrying nothing: the launcher opens its own file box, and the page has no say in the name or folder. New map writes only a `.map` whose name is letters, digits, `_`, `.` or `-`, built from fixed text (the map's title has quotes, braces and line breaks taken out), atomically and with a `.bak` of a file it replaces, then reads it back and checks every brush before opening it. The level script is read and written only beside the map the launcher has open from disk (a `.bsp` or `.map`; not a pak's copy in the workspace), as that map's `<name>.scr`: the page names no path the launcher writes to. Its text is length-capped (4 MB), must be single-byte text without NUL, is written atomically with a `.bak` and read back; the camera a reload carries is checked to be three numbers. The texture browser asks for the list of textures in the loaded paks (`mohaa-edit-texlist`, carrying nothing) and for one texture by name (`mohaa-edit-tex`): the name must start `textures/`, be at most 200 characters, and have no `..`, control characters, quotes or brackets; it is only looked up in the loaded paks, never on disk. Brush changes in the recovery file are a capped list (20,000) of text changes, each checked for its fields' types before the file is written; the page applies one only when the text it replaces is there. The close question's brush count is read as a number. Compile (`mohaa-edit-compile`, carrying the page's count of unsaved changes, read as a number, and, from a `.bsp` or a changed map, the map's text) compiles the map the launcher has open (that text, else the `.map` on disk), after the user's choices in the launcher's own Compile window: the steps from a fixed list (bsp, vis or fast vis, light); switches from a fixed list, plus words typed for each step, passed on only when every word is a switch (`-` then letters, digits, `_` or `.`) or a number and none names a folder or file (`-gamedir`, `-tempname`, `-tmpin`, `-tmpout`, `-moddir`); where the `.bsp` goes (the launcher's own file box, or the game's maps folder for a gametype from a fixed list: a `.bsp` there that Compile didn't write is replaced only when the user says so); the `.map` beside it is written the same way, a `.map` Compile didn't write replaced only when the user says so. The vis groups put back on the map's copy come from the original `.bsp` (the one opened, the one beside the map, or the loaded paks' copy), read with its lump bounds checked; a `.bsp` that can't be read is skipped and the map compiled without them. When the user ticks it, the game is started after a compile: the program in the paks' game folder from a fixed list of names (or the one the user picked once), with the command line typed in the window split into words, refused if a word starts with `-` or `/` or holds `;` or `&`, then `+set g_gametype` with a number from the fixed list and `+devmap` with the map's name, run without a shell (through Wine for a `.exe` off Windows); a compile can be stopped from the launcher (F9), which kills the running step and writes nothing; the compiler is the program in `bin/ommap` for this system, run without a shell with fixed arguments, in a game folder in the workspace holding only the paks' shader scripts (names checked: letters, digits, `_ . -`) and a copy of the map, and, before the light step, the static models' vertices as `<name>.smv` (removed and written fresh each time, from models read only in the loaded paks), which ommap uses only when its model count matches the map's and every vertex count fits the file and the game's limits, and the `.tga` images of the map's alphashadow shaders, copied from the loaded paks only (paths checked: letters, digits, `_ . / -`, no `..`, ending `.tga`), and, before the bsp step, the images of the shaders the map names (the same checks, ending `.tga` or `.jpg`; ommap reads a `.jpg` only as far as its size, inside the file's length); it writes the `.bsp` beside the map atomically with a `.bak`, read back, and the leak trail `<name>.lin` beside it. All the Map Viewer's requests keep their checks. |
| The embedded pane on Linux | The page runs in Qt WebEngine in a separate helper process (`bin/mohaa_webpane_qt.py`), started with the program's own Python and nothing else on its command line but the window to draw in. Its browser profile is off the record (no cookies, cache or local storage on disk). The page reaches the launcher only through `chrome.webview.postMessage`, carried to the same message handler, and with the same checks, as on Windows. The helper takes commands only on its own stdin, from the launcher, and stops when the launcher's end of it closes. |
| Configured external programs | Only an existing file at an absolute path is launched, without a shell and with the model or map file as its only argument, so a planted config can't trigger a `PATH` or current-directory lookup or smuggle in extra arguments. |

**No mitigation is perfect.** If you find a way around any of the above, please
report it.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. If that option isn't available, open an issue that only asks for a
private contact, without any details of the problem.

Please include:

* what the flaw is and what an attacker gains,
* the affected file(s) and, if you have them, line numbers,
* a minimal reproducer — for archive-handling bugs, the smallest `.pk3` or model
  file that triggers it,
* your platform, Python version and program version.

**Do not attach copyrighted game assets.** A synthetic file that demonstrates the
bug is always preferable and is usually smaller anyway.

### What to expect

This is a volunteer, non-commercial project, so please read these as good-faith
intentions rather than a contractual SLA:

| Stage | Target |
|---|---|
| Acknowledgement | within 7 days |
| Initial assessment | within 14 days |
| Fix or documented mitigation | within 90 days, sooner for anything permitting code execution or file writes outside the workspace |
| Public disclosure | coordinated with you, normally after a fix ships |

Credit will be given in the release notes unless you ask otherwise.

## Supported versions

Only the latest release receives security fixes. There is no long-term support
branch and no back-porting.

## Regulatory note (EU Cyber Resilience Act)

Regulation (EU) 2024/2847 ("CRA") applies to products with digital elements
placed on the EU market. Its vulnerability- and incident-reporting obligations
have applied since **11 September 2026**, and the remaining obligations apply from
**11 December 2027**.

Free and open-source software that is **not supplied in the course of a
commercial activity** is outside the scope of those manufacturer obligations,
and non-commercial open-source developers are not subject to CRA fines. This
project is distributed free of charge, with full source, with no paid edition,
no paid support, no mandatory donation and no collection of personal data — so
it is intended to sit squarely within that exemption.

That status is **not permanent by default**. According to the European
Commission's guidance on the CRA and open source, a project can move into scope
by, among other things: selling the software or a paid edition, monetising
services through it, making donations effectively mandatory for access or for
essential updates, or requiring personal data for purposes beyond security and
interoperability. Purely voluntary donations, sponsorship, public funding and
optional paid consulting or training do not by themselves make a project
commercial, provided the software itself stays freely available.

If this project's distribution model ever changes in one of those directions,
this policy and the CRA position must be revisited first.

*This section is a plain-language summary for contributors, not legal advice.*
