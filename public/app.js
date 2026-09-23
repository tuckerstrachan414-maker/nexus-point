// Nexus Point shell: project picker, file tree (filter, context menu, file
// ops, find in files), multi-tab CodeMirror editor with find/replace, panel
// toggles and resizers, deep links. v2 rewrite 2026-09-03.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.NexusUI;
  const state = { project: null, projectName: null, tree: [], tabs: [], active: null, cm: null };
  const SEP = String.fromCharCode(92);

  const MODE_BY_EXT = {
    ".html": "htmlmixed", ".htm": "htmlmixed", ".xml": "xml", ".svg": "xml",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "javascript",
    ".json": { name: "javascript", json: true }, ".css": "css", ".md": "markdown", ".py": "python",
  };
  const IMG_EXT = /[.](png|jpe?g|gif|webp|bmp)$/i;

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function setStatus(msg, isErr) {
    const el = $("status");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isErr);
    if (msg && !isErr) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
  }
  const relPath = (p) => (state.project && p.toLowerCase().startsWith(state.project.toLowerCase()) ? p.slice(state.project.length + 1) : p);
  const baseName = (p) => p.split(/[/\x5c]/).pop();
  const dirName = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf(SEP)));

  // ---- projects ----
  async function loadProjects() {
    const projects = await api("/api/projects");
    const sel = $("project-select");
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.path;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }

  async function selectProject(p, name) {
    state.project = p;
    state.projectName = name;
    localStorage.setItem("nexus-last-project", name || "");
    closeAllTabs(true);
    $("export-btn").hidden = !p;
    await loadTree();
    window.dispatchEvent(new CustomEvent("nexus-project", { detail: { path: p, name } }));
  }

  $("project-select").addEventListener("change", async (e) => {
    const p = e.target.value;
    if (!p) return;
    if (anyDirty() && !(await UI.confirm("You have unsaved changes. Switch project anyway?", { okLabel: "Switch" }))) {
      e.target.value = state.project || "";
      return;
    }
    await selectProject(p, e.target.selectedOptions[0].textContent);
  });

  // ---- tree ----
  async function loadTree() {
    if (!state.project) return;
    state.tree = await api("/api/tree?path=" + encodeURIComponent(state.project));
    renderTree();
  }

  function renderTree() {
    const box = $("tree");
    box.classList.remove("empty-hint");
    box.innerHTML = "";
    if (!state.tree.length) { box.textContent = "(empty project)"; return; }
    box.appendChild(renderNodes(state.tree, 0));
    applyFilter();
    highlightActive();
  }

  const expanded = new Set(); // dir paths kept open across refreshes
  function renderNodes(nodes, depth) {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const div = document.createElement("div");
      const open = expanded.has(n.path.toLowerCase()) || (depth === 0 && nodes.length <= 3);
      div.className = "tree-node " + n.type + (n.type === "dir" && !open ? " collapsed" : "");
      div.dataset.path = n.path;
      div.dataset.name = n.name.toLowerCase();
      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = n.path;
      row.dataset.type = n.type;
      const icon = document.createElement("span");
      icon.className = "ico-wrap";
      icon.innerHTML = NexusIcons.svg(n.type === "dir" ? (open ? "chevronDown" : "chevronRight") : fileIcon(n.name), 14);
      const label = document.createElement("span");
      label.className = "tname";
      label.textContent = n.name;
      row.append(icon, label);
      div.appendChild(row);
      if (n.type === "dir") {
        const kids = document.createElement("div");
        kids.className = "tree-children";
        kids.appendChild(renderNodes(n.children || [], depth + 1));
        div.appendChild(kids);
        row.addEventListener("click", () => {
          div.classList.toggle("collapsed");
          const isOpen = !div.classList.contains("collapsed");
          icon.innerHTML = NexusIcons.svg(isOpen ? "chevronDown" : "chevronRight", 14);
          if (isOpen) expanded.add(n.path.toLowerCase()); else expanded.delete(n.path.toLowerCase());
        });
      } else {
        row.addEventListener("click", () => openFile(n.path));
      }
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); treeMenu(e, n); });
      frag.appendChild(div);
    }
    return frag;
  }
  function fileIcon(name) {
    if (IMG_EXT.test(name)) return "image";
    if (/[.](mp3|wav|ogg)$/i.test(name)) return "music";
    if (/[.](js|mjs|cjs|ts|html?|css|json|py)$/i.test(name)) return "fileCode";
    return "file";
  }
  function highlightActive() {
    document.querySelectorAll(".tree-row.active").forEach((el) => el.classList.remove("active"));
    if (!state.active) return;
    const row = document.querySelector('.tree-row[data-path="' + CSS.escape(state.active) + '"]');
    if (row) {
      row.classList.add("active");
      let node = row.parentElement;
      while (node && node !== $("tree")) {
        if (node.classList && node.classList.contains("tree-node") && node.classList.contains("dir")) {
          node.classList.remove("collapsed");
          const ic = node.querySelector(":scope > .tree-row .ico-wrap");
          if (ic) ic.innerHTML = NexusIcons.svg("chevronDown", 14);
          expanded.add(node.dataset.path.toLowerCase());
        }
        node = node.parentElement;
      }
    }
  }

  // ---- filter (Ctrl+P): matching files stay, their folders open ----
  const filterInp = $("tree-filter");
  function applyFilter() {
    const q = filterInp.value.trim().toLowerCase();
    const nodes = $("tree").querySelectorAll(".tree-node");
    if (!q) {
      nodes.forEach((n) => { n.classList.remove("filtered-out"); n.querySelector(":scope > .tree-row .tname").textContent = baseName(n.dataset.path); });
      return;
    }
    // Walk bottom-up: a dir stays if any child stays.
    const keep = (node) => {
      let any = false;
      if (node.classList.contains("dir")) {
        for (const kid of node.querySelectorAll(":scope > .tree-children > .tree-node")) if (keep(kid)) any = true;
        node.classList.toggle("filtered-out", !any);
        if (any) node.classList.remove("collapsed");
        return any;
      }
      const name = node.dataset.name;
      const hit = name.includes(q);
      node.classList.toggle("filtered-out", !hit);
      const lbl = node.querySelector(":scope > .tree-row .tname");
      const raw = baseName(node.dataset.path);
      if (hit) {
        const i = name.indexOf(q);
        lbl.innerHTML = UI.esc(raw.slice(0, i)) + "<mark>" + UI.esc(raw.slice(i, i + q.length)) + "</mark>" + UI.esc(raw.slice(i + q.length));
      } else lbl.textContent = raw;
      return hit;
    };
    for (const top of $("tree").querySelectorAll(":scope > .tree-node")) keep(top);
  }
  filterInp.addEventListener("input", applyFilter);
  filterInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("tree").querySelector(".tree-node.file:not(.filtered-out) > .tree-row");
      if (first) { openFile(first.dataset.path); filterInp.value = ""; applyFilter(); }
    } else if (e.key === "Escape") { filterInp.value = ""; applyFilter(); filterInp.blur(); }
  });

  // ---- context menu + file ops (create, rename, delete to Recycle Bin) ----
  function treeMenu(e, n) {
    const isDir = n.type === "dir";
    const dir = isDir ? n.path : dirName(n.path);
    const items = [];
    if (!isDir) items.push({ label: "Open", icon: "file", onClick: () => openFile(n.path) });
    if (!isDir) items.push({ label: "Ask Claude about this file", icon: "sparkles", onClick: () => window.NexusChat && window.NexusChat.attachFile(n.path, true) });
    items.push({ sep: true });
    items.push({ label: "New file", icon: "filePlus", sub: relPath(dir) || state.projectName, onClick: () => newFile(dir) });
    items.push({ label: "New folder", icon: "folderPlus", onClick: () => newFolder(dir) });
    items.push({ label: "Rename", icon: "pencil", onClick: () => renameNode(n) });
    items.push({ label: "Copy path", icon: "copy", onClick: () => { navigator.clipboard.writeText(n.path); UI.toast("Path copied"); } });
    items.push({ sep: true });
    items.push({ label: "Delete (to Recycle Bin)", icon: "trash", danger: true, onClick: () => deleteNode(n) });
    UI.menuAt(e.clientX, e.clientY, items);
  }
  $("tree").addEventListener("contextmenu", (e) => {
    if (e.target !== $("tree") || !state.project) return;
    e.preventDefault();
    UI.menuAt(e.clientX, e.clientY, [
      { label: "New file", icon: "filePlus", onClick: () => newFile(state.project) },
      { label: "New folder", icon: "folderPlus", onClick: () => newFolder(state.project) },
    ]);
  });
  async function newFile(dir) {
    const v = await UI.modal({ title: "New file", text: "Inside " + (relPath(dir) || state.projectName), fields: [{ id: "name", label: "Name", placeholder: "script.js" }], okLabel: "Create" });
    if (!v || !v.name.trim()) return;
    const p = dir + SEP + v.name.trim();
    try { await post("/api/fs", { op: "mkfile", path: p }); await loadTree(); openFile(p); }
    catch (err) { UI.toast(err.message, "err"); }
  }
  async function newFolder(dir) {
    const v = await UI.modal({ title: "New folder", text: "Inside " + (relPath(dir) || state.projectName), fields: [{ id: "name", label: "Name", placeholder: "assets" }], okLabel: "Create" });
    if (!v || !v.name.trim()) return;
    const p = dir + SEP + v.name.trim();
    try { await post("/api/fs", { op: "mkdir", path: p }); expanded.add(p.toLowerCase()); await loadTree(); }
    catch (err) { UI.toast(err.message, "err"); }
  }
  async function renameNode(n) {
    const v = await UI.modal({ title: "Rename", fields: [{ id: "name", label: "Name", value: n.name }], okLabel: "Rename" });
    if (!v || !v.name.trim() || v.name === n.name) return;
    const np = dirName(n.path) + SEP + v.name.trim();
    try {
      await post("/api/fs", { op: "rename", path: n.path, newPath: np });
      const tab = state.tabs.find((t) => t.path.toLowerCase() === n.path.toLowerCase());
      if (tab) { tab.path = np; tab.name = v.name.trim(); if (state.active === n.path) state.active = np; renderTabs(); }
      await loadTree();
    } catch (err) { UI.toast(err.message, "err"); }
  }
  async function deleteNode(n) {
    if (!(await UI.confirm("Move " + n.name + " to the Recycle Bin?", { okLabel: "Delete", danger: true }))) return;
    try {
      await post("/api/fs", { op: "delete", path: n.path });
      const tab = state.tabs.find((t) => t.path.toLowerCase() === n.path.toLowerCase());
      if (tab) closeTab(tab, true);
      await loadTree();
      UI.toast(n.name + " moved to the Recycle Bin", "ok");
    } catch (err) { UI.toast(err.message, "err"); }
  }
  $("new-file-btn").addEventListener("click", () => { if (state.project) newFile(state.active ? dirName(state.active) : state.project); });

  // ---- find in files (Ctrl+Shift+F) ----
  const findFilesBar = $("find-files-bar"), findFilesQ = $("find-files-q"), results = $("search-results");
  function openFindFiles() { if (!state.project) return; findFilesBar.hidden = false; findFilesQ.focus(); findFilesQ.select(); }
  function closeFindFiles() { findFilesBar.hidden = true; results.hidden = true; $("tree").hidden = false; }
  $("find-files-btn").addEventListener("click", openFindFiles);
  $("find-files-close").addEventListener("click", closeFindFiles);
  findFilesQ.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { closeFindFiles(); return; }
    if (e.key !== "Enter") return;
    const q = findFilesQ.value.trim();
    if (q.length < 2) return;
    results.hidden = false; $("tree").hidden = true;
    results.innerHTML = '<div class="empty-hint">Searching</div>';
    let hits;
    try { hits = await api("/api/search?path=" + encodeURIComponent(state.project) + "&q=" + encodeURIComponent(q)); }
    catch (err) { results.innerHTML = '<div class="empty-hint">' + UI.esc(err.message) + "</div>"; return; }
    results.innerHTML = "";
    if (!hits.length) { results.innerHTML = '<div class="empty-hint">No matches for "' + UI.esc(q) + '"</div>'; return; }
    let lastFile = null;
    const ql = q.toLowerCase();
    for (const h of hits) {
      if (h.path !== lastFile) { lastFile = h.path; const f = document.createElement("div"); f.className = "sr-file"; f.textContent = h.rel; results.appendChild(f); }
      const b = document.createElement("button");
      b.className = "sr-hit";
      const i = h.text.toLowerCase().indexOf(ql);
      b.innerHTML = '<span class="ln">' + h.line + "</span>" + (i < 0 ? UI.esc(h.text) : UI.esc(h.text.slice(0, i)) + "<mark>" + UI.esc(h.text.slice(i, i + q.length)) + "</mark>" + UI.esc(h.text.slice(i + q.length)));
      b.title = h.rel + ":" + h.line;
      b.addEventListener("click", () => openFile(h.path, { line: h.line }));
      results.appendChild(b);
    }
    const note = document.createElement("div"); note.className = "empty-hint"; note.textContent = hits.length + (hits.length >= 300 ? "+ matches (capped)" : " matches"); results.appendChild(note);
  });

  // ---- editor: one CodeMirror, one Doc per open tab ----
  function ensureEditor() {
    if (state.cm) return state.cm;
    $("editor-placeholder").hidden = true;
    $("editor").hidden = false;
    state.cm = CodeMirror.fromTextArea($("editor"), {
      lineNumbers: true, theme: "material-darker", indentUnit: 2, tabSize: 2, lineWrapping: false,
      extraKeys: { "Ctrl-F": () => openFind(false), "Ctrl-H": () => openFind(true), "Ctrl-S": saveActive, "Esc": () => { if (!$("find-bar").hidden) closeFind(); } },
    });
    state.cm.on("change", () => { const t = activeTab(); if (t) { const d = !t.doc.isClean(t.gen); if (d !== t.dirty) { t.dirty = d; renderTabs(); syncTop(); } } });
    return state.cm;
  }
  const activeTab = () => state.tabs.find((t) => t.path === state.active) || null;
  const anyDirty = () => state.tabs.some((t) => t.dirty);

  async function openFile(p, opts) {
    opts = opts || {};
    if (IMG_EXT.test(p)) {
      if (/[.]png$/i.test(p)) { window.NexusTabs.activate("pixel"); window.NexusPixel.open(p, relPath(p)); }
      else if (/[.]svg$/i.test(p) && window.NexusDesign) { window.NexusTabs.activate("design"); window.NexusDesign.open(p, relPath(p)); }
      else UI.toast("PNGs open in the Pixel tab and SVGs in the Design tab. See the Assets tab for previews.", "warn");
      return;
    }
    let tab = state.tabs.find((t) => t.path.toLowerCase() === p.toLowerCase());
    if (!tab) {
      let data;
      try { data = await api("/api/file?path=" + encodeURIComponent(p)); } catch (err) { UI.toast(err.message, "err"); return; }
      if (data.binary) { UI.toast("Binary file (" + UI.fmtBytes(data.size) + ") - see the Assets tab", "warn"); return; }
      const ext = "." + p.split(".").pop().toLowerCase();
      tab = { path: p, name: baseName(p), doc: CodeMirror.Doc(data.content, MODE_BY_EXT[ext] || null), gen: 0, dirty: false, stale: false };
      tab.gen = tab.doc.changeGeneration(true);
      state.tabs.push(tab);
    }
    showTab(tab);
    if (opts.line) { const cm = state.cm; cm.setCursor({ line: opts.line - 1, ch: 0 }); cm.scrollIntoView({ line: opts.line - 1, ch: 0 }, 120); }
    if (!opts.keepFocus) state.cm.focus();
    window.NexusTabs && window.NexusTabs.activate("code");
  }
  function showTab(tab) {
    const cm = ensureEditor();
    const prev = activeTab();
    if (prev && prev !== tab) prev.scroll = cm.getScrollInfo();
    state.active = tab.path;
    cm.swapDoc(tab.doc);
    if (tab.scroll) cm.scrollTo(tab.scroll.left, tab.scroll.top);
    renderTabs(); syncTop(); highlightActive();
    if (tab.stale) reloadTab(tab);
  }
  function renderTabs() {
    const strip = $("file-tabs");
    strip.hidden = state.tabs.length === 0;
    strip.innerHTML = "";
    for (const t of state.tabs) {
      const el = document.createElement("div");
      el.className = "ftab" + (t.path === state.active ? " active" : "") + (t.dirty ? " dirty" : "") + (t.stale ? " stale" : "");
      el.title = relPath(t.path) + (t.stale ? " (changed on disk)" : "");
      el.innerHTML = '<span class="fname">' + UI.esc(t.name) + '</span><span class="fclose" title="Close (Ctrl+W)"><span class="dot"></span>' + NexusIcons.svg("x", 12) + "</span>";
      el.addEventListener("click", (e) => { if (e.target.closest(".fclose")) closeTab(t); else showTab(t); });
      el.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(t); });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        UI.menuAt(e.clientX, e.clientY, [
          { label: "Close", mk: "Ctrl+W", onClick: () => closeTab(t) },
          { label: "Close others", onClick: () => { for (const o of state.tabs.slice()) if (o !== t) closeTab(o); } },
          { label: "Close all", onClick: () => closeAllTabs(false) },
          { sep: true },
          { label: "Ask Claude about this file", icon: "sparkles", onClick: () => window.NexusChat && window.NexusChat.attachFile(t.path, true) },
          { label: "Copy path", icon: "copy", onClick: () => { navigator.clipboard.writeText(t.path); UI.toast("Path copied"); } },
        ]);
      });
      strip.appendChild(el);
    }
    const act = strip.querySelector(".ftab.active");
    if (act) act.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
  function syncTop() {
    const t = activeTab();
    $("file-label").textContent = t ? relPath(t.path) : "";
    $("dirty-dot").hidden = !(t && t.dirty);
    $("save-btn").disabled = !(t && t.dirty);
    if (!t && state.cm) { $("editor").hidden = true; state.cm.getWrapperElement().style.display = "none"; $("editor-placeholder").hidden = false; }
    else if (t && state.cm) { state.cm.getWrapperElement().style.display = ""; $("editor-placeholder").hidden = true; state.cm.refresh(); }
  }
  async function closeTab(tab, force) {
    if (tab.dirty && !force && !(await UI.confirm(tab.name + " has unsaved changes. Close it anyway?", { okLabel: "Close", danger: true }))) return;
    const i = state.tabs.indexOf(tab);
    state.tabs.splice(i, 1);
    if (state.active === tab.path) {
      const next = state.tabs[i] || state.tabs[i - 1];
      if (next) showTab(next); else { state.active = null; renderTabs(); syncTop(); highlightActive(); }
    } else renderTabs();
  }
  async function closeAllTabs(force) {
    if (!force && anyDirty() && !(await UI.confirm("Some files have unsaved changes. Close them all?", { okLabel: "Close all", danger: true }))) return;
    state.tabs = []; state.active = null; renderTabs(); syncTop(); highlightActive();
  }

  // ---- save / reload ----
  async function saveActive() {
    const t = activeTab();
    if (!t || !t.dirty) return;
    try {
      await post("/api/file", { path: t.path, content: t.doc.getValue() });
      t.gen = t.doc.changeGeneration(true); t.dirty = false; t.stale = false;
      renderTabs(); syncTop(); setStatus("Saved");
      window.dispatchEvent(new CustomEvent("nexus-file-saved", { detail: { path: t.path } }));
    } catch (err) { setStatus("Save failed: " + err.message, true); }
  }
  async function saveAll() { for (const t of state.tabs) if (t.dirty) { const a = state.active; state.active = t.path; await saveActive(); state.active = a; } renderTabs(); syncTop(); }
  // A file changed on disk (Claude edit, git, external editor): reload it if the
  // tab is clean, otherwise flag it so the user can decide.
  async function reloadTab(tab) {
    try {
      const data = await api("/api/file?path=" + encodeURIComponent(tab.path));
      if (data.binary || data.content === tab.doc.getValue()) { tab.stale = false; renderTabs(); return; }
      if (tab.dirty) { tab.stale = true; renderTabs(); return; }
      const cm = state.cm, isActive = tab.path === state.active;
      const scroll = isActive ? cm.getScrollInfo() : null;
      const cur = isActive ? cm.getCursor() : null;
      tab.doc.setValue(data.content);
      tab.gen = tab.doc.changeGeneration(true); tab.dirty = false; tab.stale = false;
      if (isActive) { cm.setCursor(cur); cm.scrollTo(scroll.left, scroll.top); }
      renderTabs(); syncTop();
      if (isActive) setStatus("Reloaded from disk");
    } catch {}
  }
  async function filesChanged(paths) {
    const set = new Set((paths || []).map((p) => p.toLowerCase()));
    for (const t of state.tabs) if (!set.size || set.has(t.path.toLowerCase())) await reloadTab(t);
    await loadTree();
  }
  $("save-btn").addEventListener("click", saveActive);
  window.addEventListener("beforeunload", (e) => { if (anyDirty()) e.preventDefault(); });

  // ---- find / replace bar (Ctrl+F, Ctrl+H) ----
  const findBar = $("find-bar"), findQ = $("find-q"), findR = $("find-r"), findCount = $("find-count");
  let marks = [], matches = [], matchIdx = -1;
  function clearMarks() { for (const m of marks) m.clear(); marks = []; matches = []; matchIdx = -1; findCount.textContent = ""; }
  function runFind(fromCursor) {
    clearMarks();
    const cm = state.cm, q = findQ.value;
    if (!cm || !q) return;
    const text = cm.getValue(), lower = text.toLowerCase(), ql = q.toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(ql, i)) > -1 && matches.length < 2000) { matches.push([cm.posFromIndex(i), cm.posFromIndex(i + q.length)]); i += q.length; }
    for (const [a, b] of matches) marks.push(cm.markText(a, b, { className: "cm-find-match" }));
    if (!matches.length) { findCount.textContent = "No results"; return; }
    const cur = cm.indexFromPos(cm.getCursor("from"));
    matchIdx = Math.max(0, matches.findIndex(([a]) => cm.indexFromPos(a) >= cur));
    if (!fromCursor) matchIdx = 0;
    gotoMatch(0);
  }
  function gotoMatch(step) {
    if (!matches.length) return;
    matchIdx = (matchIdx + step + matches.length) % matches.length;
    const [a, b] = matches[matchIdx];
    state.cm.setSelection(a, b); state.cm.scrollIntoView({ from: a, to: b }, 80);
    findCount.textContent = (matchIdx + 1) + " of " + matches.length;
  }
  function openFind(withReplace) {
    if (!state.cm) return;
    findBar.hidden = false;
    const sel = state.cm.getSelection();
    if (sel && !sel.includes("\n")) findQ.value = sel;
    (withReplace ? findR : findQ).focus(); (withReplace ? findR : findQ).select();
    runFind(true);
  }
  function closeFind() { findBar.hidden = true; clearMarks(); if (state.cm) state.cm.focus(); }
  findQ.addEventListener("input", () => runFind(true));
  findQ.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } else if (e.key === "Escape") closeFind(); });
  findR.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); replaceOne(); } else if (e.key === "Escape") closeFind(); });
  function replaceOne() {
    if (!matches.length || matchIdx < 0) return;
    const [a, b] = matches[matchIdx];
    state.cm.replaceRange(findR.value, a, b);
    runFind(true);
  }
  $("find-next").addEventListener("click", () => gotoMatch(1));
  $("find-prev").addEventListener("click", () => gotoMatch(-1));
  $("find-replace").addEventListener("click", replaceOne);
  $("find-replace-all").addEventListener("click", () => {
    if (!matches.length) return;
    const cm = state.cm, n = matches.length;
    cm.operation(() => { for (let i = matches.length - 1; i >= 0; i--) cm.replaceRange(findR.value, matches[i][0], matches[i][1]); });
    runFind(false); setStatus("Replaced " + n);
  });
  $("find-close").addEventListener("click", closeFind);

  // ---- panels, resizers, shortcuts ----
  const sidebar = $("sidebar"), claude = $("claude-panel");
  function togglePanel(el, btn, key) {
    el.classList.toggle("collapsed");
    const shown = !el.classList.contains("collapsed");
    btn.classList.toggle("active", shown);
    localStorage.setItem(key, shown ? "1" : "0");
    window.dispatchEvent(new Event("resize"));
    return shown;
  }
  $("toggle-files").addEventListener("click", () => togglePanel(sidebar, $("toggle-files"), "nexus-show-files"));
  $("toggle-claude").addEventListener("click", () => { const shown = togglePanel(claude, $("toggle-claude"), "nexus-show-claude"); if (shown && window.NexusChat) window.NexusChat.focus(); });
  if (localStorage.getItem("nexus-show-files") === "0") togglePanel(sidebar, $("toggle-files"), "nexus-show-files");
  if (localStorage.getItem("nexus-show-claude") === "0") togglePanel(claude, $("toggle-claude"), "nexus-show-claude");
  UI.resizer($("resize-left"), sidebar, { min: 180, max: 520, side: "left" });
  UI.resizer($("resize-right"), claude, { min: 300, max: 900, side: "right" });

  const inField = (e) => { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (!mod && e.key === "F5") { e.preventDefault(); refreshTree(); return; }
    if (!mod) return;
    if (k === "s" && !e.shiftKey && !$("pixel-pane").hidden) return; // pixel.js owns Ctrl+S there
    if (k === "s" && !e.shiftKey) { e.preventDefault(); saveActive(); }
    else if (k === "s" && e.shiftKey) { e.preventDefault(); saveAll(); }
    else if (k === "p" && !e.shiftKey) { e.preventDefault(); if (sidebar.classList.contains("collapsed")) togglePanel(sidebar, $("toggle-files"), "nexus-show-files"); filterInp.focus(); filterInp.select(); }
    else if (k === "f" && e.shiftKey) { e.preventDefault(); if (sidebar.classList.contains("collapsed")) togglePanel(sidebar, $("toggle-files"), "nexus-show-files"); openFindFiles(); }
    else if (k === "b" && !e.shiftKey && !inField(e)) { e.preventDefault(); togglePanel(sidebar, $("toggle-files"), "nexus-show-files"); }
    else if (k === "j") { e.preventDefault(); if (claude.classList.contains("collapsed")) togglePanel(claude, $("toggle-claude"), "nexus-show-claude"); if (window.NexusChat) window.NexusChat.focus(); }
    else if (k === "w" && !e.shiftKey && !inField(e) && activeTab() && !$("code-pane").hidden) { e.preventDefault(); closeTab(activeTab()); }
    else if ((k === "f" || k === "h") && !e.shiftKey && !inField(e) && activeTab() && !$("code-pane").hidden) { e.preventDefault(); openFind(k === "h"); }
    else if (k === "k" && !e.shiftKey && state.cm && state.cm.hasFocus()) { e.preventDefault(); sendSelection(); }
    else if (e.key === "Tab" && state.tabs.length > 1 && !e.shiftKey && !inField(e)) { e.preventDefault(); const i = state.tabs.indexOf(activeTab()); showTab(state.tabs[(i + 1) % state.tabs.length]); }
  });
  // Ctrl+K: hand the current selection (or the whole file) to Claude with context.
  function sendSelection() {
    const t = activeTab(); if (!t || !window.NexusChat) return;
    const cm = state.cm, sel = cm.getSelection();
    const from = cm.getCursor("from"), to = cm.getCursor("to");
    window.NexusChat.attachSelection({ path: t.path, code: sel || null, from: from.line + 1, to: to.line + 1, lang: (t.name.split(".").pop() || "").toLowerCase() });
  }

  // Claude changed files on disk: reload clean tabs, flag dirty ones, refresh the tree.
  window.addEventListener("nexus-files-changed", (e) => filesChanged(e.detail && e.detail.paths));
  window.addEventListener("claude-done", () => filesChanged([]));
  $("tree-refresh").addEventListener("click", () => refreshTree());
  async function refreshTree() { await filesChanged([]); setStatus("Refreshed"); }

  // Boot. Deep link: /?project=<name>&file=<relative path>&line=<n>
  async function init() {
    NexusIcons.mount();
    await loadProjects();
    const params = new URLSearchParams(location.search);
    const projName = params.get("project") || localStorage.getItem("nexus-last-project");
    if (!projName) return;
    const sel = $("project-select");
    const opt = [...sel.options].find((o) => o.textContent.toLowerCase() === projName.toLowerCase());
    if (!opt) { if (params.get("project")) setStatus("Unknown project: " + projName, true); return; }
    sel.value = opt.value;
    await selectProject(opt.value, opt.textContent);
    const file = params.get("file");
    if (file && !/[.]png$/i.test(file)) await openFile(opt.value + SEP + file.replaceAll("/", SEP), { line: +(params.get("line") || 0) });
  }
  window.NexusApp = {
    openFile, refreshTree, saveActive, saveAll,
    projectPath: () => state.project, projectName: () => state.projectName,
    activeFile: () => state.active,
    activeSelection: () => { const t = activeTab(); if (!t) return null; const cm = state.cm; return { path: t.path, code: cm.getSelection(), from: cm.getCursor("from").line + 1, to: cm.getCursor("to").line + 1 }; },
    focusEditor: () => { if (state.cm && activeTab()) { state.cm.refresh(); state.cm.focus(); } },
    fileList: () => { const out = []; const walk = (nodes) => { for (const n of nodes) { if (n.type === "file") out.push({ path: n.path, rel: relPath(n.path), name: n.name }); else walk(n.children || []); } }; walk(state.tree); return out; },
    revealFile: (p) => { state.active = p; highlightActive(); },
    relPath, setStatus,
  };
  init().catch((err) => setStatus(err.message, true));
})();
