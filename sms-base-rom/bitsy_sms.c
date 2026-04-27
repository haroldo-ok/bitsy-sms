/*
 * bitsy_sms.c  —  Bitsy game engine for the Sega Master System
 *
 * Toolchain : devkitSMS / SDCC  (sdcc -mz80)
 * Build     : see Makefile
 *
 * Resource blob is appended after the base ROM binary.
 * Layout: "bsy\0" header + directory + 16KB pages (starting at bank 2).
 *
 * Files in the blob:
 *   game.inf   — null-terminated game title
 *   font.dat   — 95 glyphs x 8 bytes (1bpp, 8x8, ASCII 0x20-0x7E)
 *   pal.dat    — uint16 count, then per palette: 3x{r,g,b,pad}
 *   til.dat    — tile graphics (see gfx format below)
 *   spr.dat    — sprite/avatar graphics (same format)
 *   itm.dat    — item graphics (same format)
 *   room.dat   — room records (see room format below)
 *   dlg.dat    — dialog strings
 *   var.dat    — variables
 *   itminv.dat — item inventory defaults
 *
 * Gfx format (til/spr/itm .dat):
 *   uint16 tile_count
 *   per tile:
 *     uint16  id
 *     uint8   frame_count   (1 or 2)
 *     uint8   flags         (bit0 = isWall, tiles only)
 *     uint8[64] pixels_f0   (8x8 bitmap, 0=bg 1=fg)
 *     uint8[64] pixels_f1   (only if frame_count==2)
 *
 * Room format (room.dat):
 *   uint16 room_count
 *   per room:
 *     uint16  id
 *     uint8   pal_idx
 *     uint8[256] tilemap  (16x16, tile sequential index, 0=empty)
 *     uint8   wall_count
 *     uint8[] wall_indices
 *     uint8   sprite_count  (includes avatar sentinel if avatar is here)
 *     per sprite: uint16 id, uint8 x, uint8 y, uint16 dlg_id
 *       (id == 0xFFFE is the avatar start-position sentinel, no dialog)
 *     uint8   item_count
 *     per item:   uint16 id, uint8 x, uint8 y
 *     uint8   exit_count
 *     per exit:   uint8 sx, sy; uint16 dest_room; uint8 dx, dy; uint16 dlg_id
 *     uint8   ending_count
 *     per ending: uint8 x, y; uint16 dlg_id
 */

#include <stdlib.h>
#include <string.h>
#include "SMSlib.h"

/* =========================================================
 * Constants
 * ========================================================= */

#define ROM_RESOURCE_BANK  2
#define ROM_RESOURCE_ADDR  0x8000

#define MAP_W   16
#define MAP_H   16
#define TILE_PX  8

/* VDP tile slot assignments (must not overlap) */
#define VDPTILE_BLANK    0   /* all-zero tile */
#define VDPTILE_SOLID    1   /* solid-colour tile for dialog box bg */
#define VDPTILE_TILESET  2   /* bg tiles start here; max 64*2=128 slots -> ends at 129 */
#define VDPTILE_SPRITES  130 /* NPC/avatar sprites; max 16*2=32 -> ends at 161 */
#define VDPTILE_ITEMS    162 /* item sprites; max 16*2=32 -> ends at 193 */
#define VDPTILE_FONT     194 /* font: 95 glyphs -> ends at 288 */

/* Screen geometry (in 8px tiles) */
#define SCREEN_TILE_W  32
#define SCREEN_TILE_H  24
/* Centre 16x16 map on 32x24 BG plane */
#define MAP_ORIGIN_X    8
#define MAP_ORIGIN_Y    4

/* Dialog box */
#define DBOX_X   1
#define DBOX_Y  18
#define DBOX_W  30
#define DBOX_H   5
#define DBOX_CPR 27   /* chars per row */
#define DBOX_ROWS 3   /* text rows */

#define NO_ID        0xFFFF
#define AVA_SENTINEL 0xFFFE   /* avatar start marker in room sprite list */

/* Animation period in vblanks (~400ms at 60Hz) */
#define ANIM_PERIOD  24

/* =========================================================
 * Resource filesystem
 * ========================================================= */

typedef struct {
    char         sig[4];
    unsigned int file_count;
} ResHeader;

typedef struct {
    char         name[16];
    unsigned int page;
    unsigned int size;
    unsigned int offset;
} ResEntry;

static const ResHeader *res_hdr;
static const ResEntry  *res_entries;

