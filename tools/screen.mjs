// tools/screen.mjs - capture the Windows desktop as a PNG. Zero dependencies.
//
// Why a native grab and not the browser's getDisplayMedia: the server runs on
// Tucker's own machine, so this needs no picker dialog, it sees windows outside
// the browser, and Claude can trigger it itself instead of waiting for a click.
//
// Library:  import { listDisplays, captureScreen } from "./tools/screen.mjs";
// CLI:      node tools/screen.mjs [--display all|0|1] [--max 1568] [--out f.png]
//           node tools/screen.mjs --list
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const NL = String.fromCharCode(10);
// Claude downscales anything bigger than this anyway, so past it is pure cost.
export const MAX_EDGE = 1568;

// PowerShell is fed as -EncodedCommand (UTF-16LE base64). Nothing else survives
// the quoting round trip intact, and it keeps this file free of escape soup.
// A failure inside PowerShell comes back as CLIXML on stderr, sometimes in
// UTF-16, which is unreadable. Wrap the body in try/catch and print the message
// as JSON on stdout instead, so callers get one clean sentence.
function runPs(lines, timeout) {
  const script = ["try {"].concat(lines).concat([
    "} catch {",
    "  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ nexusError = $_.Exception.Message }))",
    "  exit 1",
    "}",
  ]);
  const enc = Buffer.from(script.join(NL), "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
      { timeout: timeout || 25000, maxBuffer: 8e6 },
      (err, stdout, stderr) => {
        const out = String(stdout || "");
        const m = out.match(/[{]"nexusError":[^}]*[}]/);
        if (m) { try { return reject(new Error(JSON.parse(m[0]).nexusError)); } catch {} }
        if (err) return reject(new Error(scrub(stderr) || String(err.message || err) || "powershell failed"));
        resolve(out.trim());
      });
  });
}

// UTF-16 stderr arrives with a NUL between every character; CLIXML wraps the
// rest in XML noise. Neither belongs in a message shown to Tucker.
function scrub(text) {
  let t = String(text || "").split(String.fromCharCode(0)).join("");
  if (t.indexOf("#< CLIXML") === 0) {
    const parts = t.match(/<S S="Error">[^<]*<[/]S>/g) || [];
    t = parts.map((x) => x.replace(/<[^>]+>/g, "")).join(" ") || t;
    t = t.split("_x000D_").join(" ").split("_x000A_").join(" ");
  }
  const WS = new RegExp("[" + String.fromCharCode(92) + "s]+", "g");
  return t.replace(WS, " ").trim();
}

// A PowerShell single-quoted string: only the quote itself needs escaping.
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// SetProcessDPIAware matters: without it a scaled display (125%, 150%) reports
// logical pixels and CopyFromScreen hands back a blurry upscale of a small grab.
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  'public class NexusDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }',
  "'@",
  "[void][NexusDpi]::SetProcessDPIAware()",
];

function parseJson(text, what) {
  if (!text) throw new Error("no output from " + what);
  const i = text.indexOf("{"), j = text.indexOf("[");
  const start = j >= 0 && (i < 0 || j < i) ? j : i;
  if (start < 0) throw new Error(what + " printed no JSON: " + text.slice(0, 200));
  return JSON.parse(text.slice(start));
}

// Every monitor, in Windows' own order. index 0 is not necessarily the primary.
export async function listDisplays() {
  const rows = parseJson(await runPs(PRELUDE.concat([
    "$list = @()",
    "$i = 0",
    "foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {",
    "  $b = $s.Bounds",
    "  $list += [pscustomobject]@{ index = $i; name = $s.DeviceName; primary = [bool]$s.Primary; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height }",
    "  $i = $i + 1",
    "}",
    "ConvertTo-Json -Compress -Depth 3 -InputObject ([array]$list)",
  ])), "listDisplays");
  return Array.isArray(rows) ? rows : [rows];
}

