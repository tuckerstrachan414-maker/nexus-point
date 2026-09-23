# Nexus Point

Local workbench for Tucker's Claude Code projects: browse, edit, play-test, draw
sprites, run commands and work with Claude - the goal is a program that replaces
the terminal for day-to-day work and bridges AI and hand-made creativity. Node
server (two npm deps) with a browser UI - deliberately NOT Electron (C: drive is
small; Jarvis pattern already proven). Started 2026-07-30; v2 rebuild 2026-09-03.

## Test
`node smoke-test.mjs` with the server running (add `--chat` for a live Claude
round-trip - costs one small subscription message). Expect "158 passed, 0 failed".
To test without disturbing the live instance: `NEXUS_PORT=4001 node server.js`
then `NEXUS_PORT=4001 node smoke-test.mjs`.

## Run it
Double-click `Start Nexus Point.bat` (it cd's to its own folder, so it survives a
workspace rename), or `node server.js` from this folder, then open
http://localhost:4000
Deep link: `http://localhost:4000/?project=<name>&file=<relative\path>`
`&tab=preview|assets|pixel|design|run`

## Where it lives
The workspace is `C:\AI workspace` today, and `C:\AI workspace\Claude Projects`
beside it. **Do not write either path into source.** It was `C:\Local AI` until
2026-09-21, and every hardcoded copy of that stranded the app - zero projects in
the picker, an agent cwd that did not exist. `server.js` and `agent.js` derive
the roots from their own location, and the browser reads them from `/api/env`.
Grep `const WORKSPACE_ROOT` in both, and `"/api/env"` in pixel.js and chat.js.

## Layout (v2, 2026-09-03)
- `server.js` - http server: static UI + file APIs (`/api/projects`, `/api/tree`,
  `/api/file` GET/POST, `/api/fs` mkfile/mkdir/rename/delete, `/api/search`,
  `/api/assets`, `/api/upload`, `/api/image` (+`new=1`), `/api/export`, `/api/run`,
  `/api/settings`, `/api/chats` (+rename/delete), `/api/models`, `/api/account`,
  `/api/screen` (+`list=1`, `/last`), `/api/env`,
  `/api/scene/edit` (surgical splices, 409 on a stale offset), `/api/scene/file`
  (text write + first-write `.bak`), `/api/scene/registry`, `/api/scene/resolve`,
  `/api/mcp`, `/api/context`, `/api/usage`, `/api/commands`) and the WebSocket
  bridge. Grep `function insideRoots(` for the path guard, `searchFiles(` for find in
  files, `/_nexus-console.js` for the Play-tab console injection. `NEXUS_PORT` env
  picks the port (default 4000).
- `agent.js` - Claude sidebar backend (Agent SDK, subscription auth). One
  `createAgent()` per live chat, each with its own `query()`; `SHARED` at module
  scope holds the one auto-allow list and the defaults a new chat opens with.
  Grep `function createAgent(`, `const SHARED`, `dispose(`, `handleStreamEvent(` (streaming deltas),
  `handleAgentMessage(` (every SDK event -> sidebar event), `canUseTool(` (permission
  gate + AskUserQuestion answers), `say(` (images, uuid = checkpoint id), `rewind(`,
  `applySettings(`.
- `public/index.html` - the page. `public/styles.css` - one token set (`:root`).
- `public/ui.js` - shared primitives: `NexusUI.popover/menuAt/modal/confirm/prompt/
  toast/resizer`. Every pane uses these; never `alert/prompt/confirm`.
- `public/icons.js` - SVG icon registry, `NexusIcons.svg(name)`; `<i data-icon=...>`
  elements are filled by `NexusIcons.mount()`. Add an icon = one row in `P`.
- `public/app.js` - shell: project picker, tree (filter, context menu, file ops),
  multi-tab editor, find/replace, panels, shortcuts, deep links. Grep `function openFile(`,
  `function showTab(`, `function reloadTab(`, `function treeMenu(`, `window.NexusApp`.
