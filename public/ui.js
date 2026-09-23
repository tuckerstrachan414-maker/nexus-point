// Shared UI primitives: popover menus, context menus, modal dialogs, toasts,
// panel resizers. Every pane uses these instead of alert/prompt/confirm so the
// whole app feels like one program. Menus are data: [{label, icon, sub, mk,
// checked, disabled, danger, onClick}] plus {sep:true} and {head:"Text"}.
(() => {
  const esc = (x) => String(x == null ? "" : x).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const pop = document.getElementById("popover");
  const ctx = document.getElementById("ctx-menu");
  let openEl = null;
  let onCloseCb = null;

  function buildMenu(host, items) {
    host.innerHTML = "";
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { const d = document.createElement("div"); d.className = "menu-sep"; host.appendChild(d); continue; }
      if (it.head) { const d = document.createElement("div"); d.className = "menu-head"; d.textContent = it.head; host.appendChild(d); continue; }
      if (it.el) { host.appendChild(it.el); continue; }
      const b = document.createElement("button");
      b.className = "menu-item" + (it.danger ? " danger" : "") + (it.checked ? " checked" : "");
      b.disabled = !!it.disabled;
      let html = "";
      if (it.checked !== undefined) html += '<span class="ico mark" style="width:14px">' + (it.checked ? NexusIcons.svg("check", 14) : "") + "</span>";
      if (it.icon) html += NexusIcons.svg(it.icon, 15);
      html += '<span class="lbl"><span>' + esc(it.label) + "</span>" + (it.sub ? '<span class="sub">' + esc(it.sub) + "</span>" : "") + "</span>";
      if (it.mk) html += '<span class="mk">' + esc(it.mk) + "</span>";
      b.innerHTML = html;
      b.addEventListener("click", (e) => { e.stopPropagation(); if (!it.keepOpen) close(); if (it.onClick) it.onClick(e); });
      host.appendChild(b);
    }
  }

  function place(host, x, y, anchor) {
    host.hidden = false;
    host.style.left = "0px"; host.style.top = "0px";
    const r = host.getBoundingClientRect();
    let left = x, top = y;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      left = a.left; top = a.bottom + 4;
      if (left + r.width > innerWidth - 8) left = Math.max(8, a.right - r.width);
      if (top + r.height > innerHeight - 8) top = Math.max(8, a.top - r.height - 4);
    } else {
      if (left + r.width > innerWidth - 8) left = Math.max(8, innerWidth - r.width - 8);
      if (top + r.height > innerHeight - 8) top = Math.max(8, innerHeight - r.height - 8);
    }
    host.style.left = left + "px"; host.style.top = top + "px";
  }

  function close() {
    if (!openEl) return;
    openEl.hidden = true; openEl.innerHTML = "";
    const cb = onCloseCb; onCloseCb = null; openEl = null;
    if (cb) cb();
  }

  // content may be an array of items, an element, or a function returning either.
  function show(host, content, x, y, anchor, opts) {
    close();
    const c = typeof content === "function" ? content() : content;
    if (Array.isArray(c)) buildMenu(host, c); else { host.innerHTML = ""; host.appendChild(c); }
    host.style.minWidth = opts && opts.width ? opts.width + "px" : "";
    place(host, x, y, anchor);
    openEl = host;
    onCloseCb = (opts && opts.onClose) || null;
    return host;
  }
  document.addEventListener("pointerdown", (e) => { if (openEl && !openEl.contains(e.target)) close(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openEl) { close(); e.stopPropagation(); } }, true);
  window.addEventListener("blur", close);

  // ---- toast ----
  const toastHost = document.getElementById("toast-host");
  function toast(text, kind, ms) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = text;
    toastHost.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .25s"; setTimeout(() => t.remove(), 260); }, ms || 3200);
  }

  // ---- resizer: drag a handle to size a panel; width persists ----
  function resizer(handle, panel, opts) {
    const key = "nexus-w-" + panel.id;
    const saved = +localStorage.getItem(key);
    if (saved) panel.style.width = saved + "px";
    let startX = 0, startW = 0;
    handle.addEventListener("pointerdown", (e) => {
      startX = e.clientX; startW = panel.getBoundingClientRect().width;
      handle.classList.add("active"); handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const w = Math.max(opts.min || 160, Math.min(opts.max || 900, opts.side === "right" ? startW - dx : startW + dx));
        panel.style.width = w + "px";
        window.dispatchEvent(new Event("resize"));
      };
      const up = () => { handle.classList.remove("active"); handle.removeEventListener("pointermove", move); localStorage.setItem(key, Math.round(panel.getBoundingClientRect().width)); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      e.preventDefault();
    });
  }

  // ---- modal ----
  const modalHost = document.getElementById("modal-host");
  function modal(spec) {
    return new Promise((resolve) => {
      modalHost.innerHTML = "";
      const m = document.createElement("div");
      m.className = "modal";
      let html = "<h3>" + esc(spec.title || "") + "</h3>";
      if (spec.text) html += "<p>" + esc(spec.text) + "</p>";
      if (spec.html) html += spec.html;
      if (spec.fields && spec.fields.length) {
        html += '<div class="fields">';
        for (const f of spec.fields) {
          html += "<label for='mf-" + esc(f.id) + "'>" + esc(f.label || f.id) + "</label>";
          if (f.type === "select") {
            html += "<select id='mf-" + esc(f.id) + "'>" + (f.options || []).map((o) => {
              const v = typeof o === "string" ? o : o.value, l = typeof o === "string" ? o : o.label;
              return "<option value='" + esc(v) + "'" + (v === f.value ? " selected" : "") + ">" + esc(l) + "</option>";
            }).join("") + "</select>";
          } else if (f.type === "textarea") {
            html += "<textarea id='mf-" + esc(f.id) + "' placeholder='" + esc(f.placeholder || "") + "'>" + esc(f.value || "") + "</textarea>";
          } else if (f.type === "checkbox") {
            html += "<input type='checkbox' id='mf-" + esc(f.id) + "'" + (f.value ? " checked" : "") + ">";
          } else {
            html += "<input type='" + esc(f.type || "text") + "' id='mf-" + esc(f.id) + "' value='" + esc(f.value == null ? "" : f.value) + "' placeholder='" + esc(f.placeholder || "") + "'" +
              (f.min != null ? " min='" + f.min + "'" : "") + (f.max != null ? " max='" + f.max + "'" : "") + (f.step != null ? " step='" + f.step + "'" : "") + " spellcheck='false'>";
          }
        }
        html += "</div>";
      }
      html += '<div class="actions"><button class="btn" data-act="cancel">' + esc(spec.cancelLabel || "Cancel") + "</button>" +
        '<button class="btn ' + (spec.danger ? "danger" : "primary") + '" data-act="ok">' + esc(spec.okLabel || "OK") + "</button></div>";
      m.innerHTML = html;
      modalHost.appendChild(m);
      modalHost.hidden = false;
      const done = (ok) => {
        let values = null;
        if (ok) {
          values = {};
          for (const f of spec.fields || []) {
            const el = m.querySelector("#mf-" + f.id);
            values[f.id] = f.type === "checkbox" ? el.checked : f.type === "number" ? Number(el.value) : el.value;
          }
        }
        modalHost.hidden = true; modalHost.innerHTML = "";
        document.removeEventListener("keydown", onKey, true);
        resolve(values);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === "Enter" && !(e.target && e.target.tagName === "TEXTAREA")) { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      document.addEventListener("keydown", onKey, true);
      m.querySelector('[data-act="ok"]').addEventListener("click", () => done(true));
      m.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
      modalHost.addEventListener("pointerdown", (e) => { if (e.target === modalHost) done(false); }, { once: true });
      const first = m.querySelector("input, textarea, select");
      if (first) { first.focus(); if (first.select && spec.selectAll !== false) first.select(); }
      else m.querySelector('[data-act="ok"]').focus();
    });
  }
  const confirm = (text, opts) => modal({ title: (opts && opts.title) || "Are you sure?", text, okLabel: (opts && opts.okLabel) || "Yes", danger: !!(opts && opts.danger) }).then((v) => !!v);
  const prompt = (title, opts) => modal({ title, fields: [{ id: "v", label: (opts && opts.label) || "", value: opts && opts.value, placeholder: opts && opts.placeholder }], okLabel: opts && opts.okLabel }).then((v) => (v ? v.v : null));

  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
  const fmtTok = (t) => (t >= 1e6 ? (t / 1e6).toFixed(1) + "M" : t >= 1000 ? (t / 1000).toFixed(t >= 10000 ? 0 : 1) + "k" : String(t || 0));

  // ---- colour field ----
  // A hex box with a small SV/hue picker behind it, shared by the scene and
  // design editors. The Pixel tab keeps its own dock-sized picker: that one is
  // welded to its palette and history state and works, so it was left alone.
  function parseColor(s) {
    s = String(s == null ? "" : s).trim();
    if (!s || s === "transparent" || s === "none") return [0, 0, 0, 0];
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      if (p.length < 3) return null;
      const n = (v) => (v.endsWith("%") ? Math.round(parseFloat(v) * 2.55) : Math.round(parseFloat(v)));
      return [n(p[0]), n(p[1]), n(p[2]), p[3] == null ? 1 : parseFloat(p[3])];
    }
    return null;
  }
  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  function colorToString(c) {
    if (!c) return "";
    if (c[3] >= 0.999) return "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
    return "rgba(" + Math.round(c[0]) + ", " + Math.round(c[1]) + ", " + Math.round(c[2]) + ", " + (+c[3].toFixed(3)) + ")";
  }
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, mx ? d / mx : 0, mx];
  }
  function hsv2rgb(h, s, v) {
    h = ((h % 360) + 360) % 360 / 60;
    const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
    const t = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return t.map((n) => Math.round((n + m) * 255));
  }

  function colorField(host, opts) {
    opts = opts || {};
    let cur = parseColor(opts.value) || [0, 0, 0, 1];
    const wrap = document.createElement("div");
    wrap.className = "cfield";
    const sw = document.createElement("button");
    sw.className = "cf-swatch"; sw.type = "button"; sw.title = "Pick a colour";
    sw.innerHTML = '<span class="fillc"></span>';
    const hex = document.createElement("input");
    hex.className = "cf-hex"; hex.spellcheck = false; hex.placeholder = "transparent";
    wrap.append(sw, hex);
    host.appendChild(wrap);

    const paint = () => {
      sw.querySelector(".fillc").style.background = cur[3] ? colorToString(cur) : "transparent";
      sw.classList.toggle("clear", !cur[3]);
      if (document.activeElement !== hex) hex.value = cur[3] ? colorToString(cur) : "";
    };
    const emit = (live) => { paint(); if (opts.onChange) opts.onChange(cur[3] ? colorToString(cur) : "transparent", !!live); };
    hex.addEventListener("change", () => {
      const c = parseColor(hex.value);
      if (c) { cur = c; emit(false); } else paint();
    });

    sw.addEventListener("click", () => {
      const pop = document.createElement("div");
      pop.className = "cf-pop";
      const sv = document.createElement("canvas"); sv.className = "cf-sv"; sv.width = 180; sv.height = 110;
      const hue = document.createElement("canvas"); hue.className = "cf-hue"; hue.width = 180; hue.height = 12;
      const arow = document.createElement("label"); arow.className = "cf-arow"; arow.textContent = "Alpha";
      const alpha = document.createElement("input"); alpha.type = "range"; alpha.min = 0; alpha.max = 100; alpha.value = Math.round(cur[3] * 100);
      const clear = document.createElement("button"); clear.className = "btn sm"; clear.type = "button"; clear.textContent = "Transparent";
      arow.append(alpha);
      pop.append(sv, hue, arow, clear);
      document.body.appendChild(pop);
      const r = sw.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 210, r.left)) + "px";
      pop.style.top = (r.bottom + 6 + pop.offsetHeight > window.innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + "px";

      let hsv = rgb2hsv(cur[0], cur[1], cur[2]);
      const draw = () => {
        const c2 = sv.getContext("2d");
        c2.fillStyle = "rgb(" + hsv2rgb(hsv[0], 1, 1).join(",") + ")"; c2.fillRect(0, 0, sv.width, sv.height);
        let g = c2.createLinearGradient(0, 0, sv.width, 0);
        g.addColorStop(0, "#fff"); g.addColorStop(1, "rgba(255,255,255,0)"); c2.fillStyle = g; c2.fillRect(0, 0, sv.width, sv.height);
        g = c2.createLinearGradient(0, 0, 0, sv.height);
        g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "#000"); c2.fillStyle = g; c2.fillRect(0, 0, sv.width, sv.height);
        c2.strokeStyle = hsv[2] > 0.5 ? "#000" : "#fff"; c2.lineWidth = 1.5;
        c2.beginPath(); c2.arc(hsv[1] * sv.width, (1 - hsv[2]) * sv.height, 5, 0, 7); c2.stroke();
        const hc = hue.getContext("2d"), hg = hc.createLinearGradient(0, 0, hue.width, 0);
        for (let i = 0; i <= 6; i++) hg.addColorStop(i / 6, "rgb(" + hsv2rgb(i * 60, 1, 1).join(",") + ")");
        hc.fillStyle = hg; hc.fillRect(0, 0, hue.width, hue.height);
        hc.strokeStyle = "#fff"; hc.lineWidth = 2; hc.strokeRect((hsv[0] / 360) * hue.width - 2, 0.5, 4, hue.height - 1);
      };
      const fromHsv = (live) => { const c = hsv2rgb(hsv[0], hsv[1], hsv[2]); cur = [c[0], c[1], c[2], cur[3] || 1]; alpha.value = Math.round(cur[3] * 100); draw(); emit(live); };
      const drag = (cv, fn) => {
        let down = false;
        cv.addEventListener("pointerdown", (e) => { down = true; cv.setPointerCapture(e.pointerId); fn(e, true); });
        cv.addEventListener("pointermove", (e) => { if (down) fn(e, true); });
        cv.addEventListener("pointerup", (e) => { down = false; fn(e, false); });
      };
      const cl = (v, a, b) => Math.max(a, Math.min(b, v));
      drag(sv, (e, live) => { const b = sv.getBoundingClientRect(); hsv[1] = cl((e.clientX - b.left) / b.width, 0, 1); hsv[2] = cl(1 - (e.clientY - b.top) / b.height, 0, 1); fromHsv(live); });
      drag(hue, (e, live) => { const b = hue.getBoundingClientRect(); hsv[0] = cl((e.clientX - b.left) / b.width, 0, 0.9999) * 360; fromHsv(live); });
      alpha.addEventListener("input", () => { cur = [cur[0], cur[1], cur[2], +alpha.value / 100]; emit(true); });
      alpha.addEventListener("change", () => emit(false));
      clear.addEventListener("click", () => { cur = [cur[0], cur[1], cur[2], 0]; alpha.value = 0; emit(false); });
      draw();
      const away = (e) => { if (!pop.contains(e.target) && e.target !== sw) { pop.remove(); document.removeEventListener("pointerdown", away, true); } };
      setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
    });

    paint();
    return { set: (v) => { const c = parseColor(v); if (c) { cur = c; paint(); } }, get: () => colorToString(cur), el: wrap };
  }
  window.NexusUI = {
    esc, toast, modal, confirm, prompt, resizer, fmtBytes, fmtTok, close,
    colorField, parseColor, colorToString,
    popover: (anchor, items, opts) => show(pop, items, 0, 0, anchor, opts),
    menuAt: (x, y, items, opts) => show(ctx, items, x, y, null, opts),
    isOpen: () => !!openEl,
  };
})();
