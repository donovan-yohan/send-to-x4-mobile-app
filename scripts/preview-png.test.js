/**
 * preview_png — the RGBA -> PNG data URI hop the e-ink preview renders through.
 *
 * The claim under test is LOSSLESSNESS: the preview exists so the user sees the
 * exact pixels the packer dithered, and a PNG that quantizes, drops alpha or
 * shifts a row turns "what you see is what the panel shows" into a lie that no
 * unit elsewhere would catch. Everything here decodes the emitted bytes back
 * with the same upng-js the app uses and compares byte-for-byte.
 *
 * Buffers are deliberately tiny — this suite runs alongside the frame packers
 * on a memory-capped runner.
 *
 * Run:  node --import tsx --test scripts/preview-png.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import UPNG from 'upng-js';

import {
    PNG_DATA_URI_PREFIX,
    THUMBNAIL_WIDTH,
    rgbaToPngBytes,
    rgbaToPngBase64,
    rgbaToPngDataUri,
    rgbaToThumbnailBase64,
    pngBase64ToDataUri,
} from '../src/services/preview_png';
import { base64ToUint8Array } from '../src/utils/base64';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Deterministic RGBA test pattern; `alpha` false pins every pixel opaque. */
function pattern(width, height, { alpha = false } = {}) {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0, p = 0; p < width * height; p++) {
        rgba[i++] = (p * 37) & 0xff;
        rgba[i++] = (p * 91 + 13) & 0xff;
        rgba[i++] = (p * 7 + 200) & 0xff;
        rgba[i++] = alpha ? (p * 53) & 0xff : 255;
    }
    return rgba;
}

/**
 * Walk the PNG chunk stream: `[length][type][data][crc]` from byte 8 on.
 * Reports whether a declared chunk length runs off the end of the buffer.
 */
function walkChunks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const types = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (offset + 12 + length > bytes.length) return { types: [...types, type], truncated: true };
        types.push(type);
        offset += 12 + length;
    }
    return { types, truncated: offset !== bytes.length };
}

/** Incompressible two-tone dither — the worst case for PNG size. */
function noise(width, height) {
    const rgba = new Uint8Array(width * height * 4);
    let seed = 12345;
    for (let p = 0; p < width * height; p++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        // High bit, not the low one: an LCG's low bit has period 2 and would
        // draw a tidy checkerboard that deflates away to nothing.
        const on = (seed >>> 16) % 2 === 0 ? 255 : 0;
        rgba[p * 4] = on;
        rgba[p * 4 + 1] = on;
        rgba[p * 4 + 2] = on;
        rgba[p * 4 + 3] = 255;
    }
    return rgba;
}

/** Decode PNG bytes back to a flat RGBA Uint8Array. */
function decodeRgba(bytes) {
    const decoded = UPNG.decode(bytes);
    const frames = UPNG.toRGBA8(decoded);
    assert.equal(frames.length, 1, 'expected a single-frame PNG');
    return { rgba: new Uint8Array(frames[0]), width: decoded.width, height: decoded.height };
}

test('rgbaToPngDataUri emits a data URI carrying real PNG bytes', () => {
    const uri = rgbaToPngDataUri(pattern(4, 3), 4, 3);

    assert.ok(uri.startsWith(PNG_DATA_URI_PREFIX), 'missing data-URI prefix');
    assert.equal(PNG_DATA_URI_PREFIX, 'data:image/png;base64,');

    const bytes = base64ToUint8Array(uri.slice(PNG_DATA_URI_PREFIX.length));
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), PNG_MAGIC);
});