- `public/chat.js` - sidebar frontend, several chats at once. `CHATS` holds one
  state object per chat (its own scroll pane, tool rows, todos, draft,
  attachments, usage); `A` is the chat on screen and `R` the chat being drawn
  into. Grep `function makeChat(`, `function activate(`, `function renderTabs(`,
  `function handleEvent(`, `function onLive(`, `function renderMarkdown(`, `onDelta(`,
  `TOOL_VIEW` (how each tool renders), `function addPermission(`, `questionForm(`,
  `buildMessage(` (attachments -> prompt), `QUICK_ACTIONS`, `function connect(`
  (the event switch), `window.NexusChat`.
- `public/tabs.js` - center tabs, Play console, Assets grid, Run tab. Grep `addConsole(`,
  `function assetCard(`, `function openInDesign(`, `runCommand(`, `window.NexusTabs`.
- `public/scene.js` - the Play tab's Edit mode (session 12). Reads the same-origin
  preview iframe directly and draws its overlay in THIS page, never in the game's
  DOM. Grep `const PROPS` (property registry), `function enter(`, `function select(`,
  `function collectRules(` (which stylesheet owns a value), `function readObjects(`
  (the canvas adapter), `function commit(` (the write), `window.NexusScene`.
- `public/design.js` - the Design tab, vector art (session 12). The document IS a
  live `<svg>` in the page, so nothing this editor does not model can be lost.
  Grep `const GEO` (geometry registry), `const TOOLS`, `const PROPS`, `const MENUS`,
  `function mount(`, `function open(`, `async function save(`, `function serialize(`,
  `exportPng(`, `window.NexusDesign`.
- `tools/scene-report.mjs` - read-only survey of what in a project is editable and
  what is not. Library (`sceneReport`) plus a CLI; also `mcp__nexus__scene_report`.
- `docs/NEXUS-REPAIR.md` - the /nexus-repair playbook, and the ONE copy of it.
  `docs/NEXUS-SCENE-ADAPTER.md` - the `window.__NEXUS_SCENE__` contract.
  `.claude/skills/nexus-repair/SKILL.md` - the same thing for terminal sessions.
- `public/pixel.js` - the Pixel tab. State objects `D` (document/layers), `V` (view),
  `T` (tool settings), `C` (colours), `SEL`, `FLOAT`, `CELL`, `H` (history). Grep
  `TOOLS` (tool registry), `MENUS` (menu registry), `function applyStroke(`,
  `function commitPatch(` (undo), `function open(`, `async function save(`,
  `saveSidecar(`, `function render(`, `askClaude(`, `window.NexusPixel`.
- `public/_nexus-console.js` - injected into every /preview/ HTML page; forwards
  console output and errors to the Play tab via postMessage.
- `tools/png.mjs`, `tools/sprite.mjs` - Claude's pixel read/write CLI (session 7).
- `tools/screen.mjs` - native desktop capture (session 10). Library (`captureScreen`,
  `listDisplays`, `lastCapture`) and a CLI. PowerShell + System.Drawing, no npm dep.
- `nexus-settings.json` - persisted Claude settings (model, extra prompt, mode,
  effort, autoAllow). Generated; safe to delete.
- `_backups/` - pre-v2 zip. `public/vendor/codemirror/` - CodeMirror 5.65.16.
- `Start Nexus Point.bat` - launcher (opens browser + starts server).

