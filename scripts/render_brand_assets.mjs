#!/usr/bin/env node
// scripts/render_brand_assets.mjs
//
// Generates the cozy brand assets — "Sealed note" (a folded paper note with a
// heart wax seal) — as BOTH the SVG sources under assets/brand/ and the PNGs
// app.config.ts references under assets/. One geometry definition below is the
// single source of truth for both, so the vectors and the shipped bitmaps can
// never drift.
//
// WHY THIS FILE EXISTS AT ALL: node_modules has no SVG rasterizer (no sharp, no
// resvg, no canvas) and adding one for four icons is not worth a dependency. So
// this script contains a small, bounded rasterizer: a tiny path parser (M/L/C/Z
// absolute), Bezier flattening, scanline nonzero-winding fill with vertical
// supersampling + analytic horizontal coverage, capsule strokes with round
// caps/joins, and a PNG encoder built on node:zlib. No third-party imports, no
// network, no shelling out. Deterministic: same input -> byte-identical output.
//
//   node scripts/render_brand_assets.mjs            # write svg + png
//   node scripts/render_brand_assets.mjs --check    # render, report, write nothing
//
// Peak memory is a few RGBA float buffers at 1024x1024 (~17 MB each), so it runs
// happily under `NODE_OPTIONS=--max-old-space-size=512`.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

// ───────────────────────────────────────────────────────────────────────────
// Palette — every color is a token from src/theme/tokens.ts (light palette).
// No color is invented here.
// ───────────────────────────────────────────────────────────────────────────

const CREAM = '#F6EEDF';   // lightColors.bg      — icon background / page
const PAPER = '#FFFBF4';   // lightColors.surface — the note itself
const SEAL = '#A8552E';    // lightColors.accent  — the heart wax seal
// The note's outline. The spec's Candidate A asks for `lightColors.border`
// (#DCC9AA), but measured against the note fill that is 1.35:1 — at a 48 px
// launcher size the note simply disappears and the icon collapses into "a heart
// on cream". So this takes the spec's own icon-scale escape hatch (Candidate C:
// "border-adjacent but darker for icon-scale visibility") and uses the accent,
// which is 5.08:1 on the note fill and ties the outline to the wax seal.
const OUTLINE = SEAL;

// ───────────────────────────────────────────────────────────────────────────
// Geometry, in a 1024x1024 design space (all assets share the viewBox).
// ───────────────────────────────────────────────────────────────────────────

const U = 1024;              // design units per side
const C = U / 2;             // 512 — every transform pivots here
const NOTE_W = 552;          // ~55% of the square, per the spec
const NOTE_H = 624;
const FOLD = 160;            // dog-eared corner size
const OUTLINE_W = 20;        // ~2% of the square: thin, but ~1 px at 48 px
const NOTE_TILT = -4;        // degrees — hand-placed, not machine-square
const SEAL_W = 224;          // heart width: ~40% of the note, ~22% of the icon
const SEAL_DROP = 64;        // "slightly below the note's middle"

// The heart is the §2 Compose-icon template path, verbatim, in its own 24-unit
// space (bbox x 3..11, y 10.6..18.5). src/components/icons/TabIcons.tsx renders
// the same curve scaled down for the tab bar — same mark, two sizes.
const HEART_TEMPLATE =
    'M7 18.5 C4.2 16.2 3 14.6 3 13.1 C3 11.7 4.1 10.6 5.4 10.6 ' +
    'C6.2 10.6 6.7 11 7 11.5 C7.3 11 7.8 10.6 8.6 10.6 ' +
    'C9.9 10.6 11 11.7 11 13.1 C11 14.6 9.8 16.2 7 18.5 Z';
const HEART_BBOX = { x: 3, y: 10.6, w: 8, h: 7.9 };

// Note outline in note-local coordinates (origin at the note's center), with the
// top-right corner cut away by the fold.
const HW = NOTE_W / 2;
const HH = NOTE_H / 2;
const NOTE_PATH = [
    `M${-HW} ${-HH}`,
    `L${HW - FOLD} ${-HH}`,
    `L${HW} ${-HH + FOLD}`,
    `L${HW} ${HH}`,
    `L${-HW} ${HH}`,
    'Z',
].join(' ');
// The dog-ear itself: the triangle you see the back of, filled with the page
// color behind it so the corner reads as folded rather than clipped.
const FOLD_PATH = [
    `M${HW - FOLD} ${-HH}`,
    `L${HW} ${-HH + FOLD}`,
    `L${HW - FOLD} ${-HH + FOLD}`,
    'Z',
].join(' ');

