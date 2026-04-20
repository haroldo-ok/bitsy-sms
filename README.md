# Bitsy SMS

A modified Bitsy game editor that generates real **Sega Master System ROMs** (.sms files).

Draw tiles, sprites, and dialog in the Bitsy editor, then export your game as a `.sms` file you can load in any SMS emulator or on real hardware via an Everdrive.

---

## Project structure

```
bitsy-sms/
├── index.html              Main entry point
├── css/
│   └── style.css           Dark retro UI theme
├── js/
│   ├── bitsy-engine.js     Bitsy classic v0 engine (parse, render, play)
│   ├── bitsy-editor.js     Editor UI (map, paint, colors, rooms)
│   ├── sms-codegen.js      Bitsy world → CVBasic source code generator
│   └── sms-compiler.js     iframe pipeline + window.compiler + ROM download
└── compiler/
    ├── cvbasic-iframe.html CVBasic Emscripten iframe entry point
    ├── cvbasic.js          CVBasic compiler compiled to WebAssembly (~4.4 MB)
    ├── gasm80-iframe.html  gasm80 Emscripten iframe entry point
    └── gasm80.js           gasm80 Z80 assembler compiled to WebAssembly (~746 KB)
```

---

## How to run

The compiler iframes must be served over HTTP (not `file://`):

```bash
cd bitsy-sms
python3 -m http.server
# open http://localhost:8000/
```

Any static file server works (Node `serve`, nginx, Apache, Caddy, etc.).

---

## How to make a game

| Panel | What to do |
|-------|------------|
| **map** | Edit mode: click to place/erase the selected tile or move a sprite. Play mode: arrow keys to walk. |
| **paint** | Draw 8×8 pixel art for the avatar (player), tiles (scenery), and sprites (NPCs). |
| **colors** | Pick 3 colors — background, tile, sprite. Converted automatically to the SMS 2-bit/channel palette. |
| **title** | Your game's title, also used as the ROM filename. |
| **game data** | Raw Bitsy text format — edit directly if you want. |

**Wall tiles:** select a tile in paint mode, check the "wall?" box — the player can't walk through it.

**Dialog:** select a sprite in paint mode, type dialog text (≤ 38 chars). Walk into the sprite to trigger it.

**Room exits:** add an `EXT` line in the game data textarea inside a `SET` block:
```
SET 0
0000000000000000
...
EXT 15,8 1 0,8
```
This teleports the player from tile (15,8) in room 0 to tile (0,8) in room 1.

**Multiple rooms:** click "+ room" in the map panel, then connect with `EXT`.

---

## Exporting to SMS ROM

**Step 1 — Generate .bas**
Converts the current game into a CVBasic BASIC program targeting SMS Mode 4.
The source is displayed in the preview panel.

**Step 2 — Compile → .asm**
Loads `compiler/cvbasic-iframe.html` in a hidden iframe (Emscripten/WASM).
Writes the `.bas` to the virtual FS, calls `Module.callMain([..., "-sms", ...])`,
reads back the Z80 assembly.

**Step 3 — Assemble → .sms ROM**
Loads `compiler/gasm80-iframe.html` in a hidden iframe.
Assembles to binary, pads to power-of-2 ROM size, injects the SEGA ROM header
at `0x7FF0`, and downloads the `.sms` file.

---

## Playing the ROM

- **[Emulicious](https://emulicious.net/)** — recommended, most accurate
- **[MEKA](https://www.smspower.org/meka/)** — classic SMS emulator
- **Fusion / Gens** — widely available
- Real hardware via a [Krikzz Everdrive](https://krikzz.com/)

---

## SMS hardware constraints

| Feature | Limit |
|---------|-------|
| Screen | 256×192 pixels, Mode 4 |
| Room display | 16×16 tiles = 128×128 px, centred on screen |
| Tile size | 8×8 pixels |
| Colors | 3 (bg / tile / sprite), mapped to SMS 2-bit/channel palette (64 total) |
| Tiles | ~20 recommended |
| Sprites | Player + up to 8 NPCs |
| Rooms | Up to ~8 |
| Dialog | 38 characters per NPC, one page, dismiss with any button |

---

## Credits

- **[CVBasic](https://github.com/nanochess/CVBasic)** by Oscar Toledo G.
- **[CVBasic-emscripten](https://github.com/haroldo-ok/CVBasic-emscripten)** by haroldo-ok
- **[Bitsy](https://bitsy.org)** original editor by Adam LeDoux (MIT)