## Invariants
- Port 4000 (jarvis=3900, office=3001, PGT serve=8000, RTS dev=8123 — don't collide).
- npm dependencies: @anthropic-ai/claude-agent-sdk + ws ONLY (landed session 2, ~291 MB). Never add more without asking.
  agent.js also imports `zod` (session 10) for the MCP tool schema. Nothing new was
  installed - zod ships underneath the Agent SDK, which cannot work without it - and
  it stays out of package.json deliberately. Do not add it, and do not add anything else.
- Every file API call must pass `insideRoots()` — projects live under the
  workspace root and its `Claude Projects` folder only, both DERIVED from
  `__dirname`. Never widen this to whole-disk and never hardcode the path.
- The app edits Tucker's REAL project folders in place (his sign-off 2026-07-30).
  No import/copy step. Respect each target project's own invariants when editing through it.
- Vendor libraries are committed files, never CDN links — app must work offline.
- The pixel editor writes PNG bytes, so it only ever opens/saves `.png`. Do not
  widen it to .jpg/.gif/.webp — saving would silently change the file's format.
- `/api/image` must keep making a `<file>.png.bak` on the FIRST save of a file and
  must never overwrite an existing .bak. That backup is the only undo for image
  edits in projects with no git.
- Static UI files are served `Cache-Control: no-store`. Keep it — a cached
  styles.css has already caused one phantom layout bug here.
- The Pixel tab must never save when nothing changed: a no-op save re-encodes the
  whole PNG with the browser's encoder and triggers a first-save `.bak`. It churned
  RTS-Game/assets/units/CivFarmer.png once (identical pixels, 4573 -> 6746 bytes).
  Grep `if (!S.dirty) { setStatus("no changes to save")` in public/pixel.js.
- `tools/sprite.mjs` writes a `.bak` on first edit exactly like `/api/image`, and the
  Pixel tab's Changes overlay diffs against that .bak. If anything ever overwrites a
  .bak, the "what did I change" workflow silently breaks — don't.
- Sprite edits do NOT propagate mechanically across animation frames. Measured on
  RTS-Game's CivFarmer sheet: the same tool is redrawn at a different angle in every
  frame, best pixel-identical match outside the source frame is 59%. Always run
  `sprite.mjs find` before pasting; below 100% the frame must be redrawn by hand.
- In JS source here, write Windows paths with FORWARD slashes and path.resolve()
  them — backslash string literals have been mangled twice by shell heredocs.

## Invariants added session 12 (scene editor, Design tab, Nexus-Repair)
- The scene editor NEVER puts a node inside the game's document. Hover boxes,
  selection, handles and labels all live in `#scene-overlay` in the parent page,
  positioned from `getBoundingClientRect()`. The moment that stops being true,
  editing a project starts changing it just by being looked at.
- `stampSource()` in server.js runs BEFORE the console script is injected. The
  `data-nx` offsets index the file as it is ON DISK, and injecting after `<head>`
  shifts everything below it. Swap the order and every offset past the head is
  wrong. Proved by round-tripping all 55 HTML files in the workspace: stripping
  the stamps must give back the original, character for character.
- Every scene edit sends the tag it expects at its offset. On a mismatch the
  server writes NOTHING and answers 409 — a whole batch fails together rather
  than half-applying into a file that moved.
- `/api/scene/file` and `/api/scene/edit` make a `<file>.bak` on their FIRST write
  and never overwrite one, exactly like `/api/image`. `/api/file` still does not,
  which is why the Design tab saves through `/api/scene/file` and not through it.
- `op: "css"` is refused on anything but a `.css` file. Selector surgery inside a
  `<style>` block in HTML is not safe enough to do silently — that goes to Claude.
- Nothing is written into a `dist/`, `build/`, `.next/` or `out/` folder. An edit
  there is gone at the next build (god-sim is the case), so the server refuses it
  and the panel says why.
- Moving something in scene mode writes a `transform: translate()`, never
  `left/top`. A transform cannot disturb the layout of anything else on the page.
- `/nexus-repair` is expanded to prose IN THE BROWSER and the "/" never leaves it.
  agent.js reads a leading "/" as a CLI slash command (grep `const isCommand =`),
  so a forwarded one would be read as one and lose the active-project banner.
  Grep `const LOCAL_COMMANDS` in chat.js — add a local command = append one row.
- A canvas is one opaque rectangle. Canvas objects are clickable ONLY when the
  project publishes `window.__NEXUS_SCENE__` (docs/NEXUS-SCENE-ADAPTER.md). Never
  claim a canvas game is editable before /nexus-repair has run on it.
- `nexus-design.js` is a .js file assigning `window.NEXUS_DESIGN`, never JSON:
  `fetch()` of a local JSON file fails under `file://`, and every one of these
  projects must keep working opened straight off the disk.
- The Design tab only ever opens and saves `.svg`, for the same reason the Pixel
  tab is `.png`-only. It keeps the parsed SVG DOM as its document rather than
  building a model beside it, so a `<defs>`, a gradient or a filter it has no UI
  for still survives an open-and-save untouched.
- `fit()` in design.js refuses to compute from a stage with no size and retries on
  the next frame. Computing it while the pane is hidden clamps to the minimum zoom
  and renders the drawing a few pixels wide.

## Roadmap (agreed with Tucker 2026-07-30, ~$115 Fable budget for Round 1)
- Session 1 (DONE): server, launcher, project picker, file tree, CodeMirror editor, save.
- Session 2 (DONE): Claude sidebar via Agent SDK (jarvis wiring, subscription auth,
  NO API key). One persistent query(), cwd = the workspace root, active project sent as a
  message prefix. Grep `function createAgent(` in agent.js.
- Session 3 (DONE): center tabs Code/Play-test/Assets. `/preview/<name>/` serves a
  project over http for the iframe (grep `/preview/` in server.js); `/api/assets` +
  `/raw` power the asset grid (public/tabs.js). Deep link: `&tab=preview|assets`.
- Session 4 (DONE): drag-drop upload onto Assets tab (`/api/upload`, binary-safe,
  409+confirm on overwrite, image/audio only, lands in assets/ if the project has
  one). Stop button in the sidebar (shows while Claude is busy). Play-test and
  Assets tabs browser-verified.
- Session 5 (DONE): tree/open-file auto-refresh after Claude edits (grep
  `function refreshTree(` in app.js), preview fallback to first root .html
  (fixes Office space), markdown rendering in chat replies, `smoke-test.mjs`.
  Round 1 build complete; awaiting Tucker's hands-on pass for fixes.
- Round 2 (DONE 2026-07-30, on Fable): all four deferred features shipped.
  - Zip export: `/api/export` via PowerShell Compress-Archive (no npm dep), excludes
    node_modules/.git. ⬇ Export button in the top bar.
  - Run tab: `/api/run` runs ONE command in the project folder, 60s timeout, 2 MB
    output cap. Deliberately NOT a real PTY terminal (that needs node-pty, a native
    dep — rejected to keep the dependency list at two).
  - GitHub: quick buttons in the Run tab (git status / Commit all… / git push) using
    the installed git. No OAuth flow — git already has Tucker's credentials.
  - Custom prompt: ⚙ on the Claude sidebar. Saving writes nexus-settings.json and
    restarts the agent session (grep `applySettings(` in agent.js). The restart aborts
    the old query(); its AbortController MUST stay closure-local in start() (`myCtl`)
    or the abort is misreported to the sidebar as a crash.

- Session 6 (DONE 2026-07-30): Pixel tab — 2D pixel editor. Pencil/eraser/fill/
  eyedropper/line/rect, brush 1-8, undo/redo, wheel zoom, right- or Alt-drag pan,
  palette sampled from the image. Cell overlay (type 16 x 16 etc.) plus cell focus —
  the Cell tool or Shift+click zooms to one cell and CLAMPS every tool to it, so an
  edit to a tilesheet or unit sheet cannot bleed into the neighbouring frame.
  Reached from the Assets tab's Edit button, or
  `?project=<n>&tab=pixel&file=<rel.png>&cell=16`. Server side: `/api/image`.

- Session 7 (DONE 2026-07-30): sprite read/write for Claude. `tools/png.mjs` +
  `tools/sprite.mjs` give the sidebar agent (and any Claude Code session) real pixel
  access; the agent's system prompt in agent.js now documents them. Pixel tab gained
  a `Changes` button (diff vs the .bak, magenta overlay, per-frame grouping) and an
  `Apply to frames` button that hands Claude a precise brief — which frame is the
  reference, what changed, and the exact commands to inspect and redraw the rest.
  `window.NexusChat.ask()` in chat.js is the hand-off point. Deep link adds `&diff=1`.

- Session 8 (DONE 2026-07-30): Claude Code parity in the sidebar. Slash-command
  menu fed by the CLI's own `supportedCommands()`, token/cost/context tracker with a
  📊 Usage view (session totals + 5-hour and 7-day plan windows), four permission
  modes (Manual/Auto/Accept edits/Plan) cycled by click or Shift+Tab, thinking
  blocks rendered, and past chats now resumable via `resume: <sessionId>`.
  Endpoints: `/api/commands`, `/api/usage`.

## Invariants added session 8
- A message that starts with "/" is a slash command: never prefix it with the
  "[Active project: ...]" banner, or the CLI reads it as prose. Grep
  `const isCommand =` in agent.js.
- `total_cost_usd` on a result message is the CLI's RUNNING SESSION TOTAL, not the
  turn's cost (measured: $0.010301 then $0.012439 across two turns). Assign it,
  never add it. The token counts in `usage` ARE per-turn and are summed.
- setPermissionMode/setEffort must only move the stored value AFTER the CLI accepts,
  and must echo the value actually in force. The CLI refuses some combinations —
  auto mode is unavailable on Haiku — and an optimistic echo makes the button lie.
- The sidebar drops refused modes from the cycle (`unavailableModes` in chat.js).
  Without that, one unavailable mode makes every later mode unreachable.
- Past-chat history lists every SDK session with cwd = the workspace root, which includes
  Claude Code terminal sessions, not just sidebar chats. That is intended.

## Model guidance (Tucker asked 2026-07-30)
Fable is NOT needed for this project's work. Round 2 was ordinary feature wiring;
Opus handles it at a fraction of the credit burn. Use Opus (or Sonnet) for Nexus
Point sessions; save Fable for long autonomous runs or genuinely ambiguous problems.

## Invariants added in v2 (2026-09-03)
- Layers live in `<file>.png.layers.json` beside the PNG, written only when there is
  more than one layer (or a hidden/translucent one) and hard-deleted otherwise. On open
  the sidecar is trusted ONLY if its flattened result matches the PNG on disk; if
  Claude or git changed the PNG, the layers are dropped with a toast. Never make the
  PNG depend on the sidecar - the PNG is always the truth.
- `/api/fs` delete goes to the Recycle Bin (Microsoft.VisualBasic.FileIO) and refuses
  to delete a project folder; the only hard delete is `*.layers.json` with `hard:true`.
- The uuid the sidebar puts on a user message is the file-checkpoint id
  (`enableFileCheckpointing`); `rewind` uses it. Keep generating it client-side.
- Streaming deltas are coalesced server-side (30 ms); the final `assistant` message
  replaces the streamed text. `block-start` closes a streamed text bubble before a
  tool call so text and tools interleave in order.
- The global `[hidden] { display:none !important }` rule in styles.css is what stops
  the "explicit display beats hidden" bug that hit this project four times. Keep it.
- `/preview/` HTML gets `/_nexus-console.js` injected after `<head>`. It no-ops when
  the page is not framed, so "Open in tab" is unaffected.
- The export zip filters by NAME (`Where-Object` on node_modules/.git/_backups);
  `Get-ChildItem -Exclude` on a directory path does not filter its children.
- nexus-settings.json holds model, extraPrompt, mode, effort, autoAllow. Mode and
  effort apply live; model/prompt/autoAllow changes restart the query().
- Writing source here from a shell heredoc: chunks under 6.5 KB, never type a double backslash
  (it arrives as a single one), build literal backslashes with String.fromCharCode(92).

- Session 9 (DONE 2026-09-04, Fable, ~348 KB of source): v2 rebuild. Streaming
  sidebar with tool rows/diffs, plan + question cards, attachments (@files, images,
  Ctrl+K selection), rewind, chat rename/delete, quick actions, usage popover, todo
  and task panels; shell with multi-tab editor, find/replace, find in files, file
  ops, resizable panels, Play-tab console with Fix-with-Claude; Pixel tab rebuilt
  as an Aseprite-class editor (layers, selections, 18 tools, palettes, HSV picker,
  frames/playback/onion skin, image adjustments, menus, deep undo, Claude menu).
  See SESSION-HANDOFF.md 2026-09-04 for the verification record.
- Session 10 (DONE 2026-09-04): Claude can see the screen, and the Pixel tab's
  selection is how you point at things.
  - `tools/screen.mjs` grabs the desktop natively (PowerShell + System.Drawing,
    DPI-aware, downscaled to a 1568 px long edge). Server: `/api/screen` returns it
    as base64, `?list=1` enumerates monitors, `/api/screen/last` re-serves the most
    recent frame. CLI: `node tools/screen.mjs [--display all|N] [--max px] [--out f]`.
  - agent.js registers an in-process SDK MCP server named `nexus` holding
    `mcp__nexus__screen` and `mcp__nexus__screen_displays`, so Claude takes the shot
    itself when Tucker asks. The PNG goes back as an MCP image block; a `screen`
    event goes to the sidebar at the same moment so the tool row shows the same frame.
  - Sidebar: Attach > "Attach a shot of my screen", a "Look at my screen" quick
    action, `NexusChat.attachImage()` / `attachScreenshot()` for other panes.
  - Pixel tab: `focusRegion()` is the single answer to "what is he pointing at" -
    a selection wins, then a focused cell, then the whole image. "Ask about the
    selection" / "Review the selection" (Claude menu, and the toolbar's Ask-about
    button) send the crop as an image plus the exact `--rect` for sprite.mjs.

