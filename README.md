# MOH:AA Model Viewer & Map Viewer

Two view-only tools for *Medal of Honor: Allied Assault (2002)* in one download. Both read
the game's own `.pk3` files, share one Python setup and launcher style, and build
self-contained HTML pages that open in the launcher's embedded 3D pane or in any browser.

* **MOHAA Model Viewer** opens any `.skd` / `.tik` with its animations, tags, shaders and
  live particle effects, aiming at exact in-game parity: the running asset that LightRay3D
  and Milkshape 3D can't show.
* **MOHAA Map Viewer**, the `.bsp` viewer, opens any compiled `.bsp`, turns it back into
  `.map` source and shows the whole map textured and lit like the game, or opens a `.map`
  (or MOHRadiant's `.bak` backup) directly: a modern, view-only stand-in for MOHRadiant.

<img src="screenshots/src1.png" alt="Model Viewer" width="49%"> <img src="screenshots/map1.jpg" alt="Map Viewer" width="49%">

# Table of Contents

### [How To Install / Uninstall](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#how-to-install--uninstall-1)<br>
## [MOHAA .tik Model Viewer](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#mohaa-tik-model-viewer)<br><br>[MOHAA .bsp Map Viewer](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#mohaa-bsp-map-viewer)<br><br>[Edit animations (in the Model Viewer)](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#edit-animations-in-the-model-viewer)<br><br>[Edit map (in the Map Viewer)](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#edit-map-in-the-map-viewer)<br><br>
### [Updating](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#updating-1)<br>
### [Where Your Files Go](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#where-your-files-go-1)<br>
### [Privacy & Security](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#privacy--security-1)<br>
### [Licence & Legal](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#licence--legal-1)<br>
### [For Developers](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#for-developers-1)<br>
### [Contact & Credits](https://github.com/searingwolfe/mohaa-model-viewer?tab=readme-ov-file#contact--credits-1)

# How To Install / Uninstall

**Requirements** (the same for both viewers):

* **Python 3.8 or newer** (3.11+ recommended), with the `tkinter` GUI module.
* **Pillow 10.3 or newer**: required. MOHAA textures are `.tga` files, and nothing else decodes
  them. (Pillow 10.3 is also why Python 3.8 is the minimum.)
* A full copy of the game (and/or SH and BT expansions), for its `.pk3` files.
* Optional, Windows 8.1 and newer: allows for an embedded 3D pane instead of a browser tab
  (`pythonnet`, `pywebview==4.4.1`, `tkwebview2` and the Microsoft Edge WebView2 Runtime,
  which ships with Windows 10 and 11).
* Optional, Linux: the same embedded pane, with Qt WebEngine (`PySide6-Essentials==6.11.1`
  and `PySide6-Addons==6.11.1`, about 650 MB once installed, plus the system library
  `libxcb-cursor0`). It needs an X11 desktop or Wayland with XWayland (KDE Plasma and GNOME
  both have it), glibc 2.34 or newer and Python 3.10 to 3.14.
* Without the embedded pane, HTML pages auto-open in your browser. The Map Viewer needs WebGL 2 to work,
  which every current browser has, but the Model Viewer falls back to a 2D renderer without WebGL.

The packages are listed in [`docs/requirements.txt`](docs/requirements.txt). The RUN files
(`.bat` on Windows, `.sh` on Linux and macOS) check for all of these and install what's
missing **into the program's own `bin` folder** (`bin\libs`, `bin/libs-linux` or
`bin/libs-mac`), never into Python itself, so nothing else on your PC is changed and the
program keeps working when other software updates Python's packages.

## Windows

* Click the green `<> Code` button and choose `Download ZIP`. <br>
Extract the `mohaa-model-viewer-main` folder anywhere on your PC.

