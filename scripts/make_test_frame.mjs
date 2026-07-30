#!/usr/bin/env node
/**
 * make_test_frame.mjs — M1 "hand-built test frame" generator for the Xteink X3.
 *
 * ZERO npm dependencies. Plain Node ESM. Run with any Node >= 16.
 *
 * ---------------------------------------------------------------------------
 * DEVICE CONTRACT (verified on hardware — see HANDOFF.md / docs/xteink/app-fork-plan.md)
 * ---------------------------------------------------------------------------
 *   Panel        : 792 x 528, landscape, 1 bit per pixel.
 *   File         : /.love-notes/current.frame — EXACTLY 52272 bytes, raw, NO header.
 *   Layout       : 528 rows x 99 bytes/row  (528 * 99 = 52272).
 *   Bit order    : MSB-first within each byte. Stored bit index j runs 0..791
 *                  across a row; j = 0 is the MSB (bit 7) of byte 0.
 *                    byteOffset = row * 99 + (j >> 3)
 *                    bitInByte  = 7 - (j & 7)
 *   Polarity     : bit value 1 = WHITE, 0 = BLACK.
 *   NO MIRROR    : columns are packed LEFT-TO-RIGHT. Stored bit j IS panel pixel
 *                  x = j   (x = 0 is panel-LEFT, the MSB of byte 0).
 *                  PROVEN ON HARDWARE 2026-07-28: the firmware raw-blits with no
 *                  horizontal flip. Frames packed with the earlier `j = 791 - x`
 *                  mirror rendered MIRRORED on the panel; straight frames
 *                  rendered correct. `--mirror` reproduces the old behaviour for
 *                  diagnosis only — it is LEGACY and renders backwards.
 *   Row order    : row 0 is panel-TOP (confirmed on hardware 2026-07-28).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PRODUCES
 * ---------------------------------------------------------------------------
 * Three 52272-byte .frame variants that differ ONLY in how the authored artwork
 * is mapped into the landscape buffer. Photographing the panel for each is what
 * settled the true compose->buffer mapping on 2026-07-28: A read correctly and
 * un-mirrored (proving NO X-mirror), and C read upright while B read 180 degrees
 * off (proving CCW).
 *
 *   A "landscape"    : artwork authored directly in the 792x528 landscape buffer.
 *   B "portrait-cw"  : artwork authored on a 528(w) x 792(h) portrait canvas,
 *                      mapped into the landscape buffer by rotating 90 deg CW.
 *                      Renders UPSIDE DOWN — kept as the negative control.
 *   C "portrait-ccw" : same portrait artwork, rotated 90 deg CCW. UPRIGHT.
 *
 * ---------------------------------------------------------------------------
 * ROTATION FORMULAS (derived below; off-by-one / wrong-direction here is exactly
 * the bug class M1/M2 exists to catch, so both directions are spelled out)
 * ---------------------------------------------------------------------------
 * Portrait canvas: PW = 528 columns (px = 0..527), PH = 792 rows (py = 0..791).
 * Landscape buffer: LW = 792 columns (lx = 0..791), LH = 528 rows (ly = 0..527).
 *
 * B) 90 deg CLOCKWISE. Rotating the portrait image CW sends its TOP edge to the
 *    landscape RIGHT edge, and its LEFT edge to the landscape TOP edge.
 *      forward : lx = (PH - 1) - py = 791 - py
 *                ly = px
 *      inverse : px = ly
 *                py = (LW - 1) - lx = 791 - lx
 *    sanity: portrait TL (0,0)     -> landscape (791,   0) = TOP-RIGHT
 *            portrait TR (527,0)   -> landscape (791, 527) = BOTTOM-RIGHT
 *            portrait BL (0,791)   -> landscape (  0,   0) = TOP-LEFT
 *            portrait BR (527,791) -> landscape (  0, 527) = BOTTOM-LEFT
 *
 * C) 90 deg COUNTER-CLOCKWISE. Rotating the portrait image CCW sends its TOP edge
 *    to the landscape LEFT edge, and its RIGHT edge to the landscape TOP edge.
 *      forward : lx = py
 *                ly = (PW - 1) - px = 527 - px
 *      inverse : py = lx
 *                px = (LH - 1) - ly = 527 - ly
 *    sanity: portrait TL (0,0)     -> landscape (  0, 527) = BOTTOM-LEFT
 *            portrait TR (527,0)   -> landscape (  0,   0) = TOP-LEFT
 *            portrait BL (0,791)   -> landscape (791, 527) = BOTTOM-RIGHT
 *            portrait BR (527,791) -> landscape (791,   0) = TOP-RIGHT
 *
 * Both maps are exact bijections over the integer grid (no interpolation, no
 * holes): CW/CCW inverse maps are applied per destination pixel, and the index
 * ranges line up 1:1 (ly in 0..527 -> px in 0..527; lx in 0..791 -> py in 0..791).
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/make_test_frame.mjs [--out DIR] [--mirror]
 *       Writes A/B/C .frame files (default DIR = ./test-frames), packed STRAIGHT.
 *       --mirror packs them with the LEGACY X-mirror instead (diagnostic only —
 *       those frames render backwards on the current firmware).
 *
 *   node scripts/make_test_frame.mjs --decode FILE.frame [--mirror] [--pgm OUT.pgm]
 *                                    [--cols N] [--rows N]
 *       Prints a downsampled ASCII preview of the PANEL view (default ~120x60).
 *       Decoding is STRAIGHT by default; pass --mirror to un-mirror a legacy
 *       mirror-packed frame. --pgm additionally writes a full-resolution P5 PGM.
 */

