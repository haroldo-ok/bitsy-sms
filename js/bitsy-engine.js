/**
 * js/bitsy-engine.js
 * ─────────────────────────────────────────────────────────────────
 * Bitsy classic v0 game engine, adapted for Bitsy SMS.
 *
 * Handles:
 *   - Parsing and serializing the Bitsy plain-text world format
 *   - Rendering tiles, sprites, and dialog onto a <canvas>
 *   - Keyboard input and player movement
 *   - Wall collisions, room exits, NPC dialog triggers
 *
 * Exposes globals used by bitsy-editor.js and sms-codegen.js:
 *   canvas, ctx, title, set, tile, sprite, dialog, palette,
 *   imageStore, spriteStartLocations, curSet,
 *   width, height, scale, tilesize, mapsize
 * ─────────────────────────────────────────────────────────────────
 */

/* ── core globals ─────────────────────────────────────── */
var canvas, ctx;

var title   = "";
var set     = {};
var tile    = {};
var sprite  = {};
var dialog  = {};
var palette = { "0": [[0, 82, 204], [128, 159, 255], [255, 255, 255]] };

var imageStore           = { source: {}, render: {} };
var spriteStartLocations = {};

var width    = 128;
var height   = 128;
var scale    = 4;
var tilesize = 8;
var mapsize  = 16;

var curSet = "0";

var key = {
  left: 37, right: 39, up: 38, down: 40,
  space: 32, enter: 13,
  w: 87, a: 65, s: 83, d: 68
};

var prevTime  = 0;
var deltaTime = 0;

/* ── play-mode state ──────────────────────────────────── */
var isTitle  = false;
var isEnding = false;
var update_interval  = null;
var loading_interval = null;
var loading_anim_frame = 0;

/* ── game lifecycle ───────────────────────────────────── */
function load_game(game_data) {
  parseWorld(game_data);
  renderImages();
  onready();
}

function onready() {
  clearInterval(loading_interval);
  document.addEventListener('keydown', onkeydown);
  update_interval = setInterval(update, -1);
  isTitle = true;
  startDialog(title);
}

function stopGame() {
  document.removeEventListener('keydown', onkeydown);
  clearInterval(update_interval);
}

/* ── update loop ──────────────────────────────────────── */
function update() {
  var curTime = Date.now();
  deltaTime   = curTime - prevTime;
  if (isTitle || isEnding) { drawDialog(); return; }
  if (dialogOn) {
    if (deltaTime > 500) { prevTime = curTime; drawDialog(); }
    return;
  }
  draw();
}

/* ── input ────────────────────────────────────────────── */
function onkeydown(e) {
  if (isTitle || isEnding) { clearDialog(); isTitle = false; isEnding = false; draw(); return; }
  if (dialogOn) { clearDialog(); draw(); return; }

  var moved = false;
  if      (e.keyCode === key.left  || e.keyCode === key.a) { movePlayer(-1,  0); moved = true; }
  else if (e.keyCode === key.right || e.keyCode === key.d) { movePlayer( 1,  0); moved = true; }
  else if (e.keyCode === key.up    || e.keyCode === key.w) { movePlayer( 0, -1); moved = true; }
  else if (e.keyCode === key.down  || e.keyCode === key.s) { movePlayer( 0,  1); moved = true; }

  if (moved) e.preventDefault();
}

