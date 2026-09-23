# Session handoff — Nexus Point

## 2026-07-30 — Session 1: skeleton built and browser-verified
What changed: project created from scratch. Zero-dep Node server (`server.js`,
port 4000) with APIs: project list, file tree, file read/write, path guard.
UI (`public/`): dark three-zone layout — top bar (project dropdown, save button,
dirty dot), sidebar file tree, CodeMirror 5.65.16 editor (vendored, ~250 KB)
with syntax highlighting for html/js/css/json/md/py. Deep link
`?project=X&file=Y` auto-opens a file. `Start Nexus Point.bat` launcher.

How verified (browser-verified, Opera GX on this machine):
- `/api/projects` returns all 9 workspace projects; tree/read/save round-trip
  tested via curl (wrote + read back + deleted `_savetest.txt`).
- Path guard refuses `C:\Windows\win.ini` with 403.
- Screenshots: welcome screen; power-grid-tycoon index.html open with
  highlighting, tree, and header path.
- Editor dark theme: the MCP screenshot tool renders it WRONGLY as white — DOM
  inspection confirmed wrapper class `cm-s-material-darker` and computed
  background rgb(33,33,33). Trust the DOM, not that screenshot tool, for colors.

Still unverified (needs Tucker's eyeball): actually clicking through the UI —
dropdown, tree clicks, editing + Ctrl+S save, unsaved-changes confirm dialogs.
The MCP browser tool can't click, so interactive flows ran only via deep link.

Gotchas hit: bash heredocs silently halved backslashes TWICE (a regex in app.js,
PROJECT_ROOTS in server.js) — hence the forward-slash invariant in CLAUDE.md.

Next session: Claude sidebar (Agent SDK, copy jarvis wiring — subscription auth,
no API key). See roadmap in CLAUDE.md.

## 2026-07-30 — Session 2: Claude sidebar built and verified end-to-end
What changed: added `agent.js` (Agent SDK wiring copied from jarvis: persistent
query() fed by an input queue, canUseTool permission gate, subscription auth —
no API key), a WebSocket bridge in server.js, and the right-hand sidebar UI
(`public/chat.js` + panel markup/CSS): model dropdown (Sonnet 5 default, Opus 5,
Haiku 4.5, Fable 5), chat log, permission Allow/Always/Deny cards, status dot.
Safe tools (Read/Glob/Grep/TodoWrite/WebSearch/WebFetch) auto-run; everything
else (Write/Edit/Bash) prompts in the sidebar. The agent's cwd is C:/Local AI;
the active project is prefixed onto messages when it changes, so switching
projects never restarts the Claude session. npm deps now: agent SDK + ws (291 MB).

How verified:
- End-to-end WS test: sent "reply PONG", received user/status/assistant("PONG")/
  done events through the real Agent SDK session. No ANTHROPIC_API_KEY in env —
  subscription auth confirmed (the "cost" field in done events is an SDK
  estimate, not a bill).
- Browser screenshot: sidebar renders (header, dropdown, green dot, input)
  alongside editor with power-grid-tycoon CLAUDE.md open.

Still unverified (needs Tucker's eyeball): a real chat that edits a file —
i.e. the permission card flow (Allow/Deny buttons) has not been clicked in a
browser; model switching from the dropdown; interrupt (no UI button yet — send
is the only control, interrupt exists server-side).

Next session (3): play-test preview tab (iframe) + assets tab. See CLAUDE.md roadmap.

## 2026-07-30 — Session 3: play-test preview + assets tab
What changed: center pane now has three tabs — Code, Play-test, Assets
(`public/tabs.js`, tab bar in index.html). Server routes added (all behind
insideRoots): `/preview/<projectName>/<rel>` serves a project's files over http
so its index.html runs in the iframe (god-sim redirects to dist/); `/api/assets`
scans a project for images/audio (max 500); `/raw?path=` streams any guarded
file for thumbnails/audio players. Preview toolbar: Restart button + open-in-tab
link. Asset cards: checkerboard-backed pixelated thumbnails, audio controls.

How verified (HTTP-level; browser tool disconnected mid-session):
- `/preview/power-grid-tycoon/` returns the game HTML and ALL its relative
  subresources resolve (style.css, world.js, mask.js, sprite PNGs → 200 with
  correct MIME). Monopoly likewise. `/api/assets` finds 18 PGT assets;
  `/raw` serves image/png and 404s on C:\Windows escape attempts.

Still unverified (needs Tucker's eyeball): the tabs clicked in a real browser —
game actually playable in the iframe, asset grid rendering, audio playback.
Deep links for quick checks: `?project=power-grid-tycoon&tab=preview` and
`&tab=assets`.

Known nuance: preview runs games on the localhost:4000 origin, so their
localStorage saves are SEPARATE from file:// saves, and all projects share one
origin (distinct save keys assumed). Not a bug, but saves won't carry over
between preview and double-clicked index.html.

Next: sessions 4-5 — drag-drop asset upload, interrupt/Stop button in sidebar,
hardening, full in-browser pass.

## 2026-07-30 — Session 4: drag-drop upload + Stop button, tabs browser-verified
What changed: `/api/upload` on the server (binary-safe body reader, 20 MB cap,
image/audio extensions only, insideRoots-guarded, 409 unless overwrite=1;
targets `<project>/assets/` when that folder exists, else project root).
Assets pane accepts drag-drop (dashed outline while hovering, confirm dialog on
overwrite, grid refreshes after). Claude sidebar got a ⏹ Stop button that
appears while Claude is busy and sends the interrupt that already existed
server-side.

How verified:
- Upload: real PNG round-trip is byte-identical (md5 match); 409 then
  overwrite=1 flow works; .exe rejected 400; C:\Windows target rejected 403;
  file correctly lands in assets/ for power-grid-tycoon and project root for
  a project without assets/. Test files cleaned up.
- Browser screenshots (Opera reconnected): Power Grid Tycoon RUNNING in the
  Play-test tab (HUD, map, station cards all live); Assets tab showing all 18
  PGT sprites on checkerboard cards. Tucker had /preview/RTS-Game/ open in his
  own tab already — preview in real use.

Still unverified (needs Tucker's hands): an actual drag-drop from Explorer or
Piskel export; the Stop button mid-task; the permission Allow/Deny cards from
session 2. These need real mouse input the browser tool can't do.

Next (session 5): Tucker does the full manual pass; fix what it turns up.

## 2026-07-30 — Session 5: hardening pass, smoke test, Round 1 build complete
What changed:
- Stale-view fix: ⟳ button in the top bar + auto-refresh after Claude finishes
  a task ("claude-done" window event from chat.js -> `refreshTree()` in app.js).
  The open file reloads from disk only when it has NO unsaved edits, preserving
  scroll position; the tree re-highlights the active file.
- Preview fallback: a project with no root index.html (and no dist/) redirects
  to its first root-level .html file - Office space now play-tests correctly
  (302 -> office-space.html, verified).
- Chat readability: assistant replies render fenced code blocks, `inline code`
  and **bold** (escape-first renderer, grep `function renderAssistant(`).
- `smoke-test.mjs`: 13 endpoint checks + optional `--chat` live round-trip.

How verified: full smoke run = 14 passed, 0 failed (including live Claude PONG
via subscription). Office space fallback curl-verified. Browser screenshot:
monopoly game.js open, refresh button rendered, all three tabs present.

Gotcha (third occurrence): shell heredocs halve double-backslashes - this time
a `\n` inside a nested node script became a real newline in chat.js. The
forward-slash invariant in CLAUDE.md stands; for generated JS that needs
escape sequences, build them with String.fromCharCode or write via node -e.

Round 1 status: all five sessions done, well under the $115 budget. What's left
is Tucker's hands-on pass (drag-drop from Explorer, permission Allow/Deny cards,
Stop button mid-task) and any fixes that turns up. Round 2 backlog unchanged:
GitHub integration, zip export, custom system prompts, terminal panel.

## 2026-07-30 — Round 2: export, Run tab, git buttons, custom prompt (all four shipped)
What changed:
- `/api/export` — zips a project via PowerShell Compress-Archive (no npm dep),
  excluding node_modules and .git; ⬇ Export button appears once a project is picked.
- `/api/run` + Run tab — one command per invocation in the project folder, 60s
  timeout, 2 MB output cap, cwd guarded by insideRoots. NOT a PTY terminal by
  choice (node-pty is a native dep; two deps is the invariant).
- Git buttons in the Run tab: git status, Commit all… (prompts for a message,
  runs add -A && commit), git push. Uses the installed git — no OAuth to build.
- Custom system prompt: ⚙ on the Claude sidebar opens a drawer; text is appended
  to the system prompt, persisted in nexus-settings.json, and applied by aborting
  and restarting the query() session (grep `applySettings(` in agent.js).

How verified:
- smoke-test.mjs extended to 17 checks; 17 passed, 0 failed.
- Custom prompt proven end-to-end: injected "end every reply with BANANA",
  Claude replied "Hey there, Tucker! BANANA". Test instruction then CLEARED —
  nexus-settings.json now has an empty extraPrompt.
- Git: `git status --short --branch` in monopoly returned `## main...origin/main`;
  a non-git project returns exit 128 with a readable fatal message, no crash.
- Export: downloaded zip is valid (opens via .NET ZipFile), 117 KB, 9 entries =
  all monopoly files, .git excluded.
- Browser screenshot: Run tab active via deep link with git buttons rendered.

Two bugs found and fixed during this pass (both spotted in a screenshot):
1. `?tab=run` deep link was ignored — the allow-list only had preview/assets.
2. `#preview-controls` (Restart / Open in tab) showed on the Code tab since
   session 3 — its `display:flex` beat the `hidden` attribute. Added
   `#preview-controls[hidden] { display: none; }`. THIRD time this CSS trap has
   bitten; if you add a hideable element with an explicit display rule, add the
   `[hidden]` override in the same edit.
Also refreshed the stale "Session 1 build" welcome text in index.html.

Still unverified (needs Tucker's hands — no tool can click or drag):
drag-drop from Explorer, the permission Allow/Deny cards, ⏹ Stop mid-task,
the ⚙ drawer's Save button, Export's browser download prompt, Commit all…'s
message dialog. All their underlying endpoints are green in the smoke test.

Model note: Fable was overkill for Round 2 (plain feature wiring). Use Opus for
future Nexus Point sessions; see the Model guidance section in CLAUDE.md.

## 2026-07-30 - Round 2 follow-up: ANSI noise in Run tab output (fixed)
Independent re-verification of the Round 2 work (on Opus, per the model note):
smoke-test.mjs 17/17 green, /api/run cwd guard 403 on C:/Windows and 400 on an
empty command, /api/export 403 outside roots, exported monopoly zip valid via
.NET ZipFile (9 entries, no .git/node_modules), /api/settings reads back.

One defect found that only endpoint output reveals: node and git emit ANSI
colour codes, and the Run tab dumps the raw string into a <pre>, so a failing
command rendered as "[90m at node:internal...[39m" literal noise. Fixed in
public/tabs.js - grep `const stripAnsi` - CSI sequences are stripped for
display only; the /api/run response still carries raw output.

How verified: extracted the shipped stripAnsi from tabs.js and ran it against
the real ANSI output captured from /api/run - no ESC bytes left, no [90m/[32m
noise, error text preserved, plain output byte-identical, empty stays empty so
the "(no output)" fallback still fires. node --check clean; smoke test still
17/17. Browser screenshot: Run tab renders with the patched tabs.js loaded
(git buttons, Export button, preview-controls correctly hidden).

Still unverified (needs Tucker's hands - no tool here can click or drag): the
stripped output seen in the browser after clicking Run, plus the standing list
from the Round 2 entry (drag-drop from Explorer, permission Allow/Deny cards,
Stop mid-task, the settings drawer Save, Export's download prompt, Commit all).

Design point for Tucker, not changed: the `git push` quick button pushes on one
click with no confirm, and Commit all... strips double quotes from the message.
Both are deliberate-looking; say the word if push should confirm first.

## 2026-07-30 — Post-Round-2 bugfix: false "Claude session crashed" on settings save
Found by reading the server log after the background process was stopped, NOT by
the smoke test — the log had two "agent loop crashed: Operation aborted" lines,
exactly matching the two settings saves made during Round 2 testing.

Root cause: `applySettings()` aborts the old query() then calls `start()`, which
synchronously reassigned the shared `abortCtl` to a fresh controller. The old
loop's rejection arrives asynchronously *after* that, so the guard
`if (abortCtl.signal.aborted)` tested the NEW (non-aborted) controller, fell
through, and broadcast `{type:"error"}` — a red "Claude session crashed:
Operation aborted" in the sidebar every single time settings were saved, even
though the restart worked fine.

Fix: `start()` now creates `const myCtl = new AbortController()` and the catch
tests `myCtl.signal.aborted`. Closure-local, so a later restart can't fool it.
Grep `myCtl` in agent.js.

Verified: two consecutive settings saves → 0 error broadcasts, 0 "agent loop
crashed" lines in the log (was 2), and Claude replied "STILL WORKING." after
both restarts. Added smoke check "settings save without false crash" as a
regression guard; suite is now 18 checks, 18 passed.

Correction to the previous entry: Round 2's custom-prompt feature was reported as
working, and functionally it was — but it emitted this spurious error on every
save. The earlier BANANA test used a WS client that only logged assistant/done
messages, so the error broadcast went unseen. Lesson: when verifying over a
WebSocket, log EVERY message type, not just the ones you expect.

## 2026-07-30 — Session 6: Pixel tab (2D pixel editor for project assets)
Tucker asked for a pixel editor to edit Nexus Point's assets; the one design
question put to him was whether to include spritesheet support, and he chose
"build it with the cell overlay". Everything else was execution.

What shipped
- `POST /api/image?path=<file.png>` in server.js: raw PNG bytes, `insideRoots()`
  guarded, .png-only, PNG-magic-checked, 20 MB cap (shares `readBodyBuffer`).
  The FIRST save of a file copies it to `<file>.png.bak` — the undo for projects
  with no git. Later saves never touch that .bak.
- `public/pixel.js` — the editor. Grep `function plot(` (draw), `function
  floodFill(`, `function bounds(` (the cell clamp), `async function save(`.
  Tools: pencil, eraser, fill, eyedropper, line, rectangle, cell-focus. Brush
  1-8, undo/redo (snapshot stack sized to stay under ~8 MB), wheel zoom,
  right/Alt-drag pan, 24-colour palette sampled from the image itself.
- Cell overlay: type a cell size (16x16, 32x32…) to get a grid; the Cell tool or
  Shift+click focuses ONE cell — the view zooms to it, everything else dims, and
  every tool is clamped to that cell so a stroke cannot bleed into the next
  frame. "Whole sheet" returns. This is what makes RTS-Game's unit sheets and
  tilesets editable.
- Assets tab: every .png card now has an Edit button (the thumbnail is clickable
  too) that opens it in the Pixel tab. Deep link:
  `?project=<n>&tab=pixel&file=<rel.png>&cell=16` (or `&cell=16x24`).
- Static files are now served `Cache-Control: no-store` — see the bug below.

Bugs found and fixed during verification (all three were real, none guessed)
- Flood fill stopped part-way (301 of 576 pixels). Its iteration guard was
  `w*h+16`, but a 4-way stack fill pops each pixel up to 4 times, so the guard
  aborted legitimate fills. Now `w*h*4+64`.
- `#pixel-hint`'s `display:flex` beat the `[hidden]` attribute, so the
  "open a PNG" overlay stayed on top of the loaded image. Added
  `#pixel-hint[hidden] { display: none; }`.
- `Fit` reserved a 24 px margin, which cost a whole integer zoom level (a
  128x288 tileset fitted at 1x in a 580 px stage instead of 2x). Margin removed;
  `open()` also re-fits on the next animation frame in case the pane's layout
  had not settled.
- A stale cached `styles.css` made one load compute a nonsense stage height
  (5x zoom on an image that did not fit). That is what prompted the no-store
  header: this is a live workbench, the browser must never cache its UI files.

How it was verified
- `node smoke-test.mjs` — 25 passed, 0 failed (was 18; 7 new checks cover
  byte-exact image save, .bak-on-first-save, .bak not clobbered on the second
  save, non-PNG body rejected, path guard, non-.png path rejected, pixel.js
  served).
- Browser (Opera, real server): PGT `assets/plants/coal.png` loads with the cell
  overlay landing exactly on its four 32 px frames; RTS `tileset16x16_1.png` with
  cell=16 and `units/CivFarmer.png` with cell=32 both grid up exactly on tile and
  frame boundaries; every PNG card in the Assets tab shows Edit.
- Drawing itself was driven programmatically against the real module through a
  throwaway page (`public/_pixelselftest.html`, since DELETED) that dispatched
  synthetic PointerEvents and then re-read the saved file off disk: 8/8 —
  stroke reaches disk, dirty flag clears, Ctrl+Z undoes, fill covers the canvas,
  and a fill inside a focused 8x8 cell paints exactly 64 pixels. That guard fix
  above is what those checks caught.
- `view.setPointerCapture()` is now wrapped in try/catch (synthetic events have
  no live pointer). Harmless in normal use.

Not verified — needs Tucker's hands
Real mouse drawing feel: brush size, line/rect drag preview, eyedropper, and
whether zoom/pan with an actual wheel and Alt-drag feel right. Every one of those
paths is exercised in code by the checks above, but "feels right" is his call.

Left behind on purpose
`server.js.bak`, `smoke-test.mjs.bak`, `public/index.html.bak`,
`public/tabs.js.bak`, `public/styles.css.bak` — pre-session backups. Only Tucker
deletes .baks, after eyeballing the tab.

Note: the server was restarted twice this session, which resets the Claude
sidebar session in any open browser tab.

## 2026-07-30 — Session 7: Claude can read and write sprite pixels; cross-frame edits
Tucker: "make it so you can read write and edit every sprite... I changed the shape
of the hoe in one frame, apply it to the other frames. Not just copy pasting but
actually applying change."

The measurement that shaped the build (do not re-derive this)
RTS-Game's CivFarmer.png is 192x160, a 6x5 grid of 32x32 cells, 23 non-empty frames.
Whole-frame translation match against frame 0,0 is 7-68%. Taking the tool (hoe) out
of frame 0,0 as a 13x12 patch and searching every other frame under translation plus
flips: best match anywhere outside the source frame is 59%, most are 20-45%. ONE of
23 frames matches at >=90% - itself. The hoe is hand-drawn at a different angle in
every frame, so there is no mechanical propagation: pasting the patch would put the
wrong angle into 22 frames. Anyone who "adds auto-propagate" later should re-run
`sprite.mjs find` first and see the same numbers.

So the change gets applied by understanding each frame, and the build gives Claude
the eyes and hands to do that.

What shipped
- `tools/png.mjs` — zero-dependency PNG decode/encode (8-bit, colour types 0/2/3/4/6,
  no interlace). Decodes to flat RGBA8, writes RGBA8. Verified on real assets.
- `tools/sprite.mjs` — the CLI:
  `info` (size, grid, per-frame pixel counts, palette), `show` (a frame as one char
  per pixel plus a colour legend - this is how Claude SEES pixel art), `diff --bak
  [--art] [--px]` (what changed, grouped by frame), `write --art` (put an edited grid
  back), `set --px` (a handful of pixels), `recolor` (the one edit that is always safe
  to propagate - same colour means the same thing in every pose), `copy` (frame to
  frame, optional flip), `find` (does this patch recur? 100% = paste is safe, less =
  redraw). Every writing command keeps a `.bak` on first write.
- agent.js system prompt now tells the sidebar agent the tool exists and, explicitly,
  never to paste a mismatched patch and never to claim a frame is done without
  re-reading it with `show`.
- Pixel tab `Changes` button: diffs the canvas against the file's .bak, paints the
  changed pixels magenta, outlines the changed frames, and reports "N px changed in
  frame X". Works before saving too. Deep link `&diff=1`.
- Pixel tab `Apply to frames` button: saves if dirty, then hands the Claude sidebar a
  brief naming the reference frame (the one with the most changed pixels), telling it
  which frames are already done, and giving the exact `diff`/`find`/`show`/`write`
  commands. `window.NexusChat.ask()` (chat.js) is the hand-off point.

Verified
- `node smoke-test.mjs` — 29 passed, 0 failed (4 new: tools present, show->write is
  byte exact, diff finds the edited pixel and names its frame, find reports an
  identical patch as safe).
- The full workflow, run for real on a copy of CivFarmer: edited the hoe blade in
  frame 0,0 (8 px, "blade one pixel thicker along its length, tip squared"), `diff
  --bak` listed exactly those 8 pixels with old -> new colours, `find` reported every
  other frame as "must be redrawn", and the same change was then redrawn by hand into
  frame 2,0 (5 px) where the hoe lies at a shallower angle. Both frames read correctly
  in `show`. That is the loop working end to end.
- Browser: the Changes overlay on that demo sheet reported "13 px changed in frame 0,0
  and 2,0" with both frames outlined - matching the CLI exactly.
- The Apply-to-frames brief was checked through a dry-run hook (`askClaude(true)`),
  which caught two real bugs: with edits in two frames the search rect was computed
  across both (63 px wide, spanning frames), and the .bak path was quoted as
  `"file.png".bak`. Both fixed; the emitted `find` command was then run and works.

Not verified — needs Tucker's hands
Clicking `Apply to frames` for real, i.e. one live sidebar round-trip where Claude
does the redraw. The brief is verified and `NexusChat.ask()` uses the same send path
as the Send button, but no live message was spent.

Left behind on purpose
`public/chat.js.bak`, `agent.js.bak` (this session) plus the session-6 .baks. Only
Tucker deletes .baks.

### Same session — a real asset got churned, and the fix
While verifying, `RTS-Game/assets/units/CivFarmer.png` was rewritten at 13:14 with
IDENTICAL pixels but different bytes (4573 -> 6746), and a `CivFarmer.png.bak`
appeared beside it. Diagnosis: `tools/png.mjs` re-encodes that image to 2612 bytes,
so the CLI did not write it - the browser's canvas encoder did, i.e. the Pixel tab
performed a save while nothing had been edited.

Root cause: `save()` wrote unconditionally. Any stray call - and a save with zero
edits still re-encodes the whole PNG and triggers the first-save `.bak` - rewrote a
source asset for no reason.

Fix: `save()` now returns early with "no changes to save" unless `S.dirty`. Verified
with a throwaway page (deleted): no-op save leaves the bytes untouched AND creates no
.bak, while a real edit still marks dirty and still saves. 4/4.

The file itself was restored byte-exactly with `git checkout -- assets/units/CivFarmer.png`
(RTS-Game IS a git repo - the workspace map's "git only in monopoly and big-if" is out
of date). `assets/units/CivFarmer.png.bak` was left in place; it is byte-identical to
HEAD and only Tucker deletes .baks. NOTE: RTS-Game also shows `M js/globe.js` and an
untracked `.claude/` - those were already there and are NOT from this session.

## 2026-07-30 - Session 8: Claude Code parity in the sidebar
Tucker: "Add all the features claude code already has (/ commands / effort levels
models plan mode auto mode manual mode accept edits mode past chat history token
tracker and counter etc.)"

Half of that list already existed from earlier the same day (model picker, effort
cycle, permission-mode cycle, read-only past-chat browser) but was never written
down here - if a future session cannot find a note for it, that is why.

What shipped this session
- Slash commands. The list is the CLI's own via `queryHandle.supportedCommands()`
  (grep `async function refreshCommands(` in agent.js) plus the mid-session
  `commands_changed` push, so built-ins, project commands and skills all appear -
  44 of them on this machine. Typing "/" opens a filtered menu above the input
  (grep `function renderCmdMenu(` in public/chat.js); arrows move, Tab/Enter
  completes, Escape closes, and Enter cannot send a half-typed command name
  because the menu's keydown listener is registered first and calls
  stopImmediatePropagation. A message starting with "/" is sent verbatim and the
  CLI executes it; agent.js deliberately does NOT prefix it with the
  "[Active project: ...]" banner (grep `const isCommand =`) or the CLI would read
  the command as prose.
- Token tracker. A gauge under the toolbar shows context-window fill, tokens and
  cost; it is fed by `getContextUsage()` after every turn plus the `usage` block
  on each result message (grep `async function pushContextUsage(` in agent.js).
  MEASURED: `total_cost_usd` on a result is the CLI's RUNNING SESSION TOTAL, not
  that turn's cost - two consecutive turns reported $0.010301 then $0.012439. It
  is assigned, never added. Token counts in `usage` ARE per-turn and are summed.
- A /usage view. The 📊 Usage button (or clicking the gauge) prints session
  totals plus the plan's 5-hour and 7-day windows, from the SDK's experimental
  usage API (grep `planUsage(` in agent.js). Verified live: 18% of the 5-hour
  window, real reset timestamps, subscription_type "pro".
- Four permission modes instead of three: Manual (default), Auto (the CLI's model
  classifier), Accept edits, Plan - the same set Claude Code cycles. Shift+Tab in
  the chat box cycles them, exactly like the terminal.
- Thinking is rendered. Assistant `thinking` blocks now reach the sidebar as dim
  italic messages instead of being dropped.
- Past chats are resumable. Opening a transcript offers Resume, which restarts
  the Agent SDK query with `resume: <sessionId>` (grep `resumeChat(` in agent.js)
  and repaints the live log with that transcript so what Tucker sees matches what
  Claude now has in context. NOTE: the list is every SDK session with
  cwd = C:/Local AI, so Claude Code terminal sessions in that folder show up in
  there too, not just sidebar chats.

Two real bugs the verification caught (both fixed)
- `setPermissionMode`/`setEffort` assigned the new value BEFORE awaiting the CLI,
  then echoed the requested value. When the CLI refused ("auto mode unavailable
  for this model" - it is unavailable on Haiku) the button claimed Auto while the
  session was still in Manual. Both now assign only after the await succeeds and
  always echo the mode actually in force.
- With that fixed, cycling on Haiku got STUCK: every Shift+Tab tried Auto, was
  refused, and snapped back to Manual, so Accept edits and Plan were unreachable.
  The sidebar now remembers refused modes and skips them (grep
  `const unavailableModes` in chat.js).

Verified
- `node smoke-test.mjs` - 33 passed, 0 failed (4 new: /api/commands returns real
  commands, /api/usage exposes the counters, the sidebar carries the command menu
  and token tracker, all four modes are offered). The old expectation of 29 in
  CLAUDE.md is now 33.
- Browser, for real, in Opera: a throwaway `public/_uitest.html` drove the actual
  app in an iframe with synthetic events - 21 passed, 0 failed, covering the menu
  opening/filtering/completing, Enter not sending, Shift+Tab cycling and coming
  back round, the gauge reading after a live turn, the Usage view printing session
  totals and plan windows, and history -> transcript -> Resume reporting back.
  That harness was DELETED afterwards; it is not part of the project.
- Live WebSocket round-trip: `/context` executed and printed, two ordinary turns
  accumulated tokens, thinking blocks arrived, context read 18.7k/200k.

Not verified - needs Tucker's hands
- Auto mode actually approving/escalating tool calls. It was refused on Haiku, so
  the classifier path has never run here. Switch the model picker to Sonnet or
  Opus and cycle to Auto to exercise it.
- Every individual slash command. `/context` was run end to end; the other 43 are
  listed and completable but untried from this UI.

Left behind on purpose
`agent.js.bak`, `public/chat.js.bak` and the older .baks are session-7 vintage and
were NOT overwritten - this session's backups went to a scratch folder instead,
since only Tucker deletes .baks. The server was restarted several times, which
resets the sidebar session in any open tab.

## 2026-09-04 - Session 9 (started 2026-09-03 evening): Nexus Point v2 - full workbench, Claude Code parity, Aseprite-class Pixel tab
Tucker: "upgrade Nexus Point to be a full usable program that I can use over Claude
in terminal ... upgrade the AI side bar so it includes all of the same features as
Claude terminal with easy frictionless buttons ... upgrade the pixel editor to rival
Aseprite ... clean and uncluttered". Built autonomously on Fable; a pre-change zip of
the whole project (minus node_modules) is at `_backups/pre-v2-2026-09-03.zip`.

What shipped (every public/*.js file except the vendored CodeMirror was rewritten)
- Shell (`public/app.js`, `ui.js`, `icons.js`, `styles.css`, `index.html`): one
  design-token stylesheet, SVG icon registry (no emoji), shared popover/context
  menu/modal/toast primitives, resizable + collapsible side panels (Ctrl+B files,
  Ctrl+J Claude), multi-tab editor (one CodeMirror Doc per tab, dirty dots, middle-
  click close, Ctrl+Tab), find/replace bar (Ctrl+F / Ctrl+H, works from anywhere in
  the Code tab), file filter (Ctrl+P), find in files (Ctrl+Shift+F, `/api/search`),
  tree context menu with new file/folder, rename, delete-to-Recycle-Bin (`/api/fs`),
  copy path and "Ask Claude about this file". Files Claude edits reload in place the
  moment the tool result lands; dirty tabs get a "changed on disk" dot instead.
- Claude sidebar (`public/chat.js` + `agent.js`): replies STREAM (partial messages
  coalesced every 30 ms server-side), full markdown (headings, lists, tables, code
  with copy buttons, clickable file paths that open the editor), thinking as a
  collapsible block, tool calls as collapsible rows with the result inside (Edit/Write
  show a real diff; Bash shows the command), permission cards that understand plans
  (Approve and build / Keep planning), AskUserQuestion (clickable options, answered
  through updatedInput.answers) and an optional "do this instead" note on deny;
  Enter/Esc answer the pending card when the box is empty. Composer: `/` command
  menu from the CLI, `@` file picker, paste/drop images (sent as image blocks),
  Ctrl+K sends the editor selection, Up/Down recall prompts, Esc stops. Status chips
  under the box: model (list from `supportedModels()`), mode (4 modes, Shift+Tab
  cycles, refused modes skipped), effort; usage chip opens context breakdown, session
  cost, plan windows and a Compact button. Plan/todo panel from TodoWrite, subagent
  task rows with a stop button, prompt suggestions, rate-limit notice, compaction and
  retry events. File checkpoints are on: hover a user bubble -> rewind (dry-run
  preview, then confirm). History drawer has search, rename, delete, resume. Settings
  drawer: extra prompt, the auto-allowed tool list (chips), account and MCP status.
  Quick actions on the empty chat are a data registry (`QUICK_ACTIONS` in chat.js).
  Mode/effort/auto-allow persist in nexus-settings.json without a restart.
- Play tab: every HTML served under `/preview/` gets `/_nexus-console.js` injected,
  so the game's console.* and uncaught errors show in a console drawer under the
  iframe with a "Fix with Claude" button. Assets: filter, folder grouping, New image,
  Upload, per-card Edit/Ask Claude/Delete. Run: command history (Up/Down), "Fix with
  Claude" on a non-zero exit, Commit uses a proper dialog.
- Pixel tab (`public/pixel.js`, 115 KB): layers (list, add/duplicate/merge/flatten/
  reorder/rename, visibility, lock, opacity) persisted in `<file>.png.layers.json`
  beside the PNG and dropped automatically if the PNG changed outside the editor;
  selections (rectangle, ellipse, lasso, magic wand with tolerance, add/subtract,
  grow/shrink/invert, select by colour, crop) with marching ants; Move tool with
  floating pixels, cut/copy/paste (also to and from the system clipboard), arrow-key
  nudge; tools: pencil (pixel-perfect, dither, square/round brushes 1-64), eraser,
  fill (contiguous/global, tolerance), gradient (linear/radial, Bayer dither), shade
  (lighten/darken), line, rect, ellipse (outline/filled), eyedropper (Alt-click),
  hand, zoom, cell focus; X/Y symmetry with guide lines; menus File/Edit/Select/
  Image/Layer/View/Claude as one data registry (`MENUS`); image ops: flip, rotate,
  resize canvas, scale, offset-wrap, outline, HSL, brightness/contrast, invert,
  desaturate, replace colour, make colour transparent; colour dock with HSV picker,
  alpha, hex, primary/secondary, palettes (from image, PICO-8, DB16, DB32, Endesga 32,
  Sweetie 16, per-project Custom) and recent colours; frames dock: cell size with
  presets and auto-guess, thumbnail strip, playback with fps and range, onion skin,
  PageUp/PageDown stepping; tiled preview; deep undo (rect patches, 120 steps / 48 MB
  budget); status bar with cursor, colour, selection, layer, zoom. Claude menu: Apply
  to frames (the session-7 brief), Draw in this cell, Review this sprite, Suggest a
  palette. A PNG Claude rewrites reloads in the tab unless there are unsaved edits.
- Server (`server.js`): `/api/fs` (mkfile/mkdir/rename/delete-to-Recycle-Bin; hard
  delete only for *.layers.json), `/api/search`, `/api/chats/:id` POST rename and
  DELETE, `/api/models`, `/api/account`, `/api/mcp`, `/api/context`, `/api/image?new=1`,
  console-bridge injection, `NEXUS_PORT` env for a side instance. Bug fixed: the zip
  export never excluded node_modules (Get-ChildItem -Exclude on a directory path
  filters the directory itself, not its children) - it now filters by name.

How it was verified
- `node smoke-test.mjs` - 60 passed, 0 failed (was 33; the 27 new checks cover the
  fs ops incl. the Recycle Bin delete and the project-folder guard, find in files,
  image create, models/context/account, console-bridge injection, every new static
  file, and that the export zip no longer contains node_modules). Run first against
  a side instance on `NEXUS_PORT=4001`, then against the restarted live server.
- Browser, for real, in headless Chrome driven over the DevTools protocol in real
  time (a throwaway `public/_v2test.html`, since DELETED): 40 passed, 0 failed and
  zero console errors. Covered: boot + WebSocket up, icons, deep-link project, tree,
  filter, two editor tabs with content, find-bar match count, tree context menu,
  `/` command menu, `@` file menu attaching a chip, selection chip, model chip filled
  from the CLI, mode popover, quick actions; Pixel tab: open a fresh PNG, tool strip,
  7 menus, colour dock, a pencil stroke read back through the composite, undo/redo,
  4x4 rect selection, fill honouring the selection, flood fill stopping at a line,
  second layer, save -> sidecar on disk -> the PNG on disk is the flattened image,
  no-op save refuses, reopen restores both layers, cell focus clamps a stroke,
  frames strip shows 4 cells, E/B keys switch tools.
- Live Claude round-trip over the WebSocket (one message): saw stream-start, 6 text
  deltas, thinking, tool-pending -> tool(Read, auto) -> tool-result, assistant,
  done carrying the same user-message uuid the client sent, and `rewind` dry-run
  answered canRewind:true - so the client-generated uuid IS the checkpoint id.
- `node --check` on every JS file after every chunk.

Not verified - needs Tucker's hands (no tool here can click, drag or paste)
- The feel of drawing: brush cursor, pixel-perfect pencil on real mouse curves,
  lasso, gradient drag, shade tool, marching ants, Space-drag pan, onion skin.
- Paste from the system clipboard into the Pixel tab and into the chat box.
- A permission card in anger (Allow / Always / Deny with a note), an
  AskUserQuestion, an ExitPlanMode card, and a real rewind after an edit.
- Auto mode on Sonnet/Opus (still never exercised here - Haiku refuses it).
- Drag-drop upload from Explorer; the Recycle Bin delete showing up in the bin.
- Layout on his screen size; panel widths persist in localStorage per panel id.

Gotchas hit this session (all shell-tooling, none in the app)
- No Read/Write/Edit tools this session. Everything was written through bash
  heredocs in chunks: commands over about 10 KB are truncated (the heredoc never
  ends, nothing is written), and a double backslash arrives as a single one while every other
  backslash survives. Rule that worked: chunks under 6.5 KB, never type a double backslash,
  build a literal backslash with String.fromCharCode(92), keep regex escapes as
  regex literals (never template literals in patch scripts - `\r?\n` inside one
  became a real newline in server.js and broke it).
- Headless Chrome with `--virtual-time-budget` never sees the WebSocket connect
  and stalls on `img.decode()`; `--timeout` dumps immediately in new headless.
  Driving the page over CDP (`--remote-debugging-port`, poll the harness output
  each real second) is what finally worked - keep that approach.

Left behind on purpose
- `_backups/pre-v2-2026-09-03.zip` (183 KB) - the full pre-v2 source. Restore by
  unzipping over the folder. The older *.bak files from sessions 6-7 are untouched;
  only Tucker deletes .baks.
- `nexus-settings.json` now also stores mode, effort and autoAllow; it regenerates.
- The live server on port 4000 was restarted (killed the .bat's node and started
  `node server.js` in the background) - the console window from the .bat, if any,
  is sitting at its pause prompt and the sidebar session in any open tab reset.

Next (talk to Tucker first - these are product decisions, not execution)
- The no-code / event-sheet system he wants (GDevelop-style). Proposed shape: a
  data-driven registry of conditions and actions rendered as an event sheet in a
  new center tab, compiled to plain JS the no-build projects can include - but
  the design (which games, what the sheet looks like, how Claude edits it) is his call.
- Whether the Pixel tab should also own animation timing (frame durations) or leave
  that to each game's code as now.

## 2026-09-04 - Session 10: Claude can see the screen; the Pixel tab's selection is how you point
Tucker: "make it so Nexus Point lets Claude see your whole screen when asked and in
the pixel art editor you can select stuff with the built in selection tools so Claude
can know what to look at". Built on Opus. Pre-change copies of every file touched are
in this session's scratch folder, not in the project - the older *.bak files were left
alone, since only Tucker deletes those.

### Seeing the screen
`tools/screen.mjs` is the whole capture path: PowerShell + System.Drawing, called with
`-EncodedCommand`, DPI-aware (SetProcessDPIAware, or a scaled display hands back a
blurry upscale), downscaled to a 1568 px long edge. It is both a library
(`captureScreen`, `listDisplays`, `lastCapture`) and a CLI, so a Claude Code terminal
session can use it too: `node tools/screen.mjs --out shot.png` then Read that path.

The design call worth knowing: this is a NATIVE grab, not `getDisplayMedia`. Nexus
Point runs on Tucker's own machine, so a native shot needs no picker dialog per
capture, sees windows the browser cannot, and - the reason it matters - Claude can
trigger the same code itself. That is what "when asked" required.

Three ways in:
- Claude asks. agent.js registers an in-process SDK MCP server called `nexus` with
  `mcp__nexus__screen` and `mcp__nexus__screen_displays`. The PNG comes back as an MCP
  image block, so it lands in the model's context directly. Grep `createSdkMcpServer`.
- Tucker attaches one. Sidebar Attach menu -> "Attach a shot of my screen", or the
  "Look at my screen" quick action on an empty chat.
- Anything in the app. `window.NexusChat.attachScreenshot()` / `.attachImage()`.

Either way the sidebar shows the exact frame: the tool handler broadcasts a `screen`
event and `onScreen()` in chat.js drops `<img src="/api/screen/last">` into that tool
row and expands it. Tucker never has to take the capture on trust.

Permission: `mcp__nexus__screen` is NOT auto-allowed by default. In Manual mode it
raises a permission card; in Auto (Tucker's current mode) the CLI classifier passes it.
Fixing "Always" was part of this: it used to depend on the CLI supplying `suggestions`,
and for tools with none the button did nothing. `canUseTool` now also appends the tool
to `autoAllow` and persists it.

### Selections tell Claude what to look at
`focusRegion()` in pixel.js is now the single answer to "what is he pointing at":
a selection wins, then a focused cell, then the whole image. Everything Claude-facing
in that tab reads it.

"Ask about the selection" and "Review the selection" (Claude menu, plus a new
Ask-about-this button in the Pixel toolbar whose label tracks the live selection) send
two things: the crop as an attached PNG - nearest-neighbour upscaled to about 512 px on
a grey checkerboard, so Claude sees pixels rather than a smudge and cannot mistake
transparency for paint - and the exact rectangle in whole-image coordinates with the
`sprite.mjs show/write --rect x,y,w,h` commands that read and write that same area.
`--rect` already worked in `write`; only the usage text was missing it, and that is
fixed. "Ask about the selection" deliberately does NOT auto-send: the framing text
lands in the box with the crop attached so Tucker types his actual question. "Review
the selection" sends immediately. "Draw here" follows the same region.

The system prompt now tells Claude both things: that the screen tool exists and when to
reach for it, and that a selection rectangle in a message IS the subject - work inside
it, leave the rest of the sheet alone.

### Verified
- `node smoke-test.mjs` - 71 passed, 0 failed (was 60; 11 new cover the displays list,
  the capture, the downscale cap, `/api/screen/last`, a readable error for a bad
  display, and that agent.js/chat.js/pixel.js/index.html actually wire it all up).
- Two live Claude turns over the WebSocket against a side instance on NEXUS_PORT=4001.
  In Auto mode Claude called `mcp__nexus__screen` unprompted-by-a-card and replied with
  the image's size, dominant colour and rough window count - so the picture genuinely
  reached the model. In Manual mode the permission card appeared with a real
  suggestion, "Always" wrote the tool into `autoAllow` on disk, and the turn completed.
- Browser, for real, in headless Chrome driven over CDP in real time (a throwaway
  `public/_screentest.html`, since DELETED): 32 passed, 0 failed, no console errors.
  It dragged a real rectangle selection with pointer events on the canvas and checked
  the selection was exactly 4,6 12x14; that the toolbar button label and title follow
  it; that the Claude menu offers both selection items with the live size; that the
  prompt lands in the chat box carrying `--rect 4,6,12,14` and is not auto-sent; that
  the crop chip is a whole-number upscale AND that every opaque pixel in it matches
  `NexusPixel.pixel()` at the source coordinate; that `attachScreenshot()` adds a chip
  named for the real 1920x1080 screen; and finally a live turn in which Claude used the
  screen tool and `img.shot` appeared in the open `mcp__nexus__screen` tool row and
  loaded.
- `node --check` on every file after every chunk.

### Not verified - needs Tucker's hands
- A second monitor. Only one display exists here, so `--display 1` and the stitched
  multi-monitor `VirtualScreen` path have never had a real second screen to prove.
- A display scaled to 125%/150%. `SetProcessDPIAware` is in there for exactly that and
  is the standard fix, but on this machine at 100% it changes nothing observable.
- Whether 1568 px is the right cap for reading small text on his screen. If Claude
  keeps saying it cannot make something out, capture one monitor instead of all
  (`?display=0`) before raising the cap - that helps more and costs less.
- The feel of the Pixel hand-off: lasso and magic-wand selections (only the rectangle
  was driven here), and whether "type your question after the framing text" reads well
  in practice or wants the question box first.

### Left behind on purpose
- The live server on port 4000 was NOT restarted. It is still running session 9's
  server.js and agent.js, so `/api/screen` 404s there until it is restarted -
  restarting it would have dropped whatever chat was open. Restart Nexus Point to pick
  this up; a browser refresh alone is not enough (the UI files are no-store, but
  server.js and agent.js only load at startup).
- `nexus-settings.json` was restored byte-identical after the permission test, so
  `mcp__nexus__screen` is NOT in the auto-allow list - that stays Tucker's call. The
  test also wrote an allow rule into `C:\Local AI\.claude\settings.local.json`; that
  line was removed again.
- No .bak files were created or touched.

### 2026-09-04, same day - follow-up: "missing o in JSON"
Tucker hit `Unexpected token 'o', "not found" is not valid JSON` on the screen button.
Cause was exactly the restart note above: the server on port 4000 was still session 9's
build, so `/api/screen` fell through to the static handler and answered 404 with the
plain text `not found` - and `attachScreenshot()` called `r.json()` on it, so the parse
error was reported instead of the real problem.

Fixed both ends. `attachScreenshot()` in chat.js now reads the body as text and only
then tries to parse it: a 404 with no JSON says "this server build has no screen capture
- restart Nexus Point", any other non-JSON body is quoted with its status code. Grep
`const body = await r.text();` in chat.js. And the live server WAS restarted this time
(old pid killed, `node server.js` started in the background), so the feature is live.

Re-verified after the restart: `node smoke-test.mjs` against port 4000 - 71 passed,
0 failed. Browser, headless Chrome over CDP against the live server (throwaway
`public/_shottest.html`, since DELETED) - 6 passed, 0 failed, no page errors: the
sidebar connects, `attachScreenshot()` returns a real 1920x1080 capture, the chip is
added and named for the true screen size, its thumbnail decodes, and the composer was
left empty afterwards. The lesson worth keeping: any `fetch(...).then(r => r.json())`
in this UI can be handed the static 404 body, so parse defensively or the user sees a
JSON error instead of the actual cause.

## 2026-09-05 - session 11: several chats at once (Opus)

Tucker asked for multiple chats running side by side with seamless navigation,
and specifically for the controls to fit rather than be crammed in.

### What it does now
The sidebar runs up to five Claude chats at the same time. Each one is a separate
Agent SDK `query()` on the server with its own context, model, permission mode and
token counters, and its own scroll pane in the browser. You can start a turn in
one, switch to another and keep working while the first keeps streaming; when it
finishes, its tab turns purple and a toast names it.

Switching is instant because nothing is re-rendered - every chat's messages stay
in their own `.chat-pane`, and only the active pane is shown. Each chat also keeps
its own half-written message and its own attachment chips, so switching mid-thought
loses nothing.

### The tab strip
It does not exist until there is a second chat. With one chat the panel is exactly
what it was, and `+` in the header is the only new thing to notice. Open a second
and a 35px row appears under the header: one tab per chat, plus a `+` that greys
out at five.

Every tab is flex-basis 0, so they always add up to the panel width and the row
never scrolls sideways - measured, not assumed. The active tab has `flex-grow:
1.9`, so at four chats it is 121px and the others are 70px each: you read the name
of the chat you are in, and the others stay recognisable stubs with the full name
on hover. Each tab carries its own status dot (green idle, amber pulsing while that
chat works, purple when it wants an answer), which is how a background chat tells
you it is still going. The close cross only appears on the tab you are pointing at
or using, so the row reads as names rather than a row of buttons.

Alt+1..5 jumps between chats (Ctrl+1..9 belongs to the browser and cannot be
intercepted). Resume from the history drawer now opens that past chat in its OWN
tab instead of replacing whatever is running.

### How the routing works - the thing to know before editing chat.js
Every WebSocket message in both directions carries `chat: <id>`. On the way in the
server routes it to that chat's agent; on the way out the sidebar points `R` at
that chat, renders, and puts `R` back. `A` is the chat on screen, `R` is the chat
being drawn into. Any handler a drawing function wires up must capture `R` at
creation time (`const c = R;`) or it will act on whichever chat is open when the
button is clicked, not the one it was drawn for. That single rule is what the
permission cards, task stop buttons and rewind buttons depend on.

The composer, the chips, the status dot, the todo panel and the notice rows are
shared chrome. Their values live on the chat object and `activate()` repaints them.
Auto-allow is deliberately NOT per chat - `SHARED.autoAllow` in agent.js is one
list, so an "Always" answered in one chat holds everywhere.

### Verified
- `node smoke-test.mjs` against a side instance on NEXUS_PORT=4001 - **87 passed,
  0 failed** (was 71). The 16 new ones cover `/api/live`, opening and closing a
  second chat over the socket, that its events come back stamped with its own id,
  `?chat=` on the settings and usage routes, that a live chat never appears in the
  past-chats list, and that the tab strip is actually wired into chat.js,
  index.html and styles.css.
- Browser, for real, in headless Chrome driven over CDP against that same
  instance (throwaway `_cdp.mjs`, since DELETED) - **32 passed, 0 failed, no page
  errors**. It clicked the real buttons: the strip is hidden at one chat and
  appears at two; drafts and attachment chips survive a switch in both directions;
  Alt+1 and Alt+2 jump; at five chats the row's `scrollWidth` equals its
  `clientWidth` (so it genuinely does not overflow), every tab is at least 45px and
  the active one is at least 1.6x the others, the `+` is disabled and a sixth chat
  is refused; closing tabs works.
- The one that matters: with chat one on screen, a real Claude turn was sent to
  chat two from a separate socket client. It completed, its reply landed in chat
  two's pane and NOT chat one's, chat one stayed on screen throughout, and the
  background tab flagged itself unread until it was opened. Then the page was
  reloaded and both chats were re-adopted from `/api/live` with the background
  transcript repainted.
- `node --check` on agent.js, server.js, chat.js and smoke-test.mjs after every
  chunk.

### Not verified - needs Tucker's hands
- How five chats at once actually feel on this machine. Five Claude CLI sessions
  is five processes; the cap is a judgement call, not a measurement. If it drags,
  `MAX_CHATS` is one constant in server.js and one in chat.js.
- Whether 70px stubs are enough to tell four chats apart in practice. The names
  come from the first prompt, so several chats about the same project can start
  with the same words. If that bites, shortening what goes into the tab (rather
  than widening the tabs) is the fix.
- Running two chats that edit the SAME file at once. Nothing stops it and nothing
  warns about it - the file APIs and checkpoints are per chat, so the second write
  wins. Worth knowing before doing it on purpose.
- The Play/Assets/Pixel tabs still hand their prompts to the ACTIVE chat, which is
  what you would expect, but it has only been eyeballed through `NexusChat.ask()`,
  not driven end to end.

### Left behind on purpose
- Pre-change copies of the six edited files are in
  `_backups/pre-multichat-2026-09-05/`. The older `*.bak` files in the project root
  are Tucker's and were not touched - only he deletes those.
- The live server on port 4000 WAS restarted (old pid killed, `node server.js`
  started again). It had to be: the UI files are served no-store so a refresh picks
  them up, but server.js and agent.js only load at startup, and the new sidebar
  cannot work against the old server - it would sit there with no chat pane at all.
  Whatever chat was open there is still on disk and can be reopened from the
  history drawer.
- `nexus-settings.json` is byte-identical to how it started. The one test that
  touches a setting reads the current effort and writes the same value back.

## 2026-09-21 - session 12: the visual scene editor, the Design tab, Nexus-Repair (Opus)

Tucker asked for a visual scene editor that works on websites and games, an
editor for art that is not pixel art, and a `Nexus-Repair` command that makes
assets Claude produced editable instead of stranded.

### Before anything else: the app did not run

The workspace had been renamed `C:\Local AI` -> `C:\AI workspace`, and six places
hardcoded the old path: `PROJECT_ROOTS` in server.js, `WORKSPACE_ROOT` and
`SETTINGS_PATH` and the sprite-CLI line in agent.js, `TOOL_CLI` in pixel.js, the
"Draw a sprite" quick action in chat.js, `Start Nexus Point.bat`, and CLAUDE.md.
The project picker would have listed zero projects and the agent's cwd would not
have existed.

Fixed by derivation, not by writing the new name down: server.js and agent.js
resolve the workspace from their own `__dirname`, the browser reads it from a new
`GET /api/env`, and the .bat does `cd /d "%~dp0"`. A rename cannot do this again.
A smoke test now fails if a live reference to a hardcoded workspace path comes
back (comments explaining the history are allowed).

### Scene mode - the Play tab's Edit button

Two decisions made the rest cheap.

**The preview iframe is same-origin**, so the parent page can read
`frame.contentDocument` directly. Nothing is injected for the inspector, and the
overlay - hover box, selection, eight handles, label - is built in Nexus's own
page and positioned from `getBoundingClientRect()`. **The editor never puts a
node inside the game's DOM.** That is an invariant now.

**Source offsets are stamped on the served copy only.** `stampSource()` in
server.js adds `data-nx="<character offset>"` to each open tag of previewed HTML,
and a `<meta name="nexus-source">` naming the file. It exists in the bytes sent
to the iframe and never on disk. It must run BEFORE the console-script injection,
because injecting after `<head>` shifts every offset below it.

Clicking an element gives its file and line, a breadcrumb of its ancestors, and a
property panel driven by a `PROPS` registry (add a property = append one row).
One scope control decides where a change goes: the element's own inline style, or
whichever matching CSS rule you pick, with the owning stylesheet named and
`@media` variants labelled. Rules living in a `<style>` block inside HTML are
listed but disabled and routed to Claude - selector surgery in HTML is not safe
enough to do silently.

Saving sends one batch to `/api/scene/edit`, which splices highest-offset-first
and **refuses the whole batch with 409 if any offset no longer holds the tag it
was told to expect**, so a file that moved under us is never half-written. First
write of a file leaves a `.bak` and never overwrites one, the same rule
`/api/image` has had since session 6. Writes into `dist/`, `build/`, `.next/` or
`out/` are refused with a reason - an edit there dies at the next build, which is
god-sim's whole situation.

Dragging writes a `transform: translate()`, never `left/top`: a transform cannot
disturb the layout of anything else on the page.

Elements the project's own JavaScript builds at runtime have no stamp. The panel
says so plainly, offers no Open-in-Code, and routes to Claude. hoopshots is the
extreme case - its entire UI is `<div id="screen">` filled by app.js, so three
elements carry stamps and everything else is rule-scope or Claude. That is the
honest answer, not a bug.

### Canvas objects, and the adapter contract

A canvas is one opaque rectangle; nothing in a browser knows a plant was drawn
there. So a project opts in by publishing `window.__NEXUS_SCENE__`
(`docs/NEXUS-SCENE-ADAPTER.md`): `objects()` returns boxes and props, `set()`
previews live, `source()` says where each value lives. With one present, clicking
the canvas selects the object under the pointer, its props become rows (a value
that looks like a colour gets a colour field, a number gets a number box - the
shape of the value IS the type system), and saving patches
`nexus-design.js` surgically by key path. Anything the adapter cannot place
becomes a Claude brief naming the file and a greppable token, never a line number.

`nexus-design.js` is a .js file assigning `window.NEXUS_DESIGN`, deliberately not
JSON: `fetch()` of a local JSON file fails under `file://`.

### The Design tab

A sixth centre tab that owns `.svg` the way Pixel owns `.png`.

The document **is** a live `<svg>` element in the page - there is no model beside
it. That single decision means the browser does the rendering, the text layout
and the hit-testing, and a file opened here and saved again cannot lose a
`<defs>`, a gradient or a filter this editor has no UI for, because those were
never taken apart. Verified: a fixture with a `linearGradient`, a `<path>` and a
`<text>` came back byte-identical in those parts after an edit and save.

Tools: select, rect, ellipse, line, pen, text, eyedropper. Panels for
fill/stroke/type/geometry, layer reorder, snapshot undo, arrow-key nudge. Export
PNG rasterises through a canvas into `/api/image?new=1`, which is how a vector
asset feeds a canvas game. Saves go through `/api/scene/file` so an `.svg` gets
the same first-write `.bak` a `.png` does.

Geometry is a registry keyed by tag (`const GEO`) with a fallback that moves and
scales anything at all through a transform - so a `<path>`, a `<polygon>` or a
`<g>` works without a row. A `<circle>` dragged to a non-square box becomes an
`<ellipse>`, because a handle that silently refused would be lying.

### Nexus-Repair

Four ways in, one source of truth (`docs/NEXUS-REPAIR.md`):
`/nexus-repair [deep]` typed in the composer, a quick action, the
`nexus-repair` skill for terminal sessions, and `mcp__nexus__scene_report` for
the survey it opens with.

`/nexus-repair` is expanded to prose **in the browser** and the "/" never leaves
it - agent.js reads a leading "/" as a CLI slash command, so a forwarded one
would be read as one and would also lose the active-project banner. Grep
`const LOCAL_COMMANDS` in chat.js; adding a local command is appending one row.

`tools/scene-report.mjs` surveys a project read-only: canvases and their draw
entry points, shape drawing with no image behind it, inline SVG, `data:` image
URIs, emoji used as sprites, hardcoded colours with counts, and whether an
adapter or registry already exists. On power-grid-tycoon it correctly finds
`draw` and `drawFX` and nothing else, and it found the thing worth finding - a
343 KB base64 JPEG living inside `assets/map/world.js`. On hoopshots it says
"pure DOM, so the scene editor already works on all of it with no repair needed".

The default run is additive: add the adapter, the registry and real asset files,
rewire only where the swap is provably identical, and report what could NOT be
made editable and why. `deep` is opt-in and hoists constants one subsystem at a
time.

### Verified

- `NEXUS_PORT=4001 node smoke-test.mjs` - **158 passed, 0 failed** (was 87). The
  71 new cases cover `/api/env`, stamping and its exact round-trip, the style,
  attribute, text and CSS splices, the 409-on-stale path and that it writes
  nothing, `.bak` made once and never overwritten, the registry patcher's key
  walk and its refusals, the scanner, and that all of it is wired into the page.
- **Browser, for real, in headless Chrome over CDP against that instance.** Four
  throwaway harnesses, written to the session scratchpad outside the project so
  nothing had to be cleaned out of it afterwards:
  - DOM scene mode on a fixture - **36 passed, 0 failed, no page errors**. It
    clicked real elements, checked that the game never saw those clicks, changed
    a colour, saved, and read the file and its `.bak` off disk.
  - Canvas mode on a fixture with a hand-written adapter - **18 passed, 0
    failed**, including reading the canvas back with `getImageData` to prove it
    actually repainted, and that only one value in `nexus-design.js` moved.
  - The Design tab - **31 passed, 0 failed**, including the lossless round-trip
    and a real 240x160 PNG export.
  - `/nexus-repair` - **10 passed, 0 failed**: it appears in the slash menu, the
    "/" never reaches the socket, the brief names the project, and `deep` changes
    it.
- **Tucker's real projects, read-only** (no Save was ever pressed, and no `.bak`
  appeared in any of them): power-grid-tycoon stamps 134 elements and offers the
  right rules out of `assets/ui/style.css` including the `@media (max-width:640px)`
  variant; hoopshots behaves as described above.
- **The strongest one**: `stampSource()` run over every HTML file in the
  workspace - **55 files, 2797 tags, all 55 round-trip character for character**
  and every emitted offset lands on that tag in the original file. And the live
  server's PGT preview strips back to the file on disk exactly.
- `node --check` on every edited file after every chunk.

### Not verified - needs Tucker's hands

- **A real Nexus-Repair run on a real game.** The adapter contract was proved by
  hand-writing one for a fixture and driving it end to end, but no project of
  Tucker's has been repaired. sky-hopper is the right first target: one file, one
  canvas, `drawPlatform` and `drawPlayer` are the entry points.
- How scene mode feels on a game that is actually moving. Freeze (on by default)
  no-ops `requestAnimationFrame` inside the iframe so a repainting HUD cannot wipe
  a preview; whether that is the right default on a game where the world keeps
  simulating is a judgement call, not a measurement.
- Dragging and resizing by hand. The handles were driven synthetically and the
  numbers land, but the feel is unmeasured.
- The Design tab's pen tool and multi-select on a drawing with real content.

### Left behind on purpose

- Pre-change copies of the twelve edited files in
  `_backups/pre-scene-2026-09-21/`. The older `*.bak` files in the project root
  are Tucker's and were not touched.
- **The live instance on port 4000 is still running the OLD server.** UI files
  are served no-store so a refresh picks those up, but server.js and agent.js
  only load at startup, and the new UI cannot work against the old server -
  `/api/env`, `/api/scene/*` and the stamping all live there. It needs a restart,
  and until then it is still pointed at a workspace path that does not exist.
- `nexus-settings.json` was not touched.
## 2026-09-21 - session 12b: the first real Nexus-Repair run (Opus)

Session 12 shipped Nexus-Repair but had never run it on one of Tucker's games.
This closes that, on **sky-hopper** - one file, one canvas, no project docs of its
own, which is why it was the right first target.

### What the repair did

Three files added to sky-hopper: `nexus-design.js` (eleven colours),
`nexus-scene.js` (the adapter), `NEXUS-SCENE.md` (the report). `index.html`
gained two `<script>` tags, one read-only hook at the end of its IIFE
(`window.__SKYHOPPER__`, four accessors and `redraw`), and eleven colour reads
that now come from the registry. The pre-repair file is in
`_backups/nexus-repair-2026-09-21/`.

Every swap is `NXC.key || '<the literal that used to be there>'`, so the whole
diff is additive and deleting the registry gives the original colours back.

**Nothing was turned into an image file, and that is the correct outcome.** The
game ships no art; it draws everything procedurally, and all of it varies with
state - the player squashes and flips, platforms carry a per-instance wobble seed
and fade as they break, clouds are random per game. The playbook says only static
drawing may be materialised, so none was. `NEXUS-SCENE.md` says so in as many
words rather than quietly listing successes.

Also deliberately NOT hoisted: platform and player **size**. `makePlatform`
stamps `w: 78, h: 18` at creation and collision reads the same numbers, so a
registry value would not resize anything already on screen and would drift from
the physics. Offering a control that half works is worse than not offering it.
Physics constants are untouched - they are gameplay, and a default run does not
touch gameplay.

### What is editable now

Sky (two gradient stops), every platform (fill per type, plus the shared ink
colour), and the player (body, eye whites, antenna, ink). The HTML cards, score
badge and mute button were left out of the registry on purpose: scene mode
already edits those directly, and two places to change one colour is worse
than one.

The one thing that will surprise him once, and which the label and the report
both say: **a platform's colour belongs to its type, not to that platform.**
Recolour one green platform and all thirteen change, because that is genuinely
where the value lives in `drawPlatform`.

### Verified

- **Pixel-identity proof.** The pre-repair backup and the repaired file were both
  rendered in headless Chrome with the same seeded PRNG (installed via
  `Page.addScriptToEvaluateOnNewDocument`, before any page script) and the same
  viewport, and the canvases came back **pixel-identical**. Repeated with
  `window.NEXUS_DESIGN` forced to `undefined`: still identical. That is what
  makes "provably identical swap" and "deleting it degrades instead of breaking"
  true statements rather than hopeful ones. **3 passed, 0 failed.**
- **End to end in the Play tab** against the side instance - **16 of 17**, the one
  failure being the harness sampling the player's centre pixel, which is eye ink,
  not body. Re-probed by counting pixels inside the object's box instead:
  **5 passed, 0 failed** - 725 pink pixels became 725 green with none left over,
  recolouring one normal platform recoloured all 13, and Revert restored the
  preview and wrote nothing to disk. The Play-tab console was clean, the adapter
  reported 19 objects across background/platform/player, and saving patched one
  value in `nexus-design.js` with a `.bak` and left the comment block intact.
- **The no-build invariant**, which is the reason `nexus-design.js` is a .js file
  and not JSON: opened straight off the disk at
  `file:///C:/AI workspace/.../sky-hopper/index.html` - **8 passed, 0 failed**, no
  uncaught exceptions, no console errors, registry and adapter both loaded, world
  generated, canvas drawn.
- `node --check` on both new files; the full nexus-point smoke test still
  **158 passed, 0 failed**.

### The live instance was restarted

Port 4000 had been serving the pre-session build all day, which was pointed at
`C:\Local AI` and would have listed zero projects. Old pid killed, `node
server.js` started again from the project folder. Confirmed after the restart:
`/api/env` returns the real workspace, 24 projects list, the sky-hopper preview
comes back with 24 stamped tags and the adapter script tag, and the smoke test
passes against it. Whatever sidebar chat was open there is on disk and can be
reopened from the history drawer.

### Still not verified - needs Tucker's hands

- **How it feels to play after the repair.** Every check above is machine-made.
  The game was never actually played through a jump.
- **A second repair on a harder target.** power-grid-tycoon is the real test: 82 KB
  in one file, a fog canvas as well as the map canvas, and documented invariants
  (`INCOME_RATE === BLACKOUT_RATE`) that a careless hoist could break. sky-hopper
  had no CLAUDE.md at all, so the "read the project's own invariants first" step
  was never exercised against a project that has any.
- Whether the per-type platform colour reads as a feature or a papercut in
  practice. If it is a papercut, the fix is a real change to `makePlatform`, not
  a registry edit.