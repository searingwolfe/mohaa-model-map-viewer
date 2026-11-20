# ommap

The map compiler the Map Viewer's Edit map runs: a `.map` in, a MOHAA `.bsp` out. It is OpenMoHAA's
`code/tools/ommap` (from https://github.com/openmoh/openmohaa, commit
a2f340195975f4f042e28a60b62561dd9a0b2700, 24 April 2026), which is id Software's q3map
from the Quake III Arena tools with MoHAA's `.bsp` lumps added. It is under the GNU
General Public License, version 2 or later (see the file headers), like this project.

`python tools/build_ommap.py` builds it for this system with its C compiler; with
`--target all` it builds for Linux, Windows and macOS with Zig's C compiler
(`python -m pip install ziglang`). The programs go to `bin/ommap/<system>/`.

    ommap [-vis | -light] [-gamedir folder] [options] mapfile

`-gamedir` names the game folder holding `scripts/` (the shaders) and `maps/`; without it
the folder is found from the map's path, which must then run through a folder named
`MoHAA` or `build`.

## Changes from OpenMoHAA's copy

As published, ommap is not part of OpenMoHAA's build and no longer compiles against the
game's headers. These are the changes made here:

- **Builds again, on every system.** The game's `.bsp` structures are in
  `common/mohaa_qfiles.h` and `common/mohaa_surfaceflags.h` (copies of OpenMoHAA's
  `qcommon/qfiles.h` and `surfaceflags.h` without `q_shared.h`, whose types clash with the
  tool's own). Windows-only calls are kept to Windows (`getwd` replaced by `getcwd`, the
  Windows message atom, `_findfirst` beside `opendir`); `stricmp` / `strlwr` replaced by
  the tool's own `Q_stricmp` / `strlower`; `CLK_TCK` by `CLOCKS_PER_SEC`; the pak and JPEG
  readers (Windows-only C++ libraries) are left out (`OMMAP_PAK`), the folder given by
  `-gamedir` holding what the compiler reads.
- **`vec2_t` is two floats** (it was three), so the terrain lump's records are the
  game's 388 bytes, not 404.
- **MoHAA's surfaceparms**: the table in `shaders.c` is the game renderer's
  (`renderergl1/tr_shader.c`, with the game's flag values: fence, weaponclip,
  vehicleclip, castshadow and the surface types paper to carpet) plus q3map's
  compile-only ones.
- **A missing shader file** named in `shaderlist.txt` is a warning, not the end of the
  compile.
- **MOHRadiant's `detail` entities** are taken into the world as detail brushes, as
  `func_group`s are (EA's sources use them; the game's `.bsp` files have no such entities).
- **Static models**: `static_*` entities become the static model lumps (model, origin,
  angles, scale) instead of entities, and every world leaf a model's box reaches lists it.
  The box is 64 units times the model's scale round its origin, since the tool doesn't
  read the models. The leaf index lump was written from the wrong array; it is fixed.
- **`-gamedir`** as above.
- **Light for MoHAA** (`mohlight.c`, `light.c`): the world's light keys (`ambientlight`,
  `suncolor`, `sundiffuse` / `sundiffusecolor`, `sundirection`), light from the sky
  (EA's 92 directions round each lightmap texel, below; 8 rays for the grid, counted when
  they reach a sky face), spotlights (a light with `angles` or `radius`: the cone's radius 64 units out),
  and the game's light grid: one 32-unit cell per
  point, its colours cut to a 255-colour palette and each column run-length coded as the
  renderer reads it (lumps 16 to 18). Terrain gets lightmaps of its own (17 by 17 texels a
  patch, one every 32 units). The light grid size is the game's 32 32 32.
- **Lightmaps laid out as EA's**: a texel every 32 units (q3map's default is 16), or every
  half a surface's width along an axis where that is less, so a thin face still has a texel
  at each edge and one between (`lightmaps.c`); texels stored rescaled by colour at 127,
  since the game doubles them as it loads them (`LightmapToBytes`); lights (not the sun,
  sky or ambient) light surfaces 1.25 times as brightly as q3map's formula, which is what
  the game's lightmaps show on both maps. The light grid and static props keep their own
  scale.
