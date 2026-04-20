# Bitsy SMS

A modified Bitsy game editor that generates and plays **Sega Master System ROMs**.

Draw tiles, sprites, and dialog in the Bitsy editor, then export your game as a real `.sms` ROM file you can load in any SMS emulator.

---

## Project structure

```
bitsy-sms/
├── index.html          Main entry point
├── css/
│   └── style.css       Dark retro UI theme
├── js/
│   ├── bitsy-engine.js Bitsy classic v0 engine (parse, render, play)
│   ├── bitsy-editor.js Editor UI (map, paint, colors, rooms)
│   ├── sms-codegen.js  Bitsy world → CVBasic source code generator
│   └── sms-compiler.js CVBasic + gasm80 iframe pipeline + ROM download
└── README.md
```

---

## How to use

### Serving the project

The compiler steps load external tools via iframes from GitHub Pages, so the
project **must be served over HTTP** — not opened as a `file://` URL.

```bash
cd bitsy-sms
python3 -m http.server
# then open http://localhost:8000/ in your browser
```

Any static file server works (Node `serve`, nginx, Apache, etc.).

### Making your game

| Panel | What to do |
|-------|------------|
| **map** | Edit mode: click to place/erase the selected tile. Play mode: arrow keys to walk. |
| **paint** | Draw 8×8 pixel art for the avatar (player), tiles (scenery), and sprites (NPCs). |
| **colors** | Pick 3 colors — background, tile, sprite. Automatically converted to SMS palette. |
| **title** | Your game's title (also used as the ROM filename). |
| **game data** | Raw Bitsy text format — edit directly if you know what you're doing. |

**Wall tiles:** select a tile in paint mode, then check the "wall?" box to make it impassable.

**Dialog:** select a sprite in paint mode, then type dialog text (≤ 38 chars). Player walks into sprite to trigger it.

**Room exits:** add an `EXT x,y destRoom dx,dy` line inside a `SET` block in the game data textarea. E.g.:
```
SET 0
0000000000000000
...
EXT 15,8 1 0,8
```

**Multiple rooms:** click "+ room" in the map panel, then use `EXT` to connect them.

### Exporting to SMS ROM

The export panel has three steps:

**Step 1 — Generate .bas**
Converts the current game into a CVBasic BASIC program targeting SMS Mode 4.
The source is shown in the preview panel and can be downloaded.

**Step 2 — Compile → .asm**
Sends the `.bas` source to [CVBasic-emscripten](https://github.com/haroldo-ok/CVBasic-emscripten)
running in a hidden iframe (compiled to WebAssembly via Emscripten).
Produces Z80 assembly.

**Step 3 — Assemble → .sms ROM**
Sends the `.asm` to gasm80 in a hidden iframe.
The binary is padded to a power-of-2 size, the SEGA ROM header is injected at `0x7FF0`,
and the `.sms` file is downloaded.

### Playing the ROM

Load the `.sms` file in any Sega Master System emulator:

- **[Emulicious](https://emulicious.net/)** — recommended, very accurate
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
| Colors | 3 (background + tile + sprite), mapped to 2-bit/channel SMS palette (64 total) |
| Tiles | ~20 recommended (SMS has 448 VRAM slots) |
| Sprites | Player + up to 8 NPCs (SMS hardware limit: 64 sprites, 8 per scanline) |
| Rooms | Up to ~8 (limited by DATA BYTE ROM space in a 32 KB ROM) |
| Dialog | 38 characters per NPC, one page, dismiss with any button |

---

## Dependencies

- **[CVBasic](https://github.com/nanochess/CVBasic)** by Oscar Toledo G. — BASIC compiler targeting Z80 systems including SMS. The in-browser version is [CVBasic-emscripten](https://github.com/haroldo-ok/CVBasic-emscripten) by haroldo-ok.
- **gasm80** — Z80 assembler, bundled with CVBasic-emscripten.
- **Bitsy** — original game editor by Adam LeDoux. This project uses the classic v0 engine as a base.

---

## License

Bitsy engine: MIT (Adam LeDoux)  
CVBasic: see https://github.com/nanochess/CVBasic  
This project's code: MIT