// ───────────────────────────────────────────────────────────────────────────
// Affine helpers. Matrices are SVG-order [a, b, c, d, e, f]:
//   x' = a*x + c*y + e ;  y' = b*x + d*y + f
// The SVG output emits these matrices verbatim, and the rasterizer applies the
// same numbers, which is what keeps vector and bitmap identical.
// ───────────────────────────────────────────────────────────────────────────

const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
const scaleM = (s) => [s, 0, 0, s, 0, 0];
const rotateM = (deg) => {
    const r = (deg * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const fmt = (n) => {
    const r = Math.round(n * 1e6) / 1e6;
    return Object.is(r, -0) ? '0' : String(r);
};
const matrixAttr = (m) => `matrix(${m.map(fmt).join(' ')})`;

/**
 * The whole mark (note + seal) scaled about the icon center. `scale` is how much
 * of the square the mark is allowed to use: 1 for the iOS icon, 0.78 for the
 * Android adaptive foreground (Android reserves a 66%-diameter safe circle, and
 * the tilted note's half-diagonal is 425 units, so 338/425 -> 0.78 with margin).
 */
function markMatrices(scale) {
    const mark = mul(mul(translate(C, C), mul(rotateM(NOTE_TILT), scaleM(scale))), translate(-C, -C));
    const note = mul(mark, translate(C, C));
    const sealScale = SEAL_W / HEART_BBOX.w;
    const seal = mul(
        mul(mark, mul(translate(C, C + SEAL_DROP), scaleM(sealScale))),
        translate(-(HEART_BBOX.x + HEART_BBOX.w / 2), -(HEART_BBOX.y + HEART_BBOX.h / 2))
    );
    return { note, seal, strokeScale: scale };
}

/** Shape list for one asset. `bg: true` paints the full-bleed cream square. */
function buildShapes({ bg, mark }) {
    const shapes = [];
    if (bg) {
        shapes.push({
            id: 'background',
            d: `M0 0 L${U} 0 L${U} ${U} L0 ${U} Z`,
            fill: CREAM,
            matrix: IDENT,
        });
    }
    if (mark !== null) {
        const { note, seal, strokeScale } = markMatrices(mark);
        shapes.push({
            id: 'note',
            d: NOTE_PATH,
            fill: PAPER,
            stroke: OUTLINE,
            strokeWidth: OUTLINE_W * strokeScale,
            matrix: note,
        });
        shapes.push({
            id: 'fold',
            d: FOLD_PATH,
            fill: CREAM,
            stroke: OUTLINE,
            strokeWidth: OUTLINE_W * strokeScale,
            matrix: note,
        });
        shapes.push({
            id: 'seal',
            d: HEART_TEMPLATE,
            fill: SEAL,
            matrix: seal,
        });
    }
    return shapes;
}

// ───────────────────────────────────────────────────────────────────────────
// Path parsing + flattening (absolute M / L / C / Z only — every path in this
// file is authored right here, so the subset is complete by construction).
// ───────────────────────────────────────────────────────────────────────────

function parsePath(d) {
    const tokens = d.match(/[MLCZmlcz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
    const subpaths = [];
    let current = null;
    let cx = 0;
    let cy = 0;
    let start = [0, 0];
    let i = 0;
    const num = () => {
        const v = Number(tokens[i++]);
        if (!Number.isFinite(v)) throw new Error(`bad number in path near token ${i}: ${d}`);
        return v;
    };
    while (i < tokens.length) {
        const cmd = tokens[i++];
        switch (cmd) {
            case 'M': {
                cx = num();
                cy = num();
                start = [cx, cy];
                current = { pts: [[cx, cy]], closed: false };
                subpaths.push(current);
                break;
            }
            case 'L': {
                cx = num();
                cy = num();
                current.pts.push([cx, cy]);
                break;
            }
            case 'C': {
                const x1 = num();
                const y1 = num();
                const x2 = num();
                const y2 = num();
                const x = num();
                const y = num();
                flattenCubic(current.pts, cx, cy, x1, y1, x2, y2, x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'Z':
            case 'z': {
                current.closed = true;
                cx = start[0];
                cy = start[1];
                break;
            }
            default:
                throw new Error(`unsupported path command '${cmd}' (subset is M/L/C/Z): ${d}`);
        }
    }
    return subpaths;
}

function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3) {
    // Segment count from the control-polygon length: long curves get more
    // segments, short ones stay cheap. The cap keeps this bounded.
    const len =
        Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.min(96, Math.max(8, Math.ceil(len / 2)));
    for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const e = t * t * t;
        out.push([a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3]);
    }
}

function transformSubpaths(subpaths, m, s) {
    return subpaths.map((sp) => ({
        closed: sp.closed,
        pts: sp.pts.map(([x, y]) => {
            const [tx, ty] = apply(m, x, y);
            return [tx * s, ty * s];
        }),
    }));
}

// ───────────────────────────────────────────────────────────────────────────
// Rasterizer
// ───────────────────────────────────────────────────────────────────────────

const SUBROWS = 5; // vertical supersampling for fills

function fillCoverage(W, H, subpaths) {
    const cov = new Float32Array(W * H);
    const edges = [];
    for (const sp of subpaths) {
        const pts = sp.pts;
        for (let k = 0; k < pts.length; k++) {
            const a = pts[k];
            const b = pts[(k + 1) % pts.length];
            if (k === pts.length - 1 && !sp.closed) {
                // Implicit close: a fill is always a closed region.
                if (a[0] === pts[0][0] && a[1] === pts[0][1]) continue;
            }
            if (a[1] === b[1]) continue;
            edges.push([a[0], a[1], b[0], b[1]]);
        }
    }
    if (edges.length === 0) return cov;

    const weight = 1 / SUBROWS;
    const xs = [];
    for (let sy = 0; sy < H * SUBROWS; sy++) {
        const y = (sy + 0.5) / SUBROWS;
        const row = sy / SUBROWS | 0;
        xs.length = 0;
        for (const [x0, y0, x1, y1] of edges) {
            const yMin = Math.min(y0, y1);
            const yMax = Math.max(y0, y1);
            if (y < yMin || y >= yMax) continue;
            const t = (y - y0) / (y1 - y0);
            xs.push([x0 + t * (x1 - x0), y1 > y0 ? 1 : -1]);
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a[0] - b[0]);
        let winding = 0;
        for (let k = 0; k < xs.length - 1; k++) {
            winding += xs[k][1];
            if (winding !== 0) addSpan(cov, W, row, xs[k][0], xs[k + 1][0], weight);
        }
    }
    return cov;
}

function addSpan(cov, W, row, xa, xb, weight) {
    let a = Math.max(0, xa);
    let b = Math.min(W, xb);
    if (b <= a) return;
    const base = row * W;
    let i0 = Math.floor(a);
    const i1 = Math.floor(b - 1e-9);
    if (i0 === i1) {
        cov[base + i0] += (b - a) * weight;
        return;
    }
    cov[base + i0] += (i0 + 1 - a) * weight;
    for (let i = i0 + 1; i < i1; i++) cov[base + i] += weight;
    cov[base + i1] += (b - i1) * weight;
}

const STROKE_SS = 4; // NxN samples per pixel for stroke edges

function strokeCoverage(W, H, subpaths, width) {
    const cov = new Float32Array(W * H);
    const half = width / 2;
    const pad = half + 1.5;
    const step = 1 / STROKE_SS;
    const samples = STROKE_SS * STROKE_SS;
    for (const sp of subpaths) {
        const pts = sp.pts;
        const last = sp.closed ? pts.length : pts.length - 1;
        for (let k = 0; k < last; k++) {
            const [ax, ay] = pts[k];
            const [bx, by] = pts[(k + 1) % pts.length];
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
            const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + pad));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad));
            const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + pad));
            const dx = bx - ax;
            const dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            for (let py = y0; py <= y1; py++) {
                for (let px = x0; px <= x1; px++) {
                    let hit = 0;
                    for (let sy = 0; sy < STROKE_SS; sy++) {
                        const y = py + (sy + 0.5) * step;
                        for (let sx = 0; sx < STROKE_SS; sx++) {
                            const x = px + (sx + 0.5) * step;
                            let t = lenSq === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / lenSq;
                            t = t < 0 ? 0 : t > 1 ? 1 : t;
                            const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
                            if (d <= half) hit++;
                        }
                    }
                    if (hit === 0) continue;
                    const c = hit / samples;
                    const i = py * W + px;
                    // MAX, not sum: overlapping segments at a join must not
                    // double-darken (round caps already make the join solid).
                    if (c > cov[i]) cov[i] = c;
                }
            }
        }
    }
    return cov;
}

