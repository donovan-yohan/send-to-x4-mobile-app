/**
 * panel_render — WHAT THE PANEL ACTUALLY SHOWS, replicated in pure TypeScript.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The app uploads a smooth 8-bit grayscale BMP to `/sleep.bmp`. The X3 panel
 * cannot show smooth gray: it is a 1-bit panel that the firmware drives with a
 * 3-pass write to synthesise exactly FOUR levels, and it error-diffusion
 * dithers the source down to those four levels before it ever gets there.
 *
 * So a preview built from the BMP's own bytes is wrong on two counts — no
 * quantization and no dither. This module runs the firmware's own chain instead,
 * so the on-screen preview is the panel's output, not the file's input.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN, AS CITED FROM THE FIRMWARE (read-only recon of
 * ~/Documents/Programs/personal/crosspoint-reader @ branch `messenger`)
 * ---------------------------------------------------------------------------
 *   SleepActivity::renderCustomSleepScreen   opens /sleep.bmp with dithering=TRUE
 *                                            (SleepActivity.cpp:69)
 *     -> renderBitmapSleepScreen             fit/crop geometry, ALL float32
 *                                            (SleepActivity.cpp:174-252)
 *     -> Bitmap::readNextRow / packPixel     palette luma -> ATKINSON dither to
 *                                            4 levels (Bitmap.cpp:193-245,
 *                                            BitmapHelpers.h:105-196)
 *     -> GfxRenderer::drawBitmap             nearest-neighbour SCATTER downscale,
 *                                            per-plane OR (GfxRenderer.cpp:1251-1357)
 *     -> 3 passes (BW base, GRAYSCALE_LSB, GRAYSCALE_MSB) -> displayGrayBuffer
 *                                            (SleepActivity.cpp:215-251)
 *
 * Five facts from that recon drive every line below. None of them is invented:
 *
 *   1. THE SLEEP RENDER IS PORTRAIT. `SleepActivity.cpp:36` forces
 *      GfxRenderer::Orientation::Portrait, where `getScreenWidth()` returns the
 *      panel's HEIGHT and `getScreenHeight()` its WIDTH
 *      (GfxRenderer.cpp:1678-1704). For the X3's 792x528 physical panel that is
 *      a 528 x 792 PORTRAIT logical screen — a tall book cover, not a wide
 *      landscape strip. Hence the {@link COMPOSE_W} / {@link COMPOSE_H}
 *      defaults; nothing here hard-codes a size, so an X4 (480x800,
 *      USER_GUIDE.md:524) is a `src/device/*.ts` change, not a change here.
 *
 *   2. THE DITHER IS ATKINSON, AT SOURCE RESOLUTION, BEFORE THE DOWNSCALE.
 *      `USE_ATKINSON == true` (Bitmap.cpp:13) and our BMP's 256-entry identity
 *      gray ramp fails the `nativePalette` test (Bitmap.cpp:150-162), so
 *      `highColor && dithering` selects AtkinsonDitherer (Bitmap.cpp:168-175).
 *
 *   3. THE THRESHOLDS ARE 30 / 50 / 140 AND THE LEVELS RECONSTRUCT AS
 *      15 / 30 / 80 / 210. Those are the LIVE constants (BitmapHelpers.h:147-161,
 *      commented "fine-tuned to X4 eink display"); the 43/128/213 variant sits
 *      inside `if (false)` at BitmapHelpers.h:133 and is dead code.
 *
 *   4. THE DOWNSCALE IS A SCATTER WITH PER-PLANE OR, NOT A RESAMPLE. Several
 *      source pixels land on one destination and each plane ORs, so ink wins:
 *      priority 1 > 2 > 0 > 3. See {@link renderPanelLevels}. This is why a
 *      panel-true preview looks DARKER and noisier than the smooth one — that
 *      is the firmware, not this module.
 *
 *   5. THE FIRMWARE NEVER UPSCALES (`isScaled = fitScale < 1.0f`,
 *      GfxRenderer.cpp:1283-1286). Combined with the CROP branch already
 *      forcing x = y = 0, a cropped source smaller than the screen lands at the
 *      TOP-LEFT with white margins. That is a real firmware limitation and it is
 *      replicated here on purpose — a preview that "fixed" it would lie.
 *
 * ---------------------------------------------------------------------------
 * FLOAT32 IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `renderBitmapSleepScreen` and `drawBitmap` do their geometry in C++ `float`,
 * not `double`. Every arithmetic step here is wrapped in `Math.fround` for that
 * reason, and it is not decoration: a 792x1056 source in CROP mode yields
 * cropPixX = 43 in float32 and 44 in double, i.e. a one-column crop error.
 * `scripts/panel-render.test.js` pins the whole geometry table.
 *
 * ---------------------------------------------------------------------------
 * PURITY
 * ---------------------------------------------------------------------------
 * No React Native, no DOM, no Node built-ins — `scripts/panel-render.test.js`
 * imports this file directly, so CI covers the quantization arithmetic instead
 * of a device photo doing it.
 */

