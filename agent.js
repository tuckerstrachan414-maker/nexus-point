// Claude sidebar backend - persistent Agent SDK session, wiring copied from jarvis.
// Subscription auth: NO API key, no .env. One query() for the whole server;
// cwd is the workspace root and each message names the active project.
//
// v2 (2026-09-03): streaming deltas, tool results, file checkpoints + rewind,
// image attachments, model list from the CLI, task/compact/notification
// events, persisted effort/mode/auto-allow settings, chat rename/delete.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  query, listSessions, getSessionMessages, renameSession, deleteSession,
  createSdkMcpServer, tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { captureScreen, listDisplays } from "./tools/screen.mjs";
import { sceneReport } from "./tools/scene-report.mjs";

// Derived, not written out: the workspace folder was renamed once and every
// hardcoded copy of the old name stranded the app. agent.js lives in
// <workspace>/Claude Projects/nexus-point/.
const NEXUS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(NEXUS_DIR, "..", "..").replaceAll(String.fromCharCode(92), "/");
// scene_report only reads, so it belongs here; mcp__nexus__screen deliberately
// does not - looking at Tucker's whole desktop is his call to make permanent.
const DEFAULT_SAFE_TOOLS = ["Read", "Glob", "Grep", "TodoWrite", "WebSearch", "WebFetch", "Task", "TaskOutput", "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__nexus__scene_report"];
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MODE = "default"; // default -> auto -> acceptEdits -> plan
const DEFAULT_EFFORT = "medium"; // low -> medium -> high -> xhigh -> max
const SETTINGS_PATH = path.join(NEXUS_DIR, "nexus-settings.json");
// Forward slashes on purpose: a backslash path inside a quoted shell command
// has been mangled here before, and Node takes either one on Windows.
const SPRITE_CLI = 'node "' + path.join(NEXUS_DIR, "tools", "sprite.mjs").replaceAll(String.fromCharCode(92), "/") + '"';
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Past chats: the SDK already persists every session as a JSONL transcript
// keyed by cwd, since agent.js always runs with cwd = WORKSPACE_ROOT. No
// homegrown history store needed - just read it back.
// exclude: a session id, or the ids of every chat that is live right now.
export async function listPastChats(exclude) {
  const skip = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);
  const sessions = await listSessions({ dir: WORKSPACE_ROOT, limit: 200 });
  return sessions
    .filter((s) => !skip.has(s.sessionId))
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((s) => ({
      id: s.sessionId,
      summary: s.customTitle || s.summary || s.firstPrompt || "(no prompt)",
      titled: !!s.customTitle,
      lastModified: s.lastModified,
      createdAt: s.createdAt || null,
      size: s.fileSize || 0,
    }));
}

export async function getPastChat(sessionId) {
  const msgs = await getSessionMessages(sessionId, { dir: WORKSPACE_ROOT });
  const out = [];
  for (const m of msgs) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    if (m.parent_tool_use_id) continue; // subagent traffic
    const content = m.message && m.message.content;
    if (typeof content === "string") {
      if (content.trim()) out.push({ role: m.type, text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && block.text && block.text.trim()) {
          out.push({ role: m.type, text: block.text });
        } else if (block.type === "tool_use") {
          out.push({ role: "tool", name: block.name, input: block.input });
        }
      }
    }
  }
  return out;
}

export function renamePastChat(sessionId, title) {
  return renameSession(sessionId, title, { dir: WORKSPACE_ROOT });
}
export function deletePastChat(sessionId) {
  return deleteSession(sessionId, { dir: WORKSPACE_ROOT });
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch { return {}; }
}

// Shared across every live chat. Auto-allow is one list for the whole app - an
// "Always" answered in one chat must hold in the others too - and model / prompt
// / mode / effort are the DEFAULTS a newly opened chat starts from, updated
// whenever a chat changes its own. nexus-settings.json holds exactly these.
const SHARED = (() => {
  const saved = loadSettings();
  return {
    model: saved.model || DEFAULT_MODEL,
    extraPrompt: saved.extraPrompt || "",
    mode: saved.mode || DEFAULT_MODE,
    effort: saved.effort || DEFAULT_EFFORT,
    autoAllow: Array.isArray(saved.autoAllow) ? saved.autoAllow : DEFAULT_SAFE_TOOLS.slice(),
  };
})();
function persistShared() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
      model: SHARED.model, extraPrompt: SHARED.extraPrompt, mode: SHARED.mode,
      effort: SHARED.effort, autoAllow: SHARED.autoAllow,
    }, null, 2));
  } catch {}
}

