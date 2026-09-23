# The Nexus Point scene adapter

A canvas is one opaque rectangle. The scene editor can click any DOM element in
a project with no cooperation from it at all, but it cannot see a plant, a unit
or a tile drawn with `ctx.fillRect` - nothing in the browser knows those exist.

This file is the contract that fixes that. A project opts in by defining one
object on `window`. `/nexus-repair` writes that object for you (see
`NEXUS-REPAIR.md`); this document is what it writes against, and what to read if
you want to hand-write one.

## The object

```js
window.__NEXUS_SCENE__ = {
  version: 1,

  // The canvas the objects are drawn on. The editor positions its overlay from
  // this element's box, so it must be the one actually on screen.
  canvas: () => document.getElementById("map"),

  // Everything clickable, in CSS pixels relative to that canvas's top-left
  // corner - the same space a mouse event gives you after subtracting
  // getBoundingClientRect(). NOT device pixels: if you draw at DPR 2, divide.
  objects: () => state.plants.map((p, i) => ({
    id: "plant:" + i,               // stable for as long as the object lives
    kind: "plant",                  // groups objects in the picker
    label: p.name,                  // what the panel calls it
    x: p.sx - 12, y: p.sy - 12, w: 24, h: 24,
    asset: "assets/plants/coal.png",         // optional, see below
    props: { colour: p.colour, radius: p.r } // what the panel offers to edit
  })),

  // Optional. The editor hit-tests the boxes from objects() itself, so supply
  // this only when the game already has a better answer (z-order, odd shapes).
  hitTest: (x, y) => id || null,

  // Change one property live. Preview only - it must never write a file.
  // Follow it with whatever redraw the game needs.
  set: (id, prop, value) => { ... },

  // Where that property actually lives on disk. Two answers are understood:
  //   { registry: "colors.plantBody" } - a key path inside nexus-design.js.
  //     The editor patches that value itself, surgically, with a .bak.
  //   { file: "index.html", token: "const PLANT_COLOURS =" }  - anywhere else.
  //     The editor cannot safely splice that, so it builds Claude a brief
  //     naming the file and the greppable token. Never a line number: they rot.
  source: (id, prop) => ({ registry: "colors.plantBody" }),

  // Optional. Called with true when the editor takes over and false when it
  // leaves. Use it to stop simulation so objects hold still while they are
  // being edited. Without it the editor freezes requestAnimationFrame instead,
  // which is cruder but works.
  pause: (on) => { state.paused = on; },

  // Optional. Called after set(), if one repaint is not automatic.
  redraw: () => draw(),
};
```

Every field except `version`, `canvas`, `objects` and `set` is optional. An
adapter with just those four is already useful: you can click objects and see
them change, and every write is routed to Claude.

## The registry

`nexus-design.js` is where editable values live:

```js
// nexus-design.js - loaded by a plain <script> tag before the game.
window.NEXUS_DESIGN = {
  colors: { plantBody: "#5b7fa8", plantGlow: "#9fd0ff" },
  sizes:  { plantRadius: 12 },
};
```

It is a **.js file, not JSON**, and that is deliberate: `fetch()` of a local
JSON file fails under `file://`, and every one of these projects has to keep
working when you open `index.html` straight off the disk. A `<script>` tag has
no such problem.

The game reads through it with a fallback, so deleting the file degrades to the
old hardcoded value instead of breaking:

```js
const D = (window.NEXUS_DESIGN || {});
const bodyColour = (D.colors && D.colors.plantBody) || "#5b7fa8";
```

## Rules that matter

- `objects()` is called often while the editor is open. Keep it cheap: map over
  arrays the game already has, never allocate a scene graph.
- Coordinates are CSS pixels relative to the canvas. Getting DPR scaling wrong
  is the single most common mistake - the boxes land in the right shape at the
  wrong scale.
- `set()` previews. It must not touch the network or the filesystem, and it must
  not persist to localStorage, or a preview the user abandons will survive a
  reload and look like a bug.
- `id` has to be stable while the object exists. An array index is fine if the
  array is stable; it is not fine if the game splices out of the middle.
- The adapter is additive. Nothing in the game may require it to be present -
  guard with `if (window.__NEXUS_SCENE__)` if the game ever reads it back.