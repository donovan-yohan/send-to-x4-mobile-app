/**
 * frame_encoder — composed RGBA -> Xteink X3 love-note frame (52272 bytes).
 *
 * PURE TypeScript. Zero React Native imports, zero npm imports, no I/O — so the
 * node test runner can import it directly (`node --import tsx --test`) and so
 * the exact same code path runs on device and in CI.
 *
 * ---------------------------------------------------------------------------
 * PIPELINE
 * ---------------------------------------------------------------------------
 *   RGBA compose canvas (top-down, 4 B/px) — 528x792 portrait, or 792x528
 *   landscape when rotation is 'none'
 *     -> luma (Rec.601, alpha composited over WHITE paper)
 *     -> optional gentle percentile autocontrast
 *     -> 1-bit  (photo = Floyd-Steinberg serpentine dither | graphic = threshold)
 *     -> previewRgba  <-- BRANCHES OFF HERE, still in COMPOSE space, unrotated
 *     -> map into the 792x528 landscape buffer:
 *          'ccw' (default) / 'cw' = 90 deg rotation of a portrait canvas
 *          'none'                 = IDENTITY; the canvas already is the buffer
 *     -> STRAIGHT (unmirrored) MSB-first bit packing -> 52272 bytes
 *
 * The rotation DECIDES the accepted canvas size — 'cw'/'ccw' take 528x792,
 * 'none' takes 792x528 — and a mismatch throws. There is no rotation that
 * accepts both, so an orientation toggle cannot ship a sideways frame.
 *
 * ---------------------------------------------------------------------------
 * PANEL CONTRACT — HARDWARE-PROVEN 2026-07-28 (physical X3)
 * ---------------------------------------------------------------------------
 *   Frame     : exactly 52272 bytes = 528 rows x 99 bytes, raw, no header.
 *   Bits      : MSB-first; stored bit index j runs 0..791 across a row.
 *   NO MIRROR : stored bit j IS panel pixel x = j. The firmware raw-blits the
 *               buffer with no horizontal flip. Frames packed with the earlier
 *               `j = 791 - x` mirror rendered MIRRORED on the panel; re-packed
 *               straight, they rendered correct.
 *   Polarity  : 1 = WHITE, 0 = BLACK. Row 0 = landscape-TOP.
 *   Rotation  : COUNTER-CLOCKWISE is upright for a PORTRAIT canvas. The 'cw'
 *               variant rendered exactly 180 degrees off, and
 *               CW(src) == rot180(CCW(src)) by construction. A LANDSCAPE canvas
 *               needs no rotation at all ('none') — that is variant A of
 *               `make_test_frame.mjs`, the frame that proved the no-mirror
 *               finding on the same hardware run.
 *
 * The caller does ALL resizing/cropping/letterboxing. This module only accepts
 * an exactly-sized buffer for the requested rotation and throws otherwise: a
 * silently rescaled frame is worse than a loud error, because the device renders
 * whatever it is given and a wrong-geometry frame looks like a hardware fault.
 *
 * ---------------------------------------------------------------------------
 * WHY previewRgba IS TAKEN BEFORE ROTATION
 * ---------------------------------------------------------------------------
 * The Compose UI shows the note the way the user authored it (in compose space,
 * reading left-to-right). The rotation is a transport detail of the panel
 * buffer, not something the user should ever see. Taking the preview before it
 * also means
 * the preview is a faithful picture of the DITHER — the one thing that actually
 * surprises people about e-ink — with no chance of a preview-only inverse-map
 * bug hiding a packing bug.
 *
 * The bit-level geometry (straight column order, MSB-first order, rotation
 * formulas) is byte-identical to `scripts/make_test_frame.mjs`, the M1 reference
 * packer. `scripts/frame-encoder.test.js` cross-validates the two
 * implementations byte-for-byte; do not "clean up" the index arithmetic below
 * without re-running it.
 */

import {
    COMPOSE_H,
    COMPOSE_W,
    DEFAULT_FRAME_ROTATION,
    PANEL_H,
    PANEL_W,
    ROW_BYTES,
    X3_FRAME_BYTES,
    X_MIRROR,
    type FrameRotation,
} from '../device/x3';