* Start any of the programs with **`MOH Model-Map Viewer (Windows x86-x64).bat`**. A menu asks which one:
  press **1** for the **Map Viewer** (`.bsp` / `.map` / `.bak`) or **2** for the **Model
  Viewer** (`.skd` / `.tik`), or move with Up / Down
  and press Enter or Space (the Map Viewer is selected at first); Q or Esc quits. Drag a file onto the `.bat` to skip the menu and
  open it straight away in the program for its kind.

  Before opening the program, it:
  1. looks for **Python 3.8 or newer with tkinter**. If there isn't one, it asks whether
     to install it now: **Y** runs `bin\python_installer_updater.bat` (below), **N** stops
     so you can install Python yourself from
     [python.org](https://www.python.org/downloads/) (tick "tcl/tk" in the installer);
  2. shows the menu (unless a file was dropped on it);
  3. installs **Pillow** into `bin\libs` if it's missing or older than 10.3 (required for
     textures), and checks that it really loads;
  4. installs the **embedded 3D pane** packages into `bin\libs` if they're missing
     (optional; on Windows 8.1 and newer);
  5. tells you if the Microsoft Edge WebView2 Runtime is missing, in which case pages
     open in your browser.

  The `.bat` window then starts the program and closes by itself as soon as its window is
  open. Everything it printed (the Python it found, the package checks, pip's output) is
  saved in `output\logs\run_map.log` / `run_model.log` and shown at the top of the
  program's Output pane. If the program can't start, the `.bat` window stays open, shows
  what went wrong and waits for a key press. (The full record is in `output\logs\`.) The
  Output pane also says each time the program saves a file ("saved <path>").

* **`bin\python_installer_updater.bat`** installs a Python that suits your Windows
version and CPU (Windows 7 → 3.8, Windows 8/8.1 → 3.11, Windows 10/11 → latest) for
your user account only, so it normally needs no administrator rights. It verifies the
installer's Authenticode signature before running it, then installs the packages into
`bin\libs`. The RUN `.bat` offers to run it for you, and you can also run it on its
own to refresh the packages to their newest versions. <br>
It deliberately **does not modify your `PATH`**: Python's own installer handles that,
and hand-editing the registry `PATH` is how environments often get broken.

* If Windows blocks a `.bat` (SmartScreen or Smart App Control): <br>
Right-click the `.bat` file → Properties → General tab → Security: [✓] Unblock → OK.

* Once a launcher is open, use File → `Add .pk3 pak(s)...` and select all the game's
`.pk3` files (Pak0.pk3 and up, plus any expansion or mod paks; later paks override
earlier ones). <br>
Models, maps, scripts and textures are spread across them, so load them all together.
Each viewer remembers its own list.

## macOS and Linux

Do these once, before the first start. Run the commands from a terminal opened in the
program's folder (the one holding the `.sh` file).

**1. Python's Tk toolkit** (often a separate package):

```sh
sudo apt install python3-tk python3-pip   # Debian / Ubuntu / Kubuntu / Mint
sudo dnf install python3-tkinter          # Fedora / RHEL
sudo pacman -S tk                         # Arch
brew install python-tk                    # macOS (or use the python.org installer, which bundles Tk)
```

**2. Linux only: the library the embedded 3D pane needs.** pip can't install it, so
without it the pane can't start and pages open in your browser instead (the RUN file
warns when it's missing):

```sh
sudo apt install libxcb-cursor0           # Debian / Ubuntu / Kubuntu / Mint
sudo dnf install xcb-util-cursor          # Fedora / RHEL
sudo pacman -S xcb-util-cursor            # Arch
```

**3. Make the RUN file executable.** A downloaded zip doesn't keep the permission, and
the file won't start without it:

```sh
chmod +x "MOH Model-Map Viewer (Linux - Mac OS).sh"
```

Then start either program with **`MOH Model-Map Viewer (Linux - Mac OS).sh`**, from a terminal
(Konsole, GNOME Terminal, macOS Terminal ...) or a Linux file manager (it opens a terminal
for itself if it has none). The same menu asks which one: **1** Map Viewer, **2** Model
Viewer, or Up / Down and Enter (or Space). Give it a
file to skip the menu:

```sh
./"MOH Model-Map Viewer (Linux - Mac OS).sh"                     # the menu
./"MOH Model-Map Viewer (Linux - Mac OS).sh" maps/obj_team2.bsp  # straight into the Map Viewer
./"MOH Model-Map Viewer (Linux - Mac OS).sh" models/dog.tik      # straight into the Model Viewer
```

Like the `.bat`, it finds Python 3.8+ with tkinter and installs Pillow into
`bin/libs-linux` (`bin/libs-mac` on macOS) with `python -m pip install --target`. That
works on distributions that refuse system-wide `pip` installs (Ubuntu and Kubuntu 23.04
and newer), and it avoids Ubuntu 24.04's packaged Pillow 10.2, which is below the 10.3
security floor. If the `.sh` file won't start, check step 3 above. On macOS, Finder opens a double-clicked
`.sh` in a text editor, so start it from Terminal.

On Linux it also installs the **embedded 3D pane** (Qt WebEngine, PySide6 6.11.1) into
`bin/libs-linux` (about 650 MB, downloaded once). It also needs the system library from
step 2 above.

The pane runs in its own process, inside the program's window. On Wayland (Kubuntu's
default) both the program and the pane use XWayland. If the pane can't start, the Output
pane says why and the page opens in your default browser instead. If the pane stays
blank, start the program with `QT_QUICK_BACKEND=software` set, which draws the pane
without the GPU. On macOS there is no embedded pane: pages open in your default browser,
with the same viewer and the same output.

## Uninstall

Close both programs (each deletes its temporary workspace when it closes; File →
`Clear %temp% files` removes any left behind by a crash), then delete the folder.
Everything the programs keep is inside it: settings, logs and pages in `output/`
(see [Where Your Files Go](#where-your-files-go-1)) and the Python packages in `bin/libs*`.
Python itself stays installed; remove it from Windows Settings → Apps if nothing else
needs it.

# MOHAA .tik Model Viewer

A browser-based 3D asset viewer aiming at exact in-game visual parity across every asset
type the engine ships: skeletal models, animations, vehicles, weapons, projectiles,
static props, and the particle emitters and FX effects that existing tools do not handle.

Start it with **`MOH Model-Map Viewer (Windows x86-x64).bat`** and press **2** (or drag a `.skd` /
`.tik` onto it), load your `.pk3` archives, browse the model tree, and open any `.skd` or `.tik`
in a self-contained HTML viewer with animation playback, tag display, texture resolution
through the shader chain, and live particle effects.

## Why this exists

Plenty of tools open MOHAA's static geometry: vehicles, weapons and props load fine in
LightRay3D or Milkshape 3D. None of them show you a *running* asset: the particle
emitters, the FX scripts, the explosions, a skeletal model actually playing its animation
with its effects firing on the right frames. This viewer does, rebuilding each effect from
the `.tik` / `.shader` commands the way the engine would, so what you see on screen is
what the game draws.

## Features

**Loading & browsing**

* Open one or more `.pk3` archives and navigate the `models/` tree, or drag a
  loose `.skd` / `.tik` onto the launcher (or onto the RUN `.bat`).
* Loaded paks and preferences are remembered between sessions, with a
  recent-files list, tree search (`Ctrl+F`) and Explorer-style keyboard
  navigation.
* Select several files to build them in one batch, or drag a file out of the
  window to open it in its own browser tab.
* Right-click a file to open a `.tik` in your text editor, or a `.skd` in
  LightRay3D / Milkshape 3D (set them under Options → Change Text Editor /
  Change Legacy Model Viewer).
* Every built model is also exported as a Wavefront `.obj` you can open in other 3D tools.

**Rendering & animation**

* Skeletal `.skd` / `.skb` models with textures resolved through the full
  `.shader` chain, plus `.skc` / `.tik` animation playback: play/pause, loop,
  reset, per-frame scrub and a speed control.
* The animation browser follows the model's own `$include` / `includes{}`
  structure, so you can reach every anim the asset can play. The first 150 are
  built into the page (adjustable in Options); the rest are built the first time
  you pick them.
* **Particle emitters, FX scripts and explosions**, rebuilt from the effect
  commands and fired on their real frames: the part other tools skip.
* Show or hide individual surfaces, starting from what the `.tik` hides at spawn;
  an animation's own surface commands apply as it plays.
* Hang other models off any bone or tag with **attach-to-bone**, each with its
  own editable scale, offset (in `.tik` units) and angles. Its bone button moves
  it to another bone or tag and keeps those settings.
* WebGL rendering with a real depth buffer, or the 2D-canvas renderer (switch with
  View → Viewer renderer in the launcher, or Display → WebGL in the viewer; 2D is used
  automatically when WebGL isn't available).

On-demand animations and attach-to-bone need the launcher's embedded pane; a page
opened in a plain browser shows everything already built into it.

**Inspect & tweak**

* Display toggles: Texture, Mesh, Wire, Setsizes, Nodes, Labels, Face Anims,
  Corona orbit, WebGL and, for trees, the long-range Tree Sprite stand-in.
* **Edit a model's `setsize` bounding box live**: a pencil toggle on the setsize
  line turns the two `( x y z )` triples into number fields that redraw the red
  box as you type, then revert to the file's original values when you toggle it
  back off. A model with no `setsize` shows a `( 0 0 0 ) ( 0 0 0 )` placeholder
  you can fill in the same way.
* Copy the `setsize` line, or any attach-to-bone `scale / offset / angles` row,
  as one flat line in MOHAA `.tik` spacing, ready to paste straight into a
  script. Each attach-to-bone row's copy button gives the whole attachment as a
  script `attachmodel` line (model, bone, scale and offset).
* Free-look (WASD fly) and Tag-lock (orbit a clicked tag) cameras; tag/bone nodes
  and labels with a Tags-vs-Bones filter.
* An entity placement-angle (pitch / yaw / roll) dial that snaps to quarter
  turns, with a pencil for typing any angle.
* Light / dark theme and a custom backdrop colour, plus a full keyboard-shortcut
  set (`H` in the viewer, `F1` in the launcher).

**Self-contained by design**

* Each generated page is a single `.html` file: textures embedded as `data:`
  URIs, a restrictive Content-Security-Policy, and no network access at all
  (see [Privacy & Security](#privacy--security-1)).

## Model Viewer screenshots

![Model Viewer: Image 2](screenshots/src2.png)
![Model Viewer: Image 3](screenshots/src3.png)
![Model Viewer: Image 4](screenshots/src4.png)
![Model Viewer: Image 5](screenshots/src5.png)
![Model Viewer: Image 6](screenshots/src6.png)
![Model Viewer: Image 7](screenshots/src7.png)

# MOHAA .bsp Map Viewer

**MOHAA Map Viewer** opens the game's maps. A compiled `.bsp` is decompiled back into
`.map` source and shown whole: textured, lit like the game, every entity one click away.
A `.map` source opens directly. It's a modern, view-only stand-in for MOHRadiant: nothing
is ever written back to a map.

Start it with **`MOH Model-Map Viewer (Windows x86-x64).bat`** and press **1** (or drag a `.bsp` /
`.map` / `.bak` onto it), add your `.pk3` paks, and open any map from the `maps/` tree (`dm`, `obj`, the
single-player levels), or a loose `.bsp` / `.map` / `.bak` from disk with File → `Open File...`.

## Why this exists

MOHRadiant, the game's level editor, only opens `.map` sources, and the game's maps, like
most custom maps, ship only as compiled `.bsp` files. This viewer turns any `.bsp` back
into `.map` source and lets you explore the map in a modern 3D view, the way the game
draws it or the way MOHRadiant does, with every entity, trigger, path node and brush one
click away: its targetname, origin, `setsize`, targets and ready-to-paste script lines.

## Features

**Opening maps**

* **`.bsp` and `.map`.** A compiled `.bsp` is turned back into `.map` source by a
  built-in decompiler: brushes with their texture alignment recovered from what the game
  actually draws, curved patches, terrain (with its cut-away holes), entities and static
  models. The `.map` is saved next to the page; a `.map` of your own next to a `.bsp` is
  never overwritten.
* **`.bak`** (MOHRadiant's previous save) opens like the `.map` or `.bsp` it holds; what it
  writes has `_bak` in its name, so it never replaces the real map's page or decompile.
* Right-click a `.bsp` → **Decompile to .map only**, or decompile and open the `.map` in
  your text editor. A map's `.scr` scripts are in the tree too: double-click one to open
  it in your text editor.
* A page is rebuilt by itself when a loose file it was built from changes: the map
  opened from disk, or its `.scr`, `.dcl`, `.lin` or `.pth`.
* Select several maps, or right-click a folder, to build them in one batch.

**Seeing the map**

* **The whole map, textured:** brushes, curved patches, LOD terrain, placed and static
  models, and every entity, with point entities drawn the way MOHRadiant draws them
  (path nodes coloured by their targetname and spawnflags, facing arrows, stand-in cubes).
* **Lit like the game:** a `.bsp` opens with its own lightmaps, vertex light, baked
  static-prop light, light-grid model colours and sky box (with its moving cloud
  layers), and its moving surfaces play as in game: water ripples and flows, and
  scrolling, pulsing and animated textures move, so you see what a player sees. **Full Brightness** (`B`) switches to
  MOHRadiant's flat, fully bright look. The sky is drawn behind everything, as in game;
  **Simple Sky** (`K`) shows MOHRadiant's solid, tiled sky brushes instead, and the
  **Sun flare** (`J`) is drawn the way the game draws it.
* **Lights off** (`0`) turns every light off, or just the selected ones, and **Sun
  light** (`-`) takes the sun and sky out of the baked light, so you can see what each
  light gives the map.
* **Weather** (`Y`): the map's rain and snow, made the way the game makes it in its Rain
  (`func_rain`) brushes, beam limit and all (a map without any falls from its sky instead,
  never indoors), with every setting in the game cvars (speed,
  size, slant, density, shader, the client's frame rate, Allied Assault 1.11 or OpenMoHAA
  behaviour) and presets (`cg_weather snow`, `rain`, `blizzard` ...). `cg_thunder` adds the
  lightning flashes of the game's weather script, and the trees' leaves sway as in game
  (`r_static_shadermultiplier1` for how far).
* **Decals** (`=`): the map's permanent `.dcl` decals (signs, cracks, numbers), lit as
  the game draws them.
* **Leak trail** (`P`): when a map leaks, the compiler's `.lin` trail is drawn through
  walls from the void to the entity it reaches; the place it gets in is worked out and
  marked (the gap's size and the brushes either side), and its card says how to fix it.
* **Level script entities** (Show → Script ents, `Ctrl+E`): what the map's `.scr` (and
  the map scripts it runs) spawns: waypoints and their `target` paths (set in loops
  too), script models and origins, actors, placed where its lines say, with the threads it
  runs read for the entity they run on (a bipod spawned under each gun). The map's stats line opens the list, with
  its `setcvar` and `$world` lines. Scripts are found as the game finds them: a loose
  `main/maps/<map>.scr` before the paks. A trigger the script spawns with a `setsize`
  (also one given through fields of the script's own, `local.t.setsize1 = ( ... )` then
  `local.t setsize local.t.setsize1 local.t.setsize2`) is a small marker under Script
  ents, and **Show → Script trigs** draws its volume, see-through like a trigger brush
  (hidden by the In-game look).
* **Open door** (`O`) opens and closes doors as the game does.
* **Run exploder** sets off an exploder's `#set` as `global/exploder.scr` does: the
  building goes and its chunks fly toward their targets, land and sink away. **Reset
  exploder** puts it back.
* **Simulate**: select an `info_splinepath` and press **Simulate** to fly a model along
  its path the way a script's `followpath` does: from the path's first node, through each
  node's origin, angles (it banks) and `speed`, at the game's own pace. **Choose...** picks
  the model (any `.tik` in the loaded paks, with a search box; a box with a nose until
  one is picked), **Reset** stops it, **Follow** rides along behind it (with **Eye view**
  too, at its own angles, banking with it), and **camera zoom** (or the mouse wheel)
  sets how far behind. Move or edit the nodes in Modify and simulate again to see the change.
  Select an `info_pathnode` (or an `info_waypoint`) instead and the same section stands a
  **Human** (choose any actor model) holding a **Weapon** (any weapon, no grenades) on the
  node, dropped to the floor and facing its angle, idling (**Spawn**). If the node has
  spawnflags (CORNER_LEFT, CORNER_RIGHT, CRATE, SNIPER, DUCK, or Spearhead's and
  Breakthrough's LOW_WALL_ARC), **Simulate** plays the animation the game plays there (wall
  left / right with its sideways lean, crate, aiming, crouching), so you can see whether a
  wall or crate is in the way and move the node. **Move** runs or walks him along the node's
  `target` chain, or to any node, entity or spot you click next, routed over the AI's path
  nodes the way the game routes a soldier (a waypoint is walked to in a straight line), and
  doors open for him as they do for the AI; **Trace path** draws his route. **Pause**, **Fly
  to** and **Follow** (the game's third-person camera) help watch him, and **Respawn** puts
  him back on the node. The human and weapon are built from the paks only when chosen, each
  animation the first time it's needed. Needs the Map Viewer (not a bare browser).
  Select a `func_ladder` and the section climbs it with an unarmed **Human** as the
  player's ladder states do (global/mike_torso.st, with OpenMoHAA's FuncLadder code):
  **Spawn Bottom** stands him where `ladder_down_getoff` leaves a climber at its foot,
  **Spawn Top** where `ladder_up_getoff` leaves him at the top (facing the ladder), **Spawn
  Middle** puts him on it halfway up (for a ladder whose ends go into the floor or
  ceiling). **Simulate Up** walks him at the ladder looking up by the **pitch** box (50
  degrees by default, kept for next time; the game needs more than 35) until he can use it,
  gets him on (`ladder_up_geton`), climbs a hand at a time (`ladder_up_righthand`,
  `_lefthand`...) and gets him off the top; **Simulate Down** the same downwards, looking
  down by the pitch. His body shows the pitch as a player's does (head, spine and pelvis
  share it; on the ladder only the head turns, by half), and a new pitch shows at once on a
  man standing at Spawn Top or Spawn Bottom; after getting off he looks level. He starts up
  to 64 units behind the spawn, as a player walks up to it: at some ladders' tops only a
  steeper pitch gets him on (mohdm7's trench ladder needs 50, not 45). The clips' own
  movement carries him, with the player's box against walls, playerclip and the floor, the
  game's tests for climbing on, getting off the top (98 units of room over him) and the
  bottom (the floor within 40 under him), and its snaps to the ladder. As in the game, each
  clip's last frame holds for one server frame (0.05 s) before the next state starts, and
  each new clip crossblends in over 0.2 s; after getting off he blends into his standing
  idle the same way. Each starts again from the last spawn. When he can't finish (the
  ladder too short or too long, too close to a wall, something in the way, its origin far
  from it) the climb stops and the yellow note says why, with what to change.
  **Pause**, **Fly to** and **Follow** work as for path nodes (Follow's camera pitches with
  him, as the game's third-person camera does: up behind him when he looks down, down when
  he looks up), and **Hide select** (green while on) hides the ladder's red selection
  highlight and its facing arrow so the climb is easier to watch; the ladder stays
  selected, and deselecting it turns Hide select off.
* **Modify** (above Find): add entities, most of all AI path nodes: Add, then click on the
  map where it goes. A new node is drawn
  see-through until saved, its parameters edit as entity-lump text (applied as you type),
  **Move** picks it up again with the mouse, **Trim origin** nudges it with W A S D / the arrows by a trim step of 1 to 50 units
  while the camera stays put (white arrows out of its sides, red the way it just went; a
  door or other brush entity's from round its brushes, faint where a wall is in front),
  **angles** (under trim step) shows the selected entity's pitch, yaw and roll to type over
  (Enter sets them on every selected entity), with **⟳ Rotate** (a circle facing you: drag
  inside it, Shift tumbles) and **⊕ Axes** (X, Y and Z rings: drag one) to turn them with the
  mouse, each about its own origin, in whole degrees (Ctrl: 15s), one Undo per drag; a path
  node or other info_ entity (not info_splinepath) turns on its yaw only (pitch and roll
  off, one flat ring), its box staying as it is while its arrow turns; and **AI routes** show its links as soon as it is placed,
  worked out the way the game builds its `.pth`. **Save as .bsp** writes a copy of the
  map with the new entities and a new `map_time`, so the game rebuilds its paths; it
  never writes over the original. Both saves are quick saves, not compiles: Save as .bsp
  changes only entities and path nodes (it is off once Edit map has changed a brush, patch
  or terrain), and Save as .map writes the text, which Compile... (Edit map) builds into a
  .bsp. **Save as .map** and **Copy** are there too. Closing the
  viewer with Esc (or File > Close file), or opening another map, while changes aren't
  saved asks first: Save as .bsp, Save as .map, Discard changes or Cancel (Cancel keeps
  this map open; the other one opens after a save or a discard). Selecting one of the map's own point entities (a broken
  path node, say) lists it in Modify too, to edit, move or trim it the same way, or to
  **Delete** it from the saved copy (marked DEL until you save; Restore or Undo puts it
  back). **Spawnflags** ticks the selected entity's spawnflags from its class's list (for
  a path node DUCK, COVER, CORNER_LEFT, CRATE ...). **Make path**
  sets the selected entity's `target` by clicking the next one (waypoints, spline paths,
  script origins), drawn as a target link. **Grid** (+) draws a see-through 3D grid of MOHRadiant's sizes (1 to 512)
  that Add and Move snap to.
