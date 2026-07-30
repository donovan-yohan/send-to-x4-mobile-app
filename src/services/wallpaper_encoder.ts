/**
 * wallpaper_encoder — RGBA -> 8-bit grayscale BMP for the X3 PERMANENT wallpaper.
 *
 * The CrossPoint sleep-screen path (`SleepActivity::renderCustomSleepScreen` ->
 * `renderBitmapSleepScreen` -> `drawBitmap`) reads `/sleep.bmp` (or a rotating
 * set under `/.sleep/<n>.bmp`). The verified-good format — the one the firmware's
 * own `JpegToBmpConverter` / `PngToBmpConverter` emit, and the one that makes
 * `hasGreyscale()` return true so the panel gets the nicer multi-pass gray
 * render — is:
 *
 *   - 8 bits/pixel, BI_RGB (compression 0), 256-entry grayscale palette
 *   - 14 B BITMAPFILEHEADER + 40 B BITMAPINFOHEADER + 1024 B palette = 1078 B
 *   - bottom-up rows, each row padded up to a 4-byte boundary
 *
 * Two things this encoder deliberately does NOT do:
 *   - NO X-mirror. Columns are written left-to-right. (Neither does the raw
 *     love-note `.frame` packer — the X3 panel is not mirrored at all, proven
 *     on hardware 2026-07-28; see `src/device/x3.ts`.)
 *   - NO rotation and NO resize — and THIS is where the wallpaper path differs
 *     from the love-note path, which rotates 90 degrees CCW into the landscape
 *     panel buffer. `drawBitmap` is orientation-aware and handles a portrait
 *     bitmap itself; the firmware also scales/crops to the panel through its
 *     sleep-cover settings, and the caller pre-sizes the RGBA anyway
 *     (suggested long side `WALLPAPER_LONG_SIDE_PX`).
 *
 * WHAT THE PANEL DOES WITH THESE BYTES IS NOT SMOOTH GRAY. The firmware Atkinson
 * error-diffusion dithers this 8-bit plane down to FOUR levels and scatters it
 * onto a 528x792 PORTRAIT logical screen. `panel_render.ts` replicates that
 * chain from the firmware source; feed it {@link WallpaperEncodeResult.gray} to
 * see what the reader will really show.
 *
 * Pure TypeScript: no React Native imports, no DOM, no Node built-ins, so it is
 * importable straight from `node --import tsx --test`.
 */

/** Tuning knobs for {@link encodeWallpaperBmp}. All optional. */
export interface WallpaperEncodeOptions {
    /**
     * Gentle percentile autocontrast, on by default. E-ink has a short tonal
     * range; a flat photo turns to mud without it. Off => the BMP carries the
     * exact Rec. 601 luma of the input.
     */
    autocontrast?: boolean;
    /**
     * Fraction of pixels ignored at EACH tail when picking the black/white
     * points. Default 0.005 (0.5%). Clamped to [0, 0.2].
     */
    autocontrastClip?: number;
    /**
     * Ceiling on the contrast gain, which is what keeps "gentle" gentle: a
     * nearly flat image is not blown up into noise. Default 2.5. Clamped to
     * >= 1.
     */
    autocontrastMaxGain?: number;
    /**
     * Composite translucent pixels over WHITE before converting (default true).
     * E-ink paper is white, so this is what the panel effectively shows for a
     * transparent PNG. Off => the alpha channel is ignored entirely and
     * whatever RGB sits under it is used as-is.
     */
    flattenAlpha?: boolean;
}