import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Landscape buffer width in pixels. */
const LW = 792;
/** Landscape buffer height in pixels (== rows in the file). */
const LH = 528;
/** Bytes per stored row. 792 bits / 8 = 99. */
const ROW_BYTES = 99;
/** Exact on-disk size. Asserted before every write. */
const FRAME_BYTES = LH * ROW_BYTES; // 52272

/** Portrait compose canvas dimensions (variants B and C are authored here). */
const PW = 528;
const PH = 792;

const WHITE = 1;
const BLACK = 0;

// ---------------------------------------------------------------------------
// 5x7 bitmap font: A-Z, 0-9, space, dash.
// Each glyph is 7 rows of 5 columns. '#' = ink (black), '.' = background.
// Rendered scaled up (see drawText) so it is legible on the panel.
// ---------------------------------------------------------------------------

const FONT_W = 5;
const FONT_H = 7;

const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
};

// ---------------------------------------------------------------------------
// Canvas: a plain 1-byte-per-pixel bitmap. 1 = white, 0 = black.
// This is authoring space only — packing to the device format happens later.
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const data = new Uint8Array(w * h);
  data.fill(WHITE);
  return { w, h, data };
}

function setPx(c, x, y, v) {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= c.w || yi >= c.h) return;
  c.data[yi * c.w + xi] = v;
}

function fillRect(c, x, y, w, h, v) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(c.w, Math.round(x + w));
  const y1 = Math.min(c.h, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    const base = yy * c.w;
    for (let xx = x0; xx < x1; xx++) c.data[base + xx] = v;
  }
}

/** Outlined rectangle of the given border thickness, drawn inside (x,y,w,h). */
function strokeRect(c, x, y, w, h, t, v) {
  fillRect(c, x, y, w, t, v); // top
  fillRect(c, x, y + h - t, w, t, v); // bottom
  fillRect(c, x, y, t, h, v); // left
  fillRect(c, x + w - t, y, t, h, v); // right
}

