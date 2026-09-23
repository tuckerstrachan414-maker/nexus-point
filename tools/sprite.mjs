// sprite.mjs - read/write/edit any sprite in this workspace from the command line.
// Zero dependencies (png.mjs + node builtins). Built so Claude can SEE pixel art as
// text, diff it, and write exact pixels back - the Pixel tab is the human's hands,
// this is Claude's.
//
//   node tools/sprite.mjs info   <png> [--cell 32x32]
//   node tools/sprite.mjs show   <png> [--cell 32x32 --frame cx,cy | --rect x,y,w,h]
//   node tools/sprite.mjs diff   <png> [--against other.png | --bak] [--cell 32x32]
//   node tools/sprite.mjs write  <png> [--cell 32x32 --frame cx,cy | --rect x,y,w,h] --art art.txt
//   node tools/sprite.mjs set    <png> --px "x,y=#rrggbb;x,y=none" [--frame cx,cy --cell WxH]
//   node tools/sprite.mjs recolor <png> --from "#aabbcc" --to "#ddeeff" [--frame cx,cy]
//   node tools/sprite.mjs copy   <png> --cell 32x32 --from cx,cy --to cx,cy[;cx,cy] [--flipx]
//
// Every command that writes copies the file to <name>.png.bak first if no .bak
// exists - same rule as the Pixel tab. Only Tucker deletes .baks.
import fs from "node:fs";
import { readPng, writePng } from "./png.mjs";

const CHARS = ".0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!@$%&*+=<>?";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

const hex = (r, g, b, a) => a === 0 ? "none"
  : "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("") + (a === 255 ? "" : a.toString(16).padStart(2, "0"));