/* ── movement ─────────────────────────────────────────── */
function movePlayer(dx, dy) {
  var player = sprite["A"];
  var nx = player.x + dx;
  var ny = player.y + dy;

  // bounds
  if (nx < 0 || nx >= mapsize || ny < 0 || ny >= mapsize) return;

  // walls
  var cellId = (set[curSet].tilemap[ny] || "")[nx] || "0";
  if (set[curSet].walls.indexOf(cellId) !== -1) return;

  // NPC collision
  for (var id in sprite) {
    if (id === "A") continue;
    var s = sprite[id];
    if (s.set === curSet && s.x === nx && s.y === ny) {
      if (id in dialog) startDialog(dialog[id]);
      return;
    }
  }

  // exits
  for (var ei = 0; ei < set[curSet].exits.length; ei++) {
    var ext = set[curSet].exits[ei];
    if (ext.x === nx && ext.y === ny) {
      curSet       = ext.dest.set;
      player.set   = curSet;
      player.x     = ext.dest.x;
      player.y     = ext.dest.y;
      draw();
      return;
    }
  }

  player.x   = nx;
  player.y   = ny;
  player.set = curSet;
}

/* ── world parsing ────────────────────────────────────── */
function parseWorld(file) {
  set    = {};
  tile   = {};
  sprite = {};
  dialog = {};
  palette              = { "0": [[0, 82, 204], [128, 159, 255], [255, 255, 255]] };
  imageStore           = { source: {}, render: {} };
  spriteStartLocations = {};

  var lines = file.split("\n");
  var i     = 0;
  while (i < lines.length) {
    var cur = lines[i];
    if      (i === 0)                       { i = parseTitle(lines, i); }
    else if (cur.length <= 0 || cur[0] === "#") { i++; }
    else if (getType(cur) === "PAL")        { i = parsePalette(lines, i); }
    else if (getType(cur) === "SET")        { i = parseSet(lines, i); }
    else if (getType(cur) === "TIL")        { i = parseTile(lines, i); }
    else if (getType(cur) === "SPR")        { i = parseSprite(lines, i); }
    else if (getType(cur) === "DRW")        { i = parseDrawing(lines, i); }
    else if (getType(cur) === "DLG")        { i = parseDialog(lines, i); }
    else                                    { i++; }
  }
  placeSprites();
}

/* ── world serialization ──────────────────────────────── */
function serializeWorld() {
  var w = "";

  w += title + "\n\n";

  for (var id in palette) {
    w += "PAL " + id + "\n";
    for (var i in palette[id]) w += palette[id][i].join(",") + "\n";
    w += "\n";
  }

  for (var id in set) {
    w += "SET " + id + "\n";
    for (var i in set[id].tilemap) w += set[id].tilemap[i] + "\n";
    if (set[id].walls.length > 0) w += "WAL " + set[id].walls.join(",") + "\n";
    for (var ei = 0; ei < set[id].exits.length; ei++) {
      var ext = set[id].exits[ei];
      w += "EXT " + ext.x + "," + ext.y + " " + ext.dest.set + " " + ext.dest.x + "," + ext.dest.y + "\n";
    }
    w += "\n";
  }

  for (var id in tile) {
    w += "TIL " + id + "\n";
    for (var i in imageStore.source["TIL_" + id]) w += imageStore.source["TIL_" + id][i] + "\n";
    w += "\n";
  }

  for (var id in sprite) {
    w += "SPR " + id + "\n";
    for (var i in imageStore.source["SPR_" + id]) w += imageStore.source["SPR_" + id][i] + "\n";
    if (sprite[id].set !== null)
      w += "POS " + sprite[id].set + " " + sprite[id].x + "," + sprite[id].y + "\n";
    w += "\n";
  }

  for (var id in dialog) {
    w += "DLG " + id + "\n";
    w += dialog[id] + "\n\n";
  }

  return w;
}

/* ── parse helpers ────────────────────────────────────── */
function placeSprites() {
  for (var id in spriteStartLocations) {
    if (sprite[id]) {
      sprite[id].set = spriteStartLocations[id].set;
      sprite[id].x   = spriteStartLocations[id].x;
      sprite[id].y   = spriteStartLocations[id].y;
    }
  }
}

function getType(l) { return l.split(" ")[0]; }
function getId(l)   { return l.split(" ")[1]; }

function parseTitle(lines, i)   { title = lines[i]; return i + 1; }

