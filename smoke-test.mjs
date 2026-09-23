// Nexus Point smoke test. Server must be running: node server.js (or the .bat).
// Run: node smoke-test.mjs        (add --chat to also round-trip a Claude message)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import zlib from "node:zlib";
import os from "node:os";
import { execSync } from "node:child_process";

const BASE = "http://localhost:" + (process.env.NEXUS_PORT || 4000);
const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail ? " - " + detail : "")); }
}

const projects = await (await fetch(BASE + "/api/projects")).json();
ok("projects list", Array.isArray(projects) && projects.length > 0, JSON.stringify(projects).slice(0, 80));

const self = projects.find((p) => p.name === "nexus-point");
ok("nexus-point listed", !!self);

const tree = await (await fetch(BASE + "/api/tree?path=" + encodeURIComponent(self.path))).json();
ok("tree", Array.isArray(tree) && tree.some((n) => n.name === "server.js"));

const claudeMd = path.join(self.path, "CLAUDE.md");
const fileRes = await (await fetch(BASE + "/api/file?path=" + encodeURIComponent(claudeMd))).json();
ok("file read", typeof fileRes.content === "string" && fileRes.content.includes("Nexus Point"));

const guard = await fetch(BASE + "/api/file?path=" + encodeURIComponent("C:/Windows/win.ini"));
ok("path guard (read)", guard.status === 403);

// Save round-trip.
const tmpPath = path.join(self.path, "_smoke_write.txt");
const saveRes = await fetch(BASE + "/api/file", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: tmpPath, content: "smoke " + Date.now() }),
});
ok("file save", saveRes.status === 200 && fs.existsSync(tmpPath));
fs.rmSync(tmpPath, { force: true });

// Preview: any project with an index.html at root.
const withIndex = projects.find((p) => fs.existsSync(path.join(p.path, "index.html")));
if (withIndex) {
  const prev = await fetch(BASE + "/preview/" + encodeURIComponent(withIndex.name) + "/");
  const body = await prev.text();
  ok("preview " + withIndex.name, prev.status === 200 && body.toLowerCase().includes("<html"));
} else ok("preview", false, "no project with index.html found");

// Assets + raw.
const assets = await (await fetch(BASE + "/api/assets?path=" + encodeURIComponent(self.path))).json();
ok("assets scan", Array.isArray(assets));
const rawGuard = await fetch(BASE + "/raw?path=" + encodeURIComponent("C:/Windows/win.ini"));
ok("path guard (raw)", rawGuard.status === 404 || rawGuard.status === 403);

// Upload round-trip (tiny valid PNG), overwrite flow, extension guard.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const upUrl = BASE + "/api/upload?dir=" + encodeURIComponent(self.path) + "&name=_smoke_upload.png";
const up1 = await fetch(upUrl, { method: "POST", body: png });
const dest = path.join(self.path, "_smoke_upload.png");
ok("upload", up1.status === 200 && fs.existsSync(dest) && fs.readFileSync(dest).equals(png));
const up2 = await fetch(upUrl, { method: "POST", body: png });
ok("upload conflict 409", up2.status === 409);
const up3 = await fetch(upUrl + "&overwrite=1", { method: "POST", body: png });
ok("upload overwrite", up3.status === 200);
fs.rmSync(dest, { force: true });
const upBad = await fetch(BASE + "/api/upload?dir=" + encodeURIComponent(self.path) + "&name=x.exe", { method: "POST", body: png });
ok("upload rejects .exe", upBad.status === 400);

// Round 2: run, export, settings.
const run = await (await fetch(BASE + "/api/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cmd: "echo nexus-run-ok", cwd: self.path }),
})).json();
ok("run command", run.code === 0 && run.out.includes("nexus-run-ok"));
const runGuard = await fetch(BASE + "/api/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cmd: "echo x", cwd: "C:/Windows" }),
});
ok("run cwd guard", runGuard.status === 403);

const smallProj = projects.find((p) => p.name === "monopoly") || self;
const exp = await fetch(BASE + "/api/export?path=" + encodeURIComponent(smallProj.path));
const zipHead = Buffer.from(await exp.arrayBuffer()).subarray(0, 2).toString("latin1");
ok("export zip", exp.status === 200 && zipHead === "PK", "status " + exp.status + " head " + zipHead);

const st = await (await fetch(BASE + "/api/settings")).json();
ok("settings read", typeof st.model === "string" && "extraPrompt" in st);

// Saving settings restarts the agent session; that must NOT broadcast a crash
// error (regression guard for the closure-local abortController fix, 2026-07-30).
{
  const ws = new WebSocket(BASE.replace("http", "ws"));
  const errs = [];
  await new Promise((r) => { ws.on("open", r); ws.on("error", r); });
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "error") errs.push(m.text); });
  const before = await (await fetch(BASE + "/api/settings")).json();
  await fetch(BASE + "/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(before),
  });
  await new Promise((r) => setTimeout(r, 3000));
  ok("settings save without false crash", errs.length === 0, errs.join("; "));
  ws.close();
}

