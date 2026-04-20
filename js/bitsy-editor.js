/**
 * js/bitsy-editor.js
 * ─────────────────────────────────────────────────────────────────
 * Bitsy SMS editor UI.
 *
 * Depends on: bitsy-engine.js (must load first)
 *
 * Handles:
 *   - Paint canvas (8×8 pixel editor for tiles, sprites, avatar)
 *   - Map canvas (16×16 room editor, click to place/erase tiles)
 *   - Color pickers for the 3-color Bitsy palette
 *   - Room management (add room, switch room)
 *   - Game data textarea (manual editing + live re-parse)
 *   - Edit ↔ Play mode toggle
 * ─────────────────────────────────────────────────────────────────
 */

/* ── editor constants ─────────────────────────────────── */
var TileType = { Tile: 0, Sprite: 1, Avatar: 2 };
var EditMode = { Edit: 0, Play: 1 };

/* ── editor state ─────────────────────────────────────── */
var editMode = EditMode.Edit;

var paint_canvas, paint_ctx;
var paint_scale = 32;

var paintMode    = TileType.Avatar;
var drawingId    = "A";
var drawingPal   = "0";
var drawing_data = Array.from({ length: 8 }, function() { return Array(8).fill(0); });

var drawPaintGrid  = true;
var curPaintBrush  = 0;
var isPainting     = false;

var nextTileCharCode   = 97; // 'a'
var tileIndex          = 0;
var nextSpriteCharCode = 97; // 'a'
var spriteIndex        = 0;

var drawMapGrid = true;

/* ── initialisation ───────────────────────────────────── */
function start() {
  // game / map canvas
  canvas        = document.getElementById("game");
  canvas.width  = width  * scale;
  canvas.height = height * scale;
  ctx           = canvas.getContext("2d");
  listenMapEditEvents();

  // paint canvas
  paint_canvas        = document.getElementById("paint");
  paint_canvas.width  = tilesize * paint_scale;
  paint_canvas.height = tilesize * paint_scale;
  paint_ctx           = paint_canvas.getContext("2d");
  paint_canvas.addEventListener("mousedown",  paint_onMouseDown);
  paint_canvas.addEventListener("mousemove",  paint_onMouseMove);
  paint_canvas.addEventListener("mouseup",    paint_onMouseUp);
  paint_canvas.addEventListener("mouseleave", paint_onMouseUp);

  // ── default world ──
  title       = "My Bitsy SMS Game";
  palette["0"] = [[0, 52, 104], [80, 140, 200], [240, 240, 255]];

  // avatar
  paintMode = TileType.Avatar;
  on_paint_avatar();
  drawing_data = [
    [0,0,0,1,1,0,0,0],
    [0,0,0,1,1,0,0,0],
    [0,0,0,1,1,0,0,0],
    [0,0,1,1,1,1,0,0],
    [0,1,1,1,1,1,1,0],
    [1,0,1,1,1,1,0,1],
    [0,0,1,0,0,1,0,0],
    [0,0,1,0,0,1,0,0]
  ];
  saveDrawingData();
  sprite["A"].set = "0";
  sprite["A"].x   = 4;
  sprite["A"].y   = 4;

  // default NPC sprite
  paintMode = TileType.Sprite;
  newSprite();
  on_paint_sprite();
  drawing_data = [
    [0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0],
    [0,1,0,1,0,0,0,1],
    [0,1,1,1,0,0,0,1],
    [0,1,1,1,0,0,1,0],
    [0,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,0,0],
    [0,0,1,0,0,1,0,0]
  ];
  saveDrawingData();
  sprite["a"].set = "0";
  sprite["a"].x   = 8;
  sprite["a"].y   = 8;
  dialog["a"]     = "Hello from the SMS!";

  // default tile (wall block)
  paintMode = TileType.Tile;
  newTile();
  on_paint_tile();
  drawing_data = [
    [1,1,1,1,1,1,1,1],
    [1,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,1],
    [1,0,0,1,1,0,0,1],
    [1,0,0,1,1,0,0,1],
    [1,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,1],
    [1,1,1,1,1,1,1,1]
  ];
  saveDrawingData();
  renderImages();

  // default room
  set["0"] = {
    id: "0",
    tilemap: [
      "0000000000000000",
      "0aaaaaaaaaaaaaa0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0a000000000000a0",
      "0aaaaaaaaaaaaaa0",
      "0000000000000000"
    ],
    walls: ["a"],
    exits: [],
    pal: null
  };

  refreshGameData();
  on_paint_avatar();
  drawPaintCanvas();
  drawEditMap();
}