import { COMPOSE_H, COMPOSE_W } from '../device/x3';

// ---------------------------------------------------------------------------
// Firmware constants — every one carries its file:line
// ---------------------------------------------------------------------------

/**
 * How many distinct grays the panel can show. FOUR.
 *
 * Bitmap.cpp:9-11 ("the display's native 2-bit (4-level) grayscale"),
 * Bitmap.cpp:180 ("0 = black, 1 = dark gray, 2 = light gray, 3 = white"),
 * GfxRenderer.h:26 `Color { Black, DarkGray, LightGray, White }`.
 *
 * Every byte in a {@link renderPanelLevels} result is < this. The test asserts
 * it over a histogram, because "only N legal levels" is the single claim that
 * makes this preview panel-TRUE rather than merely panel-shaped.
 */
export const PANEL_GRAY_LEVELS = 4;

/**
 * Atkinson quantization boundaries, ascending: a pixel below the first is
 * level 0, below the second level 1, below the third level 2, else level 3.
 *
 * BitmapHelpers.h:147-161 — the LIVE branch. NOT 43/128/213 (dead code behind
 * `if (false)`, BitmapHelpers.h:133) and NOT 45/70/140 (`quantizeSimple`,
 * BitmapHelpers.cpp:57-67, which is the un-dithered book-cover path).
 */
export const ATKINSON_THRESHOLDS: readonly [number, number, number] = [30, 50, 140];

/**
 * The value the ditherer treats each level as HAVING once written — i.e. the
 * firmware author's own calibration of what the X-series panel emits.
 * BitmapHelpers.h:148-160. Indexed by level.
 */
export const ATKINSON_QUANTIZED_VALUES: readonly [number, number, number, number] = [
    15, 30, 80, 210,
];

/**
 * Atkinson distributes only 6/8 of the error. BitmapHelpers.h:164 —
 * `error = (adjusted - quantizedValue) >> 3`, then six neighbours each take one
 * `error`. Named so the shift below is not a magic 3.
 */
export const ATKINSON_ERROR_SHIFT = 3;

/**
 * The evenly spaced level map the BMP format itself describes — Bitmap.cpp:148,
 * "Native levels are 0, 85, 170, 255". Four VISIBLY DISTINCT grays.
 */
export const PANEL_LEVEL_LUMINANCE_NOMINAL: readonly number[] = [0, 85, 170, 255];

/**
 * Level -> preview luminance. THE ONE TUNABLE IN THIS FILE.
 *
 * Defaults to {@link PANEL_LEVEL_LUMINANCE_NOMINAL}, NOT to
 * {@link ATKINSON_QUANTIZED_VALUES}. That [15, 30, 80, 210] array is the
 * ditherer's error-diffusion RECONSTRUCTION table (BitmapHelpers.h:148-160): it
 * decides how much error each written pixel pushes into its neighbours, which is
 * a statement about the DITHER, not a measured display LUT. Painting the preview
 * with it costs two concrete things:
 *
 *   - levels 0 and 1 sit 15 apart out of 255 and read as ONE tone on a phone
 *     screen, so a preview whose entire claim is "the panel shows exactly FOUR
 *     grays" visibly shows three;
 *   - panel white would be 210 while DevicePreview's own model of unlit e-ink
 *     paper is `PAPER = #e9e8e3` (233), so the rendered panel would read as a
 *     dull card inset in a BRIGHTER bezel, inverting that component's
 *     documented intent that a fit-mode letterbox bar shows as the brighter
 *     white.
 *
 * The THRESHOLDS above decide the dither PATTERN and must not move; this array
 * only decides how that pattern is painted. If hardware photography ever says
 * the glass really is closer to [15, 30, 80, 210], swap
 * {@link ATKINSON_QUANTIZED_VALUES} back in here — one line, and
 * `levelLuminance` already overrides it per call.
 */