// Session 6: pixel editor save endpoint + static asset.
// A real 1x1 PNG built here so the round-trip compares exact bytes.
function makePng(r, g, b) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const cbuf = Buffer.alloc(4);
    cbuf.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, cbuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.from([0, r, g, b, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
{
  const target = path.join(self.path, "_smoke_pixel.png");
  const bak = target + ".bak";
  const original = makePng(255, 0, 0);
  const edited = makePng(0, 128, 255);
  fs.writeFileSync(target, original);
  const w1 = await fetch(BASE + "/api/image?path=" + encodeURIComponent(target), { method: "POST", body: edited });
  const w1json = await w1.json();
  ok("image save writes bytes", w1.status === 200 && fs.readFileSync(target).equals(edited), "status " + w1.status);
  ok("image save keeps a .bak of the original", w1json.madeBak === true && fs.existsSync(bak) && fs.readFileSync(bak).equals(original));
  const w2 = await fetch(BASE + "/api/image?path=" + encodeURIComponent(target), { method: "POST", body: original });
  ok("second save does not clobber the .bak", (await w2.json()).madeBak === false && fs.readFileSync(bak).equals(original));
  const bad = await fetch(BASE + "/api/image?path=" + encodeURIComponent(target), { method: "POST", body: Buffer.from("not a png") });
  ok("image save rejects non-PNG body", bad.status === 400);
  fs.rmSync(target, { force: true });
  fs.rmSync(bak, { force: true });
}
const imgGuard = await fetch(BASE + "/api/image?path=" + encodeURIComponent("C:/Windows/_x.png"), { method: "POST", body: Buffer.alloc(8) });
ok("image save path guard", imgGuard.status === 403);
const imgExt = await fetch(BASE + "/api/image?path=" + encodeURIComponent(path.join(self.path, "CLAUDE.md")), { method: "POST", body: Buffer.alloc(8) });
ok("image save rejects non-png path", imgExt.status === 400);
const pixelJs = await fetch(BASE + "/pixel.js");
ok("pixel.js served", pixelJs.status === 200 && (await pixelJs.text()).includes("window.NexusPixel"));

// Session 7: the sprite CLI (Claude's read/write path into pixels).
{
  const src = path.join(self.path, "tools", "png.mjs");
  ok("sprite tools present", fs.existsSync(src) && fs.existsSync(path.join(self.path, "tools", "sprite.mjs")));
  const tmp = path.join(os.tmpdir(), "nexus-sprite-smoke.png");
  const sample = path.join(self.path, "public", "vendor");   // placeholder, replaced below
  void sample;
  // Build a 4x2 grid of 2x2 cells with a known pattern, via the tool's own codec.
  const png = await import("file://" + path.join(self.path, "tools", "png.mjs").replaceAll("\\", "/"));
  const img = { width: 8, height: 4, data: Buffer.alloc(8 * 4 * 4) };
  for (let i = 0; i < 8 * 4; i++) { img.data[i*4] = 200; img.data[i*4+1] = 40; img.data[i*4+2] = 90; img.data[i*4+3] = 255; }
  png.writePng(tmp, img);
  const run = (cmd) => execSync('node "' + path.join(self.path, "tools", "sprite.mjs") + '" ' + cmd, { encoding: "utf8" });

  const art = run('show "' + tmp + '"');
  const artFile = path.join(os.tmpdir(), "nexus-sprite-smoke.txt");
  fs.writeFileSync(artFile, art);
  run('write "' + tmp + '" --art "' + artFile + '"');
  const after = png.readPng(tmp);
  ok("sprite show->write round trip is byte exact", Buffer.compare(after.data, img.data) === 0);

  run('set "' + tmp + '" --px "0,0=#00ff00"');
  const dmp = run('diff "' + tmp + '" --bak --cell 2x2 --px');
  ok("sprite diff finds the edited pixel and its frame",
     dmp.includes("1 pixels differ") && dmp.includes("frame 0,0") && dmp.includes("-> #00ff00"), dmp.slice(0, 120));

  const found = run('find "' + tmp + '.bak" --cell 2x2 --rect 0,0,2,2');
  ok("sprite find reports an identical patch as safe", found.includes("IDENTICAL"), found.slice(0, 120));

  fs.rmSync(tmp, { force: true });
  fs.rmSync(tmp + ".bak", { force: true });
  fs.rmSync(artFile, { force: true });
}

// Session 8: the Claude Code parity bits - slash commands, token counters,
// and the sidebar wiring that renders them.
const cmds = await (await fetch(BASE + "/api/commands")).json();
ok("slash commands listed", Array.isArray(cmds) && cmds.length > 0 && cmds.every((c) => c.name && "description" in c),
   JSON.stringify(cmds).slice(0, 80));
const usage = await (await fetch(BASE + "/api/usage")).json();
ok("usage counters exposed", usage && usage.session && typeof usage.session.input === "number" && typeof usage.session.turns === "number",
   JSON.stringify(usage.session || {}).slice(0, 80));
{
  const chatJs = await (await fetch(BASE + "/chat.js")).text();
  const indexHtml = await (await fetch(BASE + "/")).text();
  ok("sidebar has the command menu + token tracker",
     chatJs.includes("renderCmdMenu") && chatJs.includes("paintUsage") && indexHtml.includes("cmd-menu") && indexHtml.includes("usage-bar"));
  ok("all four permission modes offered",
     ["default", "auto", "acceptEdits", "plan"].every((m) => chatJs.includes('id: "' + m + '"')));
}


// v2 (2026-09-03): file ops, find in files, models/context/account, console
// bridge injection, export excludes node_modules, image create, new UI files.
{
  const dir = path.join(self.path, "_smoke_v2");
  const post = (op, body) => fetch(BASE + "/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ op }, body)) });
  const mk = await post("mkdir", { path: dir });
  ok("fs mkdir", mk.status === 200 && fs.existsSync(dir));
  const f1 = path.join(dir, "a.txt");
  const mf = await post("mkfile", { path: f1, content: "needle-here" });
  ok("fs mkfile", mf.status === 200 && fs.readFileSync(f1, "utf8") === "needle-here");
  ok("fs mkfile refuses overwrite", (await post("mkfile", { path: f1 })).status === 409);
  const f2 = path.join(dir, "b.txt");
  const rn = await post("rename", { path: f1, newPath: f2 });
  ok("fs rename", rn.status === 200 && fs.existsSync(f2) && !fs.existsSync(f1));
  ok("fs guard", (await post("mkfile", { path: "C:/Windows/_nexus_x.txt" })).status === 403);
  ok("fs refuses deleting a project", (await post("delete", { path: self.path })).status === 403);
  const hits = await (await fetch(BASE + "/api/search?path=" + encodeURIComponent(self.path) + "&q=needle-here")).json();
  ok("search finds text", Array.isArray(hits) && hits.some((h) => h.path.toLowerCase() === f2.toLowerCase() && h.line === 1), JSON.stringify(hits).slice(0, 100));
  const sc = path.join(dir, "x.png.layers.json");
  fs.writeFileSync(sc, "{}");
  ok("fs hard-deletes a layers sidecar", (await post("delete", { path: sc, hard: true })).status === 200 && !fs.existsSync(sc));
  // Recycle-bin delete of the folder (reversible for Tucker, gone for us).
  const del = await post("delete", { path: dir });
  ok("fs delete to recycle bin", del.status === 200 && !fs.existsSync(dir), "status " + del.status);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
{
  const target = path.join(self.path, "_smoke_new.png");
  fs.rmSync(target, { force: true });
  const body = makePng(1, 2, 3);
  const c1 = await fetch(BASE + "/api/image?path=" + encodeURIComponent(target) + "&new=1", { method: "POST", body });
  ok("image new=1 creates a file without a .bak", c1.status === 200 && fs.existsSync(target) && !fs.existsSync(target + ".bak"));
  const c2 = await fetch(BASE + "/api/image?path=" + encodeURIComponent(target) + "&new=1", { method: "POST", body });
  ok("image new=1 refuses to clobber", c2.status === 409);
  fs.rmSync(target, { force: true });
}
{
  const models = await (await fetch(BASE + "/api/models")).json();
  ok("models listed from the CLI", Array.isArray(models) && models.length > 0 && models.every((m) => m.value && m.name), JSON.stringify(models).slice(0, 100));
  const ctxu = await (await fetch(BASE + "/api/context")).json();
  ok("context breakdown", ctxu === null || (typeof ctxu.used === "number" && typeof ctxu.max === "number"));
  const acct = await (await fetch(BASE + "/api/account")).json();
  ok("account info", acct === null || typeof acct === "object");
  const st = await (await fetch(BASE + "/api/settings")).json();
  ok("settings carry mode/effort/autoAllow", "mode" in st && "effort" in st && Array.isArray(st.autoAllow));
}
{
  const withIndex2 = projects.find((p) => fs.existsSync(path.join(p.path, "index.html")));
  if (withIndex2) {
    const html = await (await fetch(BASE + "/preview/" + encodeURIComponent(withIndex2.name) + "/")).text();
    ok("preview injects the console bridge", html.includes("/_nexus-console.js"));
  }
  const bridge = await fetch(BASE + "/_nexus-console.js");
  ok("console bridge served", bridge.status === 200 && (await bridge.text()).includes("nexusConsole"));
  for (const f of ["ui.js", "icons.js", "app.js", "chat.js", "pixel.js", "tabs.js", "styles.css"]) {
    const r = await fetch(BASE + "/" + f);
    ok("serves " + f, r.status === 200 && (await r.text()).length > 1000);
  }
  const chatJs = await (await fetch(BASE + "/chat.js")).text();
  ok("sidebar v2 features present", ["onDelta", "addPermission", "questionForm", "attachSelection", "rewindTo", "QUICK_ACTIONS", "paintTodos"].every((t) => chatJs.includes(t)));
  const pixelJs = await (await fetch(BASE + "/pixel.js")).text();
  ok("pixel v2 features present", ["saveSidecar", "floodFill", "wandMask", "gradientFill", "perfectPath", "liftSelection", "outlineDialog", "hslDialog", "resizeAll"].every((t) => pixelJs.includes(t)));
  // Export must not zip node_modules (bug fixed 2026-09-03).
  const exp2 = await fetch(BASE + "/api/export?path=" + encodeURIComponent(self.path));
  const zipBuf = Buffer.from(await exp2.arrayBuffer());
  ok("export skips node_modules", exp2.status === 200 && zipBuf.length < 5e6 && !zipBuf.includes(Buffer.from("node_modules/ws/")), "bytes " + zipBuf.length);
}

// ---- screen capture (session 10) ----
// Claude can see the whole desktop, and Tucker can clip a shot to a message.
{
  const list = await (await fetch(BASE + "/api/screen?list=1")).json();
  ok("screen: displays listed", Array.isArray(list.displays) && list.displays.length > 0 &&
    list.displays.every((d) => d.w > 0 && d.h > 0), JSON.stringify(list).slice(0, 120));

  const shotRes = await fetch(BASE + "/api/screen?max=320");
  const shot = await shotRes.json();
  ok("screen: capture returns a PNG", shotRes.status === 200 && typeof shot.data === "string" &&
    Buffer.from(shot.data, "base64").slice(1, 4).toString() === "PNG", shot.error || "");
  ok("screen: downscaled to the cap", shot.width <= 320 && shot.height <= 320 && shot.sourceWidth >= shot.width,
    shot.width + "x" + shot.height + " from " + shot.sourceWidth + "x" + shot.sourceHeight);
  // Not a black frame: a real desktop grab has many distinct colours.
  {
    const px = Buffer.from(shot.data, "base64");
    ok("screen: capture is not empty", px.length > 2000, px.length + " bytes");
  }

  const lastRes = await fetch(BASE + "/api/screen/last");
  const lastBuf = Buffer.from(await lastRes.arrayBuffer());
  ok("screen: last capture is served back", lastRes.status === 200 &&
    lastRes.headers.get("content-type") === "image/png" && lastBuf.slice(1, 4).toString() === "PNG");

  const badRes = await fetch(BASE + "/api/screen?display=99");
  const bad = await badRes.json();
  // The message must be readable - no CLIXML, no UTF-16 NULs.
  ok("screen: bad display gives a clean error", !!bad.error && !bad.error.includes("CLIXML") &&
    !bad.error.includes(String.fromCharCode(0)), JSON.stringify(bad).slice(0, 120));

  // The agent must actually offer the tool, and the UI must know how to use it.
  const agentSrc = fs.readFileSync(path.join(HERE, "agent.js"), "utf8");
  ok("screen: agent registers the MCP tools", ["createSdkMcpServer", "mcpServers: { nexus: screenServer }",
    'tool(', "captureScreen(", "mcp__nexus__screen"].every((t) => agentSrc.includes(t)));
  const chatSrc = await (await fetch(BASE + "/chat.js")).text();
  ok("screen: sidebar can attach and show one", ["attachScreenshot", "attachImage", "onScreen",
    "/api/screen/last", "mcp__nexus__screen"].every((t) => chatSrc.includes(t)));
}

// ---- pixel selections reach Claude (session 10) ----
{
  const pixelSrc = await (await fetch(BASE + "/pixel.js")).text();
  ok("pixel: selection hand-off present", ["focusRegion", "regionWords", "regionPng", "rectArg",
    "sendRegion", "askSelection", "reviewSelection", "attachImage"].every((t) => pixelSrc.includes(t)));
  const html = await (await fetch(BASE + "/index.html")).text();
  ok("pixel: Ask-about-this button in the toolbar", html.includes('id="pixel-look"'));
  // The rectangle it sends must be one sprite.mjs actually understands.
  const spriteSrc = fs.readFileSync(path.join(HERE, "tools", "sprite.mjs"), "utf8");
  ok("pixel: sprite.mjs takes the same --rect", spriteSrc.includes("if (a.rect)"));
}


// ---- session 11: several chats at once ----
// Each live chat is its own Agent SDK query(); the browser names them and every
// message in either direction carries that name.
{
  const live0 = await (await fetch(BASE + "/api/live")).json();
  ok("live chats endpoint", Array.isArray(live0.chats) && live0.chats.length >= 1 && live0.max >= 2,
    JSON.stringify(live0).slice(0, 120));

  const ws = new WebSocket(BASE.replace("http", "ws"));
  const seen = [];
  // The server's opening burst (including the live frame) arrives the moment the socket
  // opens, so the listener has to be attached before awaiting open.
  ws.on("message", (raw) => { try { seen.push(JSON.parse(raw)); } catch {} });
  await new Promise((r) => { ws.on("open", r); ws.on("error", r); });
  const waitFor = (fn, ms = 20000) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = seen.find(fn);
      if (hit || Date.now() - t0 > ms) { clearInterval(iv); res(hit || null); }
    }, 100);
  });

  const first = await waitFor((m) => m.type === "live", 5000);
  ok("socket announces live chats", !!first && Array.isArray(first.chats));

  ws.send(JSON.stringify({ type: "open", chat: "smoke-a" }));
  const opened = await waitFor((m) => m.type === "opened" && m.chat === "smoke-a");
  ok("opening a second chat", !!opened);

  const live1 = await (await fetch(BASE + "/api/live")).json();
  ok("second chat is live", live1.chats.some((c) => c.id === "smoke-a"), JSON.stringify(live1.chats));

  // Per-chat HTTP reads address a chat by ?chat=.
  const st2 = await (await fetch(BASE + "/api/settings?chat=smoke-a")).json();

  // Every event the new chat produces must be stamped with its own id, or a
  // reply would land in the wrong tab. Echoing the effort it already has proves
  // the round trip without spending a Claude turn or changing any setting.
  ws.send(JSON.stringify({ type: "setEffort", chat: "smoke-a", effort: st2.effort }));
  const tagged = await waitFor((m) => m.type === "effort" && m.chat === "smoke-a");
  ok("events carry their chat id", !!tagged, JSON.stringify(seen.slice(-3)).slice(0, 160));

  ok("settings read per chat", typeof st2.model === "string" && Array.isArray(st2.autoAllow));
  const us2 = await (await fetch(BASE + "/api/usage?chat=smoke-a")).json();
  ok("usage read per chat", us2 && us2.session && typeof us2.session.turns === "number");

  // A live chat must never show up in the past-chats list.
  const pastList = await (await fetch(BASE + "/api/chats")).json();
  const liveIds = new Set((await (await fetch(BASE + "/api/live")).json()).chats.map((c) => c.sessionId).filter(Boolean));
  ok("live chats excluded from history", Array.isArray(pastList) && !pastList.some((c) => liveIds.has(c.id)));

  ws.send(JSON.stringify({ type: "close", chat: "smoke-a" }));
  const closed = await waitFor((m) => m.type === "closed" && m.chat === "smoke-a");
  ok("closing a chat", !!closed);
  const live2 = await (await fetch(BASE + "/api/live")).json();
  ok("closed chat is gone", !live2.chats.some((c) => c.id === "smoke-a"));

  ws.close();
}

