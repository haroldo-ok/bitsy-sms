/**
 * js/sms-compiler.js
 * ─────────────────────────────────────────────────────────────────
 * Bitsy SMS — three-step compile pipeline
 *
 * Correct callMain arguments (from CVBasic-emscripten source):
 *   CVBasic:  callMain(["--sms", "/input.bas", "/output.asm"])
 *             ^^^ double-dash flag, flag BEFORE filenames
 *   gasm80:   callMain(["/input.asm", "-o", "/output.bin", "-sms"])
 *             ^^^ single-dash, flag AFTER filenames
 * ─────────────────────────────────────────────────────────────────
 */

var cachedBasSource = null;
var cachedAsmSource = null;

/* ── build log ────────────────────────────────────────── */
function smsLog(msg) {
  var el = document.getElementById("status-log");
  if (!el) return;
  el.value += msg + "\n";
  el.scrollTop = el.scrollHeight;
}
function smsLogClear() {
  var el = document.getElementById("status-log");
  if (el) el.value = "";
}

/* ══════════════════════════════════════════════════════════
   window.compiler — must be assigned before any iframe loads.
   Mirrors the object that compiler-invoker.js creates.
   ══════════════════════════════════════════════════════════ */

function createToolInvoker(moduleName) {
  var invoker = {
    pendingCallback: null,
    pendingReject:   null,

    // Called by the iframe: top.compiler.<n>.handleIframeCallback(window)
    handleIframeCallback: function(iframeWindow) {
      var retries = 0;
      function poll() {
        if (iframeWindow.FS) {
          if (invoker.pendingCallback) invoker.pendingCallback(iframeWindow);
        } else {
          if (retries > 60) {
            if (invoker.pendingReject) invoker.pendingReject(new Error(moduleName + " FS never ready"));
            return;
          }
          retries++;
          setTimeout(poll, retries * 100);
        }
      }
      setTimeout(poll, 50);
    },

    // Load (or reload) the iframe; returns Promise<iframeWindow>
    load: function() {
      return new Promise(function(resolve, reject) {
        invoker.pendingCallback = resolve;
        invoker.pendingReject   = reject;

        var old = document.getElementById(moduleName + "-iframe");
        if (old) old.remove();

        var iframe = document.createElement("iframe");
        iframe.id  = moduleName + "-iframe";
        iframe.style.display = "none";
        iframe.src = "compiler/" + moduleName + "-iframe.html";
        document.body.appendChild(iframe);

        setTimeout(function() {
          if (invoker.pendingCallback === resolve) {
            invoker.pendingCallback = null;
            invoker.pendingReject   = null;
            reject(new Error(
              moduleName + " timed out (30s).\n" +
              "Serve this project via HTTP:\n" +
              "  python3 -m http.server\n" +
              "then open http://localhost:8000/"
            ));
          }
        }, 30000);
      });
    }
  };
  return invoker;
}

var compilerStatusModule = {
  print:    function(t) { smsLog("[out] " + t); },
  printErr: function(t) { smsLog("[err] " + t); },
  setStatus: function(t) { if (t) smsLog("[status] " + t); },
  totalDependencies: 0,
  monitorRunDependencies: function() {},

  createToolConfiguration: function(moduleName, iframeCtx) {
    iframeCtx.onerror = function(e) { smsLog("[" + moduleName + " onerror] " + e); };
    return {
      preRun: [], postRun: [],
      print:    function(t) { smsLog("[" + moduleName + "] " + Array.prototype.slice.call(arguments).join(" ")); },
      printErr: function(t) { smsLog("[" + moduleName + " ERR] " + Array.prototype.slice.call(arguments).join(" ")); },
      setStatus: function(t) { if (t) smsLog("[" + moduleName + " status] " + t); },
      totalDependencies: 0,
      monitorRunDependencies: function(left) { this.totalDependencies = Math.max(this.totalDependencies, left); }
    };
  }
};

window.compiler = {
  cvbasic: createToolInvoker("cvbasic"),
  gasm80:  createToolInvoker("gasm80"),
  status:  compilerStatusModule
};

/* ══════════════════════════════════════════════════════════
   STEP 1 — Generate CVBasic source
   ══════════════════════════════════════════════════════════ */