/** Bresenham line, stamped with a t x t square so it reads on the panel. */
function drawLine(c, x0, y0, x1, y1, t, v) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  const half = Math.floor(t / 2);
  for (;;) {
    fillRect(c, x - half, y - half, t, t, v);
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Advance per character = (5 glyph cols + 1 gap col) * scale. */
function textWidth(s, scale) {
  if (s.length === 0) return 0;
  return s.length * (FONT_W + 1) * scale - scale; // no trailing gap
}

function textHeight(scale) {
  return FONT_H * scale;
}

/** Largest integer scale in [min,max] such that `s` fits in `maxW` pixels. */
function fitScale(s, maxW, min, max) {
  for (let sc = max; sc >= min; sc--) {
    if (textWidth(s, sc) <= maxW) return sc;
  }
  return min;
}

/**
 * Draw `s` with its top-left at (x, y) at the given integer scale.
 *
 * `plate` paints a WHITE rectangle (padded by `pad`) behind the glyphs first.
 * That is what lets the full-length TL->BR diagonal run edge to edge without
 * ever degrading text legibility in a photo of the panel.
 */
function drawText(c, s, x, y, scale, { plate = true, pad = 8 } = {}) {
  const w = textWidth(s, scale);
  const h = textHeight(scale);
  if (plate) fillRect(c, x - pad, y - pad, w + 2 * pad, h + 2 * pad, WHITE);
  const up = s.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const glyph = FONT[up[i]] ?? FONT['-'];
    const gx = x + i * (FONT_W + 1) * scale;
    for (let gy = 0; gy < FONT_H; gy++) {
      const row = glyph[gy];
      for (let gxx = 0; gxx < FONT_W; gxx++) {
        if (row[gxx] !== '#') continue;
        fillRect(c, gx + gxx * scale, y + gy * scale, scale, scale, BLACK);
      }
    }
  }
  return { w, h };
}

/** Horizontally centred text; returns the drawn box. */
function drawTextCentered(c, s, cx, y, scale, opts) {
  const w = textWidth(s, scale);
  return drawText(c, s, Math.round(cx - w / 2), y, scale, opts);
}

// ---------------------------------------------------------------------------
// Arrow (points RIGHT in canvas space)
// ---------------------------------------------------------------------------

/**
 * Thick right-pointing arrow centred on (cx, cy).
 * Shaft is a rectangle; head is a filled triangle whose apex is the rightmost
 * point. Sits on a white plate so the background diagonal cannot be mistaken
 * for part of it.
 */
function drawArrowRight(c, cx, cy, len, shaftTh, headLen, headHalf) {
  const x0 = Math.round(cx - len / 2);
  const x1 = Math.round(cx + len / 2); // apex
  const xh = x1 - headLen; // head base

  fillRect(
    c,
    x0 - 14,
    cy - headHalf - 14,
    len + 28,
    2 * headHalf + 28,
    WHITE
  ); // plate

  fillRect(c, x0, Math.round(cy - shaftTh / 2), xh - x0, shaftTh, BLACK);

  for (let x = xh; x <= x1; x++) {
    const tRatio = headLen === 0 ? 0 : (x1 - x) / headLen; // 1 at base, 0 at apex
    const half = Math.max(1, Math.round(headHalf * tRatio));
    fillRect(c, x, Math.round(cy - half), 1, 2 * half, BLACK);
  }
}

// ---------------------------------------------------------------------------
// The orientation test pattern
// ---------------------------------------------------------------------------

/**
 * Paint the orientation pattern onto `c` in ITS OWN coordinate space
 * (x right, y down). Works for both the 792x528 landscape canvas (variant A)
 * and the 528x792 portrait canvas (variants B and C).
 *
 * The pattern must be distinguishable from all 8 dihedral transforms
 * (4 rotations x optional mirror) from a single photograph:
 *
 *   - readable TEXT           -> breaks every mirror; also breaks 180 deg
 *   - corner labels TL/TR/BL/BR in the matching corners
 *                             -> pins each of the 4 corners individually
 *   - thick arrow pointing RIGHT, labelled "RIGHT"
 *                             -> independent left/right check
 *   - full 3px black border   -> proves nothing is cropped / no row-stride skew
 *   - diagonal from TOP-LEFT to BOTTOM-RIGHT
 *                             -> breaks the two transpose reflections at a glance
 *
 * Drawing order matters: background -> diagonal -> border -> plated content,
 * so the diagonal spans the whole frame yet never sits on top of a glyph.
 */