static void res_init(void) {
    SMS_mapROMBank(ROM_RESOURCE_BANK);
    res_hdr     = (const ResHeader *)ROM_RESOURCE_ADDR;
    res_entries = (const ResEntry  *)(ROM_RESOURCE_ADDR + sizeof(ResHeader));
}

static const ResEntry *res_find(const char *name) {
    unsigned int n;
    const ResEntry *e;
    SMS_mapROMBank(ROM_RESOURCE_BANK);
    n = res_hdr->file_count;
    e = res_entries;
    while (n--) {
        if (strcmp(name, e->name) == 0) return e;
        e++;
    }
    return 0;
}

static const unsigned char *res_ptr(const ResEntry *e) {
    if (!e) return 0;
    SMS_mapROMBank((unsigned char)e->page);
    return (const unsigned char *)(ROM_RESOURCE_ADDR + e->offset);
}

static const unsigned char *res_get(const char *name) {
    return res_ptr(res_find(name));
}

/* =========================================================
 * Binary utilities
 * ========================================================= */

static unsigned int read_u16(const unsigned char **p) {
    unsigned int v = (unsigned int)(*p)[0] | ((unsigned int)(*p)[1] << 8);
    (*p) += 2;
    return v;
}

/* =========================================================
 * VDP helpers
 * ========================================================= */

static void upload_tile(const unsigned char *pixels,
                        unsigned char col0, unsigned char col1,
                        unsigned int vdp_tile)
{
    unsigned char row, col, p0, p1, p2, p3;
    SMS_setAddr(TILEtoADDR(vdp_tile));
    for (row = 0; row < 8; row++) {
        p0 = p1 = p2 = p3 = 0;
        for (col = 0; col < 8; col++) {
            unsigned char bit  = 0x80 >> col;
            unsigned char cidx = pixels[row * 8 + col] ? col1 : col0;
            if (cidx & 1) p0 |= bit;
            if (cidx & 2) p1 |= bit;
            if (cidx & 4) p2 |= bit;
            if (cidx & 8) p3 |= bit;
        }
        SMS_setTile(((unsigned int)p1 << 8) | p0);
        SMS_setTile(((unsigned int)p3 << 8) | p2);
    }
}

static void put_bg_tile(unsigned char x, unsigned char y, unsigned int attr) {
    SMS_setNextTileatXY(x, y);
    SMS_setTile(attr);
}

/* =========================================================
 * Font
 * ========================================================= */

static void font_upload(const unsigned char *data, unsigned char fg, unsigned char bg) {
    unsigned char c;
    for (c = 0; c < 95; c++) {
        const unsigned char *glyph = data + c * 8;
        unsigned char row, col, p0, p1, p2, p3;
        SMS_setAddr(TILEtoADDR(VDPTILE_FONT + c));
        for (row = 0; row < 8; row++) {
            unsigned char byte = glyph[row];
            p0 = p1 = p2 = p3 = 0;
            for (col = 0; col < 8; col++) {
                unsigned char bit  = 0x80 >> col;
                unsigned char cidx = (byte >> (7 - col)) & 1 ? fg : bg;
                if (cidx & 1) p0 |= bit;
                if (cidx & 2) p1 |= bit;
                if (cidx & 4) p2 |= bit;
                if (cidx & 8) p3 |= bit;
            }
            SMS_setTile(((unsigned int)p1 << 8) | p0);
            SMS_setTile(((unsigned int)p3 << 8) | p2);
        }
    }
}

static void put_char(unsigned char tx, unsigned char ty, char ch) {
    unsigned int tile;
    if ((unsigned char)ch < 0x20 || (unsigned char)ch > 0x7E) ch = ' ';
    tile = VDPTILE_FONT + ((unsigned char)ch - 0x20);
    put_bg_tile(tx, ty, (unsigned int)(tile << 2));
}

static void put_str(unsigned char tx, unsigned char ty, const char *s) {
    while (*s) put_char(tx++, ty, *s++);
}

/* =========================================================
 * Data structures
 * ========================================================= */

#define MAX_PALS         16
#define MAX_TILES        64
#define MAX_SPRITES      16
#define MAX_ITEMS        16
#define MAX_VARS         32
#define MAX_ROOM_SPRITES  8
#define MAX_ROOM_ITEMS   16
#define MAX_EXITS        16
#define MAX_ENDINGS       8
#define MAX_WALLS        16