test('the emitted file is a COMPLETE png — upng-js palette output is not', () => {
    // THE BUG THIS PINS: `UPNG.encode(..., 0)` with its default `forbidPlte`
    // picks a PLTE encoding for any image with few enough distinct colours, and
    // that path writes a final IDAT whose declared length runs past the end of
    // the buffer and never writes IEND at all. Every dithered preview is a
    // two-colour image, so the default would have shipped a truncated PNG that
    // `<Image>` renders as a broken placeholder. Walking the chunks is the only
    // way to see it: the bytes still start with the PNG magic, and UPNG's own
    // decoder returns an object rather than throwing.
    for (const [w, h] of [[16, 9], [24, 16], [1, 1]]) {
        const bytes = rgbaToPngBytes(pattern(w, h), w, h);
        const chunks = walkChunks(bytes);
        assert.equal(
            chunks.truncated,
            false,
            `${w}x${h}: chunk stream overruns the buffer (${chunks.types.join(' ')})`
        );
        assert.equal(chunks.types[0], 'IHDR', `${w}x${h}: first chunk is not IHDR`);
        assert.equal(chunks.types.at(-1), 'IEND', `${w}x${h}: file does not end with IEND`);
        assert.ok(chunks.types.includes('IDAT'), `${w}x${h}: no image data`);
        assert.equal(chunks.types.includes('PLTE'), false, `${w}x${h}: palette path re-enabled`);
    }
});

test('the encoded PNG round-trips pixel-for-pixel (opaque)', () => {
    const [w, h] = [16, 9];
    const rgba = pattern(w, h);
    const decoded = decodeRgba(rgbaToPngBytes(rgba, w, h));

    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual(decoded.rgba, rgba, 'preview pixels changed in the encode');
});

test('the encoded PNG round-trips pixel-for-pixel (with alpha)', () => {
    // A transparent PNG capture (the doodle canvas) must not have its alpha
    // flattened here — that decision belongs to the packer's white paper, not
    // to the preview encoder.
    const [w, h] = [8, 8];
    const rgba = pattern(w, h, { alpha: true });
    const decoded = decodeRgba(rgbaToPngBytes(rgba, w, h));

    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual(decoded.rgba, rgba);
});

test('a 1-bit-style two-tone buffer survives (the actual preview case)', () => {
    // What prepareLoveNoteFrame hands back: pure black and pure white only.
    const [w, h] = [24, 16];
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
        const on = ((p % w) + Math.floor(p / w)) % 2 === 0 ? 255 : 0;
        rgba[p * 4] = on;
        rgba[p * 4 + 1] = on;
        rgba[p * 4 + 2] = on;
        rgba[p * 4 + 3] = 255;
    }
    const decoded = decodeRgba(rgbaToPngBytes(rgba, w, h));
    assert.deepEqual(decoded.rgba, rgba, 'dither pattern did not survive the encode');
});

test('encoding is deterministic and leaves the input untouched', () => {
    const [w, h] = [12, 5];
    const rgba = pattern(w, h, { alpha: true });
    const before = rgba.slice();

    const first = rgbaToPngDataUri(rgba, w, h);
    const second = rgbaToPngDataUri(rgba, w, h);

    assert.equal(first, second, 'same pixels produced two different PNGs');
    assert.deepEqual(rgba, before, 'the encoder mutated the caller buffer');
});

test('a view into a larger buffer encodes as its own pixels', () => {
    // previewRgba can arrive as a subarray of a decode buffer; handing UPNG the
    // whole underlying ArrayBuffer would encode the neighbours instead.
    const [w, h] = [6, 4];
    const rgba = pattern(w, h);
    const backing = new Uint8Array(rgba.length + 64);
    backing.fill(0x5a);
    backing.set(rgba, 32);
    const view = backing.subarray(32, 32 + rgba.length);

    const decoded = decodeRgba(rgbaToPngBytes(view, w, h));
    assert.deepEqual(decoded.rgba, rgba);
});

