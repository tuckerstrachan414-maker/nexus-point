// Scene mode: the running project in the Play tab, made clickable and editable.
//
// The preview iframe is served from this same origin, so the editor reads the
// live document directly - no script is injected into the game and the overlay
// (hover box, selection, handles) lives in THIS page, never in the project's
// DOM. What the DOM cannot say is where an element came from, so the HTML
// served under /preview/ carries data-nx="<char offset>" on each open tag and a
// <meta name="nexus-source"> naming the file. Elements built at runtime by JS
// have no stamp: the panel says so and hands the job to Claude rather than
// guessing at a source location.
//
// Writes go through /api/scene/edit, which splices the file surgically and
// leaves a .bak on its first write. Grep `function commit(` for that, `PROPS`
// for the property registry (add a property = append one row) and
// `window.NexusScene` for what the rest of the app can call.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.NexusUI, I = window.NexusIcons;
  const frame = $("preview-frame"), stage = $("preview-stage");
  const overlay = $("scene-overlay"), panel = $("scene-panel");
  const crumbs = $("scene-crumbs"), body = $("scene-body"), modeChip = $("scene-mode");
  const btnEdit = $("scene-edit"), btnFreeze = $("scene-freeze"), btnExit = $("scene-exit");
  const btnSave = $("scene-save"), btnRevert = $("scene-revert");
  const projSel = $("project-select");

  const S = {
    on: false, freeze: true,
    doc: null, win: null,
    file: null,        // the HTML file on disk the offsets index
    lines: null,       // that file's text, for turning an offset into a line
    el: null, hover: null,
    scope: "inline",   // "inline" or "rule:<n>"
    rules: [],         // matching CSS rules for the selection
    rafSaved: null,
    pend: [],          // unsaved edits: { el, prop, value, before, scope, rule }
    dragging: null,
    // canvas mode: only exists when the project publishes an adapter
    // (docs/NEXUS-SCENE-ADAPTER.md). Without one a canvas is one opaque
    // rectangle and there is nothing in it to click.
    adapter: null, objects: [], obj: null, designFile: null,
  };

  // ---- property registry: add a property = append one row -------------------
  const PROPS = [
    { group: "Fill and text", css: "background-color", label: "Fill", type: "color" },
    { group: "Fill and text", css: "color", label: "Text", type: "color" },
    { group: "Fill and text", css: "opacity", label: "Opacity", type: "text" },
    { group: "Type", css: "font-size", label: "Size", type: "text" },
    { group: "Type", css: "font-weight", label: "Weight", type: "select", options: ["", "300", "400", "500", "600", "700", "800", "900"] },
    { group: "Type", css: "font-family", label: "Family", type: "text" },
    { group: "Type", css: "text-align", label: "Align", type: "select", options: ["", "left", "center", "right", "justify"] },
    { group: "Type", css: "letter-spacing", label: "Tracking", type: "text" },
    { group: "Border", css: "border-color", label: "Colour", type: "color" },
    { group: "Border", css: "border-width", label: "Width", type: "text" },
    { group: "Border", css: "border-style", label: "Style", type: "select", options: ["", "none", "solid", "dashed", "dotted"] },
    { group: "Border", css: "border-radius", label: "Radius", type: "text" },
    { group: "Box", css: "width", label: "Width", type: "text" },
    { group: "Box", css: "height", label: "Height", type: "text" },
    { group: "Box", css: "padding", label: "Padding", type: "text" },
    { group: "Box", css: "margin", label: "Margin", type: "text" },
    { group: "Box", css: "gap", label: "Gap", type: "text" },
    { group: "Box", css: "display", label: "Display", type: "select", options: ["", "block", "inline-block", "flex", "grid", "none"] },
    { group: "Position", css: "transform", label: "Transform", type: "text" },
    { group: "Position", css: "z-index", label: "Z", type: "text" },
    { group: "Effects", css: "box-shadow", label: "Shadow", type: "text" },
    { group: "Effects", css: "filter", label: "Filter", type: "text" },
  ];

  // ---- helpers --------------------------------------------------------------
  const esc = (s) => UI.esc(String(s == null ? "" : s));
  const projectName = () => { const o = projSel.selectedOptions[0]; return o && o.value ? o.textContent : null; };

  function label(el) {
    if (!el || el.nodeType !== 1) return "";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    return s;
  }
  // A selector good enough to name the element to Claude. Not guaranteed unique -
  // it is read by a person, not queried.
  function cssPath(el) {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && out.length < 5; n = n.parentElement) {
      out.unshift(label(n));
      if (n.id) break;
    }
    return out.join(" > ");
  }
  function lineOf(offset) {
    if (!S.lines || offset == null) return null;
    let line = 1;
    for (let i = 0; i < offset && i < S.lines.length; i++) if (S.lines.charCodeAt(i) === 10) line++;
    return line;
  }
  const offsetOf = (el) => { const v = el && el.getAttribute && el.getAttribute("data-nx"); return v == null ? null : +v; };

  // ---- overlay --------------------------------------------------------------
  function syncOverlay() {
    overlay.style.left = frame.offsetLeft + "px";
    overlay.style.top = frame.offsetTop + "px";
    overlay.style.width = frame.offsetWidth + "px";
    overlay.style.height = frame.offsetHeight + "px";
  }
  function boxFor(el, cls) {
    const r = el.getBoundingClientRect();
    const d = document.createElement("div");
    d.className = "sc-box " + cls;
    d.style.left = r.left + "px"; d.style.top = r.top + "px";
    d.style.width = r.width + "px"; d.style.height = r.height + "px";
    return { node: d, rect: r };
  }
  const HANDLES = [["nw", 0, 0], ["n", .5, 0], ["ne", 1, 0], ["e", 1, .5], ["se", 1, 1], ["s", .5, 1], ["sw", 0, 1], ["w", 0, .5]];
  function paintOverlay() {
    if (!S.on) return;
    overlay.innerHTML = "";
    if (S.adapter) { readObjects(); paintObjects(); }
    if (S.hover && S.hover !== S.el && S.hover.isConnected) overlay.appendChild(boxFor(S.hover, "hover").node);
    if (!S.el || !S.el.isConnected) return;
    const { node, rect } = boxFor(S.el, "sel");
    overlay.appendChild(node);
    const tag = document.createElement("div");
    tag.className = "sc-tag";
    tag.textContent = label(S.el) + "  " + Math.round(rect.width) + "x" + Math.round(rect.height);
    tag.style.left = rect.left + "px";
    tag.style.top = Math.max(0, rect.top - 15) + "px";
    overlay.appendChild(tag);
    for (const [name, fx, fy] of HANDLES) {
      const h = document.createElement("div");
      h.className = "sc-handle";
      h.dataset.h = name;
      h.style.left = rect.left + rect.width * fx + "px";
      h.style.top = rect.top + rect.height * fy + "px";
      h.style.cursor = (name.length === 2 ? name : name === "n" || name === "s" ? "ns" : "ew") + "-resize";
      overlay.appendChild(h);
    }
  }

  // ---- entering and leaving -------------------------------------------------
  function reachDoc() {
    try {
      const d = frame.contentDocument, w = frame.contentWindow;
      if (!d || !d.body) return null;
      return { d, w };
    } catch { return null; }
  }
  async function enter() {
    const got = reachDoc();
    if (!got) { UI.toast("Press Play and let the project load first", "warn"); return; }
    S.doc = got.d; S.win = got.w; S.on = true;
    const meta = S.doc.querySelector('meta[name="nexus-source"]');
    S.file = meta ? meta.getAttribute("content") : null;
    S.lines = null;
    if (S.file) {
      try { const r = await fetch("/api/file?path=" + encodeURIComponent(S.file)); const j = await r.json(); S.lines = j.content || null; } catch {}
    }
    S.adapter = null; S.objects = []; S.obj = null; S.designFile = null;
    try { if (S.win.__NEXUS_SCENE__ && typeof S.win.__NEXUS_SCENE__.objects === "function") S.adapter = S.win.__NEXUS_SCENE__; } catch {}
    if (S.adapter) {
      S.designFile = (projSel.value || "") + String.fromCharCode(92) + "nexus-design.js";
      try { if (typeof S.adapter.pause === "function") S.adapter.pause(true); } catch {}
      readObjects();
    }
    modeChip.textContent = S.adapter ? "DOM + canvas" : "DOM";
    modeChip.title = S.adapter
      ? "This project publishes a scene adapter, so the objects drawn on its canvas are clickable too."
      : "DOM elements only. A canvas is one opaque rectangle - run /nexus-repair on this project to make the objects drawn in it clickable.";
    btnEdit.classList.add("active");
    btnFreeze.classList.toggle("active", S.freeze);
    panel.hidden = false; overlay.hidden = false;
    syncOverlay();
    bind(true);
    setFreeze(S.freeze);
    select(null);
  }
  function exit() {
    if (!S.on) return;
    bind(false);
    setFreeze(false);
    revert();
    try { if (S.adapter && typeof S.adapter.pause === "function") S.adapter.pause(false); } catch {}
    S.adapter = null; S.objects = []; S.obj = null;
    S.on = false; S.el = null; S.hover = null; S.doc = null; S.win = null;
    btnEdit.classList.remove("active");
    panel.hidden = true; overlay.hidden = true; overlay.innerHTML = "";
  }
  function toggle() { S.on ? exit() : enter(); }

  // Freezing swaps requestAnimationFrame for a no-op inside the iframe only, so
  // a HUD that repaints every frame cannot wipe a live preview mid-edit. It is
  // put back on exit, and a reload throws the patched window away anyway.
  function setFreeze(on) {
    if (!S.win) return;
    try {
      if (on && !S.rafSaved) {
        S.rafSaved = S.win.requestAnimationFrame;
        S.win.requestAnimationFrame = function () { return 0; };
      } else if (!on && S.rafSaved) {
        S.win.requestAnimationFrame = S.rafSaved;
        S.rafSaved = null;
      }
    } catch {}
  }

  // Capture phase and stopped dead: while editing, the game must not see a
  // single one of these events.
  const SWALLOW = ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup", "touchstart", "touchend"];
  function onSwallow(e) {
    e.preventDefault(); e.stopPropagation();
    if (e.type !== "click" && e.type !== "pointerdown") return;
    const t = e.target;
    if (!t || t.nodeType !== 1 || t === S.doc.documentElement) return;
    // On the adapter's canvas, what was clicked is an object the game drew -
    // selecting the <canvas> element itself would be useless.
    if (S.adapter && t === adapterCanvas()) {
      readObjects();
      const o = objectAt(e.clientX, e.clientY);
      if (o) { selectObject(o); return; }
    }
    S.obj = null;
    select(t);
  }
  function onMove(e) {
    if (S.dragging) return;
    const t = e.target;
    if (t && t.nodeType === 1 && t !== S.hover) { S.hover = t; paintOverlay(); }
  }
  function onScroll() { paintOverlay(); }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); S.obj = null; select(null); }
  }
  function bind(on) {
    if (!S.doc) return;
    const fn = on ? "addEventListener" : "removeEventListener";
    for (const t of SWALLOW) S.doc[fn](t, onSwallow, true);
    S.doc[fn]("mousemove", onMove, true);
    S.doc[fn]("scroll", onScroll, true);
    S.doc[fn]("keydown", onKey, true);
    if (S.win) S.win[fn]("resize", onScroll);
    window[on ? "addEventListener" : "removeEventListener"]("resize", onResize);
  }
  function onResize() { syncOverlay(); paintOverlay(); }
  // ---- which stylesheet rules reach this element ----------------------------
  // Only a rule from a real .css file can be patched: a rule inside a <style>
  // block lives in the HTML, where selector surgery is far less safe, so those
  // are listed but disabled and routed to Claude.
  function collectRules(el) {
    const out = [];
    const walk = (rules, sheet, at) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules, sheet, r.conditionText || (r.media && r.media.mediaText) || "at-rule"); continue; }
        if (!r.selectorText) continue;
        let hit = false;
        try { hit = el.matches(r.selectorText); } catch {}
        if (hit) out.push({ rule: r, href: sheet.href || null, at, selector: r.selectorText });
      }
    };
    for (const sheet of S.doc.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch { continue; }
      if (rules) walk(rules, sheet, null);
    }
    return out;
  }
  // The file a stylesheet href points at, resolved through the server so the
  // /preview/ fallbacks are honoured.
  const sheetPathCache = new Map();
  async function sheetPath(href) {
    if (!href) return null;
    if (sheetPathCache.has(href)) return sheetPathCache.get(href);
    let p = null;
    try { const j = await (await fetch("/api/scene/resolve?url=" + encodeURIComponent(href))).json(); p = j && j.path ? j : null; } catch {}
    sheetPathCache.set(href, p);
    return p;
  }

  // ---- selection ------------------------------------------------------------
  async function select(el) {
    S.el = el; S.hover = null; S.scope = "inline";
    S.rules = el ? collectRules(el) : [];
    for (const r of S.rules) r.disk = await sheetPath(r.href);
    paintOverlay();
    renderCrumbs();
    renderPanel();
  }
  function renderCrumbs() {
    crumbs.innerHTML = "";
    if (!S.el) return;
    const chain = [];
    for (let n = S.el; n && n.nodeType === 1 && n !== S.doc.documentElement; n = n.parentElement) chain.unshift(n);
    for (const n of chain.slice(-6)) {
      const b = document.createElement("button");
      b.className = "sc-crumb" + (n === S.el ? " cur" : "");
      b.textContent = label(n);
      b.title = cssPath(n);
      b.addEventListener("mouseenter", () => { S.hover = n; paintOverlay(); });
      b.addEventListener("mouseleave", () => { S.hover = null; paintOverlay(); });
      b.addEventListener("click", () => select(n));
      crumbs.appendChild(b);
    }
  }

  // ---- reading and writing one property -------------------------------------
  const activeRule = () => (S.scope.startsWith("rule:") ? S.rules[+S.scope.slice(5)] : null);
  function currentValue(css) {
    const r = activeRule();
    if (r) return r.rule.style.getPropertyValue(css) || "";
    return S.el.style.getPropertyValue(css) || "";
  }
  function computed(css) { try { return S.win.getComputedStyle(S.el).getPropertyValue(css).trim(); } catch { return ""; } }

  function apply(css, value) {
    const r = activeRule();
    const target = r ? r.rule.style : S.el.style;
    const key = (r ? "rule:" + r.selector + "|" + (r.disk ? r.disk.path : "") : "inline:" + offsetOf(S.el)) + "|" + css;
    let rec = S.pend.find((p) => p.key === key);
    if (!rec) {
      rec = { key, css, el: S.el, rule: r, before: target.getPropertyValue(css) || "" };
      S.pend.push(rec);
    }
    rec.value = value;
    try { if (value === "" || value == null) target.removeProperty(css); else target.setProperty(css, value); } catch {}
    paintOverlay();
    syncActions();
  }
  function revert() {
    for (let i = S.pend.length - 1; i >= 0; i--) {
      const p = S.pend[i];
      if (p.object) {
        if (p.object.props) p.object.props[p.prop] = p.before;
        try { S.adapter.set(p.object.id, p.prop, p.before); if (typeof S.adapter.redraw === "function") S.adapter.redraw(); } catch {}
        continue;
      }
      if (p.text) { try { p.el.textContent = p.before; } catch {} continue; }
      const target = p.rule ? p.rule.rule.style : p.el.style;
      try { if (p.before) target.setProperty(p.css, p.before); else target.removeProperty(p.css); } catch {}
    }
    S.pend = [];
    syncActions();
    paintOverlay();
    if (S.obj) renderObjectPanel();
    else if (S.el) renderPanel();
  }
  function syncActions() {
    const n = S.pend.length;
    btnSave.disabled = !n; btnRevert.disabled = !n;
    let pend = $("scene-pend");
    if (!pend) { pend = document.createElement("span"); pend.id = "scene-pend"; pend.className = "pend"; $("scene-actions").appendChild(pend); }
    pend.textContent = n ? n + " unsaved" : "";
  }

  // ---- the panel ------------------------------------------------------------
  function renderPanel() {
    body.innerHTML = "";
    if (!S.el) {
      body.innerHTML = '<div class="scene-hint">Click anything in the page to the left. Its source file, colours, size and text appear here; the breadcrumb above walks up to its parents.</div>';
      return;
    }
    const off = offsetOf(S.el);
    const src = document.createElement("div");
    src.className = "sc-src";
    if (off != null && S.file) {
      const ln = lineOf(off);
      src.innerHTML = "<b>" + esc(S.file.split("/").pop()) + "</b>" + (ln ? ":" + ln : "") + " &middot; " + esc(cssPath(S.el));
    } else {
      src.innerHTML = esc(cssPath(S.el));
    }
    body.appendChild(src);

    if (off == null) {
      const w = document.createElement("div");
      w.className = "sc-warn";
      w.textContent = "This element was built at runtime by the project's own JavaScript, so it is in no file to edit. " +
        "Changes here preview live and are lost on reload - use Ask Claude to make them stick.";
      body.appendChild(w);
    }

    // one scope control for every property below it
    const scopeRow = document.createElement("div");
    scopeRow.className = "sc-row";
    const sel = document.createElement("select");
    sel.className = "sc-scope";
    const opts = [["inline", off == null ? "This element (preview only)" : "This element (inline style)"]];
    S.rules.forEach((r, i) => {
      const where = r.disk && r.disk.path ? r.disk.rel : "a <style> block";
      const lbl = "All " + r.selector + "  -  " + where + (r.at ? "  (" + r.at + ")" : "");
      opts.push(["rule:" + i, lbl, !r.disk || !r.disk.path]);
    });
    for (const [v, t, dis] of opts) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t + (dis ? "  [Claude only]" : "");
      o.disabled = !!dis;
      sel.appendChild(o);
    }
    sel.value = S.scope;
    sel.addEventListener("change", () => { S.scope = sel.value; renderPanel(); });
    scopeRow.appendChild(sel);
    body.appendChild(scopeRow);

    // text, when the element holds text and nothing else
    const onlyText = S.el.children.length === 0 && (S.el.textContent || "").trim().length > 0;
    if (onlyText) {
      body.appendChild(groupLabel("Text"));
      const row = document.createElement("div");
      row.className = "sc-row";
      const lab = document.createElement("label"); lab.textContent = "Content";
      const inp = document.createElement("input"); inp.type = "text"; inp.value = S.el.textContent;
      inp.addEventListener("input", () => { S.el.textContent = inp.value; inp.classList.add("changed"); markText(inp.value); });
      row.append(lab, inp);
      body.appendChild(row);
    }

    let group = null;
    for (const p of PROPS) {
      if (p.group !== group) { group = p.group; body.appendChild(groupLabel(group)); }
      body.appendChild(propRow(p));
    }
    body.appendChild(actionButtons());
  }
  function groupLabel(t) { const d = document.createElement("div"); d.className = "sc-group"; d.textContent = t; return d; }

  function markText(value) {
    const off = offsetOf(S.el);
    if (off == null) return;
    const key = "text:" + off;
    let rec = S.pend.find((p) => p.key === key);
    if (!rec) { rec = { key, text: true, el: S.el, offset: off, tag: S.el.tagName.toLowerCase(), before: S.el.textContent }; S.pend.push(rec); }
    rec.value = value;
    syncActions();
  }

  function propRow(p) {
    const row = document.createElement("div");
    row.className = "sc-row";
    const lab = document.createElement("label");
    lab.textContent = p.label;
    lab.title = p.css;
    row.appendChild(lab);
    const own = currentValue(p.css);
    const shown = own || computed(p.css);
    if (p.type === "color") {
      const f = UI.colorField(row, { value: shown, onChange: (v, live) => { apply(p.css, v); if (!live) renderCrumbs(); } });
      if (own) f.el.classList.add("changed");
    } else if (p.type === "select") {
      const s = document.createElement("select");
      for (const o of p.options) { const e = document.createElement("option"); e.value = o; e.textContent = o || "(inherit)"; s.appendChild(e); }
      s.value = p.options.includes(shown) ? shown : "";
      s.addEventListener("change", () => { apply(p.css, s.value); s.classList.add("changed"); });
      row.appendChild(s);
    } else {
      const i = document.createElement("input");
      i.type = "text"; i.value = shown; i.placeholder = computed(p.css);
      if (own) i.classList.add("changed");
      i.addEventListener("change", () => { apply(p.css, i.value.trim()); i.classList.add("changed"); });
      row.appendChild(i);
    }
    return row;
  }

  // ---- canvas objects, via the project's adapter ----------------------------
  // Everything below only runs when the project published a __NEXUS_SCENE__.
  // See docs/NEXUS-SCENE-ADAPTER.md for the contract and /nexus-repair for the
  // command that writes one.
  function readObjects() {
    S.objects = [];
    if (!S.adapter) return;
    let list = [];
    try { list = S.adapter.objects() || []; } catch (e) { UI.toast("The scene adapter threw: " + e.message, "err", 6000); return; }
    const cv = adapterCanvas();
    if (!cv) return;
    const cr = cv.getBoundingClientRect();
    for (const o of list) {
      if (!o || o.x == null) continue;
      S.objects.push({ ...o, sx: cr.left + o.x, sy: cr.top + o.y, sw: o.w || 1, sh: o.h || 1 });
    }
  }
  function adapterCanvas() {
    try { const c = S.adapter.canvas && S.adapter.canvas(); return c && c.getBoundingClientRect ? c : S.doc.querySelector("canvas"); }
    catch { return S.doc.querySelector("canvas"); }
  }
  function objectAt(clientX, clientY) {
    if (!S.adapter) return null;
    try {
      if (typeof S.adapter.hitTest === "function") {
        const cr = adapterCanvas().getBoundingClientRect();
        const id = S.adapter.hitTest(clientX - cr.left, clientY - cr.top);
        if (id != null) return S.objects.find((o) => o.id === id) || null;
      }
    } catch {}
    // Smallest box wins, so a child drawn on top of its parent is reachable.
    let best = null;
    for (const o of S.objects) {
      if (clientX < o.sx || clientY < o.sy || clientX > o.sx + o.sw || clientY > o.sy + o.sh) continue;
      if (!best || o.sw * o.sh < best.sw * best.sh) best = o;
    }
    return best;
  }
  function paintObjects() {
    for (const o of S.objects) {
      const d = document.createElement("div");
      d.className = "sc-box obj" + (S.obj && o.id === S.obj.id ? " sel" : "");
      d.style.left = o.sx + "px"; d.style.top = o.sy + "px";
      d.style.width = o.sw + "px"; d.style.height = o.sh + "px";
      overlay.appendChild(d);
    }
    if (!S.obj) return;
    const tag = document.createElement("div");
    tag.className = "sc-tag";
    tag.textContent = S.obj.label || S.obj.id;
    tag.style.left = S.obj.sx + "px";
    tag.style.top = Math.max(0, S.obj.sy - 15) + "px";
    overlay.appendChild(tag);
  }
  function selectObject(o) {
    S.obj = o; S.el = null; S.hover = null;
    paintOverlay(); crumbs.innerHTML = "";
    renderObjectPanel();
  }
  // A value's shape decides its control: this is the whole type system, on
  // purpose - the adapter hands over plain data, not a schema to keep in sync.
  const looksLikeColour = (v) => typeof v === "string" && (/^#[0-9a-f]{3,8}$/i.test(v.trim()) || /^(rgb|hsl)a?\(/i.test(v.trim()));

  function renderObjectPanel() {
    body.innerHTML = "";
    const o = S.obj;
    const head = document.createElement("div");
    head.className = "sc-src";
    head.innerHTML = "<b>" + esc(o.label || o.id) + "</b>" + (o.kind ? " &middot; " + esc(o.kind) : "") +
      " &middot; " + Math.round(o.sw) + "x" + Math.round(o.sh);
    body.appendChild(head);

    const props = o.props || {};
    if (!Object.keys(props).length) {
      const w = document.createElement("div");
      w.className = "sc-warn";
      w.textContent = "The adapter lists this object but gives it no editable properties. Add them to its props in nexus-scene.js, or use Ask Claude.";
      body.appendChild(w);
    }
    body.appendChild(groupLabel("Properties"));
    for (const [k, v] of Object.entries(props)) {
      const row = document.createElement("div");
      row.className = "sc-row";
      const lab = document.createElement("label"); lab.textContent = k; lab.title = k;
      row.appendChild(lab);
      if (looksLikeColour(v)) {
        UI.colorField(row, { value: v, onChange: (val) => setObjProp(k, val) });
      } else {
        const i = document.createElement("input");
        i.type = "text"; i.value = v == null ? "" : String(v);
        i.addEventListener("change", () => {
          const raw = i.value.trim();
          setObjProp(k, typeof v === "number" && raw !== "" && !isNaN(+raw) ? +raw : raw);
          i.classList.add("changed");
        });
        row.appendChild(i);
      }
      body.appendChild(row);
    }
    body.appendChild(objectButtons());
  }
  function setObjProp(prop, value) {
    const o = S.obj;
    const key = "obj:" + o.id + "|" + prop;
    let rec = S.pend.find((p) => p.key === key);
    if (!rec) { rec = { key, object: o, prop, before: (o.props || {})[prop] }; S.pend.push(rec); }
    rec.value = value;
    if (o.props) o.props[prop] = value;
    try { S.adapter.set(o.id, prop, value); if (typeof S.adapter.redraw === "function") S.adapter.redraw(); } catch (e) { UI.toast("adapter set() threw: " + e.message, "err"); }
    syncActions();
  }
  function objectButtons() {
    const wrap = document.createElement("div");
    wrap.className = "sc-btns";
    const o = S.obj;
    const mk = (icon, text, fn, cls) => {
      const b = document.createElement("button");
      b.className = "btn sm" + (cls ? " " + cls : "");
      b.innerHTML = I.svg(icon, 13) + esc(text);
      b.addEventListener("click", fn);
      wrap.appendChild(b);
      return b;
    };
    if (o.asset) {
      mk("image", "Edit asset", async () => {
        const base = S.doc.baseURI;
        let u = o.asset;
        try { u = new URL(o.asset, base).href; } catch {}
        const j = await (await fetch("/api/scene/resolve?url=" + encodeURIComponent(u))).json();
        if (!j || !j.path || !j.exists) { UI.toast("The adapter names " + o.asset + ", but there is no such file in this project", "warn", 5000); return; }
        if (j.editor === "pixel") { window.NexusTabs.activate("pixel"); window.NexusPixel.open(j.path, j.rel); }
        else if (j.editor === "design" && window.NexusDesign) { window.NexusTabs.activate("design"); window.NexusDesign.open(j.path, j.rel); }
        else window.NexusApp.openFile(j.path);
      });
    }
    mk("sparkles", "Ask Claude", askClaudeObject, "accent");
    return wrap;
  }
  function askClaudeObject() {
    if (!window.NexusChat) return;
    const o = S.obj;
    const lines = ["In the Play tab I am pointing at this object on " + (projectName() || "the open project") + "'s canvas:", "", "```"];
    lines.push("id: " + o.id + (o.kind ? "   kind: " + o.kind : "") + (o.label ? "   label: " + o.label : ""));
    lines.push("on screen: " + Math.round(o.sw) + " x " + Math.round(o.sh));
    if (o.asset) lines.push("asset: " + o.asset);
    for (const [k, v] of Object.entries(o.props || {})) {
      let where = "";
      try { const s = S.adapter.source && S.adapter.source(o.id, k); if (s) where = "   <- " + (s.registry ? "nexus-design.js " + s.registry : s.file + " near `" + s.token + "`"); } catch {}
      lines.push(k + ": " + v + where);
    }
    lines.push("```", "", "What I want: ");
    window.NexusChat.ask(lines.join("\n"), false);
  }
  // ---- the three buttons under the properties -------------------------------
  // The asset behind a selection: an <img src>, a CSS background-image, or the
  // adapter's own asset field. Resolved through the server so the /preview/
  // fallbacks are honoured, then handed to whichever editor owns that file.
  function assetUrl(el) {
    if (el.tagName === "IMG" && el.src) return el.src;
    if (el.tagName === "IMAGE" && el.href && el.href.baseVal) return new URL(el.href.baseVal, S.doc.baseURI).href;
    const bg = computed("background-image");
    const m = /url\((['"]?)([^'")]+)\1\)/.exec(bg || "");
    if (m) { try { return new URL(m[2], S.doc.baseURI).href; } catch { return m[2]; } }
    return null;
  }
  function actionButtons() {
    const wrap = document.createElement("div");
    wrap.className = "sc-btns";
    const mk = (icon, text, title, fn, cls) => {
      const b = document.createElement("button");
      b.className = "btn sm" + (cls ? " " + cls : "");
      b.title = title; b.innerHTML = I.svg(icon, 13) + esc(text);
      b.addEventListener("click", fn);
      wrap.appendChild(b);
      return b;
    };
    const off = offsetOf(S.el);
    if (off != null && S.file) {
      mk("fileCode", "Open in Code", "Open this file at this element", () => {
        window.NexusApp.openFile(S.file.replaceAll("/", String.fromCharCode(92)), { line: lineOf(off) });
      });
    }
    const url = assetUrl(S.el);
    if (url) {
      const b = mk("image", "Edit asset", "Open the file this picture comes from", async () => {
        const j = await (await fetch("/api/scene/resolve?url=" + encodeURIComponent(url))).json();
        if (!j || !j.path || !j.exists) { UI.toast("That picture is not a file in this project", "warn"); return; }
        if (j.editor === "pixel") { window.NexusTabs.activate("pixel"); window.NexusPixel.open(j.path, j.rel); }
        else if (j.editor === "design" && window.NexusDesign) { window.NexusTabs.activate("design"); window.NexusDesign.open(j.path, j.rel); }
        else window.NexusApp.openFile(j.path);
      });
      b.title = "Open " + url.split("/").pop();
    }
    mk("sparkles", "Ask Claude", "Hand Claude this element with its source location and styles", askClaude, "accent");
    return wrap;
  }

  function askClaude() {
    if (!window.NexusChat || !S.el) return;
    const off = offsetOf(S.el);
    const changed = S.pend.filter((p) => p.el === S.el || p.rule);
    const lines = [];
    lines.push("In the Play tab I am pointing at this element of " + (projectName() || "the open project") + ":");
    lines.push("");
    lines.push("```");
    lines.push(cssPath(S.el));
    if (off != null && S.file) lines.push("source: " + S.file + " line " + lineOf(off));
    else lines.push("source: built at runtime by the project's own JavaScript - it is in no file, so you will have to find the code that creates it");
    const r = S.el.getBoundingClientRect();
    lines.push("on screen: " + Math.round(r.width) + " x " + Math.round(r.height) + " at " + Math.round(r.left) + "," + Math.round(r.top));
    for (const k of ["background-color", "color", "font-size", "font-family", "border-radius", "display", "padding"]) {
      const v = computed(k);
      if (v && v !== "none" && v !== "normal") lines.push(k + ": " + v);
    }
    lines.push("```");
    if (changed.length) {
      lines.push("");
      lines.push("I tried these values in the scene editor (previewed, not saved):");
      lines.push("");
      lines.push("```");
      for (const p of changed) lines.push((p.text ? "text" : p.css) + ": " + p.value + (p.rule ? "   (on the rule " + p.rule.selector + ")" : ""));
      lines.push("```");
    }
    lines.push("");
    lines.push("What I want: ");
    window.NexusChat.ask(lines.join("\n"), false);
  }

  // ---- drag and resize ------------------------------------------------------
  // Moving writes a transform, never left/top: a transform cannot disturb the
  // layout of anything else on the page, which left/top on an unpositioned
  // element quietly does.
  function currentTranslate(el) {
    const t = el.style.transform || "";
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(t);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
  }
  function setTranslate(dx, dy) {
    const base = (S.el.style.transform || "").replace(/translate\([^)]*\)\s*/g, "").trim();
    apply("transform", ("translate(" + Math.round(dx) + "px, " + Math.round(dy) + "px) " + base).trim());
  }
  overlay.addEventListener("pointerdown", (e) => {
    const h = e.target.closest(".sc-handle");
    if (!h || !S.el) return;
    e.preventDefault();
    const r = S.el.getBoundingClientRect();
    const [tx, ty] = currentTranslate(S.el);
    S.dragging = { mode: h.dataset.h, x0: e.clientX, y0: e.clientY, w0: r.width, h0: r.height, tx, ty };
    overlay.classList.add("dragging");
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!S.dragging || !S.el) return;
    const d = S.dragging, dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    const m = d.mode;
    if (m.includes("e")) apply("width", Math.max(1, Math.round(d.w0 + dx)) + "px");
    if (m.includes("s")) apply("height", Math.max(1, Math.round(d.h0 + dy)) + "px");
    if (m.includes("w")) { apply("width", Math.max(1, Math.round(d.w0 - dx)) + "px"); setTranslate(d.tx + dx, d.ty); }
    if (m.includes("n")) { apply("height", Math.max(1, Math.round(d.h0 - dy)) + "px"); setTranslate(d.tx, d.ty + dy); }
    paintOverlay();
  });
  const endDrag = () => { if (S.dragging) { S.dragging = null; overlay.classList.remove("dragging"); renderPanel(); } };
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  // ---- saving ---------------------------------------------------------------
  // One request for everything pending. The server splices highest offset first
  // and refuses the whole batch if any offset no longer holds the tag it was
  // told to expect, so a file that moved under us is never half-written.
  async function commit() {
    if (!S.pend.length) return;
    const edits = [];
    const inlineByOffset = new Map();
    const ruleByKey = new Map();
    const blocked = [];
    const regWrites = [];
    for (const p of S.pend) {
      if (p.object) {
        let where = null;
        try { where = S.adapter.source && S.adapter.source(p.object.id, p.prop); } catch {}
        if (where && where.registry && S.designFile) regWrites.push({ key: where.registry, value: p.value, prop: p.prop, id: p.object.id });
        else blocked.push(p.prop + " on " + (p.object.label || p.object.id) + (where && where.file ? " (lives in " + where.file + ")" : " (the adapter does not say where it lives)"));
        continue;
      }
      if (p.text) { edits.push({ op: "text", file: S.file, offset: p.offset, tag: p.tag, text: p.value }); continue; }
      if (p.rule) {
        const disk = p.rule.disk;
        if (!disk || !disk.path) { blocked.push(p.css + " on " + p.rule.selector + " (that rule is in a <style> block)"); continue; }
        const k = disk.path + "|" + p.rule.selector;
        if (!ruleByKey.has(k)) ruleByKey.set(k, { op: "css", file: disk.path, selector: p.rule.selector, props: {} });
        ruleByKey.get(k).props[p.css] = p.value;
        continue;
      }
      const off = offsetOf(p.el);
      if (off == null || !S.file) { blocked.push(p.css + " on " + label(p.el) + " (built at runtime, in no file)"); continue; }
      if (!inlineByOffset.has(off)) inlineByOffset.set(off, { op: "style", file: S.file, offset: off, tag: p.el.tagName.toLowerCase(), props: {} });
      inlineByOffset.get(off).props[p.css] = p.value;
    }
    edits.push(...inlineByOffset.values(), ...ruleByKey.values());
    // Registry values live in nexus-design.js, one surgical patch each.
    const regDone = [];
    for (const w of regWrites) {
      try {
        const rr = await fetch("/api/scene/registry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: S.designFile, key: w.key, value: w.value }) });
        const rj = await rr.json();
        if (!rr.ok) blocked.push(w.prop + " -> nexus-design.js " + w.key + ": " + (rj.error || rr.status));
        else regDone.push(w.key + (rj.madeBak ? " (.bak made)" : ""));
      } catch (err) { blocked.push(w.prop + ": " + err.message); }
    }
    if (regDone.length) UI.toast("nexus-design.js: " + regDone.join(", "), "ok", 4000);
    if (!edits.length) {
      if (!regDone.length) UI.toast("Nothing here can be written to a file - use Ask Claude", "warn", 4000);
      if (blocked.length) UI.toast("Not written: " + blocked.join("; ") + " - ask Claude for those", "warn", 8000);
      S.pend = S.pend.filter((p) => blocked.length && !p.object);
      if (regDone.length) S.pend = [];
      syncActions();
      if (regDone.length && window.NexusApp) window.NexusApp.refreshTree();
      return;
    }
    btnSave.disabled = true;
    let j;
    try {
      const res = await fetch("/api/scene/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edits }) });
      j = await res.json();
      if (!res.ok) { UI.toast(j.error || "could not save", "err", 6000); btnSave.disabled = false; return; }
    } catch (err) { UI.toast(err.message, "err"); btnSave.disabled = false; return; }
    const files = (j.written || []).map((w) => w.file.split(/[\\/]/).pop());
    const baks = (j.written || []).filter((w) => w.madeBak).length;
    UI.toast("Saved to " + files.join(", ") + (baks ? " (" + baks + " .bak made)" : ""), "ok", 4000);
    for (const n of j.notes || []) UI.toast(n, "warn", 7000);
    if (blocked.length) UI.toast("Not written: " + blocked.join("; ") + " - ask Claude for those", "warn", 8000);
    S.pend = [];
    syncActions();
    if (window.NexusApp) window.NexusApp.refreshTree();
    window.dispatchEvent(new CustomEvent("nexus-files-changed", { detail: { paths: (j.written || []).map((w) => w.file) } }));
  }

  // ---- wiring ---------------------------------------------------------------
  btnEdit.addEventListener("click", toggle);
  btnExit.addEventListener("click", exit);
  btnFreeze.addEventListener("click", () => { S.freeze = !S.freeze; btnFreeze.classList.toggle("active", S.freeze); setFreeze(S.freeze); });
  btnSave.addEventListener("click", commit);
  btnRevert.addEventListener("click", revert);
  // A reload throws away the document the editor was holding, so leave edit mode.
  frame.addEventListener("load", () => { if (S.on) { S.pend = []; exit(); } });
  window.addEventListener("nexus-tab", (e) => { if (e.detail !== "preview" && S.on) exit(); });
  window.addEventListener("nexus-project", () => { if (S.on) exit(); });

  window.NexusScene = { enter, exit, toggle, isOn: () => S.on, selected: () => S.el, pending: () => S.pend.length };
})();