typedef struct { unsigned char bg, tile, sprite; } Palette;

typedef struct {
    unsigned int  id;
    unsigned char x, y;
    unsigned int  dlg_id;
} RoomSprite;

typedef struct {
    unsigned int  id;
    unsigned char x, y;
} RoomItem;

typedef struct {
    unsigned char src_x, src_y;
    unsigned int  dest_room;
    unsigned char dest_x, dest_y;
    unsigned int  dlg_id;
} Exit;

typedef struct {
    unsigned char x, y;
    unsigned int  dlg_id;
} Ending;

typedef struct {
    unsigned int  id;
    unsigned char pal_idx;
    unsigned char tilemap[MAP_H][MAP_W];   /* sequential tile index, 0=empty */
    unsigned char wall_count;
    unsigned char walls[MAX_WALLS];
    unsigned char sprite_count;
    RoomSprite    sprites[MAX_ROOM_SPRITES];
    unsigned char item_count;
    RoomItem      items[MAX_ROOM_ITEMS];
    unsigned char exit_count;
    Exit          exits[MAX_EXITS];
    unsigned char ending_count;
    Ending        endings[MAX_ENDINGS];
} Room;

typedef struct { char name[16]; int value; } Variable;

/* =========================================================
 * Game state  (all in 0xC000..0xDFFF RAM)
 * ========================================================= */

static unsigned char  num_palettes;
static Palette        palettes[MAX_PALS];

static unsigned int   num_tiles, num_sprites, num_items;
static unsigned int   tile_vdp[MAX_TILES],  tile_vdp2[MAX_TILES];
static unsigned int   spr_vdp[MAX_SPRITES], spr_vdp2[MAX_SPRITES];
static unsigned int   itm_vdp[MAX_ITEMS],   itm_vdp2[MAX_ITEMS];
static unsigned int   tile_ids[MAX_TILES];
static unsigned int   spr_ids[MAX_SPRITES];
static unsigned int   itm_ids[MAX_ITEMS];
static unsigned char  tile_is_wall[MAX_TILES];  /* from gfx flags */

static unsigned char  anim_frame;
static unsigned char  anim_counter;

static Room           cur_room;

static unsigned char  player_x, player_y;
static unsigned int   player_room;
static unsigned int   avatar_spr_id;

static int            item_counts[MAX_ITEMS];

static unsigned char  num_vars;
static Variable       vars[MAX_VARS];

/* Dialog */
static char           dlg_text[256];
static unsigned char  dlg_active;
static unsigned char  dlg_page;
static unsigned char  dlg_done;

/* Deferred exit (queued while dialog is open) */
static unsigned char  pending_exit;
static unsigned int   pending_room;
static unsigned char  pending_x, pending_y;

static unsigned char  game_over;

/* Input */
static unsigned int   prev_joy;
static unsigned char  joy_repeat;
#define JOY_REPEAT_INITIAL 12
#define JOY_REPEAT_CONT     4

/* =========================================================
 * Palette
 * ========================================================= */

static void load_palettes(void) {
    const unsigned char *p = res_get("pal.dat");
    unsigned char i;
    if (!p) { num_palettes = 1; return; }
    num_palettes = (unsigned char)read_u16(&p);
    if (num_palettes > MAX_PALS) num_palettes = MAX_PALS;
    for (i = 0; i < num_palettes; i++) {
        palettes[i].bg     = (p[0]>>6)|((p[1]>>6)<<2)|((p[2]>>6)<<4); p+=4;
        palettes[i].tile   = (p[0]>>6)|((p[1]>>6)<<2)|((p[2]>>6)<<4); p+=4;
        palettes[i].sprite = (p[0]>>6)|((p[1]>>6)<<2)|((p[2]>>6)<<4); p+=4;
    }
}

static void apply_palette(unsigned char idx) {
    unsigned char bg, tile, sprite;
    if (idx >= num_palettes) idx = 0;
    bg     = palettes[idx].bg;
    tile   = palettes[idx].tile;
    sprite = palettes[idx].sprite;
    SMS_setBGPaletteColor(0, bg);
    SMS_setBGPaletteColor(1, tile);
    SMS_setBGPaletteColor(2, sprite);
    SMS_setBGPaletteColor(3, 0x3F);
    SMS_setSpritePaletteColor(0, bg);
    SMS_setSpritePaletteColor(1, sprite);
    SMS_setSpritePaletteColor(2, sprite);
    SMS_setSpritePaletteColor(3, 0x3F);
}

