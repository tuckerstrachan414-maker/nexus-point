// Nexus Point — local workbench for Claude Code projects.
// Node server: static UI + file APIs + WebSocket bridge to the Agent SDK (agent.js).
// v2 (2026-09-03): file ops, find-in-files, chat management, Play-tab console bridge.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { exec, execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import { createAgent, listPastChats, getPastChat, renamePastChat, deletePastChat } from "./agent.js";

// Each live chat is one Claude CLI session: real memory, and they share Tucker's
// plan limits. Five at once is plenty for parallel work without thrashing.
const MAX_CHATS = 5;
import { captureScreen, listDisplays, lastCapture } from "./tools/screen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// NEXUS_PORT lets a second instance run beside the live one for testing.
const PORT = Number(process.env.NEXUS_PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, "public");

// Folders whose direct subfolders count as projects. Derived from this file's
// own location (nexus-point -> Claude Projects -> the workspace root) rather
// than written out, because the workspace folder HAS been renamed once
// ("C:/Local AI" -> "C:/AI workspace") and every hardcoded copy stranded the app.
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ROOTS = [WORKSPACE_ROOT, path.join(WORKSPACE_ROOT, "Claude Projects")];
const SKIP_DIRS = new Set([".claude", ".git", "node_modules", "Claude Projects"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".mp3", ".wav", ".ogg", ".mp4", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".pdf", ".exe", ".dll", ".xlsx", ".db",
]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4",
  ".webm": "video/webm", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// Every file API call must resolve inside one of the roots — blocks "..\" escapes.
function insideRoots(p) {
  const norm = path.resolve(p);
  return PROJECT_ROOTS.some((root) =>
    norm.toLowerCase().startsWith(root.toLowerCase() + path.sep) ||
    norm.toLowerCase() === root.toLowerCase());
}

async function listProjects() {
  const seen = new Map();
  for (const root of PROJECT_ROOTS) {
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(root, e.name);
      seen.set(full.toLowerCase(), { name: e.name, path: full });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function buildTree(dir, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) && e.name !== "Claude Projects") continue;
    if (e.name === "Claude Projects") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: full, type: "dir", children: await buildTree(full, depth + 1) });
    } else {
      out.push({ name: e.name, path: full, type: "file" });
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out;
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20e6) { reject(new Error("file too large (20 MB max)")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 20e6) reject(new Error("too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const ASSET_EXT = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
  ".webp": "image", ".bmp": "image", ".svg": "image",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio",
};

function streamFile(res, filePath) {
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function scanAssets(dir, base, out, depth = 0) {
  if (depth > 8 || out.length >= 500) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await scanAssets(full, base, out, depth + 1);
    else {
      const kind = ASSET_EXT[path.extname(e.name).toLowerCase()];
      if (kind) out.push({ name: e.name, path: full, rel: path.relative(base, full), kind });
    }
    if (out.length >= 500) return;
  }
}

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".html", ".htm", ".css", ".json", ".md", ".txt",
  ".py", ".bat", ".ps1", ".yml", ".yaml", ".xml", ".svg", ".csv", ".sh", ".toml", ".ini", ".cfg"]);
async function searchFiles(dir, base, q, hits, depth = 0) {
  if (depth > 8 || hits.length >= 300) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (hits.length >= 300) return;
    if (SKIP_DIRS.has(e.name) || e.name === "_backups") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await searchFiles(full, base, q, hits, depth + 1); continue; }
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let st; try { st = await fsp.stat(full); } catch { continue; }
    if (st.size > 2e6) continue;
    let text; try { text = await fsp.readFile(full, "utf8"); } catch { continue; }
    if (!text.toLowerCase().includes(q)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < 300; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ path: full, rel: path.relative(base, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
}

// ---- Scene editor: source stamping and surgical write-back ----
// The Play tab's iframe is same-origin, so the editor reads the live DOM
// directly. What the DOM cannot tell it is where an element came from, so the
// HTML served under /preview/ carries a data-nx="<char offset>" on each open
// tag. That attribute exists only in the bytes sent to the iframe, never on
// disk, and is what turns "this element on screen" into "these characters in
// index.html". Elements built at runtime by JS have no stamp - the panel says
// so and hands the job to Claude instead of guessing.
const NO_STAMP = new Set(["script", "style", "meta", "link", "br", "base", "title", "html", "head"]);

// A ">" inside a quoted attribute value does not end the tag.
function findTagEnd(s, from) {
  let q = "";
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ">") return i;
  }
  return -1;
}

