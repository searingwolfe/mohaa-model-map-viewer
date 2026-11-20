# Map Editor

The map editor changes a map or starts a new one. It is a mode of the Map Viewer, not a
program of its own: **View → Edit map** (the **✎ Edit map** button beside Help,
`Ctrl+Shift+E`) turns it on or off, the choice is kept in the Map Viewer's settings
(`editor_mode`), and the open page switches in place: every map page carries the editor's
code, dormant, and `setEditorMode(on)` (run in the page by `App._editor_set`; `#edit=1`
in the URL a page is opened with) shows or hides the Editor section, moves Modify under
it or back, and turns the editor's picking and marks on or off. Nothing is rebuilt or
reloaded. The Model Viewer's **Edit animations** works the same way. With it off the
window is the Map Viewer exactly, but for changes already made, which stay and save. (It began as a fourth program behind the RUN
menu with its own settings, logs and folders; those were folded into the Map Viewer.)

## Files

| Path | Role |
|---|---|
| `bin/mohaa_map_edit.py` | The editor mode. `EditApp` subclasses `mohaa_map_launcher.MapApp` and is the class the Map Viewer runs (`mohaa_map_launcher.py`'s `__main__`). `EDITOR_LABEL` gives the window its View → Edit map item and button (`App._editor_set`, `_editor_hash`); a cached page is reused only when it is newer than the editor's own files too (`_html_current`). Always: the File menu (New map..., which turns the mode on, and Compile map...), the level script's reading and saving (`_edit_scr_*`), the texture browser's list and pictures (`_edit_texlist`, `_edit_tex`), the recovery file and close question with brush changes (`_modify_backup`, `_close_ask`) and its page messages (`_page_message`). |
| `bin/mohaa_map_editor.js` | The editor's page code. `mohaa_map_view.py` inlines it in every page at the `__EDITOR_JS__` token, at the end of the page script just before `main()` runs; it reads the page's globals and wraps some of Modify's functions (`modTakes`, `modDrawn`, `modBox`, `modPlaceAt`, `doorXf`, `modSets`, `modMapText`... reassigned, each calling the page's own), which is how brush entities join Modify. Its brush, patch and terrain section edits the map's text and rebuilds the scene from it. Dormant until the page's mode is on (`EON()`, `edMode`, registered in `__EDITHOOKS__`): off, `modTakes` takes no new brush entity, `edPickSync` selects nothing and `edMarks` draws only the leak trail; the rows and edits already made keep working. |
| `bin/mohaa_compile.py` | Compiling: the game folder for ommap, its steps, the `.bsp` and `.lin` written beside the map. |
| `bin/ommap/<system>/ommap` | The compiler, built from `tools/ommap` by `tools/build_ommap.py`. |
| `tests/test_map_editor.py` | New map's room and its check, page names, the editor's code (dormant) in every page, the toggle switching the open page without a rebuild, page messages, which `.scr` the page may write, the Linux pane's early messages, the launcher's side of brush editing (the recovery copy of brush-only work and its check, texture names refused, the close question), and (with `MOHAA_GAMEFOLDER`) a door written into m4l0's `.bsp` keeping its brush model. |

| | Edit map |
|---|---|
| Settings, logs | the Map Viewer's (`editor_mode` in its settings) |
| Built pages | the Map Viewer's own (`<stem>_<kind>_view.html`); one page for both modes |
| New maps | where the user chooses; the file box starts in `output/my_maps/` |
| Unsaved Modify work | `output/modify_recovery/`, the same file in both modes, brush changes included |

## The page

- Save as `.map` lights up for brush, patch or terrain changes alone, not only for
  entities (`edSaveButtons`, after Modify's own render); Save as `.bsp` stays greyed and
  its tooltip says why.
- An **Editor** section at the top of the panel (New map..., Level script...), with
  **Modify** moved up under it. Its line names the map being edited and says that Save as
  writes a new file, never over it.
- Everything else is the Map Viewer's page. Modify's adding, moving, trimming, deleting,
  spawnflags, path making, AI routes, unlimited Undo, recovery and Save as `.bsp` / `.map`
  are described in [map-viewer.md](map-viewer.md) (Modify).

## Brush entities

Selecting one of the map's brush entities (a door, a trigger, a ladder, a `script_object`
...: not the world, a `func_group` or detail, a static prop or what the level script
spawns) gives it a Modify row, as a point entity gets one in the Map Viewer, so Edit
parameters, Move, Trim origin, Delete (DEL) / Restore, Undo and the exact origin in Edit
parameters work on it as a whole. Copy takes point entities only.