export const PANEL_LEVEL_LUMINANCE: readonly number[] = PANEL_LEVEL_LUMINANCE_NOMINAL;

/**
 * Rec.601-ish integer palette luma, EXACTLY as `parseHeaders` computes it:
 * `(77*R + 150*G + 29*B) >> 8` (Bitmap.cpp:139). Only used when this module is
 * handed RGBA instead of a gray plane; the real upload path hands it the gray
 * plane the BMP carries, where the palette is an identity ramp and this
 * function is the identity too.
 */
export function paletteLuma(r: number, g: number, b: number): number {
    return (77 * r + 150 * g + 29 * b) >> 8;
}

/** Logical sleep-screen width. Portrait — see fact 1 in the header. */
export const DEFAULT_PANEL_SCREEN_WIDTH = COMPOSE_W;
/** Logical sleep-screen height. Portrait — see fact 1 in the header. */
export const DEFAULT_PANEL_SCREEN_HEIGHT = COMPOSE_H;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The reader's `sleepScreenCoverMode` setting (CrossPointSettings.h:26,177).
 * Defaults to FIT on the device, so it defaults to 'fit' here.
 *
 * This lives on the DEVICE, not in the app, and no API reads it back — so the
 * preview cannot know it. Offer it as a user-visible choice rather than guessing
 * CROP.
 */
export type SleepCoverMode = 'fit' | 'crop';

/**
 * The reader's `sleepScreenCoverFilter` setting (CrossPointSettings.h:27-32,179).
 *
 *   'none'      NO_FILTER — the 4-level gray path. The device default.
 *   'bw'        BLACK_AND_WHITE — only the BW base pass is shown, so every level
 *               below 3 is BLACK (SleepActivity.cpp:217-233). Very dark.
 *   'inverted'  INVERTED_BLACK_AND_WHITE — the above, then `invertScreen()` over
 *               the WHOLE framebuffer including the white background
 *               (SleepActivity.cpp:222-224, GfxRenderer.cpp:1534-1538).
 */
export type SleepCoverFilter = 'none' | 'bw' | 'inverted';

/** Screen box + cover mode — everything {@link computeSleepGeometry} needs. */
export interface PanelGeometryOptions {
    /** See {@link SleepCoverMode}. Default 'fit' (the device default). */
    coverMode?: SleepCoverMode;
    /** Logical screen width. Default {@link DEFAULT_PANEL_SCREEN_WIDTH} (528). */
    screenWidth?: number;
    /** Logical screen height. Default {@link DEFAULT_PANEL_SCREEN_HEIGHT} (792). */
    screenHeight?: number;
}

export interface PanelRenderOptions extends PanelGeometryOptions {
    /** See {@link SleepCoverFilter}. Default 'none' (the device default). */
    filter?: SleepCoverFilter;
    /**
     * Whether the source rows arrive in BMP file order for a BOTTOM-UP bitmap,
     * which is what `wallpaper_encoder.buildBmp` writes (positive `biHeight`).
     * Default true.
     *
     * NOT cosmetic: `readNextRow` advances the Atkinson state once per FILE row,
     * so on a bottom-up BMP the error diffuses UPWARD through the picture. Get
     * this wrong and the dither pattern is subtly but visibly different from the
     * panel's.
     */
    bottomUp?: boolean;
}

export interface PanelPreviewOptions extends PanelRenderOptions {
    /**
     * Level -> luminance map, 4 entries. Default {@link PANEL_LEVEL_LUMINANCE}.
     */
    levelLuminance?: readonly number[];
}

