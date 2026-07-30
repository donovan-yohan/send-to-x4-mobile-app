/**
 * image_geometry — the pure half of the image front-end.
 *
 * PURE TypeScript. Zero React Native imports, zero npm imports, no I/O — same
 * discipline as `frame_encoder.ts` / `wallpaper_encoder.ts`, and for the same
 * reason: the node test runner can import it directly (`node --import tsx
 * --test`), so the fit/crop/resample arithmetic that decides whether a frame is
 * the exact size the packer demands is covered by CI instead of by inspection.
 *
 * `image_converter.ts` is the impure wrapper: it owns expo-image-manipulator and
 * upng-js, and calls into here for every decision about pixels and rectangles.
 *
 * Nothing in this file hard-codes panel geometry — callers pass targets in,
 * sourced from `src/device/x3.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How a source image is mapped onto a fixed target rectangle.
 *
 *   'cover' Scale until BOTH axes are covered, then centre-crop the overflow.
 *           Fills the panel, loses the edges. The historical behaviour and the
 *           default, because a note with white bars reads as broken on e-ink
 *           far more often than a slightly cropped one does.
 *   'fit'   Scale until the WHOLE image is inside the target, then centre it on
 *           a WHITE canvas (letterbox / pillarbox). Keeps every pixel. White,
 *           not black, because the panel is white paper — black bars would burn
 *           a full frame of ink on every send.
 */
export type FitMode = 'cover' | 'fit';

export interface ImageSize {
    width: number;
    height: number;
}

/**
 * Structural mirrors of expo-image-manipulator's `ActionResize` / `ActionCrop`.
 *
 * Declared locally rather than imported so this module keeps zero third-party
 * imports; they are assignable to the real `Action` union at the call site in
 * `image_converter.ts`, and `tsc` checks that assignment on every build.
 */
export type ResizeAction = { resize: { width?: number; height?: number } };
export type CropAction = {
    crop: { originX: number; originY: number; width: number; height: number };
};
export type GeometryAction = ResizeAction | CropAction;

// ---------------------------------------------------------------------------
// Target sizing
// ---------------------------------------------------------------------------

/**
 * Long side -> full target size at the source's aspect ratio.
 *
 * Used by the wallpaper path, which does not crop: the firmware's sleep-cover
 * settings do the final fit to the panel, so the app hands over the whole
 * picture at roughly 2x panel resolution.
 */
export function naturalTarget(source: ImageSize, longSide: number): ImageSize {
    if (source.width >= source.height) {
        return {
            width: longSide,
            height: Math.max(1, Math.round((source.height * longSide) / source.width)),
        };
    }
    return {
        width: Math.max(1, Math.round((source.width * longSide) / source.height)),
        height: longSide,
    };
}

/**
 * Pre-frame box for the wallpaper path's 'panel' framing: THE SCREEN'S OWN BOX.
 *
 * Not `naturalTarget(screen, someLargerLongSide)`. Once the APP has decided the
 * crop — which is the whole point of 'panel' framing — extra resolution is not
 * headroom, it is damage:
 *
 *   - `drawBitmap` NEVER upscales (`isScaled = fitScale < 1.0f`,
 *     GfxRenderer.cpp:1283-1286), so nothing is gained by overshooting;
 *   - its downscale is a nearest-neighbour SCATTER with a per-plane OR
 *     (GfxRenderer.cpp:1330-1351), so several source pixels landing on one panel
 *     pixel means INK WINS. Measured on a photo-like fixture whose mean gray is
 *     unchanged by the resample (132.8 -> 132.9): uploading 704x1056 renders at
 *     mean panel luminance 189.4, while the same picture area-averaged to
 *     528x792 by {@link conformRgba} first renders at 197.3 — with 33k pixels
 *     pushed out of white into light gray. `scripts/panel-render.test.js` pins
 *     the direction;
 *   - at the screen's own size the firmware's geometry is scale = 1, x = 0,
 *     y = 0 in BOTH sleep-cover modes, so the app's preview is exact rather than
 *     approximate, and the BMP is 44% smaller.
 *
 * `longSide` is an escape hatch, not the normal path: pass it only to deliberately
 * hand the firmware a larger bitmap (and its scatter with it).
 */
export function panelFramingTarget(screen: ImageSize, longSide?: number | null): ImageSize {
    assertPositiveInt('screen.width', screen.width);
    assertPositiveInt('screen.height', screen.height);
    if (longSide === undefined || longSide === null) {
        return { width: screen.width, height: screen.height };
    }
    return naturalTarget(screen, longSide);
}

// ---------------------------------------------------------------------------
// Native resize/crop plans
// ---------------------------------------------------------------------------

/** Dispatch to the cover or fit plan for a fixed target rectangle. */
export function buildFrameActions(
    targetW: number,
    targetH: number,
    fit: FitMode,
    source: ImageSize | null
): GeometryAction[] {
    return fit === 'fit'
        ? buildFitActions(targetW, targetH, source)
        : buildCoverCropActions(targetW, targetH, source);
}