/** What {@link encodeWallpaperBmp} hands back. */
export interface WallpaperEncodeResult {
    /** The complete BMP file, ready to upload to `/sleep.bmp`. */
    bmp: Uint8Array;
    /**
     * The EXACT bytes the BMP carries, `width * height` of them, TOP-DOWN in
     * image space (the BMP itself stores them bottom-up).
     *
     * This is the honest input to a panel-true render: our palette is a 256-entry
     * identity gray ramp, so the firmware's `paletteLum[i] == i` and the byte
     * below IS the luminance `Bitmap::readNextRow` feeds to its ditherer
     * (Bitmap.cpp:136-141, :242). Hand this — never `filePreviewRgba` — to
     * `panel_render.renderPanelPreview`, and the preview cannot drift from the
     * upload because both come from this one buffer.
     */
    gray: Uint8Array;
    /**
     * The gray plane expanded to RGBA (top-down, alpha 255): what the FILE
     * contains, i.e. smooth 8-bit grayscale.
     *
     * NOT what the panel shows. The panel is 1-bit driven to four synthetic
     * levels and the firmware error-diffusion dithers on the way there — see
     * `panel_render.ts`. Useful as the "source" half of a before/after toggle;
     * misleading on its own.
     */
    filePreviewRgba: Uint8Array;
    /**
     * @deprecated Historical name for {@link filePreviewRgba}, and the SAME
     * buffer (no copy). Kept so existing callers and `wallpaper-encoder.test.js`
     * keep working; new code should say which preview it means.
     */
    previewRgba: Uint8Array;
    /** Echo of the encoded dimensions, for callers that pass sizes around. */
    width: number;
    height: number;
}

/** BITMAPFILEHEADER. */
export const WALLPAPER_BMP_FILE_HEADER_BYTES = 14;
/** BITMAPINFOHEADER (the 40-byte flavour; anything larger confuses old parsers). */
export const WALLPAPER_BMP_INFO_HEADER_BYTES = 40;
/** 256 palette entries x 4 bytes (B, G, R, reserved). */
export const WALLPAPER_BMP_PALETTE_BYTES = 1024;
/** bfOffBits: 14 + 40 + 1024. Pixel data starts here. */
export const WALLPAPER_BMP_PIXEL_OFFSET =
    WALLPAPER_BMP_FILE_HEADER_BYTES +
    WALLPAPER_BMP_INFO_HEADER_BYTES +
    WALLPAPER_BMP_PALETTE_BYTES;

/**
 * Suggested long side for wallpaper sources: roughly 2x the 528 panel short
 * side, which leaves the firmware headroom to scale/crop without softening.
 * A suggestion for callers, not a constraint enforced here.
 */
export const WALLPAPER_LONG_SIDE_PX = 1056;

const DEFAULT_AUTOCONTRAST_CLIP = 0.005;
const DEFAULT_AUTOCONTRAST_MAX_GAIN = 2.5;
/**
 * Below this input dynamic range autocontrast is skipped entirely. A genuinely
 * flat image (a solid fill, a blank scan) has nothing to stretch but sensor
 * noise, and stretching it produces garbage.
 */
const AUTOCONTRAST_MIN_RANGE = 16;

/** ~72 DPI, matching what the legacy X4 encoder writes. */
const PIXELS_PER_METER = 2835;

/** Rec. 601 luma weights (they sum to exactly 1). */
const R_WEIGHT = 0.299;
const G_WEIGHT = 0.587;
const B_WEIGHT = 0.114;

/**
 * Bytes per BMP row for an 8-bit image: one byte per pixel, rounded up to the
 * next multiple of 4. (1056 -> 1056, no padding; 1053 -> 1056, 3 pad bytes.)
 */
export function wallpaperRowStride(width: number): number {
    assertPositiveInt('width', width);
    return (width + 3) & ~3;
}

/** Total file size: 1078 byte header block + padded pixel rows. */
export function wallpaperBmpSize(width: number, height: number): number {
    const stride = wallpaperRowStride(width); // validates width
    assertPositiveInt('height', height);
    return WALLPAPER_BMP_PIXEL_OFFSET + stride * height;
}

/**
 * Encode top-down RGBA into an 8-bit grayscale BMP plus a preview buffer.
 *
 * @param rgba   Exactly `width * height * 4` bytes, top-down row order.
 * @param width  Image width in pixels (>= 1).
 * @param height Image height in pixels (>= 1).
 */