/** Everything `renderBitmapSleepScreen` + `drawBitmap` decide before drawing. */
export interface PanelGeometry {
    /** `cropX` / `cropY` from SleepActivity.cpp:190/200 — fractions, 0 in FIT. */
    cropX: number;
    cropY: number;
    /** Source columns/rows dropped at EACH edge. GfxRenderer.cpp:1262-1263. */
    cropPixX: number;
    cropPixY: number;
    /** `(1 - crop) * dimension`. GfxRenderer.cpp:1267-1268. */
    croppedWidth: number;
    croppedHeight: number;
    /** `min(PW/croppedWidth, PH/croppedHeight)`. GfxRenderer.cpp:1272-1281. */
    fitScale: number;
    /** `fitScale < 1` — the firmware NEVER upscales. GfxRenderer.cpp:1283. */
    isScaled: boolean;
    /** `isScaled ? fitScale : 1`. GfxRenderer.cpp:1286. */
    scale: number;
    /** Destination offset. SleepActivity.cpp:195/204/209-211. */
    x: number;
    y: number;
    /** Echo of the screen box the numbers were computed against. */
    screenWidth: number;
    screenHeight: number;
}

/** A rendered panel frame: one byte per pixel, each 0..3. */
export interface PanelLevelsResult {
    /** `width * height` bytes, values 0..{@link PANEL_GRAY_LEVELS}-1, top-down. */
    levels: Uint8Array;
    /** Always the SCREEN width (528), never the source's. */
    width: number;
    /** Always the SCREEN height (792), never the source's. */
    height: number;
    /** The geometry that produced it — handy for captions and for tests. */
    geometry: PanelGeometry;
}

/** {@link PanelLevelsResult} plus the RGBA an `<Image>` can show. */
export interface PanelPreviewResult extends PanelLevelsResult {
    /** `width * height * 4` bytes, top-down, opaque. */
    rgba: Uint8Array;
}

// ---------------------------------------------------------------------------
// Geometry — SleepActivity::renderBitmapSleepScreen + GfxRenderer::drawBitmap
// ---------------------------------------------------------------------------

const f32 = Math.fround;

/**
 * `std::round` — half AWAY FROM ZERO, which is not `Math.round` (half UP) for
 * negative arguments. Both call sites are provably non-negative today, but the
 * firmware's rule is the one being replicated.
 */
function roundHalfAwayFromZero(value: number): number {
    const magnitude = Math.round(Math.abs(value));
    // `=== 0` before the sign, because the firmware assigns the rounded float to
    // an `int` and C++ has no negative zero there. Without this a source whose
    // offset lands a hair below zero (1056x704 CROP computes -3e-5) returns -0,
    // which is arithmetically identical but fails a `deepEqual` against 0 and
    // would make the geometry table impossible to pin.
    if (magnitude === 0) return 0;
    return value < 0 ? -magnitude : magnitude;
}

/**
 * Where the source lands on the sleep screen, and by how much it shrinks.
 *
 * A faithful transcription of `renderBitmapSleepScreen` (SleepActivity.cpp:181-212)
 * followed by `drawBitmap`'s own prologue (GfxRenderer.cpp:1262-1286). Exported
 * because it is the whole of the "why is my picture letterboxed" answer and it
 * is the part a test can pin exactly.
 *
 * Note the branch the firmware does NOT take: when the source already fits
 * inside the screen, NO crop is applied even in CROP mode
 * (SleepActivity.cpp:208-212) — cropX/cropY stay 0 and the image is centred.
 */
