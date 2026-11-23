# STAAD Viewer

A single-file, offline viewer for STAAD.Pro input files (`.std`). No install, no
server, nothing is uploaded: the file is read and drawn entirely in your browser.

## Use

1. Open `staad-viewer.html` in any modern browser (double-click it).
2. Click **Open .std…** or drop a `.std` file onto the window.

| Action | How |
| --- | --- |
| Orbit | drag |
| Pan | Shift-drag, right-drag or middle-drag (two fingers on touch) |
| Zoom | mouse wheel / pinch |
| Select | click a node, member or plate |
| Centre on something | double-click it |
| Jump to an entity | type `n12`, `m7` or `p3` in the Find box and press Enter |
| Views | `1` iso, `2` front, `3` side, `4` top, `F` fit, `P` perspective, `Esc` clear selection |

The side panel has four tabs: **Model** (summary, checks, display options,
colour-by, load cases), **Selection** (properties of the clicked entity),
**Tables** (nodes, members, plates, supports, sections) and **Source** (the raw
file, with the line that defines the selected entity highlighted).

## What it reads

The text command file that STAAD.Pro saves (`.std`):

- `JOINT COORDINATES` including generation, `REPEAT` / `REPEAT ALL`, `CYLINDRICAL` and `CYLINDRICAL REVERSE`
- `MEMBER INCIDENCES` and `ELEMENT INCIDENCES` (shell and solid) including generation and `REPEAT`
- `UNIT` changes anywhere in the file, `SET Z UP`
- `MEMBER PROPERTY`, `ELEMENT PROPERTY`, `CONSTANTS` (`BETA`, `MATERIAL`), `DEFINE MATERIAL`
- `SUPPORTS`, `MEMBER RELEASE`, `MEMBER TRUSS / TENSION / COMPRESSION / CABLE`
- group definitions, used both in lists and for colouring
- load cases: joint loads, member `UNI` / `CON` / `LIN` / `TRAP` loads, plate pressure and
  self-weight are drawn; every other load command is listed as text. Load combinations are listed.
- abbreviated commands (`JOI COO`, `MEM INC`, …), `;` separators, `-` line continuations, `*` comments

## What it does not do

- It is a viewer for the model definition, not a solver: there are no analysis
  results (deflections, forces, reactions).
- Only the `.std` input file is read. The `.ANL` output report and the binary
  result files STAAD writes next to it (`.BMD`, `.DSP`, `.REA`, …) are not.
- Members are drawn as lines, not as extruded section shapes.
- Generated meshes and loads (`GENERATE ELEMENT`, `DEFINE MESH`, floor/area/wind
  load distribution) are not expanded.