function systemPrompt(extraPrompt) {
  let base = [
    "You are the Claude sidebar inside Nexus Point, Tucker's local workbench for his game projects.",
    "You collaborate on whichever project he has open; a user message is prefixed with the active project path when it changes.",
    "Before editing a project, read its CLAUDE.md and SESSION-HANDOFF.md if they exist - conventions and invariants live there.",
    "Tucker is a solo dev shipping small browser games. Iteration speed beats ceremony. Smallest change that proves the idea.",
    "His no-build projects must keep working by opening index.html from file:// - never add build steps or frameworks.",
    "Keep replies short and concrete. Lead with the outcome. He reads you in a sidebar that renders markdown: short lists are fine, walls of text are not.",
    "When he asks a design or product question, give ONE recommendation with reasoning, not a menu.",
    "",
    "Nexus Point around you: a Code tab (editor), a Play tab that runs the project in an iframe and shows its console output,",
    "an Assets tab, a Pixel tab (pixel editor with layers, cells/frames, palettes) and a Run tab for one-shot commands.",
    "Messages may arrive with attached file paths or pasted images; treat attached files as the thing he is looking at.",
    "",
    "You can see his actual screen. The mcp__nexus__screen tool screenshots his whole desktop and hands you",
    "the image. Reach for it the moment he says look at my screen / see this / what is wrong with this,",
    "or describes something visual you cannot get from a file - a dialog, a game mid-play, another app.",
    "The shot arrives downscaled, so small text can be unreadable: say what you cannot make out and ask",
    "him to zoom in, never guess at it. Do not take a screenshot he did not ask for.",
    "",
    "In the Pixel tab he can ring a region with the selection tools and send it over. When a message gives",
    "you a selection rectangle, that rectangle IS the thing he is asking about: work inside it and leave the",
    "rest of the sheet alone unless he says otherwise. The rectangle is in whole-image pixel coordinates and",
    "sprite.mjs show --rect x,y,w,h reads exactly that area back as text.",
    "",
    "You can read AND edit sprite pixels. Run `" + SPRITE_CLI + "`",
    "with no arguments for the full usage. In short: `show` prints a frame as one character per pixel",
    "with a colour legend (this is how you SEE pixel art), `diff --bak --art` shows exactly what Tucker",
    "just changed in the Pixel tab, `write --art` puts an edited grid back byte-exactly, and `find`",
    "reports whether a patch recurs in other frames (100% = a paste is safe, less = the art differs",
    "there and must be redrawn by hand).",
    "When he asks you to apply an edit to the other frames of a sheet: read his change with `diff`,",
    "run `find` to see which frames genuinely repeat that art, paste only into the frames that match,",
    "and REDRAW the rest frame by frame at that frame's own angle and pose - never paste a mismatched",
    "patch, and never claim a frame is done that you have not looked at with `show` afterwards.",
    "A PNG may have a `<name>.png.layers.json` sidecar beside it (the Pixel tab's layers). If you edit",
    "the PNG directly, the Pixel tab drops the stale sidecar on next open - mention that when relevant.",
    "",
    "The Play tab has an Edit button: scene mode. Tucker clicks an element in the running project and",
    "edits its colours, size, text and position, and Nexus splices the change into the real file with a",
    "first-write .bak. It works on any DOM without the project doing anything. It does NOT work on things",
    "drawn on a canvas unless that project publishes a scene adapter - a canvas is one opaque rectangle",
    "and nothing in the browser knows what was drawn there.",
    "When he asks for nexus-repair (or asks why he cannot click something in a game): run",
    "mcp__nexus__scene_report on the project FIRST, then read",
    NEXUS_DIR.replaceAll(String.fromCharCode(92), "/") + "/docs/NEXUS-REPAIR.md and follow it exactly.",
    "That file is the playbook - the contract it writes against is docs/NEXUS-SCENE-ADAPTER.md beside it.",
    "The short version: additive only unless he says deep, back up first, tell him what you could NOT",
    "make editable and why, and load the game in the Play tab with a clean console before saying done.",
  ].join("\n");
  // Tucker-authored additions from the settings panel.
  if (extraPrompt && extraPrompt.trim()) base += "\n\n" + extraPrompt.trim();
  return base;
}

