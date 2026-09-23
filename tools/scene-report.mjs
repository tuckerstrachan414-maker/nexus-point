// Read-only survey of what in a project is editable in Nexus Point and what is
// not. Exposed to Claude as mcp__nexus__scene_report (agent.js) and runnable on
// its own: node tools/scene-report.mjs "<project path>"
//
// It answers the questions /nexus-repair opens with - where the canvas is, what
// art exists only as code, which colours are written out by hand - so the work
// starts from a survey instead of a blind grep. It never writes anything.
import fs from "node:fs";
import path from "node:path";

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".html", ".htm", ".ts"]);
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const SKIP = new Set(["node_modules", ".git", "_backups", "dist", "build", ".next", "out", "vendor"]);
// Colours the UI itself never shows: pure black and white are almost always
// structural (borders, shadows) rather than art worth hoisting.
const DULL = new Set(["#000", "#fff", "#000000", "#ffffff"]);

function walk(dir, out = { code: [], images: [], all: [] }, depth = 0) {
  if (depth > 7) return out;
  let e; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    if (SKIP.has(x.name) || x.name.startsWith(".")) continue;
    const full = path.join(dir, x.name);
    if (x.isDirectory()) { walk(full, out, depth + 1); continue; }
    const ext = path.extname(x.name).toLowerCase();
    out.all.push(full);
    if (IMG_EXT.has(ext)) out.images.push(full);
    else if (CODE_EXT.has(ext) && !/\.bak$/i.test(x.name)) {
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size <= 3e6) out.code.push(full);
    }
  }
  return out;
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const QUOTES = new Set([String.fromCharCode(34), String.fromCharCode(39), String.fromCharCode(96)]);

// Where the function body that opens at `openBrace` closes. Quotes and comments
// are skipped, so a brace inside a string cannot end it early. A fixed-size
// window ran past the end of short functions and picked up the drawing in the
// next one, which is how power-grid-tycoon's playSfx was reported as canvas art.
function bodyEnd(src, openBrace) {
  let d = 0;
  for (let i = openBrace; i < src.length && i < openBrace + 40000; i++) {
    const c = src[i];
    if (QUOTES.has(c)) {
      for (i++; i < src.length; i++) { if (src[i] === String.fromCharCode(92)) { i++; continue; } if (src[i] === c) break; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); if (e === -1) return src.length; i = e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e === -1) return src.length; i = e + 1; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (!d) return i + 1; }
  }
  return Math.min(src.length, openBrace + 40000);
}