/**
 * Cover: scale so both dimensions are at least the target, then centre-crop.
 *
 * The free axis of the resize is predicted with FLOOR, not round, because that
 * is what the native resizer does: expo-image-manipulator's Android
 * `ResizeTransformer` computes the unconstrained side as `(w / imageRatio)
 * .toInt()`, and `toInt()` truncates. Predicting with `Math.round` overshoots
 * the real bitmap by one pixel whenever the exact scaled dimension has a
 * fractional part >= 0.5 (e.g. 217x325 -> 528.68 px wide: rounds to 529,
 * truncates to 528).
 *
 * That one pixel is not survivable. `CropTransformer` only guards
 * `w <= bw && h <= bh && x <= bw && y <= bh` — it never checks `x + w <= bw` —
 * so an overshooting rect passes validation and `Bitmap.createBitmap` throws an
 * uncaught `IllegalArgumentException`. Clamping the SIZE alone cannot help
 * either, because it clamps against the predicted width, not the real one; the
 * ORIGIN has to be clamped too, which is what `originX`/`originY` below do.
 *
 * Predicting low is safe in a way predicting high is not: a 1 px shortfall is
 * absorbed by {@link conformRgba}, and in practice there is none — floor never
 * yields a smaller crop rect than the old round-based math over a full sweep of
 * source aspect ratios at any of the three targets in play: the 528x792 portrait
 * frame, its 792x528 landscape twin, or the 528x792 wallpaper sleep screen
 * ({@link panelFramingTarget} — portrait, and the same box as the portrait
 * frame; it was 1056x704 landscape when this note was written, which is exactly
 * the class of stale number that caused the landscape-preview bug).
 *
 * With no source size we resize to the exact target, which may stretch. That is
 * the historical fallback, kept so behaviour does not change when a size probe
 * fails.
 */
export function buildCoverCropActions(
    targetW: number,
    targetH: number,
    source: ImageSize | null
): GeometryAction[] {
    if (!source) {
        return [{ resize: { width: targetW, height: targetH } }];
    }

    const targetRatio = targetW / targetH;
    const sourceRatio = source.width / source.height;

    if (sourceRatio > targetRatio) {
        // Source is wider -> resize by height, crop width. Height comes out
        // exact (it is the constrained axis); width is the truncated one.
        const scaledWidth = Math.max(1, Math.floor((source.width * targetH) / source.height));
        const cropW = Math.min(targetW, scaledWidth);
        const originX = Math.max(
            0,
            Math.min(Math.round((scaledWidth - cropW) / 2), scaledWidth - cropW)
        );

        return [
            { resize: { height: targetH } },
            {
                crop: {
                    originX,
                    originY: 0,
                    width: cropW,
                    height: targetH,
                },
            },
        ];
    }

    // Source is taller (or exact) -> resize by width, crop height. Width comes
    // out exact; height is the truncated one.
    const scaledHeight = Math.max(1, Math.floor((source.height * targetW) / source.width));
    const cropH = Math.min(targetH, scaledHeight);
    const originY = Math.max(
        0,
        Math.min(Math.round((scaledHeight - cropH) / 2), scaledHeight - cropH)
    );

    return [
        { resize: { width: targetW } },
        {
            crop: {
                originX: 0,
                originY,
                width: targetW,
                height: cropH,
            },
        },
    ];
}

/**
 * Fit: scale so the whole image lands inside the target. No crop — the white
 * padding is added by {@link conformRgba}, because expo-image-manipulator's
 * `extent` action (the only one that can GROW a canvas) is web-only.
 */
export function buildFitActions(
    targetW: number,
    targetH: number,
    source: ImageSize | null
): GeometryAction[] {
    if (!source) {
        // Nothing to letterbox against; degrade to the cover fallback rather
        // than inventing an aspect ratio.
        return [{ resize: { width: targetW, height: targetH } }];
    }

    const targetRatio = targetW / targetH;
    const sourceRatio = source.width / source.height;

    // Wider than the target -> width is the binding constraint (bars top/bottom).
    return sourceRatio > targetRatio
        ? [{ resize: { width: targetW } }]
        : [{ resize: { height: targetH } }];
}

// ---------------------------------------------------------------------------
// Exact conform (cover-crop / white letterbox, in JS)
// ---------------------------------------------------------------------------

/**
 * Map a decoded RGBA buffer onto an EXACTLY dstW x dstH RGBA canvas.
 *
 * WHY THIS EXISTS: `encodeFrame` throws on a geometry mismatch, deliberately.
 * The native resize is a platform call whose rounding differs across devices,
 * its crop rect can come back a pixel short, and the size a caller passes in is
 * not always the size the decoder produces (EXIF-rotated JPEGs). Making the
 * final geometry a property of this pure function means the packers keep their
 * strict contracts and a 1 px platform difference cannot fail a send.
 *
 * Identity fast path (returns the input buffer, no copy) when the sizes already
 * match — the normal case, since the native plan has usually done the work.
 *
 * 'cover' stretches a centred source rectangle over the whole canvas; 'fit'
 * places the whole source in a centred destination rectangle on a WHITE canvas.
 * Both go through the same area-averaging resampler.
 */