function drawPattern(c, titleLines) {
  const W = c.w;
  const H = c.h;

  // 1. white background
  fillRect(c, 0, 0, W, H, WHITE);

  // 2. full-length diagonal, TOP-LEFT corner -> BOTTOM-RIGHT corner
  drawLine(c, 0, 0, W - 1, H - 1, 3, BLACK);

  // 3. 3px border all the way round
  strokeRect(c, 0, 0, W, H, 3, BLACK);

  // 4. corner labels, inset from the border
  const cornerScale = 6;
  const inset = 18;
  const ch = textHeight(cornerScale);
  drawText(c, 'TL', inset, inset, cornerScale, { pad: 7 });
  drawText(c, 'TR', W - inset - textWidth('TR', cornerScale), inset, cornerScale, { pad: 7 });
  drawText(c, 'BL', inset, H - inset - ch, cornerScale, { pad: 7 });
  drawText(c, 'BR', W - inset - textWidth('BR', cornerScale), H - inset - ch, cornerScale, { pad: 7 });

  // 5. title block, centred, auto-scaled to fit this canvas width
  const margin = 34;
  const avail = W - 2 * margin;
  let scale = 8;
  for (const line of titleLines) scale = Math.min(scale, fitScale(line, avail, 3, 8));
  const lineGap = Math.round(textHeight(scale) * 0.45);
  const blockH = titleLines.length * textHeight(scale) + (titleLines.length - 1) * lineGap;
  let ty = Math.round(H * 0.30 - blockH / 2);
  for (const line of titleLines) {
    drawTextCentered(c, line, W / 2, ty, scale, { pad: 10 });
    ty += textHeight(scale) + lineGap;
  }

  // 6. thick arrow pointing right + its label
  const arrowLen = Math.round(Math.min(W * 0.62, 420));
  const headHalf = Math.round(Math.min(H * 0.055, 46));
  const headLen = Math.round(arrowLen * 0.26);
  const shaftTh = Math.max(10, Math.round(headHalf * 0.75));
  const arrowCy = Math.round(H * 0.56);
  drawArrowRight(c, W / 2, arrowCy, arrowLen, shaftTh, headLen, headHalf);

  const labScale = fitScale('THIS WAY RIGHT', avail, 3, 6);
  drawTextCentered(
    c,
    'THIS WAY RIGHT',
    W / 2,
    arrowCy + headHalf + 26,
    labScale,
    { pad: 9 }
  );

  // 7. explicit top / bottom words for a fully unambiguous photo
  const tbScale = fitScale('TOP EDGE', avail, 3, 5);
  drawTextCentered(c, 'TOP EDGE', W / 2, Math.round(H * 0.10), tbScale, { pad: 9 });
  drawTextCentered(
    c,
    'BOTTOM EDGE',
    W / 2,
    Math.round(H * 0.88) - textHeight(tbScale),
    tbScale,
    { pad: 9 }
  );
}

// ---------------------------------------------------------------------------
// Canvas -> landscape buffer mappings
// ---------------------------------------------------------------------------

/** Variant A: the canvas IS the landscape buffer. Straight copy. */
function landscapeFromLandscape(src) {
  if (src.w !== LW || src.h !== LH) throw new Error('variant A canvas must be 792x528');
  const dst = makeCanvas(LW, LH);
  dst.data.set(src.data);
  return dst;
}

/**
 * Variant B: portrait canvas rotated 90 deg CLOCKWISE into the landscape buffer.
 *   forward  lx = 791 - py , ly = px
 *   inverse  px = ly       , py = 791 - lx      <-- applied here, per dest pixel
 */
function landscapeFromPortraitCW(src) {
  if (src.w !== PW || src.h !== PH) throw new Error('portrait canvas must be 528x792');
  const dst = makeCanvas(LW, LH);
  for (let ly = 0; ly < LH; ly++) {
    for (let lx = 0; lx < LW; lx++) {
      const px = ly;
      const py = LW - 1 - lx; // 791 - lx
      dst.data[ly * LW + lx] = src.data[py * PW + px];
    }
  }
  return dst;
}

