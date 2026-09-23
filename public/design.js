// The Design tab: the editor for art that is not pixel art.
//
// The document IS a live <svg> element in this page. There is no parallel model
// beside it, and that is the whole design: the browser does the rendering, the
// text layout and the hit-testing, and a file opened here and saved again
// cannot lose anything this editor does not happen to understand - a filter, a
// gradient, a <use> - because those elements were never taken apart.
//
// Grep `const GEO` for the geometry registry (add a shape = append one row),
// `const TOOLS` for the toolbar, `const PROPS` for the property rows,
// `function open(` / `async function save(` for the file ends, and
// `window.NexusDesign` for what the rest of the app can call.
//
// It only ever opens and saves .svg, for the same reason the Pixel tab is
// .png-only: saving would silently change the file's format.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.NexusUI, I = window.NexusIcons;
  const stage = $("dz-stage"), host = $("dz-canvas"), hint = $("dz-hint");
  const propsEl = $("dz-props"), layersEl = $("dz-layers"), statusEl = $("dz-status"), fileEl = $("dz-file");
  const SVGNS = "http://www.w3.org/2000/svg";

  const D = { svg: null, path: null, label: "", dirty: false, loaded: false, w: 0, h: 0 };
  const V = { zoom: 2, snap: true, needsFit: false };
  const T = { tool: "select", fill: "#7aa2f7", stroke: "none", sw: 2 };
  const SEL = { els: [] };
  const H = { undo: [], redo: [], MAX: 80 };
  let overlay = null, drag = null, draft = null;

  const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const setStatus = (msg, bad) => { statusEl.textContent = msg || ""; statusEl.classList.toggle("bad", !!bad); if (msg && !bad) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 2500); };

  // ---- geometry registry: add a shape = append one row ----------------------
  // box() gives [x, y, w, h] in user units; set() puts it back. A tag with no
  // row here still works - it falls back to a transform, which moves and scales
  // anything at all, including a <g> or a <path>.
  const GEO = {
    rect: {
      box: (e) => [num(e.getAttribute("x")), num(e.getAttribute("y")), num(e.getAttribute("width")), num(e.getAttribute("height"))],
      set: (e, x, y, w, h) => { e.setAttribute("x", r2(x)); e.setAttribute("y", r2(y)); e.setAttribute("width", r2(Math.max(0, w))); e.setAttribute("height", r2(Math.max(0, h))); },
      make: (x, y) => mk("rect", { x, y, width: 0, height: 0 }),
    },
    image: {
      box: (e) => [num(e.getAttribute("x")), num(e.getAttribute("y")), num(e.getAttribute("width")), num(e.getAttribute("height"))],
      set: (e, x, y, w, h) => { e.setAttribute("x", r2(x)); e.setAttribute("y", r2(y)); e.setAttribute("width", r2(Math.max(0, w))); e.setAttribute("height", r2(Math.max(0, h))); },
    },
    ellipse: {
      box: (e) => [num(e.getAttribute("cx")) - num(e.getAttribute("rx")), num(e.getAttribute("cy")) - num(e.getAttribute("ry")), num(e.getAttribute("rx")) * 2, num(e.getAttribute("ry")) * 2],
      set: (e, x, y, w, h) => { e.setAttribute("cx", r2(x + w / 2)); e.setAttribute("cy", r2(y + h / 2)); e.setAttribute("rx", r2(Math.max(0, w / 2))); e.setAttribute("ry", r2(Math.max(0, h / 2))); },
      make: (x, y) => mk("ellipse", { cx: x, cy: y, rx: 0, ry: 0 }),
    },
    circle: {
      box: (e) => [num(e.getAttribute("cx")) - num(e.getAttribute("r")), num(e.getAttribute("cy")) - num(e.getAttribute("r")), num(e.getAttribute("r")) * 2, num(e.getAttribute("r")) * 2],
      // A circle resized to a non-square box has to become an ellipse, or the
      // handle would lie about what it does.
      set: (e, x, y, w, h) => {
        if (Math.abs(w - h) < 0.51) { e.setAttribute("cx", r2(x + w / 2)); e.setAttribute("cy", r2(y + h / 2)); e.setAttribute("r", r2(Math.max(0, w / 2))); return; }
        const el = mk("ellipse", {});
        for (const a of e.attributes) if (!["cx", "cy", "r"].includes(a.name)) el.setAttribute(a.name, a.value);
        GEO.ellipse.set(el, x, y, w, h);
        e.replaceWith(el);
        SEL.els = SEL.els.map((s) => (s === e ? el : s));
      },
    },
    line: {
      box: (e) => { const x1 = num(e.getAttribute("x1")), y1 = num(e.getAttribute("y1")), x2 = num(e.getAttribute("x2")), y2 = num(e.getAttribute("y2")); return [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)]; },
      set: (e, x, y, w, h) => { e.setAttribute("x1", r2(x)); e.setAttribute("y1", r2(y)); e.setAttribute("x2", r2(x + w)); e.setAttribute("y2", r2(y + h)); },
      make: (x, y) => mk("line", { x1: x, y1: y, x2: x, y2: y }),
    },
    text: {
      box: (e) => { const b = e.getBBox(); return [b.x, b.y, b.width, b.height]; },
      set: (e, x, y, w, h, was) => { e.setAttribute("x", r2(num(e.getAttribute("x")) + (x - was[0]))); e.setAttribute("y", r2(num(e.getAttribute("y")) + (y - was[1]))); },
      make: (x, y) => mk("text", { x, y: y + 16, "font-size": 16, "font-family": "sans-serif" }),
    },
  };
  const r2 = (n) => Math.round(n * 100) / 100;
  function mk(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  }
  // Anything without a GEO row: read its rendered box, write a transform. Works
  // on a <path>, a <polygon>, a <g>, a <use> - on everything.
  const fallbackGeo = {
    box: (e) => { try { const b = e.getBBox(); return [b.x, b.y, b.width, b.height]; } catch { return [0, 0, 0, 0]; } },
    set: (e, x, y, w, h, was) => {
      const sx = was[2] ? w / was[2] : 1, sy = was[3] ? h / was[3] : 1;
      const base = (e.dataset.nxBase !== undefined ? e.dataset.nxBase : (e.getAttribute("transform") || ""));
      e.dataset.nxBase = base;
      const tx = x - was[0] * sx, ty = y - was[1] * sy;
      const t = (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6)
        ? "translate(" + r2(tx) + " " + r2(ty) + ") scale(" + r2(sx) + " " + r2(sy) + ")"
        : "translate(" + r2(x - was[0]) + " " + r2(y - was[1]) + ")";
      e.setAttribute("transform", (t + " " + base).trim());
    },
  };
  const geo = (e) => GEO[e.tagName.toLowerCase()] || fallbackGeo;
  const boxOf = (e) => { try { return geo(e).box(e); } catch { return fallbackGeo.box(e); } };
  function setBox(e, x, y, w, h) {
    const was = boxOf(e);
    const g = geo(e);
    // A shape whose row cannot resize (text) is moved; everything else is set.
    try { g.set(e, x, y, w, h, was); } catch { fallbackGeo.set(e, x, y, w, h, was); }
  }
  // ---- undo: whole-document snapshots ---------------------------------------
  // An SVG here is a few KB, so a snapshot per edit is cheaper than tracking
  // per-attribute deltas and cannot drift out of step with the document.
  function snap() {
    if (!D.svg) return;
    H.undo.push(D.svg.innerHTML);
    if (H.undo.length > H.MAX) H.undo.shift();
    H.redo.length = 0;
    D.dirty = true;
    syncBar();
  }
  function restore(from, to) {
    if (!D.svg || !from.length) return;
    to.push(D.svg.innerHTML);
    D.svg.innerHTML = from.pop();
    SEL.els = [];
    D.dirty = true;
    render();
  }
  const undo = () => restore(H.undo, H.redo);
  const redo = () => restore(H.redo, H.undo);

  // ---- tools -----------------------------------------------------------------
  const TOOLS = [
    { id: "select", icon: "move", title: "Select and move (V)", key: "v" },
    { id: "rect", icon: "rect", title: "Rectangle (R)", key: "r" },
    { id: "ellipse", icon: "circle", title: "Ellipse (E)", key: "e" },
    { id: "line", icon: "line", title: "Line (L)", key: "l" },
    { id: "polyline", icon: "wand", title: "Pen - click points, Enter or double-click to finish (P)", key: "p" },
    { id: "text", icon: "text", title: "Text (T)", key: "t" },
    { id: "pick", icon: "pipette", title: "Pick a colour from a shape (I)", key: "i" },
  ];
  function renderTools() {
    const box = $("dz-tools");
    box.innerHTML = "";
    for (const t of TOOLS) {
      const b = document.createElement("button");
      b.className = "dz-tool" + (T.tool === t.id ? " active" : "");
      b.title = t.title;
      b.innerHTML = I.svg(t.icon, 15);
      b.addEventListener("click", () => setTool(t.id));
      box.appendChild(b);
    }
  }
  function setTool(id) { finishDraft(); T.tool = id; renderTools(); }

  // ---- the document ----------------------------------------------------------
  function mount(svg) {
    host.innerHTML = "";
    D.svg = svg;
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    D.w = vb.length === 4 && vb[2] ? vb[2] : num(svg.getAttribute("width"), 256);
    D.h = vb.length === 4 && vb[3] ? vb[3] : num(svg.getAttribute("height"), 256);
    if (!svg.getAttribute("viewBox")) svg.setAttribute("viewBox", "0 0 " + D.w + " " + D.h);
    host.appendChild(svg);
    overlay = document.createElement("div");
    overlay.id = "dz-overlay";
    host.appendChild(overlay);
    D.loaded = true;
    hint.hidden = true;
    H.undo.length = 0; H.redo.length = 0;
    SEL.els = [];
    applyZoom();
    render();
  }
  function applyZoom() {
    if (!D.svg) return;
    const w = Math.round(D.w * V.zoom), h = Math.round(D.h * V.zoom);
    D.svg.setAttribute("width", w);
    D.svg.setAttribute("height", h);
    overlay.style.width = w + "px";
    overlay.style.height = h + "px";
    $("dz-zoom").textContent = Math.round(V.zoom * 100) + "%";
    $("dz-size").textContent = D.w + " x " + D.h;
  }
  // A fit computed while the pane is still hidden or unlaid-out reads a stage of
  // zero size and clamps to the minimum zoom, which is how a drawing ends up six
  // pixels wide. Wait for a real size instead of guessing at one.
  function fit(tries) {
    if (!D.svg) return;
    const pad = 40;
    if (stage.clientWidth < pad + 10 || stage.clientHeight < pad + 10) {
      V.needsFit = true;
      if ((tries || 0) < 20) requestAnimationFrame(() => fit((tries || 0) + 1));
      return;
    }
    V.needsFit = false;
    V.zoom = Math.max(0.05, Math.min(32, Math.min((stage.clientWidth - pad) / D.w, (stage.clientHeight - pad) / D.h)));
    applyZoom(); render();
  }
  // Every shape that can be selected: the svg's own element children, one level
  // deep. A <g> is selected and moved whole rather than picked apart.
  const shapes = () => (D.svg ? [...D.svg.children].filter((e) => !["defs", "title", "desc", "metadata", "style"].includes(e.tagName.toLowerCase())) : []);

  function render() {
    renderOverlay();
    renderProps();
    renderLayers();
    syncBar();
  }
  function syncBar() {
    $("dz-save").disabled = !D.loaded;
    $("dz-png").disabled = !D.loaded;
    fileEl.textContent = D.label ? D.label + (D.dirty ? " *" : "") : "";
    $("dz-selinfo").textContent = SEL.els.length ? SEL.els.length + " selected" : "";
  }

  const HANDLES = [["nw", 0, 0], ["n", .5, 0], ["ne", 1, 0], ["e", 1, .5], ["se", 1, 1], ["s", .5, 1], ["sw", 0, 1], ["w", 0, .5]];
  function renderOverlay() {
    if (!overlay) return;
    overlay.innerHTML = "";
    for (const e of SEL.els) {
      const [x, y, w, h] = boxOf(e);
      const b = document.createElement("div");
      b.className = "dz-box";
      b.style.left = x * V.zoom + "px"; b.style.top = y * V.zoom + "px";
      b.style.width = w * V.zoom + "px"; b.style.height = h * V.zoom + "px";
      overlay.appendChild(b);
    }
    if (SEL.els.length !== 1) return;
    const [x, y, w, h] = boxOf(SEL.els[0]);
    for (const [name, fx, fy] of HANDLES) {
      const d = document.createElement("div");
      d.className = "dz-h"; d.dataset.h = name;
      d.style.left = (x + w * fx) * V.zoom + "px";
      d.style.top = (y + h * fy) * V.zoom + "px";
      d.style.cursor = (name.length === 2 ? name : name === "n" || name === "s" ? "ns" : "ew") + "-resize";
      overlay.appendChild(d);
    }
  }
  function renderLayers() {
    layersEl.innerHTML = "";
    const list = shapes();
    if (!list.length) { layersEl.innerHTML = '<div class="dz-empty">Nothing drawn yet.</div>'; return; }
    // Topmost first, because that is the order they are painted in reverse.
    for (const e of [...list].reverse()) {
      const row = document.createElement("div");
      row.className = "dz-layer" + (SEL.els.includes(e) ? " sel" : "");
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = e.getAttribute("fill") || e.style.fill || "transparent";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.tagName.toLowerCase() === "text" ? '  "' + (e.textContent || "").slice(0, 14) + '"' : "");
      const up = document.createElement("button"); up.className = "ibtn sm"; up.title = "Bring forward"; up.innerHTML = I.svg("chevronUp", 11);
      up.addEventListener("click", (ev) => { ev.stopPropagation(); if (e.nextElementSibling) { snap(); e.parentNode.insertBefore(e.nextElementSibling, e); render(); } });
      const dn = document.createElement("button"); dn.className = "ibtn sm"; dn.title = "Send backward"; dn.innerHTML = I.svg("chevronDown", 11);
      dn.addEventListener("click", (ev) => { ev.stopPropagation(); if (e.previousElementSibling) { snap(); e.parentNode.insertBefore(e, e.previousElementSibling); render(); } });
      row.append(sw, nm, up, dn);
      row.addEventListener("click", () => { SEL.els = [e]; render(); });
      layersEl.appendChild(row);
    }
  }
  // ---- property rows: add a property = append one row ------------------------
  // `on` decides which shapes show the row; null means all of them.
  const PROPS = [
    { group: "Paint", key: "fill", label: "Fill", type: "color", on: null },
    { group: "Paint", key: "stroke", label: "Stroke", type: "color", on: null },
    { group: "Paint", key: "stroke-width", label: "Width", type: "num", on: null },
    { group: "Paint", key: "opacity", label: "Opacity", type: "num", on: null },
    { group: "Paint", key: "stroke-linecap", label: "Cap", type: "select", options: ["", "butt", "round", "square"], on: null },
    { group: "Shape", key: "rx", label: "Radius", type: "num", on: ["rect"] },
    { group: "Type", key: "font-size", label: "Size", type: "num", on: ["text"] },
    { group: "Type", key: "font-family", label: "Family", type: "text", on: ["text"] },
    { group: "Type", key: "font-weight", label: "Weight", type: "select", options: ["", "400", "500", "600", "700", "800"], on: ["text"] },
    { group: "Type", key: "text-anchor", label: "Anchor", type: "select", options: ["", "start", "middle", "end"], on: ["text"] },
  ];
  const attrOf = (e, k) => e.style.getPropertyValue(k) || e.getAttribute(k) || "";
  function setAttrOn(e, k, v) {
    if (v === "" || v == null) { e.removeAttribute(k); e.style.removeProperty(k); }
    else { e.setAttribute(k, v); if (e.style.getPropertyValue(k)) e.style.setProperty(k, v); }
  }

  function renderProps() {
    propsEl.innerHTML = "";
    if (!D.loaded) { propsEl.innerHTML = '<div class="dz-empty">Open an .svg, or File &rsaquo; New.</div>'; return; }
    if (!SEL.els.length) {
      propsEl.appendChild(group("Document"));
      numRow(propsEl, "Width", D.w, (v) => { D.w = Math.max(1, v | 0); D.svg.setAttribute("viewBox", "0 0 " + D.w + " " + D.h); snap(); applyZoom(); render(); });
      numRow(propsEl, "Height", D.h, (v) => { D.h = Math.max(1, v | 0); D.svg.setAttribute("viewBox", "0 0 " + D.w + " " + D.h); snap(); applyZoom(); render(); });
      propsEl.appendChild(group("Defaults for new shapes"));
      const fr = row(propsEl, "Fill"); UI.colorField(fr, { value: T.fill, onChange: (v) => { T.fill = v; } });
      const sr = row(propsEl, "Stroke"); UI.colorField(sr, { value: T.stroke, onChange: (v) => { T.stroke = v; } });
      numRow(propsEl, "Width", T.sw, (v) => { T.sw = v; });
      const hintRow = document.createElement("div");
      hintRow.className = "dz-empty";
      hintRow.textContent = "Click a shape on the canvas, or a row in the layer list below.";
      propsEl.appendChild(hintRow);
      return;
    }
    const e = SEL.els[0];
    const tag = e.tagName.toLowerCase();
    const head = document.createElement("div");
    head.className = "dz-empty";
    head.style.padding = "0 0 4px";
    head.innerHTML = "<b>" + UI.esc(tag) + "</b>" + (SEL.els.length > 1 ? " and " + (SEL.els.length - 1) + " more" : "");
    propsEl.appendChild(head);

    let g = null;
    for (const p of PROPS) {
      if (p.on && !p.on.includes(tag)) continue;
      if (p.group !== g) { g = p.group; propsEl.appendChild(group(g)); }
      const r = row(propsEl, p.label);
      const cur = attrOf(e, p.key);
      if (p.type === "color") {
        UI.colorField(r, { value: cur || (p.key === "fill" ? "#000000" : "transparent"), onChange: (v, live) => { for (const el of SEL.els) setAttrOn(el, p.key, v === "transparent" ? "none" : v); if (!live) { snap(); renderLayers(); } } });
      } else if (p.type === "select") {
        const s = document.createElement("select");
        for (const o of p.options) { const oe = document.createElement("option"); oe.value = o; oe.textContent = o || "(default)"; s.appendChild(oe); }
        s.value = p.options.includes(cur) ? cur : "";
        s.addEventListener("change", () => { for (const el of SEL.els) setAttrOn(el, p.key, s.value); snap(); });
        r.appendChild(s);
      } else {
        const i = document.createElement("input");
        i.type = p.type === "num" ? "number" : "text";
        i.step = "any"; i.value = cur;
        i.addEventListener("change", () => { for (const el of SEL.els) setAttrOn(el, p.key, i.value); snap(); render(); });
        r.appendChild(i);
      }
    }
    if (tag === "text") {
      propsEl.appendChild(group("Content"));
      const r = row(propsEl, "Text");
      const i = document.createElement("input"); i.type = "text"; i.value = e.textContent;
      i.addEventListener("input", () => { e.textContent = i.value; renderOverlay(); });
      i.addEventListener("change", () => { snap(); renderLayers(); });
      r.appendChild(i);
    }
    propsEl.appendChild(group("Position and size"));
    const [bx, by, bw, bh] = boxOf(e);
    numRow(propsEl, "X", r2(bx), (v) => { const b = boxOf(e); snap(); setBox(e, v, b[1], b[2], b[3]); render(); });
    numRow(propsEl, "Y", r2(by), (v) => { const b = boxOf(e); snap(); setBox(e, b[0], v, b[2], b[3]); render(); });
    numRow(propsEl, "W", r2(bw), (v) => { const b = boxOf(e); snap(); setBox(e, b[0], b[1], v, b[3]); render(); });
    numRow(propsEl, "H", r2(bh), (v) => { const b = boxOf(e); snap(); setBox(e, b[0], b[1], b[2], v); render(); });

    const btns = document.createElement("div");
    btns.className = "sc-btns";
    const mkb = (icon, text, fn) => { const b = document.createElement("button"); b.className = "btn sm"; b.innerHTML = I.svg(icon, 13) + UI.esc(text); b.addEventListener("click", fn); btns.appendChild(b); };
    mkb("copy", "Duplicate", () => { snap(); for (const el of SEL.els) { const c = el.cloneNode(true); const b = boxOf(el); D.svg.appendChild(c); setBox(c, b[0] + 8, b[1] + 8, b[2], b[3]); } render(); });
    mkb("trash", "Delete", () => { snap(); for (const el of SEL.els) el.remove(); SEL.els = []; render(); });
    propsEl.appendChild(btns);
  }
  function group(t) { const d = document.createElement("div"); d.className = "dz-group"; d.textContent = t; return d; }
  function row(host2, label) {
    const r = document.createElement("div"); r.className = "dz-row";
    const l = document.createElement("label"); l.textContent = label;
    r.appendChild(l); host2.appendChild(r); return r;
  }
  function numRow(host2, label, value, onChange) {
    const r = row(host2, label);
    const i = document.createElement("input"); i.type = "number"; i.step = "any"; i.value = value;
    i.addEventListener("change", () => onChange(num(i.value)));
    r.appendChild(i);
  }

  // ---- pointer: draw, select, move, resize -----------------------------------
  const capture = (ev) => { try { if (ev.pointerId != null) stage.setPointerCapture(ev.pointerId); } catch {} };
  const toUser = (ev) => {
    const r = D.svg.getBoundingClientRect();
    let x = (ev.clientX - r.left) / V.zoom, y = (ev.clientY - r.top) / V.zoom;
    if (V.snap && !ev.altKey) { x = Math.round(x); y = Math.round(y); }
    return [x, y];
  };
  stage.addEventListener("pointerdown", (ev) => {
    if (!D.loaded || ev.button !== 0) return;
    const handle = ev.target.closest(".dz-h");
    if (handle && SEL.els.length === 1) {
      ev.preventDefault();
      snap();
      drag = { mode: "resize", h: handle.dataset.h, el: SEL.els[0], start: toUser(ev), box: boxOf(SEL.els[0]) };
      capture(ev);
      return;
    }
    // Whether the pointer is over the drawing is a question about WHERE it is,
    // not about which node the event happened to be dispatched on: the overlay
    // and its handles sit on top of the svg, so a target test answers wrong.
    const cr = D.svg.getBoundingClientRect();
    const inside = ev.clientX >= cr.left && ev.clientX <= cr.right && ev.clientY >= cr.top && ev.clientY <= cr.bottom;
    if (!inside) { if (T.tool === "select") { SEL.els = []; render(); } return; }
    const [x, y] = toUser(ev);
    if (T.tool === "select") {
      const el = pickAt(ev);
      if (!el) { SEL.els = []; render(); return; }
      if (ev.shiftKey) SEL.els = SEL.els.includes(el) ? SEL.els.filter((s) => s !== el) : [...SEL.els, el];
      else if (!SEL.els.includes(el)) SEL.els = [el];
      snap();
      drag = { mode: "move", start: [x, y], boxes: SEL.els.map((e) => boxOf(e)) };
      capture(ev);
      render();
      return;
    }
    if (T.tool === "pick") {
      const el = pickAt(ev);
      if (el) { T.fill = el.getAttribute("fill") || T.fill; setTool("select"); SEL.els = [el]; render(); }
      return;
    }
    if (T.tool === "text") {
      snap();
      const e = GEO.text.make(x, y);
      e.setAttribute("fill", T.fill);
      e.textContent = "Text";
      D.svg.appendChild(e);
      SEL.els = [e]; setTool("select"); render();
      return;
    }
    if (T.tool === "polyline") { penClick(x, y); return; }
    // rect / ellipse / line: drag out a new shape
    ev.preventDefault();
    snap();
    const e = (GEO[T.tool] && GEO[T.tool].make) ? GEO[T.tool].make(x, y) : GEO.rect.make(x, y);
    styleNew(e, T.tool);
    D.svg.appendChild(e);
    SEL.els = [e];
    drag = { mode: "create", el: e, start: [x, y] };
    capture(ev);
    render();
  });
  function styleNew(e, tool) {
    if (tool === "line") { e.setAttribute("stroke", T.stroke === "none" || T.stroke === "transparent" ? T.fill : T.stroke); e.setAttribute("stroke-width", T.sw); }
    else {
      e.setAttribute("fill", T.fill);
      if (T.stroke && T.stroke !== "none" && T.stroke !== "transparent") { e.setAttribute("stroke", T.stroke); e.setAttribute("stroke-width", T.sw); }
    }
  }
  // The topmost shape under the pointer, found with the browser's own hit test.
  function pickAt(ev) {
    const hits = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const h of hits) {
      if (h === D.svg || !D.svg.contains(h)) continue;
      let n = h;
      while (n && n.parentNode !== D.svg) n = n.parentNode;
      if (n && n.parentNode === D.svg) return n;
    }
    return null;
  }
  stage.addEventListener("pointermove", (ev) => {
    if (D.loaded) { const [x, y] = toUser(ev); $("dz-pos").textContent = Math.round(x) + ", " + Math.round(y); }
    if (!drag) return;
    const [x, y] = toUser(ev);
    if (drag.mode === "create") {
      const [sx, sy] = drag.start;
      setBox(drag.el, Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy));
      if (drag.el.tagName.toLowerCase() === "line") GEO.line.set(drag.el, sx, sy, x - sx, y - sy);
    } else if (drag.mode === "move") {
      const dx = x - drag.start[0], dy = y - drag.start[1];
      SEL.els.forEach((e, i) => { const b = drag.boxes[i]; setBox(e, b[0] + dx, b[1] + dy, b[2], b[3]); });
    } else if (drag.mode === "resize") {
      const [bx, by, bw, bh] = drag.box, m = drag.h;
      let nx = bx, ny = by, nw = bw, nh = bh;
      if (m.includes("e")) nw = Math.max(1, x - bx);
      if (m.includes("s")) nh = Math.max(1, y - by);
      if (m.includes("w")) { nx = Math.min(x, bx + bw - 1); nw = bx + bw - nx; }
      if (m.includes("n")) { ny = Math.min(y, by + bh - 1); nh = by + bh - ny; }
      if (ev.shiftKey && bw && bh) { const s = Math.max(nw / bw, nh / bh); nw = bw * s; nh = bh * s; }
      setBox(drag.el, nx, ny, nw, nh);
    }
    renderOverlay();
  });
  const endDrag = () => { if (!drag) return; const was = drag; drag = null; if (was.mode === "create") setTool("select"); render(); };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("wheel", (ev) => {
    if (!D.loaded) return;
    ev.preventDefault();
    V.zoom = Math.max(0.05, Math.min(32, V.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)));
    applyZoom(); renderOverlay();
  }, { passive: false });

  // ---- pen ------------------------------------------------------------------
  function penClick(x, y) {
    if (!draft) {
      snap();
      draft = mk("polyline", { points: x + "," + y, fill: "none", stroke: T.stroke === "none" || T.stroke === "transparent" ? T.fill : T.stroke, "stroke-width": T.sw });
      D.svg.appendChild(draft);
    } else {
      draft.setAttribute("points", draft.getAttribute("points") + " " + x + "," + y);
    }
    render();
  }
  function finishDraft() {
    if (!draft) return;
    const pts = draft.getAttribute("points").trim().split(/\s+/);
    if (pts.length < 2) draft.remove();
    else SEL.els = [draft];
    draft = null;
    render();
  }
  stage.addEventListener("dblclick", () => { if (draft) finishDraft(); });
  // ---- files -----------------------------------------------------------------
  // Only .svg is opened and only .svg is written, for the same reason the Pixel
  // tab is .png-only: saving would silently change the file's format.
  async function open(diskPath, label) {
    if (!/[.]svg$/i.test(diskPath)) { UI.toast("The Design tab only opens .svg files", "warn"); return; }
    if (D.dirty && !(await UI.confirm("This drawing has unsaved changes. Open " + (label || diskPath) + " anyway?", { okLabel: "Open" }))) return;
    let text;
    try {
      const r = await fetch("/api/file?path=" + encodeURIComponent(diskPath));
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (typeof j.content !== "string") throw new Error("that file is not readable as text");
      text = j.content;
    } catch (err) { UI.toast(err.message, "err"); return; }
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const bad = doc.querySelector("parsererror");
    const svg = doc.documentElement;
    if (bad || !svg || svg.tagName.toLowerCase() !== "svg") { UI.toast("That file is not valid SVG - open it in the Code tab", "err", 5000); return; }
    D.path = diskPath; D.label = label || diskPath.split(/[\\/]/).pop(); D.dirty = false;
    mount(document.importNode(svg, true));
    fit();
    setStatus("opened");
  }
  async function newDoc() {
    const v = await UI.modal({ title: "New drawing", fields: [
      { id: "name", label: "File name", value: "art.svg" },
      { id: "w", label: "Width", type: "number", value: 256, min: 1, max: 8192 },
      { id: "h", label: "Height", type: "number", value: 256, min: 1, max: 8192 },
    ], okLabel: "Create" });
    if (!v || !v.name.trim()) return;
    const proj = window.NexusApp && window.NexusApp.projectPath();
    if (!proj) { UI.toast("Pick a project first", "warn"); return; }
    const name = /[.]svg$/i.test(v.name) ? v.name.trim() : v.name.trim() + ".svg";
    const w = Math.max(1, v.w | 0), h = Math.max(1, v.h | 0);
    const svg = mk("svg", { xmlns: SVGNS, viewBox: "0 0 " + w + " " + h, width: w, height: h });
    D.w = w; D.h = h;
    D.path = proj + String.fromCharCode(92) + "assets" + String.fromCharCode(92) + name;
    D.label = name; D.dirty = true;
    mount(svg); fit();
    setStatus("new drawing - press Save to write it");
  }
  function serialize() {
    const out = D.svg.cloneNode(true);
    // Zoom lives on the element while editing; the file keeps its own size.
    out.setAttribute("width", D.w);
    out.setAttribute("height", D.h);
    out.setAttribute("viewBox", "0 0 " + D.w + " " + D.h);
    if (!out.getAttribute("xmlns")) out.setAttribute("xmlns", SVGNS);
    for (const e of out.querySelectorAll("[data-nx-base]")) e.removeAttribute("data-nx-base");
    return new XMLSerializer().serializeToString(out) + "\n";
  }
  async function save() {
    if (!D.loaded || !D.path) return;
    if (!D.dirty) { setStatus("no changes to save"); return; }
    try {
      const res = await fetch("/api/scene/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: D.path, content: serialize() }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "could not save");
      D.dirty = false;
      setStatus("saved" + (j.madeBak ? " (.bak made)" : ""));
      syncBar();
      if (window.NexusApp) window.NexusApp.refreshTree();
      window.dispatchEvent(new CustomEvent("nexus-files-changed", { detail: { paths: [D.path] } }));
    } catch (err) { setStatus(err.message, true); UI.toast(err.message, "err"); }
  }
  // Rasterise, so a vector asset can feed a canvas game that only loads images.
  async function exportPng() {
    if (!D.loaded || !D.path) return;
    const scale = await UI.prompt("Export PNG", { label: "Scale", value: "1" });
    if (scale === null) return;
    const s = Math.max(0.1, Math.min(16, parseFloat(scale) || 1));
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(serialize());
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("the browser could not render this SVG")); img.src = url; });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(D.w * s)); c.height = Math.max(1, Math.round(D.h * s));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dest = D.path.replace(/[.]svg$/i, "") + (s === 1 ? "" : "@" + s + "x") + ".png";
    let res = await fetch("/api/image?new=1&path=" + encodeURIComponent(dest), { method: "POST", body: blob });
    if (res.status === 409) {
      if (!(await UI.confirm(dest.split(/[\\/]/).pop() + " already exists. Overwrite it?", { okLabel: "Overwrite", danger: true }))) return;
      res = await fetch("/api/image?new=1&overwrite=1&path=" + encodeURIComponent(dest), { method: "POST", body: blob });
    }
    const j = await res.json();
    if (!res.ok) { UI.toast(j.error || "export failed", "err"); return; }
    UI.toast("Exported " + dest.split(/[\\/]/).pop() + " (" + c.width + "x" + c.height + ")", "ok", 4000);
    if (window.NexusApp) window.NexusApp.refreshTree();
  }
  function askClaude() {
    if (!window.NexusChat || !D.loaded) return;
    const list = shapes().slice(0, 40).map((e) => "  " + e.tagName.toLowerCase() + " " + boxOf(e).map(r2).join(",") + (e.getAttribute("fill") ? "  fill " + e.getAttribute("fill") : ""));
    window.NexusChat.ask([
      "I have " + (D.path || "a drawing") + " open in the Design tab (" + D.w + "x" + D.h + " SVG).",
      "",
      "It contains:",
      "```",
      ...list,
      shapes().length > 40 ? "  ...and " + (shapes().length - 40) + " more" : "",
      "```",
      "",
      "It is plain SVG text, so you can read and edit it directly with Read and Edit.",
      "Keep it valid SVG with an explicit viewBox, and do not add a build step.",
      "",
      "What I want: ",
    ].filter((x) => x !== "").join("\n"), false);
  }

  // ---- menus, keys, wiring ---------------------------------------------------
  const MENUS = {
    File: () => [
      { label: "New drawing...", icon: "filePlus", onClick: newDoc },
      { label: "Save", icon: "save", disabled: !D.loaded, onClick: save },
      { label: "Export PNG...", icon: "image", disabled: !D.loaded, onClick: exportPng },
    ],
    Edit: () => [
      { label: "Undo", icon: "undo", disabled: !H.undo.length, onClick: undo },
      { label: "Redo", icon: "redo", disabled: !H.redo.length, onClick: redo },
      { sep: true },
      { label: "Select all", disabled: !D.loaded, onClick: () => { SEL.els = shapes(); render(); } },
      { label: "Delete selection", icon: "trash", disabled: !SEL.els.length, onClick: () => { snap(); SEL.els.forEach((e) => e.remove()); SEL.els = []; render(); } },
    ],
    View: () => [
      { label: "Fit to window", icon: "fit", disabled: !D.loaded, onClick: fit },
      { label: "Zoom 100%", disabled: !D.loaded, onClick: () => { V.zoom = 1; applyZoom(); renderOverlay(); } },
      { label: (V.snap ? "Snap to whole units: on" : "Snap to whole units: off"), icon: "grid", onClick: () => { V.snap = !V.snap; } },
    ],
    Claude: () => [
      { label: "Ask about this drawing", icon: "sparkles", disabled: !D.loaded, onClick: askClaude },
    ],
  };
  function renderMenus() {
    const box = $("dz-menus");
    box.innerHTML = "";
    for (const name of Object.keys(MENUS)) {
      const b = document.createElement("button");
      b.className = "pxmenu";
      b.textContent = name;
      b.addEventListener("click", (e) => UI.popover(e.currentTarget, MENUS[name](), { width: 220 }));
      box.appendChild(b);
    }
  }

  window.addEventListener("keydown", (e) => {
    if (!window.NexusTabs || window.NexusTabs.current() !== "design") return;
    const typing = /input|textarea|select/i.test((e.target.tagName || "")) || e.target.isContentEditable;
    if (typing) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); save(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); SEL.els = shapes(); render(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "d" && SEL.els.length) { e.preventDefault(); snap(); for (const el of SEL.els) { const c = el.cloneNode(true); const b = boxOf(el); D.svg.appendChild(c); setBox(c, b[0] + 8, b[1] + 8, b[2], b[3]); } render(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "delete" || k === "backspace") { if (SEL.els.length) { e.preventDefault(); snap(); SEL.els.forEach((el) => el.remove()); SEL.els = []; render(); } return; }
    if (k === "escape") { if (draft) finishDraft(); else { SEL.els = []; render(); } return; }
    if (k === "enter" && draft) { finishDraft(); return; }
    if (k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright") {
      if (!SEL.els.length) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = (k === "arrowright" ? step : 0) - (k === "arrowleft" ? step : 0);
      const dy = (k === "arrowdown" ? step : 0) - (k === "arrowup" ? step : 0);
      snap();
      for (const el of SEL.els) { const b = boxOf(el); setBox(el, b[0] + dx, b[1] + dy, b[2], b[3]); }
      render();
      return;
    }
    const t = TOOLS.find((x) => x.key === k);
    if (t) setTool(t.id);
  });

  $("dz-save").addEventListener("click", save);
  $("dz-png").addEventListener("click", exportPng);
  $("dz-ask").addEventListener("click", askClaude);
  window.addEventListener("nexus-project", () => { if (!D.dirty) { D.loaded = false; D.svg = null; D.path = null; D.label = ""; host.innerHTML = ""; hint.hidden = false; render(); } });
  renderTools(); renderMenus(); render();

  window.NexusDesign = {
    open, save, newDoc, exportPng,
    onShow: () => { if (!D.loaded) return; if (V.needsFit) fit(); else { applyZoom(); render(); } },
    isDirty: () => D.dirty, isLoaded: () => D.loaded, currentPath: () => D.path,
    setTool, undo, redo,
    state: () => ({ w: D.w, h: D.h, shapes: shapes().length, selected: SEL.els.length, dirty: D.dirty, zoom: V.zoom, tool: T.tool, undo: H.undo.length }),
    svgText: () => (D.loaded ? serialize() : null),
  };
})();