- **Its place is its origin.** In the game a brush entity's model is drawn and collides at
  its origin plus the model's bounds (`SV_SetBrushModel`; `Entity::setModel` for a `*N`
  model). The compiler writes an origin for one with an origin brush (a door's hinge);
  in the retail maps every brush entity has one. One without (a hand-made `.map`) is 0 0 0:
  its row gets an origin at the middle of its brushes (its anchor), so moving it works as
  for any entity.
- **Drawn where it is now.** Its faces are moved as an open door's are (`entPose`, with the
  row's offset added to `doorXf`), so it is picked, selected and labelled where it now is;
  DEL hides its faces. Modify draws no box of its own for it.
- **Saved as the file holds it.** Save as `.bsp`: the entity's keys with origin = the
  origin it had plus the offset (or the offset alone when it had none, left out when it
  is 0); `write_bsp_entities` keeps its `"model" "*N"`, which the decompiled `.map` the
  page reads doesn't carry. Save as `.map`: its brushes and patch control points moved by
  the offset, with each face's texture shift changed so the picture stays where it was
  (texture lock, from `QuakeTextureVecs`); the origin key only where the map had one. A
  brush entity holding a terrain block isn't moved (Save says so).
- Checked on m4l0 and mohdm6: a `func_rotatingdoor` and `trigger_use`s moved 48 units and
  up 8 come back from the saved `.bsp` at exactly that place in the Map Viewer, keeping
  their brush models; on a hand-made `.map`, a moved door's faces give the same texture
  coordinates at the moved corners as before, to the texel.

## The level script

**Level script...** in the Editor section opens the map's `.scr` in a box over the view
(the file beside the map: `maps/dm/mohdm6.bsp` -> `maps/dm/mohdm6.scr`; when there is none,
a starting script with `main:`, `level waittill prespawn`, `level waittill spawn` and
`end`). Tab types a tab, Ctrl+S saves, Esc closes (asking first when there are changes).

- The launcher reads and writes it (`mohaa-edit-scr-load`, `mohaa-edit-scr-save`): only
  for the map it has open, from disk, a `.bsp` or `.map` (a map from the paks is a copy in
  the workspace: save it with Save as and open the copy). Up to 4 MB, single-byte text
  (the game reads scripts so), no NUL. Written atomically with the old file kept as `.bak`,
  in the line endings it had (`\n` for a new file), read back and compared.
- Then the page is built again (`mohaa-edit-scr-reload`: the page is closed and opened,
  as Rebuild does, since the map's `.scr` is one of the files it is built from), so what
  the script spawns is redrawn. Modify's unsaved work is kept by its recovery file and
  offered back; the camera goes with the reload request and is handed back when the new
  page says it is ready (`mohaa-edit-ready`, `MOHAA_EDIT_CAM`).

## Tools in the view

The Editor section's tools (`EDTOOLS`, `edToolHtml`) work with the mouse in the 3D view;
each drag is drawn as outlines (`ED.prev` in `edMarks`), snapped to the grid and written
on release as one text change (one Undo step).

| Tool | What it does | Code |
|---|---|---|
| Select | picks brushes, patches, terrain blocks, entities | the page's own picking |
| ▭ Draw brush | outline on the surface under the mouse, then height, then click. Box, 3- to 16-sided prism, cylinder, cone, pipe bend (curved ones built on z and turned to the face drawn on) | `edDrawDown`, `edShapeFaces`, `edPrismFaces`, `edPatchShape`, `edPatchCone`, `edPatchElbow`, `edDrawMake` |
| ⇕ Resize | a face along its normal; a corner or edge anywhere (convex hull of the corners, textures from the nearest-facing old face); a patch control point | `edResizeDown`, `edGrabAt`, `edGrabDown`, `pointDrag`, `hull3`, `facesFromCorners`, `edCornerMarks` |
| ✥ Move | a brush, patch or terrain block; Shift up and down; Alt a copy | `edMoveDown` |
| ✂ Clip | two points and the eye make the plane (a third tilts it); Enter, Shift+Enter split, Tab flips | `edClipDown`, `edClipFace`, `edClipDo` |
| ▦ Texture | click paints, Shift the brush, Alt picks, Ctrl selects a face for Fit / turn / flip / shift / scale / Natural | `edPaintDown`, `edFaceTex`, `TEXPRESETS` |
| ▲ Terrain | triangles cut / filled, raise, flatten, smooth, paint a patch's texture, draw a new block | `edTerrHit`, `edTerrDown`, `edPaintDown(..., true)`, `edTerrNewDown`, `edTerrNewText` |

With a terrain block selected: **Join edges** and **Fit to neighbours** (`terrHeightsMap`,
`terrFit`, `edTerrFitSel`). With a patch selected (Select or Resize): **+rows / −rows /
+cols / −cols** (`edPatchGrow`, `edPatchRows`), **Cap ends** (`edPatchCap`), **Thicken**
(`edPatchThicken`, `edAddPatches`). **Region** (`edRegionSet`, margin `edRegM`) wraps the
page's `faceShown` and `entShown` to draw only what lies near the selection.

## Brushes

The **Brushes** part of the Editor section changes the map's brushes by exact values.
Click a brush in the view to select it (a face of it is selected too); the panel shows
its brush number, its entity (the world or a brush entity), its faces and, for any brush,
its bounds.

- **New box** x y z, **Add**: a box that size on the surface straight ahead of the camera,
  on the grid, with the **Texture** above on every face; with *in entity* ticked it goes
  into the selected brush entity instead of the world.
- **min / max**, **Set**: a box's corners as coordinates (only a box: six faces, each on
  an axis). **by** x y z with **Move**, **-** (the other way) and **Copy** (a copy moved
  by that much); **Delete** (an entity's last brush can't be deleted: delete the entity
  in Modify). *texture lock* (on at first) keeps each face's picture where it is on the
  wall as the brush moves: the shift is changed by the move along the face's texture
  axes (`texVecs` for Quake-style faces, the brush primitives matrix for `brushDef`
  faces).
- **Clip** on x = , y = or z = a value, keeping below or above, or on a plane through
  three points (the part behind the plane is kept, as a `.map` face's points describe
  it). The new face gets the texture above. A clip that would leave nothing, or cut
  nothing off, is refused.
- **Faces**: click one in the view or the list. Its plane's three points can be typed
  (**Set face**), its texture chosen, and for a Quake-style face its shift, rotation and
  scale; **Push out** moves it along its normal (below 0: in). **Texture on all faces**
  puts the texture above on the whole brush.
- **Browse...** opens the texture browser: the map's own textures first, then every
  texture in the loaded paks (images under `textures/` and the shaders named there), with
  a filter. A texture the page doesn't hold yet is asked of the launcher
  (`mohaa-edit-tex`), which loads it from the paks as a build would and sends it back;
  the faces using it are drawn with it.

How it works: every change is a text change to the map's `.map` text (the decompiled one
for a `.bsp`), checked before it is made (the faces must close into a solid, each corner
inside 65536, every number a number; a bad value leaves the map as it was and says why)
and then the page's scene is rebuilt from the text (about 0.1 to 0.4 s on the retail
maps). Faces are written in the line format they had, so a `brushDef` face keeps its
matrix and a Quake-style face its five numbers. The changes join Modify's Undo / Redo,
its recovery file and its unsaved count:

- Save as `.map` writes the changed brushes with Modify's entities; Save as `.bsp` is
  refused once a brush has changed (a `.bsp` holds its brushes compiled: compile the
  `.map`). The close question names the brush changes and offers Save as `.map`.
- After the first brush change the baked lighting is turned off (the lightmaps belong to
  the compiled faces) and the page says so.

Checked on the starter room and a hand-made `.map` with a door and a trigger (every
operation, the refusals, Undo of nine changes giving back the text exactly, recovery,
the save and close requests), and on m4l0 (a brush of the world and a door's brush
changed, the door's Modify offset kept through the rebuild, the `.bsp` save refused, the
`.map` saved with both, Undo back to the original text). The texture browser listed
2,772 textures from the test paks.

## Patches and terrain

The same part of the Editor section (now **Brushes, patches and terrain**) changes a
selected patch or terrain block the same way: typed values, a checked edit of the map's
text, the scene built again, Modify's Undo / Redo, recovery and unsaved count. Only what
changes is written again: a patch's changed control points (the others, its header with
`subdivisions` and its texture keep their text), a terrain block's changed heights, flags
and texture lines (its vertex flags such as `maxdetail` and `invisible` are kept), in the
file's own line endings.

**Patches.** *New patch* makes one on the surface straight ahead, on the grid, with the
texture above: flat (a floor, 3 x 3 points), a wall along x or y, a cylinder (9 x 3, four
quarter circles), or an arch along x or y (5 x 3), sized by x y z. With a patch selected:

- **Point row / column** (or click near one: the nearest control point is taken); its
  x y z and texture s t set exactly (**Set point**).
- **by** x y z with **Move** for the patch, the point, its row or its column, and **Copy**
  (the whole patch). **Turn 90** round the middle of its points, **Flip** (it faces the
  other way), **Delete**.
- **Set texture** with the texture above: s t kept, *natural* (texels at the scale given,
  along the control net, as a brush face at that scale) or *fit* (once across each way).
- The panel says which way it faces: rows (the `.map`'s outer lists) crossed with columns,
  as the normals q3map wrote in the game's `.bsp` files (1,114 of 1,116 patch squares in
  m4l0 and mohdm6). The game draws a patch from that side only unless its shader has
  `cull none`; the view here draws both sides.
- The view shows the selected patch's control net and points, the chosen point larger.
- A patch keeps 3 to 129 points each way, an odd number (rows and columns can't be added
  or taken away here).

**Terrain.** *New terrain* makes a flat block of 1 to 32 512-unit patches each way, on the
64-unit grid where you look. A terrainDef is W x H vertices 64 units apart (8 per patch, so
9, 17, 25 ...), an origin, one texture line per patch corner and a height with two flag
groups per vertex (the two triangles of the square it starts; `nodraw` cuts a hole), as
in EA's own sources. With a block selected:

- **Vertex** i j (or click the terrain: the nearest vertex); its place and height shown
  and marked in the view.
- **vertices** i j **to** i j: set every height to, or raise it by, a value; **Smooth**
  (each the average of it and its four neighbours, once).
- **raise** an amount **within** a distance of the vertex: smooth (cosine), cone or flat;
  below 0 lowers.