function stampSource(html) {
  let out = "", i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += html.slice(lt, stop); i = stop; continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?" || html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const stop = end === -1 ? html.length : end + 1;
      out += html.slice(lt, stop); i = stop; continue;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 60));
    if (!m) { out += "<"; i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    const gt = findTagEnd(html, lt);
    if (gt === -1) { out += html.slice(lt); break; }
    let open = html.slice(lt, gt + 1);
    if (!NO_STAMP.has(tag)) {
      const cut = 1 + m[1].length;
      open = open.slice(0, cut) + ' data-nx="' + lt + '"' + open.slice(cut);
    }
    out += open;
    i = gt + 1;
    // Raw text elements: a "<" inside JS or CSS is not a tag.
    if (tag === "script" || tag === "style") {
      const close = html.toLowerCase().indexOf("</" + tag, i);
      const stop = close === -1 ? html.length : close;
      out += html.slice(i, stop); i = stop;
    }
  }
  return out;
}

// First write of a given file leaves a .bak beside it and NEVER overwrites an
// existing one. Same rule as /api/image: in projects with no git that .bak is
// the only undo there is, so the oldest copy is the one worth keeping.
async function backupOnce(p) {
  const bak = p + ".bak";
  if (fs.existsSync(p) && !fs.existsSync(bak)) { await fsp.copyFile(p, bak); return true; }
  return false;
}

// Refuse to edit generated output. god-sim builds through Vite and only dist/
// is playable - an edit there is gone at the next build, so it must go to
// Claude and the source instead.
function generatedDirNote(p) {
  const parts = path.resolve(p).split(path.sep).map((s) => s.toLowerCase());
  const hit = parts.find((s) => s === "dist" || s === "build" || s === ".next" || s === "out");
  return hit ? "this file is inside " + hit + "/, which a build overwrites - edit the source and rebuild" : null;
}

function readOpenTag(src, offset) {
  if (src[offset] !== "<") return null;
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(offset, offset + 60));
  if (!m) return null;
  const end = findTagEnd(src, offset);
  if (end === -1) return null;
  return { tag: m[1].toLowerCase(), nameEnd: offset + 1 + m[1].length, end, text: src.slice(offset, end + 1) };
}

const ATTR_OK = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
function getAttr(open, name) {
  const re = new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]*))", "i");
  const m = re.exec(open);
  if (!m) return null;
  const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || "";
  return { value: v, index: m.index, length: m[0].length };
}
function setAttr(open, name, value) {
  const selfClosing = /\/>$/.test(open);
  const hit = getAttr(open, name);
  if (value === null || value === "") return hit ? open.slice(0, hit.index) + open.slice(hit.index + hit.length) : open;
  const quoted = " " + name + '="' + String(value).replaceAll('"', "&quot;") + '"';
  if (hit) return open.slice(0, hit.index) + quoted + open.slice(hit.index + hit.length);
  const cut = open.length - (selfClosing ? 2 : 1);
  return open.slice(0, cut) + quoted + open.slice(cut);
}

const CSS_PROP_OK = /^-{0,2}[a-z][a-z0-9-]*$/;
function mergeStyle(current, props) {
  const map = new Map();
  for (const part of String(current || "").split(";")) {
    const i = part.indexOf(":");
    if (i === -1) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (k) map.set(k, part.slice(i + 1).trim());
  }
  for (const [rawK, v] of Object.entries(props || {})) {
    const k = String(rawK).trim().toLowerCase();
    if (!CSS_PROP_OK.test(k)) continue;
    if (v === null || v === "") map.delete(k);
    else map.set(k, String(v).trim().replaceAll(";", "").replaceAll('"', "'"));
  }
  return [...map].map(([k, v]) => k + ": " + v).join("; ");
}

// Patch one declaration in place rather than re-emitting the rule, so a file
// keeps its own formatting everywhere the edit did not land.
function patchDecls(body, props) {
  let out = body;
  for (const [rawK, v] of Object.entries(props || {})) {
    const key = String(rawK).trim().toLowerCase();
    if (!CSS_PROP_OK.test(key)) continue;
    const re = new RegExp("(^|[;{\\s])(" + key + ")\\s*:\\s*([^;}]*)", "gi");
    let last = null, m;
    while ((m = re.exec(out))) last = m;
    if (v === null || v === "") {
      if (last) {
        let end = last.index + last[0].length;
        if (out[end] === ";") end++;
        out = out.slice(0, last.index + last[1].length) + out.slice(end);
      }
      continue;
    }
    const val = String(v).trim().replaceAll(";", "");
    if (last) {
      const valStart = last.index + last[0].length - last[3].length;
      out = out.slice(0, valStart) + val + out.slice(valStart + last[3].length);
    } else {
      const head = out.replace(/\s+$/, "");
      const tail = out.slice(head.length);
      const sep = !head.trim() || head.endsWith(";") ? "" : ";";
      out = head + sep + " " + key + ": " + val + ";" + tail;
    }
  }
  return out;
}