- **The world's light read as EA's light step reads it** (`mohlight.c`, `light.c`; checked by
  running EA's own `MOHlight.exe` on test maps: the same floor values to the byte for the
  sun at four angles, the sky, `sundiffuse` 0 / 0.5 / 3.0, and `sunlight`):
  - a key whose value is a single character is ignored and its default kept, as EA's
    MOHlight does (each key's value must be longer than one character): `"sundiffuse"
    "3"` lights as the default 1 (m3l1b, m2l1, m3l1a), while `"3.0"` or `"1.5"` is read;
  - `sunlight`, read after `suncolor`, replaces the sun's colour (mohdm1's `"sunlight"
    "255 243 171"` is its sun; its lightmaps went from half the game's to within 10%);
  - the sky (`sundiffuse`, default 1, coloured by `sundiffusecolor`, else the sun's colour)
    is EA's: 92 directions (MOHlight.exe's table at 0x44b908), those at most 0.3 below the
    horizon and facing the surface, every other one counted twice (`-extra`: each once),
    each reaching the sky adding colour x sundiffuse x 2.3 / 92 x (1 + cos) / 2 (an open
    floor: 1.07 x the colour);
  - with no sky light (`sundiffuse` 0 or less, or `-nodiffusesun`) the sun is 1.3 times as
    bright.
  On m3l1b our lightmaps are within 1% of EA's MOHlight on the same map. EA's light step
  still lets a little more sky past a tall object right beside a surface (a pillar's foot:
  33 against our 26 of 41); not found yet.
- **`-sunscale N` and `-skyscale N`** (light): the sun's and the sky's baked light scaled
  (the keys stay as they are, so the game's own sun for models keeps `suncolor`). The
  game's own maps were lit darker than EA's MOHTools lights them now (m3l1b: MOHTools'
  terrain is 8% brighter, m2l1's 32%), so no light step given their keys gives them back
  exactly; `-sunscale 0.77` comes closest on the maps measured (m3l1b: 88% of the terrain
  texels within 5 of 255 of the game's, against 15% without; m2l1's sunlit floors 113 ->
  108, the game's 101). The Compile window's LIGHT box has it as **Sun scale**, 0.77 by
  default (1: as MOHTools).
- **Terrain** (`mohterrain.c`): MOHRadiant's `terrainDef` blocks become the terrain lump
  (heights, holes, texture coordinates, neighbours, the level-of-detail variance tree with
  holes marked) and the terrain index lump that lists the patches in each leaf. A
  triangle marked `nodraw` or `invisible` is a hole; `maxdetail` keeps a triangle at full
  detail; a smallest triangle whose vertices are all `nodetail` (and not `nodraw`) never
  splits (0x4000, set on a node whose children both have it and on every node under one
  that has it); `important` doubles a smallest triangle's variance and `trivial` halves it,
  as EA's compiler reads them. Texture coordinates go as a floor brush face's (s = x,
  t = -y, turned by the rotation, then shifted, over the line's width times its scale), from
  the block's origin, a right angle turned exactly (the game floors a patch's lowest
  coordinate, so -1e-8 would move a clamped texture off its edge). A node's variance is how far its triangle's apex sits from the mean of its long
  edge's ends, the largest in its subtree, as EA's compiler measures it.
- **Surface materials**: each brush side's shader record carries the surface types
  (paper to carpet) of every side of its brush, stone when none names one, as EA's
  compiler writes them, with its own other flags and the contents and flags MOHRadiant
  writes on the face. Draw surfaces use the same records as their sides.
- **Lights for models** (`mohlight.c`): every light entity but those with NO_ENTITIES
  (`spawnflags 2`) becomes a sphere light (lump 19: origin, colour, intensity, its leaf,
  ENTITY_TRACE, a spotlight's aim and spread), and each leaf lists the ones that can
  reach a model in it (lump 20): the sun first when the leaf's cluster sees a sky face,
  then each light whose cluster it sees within the distance where the game stops adding
  it (intensity * 7500 / distance^2 under 5).
- **Static model vertex light** (`mohlight.c`, `light.c`): ommap doesn't read models, so
  the launcher writes `<map>.smv` beside the `.bsp` before the light step: each static
  model's vertices in the game's order (every surface of every mesh) with their world
  positions and normals. Each vertex is lit as the game lights a model
  (`renderergl1/tr_sphere_shade.cpp`): a light's strength is taken at the model's centre
  (the mean of its vertices; none under 1), and the vertex takes it by how far it faces
  the light, v.n / |v|^2 from the vertex times the distance from the centre; the sun by
  its facing alone; lights and sun only where they reach a point 4 units out along its
  normal (a spotlight inside its cone). The whole model also gets the world's ambient
  light and the light grid at its centre. The scales are the ones EA's maps fit: lights
  2, sun and ambient 2.6 (the game doubles its model sun and ambient for overbright and
  scales them by `r_entlight_scale` 1.3), grid 0.234 (the game's 0.18 times 1.3). The
  colours go to lump 24 with each model's start and count. Without the file, or when a model is missing from
  it, no vertex light is written and the game falls back to its own.
- **Hint and clip brushes are open space**: MoHAA's hint and clip shaders are nonsolid
  without `trans` (q3map's are trans), so q3map filled them as solid; only brushes with
  solid contents are now opaque, as EA's tree has them.
- **Light through foliage, fences and tree lines**: a surface whose shader has
  `alphashadow` lets light through its clear texels, so the light step needs its image;
  ommap reads plain files, not the paks, so before light the launcher copies the `.tga`
  images of the map's alphashadow shaders into the game folder. Without one, ommap counts
  the whole surface as solid (m4l0's tree lines then took the sun from everything near
  the map's edge).
- **Light tracer fix**: a trace that ended in solid had its hit point overwritten with
  the trace's far end, so the sun test sometimes missed the sky brush it had reached.
- **Terrain holes in the level-of-detail data**, as EA's compiler writes them: a node
  carries 0x2000 when its first child's triangles are all holes and 0x1000 when its
  second's are, and 0x8000 (always split, the new point at its true height) on the way
  down to every `nodraw` hole, every `maxdetail` triangle, every triangle sharing an edge
  with a `nodraw` hole and the triangle across that one's long edge; each node so split
  also splits the node across its own long edge, in its patch or the patch beside it on
  the 512-unit grid. `invisible` holes split nothing.
- **Terrain in the leaves as EA lists it**: every world leaf, solid ones too, lists each
  patch one of whose 128 smallest triangles' boxes its box meets (holes counted). A patch
  no leaf lists is dropped and the leaf lists and neighbours renumbered; a patch cut away
  entirely is kept when a leaf lists it, as EA keeps it.
- **Static props in brushes**: a prop vertex inside the brush it stands on or hangs from
  is lit from the first clear point within 16 units on the way to each light (and to the
  sun): a ceiling lamp's bulb lights as in the game.
- **Fences and grates as the game shoots through them**: each shader record names its
  fence mask as EA's do (the shader's `qer_editorimage`; `ignore` for `nodraw`; `nomask`
  for terrain); each brush side whose shader is a `fence` gets its texture coordinates as
  a side equation (lump 10, shared between sides, equation 0 the empty one), which the
  game reads to find where a shot meets the mask; a brush's collision record holds all
  its sides' contents, as EA's (a gate's `nodraw` sides and its fence face make a fence
  brush); and a brush's bevel sides take its first side's shader, as EA's do (a shot
  meeting a gate's bevel passes as through `nodraw`, or is tested as the gate's face).
- **Textures laid out by their images' real sizes**: ommap reads plain files, not the
  paks, and took every image it couldn't find as 64 by 64, so most textures came out
  stretched or squeezed (on mohdm6, 9 vertices in 100 had EA's texture coordinates).
  The launcher now copies the image ommap looks for (`q3map_lightimage`, then
  `qer_editorimage`, then the shader's name; `.tga`, else `.jpg`) for every shader the
  map names, in the case the map writes it, and ommap reads a `.jpg`'s size from its
  header (it has no JPEG decoder outside the Windows pak build).
- **Two light-step faults**: the grid, the static props and vertex-lit surfaces left a
  trace's patch-shadow setting to whatever was on the stack, so the gcc and clang builds
  lit a map differently; it is set now (curved patches shade the grid and the props, as
  in the game's maps), and every build writes the same `.bsp`. An alphashadow texel
  lookup could read outside its image (a crash on m4l0 in the clang builds).
- **Threads on Linux and macOS** (pthreads): vis and light use every CPU there too.
- **`info_splinepath`** entities (camera paths, often outside the world) don't count as
  inside for the leak test.
- **64-bit fixes**: a pointer cut to an `int` in the light tracer (a crash on 64-bit
  systems) and the grid's size limit.

- **No edge bevels**: id's q3map gives a brush with slanted sides extra bevel planes along
  its slanted edges for the collision code; EA's compiler gives only the six axial ones,
  and so does ommap now (`noEdgeBevels` in `map.c`). On a decompiled m3l1a with its props'
  collision, ommap's brush sides were 63,923 against EA's 28,285; now they are 28,285.
- **What EA's compiler adds to a map before building it** is added by the launcher on the
  map's copy before ommap reads it (`ea_prepare` in `bin/mohaa_compile.py`): worldspawn's
  `map_time`, set to the time of the compile (the game rebuilds a map's AI paths when its
  `.pth` has another), and each static prop's collision brushes, the paks'
  `models/<model>.map` turned, scaled and moved with the prop, so props are solid in the
  game. The shipped maps' "extra" clip brushes that EA's released sources lack
  (`metalclip`, `woodclip`... below) are these.
- **The Windows build** leaves out the editor's pak and JPEG headers as the other systems
  do (`OMMAP_PAK`), so `--target windows-x86_64` builds from this folder alone.
- **MoHAA's manual vis** (`vis_leafgroup`), as EA's compiler has it: each such entity's
  brushes (one `common/vis` brush, normally) go to the world, marked with the group
  (`map.c`); after the portal file the bsp step writes `<map>.lgv` (`prtfile.c`): each
  group's clusters (the leaves whose brush lists hold a piece of its brush) and the groups
  each one's `target` names (and `target2`, `target3`... joined to it, for a list too long
  for one value). Vis reads it (`LoadLeafGroups`, `vis.c`): a cluster of a group
  never sees a cluster of a group it targets, the table ANDed into each cluster's row at
  the end (`ClusterMerge`). A cluster in both groups stays seen from both (a hole in the
  world otherwise). `-nomanvis` (bsp and vis) ignores the groups. The `.lgv` is removed
  with the `.prt` unless `-saveprt`.
- **`vis_derived` and the farplane**, as EA's vis reads them from worldspawn: with
  `vis_derived` set (or `-derived`; `-noderived` turns it off), the groups' blocks also
  leave portals out of the vis work (`BasePortalVis`); when `farplane_cull` is 0, portals
  further apart than `farplane` (or `-farplane N`) plus their radii are skipped
  (`-nofarplane` turns that off).
- **`-nohint`** (bsp), MBuilder's switch: hint and vis brushes don't split the map. And a
  brush with a hint side splits it by its hint sides only (its skip sides no longer), as
  EA's compiler does (`facebsp.c`).
- **`-onlyents`** keeps the `.bsp`'s static models: `static_*` props are left out of the
  entities it writes (they were written as entities), the static model lumps kept as
  compiled.
- **`-cap N`** (vis): at most N flow steps for each portal (`RecursivePassagePortalFlow`,
  and `RecursivePassageFlow` / `RecursiveLeafFlow` for `-passageOnly` / `-nopassage`);
  past that, every portal the path might still see counts as seen (every portal the flow
  could still have marked is in that set), so a capped portal sees more than it would
  have, never less.
  Vis says how many portals reached the cap. Without it vis runs to the end as EA's does.
  Compile passes `-cap 100000`.
- **Progress as it comes**: `_printf` flushes, so the `0...1...` progress reaches a pipe
  (Compile's Output pane) as it is printed, not when the step ends.
- **Terrain diagonals alternate across the whole map**: each patch's two big triangles
  split it along one diagonal or the other (`TERPATCH_NEIGHBOR`), and a patch's neighbours
  must have the other one, as in every EA map, for the renderer's splits to meet across
  patch edges. The flag was set by the patch's place in its own `terrainDef`, so a
  decompiled map (one `terrainDef` a patch) had every patch the same way, and the game froze
  the moment its terrain came into view (the splits chased each other across patches for
  ever). It is now counted from the map's first patch: m3l1b's 426 patches get exactly the
  flags of the game's own `.bsp`.
- **No vertex-lit surfaces**: q3map gave `SURF_POINTLIGHT` surfaces lightmap -3 (lit by
  vertex); that flag is 0x800, MoHAA's `SURF_NONSOLID`, so every nonsolid surface (wires,
  bars, grates: 56 on m3l1b) was written vertex lit, which EA's compiler never does. The
  game drew them unlit with "vertex colors are not valid for this model" every frame, and
  the game crashed on m3l1b where they came into view. `lightmaps.c` no longer does it:
  m3l1b's faces and patches now get lightmaps exactly where the game's own `.bsp` has them.
- **Brush entity textures as the editor shows them**: id's q3map moves a brush entity's
  brushes round its origin after working out their texture vecs for world positions, so
  every door, crate and script object came out shifted by its origin. EA's compiler keeps
  them where the editor shows them; so does ommap now (`AdjustBrushesForOrigin` adds the
  origin into each side's shift and texture matrix). On m3l1b, brush entity vertices with
  the game's own texture position: 2% before, 91% now (the world's: 87%).
- **Windows thread count**: a machine with more than 32 CPUs ran on one thread (q3map's
  limit); it now runs on as many as `MAX_THREADS` (64).

## Compared with EA's compiler

`python tools/bsp_compare.py ours.bsp reference.bsp` compares two `.bsp` files lump by
lump. The reference is EA's own `.map` sources (mohdm6, m4l0) against the game's `.bsp`
files, but the released sources are older than the shipped maps: the game's mohdm6 has
391 clip brushes (`metalclip`, `glassclip`, `woodclip`, `foliageclip`) its released
`.map` doesn't have, m4l0 has 460, so brush and side counts and the shader list can't
match exactly. Leaving those out, mohdm6's brushes come to 2,319 against EA's 2,335 and
their sides to 16,200 against 15,849.

Compiling mohdm6 and m4l0 and comparing them with the game's own:

- The world's bounds, the models, the entities and the static models match.
- **Light grid**: the same cells; colours 15 apart on average (out of 255) on mohdm6,
  6 on m4l0.
- **Lightmaps**: the same size as EA's on 94% of mohdm6's flat faces and 98% of m4l0's
  (so they can be compared texel for texel); surface by surface the median of ours / EA's
  is 1.00 on both maps, texel by texel 7 apart on average on mohdm6 and 8 on m4l0 (a
  colour channel, 0 to 127 as stored).
- **Lights for models**: the same 288 sphere lights on mohdm6 (22 on m4l0), field for
  field. At 3,000 points in mohdm6 (full vis), the lights in reach that both list: 6,772;
  only ours 293, only EA's 556 (where EA's vis sees more). The sun: listed the same at
  2,771 of the 2,783 points that have it.
- **Static model vertex light**: the same layout as EA's (11,602 vertices in mohdm6, every
  model's start and count equal). Lit on EA's own mohdm6 (its geometry and its props'
  places), 12.6 apart a vertex on average out of 255 (mean 195 against 192). Compiled
  from the released sources, 18 apart on mohdm6 (the shipped map moved some lamps) and
  21 on m4l0, 11 leaving out m4l0's trees and bushes, which are still 30 apart: EA's
  leaves are brighter, in the shade most of all.
- **Terrain**: mohdm6's 6 patches have the same flags, heights, texture coordinates and
  neighbours; holes and variance match EA's node for node on both maps (m4l0: every patch
  whose heights are the same in the released source), forced splits 99.5% on mohdm6 and
  99.3% on m4l0. The leaves list patches by EA's rule exactly (checked on EA's own
  `.bsp` files). m4l0 keeps 731 patches against EA's 591 (all 591 among them): the shipped m4l0's terrain
  was trimmed after the source was released (a ring of patches round its edge is gone and
  the patches inside it have holes the source lacks).
- **Fences**: mohdm6's fence brushes have EA's sides, shaders, fence masks and side
  equations, all 82 equations the same as EA's (m4l0: all 14 its source has; the shipped
  m4l0's other 138 are on clip brushes added after its source was released). EA makes
  a few fence brushes detail that ours keep structural (which the game's collision
  doesn't read).
- **Texture coordinates**: the same as EA's at 97% of mohdm6's vertices and 93% of
  m4l0's; the rest mostly textures EA laid out by a size other than the paks' image
  (`basecrete_seem_paint`: 256, its image 128).
**The same .map through both.** EA's own `Q3map.exe` and `MOHlight.exe` (MOHTools), run
under Wine on the developer's machine as a reference only (never shipped or copied here),
compiled the Map Viewer's decompile of m3l1a and New map's room; ommap compiled the same
files:

- **Brushes and sides**: 2,786 brushes and 28,285 sides in both (m3l1a), each prop's
  collision brushes plane for plane the same (checked on a pitched, rolled and scaled prop).
- **The entities** are byte for byte the same size, `map_time` included.
- **Different still**: the shader records' surface and content flags of many sides (which
  sound a footstep or bullet makes, and whether some clip and nodraw sides block shots);
  the BSP splits (m3l1a: 2,065 leaves against 2,150); the light grid's storage (the same
  cells, but EA's colours repeat in long runs, 14 KB against ommap's 1.4 MB); the header's
  checksum (EA writes one, ommap 0; the game passes it on but doesn't check it);
  `lightdef`s.

- **Not the same yet**: `lightdef`s (lump 21, which the game doesn't read); the last 0.5 to 0.8% of the terrain's forced splits;
  terrain casts no shadow, as with EA's (the game's grids and lightmaps fit better
  without it); full vis on large outdoor maps is slow without `-cap` (m4l0: over an hour;
  m3l1b in MBuilder: over 9 hours without finishing), while `-vis -fast` takes seconds.

## Full vis on an open map

m3l1b (Omaha's bunker, decompiled; 1,338 clusters, 4,027 portals, 115 vis groups put back
from the game's `.bsp`), vis on two CPU cores:

| vis | time | clusters seen from a cluster, on average |
|---|---|---|
| `-fast` | 2 s | 1,061 |
| `-cap 10000` | 32 s | 983 |
| `-cap 100000` | 2 min 51 s | 906 |
| no cap | not finished after 22 minutes (MBuilder: over 9 hours) | |

The groups cut what each cluster sees from 1,147 to 1,061 in fast vis. Every capped result
lies within the fast one, and a higher cap only takes clusters away. `-passageOnly -cap
100000`: 31 s, 995.

Against vis run to the end: the decompiled m3l1b without its groups (1,338 clusters, 4,039
portals), compiled with no cap on the developer's machine, sees 862 clusters from a
cluster on average; `-cap 100000` on the same tree, 963 (12% more; 6 min 2 s on two cores
while another vis ran). The capped vis sees every pair of clusters the full one sees both
ways; it differs on 5 of the full one's 1.15 million pairs, each one the full vis sees one
way only, the fringe where q3map's vis depends on the order the portals finish in (two
runs of the same vis can differ there too).
