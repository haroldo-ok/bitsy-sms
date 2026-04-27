'use strict';

/*
 * sms-exporter.js
 * Converts a parsed Bitsy world object into a Sega Master System ROM.
 *
 * Usage (called from game.js):
 *   SmsExporter.exportRom(world, gameTitle);
 *
 * The world object is the live `world` global from the Bitsy editor
 * (populated by world.js parseWorld).
 *
 * Architecture
 * ============
 * 1. buildResourceBlob(world)  →  Uint8Array  (the resource filesystem)
 * 2. fetchBaseRom()            →  Uint8Array  (the pre-built .sms stub)
 * 3. concat + download
 *
 * Resource filesystem format
 * ==========================
 * Header  : 4-byte magic "bsy\0" + uint16-LE file_count
 * Entries : per file: name[16] + uint16 page + uint16 size + uint16 offset
 * Pages   : file contents packed into 16 KB pages starting at page 2
 *
 * Files
 * =====
 *  game.inf   — null-terminated game title
 *  font.dat   — 8×8 1bpp font glyphs for 0x20..0x7E (95 chars × 8 bytes)
 *  pal.dat    — palettes
 *  til.dat    — tile graphics
 *  spr.dat    — sprite (+ avatar) graphics
 *  itm.dat    — item graphics
 *  room.dat   — room records
 *  dlg.dat    — dialog strings
 *  var.dat    — variables
 *  itminv.dat — item inventory defaults
 *
 * Palette format (pal.dat)
 * ------------------------
 *  uint16  palette_count
 *  per palette:
 *    3 × { uint8 r, uint8 g, uint8 b, uint8 pad }   (bg, tile, sprite)
 *
 * Tile graphics format (til.dat / spr.dat / itm.dat)
 * ---------------------------------------------------
 *  uint16  tile_count
 *  per tile:
 *    uint16  tile_id           (numeric ID; avatar "A" → 0)
 *    uint8[64]  pixels         (8 rows × 8 cols, 0=bg 1=fg, row-major)
 *
 * Room format (room.dat)
 * ----------------------
 *  uint16  room_count
 *  per room:
 *    uint16  room_id
 *    uint8   pal_idx           (index into palette table)
 *    uint8[256] tilemap        (16×16 cells, tile_index, 0=empty)
 *    uint8   wall_count
 *    uint8[] walls             (tile indices that block movement)
 *    uint8   sprite_count
 *    per sprite: uint16 id, uint8 x, uint8 y, uint16 dlg_id
 *    uint8   item_count
 *    per item:   uint16 id, uint8 x, uint8 y
 *    uint8   exit_count
 *    per exit:   uint8 sx, uint8 sy, uint16 dest_room, uint8 dx, uint8 dy, uint16 dlg_id
 *    uint8   ending_count
 *    per ending: uint8 x, uint8 y, uint16 dlg_id
 *
 * Dialog format (dlg.dat)
 * -----------------------
 *  uint16  dialog_count
 *  per dialog:
 *    uint16  dlg_id    (numeric; "title" → 0)
 *    uint16  str_len
 *    char[]  str       (UTF-8 text, scripts stripped to plain text)
 *
 * Variable format (var.dat)
 * -------------------------
 *  uint16  var_count
 *  per variable:
 *    uint8   name_len
 *    char[]  name
 *    int16   value     (signed, stored as uint16-LE with 2s complement)
 *
 * Item inventory (itminv.dat)
 * ---------------------------
 *  uint16  entry_count
 *  per entry:
 *    uint16  item_id
 *    int16   default_count
 */