function matchBrace(css, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); i = e === -1 ? css.length : e + 1; continue; }
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Every rule whose selector matches, with the depth it sits at. A depth-0 rule
// is the plain one; anything deeper is inside an at-rule such as @media, and
// patching that would only change one breakpoint - so depth 0 wins.
function findCssRules(css, selector) {
  const want = selector.replace(/\s+/g, " ").trim().toLowerCase();
  const found = [];
  let depth = 0, selStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); i = e === -1 ? css.length : e + 1; continue; }
    if (css[i] === "{") {
      const sel = css.slice(selStart, i).replace(/\s+/g, " ").trim();
      if (!sel.startsWith("@") && sel.toLowerCase() === want) {
        const close = matchBrace(css, i);
        if (close !== -1) found.push({ depth, bodyFrom: i + 1, bodyTo: close });
      }
      depth++; selStart = i + 1; continue;
    }
    if (css[i] === "}") { depth = Math.max(0, depth - 1); selStart = i + 1; continue; }
    if (css[i] === ";" && depth === 0) selStart = i + 1;
  }
  return found.sort((a, b) => a.depth - b.depth);
}
// ---- the design registry (nexus-design.js) ----
// A canvas object's colour is a value in the project's source, not an attribute
// on a node. /nexus-repair hoists the ones worth editing into nexus-design.js,
// and these walk that object literal to patch ONE value in place - the rest of
// the file, comments and formatting included, is untouched.
function skipJsString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === String.fromCharCode(92)) { j++; continue; }
    if (src[j] === q) return j;
  }
  return src.length - 1;
}
function matchBraceJs(src, openIdx) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = skipJsString(src, i); continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e === -1 ? src.length : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e === -1 ? src.length : e + 1; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (!d) return i; }
  }
  return -1;
}
// One key at the top level of the object literal that starts at openBrace.
function findRegistryKey(src, openBrace, key) {
  const end = matchBraceJs(src, openBrace);
  if (end === -1) return null;
  let depth = 0;
  for (let i = openBrace; i < end; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = skipJsString(src, i); continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e === -1 ? end : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e === -1 ? end : e + 1; continue; }
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth !== 1 || c !== ":") continue;
    let j = i - 1;
    while (j > openBrace && /\s/.test(src[j])) j--;
    let name;
    if (src[j] === '"' || src[j] === "'") {
      let s = j - 1;
      while (s > openBrace && src[s] !== src[j]) s--;
      name = src.slice(s + 1, j);
    } else {
      let s = j;
      while (s > openBrace && /[A-Za-z0-9_$]/.test(src[s])) s--;
      name = src.slice(s + 1, j + 1);
    }
    if (name !== key) continue;
    let v = i + 1;
    while (v < end && /\s/.test(src[v])) v++;
    let d2 = 0, e2 = v;
    for (; e2 < end; e2++) {
      const ch = src[e2];
      if (ch === '"' || ch === "'" || ch === "`") { e2 = skipJsString(src, e2); continue; }
      if (ch === "{" || ch === "[" || ch === "(") d2++;
      else if (ch === "}" || ch === "]" || ch === ")") { if (!d2) break; d2--; }
      else if (ch === "," && !d2) break;
    }
    let vEnd = e2;
    while (vEnd > v && /\s/.test(src[vEnd - 1])) vEnd--;
    return { from: v, to: vEnd, isObject: src[v] === "{" };
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // Where this install actually lives. The UI reads it at boot instead of
    // hardcoding the workspace path, which broke every client file once when
    // the workspace folder was renamed.
    if (url.pathname === "/api/env") {
      const fwd = (p) => p.replaceAll(String.fromCharCode(92), "/");
      return json(res, 200, {
        workspace: fwd(WORKSPACE_ROOT),
        nexus: fwd(__dirname),
        spriteCli: 'node "' + fwd(path.join(__dirname, "tools", "sprite.mjs")) + '"',
      });
    }
    if (url.pathname === "/api/projects") {
      return json(res, 200, await listProjects());
    }
    if (url.pathname === "/api/tree") {
      const p = url.searchParams.get("path") || "";
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      return json(res, 200, await buildTree(p));
    }
    if (url.pathname === "/api/file" && req.method === "GET") {
      const p = url.searchParams.get("path") || "";
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      const ext = path.extname(p).toLowerCase();
      const stat = await fsp.stat(p);
      if (BINARY_EXT.has(ext)) return json(res, 200, { binary: true, size: stat.size });
      if (stat.size > 5e6) return json(res, 200, { binary: true, size: stat.size, note: "too large to edit" });
      const content = await fsp.readFile(p, "utf8");
      return json(res, 200, { content });
    }
    if (url.pathname === "/api/file" && req.method === "POST") {
      const { path: p, content } = JSON.parse(await readBody(req));
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      if (typeof content !== "string") return json(res, 400, { error: "content must be a string" });
      await fsp.writeFile(p, content, "utf8");
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/assets") {
      const p = url.searchParams.get("path") || "";
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      const out = [];
      await scanAssets(p, p, out);
      return json(res, 200, out);
    }
    // ---- Scene editor write-back ----
    // Surgical splices into the project's own source. HTML edits run highest
    // offset first so the earlier offsets in the same file stay valid, and
    // every edit names the tag it expects at its offset: if the file moved
    // under us, nothing at all is written.
    if (url.pathname === "/api/scene/edit" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const edits = Array.isArray(body.edits) ? body.edits : [];
      if (!edits.length) return json(res, 400, { error: "no edits" });
      const byFile = new Map();
      for (const e of edits) {
        const f = path.resolve(String(e.file || ""));
        if (!insideRoots(f)) return json(res, 403, { error: "path outside allowed roots" });
        const gen = generatedDirNote(f);
        if (gen) return json(res, 409, { error: gen, generated: true, file: f });
        if (!fs.existsSync(f)) return json(res, 404, { error: "file not found: " + f });
        if (e.op === "css" && path.extname(f).toLowerCase() !== ".css") {
          return json(res, 409, { error: "rule edits only work in a .css file; a <style> block inside HTML has to go to Claude", file: f });
        }
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(e);
      }
      const written = [], notes = [];
      for (const [f, list] of byFile) {
        let src = await fsp.readFile(f, "utf8");
        const markup = list.filter((e) => e.op !== "css").sort((a, b) => (b.offset | 0) - (a.offset | 0));
        for (const e of markup) {
          const off = e.offset | 0;
          const at = readOpenTag(src, off);
          if (!at || (e.tag && at.tag !== String(e.tag).toLowerCase())) {
            return json(res, 409, { stale: true, file: f, error: "that file changed since the Play tab loaded it - restart the Play tab and try again" });
          }
          if (e.op === "style") {
            const cur = getAttr(at.text, "style");
            src = src.slice(0, off) + setAttr(at.text, "style", mergeStyle(cur ? cur.value : "", e.props)) + src.slice(at.end + 1);
          } else if (e.op === "attr") {
            if (!ATTR_OK.test(String(e.name || ""))) return json(res, 400, { error: "bad attribute name" });
            src = src.slice(0, off) + setAttr(at.text, e.name, e.value == null ? null : String(e.value)) + src.slice(at.end + 1);
          } else if (e.op === "text") {
            const close = src.toLowerCase().indexOf("</" + at.tag, at.end + 1);
            if (close === -1) return json(res, 409, { file: f, error: "<" + at.tag + "> has no closing tag here, so its text cannot be replaced" });
            if (src.slice(at.end + 1, close).includes("<")) return json(res, 409, { file: f, error: "that element holds other elements, so its text is not one piece - ask Claude instead" });
            const esc = String(e.text == null ? "" : e.text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            src = src.slice(0, at.end + 1) + esc + src.slice(close);
          } else {
            return json(res, 400, { error: "unknown op " + e.op });
          }
        }
        for (const e of list.filter((x) => x.op === "css")) {
          const sel = String(e.selector || "").trim();
          if (!sel) return json(res, 400, { error: "empty selector" });
          const hits = findCssRules(src, sel);
          if (!hits.length) {
            const decls = Object.entries(e.props || {}).filter(([k]) => CSS_PROP_OK.test(k))
              .map(([k, v]) => k + ": " + String(v).replaceAll(";", "") + ";").join("\n  ");
            src = src.replace(/\s*$/, "") + "\n\n/* added by the Nexus Point scene editor */\n" + sel + " {\n  " + decls + "\n}\n";
            notes.push("no " + sel + " rule existed in " + path.basename(f) + ", so one was appended at the end");
          } else {
            const hit = hits[0];
            src = src.slice(0, hit.bodyFrom) + patchDecls(src.slice(hit.bodyFrom, hit.bodyTo), e.props) + src.slice(hit.bodyTo);
            if (hit.depth > 0) notes.push("the only " + sel + " rule in " + path.basename(f) + " sits inside an at-rule such as @media, so this change applies at that breakpoint only");
          }
        }
        const madeBak = await backupOnce(f);
        await fsp.writeFile(f, src, "utf8");
        written.push({ file: f, madeBak });
      }
      return json(res, 200, { ok: true, written, notes });
    }
    // Patch one value inside a project's nexus-design.js. This is where a
    // canvas object's editable properties live - see docs/NEXUS-SCENE-ADAPTER.md.
    if (url.pathname === "/api/scene/registry" && req.method === "POST") {
      const b = JSON.parse(await readBody(req));
      const f = path.resolve(String(b.file || ""));
      if (!insideRoots(f)) return json(res, 403, { error: "path outside allowed roots" });
      if (path.basename(f).toLowerCase() !== "nexus-design.js") return json(res, 400, { error: "only nexus-design.js can be patched this way" });
      if (!fs.existsSync(f)) return json(res, 404, { error: "this project has no nexus-design.js - run /nexus-repair on it first" });
      const keys = String(b.key || "").split(".").filter(Boolean);
      if (!keys.length) return json(res, 400, { error: "no key path" });
      let src = await fsp.readFile(f, "utf8");
      const anchor = src.indexOf("NEXUS_DESIGN");
      const rootBrace = anchor === -1 ? -1 : src.indexOf("{", anchor);
      if (rootBrace === -1) return json(res, 400, { error: "nexus-design.js does not assign a window.NEXUS_DESIGN object" });
      let brace = rootBrace, hit = null;
      for (let i = 0; i < keys.length; i++) {
        hit = findRegistryKey(src, brace, keys[i]);
        if (!hit) return json(res, 409, { error: "nexus-design.js has no key " + keys.slice(0, i + 1).join(".") });
        if (i < keys.length - 1) {
          if (!hit.isObject) return json(res, 409, { error: keys.slice(0, i + 1).join(".") + " is not an object" });
          brace = hit.from;
        }
      }
      const was = src.slice(hit.from, hit.to);
      const next = JSON.stringify(b.value);
      if (was === next) return json(res, 200, { ok: true, unchanged: true, was });
      src = src.slice(0, hit.from) + next + src.slice(hit.to);
      const madeBak = await backupOnce(f);
      await fsp.writeFile(f, src, "utf8");
      return json(res, 200, { ok: true, madeBak, key: keys.join("."), was, now: next });
    }    // Text write with the same first-write .bak guarantee /api/image gives PNGs.
    // The Design tab saves through here so an .svg is as recoverable as a .png.
    if (url.pathname === "/api/scene/file" && req.method === "POST") {
      const b = JSON.parse(await readBody(req));
      const f = path.resolve(String(b.path || ""));
      if (!insideRoots(f)) return json(res, 403, { error: "path outside allowed roots" });
      if (typeof b.content !== "string") return json(res, 400, { error: "content must be a string" });
      const gen = generatedDirNote(f);
      if (gen) return json(res, 409, { error: gen, generated: true });
      const madeBak = await backupOnce(f);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, b.content, "utf8");
      return json(res, 200, { ok: true, madeBak, bytes: Buffer.byteLength(b.content) });
    }
    // Map something the iframe is showing (an img src, a CSS url()) back to a
    // file on disk, and say which editor owns it. Server side because the
    // /preview/ dist and first-root-html fallbacks live here.
    if (url.pathname === "/api/scene/resolve") {
      const raw = url.searchParams.get("url") || "";
      let pathname = raw;
      try { pathname = new URL(raw, "http://localhost:" + PORT).pathname; } catch {}
      if (!pathname.startsWith("/preview/")) return json(res, 200, { path: null, reason: "not a file served from the project" });
      const segs = pathname.split("/").slice(2).map(decodeURIComponent);
      const projName = segs.shift() || "";
      const proj = (await listProjects()).find((x) => x.name.toLowerCase() === projName.toLowerCase());
      if (!proj) return json(res, 200, { path: null, reason: "unknown project" });
      const f = path.resolve(path.join(proj.path, segs.join("/")));
      if (!insideRoots(f)) return json(res, 403, { error: "path outside allowed roots" });
      const ext = path.extname(f).toLowerCase();
      return json(res, 200, {
        path: f, rel: path.relative(proj.path, f), project: proj.path, projectName: proj.name,
        exists: fs.existsSync(f), generated: generatedDirNote(f),
        editor: ext === ".png" ? "pixel" : ext === ".svg" ? "design" : TEXT_EXT.has(ext) ? "code" : null,
      });
    }    if (url.pathname === "/raw") {
      const p = url.searchParams.get("path") || "";
      if (!insideRoots(p) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      return streamFile(res, p);
    }
    // Play-test preview: /preview/<projectName>/<relative file> serves from the project folder.
    if (url.pathname.startsWith("/preview/")) {
      const segs = url.pathname.split("/").slice(2).map(decodeURIComponent);
      const projName = segs.shift() || "";
      const projects = await listProjects();
      const proj = projects.find((x) => x.name.toLowerCase() === projName.toLowerCase());
      if (!proj) { res.writeHead(404); return res.end("unknown project"); }
      let rel = segs.join("/");
      if (!rel || rel.endsWith("/")) rel += "index.html";
      let filePath = path.resolve(path.join(proj.path, rel));
      if (!insideRoots(filePath)) { res.writeHead(403); return res.end(); }
      // god-sim: only the built dist/ is playable — fall back if root index.html is absent.
      if (!fs.existsSync(filePath) && rel === "index.html") {
        const dist = path.join(proj.path, "dist", "index.html");
        if (fs.existsSync(dist)) {
          res.writeHead(302, { Location: "/preview/" + encodeURIComponent(proj.name) + "/dist/index.html" });
          return res.end();
        }
      }
      // No index.html at all (e.g. Office space): serve the first root-level .html file.
      if (!fs.existsSync(filePath) && rel === "index.html") {
        const htmls = (await fsp.readdir(proj.path)).filter((n) => n.toLowerCase().endsWith(".html")).sort();
        if (htmls.length) {
          res.writeHead(302, { Location: "/preview/" + encodeURIComponent(proj.name) + "/" + encodeURIComponent(htmls[0]) });
          return res.end();
        }
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      if (/[.]html?$/i.test(filePath)) {
        // The bridge forwards console.* and window errors to the parent frame
        // (public/_nexus-console.js). It no-ops when the page is not framed.
        let html = await fsp.readFile(filePath, "utf8");
        // Stamp FIRST: data-nx offsets must index the file as it is on disk,
        // and the injected tag below shifts everything after <head>.
        html = stampSource(html);
        const tag = '<script src="/_nexus-console.js"></script>' +
          '<meta name="nexus-source" content="' + filePath.replaceAll(String.fromCharCode(92), "/").replaceAll('"', "&quot;") + '">';
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      }
      return streamFile(res, filePath);
    }
    // Asset upload: drop a sprite/sound in, lands in <project>/assets/ (or project root).
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const dir = url.searchParams.get("dir") || "";
      const name = path.basename(url.searchParams.get("name") || "");
      const overwrite = url.searchParams.get("overwrite") === "1";
      if (!insideRoots(dir)) return json(res, 403, { error: "path outside allowed roots" });
      const ext = path.extname(name).toLowerCase();
      if (!ASSET_EXT[ext]) return json(res, 400, { error: "only image/audio files can be uploaded" });
      let target = dir;
      const assetsDir = path.join(dir, "assets");
      if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) target = assetsDir;
      const dest = path.join(target, name);
      if (!insideRoots(dest)) return json(res, 403, { error: "bad filename" });
      if (fs.existsSync(dest) && !overwrite) return json(res, 409, { error: "exists", path: dest });
      const buf = await readBodyBuffer(req);
      await fsp.writeFile(dest, buf);
      return json(res, 200, { ok: true, path: dest });
    }
    // Pixel editor save: overwrite a PNG in place with raw bytes from the canvas.
    // First save of a given file leaves a .bak beside it - the only undo for
    // projects with no git (only Tucker deletes .baks).
    if (url.pathname === "/api/image" && req.method === "POST") {
      const p = url.searchParams.get("path") || "";
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      if (path.extname(p).toLowerCase() !== ".png") return json(res, 400, { error: "only .png files can be saved from the pixel editor" });
      const creating = url.searchParams.get("new") === "1";
      if (!fs.existsSync(p) && !creating) return json(res, 404, { error: "file not found" });
      if (fs.existsSync(p) && creating && url.searchParams.get("overwrite") !== "1") return json(res, 409, { error: "exists", path: p });
      const buf = await readBodyBuffer(req);
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return json(res, 400, { error: "body is not PNG data" });
      const bak = p + ".bak";
      let madeBak = false;
      if (fs.existsSync(p) && !fs.existsSync(bak)) { await fsp.copyFile(p, bak); madeBak = true; }
      if (!fs.existsSync(p)) await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, buf);
      return json(res, 200, { ok: true, bytes: buf.length, madeBak });
    }
    // Export a project as a zip (PowerShell Compress-Archive - no npm dep).
    if (url.pathname === "/api/export") {
      const p = url.searchParams.get("path") || "";
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      const name = path.basename(p).replace(/[^a-zA-Z0-9 _.-]/g, "");
      const stamp = new Date().toISOString().slice(0, 10);
      const tmp = path.join(os.tmpdir(), "nexus-export-" + Date.now() + ".zip");
      const ps = "$items = Get-ChildItem -LiteralPath '" + p + "' | Where-Object { @('node_modules','.git','_backups') -notcontains $_.Name }; " +
        "Compress-Archive -Path $items.FullName -DestinationPath '" + tmp + "' -Force";
      execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 120000 }, (err) => {
        if (err || !fs.existsSync(tmp)) return json(res, 500, { error: "zip failed: " + (err ? err.message : "no output") });
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="' + name + "-" + stamp + '.zip"',
        });
        fs.createReadStream(tmp).pipe(res).on("finish", () => fs.rm(tmp, { force: true }, () => {}));
      });
      return;
    }
    // Run one command in a project folder (the Run tab). Not for long-running servers.
    if (url.pathname === "/api/run" && req.method === "POST") {
      const { cmd, cwd } = JSON.parse(await readBody(req));
      if (!insideRoots(cwd || "")) return json(res, 403, { error: "cwd outside allowed roots" });
      if (typeof cmd !== "string" || !cmd.trim()) return json(res, 400, { error: "empty command" });
      exec(cmd, { cwd, timeout: 60000, maxBuffer: 2e6 }, (err, stdout, stderr) => {
        json(res, 200, {
          out: String(stdout || "") + String(stderr || ""),
          code: err ? (err.code ?? 1) : 0,
          timedOut: !!(err && err.killed),
        });
      });
      return;
    }
    // Claude sidebar settings (custom prompt + default model).
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return json(res, 200, anyAgent(url).getSettings());
    }
    if (url.pathname === "/api/settings" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      anyAgent(url).applySettings(body);
      return json(res, 200, { ok: true });
    }
    // Past Claude chats: the Agent SDK already persists sessions for this
    // cwd (see agent.js) - these just read that back for the sidebar's
    // history view. The live session is excluded from the list.
    if (url.pathname === "/api/chats" && req.method === "GET") {
      return json(res, 200, await listPastChats(liveSessionIds()));
    }
    if (url.pathname.startsWith("/api/chats/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/chats/".length));
      return json(res, 200, await getPastChat(id));
    }
    // Claude Code parity: the CLI's own slash-command list, and the token/cost
    // counters behind the sidebar's usage bar (plan windows = the /usage data).
    if (url.pathname === "/api/commands" && req.method === "GET") {
      return json(res, 200, await anyAgent(url).refreshCommands());
    }
    if (url.pathname === "/api/usage" && req.method === "GET") {
      const a = anyAgent(url);
      return json(res, 200, { session: a.usage, plan: await a.planUsage() });
    }
    // v2: file operations from the tree's context menu. Delete goes to the
    // Recycle Bin (Microsoft.VisualBasic.FileIO) so it is reversible; the only
    // hard delete allowed is a pixel-layer sidecar (*.layers.json).
    if (url.pathname === "/api/fs" && req.method === "POST") {
      const b = JSON.parse(await readBody(req));
      const p = path.resolve(String(b.path || ""));
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      const isProjectDir = PROJECT_ROOTS.some((r) => path.dirname(p).toLowerCase() === r.toLowerCase() || p.toLowerCase() === r.toLowerCase());
      if (b.op === "mkfile") {
        if (fs.existsSync(p)) return json(res, 409, { error: "already exists" });
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, typeof b.content === "string" ? b.content : "", "utf8");
        return json(res, 200, { ok: true, path: p });
      }
      if (b.op === "mkdir") {
        await fsp.mkdir(p, { recursive: true });
        return json(res, 200, { ok: true, path: p });
      }
      if (b.op === "rename") {
        const np = path.resolve(String(b.newPath || ""));
        if (!insideRoots(np) || isProjectDir) return json(res, 403, { error: "cannot rename that" });
        if (fs.existsSync(np) && np.toLowerCase() !== p.toLowerCase()) return json(res, 409, { error: "target already exists" });
        await fsp.rename(p, np);
        return json(res, 200, { ok: true, path: np });
      }
      if (b.op === "delete") {
        if (isProjectDir) return json(res, 403, { error: "refusing to delete a whole project" });
        if (!fs.existsSync(p)) return json(res, 404, { error: "not found" });
        if (b.hard && /[.]layers[.]json$/i.test(p)) { await fsp.rm(p, { force: true }); return json(res, 200, { ok: true, hard: true }); }
        const isDir = fs.statSync(p).isDirectory();
        const ps = "Add-Type -AssemblyName Microsoft.VisualBasic; " +
          "[Microsoft.VisualBasic.FileIO.FileSystem]::" + (isDir ? "DeleteDirectory" : "DeleteFile") +
          "('" + p.replace(/'/g, "''") + "', 'OnlyErrorDialogs', 'SendToRecycleBin')";
        await new Promise((resolve, reject) => execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 30000 }, (err) => err ? reject(err) : resolve()));
        return json(res, 200, { ok: true, recycled: true });
      }
      return json(res, 400, { error: "unknown op" });
    }
    // v2: find in files. Case-insensitive substring over text files, capped.
    if (url.pathname === "/api/search") {
      const p = url.searchParams.get("path") || "";
      const q = (url.searchParams.get("q") || "").toLowerCase();
      if (!insideRoots(p)) return json(res, 403, { error: "path outside allowed roots" });
      if (q.length < 2) return json(res, 200, []);
      const hits = [];
      await searchFiles(p, p, q, hits);
      return json(res, 200, hits);
    }
    // v2: past-chat management (title + delete) and live-session facts.
    if (url.pathname.startsWith("/api/chats/") && req.method === "POST") {
      const id = decodeURIComponent(url.pathname.slice("/api/chats/".length));
      const b = JSON.parse(await readBody(req));
      await renamePastChat(id, String(b.title || "").slice(0, 120));
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/chats/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/chats/".length));
      if (liveSessionIds().includes(id)) return json(res, 400, { error: "that chat is live - close its tab first" });
      await deletePastChat(id);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/models") return json(res, 200, await anyAgent(url).models());
    if (url.pathname === "/api/account") return json(res, 200, await anyAgent(url).account());
    if (url.pathname === "/api/mcp") return json(res, 200, await anyAgent(url).mcp());
    if (url.pathname === "/api/context") return json(res, 200, await anyAgent(url).contextBreakdown());
    // Which chats are live right now (the sidebar re-adopts these after a reload).
    if (url.pathname === "/api/live") return json(res, 200, { chats: liveChats(), max: MAX_CHATS });
    // Screen capture. Nexus Point is a local workbench running on Tucker's own
    // machine, so this is a native grab (tools/screen.mjs) rather than the
    // browser's getDisplayMedia: no picker dialog per shot, it sees windows
    // outside the browser, and Claude can trigger the same code path itself.
    if (url.pathname === "/api/screen" && req.method === "GET") {
      if (url.searchParams.get("list")) return json(res, 200, { displays: await listDisplays() });
      const max = url.searchParams.get("max");
      const shot = await captureScreen({
        display: url.searchParams.get("display") || "all",
        maxEdge: max === null ? undefined : Number(max),
        by: "Tucker",
      });
      return json(res, 200, {
        media_type: "image/png",
        data: shot.png.toString("base64"),
        width: shot.width, height: shot.height,
        sourceWidth: shot.sourceWidth, sourceHeight: shot.sourceHeight,
        label: shot.label, displays: shot.displays, scaled: shot.scaled,
      });
    }
    // The exact frame Claude was last handed, so the sidebar can show Tucker
    // what was actually sent rather than asking him to trust it.
    if (url.pathname === "/api/screen/last") {
      const shot = lastCapture();
      if (!shot) { res.writeHead(404); return res.end("no capture yet"); }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return res.end(shot.png);
    }

    // Static: the app UI itself.
    let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    filePath = path.resolve(filePath);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end("not found"); }
    // This is a live workbench - never let the browser cache the UI's own files,
    // or an edit to app.js/pixel.js silently keeps serving the old one.
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

