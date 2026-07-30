/**
 * image_converter — user image -> device-ready payload.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS
 * ---------------------------------------------------------------------------
 * The single image FRONT-END for both device surfaces. It owns everything that
 * needs React Native (expo-image-manipulator, upng-js) and hands an exactly
 * sized RGBA buffer to one of the two PURE packers:
 *
 *   prepareLoveNoteFrame -> frame_encoder.encodeFrame       (1-bit .frame)
 *   prepareWallpaperBmp  -> wallpaper_encoder.encodeWallpaperBmp (8-bit gray BMP)
 *
 * Shared pipeline:
 *   1. probe / trust the source size
 *   2. manipulateAsync resize (+ crop for 'cover') — native, fast, good filter
 *   3. export lossless PNG (base64), decode to RGBA with upng-js (Hermes-safe)
 *   4. conform in JS to the EXACT target rect (image_geometry.conformRgba)
 *   5. pack
 *
 * Works entirely offline — no network calls.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE LOGIC LIVES
 * ---------------------------------------------------------------------------
 * Every decision about rectangles and pixels is in `image_geometry.ts`, which
 * is pure and node-testable (`scripts/image-geometry.test.js`). This file is
 * deliberately thin: platform calls, orchestration, and nothing else. That
 * split is what lets CI cover the arithmetic that decides whether a frame is
 * the exact size `encodeFrame` demands.
 *
 * ---------------------------------------------------------------------------
 * GEOMETRY OWNERSHIP
 * ---------------------------------------------------------------------------
 * Nothing here hard-codes panel numbers. Compose/panel geometry comes from
 * `src/device/x3.ts`; the wallpaper long-side suggestion comes from its owner,
 * `wallpaper_encoder.ts`. There are no duplicate constants in this file.
 *
 * That includes the love-note ORIENTATION: this file asks `composeDimsFor` /
 * `rotationForOrientation` for the target rectangle and the mapping, and never
 * branches on 'portrait' vs 'landscape' itself.
 */

import { manipulateAsync, SaveFormat, type Action } from 'expo-image-manipulator';
import UPNG from 'upng-js';

import {
    COMPOSE_H,
    COMPOSE_W,
    DEFAULT_NOTE_ORIENTATION,
    composeDimsFor,
    rotationForOrientation,
    type NoteOrientation,
} from '../device/x3';
import { base64ToUint8Array } from '../utils/base64';
import {
    buildFrameActions,
    conformRgba,
    naturalTarget,
    panelFramingTarget,
    type FitMode,
    type ImageSize,
} from './image_geometry';
import {
    encodeFrame,
    type EncodeFrameOptions,
    type FrameMode,
    type FrameRotation,
} from './frame_encoder';
import {
    WALLPAPER_LONG_SIDE_PX,
    encodeWallpaperBmp,
    type WallpaperEncodeOptions,
} from './wallpaper_encoder';
import {
    DEFAULT_PANEL_SCREEN_HEIGHT,
    DEFAULT_PANEL_SCREEN_WIDTH,
    renderPanelPreview,
    type SleepCoverFilter,
    type SleepCoverMode,
} from './panel_render';