export function createAgent(broadcast) {
  let queryHandle = null;
  let currentModel = SHARED.model;
  let extraPrompt = SHARED.extraPrompt;
  let currentMode = SHARED.mode;
  let currentEffort = SHARED.effort;
  let currentSessionId = null;
  let disposed = false;
  let abortCtl = null;
  let lastProject = null;
  let busy = false;
  const inputQueue = [];
  let waiter = null;
  const pendingPerms = new Map();
  // Claude Code parity state: the CLI's own slash-command list, model list,
  // running token counters, and the session id to resume into on next start().
  let commands = [];
  let models = [];
  let account = null;
  let resumeId = null;
  const sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, turns: 0 };
  // tool_use id -> file path for Edit/Write, so the UI can refresh that file
  // the moment the tool result lands (not only when the whole turn ends).
  const editTargets = new Map();
  const toolNames = new Map();

  // This chat's choices become the defaults the next new chat opens with.
  function persist() {
    SHARED.model = currentModel; SHARED.extraPrompt = extraPrompt;
    SHARED.mode = currentMode; SHARED.effort = currentEffort;
    persistShared();
  }
  const autoAllowList = () => SHARED.autoAllow;

  function enqueue(content, uuid) {
    inputQueue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
      uuid,
    });
    if (waiter) { waiter(); waiter = null; }
  }

  async function* inputStream() {
    while (true) {
      if (inputQueue.length === 0) await new Promise((r) => (waiter = r));
      while (inputQueue.length) yield inputQueue.shift();
    }
  }

  async function canUseTool(toolName, input, { suggestions, blockedPath }) {
    if (autoAllowList().includes(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const id = "perm-" + Math.random().toString(36).slice(2);
    broadcast({ type: "permission", id, tool: toolName, input, suggestions: suggestions || [], blockedPath: blockedPath || null });
    return await new Promise((resolve) => {
      pendingPerms.set(id, (decision) => {
        broadcast({ type: "permission-resolved", id, allow: !!decision.allow });
        if (decision.allow) {
          // AskUserQuestion: the answers picked in the sidebar ride back on the
          // input, which is how the CLI expects a host to answer it.
          // "Always" has to stick even when the CLI offers no permission suggestion -
          // it offers none for MCP tools like mcp__nexus__screen - so remember the tool
          // on our side as well. autoAllow is what canUseTool checks first.
          if (decision.always && !autoAllowList().includes(toolName)) {
            SHARED.autoAllow.push(toolName); persistShared();
            broadcast({ type: "auto-allow", tools: SHARED.autoAllow.slice() });
          }
          const updatedInput = decision.updatedInput ? { ...input, ...decision.updatedInput } : input;
          resolve({
            behavior: "allow",
            updatedInput,
            updatedPermissions: decision.always && suggestions && suggestions.length ? suggestions : undefined,
          });
        } else {
          resolve({ behavior: "deny", message: decision.message || "Tucker declined this action from Nexus Point." });
        }
      });
    });
  }

  // Streaming text arrives as many tiny deltas; coalesce them per ~30ms so the
  // WebSocket is not flooded and the sidebar repaints at a sane rate.
  const deltaBuf = { text: "", thinking: "" };
  let deltaTimer = null;
  function flushDeltas() {
    deltaTimer = null;
    if (deltaBuf.thinking) { broadcast({ type: "delta", kind: "thinking", text: deltaBuf.thinking }); deltaBuf.thinking = ""; }
    if (deltaBuf.text) { broadcast({ type: "delta", kind: "text", text: deltaBuf.text }); deltaBuf.text = ""; }
  }
  function pushDelta(kind, text) {
    deltaBuf[kind] += text;
    if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 30);
  }

  function handleStreamEvent(msg) {
    if (msg.parent_tool_use_id) return; // subagent chatter stays out of the main log
    const ev = msg.event || {};
    if (ev.type === "message_start") { flushDeltas(); broadcast({ type: "stream-start" }); }
    else if (ev.type === "content_block_start") {
      const cb = ev.content_block || {};
      if (cb.type === "tool_use") { flushDeltas(); broadcast({ type: "tool-pending", id: cb.id, name: cb.name }); }
      else if (cb.type === "text" || cb.type === "thinking") broadcast({ type: "block-start", kind: cb.type });
    }
    else if (ev.type === "content_block_delta") {
      const d = ev.delta || {};
      if (d.type === "text_delta" && d.text) pushDelta("text", d.text);
      else if (d.type === "thinking_delta" && d.thinking) pushDelta("thinking", d.thinking);
    }
    else if (ev.type === "message_stop") { flushDeltas(); broadcast({ type: "stream-end" }); }
  }

  function summarizeToolResult(block) {
    let text = "";
    if (typeof block.content === "string") text = block.content;
    else if (Array.isArray(block.content)) {
      text = block.content.map((c) => (c && c.type === "text" ? c.text : c && c.type === "image" ? "[image]" : "")).join("\n");
    }
    const MAX = 6000;
    return text.length > MAX ? text.slice(0, MAX) + "\n... (" + (text.length - MAX) + " more chars)" : text;
  }

  function handleAgentMessage(msg) {
    if (msg.type === "stream_event") return handleStreamEvent(msg);
    if (msg.type === "system") {
      switch (msg.subtype) {
        case "init":
          currentSessionId = msg.session_id || null;
          broadcast({ type: "ready", sessionId: currentSessionId, model: msg.model, mode: currentMode, effort: currentEffort });
          if (commands.length === 0) refreshCommands();
          if (models.length === 0) refreshModels();
          if (!account) refreshAccount();
          pushContextUsage();
          setTimeout(() => { if (!commands.length) refreshCommands(); if (!models.length) refreshModels(); if (!account) refreshAccount(); }, 4000);
          return;
        // Whatever a slash command printed locally (/context, /cost, /status...).
        case "local_command_output":
          broadcast({ type: "local", text: msg.content });
          return;
        // The CLI pushes a fresh list when skills/commands appear mid-session.
        case "commands_changed":
          commands = msg.commands || [];
          broadcast({ type: "commands", commands });
          return;
        case "status":
          broadcast({ type: "status", text: msg.status || "idle", compact: msg.compact_result || null });
          return;
        case "session_state_changed":
          busy = msg.state !== "idle";
          broadcast({ type: "state", state: msg.state });
          return;
        case "compact_boundary": {
          const cm = msg.compact_metadata || {};
          broadcast({ type: "compact", trigger: cm.trigger, pre: cm.pre_tokens || 0, post: cm.post_tokens || 0 });
          pushContextUsage();
          return;
        }
        case "api_retry":
          broadcast({ type: "status", text: "retry", attempt: msg.attempt, max: msg.max_retries, error: msg.error || null });
          return;
        case "task_started":
          broadcast({ type: "task", id: msg.task_id, status: "started", description: msg.description || "", toolUseId: msg.tool_use_id || null, kind: msg.subagent_type || msg.task_type || "" });
          return;
        case "task_notification":
          broadcast({ type: "task", id: msg.task_id, status: msg.status, summary: msg.summary || "", toolUseId: msg.tool_use_id || null, usage: msg.usage || null });
          return;
        case "notification":
          broadcast({ type: "notice", text: msg.text, level: msg.priority === "high" || msg.priority === "immediate" ? "warn" : "info" });
          return;
        case "informational":
          broadcast({ type: "notice", text: msg.content, level: msg.level === "warning" ? "warn" : "info" });
          return;
        case "permission_denied":
          broadcast({ type: "tool-denied", id: msg.tool_use_id, name: msg.tool_name });
          return;
        default:
          return;
      }
    }
    if (msg.type === "assistant") {
      if (msg.parent_tool_use_id) return;
      if (msg.error) broadcast({ type: "error", text: "API error: " + msg.error });
      const texts = [];
      for (const block of (msg.message && msg.message.content) || []) {
        if (block.type === "text" && block.text && block.text.trim()) {
          texts.push(block.text);
        } else if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
          broadcast({ type: "thinking", text: block.thinking });
        } else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          const inp = block.input || {};
          if (EDIT_TOOLS.has(block.name) && (inp.file_path || inp.notebook_path)) editTargets.set(block.id, inp.file_path || inp.notebook_path);
          broadcast({ type: "tool", id: block.id, name: block.name, input: inp, status: autoAllowList().includes(block.name) ? "auto" : "run" });
        }
      }
      if (texts.length) broadcast({ type: "assistant", uuid: msg.uuid, text: texts.join("\n\n") });
      return;
    }
    // Tool results come back as user messages carrying tool_result blocks.
    if (msg.type === "user") {
      if (msg.parent_tool_use_id) return;
      const content = msg.message && msg.message.content;
      if (!Array.isArray(content)) return;
      const changed = [];
      for (const block of content) {
        if (!block || block.type !== "tool_result") continue;
        broadcast({
          type: "tool-result", id: block.tool_use_id, name: toolNames.get(block.tool_use_id) || "",
          content: summarizeToolResult(block), isError: !!block.is_error,
        });
        const target = editTargets.get(block.tool_use_id);
        if (target && !block.is_error) changed.push(target);
        editTargets.delete(block.tool_use_id);
      }
      if (changed.length) broadcast({ type: "files-changed", paths: changed });
      return;
    }
    if (msg.type === "prompt_suggestion") {
      if (msg.suggestion) broadcast({ type: "suggestion", text: msg.suggestion });
      return;
    }
    if (msg.type === "rate_limit_event") {
      broadcast({ type: "rate-limit", info: msg.rate_limit_info || null });
      return;
    }
    if (msg.type === "result") {
      flushDeltas();
      const u = msg.usage || {};
      const turn = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
      };
      sessionUsage.input += turn.input;
      sessionUsage.output += turn.output;
      sessionUsage.cacheRead += turn.cacheRead;
      sessionUsage.cacheCreate += turn.cacheCreate;
      sessionUsage.turns += 1;
      // total_cost_usd on a result is the CLI's running session total, not this
      // turn's - assign it, never add, or the counter double-counts every turn.
      sessionUsage.cost = msg.total_cost_usd || sessionUsage.cost;
      busy = false;
      broadcast({ type: "usage", turn, session: { ...sessionUsage } });
      broadcast({
        type: "done", cost: msg.total_cost_usd || 0, durationMs: msg.duration_ms || 0,
        numTurns: msg.num_turns || 0, isError: !!msg.is_error, subtype: msg.subtype,
        errors: Array.isArray(msg.errors) ? msg.errors : [],
        denials: (msg.permission_denials || []).length,
        userMessageUuid: msg.user_message_uuid || null,
      });
      pushContextUsage();
    }
  }

  // Context-window fill for the token gauge - the same numbers /context prints.
  // It is a control request, so it can fail while the session is restarting;
  // never let that break a turn.
  async function pushContextUsage() {
    try {
      const c = await queryHandle?.getContextUsage();
      if (c) broadcast({ type: "context", used: c.totalTokens, max: c.maxTokens, percentage: c.percentage, model: c.model || null });
    } catch {}
  }

  // Every slash command this session knows: built-ins, plus project commands and
  // skills the CLI discovers. The sidebar's "/" menu is built from this.
  async function refreshCommands() {
    try { commands = (await queryHandle?.supportedCommands()) || []; } catch { commands = []; }
    broadcast({ type: "commands", commands });
    return commands;
  }
  async function refreshModels() {
    try {
      const list = (await queryHandle?.supportedModels()) || [];
      models = list.map((m) => ({ value: m.value, resolved: m.resolvedModel || null, name: m.displayName, description: m.description || "", effort: m.supportsEffort !== false }));
    } catch { models = []; }
    if (models.length) broadcast({ type: "models", models });
    return models;
  }
  async function refreshAccount() {
    try { account = (await queryHandle?.accountInfo()) || null; } catch { account = null; }
    if (account) broadcast({ type: "account", account });
    return account;
  }

  // ---- Claude's eyes: an in-process MCP server holding the screen tools ----
  // Tucker says look at my screen and Claude takes the shot itself rather than
  // him capturing and pasting one. The PNG goes back as the tool result; the
  // sidebar is told at the same time so it can show him the same frame.
  const screenServer = createSdkMcpServer({
    name: "nexus",
    version: "1.0.0",
    alwaysLoad: true,
    instructions: "Nexus Point runs on Tucker's own Windows machine. These tools look at his real screen.",
    tools: [
      tool(
        "screen",
        "Screenshot Tucker's screen and look at it. Use it whenever he asks you to look at, check or see " +
        "his screen, or points at something visual that is not in a file - an error dialog, a game mid-play, " +
        "a layout that reads wrong, another app. Captures every monitor stitched together by default.",
        {
          display: z.string().optional().describe("all (the default) for every monitor stitched together, or a display index from mcp__nexus__screen_displays."),
          reason: z.string().optional().describe("One short line on what you are looking for. Shown to Tucker in the sidebar."),
        },
        async (args) => {
          try {
            const shot = await captureScreen({ display: (args && args.display) || "all", by: "Claude" });
            broadcast({ type: "screen", by: "claude", at: Date.now(), width: shot.width, height: shot.height,
              label: shot.label, reason: (args && args.reason) || null });
            const note = shot.label + ", " + shot.sourceWidth + "x" + shot.sourceHeight + " pixels" +
              (shot.scaled ? " (you are seeing it at " + shot.width + "x" + shot.height + ", so a distance you measure here is " +
                (shot.sourceWidth / shot.width).toFixed(2) + "x that on his screen)" : "") +
              (shot.displays > 1 ? ". " + shot.displays + " monitors, stitched side by side" : "") + ".";
            return { content: [
              { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
              { type: "text", text: "Screenshot of " + note },
            ] };
          } catch (e) {
            return { content: [{ type: "text", text: "Screen capture failed: " + String(e.message || e) }], isError: true };
          }
        },
      ),
      tool(
        "scene_report",
        "Survey what in a project is editable in Nexus Point and what is not: its canvases and draw " +
        "entry points, art that exists only as code (ctx.* shape drawing with no image behind it), " +
        "inline SVG, data: image URIs, emoji used as sprites, hardcoded colours, and whether it " +
        "already has a scene adapter or design registry. Read-only. Run this FIRST when Tucker asks " +
        "for /nexus-repair, or whenever he asks why he cannot click or edit something in a game.",
        {
          project: z.string().describe("Full path to the project folder, e.g. C:/AI workspace/Claude Projects/sky-hopper"),
        },
        async (args) => {
          try {
            return { content: [{ type: "text", text: sceneReport(String((args && args.project) || "")) }] };
          } catch (e) {
            return { content: [{ type: "text", text: "Scene report failed: " + String(e.message || e) }], isError: true };
          }
        },
      ),
      tool(
        "screen_displays",
        "List Tucker's monitors with their sizes and positions. Only needed when you want one screen " +
        "instead of the whole desktop.",
        {},
        async () => {
          try {
            const ds = await listDisplays();
            const text = ds.map((d) => d.index + ": " + d.w + "x" + d.h + " at " + d.x + "," + d.y +
              (d.primary ? " (primary)" : "") + " " + d.name).join(String.fromCharCode(10));
            return { content: [{ type: "text", text: text || "no displays reported" }] };
          } catch (e) {
            return { content: [{ type: "text", text: "Could not list displays: " + String(e.message || e) }], isError: true };
          }
        },
      ),
    ],
  });

  function start() {
    // Closure-local so a later restart reassigning abortCtl cannot fool the
    // catch below into reporting a deliberate abort as a crash.
    const myCtl = new AbortController();
    abortCtl = myCtl;
    // resumeChat() parks an id here; consume it so a later restart does not
    // silently reopen the same past chat.
    const resumeFrom = resumeId;
    resumeId = null;
    for (const k of Object.keys(sessionUsage)) sessionUsage[k] = 0;
    busy = false;
    // Pending permission cards belong to the old query - resolve them as denied
    // so nothing awaits forever, and tell the sidebar to drop them.
    for (const [id, fn] of pendingPerms) { fn({ allow: false, message: "session restarted" }); pendingPerms.delete(id); }
    queryHandle = query({
      prompt: inputStream(),
      options: {
        model: currentModel,
        resume: resumeFrom || undefined,
        systemPrompt: systemPrompt(extraPrompt),
        settingSources: [],
        includePartialMessages: true,
        enableFileCheckpointing: true,
        promptSuggestions: true,
        cwd: WORKSPACE_ROOT,
        mcpServers: { nexus: screenServer },
        canUseTool,
        permissionMode: currentMode,
        effort: currentEffort,
        abortController: myCtl,
      },
    });
    (async () => {
      for await (const msg of queryHandle) {
        try { handleAgentMessage(msg); } catch (e) { console.error("handle error", e); }
      }
    })().catch((e) => {
      if (myCtl.signal.aborted) return; // deliberate restart, not a crash
      console.error("agent loop crashed:", e);
      busy = false;
      broadcast({ type: "error", text: "Claude session crashed: " + String(e.message || e) });
    });
  }

  function dispose() {
    disposed = true;
    for (const [id, fn] of pendingPerms) { fn({ allow: false, message: "chat closed" }); pendingPerms.delete(id); }
    try { abortCtl?.abort(); } catch {}
    queryHandle = null;
  }

  function restart() {
    const old = abortCtl;
    lastProject = null; // fresh session: re-announce the active project
    if (old) old.abort();
    start();
  }

  return {
    start,
    dispose,
    get disposed() { return disposed; },
    // text: the prompt; images: [{media_type, data(base64)}]; uuid: the client's
    // id for this user message - it is also the checkpoint id rewind() uses.
    say(text, projectPath, images, uuid) {
      uuid = uuid || crypto.randomUUID();
      let msg = text;
      // A slash command must start the message or the CLI reads it as prose, so
      // the "[Active project: ...]" banner waits for the next ordinary message.
      const isCommand = text.trim().startsWith("/");
      if (!isCommand && projectPath && projectPath !== lastProject) {
        lastProject = projectPath;
        msg = "[Active project: " + projectPath + "]\n\n" + text;
      }
      let content = msg;
      if (Array.isArray(images) && images.length) {
        content = images.slice(0, 8).map((im) => ({
          type: "image",
          source: { type: "base64", media_type: im.media_type || "image/png", data: im.data },
        }));
        content.push({ type: "text", text: msg || "(see attached image)" });
      }
      const queued = busy;
      busy = true;
      broadcast({ type: "user", text, uuid, images: Array.isArray(images) ? images.length : 0, queued });
      broadcast({ type: "status", text: "thinking" });
      enqueue(content, uuid);
    },
    resolvePermission(id, allow, always, extra) {
      const fn = pendingPerms.get(id);
      if (fn) { pendingPerms.delete(id); fn({ allow, always, updatedInput: extra && extra.updatedInput, message: extra && extra.message }); }
    },
    async interrupt() {
      try { await queryHandle?.interrupt(); } catch {}
      busy = false;
      broadcast({ type: "status", text: "idle" });
    },
    async setModel(model) {
      currentModel = model;
      try { await queryHandle?.setModel(model); } catch (e) { broadcast({ type: "error", text: "Couldn't change model: " + String(e.message || e) }); }
      persist();
      broadcast({ type: "model", model });
      pushContextUsage();
    },
    // Live, no restart - the SDK supports changing this mid-session. Only move
    // the stored value AFTER the CLI accepts, and always echo what is in force.
    async setPermissionMode(mode) {
      try {
        await queryHandle?.setPermissionMode(mode);
        currentMode = mode;
        persist();
      } catch (e) {
        // e.g. "auto mode unavailable for this model" - keep the old mode and
        // echo it back so the button snaps to what is really in force.
        broadcast({ type: "error", text: "Couldn't change mode: " + String(e.message || e) });
      }
      broadcast({ type: "mode", mode: currentMode });
    },
    async setEffort(effort) {
      try {
        await queryHandle?.applyFlagSettings({ effortLevel: effort });
        currentEffort = effort;
        persist();
      } catch (e) {
        broadcast({ type: "error", text: "Couldn't change effort: " + String(e.message || e) });
      }
      broadcast({ type: "effort", effort: currentEffort });
    },
    // Rewind files to the state at a user message (Claude Code's Esc Esc).
    async rewind(uuid, dryRun) {
      if (!uuid) return;
      let result;
      try { result = await queryHandle?.rewindFiles(uuid, { dryRun: !!dryRun }); }
      catch (e) { result = { canRewind: false, error: String(e.message || e) }; }
      broadcast({ type: "rewound", uuid, dryRun: !!dryRun, result: result || { canRewind: false, error: "no session" } });
    },
    async stopTask(taskId) {
      try { await queryHandle?.stopTask(taskId); } catch (e) { broadcast({ type: "error", text: "Couldn't stop task: " + String(e.message || e) }); }
    },
    refreshCommands,
    models: async () => (models.length ? models : refreshModels()),
    account: async () => account || refreshAccount(),
    async mcp() { try { return (await queryHandle?.mcpServerStatus()) || []; } catch { return []; } },
    async contextBreakdown() {
      try {
        const c = await queryHandle?.getContextUsage();
        if (!c) return null;
        return { used: c.totalTokens, max: c.maxTokens, percentage: c.percentage, model: c.model || null,
          categories: (c.categories || []).map((x) => ({ name: x.name, tokens: x.tokens })),
          memoryFiles: (c.memoryFiles || []).map((f) => ({ path: f.path, tokens: f.tokens })) };
      } catch { return null; }
    },
    get commands() { return commands; },
    get usage() { return { ...sessionUsage }; },
    get busy() { return busy; },
    // The structured data behind Claude Code's /usage: session cost plus the
    // 5-hour and 7-day plan windows. Experimental SDK API - null means "not
    // available", which the sidebar must render as a note, not an error.
    async planUsage() {
      try { return await queryHandle?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); }
      catch { return null; }
    },
    // Continue a past chat: restart the query with resume=<id> so the CLI loads
    // that transcript back into context.
    resumeChat(sessionId) {
      resumeId = sessionId;
      restart();
      broadcast({ type: "resumed", sessionId });
    },
    // Start a brand-new chat. The old session stops being "current", so
    // listPastChats() picks it up from here on.
    newChat() {
      resumeId = null;
      currentSessionId = null;
      restart();
      broadcast({ type: "new" });
    },
    get model() { return currentModel; },
    get mode() { return currentMode; },
    get effort() { return currentEffort; },
    get sessionId() { return currentSessionId; },
    getSettings() { return { model: currentModel, extraPrompt, mode: currentMode, effort: currentEffort, autoAllow: SHARED.autoAllow.slice(), defaultAutoAllow: DEFAULT_SAFE_TOOLS.slice() }; },
    // Model / prompt / auto-allow changes need a fresh query(); mode and effort
    // are live (setPermissionMode/setEffort) so they never restart.
    applySettings(next) {
      let needsRestart = false;
      if (typeof next.model === "string" && next.model && next.model !== currentModel) { currentModel = next.model; needsRestart = true; }
      if (typeof next.extraPrompt === "string" && next.extraPrompt !== extraPrompt) { extraPrompt = next.extraPrompt; needsRestart = true; }
      if (Array.isArray(next.autoAllow)) {
        const clean = next.autoAllow.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
        if (JSON.stringify(clean) !== JSON.stringify(SHARED.autoAllow)) SHARED.autoAllow = clean;
      }
      persist();
      if (needsRestart || next.forceRestart) restart();
      broadcast({ type: "model", model: currentModel });
      broadcast({ type: "settings-applied", restarted: !!(needsRestart || next.forceRestart) });
    },
  };
}