// Claude sidebar: WebSocket bridge to the Agent SDK session (see agent.js).
const clients = new Set();
function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const c of clients) { try { c.send(str); } catch {} }
}
// Several chats run at once, one Agent SDK query() each. The browser names them
// ("c1", "c2", ...) and every message in either direction carries that name, so
// a reply always lands in the tab that asked for it. Untagged events are global.
const agents = new Map();
function agentFor(id, create = true) {
  const key = String(id || "c1");
  let a = agents.get(key);
  if (!a && create) {
    if (agents.size >= MAX_CHATS) return null;
    a = createAgent((ev) => broadcast({ ...ev, chat: key }));
    agents.set(key, a);
    a.start();
  }
  return a || null;
}
// The chat the HTTP routes mean when no ?chat= is given: the first one open.
function anyAgent(url) {
  const want = url && url.searchParams.get("chat");
  if (want && agents.has(want)) return agents.get(want);
  return agents.values().next().value || agentFor("c1");
}
const liveSessionIds = () => [...agents.values()].map((a) => a.sessionId).filter(Boolean);
function liveChats() {
  return [...agents.entries()].map(([id, a]) => ({
    id, sessionId: a.sessionId, busy: a.busy, model: a.model, mode: a.mode, effort: a.effort,
  }));
}

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws);
  const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  send({ type: "live", chats: liveChats(), max: MAX_CHATS });
  for (const [id, a] of agents) {
    send({ type: "model", chat: id, model: a.model });
    send({ type: "mode", chat: id, mode: a.mode });
    send({ type: "effort", chat: id, effort: a.effort });
    send({ type: "usage", chat: id, session: a.usage });
    send({ type: "session", chat: id, sessionId: a.sessionId, busy: a.busy });
  }
  const first = agents.values().next().value;
  if (first) {
    send({ type: "commands", commands: first.commands });
    first.models().then((models) => send({ type: "models", models }));
  }
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    // "open" is the only message allowed to create a chat; everything else must
    // address one that already exists, so a stale tab cannot spawn agents.
    if (m.type === "open") {
      const existing = agents.get(String(m.chat));
      if (existing) { broadcast({ type: "opened", chat: String(m.chat), sessionId: existing.sessionId, existed: true }); return; }
      const a = agentFor(m.chat);
      if (!a) { broadcast({ type: "error", chat: String(m.chat), text: "Too many chats at once (limit " + MAX_CHATS + "). Close one first." }); return; }
      if (m.resume) a.resumeChat(m.resume);
      broadcast({ type: "opened", chat: String(m.chat), sessionId: a.sessionId, existed: false });
      return;
    }
    if (m.type === "close") {
      const a = agents.get(String(m.chat));
      if (a) { a.dispose(); agents.delete(String(m.chat)); }
      broadcast({ type: "closed", chat: String(m.chat) });
      return;
    }
    const agent = agentFor(m.chat, false);
    if (!agent) return;
    switch (m.type) {
      case "chat": if ((m.text && m.text.trim()) || (m.images && m.images.length)) agent.say(m.text || "", m.project, m.images, m.uuid); break;
      case "rewind": await agent.rewind(m.uuid, !!m.dryRun); break;
      case "stopTask": await agent.stopTask(m.taskId); break;
      case "refreshModels": ws.send(JSON.stringify({ type: "models", models: await agent.models() })); break;
      case "permission": agent.resolvePermission(m.id, m.allow, m.always, { updatedInput: m.updatedInput, message: m.message }); break;
      case "interrupt": await agent.interrupt(); break;
      case "setModel": await agent.setModel(m.model); break;
      case "setMode": await agent.setPermissionMode(m.mode); break;
      case "setEffort": await agent.setEffort(m.effort); break;
      case "resume": agent.resumeChat(m.sessionId); break;
      case "new": agent.newChat(); break;
    }
  });
});
agentFor("c1");

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Nexus Point running at http://localhost:${PORT}`);
});
