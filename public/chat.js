// Claude sidebar frontend: WebSocket to the server's Agent SDK bridge (agent.js).
// v2 (2026-09-03): streamed replies, full markdown, tool rows with results and
// diffs, richer permission cards (plans, questions), attachments (@files, pasted
// images, editor selections), prompt history, model/mode/effort chips, todo and
// task panels, rewind, chat rename/delete, quick actions, notices and suggestions.
//
// v2.1 (2026-09-05): several chats at once. Every chat owns its own scroll pane,
// state and query() on the server; the composer, chips, todo panel and status dot
// are shared chrome repainted from whichever chat is active. Two module-level
// pointers do all the routing: A is the chat the user is looking at, R is the chat
// the code is currently rendering INTO (an arriving event's chat, or A). Any
// function that draws must use R, and any handler it wires up must capture R at
// creation time - a background chat can stream while another one is on screen.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.NexusUI;
  const logHost = $("chat-log"), input = $("chat-input"), sendBtn = $("chat-send"), stopBtn = $("chat-stop");
  const statusDot = $("claude-status"), modeBtn = $("mode-btn"), effortBtn = $("effort-btn"), modelBtn = $("model-btn");
  const tabsHost = $("chat-tabs");
  let ws = null;
  let COMMANDS = [], MODELS = [], ACCOUNT = null;
  // Where this install lives, read from the server instead of hardcoded - the
  // workspace folder has been renamed once already.
  const ENV = { workspace: "", nexus: "", spriteCli: 'node "tools/sprite.mjs"' };
  fetch("/api/env").then((r) => r.json()).then((e) => Object.assign(ENV, e || {})).catch(() => {});
  const SEP = String.fromCharCode(92);
  const projectPath = () => (window.NexusApp ? window.NexusApp.projectPath() : $("project-select").value || null);
  const projectName = () => (window.NexusApp ? window.NexusApp.projectName() : null);
  const rel = (p) => { const pp = projectPath(); return pp && p && p.toLowerCase().startsWith(pp.toLowerCase()) ? p.slice(pp.length + 1) : p; };
  // Every message names its chat, so a reply cannot land in the wrong tab.
  const wsSend = (obj, chatId) => {
    if (!(ws && ws.readyState === 1)) return false;
    ws.send(JSON.stringify(Object.assign({ chat: chatId || (obj && obj.chat) || (A && A.id) }, obj)));
    return true;
  };

  // ---- the chats ----
  const MAX_CHATS = 5;
  const CHATS = new Map();
  let A = null, R = null, chatSeq = 0;
  function emptyState() {
    const el = $("chat-empty-tpl").content.firstElementChild.cloneNode(true);
    NexusIcons.mount(el);
    renderQuickActions(el.querySelector(".quick-actions"));
    return el;
  }
  function makeChat(id) {
    const pane = document.createElement("div");
    pane.className = "chat-pane";
    pane.hidden = true;
    pane.appendChild(emptyState());
    logHost.appendChild(pane);
    const c = {
      id, pane, sessionId: null, title: "", firstPrompt: "", stick: true, busy: false, dot: "idle",
      live: null, liveText: "", liveThink: null, liveThinkText: "", renderTimer: null,
      toolRows: new Map(), taskRows: new Map(), pendingCards: new Map(),
      todos: [], attachments: [], draft: "", unread: false, tabEl: null,
      model: "", mode: "default", effort: "medium",
      ctxPct: 0, ctxUsed: 0, ctxMax: 0, sessionTok: 0, sessionCost: 0,
      notice: "", suggestion: "",
    };
    pane.addEventListener("scroll", () => { c.stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40; });
    CHATS.set(id, c);
    const n = parseInt(id.slice(1), 10);
    if (n > chatSeq) chatSeq = n;
    return c;
  }

  // ---- log helpers (always draw into R) ----
  function scrollDown(force) { const c = R; if (c && (c.stick || force)) c.pane.scrollTop = c.pane.scrollHeight; }
  function append(el) { const c = R; const e = c.pane.querySelector(".chat-empty"); if (e) e.hidden = true; c.pane.appendChild(el); scrollDown(); return el; }
  function addMsg(cls, text) {
    const div = document.createElement("div");
    div.className = "msg " + cls;
    if (cls === "assistant") div.innerHTML = renderMarkdown(text);
    else if (cls === "event") div.innerHTML = NexusIcons.svg("info", 13) + "<span>" + UI.esc(text) + "</span>";
    else div.textContent = text;
    return append(div);
  }
  function addEvent(icon, text) {
    const div = document.createElement("div");
    div.className = "msg event";
    div.innerHTML = NexusIcons.svg(icon || "info", 13) + "<span>" + UI.esc(text) + "</span>";
    return append(div);
  }

  // ---- markdown (escape-first; supports what Claude actually emits) ----
  function inline(t) {
    t = UI.esc(t);
    t = t.replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    // File paths become links into the editor (absolute Windows paths or project-relative ones with a known extension).
    t = t.replace(/(?<![\w"'=/])((?:[A-Za-z]:[\x5c/])?(?:[\w.-]+[\x5c/])*[\w.-]+[.](?:js|mjs|cjs|ts|html?|css|json|md|py|txt|png|bat|yml|yaml))(?::(\d+))?(?![\w/])/g,
      (m, p, ln) => '<span class="file-link" data-path="' + UI.esc(p) + '" data-line="' + (ln || "") + '">' + m + "</span>");
    return t;
  }
  function renderMarkdown(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    let html = "", i = 0, para = [];
    const flush = () => { if (para.length) { html += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>"; para = []; } };
    while (i < lines.length) {
      const L = lines[i];
      const fence = L.match(/^\s*```\s*(\w+)?/);
      if (fence) {
        flush();
        const lang = fence[1] || "";
        let j = i + 1, code = [];
        while (j < lines.length && !/^\s*```/.test(lines[j])) code.push(lines[j++]);
        html += '<pre data-lang="' + UI.esc(lang) + '"><button class="ibtn sm copy-btn" title="Copy">' + NexusIcons.svg("copy", 12) + "</button><code>" + UI.esc(code.join("\n")) + "</code></pre>";
        i = j + 1; continue;
      }
      const h = L.match(/^(#{1,4})\s+(.*)/);
      if (h) { flush(); html += "<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"; i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(L)) { flush(); html += "<hr>"; i++; continue; }
      if (/^\s*>/.test(L)) { flush(); let q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, "")); html += "<blockquote>" + renderMarkdown(q.join("\n")) + "</blockquote>"; continue; }
      if (/^\s*\|.*\|\s*$/.test(L) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        html += "<table><thead><tr>" + cells(L).map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += "<tr>" + cells(lines[i++]).map((c) => "<td>" + c + "</td>").join("") + "</tr>";
        html += "</tbody></table>"; continue;
      }
      const li = L.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        html += ordered ? "<ol>" : "<ul>";
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
          if (!m) { if (/^\s{2,}\S/.test(lines[i]) && html.endsWith("</li>")) { html = html.slice(0, -5) + "<br>" + inline(lines[i].trim()) + "</li>"; i++; continue; } break; }
          html += "<li>" + inline(m[3]) + "</li>"; i++;
        }
        html += ordered ? "</ol>" : "</ul>"; continue;
      }
      if (!L.trim()) { flush(); i++; continue; }
      para.push(L); i++;
    }
    flush();
    return html;
  }
  logHost.addEventListener("click", (e) => {
    const copy = e.target.closest(".copy-btn");
    if (copy) { navigator.clipboard.writeText(copy.parentElement.querySelector("code").textContent); UI.toast("Copied"); return; }
    const fl = e.target.closest(".file-link");
    if (fl && window.NexusApp) {
      let p = fl.dataset.path;
      if (!/^[A-Za-z]:/.test(p) && projectPath()) p = projectPath() + SEP + p.replaceAll("/", SEP);
      window.NexusApp.openFile(p, { line: fl.dataset.line ? +fl.dataset.line : 0 });
    }
  });

  // ---- streaming assistant text and thinking (per chat) ----
  function ensureLive() {
    const c = R;
    if (c.live) return c.live;
    c.live = document.createElement("div");
    c.live.className = "msg assistant streaming";
    c.liveText = "";
    return append(c.live);
  }
  function paintLive(c) {
    c = c || R;
    c.renderTimer = null;
    if (c.live) { c.live.innerHTML = renderMarkdown(c.liveText); if (c === R) scrollDown(); }
  }
  function onDelta(kind, text) {
    const c = R;
    if (kind === "text") {
      ensureLive();
      c.liveText += text;
      if (!c.renderTimer) c.renderTimer = setTimeout(() => paintLive(c), 60);
    } else if (kind === "thinking") {
      if (!c.liveThink) {
        c.liveThink = document.createElement("div");
        c.liveThink.className = "msg thinking streaming";
        c.liveThink.innerHTML = "<details><summary>Thinking</summary><div class='think-body'></div></details>";
        c.liveThinkText = "";
        append(c.liveThink);
      }
      c.liveThinkText += text;
      c.liveThink.querySelector(".think-body").textContent = c.liveThinkText;
      scrollDown();
    }
  }
  function finishAssistant(text) {
    const c = R;
    if (c.renderTimer) { clearTimeout(c.renderTimer); c.renderTimer = null; }
    const el = c.live || ensureLive();
    el.innerHTML = renderMarkdown(text);
    el.classList.remove("streaming");
    c.live = null; c.liveText = "";
    scrollDown();
  }
  function finishThinking(text) {
    const c = R;
    if (c.liveThink) { c.liveThink.querySelector(".think-body").textContent = text; c.liveThink.classList.remove("streaming"); c.liveThink = null; }
    else { const d = document.createElement("div"); d.className = "msg thinking"; d.innerHTML = "<details><summary>Thinking</summary><div class='think-body'></div></details>"; d.querySelector(".think-body").textContent = text; append(d); }
  }
  function endStream() {
    const c = R;
    if (c.live && c.liveText) { paintLive(c); c.live.classList.remove("streaming"); c.live = null; c.liveText = ""; }
    else if (c.live) { c.live.remove(); c.live = null; }
    if (c.liveThink) { c.liveThink.classList.remove("streaming"); c.liveThink = null; }
  }

  // ---- tool rows: one registry decides how each tool reads in the log ----
  const shortCmd = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const TOOL_VIEW = {
    Read: { icon: "file", desc: (i) => rel(i.file_path), file: (i) => i.file_path },
    Glob: { icon: "search", desc: (i) => i.pattern + (i.path ? "  in " + rel(i.path) : "") },
    Grep: { icon: "search", desc: (i) => i.pattern + (i.path ? "  in " + rel(i.path) : "") },
    Edit: { icon: "pencil", desc: (i) => rel(i.file_path), file: (i) => i.file_path, body: (i) => diffHtml(i.old_string, i.new_string) },
    MultiEdit: { icon: "pencil", desc: (i) => rel(i.file_path) + "  (" + ((i.edits || []).length) + " edits)", file: (i) => i.file_path, body: (i) => (i.edits || []).map((e) => diffHtml(e.old_string, e.new_string)).join("<hr>") },
    Write: { icon: "filePlus", desc: (i) => rel(i.file_path), file: (i) => i.file_path, body: (i) => "<div class='diff'>" + String(i.content || "").split("\n").slice(0, 80).map((l) => "<span class='add'>+ " + UI.esc(l) + "</span>").join("") + "</div>" },
    NotebookEdit: { icon: "pencil", desc: (i) => rel(i.notebook_path), file: (i) => i.notebook_path },
    Bash: { icon: "terminal", desc: (i) => shortCmd(i.command), body: (i) => (i.description ? "<div class='dim'>" + UI.esc(i.description) + "</div>" : "") + "<code>" + UI.esc(i.command || "") + "</code>" },
    PowerShell: { icon: "terminal", desc: (i) => shortCmd(i.command), body: (i) => "<code>" + UI.esc(i.command || "") + "</code>" },
    WebFetch: { icon: "external", desc: (i) => i.url },
    WebSearch: { icon: "search", desc: (i) => i.query },
    Task: { icon: "sparkles", desc: (i) => i.description || i.subagent_type || "subagent", body: (i) => "<div>" + UI.esc(String(i.prompt || "").slice(0, 600)) + "</div>" },
    Agent: { icon: "sparkles", desc: (i) => i.description || "subagent", body: (i) => "<div>" + UI.esc(String(i.prompt || "").slice(0, 600)) + "</div>" },
    TodoWrite: { icon: "check", desc: () => "updated the plan" },
    AskUserQuestion: { icon: "chat", desc: () => "asked a question" },
    ExitPlanMode: { icon: "check", desc: () => "presented a plan" },
    EnterPlanMode: { icon: "shield", desc: () => "entered plan mode" },
    Skill: { icon: "zap", desc: (i) => "/" + (i.skill || "") + " " + (i.args || "") },
    mcp__nexus__screen: { icon: "monitor", desc: (i) => (i && i.reason) || "looking at your screen" },
    mcp__nexus__screen_displays: { icon: "monitor", desc: () => "checking your monitors" },
  };
  function diffHtml(oldS, newS) {
    const a = String(oldS || "").split("\n"), b = String(newS || "").split("\n");
    // Trim common prefix/suffix so the diff shows only the changed core.
    let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const ctxBefore = a.slice(Math.max(0, s - 2), s), ctxAfter = a.slice(a.length - e, a.length - e + 2);
    let html = "<div class='diff'>";
    for (const l of ctxBefore) html += "<span class='ctx'>  " + UI.esc(l) + "</span>";
    for (const l of a.slice(s, a.length - e)) html += "<span class='del'>- " + UI.esc(l) + "</span>";
    for (const l of b.slice(s, b.length - e)) html += "<span class='add'>+ " + UI.esc(l) + "</span>";
    for (const l of ctxAfter) html += "<span class='ctx'>  " + UI.esc(l) + "</span>";
    return html + "</div>";
  }
  function toolGroup() {
    const last = R.pane.lastElementChild;
    if (last && last.classList.contains("tool-group")) return last;
    const g = document.createElement("div"); g.className = "tool-group"; append(g); return g;
  }
  function toolRow(id, name, input, status) {
    endStream();
    const v = TOOL_VIEW[name] || { icon: "wrench", desc: (i) => shortCmd(JSON.stringify(i)) };
    const c = R;
    if (name === "TodoWrite" && input && input.todos) { c.todos = input.todos.slice(); if (c === A) paintTodos(); }
    let row = c.toolRows.get(id);
    if (!row) {
      row = document.createElement("div");
      row.className = "tool-row collapsed";
      row.innerHTML = '<div class="tool-head">' + NexusIcons.svg(v.icon, 14) + '<span class="tname"></span><span class="tdesc"></span><span class="tstat run">running</span></div><div class="tool-body"></div>';
      row.querySelector(".tool-head").addEventListener("click", (e) => { if (!e.target.closest(".fl")) row.classList.toggle("collapsed"); });
      c.toolRows.set(id, row);
      toolGroup().appendChild(row);
    }
    row.querySelector(".tname").textContent = name;
    if (input) {
      let desc = ""; try { desc = v.desc(input) || ""; } catch { desc = ""; }
      const d = row.querySelector(".tdesc");
      const f = v.file && v.file(input);
      if (f) { d.innerHTML = '<span class="fl" data-path="' + UI.esc(f) + '">' + UI.esc(desc) + "</span>"; d.querySelector(".fl").addEventListener("click", () => window.NexusApp && window.NexusApp.openFile(f)); }
      else d.textContent = desc;
      if (v.body) { try { row.querySelector(".tool-body").innerHTML = v.body(input); } catch {} }
    }
    if (status === "auto") row.querySelector(".tstat").textContent = "auto";
    scrollDown();
    return row;
  }
  function toolResult(id, content, isError) {
    const row = R.toolRows.get(id);
    if (!row) return;
    const st = row.querySelector(".tstat");
    st.textContent = isError ? "failed" : "done";
    st.className = "tstat " + (isError ? "err" : "ok");
    const body = row.querySelector(".tool-body");
    if (content && content.trim()) {
      const pre = document.createElement("div");
      pre.className = isError ? "tr-err" : "";
      pre.textContent = content.trim().slice(0, 4000);
      if (body.innerHTML) { const hr = document.createElement("hr"); hr.style.cssText = "border:none;border-top:1px solid var(--line);margin:6px 0"; body.appendChild(hr); }
      body.appendChild(pre);
    }
    if (isError) row.classList.remove("collapsed");
  }
  // Claude captured the screen. Put that exact frame in its tool row (or its
  // own line if the row has gone) so Tucker always sees what was sent.
  function onScreen(m) {
    const src = "/api/screen/last?t=" + (m.at || Date.now());
    const cap = (m.reason ? m.reason + " - " : "") + m.width + "x" + m.height;
    let row = null;
    for (const r of R.toolRows.values()) { const n = r.querySelector(".tname"); if (n && n.textContent === "mcp__nexus__screen") row = r; }
    const img = document.createElement("img");
    img.className = "shot"; img.src = src; img.alt = "screenshot Claude was given"; img.title = cap;
    img.addEventListener("click", () => window.open(src, "_blank"));
    if (row) {
      row.querySelector(".tool-body").appendChild(img);
      row.classList.remove("collapsed");
    } else { const d = addEvent("monitor", "looked at your screen (" + cap + ")"); d.appendChild(img); }
    scrollDown();
  }

  function toolDenied(id) {
    const row = R.toolRows.get(id); if (!row) return;
    const st = row.querySelector(".tstat"); st.textContent = "denied"; st.className = "tstat err";
  }

  // ---- todo panel (TodoWrite) and subagent tasks ----
  const todoPanel = $("todo-panel");
  function paintTodos() {
    const todos = (A && A.todos) || [];
    if (!todos.length) { todoPanel.hidden = true; todoPanel.dataset.empty = "1"; return; }
    todoPanel.dataset.empty = "0";
    const done = todos.filter((t) => t.status === "completed").length;
    todoPanel.hidden = false;
    todoPanel.classList.toggle("collapsed", done === todos.length);
    let html = '<div class="todo-head">' + NexusIcons.svg("check", 12) + "<span>Plan " + done + "/" + todos.length + "</span><span class='spacer'></span>" + NexusIcons.svg("chevronDown", 12) + "</div>";
    for (const t of todos) {
      const ic = t.status === "completed" ? "check" : t.status === "in_progress" ? "arrowRight" : "circle";
      html += '<div class="todo ' + UI.esc(t.status) + '">' + NexusIcons.svg(ic, 12) + "<span>" + UI.esc(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content) + "</span></div>";
    }
    todoPanel.innerHTML = html;
    todoPanel.querySelector(".todo-head").addEventListener("click", () => todoPanel.classList.toggle("collapsed"));
  }
  function onTask(m) {
    endStream();
    const c = R;
    let row = c.taskRows.get(m.id);
    if (!row) {
      row = document.createElement("div"); row.className = "task-row"; c.taskRows.set(m.id, row); append(row);
    }
    if (m.status === "started") {
      row.innerHTML = NexusIcons.svg("sparkles", 14) + '<span class="spin">' + UI.esc(m.description || "subagent working") + "</span><span class='spacer'></span>";
      const stop = document.createElement("button"); stop.className = "ibtn sm"; stop.title = "Stop this task"; stop.innerHTML = NexusIcons.svg("stop", 12);
      stop.addEventListener("click", () => wsSend({ type: "stopTask", taskId: m.id }, c.id));
      row.appendChild(stop);
    } else {
      row.className = "task-row " + (m.status === "completed" ? "done" : "failed");
      const u = m.usage ? "  (" + UI.fmtTok(m.usage.total_tokens || 0) + " tok, " + Math.round((m.usage.duration_ms || 0) / 1000) + "s)" : "";
      row.innerHTML = NexusIcons.svg(m.status === "completed" ? "check" : "alert", 14) + "<span>" + UI.esc((m.summary || m.status).slice(0, 300)) + UI.esc(u) + "</span>";
    }
    scrollDown();
  }

  // ---- permission cards ----
  function addPermission(m) {
    endStream();
    const c = R;
    const div = document.createElement("div");
    div.className = "msg perm";
    div.dataset.id = m.id;
    const inp = m.input || {};
    const v = TOOL_VIEW[m.tool];
    let title = m.tool, body = "", extra = null;
    if (m.tool === "ExitPlanMode") {
      title = "Claude has a plan";
      body = '<div class="perm-plan">' + renderMarkdown(inp.plan || "(plan text arrives in the reply above)") + "</div>";
    } else if (m.tool === "AskUserQuestion") {
      title = "Claude has a question";
      extra = questionForm(inp);
    } else if (m.tool === "Bash" || m.tool === "PowerShell") {
      title = "Run a command";
      body = '<div class="perm-input">' + (inp.description ? '<span class="dim">' + UI.esc(inp.description) + "</span>\n" : "") + UI.esc(inp.command || "") + "</div>";
    } else if (v && v.body) {
      title = m.tool + "  " + (v.desc(inp) || "");
      body = '<div class="perm-input">' + v.body(inp) + "</div>";
    } else {
      title = m.tool + (v ? "  " + (v.desc(inp) || "") : "");
      body = '<div class="perm-input">' + UI.esc(JSON.stringify(inp, null, 1).slice(0, 3000)) + "</div>";
    }
    const isPlan = m.tool === "ExitPlanMode", isQ = m.tool === "AskUserQuestion";
    div.innerHTML = '<div class="perm-tool">' + NexusIcons.svg(isQ ? "chat" : isPlan ? "check" : "shield", 14) + "<span>" + UI.esc(title) + "</span></div>" + body +
      (m.blockedPath ? '<div class="perm-hint">Touches a path outside the allowed folders: ' + UI.esc(m.blockedPath) + "</div>" : "") +
      '<div class="perm-buttons"></div>';
    if (extra) div.insertBefore(extra, div.querySelector(".perm-buttons"));
    const btns = div.querySelector(".perm-buttons");
    const finish = (allow, always, payload) => {
      wsSend(Object.assign({ type: "permission", id: m.id, allow, always }, payload || {}), c.id);
      div.remove(); c.pendingCards.delete(m.id);
      addEvent(allow ? "check" : "x", (allow ? "allowed " : "denied ") + m.tool);
    };
    const mk = (label, cls, fn, title2) => { const b = document.createElement("button"); b.className = "btn sm " + cls; b.textContent = label; if (title2) b.title = title2; b.addEventListener("click", fn); btns.appendChild(b); return b; };
    if (isQ) {
      mk("Answer", "perm-allow", () => {
        const answers = extra.collect();
        if (!answers) { UI.toast("Pick an answer first", "warn"); return; }
        finish(true, false, { updatedInput: { answers } });
      });
      mk("Skip", "perm-deny", () => finish(false, false, { message: "Tucker skipped the question - use your best judgement." }));
    } else if (isPlan) {
      mk("Approve and build", "perm-allow", () => finish(true, false), "Leaves plan mode and starts the work");
      mk("Keep planning", "perm-deny", () => finish(false, false, { message: "Not yet - keep refining the plan. " + (extraNote() || "") }));
    } else {
      mk("Allow", "perm-allow", () => finish(true, false), "Enter");
      if (m.suggestions && m.suggestions.length) mk("Always", "", () => finish(true, true), "Allow and remember for this session");
      mk("Deny", "perm-deny", () => finish(false, false, { message: extraNote() || undefined }), "Escape");
    }
    // Optional note to Claude when denying ("do X instead").
    const note = document.createElement("input"); note.placeholder = "Optional: tell Claude what to do instead"; note.className = "perm-note"; note.style.cssText = "font-size:12px;padding:3px 8px;flex:1;min-width:120px";
    btns.appendChild(note);
    const extraNote = () => note.value.trim();
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(false, false, { message: extraNote() || undefined }); } });
    c.pendingCards.set(m.id, { el: div, finish });
    append(div);
    setDot("action");
  }
  // AskUserQuestion: render each question's options; multiSelect allowed.
  function questionForm(inp) {
    const wrap = document.createElement("div");
    wrap.className = "perm-q-wrap";
    const picks = [];
    for (const q of inp.questions || []) {
      const box = document.createElement("div"); box.className = "perm-q";
      box.innerHTML = '<div class="qtext">' + UI.esc(q.question) + "</div>";
      const chosen = new Set();
      for (const o of q.options || []) {
        const b = document.createElement("button"); b.className = "qopt";
        b.innerHTML = "<span>" + UI.esc(o.label) + "</span>" + (o.description ? '<span class="sub">' + UI.esc(o.description) + "</span>" : "");
        b.addEventListener("click", () => {
          if (q.multiSelect) { if (chosen.has(o.label)) chosen.delete(o.label); else chosen.add(o.label); b.classList.toggle("sel"); }
          else { chosen.clear(); chosen.add(o.label); box.querySelectorAll(".qopt").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); }
        });
        box.appendChild(b);
      }
      const other = document.createElement("input"); other.placeholder = "Or type your own answer"; other.style.cssText = "font-size:12px;padding:3px 8px";
      box.appendChild(other);
      picks.push({ q, chosen, other });
      wrap.appendChild(box);
    }
    wrap.collect = () => {
      const answers = {};
      for (const p of picks) {
        const v = p.other.value.trim() ? p.other.value.trim() : [...p.chosen].join(", ");
        if (!v) return null;
        answers[p.q.question] = v;
      }
      return answers;
    };
    return wrap;
  }
  function permissionResolved(id) { const card = R.pendingCards.get(id); if (card) { card.el.remove(); R.pendingCards.delete(id); } }
  // Enter / Escape answer the oldest pending card when the composer is empty.
  function answerPendingWithKey(allow) {
    const first = A.pendingCards.values().next().value;
    if (!first) return false;
    const btn = first.el.querySelector(allow ? ".perm-allow" : ".perm-deny");
    if (btn) btn.click();
    return true;
  }

  // ---- composer: attachments, menus, history, send ----
  const attachRow = $("attach-row"), cmdMenu = $("cmd-menu");
  // Attachments belong to the active chat, so switching tabs keeps each one's
  // half-written message and its chips intact.
  function renderAttachments() {
    const attachments = A ? A.attachments : [];
    attachRow.innerHTML = "";
    attachRow.hidden = attachments.length === 0;
    attachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.innerHTML = (a.kind === "image" ? '<img src="' + a.url + '" alt="">' : NexusIcons.svg(a.kind === "selection" ? "fileCode" : "file", 13)) +
        '<span class="aname">' + UI.esc(a.name) + "</span>";
      const x = document.createElement("button"); x.className = "ibtn"; x.innerHTML = NexusIcons.svg("x", 12); x.title = "Remove";
      x.addEventListener("click", () => { A.attachments.splice(i, 1); renderAttachments(); });
      chip.appendChild(x);
      attachRow.appendChild(chip);
    });
  }
  function attachFile(path, focusInput) {
    if (!path || !A) return;
    if (!A.attachments.some((a) => a.kind === "file" && a.path === path)) A.attachments.push({ kind: "file", path, name: rel(path) });
    renderAttachments();
    if (focusInput) { showPanel(); input.focus(); }
  }
  function attachSelection(sel) {
    if (!sel || !sel.path || !A) return;
    A.attachments = A.attachments.filter((a) => a.kind !== "selection");
    if (sel.code) A.attachments.push({ kind: "selection", path: sel.path, code: sel.code, from: sel.from, to: sel.to, lang: sel.lang, name: rel(sel.path) + ":" + sel.from + (sel.to !== sel.from ? "-" + sel.to : "") });
    else attachFile(sel.path);
    renderAttachments();
    showPanel(); input.focus();
  }
  function attachImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      A.attachments.push({ kind: "image", name: file.name || "image", media_type: file.type, data: url.split(",")[1], url });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
  // Any pane can hand the composer an image: {name, media_type, data(base64)}.
  function attachImage(img) {
    if (!img || !img.data || !A) return;
    A.attachments.push({ kind: "image", name: img.name || "image", media_type: img.media_type || "image/png",
      data: img.data, url: "data:" + (img.media_type || "image/png") + ";base64," + img.data });
    renderAttachments();
  }
  // Grab the whole desktop and clip it to the message. Native capture through
  // the server (tools/screen.mjs), so there is no getDisplayMedia picker to
  // click through every single time and nothing is hidden behind the browser.
  let shooting = false;
  async function attachScreenshot(display) {
    if (shooting) return null;
    shooting = true;
    UI.toast("Capturing your screen...", "info", 1200);
    try {
      const r = await fetch("/api/screen" + (display != null ? "?display=" + encodeURIComponent(display) : ""));
      // Never hand a non-JSON body to JSON.parse. An older server answers this
      // route with the static 404 "not found", and the parse error that caused
      // was reported to Tucker instead of the actual problem.
      const body = await r.text();
      let j = null;
      try { j = JSON.parse(body); } catch {}
      if (r.status === 404 && !j) throw new Error("this server build has no screen capture - restart Nexus Point");
      if (!j) throw new Error("the server answered " + r.status + ": " + body.slice(0, 120));
      if (!r.ok || !j.data) throw new Error(j.error || "capture failed");
      attachImage({ name: "screen " + j.sourceWidth + "x" + j.sourceHeight, media_type: j.media_type, data: j.data });
      showPanel(); input.focus();
      return j;
    } catch (e) {
      UI.toast("Screen capture failed: " + String(e.message || e), "err", 5000);
      return null;
    } finally { shooting = false; }
  }

  input.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData && e.clipboardData.items || [])].filter((it) => it.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) attachImageFile(it.getAsFile());
  });
  for (const el of [input, logHost]) {
    el.addEventListener("dragover", (e) => { e.preventDefault(); });
    el.addEventListener("drop", (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) attachImageFile(f); });
  }
  $("attach-file").addEventListener("change", (e) => { for (const f of e.target.files) attachImageFile(f); e.target.value = ""; });
  $("attach-btn").addEventListener("click", (e) => {
    const cur = window.NexusApp && window.NexusApp.activeFile();
    UI.popover(e.currentTarget, [
      { label: "Attach the open file", sub: cur ? rel(cur) : "no file open", icon: "file", disabled: !cur, onClick: () => attachFile(cur, true) },
      { label: "Attach the editor selection", icon: "fileCode", disabled: !cur, mk: "Ctrl+K", onClick: () => window.NexusApp && attachSelection(window.NexusApp.activeSelection()) },
      { label: "Attach a project file", sub: "type @ in the box", icon: "search", onClick: () => { input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + "@"; input.focus(); renderCmdMenu(); } },
      { label: "Attach an image", sub: "or paste / drop one", icon: "image", onClick: () => $("attach-file").click() },
      { label: "Attach a shot of my screen", sub: "everything on screen right now", icon: "monitor", onClick: () => attachScreenshot() },
    ]);
  });

  // "/" lists the CLI's own commands; "@" lists project files. Both filter as you type.
  let cmdMatches = [], cmdSel = 0, menuKind = null, fetchingCmds = false;
  function menuQuery() {
    const v = input.value, caret = input.selectionStart;
    const before = v.slice(0, caret);
    if (/^\/[\w:-]*$/.test(before)) return { kind: "cmd", q: before.slice(1).toLowerCase(), start: 0 };
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) return { kind: "file", q: at[1].toLowerCase(), start: caret - at[1].length - 1 };
    return null;
  }
  function renderCmdMenu() {
    const mq = menuQuery();
    if (!mq) { cmdMenu.hidden = true; menuKind = null; return; }
    menuKind = mq;
    if (mq.kind === "cmd" && !COMMANDS.length && !fetchingCmds) { fetchingCmds = true; fetch("/api/commands").then((r) => r.json()).then((c) => { COMMANDS = c || []; fetchingCmds = false; renderCmdMenu(); }).catch(() => { fetchingCmds = false; }); }
    if (mq.kind === "cmd") {
      const local = LOCAL_COMMANDS.map((c) => ({ name: c.name.slice(1), description: c.desc, argumentHint: c.hint || "" }));
      cmdMatches = [...local, ...COMMANDS].filter((c) => c.name.toLowerCase().startsWith(mq.q)).slice(0, 40);
    }
    else {
      const files = window.NexusApp ? window.NexusApp.fileList() : [];
      cmdMatches = files.filter((f) => f.rel.toLowerCase().includes(mq.q)).sort((a, b) => a.rel.length - b.rel.length).slice(0, 40);
    }
    if (!cmdMatches.length) { cmdMenu.hidden = true; return; }
    if (cmdSel >= cmdMatches.length) cmdSel = 0;
    cmdMenu.innerHTML = "";
    cmdMatches.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "cmd-item" + (mq.kind === "file" ? " file" : "") + (i === cmdSel ? " sel" : "");
      if (mq.kind === "cmd") b.innerHTML = '<span class="cmd-name">/' + UI.esc(c.name) + "</span>" + (c.argumentHint ? '<span class="cmd-hint">' + UI.esc(c.argumentHint) + "</span>" : "") + '<span class="cmd-desc">' + UI.esc(c.description || "") + "</span>";
      else b.innerHTML = '<span class="cmd-name">' + UI.esc(c.rel) + "</span>";
      b.addEventListener("click", () => pickMenu(i));
      cmdMenu.appendChild(b);
    });
    cmdMenu.hidden = false;
    if (cmdMenu.children[cmdSel]) cmdMenu.children[cmdSel].scrollIntoView({ block: "nearest" });
  }
  function pickMenu(i) {
    const c = cmdMatches[i], mq = menuKind;
    if (!c || !mq) return;
    if (mq.kind === "cmd") input.value = "/" + c.name + (c.argumentHint ? " " : "");
    else {
      attachFile(c.path);
      input.value = input.value.slice(0, mq.start) + input.value.slice(input.selectionStart);
    }
    cmdMenu.hidden = true; menuKind = null;
    input.focus(); autoGrow();
  }
  input.addEventListener("input", () => { cmdSel = 0; renderCmdMenu(); autoGrow(); });
  // Registered before the send handler, so stopImmediatePropagation keeps Enter
  // from sending a half-typed command name.
  input.addEventListener("keydown", (e) => {
    if (cmdMenu.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { cmdSel = (cmdSel + (e.key === "ArrowDown" ? 1 : cmdMatches.length - 1)) % cmdMatches.length; renderCmdMenu(); }
    else if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) pickMenu(cmdSel);
    else if (e.key === "Escape") { cmdMenu.hidden = true; menuKind = null; }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  });
  function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(200, input.scrollHeight) + "px"; }

  // ---- local slash commands -------------------------------------------------
  // These are Nexus Point's own, not the CLI's. They are expanded to prose HERE,
  // in the browser, and the "/" never leaves it: agent.js treats a leading "/"
  // as a CLI slash command (grep `const isCommand =`), so a forwarded
  // /nexus-repair would be read as one and would also lose the active-project
  // banner. Add a command = append one row.
  const LOCAL_COMMANDS = [
    {
      name: "/nexus-repair",
      hint: "[deep]",
      desc: "Make this project's art and canvas objects editable in Nexus Point",
      expand: (arg, ctx) => {
        const deep = /\bdeep\b/i.test(arg || "");
        return [
          "Run Nexus-Repair on " + (ctx.projectPath || "the open project") + ".",
          "",
          "Read " + ENV.nexus + "/docs/NEXUS-REPAIR.md and follow it exactly. It is the playbook; the",
          "adapter contract it writes against is docs/NEXUS-SCENE-ADAPTER.md beside it.",
          "",
          "Start by calling mcp__nexus__scene_report on " + (ctx.projectPath || "this project") + " - do not grep blind.",
          "Then read that project's own CLAUDE.md and SESSION-HANDOFF.md; its invariants beat anything in the playbook.",
          "",
          deep
            ? "DEEP run: I am asking for the deeper pass as well. Hoist hardcoded visual constants into the registry too, but do it ONE subsystem at a time and tell me what each one changed."
            : "Default run: additive only. Add nexus-scene.js, nexus-design.js and real asset files, and rewire code ONLY where you can prove the swap is identical. Do not hoist constants wholesale and do not tidy anything that was not in the way.",
          "",
          "Back up everything you touch into _backups/nexus-repair-<today>/ before the first write.",
          "Finish with NEXUS-SCENE.md in that project saying what is now editable AND what is not and why,",
          "then load it in the Play tab and confirm a clean console before you tell me it is done.",
        ].join("\n");
      },
    },
  ];
  function expandLocal(text) {
    const t = text.trim();
    for (const c of LOCAL_COMMANDS) {
      if (t.toLowerCase() === c.name || t.toLowerCase().startsWith(c.name + " ")) {
        return c.expand(t.slice(c.name.length).trim(), { projectPath: projectPath(), projectName: projectName() });
      }
    }
    return null;
  }

  // ---- sending, prompt history, composer keys ----
  const promptHistory = JSON.parse(localStorage.getItem("nexus-prompt-history") || "[]");
  let histIdx = promptHistory.length, draft = "";
  function buildMessage() {
    let text = input.value.trim();
    const attachments = A.attachments;
    const files = attachments.filter((a) => a.kind === "file"), sels = attachments.filter((a) => a.kind === "selection"), imgs = attachments.filter((a) => a.kind === "image");
    let ctxText = "";
    if (files.length) ctxText += "Attached files (read them first):\n" + files.map((f) => "- " + f.path).join("\n") + "\n\n";
    for (const s of sels) ctxText += "Selected code from " + s.path + " (lines " + s.from + "-" + s.to + "):\n```" + (s.lang || "") + "\n" + s.code + "\n```\n\n";
    if (!text && !ctxText && !imgs.length) return null;
    const local = expandLocal(text);
    if (local) return { text: local, shown: text, images: [], attach: [] };
    const isCommand = text.startsWith("/");
    const full = isCommand ? text : ctxText + (text || (imgs.length ? "What do you see?" : "Have a look at this."));
    return { text: full, shown: text || (files.length ? "Attached " + files.map((f) => f.name).join(", ") : imgs.length ? "(image)" : "(selection)"), images: imgs.map((i) => ({ media_type: i.media_type, data: i.data })), attach: attachments.slice() };
  }
  function send() {
    const m = buildMessage();
    if (!m) return;
    if (!ws || ws.readyState !== 1) { UI.toast("Claude is not connected yet", "warn"); return; }
    const c = A;
    const uuid = crypto.randomUUID ? crypto.randomUUID() : "u-" + Date.now() + Math.random().toString(36).slice(2);
    wsSend({ type: "chat", text: m.text, project: projectPath(), images: m.images, uuid }, c.id);
    R = c;
    addUserBubble(m.shown, uuid, m.attach, c.busy);
    c.busy = true; setDot("busy");
    if (m.shown && (!promptHistory.length || promptHistory[promptHistory.length - 1] !== m.shown)) { promptHistory.push(m.shown); if (promptHistory.length > 100) promptHistory.shift(); localStorage.setItem("nexus-prompt-history", JSON.stringify(promptHistory)); }
    histIdx = promptHistory.length; draft = "";
    input.value = ""; autoGrow(); c.attachments = []; renderAttachments(); cmdMenu.hidden = true;
    c.suggestion = ""; $("suggestion-row").hidden = true;
    c.stick = true; scrollDown(true);
  }
  function addUserBubble(text, uuid, attach, queued) {
    const div = document.createElement("div");
    div.className = "msg user" + (queued ? " queued" : "");
    div.dataset.uuid = uuid || "";
    div.textContent = text;
    const imgs = (attach || []).filter((a) => a.kind === "image");
    if (imgs.length) { const s = document.createElement("span"); s.className = "uimg"; s.textContent = imgs.length + " image" + (imgs.length > 1 ? "s" : "") + " attached"; div.appendChild(document.createElement("br")); div.appendChild(s); }
    if (uuid) {
      const rw = document.createElement("button"); rw.className = "ibtn sm rewind-btn"; rw.title = "Rewind files to before this message"; rw.innerHTML = NexusIcons.svg("undo", 13);
      const c = R;
      rw.addEventListener("click", () => { const prev = R; R = c; rewindTo(uuid); R = prev; });
      div.appendChild(rw);
    }
    append(div);
  }
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => { if (wsSend({ type: "interrupt" }, A.id)) { R = A; addEvent("stop", "stopped"); } });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!input.value.trim() && !A.attachments.length && answerPendingWithKey(true)) return; send(); }
    else if (e.key === "Escape") { if (!input.value.trim() && answerPendingWithKey(false)) return; if (A.busy) stopBtn.click(); else input.blur(); }
    else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); }
    else if (e.key === "ArrowUp" && !input.value.includes("\n") && input.selectionStart === 0 && promptHistory.length) { e.preventDefault(); if (histIdx === promptHistory.length) draft = input.value; histIdx = Math.max(0, histIdx - 1); input.value = promptHistory[histIdx]; autoGrow(); }
    else if (e.key === "ArrowDown" && histIdx < promptHistory.length) { e.preventDefault(); histIdx = Math.min(promptHistory.length, histIdx + 1); input.value = histIdx === promptHistory.length ? draft : promptHistory[histIdx]; autoGrow(); }
  });
  function rewindTo(uuid) {
    const c = R;
    const handler = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== "rewound" || m.uuid !== uuid || !m.dryRun || m.chat !== c.id) return;
      ws.removeEventListener("message", handler);
      const r = m.result || {};
      if (!r.canRewind) { UI.toast("Can't rewind: " + (r.error || "no checkpoint for that message"), "warn", 5000); return; }
      const n = (r.filesChanged || []).length;
      UI.confirm("Restore " + n + " file" + (n === 1 ? "" : "s") + " to how they were before this message?" + (n ? "\n\n" + r.filesChanged.slice(0, 8).map(rel).join("\n") : ""), { title: "Rewind files", okLabel: "Rewind", danger: true })
        .then((ok) => { if (ok) wsSend({ type: "rewind", uuid }, c.id); });
    };
    ws.addEventListener("message", handler);
    wsSend({ type: "rewind", uuid, dryRun: true }, c.id);
  }

  // ---- status dot + chips (model / mode / effort / usage) ----
  // The dot belongs to a chat; the header shows the active one and every tab
  // shows its own, which is how a background chat says it is still working.
  function setDot(cls, chat) {
    const c = chat || R || A; if (!c) return;
    c.dot = cls;
    if (c === A) paintDot();
    tabDot(c);
  }
  function paintDot() {
    const cls = A ? A.dot : "idle";
    statusDot.className = cls;
    const working = cls === "busy" || cls === "action";
    stopBtn.hidden = !working; sendBtn.hidden = working;
  }
  const MODES = [
    { id: "default", label: "Manual", sub: "Ask before every edit or command" },
    { id: "auto", label: "Auto", sub: "A classifier approves safe actions, asks for the rest" },
    { id: "acceptEdits", label: "Accept edits", sub: "File edits go through; commands still ask" },
    { id: "plan", label: "Plan", sub: "Read-only: Claude proposes a plan first" },
  ];
  const EFFORTS = [["low", "Low", "Fast, cheap, shallow"], ["medium", "Medium", "Everyday work"], ["high", "High", "Thinks harder"], ["xhigh", "Extra high", "Long, careful runs"], ["max", "Max", "Everything it has"]];
  const unavailableModes = new Set();
  let requestedMode = null, modeRejected = false;
  function setModeLabel(id, chat) {
    const c = chat || R || A; if (c) c.mode = id;
    if (c && c !== A) return;
    const m = MODES.find((x) => x.id === id) || MODES[0];
    modeBtn.querySelector("span").textContent = m.label;
    modeBtn.className = "chip mode-" + id;
  }
  function requestMode(id) { requestedMode = id; setModeLabel(id, A); wsSend({ type: "setMode", mode: id }, A.id); }
  function cycleMode() {
    let i = MODES.findIndex((m) => m.id === A.mode);
    for (let n = 0; n < MODES.length; n++) { i = (i + 1) % MODES.length; if (!unavailableModes.has(MODES[i].id)) break; }
    if (MODES[i].id !== A.mode) requestMode(MODES[i].id);
  }
  modeBtn.addEventListener("click", (e) => UI.popover(e.currentTarget, MODES.map((m) => ({ label: m.label, sub: m.sub, checked: m.id === A.mode, disabled: unavailableModes.has(m.id), onClick: () => requestMode(m.id) })).concat([{ sep: true }, { label: "Shift+Tab cycles modes", disabled: true }]), { width: 260 }));
  function setEffortLabel(level, chat) {
    const c = chat || R || A; if (c) c.effort = level;
    if (c && c !== A) return;
    const e = EFFORTS.find((x) => x[0] === level) || EFFORTS[1];
    effortBtn.querySelector("span").textContent = e[1];
  }
  effortBtn.addEventListener("click", (e) => UI.popover(e.currentTarget, EFFORTS.map((x) => ({ label: x[1], sub: x[2], checked: x[0] === A.effort, onClick: () => { setEffortLabel(x[0], A); wsSend({ type: "setEffort", effort: x[0] }, A.id); } })), { width: 220 }));
  function setModelLabel(model, chat) {
    const c = chat || R || A; if (c) c.model = model || "";
    if (c && c !== A) return;
    const m = MODELS.find((x) => x.value === model || x.resolved === model);
    modelBtn.querySelector("span").textContent = m ? m.name : (model || "Model").replace(/^claude-/, "");
  }
  modelBtn.addEventListener("click", (e) => {
    const items = MODELS.length ? MODELS.map((m) => ({ label: m.name, sub: m.description, checked: m.value === A.model || m.resolved === A.model, onClick: () => { setModelLabel(m.value, A); wsSend({ type: "setModel", model: m.value }, A.id); } }))
      : [{ label: "Loading models", disabled: true }];
    UI.popover(e.currentTarget, items, { width: 280 });
    if (!MODELS.length) wsSend({ type: "refreshModels" }, A.id);
  });

  // ---- usage: thin bar + chip; click for the /usage view ----
  const usageFill = $("usage-fill"), usageText = $("usage-text");
  // ctx: a context event for the chat being rendered. With no argument this
  // just repaints the bar from whichever chat is active.
  function paintUsage(ctx) {
    const c = ctx ? (R || A) : A;
    if (!c) return;
    if (ctx) { c.ctxPct = Math.round(ctx.percentage || 0); c.ctxUsed = ctx.used || 0; c.ctxMax = ctx.max || 0; }
    if (c !== A) return;
    usageFill.style.width = Math.min(100, c.ctxPct) + "%";
    usageFill.className = c.ctxPct >= 90 ? "crit" : c.ctxPct >= 70 ? "warn" : "";
    usageText.textContent = c.ctxPct + "%" + (c.sessionCost ? " · $" + c.sessionCost.toFixed(c.sessionCost < 1 ? 3 : 2) : "");
    $("usage-btn").title = "Context " + UI.fmtTok(c.ctxUsed) + " / " + UI.fmtTok(c.ctxMax) + " tokens · session " + UI.fmtTok(c.sessionTok) + " tokens";
  }
  async function showUsage(anchor) {
    const el = document.createElement("div");
    el.style.cssText = "padding:8px 10px;font-size:12px;min-width:250px;display:flex;flex-direction:column;gap:6px";
    el.innerHTML = "<div class='dim'>Loading usage</div>";
    UI.popover(anchor, el, { width: 280 });
    try {
      const q = "?chat=" + encodeURIComponent(A.id);
      const [u, c] = await Promise.all([(await fetch("/api/usage" + q)).json(), (await fetch("/api/context" + q)).json()]);
      const s = u.session || {};
      let html = "<div><b>Context</b> " + UI.fmtTok(c ? c.used : A.ctxUsed) + " / " + UI.fmtTok(c ? c.max : A.ctxMax) + " (" + (c ? Math.round(c.percentage) : A.ctxPct) + "%)</div>";
      if (c && c.categories) html += "<div class='dim' style='font-family:var(--mono);font-size:11px'>" + c.categories.filter((x) => x.tokens > 0).map((x) => UI.esc(x.name) + " " + UI.fmtTok(x.tokens)).join("<br>") + "</div>";
      html += "<div style='border-top:1px solid var(--line);padding-top:6px'><b>This chat</b> " + (s.turns || 0) + " turns, " + UI.fmtTok((s.input || 0) + (s.output || 0)) + " in+out, " + UI.fmtTok(s.cacheRead || 0) + " cached, $" + (s.cost || 0).toFixed(4) + "</div>";
      const rl = u.plan && u.plan.rate_limits;
      if (u.plan && u.plan.rate_limits_available && rl) {
        const win = (w, label) => (w && w.utilization != null) ? "<div>" + label + ": <b>" + Math.round(w.utilization) + "%</b> used" + (w.resets_at ? " <span class='dim'>resets " + new Date(w.resets_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + "</span>" : "") + "</div>" : "";
        html += "<div style='border-top:1px solid var(--line);padding-top:6px'><b>Plan</b>" + (u.plan.subscription_type ? " <span class='dim'>" + UI.esc(u.plan.subscription_type) + "</span>" : "") + win(rl.five_hour, "5-hour") + win(rl.seven_day, "7-day") + "</div>";
      }
      html += "<div style='display:flex;gap:6px;padding-top:4px'><button class='btn sm' id='u-compact'>Compact context</button><button class='btn sm' id='u-ctx'>/context</button></div>";
      el.innerHTML = html;
      el.querySelector("#u-compact").addEventListener("click", () => { UI.close(); input.value = "/compact"; send(); });
      el.querySelector("#u-ctx").addEventListener("click", () => { UI.close(); input.value = "/context"; send(); });
    } catch (err) { el.innerHTML = "<div class='dim'>Usage unavailable: " + UI.esc(err.message) + "</div>"; }
  }
  $("usage-btn").addEventListener("click", (e) => showUsage(e.currentTarget));

  // ---- header: title, new chat, menu; quick actions; notices ----
  const chatTitle = $("chat-title");
  // The header shows the title only when there is a single chat - with tabs open
  // each tab already carries its own name, and two copies of it is clutter.
  function setChatTitle(t, chat) {
    const c = chat || R || A; if (c) c.title = t || "";
    if (c && c !== A) { tabDot(c); return; }
    chatTitle.textContent = t || "";
    chatTitle.hidden = !t || CHATS.size > 1;
    tabDot(c);
  }
  chatTitle.addEventListener("click", () => renameChat(A));
  async function renameChat(c) {
    if (!c || !c.sessionId) return;
    const t = await UI.prompt("Rename this chat", { value: c.title, okLabel: "Rename" });
    if (t == null) return;
    await fetch("/api/chats/" + encodeURIComponent(c.sessionId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t }) });
    setChatTitle(t, c);
  }
  function resetLog() {
    const c = R || A;
    c.pane.innerHTML = ""; c.pane.appendChild(emptyState());
    c.toolRows.clear(); c.taskRows.clear(); c.pendingCards.clear();
    c.live = null; c.liveThink = null; c.liveText = ""; c.liveThinkText = "";
    c.todos = []; c.firstPrompt = ""; c.attachments = [];
    c.ctxPct = 0; c.sessionTok = 0; c.sessionCost = 0;
    c.notice = ""; c.suggestion = "";
    setChatTitle("", c);
    if (c === A) { paintTodos(); paintUsage(); paintRows(); renderAttachments(); }
  }
  $("new-chat-btn").addEventListener("click", () => newChat());
  $("claude-menu-btn").addEventListener("click", (e) => UI.popover(e.currentTarget, [
    { label: "New chat", icon: "plus", sub: "Runs alongside this one", disabled: CHATS.size >= MAX_CHATS, onClick: () => newChat() },
    { label: "Rename chat", icon: "pencil", disabled: !A.sessionId, onClick: () => renameChat(A) },
    { label: "Start over in this tab", icon: "refresh", sub: "Claude forgets this conversation", onClick: async () => {
      if (A.busy && !(await UI.confirm("Claude is still working in this tab. Start over anyway?", { okLabel: "Start over" }))) return;
      if (wsSend({ type: "new" }, A.id)) { R = A; resetLog(); }
    } },
    { label: "Compact context", icon: "compact", sub: "Summarise the chat to free up room", onClick: () => { input.value = "/compact"; send(); } },
    { label: "Clear the view", icon: "x", sub: "Claude keeps its memory", onClick: () => { const t = A.title; R = A; resetLog(); setChatTitle(t, A); } },
    { sep: true },
    { head: "Quick actions" },
    ...QUICK_ACTIONS.map((q) => ({ label: q.label, icon: q.icon, onClick: () => runQuick(q) })),
    { sep: true },
    { label: "Settings", icon: "sliders", onClick: openSettings },
    { label: "Keyboard shortcuts", icon: "info", onClick: showShortcuts },
  ], { width: 250 }));
  function showShortcuts() {
    UI.modal({ title: "Shortcuts", html: "<div class='px-kbd' style='font-size:12.5px'>" + [
      ["Enter", "send  /  Shift+Enter newline"], ["Esc", "stop Claude, or deny the pending card"], ["Shift+Tab", "cycle permission mode"], ["Up / Down", "recall earlier prompts"],
      ["Alt+1..5", "jump to that chat"], ["/", "slash commands"], ["@", "attach a project file"], ["Ctrl+K", "send the editor selection"], ["Ctrl+J", "focus Claude"], ["Ctrl+P", "find a file"], ["Ctrl+Shift+F", "find in files"], ["Ctrl+B", "toggle files"], ["Ctrl+S", "save"],
    ].map((r) => "<kbd>" + UI.esc(r[0]) + "</kbd><span>" + UI.esc(r[1]) + "</span>").join("") + "</div>", okLabel: "Close", cancelLabel: "" }).then(() => {});
  }
  // Quick actions are data: add one = append one row. ctx gives the open project/file.
  const QUICK_ACTIONS = [
    { label: "Explain this project", icon: "info", prompt: (c) => "Give me a short tour of " + (c.projectName || "this project") + ": what it is, how it is structured, and where the important code lives. Read CLAUDE.md and SESSION-HANDOFF.md first if they exist." },
    { label: "Review the open file", icon: "fileCode", needsFile: true, prompt: (c) => "Review " + c.file + " for bugs, dead code and anything that would confuse a future edit. Be concrete: file and function names, and what to change." },
    { label: "Find bugs", icon: "alert", prompt: (c) => "Look for real bugs in " + (c.projectName || "this project") + " (not style). For each one: where it is, how to trigger it, and the smallest fix. Do not change anything yet." },
    { label: "Play-test feedback", icon: "play", prompt: (c) => "Read the game code in " + (c.projectName || "this project") + " and tell me, as a player, what would feel bad or confusing in the first five minutes, and the three changes with the best payoff." },
    { label: "Write handoff notes", icon: "pencil", prompt: () => "Append a dated block to SESSION-HANDOFF.md for this project describing what changed today, how it was verified, and what is still unverified. Absolute dates, greppable code tokens, no line numbers." },
    { label: "Look at my screen", icon: "monitor", screenshot: true, blankOk: true, ask: "What should Claude look at? (blank = just describe it)", prompt: (c, a) => a || "Look at my screen and tell me what you see." },
    { label: "Make this editable in Nexus (Nexus-Repair)", icon: "wrench", prompt: () => "/nexus-repair" },
    { label: "Draw a sprite", icon: "image", ask: "Describe the sprite (size, subject, style, palette)", prompt: (c, a) => "Draw a new sprite in " + (c.projectName || "the project") + ": " + a + ". Use the sprite tool (" + ENV.spriteCli + ") to write it as a PNG in the assets folder, then re-read it with show and check the silhouette reads clearly." },
  ];
  async function runQuick(q) {
    const c = { projectName: projectName(), file: window.NexusApp && window.NexusApp.activeFile() ? rel(window.NexusApp.activeFile()) : null };
    if (q.needsFile && !c.file) { UI.toast("Open a file first", "warn"); return; }
    let a = null;
    if (q.ask) { a = await UI.prompt(q.label, { label: q.ask }); if (a === null || (!a && !q.blankOk)) return; }
    if (q.screenshot && !(await attachScreenshot())) return;
    input.value = q.prompt(c, a); autoGrow(); showPanel(); input.focus();
  }
  function renderQuickActions(host) {
    if (!host) return;
    host.innerHTML = "";
    for (const q of QUICK_ACTIONS) { const b = document.createElement("button"); b.className = "qa"; b.innerHTML = NexusIcons.svg(q.icon, 13) + UI.esc(q.label); b.addEventListener("click", () => runQuick(q)); host.appendChild(b); }
  }
  function showPanel() { const p = $("claude-panel"); if (p.classList.contains("collapsed")) $("toggle-claude").click(); }
  function notice(text, level) { const d = addMsg("notice" + (level === "warn" ? " warn" : ""), text); return d; }
  // The suggestion and rate-limit rows live in the shared composer, so each chat
  // remembers its own text and paintRows() puts the active one back on switch.
  function showSuggestion(text) { const c = R || A; c.suggestion = text || ""; if (c === A) paintRows(); }
  function showRateLimit(info) {
    const c = R || A;
    c.notice = (!info || info.status === "allowed") ? "" :
      (info.status === "rejected" ? "Plan limit reached" : "Nearing the plan limit") +
      (info.utilization != null ? " (" + Math.round(info.utilization) + "% of " + (info.rateLimitType || "window").replace("_", "-") + ")" : "") +
      (info.resetsAt ? ", resets " + new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
    if (c === A) paintRows();
  }
  function paintRows() {
    const sRow = $("suggestion-row"), nRow = $("notice-row");
    const text = A ? A.suggestion : "";
    sRow.innerHTML = ""; sRow.hidden = !text;
    if (text) {
      const b = document.createElement("button"); b.className = "sugg"; b.title = text;
      b.innerHTML = NexusIcons.svg("sparkles", 12) + '<span class="stext">' + UI.esc(text) + "</span>";
      b.addEventListener("click", () => { input.value = text; autoGrow(); input.focus(); A.suggestion = ""; sRow.hidden = true; });
      sRow.appendChild(b);
    }
    const n = A ? A.notice : "";
    nRow.hidden = !n;
    nRow.innerHTML = n ? '<span class="notice">' + NexusIcons.svg("alert", 12) + UI.esc(n) + "</span>" : "";
  }

  // ---- the tab strip: one row, only when there is more than one chat ----
  // Tabs share the width evenly and truncate, so five of them still fit a 380px
  // panel; the strip is hidden entirely at one chat, which leaves the single-chat
  // sidebar exactly as it was.
  function tabDot(c) {
    if (!c || !c.tabEl) return;
    c.tabEl.querySelector(".cdot").className = "cdot " + c.dot;
    c.tabEl.classList.toggle("unread", !!c.unread);
    c.tabEl.classList.toggle("active", c === A);
    const label = c.title || "New chat";
    c.tabEl.querySelector(".clabel").textContent = label;
    c.tabEl.title = label + (c.busy ? " - working" : "");
  }
  function renderTabs() {
    tabsHost.innerHTML = "";
    tabsHost.hidden = CHATS.size < 2;
    chatTitle.hidden = !A || !A.title || CHATS.size > 1;
    if (CHATS.size < 2) { for (const c of CHATS.values()) c.tabEl = null; return; }
    for (const c of CHATS.values()) {
      const b = document.createElement("button");
      b.className = "ctab";
      b.innerHTML = '<span class="cdot"></span><span class="clabel"></span>';
      b.addEventListener("click", () => activate(c.id));
      const x = document.createElement("span");
      x.className = "cclose"; x.innerHTML = NexusIcons.svg("x", 11);
      x.addEventListener("click", (e) => { e.stopPropagation(); closeChat(c.id); });
      b.appendChild(x);
      c.tabEl = b;
      tabDot(c);
      tabsHost.appendChild(b);
    }
    const add = document.createElement("button");
    add.className = "ctab-add";
    add.title = CHATS.size >= MAX_CHATS ? "Five chats is the limit" : "New chat";
    add.innerHTML = NexusIcons.svg("plus", 13);
    add.disabled = CHATS.size >= MAX_CHATS;
    add.addEventListener("click", () => newChat());
    tabsHost.appendChild(add);
  }
  // Switching is instant: every chat keeps its own live DOM, so nothing is
  // re-rendered - the panes swap and the shared chrome is repainted from A.
  function activate(id) {
    const c = CHATS.get(id);
    if (!c) return;
    if (A === c) { c.unread = false; tabDot(c); return; }
    if (A) { A.draft = input.value; A.pane.hidden = true; }
    A = c; R = c;
    c.unread = false;
    c.pane.hidden = false;
    input.value = c.draft || ""; autoGrow();
    cmdMenu.hidden = true;
    renderAttachments();
    setModeLabel(c.mode, c); setEffortLabel(c.effort, c); setModelLabel(c.model, c);
    paintDot(); paintUsage(); paintTodos(); paintRows();
    chatTitle.textContent = c.title; 
    renderTabs();
    scrollDown(true);
  }
  function newChat(resume) {
    if (CHATS.size >= MAX_CHATS) { UI.toast("Five chats at once is the limit - close one first", "warn"); return null; }
    const c = makeChat("c" + (chatSeq + 1));
    wsSend({ type: "open", resume: resume || undefined }, c.id);
    activate(c.id);
    showPanel(); input.focus();
    return c;
  }
  async function closeChat(id) {
    const c = CHATS.get(id);
    if (!c || CHATS.size < 2) return;
    if (c.busy && !(await UI.confirm("Claude is still working in that chat. Close it anyway?", { okLabel: "Close", danger: true }))) return;
    wsSend({ type: "close" }, id);
    const wasActive = c === A;
    const ids = [...CHATS.keys()];
    const next = ids[Math.max(0, ids.indexOf(id) - 1)] === id ? ids[1] : ids[Math.max(0, ids.indexOf(id) - 1)];
    c.pane.remove();
    CHATS.delete(id);
    if (wasActive) { A = null; activate(next); }
    renderTabs();
  }
  // Alt+1..5 jumps straight to a chat (Ctrl+N is the browser's).
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const n = parseInt(e.key, 10);
    if (!n || n < 1 || n > MAX_CHATS) return;
    const id = [...CHATS.keys()][n - 1];
    if (id) { e.preventDefault(); activate(id); showPanel(); }
  });

  // ---- history drawer ----
  const historyDrawer = $("history-drawer"), historyList = $("history-list"), historyTranscript = $("history-transcript");
  const historyBack = $("history-back"), historyClose = $("history-close"), historyResume = $("history-resume"), historyFilter = $("history-filter");
  const composer = $("composer"), settingsDrawer = $("settings-drawer");
  let chats = [], historyOpenId = null, historyOpenMsgs = [];
  function showDrawer(which) {
    historyDrawer.hidden = which !== "history"; settingsDrawer.hidden = which !== "settings";
    logHost.hidden = !!which; composer.hidden = !!which; tabsHost.hidden = !!which || CHATS.size < 2;
    todoPanel.hidden = !!which || todoPanel.dataset.empty === "1";
  }
  async function openHistory() {
    showDrawer("history");
    historyTranscript.hidden = true; historyBack.hidden = true; historyResume.hidden = true; historyList.hidden = false; $("history-search").hidden = false;
    $("history-drawer-title").textContent = "Past chats";
    historyList.textContent = "Loading";
    try { chats = await (await fetch("/api/chats")).json(); renderHistory(); }
    catch (err) { historyList.textContent = "Couldn't load past chats: " + err.message; }
  }
  function renderHistory() {
    const q = historyFilter.value.trim().toLowerCase();
    historyList.innerHTML = "";
    const list = chats.filter((c) => !q || c.summary.toLowerCase().includes(q));
    if (!list.length) { historyList.innerHTML = '<div class="empty-hint">' + (chats.length ? "No chats match." : "No past chats yet.") + "</div>"; return; }
    for (const c of list) {
      const item = document.createElement("div");
      item.className = "history-item";
      const when = new Date(c.lastModified);
      const ago = Date.now() - when < 864e5 ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : when.toLocaleDateString([], { month: "short", day: "numeric" });
      item.innerHTML = '<div class="hbody"><span class="history-summary">' + UI.esc(c.summary) + '</span><span class="history-date">' + ago + (c.size ? " · " + UI.fmtBytes(c.size) : "") + "</span></div>";
      const ren = document.createElement("button"); ren.className = "ibtn sm"; ren.title = "Rename"; ren.innerHTML = NexusIcons.svg("pencil", 12);
      ren.addEventListener("click", async (e) => { e.stopPropagation(); const t = await UI.prompt("Rename chat", { value: c.titled ? c.summary : "", okLabel: "Rename" }); if (t == null) return; await fetch("/api/chats/" + encodeURIComponent(c.id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t }) }); c.summary = t || c.summary; c.titled = !!t; renderHistory(); });
      const del = document.createElement("button"); del.className = "ibtn sm"; del.title = "Delete"; del.innerHTML = NexusIcons.svg("trash", 12);
      del.addEventListener("click", async (e) => { e.stopPropagation(); if (!(await UI.confirm("Delete this chat transcript?", { okLabel: "Delete", danger: true }))) return; await fetch("/api/chats/" + encodeURIComponent(c.id), { method: "DELETE" }); chats = chats.filter((x) => x.id !== c.id); renderHistory(); });
      item.append(ren, del);
      item.addEventListener("click", () => openTranscript(c));
      historyList.appendChild(item);
    }
  }
  historyFilter.addEventListener("input", renderHistory);
  async function openTranscript(c) {
    historyList.hidden = true; $("history-search").hidden = true; historyBack.hidden = false; historyResume.hidden = false;
    historyOpenId = c.id; historyOpenMsgs = [];
    $("history-drawer-title").textContent = c.summary.slice(0, 40);
    historyTranscript.hidden = false; historyTranscript.innerHTML = "Loading";
    try {
      const msgs = await (await fetch("/api/chats/" + encodeURIComponent(c.id))).json();
      historyOpenMsgs = msgs;
      historyTranscript.innerHTML = "";
      for (const msg of msgs) {
        const div = document.createElement("div");
        if (msg.role === "tool") { div.className = "msg event"; div.innerHTML = NexusIcons.svg("wrench", 12) + "<span>" + UI.esc(msg.name + " " + ((TOOL_VIEW[msg.name] && TOOL_VIEW[msg.name].desc(msg.input || {})) || "")) + "</span>"; }
        else { div.className = "msg " + (msg.role === "assistant" ? "assistant" : "user"); if (msg.role === "assistant") div.innerHTML = renderMarkdown(msg.text); else div.textContent = msg.text; }
        historyTranscript.appendChild(div);
      }
      if (!msgs.length) historyTranscript.textContent = "(empty transcript)";
    } catch (err) { historyTranscript.textContent = "Couldn't load transcript: " + err.message; }
  }
  $("history-btn").addEventListener("click", () => (historyDrawer.hidden ? openHistory() : showDrawer(null)));
  historyBack.addEventListener("click", () => { historyTranscript.hidden = true; historyBack.hidden = true; historyResume.hidden = true; historyList.hidden = false; $("history-search").hidden = false; $("history-drawer-title").textContent = "Past chats"; });
  historyClose.addEventListener("click", () => showDrawer(null));
  // Resume opens the past chat in its OWN tab, so whatever is running in the
  // current one is left alone. The server restarts that tab's query with
  // resume=<id> and the transcript is repainted, so what you see matches what
  // Claude now has in context.
  historyResume.addEventListener("click", () => {
    if (!historyOpenId) return;
    const target = newChat(historyOpenId);
    if (!target) return;
    R = target;
    resetLog();
    for (const msg of historyOpenMsgs) { if (msg.role === "assistant") addMsg("assistant", msg.text); else if (msg.role === "user") addUserBubble(msg.text); }
    const c = chats.find((x) => x.id === historyOpenId);
    if (c) setChatTitle(c.summary.slice(0, 40), target);
    renderTabs();
    showDrawer(null);
  });

  // ---- settings drawer ----
  const KNOWN_TOOLS = ["Read", "Glob", "Grep", "TodoWrite", "WebSearch", "WebFetch", "Task", "TaskOutput", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Skill", "mcp__nexus__screen", "mcp__nexus__screen_displays"];
  let autoAllowSet = new Set();
  async function openSettings() {
    showDrawer("settings");
    try {
      const cur = await (await fetch("/api/settings?chat=" + encodeURIComponent(A.id))).json();
      $("extra-prompt").value = cur.extraPrompt || "";
      autoAllowSet = new Set(cur.autoAllow || []);
      const host = $("auto-allow"); host.innerHTML = "";
      for (const t of [...new Set([...KNOWN_TOOLS, ...autoAllowSet])]) {
        const b = document.createElement("button"); b.className = "chip" + (autoAllowSet.has(t) ? " on" : ""); b.textContent = t;
        b.addEventListener("click", () => { if (autoAllowSet.has(t)) autoAllowSet.delete(t); else autoAllowSet.add(t); b.classList.toggle("on"); });
        host.appendChild(b);
      }
    } catch {}
    try { const a = await (await fetch("/api/account")).json(); $("account-info").textContent = a && (a.email || a.subscriptionType) ? [a.email, a.subscriptionType, a.organization].filter(Boolean).join(" · ") : "Subscription login (no API key)"; } catch { $("account-info").textContent = "unknown"; }
    try { const m = await (await fetch("/api/mcp")).json(); $("mcp-info").textContent = m.length ? m.map((s) => s.name + " (" + s.status + ")").join(", ") : "none configured"; } catch { $("mcp-info").textContent = "unknown"; }
  }
  $("settings-close").addEventListener("click", () => showDrawer(null));
  $("settings-save").addEventListener("click", async () => {
    try {
      await fetch("/api/settings?chat=" + encodeURIComponent(A.id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: A.model, extraPrompt: $("extra-prompt").value, autoAllow: [...autoAllowSet] }) });
      showDrawer(null); UI.toast("Settings saved", "ok");
    } catch (err) { UI.toast("Settings failed: " + err.message, "err"); }
  });

  // ---- WebSocket ----
  // One socket carries every chat. m.chat names the tab an event belongs to, so
  // R is pointed at that chat for the duration of the event and put back after.
  const UNREAD_ON = new Set(["assistant", "permission", "done", "error", "local", "notice"]);
  function adoptTranscript(c) {
    if (!c.sessionId) return;
    fetch("/api/chats/" + encodeURIComponent(c.sessionId)).then((r) => r.json()).then((msgs) => {
      if (!Array.isArray(msgs) || !msgs.length) return;
      const prev = R; R = c;
      resetLog();
      for (const msg of msgs) {
        if (msg.role === "assistant") addMsg("assistant", msg.text);
        else if (msg.role === "user") addUserBubble(msg.text);
        else if (msg.role === "tool") { let d = ""; try { d = (TOOL_VIEW[msg.name] && TOOL_VIEW[msg.name].desc(msg.input || {})) || ""; } catch {} addEvent("wrench", msg.name + " " + d); }
      }
      const first = msgs.find((x) => x.role === "user");
      if (first && first.text) setChatTitle(first.text.slice(0, 40), c);
      c.stick = true; if (c === A) scrollDown(true);
      R = prev;
    }).catch(() => {});
  }
  // The server's list of live chats. On a fresh page load the tabs are rebuilt
  // from it (with each transcript repainted) so a reload never orphans a running
  // chat; on a reconnect it tells us which of ours the server lost.
  function onLive(m) {
    const serverIds = new Set((m.chats || []).map((c) => c.id));
    if (CHATS.size === 0) {
      const list = (m.chats && m.chats.length) ? m.chats : [{ id: "c1" }];
      for (const info of list) {
        const c = makeChat(info.id);
        c.sessionId = info.sessionId || null;
        c.busy = !!info.busy;
        c.dot = info.busy ? "busy" : "ready";
        if (info.model) c.model = info.model;
        if (info.mode) c.mode = info.mode;
        if (info.effort) c.effort = info.effort;
      }
      if (!serverIds.size) wsSend({ type: "open" }, "c1");
      activate([...CHATS.keys()][0]);
      renderTabs();
      for (const c of CHATS.values()) adoptTranscript(c);
      return;
    }
    for (const c of CHATS.values()) {
      if (serverIds.has(c.id)) continue;
      R = c;
      addEvent("alert", "the server restarted - this tab has a fresh Claude session");
      wsSend({ type: "open" }, c.id);
    }
    R = A;
    renderTabs();
  }
  function connect() {
    ws = new WebSocket("ws://" + location.host);
    ws.addEventListener("open", () => { if (A) setDot("ready", A); });
    ws.addEventListener("close", () => { for (const c of CHATS.values()) setDot("idle", c); setTimeout(connect, 2000); });
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      switch (m.type) {
        case "live": onLive(m); return;
        case "models": MODELS = m.models || []; if (A) setModelLabel(A.model, A); return;
        case "commands": COMMANDS = m.commands || []; renderCmdMenu(); return;
        case "account": ACCOUNT = m.account; return;
        case "auto-allow": return;
        case "opened": { const c = CHATS.get(m.chat); if (c && m.sessionId) c.sessionId = m.sessionId; return; }
        case "closed": return;
      }
      const target = m.chat ? CHATS.get(m.chat) : A;
      if (!target) return;
      R = target;
      handleEvent(m, target);
      if (target !== A && UNREAD_ON.has(m.type)) target.unread = true;
      tabDot(target);
      R = A;
    });
  }
  function handleEvent(m, c) {
      switch (m.type) {
        case "user": // echoed for other browser tabs; this one already drew its bubble
          if (!c.pane.querySelector('.msg.user[data-uuid="' + m.uuid + '"]')) addUserBubble(m.text, m.uuid, null, m.queued);
          if (!c.firstPrompt && m.text) { c.firstPrompt = m.text; setChatTitle(m.text.slice(0, 40), c); }
          c.busy = true; setDot("busy", c); break;
        case "stream-start": c.pane.querySelectorAll(".msg.user.queued").forEach((el) => el.classList.remove("queued")); setDot("busy", c); break;
        case "block-start": if (m.kind === "text" && c.live && c.liveText) { paintLive(c); c.live.classList.remove("streaming"); c.live = null; c.liveText = ""; } break;
        case "delta": onDelta(m.kind, m.text); setDot("busy", c); break;
        case "stream-end": endStream(); break;
        case "assistant": finishAssistant(m.text); break;
        case "thinking": finishThinking(m.text); break;
        case "tool-pending": toolRow(m.id, m.name, null); break;
        case "tool": toolRow(m.id, m.name, m.input, m.status); break;
        case "tool-result": toolResult(m.id, m.content, m.isError); break;
        case "tool-denied": toolDenied(m.id); break;
        case "files-changed": window.dispatchEvent(new CustomEvent("nexus-files-changed", { detail: { paths: m.paths } })); break;
        case "permission": addPermission(m); break;
        case "permission-resolved": permissionResolved(m.id); if (!c.pendingCards.size) setDot(c.busy ? "busy" : "ready", c); break;
        case "status":
          if (m.text === "compacting") addEvent("compact", "compacting context");
          else if (m.text === "retry") addEvent("clock", "API retry " + m.attempt + "/" + m.max + (m.error ? " (" + m.error + ")" : ""));
          else if (m.text === "idle") { c.busy = false; setDot("ready", c); }
          else setDot("busy", c);
          break;
        case "state": if (m.state === "idle") { c.busy = false; setDot(c.pendingCards.size ? "action" : "ready", c); } else if (m.state === "requires_action") setDot("action", c); else setDot("busy", c); break;
        case "done":
          endStream(); c.busy = false; setDot("ready", c);
          if (m.isError && m.errors && m.errors.length) addMsg("error", m.errors.join(String.fromCharCode(10)));
          else if (m.subtype && m.subtype !== "success") addMsg("error", "Turn ended: " + m.subtype);
          if (c !== A) UI.toast((c.title || "A background chat") + " finished", "ok", 3500);
          window.dispatchEvent(new Event("claude-done"));
          break;
        case "model": setModelLabel(m.model, c); break;
        case "mode": setModeLabel(m.mode, c); if (modeRejected && c === A) { modeRejected = false; cycleMode(); } break;
        case "effort": setEffortLabel(m.effort, c); break;
        case "ready": c.sessionId = m.sessionId || c.sessionId; setDot("ready", c); if (m.mode) setModeLabel(m.mode, c); if (m.effort) setEffortLabel(m.effort, c); if (m.model) setModelLabel(m.model, c); break;
        case "session": c.sessionId = m.sessionId || null; c.busy = !!m.busy; setDot(c.busy ? "busy" : "ready", c); break;
        case "context": paintUsage(m); break;
        case "usage": { const u = m.session || {}; c.sessionTok = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0); c.sessionCost = u.cost || 0; paintUsage(); break; }
        case "local": addMsg("local", m.text); break;
        case "compact": addEvent("compact", "context compacted " + UI.fmtTok(m.pre) + " to " + UI.fmtTok(m.post) + (m.trigger === "auto" ? " (automatic)" : "")); break;
        case "screen": onScreen(m); break;
        case "task": onTask(m); break;
        case "notice": notice(m.text, m.level); break;
        case "suggestion": showSuggestion(m.text); break;
        case "rate-limit": showRateLimit(m.info); break;
        case "rewound": if (!m.dryRun) { const r = m.result || {}; if (r.canRewind) { addEvent("undo", "rewound " + (r.filesChanged || []).length + " file(s)"); window.dispatchEvent(new CustomEvent("nexus-files-changed", { detail: { paths: r.filesChanged || [] } })); } else UI.toast("Rewind failed: " + (r.error || "unknown"), "err"); } break;
        case "resumed": addEvent("history", "resumed that chat - Claude has it in context again"); break;
        case "new": resetLog(); addEvent("plus", "new chat"); break;
        case "settings-applied": addEvent("sliders", m.restarted ? "settings saved, fresh Claude session" : "settings saved"); break;
        case "error":
          if (/change mode/i.test(m.text) && requestedMode) { unavailableModes.add(requestedMode); requestedMode = null; modeRejected = true; }
          addMsg("error", m.text); c.busy = false; setDot("ready", c);
          break;
      }
  }

  // ---- public API for the other panes ----
  window.NexusChat = {
    // Drop a prepared prompt in the box (autoSend=false) or send it straight away.
    ask(text, autoSend = true) { showPanel(); input.value = text; autoGrow(); if (autoSend) send(); else input.focus(); },
    attachFile, attachSelection, attachImage, attachScreenshot,
    isReady: () => !!ws && ws.readyState === 1,
    focus: () => { showPanel(); input.focus(); },
    isBusy: () => !!(A && A.busy),
    newChat: () => newChat(),
    chats: () => [...CHATS.values()].map((c) => ({ id: c.id, title: c.title, busy: c.busy, active: c === A })),
  };
  autoGrow();
  connect();
})();
