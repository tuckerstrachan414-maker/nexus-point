// Pixel tab v2 (2026-09-03): an Aseprite-class pixel editor for the PNGs in the
// open project. Layers (kept in a <file>.png.layers.json sidecar), selections
// (rect/ellipse/lasso/wand + move/copy/paste), a full tool set with per-tool
// options, symmetry, dithering, palettes, an HSV picker, cell/frame navigation
// with playback and onion skin, image adjustments, and deep undo. Saves the
// flattened PNG in place through POST /api/image (first save keeps a .bak).
// Claude hooks: Changes-vs-.bak overlay, "Apply to frames", "Draw in this cell".
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.NexusUI, I = window.NexusIcons;
  const stage = $("pixel-stage"), view = $("pixel-canvas"), ctx = view.getContext("2d");
  const hint = $("pixel-hint"), statusEl = $("pixel-status");
  const SEP = String.fromCharCode(92);
  // Filled from /api/env at boot. Never hardcode the workspace path again -
  // it was renamed once and every copy of it stranded the app.
  let TOOL_CLI = 'node "tools/sprite.mjs"';
  fetch("/api/env").then((r) => r.json()).then((e) => { if (e && e.spriteCli) TOOL_CLI = e.spriteCli; }).catch(() => {});

  // ---- state ----
  // Document: layers of equal size; comp is the flattened composite.
  const D = { w: 0, h: 0, layers: [], active: 0, path: null, label: "", loaded: false, dirty: false, hadSidecar: false };
  const comp = document.createElement("canvas"), compCtx = comp.getContext("2d", { willReadFrequently: true });
  let compDirty = true;
  // View + toggles (persisted).
  const V = Object.assign({ zoom: 8, panX: 0, panY: 0, grid: true, cells: true, checker: true, tiled: false, onion: false, symLines: true, dock: true, dockTab: "color" },
    JSON.parse(localStorage.getItem("nexus-px-view") || "{}"));
  // Tool settings (persisted).
  const T = Object.assign({ tool: "pencil", size: 1, shape: "square", perfect: true, dither: false, symX: false, symY: false, fillMode: "outline", tolerance: 0, contiguous: true,
    selMode: "replace", gradMode: "linear", gradDither: true, shadeAmt: 8, sample: "layer", wrap: false },
    JSON.parse(localStorage.getItem("nexus-px-tools") || "{}"));
  const C = { primary: [255, 255, 255, 255], secondary: [0, 0, 0, 0], target: "primary", recent: [] };
  const SEL = { mask: null, bbox: null, edges: null, ants: 0 };      // mask: Uint8Array(w*h)
  const FLOAT = { cv: null, x: 0, y: 0, mask: null };                  // pixels lifted by Move/Paste
  const CELL = { w: 0, h: 0, focus: null, fps: 8, playing: false, frame: 0, from: 0, to: 0, onionPrev: 1, onionNext: 1 };
  const CLIP = { cv: null, x: 0, y: 0, mask: null };
  const H = { undo: [], redo: [], bytes: 0, MAX: 120, BUDGET: 48e6 };
  const P = { drawing: false, panning: false, space: false, start: null, last: null, pts: [], snap: null, snapImg: null, button: 0, visited: null, lasso: [], hover: null, moveStart: null, gradEnd: null };
  const DIFF = { show: false, pts: null, frames: null, bbox: null, bak: null };
  const saveView = () => localStorage.setItem("nexus-px-view", JSON.stringify(V));
  const saveTools = () => localStorage.setItem("nexus-px-tools", JSON.stringify(T));

  function setStatus(msg, bad) { statusEl.textContent = msg || ""; statusEl.className = bad ? "bad" : ""; }

  // ---- colour utils ----
  const rgbaEq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  const toHex = (c, withA) => "#" + [c[0], c[1], c[2]].map((n) => n.toString(16).padStart(2, "0")).join("") + (withA && c[3] !== 255 ? c[3].toString(16).padStart(2, "0") : "");
  function parseHex(s) {
    s = String(s || "").trim().replace("#", "");
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split("").map((ch) => ch + ch).join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return null;
    const n = parseInt(s.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, s.length === 8 ? parseInt(s.slice(6), 16) : 255];
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, max ? d / max : 0, max];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const colorDist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));

  // ---- layers ----
  let layerSeq = 1;
  function newLayer(name, w, h) {
    const cv = document.createElement("canvas"); cv.width = w || D.w; cv.height = h || D.h;
    return { id: layerSeq++, name: name || "Layer " + layerSeq, visible: true, locked: false, opacity: 1, cv, cx: cv.getContext("2d", { willReadFrequently: true }) };
  }
  const L = () => D.layers[D.active];
  function compose() {
    if (!compDirty) return comp;
    if (comp.width !== D.w || comp.height !== D.h) { comp.width = D.w; comp.height = D.h; }
    compCtx.clearRect(0, 0, D.w, D.h);
    for (const l of D.layers) {
      if (!l.visible) continue;
      compCtx.globalAlpha = l.opacity;
      compCtx.drawImage(l.cv, 0, 0);
    }
    compCtx.globalAlpha = 1;
    compDirty = false;
    return comp;
  }
  function touch() { compDirty = true; }
  function markDirty() { if (!D.dirty) { D.dirty = true; } setStatus("unsaved changes"); }

  // ---- geometry ----
  function bounds() {
    if (CELL.focus && CELL.w > 0 && CELL.h > 0) return { x: CELL.focus.cx * CELL.w, y: CELL.focus.cy * CELL.h, w: CELL.w, h: CELL.h };
    return { x: 0, y: 0, w: D.w, h: D.h };
  }
  function inBounds(x, y) {
    const b = bounds();
    if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return false;
    return !SEL.mask || SEL.mask[y * D.w + x] === 1;
  }
  const inImage = (x, y) => x >= 0 && y >= 0 && x < D.w && y < D.h;
  function toImage(ev) {
    const r = view.getBoundingClientRect();
    return { x: Math.floor((ev.clientX - r.left - V.panX) / V.zoom), y: Math.floor((ev.clientY - r.top - V.panY) / V.zoom), fx: (ev.clientX - r.left - V.panX) / V.zoom, fy: (ev.clientY - r.top - V.panY) / V.zoom };
  }
  function fit(target) {
    const b = target || { x: 0, y: 0, w: D.w, h: D.h };
    if (!b.w || !b.h) return;
    const pad = 24;
    const z = Math.min((view.width - pad) / b.w, (view.height - pad) / b.h);
    V.zoom = clamp(Math.floor(z) || 1, 1, 64);
    V.panX = Math.round((view.width - b.w * V.zoom) / 2 - b.x * V.zoom);
    V.panY = Math.round((view.height - b.h * V.zoom) / 2 - b.y * V.zoom);
  }
  function zoomAt(clientX, clientY, dir) {
    const steps = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
    let i = steps.findIndex((s) => s >= V.zoom); if (i < 0) i = steps.length - 1;
    const next = steps[clamp(i + dir, 0, steps.length - 1)];
    if (next === V.zoom) return;
    const r = view.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const ix = (mx - V.panX) / V.zoom, iy = (my - V.panY) / V.zoom;
    V.zoom = next;
    V.panX = Math.round(mx - ix * V.zoom);
    V.panY = Math.round(my - iy * V.zoom);
  }
  function resize() {
    const w = Math.max(50, stage.clientWidth), h = Math.max(50, stage.clientHeight);
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  }

  // ---- selection ----
  function setMask(mask, silent) {
    SEL.mask = mask;
    if (mask) {
      let x0 = D.w, y0 = D.h, x1 = -1, y1 = -1, any = false;
      for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) if (mask[y * D.w + x]) { any = true; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (!any) { SEL.mask = null; SEL.bbox = null; SEL.edges = null; }
      else { SEL.bbox = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; computeEdges(); }
    } else { SEL.bbox = null; SEL.edges = null; }
    if (!silent) updateStatusBar();
  }
  // Marching-ants outline: every edge between a selected pixel and a non-selected one.
  function computeEdges() {
    const m = SEL.mask, w = D.w, h = D.h, e = [];
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
    const b = SEL.bbox;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) e.push([x, y, x + 1, y]);
      if (!at(x, y + 1)) e.push([x, y + 1, x + 1, y + 1]);
      if (!at(x - 1, y)) e.push([x, y, x, y + 1]);
      if (!at(x + 1, y)) e.push([x + 1, y, x + 1, y + 1]);
    }
    SEL.edges = e;
  }
  function maskFromRect(x0, y0, x1, y1, ellipse) {
    const m = new Uint8Array(D.w * D.h);
    const ax = Math.max(0, Math.min(x0, x1)), bx = Math.min(D.w - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1)), by = Math.min(D.h - 1, Math.max(y0, y1));
    const cxm = (ax + bx) / 2, cym = (ay + by) / 2, rx = (bx - ax) / 2 + 0.5, ry = (by - ay) / 2 + 0.5;
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      if (ellipse) { const dx = (x + 0.5 - cxm - 0.5) / rx, dy = (y + 0.5 - cym - 0.5) / ry; if (dx * dx + dy * dy > 1) continue; }
      m[y * D.w + x] = 1;
    }
    return m;
  }
  function combineMask(next) {
    if (!SEL.mask || T.selMode === "replace") return next;
    const out = new Uint8Array(D.w * D.h);
    for (let i = 0; i < out.length; i++) out[i] = T.selMode === "add" ? (SEL.mask[i] | next[i]) : (SEL.mask[i] && !next[i] ? 1 : 0);
    return out;
  }

  // ---- history: rect patches for pixel edits, closures for structure ----
  function pushHistory(entry) {
    H.undo.push(entry); H.redo.length = 0; H.bytes += entry.bytes || 0;
    while (H.undo.length > H.MAX || (H.bytes > H.BUDGET && H.undo.length > 1)) { const e = H.undo.shift(); H.bytes -= e.bytes || 0; }
  }
  // Compare a layer's pixels against a snapshot and store only the changed rect.
  function commitPatch(layer, beforeImg, label) {
    const after = layer.cx.getImageData(0, 0, D.w, D.h), a = beforeImg.data, b = after.data;
    let x0 = D.w, y0 = D.h, x1 = -1, y1 = -1;
    for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) {
      const i = (y * D.w + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return false;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const tmp = document.createElement("canvas"); tmp.width = D.w; tmp.height = D.h; const tc = tmp.getContext("2d"); tc.putImageData(beforeImg, 0, 0);
    const before = tc.getImageData(x0, y0, w, h), now = layer.cx.getImageData(x0, y0, w, h);
    const id = layer.id;
    pushHistory({ label, bytes: w * h * 8, undo: () => putOn(id, before, x0, y0), redo: () => putOn(id, now, x0, y0) });
    markDirty(); touch();
    return true;
  }
  function putOn(layerId, img, x, y) { const l = D.layers.find((q) => q.id === layerId); if (l) { l.cx.putImageData(img, x, y); touch(); } }
  function snapshotMask() { return SEL.mask ? new Uint8Array(SEL.mask) : null; }
  function pushSelectionHistory(before) {
    const after = snapshotMask();
    pushHistory({ label: "selection", bytes: D.w * D.h * 2, undo: () => setMask(before ? new Uint8Array(before) : null), redo: () => setMask(after ? new Uint8Array(after) : null) });
  }
  function undo() { const e = H.undo.pop(); if (!e) return; e.undo(); H.redo.push(e); markDirty(); touch(); refreshLayers(); render(); }
  function redo() { const e = H.redo.pop(); if (!e) return; e.redo(); H.undo.push(e); markDirty(); touch(); refreshLayers(); render(); }

  // ---- brush + pixel primitives (operate on an ImageData of the active layer) ----
  let brushOffsets = [[0, 0]];
  function buildBrush() {
    const n = T.size, out = [], o = Math.floor((n - 1) / 2), r = n / 2;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) {
      if (T.shape === "circle" && n > 2) { const cx = dx + 0.5 - r, cy = dy + 0.5 - r; if (cx * cx + cy * cy > r * r) continue; }
      out.push([dx - o, dy - o]);
    }
    brushOffsets = out.length ? out : [[0, 0]];
  }
  function putPx(img, x, y, c) {
    if (!inBounds(x, y)) return;
    const i = (y * D.w + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = c[3];
  }
  function getPx(img, x, y) { const i = (y * D.w + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; }
  // One brush dab, with symmetry and dithering applied.
  function dab(img, x, y, color, erase) {
    const b = bounds();
    const pts = [[x, y]];
    if (T.symX) pts.push([b.x + b.w - 1 - (x - b.x), y]);
    if (T.symY) pts.push([x, b.y + b.h - 1 - (y - b.y)]);
    if (T.symX && T.symY) pts.push([b.x + b.w - 1 - (x - b.x), b.y + b.h - 1 - (y - b.y)]);
    for (const [px, py] of pts) for (const [dx, dy] of brushOffsets) {
      const qx = px + dx, qy = py + dy;
      let c = color;
      if (T.dither && !erase) { if (((qx + qy) & 1) === 1) { c = C.secondary; if (c[3] === 0 && T.tool !== "eraser") continue; } }
      putPx(img, qx, qy, erase ? [0, 0, 0, 0] : c);
    }
  }
  function bresenham(x0, y0, x1, y1, fn) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // Pixel-perfect: drop the middle pixel of every L-shaped corner in a 1px path.
  function perfectPath(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1, l2 = Math.abs(b[0] - c[0]) + Math.abs(b[1] - c[1]) === 1;
      const diag = Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1;
      if (l1 && l2 && diag) continue;
      out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function ellipsePoints(x0, y0, x1, y1, filled, fn) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const w = bx - ax + 1, h = by - ay + 1;
    if (w <= 2 || h <= 2) { for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) fn(x, y); return; }
    const rx = w / 2, ry = h / 2, cx = ax + rx, cy = ay + ry;
    const inside = (x, y) => { const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; return dx * dx + dy * dy <= 1; };
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      if (!inside(x, y)) continue;
      if (filled) { fn(x, y); continue; }
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) fn(x, y);
    }
  }

  // ---- fills, gradient, shading ----
  function floodFill(img, sx, sy, paint, global) {
    if (!inBounds(sx, sy)) return;
    const b = bounds(), target = getPx(img, sx, sy), tol = Math.round(T.tolerance * 2.55);
    const match = (x, y) => colorDist(getPx(img, x, y), target) <= tol;
    if (global) {
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (inBounds(x, y) && match(x, y)) putPx(img, x, y, paint);
      return;
    }
    const seen = new Uint8Array(D.w * D.h), stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!inBounds(x, y)) continue;
      const k = y * D.w + x;
      if (seen[k]) continue;
      seen[k] = 1;
      if (!match(x, y)) continue;
      putPx(img, x, y, paint);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }
  // Wand: same walk but producing a mask from the composite.
  function wandMask(sx, sy, global) {
    const img = compCtx.getImageData(0, 0, D.w, D.h), target = getPx(img, sx, sy), tol = Math.round(T.tolerance * 2.55);
    const m = new Uint8Array(D.w * D.h), match = (x, y) => colorDist(getPx(img, x, y), target) <= tol;
    if (global) { for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) if (match(x, y)) m[y * D.w + x] = 1; return m; }
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!inImage(x, y)) continue;
      const k = y * D.w + x;
      if (m[k]) continue;
      if (!match(x, y)) continue;
      m[k] = 1;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return m;
  }
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  function gradientFill(img, x0, y0, x1, y1) {
    const region = SEL.bbox && SEL.mask ? SEL.bbox : bounds();
    const a = C.primary, b = C.secondary;
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
      if (!inBounds(x, y)) continue;
      let t;
      if (T.gradMode === "radial") t = Math.sqrt(((x - x0) ** 2 + (y - y0) ** 2) / len2);
      else t = ((x - x0) * dx + (y - y0) * dy) / len2;
      t = clamp(t, 0, 1);
      if (T.gradDither) { const th = (BAYER[y & 3][x & 3] + 0.5) / 16; putPx(img, x, y, t < th ? a : b); }
      else putPx(img, x, y, [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), Math.round(a[3] + (b[3] - a[3]) * t)]);
    }
  }
  // Shade: lighten (left) or darken (right) each pixel once per stroke.
  function shadeAt(img, x, y, darken) {
    for (const [dx, dy] of brushOffsets) {
      const px = x + dx, py = y + dy;
      if (!inBounds(px, py)) continue;
      const k = py * D.w + px;
      if (P.visited[k]) continue;
      P.visited[k] = 1;
      const c = getPx(img, px, py);
      if (c[3] === 0) continue;
      const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
      const nl = clamp(l + (darken ? -1 : 1) * T.shadeAmt / 100, 0, 1);
      const rgb = hslToRgb(h, s, nl);
      putPx(img, px, py, [rgb[0], rgb[1], rgb[2], c[3]]);
    }
  }

  // ---- stroke engine ----
  // A stroke edits an ImageData copy of the active layer, restored from the
  // stroke-start snapshot on every move for shape/perfect previews, then put
  // back on the canvas so render() shows it live.
  function beginStroke(e, p) {
    const layer = L();
    if (!layer || layer.locked) { setStatus("that layer is locked", true); return false; }
    if (!layer.visible) { setStatus("that layer is hidden", true); return false; }
    P.drawing = true; P.start = p; P.last = p; P.pts = [[p.x, p.y]]; P.button = e.button;
    P.snap = layer.cx.getImageData(0, 0, D.w, D.h);
    P.snapImg = layer.cx.getImageData(0, 0, D.w, D.h);
    P.visited = new Uint8Array(D.w * D.h);
    return true;
  }
  function paintColor() { return P.button === 2 ? C.secondary : C.primary; }
  function applyStroke(p) {
    const layer = L(), img = P.snapImg, tool = T.tool;
    // Fresh copy of the snapshot each move (shapes/perfect need a clean base).
    img.data.set(P.snap.data);
    const col = paintColor(), erase = tool === "eraser";
    if (tool === "pencil" || tool === "eraser") {
      let pts = P.pts;
      if (T.perfect && T.size === 1 && !erase) pts = perfectPath(pts);
      for (const [x, y] of pts) dab(img, x, y, col, erase);
    } else if (tool === "line") {
      bresenham(P.start.x, P.start.y, p.x, p.y, (x, y) => dab(img, x, y, col, false));
    } else if (tool === "rect") {
      const ax = Math.min(P.start.x, p.x), bx = Math.max(P.start.x, p.x), ay = Math.min(P.start.y, p.y), by = Math.max(P.start.y, p.y);
      if (T.fillMode === "filled") { for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) dab(img, x, y, col, false); }
      else { bresenham(ax, ay, bx, ay, (x, y) => dab(img, x, y, col)); bresenham(ax, by, bx, by, (x, y) => dab(img, x, y, col)); bresenham(ax, ay, ax, by, (x, y) => dab(img, x, y, col)); bresenham(bx, ay, bx, by, (x, y) => dab(img, x, y, col)); }
    } else if (tool === "ellipse") {
      ellipsePoints(P.start.x, P.start.y, p.x, p.y, T.fillMode === "filled", (x, y) => dab(img, x, y, col, false));
    } else if (tool === "gradient") {
      gradientFill(img, P.start.x, P.start.y, p.x, p.y);
    } else if (tool === "shade") {
      // Shade accumulates: work on the live image, not the snapshot.
      img.data.set(layer.cx.getImageData(0, 0, D.w, D.h).data);
      shadeAt(img, p.x, p.y, P.button === 2);
    }
    layer.cx.putImageData(img, 0, 0);
    touch();
  }
  function endStroke() {
    if (!P.drawing) return;
    P.drawing = false;
    const layer = L();
    const before = P.snap; P.snap = null; P.snapImg = null; P.visited = null;
    if (commitPatch(layer, before, T.tool)) { if (DIFF.show) computeDiff(); refreshFrameThumbs(); }
    render();
  }

  // ---- floating pixels (Move tool, paste) ----
  function liftSelection(cut) {
    const layer = L(); if (!layer || FLOAT.cv) return false;
    const b = SEL.bbox || { x: 0, y: 0, w: D.w, h: D.h };
    const cv = document.createElement("canvas"); cv.width = b.w; cv.height = b.h;
    const c2 = cv.getContext("2d");
    const img = layer.cx.getImageData(b.x, b.y, b.w, b.h);
    if (SEL.mask) { const d = img.data; for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (!SEL.mask[(b.y + y) * D.w + b.x + x]) d[(y * b.w + x) * 4 + 3] = 0; }
    c2.putImageData(img, 0, 0);
    FLOAT.cv = cv; FLOAT.x = b.x; FLOAT.y = b.y; FLOAT.mask = SEL.mask ? new Uint8Array(SEL.mask) : null; FLOAT.layerId = layer.id;
    if (cut) {
      const before = layer.cx.getImageData(0, 0, D.w, D.h);
      const li = layer.cx.getImageData(b.x, b.y, b.w, b.h), d = li.data;
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (!SEL.mask || SEL.mask[(b.y + y) * D.w + b.x + x]) d[(y * b.w + x) * 4 + 3] = 0;
      layer.cx.putImageData(li, b.x, b.y);
      commitPatch(layer, before, "lift");
    }
    return true;
  }
  function commitFloat() {
    if (!FLOAT.cv) return;
    const layer = D.layers.find((l) => l.id === FLOAT.layerId) || L();
    const before = layer.cx.getImageData(0, 0, D.w, D.h);
    layer.cx.drawImage(FLOAT.cv, FLOAT.x, FLOAT.y);
    commitPatch(layer, before, "move");
    // The selection follows the pixels.
    if (FLOAT.mask) {
      const m = new Uint8Array(D.w * D.h), dx = FLOAT.x - FLOAT.ox, dy = FLOAT.y - FLOAT.oy;
      for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) if (FLOAT.mask[y * D.w + x]) { const nx = x + dx, ny = y + dy; if (inImage(nx, ny)) m[ny * D.w + nx] = 1; }
      setMask(m);
    }
    FLOAT.cv = null; FLOAT.mask = null;
    refreshFrameThumbs(); render();
  }
  function cancelFloat() {
    if (!FLOAT.cv) return;
    FLOAT.x = FLOAT.ox; FLOAT.y = FLOAT.oy; commitFloat();
  }
  function startFloat(cut) { if (!liftSelection(cut)) return false; FLOAT.ox = FLOAT.x; FLOAT.oy = FLOAT.y; return true; }
  function nudge(dx, dy) {
    if (FLOAT.cv) { FLOAT.x += dx; FLOAT.y += dy; render(); return; }
    if (SEL.mask) { const before = snapshotMask(); const m = new Uint8Array(D.w * D.h); for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) if (SEL.mask[y * D.w + x] && inImage(x + dx, y + dy)) m[(y + dy) * D.w + x + dx] = 1; setMask(m); pushSelectionHistory(before); render(); }
  }

  // ---- clipboard ----
  function copySel(cut) {
    const layer = L(); if (!layer) return;
    const b = SEL.bbox || { x: 0, y: 0, w: D.w, h: D.h };
    const cv = document.createElement("canvas"); cv.width = b.w; cv.height = b.h;
    const img = layer.cx.getImageData(b.x, b.y, b.w, b.h);
    if (SEL.mask) { const d = img.data; for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (!SEL.mask[(b.y + y) * D.w + b.x + x]) d[(y * b.w + x) * 4 + 3] = 0; }
    cv.getContext("2d").putImageData(img, 0, 0);
    CLIP.cv = cv; CLIP.x = b.x; CLIP.y = b.y;
    try { cv.toBlob((blob) => { try { navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); } catch {} }); } catch {}
    if (cut) clearSelection();
    setStatus((cut ? "cut " : "copied ") + b.w + "x" + b.h);
  }
  function pasteClip(cv, x, y) {
    if (!cv) return;
    if (FLOAT.cv) commitFloat();
    const layer = L(); if (!layer || layer.locked) { setStatus("layer is locked", true); return; }
    if (x == null) { x = CLIP.cv === cv ? CLIP.x : 0; y = CLIP.cv === cv ? CLIP.y : 0; }
    const c = document.createElement("canvas"); c.width = cv.width; c.height = cv.height; c.getContext("2d").drawImage(cv, 0, 0);
    FLOAT.cv = c; FLOAT.x = x; FLOAT.y = y; FLOAT.ox = x; FLOAT.oy = y; FLOAT.layerId = layer.id;
    const m = new Uint8Array(D.w * D.h);
    for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) if (inImage(x + xx, y + yy)) m[(y + yy) * D.w + x + xx] = 1;
    FLOAT.mask = m; setMask(m);
    setTool("move");
    setStatus("pasted - drag to place, Enter to commit, Esc to cancel");
    render();
  }
  function clearSelection() {
    const layer = L(); if (!layer || layer.locked) return;
    const b = SEL.bbox || bounds();
    const before = layer.cx.getImageData(0, 0, D.w, D.h);
    const img = layer.cx.getImageData(b.x, b.y, b.w, b.h), d = img.data;
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (inBounds(b.x + x, b.y + y)) d[(y * b.w + x) * 4 + 3] = 0;
    layer.cx.putImageData(img, b.x, b.y);
    commitPatch(layer, before, "clear"); refreshFrameThumbs(); render();
  }
  function fillSelection(color) {
    const layer = L(); if (!layer || layer.locked) return;
    const before = layer.cx.getImageData(0, 0, D.w, D.h), img = layer.cx.getImageData(0, 0, D.w, D.h), b = SEL.bbox || bounds();
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) putPx(img, x, y, color);
    layer.cx.putImageData(img, 0, 0);
    commitPatch(layer, before, "fill"); refreshFrameThumbs(); render();
  }
  window.addEventListener("paste", (e) => {
    if ($("pixel-pane").hidden || !D.loaded) return;
    const t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find((it) => it.type.startsWith("image/"));
    if (!item) { if (CLIP.cv) pasteClip(CLIP.cv); return; }
    e.preventDefault();
    const img = new Image();
    img.onload = () => { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0); pasteClip(c, 0, 0); };
    img.src = URL.createObjectURL(item.getAsFile());
  });

  // ---- pointer handling ----
  view.addEventListener("contextmenu", (e) => e.preventDefault());
  const SELECT_TOOLS = new Set(["selrect", "selellipse", "lasso", "wand"]);
  const DRAW_TOOLS = new Set(["pencil", "eraser", "line", "rect", "ellipse", "gradient", "shade"]);
  view.addEventListener("pointerdown", (e) => {
    if (!D.loaded) return;
    try { view.setPointerCapture(e.pointerId); } catch {}
    const p = toImage(e);
    if (e.button === 1 || P.space || T.tool === "hand") { P.panning = true; P.panStart = { x: e.clientX - V.panX, y: e.clientY - V.panY }; return; }
    if (T.tool === "zoom") { zoomAt(e.clientX, e.clientY, e.button === 2 || e.altKey ? -1 : 1); render(); return; }
    if (e.altKey || T.tool === "picker") { pickAt(p.x, p.y, e.button === 2 ? "secondary" : "primary"); return; }
    if (T.tool === "cell" || (e.shiftKey && !SELECT_TOOLS.has(T.tool) && T.tool !== "move" && !DRAW_TOOLS.has(T.tool))) { selectCellAt(p.x, p.y); if (T.tool === "cell") setTool(T.prev || "pencil"); return; }
    if (T.tool === "fill") {
      if (!beginStroke(e, p)) return;
      floodFill(P.snapImg, p.x, p.y, paintColor(), !T.contiguous || e.shiftKey);
      L().cx.putImageData(P.snapImg, 0, 0); touch(); endStroke(); return;
    }
    if (DRAW_TOOLS.has(T.tool)) {
      if (FLOAT.cv) commitFloat();
      if (!beginStroke(e, p)) return;
      applyStroke(p); render(); return;
    }
    if (T.tool === "move") {
      const inside = !SEL.mask || (inImage(p.x, p.y) && SEL.mask[p.y * D.w + p.x]);
      if (FLOAT.cv && !(p.x >= FLOAT.x && p.y >= FLOAT.y && p.x < FLOAT.x + FLOAT.cv.width && p.y < FLOAT.y + FLOAT.cv.height)) commitFloat();
      if (!FLOAT.cv) { if (!inside) { setMask(null); } if (!startFloat(true)) return; }
      P.moveStart = { x: p.x - FLOAT.x, y: p.y - FLOAT.y }; P.drawing = true; return;
    }
    if (SELECT_TOOLS.has(T.tool)) {
      if (FLOAT.cv) commitFloat();
      P.selBefore = snapshotMask();
      if (e.shiftKey) T.selMode = "add"; else if (e.ctrlKey) T.selMode = "subtract";
      if (T.tool === "wand") {
        if (!inImage(p.x, p.y)) return;
        setMask(combineMask(wandMask(p.x, p.y, !T.contiguous)));
        pushSelectionHistory(P.selBefore); syncOptions(); render(); return;
      }
      P.drawing = true; P.start = p; P.last = p; P.lasso = [[p.x, p.y]]; render(); return;
    }
  });
  view.addEventListener("pointermove", (e) => {
    const p = toImage(e);
    P.hover = p; updateStatusBar();
    if (P.panning) { V.panX = e.clientX - P.panStart.x; V.panY = e.clientY - P.panStart.y; render(); return; }
    if (!D.loaded) return;
    if (!P.drawing) { if (DRAW_TOOLS.has(T.tool) || T.tool === "fill") render(); return; }
    if (T.tool === "move" && FLOAT.cv) { FLOAT.x = p.x - P.moveStart.x; FLOAT.y = p.y - P.moveStart.y; render(); return; }
    if (SELECT_TOOLS.has(T.tool)) { P.last = p; if (T.tool === "lasso") { const l = P.lasso[P.lasso.length - 1]; if (l[0] !== p.x || l[1] !== p.y) P.lasso.push([p.x, p.y]); } render(); return; }
    if (T.tool === "pencil" || T.tool === "eraser" || T.tool === "shade") {
      const last = P.pts[P.pts.length - 1];
      bresenham(last[0], last[1], p.x, p.y, (x, y) => { if (x !== last[0] || y !== last[1]) P.pts.push([x, y]); });
      if (T.tool === "shade") { for (const pt of P.pts.slice(-Math.max(1, P.pts.length - 1))) applyStroke({ x: pt[0], y: pt[1] }); }
      else applyStroke(p);
    } else applyStroke(p);
    P.last = p; render();
  });
  function pointerUp(e) {
    if (P.panning) { P.panning = false; return; }
    if (!P.drawing) return;
    if (T.tool === "move") { P.drawing = false; render(); return; }
    if (SELECT_TOOLS.has(T.tool)) {
      P.drawing = false;
      let m;
      if (T.tool === "lasso") m = lassoMask(P.lasso);
      else m = maskFromRect(P.start.x, P.start.y, P.last.x, P.last.y, T.tool === "selellipse");
      const tiny = P.start.x === P.last.x && P.start.y === P.last.y && T.tool !== "lasso";
      setMask(tiny && T.selMode === "replace" ? null : combineMask(m));
      pushSelectionHistory(P.selBefore);
      if (e && !e.shiftKey && !e.ctrlKey) { /* keep user's chosen mode */ } else T.selMode = "replace";
      syncOptions(); render(); return;
    }
    endStroke();
  }
  view.addEventListener("pointerup", pointerUp);
  view.addEventListener("pointercancel", pointerUp);
  view.addEventListener("pointerleave", () => { P.hover = null; updateStatusBar(); if (!P.drawing) render(); });
  view.addEventListener("wheel", (e) => {
    if (!D.loaded) return;
    e.preventDefault();
    if (e.ctrlKey || !e.shiftKey) zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
    else { V.panX -= e.deltaY; }
    render();
  }, { passive: false });
  function lassoMask(pts) {
    const m = new Uint8Array(D.w * D.h);
    if (pts.length < 3) return m;
    // Scanline polygon fill over pixel centres.
    for (let y = 0; y < D.h; y++) {
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        const cy = y + 0.5;
        if ((yi + 0.5 > cy) !== (yj + 0.5 > cy)) xs.push(xi + 0.5 + ((cy - yi - 0.5) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x + 0.5 < xs[k + 1]; x++) if (x >= 0 && x < D.w) m[y * D.w + x] = 1;
    }
    return m;
  }
  function pickAt(x, y, which) {
    if (!inImage(x, y)) return;
    const src = T.sample === "layer" && L() ? L().cx : compCtx;
    if (src === compCtx) compose();
    const d = src.getImageData(x, y, 1, 1).data;
    if (d[3] === 0) { setStatus("that pixel is transparent"); return; }
    setColor(which || "primary", [d[0], d[1], d[2], d[3]]);
    setStatus("picked " + toHex([d[0], d[1], d[2]]));
  }
  function selectCellAt(x, y) {
    if (CELL.w <= 0 || CELL.h <= 0) { setStatus("set a cell size in the Frames panel first", true); showDock("frames"); return; }
    if (!inImage(x, y)) return;
    focusCell(Math.floor(x / CELL.w), Math.floor(y / CELL.h));
  }
  function focusCell(cx, cy) {
    if (FLOAT.cv) commitFloat();
    CELL.focus = { cx, cy };
    fit(bounds());
    setStatus("editing cell " + cx + "," + cy + " only");
    refreshFrames(); render();
  }
  function wholeSheet() { CELL.focus = null; fit(); setStatus(""); refreshFrames(); render(); }

  // ---- rendering ----
  const checker = (() => { const c = document.createElement("canvas"); c.width = c.height = 16; const x = c.getContext("2d"); x.fillStyle = "#20232b"; x.fillRect(0, 0, 16, 16); x.fillStyle = "#2a2e38"; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8); return c; })();
  let antsTimer = null;
  function render() {
    resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#101216";
    ctx.fillRect(0, 0, view.width, view.height);
    if (!D.loaded) return;
    const z = V.zoom, w = D.w * z, h = D.h * z, img = compose();
    ctx.save();
    ctx.translate(V.panX, V.panY);
    if (V.checker) { ctx.fillStyle = ctx.createPattern(checker, "repeat"); ctx.fillRect(0, 0, w, h); }
    if (V.tiled) {
      ctx.globalAlpha = 0.45;
      for (let ty = -1; ty <= 1; ty++) for (let tx = -1; tx <= 1; tx++) if (tx || ty) ctx.drawImage(img, tx * w, ty * h, w, h);
      ctx.globalAlpha = 1;
    }
    // Onion skin: neighbouring cells ghosted into the focused cell.
    if (V.onion && CELL.focus && CELL.w > 0) {
      const b = bounds(), cols = Math.floor(D.w / CELL.w), idx = CELL.focus.cy * cols + CELL.focus.cx, n = frameCount();
      for (let k = 1; k <= CELL.onionPrev; k++) drawGhost(idx - k, b, "rgba(255,80,80,1)", 0.28 / k, cols, n);
      for (let k = 1; k <= CELL.onionNext; k++) drawGhost(idx + k, b, "rgba(80,200,120,1)", 0.28 / k, cols, n);
    }
    ctx.drawImage(img, 0, 0, w, h);
    if (FLOAT.cv) { ctx.drawImage(FLOAT.cv, FLOAT.x * z, FLOAT.y * z, FLOAT.cv.width * z, FLOAT.cv.height * z); ctx.strokeStyle = "rgba(122,162,247,.9)"; ctx.setLineDash([4, 3]); ctx.strokeRect(FLOAT.x * z + 0.5, FLOAT.y * z + 0.5, FLOAT.cv.width * z, FLOAT.cv.height * z); ctx.setLineDash([]); }
    // Selection in progress (rect/ellipse/lasso preview).
    if (P.drawing && SELECT_TOOLS.has(T.tool) && P.start && P.last) {
      ctx.strokeStyle = "#fff"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      if (T.tool === "lasso") { ctx.beginPath(); P.lasso.forEach((pt, i) => { const X = (pt[0] + 0.5) * z, Y = (pt[1] + 0.5) * z; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }); ctx.closePath(); ctx.stroke(); }
      else {
        const ax = Math.min(P.start.x, P.last.x) * z, ay = Math.min(P.start.y, P.last.y) * z, bw = (Math.abs(P.last.x - P.start.x) + 1) * z, bh = (Math.abs(P.last.y - P.start.y) + 1) * z;
        if (T.tool === "selellipse") { ctx.beginPath(); ctx.ellipse(ax + bw / 2, ay + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2); ctx.stroke(); } else ctx.strokeRect(ax + 0.5, ay + 0.5, bw, bh);
      }
      ctx.setLineDash([]);
    }
    if (V.grid && z >= 6) {
      ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = 0; x <= D.w; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, h); }
      for (let y = 0; y <= D.h; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(w, y * z + 0.5); }
      ctx.stroke();
    }
    if (V.cells && CELL.w > 0 && CELL.h > 0 && z * CELL.w > 3) {
      ctx.strokeStyle = "rgba(122,162,247,0.45)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = 0; x <= D.w; x += CELL.w) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, h); }
      for (let y = 0; y <= D.h; y += CELL.h) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(w, y * z + 0.5); }
      ctx.stroke();
    }
    if (DIFF.show && DIFF.pts && DIFF.pts.length) {
      ctx.fillStyle = "rgba(255,42,168,0.45)";
      for (const pt of DIFF.pts) ctx.fillRect(pt[0] * z, pt[1] * z, z, z);
      if (CELL.w > 0) { ctx.strokeStyle = "#ff2aa8"; ctx.lineWidth = 2; for (const f of DIFF.frames) { const q = f.key.split(",").map(Number); ctx.strokeRect(q[0] * CELL.w * z, q[1] * CELL.h * z, CELL.w * z, CELL.h * z); } }
    }
    if (V.symLines && (T.symX || T.symY)) {
      const b = bounds(); ctx.strokeStyle = "rgba(224,175,104,.8)"; ctx.setLineDash([6, 4]); ctx.lineWidth = 1; ctx.beginPath();
      if (T.symX) { const X = (b.x + b.w / 2) * z; ctx.moveTo(X, b.y * z); ctx.lineTo(X, (b.y + b.h) * z); }
      if (T.symY) { const Y = (b.y + b.h / 2) * z; ctx.moveTo(b.x * z, Y); ctx.lineTo((b.x + b.w) * z, Y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (SEL.edges && SEL.edges.length) {
      ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -SEL.ants;
      ctx.strokeStyle = "#000"; ctx.beginPath(); for (const e of SEL.edges) { ctx.moveTo(e[0] * z + 0.5, e[1] * z + 0.5); ctx.lineTo(e[2] * z + 0.5, e[3] * z + 0.5); } ctx.stroke();
      ctx.lineDashOffset = -SEL.ants + 4; ctx.strokeStyle = "#fff"; ctx.stroke(); ctx.setLineDash([]);
      if (!antsTimer) antsTimer = setInterval(() => { SEL.ants = (SEL.ants + 1) % 8; if (!SEL.edges) { clearInterval(antsTimer); antsTimer = null; } if (!$("pixel-pane").hidden) render(); }, 120);
    }
    if (CELL.focus && CELL.w > 0) {
      const b = bounds(); ctx.fillStyle = "rgba(16,18,22,0.66)";
      ctx.fillRect(0, 0, w, b.y * z); ctx.fillRect(0, (b.y + b.h) * z, w, h - (b.y + b.h) * z);
      ctx.fillRect(0, b.y * z, b.x * z, b.h * z); ctx.fillRect((b.x + b.w) * z, b.y * z, w - (b.x + b.w) * z, b.h * z);
      ctx.strokeStyle = "#7aa2f7"; ctx.lineWidth = 2; ctx.strokeRect(b.x * z, b.y * z, b.w * z, b.h * z);
    }
    // Brush cursor.
    if (P.hover && !P.drawing && (DRAW_TOOLS.has(T.tool) || T.tool === "fill") && inImage(P.hover.x, P.hover.y) && z >= 3) {
      ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1;
      const o = Math.floor((T.size - 1) / 2);
      for (const [dx, dy] of (T.tool === "fill" ? [[0, 0]] : brushOffsets)) ctx.strokeRect((P.hover.x + dx) * z + 0.5, (P.hover.y + dy) * z + 0.5, z, z);
      void o;
    }
    ctx.strokeStyle = "#3a4050"; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w, h);
    ctx.restore();
    $("pixel-zoomlbl").textContent = D.w + "x" + D.h + "  " + z + "x";
  }
  function drawGhost(idx, b, tint, alpha, cols, n) {
    if (idx < 0 || idx >= n) return;
    const sx = (idx % cols) * CELL.w, sy = Math.floor(idx / cols) * CELL.h, z = V.zoom;
    ctx.globalAlpha = alpha;
    ctx.drawImage(comp, sx, sy, CELL.w, CELL.h, b.x * z, b.y * z, b.w * z, b.h * z);
    ctx.globalAlpha = 1;
    void tint;
  }
  function frameCount() { if (CELL.w <= 0 || CELL.h <= 0) return 0; return Math.floor(D.w / CELL.w) * Math.floor(D.h / CELL.h); }

  // ---- open / save / sidecar ----
  const sidecarPath = (p) => p + ".layers.json";
  async function loadImage(url) { const img = new Image(); img.src = url; await img.decode(); return img; }
  function resetDoc(w, h) {
    D.w = w; D.h = h; D.layers = []; D.active = 0; D.dirty = false; D.hadSidecar = false;
    H.undo.length = 0; H.redo.length = 0; H.bytes = 0;
    SEL.mask = null; SEL.bbox = null; SEL.edges = null; FLOAT.cv = null; CELL.focus = null; DIFF.show = false; DIFF.pts = null;
    touch();
  }
  async function open(diskPath, label) {
    if (D.dirty && !(await UI.confirm("This image has unsaved pixel edits. Open another one anyway?", { okLabel: "Discard and open", danger: true }))) return;
    setStatus("loading");
    let img;
    try { img = await loadImage("/raw?path=" + encodeURIComponent(diskPath) + "&ts=" + Date.now()); }
    catch { setStatus("could not load that image", true); return; }
    resetDoc(img.naturalWidth, img.naturalHeight);
    D.path = diskPath; D.label = label || diskPath; D.loaded = true;
    // Layers sidecar: only trusted when its flattened result still matches the PNG.
    let restored = false;
    try {
      const r = await fetch("/api/file?path=" + encodeURIComponent(sidecarPath(diskPath)));
      const j = await r.json();
      if (r.ok && j.content) {
        const sc = JSON.parse(j.content);
        if (sc.w === D.w && sc.h === D.h && Array.isArray(sc.layers) && sc.layers.length) {
          const layers = [];
          for (const s of sc.layers) { const l = newLayer(s.name); l.visible = s.visible !== false; l.locked = !!s.locked; l.opacity = s.opacity == null ? 1 : s.opacity; l.cx.drawImage(await loadImage(s.png), 0, 0); layers.push(l); }
          D.layers = layers; D.active = clamp(sc.active || 0, 0, layers.length - 1); touch();
          const flat = compose().getContext("2d").getImageData(0, 0, D.w, D.h).data;
          const tmp = document.createElement("canvas"); tmp.width = D.w; tmp.height = D.h; const tc = tmp.getContext("2d"); tc.drawImage(img, 0, 0);
          const disk = tc.getImageData(0, 0, D.w, D.h).data;
          let same = true; for (let i = 0; i < flat.length; i++) if (Math.abs(flat[i] - disk[i]) > 2) { same = false; break; }
          if (same) { restored = true; D.hadSidecar = true; }
          else UI.toast("The PNG changed outside the editor; its saved layers no longer match and were dropped.", "warn", 6000);
        }
      }
    } catch {}
    if (!restored) { const l = newLayer("Background"); l.cx.drawImage(img, 0, 0); D.layers = [l]; D.active = 0; }
    layerSeq = D.layers.length + 1;
    touch();
    hint.hidden = true;
    $("pixel-file").textContent = D.label;
    if (!CELL.w) guessCell();
    CELL.from = 0; CELL.to = Math.max(0, frameCount() - 1);
    resize(); fit(); render();
    requestAnimationFrame(() => { resize(); fit(); render(); });
    buildImagePalette(); refreshLayers(); refreshFrames();
    setStatus("");
  }
  // Common sheet sizes: pick the largest cell size that tiles the image into a small grid.
  function guessCell() {
    for (const s of [64, 48, 32, 24, 16]) { if (D.w % s === 0 && D.h % s === 0 && (D.w / s) * (D.h / s) >= 2 && (D.w / s) * (D.h / s) <= 400 && !(D.w === s && D.h === s)) { setCell(s, s); return; } }
  }
  async function pngBlob() { const c = compose(); return await new Promise((r) => c.toBlob(r, "image/png")); }
  async function save() {
    if (!D.loaded || !D.path) return;
    if (FLOAT.cv) commitFloat();
    // A no-op save still rewrites the file's bytes with the browser's PNG encoder
    // and triggers a .bak - it churned a real RTS-Game asset once. Never write
    // unless a pixel actually changed.
    if (!D.dirty) { setStatus("no changes to save"); return; }
    setStatus("saving");
    const blob = await pngBlob();
    try {
      const res = await fetch("/api/image?path=" + encodeURIComponent(D.path), { method: "POST", body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save failed");
      await saveSidecar();
      D.dirty = false;
      setStatus("Saved " + (Math.round((data.bytes || blob.size) / 102.4) / 10) + " KB" + (data.madeBak ? " (.bak kept)" : ""));
      window.dispatchEvent(new CustomEvent("pixel-saved", { detail: { path: D.path } }));
    } catch (err) { setStatus(err.message, true); }
  }
  // Layers live beside the PNG in <name>.png.layers.json, written only when there
  // is something to keep (more than one layer, or a hidden/translucent one).
  async function saveSidecar() {
    const needed = D.layers.length > 1 || D.layers.some((l) => !l.visible || l.opacity < 1);
    const sp = sidecarPath(D.path);
    if (!needed) {
      if (D.hadSidecar) { await fetch("/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "delete", path: sp, hard: true }) }); D.hadSidecar = false; }
      return;
    }
    const sc = { version: 1, w: D.w, h: D.h, active: D.active, layers: D.layers.map((l) => ({ name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, png: l.cv.toDataURL("image/png") })) };
    await fetch("/api/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: sp, content: JSON.stringify(sc) }) });
    D.hadSidecar = true;
  }
  async function saveAs() {
    if (!D.loaded) return;
    const v = await UI.modal({ title: "Save as", text: "A new PNG next to the current one", fields: [{ id: "name", label: "File name", value: (D.label.split(/[/\x5c]/).pop() || "sprite.png").replace(/[.]png$/i, "") + "-copy.png" }], okLabel: "Save" });
    if (!v || !v.name.trim()) return;
    const name = /[.]png$/i.test(v.name) ? v.name.trim() : v.name.trim() + ".png";
    const dest = D.path.slice(0, Math.max(D.path.lastIndexOf("/"), D.path.lastIndexOf(SEP)) + 1) + name;
    const res = await fetch("/api/image?path=" + encodeURIComponent(dest) + "&new=1", { method: "POST", body: await pngBlob() });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || "save failed", true); return; }
    D.path = dest; D.label = name; D.hadSidecar = false; D.dirty = true;
    await saveSidecar(); D.dirty = false;
    $("pixel-file").textContent = D.label;
    setStatus("Saved as " + name);
    window.dispatchEvent(new CustomEvent("pixel-saved", { detail: { path: dest } }));
  }

  // ---- new / export / import / revert ----
  async function newImage() {
    if (D.dirty && !(await UI.confirm("Discard unsaved pixel edits?", { okLabel: "Discard", danger: true }))) return;
    const proj = window.NexusApp && window.NexusApp.projectPath();
    if (!proj) { UI.toast("Pick a project first", "warn"); return; }
    const v = await UI.modal({ title: "New image", fields: [{ id: "name", label: "File name", value: "sprite.png" }, { id: "w", label: "Width", type: "number", value: 32, min: 1, max: 4096 }, { id: "h", label: "Height", type: "number", value: 32, min: 1, max: 4096 }, { id: "dir", label: "Folder", value: "assets" }], okLabel: "Create" });
    if (!v || !v.name.trim()) return;
    const name = /[.]png$/i.test(v.name) ? v.name.trim() : v.name.trim() + ".png";
    const dest = proj + (v.dir.trim() ? SEP + v.dir.trim().replaceAll("/", SEP) : "") + SEP + name;
    const c = document.createElement("canvas"); c.width = clamp(v.w | 0, 1, 4096); c.height = clamp(v.h | 0, 1, 4096);
    const res = await fetch("/api/image?path=" + encodeURIComponent(dest) + "&new=1", { method: "POST", body: await new Promise((r) => c.toBlob(r, "image/png")) });
    const data = await res.json();
    if (!res.ok) { UI.toast(data.error || "could not create", "err"); return; }
    if (window.NexusApp) window.NexusApp.refreshTree();
    await open(dest, (v.dir.trim() ? v.dir.trim() + "/" : "") + name);
  }
  function download(cv, name) { const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = name; a.click(); }
  function exportRegion() {
    if (!D.loaded) return;
    const b = SEL.bbox || bounds();
    const c = document.createElement("canvas"); c.width = b.w; c.height = b.h;
    c.getContext("2d").drawImage(compose(), b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    download(c, (D.label.split(/[/\x5c]/).pop() || "sprite").replace(/[.]png$/i, "") + (SEL.bbox ? "-selection" : CELL.focus ? "-cell" + CELL.focus.cx + "-" + CELL.focus.cy : "") + ".png");
  }
  async function exportScaled() {
    const v = await UI.modal({ title: "Export scaled PNG", fields: [{ id: "s", label: "Scale", type: "number", value: 4, min: 1, max: 32 }], okLabel: "Download" });
    if (!v) return;
    const s = clamp(v.s | 0, 1, 32), c = document.createElement("canvas"); c.width = D.w * s; c.height = D.h * s;
    const x = c.getContext("2d"); x.imageSmoothingEnabled = false; x.drawImage(compose(), 0, 0, c.width, c.height);
    download(c, (D.label.split(/[/\x5c]/).pop() || "sprite").replace(/[.]png$/i, "") + "@" + s + "x.png");
  }
  const importInput = document.createElement("input"); importInput.type = "file"; importInput.accept = "image/*"; importInput.hidden = true; document.body.appendChild(importInput);
  importInput.addEventListener("change", async () => {
    const f = importInput.files[0]; importInput.value = ""; if (!f || !D.loaded) return;
    const img = await loadImage(URL.createObjectURL(f));
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0);
    pasteClip(c, 0, 0);
  });
  async function revertToBak() {
    if (!D.loaded) return;
    if (!(await UI.confirm("Reload the original .bak? Unsaved edits are lost, and the next save overwrites the file with the .bak's pixels.", { okLabel: "Revert", danger: true }))) return;
    let img; try { img = await loadImage("/raw?path=" + encodeURIComponent(D.path + ".bak") + "&ts=" + Date.now()); } catch { setStatus("no .bak for this file", true); return; }
    const p = D.path, lbl = D.label; resetDoc(img.naturalWidth, img.naturalHeight);
    const l = newLayer("Background"); l.cx.drawImage(img, 0, 0); D.layers = [l]; D.path = p; D.label = lbl; D.loaded = true; D.dirty = true;
    refreshLayers(); refreshFrames(); fit(); render(); setStatus("reverted to .bak (unsaved)");
  }

  // ---- transforms: act on the selection of the active layer, or the whole image ----
  function eachLayerOrActive(all) { return all ? D.layers : [L()]; }
  function transformPixels(fn, label, allLayers) {
    const b = SEL.bbox || bounds();
    for (const layer of eachLayerOrActive(allLayers)) {
      if (!layer || layer.locked) continue;
      const before = layer.cx.getImageData(0, 0, D.w, D.h), src = layer.cx.getImageData(b.x, b.y, b.w, b.h), out = layer.cx.createImageData(b.w, b.h);
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        const [sx, sy] = fn(x, y, b.w, b.h), si = (sy * b.w + sx) * 4, di = (y * b.w + x) * 4;
        const keep = SEL.mask && !SEL.mask[(b.y + y) * D.w + b.x + x];
        const from = keep ? di : si, buf = keep ? src.data : src.data;
        out.data[di] = buf[from]; out.data[di + 1] = buf[from + 1]; out.data[di + 2] = buf[from + 2]; out.data[di + 3] = buf[from + 3];
      }
      layer.cx.putImageData(out, b.x, b.y);
      commitPatch(layer, before, label);
    }
    refreshFrameThumbs(); render();
  }
  const flipH = (all) => transformPixels((x, y, w) => [w - 1 - x, y], "flip", all);
  const flipV = (all) => transformPixels((x, y, w, h) => [x, h - 1 - y], "flip", all);
  const rotate180 = (all) => transformPixels((x, y, w, h) => [w - 1 - x, h - 1 - y], "rotate", all);
  function rotate90(cw) {
    // Whole-image rotate (all layers) when nothing is selected; square selections rotate in place.
    const b = SEL.bbox;
    if (b && b.w === b.h) { transformPixels((x, y, w) => (cw ? [y, w - 1 - x] : [w - 1 - y, x]), "rotate", false); return; }
    if (b) { UI.toast("Rotate 90 needs a square selection (or no selection to rotate the whole image)", "warn"); return; }
    resizeAll(D.h, D.w, (layer, nc) => { nc.save(); nc.translate(D.h / 2, D.w / 2); nc.rotate((cw ? 1 : -1) * Math.PI / 2); nc.drawImage(layer.cv, -D.w / 2, -D.h / 2); nc.restore(); }, "rotate");
  }
  // Rebuild every layer at a new size through a draw callback; undo restores the old canvases.
  function resizeAll(nw, nh, draw, label) {
    const old = D.layers.map((l) => { const c = document.createElement("canvas"); c.width = D.w; c.height = D.h; c.getContext("2d").drawImage(l.cv, 0, 0); return { id: l.id, cv: c }; });
    const ow = D.w, oh = D.h;
    const apply = () => {
      for (const l of D.layers) {
        const nc = document.createElement("canvas"); nc.width = nw; nc.height = nh; const x = nc.getContext("2d", { willReadFrequently: true }); x.imageSmoothingEnabled = false;
        draw(l, x); l.cv = nc; l.cx = x;
      }
      D.w = nw; D.h = nh; setMask(null); touch();
    };
    apply();
    const news = D.layers.map((l) => ({ id: l.id, cv: l.cv }));
    pushHistory({ label, bytes: ow * oh * 4 * D.layers.length * 2,
      undo: () => { for (const o of old) { const l = D.layers.find((q) => q.id === o.id); if (l) { l.cv = o.cv; l.cx = o.cv.getContext("2d", { willReadFrequently: true }); } } D.w = ow; D.h = oh; setMask(null); touch(); fit(); },
      redo: () => { for (const o of news) { const l = D.layers.find((q) => q.id === o.id); if (l) { l.cv = o.cv; l.cx = o.cv.getContext("2d", { willReadFrequently: true }); } } D.w = nw; D.h = nh; setMask(null); touch(); fit(); } });
    markDirty(); CELL.focus = null; fit(); refreshLayers(); refreshFrames(); render();
  }
  async function resizeCanvasDialog() {
    if (!D.loaded) return;
    const v = await UI.modal({ title: "Resize canvas", text: "Pixels keep their size; the canvas grows or crops.", fields: [
      { id: "w", label: "Width", type: "number", value: D.w, min: 1, max: 4096 }, { id: "h", label: "Height", type: "number", value: D.h, min: 1, max: 4096 },
      { id: "anchor", label: "Anchor", type: "select", value: "top-left", options: ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] }], okLabel: "Resize" });
    if (!v) return;
    const nw = clamp(v.w | 0, 1, 4096), nh = clamp(v.h | 0, 1, 4096);
    const ax = /right/.test(v.anchor) ? nw - D.w : /left/.test(v.anchor) ? 0 : Math.round((nw - D.w) / 2);
    const ay = /bottom/.test(v.anchor) ? nh - D.h : /top/.test(v.anchor) ? 0 : Math.round((nh - D.h) / 2);
    resizeAll(nw, nh, (l, nc) => nc.drawImage(l.cv, ax, ay), "resize canvas");
  }
  async function scaleDialog() {
    if (!D.loaded) return;
    const v = await UI.modal({ title: "Scale image", text: "Nearest-neighbour, so pixels stay crisp.", fields: [{ id: "s", label: "Factor", type: "number", value: 2, min: 0.05, max: 16, step: 0.5 }], okLabel: "Scale" });
    if (!v || !(v.s > 0)) return;
    const nw = Math.max(1, Math.round(D.w * v.s)), nh = Math.max(1, Math.round(D.h * v.s));
    resizeAll(nw, nh, (l, nc) => nc.drawImage(l.cv, 0, 0, nw, nh), "scale");
    if (CELL.w) setCell(Math.max(1, Math.round(CELL.w * v.s)), Math.max(1, Math.round(CELL.h * v.s)));
  }
  async function offsetDialog() {
    if (!D.loaded) return;
    const v = await UI.modal({ title: "Offset (wrap around)", fields: [{ id: "x", label: "X", type: "number", value: 0 }, { id: "y", label: "Y", type: "number", value: 0 }, { id: "all", label: "All layers", type: "checkbox", value: false }], okLabel: "Offset" });
    if (!v) return;
    transformPixels((x, y, w, h) => [(((x - v.x) % w) + w) % w, (((y - v.y) % h) + h) % h], "offset", v.all);
  }
  async function outlineDialog() {
    if (!D.loaded) return;
    const v = await UI.modal({ title: "Outline", text: "Adds a 1px outline around every opaque pixel of the layer.", fields: [{ id: "c", label: "Colour", type: "color", value: toHex(C.primary) }, { id: "mode", label: "Where", type: "select", value: "outside", options: ["outside", "inside"] }, { id: "diag", label: "Corners too", type: "checkbox", value: false }], okLabel: "Apply" });
    if (!v) return;
    const col = parseHex(v.c) || C.primary;
    const layer = L(); if (!layer || layer.locked) return;
    const before = layer.cx.getImageData(0, 0, D.w, D.h), src = layer.cx.getImageData(0, 0, D.w, D.h), img = layer.cx.getImageData(0, 0, D.w, D.h);
    const opaque = (x, y) => inImage(x, y) && src.data[(y * D.w + x) * 4 + 3] > 0;
    const n8 = [[1, 0], [-1, 0], [0, 1], [0, -1]].concat(v.diag ? [[1, 1], [1, -1], [-1, 1], [-1, -1]] : []);
    const b = bounds();
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      if (!inBounds(x, y)) continue;
      const isOp = opaque(x, y);
      if (v.mode === "outside" && !isOp && n8.some(([dx, dy]) => opaque(x + dx, y + dy))) putPx(img, x, y, col);
      if (v.mode === "inside" && isOp && n8.some(([dx, dy]) => !opaque(x + dx, y + dy))) putPx(img, x, y, col);
    }
    layer.cx.putImageData(img, 0, 0); commitPatch(layer, before, "outline"); refreshFrameThumbs(); render();
  }
  // Per-pixel colour adjustments over the selection / bounds of the active layer.
  function adjust(fn, label, all) {
    for (const layer of eachLayerOrActive(all)) {
      if (!layer || layer.locked) continue;
      const before = layer.cx.getImageData(0, 0, D.w, D.h), img = layer.cx.getImageData(0, 0, D.w, D.h), b = SEL.bbox || bounds();
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        if (!inBounds(x, y)) continue;
        const c = getPx(img, x, y); if (c[3] === 0) continue;
        const r = fn(c); if (r) putPx(img, x, y, r);
      }
      layer.cx.putImageData(img, 0, 0); commitPatch(layer, before, label);
    }
    refreshFrameThumbs(); render();
  }
  async function hslDialog() {
    const v = await UI.modal({ title: "Hue / saturation / lightness", fields: [{ id: "h", label: "Hue shift", type: "number", value: 0, min: -180, max: 180 }, { id: "s", label: "Saturation %", type: "number", value: 0, min: -100, max: 100 }, { id: "l", label: "Lightness %", type: "number", value: 0, min: -100, max: 100 }, { id: "all", label: "All layers", type: "checkbox", value: false }], okLabel: "Apply" });
    if (!v) return;
    adjust((c) => { const [h, s, l] = rgbToHsl(c[0], c[1], c[2]); const rgb = hslToRgb(h + v.h, clamp(s + v.s / 100, 0, 1), clamp(l + v.l / 100, 0, 1)); return [rgb[0], rgb[1], rgb[2], c[3]]; }, "hsl", v.all);
  }
  async function brightnessDialog() {
    const v = await UI.modal({ title: "Brightness / contrast", fields: [{ id: "b", label: "Brightness", type: "number", value: 0, min: -100, max: 100 }, { id: "c", label: "Contrast", type: "number", value: 0, min: -100, max: 100 }, { id: "all", label: "All layers", type: "checkbox", value: false }], okLabel: "Apply" });
    if (!v) return;
    const k = (259 * (v.c + 255)) / (255 * (259 - v.c));
    adjust((c) => [0, 1, 2].map((i) => clamp(Math.round(k * (c[i] - 128) + 128 + v.b * 2.55), 0, 255)).concat([c[3]]), "brightness", v.all);
  }
  async function replaceColorDialog() {
    const v = await UI.modal({ title: "Replace colour", fields: [{ id: "from", label: "From", type: "color", value: toHex(C.secondary[3] ? C.secondary : C.primary) }, { id: "to", label: "To", type: "color", value: toHex(C.primary) }, { id: "tol", label: "Tolerance %", type: "number", value: 0, min: 0, max: 100 }, { id: "all", label: "All layers", type: "checkbox", value: true }], okLabel: "Replace" });
    if (!v) return;
    const from = parseHex(v.from), to = parseHex(v.to), tol = Math.round(v.tol * 2.55);
    adjust((c) => (Math.max(Math.abs(c[0] - from[0]), Math.abs(c[1] - from[1]), Math.abs(c[2] - from[2])) <= tol ? [to[0], to[1], to[2], c[3]] : null), "replace colour", v.all);
  }
  const invertColors = (all) => adjust((c) => [255 - c[0], 255 - c[1], 255 - c[2], c[3]], "invert", all);
  const desaturate = (all) => adjust((c) => { const g = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]); return [g, g, g, c[3]]; }, "desaturate", all);
  const removeColor = () => adjust((c) => (Math.max(Math.abs(c[0] - C.primary[0]), Math.abs(c[1] - C.primary[1]), Math.abs(c[2] - C.primary[2])) <= Math.round(T.tolerance * 2.55) ? [0, 0, 0, 0] : null), "remove colour", false);

  // ---- selection commands ----
  function selectAll() { const before = snapshotMask(); const b = bounds(); setMask(maskFromRect(b.x, b.y, b.x + b.w - 1, b.y + b.h - 1)); pushSelectionHistory(before); render(); }
  function deselect() { if (FLOAT.cv) commitFloat(); if (!SEL.mask) return; const before = snapshotMask(); setMask(null); pushSelectionHistory(before); render(); }
  function invertSelection() { const before = snapshotMask(); const b = bounds(), m = new Uint8Array(D.w * D.h); for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) m[y * D.w + x] = SEL.mask && SEL.mask[y * D.w + x] ? 0 : 1; setMask(m); pushSelectionHistory(before); render(); }
  function growShrink(grow) {
    if (!SEL.mask) return;
    const before = snapshotMask(), m = new Uint8Array(D.w * D.h), s = SEL.mask;
    for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) {
      const nb = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => (inImage(x + dx, y + dy) ? s[(y + dy) * D.w + x + dx] : 0));
      m[y * D.w + x] = grow ? (nb.some((v) => v) ? 1 : 0) : (nb.every((v) => v) ? 1 : 0);
    }
    setMask(m); pushSelectionHistory(before); render();
  }
  function selectByColor() {
    compose();
    const before = snapshotMask(), img = compCtx.getImageData(0, 0, D.w, D.h), m = new Uint8Array(D.w * D.h), tol = Math.round(T.tolerance * 2.55);
    for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) { const c = getPx(img, x, y); if (c[3] > 0 && Math.max(Math.abs(c[0] - C.primary[0]), Math.abs(c[1] - C.primary[1]), Math.abs(c[2] - C.primary[2])) <= tol) m[y * D.w + x] = 1; }
    setMask(m); pushSelectionHistory(before); render();
  }
  function cropToSelection() {
    const b = SEL.bbox; if (!b) { UI.toast("Select something first", "warn"); return; }
    resizeAll(b.w, b.h, (l, nc) => nc.drawImage(l.cv, -b.x, -b.y), "crop");
  }

  // ---- tools: one registry drives the strip, the options bar and the keys ----
  const TOOLS = [
    { id: "pencil", icon: "pencil", label: "Pencil", key: "B", opts: ["size", "shape", "perfect", "dither", "sym"] },
    { id: "eraser", icon: "eraser", label: "Eraser", key: "E", opts: ["size", "shape", "sym"] },
    { id: "fill", icon: "bucket", label: "Fill", key: "G", opts: ["contiguous", "tolerance", "sym"] },
    { id: "gradient", icon: "gradient", label: "Gradient", key: "Shift+G", opts: ["gradMode", "gradDither"] },
    { id: "shade", icon: "shade", label: "Shade (left lightens, right darkens)", key: "K", opts: ["size", "shape", "shadeAmt"] },
    { sep: true },
    { id: "line", icon: "line", label: "Line", key: "L", opts: ["size", "sym"] },
    { id: "rect", icon: "rect", label: "Rectangle", key: "U", opts: ["size", "fillMode", "sym"] },
    { id: "ellipse", icon: "circle", label: "Ellipse", key: "O", opts: ["size", "fillMode", "sym"] },
    { sep: true },
    { id: "selrect", icon: "selectRect", label: "Rectangle select", key: "M", opts: ["selMode"] },
    { id: "selellipse", icon: "circle", label: "Ellipse select", key: "Shift+M", opts: ["selMode"] },
    { id: "lasso", icon: "lasso", label: "Lasso select", key: "Q", opts: ["selMode"] },
    { id: "wand", icon: "wand", label: "Magic wand", key: "W", opts: ["selMode", "contiguous", "tolerance"] },
    { id: "move", icon: "move", label: "Move selection (Enter commits, Esc cancels)", key: "V", opts: [] },
    { sep: true },
    { id: "picker", icon: "pipette", label: "Eyedropper (Alt-click with any tool)", key: "I", opts: ["sample"] },
    { id: "cell", icon: "grid", label: "Focus one cell of a sheet (Shift+click)", key: "C", opts: [] },
    { id: "hand", icon: "hand", label: "Pan (Space-drag or middle-drag)", key: "H", opts: [] },
    { id: "zoom", icon: "zoom", label: "Zoom (right-click zooms out)", key: "Z", opts: [] },
  ];
  const TOOL_BY_KEY = {};
  for (const t of TOOLS) if (t.key) TOOL_BY_KEY[t.key.toLowerCase()] = t.id;
  function buildToolStrip() {
    const host = $("px-tools"); host.innerHTML = "";
    for (const t of TOOLS) {
      if (t.sep) { const s = document.createElement("div"); s.className = "psep"; host.appendChild(s); continue; }
      const b = document.createElement("button"); b.className = "ptool"; b.dataset.tool = t.id; b.title = t.label + "  (" + t.key + ")"; b.innerHTML = I.svg(t.icon, 17);
      b.addEventListener("click", () => setTool(t.id));
      host.appendChild(b);
    }
  }
  function setTool(id) {
    if (!TOOLS.some((t) => t.id === id)) return;
    if (FLOAT.cv && id !== "move") commitFloat();
    if (T.tool !== id && T.tool !== "cell" && T.tool !== "picker") T.prev = T.tool;
    T.tool = id; saveTools();
    for (const b of $("px-tools").querySelectorAll(".ptool")) b.classList.toggle("active", b.dataset.tool === id);
    view.style.cursor = id === "picker" ? "crosshair" : id === "hand" ? "grab" : id === "zoom" ? "zoom-in" : id === "move" ? "move" : id === "cell" ? "cell" : "default";
    syncOptions(); render();
  }
  // Options bar: rebuilt for the active tool from small widgets.
  const OPT = {
    size: () => wrapOpt("Size", num("size", 1, 64) ),
    shape: () => seg("shape", [["square", "Square"], ["circle", "Round"]]),
    perfect: () => tog("perfect", "Pixel-perfect", "Drops the corner pixels of 1px lines"),
    dither: () => tog("dither", "Dither", "Checkerboard of primary and secondary colour"),
    sym: () => { const w = document.createElement("span"); w.className = "opt"; w.append(tog("symX", "Mirror X", "Symmetry across the vertical axis"), tog("symY", "Mirror Y", "Symmetry across the horizontal axis")); return w; },
    contiguous: () => tog("contiguous", "Contiguous", "Off = every matching pixel in the image (Shift-click also does this)"),
    tolerance: () => wrapOpt("Tolerance", range("tolerance", 0, 100)),
    fillMode: () => seg("fillMode", [["outline", "Outline"], ["filled", "Filled"]]),
    gradMode: () => seg("gradMode", [["linear", "Linear"], ["radial", "Radial"]]),
    gradDither: () => tog("gradDither", "Dithered", "Two-colour Bayer dither instead of a smooth blend"),
    shadeAmt: () => wrapOpt("Amount", range("shadeAmt", 1, 40)),
    selMode: () => seg("selMode", [["replace", "New"], ["add", "Add"], ["subtract", "Subtract"]], "Shift adds, Ctrl subtracts"),
    sample: () => seg("sample", [["layer", "This layer"], ["all", "All layers"]]),
  };
  function wrapOpt(label, el) { const w = document.createElement("span"); w.className = "opt"; const l = document.createElement("span"); l.textContent = label; w.append(l, el); return w; }
  function num(key, min, max) { const i = document.createElement("input"); i.type = "number"; i.min = min; i.max = max; i.value = T[key]; i.addEventListener("change", () => { T[key] = clamp(+i.value || min, min, max); i.value = T[key]; saveTools(); buildBrush(); render(); }); return i; }
  function range(key, min, max) { const w = document.createElement("span"); w.className = "opt"; const i = document.createElement("input"); i.type = "range"; i.min = min; i.max = max; i.value = T[key]; const v = document.createElement("span"); v.className = "val"; v.textContent = T[key]; i.addEventListener("input", () => { T[key] = +i.value; v.textContent = i.value; saveTools(); }); w.append(i, v); return w; }
  function seg(key, items, title) { const s = document.createElement("span"); s.className = "seg"; if (title) s.title = title; for (const [val, label] of items) { const b = document.createElement("button"); b.textContent = label; b.classList.toggle("on", T[key] === val); b.addEventListener("click", () => { T[key] = val; saveTools(); syncOptions(); render(); }); s.appendChild(b); } return s; }
  function tog(key, label, title) { const b = document.createElement("button"); b.className = "tog" + (T[key] ? " on" : ""); b.textContent = label; if (title) b.title = title; b.addEventListener("click", () => { T[key] = !T[key]; b.classList.toggle("on", T[key]); saveTools(); render(); }); return b; }
  function syncOptions() {
    const host = $("px-options"); host.innerHTML = "";
    const t = TOOLS.find((x) => x.id === T.tool); if (!t) return;
    const name = document.createElement("span"); name.className = "opt"; name.style.color = "var(--fg)"; name.style.fontWeight = "600"; name.textContent = t.label.split(" (")[0]; host.appendChild(name);
    for (const o of t.opts) if (OPT[o]) host.appendChild(OPT[o]());
    buildBrush();
  }

  // ---- menus: data-driven; add a command = append one row ----
  const MENUS = {
    File: () => [
      { label: "New image", mk: "Ctrl+N", icon: "filePlus", onClick: newImage },
      { label: "Open from Assets", icon: "image", onClick: () => window.NexusTabs.activate("assets") },
      { sep: true },
      { label: "Save", mk: "Ctrl+S", icon: "save", disabled: !D.loaded, onClick: save },
      { label: "Save as", icon: "copy", disabled: !D.loaded, onClick: saveAs },
      { label: "Export selection / cell as PNG", icon: "download", disabled: !D.loaded, onClick: exportRegion },
      { label: "Export scaled PNG", icon: "download", disabled: !D.loaded, onClick: exportScaled },
      { label: "Import image as floating layer", icon: "upload", disabled: !D.loaded, onClick: () => importInput.click() },
      { sep: true },
      { label: "Revert to the .bak", icon: "history", disabled: !D.loaded, danger: true, onClick: revertToBak },
    ],
    Edit: () => [
      { label: "Undo", mk: "Ctrl+Z", icon: "undo", disabled: !H.undo.length, onClick: undo },
      { label: "Redo", mk: "Ctrl+Y", icon: "redo", disabled: !H.redo.length, onClick: redo },
      { sep: true },
      { label: "Cut", mk: "Ctrl+X", onClick: () => copySel(true) },
      { label: "Copy", mk: "Ctrl+C", onClick: () => copySel(false) },
      { label: "Paste", mk: "Ctrl+V", disabled: !CLIP.cv, onClick: () => pasteClip(CLIP.cv) },
      { label: "Clear", mk: "Del", onClick: clearSelection },
      { label: "Fill with primary colour", mk: "Alt+Backspace", onClick: () => fillSelection(C.primary) },
      { sep: true },
      { label: "Swap colours", mk: "X", icon: "swap", onClick: swapColors },
      { label: "Replace colour", icon: "palette", onClick: replaceColorDialog },
    ],
    Select: () => [
      { label: "All", mk: "Ctrl+A", onClick: selectAll },
      { label: "Deselect", mk: "Ctrl+D", onClick: deselect },
      { label: "Invert", mk: "Ctrl+Shift+I", onClick: invertSelection },
      { label: "Select by primary colour", onClick: selectByColor },
      { sep: true },
      { label: "Grow 1px", onClick: () => growShrink(true) },
      { label: "Shrink 1px", onClick: () => growShrink(false) },
      { label: "Crop image to selection", icon: "crop", disabled: !SEL.bbox, onClick: cropToSelection },
    ],
    Image: () => [
      { label: "Flip horizontal", mk: "Shift+H", icon: "flipH", onClick: () => flipH(false) },
      { label: "Flip vertical", mk: "Shift+V", icon: "flipV", onClick: () => flipV(false) },
      { label: "Rotate 90 clockwise", icon: "rotate", onClick: () => rotate90(true) },
      { label: "Rotate 90 anticlockwise", onClick: () => rotate90(false) },
      { label: "Rotate 180", onClick: () => rotate180(false) },
      { sep: true },
      { label: "Resize canvas", onClick: resizeCanvasDialog },
      { label: "Scale image", onClick: scaleDialog },
      { label: "Offset (wrap)", onClick: offsetDialog },
      { label: "Outline", onClick: outlineDialog },
      { sep: true },
      { label: "Hue / saturation / lightness", icon: "sun", onClick: hslDialog },
      { label: "Brightness / contrast", onClick: brightnessDialog },
      { label: "Invert colours", onClick: () => invertColors(false) },
      { label: "Desaturate", onClick: () => desaturate(false) },
      { label: "Make primary colour transparent", onClick: removeColor },
    ],
    Layer: () => [
      { label: "New layer", mk: "N", icon: "plus", onClick: () => addLayer() },
      { label: "Duplicate layer", onClick: duplicateLayer },
      { label: "Merge down", mk: "Ctrl+E", onClick: mergeDown },
      { label: "Flatten image", onClick: flattenAll },
      { sep: true },
      { label: "Move up", onClick: () => moveLayer(1) },
      { label: "Move down", onClick: () => moveLayer(-1) },
      { label: "Rename", onClick: renameLayer },
      { label: "Delete layer", icon: "trash", danger: true, disabled: D.layers.length < 2, onClick: deleteLayer },
    ],
    View: () => [
      { label: "Zoom in", mk: "+", onClick: () => { zoomAt(view.width / 2, view.height / 2, 1); render(); } },
      { label: "Zoom out", mk: "-", onClick: () => { zoomAt(view.width / 2, view.height / 2, -1); render(); } },
      { label: "Fit", mk: "0", icon: "fit", onClick: () => { fit(CELL.focus ? bounds() : null); render(); } },
      { label: "Actual pixels (1:1)", mk: "1", onClick: () => { V.zoom = 1; fit; render(); } },
      { sep: true },
      { label: "Pixel grid", checked: V.grid, keepOpen: false, onClick: () => toggleView("grid") },
      { label: "Cell grid", checked: V.cells, onClick: () => toggleView("cells") },
      { label: "Checkerboard", checked: V.checker, onClick: () => toggleView("checker") },
      { label: "Tiled preview", sub: "Repeat the image around itself (tiles)", checked: V.tiled, onClick: () => toggleView("tiled") },
      { label: "Onion skin", sub: "Ghost the previous and next cells", checked: V.onion, onClick: () => toggleView("onion") },
      { label: "Symmetry lines", checked: V.symLines, onClick: () => toggleView("symLines") },
      { label: "Changes vs the .bak", checked: DIFF.show, onClick: toggleDiff },
      { sep: true },
      { label: "Side panel", mk: "Tab", checked: V.dock, onClick: toggleDock },
      { label: "Whole sheet", disabled: !CELL.focus, onClick: wholeSheet },
    ],
    Claude: () => [
      { label: "Ask about the selection", icon: "selectRect", sub: selHint(), disabled: !D.loaded, onClick: askSelection },
      { label: "Review the selection", icon: "eye", sub: selHint(), disabled: !D.loaded, onClick: reviewSelection },
      { sep: true },
      { label: "Apply this change to the other frames", icon: "sparkles", sub: "Uses the diff against the .bak", disabled: !D.loaded, onClick: () => askClaude(false) },
      { label: "Draw here", icon: "pencil", sub: selHint(), disabled: !D.loaded, onClick: askDraw },
      { label: "Review this sprite", icon: "eye", disabled: !D.loaded, onClick: askReview },
      { label: "Suggest a palette", icon: "palette", disabled: !D.loaded, onClick: askPalette },
    ],
  };
  function toggleView(key) { V[key] = !V[key]; saveView(); render(); }
  function toggleDock() { V.dock = !V.dock; saveView(); $("px-dock").classList.toggle("collapsed", !V.dock); requestAnimationFrame(() => { resize(); render(); }); }
  function buildMenuBar() {
    const host = $("px-menus"); host.innerHTML = "";
    for (const name of Object.keys(MENUS)) {
      const b = document.createElement("button"); b.className = "pxmenu"; b.textContent = name;
      b.addEventListener("click", () => { b.classList.add("open"); UI.popover(b, MENUS[name](), { width: 220, onClose: () => b.classList.remove("open") }); });
      host.appendChild(b);
    }
  }

  // ---- colour dock: swatches, HSV picker, palettes ----
  const PALETTES = {
    "PICO-8": "000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa",
    "DB16": "140c1c 442434 30346d 4e4a4e 854c30 346524 d04648 757161 597dce d27d2c 8595a1 6daa2c d2aa99 6dc2ca dad45e deeed6",
    "DB32": "000000 222034 45283c 663931 8f563b df7126 d9a066 eec39a fbf236 99e550 6abe30 37946e 4b692f 524b24 323c39 3f3f74 306082 5b6ee1 639bff 5fcde4 cbdbfc ffffff 9badb7 847e87 696a6a 595652 76428a ac3232 d95763 d77bba 8f974a 8a6f30",
    "Endesga 32": "be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633 e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e 124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466 262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569",
    "Sweetie 16": "1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57",
  };
  let paletteName = localStorage.getItem("nexus-px-palette") || "Image";
  let imagePalette = [], customPalette = [];
  function customKey() { const p = window.NexusApp && window.NexusApp.projectName(); return "nexus-px-custom-" + (p || "global"); }
  function loadCustom() { try { customPalette = JSON.parse(localStorage.getItem(customKey()) || "[]"); } catch { customPalette = []; } }
  function saveCustom() { localStorage.setItem(customKey(), JSON.stringify(customPalette)); }
  function buildImagePalette() {
    imagePalette = [];
    if (!D.loaded) return;
    const d = compose().getContext("2d").getImageData(0, 0, D.w, D.h).data, counts = new Map();
    const step = Math.max(1, Math.floor(Math.sqrt((D.w * D.h) / 250000)));
    for (let y = 0; y < D.h; y += step) for (let x = 0; x < D.w; x += step) { const i = (y * D.w + x) * 4; if (d[i + 3] < 128) continue; const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
    imagePalette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([k]) => "#" + k.toString(16).padStart(6, "0"));
    if (paletteName === "Image") renderPalette();
  }
  function currentPalette() { return paletteName === "Image" ? imagePalette : paletteName === "Custom" ? customPalette : (PALETTES[paletteName] || "").split(" ").map((h) => "#" + h); }
  const dockColor = $("px-dock-color");
  let svCv, hueCv, alphaInp, hexInp, primEl, secEl, palGrid, palSel, recentGrid, hsv = [0, 0, 1];
  function buildColorDock() {
    dockColor.innerHTML = "";
    const top = document.createElement("div"); top.className = "cp-top";
    const pair = document.createElement("div"); pair.className = "cp-pair";
    primEl = document.createElement("button"); primEl.className = "cp-swatch primary"; primEl.title = "Primary (left click). Click to edit."; primEl.innerHTML = '<span class="fillc"></span>';
    secEl = document.createElement("button"); secEl.className = "cp-swatch secondary"; secEl.title = "Secondary (right click). Click to edit."; secEl.innerHTML = '<span class="fillc"></span>';
    const swap = document.createElement("button"); swap.className = "ibtn sm cp-swap"; swap.title = "Swap (X)"; swap.innerHTML = I.svg("swap", 12); swap.addEventListener("click", swapColors);
    primEl.addEventListener("click", () => { C.target = "primary"; syncColorUI(); }); secEl.addEventListener("click", () => { C.target = "secondary"; syncColorUI(); });
    pair.append(primEl, secEl, swap);
    hexInp = document.createElement("input"); hexInp.className = "cp-hex"; hexInp.spellcheck = false; hexInp.placeholder = "#rrggbb";
    hexInp.addEventListener("change", () => { const c = parseHex(hexInp.value); if (c) setColor(C.target, c); else syncColorUI(); });
    top.append(pair, hexInp);
    svCv = document.createElement("canvas"); svCv.className = "cp-sv"; svCv.width = 200; svCv.height = 120;
    hueCv = document.createElement("canvas"); hueCv.className = "cp-hue"; hueCv.width = 200; hueCv.height = 12;
    const drag = (cv, fn) => { let down = false; cv.addEventListener("pointerdown", (e) => { down = true; cv.setPointerCapture(e.pointerId); fn(e); }); cv.addEventListener("pointermove", (e) => { if (down) fn(e); }); cv.addEventListener("pointerup", () => { down = false; pushRecent(C[C.target]); }); };
    drag(svCv, (e) => { const r = svCv.getBoundingClientRect(); hsv[1] = clamp((e.clientX - r.left) / r.width, 0, 1); hsv[2] = clamp(1 - (e.clientY - r.top) / r.height, 0, 1); fromHsv(); });
    drag(hueCv, (e) => { const r = hueCv.getBoundingClientRect(); hsv[0] = clamp((e.clientX - r.left) / r.width, 0, 0.9999) * 360; fromHsv(); });
    const arow = document.createElement("div"); arow.className = "cp-row";
    arow.innerHTML = "<label>A</label>"; alphaInp = document.createElement("input"); alphaInp.type = "range"; alphaInp.min = 0; alphaInp.max = 255; const aval = document.createElement("span"); aval.className = "val";
    alphaInp.addEventListener("input", () => { const c = C[C.target].slice(); c[3] = +alphaInp.value; setColor(C.target, c, true); aval.textContent = alphaInp.value; });
    arow.append(alphaInp, aval);
    const h4 = document.createElement("h4"); h4.innerHTML = "Palette";
    palSel = document.createElement("select"); palSel.className = "pal-select";
    for (const n of ["Image", "Custom", ...Object.keys(PALETTES)]) { const o = document.createElement("option"); o.value = n; o.textContent = n; palSel.appendChild(o); }
    palSel.value = paletteName; palSel.addEventListener("change", () => { paletteName = palSel.value; localStorage.setItem("nexus-px-palette", paletteName); renderPalette(); });
    const addB = document.createElement("button"); addB.className = "ibtn sm"; addB.title = "Add the primary colour to the custom palette"; addB.innerHTML = I.svg("plus", 12);
    addB.addEventListener("click", () => { const hx = toHex(C.primary); if (!customPalette.includes(hx)) customPalette.push(hx); saveCustom(); paletteName = "Custom"; palSel.value = "Custom"; renderPalette(); });
    const moreB = document.createElement("button"); moreB.className = "ibtn sm"; moreB.innerHTML = I.svg("more", 12);
    moreB.addEventListener("click", (e) => UI.popover(e.currentTarget, [
      { label: "Add all image colours to Custom", onClick: () => { for (const h of imagePalette) if (!customPalette.includes(h)) customPalette.push(h); saveCustom(); paletteName = "Custom"; palSel.value = "Custom"; renderPalette(); } },
      { label: "Clear the custom palette", danger: true, onClick: () => { customPalette = []; saveCustom(); renderPalette(); } },
      { label: "Copy palette as hex list", onClick: () => { navigator.clipboard.writeText(currentPalette().join("\n")); UI.toast("Copied"); } },
      { label: "Right-click a swatch to remove it (Custom)", disabled: true },
    ]));
    h4.append(document.createElement("span"), palSel, addB, moreB); h4.firstChild.className = "spacer";
    palGrid = document.createElement("div"); palGrid.className = "pal-grid";
    const h5 = document.createElement("h4"); h5.textContent = "Recent";
    recentGrid = document.createElement("div"); recentGrid.className = "pal-grid recent";
    dockColor.append(top, svCv, hueCv, arow, h4, palGrid, h5, recentGrid);
    loadCustom(); syncColorUI(); renderPalette();
  }
  function drawPicker() {
    if (!svCv) return;
    const sc = svCv.getContext("2d"), W = svCv.width, Hh = svCv.height;
    const base = hsvToRgb(hsv[0], 1, 1);
    sc.fillStyle = "rgb(" + base.join(",") + ")"; sc.fillRect(0, 0, W, Hh);
    let g = sc.createLinearGradient(0, 0, W, 0); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)"); sc.fillStyle = g; sc.fillRect(0, 0, W, Hh);
    g = sc.createLinearGradient(0, 0, 0, Hh); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,1)"); sc.fillStyle = g; sc.fillRect(0, 0, W, Hh);
    const px = hsv[1] * W, py = (1 - hsv[2]) * Hh;
    sc.strokeStyle = hsv[2] > 0.5 ? "#000" : "#fff"; sc.lineWidth = 1.5; sc.beginPath(); sc.arc(px, py, 5, 0, Math.PI * 2); sc.stroke();
    const hc = hueCv.getContext("2d"), hg = hc.createLinearGradient(0, 0, hueCv.width, 0);
    for (let i = 0; i <= 6; i++) hg.addColorStop(i / 6, "rgb(" + hsvToRgb(i * 60 % 360, 1, 1).join(",") + ")");
    hc.fillStyle = hg; hc.fillRect(0, 0, hueCv.width, hueCv.height);
    const hx = (hsv[0] / 360) * hueCv.width; hc.strokeStyle = "#fff"; hc.lineWidth = 2; hc.strokeRect(hx - 2, 0.5, 4, hueCv.height - 1);
  }
  function fromHsv() { const rgb = hsvToRgb(hsv[0], hsv[1], hsv[2]); setColor(C.target, [rgb[0], rgb[1], rgb[2], C[C.target][3] || 255], true); }
  function setColor(which, c, keepHsv) {
    C[which] = [c[0], c[1], c[2], c[3] == null ? 255 : c[3]];
    if (which === C.target && !keepHsv) hsv = rgbToHsv(c[0], c[1], c[2]);
    syncColorUI();
  }
  function swapColors() { const t = C.primary; C.primary = C.secondary; C.secondary = t; hsv = rgbToHsv(...C[C.target]); syncColorUI(); }
  function pushRecent(c) { if (c[3] === 0) return; const hx = toHex(c, true); C.recent = [hx, ...C.recent.filter((x) => x !== hx)].slice(0, 12); renderRecent(); }
  const cssColor = (c) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (c[3] / 255).toFixed(3) + ")";
  function syncColorUI() {
    if (!primEl) return;
    primEl.querySelector(".fillc").style.background = cssColor(C.primary);
    secEl.querySelector(".fillc").style.background = cssColor(C.secondary);
    primEl.style.borderColor = C.target === "primary" ? "var(--fg)" : "var(--line2)";
    secEl.style.borderColor = C.target === "secondary" ? "var(--fg)" : "var(--line2)";
    const cur = C[C.target];
    hexInp.value = toHex(cur, true); alphaInp.value = cur[3]; alphaInp.nextElementSibling.textContent = cur[3];
    drawPicker();
    for (const sw of palGrid.querySelectorAll(".pswatch")) { sw.classList.toggle("cur", sw.dataset.hex === toHex(C.primary)); sw.classList.toggle("cur2", sw.dataset.hex === toHex(C.secondary) && C.secondary[3] > 0); }
    updateStatusBar();
  }
  function swatch(hex, removable) {
    const b = document.createElement("button"); b.className = "pswatch"; b.dataset.hex = hex.slice(0, 7); b.title = hex; b.innerHTML = '<span class="fillc" style="background:' + hex + '"></span>';
    b.addEventListener("click", (e) => { const c = parseHex(hex); if (!c) return; setColor(e.shiftKey ? "secondary" : "primary", c); if (!e.shiftKey) C.target = "primary"; syncColorUI(); });
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); const c = parseHex(hex); if (!c) return; if (removable && paletteName === "Custom" && e.ctrlKey) { customPalette = customPalette.filter((h) => h !== hex); saveCustom(); renderPalette(); return; } setColor("secondary", c); });
    return b;
  }
  function renderPalette() { if (!palGrid) return; palGrid.innerHTML = ""; for (const hx of currentPalette()) palGrid.appendChild(swatch(hx, true)); if (!palGrid.children.length) palGrid.innerHTML = '<span class="dim" style="font-size:11px">' + (paletteName === "Custom" ? "Empty. Press + to add the primary colour." : "No colours yet.") + "</span>"; syncColorUI(); }
  function renderRecent() { if (!recentGrid) return; recentGrid.innerHTML = ""; for (const hx of C.recent) recentGrid.appendChild(swatch(hx, false)); }

  // ---- layers dock ----
  const dockLayers = $("px-dock-layers");
  let layList, opacityInp;
  function buildLayersDock() {
    dockLayers.innerHTML = "";
    const tb = document.createElement("div"); tb.className = "lay-toolbar";
    const mk = (icon, title, fn) => { const b = document.createElement("button"); b.className = "ibtn sm"; b.title = title; b.innerHTML = I.svg(icon, 13); b.addEventListener("click", fn); tb.appendChild(b); };
    mk("plus", "New layer (N)", () => addLayer()); mk("copy", "Duplicate", duplicateLayer); mk("layers", "Merge down (Ctrl+E)", mergeDown);
    mk("chevronUp", "Move up", () => moveLayer(1)); mk("chevronDown", "Move down", () => moveLayer(-1)); mk("trash", "Delete", deleteLayer);
    layList = document.createElement("div"); layList.className = "lay-list";
    const orow = document.createElement("div"); orow.className = "cp-row"; orow.innerHTML = "<label>Opacity</label>";
    opacityInp = document.createElement("input"); opacityInp.type = "range"; opacityInp.min = 0; opacityInp.max = 100; opacityInp.value = 100;
    const oval = document.createElement("span"); oval.className = "val"; oval.textContent = "100";
    opacityInp.addEventListener("input", () => { const l = L(); if (!l) return; l.opacity = +opacityInp.value / 100; oval.textContent = opacityInp.value; touch(); markDirty(); render(); });
    opacityInp.addEventListener("change", () => refreshLayers());
    orow.append(opacityInp, oval);
    dockLayers.append(tb, layList, orow);
    refreshLayers();
  }
  function refreshLayers() {
    if (!layList) return;
    layList.innerHTML = "";
    for (let i = D.layers.length - 1; i >= 0; i--) {
      const l = D.layers[i];
      const row = document.createElement("div"); row.className = "lay-row" + (i === D.active ? " active" : "") + (l.visible ? "" : " hiddenlayer");
      const eye = document.createElement("button"); eye.className = "ibtn sm" + (l.visible ? " on" : ""); eye.title = "Visible"; eye.innerHTML = I.svg(l.visible ? "eye" : "eyeOff", 12);
      eye.addEventListener("click", (e) => { e.stopPropagation(); l.visible = !l.visible; touch(); markDirty(); refreshLayers(); render(); });
      const lock = document.createElement("button"); lock.className = "ibtn sm" + (l.locked ? " on" : ""); lock.title = "Locked"; lock.innerHTML = I.svg(l.locked ? "lock" : "unlock", 12);
      lock.addEventListener("click", (e) => { e.stopPropagation(); l.locked = !l.locked; refreshLayers(); });
      const th = document.createElement("canvas"); th.className = "lay-thumb"; th.width = 28; th.height = 28;
      const tc = th.getContext("2d"); tc.imageSmoothingEnabled = false; const s = Math.min(28 / D.w, 28 / D.h); tc.drawImage(l.cv, (28 - D.w * s) / 2, (28 - D.h * s) / 2, D.w * s, D.h * s);
      const name = document.createElement("span"); name.className = "lay-name"; name.textContent = l.name; name.title = "Double-click to rename";
      name.addEventListener("dblclick", (e) => { e.stopPropagation(); D.active = i; renameLayer(); });
      row.append(eye, lock, th, name);
      row.addEventListener("click", () => { if (FLOAT.cv) commitFloat(); D.active = i; refreshLayers(); updateStatusBar(); });
      layList.appendChild(row);
    }
    if (L() && opacityInp) { opacityInp.value = Math.round(L().opacity * 100); opacityInp.nextElementSibling.textContent = opacityInp.value; }
    updateStatusBar();
  }
  // Structural layer ops record closures so undo can put the list back exactly.
  function layerOp(label, apply, revert) { apply(); pushHistory({ label, bytes: 0, undo: () => { revert(); refreshLayers(); }, redo: () => { apply(); refreshLayers(); } }); touch(); markDirty(); refreshLayers(); render(); }
  function addLayer(name) {
    const l = newLayer(name || "Layer " + (D.layers.length + 1)), at = D.active + 1;
    layerOp("new layer", () => { if (!D.layers.includes(l)) D.layers.splice(at, 0, l); D.active = at; }, () => { D.layers.splice(D.layers.indexOf(l), 1); D.active = Math.max(0, at - 1); });
    return l;
  }
  function duplicateLayer() {
    const src = L(); if (!src) return;
    const l = newLayer(src.name + " copy"); l.cx.drawImage(src.cv, 0, 0); l.opacity = src.opacity; const at = D.active + 1;
    layerOp("duplicate layer", () => { if (!D.layers.includes(l)) D.layers.splice(at, 0, l); D.active = at; }, () => { D.layers.splice(D.layers.indexOf(l), 1); D.active = at - 1; });
  }
  function deleteLayer() {
    if (D.layers.length < 2) { UI.toast("Keep at least one layer", "warn"); return; }
    const l = L(), at = D.active;
    layerOp("delete layer", () => { D.layers.splice(D.layers.indexOf(l), 1); D.active = Math.max(0, at - 1); }, () => { D.layers.splice(at, 0, l); D.active = at; });
  }
  function mergeDown() {
    const at = D.active; if (at < 1) { UI.toast("Nothing below this layer", "warn"); return; }
    const top = D.layers[at], below = D.layers[at - 1];
    const keep = document.createElement("canvas"); keep.width = D.w; keep.height = D.h; keep.getContext("2d").drawImage(below.cv, 0, 0);
    const merged = document.createElement("canvas"); merged.width = D.w; merged.height = D.h; const mc = merged.getContext("2d");
    mc.globalAlpha = below.opacity; mc.drawImage(below.cv, 0, 0); mc.globalAlpha = top.visible ? top.opacity : 0; mc.drawImage(top.cv, 0, 0);
    const oldOpacity = below.opacity;
    layerOp("merge down",
      () => { below.cx.clearRect(0, 0, D.w, D.h); below.cx.drawImage(merged, 0, 0); below.opacity = 1; if (D.layers.includes(top)) D.layers.splice(D.layers.indexOf(top), 1); D.active = at - 1; },
      () => { below.cx.clearRect(0, 0, D.w, D.h); below.cx.drawImage(keep, 0, 0); below.opacity = oldOpacity; D.layers.splice(at, 0, top); D.active = at; });
  }
  function flattenAll() {
    if (D.layers.length < 2) return;
    const old = D.layers.slice(), oldActive = D.active;
    const flat = newLayer("Background"); flat.cx.drawImage(compose(), 0, 0);
    layerOp("flatten", () => { D.layers = [flat]; D.active = 0; }, () => { D.layers = old.slice(); D.active = oldActive; });
  }
  function moveLayer(dir) {
    const at = D.active, to = at + dir; if (to < 0 || to >= D.layers.length) return;
    layerOp("move layer", () => { const l = D.layers.splice(at, 1)[0]; D.layers.splice(to, 0, l); D.active = to; }, () => { const l = D.layers.splice(to, 1)[0]; D.layers.splice(at, 0, l); D.active = at; });
  }
  async function renameLayer() {
    const l = L(); if (!l) return;
    const v = await UI.prompt("Rename layer", { value: l.name, okLabel: "Rename" });
    if (v == null || !v.trim()) return;
    const old = l.name, nn = v.trim();
    layerOp("rename layer", () => { l.name = nn; }, () => { l.name = old; });
  }

  // ---- frames dock: cell size, thumbnails, playback, onion skin ----
  const dockFrames = $("px-dock-frames");
  let frStrip, frPreview, frPlayBtn, frFps, cellWInp, cellHInp, frFrom, frTo, onionBtn, playTimer = null;
  function buildFramesDock() {
    dockFrames.innerHTML = "";
    const crow = document.createElement("div"); crow.className = "cp-row";
    crow.innerHTML = "<label>Cell</label>";
    cellWInp = document.createElement("input"); cellWInp.type = "number"; cellWInp.min = 0; cellWInp.max = 1024; cellWInp.style.width = "52px"; cellWInp.title = "Cell width (0 = no grid)";
    cellHInp = document.createElement("input"); cellHInp.type = "number"; cellHInp.min = 0; cellHInp.max = 1024; cellHInp.style.width = "52px"; cellHInp.title = "Cell height";
    const x = document.createElement("span"); x.className = "dim"; x.textContent = "x";
    const preset = document.createElement("button"); preset.className = "ibtn sm"; preset.innerHTML = I.svg("chevronDown", 12); preset.title = "Common sizes";
    preset.addEventListener("click", (e) => UI.popover(e.currentTarget, [8, 16, 24, 32, 48, 64, 128].map((s) => ({ label: s + " x " + s, onClick: () => setCell(s, s) })).concat([{ sep: true }, { label: "No grid", onClick: () => setCell(0, 0) }])));
    for (const i of [cellWInp, cellHInp]) i.addEventListener("change", () => setCell(+cellWInp.value || 0, +cellHInp.value || +cellWInp.value || 0));
    crow.append(cellWInp, x, cellHInp, preset);
    frStrip = document.createElement("div"); frStrip.className = "fr-strip";
    const prow = document.createElement("div"); prow.className = "cp-row";
    frPlayBtn = document.createElement("button"); frPlayBtn.className = "ibtn sm"; frPlayBtn.innerHTML = I.svg("play", 12); frPlayBtn.title = "Play the cells as an animation";
    frPlayBtn.addEventListener("click", togglePlay);
    frFps = document.createElement("input"); frFps.type = "range"; frFps.min = 1; frFps.max = 30; frFps.value = CELL.fps;
    const fval = document.createElement("span"); fval.className = "val"; fval.textContent = CELL.fps + " fps";
    frFps.addEventListener("input", () => { CELL.fps = +frFps.value; fval.textContent = CELL.fps + " fps"; if (CELL.playing) { stopPlay(); togglePlay(); } });
    prow.append(frPlayBtn, frFps, fval);
    const rrow = document.createElement("div"); rrow.className = "fr-range"; rrow.innerHTML = "<span class='dim'>Range</span>";
    frFrom = document.createElement("input"); frFrom.type = "number"; frFrom.min = 0; frTo = document.createElement("input"); frTo.type = "number"; frTo.min = 0;
    for (const i of [frFrom, frTo]) i.addEventListener("change", () => { const n = frameCount(); CELL.from = clamp(+frFrom.value || 0, 0, Math.max(0, n - 1)); CELL.to = clamp(+frTo.value || 0, CELL.from, Math.max(0, n - 1)); frFrom.value = CELL.from; frTo.value = CELL.to; });
    const dash = document.createElement("span"); dash.className = "dim"; dash.textContent = "to";
    rrow.append(frFrom, dash, frTo);
    frPreview = document.createElement("div"); frPreview.className = "fr-preview"; const pc = document.createElement("canvas"); frPreview.appendChild(pc);
    const orow = document.createElement("div"); orow.className = "cp-row";
    onionBtn = document.createElement("button"); onionBtn.className = "tog" + (V.onion ? " on" : ""); onionBtn.innerHTML = I.svg("onion", 12) + " Onion skin"; onionBtn.title = "Ghost the previous (red) and next (green) cells behind the focused one";
    onionBtn.addEventListener("click", () => { V.onion = !V.onion; onionBtn.classList.toggle("on", V.onion); saveView(); render(); });
    const whole = document.createElement("button"); whole.className = "btn sm"; whole.textContent = "Whole sheet"; whole.addEventListener("click", wholeSheet);
    orow.append(onionBtn, whole);
    const hint2 = document.createElement("div"); hint2.className = "dim"; hint2.style.fontSize = "11px"; hint2.textContent = "Click a cell to focus it. PageUp / PageDown step through cells.";
    dockFrames.append(crow, frStrip, prow, rrow, frPreview, orow, hint2);
    refreshFrames();
  }
  function setCell(w, h) {
    CELL.w = clamp(w | 0, 0, 1024); CELL.h = clamp((h == null ? w : h) | 0, 0, 1024);
    if (!CELL.w || !CELL.h) { CELL.w = CELL.h = 0; CELL.focus = null; }
    if (cellWInp) { cellWInp.value = CELL.w; cellHInp.value = CELL.h; }
    const n = frameCount(); CELL.from = 0; CELL.to = Math.max(0, n - 1);
    if (frFrom) { frFrom.value = 0; frTo.value = CELL.to; frFrom.max = frTo.max = CELL.to; }
    refreshFrames(); render();
  }
  function cellIndex() { if (!CELL.focus) return -1; return CELL.focus.cy * Math.floor(D.w / CELL.w) + CELL.focus.cx; }
  function refreshFrames() {
    if (!frStrip) return;
    frStrip.innerHTML = "";
    const n = frameCount();
    if (!D.loaded || !n) { frStrip.innerHTML = '<span class="dim" style="font-size:11px">Set a cell size to see the sheet as frames.</span>'; return; }
    const cols = Math.floor(D.w / CELL.w), cur = cellIndex();
    const img = compose();
    for (let i = 0; i < n; i++) {
      const th = document.createElement("canvas"); th.className = "fr-thumb" + (i === cur ? " active" : ""); th.width = 36; th.height = 36; th.title = "cell " + (i % cols) + "," + Math.floor(i / cols) + "  (frame " + i + ")";
      const tc = th.getContext("2d"); tc.imageSmoothingEnabled = false; const s = Math.min(36 / CELL.w, 36 / CELL.h);
      tc.drawImage(img, (i % cols) * CELL.w, Math.floor(i / cols) * CELL.h, CELL.w, CELL.h, (36 - CELL.w * s) / 2, (36 - CELL.h * s) / 2, CELL.w * s, CELL.h * s);
      th.dataset.i = i;
      th.addEventListener("click", () => focusCell(i % cols, Math.floor(i / cols)));
      frStrip.appendChild(th);
    }
    if (DIFF.frames) for (const f of DIFF.frames) { const q = f.key.split(",").map(Number); const el = frStrip.children[q[1] * cols + q[0]]; if (el) el.classList.add("changed"); }
    drawPreviewFrame(cur >= 0 ? cur : CELL.frame);
  }
  let thumbTimer = null;
  function refreshFrameThumbs() { if (thumbTimer) return; thumbTimer = setTimeout(() => { thumbTimer = null; refreshFrames(); refreshLayers(); }, 150); }
  function drawPreviewFrame(i) {
    if (!frPreview) return;
    const pc = frPreview.firstChild, n = frameCount();
    if (!n) { pc.width = pc.height = 0; return; }
    const cols = Math.floor(D.w / CELL.w), s = clamp(Math.floor(160 / Math.max(CELL.w, CELL.h)), 1, 8);
    pc.width = CELL.w * s; pc.height = CELL.h * s;
    const c2 = pc.getContext("2d"); c2.imageSmoothingEnabled = false; c2.clearRect(0, 0, pc.width, pc.height);
    c2.drawImage(compose(), (i % cols) * CELL.w, Math.floor(i / cols) * CELL.h, CELL.w, CELL.h, 0, 0, pc.width, pc.height);
    for (const el of frStrip.children) el.classList.toggle("playing", CELL.playing && +el.dataset.i === i);
  }
  function togglePlay() {
    if (CELL.playing) { stopPlay(); return; }
    if (!frameCount()) { UI.toast("Set a cell size first", "warn"); return; }
    CELL.playing = true; CELL.frame = CELL.from; frPlayBtn.innerHTML = I.svg("pause", 12);
    playTimer = setInterval(() => { drawPreviewFrame(CELL.frame); CELL.frame = CELL.frame >= CELL.to ? CELL.from : CELL.frame + 1; }, 1000 / CELL.fps);
  }
  function stopPlay() { CELL.playing = false; if (playTimer) clearInterval(playTimer); playTimer = null; if (frPlayBtn) frPlayBtn.innerHTML = I.svg("play", 12); drawPreviewFrame(Math.max(0, cellIndex())); }
  function stepCell(dir) {
    const n = frameCount(); if (!n) return;
    const cols = Math.floor(D.w / CELL.w);
    const i = clamp((cellIndex() < 0 ? 0 : cellIndex()) + dir, 0, n - 1);
    focusCell(i % cols, Math.floor(i / cols));
  }
  function showDock(tab) {
    V.dockTab = tab; saveView();
    for (const b of document.querySelectorAll("#px-dock-tabs .dtab")) b.classList.toggle("active", b.dataset.dock === tab);
    for (const id of ["color", "layers", "frames"]) $("px-dock-" + id).hidden = id !== tab;
  }
  for (const b of document.querySelectorAll("#px-dock-tabs .dtab")) b.addEventListener("click", () => showDock(b.dataset.dock));

  // ---- what changed since the .bak (the bridge to Claude) ----
  const bakCv = document.createElement("canvas"), bakCtx = bakCv.getContext("2d", { willReadFrequently: true });
  async function loadBak() {
    DIFF.bak = null;
    if (!D.path) return false;
    let img; try { img = await loadImage("/raw?path=" + encodeURIComponent(D.path + ".bak") + "&ts=" + Date.now()); } catch { return false; }
    if (img.naturalWidth !== D.w || img.naturalHeight !== D.h) return false;
    bakCv.width = D.w; bakCv.height = D.h; bakCtx.clearRect(0, 0, D.w, D.h); bakCtx.drawImage(img, 0, 0);
    DIFF.bak = true;
    return true;
  }
  function computeDiff() {
    if (!DIFF.bak) return null;
    const a = compose().getContext("2d").getImageData(0, 0, D.w, D.h).data, b = bakCtx.getImageData(0, 0, D.w, D.h).data, pts = [];
    for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) { const i = (y * D.w + x) * 4; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) pts.push([x, y]); }
    let bbox = null, frames = [];
    if (pts.length) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (CELL.w > 0 && CELL.h > 0) {
        const byKey = new Map();
        for (const pt of pts) { const key = Math.floor(pt[0] / CELL.w) + "," + Math.floor(pt[1] / CELL.h); if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(pt); }
        for (const [key, list] of byKey) { const fx = list.map((p) => p[0]), fy = list.map((p) => p[1]); frames.push({ key, count: list.length, bbox: [Math.min(...fx), Math.min(...fy), Math.max(...fx), Math.max(...fy)] }); }
        frames.sort((p, q) => q.count - p.count);
      }
    }
    DIFF.pts = pts; DIFF.frames = frames; DIFF.bbox = bbox;
    return DIFF;
  }
  async function toggleDiff() {
    if (DIFF.show) { DIFF.show = false; DIFF.pts = null; DIFF.frames = null; refreshFrames(); render(); setStatus(""); return; }
    if (!D.loaded) return;
    if (!(await loadBak())) { setStatus("no .bak for this file yet - save once and the original is kept", true); return; }
    computeDiff(); DIFF.show = true; refreshFrames(); render();
    if (!DIFF.pts.length) { setStatus("no changes vs the .bak"); return; }
    setStatus(DIFF.pts.length + " px changed" + (DIFF.frames.length ? " in frame " + DIFF.frames.map((f) => f.key).join(" and ") : "") + "  (bbox " + DIFF.bbox.join(",") + ")");
  }

  // ---- Claude hooks ----
  const q = (p) => '"' + p + '"';
  const cellArg = () => (CELL.w > 0 && CELL.h > 0 ? " --cell " + CELL.w + "x" + CELL.h : "");
  // Whatever Tucker has ringed with the selection tools IS the thing he is asking
  // about. A selection wins; a focused cell is the fallback; failing both it is
  // the whole image. Every Claude hand-off below scopes itself to this.
  function focusRegion() {
    if (SEL.bbox) return { x: SEL.bbox.x, y: SEL.bbox.y, w: SEL.bbox.w, h: SEL.bbox.h, kind: "selection" };
    if (CELL.focus && CELL.w > 0 && CELL.h > 0) {
      const b = bounds(); return { x: b.x, y: b.y, w: b.w, h: b.h, kind: "cell" };
    }
    return { x: 0, y: 0, w: D.w, h: D.h, kind: "image" };
  }
  function regionWords(r) {
    const span = "x " + r.x + ".." + (r.x + r.w - 1) + ", y " + r.y + ".." + (r.y + r.h - 1);
    if (r.kind === "selection") return "the area I selected - " + span + ", " + r.w + "x" + r.h + " px in whole-image coordinates";
    if (r.kind === "cell") return "frame " + CELL.focus.cx + "," + CELL.focus.cy + " of the " + CELL.w + "x" + CELL.h + " grid (" + span + ")";
    return "the whole " + D.w + "x" + D.h + " image";
  }
  function selHint() {
    if (!D.loaded) return null;
    const r = focusRegion();
    if (r.kind === "selection") return r.w + "x" + r.h + " px at " + r.x + "," + r.y;
    if (r.kind === "cell") return "nothing selected - cell " + CELL.focus.cx + "," + CELL.focus.cy;
    return "nothing selected - the whole image";
  }
  const rectArg = (r) => " --rect " + r.x + "," + r.y + "," + r.w + "," + r.h;
  // The crop as a PNG, blown up nearest-neighbour so Claude sees actual pixels
  // instead of a smudge, on a checkerboard so transparency cannot read as paint.
  function regionPng(r, target) {
    const scale = Math.max(1, Math.min(16, Math.floor((target || 512) / Math.max(1, Math.max(r.w, r.h)))));
    const cv = document.createElement("canvas");
    cv.width = r.w * scale; cv.height = r.h * scale;
    const cx = cv.getContext("2d");
    const sq = Math.max(4, 4 * scale);
    for (let y = 0; y < cv.height; y += sq) {
      for (let x = 0; x < cv.width; x += sq) {
        cx.fillStyle = (((x / sq) | 0) + ((y / sq) | 0)) & 1 ? "#8a8a8a" : "#b6b6b6";
        cx.fillRect(x, y, sq, sq);
      }
    }
    cx.imageSmoothingEnabled = false;
    cx.drawImage(compose(), r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
    return { data: cv.toDataURL("image/png").split(",")[1], scale };
  }
  async function askClaude(dryRun) {
    if (!D.loaded) return;
    if (!dryRun && (!window.NexusChat || !window.NexusChat.isReady())) { setStatus("Claude sidebar is not connected", true); return; }
    if (D.dirty && !dryRun) await save();            // Claude works on the file on disk
    if (!(await loadBak())) { setStatus("no .bak to compare against - save once first", true); return; }
    const d = computeDiff();
    if (!d || !d.pts.length) { setStatus("nothing changed vs the .bak", true); return; }
    const cell = CELL.w > 0 && CELL.h > 0 ? CELL.w + "x" + CELL.h : null;
    // The reference is the frame I changed most; other changed frames are done.
    const ref = d.frames.length ? d.frames[0] : null;
    const others = d.frames.slice(1).map((f) => f.key);
    const box = ref ? ref.bbox : d.bbox;
    const pad = 3;
    const lim = ref ? (() => { const c = ref.key.split(",").map(Number); return { x0: c[0] * CELL.w, y0: c[1] * CELL.h, x1: (c[0] + 1) * CELL.w - 1, y1: (c[1] + 1) * CELL.h - 1 }; })() : { x0: 0, y0: 0, x1: D.w - 1, y1: D.h - 1 };
    const rx = Math.max(lim.x0, box[0] - pad), ry = Math.max(lim.y0, box[1] - pad);
    const rect = [rx, ry, Math.min(lim.x1, box[2] + pad) - rx + 1, Math.min(lim.y1, box[3] + pad) - ry + 1].join(",");
    const lines = [
      "I edited " + D.path + " in the Pixel tab.",
      d.pts.length + " pixels changed" + (ref ? ", " + ref.count + " of them in frame " + ref.key + (cell ? " of a " + cell + " grid" : "") + "." : "."),
      ref ? "Frame " + ref.key + " is the reference - that is where I made the change." : "",
      others.length ? "I also already updated frame " + others.join(" and ") + " - leave those alone." : "",
      "Changed area in the reference frame: x " + box[0] + ".." + box[2] + ", y " + box[1] + ".." + box[3] + " (whole-image coordinates).",
      "",
      "Apply the same change to the sheet's other frames. Steps:",
      "1. " + TOOL_CLI + " diff " + q(D.path) + " --bak" + (cell ? " --cell " + cell : "") + " --art",
      "   - shows the before/after art of exactly what I changed.",
      "2. " + TOOL_CLI + " find " + q(D.path + ".bak") + " --cell " + (cell || "32x32") + " --rect " + rect,
      "   - searches the ORIGINAL art for that patch. 100% means the frame draws it identically and a",
      "     paste is safe; anything less means that frame draws it at a different angle or pose and you",
      "     must redraw the change by hand there.",
      "3. For every frame that is not identical: read it with",
      "   " + TOOL_CLI + " show " + q(D.path) + " --cell " + (cell || "32x32") + " --frame <cx,cy>",
      "   work out where the same part sits in that pose, and write the redrawn grid back with",
      "   " + TOOL_CLI + " write " + q(D.path) + " --cell " + (cell || "32x32") + " --frame <cx,cy> --art <file>",
      "   (or " + TOOL_CLI + " set ... for a handful of pixels).",
      "4. Re-read each frame you touched with show and check the silhouette still reads right.",
      "5. Tell me which frames you changed, which you left alone, and why.",
      "",
      "The .bak beside the file is my original - never overwrite it.",
    ].filter(Boolean);
    const text = lines.join(String.fromCharCode(10));
    if (dryRun) return text;
    window.NexusChat.ask(text);
    setStatus("sent to Claude - watch the sidebar");
  }
  // Hand the selection to the sidebar: the crop as an attached image so Claude
  // literally sees it, plus the exact rectangle and the commands that read and
  // write that same area, so it works on what Tucker is pointing at.
  async function sendRegion(question, autoSend) {
    if (!D.loaded) return;
    if (!window.NexusChat || !window.NexusChat.isReady()) { setStatus("Claude sidebar is not connected", true); return; }
    const r = focusRegion();
    if (D.dirty) await save();               // Claude reads the file on disk
    const crop = regionPng(r, 512);
    window.NexusChat.attachImage({ name: (D.label || "sprite") + "  " + r.w + "x" + r.h, media_type: "image/png", data: crop.data });
    const lines = [
      "In " + D.path + " I am looking at " + regionWords(r) + ".",
      "The attached image is that exact crop at " + crop.scale + "x zoom - the grey checkerboard is transparency, not paint.",
      "Read the real pixels with:",
      "  " + TOOL_CLI + " show " + q(D.path) + rectArg(r),
      "and write changes back into the same area with:",
      "  " + TOOL_CLI + " write " + q(D.path) + rectArg(r) + " --art <file>",
      "  " + TOOL_CLI + " set " + q(D.path) + ' --px \"x,y=#rrggbb;x,y=none\"'  + "   (for a handful of pixels)",
      "Both take whole-image coordinates, so the rectangle above drops straight in.",
      r.kind === "image" ? "" : "Stay inside that area - leave the rest of the sheet alone unless I ask.",
      "",
      question || "",
    ].filter(function (l) { return l !== ""; });
    window.NexusChat.ask(lines.join(String.fromCharCode(10)), !!autoSend);
    setStatus(autoSend ? "sent to Claude - watch the sidebar"
      : "in the Claude box with the crop attached - type your question and press Enter");
  }
  const askSelection = () => sendRegion(null, false);
  const reviewSelection = () => sendRegion(
    "Tell me what reads badly in there - silhouette, contrast, stray pixels, light direction, palette drift - " +
    "and the smallest fixes. Do not change anything yet.", true);

  async function askDraw() {
    if (!D.loaded) return;
    const r = focusRegion();
    const spot = r.kind === "selection" ? "in the selected " + r.w + "x" + r.h + " area"
      : r.kind === "cell" ? "in cell " + CELL.focus.cx + "," + CELL.focus.cy : "in this image";
    const what = await UI.prompt("Ask Claude to draw", { label: "What should go " + spot + "?", placeholder: "a small oak tree, 3 shades of green, brown trunk" });
    if (!what) return;
    if (D.dirty) await save();
    const where = regionWords(r);
    if (r.kind !== "image") window.NexusChat.attachImage({ name: (D.label || "sprite") + "  " + r.w + "x" + r.h,
      media_type: "image/png", data: regionPng(r, 512).data });
    const target = r.kind === "selection" ? rectArg(r) : cellArg() + (CELL.focus ? " --frame " + CELL.focus.cx + "," + CELL.focus.cy : "");
    const text = [
      "Draw this in " + D.path + " - " + where + ": " + what,
      "",
      "Use the sprite tool. First look at what is there and at a neighbouring frame for style:",
      "  " + TOOL_CLI + " show " + q(D.path) + target,
      "Then write the finished grid back with",
      "  " + TOOL_CLI + " write " + q(D.path) + target + " --art <file>",
      "and re-read it with show to check the silhouette. Keep to the palette already in the sheet unless I said otherwise.",
      "Only touch " + where + ". I will reload the Pixel tab when you are done.",
    ].join(String.fromCharCode(10));
    window.NexusChat.ask(text);
    setStatus("sent to Claude - the tab reloads when it finishes");
  }
  async function askReview() {
    if (!D.loaded) return;
    if (D.dirty) await save();
    window.NexusChat.ask("Review the pixel art in " + D.path + ". Read it with " + TOOL_CLI + " info " + q(D.path) + cellArg() + " and show. Tell me what reads badly (silhouette, contrast, stray pixels, inconsistent light direction, palette drift" + (CELL.w ? ", frames that do not match the others" : "") + ") and the smallest fixes. Do not change anything yet.");
  }
  async function askPalette() {
    if (!D.loaded) return;
    if (D.dirty) await save();
    window.NexusChat.ask("Look at the palette of " + D.path + " with " + TOOL_CLI + " info " + q(D.path) + ". Suggest a tighter palette (fewer, better-ramped colours) as a list of hex values with what each is for, and say which existing colours you would merge. Do not change the file.");
  }
  // Claude (or git) changed the open PNG on disk: reload it unless there are unsaved edits.
  window.addEventListener("nexus-files-changed", (e) => {
    const paths = (e.detail && e.detail.paths) || [];
    if (!D.loaded || !D.path) return;
    if (paths.length && !paths.some((p) => p.toLowerCase() === D.path.toLowerCase())) return;
    if (D.dirty) { setStatus("changed on disk by Claude - you have unsaved edits", true); return; }
    open(D.path, D.label).then(() => setStatus("reloaded - Claude changed this file"));
  });

  // ---- status bar ----
  function updateStatusBar() {
    const pos = $("px-pos"), ci = $("px-colorinfo"), si = $("px-selinfo"), li = $("px-layerinfo");
    if (!D.loaded) { pos.textContent = ci.textContent = si.textContent = li.textContent = ""; return; }
    if (P.hover && inImage(P.hover.x, P.hover.y)) {
      pos.textContent = P.hover.x + ", " + P.hover.y;
      const d = compose().getContext("2d").getImageData(P.hover.x, P.hover.y, 1, 1).data;
      ci.textContent = d[3] ? toHex([d[0], d[1], d[2]]) + (d[3] < 255 ? " a" + d[3] : "") : "transparent";
    } else { pos.textContent = ""; ci.textContent = ""; }
    si.textContent = SEL.bbox ? "sel " + SEL.bbox.w + "x" + SEL.bbox.h + " at " + SEL.bbox.x + "," + SEL.bbox.y : FLOAT.cv ? "floating " + FLOAT.cv.width + "x" + FLOAT.cv.height : "";
    li.textContent = (L() ? L().name : "") + (CELL.focus ? "  cell " + CELL.focus.cx + "," + CELL.focus.cy : "");
    const look = $("pixel-look");
    if (look) {
      const sel = !!SEL.bbox;
      look.querySelector(".lbl").textContent = sel ? "Ask about selection" : "Ask about this";
      look.title = "Send " + (selHint() || "this") + " to Claude with the crop attached";
    }
  }

  // ---- keyboard: only while the Pixel tab is visible and no field has focus ----
  document.addEventListener("keydown", (e) => {
    if ($("pixel-pane").hidden) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (UI.isOpen() || !$("modal-host").hidden) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod) {
      if (k === "s") { stop(); save(); }
      else if (k === "z") { stop(); if (e.shiftKey) redo(); else undo(); }
      else if (k === "y") { stop(); redo(); }
      else if (k === "a") { stop(); selectAll(); }
      else if (k === "d") { stop(); deselect(); }
      else if (k === "i" && e.shiftKey) { stop(); invertSelection(); }
      else if (k === "c") { stop(); copySel(false); }
      else if (k === "x") { stop(); copySel(true); }
      else if (k === "v") { /* paste event handles it */ }
      else if (k === "e") { stop(); mergeDown(); }
      else if (k === "n") { stop(); newImage(); }
      return;
    }
    if (e.altKey && e.key === "Backspace") { stop(); fillSelection(C.primary); return; }
    if (e.altKey) return;
    if (e.key === " ") { if (!P.space) { P.space = true; view.style.cursor = "grab"; } stop(); return; }
    if (e.key === "Enter") { if (FLOAT.cv) { stop(); commitFloat(); } return; }
    if (e.key === "Escape") { stop(); if (FLOAT.cv) cancelFloat(); else if (SEL.mask) deselect(); else if (CELL.focus) wholeSheet(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { stop(); clearSelection(); return; }
    if (e.key.startsWith("Arrow")) { stop(); const n = e.shiftKey ? 10 : 1; nudge(e.key === "ArrowLeft" ? -n : e.key === "ArrowRight" ? n : 0, e.key === "ArrowUp" ? -n : e.key === "ArrowDown" ? n : 0); return; }
    if (e.key === "PageUp") { stop(); stepCell(-1); return; }
    if (e.key === "PageDown") { stop(); stepCell(1); return; }
    if (e.key === "Tab") { stop(); toggleDock(); return; }
    const combo = (e.shiftKey ? "shift+" : "") + k;
    if (e.shiftKey && k === "h") { stop(); flipH(false); return; }
    if (e.shiftKey && k === "v") { stop(); flipV(false); return; }
    if (TOOL_BY_KEY[combo]) { stop(); setTool(TOOL_BY_KEY[combo]); return; }
    if (k === "x") { stop(); swapColors(); return; }
    if (k === "[") { T.size = Math.max(1, T.size - 1); saveTools(); syncOptions(); render(); return; }
    if (k === "]") { T.size = Math.min(64, T.size + 1); saveTools(); syncOptions(); render(); return; }
    if (k === "0") { fit(CELL.focus ? bounds() : null); render(); return; }
    if (k === "1") { V.zoom = 1; render(); return; }
    if (k === "=" || k === "+") { zoomAt(view.width / 2, view.height / 2, 1); render(); return; }
    if (k === "-") { zoomAt(view.width / 2, view.height / 2, -1); render(); return; }
    if (k === "n") { addLayer(); return; }
    if (k === ",") { stepCell(-1); return; }
    if (k === ".") { stepCell(1); return; }
  }, true);
  document.addEventListener("keyup", (e) => { if (e.key === " " && P.space) { P.space = false; view.style.cursor = T.tool === "hand" ? "grab" : "default"; } });
  window.addEventListener("resize", () => { if (!$("pixel-pane").hidden) render(); });
  window.addEventListener("beforeunload", (e) => { if (D.dirty) e.preventDefault(); });
  $("pixel-save").addEventListener("click", save);
  $("pixel-ask").addEventListener("click", () => askClaude(false));
  $("pixel-look").addEventListener("click", askSelection);
  window.addEventListener("nexus-project", () => { loadCustom(); renderPalette(); });

  // ---- boot ----
  buildToolStrip(); buildMenuBar(); buildColorDock(); buildLayersDock(); buildFramesDock();
  showDock(V.dockTab || "color");
  $("px-dock").classList.toggle("collapsed", !V.dock);
  setTool(TOOLS.some((t) => t.id === T.tool) ? T.tool : "pencil");
  setColor("primary", C.primary); setColor("secondary", C.secondary);
  I.mount($("pixel-pane"));

  // tabs.js, app.js and the test harness drive these.
  window.NexusPixel = {
    open, save, setCell, focusCell, wholeSheet, setTool, undo, redo, selectAll, deselect, addLayer, newImage,
    showChanges: toggleDiff, askClaude,
    setColor: (which, c) => setColor(which, c),
    fillSelection: () => fillSelection(C.primary),
    onShow() { resize(); render(); },
    isDirty: () => D.dirty, isLoaded: () => D.loaded, currentPath: () => D.path, getTool: () => T.tool,
    discard: () => { D.dirty = false; },
    pixel: (x, y) => { const d = compose().getContext("2d").getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]]; },
    state: () => ({ w: D.w, h: D.h, layers: D.layers.length, active: D.active, dirty: D.dirty, zoom: V.zoom, panX: V.panX, panY: V.panY, sel: SEL.bbox, cell: { w: CELL.w, h: CELL.h, focus: CELL.focus }, undo: H.undo.length }),
  };
})();