export function computeSleepGeometry(
    width: number,
    height: number,
    opts: PanelGeometryOptions = {}
): PanelGeometry {
    assertPositiveInt('width', width);
    assertPositiveInt('height', height);

    const screenWidth = opts.screenWidth ?? DEFAULT_PANEL_SCREEN_WIDTH;
    const screenHeight = opts.screenHeight ?? DEFAULT_PANEL_SCREEN_HEIGHT;
    assertPositiveInt('screenWidth', screenWidth);
    assertPositiveInt('screenHeight', screenHeight);

    const crop = (opts.coverMode ?? 'fit') === 'crop';

    // SleepActivity.cpp:179 — float screenRatio = (float)PW / (float)PH;
    const screenRatio = f32(f32(screenWidth) / f32(screenHeight));

    let cropX = 0;
    let cropY = 0;
    let x = 0;
    let y = 0;

    if (width > screenWidth || height > screenHeight) {
        // SleepActivity.cpp:183 — float ratio = (float)W / (float)H;
        let ratio = f32(f32(width) / f32(height));

        if (ratio > screenRatio) {
            // Source is WIDER than the screen: it spans the full width.
            if (crop) {
                // :190  cropX = 1.0f - screenRatio / ratio;
                cropX = f32(1 - f32(screenRatio / ratio));
                // :192  ratio = (1.0f - cropX) * W / H;
                ratio = f32(f32(f32(1 - cropX) * width) / height);
            }
            x = 0;
            // :195  y = std::round((PH - PW / ratio) / 2);
            y = roundHalfAwayFromZero(f32(f32(screenHeight - f32(screenWidth / ratio)) / 2));
        } else {
            // Source is TALLER than the screen: it spans the full height.
            if (crop) {
                // :200  cropY = 1.0f - ratio / screenRatio;
                cropY = f32(1 - f32(ratio / screenRatio));
                // :202  ratio = W / ((1.0f - cropY) * H);
                ratio = f32(width / f32(f32(1 - cropY) * height));
            }
            // :204  x = std::round((PW - PH * ratio) / 2);
            x = roundHalfAwayFromZero(f32(f32(screenWidth - f32(screenHeight * ratio)) / 2));
            y = 0;
        }
    } else {
        // :209-211 — C++ INTEGER division (truncating), and NO crop ever.
        x = Math.trunc((screenWidth - width) / 2);
        y = Math.trunc((screenHeight - height) / 2);
    }

    // GfxRenderer.cpp:1262-1263
    const cropPixX = Math.floor(f32(f32(width * cropX) / 2));
    const cropPixY = Math.floor(f32(f32(height * cropY) / 2));
    // GfxRenderer.cpp:1267-1268
    const croppedWidth = f32(f32(1 - cropX) * width);
    const croppedHeight = f32(f32(1 - cropY) * height);
    // GfxRenderer.cpp:1272-1281
    const fitScale = Math.min(
        f32(screenWidth / croppedWidth),
        f32(screenHeight / croppedHeight)
    );
    // GfxRenderer.cpp:1283-1286 — THE FIRMWARE NEVER UPSCALES.
    const isScaled = fitScale < 1;
    const scale = isScaled ? fitScale : 1;

    return {
        cropX,
        cropY,
        cropPixX,
        cropPixY,
        croppedWidth,
        croppedHeight,
        fitScale,
        isScaled,
        scale,
        x,
        y,
        screenWidth,
        screenHeight,
    };
}

// ---------------------------------------------------------------------------
// The ditherer — BitmapHelpers.h:105-196, class AtkinsonDitherer
// ---------------------------------------------------------------------------

/**
 * Atkinson error diffusion to 4 levels, one row at a time, in FILE order.
 *
 * Three `int16_t` error rows of length `width + 4` (BitmapHelpers.h:110-116).
 * `Int16Array` is not a convenience here — it reproduces the C++ wrap-around on
 * the (rare, pathological) accumulation that overflows 16 bits.
 *
 * Private on purpose: `scripts/panel-render.test.js` hand-computes the expected
 * levels from the firmware formulas instead of calling this, so the test can
 * disagree with the implementation.
 */
class AtkinsonDitherer {
    private row0: Int16Array;
    private row1: Int16Array;
    private row2: Int16Array;

    constructor(width: number) {
        this.row0 = new Int16Array(width + 4);
        this.row1 = new Int16Array(width + 4);
        this.row2 = new Int16Array(width + 4);
    }