function parseHex(s) {
  if (!s || s === "none" || s === ".") return [0, 0, 0, 0];
  const v = s.replace("#", "");
  const n = parseInt(v.slice(0, 6), 16);
  const a = v.length >= 8 ? parseInt(v.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

function px(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0, 0];
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function setPx(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = rgba[0]; img.data[i + 1] = rgba[1]; img.data[i + 2] = rgba[2]; img.data[i + 3] = rgba[3];
}

function parseCell(s) {
  if (!s) return null;
  const m = String(s).split(/[x,]/).map(Number);
  return { w: m[0], h: m[1] === undefined ? m[0] : m[1] };
}

// Region = the whole image, or one cell of a sheet, or an explicit rect.
function region(img, a) {
  if (a.rect) {
    const [x, y, w, h] = String(a.rect).split(",").map(Number);
    return { x, y, w, h };
  }
  const cell = parseCell(a.cell);
  if (cell && a.frame) {
    const [cx, cy] = String(a.frame).split(",").map(Number);
    return { x: cx * cell.w, y: cy * cell.h, w: cell.w, h: cell.h };
  }
  return { x: 0, y: 0, w: img.width, h: img.height };
}

function backup(file) {
  const bak = file + ".bak";
  if (!fs.existsSync(bak)) { fs.copyFileSync(file, bak); return bak; }
  return null;
}

// ---- rendering pixel art as text ----------------------------------------
// One char per pixel plus a legend, so a frame can be read, reasoned about, and
// written back byte-identically. "." is always transparent.
function toArt(img, r) {
  const map = new Map();
  const rows = [];
  for (let y = 0; y < r.h; y++) {
    let row = "";
    for (let x = 0; x < r.w; x++) {
      const p = px(img, r.x + x, r.y + y);
      const key = p[3] === 0 ? "none" : hex(...p);
      if (key === "none") { row += "."; continue; }
      if (!map.has(key)) {
        const ch = CHARS[map.size + 1];
        if (!ch) throw new Error("more than " + (CHARS.length - 1) + " colours in this region");
        map.set(key, ch);
      }
      row += map.get(key);
    }
    rows.push(row);
  }
  return { rows, legend: [...map.entries()] };
}

function printArt(img, r, label) {
  const { rows, legend } = toArt(img, r);
  console.log("# " + (label || "") + " region x=" + r.x + " y=" + r.y + " w=" + r.w + " h=" + r.h);
  for (const [color, ch] of legend) console.log("# " + ch + " = " + color);
  console.log("# . = transparent");
  const digits = String(r.h - 1).length;
  console.log("#" + " ".repeat(digits + 1) + [...Array(r.w)].map((_, i) => i % 10).join(""));
  rows.forEach((row, i) => console.log(String(i).padStart(digits) + " " + row));
}

// Parse the same format back: "# <ch> = #rrggbb" legend lines, then rows that may
// carry a leading row number.
function parseArt(text) {
  const legend = new Map([[".", [0, 0, 0, 0]]]);
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = line.match(/^#\s*(\S)\s*=\s*(\S+)\s*$/);
      if (m) legend.set(m[1], parseHex(m[2] === "transparent" ? "none" : m[2]));
      continue;
    }
    rows.push(line.replace(/^\s*\d+\s/, ""));
  }
  const w = Math.max(...rows.map((r) => r.length));
  return { rows, w, h: rows.length, legend };
}

// ---- commands -----------------------------------------------------------
const cmds = {};

cmds.info = (file, a) => {
  const img = readPng(file);
  console.log(file);
  console.log("  size " + img.width + "x" + img.height);
  const colors = new Map();
  let solid = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const p = px(img, x, y);
    if (p[3] === 0) continue;
    solid++;
    const k = hex(...p);
    colors.set(k, (colors.get(k) || 0) + 1);
  }
  console.log("  " + solid + " opaque px, " + colors.size + " colours");
  const cell = parseCell(a.cell);
  if (cell) {
    const cols = Math.floor(img.width / cell.w), rows = Math.floor(img.height / cell.h);
    console.log("  grid " + cols + "x" + rows + " of " + cell.w + "x" + cell.h + " cells:");
    for (let cy = 0; cy < rows; cy++) {
      let line = "   ";
      for (let cx = 0; cx < cols; cx++) {
        let n = 0;
        for (let y = 0; y < cell.h; y++) for (let x = 0; x < cell.w; x++) if (px(img, cx * cell.w + x, cy * cell.h + y)[3]) n++;
        line += (n ? String(n).padStart(4) : "   -");
      }
      console.log(line + "   <- row " + cy + " (opaque px per frame)");
    }
  } else {
    console.log("  suggested cell sizes: " + [8, 16, 24, 32, 48, 64]
      .filter((n) => img.width % n === 0 && img.height % n === 0)
      .map((n) => n + "x" + n + " (" + (img.width / n) + "x" + (img.height / n) + " frames)").join(", "));
  }
  const top = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log("  top colours: " + top.map(([c, n]) => c + " x" + n).join(", "));
};

cmds.show = (file, a) => {
  const img = readPng(file);
  printArt(img, region(img, a), file);
};

cmds.diff = (file, a) => {
  const other = a.against || (a.bak ? file + ".bak" : null);
  if (!other) throw new Error("diff needs --against <file.png> or --bak");
  if (!fs.existsSync(other)) throw new Error("nothing to compare against: " + other);
  // Convention: <file> is the NEW state, <other> the OLD one.
  const nu = readPng(file), old = readPng(other);
  if (nu.width !== old.width || nu.height !== old.height) throw new Error("sizes differ - cannot diff");
  const cell = parseCell(a.cell);
  const changed = [];
  for (let y = 0; y < nu.height; y++) for (let x = 0; x < nu.width; x++) {
    const p = px(nu, x, y), q = px(old, x, y);
    if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2] || p[3] !== q[3]) changed.push({ x, y, from: hex(...q), to: hex(...p) });
  }
  console.log("# new: " + file);
  console.log("# old: " + other);
  console.log("# " + changed.length + " pixels differ");
  if (!changed.length) return;
  const byFrame = new Map();
  for (const c of changed) {
    const key = cell ? Math.floor(c.x / cell.w) + "," + Math.floor(c.y / cell.h) : "whole image";
    if (!byFrame.has(key)) byFrame.set(key, []);
    byFrame.get(key).push(c);
  }
  for (const [frame, list] of byFrame) {
    const xs = list.map((c) => c.x), ys = list.map((c) => c.y);
    console.log("\n# frame " + frame + ": " + list.length + " px changed, bbox x " +
      Math.min(...xs) + ".." + Math.max(...xs) + " y " + Math.min(...ys) + ".." + Math.max(...ys));
    if (a.px) for (const c of list) console.log("  " + c.x + "," + c.y + "  " + c.from + " -> " + c.to);
  }
  // Side-by-side art of the changed frames makes the edit readable at a glance.
  if (a.art) {
    for (const [frame, list] of byFrame) {
      if (frame === "whole image") continue;
      const [cx, cy] = frame.split(",").map(Number);
      const r = { x: cx * cell.w, y: cy * cell.h, w: cell.w, h: cell.h };
      console.log("\n===== frame " + frame + " BEFORE =====");
      printArt(old, r, other);
      console.log("\n===== frame " + frame + " AFTER =====");
      printArt(nu, r, file);
    }
  }
};