* **Game cvars** (`` ` ``): the game's debugging cvars, working in the page:
  `r_showtris`, `r_farplane`, `ai_showroutes` (from the map's `.pth`, or worked out when it has none: only once AI routes or another `ai_show...` cvar is turned on, or a Simulate run needs them, never just for selecting a node or editing an entity), `sv_showentnums`,
  `sv_showbboxes`, `g_entinfo`, `r_lightmap` and more; Reset at the top of the list sets them all back.
* **MOHRadiant-style filters** (`Alt+1` … `Alt+0`, `Ctrl+D / H / M / R / T / P / K`) for
  caulk, clips, triggers, hints, AI nodes, lights, details, terrain, sky and more, with
  **In-game look** and **Editor look** presets, plus setsize boxes, target arrows,
  labels, X-ray, fog and cubic clipping.
* **Legend** (`L` in the viewer, `F2` / Help → Legend in the launcher): what every
  colour, marker, path-node border and editor brush (clip, trigger, hint, vis,
  areaportal...) means.

**Moving and finding**

* **Two cameras:** Free-look (the Model Viewer's WASD fly, with `Q` / `E` tilt) and
  **Radiant-look**, which flies with MOHRadiant's own keys and right-drag. `V` switches
  between them.
* **Click anything:** a face, brush, patch, model or entity. `N` or `Ctrl+click` opens
  its card: every key, origin, angles, targets and targetnames, spawnflags, the
  `setsize` (taken from its brushes for triggers and doors) and ready-to-paste script
  lines. `Alt+click` selects everything of the same kind, `Ctrl+Alt+click` a whole path
  (a node's `target` chain, before and after it), and `Ctrl+Shift+click` shows a face's
  texture. The Selection panel's **Same spawnflags** selects every entity of that class
  with the same spawnflags (every CRATE node, say), and **Same error** every path node
  with the same AI path problem (no paths, one-way, no angle, 48 paths full ...).
* **Find** any class, targetname, key or texture (`Ctrl+F`), with `"exact"`, `$targetname`,
  `key: value`, `entity 25`, `( x y z )` and `-term` searches, or browse every class and
  texture the map uses; Shift+click a green (selected) row to deselect just that row.
  It searches what isn't saved yet too: a map entity changed in Modify or Edit map (a
  targetname set in Class specs, say) by its keys as they are now, tagged **edited**
  (**deleted** for one deleted there), and Modify's new entities, tagged **new** (a click
  selects one in Modify and flies to it).
* **The world's keys** (`$world`, the worldspawn: entity 0 in the `.map`, entity number 1022
  in the game): hold the mouse over the stats line under the map's name ("decompiled from
  the .bsp", or "$world: N keys" for a `.map`) to see them all, and click it, its row in
  the class list, or Find `world`, `$world` or `entnum: 1022`, for its card: what each key
  does (`suncolor`, `sundiffuse`, `ambientlight`, `farplane`...) and a box to change, add
  or remove them. Nothing is selected for it. The changes go with Save as `.bsp` / `.map`
  and with Compile (only the key lines of its block: its brushes and terrain stay); the
  lighting keys change the game's look once the map is compiled with light.

It uses the same Python and packages as the Model Viewer, and both can be open at once.
Press `H` in the viewer or `F1` in the launcher for every shortcut.

**Planned:** following more of what a level script does as it runs (moving and removing
the map's own entities).

## Map Viewer screenshots

![Map Viewer: full launcher view of a map and its right-side panel](screenshots/map5.jpg)
![Map Viewer: another full launcher view of a map](screenshots/map6.jpg)
![Map Viewer: a path node's info card in the Editor look](screenshots/map2.jpg)
![Map Viewer: a landing craft in the In-game look, with entity labels](screenshots/map4.jpg)
![Map Viewer: the legend of brushes/entities 1](screenshots/legend1.jpg)
![Map Viewer: the legend of brushes/entities 2](screenshots/legend2.jpg)
![Map Viewer: the legend of brushes/entities 3](screenshots/legend3.jpg)

# Edit animations (in the Model Viewer)

Make new animations for the game's human characters, or change the ones they have, and
add them to the game.

In the Model Viewer, turn on **View → Edit animations** (or the **✎ Edit animations**
button beside Help, or `Ctrl+Shift+E`). An Animation Editor panel appears in the open
page straight away (nothing is rebuilt or reloaded), and every model opens with it until
you turn it off (the choice is kept with your settings). Load your `.pk3` archives, open a human `.tik`
or `.skd`, and start an edit from the selected animation, the neutral A-pose or the pose
the model opened in.

Pose the frame shown with one of three tools (the hint under them says what a drag will do,
and pointing at a joint shows it too):

* **✋ Drag** (the default): drag any joint and it follows the mouse across the screen,
  whichever way the camera faces (looking from the front it goes left / right and up /
  down; from above, left / right and forward / back). What moves depends on the joint:
  * the **hips, pelvis or lower spine** move the **whole body**. With **feet: stay
    planted** the feet keep their place and the knees bend: crouch, kneel, lean, sit;
  * a **foot** (or the knee or thigh) moves the foot, and the leg bends to reach it. The
    game itself works the legs out from the feet, so a knee can't be posed on its own;
  * a **hand, the head or any other joint** is pulled to the mouse by bending the bones
    above it: a hand bends the forearm and upper arm, the head bends the neck and spine
    (**pulling a joint bends** sets how many bones above it, or auto);
  * **weapon tags** (tag_weapon_left / right) move.
* **⟳ Rotate**: click a joint to select it, then drag inside the dashed circle round it
  to turn it about the line you're looking along; hold **Shift** to tumble it instead.
  Select **Bip01** (the hips) to turn the whole body: with **feet: move with the body**
  it turns as one piece, for flips, falls, lying down or a hand-stand.
* **⊕ Axes**: exact turns about the bone's own X / Y / Z (rings) or moves along the
  model's X / Y / Z (arrows).

Every tool works on **this frame** or on **every key** at once (each key from its own
pose: lower or turn a whole animation). Pick a bone from the list as well as in the view;
grey ones are posed by the game from the others. For the selected bone you can type its
turn (degrees about X, Y, Z from its parent; a foot's facing) and its place, **Reset bone**
to the pose the model opened in, or **Copy from other side**. **Mirror pose** swaps left
and right for the whole body. Undo / Redo go back 60 steps.
* **Timeline.** Set keys on frames; the frames between keys are filled in from the keys
  either side. Copy and paste a pose or one bone's channels, and set the frame count and
  frames per second.
* **Save .skc...** writes a standard `.skc` animation file (default folder
  `skc` in the Model Viewer's built-pages folder, at first `output/models/skc`), keeps the old file as `.bak`, then reads it back and checks
  every value.
* **Add to game...** gives a saved animation a name and puts it in
  `output/models/mod/zzz_mohaa_custom_anims.pk3`. Copy that pak into the game's `main`
  folder and every human in the game can play the animation by that name. The name must be
  new (no human `.tik` may already use it). Adding the same name again replaces it.

Limits: human (Bip01) animations only, and only files saved in the same session can be
added to the game. Every model page carries the editor, so turning Edit animations off
just hides the panel and the skeleton handles; an edit in progress is still there when you
turn it back on.

# Edit map (in the Map Viewer)

Change a map, or start a new one.

In the Map Viewer, turn on **View → Edit map** (or the **✎ Edit map** button beside Help,
or `Ctrl+Shift+E`). The open page shows an **Editor** section at the top of the panel
with **Modify** under it straight away (nothing is rebuilt or reloaded), and every map
opens that way until you turn it off (the choice is kept with your settings): everything Modify does (add, move, trim, delete and change entities,
path nodes and their AI routes, unlimited Undo, Save as `.bsp` / `.map`) works the same
way here.

* **New map...** (File menu, Ctrl+N, which turns Edit map on, or the button in the Editor section) writes a starter
  `.map` where you choose (at first `output/my_maps/`): a sealed 512 x 512 x 256 room with
  a concrete floor, stone walls, a plank ceiling, a player start, a deathmatch start and a
  light. The file is read back and every brush is rebuilt from its planes to check it
  closes, then it opens in the editor.
* **Doors, triggers and other brush entities**: click one and it gets a row in Modify,
  so you can change its keys or class, move it (Move, Trim origin, or an exact origin in
  Edit parameters), delete it, and undo. Saved as a `.bsp` it moves the way the game moves
  it (its origin); saved as a `.map` its brushes themselves move, with their textures kept
  in place.
* **Level script...** opens the map's `.scr` (beside the map file; a starting script when
  there is none) in a box over the view. Save writes it (the old one kept as `.bak`) and
  builds the page again, so what the script spawns is redrawn; the camera and Modify's
  unsaved work come back with it. Maps opened from the paks: save a copy first, then open
  the copy.
* **Building in the view.** The Editor section's tools work with the mouse in the 3D view,
  much as MOHRadiant's do in its 2D views. Everything snaps to the grid (the Grid slider,
  8 at first), is shown as outlines while you drag, and is written on release as one
  Undo step (Modify's Undo, Alt+Z):
  * **▭ Draw brush**: drag on a floor, wall or ceiling to draw the outline on it, let go,
    move the mouse to set the height, click to make it (Esc or right-click cancels).
    **Shape**: a box, a 3- to 16-sided prism, or curved patches: a cylinder or pipe, a
    cone, or a pipe bend (a quarter elbow). It gets the texture in the Texture box
    (**Browse...** picks one from the map or your paks; the list beside it has the tool
    textures: caulk, hint, vis, skip, clip, playerclip, nodraw, trigger, origin and more).
    **▭ Draw any axis** (beside *in entity*; click for **Draw XY**, **Draw XZ**, **Draw YZ**):
    any axis draws on the surface under the mouse, a slope too (the outline lies on the
    slope and the brush stands square on it); XY always draws flat, XZ and YZ upright
    (facing y or x), through the point clicked, then the mouse sets the depth.
  * **⇕ Resize**: drag a face of a brush to pull it out or push it in, along its own
    direction. The brush's corners show as white crosses: drag a **corner** or an
    **edge** to reshape the brush freely (it stays a closed, convex brush; the faces keep
    their textures). On a patch, drag any **control point**. These drag across the floor;
    hold Shift to drag them up and down. The face under the mouse (the one a drag pulls),
    or the corner or edge a drag would take, is outlined in green.
  * **✥ Move**: drag a brush, patch or terrain block across the floor; Shift+drag moves it
    up and down, Alt+drag makes a moved copy, and Shift+click (no drag) adds a brush to the
    selection or takes it out, without going back to Select. Move and Resize go in single
    units, or in the grid's size with Grid on. Under Region, Move and Resize have
    copies of Modify's **trim step** and Display's **grid** (Grid XY / XZ / YZ / all, its size and
    **Grid +** on / off), Draw brush and Clip the grid ones: the same settings, moved either
    place. **✥ Trim / ⇕ Trim** (beside Region, with Move
    or Resize): W A S D / arrows and Space / C nudge the selected brushes by Modify's trim
    step (Resize: push out the face that faces that way, Shift+key pulls it in), the way to
    stretch a brush too thin to grab, like a ceiling wire. A selected patch (a pipe or wire,
    such as `general_industrial/ge_wires_para`) is made longer or shorter along itself by
    the key that points along it: its end goes out, the points between follow evenly (a
    sag stays) and the texture keeps its size; Shift+key shortens that end (Shift+A the left
    one, Shift+D the right). While Trim is on, a grey note above the tool's help lists the
    keys. Holding a key keeps going: the steps its repeats ask for are done together once a frame, so the selection grows as you hold it, however big the map. Esc or T stops, one Undo for it all. As Modify's trim, white arrows stand out of the selection's sides (Resize: each
    brush's sides that a key pushes) and turn red as a key moves it that way (cyan as
    Shift pulls in); a big side gets a few, tiled from its middle, and they grow with
    distance so a giant brush shows them from far away. The camera keys stay still. **Delete** (the key, or the button beside the selection) deletes the selected
    brushes, patches and terrain blocks; a brush entity whose every brush is selected is
    deleted as Modify deletes it. Press on a brush that is part of a bigger
    selection and the whole selection moves (or is copied) together; an entity whose every
    brush is selected takes its `origin` key along. Texture lock keeps the textures in place.
  * **Selecting brushes of a brush entity**: with the editor on, a click picks the one brush
    under the mouse (a door apart from its `common/origin` brush) and Shift+click adds or
    takes away single brushes. Modify still shows the entity's row (its keys, its Move as a
    whole). Selecting every brush of an entity counts as the entity: Copy makes a new one.
  * **Copy (Alt+C)**, with any tool: the selected brushes, patches, terrain blocks and
    brush entities (Shift+click selects more) follow the mouse, their middle under it and
    their bottom on the surface it is over, on the grid, until a click puts them down; a
    drag still turns the camera, **Esc** or Alt+C again takes them away. Brushes go into
    the entity they came from; a brush entity becomes a new entity, without its
    `targetname` or `target`. One Undo (Alt+Z) takes the whole copy away. Brushes and
    entities (path nodes, spawns ...) aren't copied at once: with only entities selected,
    Alt+C is Modify's Copy.
  * **✂ Clip**: click the brush, then two points: it is cut along the line between them
    as you see it on screen (a third point tilts the cut). **Enter** cuts, **Shift+Enter**
    splits it into two brushes, **Tab** keeps the other side. Cuts make any shape: bevels,
    wedges, stairs, roofs. Ctrl+click picks another brush.
  * **▦ Texture**: click a face to give it the Texture box's texture (Shift+click: every
    face of the brush; patches and terrain patches too). **Alt+click** takes the texture
    under the mouse into the box. **Ctrl+click** picks a face, then **Fit** (once across
    the face), turn ⟲ ⟳, flip, shift, scale up or down, or **Natural** (reset).
  * **Eyedropper** (the pipette button beside *- tool textures -*, with any tool): click
    it, then click any surface in the view (a brush face, a patch, a terrain patch or a
    `.bsp`'s own surface) and its texture goes into the Texture box, then the **▦ Texture**
    tool comes on (terrain *paint texture* stays on) so each click lays it. A drag still
    turns the camera; **Esc** or the button again cancels.
  * **The Texture box follows the selection**: selecting a brush, patch or terrain block
    puts its texture in the box (the face clicked, else the brush's most used texture).
    A texture chosen with **Browse...**, *- tool textures -* or the eyedropper goes on what
    is selected too: every face of a brush, a patch, or every patch of a terrain block
    (one Undo). With the **▦ Texture** tool or terrain *paint texture* on, the box is the
    paint and stays as you set it.
  * **Angles** (above Exact values, with brushes or patches selected): a turn typed in as
    pitch, yaw and roll, then **Turn**; or with the mouse: **⟳ Rotate** draws a circle round
    the selection facing you (drag inside it to turn it about the line you look along,
    Shift+drag tumbles it), **⊕ Axes** three rings for the world's X, Y and Z (drag one to
    turn about it). Whole degrees, Ctrl for 15s; the angles show the turn as you drag, and
    letting go makes it (one Undo, Esc cancels). They turn about the selection's middle; an
    entity with all its brushes selected turns its origin key too. Terrain blocks don't turn.
  * **Tiling** (under Texture, with a brush or terrain block selected): its texture's scale,
    rotate and shift, on the face clicked (else every face) or every terrain patch; **Set**
    lays them. The eyedropper takes a surface's tiling with its texture and gives both to
    the selection, to match a neighbour, also when the selection has that texture already.
    With the Texture tool (or terrain paint), what the eyedropper or an Alt+click took is
    laid with its tiling by each click.
  * **Classname** (under Texture): what the selected brushes are. **Browse...** lists the
    brush entity classes (`func_rotatingdoor`, `script_object`, `trigger_multiple` ...);
    typing one and Enter does the same. Brushes or patches of the world become one new
    entity of that class, moved into it (a door also needs a `common/origin` brush where
    it turns: Draw one with *in entity* ticked while the door is selected). A brush entity
    selected just gets the new class, as a key change, so **Save as .bsp** keeps it
    without compiling. Point entities' classname is in Modify's Edit parameters.
  * **Entity [list] Move into** (under Classname, with brushes of an entity selected): the
    selected brushes and patches go into the entity picked in the list, out of the ones
    they are in now, as MOHRadiant's move into entity. Select a door's brush, Shift+click an
    origin brush (a copy of another door's, say), pick the door and **Move into**: the door
    then turns about that origin brush. Picking *the world* takes brushes back out of an
    entity. No entity is left with no brushes, and terrain stays in the world; one Undo.
  * **Class specs** (below Exact values, with one brush entity's brush selected): its
    **targetname** first (the `$name` the level script and other entities' `target` call it
    by; no spaces, a leading `$` is dropped), then every key its class takes from the map, by class (a `func_rotatingdoor`: RotatingDoor's
    `openangle`, then Door's `doortype`, `time`, `wait`, `angle`, `alwaysaway`, the
    sounds...), and under *more* the general ones from ScriptSlave, Trigger and Entity.
    Bold keys are set on the entity; type a value and Enter sets it, empty takes it away
    (a key change, so Save as .bsp keeps it; Undo puts it back), and Open door uses it at
    once. **SH** / **BT** mark keys only Spearhead / Breakthrough have. Under it,
    **Edit parameters** opens Modify's editor on all of the entity's keys as text, and
    **Delete** deletes the whole entity (for a lone brush, patch or terrain block, Delete
    stays beside the selection's line). A door that opens
    to one side only usually needs the `angle` its neighbours have (Door::SetDir turns its
    direction from it), and `doortype metal` makes it take 1.5 s instead of 1. The same
    list, with the values set, is in the entity's (and its brushes') More info. Every
    brush class gets it: a trigger's own list is Trigger's (`setthread`, `wait`, `delay`,
    `message`...), a `func_ladder`'s is its `angle`.
  * **func_ladder**: its `angle` is the way a climber looks at it (FuncLadder's
    SetLadderFacing). More info has a Ladder part (which way it faces, its 52-unit reach,
    that its brushes become ladder contents, never drawn), and with Arrows on, while it
    is selected, a facing arrow at its foot shows the way a climber faces it (from where he
    stands to the ladder); the arrow follows a new `angle` at once.
    Giving brushes a class with Classname says what that class still needs (a rotating
    door's origin brush, a ladder's or sliding door's `angle`...).
  * **▲ Terrain**: click a terrain triangle to cut it away (or click a cut one to fill it
    back); drag across to do many. Each square of terrain is two triangles and the game
    keeps either one on its own, as the original maps do where terrain meets a trench wall.
    **Raise / lower** (press and drag up or down), **flatten** and **smooth** shape the
    ground round the spot within the radius chosen. **Paint texture** gives a terrain
    patch (512 x 512) the Texture box's texture. **Draw a new block**: drag out an area
    (whole 512-unit patches on the 64-unit grid); with *meet the terrain round it* ticked,
    its edges take the heights of the blocks next to it and its inside is blended between
    them, to fill a gap in the ground. The Terrain tool reaches terrain behind clip and
    other brushes.
  * With a **terrain block** selected: **Join edges** gives its edges the heights of the
    neighbouring blocks' edges (no gaps or steps), **Fit to neighbours** also blends its
    inside.
  * With a **patch** selected (Select or Resize): **+rows / −rows / +cols / −cols** add or
    remove control points without changing the shape, **Cap ends** closes the open ends
    of a pipe, cylinder or cone, and **Thicken** adds a copy pushed back by the amount
    given, facing the other way, with strips joining their edges (a slab, wall or tube).
  * **Region** (in the Editor section): select something, then Region draws only what lies
    within the margin chosen round it, as MOHRadiant's Region does, so a corner of a big
    map is quick to work in. Click it again to see the whole map.
  * **Exact values** (folded under the tools) still types every number: sizes, corners,
    face planes and textures, patch control points, terrain heights, holes over a range.
* **New and changed geometry stays in sight until it is saved**, as Modify's new entities
  do: a brush, patch or terrain block you add, move or resize is outlined in amber, drawn
  and clickable even when a Show button hides its kind (a caulk cube with Caulk off), and
  its More info card says it is new and not in the map's file yet. Once Save as `.map` or
  Compile writes it, it is one of the map's own again (and follows the Show buttons).
* **Changed geometry shows without the baked light** (the view draws the map as a `.map`
  until it is compiled again), and Save as `.bsp` stays greyed after a brush, patch or
  terrain change (a `.bsp` holds its brushes compiled). The changes are kept by Modify's
  recovery file, and Save as `.map` keeps them to carry on later.
* **Compile...** (on the page, File > Compile map..., or F9) builds a `.bsp` from the map
  **as you see it, changes included**, whether you opened a `.bsp` or a `.map`. Its window
  has what MBuilder offers:
  1. **Full: bsp + vis + light** (for playing), **Quick test: bsp + fast vis + light**,
     **bsp only** (for the viewer only) or **map file only** (the `.map` written, nothing
     compiled). Hold the mouse over each for what it does, roughly how long it takes, and
     how long it took last time. What a choice doesn't use is greyed out (Quick test: the
     vis switches fast vis ignores), and a box with nothing left that applies is hidden:
     bsp only shows BSP (and MAP), map file only MAP alone.
  2. Each step's switches (hold the mouse over one for what it does). **BSP**: verbose, no
     curves, no detail brushes, no hint brushes, entities only (the entities written into
     the `.bsp` compiled before: seconds, for lights, spawns or triggers changed), detail as
     structural. **VIS**: verbose, passage vis only, merge leafs, vis groups skip the work,
     ignore the farplane, **Vis groups** (on) and **Cap the work per portal** (on).
     **LIGHT**: verbose, extra detail, no shadows, and **Sun scale** (ticked, 0.82: the game's own
     maps were lit darker than MOHTools' light step lights them, and 0.82 comes closest to
     them; unticked or 1 lights as MOHTools does). Each step also has a box for more
     switches (hold the mouse over it for the compiler's others: `-threads`, `-samplesize`,
     `-point`, `-nogrid`...). **MAP** (scroll right, or on its own with map file only): the
     world's keys as `"key" "value"` lines to change, delete or add (its list adds a key),
     written into the `.map` the `.bsp` is built from; `"sundiffuse" "1"`, say.
  3. Where the `.bsp` goes: a folder you choose (one you will pack into a `.pk3`, say), or
     straight into the game's maps folder for its gametype: `maps` (single player),
     `maps/dm` (deathmatch, team, round based) or `maps/obj` (objective). The `.map` it is
     built from is written beside it with the same name, so you can open it later and carry
     on. Nothing is written over the map you opened, over a `.map` or a `.bsp` that Compile
     didn't write, without asking (the old one is kept as `.bak`).
     Compiling to the same folder and name as the `.map` you have open (with changes it
     doesn't have yet) asks what to do: **Yes, and close the map** or **Yes, and re-open
     the map** write your changes over it (the old one kept as `.bak`) and close it or open
     it again once the compile is done; **No, write as .map.bak** keeps the
     open `.map` as it is, puts your changes in `<name>.map.bak` and builds the `.bsp` from
     them; **Cancel** does nothing. **Map file only** asks the same over the open `.map` (nothing
     compiled: the `.bak` choice just writes your changes there), and **Replace it?** over
     another `.map` already there.
     Beside the `.bsp` go the files EA's Q3map leaves there too: the `.prt` (portal file,
     sealed maps; the game reads it for `r_showportal`), or the `.lin` leak trail when the
     map leaks (the old one of either is removed first, so a fixed leak's trail doesn't
     stay), and the `.vis` (the visibility on its own). The `.dcl`, `.pth` and `.min` are
     the game's own: its decal editor writes the `.dcl` (after a compile the game ignores
     its decals until you re-save them in the game, since the map's `map_time` changed),
     it rebuilds the `.pth` (AI paths) itself, and the `.min` is its loading-screen info.
  4. **Start the game with the map when it's done**, as MBuilder does: the game in the
     folder the paks were loaded from (asked for once, if it isn't found there) starts with
     the command line given (developer, cheats, the console and `logfile 2` by default:
     `qconsole.log` written line by line, so a crash doesn't lose its end), the gametype
     and `+devmap` with the map, exactly as a shortcut's target or a command prompt would
     pass them (`"quotes"` for a value with spaces), in the game's own folder. The window
     shows the program it will start; **Browse...** picks another (or the one it couldn't
     find), kept for next time. Off Windows, `MOHAA.exe` is started through Wine.

  The compile runs in the background (its lines and each step's time in the Output pane),
  then offers to open the new `.bsp`, with its baked light. **Shift+Esc** (in the launcher or
  on the page) or F9 again stops it, after asking: no `.bsp` is written, and the `.map` it
  wrote to build from is put back as it was (removed if it made it; the `.map` you have open
  is kept). A question that comes while the window is minimized (the compile finishing)
  waits until you restore it, its taskbar button flashing.

  **Full vis in minutes, not hours.** On an open map (a beach, a town) full vis has to
  follow every path each portal might see through, which is why MBuilder can sit at 99% all
  night. Two things keep it short here:
  * **Vis groups**: the game's own maps mark areas that never see each other with
    `vis_leafgroup` entities. A `.bsp` keeps only their brushes, so a decompiled map has
    lost them; Compile puts them back on its copy of the map from the original `.bsp`'s
    vis, and the compiler leaves those areas out of what the game draws, as EA's does.
  * **Cap the work per portal** (100,000 steps by default): a portal that has used up its
    steps counts everything its paths might still see as seen, so it can only see more than
    it would have, never less: the game draws a little more (on m3l1b, 12% more than a full
    vis run to the end). On m3l1b (Omaha's bunker) full vis took under 3 minutes on two CPU
    cores, against more than 9 hours in MBuilder without finishing. Untick it to run vis to
    the end, as EA's compiler does.

  The compiler is built in (ommap, from OpenMoHAA's code, made to write `.bsp` files as the
  game's own compiler does, checked against it on the same maps): static props get their
  models' collision brushes from the paks so they are solid in the game, light bakes the
  map's lights and the sun and sky into lightmaps and the light grid, lights the static
  props vertex by vertex, and terrain is compiled with its holes. If the map leaks, the Output pane says so and a red line on the
  page runs from the void to the entity it reached.
* Saving works as in Modify: Save as `.map` and Save as `.bsp` always write a new file,
  never over the map you opened.

Every map page carries the editor, so turning Edit map off just hides the Editor section
(Modify goes back to its place) and stops brushes, patches and terrain being picked for
editing; changes already made stay and still save and undo. A `.bsp` / `.map` dropped on
the RUN file opens with Edit map as you last left it.

# Updating

As soon as either launcher starts, it compares every program file in its folder
with the same file in this repository (by the fingerprint GitHub lists for it, not just the
version number), so new files on GitHub and changed ones are both found. If anything
differs, an update window opens with the list in a scrolling box: each file marked **new**,
**changed** or **removed**, ticked (click one to untick it and keep your copy). **Download**
installs the ticked files, **Cancel** leaves everything as it is. When nothing differs, the
Output pane just says so; offline, nothing is shown at all. **Help → Check for updates...**
runs the same check at any time (with **Close** when up to date), and **Help → Check for
updates at startup** turns the startup check off for both programs. The two viewers are
updated as one program, since they share the folder: whichever one finds the update
installs every new or changed file, the other viewer's included. Your settings and built pages in `output/` and the packages in
`bin/libs*` are left alone.

After an install, the Output pane lists the full path of every file added, updated or
removed, and the folder holding the previous copies; **Restart now** loads them (a file in
use when it was written finishes installing on a restart, which happens by itself). A file
you changed yourself after an update is told apart from one changed on GitHub
(`output/update_manifest.json` keeps each file's fingerprint as installed) and is kept.
When that record can't tell (the file was changed here before any check saw it, as with
work not pushed to GitHub yet), the file's time here is compared with when GitHub last
committed it: a file saved here after that is yours and newer, so it isn't offered (the
update window and the Output pane say how many, and the log names them).

In a Git clone (the folder has `.git`), the update also moves the branch to the commit it
installed (`git fetch origin`, then `git reset --mixed` to it: the files on disk are left
as they are), so `git status` shows only your own changes and a later `git push` needs no
pull first. It does this only when the clone has no commits of its own that GitHub lacks;
otherwise, or without Git on PATH, the Output pane says what to run instead.

The update is checked before anything changes: the download (a zip of exactly the commit
that was checked) must be undamaged, and every file must match GitHub's fingerprint for it.
Every file it replaces is copied first to
`output/previous-versions/<n>/` (one numbered folder per update, listed in
`output/previous-versions/changelog.txt`), and if any file can't be written, the files
already replaced are put back and the update reports what failed. Files the new version
no longer has (such as the old per-program RUN launchers, now one `MOH Model-Map Viewer`
file per system) are copied there too, then removed. To go back a version,
copy a numbered folder's contents over the program folder.

# Where Your Files Go

| | Model Viewer | Map Viewer |
|---|---|---|
| Settings | `output/mohaa_viewer_config.json` | `output/mohaa_map_viewer_config.json` |
| Console log | `output/output_console.log` | `output/output_console_map.log` |
| Built pages | `output/models/`, mirroring the pak's folders; files opened from disk go to `output/standalone/` | `output/maps/`, with each decompiled `.map` beside its page; files opened from disk go to `output/maps_standalone/` |
| Scratch space | a `mohaaview_*` folder in your system temp folder | a `mohaamap_*` folder in your system temp folder |
| Program logs | `output/logs/mohaa_launcher.log` and `mohaa_view.log` (page builds) | `output/logs/mohaa_map_launcher.log` and `mohaa_map_view.log` (page builds) |
| Settings backups | `mohaa_viewer_config.json.bak` beside the settings | `mohaa_map_viewer_config.json.bak` beside the settings |
| Unsaved Modify work | | `output/modify_recovery/<map>_<hash>.json`, offered back when the map opens again; cleared by a save or Discard changes |
| Previous versions | `output/previous-versions/<n>/` (written by an update, shared) | (same) |
| Update record | `output/update_manifest.json` (each program file's GitHub fingerprint as installed, and the check-at-startup choice; shared) | (same) |
| Python packages | `bin/libs` (Windows), `bin/libs-linux` (Linux), `bin/libs-mac` (macOS), shared | (same) |

Edit animations and Edit map use their viewer's settings, logs and folders; what they add
(saved `.skc` files, the mod pak, New map's `output/my_maps/`) is in their sections above.

`output/` is the folder next to `bin/` (in a flat / portable install, the scripts' own
folder). The built-pages folder can be changed under Options. On Windows, the embedded
pane also keeps its browser files in `output/webview2/`.

The logs are a timestamped record of what each part did, including every error with its
technical details (each file is capped at 2 MB, with five older copies kept). **Options →
Open log folder** shows them; please attach the relevant one when you report a bug. The
console log keeps the previous launch's copy with `.prev` in its name.

Settings are saved safely: each save keeps the previous file as `.bak`. If a settings file
is ever damaged (or hand-edited with `C:\...` paths, which JSON can't hold), the program
repairs it, or restores the `.bak`, or sets the damaged file aside as `.corrupt-<date>`,
and says which in the Output pane. **Options → Reset settings...** forgets every saved
choice, including the pak list the two viewers share (keeping `.bak` copies), and restarts the program.

**File → Clear built models** (or **Clear built maps**) and **Clear %temp% files** remove
the built pages and the scratch space. Clear built maps deletes only the pages and `.map`
files the Map Viewer wrote: a decompile never replaces a `.map` of your own (it's saved
as `<name>_decompiled.map` instead).

# Privacy & Security

**Neither program collects or sends anything.** No telemetry, no analytics, no crash
reporting. Everything happens on your machine.

They use the network only for updates: at startup (unless you turn it off under **Help →
Check for updates at startup**) and from **Help → Check for updates...**, they read this
repository's file list and version file from GitHub, sending nothing but the program's
name and version, and download newer files only when you click Download. (The
RUN files also install missing Python packages from pypi.org into `bin/libs*`, and on
Windows the Python installer they offer downloads Python from python.org if you say yes.) Full
notice: [`PRIVACY.md`](docs/PRIVACY.md), or **Help → Privacy & Legal** inside either
program.

`.pk3` files are ordinary ZIP archives, and downloaded ones, like downloaded maps, should
be treated as untrusted input. Both programs are hardened accordingly: archive paths are
confined to their workspace, model and `.bsp` headers are bounds-checked, parsers are
protected against decompression and expansion bombs (oversized images included), Pillow
older than the 10.3 security floor is refused, and generated pages escape game-file text
and carry a restrictive Content-Security-Policy.

Found a hole? See [`SECURITY.md`](docs/SECURITY.md). **Please report privately, not in a
public issue**, and please don't attach copyrighted game assets to reports.

# Licence & Legal

Released under the **GNU General Public License v2**; see [`LICENSE`](LICENSE).

Engine behaviour is verified against [OpenMoHAA](https://github.com/openmoh/openmohaa),
which is GPLv2. [`THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) explains that
relationship and lists every dependency's licence.