export function encodeWallpaperBmp(
    rgba: Uint8Array,
    width: number,
    height: number,
    opts: WallpaperEncodeOptions = {}
): WallpaperEncodeResult {
    assertPositiveInt('width', width);
    assertPositiveInt('height', height);

    const pixelCount = width * height;
    const expectedRgbaLength = pixelCount * 4;
    if (!Number.isSafeInteger(expectedRgbaLength)) {
        throw new Error(`Image ${width}x${height} is too large to encode`);
    }
    if (rgba.length !== expectedRgbaLength) {
        throw new Error(
            `RGBA data must be ${expectedRgbaLength} bytes (${width}x${height}x4), got ${rgba.length}`
        );
    }

    const gray = toGrayscale(rgba, pixelCount, opts.flattenAlpha !== false);
    if (opts.autocontrast !== false) {
        applyAutocontrast(
            gray,
            clampNumber(opts.autocontrastClip ?? DEFAULT_AUTOCONTRAST_CLIP, 0, 0.2),
            Math.max(opts.autocontrastMaxGain ?? DEFAULT_AUTOCONTRAST_MAX_GAIN, 1)
        );
    }

    // ONE buffer behind both preview names — `filePreviewRgba` is the honest
    // one, `previewRgba` the legacy alias. Aliasing rather than copying keeps
    // the deprecation free.
    const filePreviewRgba = grayToRgba(gray);

    return {
        bmp: buildBmp(gray, width, height),
        gray,
        filePreviewRgba,
        previewRgba: filePreviewRgba,
        width,
        height,
    };
}

/** RGBA -> 8-bit luma, Rec. 601, optionally composited over white. */
function toGrayscale(rgba: Uint8Array, pixelCount: number, flattenAlpha: boolean): Uint8Array {
    const gray = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        const si = i * 4;
        let luma = R_WEIGHT * rgba[si] + G_WEIGHT * rgba[si + 1] + B_WEIGHT * rgba[si + 2];
        if (flattenAlpha) {
            const a = rgba[si + 3];
            if (a !== 255) {
                // Compositing over white in gray space is identical to doing it
                // per channel first: the Rec. 601 weights sum to 1.
                luma = (luma * a + 255 * (255 - a)) / 255;
            }
        }
        gray[i] = clampByte(Math.round(luma));
    }
    return gray;
}

/**
 * Percentile black/white points, stretched about the midpoint with a capped
 * gain.
 *
 * TWO REGIMES, and the difference matters:
 *
 *   Cap does NOT bind (range >= 255 / maxGain, i.e. >= 102 by default): the
 *   mapping is exactly the usual level stretch — lo lands on 0 and hi on 255,
 *   whatever the midpoint was. Nothing is shifted.
 *
 *   Cap DOES bind (a low-contrast image): the stretch is centred on mid-gray,
 *   so the output midpoint is 127.5 REGARDLESS of the input midpoint. This is
 *   deliberate — an uncentred capped stretch would drive a dim image to
 *   near-black (100..139 at gain 2.5 becomes 0..97) — but it is a trade, not a
 *   free lunch: it MOVES the end points. A hazy, backlit frame with lo=180,
 *   hi=255 has its paper-white pulled down to 221; a low-key frame with lo=0,
 *   hi=75 has its true black lifted to 34. On a reflective panel the white
 *   point is the best tone available, so this is the cost being paid for tonal
 *   normalisation.
 *
 * If that trade is ever revisited, anchoring at lo — `(gray[i] - lo) * gain` —
 * is the alternative that preserves the black point instead. Do not treat the
 * current mapping as endpoint-preserving; it is midpoint-preserving.
 * Pinned by `scripts/wallpaper-encoder.test.js`.
 */
function applyAutocontrast(gray: Uint8Array, clip: number, maxGain: number): void {
    const total = gray.length;
    if (total === 0) return;

    const histogram = new Uint32Array(256);
    for (let i = 0; i < total; i++) histogram[gray[i]]++;

    const cut = Math.floor(total * clip);

    let lo = 0;
    for (let acc = 0, v = 0; v < 256; v++) {
        acc += histogram[v];
        if (acc > cut) {
            lo = v;
            break;
        }
    }

    let hi = 255;
    for (let acc = 0, v = 255; v >= 0; v--) {
        acc += histogram[v];
        if (acc > cut) {
            hi = v;
            break;
        }
    }

    const range = hi - lo;
    if (range < AUTOCONTRAST_MIN_RANGE) return;
    // Already full-range: nothing to gain, and the identity mapping keeps the
    // no-op case bit-exact.
    if (lo === 0 && hi === 255) return;

    const gain = Math.min(255 / range, maxGain);
    const mid = (lo + hi) / 2;
    for (let i = 0; i < total; i++) {
        gray[i] = clampByte(Math.round((gray[i] - mid) * gain + 127.5));
    }
}