export type { FrameRotation };

/**
 * How continuous tone becomes 1 bit.
 *
 *   'photo'   Floyd-Steinberg serpentine dither. Preserves apparent gradients
 *             (faces, skies) at the cost of grain. Default.
 *   'graphic' Fixed threshold. Crisp edges for text, doodles and line art,
 *             where dither grain reads as noise/artefacting on e-ink.
 */
export type FrameMode = 'photo' | 'graphic';

export interface EncodeFrameOptions {
    /** Halftone strategy. Default 'photo'. */
    mode?: FrameMode;
    /**
     * Compose -> landscape mapping. Default `DEFAULT_FRAME_ROTATION` = 'ccw',
     * the direction proven upright on hardware 2026-07-28 for a PORTRAIT canvas.
     * 'cw' stays selectable for diagnosis; it renders 180 degrees off. 'none' is
     * the identity and REQUIRES a 792x528 landscape canvas — it is what a
     * landscape-composed note uses.
     *
     * This option and the (width, height) arguments must agree; see
     * {@link encodeFrame}.
     */
    rotation?: FrameRotation;
    /** Gentle percentile contrast stretch before halftoning. Default true. */
    autocontrast?: boolean;
    /**
     * Luma cut in 0..255; values >= threshold become WHITE. Default 128.
     * Used by 'graphic' directly and by 'photo' as the dither quantizer's
     * decision point.
     */
    threshold?: number;
}

export interface EncodedFrame {
    /** Exactly X3_FRAME_BYTES, ready for `sendLoveNoteFrame`. */
    frame: Uint8Array;
    /**
     * The COMPOSE-space canvas, pure black/white, alpha 255 — 528x792 for
     * 'cw'/'ccw', 792x528 for 'none'. Same dimensions as the (width, height)
     * passed in, always.
     */
    previewRgba: Uint8Array;
}

/** Luma cut used when `opts.threshold` is omitted. */
export const DEFAULT_THRESHOLD = 128;

/** Fraction of pixels clipped at EACH end by the autocontrast stretch (0.5 %). */
const AUTOCONTRAST_CLIP = 0.005;

/**
 * Minimum post-clip luma span before autocontrast will stretch at all.
 * Below this the image is effectively flat (a blank canvas, a solid colour
 * fill), and stretching would amplify sensor/JPEG noise into full-contrast
 * garbage. Skipping is the safe identity.
 */
const AUTOCONTRAST_MIN_RANGE = 8;

const BW_WHITE = 1;
const BW_BLACK = 0;

/**
 * The compose canvas a given rotation consumes.
 *
 * The rotation and the canvas size are ONE fact, not two: a 90-degree map only
 * makes sense from 528x792, and the identity only makes sense from 792x528.
 * Deriving the expected size from the rotation here — rather than trusting two
 * independent arguments to agree — is what makes the mismatch a caught error
 * instead of a sideways frame on someone's reader.
 */
function canvasDimsForRotation(rotation: FrameRotation): {
    width: number;
    height: number;
    label: string;
} {
    return rotation === 'none'
        ? { width: PANEL_W, height: PANEL_H, label: 'landscape' }
        : { width: COMPOSE_W, height: COMPOSE_H, label: 'portrait' };
}

/**
 * Encode a composed RGBA buffer into a device love-note frame.
 *
 * THROWS on a geometry mismatch — that is a programmer error in the caller's
 * resize step, not a runtime condition to be recovered from. (Contrast with
 * `sendLoveNoteFrame`, which never throws because transport failure IS a
 * runtime condition.)
 *
 * The accepted canvas DEPENDS ON `opts.rotation`:
 *   'ccw' (default) / 'cw' -> COMPOSE_W x COMPOSE_H  (528x792, portrait)
 *   'none'                 -> PANEL_W   x PANEL_H    (792x528, landscape)
 * Both are 1672704 RGBA bytes — the two canvases are transposes of each other —
 * so the byte count alone can NEVER catch a swapped orientation. The width and
 * height are checked first and separately for exactly that reason.
 *
 * @param rgba   width * height * 4 bytes, top-down RGBA.
 * @param width  Must equal the rotation's canvas width. Passed explicitly so a
 *               caller that thinks it has different dimensions fails loudly.
 * @param height Must equal the rotation's canvas height.
 */