/* =========================================================
 * Graphics loading
 * ========================================================= */

static void load_gfx(const char *filename,
                     unsigned int  *ids,
                     unsigned int  *vdp0, unsigned int  *vdp1,
                     unsigned char *wall_flags,
                     unsigned int  *count,
                     unsigned int   vdp_base,
                     unsigned char  col0, unsigned char col1)
{
    const unsigned char *p = res_get(filename);
    unsigned int n, i, slot;
    if (!p) { *count = 0; return; }
    n = read_u16(&p);
    if (n > MAX_TILES) n = MAX_TILES;
    *count = n;
    slot = vdp_base;
    for (i = 0; i < n; i++) {
        unsigned char fc = 0, fl = 0;
        ids[i] = read_u16(&p);
        fc = *p++;
        fl = *p++;
        if (wall_flags) wall_flags[i] = fl & 1;
        vdp0[i] = slot;
        upload_tile(p, col0, col1, slot++); p += 64;
        if (fc >= 2) {
            vdp1[i] = slot;
            upload_tile(p, col0, col1, slot++); p += 64;
        } else {
            vdp1[i] = vdp0[i];
        }
    }
}

/* Tilemap cells store 1-based sequential indices (0 = empty).
   Return the VDP tile number for a given sequential index. */
static unsigned int tile_vdp_for(unsigned char seq) {
    unsigned char i;
    if (seq == 0) return VDPTILE_BLANK;
    i = seq - 1;
    if (i >= num_tiles) return VDPTILE_BLANK;
    return anim_frame ? tile_vdp2[i] : tile_vdp[i];
}

static unsigned int spr_vdp_for(unsigned int id) {
    unsigned int i;
    for (i = 0; i < num_sprites; i++)
        if (spr_ids[i] == id) return anim_frame ? spr_vdp2[i] : spr_vdp[i];
    return VDPTILE_BLANK;
}

static unsigned int itm_vdp_for(unsigned int id) {
    unsigned int i;
    for (i = 0; i < num_items; i++)
        if (itm_ids[i] == id) return anim_frame ? itm_vdp2[i] : itm_vdp[i];
    return VDPTILE_BLANK;
}

/* =========================================================
 * Room loading
 * ========================================================= */

static void load_room(unsigned int target_id) {
    const unsigned char *p = res_get("room.dat");
    unsigned int n, r, i;
    if (!p) return;
    n = read_u16(&p);
    for (r = 0; r < n; r++) {
        unsigned int  rid = read_u16(&p);
        unsigned char pal = *p++;
        unsigned char w, s, itm, ex, en;

        /* tilemap */
        for (i = 0; i < MAP_H * MAP_W; i++)
            ((unsigned char *)cur_room.tilemap)[i] = *p++;

        /* walls */
        w = *p++;
        for (i = 0; i < w && i < MAX_WALLS; i++) cur_room.walls[i] = *p++;

        /* sprites (+ optional avatar sentinel) */
        s = *p++;
        cur_room.sprite_count = 0;
        player_x = 0; player_y = 0; /* default if no sentinel found */
        for (i = 0; i < s; i++) {
            unsigned int  sid = read_u16(&p);
            unsigned char sx  = *p++;
            unsigned char sy  = *p++;
            unsigned int  dlg = read_u16(&p);
            if (sid == AVA_SENTINEL) {
                player_x = sx; player_y = sy;
            } else if (rid == target_id &&
                       cur_room.sprite_count < MAX_ROOM_SPRITES) {
                unsigned char sc = cur_room.sprite_count++;
                cur_room.sprites[sc].id     = sid;
                cur_room.sprites[sc].x      = sx;
                cur_room.sprites[sc].y      = sy;
                cur_room.sprites[sc].dlg_id = dlg;
            }
        }

        /* items */
        itm = *p++;
        if (rid == target_id)
            cur_room.item_count = itm < MAX_ROOM_ITEMS ? itm : MAX_ROOM_ITEMS;
        for (i = 0; i < itm; i++) {
            unsigned int  iid = read_u16(&p);
            unsigned char ix  = *p++;
            unsigned char iy  = *p++;
            if (rid == target_id && i < MAX_ROOM_ITEMS) {
                cur_room.items[i].id = iid;
                cur_room.items[i].x  = ix;
                cur_room.items[i].y  = iy;
            }
        }

        /* exits */
        ex = *p++;
        if (rid == target_id)
            cur_room.exit_count = ex < MAX_EXITS ? ex : MAX_EXITS;
        for (i = 0; i < ex; i++) {
            unsigned char esx = *p++, esy = *p++;
            unsigned int  edr = read_u16(&p);
            unsigned char edx = *p++, edy = *p++;
            unsigned int  edl = read_u16(&p);
            if (rid == target_id && i < MAX_EXITS) {
                cur_room.exits[i].src_x     = esx;
                cur_room.exits[i].src_y     = esy;
                cur_room.exits[i].dest_room = edr;
                cur_room.exits[i].dest_x    = edx;
                cur_room.exits[i].dest_y    = edy;
                cur_room.exits[i].dlg_id    = edl;
            }
        }

        /* endings */
        en = *p++;
        if (rid == target_id)
            cur_room.ending_count = en < MAX_ENDINGS ? en : MAX_ENDINGS;
        for (i = 0; i < en; i++) {
            unsigned char enx = *p++, eny = *p++;
            unsigned int  enl = read_u16(&p);
            if (rid == target_id && i < MAX_ENDINGS) {
                cur_room.endings[i].x      = enx;
                cur_room.endings[i].y      = eny;
                cur_room.endings[i].dlg_id = enl;
            }
        }

        if (rid == target_id) {
            cur_room.id        = rid;
            cur_room.pal_idx   = pal;
            cur_room.wall_count = w < MAX_WALLS ? w : MAX_WALLS;
            return;
        }
    }
}