/**
 * Variant C: portrait canvas rotated 90 deg COUNTER-CLOCKWISE.
 *   forward  lx = py       , ly = 527 - px
 *   inverse  py = lx       , px = 527 - ly      <-- applied here, per dest pixel
 */
function landscapeFromPortraitCCW(src) {
  if (src.w !== PW || src.h !== PH) throw new Error('portrait canvas must be 528x792');
  const dst = makeCanvas(LW, LH);
  for (let ly = 0; ly < LH; ly++) {
    for (let lx = 0; lx < LW; lx++) {
      const py = lx;
      const px = LH - 1 - ly; // 527 - ly
      dst.data[ly * LW + lx] = src.data[py * PW + px];
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Pack / unpack (the column order lives here and ONLY here)
// ---------------------------------------------------------------------------

/**
 * Stored bit index for panel column x.
 *
 *   straight (default, HARDWARE-PROVEN 2026-07-28):  j = x
 *   mirrored (LEGACY, --mirror, diagnostic only)  :  j = 791 - x
 *
 * One function so pack and unpack can never disagree, and so the legacy mirror
 * exists in exactly one expression.
 */
function bitIndexForColumn(x, mirror) {
  return mirror ? LW - 1 - x : x;
}

/**
 * Landscape panel bitmap -> 52272-byte device frame.
 *
 * For panel pixel (x, y):   j = x                      (NO MIRROR)
 *                           byte = y * 99 + (j >> 3)
 *                           bit  = 7 - (j & 7)         (MSB-first)
 *                           1 = white, 0 = black
 *
 * `mirror: true` reproduces the pre-2026-07-28 packing (j = 791 - x), which
 * renders backwards on the current firmware. Diagnostic only.
 */
function packFrame(canvas, { mirror = false } = {}) {
  if (canvas.w !== LW || canvas.h !== LH) throw new Error('packFrame expects 792x528');
  const out = Buffer.alloc(FRAME_BYTES, 0x00); // start all-black, set white bits
  for (let y = 0; y < LH; y++) {
    const rowBase = y * ROW_BYTES;
    const pixBase = y * LW;
    for (let x = 0; x < LW; x++) {
      if (canvas.data[pixBase + x] !== WHITE) continue;
      const j = bitIndexForColumn(x, mirror);
      out[rowBase + (j >> 3)] |= 0x80 >> (j & 7);
    }
  }
  return out;
}

/**
 * Inverse of packFrame: 52272-byte device frame -> landscape panel bitmap.
 * Pass the SAME `mirror` the frame was packed with, or the preview comes out
 * flipped.
 */
function unpackFrame(buf, { mirror = false } = {}) {
  if (buf.length !== FRAME_BYTES) {
    throw new Error(`expected ${FRAME_BYTES} bytes, got ${buf.length}`);
  }
  const c = makeCanvas(LW, LH);
  for (let y = 0; y < LH; y++) {
    const rowBase = y * ROW_BYTES;
    const pixBase = y * LW;
    for (let x = 0; x < LW; x++) {
      const j = bitIndexForColumn(x, mirror);
      const bit = (buf[rowBase + (j >> 3)] >> (7 - (j & 7))) & 1;
      c.data[pixBase + x] = bit ? WHITE : BLACK;
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

const RAMP = ' .:-=+*#%@';

/**
 * Downsample the PANEL view (row 0 top, x 0 left) to an ASCII block.
 * Each cell averages the ink coverage of the pixels it covers.
 */
function asciiPreview(canvas, cols = 120, rows = 60) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * canvas.h) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * canvas.h) / rows));
    let line = '';
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const x0 = Math.floor((cIdx * canvas.w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cIdx + 1) * canvas.w) / cols));
      let ink = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const base = y * canvas.w;
        for (let x = x0; x < x1; x++) {
          if (canvas.data[base + x] === BLACK) ink++;
          n++;
        }
      }
      const frac = n === 0 ? 0 : ink / n;
      let idx = Math.round(frac * (RAMP.length - 1));
      if (frac > 0 && idx === 0) idx = 1; // never lose a thin 3px line to rounding
      line += RAMP[idx];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Full-resolution binary PGM (P5) of the panel view. */