const parseHex = (hex) => {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
    ];
};

/** Straight-alpha "over" compositing into an RGBA float canvas. */
function compositeInto(canvas, cov, hex) {
    const [r, g, b] = parseHex(hex);
    for (let i = 0; i < cov.length; i++) {
        let sa = cov[i];
        if (sa <= 0) continue;
        if (sa > 1) sa = 1;
        const idx = i * 4;
        const da = canvas[idx + 3];
        const outA = sa + da * (1 - sa);
        if (outA <= 0) continue;
        const k = da * (1 - sa);
        canvas[idx] = (r * sa + canvas[idx] * k) / outA;
        canvas[idx + 1] = (g * sa + canvas[idx + 1] * k) / outA;
        canvas[idx + 2] = (b * sa + canvas[idx + 2] * k) / outA;
        canvas[idx + 3] = outA;
    }
}

export function rasterize(shapes, size, designUnits = U) {
    const s = size / designUnits; // design units -> pixels
    const canvas = new Float32Array(size * size * 4);
    for (const shape of shapes) {
        const subpaths = transformSubpaths(parsePath(shape.d), shape.matrix, s);
        if (shape.fill) compositeInto(canvas, fillCoverage(size, size, subpaths), shape.fill);
        if (shape.stroke) {
            compositeInto(
                canvas,
                strokeCoverage(size, size, subpaths, shape.strokeWidth * s),
                shape.stroke
            );
        }
    }
    return canvas;
}

