// Center tabs: Code / Play / Assets / Pixel / Design / Run.
// Deep link: &tab=preview|assets|pixel|design|run; pixel also honours
// &file=<rel.png> and &cell=16 (or &cell=16x24) and &diff=1, design &file=<rel.svg>.
// v2: Play tab gets a console (fed by /_nexus-console.js inside the iframe) with
// a Fix-with-Claude button; Assets gets filter/grouping/new/upload/delete; Run
// gets history and Fix-with-Claude.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.NexusUI;
  const panes = { code: $("code-pane"), preview: $("preview-pane"), assets: $("assets-pane"), run: $("run-pane"), pixel: $("pixel-pane"), design: $("design-pane") };
  const tabs = document.querySelectorAll("#center-tabs .tab");
  const controls = $("preview-controls");
  const frame = $("preview-frame");
  const newtab = $("preview-newtab");
  const projSel = $("project-select");
  let current = "code";

  const projectName = () => { const o = projSel.selectedOptions[0]; return o && o.value ? o.textContent : null; };
  const previewUrl = () => { const n = projectName(); return n ? "/preview/" + encodeURIComponent(n) + "/" : null; };

  function activate(name) {
    current = name;
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === name);
    for (const [key, el] of Object.entries(panes)) el.hidden = key !== name;
    controls.hidden = name !== "preview";
    if (name === "preview" && !frame.getAttribute("src")) loadPreview();
    if (name === "assets") loadAssets();
    if (name === "pixel" && window.NexusPixel) window.NexusPixel.onShow();
    if (name === "design" && window.NexusDesign) window.NexusDesign.onShow();
    if (name === "code" && window.NexusApp) window.NexusApp.focusEditor();
    if (name === "run") $("run-cmd").focus();
    window.dispatchEvent(new CustomEvent("nexus-tab", { detail: name }));
  }
  for (const t of tabs) t.addEventListener("click", () => activate(t.dataset.tab));

  // ---- Play tab + console ----
  const clog = $("play-console-log"), consoleBox = $("play-console"), consoleCount = $("console-count"), fixBtn = $("console-fix");
  let errors = 0, entries = [];
  function loadPreview() {
    const url = previewUrl();
    if (!url) { frame.removeAttribute("src"); return; }
    clearConsole();
    frame.src = url + "?ts=" + Date.now();
    newtab.href = url;
  }
  function clearConsole() { clog.innerHTML = ""; errors = 0; entries = []; consoleCount.hidden = true; consoleCount.textContent = "0"; consoleCount.className = "pill"; fixBtn.hidden = true; }
  function addConsole(level, text) {
    if (level === "ready") { addConsole("info", "game loaded"); return; }
    const last = clog.lastElementChild;
    if (last && last.dataset.text === text && last.dataset.level === level) {
      const c = last.querySelector(".cnt"); c.textContent = String(+c.textContent + 1); c.hidden = false; return;
    }
    const d = document.createElement("div");
    d.className = "clog " + level;
    d.dataset.text = text; d.dataset.level = level;
    d.innerHTML = '<span class="cnt" hidden>1</span>' + UI.esc(text);
    clog.appendChild(d);
    if (clog.children.length > 500) clog.firstElementChild.remove();
    clog.scrollTop = clog.scrollHeight;
    entries.push({ level, text });
    if (entries.length > 200) entries.shift();
    if (level === "error") {
      errors++;
      consoleCount.textContent = String(errors); consoleCount.hidden = false; consoleCount.className = "pill err";
      fixBtn.hidden = false;
      if (consoleBox.hidden && current === "preview") consoleBox.hidden = false;
    } else if (level === "warn" && !errors) {
      consoleCount.textContent = String(+consoleCount.textContent + 1); consoleCount.hidden = false; consoleCount.className = "pill warn";
    }
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || !m.nexusConsole) return;
    addConsole(m.level, m.text || "");
  });
  $("preview-console-toggle").addEventListener("click", () => { consoleBox.hidden = !consoleBox.hidden; });
  $("console-close").addEventListener("click", () => { consoleBox.hidden = true; });
  $("console-clear").addEventListener("click", clearConsole);
  fixBtn.addEventListener("click", () => {
    if (!window.NexusChat) return;
    const errs = entries.filter((x) => x.level === "error").slice(-8).map((x) => x.text);
    const text = "The Play tab shows these console errors while running the project:\n\n```\n" + errs.join("\n") + "\n```\n\nFind the cause and fix it. Restart nothing - I will reload the Play tab myself.";
    window.NexusChat.ask(text, false);
  });
  $("preview-refresh").addEventListener("click", loadPreview);
  window.addEventListener("keydown", (e) => {
    if (current === "preview" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r" && !e.shiftKey) { e.preventDefault(); loadPreview(); }
  });

  // ---- Assets tab ----
  const grid = $("assets-grid"), assetsFilter = $("assets-filter"), assetsCount = $("assets-count");
  let assetList = [];
  async function loadAssets() {
    const projPath = projSel.value;
    grid.innerHTML = "";
    if (!projPath) { grid.innerHTML = '<div class="assets-empty">Pick a project first.</div>'; return; }
    try { assetList = await (await fetch("/api/assets?path=" + encodeURIComponent(projPath))).json(); }
    catch { grid.innerHTML = '<div class="assets-empty">Failed to load assets.</div>'; return; }
    renderAssets();
  }
  function renderAssets() {
    const q = assetsFilter.value.trim().toLowerCase();
    const list = assetList.filter((a) => !q || a.rel.toLowerCase().includes(q));
    grid.innerHTML = "";
    assetsCount.textContent = list.length + " of " + assetList.length;
    if (!assetList.length) { grid.innerHTML = '<div class="assets-empty">No images or sounds in this project yet. Drop files here, or click New image.</div>'; return; }
    if (!list.length) { grid.innerHTML = '<div class="assets-empty">Nothing matches.</div>'; return; }
    // Group by folder so a big project reads as its asset tree, not a soup.
    const groups = new Map();
    for (const a of list) {
      const dir = a.rel.includes("/") || a.rel.includes(String.fromCharCode(92)) ? a.rel.replace(/[/\x5c][^/\x5c]*$/, "") : "";
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(a);
    }
    for (const [dir, items] of [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (groups.size > 1) { const h = document.createElement("div"); h.className = "asset-group"; h.textContent = dir || "(root)"; grid.appendChild(h); }
      for (const a of items) grid.appendChild(assetCard(a));
    }
  }
  function assetCard(a) {
    const card = document.createElement("div");
    card.className = "asset-card";
    const src = "/raw?path=" + encodeURIComponent(a.path) + "&ts=" + Date.now();
    const isPng = /[.]png$/i.test(a.name);
    const isSvg = /[.]svg$/i.test(a.name);
    if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = src; img.loading = "lazy"; img.alt = a.name;
      if (isPng) { img.classList.add("editable"); img.title = "Edit in the Pixel tab"; img.addEventListener("click", () => openInPixel(a)); }
      else if (isSvg) { img.classList.add("editable"); img.title = "Edit in the Design tab"; img.addEventListener("click", () => openInDesign(a)); }
      img.addEventListener("load", () => { meta.textContent = img.naturalWidth + " x " + img.naturalHeight; });
      card.appendChild(img);
    } else {
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "none"; audio.src = src; card.appendChild(audio);
    }
    const label = document.createElement("div"); label.className = "asset-name"; label.title = a.rel; label.textContent = a.name; card.appendChild(label);
    const meta = document.createElement("div"); meta.className = "asset-meta"; card.appendChild(meta);
    const acts = document.createElement("div"); acts.className = "asset-actions";
    const mk = (icon, title, fn) => { const b = document.createElement("button"); b.className = "ibtn"; b.title = title; b.innerHTML = NexusIcons.svg(icon, 14); b.addEventListener("click", fn); acts.appendChild(b); };
    if (isPng) mk("pencil", "Edit in the Pixel tab", () => openInPixel(a));
    if (isSvg) mk("shapes", "Edit in the Design tab", () => openInDesign(a));
    mk("sparkles", "Ask Claude about this asset", () => window.NexusChat && window.NexusChat.attachFile(a.path, true));
    mk("trash", "Delete (Recycle Bin)", async () => {
      if (!(await UI.confirm("Move " + a.name + " to the Recycle Bin?", { okLabel: "Delete", danger: true }))) return;
      try { await fetch("/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "delete", path: a.path }) }); loadAssets(); if (window.NexusApp) window.NexusApp.refreshTree(); }
      catch (err) { UI.toast(err.message, "err"); }
    });
    card.appendChild(acts);
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      UI.menuAt(e.clientX, e.clientY, [
        isPng ? { label: "Edit in Pixel tab", icon: "pencil", onClick: () => openInPixel(a) } : null,
        isSvg ? { label: "Edit in Design tab", icon: "shapes", onClick: () => openInDesign(a) } : null,
        { label: "Ask Claude about it", icon: "sparkles", onClick: () => window.NexusChat && window.NexusChat.attachFile(a.path, true) },
        { label: "Copy path", icon: "copy", onClick: () => { navigator.clipboard.writeText(a.path); UI.toast("Path copied"); } },
        { label: "Open in new tab", icon: "external", onClick: () => window.open("/raw?path=" + encodeURIComponent(a.path), "_blank") },
      ]);
    });
    return card;
  }
  function openInPixel(a) { activate("pixel"); window.NexusPixel.open(a.path, a.rel); }
  function openInDesign(a) { activate("design"); window.NexusDesign.open(a.path, a.rel); }
  assetsFilter.addEventListener("input", renderAssets);

  // New image: a blank PNG the Pixel tab opens straight away.
  $("assets-new").addEventListener("click", async () => {
    if (!projSel.value) { UI.toast("Pick a project first", "warn"); return; }
    const v = await UI.modal({ title: "New image", fields: [
      { id: "name", label: "File name", value: "sprite.png" },
      { id: "w", label: "Width", type: "number", value: 32, min: 1, max: 4096 },
      { id: "h", label: "Height", type: "number", value: 32, min: 1, max: 4096 },
    ], okLabel: "Create" });
    if (!v || !v.name.trim()) return;
    const name = /[.]png$/i.test(v.name) ? v.name.trim() : v.name.trim() + ".png";
    const c = document.createElement("canvas"); c.width = Math.max(1, v.w | 0); c.height = Math.max(1, v.h | 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dir = projSel.value + String.fromCharCode(92) + "assets";
    const dest = (assetList.some((a) => a.rel.toLowerCase().startsWith("assets")) || assetList.length === 0 ? dir : projSel.value) + String.fromCharCode(92) + name;
    const res = await fetch("/api/image?path=" + encodeURIComponent(dest) + "&new=1", { method: "POST", body: blob });
    const data = await res.json();
    if (!res.ok) { UI.toast(data.error || "could not create", "err"); return; }
    if (window.NexusApp) window.NexusApp.refreshTree();
    activate("pixel");
    window.NexusPixel.open(dest, name);
  });
  $("assets-upload").addEventListener("click", () => $("assets-file").click());
  $("assets-file").addEventListener("change", async (e) => { for (const f of e.target.files) await uploadFile(projSel.value, f); e.target.value = ""; loadAssets(); });
  grid.addEventListener("dragover", (e) => { e.preventDefault(); grid.classList.add("drop-target"); });
  grid.addEventListener("dragleave", () => grid.classList.remove("drop-target"));
  grid.addEventListener("drop", async (e) => {
    e.preventDefault(); grid.classList.remove("drop-target");
    if (!projSel.value) { UI.toast("Pick a project first", "warn"); return; }
    for (const file of e.dataTransfer.files) { try { await uploadFile(projSel.value, file); } catch (err) { UI.toast(file.name + ": " + err.message, "err"); } }
    loadAssets();
    if (window.NexusApp) window.NexusApp.refreshTree();
  });
  async function uploadFile(projPath, file, overwrite) {
    const q = "dir=" + encodeURIComponent(projPath) + "&name=" + encodeURIComponent(file.name) + (overwrite ? "&overwrite=1" : "");
    const res = await fetch("/api/upload?" + q, { method: "POST", body: file });
    if (res.status === 409) {
      if (await UI.confirm(file.name + " already exists in this project. Overwrite it?", { okLabel: "Overwrite", danger: true })) return uploadFile(projPath, file, true);
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "upload failed");
    UI.toast("Uploaded " + file.name, "ok");
  }

  // ---- Run tab ----
  const runOut = $("run-output"), runCmd = $("run-cmd"), runFix = $("run-fix");
  const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const history = JSON.parse(localStorage.getItem("nexus-run-history") || "[]");
  let histIdx = history.length, lastFail = null;
  function appendOut(text, cls) {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    runOut.appendChild(span);
    runOut.scrollTop = runOut.scrollHeight;
  }
  async function runCommand(cmd) {
    const cwd = projSel.value;
    if (!cwd) { UI.toast("Pick a project first", "warn"); return; }
    if (!history.length || history[history.length - 1] !== cmd) { history.push(cmd); if (history.length > 50) history.shift(); localStorage.setItem("nexus-run-history", JSON.stringify(history)); }
    histIdx = history.length;
    appendOut("\n> " + cmd + "\n", "cmdline");
    try {
      const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd, cwd }) });
      const data = await res.json();
      if (data.error) { appendOut("error: " + data.error + "\n", "exit"); return; }
      const out = stripAnsi(data.out);
      appendOut(out || "(no output)\n");
      if (data.timedOut) appendOut("[timed out after 60s]\n", "exit");
      if (data.code) { appendOut("[exit " + data.code + "]\n", "exit"); lastFail = { cmd, out }; runFix.hidden = false; }
      else { runFix.hidden = true; lastFail = null; }
      if (/^git /.test(cmd) && window.NexusApp) window.NexusApp.refreshTree();
    } catch (err) { appendOut("request failed: " + err.message + "\n", "exit"); }
  }
  $("run-go").addEventListener("click", () => { if (runCmd.value.trim()) { runCommand(runCmd.value.trim()); runCmd.value = ""; } });
  runCmd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && runCmd.value.trim()) { runCommand(runCmd.value.trim()); runCmd.value = ""; }
    else if (e.key === "ArrowUp" && history.length) { e.preventDefault(); histIdx = Math.max(0, histIdx - 1); runCmd.value = history[histIdx] || ""; }
    else if (e.key === "ArrowDown") { e.preventDefault(); histIdx = Math.min(history.length, histIdx + 1); runCmd.value = history[histIdx] || ""; }
  });
  $("run-clear").addEventListener("click", () => { runOut.textContent = ""; runFix.hidden = true; });
  for (const b of document.querySelectorAll(".run-quick[data-cmd]")) b.addEventListener("click", () => runCommand(b.dataset.cmd));
  $("run-commit").addEventListener("click", async () => {
    const msg = await UI.prompt("Commit all changes", { label: "Message", placeholder: "What changed" });
    if (msg) runCommand('git add -A && git commit -m "' + msg.replaceAll('"', "") + '"');
  });
  runFix.addEventListener("click", () => {
    if (!lastFail || !window.NexusChat) return;
    window.NexusChat.ask("This command failed in the Run tab:\n\n`" + lastFail.cmd + "`\n\nOutput:\n```\n" + lastFail.out.slice(-3000) + "\n```\n\nFind the cause and fix it.", false);
  });

  // ---- export, project changes, deep links ----
  $("export-btn").addEventListener("click", () => { if (projSel.value) location.href = "/api/export?path=" + encodeURIComponent(projSel.value); });
  window.addEventListener("nexus-project", () => {
    frame.removeAttribute("src");
    clearConsole();
    if (current === "preview") loadPreview();
    if (current === "assets") loadAssets();
  });
  // A pixel save changes a file the asset grid is showing - re-read it.
  window.addEventListener("pixel-saved", () => { if (current === "assets") loadAssets(); if (window.NexusApp) window.NexusApp.refreshTree(); });
  window.addEventListener("nexus-files-changed", (e) => {
    const paths = (e.detail && e.detail.paths) || [];
    if (current === "assets" && paths.some((p) => /[.](png|jpe?g|gif|webp|mp3|wav|ogg)$/i.test(p))) loadAssets();
  });

  window.NexusTabs = { activate, current: () => current, loadPreview, loadAssets, runCommand };

  const params = new URLSearchParams(location.search);
  const wanted = params.get("tab");
  if (["preview", "assets", "run", "pixel", "design"].includes(wanted)) {
    // app.js init() may still be selecting the project; wait a beat so the dropdown is set.
    setTimeout(() => {
      activate(wanted);
      const file = params.get("file");
      if (wanted === "design" && file && /[.]svg$/i.test(file) && projSel.value) {
        window.NexusDesign.open(projSel.value + String.fromCharCode(92) + file.replaceAll("/", String.fromCharCode(92)), file);
      }
      if (wanted === "pixel" && file && /[.]png$/i.test(file) && projSel.value) {
        window.NexusPixel.open(projSel.value + String.fromCharCode(92) + file.replaceAll("/", String.fromCharCode(92)), file);
        const cell = (params.get("cell") || "").split("x");
        if (cell[0]) window.NexusPixel.setCell(+cell[0], +(cell[1] || cell[0]));
        if (params.get("diff")) setTimeout(() => window.NexusPixel.showChanges(), 300);
      }
    }, 500);
  }
})();