function parseSet(lines, i) {
  var id = getId(lines[i]);
  set[id] = { id: id, tilemap: [], walls: [], exits: [], pal: null };
  i++;
  for (var end = i + mapsize; i < end; i++) set[id].tilemap.push(lines[i]);

  while (i < lines.length && lines[i].length > 0) {
    var t = getType(lines[i]);
    if (t === "SPR") {
      var sprId = getId(lines[i]);
      if (sprId.indexOf(",") === -1) {
        var c = lines[i].split(" ")[2].split(",");
        spriteStartLocations[sprId] = { set: id, x: parseInt(c[0]), y: parseInt(c[1]) };
      } else {
        var sl = sprId.split(",");
        for (var row in set[id].tilemap) {
          for (var s in sl) {
            var col = set[id].tilemap[row].indexOf(sl[s]);
            if (col !== -1) {
              set[id].tilemap[row] = set[id].tilemap[row].replace(sl[s], "0");
              spriteStartLocations[sl[s]] = { set: id, x: col, y: parseInt(row) };
            }
          }
        }
      }
    } else if (t === "WAL") {
      set[id].walls = getId(lines[i]).split(",");
    } else if (t === "EXT") {
      var a  = lines[i].split(" ");
      var ec = a[1].split(",");
      var dc = a[3].split(",");
      set[id].exits.push({
        x: parseInt(ec[0]), y: parseInt(ec[1]),
        dest: { set: a[2], x: parseInt(dc[0]), y: parseInt(dc[1]) }
      });
    } else if (t === "PAL") {
      set[id].pal = getId(lines[i]);
    }
    i++;
  }
  return i;
}

function parsePalette(lines, i) {
  var id = getId(lines[i]); i++;
  var pal = [];
  while (i < lines.length && lines[i].length > 0) {
    var col = [];
    lines[i].split(",").forEach(function(v) { col.push(parseInt(v)); });
    pal.push(col); i++;
  }
  palette[id] = pal;
  return i;
}

function parseTile(lines, i) {
  var id = getId(lines[i]); var drwId = null; i++;
  if (getType(lines[i]) === "DRW") { drwId = getId(lines[i]); i++; }
  else {
    drwId = "TIL_" + id;
    imageStore.source[drwId] = [];
    for (var y = 0; y < tilesize; y++) imageStore.source[drwId].push(lines[i++]);
  }
  var ci = 1;
  while (i < lines.length && lines[i].length > 0) {
    if (getType(lines[i]) === "COL") ci = parseInt(getId(lines[i]));
    i++;
  }
  tile[id] = { drw: drwId, col: ci };
  return i;
}

function parseSprite(lines, i) {
  var id = getId(lines[i]); var drwId = null; i++;
  if (getType(lines[i]) === "DRW") { drwId = getId(lines[i]); i++; }
  else {
    drwId = "SPR_" + id;
    imageStore.source[drwId] = [];
    for (var y = 0; y < tilesize; y++) imageStore.source[drwId].push(lines[i++]);
  }
  var ci = 2;
  while (i < lines.length && lines[i].length > 0) {
    if (getType(lines[i]) === "COL") {
      ci = parseInt(getId(lines[i]));
    } else if (getType(lines[i]) === "POS") {
      var pa = lines[i].split(" ");
      var cc = pa[2].split(",");
      spriteStartLocations[id] = { set: pa[1], x: parseInt(cc[0]), y: parseInt(cc[1]) };
    }
    i++;
  }
  sprite[id] = { drw: drwId, col: ci, set: null, x: -1, y: -1 };
  return i;
}

function parseDrawing(lines, i) {
  var drwId = getId(lines[i]); i++;
  imageStore.source[drwId] = [];
  for (var y = 0; y < tilesize; y++) imageStore.source[drwId].push(lines[i++]);
  return i;
}