function writePGM(path, canvas) {
  const header = Buffer.from(`P5\n${canvas.w} ${canvas.h}\n255\n`, 'ascii');
  const px = Buffer.alloc(canvas.w * canvas.h);
  for (let i = 0; i < px.length; i++) px[i] = canvas.data[i] === WHITE ? 255 : 0;
  writeFileSync(path, Buffer.concat([header, px]));
}

// ---------------------------------------------------------------------------
// Variant definitions
// ---------------------------------------------------------------------------

const VARIANTS = [
  {
    id: 'A',
    name: 'landscape',
    file: 'A-landscape.frame',
    authoredIn: `${LW}x${LH} landscape`,
    mapping: 'identity (no rotation)',
    titleLines: ['A LANDSCAPE'],
    build() {
      const c = makeCanvas(LW, LH);
      drawPattern(c, this.titleLines);
      return landscapeFromLandscape(c);
    },
  },
  {
    id: 'B',
    name: 'portrait-cw',
    file: 'B-portrait-cw.frame',
    authoredIn: `${PW}x${PH} portrait`,
    mapping: '90 deg CW: lx = 791 - py, ly = px',
    titleLines: ['B PORTRAIT', 'CW'],
    build() {
      const c = makeCanvas(PW, PH);
      drawPattern(c, this.titleLines);
      return landscapeFromPortraitCW(c);
    },
  },
  {
    id: 'C',
    name: 'portrait-ccw',
    file: 'C-portrait-ccw.frame',
    authoredIn: `${PW}x${PH} portrait`,
    mapping: '90 deg CCW: lx = py, ly = 527 - px',
    titleLines: ['C PORTRAIT', 'CCW'],
    build() {
      const c = makeCanvas(PW, PH);
      drawPattern(c, this.titleLines);
      return landscapeFromPortraitCCW(c);
    },
  },
];

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

/** pack/unpack must be exact inverses, otherwise every downstream check lies. */
function assertRoundTrip(canvas, label, { mirror = false } = {}) {
  const back = unpackFrame(packFrame(canvas, { mirror }), { mirror });
  for (let i = 0; i < canvas.data.length; i++) {
    if (back.data[i] !== canvas.data[i]) {
      const y = Math.floor(i / LW);
      const x = i % LW;
      throw new Error(`${label}: pack/unpack round-trip mismatch at (${x},${y})`);
    }
  }
}

/** Verify the rotation maps against the four corner sanity cases in the header. */
function assertRotationCorners() {
  const probe = makeCanvas(PW, PH);
  // tag each portrait corner with a unique value
  const tags = [
    [0, 0, 10], // portrait TL
    [PW - 1, 0, 11], // portrait TR
    [0, PH - 1, 12], // portrait BL
    [PW - 1, PH - 1, 13], // portrait BR
  ];
  for (const [x, y, v] of tags) probe.data[y * PW + x] = v;

  const cw = landscapeFromPortraitCW(probe);
  const expectCW = [
    [LW - 1, 0, 10], // TL -> landscape top-right
    [LW - 1, LH - 1, 11], // TR -> landscape bottom-right
    [0, 0, 12], // BL -> landscape top-left
    [0, LH - 1, 13], // BR -> landscape bottom-left
  ];
  for (const [x, y, v] of expectCW) {
    if (cw.data[y * LW + x] !== v) throw new Error(`CW map wrong at landscape (${x},${y})`);
  }

  const ccw = landscapeFromPortraitCCW(probe);
  const expectCCW = [
    [0, LH - 1, 10], // TL -> landscape bottom-left
    [0, 0, 11], // TR -> landscape top-left
    [LW - 1, LH - 1, 12], // BL -> landscape bottom-right
    [LW - 1, 0, 13], // BR -> landscape top-right
  ];
  for (const [x, y, v] of expectCCW) {
    if (ccw.data[y * LW + x] !== v) throw new Error(`CCW map wrong at landscape (${x},${y})`);
  }
}