*Medal of Honor* and *Medal of Honor: Allied Assault* are trademarks of their
respective owners. This is an unofficial, non-commercial fan project. It is
**not affiliated with, authorised, sponsored or endorsed by Electronic Arts Inc.**
or any other rights holder. Those names are used only to identify the game whose
file formats these tools read.

**No game assets are distributed with this project**, and none may be committed
to it. You must supply your own copy of the game. Do not redistribute extracted
game content. A decompiled map still belongs to whoever made it: don't publish one
without its author's permission.

# For Developers

Project notes live in [`docs/changelog/`](docs/changelog/README.md): the
[changelog](docs/changelog/CHANGELOG.md), an
[architecture overview](docs/changelog/project-overview.md) with known issues,
the [development workflow](docs/changelog/development-workflow.md),
[engine notes](docs/changelog/engine-notes.md), a reference of every
[emitter command](docs/changelog/emitter-commands.md) the Model Viewer supports, and
the [Map Viewer notes](docs/changelog/map-viewer.md): the decompiler, the page, the
game's lighting, the cameras and known limits, with notes on
[doors](docs/changelog/doors-notes.md) and the
[game cvars](docs/changelog/game-cvars-candidates.md). The source code cites the exact
OpenMoHAA files and lines it follows. How the code is hardened (logging, atomic writes,
settings recovery, the vendored packages, the updater) and the decisions behind it are in
[hardening notes](docs/changelog/hardening-notes.md).