## Invariants added session 10
- The screen tools exist because the server runs on Tucker's own machine. Never
  swap them for `getDisplayMedia`: that needs a picker click per shot, cannot see
  past the browser, and Claude could not trigger it.
- Screen captures are downscaled to a 1568 px long edge before they leave the
  server. Claude resizes anything larger anyway, so a native-resolution shot is
  pure token cost. The tool result states the scale factor so coordinates still map.
- `mcp__nexus__screen` is deliberately NOT in `DEFAULT_SAFE_TOOLS`. In Manual mode
  it raises a permission card; in Auto the CLI classifier lets it through. Tucker
  makes it permanent himself with the chip in Settings or "Always" on the card.
- "Always" on a permission card now also appends the tool to `autoAllow` and
  persists it. The CLI offers no `suggestions` for some tools, and without this the
  button silently did nothing for them.
- PowerShell is invoked with `-EncodedCommand` (UTF-16LE base64) and its body is
  wrapped in try/catch that prints `{"nexusError":...}` on stdout. Raw stderr comes
  back as CLIXML, sometimes UTF-16 with a NUL between every character - unreadable.
- Anything handed to Claude as "what I am looking at" carries whole-image pixel
  coordinates, because that is what `sprite.mjs --rect` takes. Do not switch the
  Pixel tab's hand-offs to cell-relative coordinates.