export function encodeFrame(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: EncodeFrameOptions = {}
): EncodedFrame {
    const mode: FrameMode = opts.mode ?? 'photo';
    const rotation: FrameRotation = opts.rotation ?? DEFAULT_FRAME_ROTATION;
    const useAutocontrast = opts.autocontrast ?? true;
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

    const canvas = canvasDimsForRotation(rotation);
    if (width !== canvas.width || height !== canvas.height) {
        throw new Error(
            `encodeFrame with rotation '${rotation}' expects a ` +
            `${canvas.width}x${canvas.height} ${canvas.label} canvas, got ${width}x${height}`
        );
    }
    const expectedBytes = canvas.width * canvas.height * 4;
    if (rgba.length !== expectedBytes) {
        throw new Error(
            `encodeFrame expects ${expectedBytes} RGBA bytes ` +
            `(${canvas.width}x${canvas.height}x4), got ${rgba.length}`
        );
    }

    const lum = toLuma(rgba);
    if (useAutocontrast) applyAutocontrast(lum);

    const bw =
        mode === 'graphic'
            ? thresholdToBilevel(lum, threshold)
            : ditherToBilevel(lum, threshold, canvas.width, canvas.height);

    // Preview branches off here: compose space, unrotated.
    const previewRgba = renderPreview(bw);

    const landscape = rotateToLandscape(bw, rotation);
    const frame = packLandscape(landscape);

    return { frame, previewRgba };
}

// ---------------------------------------------------------------------------
// Stage 1 — RGBA -> luma
// ---------------------------------------------------------------------------

/**
 * Rec.601 luma, kept as float32 so the dither's error diffusion is not
 * quantized twice.
 *
 * Alpha is composited over WHITE, not over black and not ignored: the panel is
 * white paper, so a transparent region of a PNG sticker or a captured canvas
 * must read as paper. Compositing over black would ring every transparent edge
 * with ink.
 */
function toLuma(rgba: Uint8Array): Float32Array {
    const n = rgba.length >> 2;
    const lum = new Float32Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        let r = rgba[o];
        let g = rgba[o + 1];
        let b = rgba[o + 2];
        const a = rgba[o + 3];
        if (a !== 255) {
            const af = a / 255;
            const inv = 255 * (1 - af);
            r = r * af + inv;
            g = g * af + inv;
            b = b * af + inv;
        }
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return lum;
}

// ---------------------------------------------------------------------------
// Stage 2 — autocontrast
// ---------------------------------------------------------------------------

/**
 * Gentle percentile stretch, in place.
 *
 * Maps the 0.5th percentile to 0 and the 99.5th to 255, so a handful of
 * specular highlights or crushed shadows cannot pin the range (which a plain
 * min/max stretch would let them do). Photos off a phone camera are routinely
 * squeezed into ~[40,200] and look muddy after a 1-bit reduction without this.
 *
 * No-ops on a flat image (see AUTOCONTRAST_MIN_RANGE) rather than dividing by a
 * near-zero span.
 */