/* ── map edit events ──────────────────────────────────── */
function listenMapEditEvents()   { canvas.addEventListener("mousedown",    map_onMouseDown); }
function unlistenMapEditEvents() { canvas.removeEventListener("mousedown", map_onMouseDown); }

function map_onMouseDown(e) {
  var rect = canvas.getBoundingClientRect();
  var x = Math.floor((e.clientX - rect.left)  / (tilesize * scale));
  var y = Math.floor((e.clientY - rect.top)   / (tilesize * scale));
  if (x < 0 || x >= mapsize || y < 0 || y >= mapsize) return;

  var row = set[curSet].tilemap[y];
  if (paintMode === TileType.Tile) {
    row = row.substr(0, x) + (row.charAt(x) === "0" ? drawingId : "0") + row.substr(x + 1);
    set[curSet].tilemap[y] = row;
  } else {
    sprite[drawingId].set = curSet;
    sprite[drawingId].x   = x;
    sprite[drawingId].y   = y;
  }
  refreshGameData();
  drawEditMap();
}

/* ── paint canvas events ──────────────────────────────── */
function paint_onMouseDown(e) {
  var rect = paint_canvas.getBoundingClientRect();
  var x = Math.floor((e.clientX - rect.left) / paint_scale);
  var y = Math.floor((e.clientY - rect.top)  / paint_scale);
  if (x < 0 || x >= 8 || y < 0 || y >= 8) return;
  curPaintBrush        = (drawing_data[y][x] === 0) ? 1 : 0;
  drawing_data[y][x]   = curPaintBrush;
  drawPaintCanvas();
  isPainting = true;
}

function paint_onMouseMove(e) {
  if (!isPainting) return;
  var rect = paint_canvas.getBoundingClientRect();
  var x = Math.floor((e.clientX - rect.left) / paint_scale);
  var y = Math.floor((e.clientY - rect.top)  / paint_scale);
  if (x >= 0 && x < 8 && y >= 0 && y < 8) {
    drawing_data[y][x] = curPaintBrush;
    drawPaintCanvas();
  }
}

function paint_onMouseUp() {
  isPainting = false;
  saveDrawingData();
  refreshGameData();
  drawEditMap();
}

/* ── tile navigation ──────────────────────────────────── */
function newTile() {
  drawingId = String.fromCharCode(nextTileCharCode++);
  drawing_data = Array.from({ length: 8 }, function() { return Array(8).fill(0); });
  drawPaintCanvas();
  saveDrawingData();
  refreshGameData();
  tileIndex = Object.keys(tile).length - 1;
  reloadTile();
}

function nextTile() {
  var ids = sortedTileIdList();
  tileIndex = (tileIndex + 1) % ids.length;
  drawingId = ids[tileIndex];
  reloadTile();
}

function prevTile() {
  var ids = sortedTileIdList();
  tileIndex = (tileIndex - 1 + ids.length) % ids.length;
  drawingId = ids[tileIndex];
  reloadTile();
}

/* ── sprite navigation ────────────────────────────────── */
function newSprite() {
  drawingId = String.fromCharCode(nextSpriteCharCode++);
  drawing_data = Array.from({ length: 8 }, function() { return Array(8).fill(0); });
  drawPaintCanvas();
  saveDrawingData();
  refreshGameData();
  spriteIndex = Object.keys(sprite).length - 1;
  reloadSprite();
}

function nextSprite() {
  var ids = sortedSpriteIdList();
  spriteIndex = (spriteIndex + 1) % ids.length;
  drawingId   = ids[spriteIndex];
  reloadSprite();
}

function prevSprite() {
  var ids = sortedSpriteIdList();
  spriteIndex = (spriteIndex - 1 + ids.length) % ids.length;
  drawingId   = ids[spriteIndex];
  reloadSprite();
}

