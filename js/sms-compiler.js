/**
 * js/sms-compiler.js
 * ─────────────────────────────────────────────────────────────────
 * Bitsy SMS — three-step compile pipeline
 *
 * Depends on: bitsy-engine.js, bitsy-editor.js, sms-codegen.js
 *
 * Pipeline:
 *   Step 1  generateBas()   — calls generateBasCode(), shows preview
 *   Step 2  compileAsm()    — runs CVBasic via hidden iframe (Emscripten)
 *   Step 3  assembleRom()   — runs gasm80 via hidden iframe, adds SEGA
 *                             header, triggers .sms download
 *
 * CVBasic-emscripten is hosted at:
 *   https://haroldo-ok.github.io/CVBasic-emscripten/
 *
 * Both compilers are loaded fresh in a new iframe on every run to
 * avoid stale Emscripten FS state between compilations.
 *
 * Requirements:
 *   - Must be served over HTTP (not file://) for cross-origin iframes
 *   - Internet access to haroldo-ok.github.io
 * ─────────────────────────────────────────────────────────────────
 */

/* ── hosted compiler URLs ────────────────────────────── */
var CVBASIC_IFRAME_URL = "https://haroldo-ok.github.io/CVBasic-emscripten/cvbasic-iframe.html";
var GASM80_IFRAME_URL  = "https://haroldo-ok.github.io/CVBasic-emscripten/gasm80-iframe.html";

/* ── cached intermediate artifacts ───────────────────── */
var cachedBasSource = null;
var cachedAsmSource = null;

/* ── active iframes ───────────────────────────────────── */
var cvbasicIframe = null;
var gasm80Iframe  = null;

/* ── build log helpers ────────────────────────────────── */
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
   STEP 1 — Generate CVBasic source
   ══════════════════════════════════════════════════════════ */

/**
 * Parse the current game data textarea, run the code generator,
 * display the result in #bas-output, and cache it.
 */
function onGenerateBas() {
  smsLogClear();
  smsLog("Parsing Bitsy world...");

  parseWorld(document.getElementById("game_data").value);
  renderImages();

  smsLog("Generating CVBasic source for SMS...");

  var world = {
    title:      title,
    palette:    palette,
    tile:       tile,
    sprite:     sprite,
    set:        set,
    dialog:     dialog,
    imageStore: imageStore
  };

  cachedBasSource = generateBasCode(world);
  cachedAsmSource = null; // invalidate downstream cache

  document.getElementById("bas-output").textContent = cachedBasSource;

  var lines = cachedBasSource.split("\n").length;
  smsLog("CVBasic source generated (" + lines + " lines).");
  smsLog("Click 'Compile \u2192 .asm' to compile with CVBasic.");
}

/**
 * Download the current .bas source directly (no compile needed).
 */
function onDownloadBas() {
  if (!cachedBasSource) cachedBasSource = (function() {
    parseWorld(document.getElementById("game_data").value);
    renderImages();
    return generateBasCode({ title, palette, tile, sprite, set, dialog, imageStore });
  })();
  downloadBlob(
    new Blob([cachedBasSource], { type: "text/plain" }),
    (title || "bitsy_sms") + ".bas"
  );
  smsLog("Downloaded .bas source.");
}

/* ══════════════════════════════════════════════════════════
   STEP 2 — Compile .bas → .asm via CVBasic (Emscripten)
   ══════════════════════════════════════════════════════════ */

/**
 * Runs the CVBasic compiler inside a hidden iframe.
 * CVBasic is compiled to WebAssembly via Emscripten; we access
 * its virtual FS directly to write the input and read the output.
 *
 * @param {string} basSource
 * @returns {Promise<string>}  Z80 assembly source
 */
function runCvbasic(basSource) {
  return new Promise(function(resolve, reject) {
    smsLog("Loading CVBasic compiler iframe...");

    if (cvbasicIframe) { cvbasicIframe.remove(); cvbasicIframe = null; }

    cvbasicIframe = document.createElement("iframe");
    cvbasicIframe.style.display = "none";
    cvbasicIframe.src = CVBASIC_IFRAME_URL;
    document.body.appendChild(cvbasicIframe);

    var timeout = setTimeout(function() {
      reject(new Error(
        "CVBasic iframe timed out after 20s.\n" +
        "Make sure you are serving this file over HTTP (not file://) and have internet access."
      ));
    }, 20000);

    cvbasicIframe.onload = function() {
      var tries = 0;
      var poll  = setInterval(function() {
        tries++;
        try {
          var iwin = cvbasicIframe.contentWindow;
          if (iwin && iwin.FS && iwin.Module && typeof iwin.Module.callMain === "function") {
            clearInterval(poll);
            clearTimeout(timeout);
            try {
              iwin.FS.writeFile("/input.bas", basSource);
              // -sms flag targets Sega Master System (Z80 + Mode 4)
              iwin.Module.callMain(["/input.bas", "-sms", "/output.asm"]);
              var asm = iwin.FS.readFile("/output.asm", { encoding: "utf8" });
              smsLog("CVBasic compiled OK (" + asm.split("\n").length + " asm lines).");
              resolve(asm);
            } catch (err) {
              reject(new Error("CVBasic runtime error: " + err.message));
            }
          }
        } catch (e) { /* cross-origin guard — keep polling */ }

        if (tries > 150) {
          clearInterval(poll);
          reject(new Error("CVBasic Emscripten FS never became ready."));
        }
      }, 200);
    };
  });
}