function applyAutocontrast(lum: Float32Array): void {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < lum.length; i++) {
        histogram[clamp255(Math.round(lum[i]))]++;
    }

    const clip = Math.floor(lum.length * AUTOCONTRAST_CLIP);

    let lo = 0;
    let acc = 0;
    for (; lo < 255; lo++) {
        acc += histogram[lo];
        if (acc > clip) break;
    }

    let hi = 255;
    acc = 0;
    for (; hi > 0; hi--) {
        acc += histogram[hi];
        if (acc > clip) break;
    }

    if (hi - lo < AUTOCONTRAST_MIN_RANGE) return;

    const scale = 255 / (hi - lo);
    for (let i = 0; i < lum.length; i++) {
        const v = (lum[i] - lo) * scale;
        lum[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
}

function clamp255(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ---------------------------------------------------------------------------
// Stage 3 — luma -> 1 bit (portrait, 1 byte per pixel: 1 = white, 0 = black)
// ---------------------------------------------------------------------------

/** 'graphic': hard cut. Deterministic, edge-preserving, no grain. */
function thresholdToBilevel(lum: Float32Array, threshold: number): Uint8Array {
    const bw = new Uint8Array(lum.length);
    for (let i = 0; i < lum.length; i++) {
        bw[i] = lum[i] >= threshold ? BW_WHITE : BW_BLACK;
    }
    return bw;
}

/**
 * 'photo': Floyd-Steinberg with SERPENTINE scanning, in place over `lum`.
 *
 * Serpentine (alternating row direction) rather than always-left-to-right: it
 * cancels the directional error smear that otherwise shows up as diagonal
 * "worms" across large flat areas, which is exactly what a note's background
 * is. Weights are the classic 7/3/5/1 sixteenths, mirrored on right-to-left
 * rows so the error always travels AHEAD of the scan.
 *
 * Fully deterministic: no randomness, no time or platform dependence, so the
 * same RGBA in always yields the same frame out.
 *
 * Runs in COMPOSE space, so a landscape note diffuses error along the rows the
 * user actually authored. Dithering in panel space instead would make the grain
 * pattern depend on a transport detail.
 */
function ditherToBilevel(
    lum: Float32Array,
    threshold: number,
    w: number,
    h: number
): Uint8Array {
    const bw = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
        const rowBase = y * w;
        const nextBase = rowBase + w;
        const hasNextRow = y + 1 < h;
        const leftToRight = (y & 1) === 0;
        const step = leftToRight ? 1 : -1;
        const xStart = leftToRight ? 0 : w - 1;
        const xEnd = leftToRight ? w : -1;

        for (let x = xStart; x !== xEnd; x += step) {
            const i = rowBase + x;
            const old = lum[i];
            const isWhite = old >= threshold;
            bw[i] = isWhite ? BW_WHITE : BW_BLACK;

            const err = old - (isWhite ? 255 : 0);
            if (err === 0) continue;

            const ahead = x + step;   // next pixel in scan order
            const behind = x - step;  // already-emitted pixel
            const aheadInRow = ahead >= 0 && ahead < w;
            const behindInRow = behind >= 0 && behind < w;

            if (aheadInRow) lum[rowBase + ahead] += err * (7 / 16);
            if (hasNextRow) {
                if (behindInRow) lum[nextBase + behind] += err * (3 / 16);
                lum[nextBase + x] += err * (5 / 16);
                if (aheadInRow) lum[nextBase + ahead] += err * (1 / 16);
            }
        }
    }

    return bw;
}

// ---------------------------------------------------------------------------
// Stage 4 — preview (portrait, pre-rotation)
// ---------------------------------------------------------------------------

/** 1-bit portrait bitmap -> opaque black/white RGBA for the Compose UI. */
function renderPreview(bw: Uint8Array): Uint8Array {
    const out = new Uint8Array(bw.length * 4);
    for (let i = 0, o = 0; i < bw.length; i++, o += 4) {
        const v = bw[i] === BW_WHITE ? 255 : 0;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Stage 5 — compose canvas -> landscape 792x528 panel buffer
// ---------------------------------------------------------------------------

/**
 * All three maps are exact bijections over the integer grid — no interpolation,
 * no holes — because the portrait and landscape index ranges line up 1:1
 * (ly in 0..527 <-> px in 0..527; lx in 0..791 <-> py in 0..791). The rotations
 * are written as INVERSE maps applied per destination pixel, which is what makes
 * that property structural instead of accidental.
 *
 * 'ccw' is the hardware-proven upright direction for a portrait canvas
 * (2026-07-28); 'cw' is its 180-degree rotation and is kept only so the
 * direction remains a one-line switch. 'none' is the identity, for a canvas
 * authored at panel size — it is `make_test_frame.mjs` variant A's mapping, and
 * variant A is a frame that was photographed on the real panel. THIS IS THE ONLY
 * SWITCH POINT — everything downstream is mapping-agnostic.
 *
 * These loops must stay byte-identical to `landscapeFromPortraitCW` /
 * `landscapeFromPortraitCCW` / `landscapeFromLandscape` in
 * scripts/make_test_frame.mjs.
 *
 * The identity branch RETURNS `bw` ITSELF rather than copying: it is a private,
 * freshly allocated buffer that only `packLandscape` reads, and it is already
 * exactly PANEL_W x PANEL_H (encodeFrame refuses any other size for 'none').
 */
function rotateToLandscape(bw: Uint8Array, rotation: FrameRotation): Uint8Array {
    if (rotation === 'none') return bw;

    const land = new Uint8Array(PANEL_W * PANEL_H);

    if (rotation === 'cw') {
        // forward: lx = 791 - py, ly = px   inverse: px = ly, py = 791 - lx
        for (let ly = 0; ly < PANEL_H; ly++) {
            const px = ly;
            const dstBase = ly * PANEL_W;
            for (let lx = 0; lx < PANEL_W; lx++) {
                const py = PANEL_W - 1 - lx;
                land[dstBase + lx] = bw[py * COMPOSE_W + px];
            }
        }
    } else {
        // forward: lx = py, ly = 527 - px   inverse: py = lx, px = 527 - ly
        for (let ly = 0; ly < PANEL_H; ly++) {
            const px = PANEL_H - 1 - ly;
            const dstBase = ly * PANEL_W;
            for (let lx = 0; lx < PANEL_W; lx++) {
                land[dstBase + lx] = bw[lx * COMPOSE_W + px];
            }
        }
    }

    return land;
}

// ---------------------------------------------------------------------------
// Stage 6 — pack (STRAIGHT: stored bit j = panel x, no mirror)
// ---------------------------------------------------------------------------

/**
 * Landscape 1-bit bitmap -> the 52272-byte device frame.
 *
 * For panel pixel (x, y):  j    = x                  (NO MIRROR)
 *                          byte = y * 99 + (j >> 3)
 *                          bit  = 7 - (j & 7)        (MSB-first)
 *                          1 = white, 0 = black
 *
 * Panel x = 0 is therefore the MSB of byte 0 of the row, and panel x = 791 is
 * the LSB of byte 98. Proven on hardware 2026-07-28: the firmware raw-blits
 * with no horizontal flip, so a mirrored pack renders backwards.
 *
 * `X_MIRROR` (false) is READ here rather than assumed, so the constant in
 * `src/device/x3.ts` actually governs the bytes: someone flipping it to
 * reproduce the legacy packing gets legacy bytes and a red test, instead of
 * identical output and a wrong conclusion about where the geometry lives. It is
 * a compile-time constant, so the branch costs nothing at runtime. Note this is
 * a DIAGNOSTIC lever, not a supported mode — `scripts/make_test_frame.mjs
 * --mirror` is the way to produce a mirrored frame on purpose.
 *
 * Starts all-zero (= all black) and sets white bits, matching the reference
 * packer exactly. A pack/unpack round trip CANNOT catch a flipped column order
 * — it passes just as happily with the direction inverted — so the direction is
 * pinned by hand-computed raw-byte assertions in the test, not here.
 */
function packLandscape(landscape: Uint8Array): Uint8Array {
    const out = new Uint8Array(X3_FRAME_BYTES);
    for (let ly = 0; ly < PANEL_H; ly++) {
        const rowBase = ly * ROW_BYTES;
        const pixBase = ly * PANEL_W;
        for (let lx = 0; lx < PANEL_W; lx++) {
            if (landscape[pixBase + lx] !== BW_WHITE) continue;
            const j = X_MIRROR ? PANEL_W - 1 - lx : lx;
            out[rowBase + (j >> 3)] |= 0x80 >> (j & 7);
        }
    }
    return out;
}

// Re-exported so callers and tests have one import for the whole contract.
export {
    COMPOSE_W,
    COMPOSE_H,
    PANEL_W,
    PANEL_H,
    ROW_BYTES,
    X3_FRAME_BYTES,
    DEFAULT_FRAME_ROTATION,
};