/* =========================================================
 * Dialog
 * ========================================================= */

static unsigned char load_dialog_text(unsigned int dlg_id) {
    const unsigned char *p = res_get("dlg.dat");
    unsigned int n, i;
    if (!p) return 0;
    n = read_u16(&p);
    for (i = 0; i < n; i++) {
        unsigned int id  = read_u16(&p);
        unsigned int len = read_u16(&p);
        if (id == dlg_id) {
            unsigned int cp = len < 255 ? len : 255;
            memcpy(dlg_text, p, cp);
            dlg_text[cp] = '\0';
            return 1;
        }
        p += len;
    }
    return 0;
}

static void dlg_draw_box(void) {
    unsigned char x, y;
    for (y = DBOX_Y; y < DBOX_Y + DBOX_H; y++)
        for (x = DBOX_X; x < DBOX_X + DBOX_W; x++)
            put_bg_tile(x, y, (unsigned int)(VDPTILE_SOLID << 2));
}

static void dlg_clear_box(void) {
    unsigned char x, y;
    for (y = DBOX_Y; y < DBOX_Y + DBOX_H; y++)
        for (x = DBOX_X; x < DBOX_X + DBOX_W; x++)
            put_bg_tile(x, y, (unsigned int)(VDPTILE_BLANK << 2));
}

static void dlg_show_page(void) {
    unsigned int  page_size = DBOX_ROWS * DBOX_CPR;
    unsigned int  pos       = (unsigned int)dlg_page * page_size;
    unsigned int  len       = strlen(dlg_text);
    unsigned char row = 0, col = 0;

    dlg_draw_box();

    while (pos < len && row < DBOX_ROWS) {
        char ch = dlg_text[pos++];
        if (ch == '\n') { row++; col = 0; continue; }
        put_char(DBOX_X + 1 + col, DBOX_Y + 1 + row, ch);
        if (++col >= DBOX_CPR) { col = 0; row++; }
    }

    dlg_done = (pos >= len);
    if (!dlg_done)
        put_char(DBOX_X + DBOX_W - 2, DBOX_Y + DBOX_H - 2, '>');
}

static void dlg_start(unsigned int dlg_id) {
    if (dlg_id == NO_ID) return;
    if (!load_dialog_text(dlg_id)) return;
    dlg_active = 1;
    dlg_page   = 0;
    dlg_done   = 0;
    dlg_show_page();
}