- The selection crop is scaled up with nearest-neighbour on a grey checkerboard.
  Smoothing would invent colours that are not in the sprite, and a plain
  transparent background reads as paint once the model sees it.


- Session 11 (DONE 2026-09-05): several chats at once, with a tab strip that only
  exists when it has to.
  - Server: `agents` is a Map of chat id -> agent, each its own `query()`. The
    browser names a chat ("c1", "c2", ...) and EVERY message in both directions
    carries that name. `open` is the only client message allowed to create one;
    `close` disposes it. `MAX_CHATS = 5`. New route `/api/live` lists what is
    running; `/api/settings|usage|context|models|commands` take `?chat=<id>`.
  - agent.js: `SHARED` at module scope is the single auto-allow list plus the
    model/prompt/mode/effort a NEW chat opens with; `dispose()` ends one for good.
  - Sidebar: one scroll pane per chat, all live in the DOM, only the active one
    shown - switching repaints nothing. The strip is hidden at one chat, so the
    single-chat panel is unchanged. Alt+1..5 jumps. Resume from history opens the
    past chat in its own tab. A reload re-adopts the running chats from
    `/api/live` and repaints each transcript.

## Invariants added session 11
- Every WebSocket message in both directions carries `chat: <id>`. An event with
  no chat id is global (models, commands, account, auto-allow) - anything else
  without one would render into whatever tab happens to be open.
