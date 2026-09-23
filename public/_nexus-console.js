// Injected into every HTML page served under /preview/ (see server.js).
// Forwards console output and uncaught errors to the Nexus Point Play tab so
// the game's log shows next to the game. Does nothing when not framed.
(function () {
  if (window.parent === window) return;
  function fmt(a) {
    try {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      if (a === undefined) return "undefined";
      var s = JSON.stringify(a);
      return s.length > 2000 ? s.slice(0, 2000) + "..." : s;
    } catch (e) { return String(a); }
  }
  function send(level, args) {
    try {
      var text = [].slice.call(args).map(fmt).join(" ");
      window.parent.postMessage({ nexusConsole: true, level: level, text: text.slice(0, 4000) }, "*");
    } catch (e) {}
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (l) {
    var orig = console[l];
    console[l] = function () { send(l, arguments); try { orig.apply(console, arguments); } catch (e) {} };
  });
  window.addEventListener("error", function (e) {
    send("error", [e.message + " (" + (e.filename || "").split("/").pop() + ":" + e.lineno + ")"]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    send("error", ["Unhandled promise rejection: " + (r && (r.stack || r.message) || r)]);
  });
  window.parent.postMessage({ nexusConsole: true, level: "ready", text: "" }, "*");
})();