function next()       { if (paintMode === TileType.Tile) nextTile();   else nextSprite(); }
function prev()       { if (paintMode === TileType.Tile) prevTile();   else prevSprite(); }
function newDrawing() { if (paintMode === TileType.Tile) newTile();    else newSprite(); }

/* ── reload helpers ───────────────────────────────────── */
function reloadTile() {
  var drw = "TIL_" + drawingId;
  if (imageStore.source[drw]) {
    for (var y = 0; y < 8; y++)
      for (var x = 0; x < 8; x++)
        drawing_data[y][x] = parseInt((imageStore.source[drw][y] || "")[x]) || 0;
  }
  drawPaintCanvas();
  if (set[curSet])
    document.getElementById("wallCheckbox").checked = (set[curSet].walls.indexOf(drawingId) !== -1);
}

function reloadSprite() {
  var drw = "SPR_" + drawingId;
  if (imageStore.source[drw]) {
    for (var y = 0; y < 8; y++)
      for (var x = 0; x < 8; x++)
        drawing_data[y][x] = parseInt((imageStore.source[drw][y] || "")[x]) || 0;
  }
  drawPaintCanvas();
  document.getElementById("dialogText").value = dialog[drawingId] || "";
}

function sortedTileIdList()   { return Object.keys(tile).sort(); }
function sortedSpriteIdList() { return Object.keys(sprite).sort(); }

/* ── drawing ──────────────────────────────────────────── */
function drawPaintCanvas() {
  var pal = palette[drawingPal] || [[0,0,0],[200,200,200],[255,255,255]];
  paint_ctx.fillStyle = "rgb(" + pal[0][0] + "," + pal[0][1] + "," + pal[0][2] + ")";
  paint_ctx.fillRect(0, 0, paint_canvas.width, paint_canvas.height);

  var c = (paintMode === TileType.Tile) ? pal[1] : pal[2];
  paint_ctx.fillStyle = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  for (var x = 0; x < 8; x++)
    for (var y = 0; y < 8; y++)
      if (drawing_data[y][x] === 1)
        paint_ctx.fillRect(x * paint_scale, y * paint_scale, paint_scale, paint_scale);

  if (drawPaintGrid) {
    paint_ctx.fillStyle = "rgba(255,255,255,0.2)";
    for (var x = 1; x < 8; x++) paint_ctx.fillRect(x * paint_scale, 0, 1, 8 * paint_scale);
    for (var y = 1; y < 8; y++) paint_ctx.fillRect(0, y * paint_scale, 8 * paint_scale, 1);
  }
}

function drawEditMap() {
  var pal = palette[curPalId()] || [[0,0,0],[200,200,200],[255,255,255]];
  ctx.fillStyle = "rgb(" + pal[0][0] + "," + pal[0][1] + "," + pal[0][2] + ")";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (set[curSet]) drawSet(set[curSet]);

  if (drawMapGrid) {
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    for (var x = 1; x < mapsize; x++) ctx.fillRect(x * tilesize * scale, 0, 1, mapsize * tilesize * scale);
    for (var y = 1; y < mapsize; y++) ctx.fillRect(0, y * tilesize * scale, mapsize * tilesize * scale, 1);
  }
}

/* ── save drawing data ────────────────────────────────── */
function saveDrawingData() {
  if (paintMode === TileType.Tile) {
    var drw = "TIL_" + drawingId;
    if (!(drawingId in tile)) tile[drawingId] = { drw: drw, col: 1 };
    imageStore.source[drw] = [];
    for (var y = 0; y < 8; y++) {
      var ln = "";
      for (var x = 0; x < 8; x++) ln += drawing_data[y][x];
      imageStore.source[drw].push(ln);
    }
    renderImages();
  } else {
    var drw = "SPR_" + drawingId;
    if (!(drawingId in sprite)) sprite[drawingId] = { drw: drw, col: 2, set: null, x: -1, y: -1 };
    imageStore.source[drw] = [];
    for (var y = 0; y < 8; y++) {
      var ln = "";
      for (var x = 0; x < 8; x++) ln += drawing_data[y][x];
      imageStore.source[drw].push(ln);
    }
    renderImages();
  }
}

/* ── game data textarea ───────────────────────────────── */
function refreshGameData() {
  document.getElementById("game_data").value = serializeWorld();
}