export type { FitMode, FrameMode, FrameRotation, NoteOrientation };
export type { SleepCoverFilter, SleepCoverMode };
export {
    COMPOSE_W,
    COMPOSE_H,
    WALLPAPER_LONG_SIDE_PX,
    DEFAULT_NOTE_ORIENTATION,
    DEFAULT_PANEL_SCREEN_WIDTH,
    DEFAULT_PANEL_SCREEN_HEIGHT,
    composeDimsFor,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Shared by both prepare* entry points. */
export interface PrepareSourceOptions {
    /**
     * Source pixel size, when the caller already knows it (an image-picker
     * result, a share intent). Saves a probe pass. Wrong or missing values are
     * safe: step 4 conforms whatever actually comes out of the decoder.
     */
    sourceWidth?: number | null;
    sourceHeight?: number | null;
    /** Cover-crop (default) or white letterbox. See {@link FitMode}. */
    fit?: FitMode;
}

export interface PrepareLoveNoteOptions extends PrepareSourceOptions, EncodeFrameOptions {
    /**
     * How the note is composed — and therefore how the recipient holds the
     * reader to read it. Default {@link DEFAULT_NOTE_ORIENTATION} ('portrait'),
     * so every existing caller is unaffected.
     *
     * This single option drives the target canvas (528x792 vs 792x528), the
     * cover/fit arithmetic that lands the picture on it, AND the encoder's
     * rotation ('ccw' vs 'none'). An explicit `rotation` still wins if one is
     * passed — that stays a diagnostic lever — but it must match the
     * orientation's canvas or `encodeFrame` throws, which is the intended alarm.
     */
    orientation?: NoteOrientation;
}

export interface PrepareLoveNoteResult {
    /** Exactly X3_FRAME_BYTES, ready for `sendLoveNoteFrame`. */
    frame: Uint8Array;
    /**
     * `width` x `height` RGBA, post-dither, in COMPOSE space, unmirrored — i.e.
     * exactly what the panel will show, the way the user authored it.
     */
    previewRgba: Uint8Array;
    /**
     * Compose-canvas width for the chosen orientation: COMPOSE_W (528) for
     * portrait, PANEL_W (792) for landscape. Echoed so callers can size the
     * preview without re-deriving the geometry.
     */
    width: number;
    /** Compose-canvas height: COMPOSE_H (792) portrait, PANEL_H (528) landscape. */
    height: number;
    /** The orientation actually used, after defaulting. */
    orientation: NoteOrientation;
}

/**
 * Output framing for {@link prepareWallpaperBmp}.
 *
 *   'natural' Keep the source aspect ratio; the LONG side becomes `longSide`.
 *             The firmware's sleep-cover settings do the final scale/crop to
 *             the panel, so handing it the whole picture at ~2x panel
 *             resolution is the least destructive thing the app can do.
 *             Default.
 *   'panel'   Pre-frame to the SLEEP SCREEN EXACTLY — 528 x 792 PORTRAIT,
 *             applying `fit`. Use when the app — not the firmware — should
 *             decide what gets cropped or letterboxed.
 *
 * THE SLEEP SCREEN IS PORTRAIT, NOT LANDSCAPE. `SleepActivity.cpp:36` forces
 * `GfxRenderer::Orientation::Portrait`, where the logical screen is
 * panelHeight x panelWidth = 528 x 792 (GfxRenderer.cpp:1678-1704). This option
 * used to pre-frame to PANEL_W:PANEL_H (792x528, landscape), which meant every
 * "panel-framed" wallpaper the app uploaded arrived as a wide strip that the
 * firmware then letterboxed into the tall screen with ~220 px of white above and
 * below it. A love-note FRAME is landscape (it is the raw panel buffer); a
 * WALLPAPER is not, and the two must not share a constant.
 *
 * AND IT IS THE SCREEN'S OWN SIZE, NOT 2x IT. 'panel' framing used to emit
 * 704x1056 (`longSide` tall at the screen's aspect) and leave the firmware to
 * downscale by 0.75 — with a nearest-neighbour scatter whose per-plane OR makes
 * ink win, measurably darkening the picture for no gain, since `drawBitmap`
 * never upscales anyway. Once the APP owns the crop, the app's own box-filter
 * resampler is strictly better than that scatter. See
 * {@link panelFramingTarget}, which carries the measurements.
 *
 * WHAT 'panel' + `fit: 'cover'` THROWS AWAY IS A PRODUCT DECISION: a landscape
 * source is now cropped to the PORTRAIT sleep screen by the app (a 4000x3000
 * photo keeps its middle 528/792 of width), where the landscape pre-frame used
 * to keep the full width and let the firmware letterbox it. 'natural' framing is
 * the escape hatch for callers that want the whole picture to reach the device.
 */
export type WallpaperFraming = 'natural' | 'panel';

export interface PrepareWallpaperOptions extends PrepareSourceOptions, WallpaperEncodeOptions {
    /**
     * Long side of the output in px.
     *
     * Default WALLPAPER_LONG_SIDE_PX (1056) for 'natural' framing. IGNORED by
     * default on the 'panel' path, which frames to the sleep screen's own
     * 528x792 box; passing it there is a deliberate escape hatch that hands the
     * firmware a bigger bitmap and its lossy scatter downscale with it.
     */
    longSide?: number;
    /** See {@link WallpaperFraming}. Default 'natural'. */
    framing?: WallpaperFraming;
    /**
     * Also render the PANEL-TRUE preview (default true).
     *
     * It is a full Atkinson dither pass over the source plus a scatter into the
     * 528x792 screen — real work, on the order of the grayscale conversion
     * itself. Pass false when the caller only wants the BMP bytes (promotion,
     * the legacy screensaver entry point) and nothing will ever look at
     * `panelPreviewRgba`.
     */
    panelPreview?: boolean;
    /**
     * The reader's `sleepScreenCoverMode`, for the panel preview only — it does
     * NOT affect the uploaded bytes. Default 'fit', which is the device default
     * (CrossPointSettings.h:177). The app cannot read the real setting back, so
     * this is the user's to declare.
     */
    panelCoverMode?: SleepCoverMode;
    /**
     * The reader's `sleepScreenCoverFilter`, for the panel preview only.
     * Default 'none' (CrossPointSettings.h:179).
     */
    panelFilter?: SleepCoverFilter;
}

export interface PrepareWallpaperResult {
    /** Complete 8-bit grayscale BMP, ready to upload to `/sleep.bmp`. */
    bmp: Uint8Array;
    /**
     * `width` x `height` RGBA of the FILE's smooth 8-bit gray. What the BMP
     * holds — NOT what the panel shows.
     */
    filePreviewRgba: Uint8Array;
    /**
     * @deprecated Ambiguous historical name for {@link filePreviewRgba}, and the
     * same buffer. Showing it to a user as "the preview" is the bug this pair of
     * fields exists to end.
     */
    previewRgba: Uint8Array;
    /**
     * `panelWidth` x `panelHeight` RGBA of what the PANEL will actually display:
     * Atkinson-dithered to four levels and scattered onto the portrait sleep
     * screen, exactly as the firmware does it. Null when `panelPreview` is off.
     */
    panelPreviewRgba: Uint8Array | null;
    /**
     * The 0..3 level per panel pixel behind {@link panelPreviewRgba} — the raw
     * answer, before any level->luminance choice. Null when `panelPreview` is
     * off.
     */
    panelLevels: Uint8Array | null;
    /** Logical sleep-screen size. 528 x 792 — always, regardless of the source. */
    panelWidth: number;
    panelHeight: number;
    /** Size of the BMP (and of `filePreviewRgba`). */
    width: number;
    height: number;
}

/**
 * Sanity ceiling on a requested long side. Matches wallpaper_encoder's own
 * per-dimension cap, so an absurd `longSide` fails here with a clear message
 * instead of deep inside the packer.
 */
const MAX_LONG_SIDE_PX = 65535;

// ---------------------------------------------------------------------------
// Public API — love-note frame
// ---------------------------------------------------------------------------

/**
 * Source image -> a 52272-byte love-note frame plus its compose-space preview.
 *
 * The frame is TEMPORARY on the device (dismissing returns the reader to its
 * book), so this path optimises for legibility of the moment: dithered photo
 * mode and autocontrast on by default, both overridable per call via the
 * pass-through `mode` / `rotation` / `autocontrast` / `threshold` options.
 *
 * ORIENTATION is resolved ONCE, at the top, and the resulting target rectangle
 * is used by all three stages — the native resize/crop plan, the exact JS
 * conform, and the encoder. That is what keeps a landscape note's cover-crop and
 * fit-letterbox honest: they are computed against the SAME 792x528 rectangle the
 * panel will show, so the preview cannot disagree with the send.
 *
 * @param imageUri Local file URI or base64 data URI.
 */
export async function prepareLoveNoteFrame(
    imageUri: string,
    opts: PrepareLoveNoteOptions = {}
): Promise<PrepareLoveNoteResult> {
    const fit = opts.fit ?? 'cover';
    const orientation = opts.orientation ?? DEFAULT_NOTE_ORIENTATION;
    const { width: targetW, height: targetH } = composeDimsFor(orientation);
    const rotation = opts.rotation ?? rotationForOrientation(orientation);

    const source = await resolveSourceSize(imageUri, opts.sourceWidth, opts.sourceHeight);

    const decoded = await decodeToRgba(
        imageUri,
        buildFrameActions(targetW, targetH, fit, source)
    );

    const canvas = conformRgba(
        decoded.rgba,
        decoded.width,
        decoded.height,
        targetW,
        targetH,
        fit
    );

    const { frame, previewRgba } = encodeFrame(canvas, targetW, targetH, {
        mode: opts.mode,
        rotation,
        autocontrast: opts.autocontrast,
        threshold: opts.threshold,
    });

    return { frame, previewRgba, width: targetW, height: targetH, orientation };
}

// ---------------------------------------------------------------------------
// Public API — wallpaper BMP
// ---------------------------------------------------------------------------

/**
 * Source image -> an 8-bit grayscale BMP for `/sleep.bmp` (or `/.sleep/<n>.bmp`)
 * plus TWO previews.
 *
 * No dither and no rotation in the BYTES: `drawBitmap` on the device is
 * orientation-aware and does its own dither, so the wallpaper path uploads a
 * smooth 8-bit plane rather than halftoning it here (unlike the love-note path,
 * which must reach 1 bit itself and rotate 90 degrees CCW into the landscape
 * panel buffer). Neither path X-mirrors — see `src/device/x3.ts`.
 *
 * TWO PREVIEWS, BECAUSE THE FILE AND THE PANEL DISAGREE:
 *   `filePreviewRgba`  the smooth gray the BMP carries, at the BMP's size.
 *   `panelPreviewRgba` what the reader will actually put on glass — four levels,
 *                      Atkinson-dithered, on the 528x792 portrait sleep screen.
 *                      Produced by `panel_render.ts` from the encoder's OWN
 *                      `gray` buffer, so it cannot drift from the upload.
 *
 * @param imageUri Local file URI or base64 data URI.
 */
export async function prepareWallpaperBmp(
    imageUri: string,
    opts: PrepareWallpaperOptions = {}
): Promise<PrepareWallpaperResult> {
    const longSide = normaliseLongSide(opts.longSide);
    // Validated either way (an absurd value still throws above), but the 'panel'
    // path needs to tell "the caller asked for a size" from "nobody asked" — its
    // default is the SCREEN, not a long side. See WallpaperFraming.
    const explicitLongSide =
        opts.longSide === undefined || opts.longSide === null ? null : longSide;
    const framing = opts.framing ?? 'natural';
    const fit = opts.fit ?? 'cover';
    const source = await resolveSourceSize(imageUri, opts.sourceWidth, opts.sourceHeight);

    let target: ImageSize | null;
    let actions: Action[];

    if (framing === 'panel') {
        // The SLEEP SCREEN itself — 528x792 portrait — so the firmware's own
        // geometry comes out scale = 1, x = 0, y = 0 and the panel preview is
        // exact rather than an approximation of a downscale we cannot see.
        target = panelFramingTarget(
            { width: DEFAULT_PANEL_SCREEN_WIDTH, height: DEFAULT_PANEL_SCREEN_HEIGHT },
            explicitLongSide
        );
        actions = buildFrameActions(target.width, target.height, fit, source);
    } else if (source) {
        target = naturalTarget(source, longSide);
        // Constrain only the long side and let the native resize preserve the
        // ratio; conformRgba absorbs the +/-1 px rounding on the other axis.
        actions =
            source.width >= source.height
                ? [{ resize: { width: target.width } }]
                : [{ resize: { height: target.height } }];
    } else {
        // The probe failed (exotic codec, transient read error). Decode at
        // native size and scale in JS from the size the decoder reports.
        target = null;
        actions = [];
    }

    const decoded = await decodeToRgba(imageUri, actions);

    // 'natural' means "keep the source aspect ratio", so the target has to come
    // from the size the DECODER produced, never from the probe. The two can
    // disagree — an EXIF-rotated JPEG reports its pre-rotation size to the
    // picker while manipulateAsync applies ImageFixOrientationTransformer — and
    // a stale ratio here would make conformRgba cover-crop the picture to the
    // wrong shape (a portrait photo reported as 4000x3000 would lose its top
    // and bottom). 'panel' framing keeps its own fixed box: there the crop is
    // the point.
    const finalTarget =
        framing === 'panel' && target
            ? target
            : naturalTarget({ width: decoded.width, height: decoded.height }, longSide);

    const canvas = conformRgba(
        decoded.rgba,
        decoded.width,
        decoded.height,
        finalTarget.width,
        finalTarget.height,
        framing === 'panel' ? fit : 'cover'
    );

    const encoded = encodeWallpaperBmp(canvas, finalTarget.width, finalTarget.height, {
        autocontrast: opts.autocontrast,
        autocontrastClip: opts.autocontrastClip,
        autocontrastMaxGain: opts.autocontrastMaxGain,
        flattenAlpha: opts.flattenAlpha,
    });

    // `encoded.gray` — the very bytes inside the BMP — not `filePreviewRgba`
    // and not `canvas`. Autocontrast has already been applied to it, and it is
    // exactly what `Bitmap::readNextRow` will hand its ditherer, so there is no
    // way for the preview and the upload to describe different pictures.
    //
    // `bottomUp: true` matches `wallpaper_encoder.buildBmp`, which writes a
    // positive biHeight. It decides the direction the dither error travels, so
    // it is a correctness argument, not a formality.
    const panel =
        opts.panelPreview === false
            ? null
            : renderPanelPreview(encoded.gray, encoded.width, encoded.height, {
                  coverMode: opts.panelCoverMode ?? 'fit',
                  filter: opts.panelFilter ?? 'none',
                  bottomUp: true,
              });

    return {
        bmp: encoded.bmp,
        filePreviewRgba: encoded.filePreviewRgba,
        previewRgba: encoded.filePreviewRgba,
        panelPreviewRgba: panel ? panel.rgba : null,
        panelLevels: panel ? panel.levels : null,
        panelWidth: panel ? panel.width : DEFAULT_PANEL_SCREEN_WIDTH,
        panelHeight: panel ? panel.height : DEFAULT_PANEL_SCREEN_HEIGHT,
        width: encoded.width,
        height: encoded.height,
    };
}

// ---------------------------------------------------------------------------
// Legacy entry point
// ---------------------------------------------------------------------------

/**
 * @deprecated X4-era name, kept ONLY because two salvage-orphan modules still
 * import it (`sleepScreenService`, `screensaver_processor` — neither reachable
 * from App.tsx after the tab reshape; the third importer,
 * `ScreensaversScreen`, has since been deleted). It now produces
 * the X3 wallpaper format — an 8-bit grayscale BMP at long side
 * {@link WALLPAPER_LONG_SIDE_PX} — NOT the old 480x800 24-bit BMP, because the
 * X4 encoder it used to call (`bmp_encoder.ts`) has been deleted. New code must
 * call {@link prepareWallpaperBmp} or {@link prepareLoveNoteFrame} directly, and
 * take the preview buffer with it.
 */
export async function convertImageToScreensaverBmp(
    uri: string,
    sourceWidth?: number | null,
    sourceHeight?: number | null,
    customFilename?: string
): Promise<{ data: Uint8Array; filename: string }> {
    const { bmp } = await prepareWallpaperBmp(uri, {
        sourceWidth,
        sourceHeight,
        // Bytes only — nothing on this orphaned path renders a preview.
        panelPreview: false,
    });
    return {
        data: bmp,
        filename: customFilename || `screensaver_${Date.now()}.bmp`,
    };
}

// ---------------------------------------------------------------------------
// Step 1 — source size
// ---------------------------------------------------------------------------

function normaliseLongSide(value: number | undefined): number {
    const raw = value ?? WALLPAPER_LONG_SIDE_PX;
    if (!Number.isFinite(raw)) {
        throw new Error(`longSide must be a finite number, got ${value}`);
    }
    const rounded = Math.round(raw);
    if (rounded < 1 || rounded > MAX_LONG_SIDE_PX) {
        throw new Error(`longSide must be between 1 and ${MAX_LONG_SIDE_PX}, got ${value}`);
    }
    return rounded;
}

/**
 * Trust the caller's dimensions, else ask the native side.
 *
 * The probe is a no-op manipulate whose OUTPUT IS DISCARDED — only `width` and
 * `height` are read, and the real pass still runs against the ORIGINAL uri, so
 * nothing is encoded twice. Cheapest-quality JPEG keeps it fast; a PNG probe
 * would losslessly re-compress a 12 MP photo just to read two integers.
 *
 * Returns null rather than throwing: every caller has a working fallback, and
 * a genuinely unreadable image should fail in the decode with a real error,
 * not here.
 */
async function resolveSourceSize(
    uri: string,
    width?: number | null,
    height?: number | null
): Promise<ImageSize | null> {
    if (isPositiveSize(width) && isPositiveSize(height)) {
        return { width: Math.round(width), height: Math.round(height) };
    }
    try {
        const probe = await manipulateAsync(uri, [], {
            format: SaveFormat.JPEG,
            compress: 0,
            base64: false,
        });
        if (isPositiveSize(probe.width) && isPositiveSize(probe.height)) {
            return { width: Math.round(probe.width), height: Math.round(probe.height) };
        }
    } catch {
        // Fall through — the caller degrades gracefully.
    }
    return null;
}

function isPositiveSize(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Steps 2-3 — native plan + decode
// ---------------------------------------------------------------------------

interface DecodedImage {
    rgba: Uint8Array;
    width: number;
    height: number;
}

/**
 * Run the native plan, export lossless PNG, decode to RGBA.
 *
 * PNG (not JPEG) so the pixels the packer dithers are the pixels the resizer
 * produced; JPEG ringing around text is extremely visible after a 1-bit
 * reduction. upng-js rather than a canvas because Hermes has no DOM.
 *
 * The returned width/height come from the DECODER, not from `ImageResult`:
 * those are the ones that actually describe the buffer.
 */
async function decodeToRgba(uri: string, actions: Action[]): Promise<DecodedImage> {
    const result = await manipulateAsync(uri, actions, {
        format: SaveFormat.PNG,
        compress: 1, // lossless
        base64: true,
    });

    if (!result.base64) {
        throw new Error('ImageManipulator did not return base64 data');
    }

    const decoded = UPNG.decode(base64ToUint8Array(result.base64));
    const rgbaFrames = UPNG.toRGBA8(decoded);

    if (rgbaFrames.length === 0) {
        throw new Error('Failed to decode PNG image');
    }

    const rgba = new Uint8Array(rgbaFrames[0]);
    const expected = decoded.width * decoded.height * 4;
    if (
        !isPositiveSize(decoded.width) ||
        !isPositiveSize(decoded.height) ||
        rgba.length !== expected
    ) {
        throw new Error(
            `Decoded image is inconsistent: ${decoded.width}x${decoded.height} ` +
            `implies ${expected} RGBA bytes, got ${rgba.length}`
        );
    }

    return { rgba, width: decoded.width, height: decoded.height };
}