/** Grayscale plane -> RGBA (top-down, opaque) for the on-screen preview. */
function grayToRgba(gray: Uint8Array): Uint8Array {
    const rgba = new Uint8Array(gray.length * 4);
    for (let i = 0; i < gray.length; i++) {
        const v = gray[i];
        const di = i * 4;
        rgba[di] = v;
        rgba[di + 1] = v;
        rgba[di + 2] = v;
        rgba[di + 3] = 255;
    }
    return rgba;
}

/** Assemble headers, palette and bottom-up padded pixel rows. */
function buildBmp(gray: Uint8Array, width: number, height: number): Uint8Array {
    const rowStride = wallpaperRowStride(width);
    const pixelDataSize = rowStride * height;
    const fileSize = WALLPAPER_BMP_PIXEL_OFFSET + pixelDataSize;

    const bmp = new Uint8Array(fileSize);
    const view = new DataView(bmp.buffer);

    // --- BITMAPFILEHEADER (14 bytes) ---
    bmp[0] = 0x42; // 'B'
    bmp[1] = 0x4d; // 'M'
    view.setUint32(2, fileSize, true); // bfSize
    view.setUint16(6, 0, true); // bfReserved1
    view.setUint16(8, 0, true); // bfReserved2
    view.setUint32(10, WALLPAPER_BMP_PIXEL_OFFSET, true); // bfOffBits (1078)

    // --- BITMAPINFOHEADER (40 bytes) ---
    view.setUint32(14, WALLPAPER_BMP_INFO_HEADER_BYTES, true); // biSize
    view.setInt32(18, width, true); // biWidth
    view.setInt32(22, height, true); // biHeight (positive => bottom-up)
    view.setUint16(26, 1, true); // biPlanes
    view.setUint16(28, 8, true); // biBitCount (8-bit palettised)
    view.setUint32(30, 0, true); // biCompression (BI_RGB)
    view.setUint32(34, pixelDataSize, true); // biSizeImage
    view.setInt32(38, PIXELS_PER_METER, true); // biXPelsPerMeter
    view.setInt32(42, PIXELS_PER_METER, true); // biYPelsPerMeter
    view.setUint32(46, 256, true); // biClrUsed (full palette present)
    view.setUint32(50, 0, true); // biClrImportant (0 => all)

    // --- Palette: 256 gray entries, B G R reserved ---
    let p = WALLPAPER_BMP_FILE_HEADER_BYTES + WALLPAPER_BMP_INFO_HEADER_BYTES;
    for (let i = 0; i < 256; i++) {
        bmp[p] = i; // B
        bmp[p + 1] = i; // G
        bmp[p + 2] = i; // R
        bmp[p + 3] = 0; // reserved
        p += 4;
    }

    // --- Pixel data: bottom-up, one index byte per pixel, rows zero-padded ---
    for (let row = 0; row < height; row++) {
        const srcRow = height - 1 - row; // BMP row 0 is the image's bottom row
        const srcOffset = srcRow * width;
        const dstOffset = WALLPAPER_BMP_PIXEL_OFFSET + row * rowStride;
        for (let x = 0; x < width; x++) {
            bmp[dstOffset + x] = gray[srcOffset + x];
        }
        // Trailing pad bytes stay 0 (Uint8Array is zero-initialised).
    }

    return bmp;
}

/**
 * Sanity ceiling on either dimension. Well above anything an e-ink wallpaper
 * needs, and low enough that the 4-byte row rounding can never overflow int32.
 */
const MAX_DIMENSION_PX = 65535;

function assertPositiveInt(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got ${value}`);
    }
    if (value > MAX_DIMENSION_PX) {
        throw new Error(`${name} must be <= ${MAX_DIMENSION_PX}, got ${value}`);
    }
}

function clampByte(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return value < min ? min : value > max ? max : value;
}