function on_game_data_change() {
  parseWorld(document.getElementById("game_data").value);
  drawPaintCanvas();
  drawEditMap();
}

/* ── edit / play mode ─────────────────────────────────── */
function on_edit_mode() {
  stopGame();
  parseWorld(document.getElementById("game_data").value);
  drawEditMap();
  listenMapEditEvents();
}

function on_play_mode() {
  unlistenMapEditEvents();
  load_game(document.getElementById("game_data").value);
}

/* ── grid toggles ─────────────────────────────────────── */
function toggleGrid()    { drawPaintGrid = !drawPaintGrid; drawPaintCanvas(); }
function toggleMapGrid() { drawMapGrid   = !drawMapGrid;   drawEditMap(); }

/* ── title ────────────────────────────────────────────── */
function on_change_title() {
  title = document.getElementById("titleText").value;
  refreshGameData();
}

/* ── color pickers ────────────────────────────────────── */
function hexToRgb(hex) {
  hex = hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, function(m, r, g, b) { return r+r+g+g+b+b; });
  var r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) } : null;
}

function on_change_color_bg() {
  var c = hexToRgb(document.getElementById("backgroundColor").value);
  palette[drawingPal][0] = [c.r, c.g, c.b];
  refreshGameData(); renderImages(); drawPaintCanvas(); drawEditMap();
}
function on_change_color_tile() {
  var c = hexToRgb(document.getElementById("tileColor").value);
  palette[drawingPal][1] = [c.r, c.g, c.b];
  refreshGameData(); renderImages(); drawPaintCanvas(); drawEditMap();
}
function on_change_color_sprite() {
  var c = hexToRgb(document.getElementById("spriteColor").value);
  palette[drawingPal][2] = [c.r, c.g, c.b];
  refreshGameData(); renderImages(); drawPaintCanvas(); drawEditMap();
}

/* ── paint mode switches ──────────────────────────────── */
function on_paint_avatar() {
  paintMode = TileType.Avatar;
  drawingId = "A";
  reloadSprite();
  document.getElementById("dialog").style.display  = "none";
  document.getElementById("wall").style.display    = "none";
  document.getElementById("paintNav").style.display = "none";
}

function on_paint_tile() {
  paintMode = TileType.Tile;
  tileIndex = 0;
  var ids   = sortedTileIdList();
  drawingId = ids.length ? ids[0] : "a";
  reloadTile();
  document.getElementById("dialog").style.display  = "none";
  document.getElementById("wall").style.display    = "block";
  document.getElementById("paintNav").style.display = "block";
}

function on_paint_sprite() {
  paintMode   = TileType.Sprite;
  spriteIndex = 1;
  var ids     = sortedSpriteIdList();
  drawingId   = ids[Math.min(1, ids.length - 1)];
  reloadSprite();
  document.getElementById("dialog").style.display  = "block";
  document.getElementById("wall").style.display    = "none";
  document.getElementById("paintNav").style.display = "block";
}

/* ── dialog input ─────────────────────────────────────── */
function on_change_dialog() {
  dialog[drawingId] = document.getElementById("dialogText").value;
  refreshGameData();
}

/* ── wall toggle ──────────────────────────────────────── */
function on_toggle_wall() {
  var walls = set[curSet].walls;
  if (document.getElementById("wallCheckbox").checked) {
    if (walls.indexOf(drawingId) === -1) walls.push(drawingId);
  } else {
    var i = walls.indexOf(drawingId);
    if (i !== -1) walls.splice(i, 1);
  }
  refreshGameData();
}

/* ── room management ──────────────────────────────────── */
function on_new_room() {
  var ids   = Object.keys(set).sort();
  var newId = String(ids.length);
  set[newId] = {
    id: newId,
    tilemap: Array(16).fill("0000000000000000"),
    walls: [],
    exits: [],
    pal: null
  };
  curSet = newId;
  refreshGameData();
  drawEditMap();
  smsLog("Added room " + newId + ". Use EXT in game data to connect rooms.");
}

function on_switch_room() {
  var ids   = Object.keys(set).sort();
  var ci    = ids.indexOf(curSet);
  curSet    = ids[(ci + 1) % ids.length];
  drawEditMap();
  smsLog("Viewing room " + curSet);
}