test('rgbaToPngBase64 is the data URI without its prefix', () => {
    const [w, h] = [5, 5];
    const rgba = pattern(w, h);
    const base64 = rgbaToPngBase64(rgba, w, h);

    assert.equal(base64.startsWith('data:'), false);
    assert.equal(rgbaToPngDataUri(rgba, w, h), PNG_DATA_URI_PREFIX + base64);
    assert.equal(pngBase64ToDataUri(base64), PNG_DATA_URI_PREFIX + base64);
    // Already-prefixed values pass through, so a stored thumbnail from an older
    // build cannot end up double-prefixed and silently blank.
    assert.equal(pngBase64ToDataUri(PNG_DATA_URI_PREFIX + base64), PNG_DATA_URI_PREFIX + base64);
});

test('mismatched geometry throws instead of encoding garbage', () => {
    const rgba = pattern(4, 4);
    assert.throws(() => rgbaToPngBytes(rgba, 4, 3), /expects 48 RGBA bytes/);
    assert.throws(() => rgbaToPngBytes(rgba.subarray(0, 60), 4, 4), /got 60/);
});

test('non-positive or fractional dimensions throw', () => {
    const rgba = pattern(2, 2);
    for (const [w, h] of [[0, 2], [2, 0], [-2, 2], [2.5, 2], [NaN, 2], [2, Infinity]]) {
        assert.throws(
            () => rgbaToPngBytes(rgba, w, h),
            /must be a positive integer/,
            `${w}x${h} was accepted`
        );
    }
});

test('rgbaToThumbnailBase64 downscales to the history width, aspect kept', () => {
    const [w, h] = [200, 100];
    assert.equal(THUMBNAIL_WIDTH, 64);

    const decoded = decodeRgba(base64ToUint8Array(rgbaToThumbnailBase64(pattern(w, h), w, h)));
    assert.equal(decoded.width, THUMBNAIL_WIDTH);
    assert.equal(decoded.height, Math.round((h * THUMBNAIL_WIDTH) / w)); // 32
    assert.equal(decoded.rgba.length, decoded.width * decoded.height * 4);
});

test('rgbaToThumbnailBase64 keeps a portrait note portrait', () => {
    // The real shape: the 528x792 love-note preview, at 1/10 scale to stay cheap.
    const [w, h] = [66, 99];
    const decoded = decodeRgba(base64ToUint8Array(rgbaToThumbnailBase64(pattern(w, h), w, h)));
    assert.equal(decoded.width, 64);
    assert.equal(decoded.height, 96);
});

test('rgbaToThumbnailBase64 never upscales a small source', () => {
    const [w, h] = [20, 10];
    const rgba = pattern(w, h);
    const decoded = decodeRgba(base64ToUint8Array(rgbaToThumbnailBase64(rgba, w, h)));

    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    // Untouched geometry means untouched pixels.
    assert.deepEqual(decoded.rgba, rgba);
});

test('a 64 px thumbnail keeps a full history inside a sane blob budget', () => {
    // The number the 100-record cap in message_history rests on. Source is the
    // real love-note preview geometry (528x792) filled with INCOMPRESSIBLE
    // dither — a smooth fixture deflates to nothing and would make this pass
    // for the wrong reason.
    const [w, h] = [528, 792];
    const rgba = noise(w, h);
    const full = rgbaToPngBase64(rgba, w, h);
    const thumb = rgbaToThumbnailBase64(rgba, w, h);

    assert.ok(thumb.length * 10 < full.length, `thumb ${thumb.length} vs full ${full.length}`);
    // 100 rows of this is a few hundred KB — one AsyncStorage read, not a stall.
    assert.ok(thumb.length < 8 * 1024, `thumbnail base64 is ${thumb.length} B`);
    // Storing the full preview per row instead would be megabytes.
    assert.ok(full.length > 64 * 1024, `fixture is too compressible to prove anything: ${full.length} B`);
});

test('thumbnail encoding is deterministic', () => {
    const [w, h] = [50, 40];
    const rgba = pattern(w, h);
    assert.equal(rgbaToThumbnailBase64(rgba, w, h), rgbaToThumbnailBase64(rgba, w, h));
});
