---
name: nexus-repair
description: Make a browser project's art and canvas objects editable in Nexus Point's scene editor - write it a scene adapter and design registry, and turn art that exists only as code (canvas drawing, inline SVG, data: URIs) into real asset files. Use when asked to run nexus-repair or Nexus-Repair, when someone cannot click or edit something in a game's Play tab, when assets Claude made cannot be opened in the Pixel or Design tab, or when a canvas game needs to become editable.
---

# Nexus-Repair

The full playbook lives in `docs/NEXUS-REPAIR.md` inside the nexus-point project
(`<workspace>/Claude Projects/nexus-point/docs/NEXUS-REPAIR.md`). **Read it before
doing anything** - this file only routes you there and states the rules that get
broken most often.

The contract the adapter is written against is `docs/NEXUS-SCENE-ADAPTER.md`
beside it.

## Start here

1. `node "<nexus-point>/tools/scene-report.mjs" "<project folder>"` - a read-only
   survey of the canvases, draw entry points, art that exists only as code,
   inline SVG, data: URIs and hardcoded colours. In the Nexus Point sidebar the
   same thing is `mcp__nexus__scene_report`. Run it first; do not grep blind.
2. Read the target project's own `CLAUDE.md` and `SESSION-HANDOFF.md`. Its
   invariants beat anything in the playbook. If a step would break one, stop and
   say so.
3. Follow `docs/NEXUS-REPAIR.md`.

## The four rules people break

- **Additive by default.** Add `nexus-scene.js`, `nexus-design.js` and real asset
  files. Rewire code only where the swap is provably identical. Hoisting
  constants wholesale is the `deep` run, and only when asked.
- **Back up before the first write**, into `_backups/nexus-repair-<YYYY-MM-DD>/`.
- **`nexus-design.js` is a .js file, not JSON.** `fetch()` of a local JSON file
  fails under `file://`, and these projects must keep working when `index.html`
  is opened straight off the disk. No build step, ever.
- **Report the failures.** `NEXUS-SCENE.md` must say what could NOT be made
  editable and why. A report listing only successes is a bad report.

## Done means

The game loads in the Play tab with a clean console, Edit mode selects one of the
new objects, and changing one value works. Say which claim you are making -
"syntax-checked" and "browser-verified" are different things.