/** All-white row 0 with a single BLACK pixel at panel column `x`. */
function rowZeroProbe(x) {
  const c = makeCanvas(LW, LH);
  fillRect(c, 0, 0, LW, LH, WHITE);
  setPx(c, x, 0, BLACK);
  return c;
}

/**
 * DEFAULT packing must NOT mirror: the panel-LEFT pixel has to land in the
 * FIRST byte of the row, as the MSB.
 *
 * Hardware-proven 2026-07-28. A pack/unpack round trip cannot catch a flipped
 * column order (it passes with both sides inverted), so this is anchored to raw
 * bytes computed by hand from the contract.
 */
function assertNoMirror() {
  // panel x = 0  ->  j = 0  ->  byte 0, bit 7 - 0 = 7 (MSB) -> 0xFF & ~0x80
  const left = packFrame(rowZeroProbe(0));
  if (left[0] !== 0x7f) {
    throw new Error(`no-mirror: byte 0 should be 0x7F, got 0x${left[0].toString(16)}`);
  }
  if (left[ROW_BYTES - 1] !== 0xff) {
    throw new Error('no-mirror: byte 98 holds the panel-RIGHT pixels and must be untouched');
  }
  for (let i = 1; i < ROW_BYTES; i++) {
    if (left[i] !== 0xff) throw new Error(`no-mirror: byte ${i} should be white`);
  }

  // panel x = 791  ->  j = 791  ->  byte 98, bit 7 - 7 = 0 (LSB) -> 0xFF & ~0x01
  const right = packFrame(rowZeroProbe(LW - 1));
  if (right[ROW_BYTES - 1] !== 0xfe) {
    throw new Error(`no-mirror: byte 98 should be 0xFE, got 0x${right[ROW_BYTES - 1].toString(16)}`);
  }
  if (right[0] !== 0xff) throw new Error('no-mirror: byte 0 must be untouched white');
}

/**
 * LEGACY --mirror packing must be the exact opposite: panel-LEFT lands in the
 * LAST byte of the row, as the LSB. Checked so the diagnostic flag stays a
 * faithful reproduction of the old behaviour rather than quietly rotting.
 */
function assertMirroredLegacy() {
  const left = packFrame(rowZeroProbe(0), { mirror: true });
  // panel x = 0  ->  j = 791  ->  byte 98, bit 7 - 7 = 0 (LSB)
  if (left[ROW_BYTES - 1] !== 0xfe) {
    throw new Error(`mirror: byte 98 should be 0xFE, got 0x${left[ROW_BYTES - 1].toString(16)}`);
  }
  if (left[0] !== 0xff) throw new Error('mirror: byte 0 should be untouched white');

  const right = packFrame(rowZeroProbe(LW - 1), { mirror: true });
  if (right[0] !== 0x7f) {
    throw new Error(`mirror: byte 0 should be 0x7F, got 0x${right[0].toString(16)}`);
  }
  if (right[ROW_BYTES - 1] !== 0xff) throw new Error('mirror: byte 98 must be untouched white');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: 'test-frames', decode: null, pgm: null, cols: 120, rows: 60, mirror: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--decode') out.decode = argv[++i];
    else if (a === '--pgm') out.pgm = argv[++i];
    else if (a === '--cols') out.cols = parseInt(argv[++i], 10);
    else if (a === '--rows') out.rows = parseInt(argv[++i], 10);
    else if (a === '--mirror') out.mirror = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  console.log(`make_test_frame.mjs — Xteink X3 orientation test frames (${FRAME_BYTES} bytes each)

  generate:  node scripts/make_test_frame.mjs [--out DIR] [--mirror]
  decode  :  node scripts/make_test_frame.mjs --decode FILE.frame [--mirror]
                                              [--pgm OUT.pgm] [--cols N] [--rows N]

  --mirror   LEGACY/DIAGNOSTIC. Pack (or decode) with the pre-2026-07-28
             X-mirror, j = 791 - x. The current firmware raw-blits straight, so
             mirrored frames render BACKWARDS on the panel. Default is straight.`);
}

