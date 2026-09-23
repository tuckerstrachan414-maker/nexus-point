# Nexus-Repair

The playbook behind `/nexus-repair`. The sidebar's command, its quick action and
the `.claude/skills/nexus-repair` skill all point here, so this file is the one
copy to keep correct.

## What it is for

Two things in a project are invisible to the scene editor:

1. **Canvas objects.** A canvas is one opaque rectangle. Nothing in the browser
   knows a plant or a unit is drawn there, so nothing can be clicked.
2. **Art that is not a file.** Sprites drawn with `ctx.*` calls, inline `<svg>`,
   `data:image/...` URIs, emoji used as sprites, CSS-gradient art. The Pixel tab
   can only open a `.png` and the Design tab only a `.svg`; none of these are
   either, so there is nothing to open.

Nexus-Repair closes both: it writes the project a scene adapter, hoists the
values worth editing into a registry, and turns art-that-is-not-a-file into real
files in `assets/`. Afterwards the Play tab's Edit button can click the game's
own objects, and the Assets tab can open its art.

## The rule: additive by default

The default run may **add** files and may rewire code **only where the swap is
provably identical**. It may not restructure the game, rename things, or hoist
constants wholesale. That deeper pass happens only when the run is asked for
with `deep`, and even then one subsystem at a time.

Tucker's projects are the real, live folders. There is no import step and no
copy. Treat every write as a write to something he is shipping.

## Order of work

**0. Read first.** The target project's `CLAUDE.md` and `SESSION-HANDOFF.md`, if
they exist. Its invariants win over anything in this file. Power-grid-tycoon's
`INCOME_RATE === BLACKOUT_RATE` is the kind of thing that must not be disturbed
by a "harmless" refactor. If a step here would break a documented invariant,
stop and say so instead.

**1. Scan.** Call `mcp__nexus__scene_report` on the project. It reports canvases
and their draw entry points, runs of `ctx.*` drawing with no image behind them,
inline `<svg>`, `data:image/` URIs, emoji-as-sprite, hardcoded colour literals
with counts and files, and whether an adapter or registry already exists. Read
its output before opening anything - it is there so you do not grep blind.

**2. Back up.** Copy every file you are about to touch into
`_backups/nexus-repair-<YYYY-MM-DD>/`, preserving relative paths. Do this before
the first write, not after the third.

**3. Materialise the art that is not a file.** For each item worth rescuing:
   - inline `<svg>` and SVG built in JS strings -> a real `.svg` in `assets/`,
     referenced by `<img src>` or loaded as an Image.
   - `data:image/png;base64,...` -> decode to a real `.png` in `assets/`.
   - procedurally drawn sprites -> only when the drawing is static (same output
     every frame, no game state in it). Render it once to a PNG with
     `tools/sprite.mjs` and swap the draw call for a `drawImage`. If the drawing
     varies with state, leave it alone and say so in the report; a still frame
     of something animated is a downgrade, not a repair.
   - emoji used as a sprite -> leave it. Say it in the report. Replacing an
     emoji with art is an art decision and it is Tucker's, not yours.

**4. Write the registry.** `nexus-design.js` at the project root, assigning
`window.NEXUS_DESIGN`, loaded by a plain `<script>` tag **before** the game's own
scripts. Not JSON: `fetch()` of a local JSON file fails under `file://` and every
one of these projects must keep working from `file://`.

   Each value the game reads must fall back to what it used to be, so deleting
   the registry degrades instead of breaking:
   `const c = (window.NEXUS_DESIGN?.colors?.plantBody) || "#5b7fa8";`

   In the default run, put in the registry only values you actually wired to a
   scene object's `props`. An unused key is noise.

**5. Write the adapter.** `nexus-scene.js`, implementing the contract in
`NEXUS-SCENE-ADAPTER.md`, loaded after the game so it can see its state. Build
`objects()` by mapping the arrays the game already keeps - do not invent a scene
graph and do not cache one. Coordinates are CSS pixels relative to the canvas:
if the game draws at DPR 2, divide, and check that on screen rather than
assuming.

**6. Report.** `NEXUS-SCENE.md` in the target project:
   - what is now clickable and editable, and where each value lives
   - **what is not, and why** - this half is the point. "The terrain is
     generated per seed, so there is no single value to edit" is a useful
     sentence; silence is not.
   - what a future session would have to do to go further

**7. Verify, and say which kind.** Load the project in the Play tab, confirm the
console is clean, press Edit, click one of the new objects, and change one value.
Only then is it done. "Syntax-checked" and "browser-verified" are different
claims - make the one that is true. If something could not be verified, list it.

## What a good run looks like

- Files added: `nexus-design.js`, `nexus-scene.js`, `NEXUS-SCENE.md`, some
  `assets/*.png` or `*.svg`.
- Files changed: `index.html` gains two `<script>` tags; a handful of draw calls
  read from the registry instead of a literal.
- Files backed up: everything in the second list, in
  `_backups/nexus-repair-<date>/`.
- Nothing renamed, nothing restructured, no build step, no new dependency.

## What a bad run looks like

- A registry with 200 keys the adapter never mentions.
- A "harmless" tidy-up of code that was not in the way.
- A still PNG standing in for something that used to animate.
- A report that lists only successes.
- Claiming done without loading the game.