/**
 * Button handler for Step 2.
 */
function onCompileAsm() {
  if (!cachedBasSource) {
    smsLog("ERROR: Generate .bas first (Step 1).");
    return;
  }
  smsLog("Starting CVBasic compilation...");
  runCvbasic(cachedBasSource)
    .then(function(asm) {
      cachedAsmSource = asm;
      smsLog("Assembly source ready. Click 'Assemble \u2192 .sms ROM' to build the ROM.");
    })
    .catch(function(err) {
      smsLog("ERROR: " + err.message);
      smsLog("Tip: Run  python3 -m http.server  in this folder, then open http://localhost:8000/");
    });
}

/* ══════════════════════════════════════════════════════════
   STEP 3 — Assemble .asm → binary via gasm80 + add SEGA header
   ══════════════════════════════════════════════════════════ */

/**
 * Runs gasm80 inside a hidden iframe.
 *
 * @param {string} asmSource
 * @returns {Promise<Uint8Array>}  raw ROM bytes
 */
function runGasm80(asmSource) {
  return new Promise(function(resolve, reject) {
    smsLog("Loading gasm80 assembler iframe...");

    if (gasm80Iframe) { gasm80Iframe.remove(); gasm80Iframe = null; }

    gasm80Iframe = document.createElement("iframe");
    gasm80Iframe.style.display = "none";
    gasm80Iframe.src = GASM80_IFRAME_URL;
    document.body.appendChild(gasm80Iframe);

    var timeout = setTimeout(function() {
      reject(new Error("gasm80 iframe timed out after 20s."));
    }, 20000);

    gasm80Iframe.onload = function() {
      var tries = 0;
      var poll  = setInterval(function() {
        tries++;
        try {
          var iwin = gasm80Iframe.contentWindow;
          if (iwin && iwin.FS && iwin.Module && typeof iwin.Module.callMain === "function") {
            clearInterval(poll);
            clearTimeout(timeout);
            try {
              iwin.FS.writeFile("/input.asm", asmSource);
              iwin.Module.callMain(["/input.asm", "-o", "/output.bin"]);
              var bin = iwin.FS.readFile("/output.bin");
              smsLog("gasm80 assembled OK (" + bin.length + " bytes).");
              resolve(bin);
            } catch (err) {
              reject(new Error("gasm80 runtime error: " + err.message));
            }
          }
        } catch (e) { /* keep polling */ }

        if (tries > 150) {
          clearInterval(poll);
          reject(new Error("gasm80 Emscripten FS never became ready."));
        }
      }, 200);
    };
  });
}

/**
 * Pad a binary to the nearest power-of-2 ROM size (≥ 32 KB),
 * inject the standard SEGA ROM header at 0x7FF0, and return
 * the final Uint8Array.
 *
 * SEGA header layout (16 bytes at 0x7FF0):
 *   0x7FF0–0x7FF7  "TMR SEGA"
 *   0x7FF8–0x7FF9  reserved (0xFF)
 *   0x7FFA–0x7FFB  checksum (left as 0x0000 — most emulators ignore it)
 *   0x7FFC–0x7FFE  product code / version
 *   0x7FFF          region | size  (0x04 = export/international, size nibble)
 */
function buildRom(rawBytes) {
  // Minimum SMS ROM size is 32 KB
  var romSize = 32768;
  while (romSize < rawBytes.length) romSize *= 2;

  var rom = new Uint8Array(romSize);
  rom.set(rawBytes);

  // SEGA header
  var sig = "TMR SEGA";
  for (var i = 0; i < 8; i++) rom[0x7FF0 + i] = sig.charCodeAt(i);
  rom[0x7FF8] = 0xFF;
  rom[0x7FF9] = 0xFF;
  // checksum bytes left as 0x00 0x00
  rom[0x7FFC] = 0x00; // product code lo
  rom[0x7FFD] = 0x00; // product code hi
  rom[0x7FFE] = 0x00; // version
  // region nibble 0x4 = export, size nibble = log2(KB) - 1
  var sizeNibble = Math.max(0, Math.log2(romSize / 1024) - 1) & 0xF;
  rom[0x7FFF] = 0x40 | sizeNibble;

  return rom;
}

/**
 * Button handler for Step 3.
 */
function onAssembleRom() {
  if (!cachedAsmSource) {
    smsLog("ERROR: Compile .asm first (Step 2).");
    return;
  }
  smsLog("Assembling...");
  runGasm80(cachedAsmSource)
    .then(function(bin) {
      var rom      = buildRom(bin);
      var filename = (title || "bitsy_sms").replace(/\s+/g, "_") + ".sms";
      downloadBlob(new Blob([rom], { type: "application/octet-stream" }), filename);
      smsLog("ROM downloaded: " + filename + " (" + rom.length + " bytes).");
      smsLog("Load it in Emulicious, MEKA, Fusion, or any SMS emulator!");
    })
    .catch(function(err) { smsLog("ERROR: " + err.message); });
}

/* ── file download utility ────────────────────────────── */
function downloadBlob(blob, filename) {
  var a       = document.createElement("a");
  a.href      = URL.createObjectURL(blob);
  a.download  = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}