function cmdGenerate(outDir, mirror) {
  assertNoMirror();
  assertMirroredLegacy();
  assertRotationCorners();
  console.log('self-check: straight packing OK, legacy --mirror packing OK, CW/CCW corner maps OK');
  if (mirror) {
    console.warn(
      'warn: --mirror packs the LEGACY X-mirror (j = 791 - x). These frames render\n' +
      '      BACKWARDS on the current firmware — diagnostic use only.'
    );
  }

  const dir = resolve(process.cwd(), outDir);
  mkdirSync(dir, { recursive: true });

  for (const v of VARIANTS) {
    const canvas = v.build();
    assertRoundTrip(canvas, v.file, { mirror });
    const buf = packFrame(canvas, { mirror });

    // Hard gate: never write anything that is not byte-exact.
    if (buf.length !== FRAME_BYTES) {
      throw new Error(`${v.file}: expected ${FRAME_BYTES} bytes, built ${buf.length}`);
    }

    const path = join(dir, v.file);
    writeFileSync(path, buf);

    const onDisk = statSync(path).size;
    if (onDisk !== FRAME_BYTES) {
      throw new Error(`${v.file}: on-disk size ${onDisk} != ${FRAME_BYTES}`);
    }
    console.log(
      `wrote ${path}  ${onDisk} bytes  [authored ${v.authoredIn}; ${v.mapping}; ` +
      `${mirror ? 'LEGACY X-mirror' : 'straight, no mirror'}]`
    );
  }

  console.log(`
Upload one variant at a time to /.love-notes/current.frame (delete the existing
file first — the firmware REJECTS an upload onto an existing path) and photograph
the panel. Expected on the 2026-07-28 firmware: A reads correctly and NOT
mirrored, C reads upright, B reads 180 degrees off. Text rendering MIRRORED would
mean the no-mirror finding has regressed; UPSIDE DOWN across the board would mean
row 0 is panel-bottom, not panel-top.`);
}

function cmdDecode(file, pgmPath, cols, rows, mirror) {
  const path = resolve(process.cwd(), file);
  const buf = readFileSync(path);
  console.log(`file      : ${path}`);
  console.log(`size      : ${buf.length} bytes (expected ${FRAME_BYTES})`);
  if (buf.length !== FRAME_BYTES) {
    throw new Error(`size mismatch: ${buf.length} != ${FRAME_BYTES}`);
  }

  const canvas = unpackFrame(buf, { mirror });

  let black = 0;
  for (let i = 0; i < canvas.data.length; i++) if (canvas.data[i] === BLACK) black++;
  const pct = ((black / canvas.data.length) * 100).toFixed(2);
  console.log(`panel view: ${LW}x${LH}, ${black} black px (${pct}%)`);
  console.log(`column map: ${mirror ? 'j = 791 - x (LEGACY --mirror, un-mirroring)' : 'j = x (straight, no un-mirror)'}`);
  console.log(`preview   : ${cols}x${rows} chars, PANEL view (row 0 = top-left)\n`);
  console.log(asciiPreview(canvas, cols, rows));

  if (pgmPath) {
    const p = resolve(process.cwd(), pgmPath);
    writePGM(p, canvas);
    console.log(`\nwrote PGM : ${p} (P5, ${LW}x${LH}, 255=white)`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    usage();
    process.exit(2);
  }
  if (args.help) {
    usage();
    return;
  }
  try {
    if (args.decode) cmdDecode(args.decode, args.pgm, args.cols, args.rows, args.mirror);
    else cmdGenerate(args.out, args.mirror);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

// Run only when invoked directly, so the helpers below stay importable by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  LW,
  LH,
  ROW_BYTES,
  FRAME_BYTES,
  PW,
  PH,
  VARIANTS,
  packFrame,
  unpackFrame,
  bitIndexForColumn,
  landscapeFromPortraitCW,
  landscapeFromPortraitCCW,
  drawPattern,
  makeCanvas,
  asciiPreview,
  assertNoMirror,
  assertMirroredLegacy,
};