export function sceneReport(projectPath) {
  const root = path.resolve(projectPath);
  if (!fs.existsSync(root)) return "No such project folder: " + root;
  const files = walk(root);
  const rel = (f) => path.relative(root, f).replaceAll(String.fromCharCode(92), "/");
  const L = [];
  const canvases = [], drawFns = [], inlineSvg = [], dataUris = [], emojiArt = [], ctxRuns = [];
  const colours = new Map();
  let hasAdapter = false, hasRegistry = false, adapterFile = null;

  for (const f of files.all) {
    const b = path.basename(f).toLowerCase();
    if (b === "nexus-scene.js") { hasAdapter = true; adapterFile = rel(f); }
    if (b === "nexus-design.js") hasRegistry = true;
  }

  for (const f of files.code) {
    let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    const r = rel(f);
    const lineAt = (i) => src.slice(0, i).split("\n").length;

    for (const m of src.matchAll(/<canvas\b[^>]*\bid=["']([^"']+)["']/gi)) canvases.push(r + "  <canvas id=\"" + m[1] + "\">");
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.()"'\[\]]*)\.getContext\(/g)) canvases.push(r + "  " + m[1] + " = " + m[2] + ".getContext(...)");
    if (/__NEXUS_SCENE__/.test(src)) hasAdapter = true;
    if (/NEXUS_DESIGN/.test(src)) hasRegistry = true;

    // functions that do a lot of drawing - the entry points an adapter hangs off
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
      const start = m.index;
      const chunk = src.slice(start, bodyEnd(src, m.index + m[0].length - 1));
      const hits = (chunk.match(/\b(ctx|c2|cx|fctx|gfx|context)\s*\.\s*(fillRect|strokeRect|clearRect|arc|beginPath|drawImage|fillText|strokeText|moveTo|lineTo|closePath|fill|stroke|save|restore|translate|setTransform)\b/g) || []).length;
      // A gain node has .gain and .connect; only a 2d context has these.
      const canvasOnly = /\b\w*(?:ctx|context|c2|cx|gfx)\s*\.\s*(?:fillRect|clearRect|drawImage|beginPath|fillText|strokeRect|setTransform)\b/.test(chunk);
      if (hits >= 4 && canvasOnly) drawFns.push(r + ":" + lineAt(start) + "  function " + m[1] + "  (" + hits + " draw calls)");
    }
    // drawing runs with no drawImage in them: art that exists only as code
    for (const m of src.matchAll(/\b(?:ctx|c2|cx|fctx|gfx|context)\s*\.\s*(?:fillRect|arc|ellipse|moveTo|lineTo|quadraticCurveTo|bezierCurveTo|roundRect)\b/g)) {
      ctxRuns.push(lineAt(m.index) + "@" + r);
    }
    for (const m of src.matchAll(/<svg[\s>]/gi)) inlineSvg.push(r + ":" + lineAt(m.index));
    for (const m of src.matchAll(/data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]{40,})/gi)) {
      dataUris.push(r + ":" + lineAt(m.index) + "  " + m[1] + ", " + Math.round(m[2].length * 0.75 / 1024) + " KB");
    }
    for (const m of src.matchAll(/fillText\s*\(\s*(["'`])([^"'`]{1,12})\1/g)) {
      if (EMOJI.test(m[2])) emojiArt.push(r + ":" + lineAt(m.index) + "  fillText(" + m[2] + ")");
    }
    for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = m[0].toLowerCase();
      if (DULL.has(hex) || hex.length === 2) continue;
      if (!colours.has(hex)) colours.set(hex, new Set());
      colours.get(hex).add(r);
    }
  }

  const uniq = (a) => [...new Set(a)];
  const byFile = new Map();
  for (const x of ctxRuns) { const [ln, f] = x.split("@"); if (!byFile.has(f)) byFile.set(f, []); byFile.get(f).push(+ln); }

  L.push("SCENE REPORT for " + path.basename(root));
  L.push(root);
  L.push("");
  L.push("Already wired: adapter " + (hasAdapter ? "YES" + (adapterFile ? " (" + adapterFile + ")" : "") : "no") +
    ", design registry " + (hasRegistry ? "YES" : "no"));
  L.push(files.code.length + " code files, " + files.images.length + " image files on disk");
  L.push("");

  L.push("## Canvases");
  L.push(canvases.length ? uniq(canvases).slice(0, 20).join("\n") : "none - this project is pure DOM, so the scene editor already works on all of it with no repair needed");
  L.push("");

  L.push("## Draw entry points (where an adapter's objects() would read from)");
  L.push(drawFns.length ? drawFns.slice(0, 25).join("\n") : "none found - look for an animation loop instead");
  L.push("");

  L.push("## Art that exists only as code (shape drawing with no drawImage behind it)");
  if (byFile.size) {
    for (const [f, lines] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      const ls = lines.sort((a, b) => a - b);
      L.push("  " + f + "  " + ls.length + " shape calls, lines " + ls[0] + "-" + ls[ls.length - 1]);
    }
    L.push("  NOTE: only materialise these into PNGs where the drawing is STATIC. Anything that");
    L.push("  varies with game state must stay code - a still frame of something animated is a downgrade.");
  } else L.push("  none");
  L.push("");

  L.push("## Inline SVG");
  L.push(inlineSvg.length ? uniq(inlineSvg).slice(0, 20).join("\n") : "  none");
  L.push("");
  L.push("## data: image URIs (decode these to real files)");
  L.push(dataUris.length ? dataUris.slice(0, 20).join("\n") : "  none");
  L.push("");
  L.push("## Emoji drawn as sprites (leave them - replacing them is an art decision, and Tucker's)");
  L.push(emojiArt.length ? uniq(emojiArt).slice(0, 20).join("\n") : "  none");
  L.push("");

  const top = [...colours.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 25);
  L.push("## Hardcoded colours (" + colours.size + " distinct)");
  L.push(top.length ? top.map(([h, fs2]) => "  " + h + "  in " + [...fs2].slice(0, 3).join(", ") + (fs2.size > 3 ? " +" + (fs2.size - 3) + " more" : "")).join("\n") : "  none");
  L.push("  Hoisting these wholesale is the `deep` run only. A default run hoists only the ones");
  L.push("  it actually wires to a scene object's props.");
  L.push("");

  L.push("## Existing image assets");
  L.push(files.images.length ? files.images.slice(0, 30).map((f) => "  " + rel(f)).join("\n") + (files.images.length > 30 ? "\n  ...+" + (files.images.length - 30) + " more" : "") : "  none");
  return L.join("\n");
}

if (import.meta.url === "file://" + process.argv[1].replaceAll(String.fromCharCode(92), "/") || process.argv[1] && process.argv[1].endsWith("scene-report.mjs")) {
  const target = process.argv[2];
  if (!target) { console.log('usage: node tools/scene-report.mjs "<project folder>"'); process.exit(1); }
  console.log(sceneReport(target));
}