    /** BitmapHelpers.h:124-175. `gray` is post-`adjustPixel`, which is the
     *  identity here: USE_BRIGHTNESS is false (BitmapHelpers.cpp:9,43-44). */
    processPixel(gray: number, x: number): number {
        // :126-128
        let adjusted = gray + this.row0[x + 2];
        if (adjusted < 0) adjusted = 0;
        else if (adjusted > 255) adjusted = 255;

        // :147-161 — the LIVE, X4-tuned branch.
        let level: number;
        let quantized: number;
        if (adjusted < ATKINSON_THRESHOLDS[0]) {
            level = 0;
            quantized = ATKINSON_QUANTIZED_VALUES[0];
        } else if (adjusted < ATKINSON_THRESHOLDS[1]) {
            level = 1;
            quantized = ATKINSON_QUANTIZED_VALUES[1];
        } else if (adjusted < ATKINSON_THRESHOLDS[2]) {
            level = 2;
            quantized = ATKINSON_QUANTIZED_VALUES[2];
        } else {
            level = 3;
            quantized = ATKINSON_QUANTIZED_VALUES[3];
        }

        // :164 — ARITHMETIC shift, written literally. JS `>>` on a negative int
        // floors exactly as C++ does; `Math.floor(x / 8)` would agree but hides
        // the fact that this is the firmware's own expression.
        const error = (adjusted - quantized) >> ATKINSON_ERROR_SHIFT;

        // :166-171 — six neighbours, 6/8 of the error, no serpentine.
        this.row0[x + 3] += error; // right
        this.row0[x + 4] += error; // right + 1
        this.row1[x + 1] += error; // below-left
        this.row1[x + 2] += error; // below
        this.row1[x + 3] += error; // below-right
        this.row2[x + 2] += error; // two rows below

        return level;
    }

    /** BitmapHelpers.h:177-183 — rotate row0<-row1<-row2, zero the new row2. */
    nextRow(): void {
        const recycled = this.row0;
        this.row0 = this.row1;
        this.row1 = this.row2;
        this.row2 = recycled;
        this.row2.fill(0);
    }
}

// ---------------------------------------------------------------------------
// Source normalisation
// ---------------------------------------------------------------------------

/**
 * Accept either the gray plane the BMP carries (`width * height` bytes) or raw
 * RGBA (`width * height * 4`).
 *
 * The real upload path passes the GRAY PLANE, and that is the exact byte the
 * firmware reads: our BMP's palette is a 256-entry identity ramp, so
 * `paletteLum[i] == i` (Bitmap.cpp:136-141 with R=G=B=i gives `256*i >> 8 == i`)
 * and `Bitmap.cpp:242` looks the pixel byte up as a palette index. RGBA is
 * accepted for convenience and reduced with the firmware's own integer weights;
 * alpha is IGNORED, because a BMP has none by the time the device sees it.
 */
function toGrayPlane(
    source: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number
): Uint8Array | Uint8ClampedArray {
    const pixels = width * height;
    if (source.length === pixels) return source;
    if (source.length === pixels * 4) {
        const gray = new Uint8Array(pixels);
        for (let i = 0; i < pixels; i++) {
            const si = i * 4;
            gray[i] = paletteLuma(source[si], source[si + 1], source[si + 2]);
        }
        return gray;
    }
    throw new Error(
        `panel_render: expected ${pixels} gray bytes or ${pixels * 4} RGBA bytes ` +
            `for ${width}x${height}, got ${source.length}`
    );
}

// ---------------------------------------------------------------------------
// The render
// ---------------------------------------------------------------------------

// Plane bits accumulated per destination pixel. GfxRenderer.cpp:1345-1351.
const PLANE_BW = 1; // BW pass wrote ink:  val < 3
const PLANE_MSB = 2; // GRAYSCALE_MSB bit: val == 1 || val == 2
const PLANE_LSB = 4; // GRAYSCALE_LSB bit: val == 1

/**
 * Source image -> the exact 4-level frame the panel will display.
 *
 * The three firmware passes (BW base, then the LSB and MSB gray planes) walk the
 * SAME loop over the SAME dither output — `rewindToData()` resets the ditherer
 * between them (Bitmap.cpp:285-295) — so one pass here that ORs three plane bits
 * per destination is byte-identical to running the loop three times.
 *
 * DESTINATIONS NO SOURCE PIXEL REACHES STAY WHITE (level 3). That is where
 * fit-mode letterbox bars and the crop-mode margins come from; it is
 * `clearScreen()` at SleepActivity.cpp:215, not a default this module chose.
 *
 * @param source Gray plane (`width*height`) or RGBA (`width*height*4`), TOP-DOWN
 *               in image space regardless of `bottomUp` — `bottomUp` describes
 *               the BMP's row ORDER ON DISK, which is what decides the dither
 *               traversal, not how this buffer is indexed.
 */