static void dlg_advance(void) {
    if (!dlg_active) return;
    if (dlg_done) {
        dlg_active = 0;
        /* Execute deferred exit if one is waiting */
        if (pending_exit) {
            pending_exit = 0;
            load_room(pending_room);
            player_room = pending_room;
            player_x    = pending_x;
            player_y    = pending_y;
            apply_palette(cur_room.pal_idx);
        }
        /* Redraw room to erase dialog box */
        {
            unsigned char x, y, i;
            for (y = 0; y < MAP_H; y++)
                for (x = 0; x < MAP_W; x++) {
                    unsigned char tid = cur_room.tilemap[y][x];
                    put_bg_tile(MAP_ORIGIN_X + x, MAP_ORIGIN_Y + y,
                        (unsigned int)((tid ? tile_vdp_for(tid) : VDPTILE_BLANK) << 2));
                }
            for (i = 0; i < cur_room.item_count; i++) {
                RoomItem *it = &cur_room.items[i];
                put_bg_tile(MAP_ORIGIN_X + it->x, MAP_ORIGIN_Y + it->y,
                    (unsigned int)(itm_vdp_for(it->id) << 2));
            }
        }
        dlg_clear_box();
    } else {
        dlg_page++;
        dlg_show_page();
    }
}

/* =========================================================
 * Map / sprite rendering
 * ========================================================= */

static void draw_room(void) {
    unsigned char x, y, i;
    apply_palette(cur_room.pal_idx);
    for (y = 0; y < MAP_H; y++)
        for (x = 0; x < MAP_W; x++) {
            unsigned char tid = cur_room.tilemap[y][x];
            put_bg_tile(MAP_ORIGIN_X + x, MAP_ORIGIN_Y + y,
                (unsigned int)((tid ? tile_vdp_for(tid) : VDPTILE_BLANK) << 2));
        }
    for (i = 0; i < cur_room.item_count; i++) {
        RoomItem *it = &cur_room.items[i];
        put_bg_tile(MAP_ORIGIN_X + it->x, MAP_ORIGIN_Y + it->y,
            (unsigned int)(itm_vdp_for(it->id) << 2));
    }
    dlg_clear_box();
}

static void draw_sprites(void) {
    unsigned char i;
    SMS_initSprites();
    SMS_addSprite(
        (unsigned char)((MAP_ORIGIN_X + player_x) * TILE_PX),
        (unsigned char)((MAP_ORIGIN_Y + player_y) * TILE_PX),
        (unsigned char)(spr_vdp_for(avatar_spr_id) & 0xFF));
    for (i = 0; i < cur_room.sprite_count; i++) {
        RoomSprite *s = &cur_room.sprites[i];
        SMS_addSprite(
            (unsigned char)((MAP_ORIGIN_X + s->x) * TILE_PX),
            (unsigned char)((MAP_ORIGIN_Y + s->y) * TILE_PX),
            (unsigned char)(spr_vdp_for(s->id) & 0xFF));
    }
    SMS_finalizeSprites();
}

/* =========================================================
 * Wall checking
 * ========================================================= */

static unsigned char is_wall(unsigned char seq) {
    unsigned char i;
    if (seq == 0) return 0;
    /* Check per-tile isWall flag */
    if (seq <= num_tiles && tile_is_wall[seq - 1]) return 1;
    /* Check room wall list */
    for (i = 0; i < cur_room.wall_count; i++)
        if (cur_room.walls[i] == seq) return 1;
    return 0;
}

/* =========================================================
 * Variables
 * ========================================================= */

static void load_vars(void) {
    const unsigned char *p = res_get("var.dat");
    unsigned int n, i;
    if (!p) { num_vars = 0; return; }
    n = read_u16(&p);
    num_vars = (unsigned char)(n < MAX_VARS ? n : MAX_VARS);
    for (i = 0; i < num_vars; i++) {
        unsigned char nl = *p++;
        if (nl >= 16) nl = 15;
        memcpy(vars[i].name, p, nl); p += nl;
        vars[i].name[nl] = '\0';
        vars[i].value = (int)(signed int)read_u16(&p);
    }
}

/* =========================================================
 * Item inventory
 * ========================================================= */

static void load_item_defaults(void) {
    const unsigned char *p = res_get("itminv.dat");
    unsigned int n, i;
    memset(item_counts, 0, sizeof(item_counts));
    if (!p) return;
    n = read_u16(&p);
    for (i = 0; i < n; i++) {
        unsigned int iid = read_u16(&p);
        int          val = (int)(signed int)read_u16(&p);
        unsigned int j;
        for (j = 0; j < num_items; j++)
            if (itm_ids[j] == iid) { item_counts[j] = val; break; }
    }
}

/* =========================================================
 * Player movement & interaction
 * ========================================================= */