// ───────────────────────────────────────────────────────────────────────────
// PNG encoding (node:zlib only). Opaque assets are written as truecolor RGB so
// the iOS icon carries no alpha channel, which App Store validation dislikes.
// ───────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

export function encodePng(canvas, size, { opaque, flatten = CREAM }) {
    const channels = opaque ? 3 : 4;
    const stride = size * channels;
    const raw = Buffer.alloc((stride + 1) * size);
    const q = (v) => {
        const n = Math.round(v * 255);
        return n < 0 ? 0 : n > 255 ? 255 : n;
    };
    for (let y = 0; y < size; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter type 0 (None) — keeps this trivially verifiable
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const o = rowStart + 1 + x * channels;
            if (opaque) {
                // Flatten onto the cream page: an opaque asset is fully covered
                // by its background rect anyway, so this only guards rounding.
                const a = canvas[i + 3];
                const bgc = parseHex(flatten);
                raw[o] = q(canvas[i] * a + bgc[0] * (1 - a));
                raw[o + 1] = q(canvas[i + 1] * a + bgc[1] * (1 - a));
                raw[o + 2] = q(canvas[i + 2] * a + bgc[2] * (1 - a));
            } else {
                raw[o] = q(canvas[i]);
                raw[o + 1] = q(canvas[i + 1]);
                raw[o + 2] = q(canvas[i + 2]);
                raw[o + 3] = q(canvas[i + 3]);
            }
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = opaque ? 2 : 6; // color type: 2 = RGB, 6 = RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ───────────────────────────────────────────────────────────────────────────
// SVG emission — same shapes, same matrices.
// ───────────────────────────────────────────────────────────────────────────

function toSvg(shapes, { title }) {
    const body = shapes
        .map((s) => {
            const attrs = [
                `d="${s.d}"`,
                s.fill ? `fill="${s.fill}"` : 'fill="none"',
                s.stroke ? `stroke="${s.stroke}"` : null,
                s.stroke ? `stroke-width="${fmt(s.strokeWidth)}"` : null,
                s.stroke ? 'stroke-linejoin="round"' : null,
                s.stroke ? 'stroke-linecap="round"' : null,
                s.matrix === IDENT ? null : `transform="${matrixAttr(s.matrix)}"`,
            ].filter(Boolean);
            return `  <path id="${s.id}" ${attrs.join(' ')}/>`;
        })
        .join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${U}" height="${U}" viewBox="0 0 ${U} ${U}">
  <title>${title}</title>
  <!-- Generated by scripts/render_brand_assets.mjs — edit the geometry there, not here. -->
${body}
</svg>
`;
}

// ───────────────────────────────────────────────────────────────────────────
// Assets
// ───────────────────────────────────────────────────────────────────────────

const ASSETS = [
    {
        svg: 'assets/brand/icon.svg',
        png: 'assets/icon.png',
        size: 1024,
        opaque: true,
        title: 'Sealed note — app icon',
        shapes: { bg: true, mark: 1 },
    },
    {
        svg: 'assets/brand/adaptive-icon-foreground.svg',
        png: 'assets/adaptive-icon.png',
        size: 1024,
        opaque: false,
        title: 'Sealed note — Android adaptive foreground',
        shapes: { bg: false, mark: 0.78 },
    },
    {
        svg: 'assets/brand/adaptive-icon-background.svg',
        png: null, // Android takes the background as a flat color from app.config.ts
        size: 1024,
        opaque: true,
        title: 'Sealed note — Android adaptive background',
        shapes: { bg: true, mark: null },
    },
    {
        svg: 'assets/brand/splash-icon.svg',
        png: 'assets/splash-icon.png',
        size: 1024,
        opaque: false,
        title: 'Sealed note — splash mark',
        shapes: { bg: false, mark: 0.85 },
    },
    {
        svg: 'assets/brand/favicon.svg',
        png: 'assets/favicon.png',
        size: 256,
        opaque: true,
        title: 'Sealed note — web favicon',
        shapes: { bg: true, mark: 1 },
    },
];

/** Coarse ASCII thumbnail so a render can be sanity-checked from a terminal. */
export function asciiPreview(canvas, size, cols = 36) {
    const ramp = ' .:-=+*#%@';
    const cell = size / cols;
    const lines = [];
    for (let r = 0; r < cols; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
            let sum = 0;
            let n = 0;
            for (let y = Math.floor(r * cell); y < Math.floor((r + 1) * cell); y += 4) {
                for (let x = Math.floor(c * cell); x < Math.floor((c + 1) * cell); x += 4) {
                    const i = (y * size + x) * 4;
                    const a = canvas[i + 3];
                    const lum = (0.2126 * canvas[i] + 0.7152 * canvas[i + 1] + 0.0722 * canvas[i + 2]) * a + (1 - a);
                    sum += lum;
                    n++;
                }
            }
            const lum = n ? sum / n : 1;
            line += ramp[Math.min(ramp.length - 1, Math.max(0, Math.round((1 - lum) * (ramp.length - 1))))];
        }
        lines.push(line);
    }
    return lines.join('\n');
}

function main() {
    mkdirSync(join(ROOT, 'assets/brand'), { recursive: true });
    for (const asset of ASSETS) {
        const shapes = buildShapes(asset.shapes);
        const svg = toSvg(shapes, { title: asset.title });
        if (!CHECK_ONLY) writeFileSync(join(ROOT, asset.svg), svg, 'utf8');
        let note = `${asset.svg} (${svg.length} B)`;
        if (asset.png) {
            const canvas = rasterize(shapes, asset.size);
            const png = encodePng(canvas, asset.size, { opaque: asset.opaque });
            if (!CHECK_ONLY) writeFileSync(join(ROOT, asset.png), png);
            note += ` -> ${asset.png} ${asset.size}x${asset.size} ${asset.opaque ? 'RGB' : 'RGBA'} (${png.length} B)`;
            if (process.argv.includes('--preview') && asset.png === 'assets/icon.png') {
                console.log(asciiPreview(canvas, asset.size));
            }
        }
        console.log(`${CHECK_ONLY ? 'check' : 'wrote'}: ${note}`);
    }
}

// Running the file writes the assets; importing it (see the verification
// scratch scripts) just gives you the rasterizer.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