- In chat.js, `A` is the chat on screen and `R` the chat being rendered into.
  Every drawing function reads `R`, and any handler it wires up must capture `R`
  at creation time (`const c = R;`) - a background chat streams while another is
  on screen, so a handler that reads `R` later would act on the wrong chat.
- The composer, chips, status dot, todo panel and notice rows are SHARED chrome.
  Per-chat values live on the chat object and are repainted by `activate()`;
  never store one of them in a module-level variable again.
- The empty state is a `<template id="chat-empty-tpl">` cloned per pane, not one
  element with an id. Quick actions render into `.quick-actions` inside the clone.
- Auto-allow is one list for the whole app (`SHARED.autoAllow`). An "Always"
  answered in one chat holds in the others; do not give a chat its own copy.
- Five live chats is the cap, because each one is a Claude CLI session with its
  own memory and they all draw on the same plan limits.
- `.chat-pane` is absolutely positioned inside `#chat-log`; the tab row uses
  flex-basis 0 with the active tab at `flex-grow: 1.9`, so tabs always fit the
  380px panel and the row never scrolls sideways. If you add anything to the
  strip, re-check that with the geometry assertions in the browser harness.

- Session 12 (DONE 2026-09-21, Opus): the visual scene editor, the Design tab and
  Nexus-Repair. Step 0 was unbreaking the app - the workspace had been renamed
  `C:\Local AI` -> `C:\AI workspace` and six files hardcoded the old path, so the
  picker listed zero projects. Roots are derived now, and `/api/env` feeds them to
  the browser.
  - **Scene mode**: an Edit toggle on the Play tab. Click anything in the running
    project, edit its colours, type, box, position and text, and Nexus splices the
    change into the real file with a first-write `.bak`. Per property you choose
    "this element" (an inline-style splice) or the CSS rule that owns the value,
    with the stylesheet named. Elements the project builds at runtime say so and
    offer Claude instead of pretending. Buttons: Open in Code, Edit asset (jumps
    to the Pixel or Design tab on the right file), Ask Claude.
  - **Canvas objects**, for any project that publishes `window.__NEXUS_SCENE__`.
    Values with a `registry` source are patched straight into `nexus-design.js`;
    the rest become a Claude brief naming the file and a greppable token.
  - **Design tab**: a vector editor for art that is not pixel art. Select, rect,
    ellipse, line, pen, text, eyedropper; fill/stroke/type/geometry panels; layer
    reorder; undo; Export PNG so a vector asset can feed a canvas game.
  - **`/nexus-repair`**, typed in the composer or picked from quick actions, plus
    `mcp__nexus__scene_report` and a skill for terminal sessions. All four point
    at `docs/NEXUS-REPAIR.md`, which is the one copy of the playbook.

- NEXT (talk to Tucker first): the GDevelop-style no-code event-sheet system. It is
  a product design, not execution - propose one shape, then wait.