static void try_move(signed char dx, signed char dy) {
    signed char   nx = (signed char)player_x + dx;
    signed char   ny = (signed char)player_y + dy;
    unsigned char i;

    if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) return;

    /* Wall check */
    {
        unsigned char tid = cur_room.tilemap[(unsigned char)ny][(unsigned char)nx];
        if (is_wall(tid)) return;
    }

    /* NPC collision — bump to talk */
    for (i = 0; i < cur_room.sprite_count; i++) {
        RoomSprite *s = &cur_room.sprites[i];
        if (s->x == (unsigned char)nx && s->y == (unsigned char)ny) {
            dlg_start(s->dlg_id);
            return;
        }
    }

    player_x = (unsigned char)nx;
    player_y = (unsigned char)ny;

    /* Item pickup */
    for (i = 0; i < cur_room.item_count; i++) {
        RoomItem *it = &cur_room.items[i];
        if (it->x == player_x && it->y == player_y) {
            unsigned int iid = it->id;
            unsigned int j;
            for (j = 0; j < num_items; j++)
                if (itm_ids[j] == iid) { item_counts[j]++; break; }
            /* Remove item from room */
            cur_room.item_count--;
            cur_room.items[i] = cur_room.items[cur_room.item_count];
            /* Clear tile */
            put_bg_tile(MAP_ORIGIN_X + player_x, MAP_ORIGIN_Y + player_y,
                (unsigned int)(VDPTILE_BLANK << 2));
            /* Item dialog: item id == dialog id */
            dlg_start(iid);
            return;
        }
    }

    /* Exit check */
    for (i = 0; i < cur_room.exit_count; i++) {
        Exit *ex = &cur_room.exits[i];
        if (ex->src_x == player_x && ex->src_y == player_y) {
            if (ex->dlg_id != NO_ID) {
                pending_exit = 1;
                pending_room = ex->dest_room;
                pending_x    = ex->dest_x;
                pending_y    = ex->dest_y;
                dlg_start(ex->dlg_id);
            } else {
                load_room(ex->dest_room);
                player_room = ex->dest_room;
                player_x    = ex->dest_x;
                player_y    = ex->dest_y;
                apply_palette(cur_room.pal_idx);
                draw_room();
            }
            return;
        }
    }

    /* Ending check */
    for (i = 0; i < cur_room.ending_count; i++) {
        Ending *en = &cur_room.endings[i];
        if (en->x == player_x && en->y == player_y) {
            game_over = 1;
            dlg_start(en->dlg_id);
            return;
        }
    }
}

/* =========================================================
 * Input tick
 * ========================================================= */

static void input_tick(void) {
    unsigned int joy     = SMS_getKeysStatus();
    unsigned int pressed = joy & ~prev_joy;
    unsigned int held    = joy &  prev_joy;
    unsigned int dirs    = 0;

    if (pressed & (PORT_A_KEY_UP|PORT_A_KEY_DOWN|PORT_A_KEY_LEFT|PORT_A_KEY_RIGHT)) {
        dirs = pressed; joy_repeat = JOY_REPEAT_INITIAL;
    } else if (held & (PORT_A_KEY_UP|PORT_A_KEY_DOWN|PORT_A_KEY_LEFT|PORT_A_KEY_RIGHT)) {
        if (joy_repeat) joy_repeat--;
        else { dirs = held; joy_repeat = JOY_REPEAT_CONT; }
    }

    if (pressed & (PORT_A_KEY_1|PORT_A_KEY_2)) {
        if (dlg_active) dlg_advance();
    }

    if (!dlg_active && !game_over && dirs) {
        if      (dirs & PORT_A_KEY_UP)    try_move( 0,-1);
        else if (dirs & PORT_A_KEY_DOWN)  try_move( 0, 1);
        else if (dirs & PORT_A_KEY_LEFT)  try_move(-1, 0);
        else if (dirs & PORT_A_KEY_RIGHT) try_move( 1, 0);
    }

    prev_joy = joy;
}

/* =========================================================
 * Animation tick
 * ========================================================= */

static void anim_tick(void) {
    if (++anim_counter < ANIM_PERIOD) return;
    anim_counter = 0;
    anim_frame  ^= 1;
    if (!dlg_active) draw_room();
}

/* =========================================================
 * Title screen
 * ========================================================= */