function onGenerateBas() {
  smsLogClear();
  smsLog("Parsing Bitsy world...");
  parseWorld(document.getElementById("game_data").value);
  renderImages();
  smsLog("Running code generator...");
  var world = { title: title, palette: palette, tile: tile, sprite: sprite, set: set, dialog: dialog, imageStore: imageStore };
  cachedBasSource = generateBasCode(world);
  cachedAsmSource = null;
  document.getElementById("bas-output").textContent = cachedBasSource;
  smsLog("CVBasic source ready (" + cachedBasSource.split("\n").length + " lines). Click 'Compile → .asm'.");
}

function onDownloadBas() {
  if (!cachedBasSource) onGenerateBas();
  downloadBlob(new Blob([cachedBasSource], { type: "text/plain" }), (title || "bitsy_sms") + ".bas");
  smsLog("Downloaded .bas source.");
}

/* ══════════════════════════════════════════════════════════
   STEP 2 — Compile .bas → .asm via CVBasic
   CVBasic args: ["--sms", inputFile, outputFile]
   (flag is --sms with double dash, and goes BEFORE filenames)
   ══════════════════════════════════════════════════════════ */
function onCompileAsm() {
  if (!cachedBasSource) { smsLog("ERROR: Generate .bas first (Step 1)."); return; }
  smsLog("Loading CVBasic compiler iframe...");
  window.compiler.cvbasic.load()
    .then(function(iwin) {
      smsLog("CVBasic ready — compiling for SMS...");
      try {
        iwin.FS.writeFile("/input.bas", cachedBasSource);
        // "--sms" with double dash, flag before filenames
        iwin.Module.callMain(["--sms", "/input.bas", "/output.asm"]);
        var asm = iwin.FS.readFile("/output.asm", { encoding: "utf8" });
        cachedAsmSource = asm;
        smsLog("Compiled OK — " + asm.split("\n").length + " asm lines. Click 'Assemble → .sms ROM'.");
      } catch (e) { smsLog("CVBasic error: " + e.message); }
    })
    .catch(function(e) { smsLog("ERROR: " + e.message); });
}

/* ══════════════════════════════════════════════════════════
   STEP 3 — Assemble .asm → .sms ROM via gasm80
   gasm80 args: [inputFile, "-o", outputFile, "-sms"]
   (single dash, flag goes AFTER filenames)
   ══════════════════════════════════════════════════════════ */
function onAssembleRom() {
  if (!cachedAsmSource) { smsLog("ERROR: Compile .asm first (Step 2)."); return; }
  smsLog("Loading gasm80 assembler iframe...");
  window.compiler.gasm80.load()
    .then(function(iwin) {
      smsLog("gasm80 ready — assembling...");
      try {
        iwin.FS.writeFile("/input.asm", cachedAsmSource);
        // single dash -sms, flag after filenames
        iwin.Module.callMain(["/input.asm", "-o", "/output.bin", "-sms"]);
        var bin = iwin.FS.readFile("/output.bin");
        smsLog("Assembled OK — " + bin.length + " raw bytes.");
        var rom = buildRom(bin);
        var filename = (title || "bitsy_sms").replace(/\s+/g, "_") + ".sms";
        downloadBlob(new Blob([rom], { type: "application/octet-stream" }), filename);
        smsLog("ROM downloaded: " + filename + " (" + rom.length + " bytes). Load in Emulicious, MEKA, or Fusion!");
      } catch (e) { smsLog("gasm80 error: " + e.message); }
    })
    .catch(function(e) { smsLog("ERROR: " + e.message); });
}

/* ── SEGA ROM header ──────────────────────────────────── */
function buildRom(rawBytes) {
  var romSize = 32768;
  while (romSize < rawBytes.length) romSize *= 2;
  var rom = new Uint8Array(romSize);
  rom.set(rawBytes);
  var sig = "TMR SEGA";
  for (var i = 0; i < 8; i++) rom[0x7FF0 + i] = sig.charCodeAt(i);
  rom[0x7FF8] = 0xFF; rom[0x7FF9] = 0xFF;
  var sizeNibble = Math.max(0, Math.round(Math.log2(romSize / 1024)) - 1) & 0xF;
  rom[0x7FFF] = 0x40 | sizeNibble;
  return rom;
}

/* ── download helper ──────────────────────────────────── */
function downloadBlob(blob, filename) {
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}