var SmsExporter = (function () {

    /* -------------------------------------------------------
     * Low-level binary helpers
     * ----------------------------------------------------- */

    function ByteWriter() {
        this._buf = [];
    }
    ByteWriter.prototype.u8  = function (v) { this._buf.push(v & 0xFF); };
    ByteWriter.prototype.u16 = function (v) { this.u8(v & 0xFF); this.u8((v >> 8) & 0xFF); };
    ByteWriter.prototype.i16 = function (v) { this.u16(v & 0xFFFF); };
    ByteWriter.prototype.bytes = function (arr) {
        for (var i = 0; i < arr.length; i++) this._buf.push(arr[i] & 0xFF);
    };
    ByteWriter.prototype.str0 = function (s) { // null-terminated ASCII string
        for (var i = 0; i < s.length; i++) this._buf.push(s.charCodeAt(i) & 0xFF);
        this._buf.push(0);
    };
    ByteWriter.prototype.pad = function (len, val) {
        val = (val === undefined) ? 0 : val;
        for (var i = 0; i < len; i++) this._buf.push(val);
    };
    ByteWriter.prototype.length = function () { return this._buf.length; };
    ByteWriter.prototype.toArray = function () { return this._buf.slice(); };

    /* -------------------------------------------------------
     * ID normalisation
     * The Bitsy world uses string IDs like "0", "a", "A", etc.
     * We convert them to uint16 numeric IDs for the ROM:
     *   - "A" (avatar) → 0xFFFE (player sentinel)
     *   - numeric strings → parseInt
     *   - alpha strings → hash to uint16 in range 0x8000..0xFFFD
     *   - "title" → 0
     * ----------------------------------------------------- */

    function idToU16(id) {
        if (id === null || id === undefined) return 0xFFFF;
        if (id === 'A' || id === 'AVA')     return 0xFFFE;
        if (id === 'title')                  return 0;
        var n = parseInt(id, 10);
        if (!isNaN(n) && String(n) === id)  return n & 0x7FFF;
        // hash for non-numeric ids
        var h = 0x8000;
        for (var i = 0; i < id.length; i++)
            h = ((h << 5) ^ (h >> 11) ^ id.charCodeAt(i)) & 0xFFFF;
        return (h & 0x7FFF) | 0x8000;
    }

    /* -------------------------------------------------------
     * Dialog text extraction
     * Strip Bitsy script markup ({wvy}, {if ...}, etc.) and
     * return plain text suitable for the SMS dialog box.
     * ----------------------------------------------------- */

    function extractPlainText(src) {
        if (!src) return '';

        // Handle both old-style (plain string) and new-style (script) dialog
        var text = src;

        // Strip script block delimiters
        text = text.replace(/^={3,}\s*/gm, '').replace(/\s*={3,}$/gm, '');

        // Strip function tags: {tag ...} or {tag}...{/tag}
        // Keep the inner text of say/print, discard action tags
        // Simple approach: extract text from say() calls if present,
        // otherwise strip all {…} tags and use remaining text.
        var sayMatches = [];
        var sayRe = /\{say\s+"([^"]*)"\}/g;
        var m;
        while ((m = sayRe.exec(text)) !== null) sayMatches.push(m[1]);

        if (sayMatches.length > 0) {
            text = sayMatches.join('\n');
        } else {
            // Strip all {tag} markers
            text = text.replace(/\{[^}]*\}/g, '');
            // Strip sequence/cycle/shuffle syntax ("- " at start of line)
            text = text.replace(/^[\s]*-\s*/gm, '');
        }

        // Collapse whitespace and trim
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        text = text.replace(/\n{3,}/g, '\n\n').trim();

        return text;
    }

    /* -------------------------------------------------------
     * Palette table builder (pal.dat)
     * ----------------------------------------------------- */

    function buildPalFile(world) {
        var w   = new ByteWriter();
        var ids = Object.keys(world.palette);
        w.u16(ids.length);
        ids.forEach(function (pid) {
            var pal    = world.palette[pid];
            var colors = pal.colors || [[0,0,0],[255,255,255],[255,255,255]];
            // bg, tile, sprite – 3 colours, 4 bytes each (r,g,b,pad)
            for (var i = 0; i < 3; i++) {
                var col = colors[i] || [0, 0, 0];
                w.u8(col[0]); w.u8(col[1]); w.u8(col[2]); w.u8(0);
            }
        });
        return w.toArray();
    }

    /* -------------------------------------------------------
     * Graphics file builder (til.dat / spr.dat / itm.dat)
     *
     * Bitsy drawings are stored in world.drawings[drwId]
     * where drwId is e.g. "TIL_a", "SPR_A", "ITM_0".
     * Each drawing is an array of frames; each frame is an
     * 8×8 array of 0/1 values.
     * We export only frame 0 (SMS has no animated tiles).
     * ----------------------------------------------------- */

    function buildGfxFile(entries, world, prefix) {
        // entries: array of { id, drwId }
        var getDrawing = world.getDrawing || function(id) { return world.drawings && world.drawings[id]; };
        var w = new ByteWriter();
        var valid = entries.filter(function (e) {
            var d = getDrawing(e.drwId);
            return d && d.length > 0;
        });
        w.u16(valid.length);
        valid.forEach(function (e) {
            var frames = getDrawing(e.drwId);
            var frame0 = frames[0]; // 8×8 array
            var frame1 = frames.length > 1 ? frames[1] : null;
            // isWall: only meaningful for tiles; read from world.tile[id].isWall
            var isWallFlag = 0;
            if (world.tile && world.tile[e.id]) {
                isWallFlag = world.tile[e.id].isWall ? 1 : 0;
            }
            w.u16(idToU16(e.id));
            w.u8(frame1 ? 2 : 1); // frame count
            w.u8(isWallFlag);      // flags: bit 0 = isWall
            // frame 0
            for (var row = 0; row < 8; row++) {
                for (var col = 0; col < 8; col++) {
                    var px = (frame0[row] && frame0[row][col] !== undefined)
                        ? (frame0[row][col] ? 1 : 0) : 0;
                    w.u8(px);
                }
            }
            // frame 1 (if present)
            if (frame1) {
                for (var row = 0; row < 8; row++) {
                    for (var col = 0; col < 8; col++) {
                        var px = (frame1[row] && frame1[row][col] !== undefined)
                            ? (frame1[row][col] ? 1 : 0) : 0;
                        w.u8(px);
                    }
                }
            }
        });
        return w.toArray();
    }

    /* -------------------------------------------------------
     * Room file builder (room.dat)
     *
     * Tile IDs in the tilemap are string IDs from the world.
     * We need to map them to sequential indices 1..N (0 = empty).
     * Wall IDs are also string tile IDs.
     * ----------------------------------------------------- */

    function buildRoomFile(world, tileIndexMap, palIdxMap) {
        // tileIndexMap: { tileStringId → uint8 sequential index (1-based) }
        // palIdxMap: { paletteStringId → uint8 index }
        var w        = new ByteWriter();
        var roomIds  = Object.keys(world.room);
        w.u16(roomIds.length);

        roomIds.forEach(function (rid) {
            var room = world.room[rid];

            // room_id
            w.u16(idToU16(rid));

            // pal_idx
            var palIdx = room.pal ? (palIdxMap[room.pal] || 0) : 0;
            w.u8(palIdx);

            // tilemap 16×16
            for (var y = 0; y < 16; y++) {
                for (var x = 0; x < 16; x++) {
                    var cell = (room.tilemap[y] && room.tilemap[y][x]) || '0';
                    // '0' or empty = no tile
                    var idx = (cell && cell !== '0') ? (tileIndexMap[cell] || 0) : 0;
                    w.u8(idx);
                }
            }

            // walls
            var walls = room.walls || [];
            w.u8(walls.length);
            walls.forEach(function (tid) { w.u8(tileIndexMap[tid] || 0); });

            // sprites (NPCs only; avatar handled separately)
            var spriteInstances = room.tilemap ? [] : [];
            // Collect sprites placed in this room
            var roomSpriteList = [];
            Object.keys(world.sprite).forEach(function (sid) {
                if (sid === 'A') return; // avatar placed separately
                var spr = world.sprite[sid];
                if (spr.room === rid) {
                    roomSpriteList.push(spr);
                }
            });

            // Also collect from per-room sprite entries (placed via room parser)
            // The world already has spr.room === rid set, so no need for room.sprites lookup

            w.u8(roomSpriteList.length);
            roomSpriteList.forEach(function (spr) {
                w.u16(idToU16(spr.id));
                w.u8(spr.x >= 0 ? spr.x : 0);
                w.u8(spr.y >= 0 ? spr.y : 0);
                var dlgId = spr.dlg ? idToU16(spr.dlg) : 0xFFFF;
                w.u16(dlgId);
            });

            // Avatar start position in this room (sentinel id 0xFFFE)
            var ava = world.sprite['A'];
            if (ava && ava.room === rid) {
                // Inject avatar as a special sprite entry so the C runtime
                // can find the start position
                // We sneak it in by re-writing the sprite count byte.
                // Trick: we already wrote sprite_count above.
                // Instead: just always write avatar as an extra sprite entry.
                // We have to patch the count we already wrote.
                // Simplest: write avatar sprite unconditionally and fix count.
                // --> We can't patch easily with ByteWriter, so pre-count it.
            }
            // Note: we handle this by pre-counting below (see revised approach)

            // items
            var roomItems = room.items || [];
            w.u8(roomItems.length);
            roomItems.forEach(function (itm) {
                w.u16(idToU16(itm.id));
                w.u8(itm.x);
                w.u8(itm.y);
            });

            // exits
            var exits = room.exits || [];
            w.u8(exits.length);
            exits.forEach(function (ex) {
                w.u8(ex.x);
                w.u8(ex.y);
                w.u16(idToU16(ex.dest.room));
                w.u8(ex.dest.x);
                w.u8(ex.dest.y);
                var dlgId = ex.dlg ? idToU16(ex.dlg) : 0xFFFF;
                w.u16(dlgId);
            });

            // endings
            var endings = room.endings || [];
            w.u8(endings.length);
            endings.forEach(function (en) {
                w.u8(en.x);
                w.u8(en.y);
                var dlgId = en.id ? idToU16(en.id) : 0xFFFF;
                w.u16(dlgId);
            });
        });

        return w.toArray();
    }

    /*
     * Revised room builder that correctly handles the avatar start position
     * by including it as a sentinel sprite entry in each room.
     */
    function buildRoomFileV2(world, tileIndexMap, palIdxMap) {
        var w       = new ByteWriter();
        var roomIds = Object.keys(world.room);
        var ava     = world.sprite['A'];

        w.u16(roomIds.length);

        roomIds.forEach(function (rid) {
            var room = world.room[rid];

            w.u16(idToU16(rid));

            var palIdx = (room.pal && palIdxMap[room.pal] !== undefined)
                ? palIdxMap[room.pal] : 0;
            w.u8(palIdx);

            // tilemap
            for (var y = 0; y < 16; y++) {
                for (var x = 0; x < 16; x++) {
                    var cell = (room.tilemap[y] && room.tilemap[y][x]) || '0';
                    var idx  = (cell && cell !== '0') ? (tileIndexMap[cell] || 0) : 0;
                    w.u8(idx);
                }
            }

            // walls: merge the room's explicit wall list with any tile that has isWall=true
            // (Bitsy 8.x uses per-tile isWall; older versions use per-room WAL list)
            var wallSet = {};
            // per-room wall list
            (room.walls || []).forEach(function (tid) {
                if (tid && tid !== '0' && tileIndexMap[tid]) wallSet[tid] = true;
            });
            // per-tile isWall flags
            Object.keys(world.tile).forEach(function (tid) {
                if (world.tile[tid].isWall === true) wallSet[tid] = true;
            });
            var wallList = Object.keys(wallSet).map(function (tid) { return tileIndexMap[tid]; })
                               .filter(function (v) { return v > 0; });
            w.u8(wallList.length & 0xFF);
            wallList.forEach(function (idx) { w.u8(idx); });

            // sprites + avatar sentinel
            var npcList = [];
            Object.keys(world.sprite).forEach(function (sid) {
                if (sid === 'A') return;
                var spr = world.sprite[sid];
                if (spr.room === rid) npcList.push(spr);
            });

            var avatarHere = ava && (ava.room === rid);
            var totalSprCount = npcList.length + (avatarHere ? 1 : 0);

            w.u8(totalSprCount & 0xFF);

            npcList.forEach(function (spr) {
                w.u16(idToU16(spr.id));
                w.u8(Math.max(0, spr.x));
                w.u8(Math.max(0, spr.y));
                w.u16(spr.dlg ? idToU16(spr.dlg) : 0xFFFF);
            });

            if (avatarHere) {
                w.u16(0xFFFE); // avatar sentinel
                w.u8(Math.max(0, ava.x));
                w.u8(Math.max(0, ava.y));
                w.u16(0xFFFF); // no dialog for avatar sentinel
            }

            // items
            var roomItems = room.items || [];
            w.u8(roomItems.length & 0xFF);
            roomItems.forEach(function (itm) {
                w.u16(idToU16(itm.id));
                w.u8(itm.x);
                w.u8(itm.y);
            });

            // exits
            var exits = room.exits || [];
            w.u8(exits.length & 0xFF);
            exits.forEach(function (ex) {
                w.u8(ex.x);  w.u8(ex.y);
                w.u16(idToU16(ex.dest.room));
                w.u8(ex.dest.x);  w.u8(ex.dest.y);
                w.u16(ex.dlg ? idToU16(ex.dlg) : 0xFFFF);
            });

            // endings
            var endings = room.endings || [];
            w.u8(endings.length & 0xFF);
            endings.forEach(function (en) {
                w.u8(en.x);  w.u8(en.y);
                w.u16(en.id ? idToU16(en.id) : 0xFFFF);
            });
        });

        return w.toArray();
    }

    /* -------------------------------------------------------
     * Dialog file builder (dlg.dat)
     * ----------------------------------------------------- */

    function buildDlgFile(world) {
        var w       = new ByteWriter();
        var entries = [];

        // Collect all dialogs (including title=0)
        Object.keys(world.dialog).forEach(function (did) {
            var dlg  = world.dialog[did];
            var text = extractPlainText(dlg.src);
            entries.push({ id: idToU16(did), text: text });
        });

        // Also collect item dialogs (by item id convention: item id → dialog id)
        // Items already have dlg field pointing to a dialog, which is already in world.dialog.
        // Nothing extra needed here.

        w.u16(entries.length);
        entries.forEach(function (e) {
            var bytes = [];
            for (var i = 0; i < e.text.length; i++)
                bytes.push(e.text.charCodeAt(i) & 0xFF);
            w.u16(e.id);
            w.u16(bytes.length);
            w.bytes(bytes);
        });

        return w.toArray();
    }

    /* -------------------------------------------------------
     * Variable file builder (var.dat)
     * ----------------------------------------------------- */

    function buildVarFile(world) {
        var w    = new ByteWriter();
        var vars = world.variable || {};
        var keys = Object.keys(vars);

        w.u16(keys.length);
        keys.forEach(function (name) {
            var val   = parseFloat(vars[name]) || 0;
            var ival  = Math.round(val) & 0xFFFF;
            var bytes = [];
            for (var i = 0; i < name.length && i < 255; i++)
                bytes.push(name.charCodeAt(i) & 0xFF);
            w.u8(bytes.length);
            w.bytes(bytes);
            w.i16(ival);
        });

        return w.toArray();
    }

    /* -------------------------------------------------------
     * Item inventory file builder (itminv.dat)
     * ----------------------------------------------------- */

    function buildItmInvFile(world) {
        var w       = new ByteWriter();
        var entries = [];

        // Each item can have a default count stored in the avatar's inventory
        var ava = world.sprite['A'];
        if (ava && ava.inventory) {
            Object.keys(ava.inventory).forEach(function (itemId) {
                entries.push({ id: idToU16(itemId), count: ava.inventory[itemId] || 0 });
            });
        }

        w.u16(entries.length);
        entries.forEach(function (e) {
            w.u16(e.id);
            w.i16(Math.round(e.count) & 0xFFFF);
        });

        return w.toArray();
    }

    /* -------------------------------------------------------
     * Embedded 8×8 1bpp font (ASCII 0x20–0x7E)
     * This is the Bitsy "ascii_small" font baked in.
     * We include a minimal built-in font so the ROM works even
     * when the resource font can't be loaded.
     * In practice the exporter embeds the actual font data.
     * ----------------------------------------------------- */

    function buildFontFile() {
        // Minimal 8×8 font: we use a tiny programmatic version.
        // 95 characters × 8 bytes = 760 bytes.
        // Each byte = one row, MSB = leftmost pixel.
        // This stub generates a simple box-like font.
        // The real Bitsy font would be extracted from fontManager.GetData().

        var CHAR_COUNT = 95; // 0x20..0x7E
        var glyphs = new Array(CHAR_COUNT);
        for (var i = 0; i < CHAR_COUNT; i++) glyphs[i] = new Uint8Array(8);

        // Space (0x20): all zeros — already initialised

        // '!' (0x21)
        glyphs[1]  = new Uint8Array([0x18,0x18,0x18,0x18,0x18,0x00,0x18,0x00]);
        // '"' (0x22)
        glyphs[2]  = new Uint8Array([0x6C,0x6C,0x24,0x00,0x00,0x00,0x00,0x00]);
        // '#' (0x23)
        glyphs[3]  = new Uint8Array([0x24,0x7E,0x24,0x24,0x7E,0x24,0x00,0x00]);
        // digits 0-9 (0x30..0x39)
        glyphs[0x10]=new Uint8Array([0x3C,0x66,0x6E,0x76,0x66,0x3C,0x00,0x00]); // 0
        glyphs[0x11]=new Uint8Array([0x18,0x38,0x18,0x18,0x18,0x7E,0x00,0x00]); // 1
        glyphs[0x12]=new Uint8Array([0x3C,0x66,0x06,0x1C,0x30,0x7E,0x00,0x00]); // 2
        glyphs[0x13]=new Uint8Array([0x3C,0x66,0x0C,0x06,0x66,0x3C,0x00,0x00]); // 3
        glyphs[0x14]=new Uint8Array([0x0C,0x1C,0x2C,0x7E,0x0C,0x0C,0x00,0x00]); // 4
        glyphs[0x15]=new Uint8Array([0x7E,0x60,0x7C,0x06,0x66,0x3C,0x00,0x00]); // 5
        glyphs[0x16]=new Uint8Array([0x3C,0x60,0x7C,0x66,0x66,0x3C,0x00,0x00]); // 6
        glyphs[0x17]=new Uint8Array([0x7E,0x06,0x0C,0x18,0x18,0x18,0x00,0x00]); // 7
        glyphs[0x18]=new Uint8Array([0x3C,0x66,0x3C,0x66,0x66,0x3C,0x00,0x00]); // 8
        glyphs[0x19]=new Uint8Array([0x3C,0x66,0x66,0x3E,0x06,0x3C,0x00,0x00]); // 9
        // uppercase A-Z (0x41..0x5A)
        var uppers = [
            [0x18,0x3C,0x66,0x7E,0x66,0x66,0x00,0x00], // A
            [0x7C,0x66,0x7C,0x66,0x66,0x7C,0x00,0x00], // B
            [0x3C,0x66,0x60,0x60,0x66,0x3C,0x00,0x00], // C
            [0x78,0x6C,0x66,0x66,0x6C,0x78,0x00,0x00], // D
            [0x7E,0x60,0x7C,0x60,0x60,0x7E,0x00,0x00], // E
            [0x7E,0x60,0x7C,0x60,0x60,0x60,0x00,0x00], // F
            [0x3C,0x66,0x60,0x6E,0x66,0x3C,0x00,0x00], // G
            [0x66,0x66,0x7E,0x66,0x66,0x66,0x00,0x00], // H
            [0x3C,0x18,0x18,0x18,0x18,0x3C,0x00,0x00], // I
            [0x06,0x06,0x06,0x66,0x66,0x3C,0x00,0x00], // J
            [0x66,0x6C,0x78,0x78,0x6C,0x66,0x00,0x00], // K
            [0x60,0x60,0x60,0x60,0x60,0x7E,0x00,0x00], // L
            [0x63,0x77,0x7F,0x6B,0x63,0x63,0x00,0x00], // M
            [0x66,0x76,0x7E,0x6E,0x66,0x66,0x00,0x00], // N
            [0x3C,0x66,0x66,0x66,0x66,0x3C,0x00,0x00], // O
            [0x7C,0x66,0x7C,0x60,0x60,0x60,0x00,0x00], // P
            [0x3C,0x66,0x66,0x6E,0x3C,0x06,0x00,0x00], // Q
            [0x7C,0x66,0x7C,0x6C,0x66,0x66,0x00,0x00], // R
            [0x3C,0x60,0x3C,0x06,0x66,0x3C,0x00,0x00], // S
            [0x7E,0x18,0x18,0x18,0x18,0x18,0x00,0x00], // T
            [0x66,0x66,0x66,0x66,0x66,0x3C,0x00,0x00], // U
            [0x66,0x66,0x66,0x66,0x3C,0x18,0x00,0x00], // V
            [0x63,0x63,0x6B,0x7F,0x77,0x63,0x00,0x00], // W
            [0x66,0x3C,0x18,0x3C,0x66,0x66,0x00,0x00], // X — fixed
            [0x66,0x66,0x3C,0x18,0x18,0x18,0x00,0x00], // Y
            [0x7E,0x06,0x0C,0x18,0x30,0x7E,0x00,0x00], // Z
        ];
        for (var ci = 0; ci < uppers.length; ci++)
            glyphs[0x41 - 0x20 + ci] = new Uint8Array(uppers[ci]);

        // lowercase a-z (0x61..0x7A) — derive from uppers for now
        var lowers = [
            [0x00,0x3C,0x06,0x3E,0x66,0x3E,0x00,0x00], // a
            [0x60,0x7C,0x66,0x66,0x66,0x7C,0x00,0x00], // b
            [0x00,0x3C,0x60,0x60,0x60,0x3C,0x00,0x00], // c
            [0x06,0x3E,0x66,0x66,0x66,0x3E,0x00,0x00], // d
            [0x00,0x3C,0x66,0x7E,0x60,0x3C,0x00,0x00], // e
            [0x0E,0x18,0x3E,0x18,0x18,0x18,0x00,0x00], // f
            [0x00,0x3E,0x66,0x3E,0x06,0x3C,0x00,0x00], // g
            [0x60,0x7C,0x66,0x66,0x66,0x66,0x00,0x00], // h
            [0x18,0x00,0x18,0x18,0x18,0x18,0x00,0x00], // i
            [0x06,0x00,0x06,0x06,0x66,0x3C,0x00,0x00], // j
            [0x60,0x66,0x6C,0x78,0x6C,0x66,0x00,0x00], // k
            [0x18,0x18,0x18,0x18,0x18,0x0C,0x00,0x00], // l
            [0x00,0x66,0x7F,0x6B,0x63,0x63,0x00,0x00], // m
            [0x00,0x7C,0x66,0x66,0x66,0x66,0x00,0x00], // n
            [0x00,0x3C,0x66,0x66,0x66,0x3C,0x00,0x00], // o
            [0x00,0x7C,0x66,0x7C,0x60,0x60,0x00,0x00], // p
            [0x00,0x3E,0x66,0x3E,0x06,0x06,0x00,0x00], // q
            [0x00,0x6C,0x76,0x60,0x60,0x60,0x00,0x00], // r
            [0x00,0x3C,0x60,0x3C,0x06,0x7C,0x00,0x00], // s
            [0x18,0x7E,0x18,0x18,0x18,0x0E,0x00,0x00], // t
            [0x00,0x66,0x66,0x66,0x66,0x3E,0x00,0x00], // u
            [0x00,0x66,0x66,0x66,0x3C,0x18,0x00,0x00], // v
            [0x00,0x63,0x6B,0x7F,0x77,0x63,0x00,0x00], // w
            [0x00,0x66,0x3C,0x18,0x3C,0x66,0x00,0x00], // x
            [0x00,0x66,0x66,0x3E,0x06,0x3C,0x00,0x00], // y
            [0x00,0x7E,0x0C,0x18,0x30,0x7E,0x00,0x00], // z
        ];
        for (var li = 0; li < lowers.length; li++)
            glyphs[0x61 - 0x20 + li] = new Uint8Array(lowers[li]);

        // Additional punctuation
        glyphs[0x2E - 0x20] = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x18,0x00,0x00]); // .
        glyphs[0x2C - 0x20] = new Uint8Array([0x00,0x00,0x00,0x00,0x18,0x18,0x30,0x00]); // ,
        glyphs[0x3A - 0x20] = new Uint8Array([0x00,0x18,0x00,0x00,0x18,0x00,0x00,0x00]); // :
        glyphs[0x3F - 0x20] = new Uint8Array([0x3C,0x66,0x0C,0x18,0x00,0x18,0x00,0x00]); // ?
        glyphs[0x27 - 0x20] = new Uint8Array([0x18,0x18,0x10,0x00,0x00,0x00,0x00,0x00]); // '
        glyphs[0x2D - 0x20] = new Uint8Array([0x00,0x00,0x7E,0x00,0x00,0x00,0x00,0x00]); // -
        glyphs[0x21 - 0x20] = new Uint8Array([0x18,0x18,0x18,0x18,0x00,0x18,0x00,0x00]); // !
        glyphs[0x3E - 0x20] = new Uint8Array([0x30,0x18,0x0C,0x0C,0x18,0x30,0x00,0x00]); // >

        var w = new ByteWriter();
        for (var gi = 0; gi < CHAR_COUNT; gi++)
            for (var bi = 0; bi < 8; bi++)
                w.u8(glyphs[gi][bi] || 0);

        return w.toArray();
    }

    /* -------------------------------------------------------
     * Resource filesystem assembler
     * ----------------------------------------------------- */

    var PAGE_SIZE     = 16 * 1024;
    var INITIAL_PAGE  = 2;
    var ENTRY_SIZE    = 16 + 2 + 2 + 2; // name + page + size + offset
    var MAGIC         = [0x62, 0x73, 0x79, 0x00]; // "bsy\0"

    function buildFilesystem(files) {
        // files: [ { name: string (≤15 chars), data: number[] } ]
        var fileCount = files.length;

        // Header size
        var hdrSize  = 4 + 2; // magic + count
        var dirSize  = fileCount * ENTRY_SIZE;
        var dirTotal = hdrSize + dirSize;

        // Allocate pages
        var pages    = [];
        var pageBufs = []; // page 0 = page index INITIAL_PAGE

        function getPage(pageIdx) {
            while (pageBufs.length <= pageIdx) {
                var p = new Array(PAGE_SIZE);
                for (var i = 0; i < PAGE_SIZE; i++) p[i] = 0;
                pageBufs.push(p);
            }
            return pageBufs[pageIdx];
        }

        // Write header + directory into page 0 of our buffer
        var curPageIdx = 0;
        var curOffset  = dirTotal; // file contents start after the directory

        // First pass: compute page/offset for each file
        var allocated = files.map(function (f) {
            var entry = { name: f.name, data: f.data, page: 0, offset: 0 };

            if (curOffset + f.data.length > PAGE_SIZE) {
                curPageIdx++;
                curOffset = 0;
            }

            entry.page   = INITIAL_PAGE + curPageIdx;
            entry.offset = curOffset;
            curOffset   += f.data.length;

            return entry;
        });

        // Second pass: write header + directory
        var dirBuf = getPage(0);
        var dp     = 0;

        // magic
        MAGIC.forEach(function (b) { dirBuf[dp++] = b; });
        // file_count uint16 LE
        dirBuf[dp++] = fileCount & 0xFF;
        dirBuf[dp++] = (fileCount >> 8) & 0xFF;

        allocated.forEach(function (e) {
            // name[16] null-padded
            for (var ni = 0; ni < 16; ni++)
                dirBuf[dp++] = ni < e.name.length ? (e.name.charCodeAt(ni) & 0xFF) : 0;
            // page uint16
            dirBuf[dp++] = e.page & 0xFF;
            dirBuf[dp++] = (e.page >> 8) & 0xFF;
            // size uint16
            dirBuf[dp++] = e.data.length & 0xFF;
            dirBuf[dp++] = (e.data.length >> 8) & 0xFF;
            // offset uint16
            dirBuf[dp++] = e.offset & 0xFF;
            dirBuf[dp++] = (e.offset >> 8) & 0xFF;
        });

        // Third pass: write file contents into pages
        allocated.forEach(function (e) {
            var pIdx = e.page - INITIAL_PAGE;
            var buf  = getPage(pIdx);
            for (var bi = 0; bi < e.data.length; bi++)
                buf[e.offset + bi] = e.data[bi] & 0xFF;
        });

        // Flatten all pages into one array
        var result = [];
        for (var pi = 0; pi < pageBufs.length; pi++)
            Array.prototype.push.apply(result, pageBufs[pi]);

        return result;
    }

    /* -------------------------------------------------------
     * Main entry point: build the full resource blob
     * ----------------------------------------------------- */

    function buildResourceBlob(world) {
        // Build tile index map: string tile id → uint8 sequential index (1-based)
        var tileIndexMap = {};
        var tileIdx = 1;
        Object.keys(world.tile).forEach(function (tid) {
            tileIndexMap[tid] = tileIdx++;
        });

        // Build palette index map: string palette id → uint8 index
        var palIdxMap = {};
        var palIdx    = 0;
        Object.keys(world.palette).forEach(function (pid) {
            palIdxMap[pid] = palIdx++;
        });

        // Build graphics entry lists
        var tileEntries = Object.keys(world.tile).map(function (tid) {
            return { id: tid, drwId: 'TIL_' + tid };
        });

        // Sprites: avatar first (id='A' → numeric 0xFFFE, but stored as first entry)
        var sprEntries = [];
        if (world.sprite['A']) sprEntries.push({ id: 'A', drwId: 'SPR_A' });
        Object.keys(world.sprite).forEach(function (sid) {
            if (sid !== 'A') sprEntries.push({ id: sid, drwId: 'SPR_' + sid });
        });

        var itmEntries = Object.keys(world.item).map(function (iid) {
            return { id: iid, drwId: 'ITM_' + iid };
        });

        // Retrieve game title
        var titleDlg  = world.dialog && world.dialog['title'];
        var titleText = titleDlg ? extractPlainText(titleDlg.src) : 'Bitsy Game';
        // Use first line only
        titleText = titleText.split('\n')[0].trim() || 'Bitsy Game';

        // Build all files
        var files = [
            { name: 'game.inf',   data: (function(){ var w=new ByteWriter(); w.str0(titleText); return w.toArray(); })() },
            { name: 'font.dat',   data: buildFontFile() },
            { name: 'pal.dat',    data: buildPalFile(world) },
            { name: 'til.dat',    data: buildGfxFile(tileEntries, world, 'TIL_') },
            { name: 'spr.dat',    data: buildGfxFile(sprEntries,  world, 'SPR_') },
            { name: 'itm.dat',    data: buildGfxFile(itmEntries,  world, 'ITM_') },
            { name: 'room.dat',   data: buildRoomFileV2(world, tileIndexMap, palIdxMap) },
            { name: 'dlg.dat',    data: buildDlgFile(world) },
            { name: 'var.dat',    data: buildVarFile(world) },
            { name: 'itminv.dat', data: buildItmInvFile(world) },
        ];

        return buildFilesystem(files);
    }

    /* -------------------------------------------------------
     * Base ROM loading
     * We try to load a prebuilt 'bitsy_sms.sms' from the same
     * directory as the editor. If it fails, we warn the user.
     * ----------------------------------------------------- */

    function fetchBaseRom() {
        return fetch('sms-base-rom/bitsy_sms.sms', { method: 'GET' })
            .then(function (r) {
                if (!r.ok) throw new Error('Base ROM not found at sms-base-rom/bitsy_sms.sms');
                return r.arrayBuffer();
            });
    }

    /* -------------------------------------------------------
     * Download helper
     * ----------------------------------------------------- */

    function downloadBlob(filename, blob) {
        var a   = document.createElement('a');
        var url = URL.createObjectURL(blob);
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }

    /* -------------------------------------------------------
     * Public API
     * ----------------------------------------------------- */

    return {
        /**
         * Build and download a Sega Master System ROM for the given world.
         * @param {Object} world      The Bitsy world object from parseWorld().
         * @param {string} gameTitle  Filename stem (without extension).
         */
        exportRom: function (world, gameTitle) {
            var resourceData;
            try {
                resourceData = buildResourceBlob(world);
            } catch (e) {
                alert('SMS export error (resource build):\n' + e.message);
                console.error('SMS export error', e);
                return;
            }

            fetchBaseRom()
                .then(function (baseRomBuffer) {
                    var baseRom  = new Uint8Array(baseRomBuffer);
                    var resource = new Uint8Array(resourceData);
                    var rom      = new Uint8Array(baseRom.length + resource.length);
                    rom.set(baseRom);
                    rom.set(resource, baseRom.length);

                    var blob = new Blob([rom], { type: 'application/octet-stream' });
                    downloadBlob((gameTitle || 'game') + '.sms', blob);
                })
                .catch(function (e) {
                    // Base ROM not available — download resource blob only so the
                    // user can concatenate manually.
                    console.warn('SMS base ROM unavailable, downloading resource blob only:', e);
                    alert(
                        'The prebuilt SMS base ROM (sms-base-rom/bitsy_sms.sms) was not found.\n' +
                        'Downloading the resource blob instead.\n' +
                        'Concatenate it with the compiled base ROM to produce a playable .sms file.'
                    );
                    var blob = new Blob(
                        [new Uint8Array(resourceData)],
                        { type: 'application/octet-stream' }
                    );
                    downloadBlob((gameTitle || 'game') + '.sms.resource', blob);
                });
        },

        // Exposed for testing / inspection
        buildResourceBlob: buildResourceBlob,
        extractPlainText:  extractPlainText,
        idToU16:           idToU16,
    };

})();