cmds.write = (file, a) => {
  if (!a.art) throw new Error("write needs --art <file with the art grid>");
  const img = readPng(file);
  const r = region(img, a);
  const art = parseArt(fs.readFileSync(a.art, "utf8"));
  if (art.w !== r.w || art.h !== r.h) {
    throw new Error("art is " + art.w + "x" + art.h + " but the target region is " + r.w + "x" + r.h);
  }
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const ch = art.rows[y][x] ?? ".";
      const rgba = art.legend.get(ch);
      if (!rgba) throw new Error("char '" + ch + "' at " + x + "," + y + " is not in the legend");
      setPx(img, r.x + x, r.y + y, rgba);
    }
  }
  const bak = backup(file);
  writePng(file, img);
  console.log("wrote " + r.w + "x" + r.h + " at " + r.x + "," + r.y + " into " + file + (bak ? " (kept " + bak + ")" : ""));
};

cmds.set = (file, a) => {
  if (!a.px) throw new Error('set needs --px "x,y=#rrggbb;x,y=none"');
  const img = readPng(file);
  const r = region(img, a);
  let n = 0;
  for (const part of String(a.px).split(";").filter(Boolean)) {
    const [coord, color] = part.split("=");
    const [x, y] = coord.split(",").map(Number);
    setPx(img, r.x + x, r.y + y, parseHex(color));
    n++;
  }
  const bak = backup(file);
  writePng(file, img);
  console.log("set " + n + " px in " + file + (bak ? " (kept " + bak + ")" : ""));
};

// Recolour is the one edit that propagates across every frame with zero risk:
// the same colour means the same thing in every pose.
cmds.recolor = (file, a) => {
  if (!a.from || !a.to) throw new Error('recolor needs --from "#aabbcc" --to "#ddeeff"');
  const img = readPng(file);
  const r = region(img, a);
  const from = parseHex(a.from), to = parseHex(a.to);
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const p = px(img, x, y);
    if (p[0] === from[0] && p[1] === from[1] && p[2] === from[2] && (from[3] === 255 || p[3] === from[3])) {
      setPx(img, x, y, [to[0], to[1], to[2], to[3] === 255 ? p[3] : to[3]]);
      n++;
    }
  }
  if (!n) { console.log("no pixels matched " + a.from + " - nothing written"); return; }
  const bak = backup(file);
  writePng(file, img);
  console.log("recoloured " + n + " px " + a.from + " -> " + a.to + " in " + file + (bak ? " (kept " + bak + ")" : ""));
};