export function renderPanelLevels(
    source: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    opts: PanelRenderOptions = {}
): PanelLevelsResult {
    assertPositiveInt('width', width);
    assertPositiveInt('height', height);

    const gray = toGrayPlane(source, width, height);
    const filter = opts.filter ?? 'none';
    const bottomUp = opts.bottomUp !== false;

    const geometry = computeSleepGeometry(width, height, opts);
    const { cropPixX, cropPixY, isScaled, scale, x: offsetX, y: offsetY } = geometry;
    const screenWidth = geometry.screenWidth;
    const screenHeight = geometry.screenHeight;

    // One byte per destination pixel. Accumulates plane BITS during the scatter,
    // then is rewritten IN PLACE with the decoded 0..3 level — the two never
    // coexist, and a second 418 KB allocation for the same pixels is waste.
    const planes = new Uint8Array(screenWidth * screenHeight);

    const ditherer = new AtkinsonDitherer(width);
    const rowLevels = new Uint8Array(width);

    // GfxRenderer.cpp:1302 — `for (bmpY = 0; bmpY < H - cropPixY; bmpY++)`.
    const rowCount = height - cropPixY;
    for (let bmpY = 0; bmpY < rowCount; bmpY++) {
        // The FILE row `bmpY` is image row `height-1-bmpY` on a bottom-up BMP.
        // GfxRenderer.cpp:1305 folds that into the same expression either way:
        //   screenY = -cropPixY + (topDown ? bmpY : H-1-bmpY)  ==  imageRow - cropPixY
        const imageRow = bottomUp ? height - 1 - bmpY : bmpY;

        let screenY = imageRow - cropPixY;
        // :1307 (floor; only ever negative on rows the guards below discard)
        if (isScaled) screenY = Math.floor(f32(screenY * scale));
        screenY += offsetY; // :1309 — the offset is NOT scaled
        if (screenY >= screenHeight) break; // :1310-1312 — stops the whole image

        // :1314 readNextRow — dithers EVERY column, including cropped ones, so
        // the error state matches the firmware's even where nothing is drawn.
        const rowBase = imageRow * width;
        for (let px = 0; px < width; px++) {
            rowLevels[px] = ditherer.processPixel(gray[rowBase + px], px);
        }
        ditherer.nextRow();

        if (screenY < 0) continue; // :1321
        if (bmpY < cropPixY) continue; // :1325

        const rowOffset = screenY * screenWidth;
        // :1330 — `for (bmpX = cropPixX; bmpX < W - cropPixX; bmpX++)`
        for (let bmpX = cropPixX; bmpX < width - cropPixX; bmpX++) {
            let screenX = bmpX - cropPixX;
            if (isScaled) screenX = Math.floor(f32(screenX * scale)); // :1333
            screenX += offsetX; // :1335
            if (screenX >= screenWidth) break; // :1336
            if (screenX < 0) continue; // :1339

            // :1343 — the sample is taken at the SOURCE column, not the dest.
            const val = rowLevels[bmpX];
            let bits = 0;
            if (val < 3) bits |= PLANE_BW;
            if (val === 1 || val === 2) bits |= PLANE_MSB;
            if (val === 1) bits |= PLANE_LSB;
            // OR, not assign: several source pixels share this destination when
            // scale < 1, and the firmware's three passes each OR their plane.
            planes[rowOffset + screenX] |= bits;
        }
    }

    decodePlanesInPlace(planes, filter);

    return { levels: planes, width: screenWidth, height: screenHeight, geometry };
}

