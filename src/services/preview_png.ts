/**
 * preview_png — RGBA bytes -> PNG data URI, the only way an in-memory preview
 * buffer reaches an `<Image>`.
 *
 * `prepareLoveNoteFrame` / `prepareWallpaperBmp` hand back `previewRgba`: the
 * EXACT pixels the packer dithered, in memory, with no file behind them. React
 * Native's `<Image>` renders a `uri` and nothing else, so those bytes have to be
 * re-encoded as a PNG data URI before the user can see what is about to be sent.
 * Writing a temp file instead would put a cache-eviction race between "preview"
 * and "send" for a picture the user is looking at; a data URI has no such gap.
 *
 * PURE TypeScript. No React Native imports, no I/O — upng-js and the chunked
 * base64 helpers are Hermes-safe AND node-safe, so `scripts/preview-png.test.js`
 * imports this file directly and CI covers the encode arithmetic instead of a
 * device screenshot doing it.
 *
 * PNG (not JPEG) because these previews are 1-bit-dithered: JPEG ringing turns
 * a clean dither into mush, and the whole point of the preview is that it is
 * pixel-identical to the frame the panel will show.
 */

import UPNG from 'upng-js';
import { uint8ArrayToBase64 } from '../utils/base64';
import { conformRgba } from './image_geometry';

/** Prefix an `<Image source={{ uri }}>` needs in front of raw base64 PNG. */
export const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

/**
 * Width of the thumbnails stored in message history.
 *
 * History rows are list-sized, and the blob lives in AsyncStorage next to 99
 * siblings — a full 528x792 preview is ~30 KB of base64 EACH, which is how a
 * history store turns into a multi-megabyte read on every app start. 64 px is
 * comfortably above the rendered row height on a 3x-density phone.
 */
export const THUMBNAIL_WIDTH = 64;

/**
 * Encode an RGBA buffer as lossless PNG bytes.
 *
 * Throws on a geometry mismatch rather than encoding garbage: a buffer that is
 * not `width * height * 4` bytes means the caller mixed up a source size with a
 * decoded size, and a silently mis-encoded preview is indistinguishable from a
 * mis-encoded frame — exactly the confusion the preview exists to prevent.
 */
export function rgbaToPngBytes(rgba: Uint8Array, width: number, height: number): Uint8Array {
    assertPositiveInt('width', width);
    assertPositiveInt('height', height);

    const expected = width * height * 4;
    if (rgba.length !== expected) {
        throw new Error(
            `rgbaToPngBytes expects ${expected} RGBA bytes (${width}x${height}x4), got ${rgba.length}`
        );
    }

    // `slice()` rather than handing over `rgba.buffer`: the caller's buffer may
    // be a view into a larger allocation (subarray of a decode buffer), and
    // UPNG takes whole ArrayBuffers. The copy also keeps this function free of
    // any observable effect on its input.
    //
    // `forbidPlte = true` IS LOAD-BEARING. upng-js picks a PLTE encoding
    // whenever the image has few enough distinct colours — which is EVERY
    // dithered love-note preview — and that path emits a CORRUPT file: the
    // final IDAT chunk claims more bytes than the buffer holds and no IEND is
    // written at all (pinned in scripts/preview-png.test.js). `<Image>` renders
    // that as a broken placeholder. The non-palette path is valid, and for the
    // two-tone previews this module exists to show it is also SMALLER: 132 B vs
    // 676 B on the 16x9 fixture, because the palette path pays for a PLTE plus
    // a full tRNS table it does not need.
    const encoded = UPNG.encode(
        [rgba.slice().buffer as ArrayBuffer],
        width,
        height,
        0, // lossless: no colour quantization, the preview must be exact
        undefined,
        true
    );
    return new Uint8Array(encoded);
}

/** Encode an RGBA buffer as base64 PNG, WITHOUT the data-URI prefix. */
export function rgbaToPngBase64(rgba: Uint8Array, width: number, height: number): string {
    return uint8ArrayToBase64(rgbaToPngBytes(rgba, width, height));
}

/**
 * Encode an RGBA buffer as a `data:image/png;base64,...` URI.
 *
 * This is the string that goes straight into `<Image source={{ uri }}>`.
 */
export function rgbaToPngDataUri(rgba: Uint8Array, width: number, height: number): string {
    return PNG_DATA_URI_PREFIX + rgbaToPngBase64(rgba, width, height);
}

/**
 * Downscale an RGBA buffer to `targetWidth` (aspect preserved) and encode it as
 * base64 PNG — the value `MessageRecord.thumbnailPngBase64` holds.
 *
 * Never upscales: a source narrower than the target is encoded as-is, so a
 * 32 px doodle stays 32 px instead of being blown up into four times the bytes.
 */
export function rgbaToThumbnailBase64(
    rgba: Uint8Array,
    width: number,
    height: number,
    targetWidth: number = THUMBNAIL_WIDTH
): string {
    assertPositiveInt('width', width);
    assertPositiveInt('height', height);
    assertPositiveInt('targetWidth', targetWidth);

    const dstW = Math.min(targetWidth, width);
    const dstH = Math.max(1, Math.round((height * dstW) / width));

    // 'fit' rather than 'cover': dstW/dstH already carries the source aspect, so
    // both modes resample the same rectangle — but 'fit' cannot crop even if the
    // integer rounding above lands a pixel off.
    const scaled = conformRgba(rgba, width, height, dstW, dstH, 'fit');
    return rgbaToPngBase64(scaled, dstW, dstH);
}

/** Prefix a stored bare-base64 thumbnail for `<Image source={{ uri }}>`. */
export function pngBase64ToDataUri(base64: string): string {
    return base64.startsWith('data:') ? base64 : PNG_DATA_URI_PREFIX + base64;
}

function assertPositiveInt(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got ${value}`);
    }
}