export function conformRgba(
    src: Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    fit: FitMode
): Uint8Array {
    assertPositiveInt('srcW', srcW);
    assertPositiveInt('srcH', srcH);
    assertPositiveInt('dstW', dstW);
    assertPositiveInt('dstH', dstH);

    const expected = srcW * srcH * 4;
    if (src.length !== expected) {
        throw new Error(
            `conformRgba expects ${expected} RGBA bytes (${srcW}x${srcH}x4), got ${src.length}`
        );
    }

    if (srcW === dstW && srcH === dstH) return src;

    const dst = new Uint8Array(dstW * dstH * 4);
    dst.fill(255); // white paper, and opaque

    if (fit === 'fit') {
        const scale = Math.min(dstW / srcW, dstH / srcH);
        const boxW = clampInt(Math.round(srcW * scale), 1, dstW);
        const boxH = clampInt(Math.round(srcH * scale), 1, dstH);
        resampleInto(
            src, srcW, srcH,
            0, 0, srcW, srcH,
            dst, dstW,
            Math.floor((dstW - boxW) / 2), Math.floor((dstH - boxH) / 2), boxW, boxH
        );
        return dst;
    }

    // 'cover': the largest centred source rect carrying the destination aspect.
    const scale = Math.max(dstW / srcW, dstH / srcH);
    const rectW = Math.min(srcW, dstW / scale);
    const rectH = Math.min(srcH, dstH / scale);
    resampleInto(
        src, srcW, srcH,
        (srcW - rectW) / 2, (srcH - rectH) / 2, rectW, rectH,
        dst, dstW,
        0, 0, dstW, dstH
    );
    return dst;
}

/**
 * Area-average resample of a (possibly fractional) source rectangle into an
 * integer destination rectangle.
 *
 * Box filter rather than nearest-neighbour: on a genuine downscale — what
 * happens whenever the size probe failed and the native plan could not pre-size
 * — point sampling aliases, and Floyd-Steinberg turns aliasing into speckle
 * that reads as a broken panel. When the footprint is under one pixel the inner
 * loop degenerates to a single sample, so upscales and the near-identity case
 * cost nothing extra.
 *
 * Averaging is ALPHA-WEIGHTED (premultiply, average, un-premultiply) so a
 * transparent PNG edge cannot drag whatever RGB sits under it into the visible
 * pixels.
 */
function resampleInto(
    src: Uint8Array,
    srcW: number,
    srcH: number,
    sx0: number,
    sy0: number,
    sw: number,
    sh: number,
    dst: Uint8Array,
    dstW: number,
    dx0: number,
    dy0: number,
    dw: number,
    dh: number
): void {
    const xScale = sw / dw;
    const yScale = sh / dh;

    for (let dy = 0; dy < dh; dy++) {
        const fy = sy0 + dy * yScale;
        const iy0 = clampInt(Math.floor(fy), 0, srcH - 1);
        const iy1 = clampInt(Math.ceil(fy + yScale), iy0 + 1, srcH);
        const dstRowBase = ((dy0 + dy) * dstW + dx0) * 4;

        for (let dx = 0; dx < dw; dx++) {
            const fx = sx0 + dx * xScale;
            const ix0 = clampInt(Math.floor(fx), 0, srcW - 1);
            const ix1 = clampInt(Math.ceil(fx + xScale), ix0 + 1, srcW);

            let r = 0;
            let g = 0;
            let b = 0;
            let aSum = 0;
            let n = 0;

            for (let y = iy0; y < iy1; y++) {
                let o = (y * srcW + ix0) * 4;
                for (let x = ix0; x < ix1; x++, o += 4) {
                    const a = src[o + 3];
                    const w = a / 255;
                    r += src[o] * w;
                    g += src[o + 1] * w;
                    b += src[o + 2] * w;
                    aSum += a;
                    n++;
                }
            }

            const di = dstRowBase + dx * 4;
            const weight = aSum / 255; // == sum of the per-pixel alpha weights

            if (n === 0 || weight === 0) {
                // Fully transparent footprint. Leave the white the canvas was
                // filled with, but carry the transparency through so the
                // packers' own alpha handling still sees it.
                dst[di] = 255;
                dst[di + 1] = 255;
                dst[di + 2] = 255;
                dst[di + 3] = n === 0 ? 255 : 0;
                continue;
            }

            dst[di] = clampByte(Math.round(r / weight));
            dst[di + 1] = clampByte(Math.round(g / weight));
            dst[di + 2] = clampByte(Math.round(b / weight));
            dst[di + 3] = clampByte(Math.round(aSum / n));
        }
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function assertPositiveInt(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got ${value}`);
    }
}

function clampInt(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function clampByte(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : value;
}