// Grab the desktop. display: "all" (every monitor stitched, the default) or a
// display index from listDisplays(). Returns the PNG bytes plus what was shot.
// maxEdge downscales the long side; pass 0 to keep native resolution.
export async function captureScreen(opts) {
  const o = opts || {};
  const display = o.display === undefined || o.display === null || o.display === "" ? "all" : String(o.display);
  if (display !== "all" && !/^[0-9]+$/.test(display)) throw new Error("display must be 'all' or a number");
  const maxEdge = o.maxEdge === undefined ? MAX_EDGE : Math.max(0, Number(o.maxEdge) || 0);
  const keep = !!o.out;
  const outPath = path.resolve(o.out || path.join(os.tmpdir(), "nexus-screen-" + Date.now() + ".png"));
  const meta = parseJson(await runPs(PRELUDE.concat([
    "$target = " + psStr(display),
    "$screens = [System.Windows.Forms.Screen]::AllScreens",
    "if ($target -eq 'all') {",
    "  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "  $label = 'all displays'",
    "} else {",
    "  $idx = [int]$target",
    "  if ($idx -lt 0 -or $idx -ge $screens.Count) { throw ('no display ' + $target + '; there are ' + $screens.Count) }",
    "  $b = $screens[$idx].Bounds",
    "  $label = $screens[$idx].DeviceName",
    "}",
    "$shot = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($shot)",
    "$g.CopyFromScreen($b.X, $b.Y, 0, 0, $shot.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)",
    "$g.Dispose()",
    "$src = $shot",
    "$maxEdge = " + maxEdge,
    "$long = [Math]::Max($shot.Width, $shot.Height)",
    "if ($maxEdge -gt 0 -and $long -gt $maxEdge) {",
    "  $scale = $maxEdge / $long",
    "  $nw = [Math]::Max(1, [int][Math]::Round($shot.Width * $scale))",
    "  $nh = [Math]::Max(1, [int][Math]::Round($shot.Height * $scale))",
    "  $small = New-Object System.Drawing.Bitmap $nw, $nh",
    "  $g2 = [System.Drawing.Graphics]::FromImage($small)",
    "  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
    "  $g2.DrawImage($shot, 0, 0, $nw, $nh)",
    "  $g2.Dispose()",
    "  $src = $small",
    "}",
    "$src.Save(" + psStr(outPath) + ", [System.Drawing.Imaging.ImageFormat]::Png)",
    "$info = [pscustomobject]@{ path = " + psStr(outPath) + "; width = $src.Width; height = $src.Height; sourceWidth = $shot.Width; sourceHeight = $shot.Height; x = $b.X; y = $b.Y; label = $label; displays = $screens.Count }",
    "$src.Dispose()",
    "$shot.Dispose()",
    "ConvertTo-Json -Compress -Depth 3 -InputObject $info",
  ])), "captureScreen");
  const png = fs.readFileSync(meta.path);
  if (!keep) { try { fs.rmSync(meta.path, { force: true }); } catch {} }
  const shot = {
    png, width: meta.width, height: meta.height,
    sourceWidth: meta.sourceWidth, sourceHeight: meta.sourceHeight,
    x: meta.x, y: meta.y, label: meta.label, displays: meta.displays,
    path: keep ? meta.path : null,
    scaled: meta.width !== meta.sourceWidth,
  };
  rememberCapture(shot, o.by);
  return shot;
}

// The most recent capture, kept in memory so the sidebar can show Tucker the
// exact frame Claude was handed. One image only - it is a preview, not a log.
let last = null;
export function lastCapture() { return last; }
export function rememberCapture(shot, by) {
  last = { png: shot.png, width: shot.width, height: shot.height, label: shot.label, by: by || null, at: Date.now() };
  return last;
}

// ---- CLI ----
function usage() {
  console.log([
    "Capture Tucker's screen as a PNG (Nexus Point).",
    "",
    "  node tools/screen.mjs [--display all|<n>] [--max <px>] [--out <file.png>]",
    "  node tools/screen.mjs --list",
    "",
    "  --display  all (every monitor, default) or a display index from --list",
    "  --max      downscale the long edge, default " + MAX_EDGE + "; 0 keeps native size",
    "  --out      where to write the PNG; without it a temp file is written and",
    "             the path is printed, so you can Read that path to see the screen",
    "",
    "Reading it back: point the Read tool at the printed path.",
  ].join(NL));
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  if (args.help) return usage();
  if (args.list) {
    const ds = await listDisplays();
    for (const d of ds) {
      console.log("  " + d.index + "  " + d.w + "x" + d.h + " at " + d.x + "," + d.y +
        (d.primary ? "  (primary)" : "") + "  " + d.name);
    }
    return;
  }
  const out = args.out || path.join(os.tmpdir(), "nexus-screen.png");
  const r = await captureScreen({ display: args.display, maxEdge: args.max, out });
  console.log(r.path);
  console.log("  " + r.label + ": " + r.sourceWidth + "x" + r.sourceHeight +
    (r.scaled ? " captured, saved at " + r.width + "x" + r.height : "") +
    "  (" + Math.round(r.png.length / 1024) + " KB)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