/**
 * Plane bits -> displayed level, rewritten in place.
 *
 * NO_FILTER combines as `level = msb ? (lsb ? 1 : 2) : (bw ? 0 : 3)`, i.e.
 * priority 1 > 2 > 0 > 3 over the source pixels that landed here.
 *
 * This step is the ONE link in the chain with no file:line proof: the
 * freeink-sdk submodule is not checked out, so how the panel decodes
 * (base, MSB, LSB) into gray could not be read. It is forced by the writes at
 * GfxRenderer.cpp:1345-1351 plus Bitmap.cpp:180's stated 0/1/2/3 =
 * black/dark/light/white ordering. If hardware ever contradicts it, THIS
 * function is where the fix goes.
 */
function decodePlanesInPlace(planes: Uint8Array, filter: SleepCoverFilter): void {
    for (let i = 0; i < planes.length; i++) {
        const bits = planes[i];
        if (filter === 'none') {
            planes[i] =
                (bits & PLANE_MSB) !== 0
                    ? (bits & PLANE_LSB) !== 0
                        ? 1
                        : 2
                    : (bits & PLANE_BW) !== 0
                      ? 0
                      : 3;
        } else if (filter === 'bw') {
            // hasGreyscale forced false: only the BW pass reaches the panel, so
            // every val < 3 is BLACK. SleepActivity.cpp:217-233.
            planes[i] = (bits & PLANE_BW) !== 0 ? 0 : 3;
        } else {
            // invertScreen() flips the WHOLE framebuffer, background included —
            // so untouched pixels come out BLACK. SleepActivity.cpp:222-224.
            planes[i] = (bits & PLANE_BW) !== 0 ? 3 : 0;
        }
    }
}

/**
 * Level plane -> opaque RGBA, ready for `preview_png.rgbaToPngDataUri`.
 *
 * @param levelLuminance 4 entries, indexed by level. Default
 *                       {@link PANEL_LEVEL_LUMINANCE}.
 */
export function levelsToRgba(
    levels: Uint8Array,
    levelLuminance: readonly number[] = PANEL_LEVEL_LUMINANCE
): Uint8Array {
    if (levelLuminance.length < PANEL_GRAY_LEVELS) {
        throw new Error(
            `levelLuminance needs ${PANEL_GRAY_LEVELS} entries, got ${levelLuminance.length}`
        );
    }
    const rgba = new Uint8Array(levels.length * 4);
    for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        if (level >= PANEL_GRAY_LEVELS) {
            // Unreachable from renderPanelLevels; a loud failure beats painting
            // `undefined` as 0 and calling it black.
            throw new Error(`level ${level} at ${i} is not a legal panel level`);
        }
        const v = levelLuminance[level];
        const di = i * 4;
        rgba[di] = v;
        rgba[di + 1] = v;
        rgba[di + 2] = v;
        rgba[di + 3] = 255;
    }
    return rgba;
}

/**
 * The one-call entry point: source pixels -> the panel's frame, as RGBA.
 *
 * Output is ALWAYS the logical screen size (528 x 792 portrait by default),
 * never the source's — that is the point. Feed the result straight to
 * `rgbaToPngDataUri` at these dimensions and show it at native resolution; a
 * downscale would average the dither back into the smooth gray this module
 * exists to stop showing.
 */
export function renderPanelPreview(
    source: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    opts: PanelPreviewOptions = {}
): PanelPreviewResult {
    const rendered = renderPanelLevels(source, width, height, opts);
    return {
        ...rendered,
        rgba: levelsToRgba(rendered.levels, opts.levelLuminance ?? PANEL_LEVEL_LUMINANCE),
    };
}

/**
 * Count how many pixels landed on each level. Diagnostic — the histogram is what
 * `scripts/panel-render.test.js` asserts the "only 4 legal levels" claim on, and
 * it is cheap enough to keep for a future UI readout.
 */
export function panelLevelHistogram(levels: Uint8Array): number[] {
    const counts = new Array<number>(PANEL_GRAY_LEVELS).fill(0);
    for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        if (level >= PANEL_GRAY_LEVELS) {
            throw new Error(`level ${level} at ${i} is not a legal panel level`);
        }
        counts[level]++;
    }
    return counts;
}

function assertPositiveInt(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got ${value}`);
    }
}