Checks to run before shipping, from the project folder (they need tkinter):

```sh
python tests/test_hardening.py      # regression tests for the hardening pass
python tests/check_batch_files.py   # CRLF, no ">" inside quotes, a single pause
python tests/check_privacy_sync.py  # PRIVACY.md = PRIVACY_TEXT = _PRIVACY_SWAPS
python tests/check_init_attrs.py    # MapApp.__init__ keeps up with App.__init__
python tests/test_map_actor.py      # Simulate's actors (set MOHAA_GAMEFOLDER for real-data tests)
python tests/fuzz_parsers.py bin 1  # corrupted-input fuzz of every file parser
python tests/test_skc_write.py      # the .skc writer (also takes .skc / .pk3 files to round-trip)
python tests/test_map_editor.py     # Edit map: New map's room and check, the editor in every page
python tests/anim_solver_parity.py --models <folder holding models/>   # the page's pose solver vs Python's
```

# Contact & Credits

Bugs, questions and suggestions: [open an issue](https://github.com/searingwolfe/mohaa-model-viewer/issues).
Security problems: report privately as described in [`SECURITY.md`](docs/SECURITY.md).

Made by **Searingwolfe**.

Engine reference: the [OpenMoHAA](https://github.com/openmoh/openmohaa) project. <br>
Map decompiling approach: wfowler1's [BSP Decompiler](https://developer.valvesoftware.com/wiki/BSP_Decompiler_005) (LibBSP). <br>
Without the game's raw code, matching the original renderer would not have been possible.