static void show_title(void) {
    const unsigned char *p = res_get("game.inf");
    unsigned char x = 5, y = 9;
    char ch;
    unsigned char tx, ty;

    for (ty = 0; ty < SCREEN_TILE_H; ty++)
        for (tx = 0; tx < SCREEN_TILE_W; tx++)
            put_bg_tile(tx, ty, (unsigned int)(VDPTILE_BLANK << 2));

    if (p) {
        while ((ch = (char)*p++) != '\0') {
            if (ch == '\n') { x = 5; y++; continue; }
            put_char(x++, y, ch);
            if (x >= SCREEN_TILE_W - 5) { x = 5; y++; }
        }
    }

    put_str(8, 22, "press button to start");

    SMS_displayOn();
    {
        unsigned int j;
        do { SMS_waitForVBlank(); j = SMS_getKeysStatus(); }
        while (!(j & (PORT_A_KEY_1|PORT_A_KEY_2)));
        do { SMS_waitForVBlank(); j = SMS_getKeysStatus(); }
        while  (j & (PORT_A_KEY_1|PORT_A_KEY_2));
    }
    SMS_displayOff();
}

/* =========================================================
 * wait for button press/release
 * ========================================================= */

static void wait_button(void) {
    unsigned int j;
    do { SMS_waitForVBlank(); j = SMS_getKeysStatus(); }
    while (!(j & (PORT_A_KEY_1|PORT_A_KEY_2)));
    do { SMS_waitForVBlank(); j = SMS_getKeysStatus(); }
    while  (j & (PORT_A_KEY_1|PORT_A_KEY_2));
}

/* =========================================================
 * World initialisation
 * ========================================================= */

static void init_world(void) {
    const unsigned char *p;
    unsigned char buf[64];

    anim_frame   = 0;
    anim_counter = 0;
    pending_exit = 0;
    game_over    = 0;
    dlg_active   = 0;
    prev_joy     = 0;
    joy_repeat   = 0;

    memset(buf, 0, 64);
    upload_tile(buf, 0, 0, VDPTILE_BLANK);
    memset(buf, 1, 64);
    upload_tile(buf, 0, 0, VDPTILE_SOLID);

    load_palettes();

    load_gfx("til.dat", tile_ids, tile_vdp, tile_vdp2,
             tile_is_wall, &num_tiles, VDPTILE_TILESET, 0, 1);
    load_gfx("spr.dat", spr_ids, spr_vdp, spr_vdp2,
             0,           &num_sprites, VDPTILE_SPRITES, 0, 2);
    load_gfx("itm.dat", itm_ids, itm_vdp, itm_vdp2,
             0,           &num_items, VDPTILE_ITEMS, 0, 1);

    avatar_spr_id = (num_sprites > 0) ? spr_ids[0] : NO_ID;

    p = res_get("font.dat");
    if (p) font_upload(p, 3, 0);

    load_vars();
    load_item_defaults();

    /* Load first room */
    p = res_get("room.dat");
    if (p) {
        unsigned int first_id;
        p += 2;
        first_id = (unsigned int)p[0] | ((unsigned int)p[1] << 8);
        load_room(first_id);
        player_room = first_id;
    }
}

/* =========================================================
 * main()
 * ========================================================= */

void main(void) {
    SMS_displayOff();
    SMS_disableLineInterrupt();
    SMS_VRAMmemsetW(0, 0, 16 * 1024);
    SMS_useFirstHalfTilesforSprites(0);
    SMS_setSpriteMode(SPRITEMODE_NORMAL);

    res_init();

    /* Upload font for title screen */
    {
        const unsigned char *fp = res_get("font.dat");
        if (fp) font_upload(fp, 3, 0);
        apply_palette(0);
    }
    show_title();

    /* Main game loop: init -> play -> end -> repeat */
    for (;;) {
        SMS_VRAMmemsetW(0, 0, 16 * 1024);
        init_world();
        draw_room();
        draw_sprites();
        SMS_copySpritestoSAT();
        /* Title dialog (id 0) */
        dlg_start(0);
        SMS_displayOn();

        /* Gameplay */
        while (!game_over || dlg_active) {
            SMS_waitForVBlank();
            input_tick();
            if (!game_over) anim_tick();
            draw_sprites();
            SMS_copySpritestoSAT();
        }

        /* Wait for a button press before restarting */
        wait_button();
        SMS_displayOff();
    }
}

SMS_EMBED_SEGA_ROM_HEADER(9999, 0);
SMS_EMBED_SDSC_HEADER(0, 2, 2025, 1, 1, "Bitsy SMS Exporter",
    "Bitsy SMS Engine v0.2",
    "Exports Bitsy games to Sega Master System ROM format.");