- **squares** i j **to** i j: **Cut hole** (`nodraw` on both triangles) or **Fill**.
- **Texture above** with shift, rotate and scale on every texture line.
- **by** x y z: **Move**, **Copy** (x and y in 64-unit steps), **Delete**.
- Refused: x or y off the 64-unit grid, a block past -8192 to 8192 on x or y (a `.bsp`
  stores each patch's place in one signed byte of 64-unit steps), a height past 32000.
  Said, not refused: a 512-unit patch whose heights span more than 510, since a `.bsp`
  holds each patch's heights as bytes times 2 above its lowest point (EA's m4l0 source has
  such patches; the compiler's handling of them will be checked in the compiler phase).

Checked in headless Chrome on the starter room (every operation above, the refusals, which
way new patches face, Undo of 21 changes back to the exact text, the saved `.map` built
again by the Map Viewer's builder with its 3 patches and 2 terrain blocks), on EA's own
`mohdm6.map` and `m4l0.map` sources (CRLF; the 233 x 249 terrain block of m4l0 changed in
0.4 s; each change differs from the file only in what was changed) and on m4l0's decompiled
`.map`.

## Models

A new entity whose class or `model` key names a `.tik` is drawn with that model, as in
the Map Viewer's Modify: the map's own mesh when the map places that model, else one the
launcher builds from the paks (`mohaa-sim-build`, as Simulate's).

## New map

File > New map... (Ctrl+N), or the page's button (`mohaa-edit-new`, a message with no
content: the launcher opens its own file box). It writes a starter `.map`:

- worldspawn with six 16-unit slabs round a 512 x 512 x 256 room, the floor's top at z 0.
  The face of each slab toward the room carries a texture the retail maps use
  (`general_structure/jh_conc512b` floor, `mohtest/stonewall1grim` walls,
  `general_structure/plank_flat` ceiling); its other faces are `common/caulk`;
- `info_player_start` at ( 0 0 16 ) facing 90, `info_player_deathmatch` at ( -128 0 16 ),
  and a `light` of 400 at ( 0 0 224 ).

Each face is written as three points, in the decompiler's line format
(`( x y z ) ( x y z ) ( x y z ) texture 0 0 0 0.5 0.5 0 0 0`), ordered so q3map's
`MapPlaneFromPoints` (normal = cross(p0 - p1, p2 - p1)) gives the outward plane. The name
must be letters, digits, `_`, `.` or `-` (the game finds a map by its file name). The text
is checked before it is written and again after it is read back (`check_map_text`):
braces balance, each brush is rebuilt from its planes (`mohaa_bsp.brush_windings`), and
it must close: a face on every plane, every corner inside `MAX_WORLD_COORD`, and the faces'
area-weighted normals adding up to nothing (a missing side leaves a hole). Then the map
opens in the editor.

## Compiling

A changed `.bsp` entity lump is saved by Modify without compiling. Geometry (brushes,
patches, terrain) only reaches the game through a map compiler, which turns the `.map`
into a `.bsp`. The editor has its own: `ommap`, from OpenMoHAA's `code/tools/ommap` (GPL,
id Software's q3map with MoHAA's lumps added), made to build again and changed for MoHAA
(the list is in `tools/ommap/README.md`). `tools/build_ommap.py` builds it; the programs
for Linux (x86_64, arm64), Windows (x86_64) and macOS (x86_64, arm64) are in `bin/ommap/`.

**Compile...** in the Editor section (or File > Compile map..., F9, which asks the page
through `edCompileAsk`) compiles what the page shows. The page sends `mohaa-edit-compile`
with `changed`, `edN`, `modKey` and, for a `.bsp` or a map with changes, `mapText`
(`modMapText()`: the decompiled `.map` with every edit in it). The launcher
(`_edit_compile`, mohaa_map_edit.py) then asks:

1. in the Compile window (`_compile_dialog`, its choices kept as `compile_opts`): the steps
   (**Full: bsp + vis + light**, **Quick test: bsp + fast vis + light**, **bsp only (for
   viewer only)**, or **map file only**: the `.map` written where chosen, nothing compiled,
   `_edit_save_map_only`); what a choice doesn't use greyed out, and a box with nothing that
   applies hidden (bsp only shows BSP and MAP, map file only MAP alone);
   MBuilder's switches for each step (`COMPILE_SWITCHES`: bsp `-v -nocurves -nodetail
   -nohint -onlyents -fulldetail`; with `-onlyents` the `.bsp` beside the map, else the
   opened one, is copied in for ommap to rewrite its entities, and vis is skipped; vis `-v -passageOnly -merge -derived -nofarplane`, light `-v
   -extra -notrace`), **Sun scale** (ticked by default, `light_sunon`; `SUN_SCALE` 0.82: light `-sunscale N`,
   none unticked or at 1),
   **Vis groups** (on; off adds `-nomanvis` to bsp and vis), **Cap the
   work per portal** (on, `VIS_CAP` 100,000 steps: vis `-cap N`) and a box of more switches
   for each step (`<step>_more`, checked by `check_options`: switches and numbers only, not
   `-gamedir` and the like; its tooltip lists the step's other switches, `MORE_SWITCH_TIPS`);
   the **MAP** box, the worldspawn's keys from the text sent (`worldspawn_keys`) as
   `"key" "value"` lines with a list that adds one (`WORLD_KEY_TIPS`), checked before the
   window closes (`parse_key_lines`) and written into the text when changed
   (`set_worldspawn_keys`: its key lines only); where the `.bsp` goes: asked, or the game's maps folder for
   the gametype (`GAMETYPES`: `maps`, `maps/dm`, `maps/obj`, from the folder the paks were
   loaded from, `_game_folder`); and whether to start the game after (`_start_game`: the
   game's program, `game_exe` once chosen, shown in the window with Browse..., asked for
   before the compile when it isn't found, `_game_program_ask`; the command line split by
   `shlex`, `+set g_gametype N` and
   `+devmap` with the map's path under `maps/`; Wine for a `.exe` off Windows);
2. where the `.bsp` goes, when asked (`compile_dir` remembered); in the game's maps folder, a
   `.bsp` there that Compile didn't write is replaced only when the user says so. The page's
   text (or the opened `.map`, copied) is written beside it as `<name>.map`, atomically; a
   `.map` there that Compile didn't write (`compile_written`), or the opened map itself, is
   replaced only when the user says so, the old one kept as `.bak`. Replacing the opened
   `.bsp` is asked too.

The compile runs on a worker thread and writes `<name>.bsp` beside that `.map` (atomically,
an older one kept as `.bak`, read back), then offers to open it. When the page's changes went
into the `.map`, the page is told (`edCompiledSaved`) and counts them saved.

Step by step:

- a game folder is made in the workspace: `scripts/` with every shader script from the
  loaded paks, `maps/` with a copy of the map; `ommap -gamedir` reads it;
- the copy is made as EA's compiler takes a map (`ea_prepare`): worldspawn's `map_time` set
  to now (the game rebuilds the AI paths of a map whose `.pth` has another time, so an old
  `.pth` is never used with the new `.bsp`), and each static prop given its model's
  collision brushes from the paks (`models/<model>.map`, turned, scaled and moved with it:
  the prop is solid in the game; the Output pane counts them);
- the vis groups are put back (`restore_leafgroups`): a `.bsp` keeps only the brushes of its
  `vis_leafgroup` entities (the compile consumes the entities), so a decompiled map has
  loose `common/vis` brushes and no groups. When the map has such brushes and no
  `vis_leafgroup`, the original `.bsp` (the opened one, the one beside the map, or the paks'
  `maps/**/<name>.bsp` named by the decompile's first line, `find_origin_bsp`) gives them
  back: each of its vis brushes whose planes match one of the map's becomes a group
  (`mv1`...), and a group targets each group no cluster of it sees in that `.bsp`'s vis
  (`bsp_leafgroups`: on m3l1b, 115 groups and 3,493 blocks). A list too long for one
  value goes over `target`, `target2`... (`_target_keys`). Only the copy is changed;
- the terrain's level of detail is put back (`restore_terrain_detail`): when a decompiled
  map's `terrainDef` vertices name none of `nodetail`, `important`, `trivial` or
  `invisible`, the original `.bsp` (as above; the first one with any never-split node) gives
  them back per patch (`terrain_lod_words` in `mohaa_bsp.py`), and its holes that split
  nothing become `invisible`. Without them far terrain falls to big triangles whose
  textures stretch into bars on slopes;
- bsp, then vis (skipped when the map leaks), then light, each timed; the compiler's lines go
  to the Output pane (its "entering" and "Unknown surfaceparm" lines left out), its
  `0...1...` progress as `  10%` lines while they come;
- when the map leaks, the compiler's trail (from the void to the entity it reached) is
  written beside the map as `<name>.lin`, said in the Output pane and drawn on the page in
  red; the gap in the outer walls is where it crosses them.

The light step bakes the map's lights, the world's sun and sky (`suncolor`,
`sundirection`, `sundiffuse`, `ambientlight` on worldspawn) into lightmaps for faces,
patches and terrain, and writes the light grid that lights players and models. Each light
(but those with NO_ENTITIES) is also kept as a light for models, which the game uses for
players and weapons, with the list of lights that can reach each leaf; static props
(`static_*`) get light per vertex: before the light step the launcher writes the props'
vertices beside the map copy (`<name>.smv`, posed and ordered as the game draws them, by
the Map Viewer's own model code) for ommap to light, each the way the game lights a
model (a light's strength at the model's centre, each vertex by how far it faces the
light, the ambient light and the light grid over the whole model). Terrain (`terrainDef`) is compiled
with its holes and level-of-detail data (a patch no open space reaches is left out), and
every brush side gets its surface type (what a footstep or bullet sounds like), stone
when none is named. Hint and clip brushes are open space, not solid. Light passes
through the clear parts of foliage, fences and tree lines: before the light step the
launcher also copies the images of the map's `alphashadow` shaders from the paks into
the compiler's game folder.

The reference for its output is EA's own: the `.map` sources EA released for mohdm1 to 3,
mohdm5 to 7, obj_team1 to 4 and m4l0 (gtsh77/MOHTools on GitHub), whose compiled `.bsp`
files are in the game's paks, and test maps compiled with EA's `Q3map.exe` from the same
release on the user's own machine. EA's tools are only run, never shipped with this
project, taken apart or copied into it: their licence allows personal use and nothing more.
Only the files they produce are compared, with `tools/bsp_compare.py ours.bsp reference.bsp`
(each lump's size and count, the shaders and their flags, the entities by class, the
surfaces by type, the terrain patches, the models and the world's bounds).

EA's released sources are older than the maps in the game (the game's mohdm6 and m4l0
have hundreds of clip brushes their `.map` files lack), so their `.bsp` files can't
match exactly. EA's `mohdm6.map` and `m4l0.map` compiled by ommap against the game's
own: the world's bounds, the models, the entities and the static models match, the two
draw the same geometry and terrain in the Map Viewer, the light grid has the same cells
(colours 15 apart on average on mohdm6, 6 on m4l0, out of 255), the lights for models
are the same, field for field, and the static props' vertex light has EA's layout and,
lit on EA's own mohdm6, is 12.6 apart a vertex on average out of 255.
Fences and grates let shots through their see-through pixels as EA's do (the same side
equations and fence masks), and textures are laid out by their images' real sizes.
Not yet the same (details in `tools/ommap/README.md`):

- **Light**: trees and bushes as static props are darker than EA's (30 apart a vertex on
  m4l0, where the other props are 11 apart); no `lightdef`s (the game doesn't read them). Terrain casts no shadow,
  as with EA's. Lightmaps match EA's in layout and brightness.
- **Terrain**: holes and variance match EA's node for node, the forced splits round
  holes to better than 99%; m4l0 keeps more patches than EA's because the shipped map's
  terrain was trimmed after its source was released.
- Static models are listed in the leaves a 64-unit box (times their scale) round their
  origin reaches, not their real size.
- Checked against EA's own compiler on the same `.map` (its `Q3map.exe`, run as a reference
  only): the same brushes and sides, props' collision included; still different are some
  sides' surface and content flags, the BSP's splits, the light grid's size on disk and the
  header's checksum (`tools/ommap/README.md`, Compared with EA's compiler).
- Full vis on a large outdoor map is slow without the work cap (m4l0: over an hour; m3l1b in
  MBuilder: over 9 hours without finishing). With the cap Compile gives it (100,000 steps
  a portal) m3l1b's full vis takes under 3 minutes on two cores and sees about 15% less
  than fast vis and 12% more than vis run to the end (`tools/ommap/README.md`, Full vis on
  an open map).

## Planned

Nothing further is planned for now; the differences above are what is left of the
compiler's.

Every tool takes exact values: corners and planes as coordinates,
sizes, texture shift / scale / rotation per face, each patch control point, each terrain
height, origins and angles, with the grid down to 1 unit.

## Known limits

- A moved brush entity: the AI's routes still trace the map's brushes where the `.bsp` has
  them (the page doesn't move them for its path checks), and in the game it keeps the light
  baked where it was compiled (its own surfaces' lightmaps go with it; the shadows it cast
  stay on the world). It can be moved, not turned: angles on a brush entity without an
  origin brush would turn it round the world's 0 0 0.
- A static prop in a `.bsp` (its own lump, not the entity lump) can't be changed here.
- Brushes: drawn, resized by faces, corners and edges, moved, clipped and textured in
  the view, or typed. A corner drag keeps the brush convex (the hull of its corners), so a
  corner pushed inward drops out rather than making a dent. A `brushDef` face keeps its
  texture matrix (its shift, scale and rotation can't be typed or fitted). After a brush
  change the page draws no baked light, Save as `.bsp` is refused, and the AI path checks
  still use the brushes as compiled.
- Patches: drawn (cylinder, cone, pipe bend), control points dragged, rows and columns
  added or removed, capped and thickened. There are no bevel or end-cap shapes beyond the
  disc cap, and an existing patch can't be bent as a whole (drag its points, or draw a
  pipe bend). Terrain: Join edges and Fit to neighbours only match vertices that sit at the
  same x y (blocks on the 64-unit grid); a new block is flat (or fitted) and textured with
  one texture. The same as brushes for the baked light, the `.bsp` save and the AI path
  checks.

- **Found (November 2026): the game froze where a compiled map's terrain came into view**,
  because every patch of a decompiled map had the same diagonal (`tools/ommap/README.md`,
  Terrain diagonals); fixed. The report below is from before that.
- **A compiled map crashes the game about a second after the player spawns** (reported
  on Windows with the original game: the map loads and the player spawns, then the game
  closes). Not found yet. Checked so far, against OpenMoHAA's loaders, on retail maps and
  on compiles of the starter room, a decompiled m4l0 (bsp + fast vis + light) and m4l0
  with terrain removed: every lump's size and every index in range (shaders, surfaces,
  draw indexes, brushes and sides, nodes and leafs, leaf lists, models, terrain shaders,
  lightmaps and neighbours, static model vertex data); the light grid's offsets length
  and palette, and every read `R_GetLightingGridValue` makes over the whole grid; the
  sphere lights, their leaves and the per-leaf light lists. Differences from EA's output
  that remain: no `LIGHTDEFS` (OpenMoHAA only counts it), terrain patches' `TERPATCH_NEIGHBOR`
  set per block (a block of one patch never has it; EA's alternate across the map) and
  shader content flags taken from the decompiled source. A bsp-only compile has no
  lightmaps (its surfaces still name them) and no light grid: the compile dialog and the
  Output pane now say it is for the viewer only. The game's `qconsole.log` written by the
  crashing run (it is overwritten by the next start) is what is needed next.
- Not yet checked on Windows: the WebView2 pane and the `.bat` menu; a moved door in the
  game. The Linux pane was checked under Xvfb (New map and the level script's messages); a
  map page itself needs WebGL 2, which the test machine's Qt doesn't have, so the script's
  save-and-reload was checked in headless Chrome and the launcher separately.
- A `.bsp` / `.map` / `.bak` dropped on the RUN file opens in the Map Viewer, as an editor
  page when Edit map was left on.

## The world's keys ($world)

The page's world card (`infoWorld`, `mohaa_map_page.py`) opens from the stats line under the
map's name (its tooltip lists the keys, `worldKeysTip`), the worldspawn's row in the class
list and Find (`world`, `$world`, `entnum: 1022`: `WORLD_ENTNUM`, the game's
ENTITYNUM_WORLD). It selects nothing. Each key gets what it does (`WORLD_KEYS`, from
OpenMoHAA `fgame/worldspawn.cpp` and the compiler's keys), what changed is marked, and the
keys are edited as `"key" "value"` lines (`modParse`; `"classname" "worldspawn"` must
stay). The edited keys (`WED.kv`) go into `modSets` (`worldSets`: entity 0, which
`write_bsp_entities` / `_find_entity` take for Save as .bsp), `modMapText` (`worldMapText`:
the first entity's key lines written again after its `{`, comments and brushes kept; the
editor's own `modMapText` calls it too) and `modUnsaved`, so Save as .bsp / .map, Compile and
the close question all see them. `farplane` and `farplane_color` change the page's fog as
typed.

## New geometry until it is saved

`EDNEW` (`mohaa_map_editor.js`) holds the scene primitives whose whole text lies inside what an
edit since the last save inserted (`ED.all[min(ED.saved, ED.n) .. ED.n)`): new brushes,
patches and terrain blocks, and moved or resized ones. `edNewCalc` runs after every rebuild
(`edRebuild`), `edNewSync` after a save (`modSaved` for a .map, `edCompiledSaved`, the brush-only
.map save, `modDiscardClose`) and redraws when the set changed. The editor's `faceShown` lets
their faces past the Show buttons' categories (Hide, `hidPrim` / `hidEnt`, still hides them), so
they are drawn and in the pick pass; `edNewLines` outlines their polygon edges in amber (from
`SC.edge`, with the editor's other marks, also with the editor off); and the editor's
`infoPrim` puts a "New: ... not saved yet" note at the top of their More info card.