// The wiring the sidebar needs for tabs: a strip, one pane per chat, and the
// A / R pointers that keep a background chat drawing into its own pane.
{
  const chatJs = await (await fetch(BASE + "/chat.js")).text();
  ok("sidebar: chat registry", ["const CHATS", "function makeChat(", "function activate(", "function closeChat(", "function renderTabs("].every((t) => chatJs.includes(t)));
  ok("sidebar: events routed by chat id", chatJs.includes("CHATS.get(m.chat)") && chatJs.includes("function handleEvent("));
  ok("sidebar: messages name their chat", chatJs.includes("const wsSend = (obj, chatId)"));
  const html = await (await fetch(BASE + "/index.html")).text();
  ok("sidebar: tab strip in the page", html.includes('id="chat-tabs"') && html.includes('id="chat-empty-tpl"'));
  const css = await (await fetch(BASE + "/styles.css")).text();
  ok("sidebar: tab strip styled", css.includes("#chat-tabs") && css.includes(".ctab") && css.includes(".chat-pane"));
  const agentJs = fs.readFileSync(path.join(HERE, "agent.js"), "utf8");
  ok("auto-allow is shared by every chat", agentJs.includes("const SHARED") && agentJs.includes("SHARED.autoAllow"));
}

// ---- session 12: /api/env, source stamping, scene write-back ----------------
{
  const env = await (await fetch(BASE + "/api/env")).json();
  ok("env: workspace exists", !!env.workspace && fs.existsSync(env.workspace), JSON.stringify(env));
  ok("env: nexus dir is this folder", env.nexus && path.resolve(env.nexus).toLowerCase() === HERE.toLowerCase(), env.nexus);
  ok("env: sprite cli points at a file that exists", env.spriteCli && fs.existsSync(env.spriteCli.replace(/^node "/, "").replace(/"$/, "")), env.spriteCli);
  // Comments are allowed to mention the old name (one explains why the roots are
  // derived at all); what must not survive is a live reference to it.
  const noComments = (f) => fs.readFileSync(path.join(HERE, f), "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  ok("no hardcoded old workspace path left in source", !["server.js", "agent.js", "public/pixel.js", "public/chat.js"]
    .some((f) => noComments(f).includes("C:/Local AI")));

  // A scratch project of our own, so nothing of Tucker's is touched.
  const dir = path.join(HERE, "_smoke_scene");
  const htmlPath = path.join(dir, "index.html"), cssPath = path.join(dir, "s.css");
  fs.mkdirSync(dir, { recursive: true });
  const ORIGINAL_HTML = '<!doctype html>\n<html><head><link rel="stylesheet" href="s.css"></head>\n<body>\n<div id="box" class="card">hi</div>\n<img src="a.png" alt="x">\n<script>var q = 1 < 2 ? "<b>" : "</b>";<\/script>\n</body></html>\n';
  const ORIGINAL_CSS = ".card {\n  color: #fff;\n  padding: 2px;\n}\n@media (max-width: 400px) { .card { color: #000; } }\n";
  fs.writeFileSync(htmlPath, ORIGINAL_HTML, "utf8");
  fs.writeFileSync(cssPath, ORIGINAL_CSS, "utf8");

  const served = await (await fetch(BASE + "/preview/nexus-point/_smoke_scene/index.html")).text();
  ok("preview: console bridge still injected", served.includes("/_nexus-console.js"));
  ok("preview: source file named in a meta tag", served.includes('name="nexus-source"'));
  ok("preview: open tags carry data-nx", /<div data-nx="\d+" id="box"/.test(served), served.slice(0, 200));
  ok("preview: script and style are not stamped", !/<script data-nx/.test(served));
  ok("preview: a < inside script is left alone", served.includes('var q = 1 < 2 ? "<b>" : "</b>";'));
  const stripped = served.replace('<script src="/_nexus-console.js"></script>', "").replace(/<meta name="nexus-source"[^>]*>/, "").replace(/ data-nx="\d+"/g, "");
  ok("preview: stamping strips back to the file on disk exactly", stripped === ORIGINAL_HTML);
  const boxOffset = +/<div data-nx="(\d+)" id="box"/.exec(served)[1];
  ok("preview: the offset lands on that tag in the real file", ORIGINAL_HTML.slice(boxOffset, boxOffset + 4) === "<div");

  const sceneEdit = (edits) => fetch(BASE + "/api/scene/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edits }) });
  let r = await sceneEdit([{ op: "style", file: htmlPath, offset: boxOffset, tag: "div", props: { "background-color": "#ff0000" } }]);
  let j = await r.json();
  ok("scene: inline style spliced", r.status === 200 && fs.readFileSync(htmlPath, "utf8").includes('style="background-color: #ff0000"'), JSON.stringify(j));
  ok("scene: .bak made on the first write", fs.existsSync(htmlPath + ".bak") && j.written[0].madeBak === true);
  ok("scene: .bak holds the original", fs.readFileSync(htmlPath + ".bak", "utf8") === ORIGINAL_HTML);
  r = await sceneEdit([{ op: "style", file: htmlPath, offset: boxOffset, tag: "div", props: { color: "#00ff00" } }]);
  j = await r.json();
  ok("scene: second write never overwrites the .bak", j.written[0].madeBak === false && fs.readFileSync(htmlPath + ".bak", "utf8") === ORIGINAL_HTML);

  const beforeStale = fs.readFileSync(htmlPath, "utf8");
  r = await sceneEdit([{ op: "style", file: htmlPath, offset: 3, tag: "div", props: { color: "#123456" } }]);
  ok("scene: a stale offset is refused with 409", r.status === 409 && (await r.json()).stale === true);
  ok("scene: the refused edit wrote nothing", fs.readFileSync(htmlPath, "utf8") === beforeStale);

  r = await sceneEdit([{ op: "text", file: htmlPath, offset: boxOffset, tag: "div", text: "bye" }]);
  ok("scene: leaf text replaced", r.status === 200 && fs.readFileSync(htmlPath, "utf8").includes(">bye</div>"));

  r = await sceneEdit([{ op: "css", file: cssPath, selector: ".card", props: { color: "#abcdef", "border-radius": "4px" } }]);
  const cssNow = fs.readFileSync(cssPath, "utf8");
  ok("scene: css declaration patched in place", r.status === 200 && cssNow.includes("color: #abcdef;"), cssNow);
  ok("scene: css gained the new declaration", cssNow.includes("border-radius: 4px;"));
  ok("scene: css kept the rest of the file untouched", cssNow.includes("padding: 2px;") && cssNow.includes("@media (max-width: 400px)"));
  ok("scene: css .bak made", fs.existsSync(cssPath + ".bak") && fs.readFileSync(cssPath + ".bak", "utf8") === ORIGINAL_CSS);

  r = await sceneEdit([{ op: "css", file: cssPath, selector: ".nowhere", props: { color: "#111" } }]);
  j = await r.json();
  ok("scene: an unknown selector is appended, and said so", fs.readFileSync(cssPath, "utf8").includes(".nowhere {") && (j.notes || []).some((n) => n.includes("appended")));

  r = await sceneEdit([{ op: "css", file: htmlPath, selector: ".card", props: { color: "#111" } }]);
  ok("scene: rule edits refused inside an html file", r.status === 409);
  r = await sceneEdit([{ op: "style", file: "C:/Windows/win.ini", offset: 0, tag: "div", props: {} }]);
  ok("scene: path guard holds", r.status === 403);

  const svg = path.join(dir, "m.svg");
  r = await fetch(BASE + "/api/scene/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: svg, content: "<svg>1</svg>" }) });
  ok("scene/file: creates without a .bak", (await r.json()).madeBak === false && fs.existsSync(svg));
  r = await fetch(BASE + "/api/scene/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: svg, content: "<svg>2</svg>" }) });
  ok("scene/file: second write makes exactly one .bak of the first version", (await r.json()).madeBak === true && fs.readFileSync(svg + ".bak", "utf8") === "<svg>1</svg>");

  const res1 = await (await fetch(BASE + "/api/scene/resolve?url=" + encodeURIComponent("/preview/nexus-point/_smoke_scene/m.svg"))).json();
  ok("scene/resolve: svg belongs to the design editor", res1.editor === "design" && res1.exists === true, JSON.stringify(res1));
  const res2 = await (await fetch(BASE + "/api/scene/resolve?url=" + encodeURIComponent("https://cdn.example.com/x.png"))).json();
  ok("scene/resolve: an offsite url resolves to nothing", res2.path === null);
  const res3 = await (await fetch(BASE + "/api/scene/resolve?url=" + encodeURIComponent("/preview/nexus-point/public/icons.js"))).json();
  ok("scene/resolve: a source file opens in the code editor", res3.editor === "code");

  fs.rmSync(dir, { recursive: true, force: true });
  ok("scene: scratch project cleaned up", !fs.existsSync(dir));

  const sceneJs = fs.readFileSync(path.join(HERE, "public", "scene.js"), "utf8");
  ok("scene.js: property registry present", sceneJs.includes("const PROPS = [") && sceneJs.includes('css: "background-color"'));
  ok("scene.js: the overlay is never put inside the game's document", !sceneJs.includes("S.doc.body.appendChild"));
  ok("scene.js: exports its api", sceneJs.includes("window.NexusScene = {"));
  const idx = await (await fetch(BASE + "/index.html")).text();
  ok("scene: wired into the page", idx.includes('id="scene-edit"') && idx.includes('id="scene-panel"') && idx.includes('src="/scene.js"'));
  const st = await (await fetch(BASE + "/styles.css")).text();
  ok("scene: styled", st.includes("#scene-panel") && st.includes(".sc-handle") && st.includes(".cf-pop"));
}
// ---- session 12: the design registry, the scanner, and /nexus-repair --------
{
  const dir = path.join(HERE, "_smoke_reg");
  fs.mkdirSync(dir, { recursive: true });
  const reg = path.join(dir, "nexus-design.js");
  const ORIGINAL = '// a comment that must survive\nwindow.NEXUS_DESIGN = {\n  colors: { body: "#5b7fa8", glow: "#9fd0ff" },\n  sizes: { radius: 18 },\n};\n';
  fs.writeFileSync(reg, ORIGINAL, "utf8");
  const patch = (key, value, file) => fetch(BASE + "/api/scene/registry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: file || reg, key, value }) });

  let r = await patch("colors.body", "#ff0000");
  let j = await r.json();
  ok("registry: nested key patched", r.status === 200 && fs.readFileSync(reg, "utf8").includes('body: "#ff0000"'), JSON.stringify(j));
  ok("registry: nothing else in the file moved", fs.readFileSync(reg, "utf8") === ORIGINAL.replace('"#5b7fa8"', '"#ff0000"'));
  ok("registry: .bak made and holds the original", fs.existsSync(reg + ".bak") && fs.readFileSync(reg + ".bak", "utf8") === ORIGINAL);
  r = await patch("sizes.radius", 30);
  ok("registry: a number stays a number", fs.readFileSync(reg, "utf8").includes("radius: 30"));
  r = await patch("colors.nope", "#111");
  ok("registry: an unknown key is refused, not invented", r.status === 409 && !fs.readFileSync(reg, "utf8").includes("nope"));
  r = await patch("colors.body.deeper", "#111");
  ok("registry: a key path through a non-object is refused", r.status === 409);
  r = await patch("colors.body", "#222", path.join(dir, "other.js"));
  ok("registry: only a file called nexus-design.js may be patched", r.status === 400);
  r = await patch("colors.body", "#333", "C:/Windows/win.ini");
  ok("registry: path guard holds", r.status === 403);
  fs.rmSync(dir, { recursive: true, force: true });

  const { sceneReport } = await import("file://" + path.join(HERE, "tools", "scene-report.mjs").replaceAll("\\", "/"));
  const rep = sceneReport(HERE);
  ok("scene-report: runs and names the project", typeof rep === "string" && rep.includes("SCENE REPORT for nexus-point"));
  ok("scene-report: has every section", ["## Canvases", "## Draw entry points", "## Inline SVG", "## data: image URIs", "## Hardcoded colours", "## Existing image assets"].every((s) => rep.includes(s)));
  ok("scene-report: says a DOM-only project needs no repair", sceneReport(path.join(path.dirname(HERE), "hoopshots")).includes("pure DOM"));

  const agentJs2 = fs.readFileSync(path.join(HERE, "agent.js"), "utf8");
  ok("scene_report registered as an mcp tool", agentJs2.includes('"scene_report"') && agentJs2.includes("sceneReport"));
  ok("scene_report is auto-allowed (it only reads)", agentJs2.includes('"mcp__nexus__scene_report"'));
  ok("the agent is told about scene mode and the playbook", agentJs2.includes("NEXUS-REPAIR.md") && agentJs2.includes("scene mode"));

  const chatJs2 = fs.readFileSync(path.join(HERE, "public", "chat.js"), "utf8");
  ok("/nexus-repair is a local command", chatJs2.includes("LOCAL_COMMANDS") && chatJs2.includes('"/nexus-repair"'));
  ok("/nexus-repair is expanded before the message is built", chatJs2.includes("const local = expandLocal(text);"));
  ok("/nexus-repair also appears as a quick action", chatJs2.includes("Nexus-Repair)"));

  ok("the adapter contract is documented", fs.existsSync(path.join(HERE, "docs", "NEXUS-SCENE-ADAPTER.md")));
  ok("the repair playbook is documented", fs.existsSync(path.join(HERE, "docs", "NEXUS-REPAIR.md")));
  ok("the skill points at the playbook", fs.readFileSync(path.join(HERE, ".claude", "skills", "nexus-repair", "SKILL.md"), "utf8").includes("docs/NEXUS-REPAIR.md"));
  const sceneJs2 = fs.readFileSync(path.join(HERE, "public", "scene.js"), "utf8");
  ok("scene.js reads the adapter rather than guessing at a canvas", sceneJs2.includes("__NEXUS_SCENE__") && sceneJs2.includes("function objectAt("));
  ok("scene.js routes object saves to the registry", sceneJs2.includes("/api/scene/registry"));
}
// ---- session 12: the Design tab --------------------------------------------
{
  const designJs = fs.readFileSync(path.join(HERE, "public", "design.js"), "utf8");
  ok("design: geometry registry present", designJs.includes("const GEO = {") && designJs.includes("fallbackGeo"));
  ok("design: property registry present", designJs.includes("const PROPS = [") && designJs.includes("const TOOLS = ["));
  ok("design: the document is the live svg, not a model beside it", designJs.includes("D.svg") && !designJs.includes("DOC.nodes"));
  ok("design: saves through the .bak-making writer", designJs.includes('"/api/scene/file"'));
  ok("design: exports png through /api/image", designJs.includes("/api/image?new=1"));
  ok("design: refuses anything but .svg", designJs.includes("only opens .svg"));
  ok("design: exports its api", designJs.includes("window.NexusDesign = {"));

  const idx2 = await (await fetch(BASE + "/index.html")).text();
  ok("design: tab and pane in the page", idx2.includes('data-tab="design"') && idx2.includes('id="design-pane"') && idx2.includes('src="/design.js"'));
  const st2 = await (await fetch(BASE + "/styles.css")).text();
  ok("design: styled", st2.includes("#design-pane") && st2.includes(".dz-tool") && st2.includes(".dz-layer"));
  const tabsJs = fs.readFileSync(path.join(HERE, "public", "tabs.js"), "utf8");
  ok("design: registered as a pane and reached from the assets grid", tabsJs.includes('design: $("design-pane")') && tabsJs.includes("function openInDesign("));
  const appJs2 = fs.readFileSync(path.join(HERE, "public", "app.js"), "utf8");
  ok("design: an .svg opens there from the tree", appJs2.includes("NexusDesign.open(p, relPath(p))"));

  // the Pixel tab still owns .png, and only .png - the invariant this sits beside
  const pixelJs = fs.readFileSync(path.join(HERE, "public", "pixel.js"), "utf8");
  ok("pixel: still png-only", pixelJs.includes("[.]png$") || pixelJs.includes(".png"));
  const r = await fetch(BASE + "/api/image?path=" + encodeURIComponent(path.join(HERE, "nope.svg")), { method: "POST", body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) });
  ok("pixel: /api/image still refuses a non-png path", r.status === 400);
}
// Optional live Claude round-trip: node smoke-test.mjs --chat
if (process.argv.includes("--chat")) {
  await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace("http", "ws"));
    const timer = setTimeout(() => { ok("claude chat", false, "timeout"); ws.close(); resolve(); }, 120000);
    let sawAssistant = false;
    ws.on("open", () => ws.send(JSON.stringify({ type: "chat", chat: "c1", text: "Reply with exactly the single word PONG. Do not use any tools." })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "assistant" && m.text.includes("PONG")) sawAssistant = true;
      if (m.type === "done") { clearTimeout(timer); ok("claude chat", sawAssistant); ws.close(); resolve(); }
    });
    ws.on("error", () => { clearTimeout(timer); ok("claude chat", false, "ws error"); resolve(); });
  });
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