cmds.copy = (file, a) => {
  const cell = parseCell(a.cell);
  if (!cell || !a.from || !a.to) throw new Error("copy needs --cell WxH --from cx,cy --to cx,cy[;cx,cy]");
  const img = readPng(file);
  const [fx, fy] = String(a.from).split(",").map(Number);
  const buf = [];
  for (let y = 0; y < cell.h; y++) for (let x = 0; x < cell.w; x++) buf.push(px(img, fx * cell.w + x, fy * cell.h + y));
  let frames = 0;
  for (const t of String(a.to).split(";").filter(Boolean)) {
    const [tx, ty] = t.split(",").map(Number);
    for (let y = 0; y < cell.h; y++) for (let x = 0; x < cell.w; x++) {
      const sx = a.flipx ? cell.w - 1 - x : x;
      const sy = a.flipy ? cell.h - 1 - y : y;
      setPx(img, tx * cell.w + x, ty * cell.h + y, buf[sy * cell.w + sx]);
    }
    frames++;
  }
  const bak = backup(file);
  writePng(file, img);
  console.log("copied frame " + a.from + " into " + frames + " frame(s)" + (bak ? " (kept " + bak + ")" : ""));
};

// Does this patch of pixels recur in the other frames? Answers the only question
// that matters before propagating an edit mechanically: 100% means a paste is
// safe, anything less means the art differs there and must be redrawn.
cmds.find = (file, a) => {
  const cell = parseCell(a.cell);
  if (!cell || !a.rect) throw new Error("find needs --cell WxH --rect x,y,w,h (the patch to look for)");
  const img = readPng(file);
  const [rx, ry, rw, rh] = String(a.rect).split(",").map(Number);
  const tpl = [];
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) tpl.push(px(img, rx + x, ry + y));
  const solid = tpl.filter((p) => p[3] > 0).length;
  const XF = { none: (x, y) => [x, y], flipx: (x, y) => [rw - 1 - x, y], flipy: (x, y) => [x, rh - 1 - y], rot180: (x, y) => [rw - 1 - x, rh - 1 - y] };
  const cols = Math.floor(img.width / cell.w), rows = Math.floor(img.height / cell.h);
  console.log("# patch " + rw + "x" + rh + " at " + rx + "," + ry + " (" + solid + " opaque px), searched in every frame:");
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    let empty = true;
    for (let y = 0; y < cell.h && empty; y++) for (let x = 0; x < cell.w; x++) if (px(img, cx * cell.w + x, cy * cell.h + y)[3]) { empty = false; break; }
    if (empty) continue;
    let best = { score: 0, dx: 0, dy: 0, xf: "none" };
    for (const [name, fn] of Object.entries(XF)) {
      for (let oy = -rh; oy < cell.h; oy++) for (let ox = -rw; ox < cell.w; ox++) {
        let same = 0, on = 0;
        for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
          const [sx, sy] = fn(x, y);
          const t = tpl[sy * rw + sx];
          if (t[3] === 0) continue;
          on++;
          const g = px(img, cx * cell.w + ox + x, cy * cell.h + oy + y);
          if (g[3] > 0 && g[0] === t[0] && g[1] === t[1] && g[2] === t[2]) same++;
        }
        const sc = on ? same / on : 0;
        if (sc > best.score) best = { score: sc, dx: ox, dy: oy, xf: name };
      }
    }
    const verdict = best.score >= 0.999 ? "IDENTICAL - a paste is safe"
      : best.score >= 0.9 ? "near match - check before pasting"
      : "different art here - must be redrawn";
    console.log("  frame " + cx + "," + cy + "  best " + (best.score * 100).toFixed(0) + "% at dx=" + best.dx +
      " dy=" + best.dy + " " + best.xf + "  " + verdict);
  }
};

const a = args(process.argv.slice(2));
const cmd = a._[0], file = a._[1];
if (!cmd || !cmds[cmd] || !file) {
  const NL = String.fromCharCode(10);
  const src = fs.readFileSync(new URL(import.meta.url), "utf8").split(NL).slice(1);
  const help = [];
  for (const l of src) { if (!l.startsWith("//")) break; help.push(l.slice(3)); }
  console.log(help.join(NL));
  process.exit(cmd ? 1 : 0);
}
try {
  cmds[cmd](file, a);
} catch (err) {
  console.error("error: " + err.message);
  process.exit(1);
}