function parseDialog(lines, i) {
  var id = getId(lines[i]); i++;
  dialog[id] = lines[i];
  return i + 1;
}

/* ── rendering ────────────────────────────────────────── */
function renderImages() {
  for (var pal in palette) {
    imageStore.render[pal] = { "1": {}, "2": {} };
  }
  for (var s in sprite) {
    var sp = sprite[s];
    for (var pal in palette)
      imageStore.render[pal]["" + sp.col][sp.drw] =
        imageDataFromImageSource(imageStore.source[sp.drw], pal, sp.col);
  }
  for (var t in tile) {
    var tl = tile[t];
    for (var pal in palette)
      imageStore.render[pal]["" + tl.col][tl.drw] =
        imageDataFromImageSource(imageStore.source[tl.drw], pal, tl.col);
  }
}

function imageDataFromImageSource(src, pal, col) {
  var img = ctx.createImageData(tilesize * scale, tilesize * scale);
  for (var y = 0; y < tilesize; y++) {
    for (var x = 0; x < tilesize; x++) {
      var ch = (src && src[y]) ? src[y][x] : "0";
      for (var sy = 0; sy < scale; sy++) {
        for (var sx = 0; sx < scale; sx++) {
          var pxl = (((y * scale) + sy) * tilesize * scale * 4) + (((x * scale) + sx) * 4);
          var c   = (ch === "1") ? palette[pal][col] : palette[pal][0];
          if (!c) c = [0, 0, 0];
          img.data[pxl]     = c[0];
          img.data[pxl + 1] = c[1];
          img.data[pxl + 2] = c[2];
          img.data[pxl + 3] = 255;
        }
      }
    }
  }
  return img;
}

function drawTile(img, x, y)   { if (img) ctx.putImageData(img, x * tilesize * scale, y * tilesize * scale); }
function drawSprite(img, x, y) { drawTile(img, x, y); }

function drawSet(s) {
  for (var i in s.tilemap) {
    for (var j = 0; j < s.tilemap[i].length; j++) {
      var id = s.tilemap[i][j];
      if (id !== "0" && tile[id]) drawTile(getTileImage(tile[id]), j, parseInt(i));
    }
  }
  for (var id in sprite) {
    var sp = sprite[id];
    if (sp.set === s.id) drawSprite(getSpriteImage(sp), sp.x, sp.y);
  }
}

function getTileImage(t)   { if (!t) return null; return imageStore.render[curPalId()][t.col][t.drw]; }
function getSpriteImage(s) { if (!s) return null; return imageStore.render[curPalId()][s.col][s.drw]; }

function curPalId() {
  if (set[curSet] && set[curSet].pal !== null) return set[curSet].pal;
  if (curSet in palette) return curSet;
  return "0";
}

function draw() {
  var pal = palette[curPalId()] || [[0,0,0],[200,200,200],[255,255,255]];
  ctx.fillStyle = "rgb(" + pal[0][0] + "," + pal[0][1] + "," + pal[0][2] + ")";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (set[curSet]) drawSet(set[curSet]);
  if (dialogOn) drawDialog();
}

/* ── dialog ───────────────────────────────────────────── */
var dialogOn    = false;
var dialogLines = [];
var dialogPage  = 0;

function startDialog(text) {
  dialogOn    = true;
  dialogLines = (text || "").split("\\n");
  dialogPage  = 0;
  drawDialog();
}

function clearDialog() { dialogOn = false; }

function drawDialog() {
  var pad = 4;
  var bx  = 12 * scale;
  var by  = (height - 12 - 19) * scale;
  var bw  = 104 * scale;
  var bh  = 19 * scale;

  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = "#fff";
  ctx.font = (tilesize * scale * 0.5) + "px monospace";

  var text = dialogLines[dialogPage % dialogLines.length] || "";
  ctx.fillText(text, bx + pad * scale, by + pad * scale + tilesize * scale * 0.5);
  dialogPage++;
}
