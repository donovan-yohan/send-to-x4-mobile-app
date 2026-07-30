/**
 * Wallpaper encoder: RGBA -> 8-bit grayscale BMP for the X3 permanent
 * wallpaper (`/sleep.bmp`, `/.sleep/<n>.bmp`).
 *
 * These tests import the REAL encoder from src/services/wallpaper_encoder.ts —
 * never a re-declared copy — so a regression in the shipped implementation
 * fails here. The tsx loader resolves the extensionless .ts import.
 *
 * The BMP is validated two ways, on purpose:
 *   1. Byte-offset assertions against the documented header layout.
 *   2. `parseBmp()` below — an INDEPENDENT parser written from the BMP spec,
 *      touching none of the encoder's internals — used to round-trip images.
 * If both agree, the file is a real BMP and not just self-consistent.
 *
 * Format contract (verified against the CrossPoint firmware's own
 * JpegToBmpConverter output): 8 bpp, BI_RGB, 256-entry grayscale palette,
 * bottom-up rows padded to 4 bytes, NO X-mirror, NO rotation.
 *
 * Run:  node --import tsx --test scripts/wallpaper-encoder.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
    encodeWallpaperBmp,
    wallpaperRowStride,
    wallpaperBmpSize,
    WALLPAPER_BMP_PIXEL_OFFSET,
    WALLPAPER_BMP_PALETTE_BYTES,
    WALLPAPER_LONG_SIDE_PX,
} from '../src/services/wallpaper_encoder';

// ---------------------------------------------------------------------------
// Independent BMP parser — spec-derived, shares nothing with the encoder.
// ---------------------------------------------------------------------------

/**
 * Decode a BMP into { width, height, pixels } with pixels in TOP-DOWN order,
 * resolved through the palette. Deliberately re-derives the row stride from
 * biBitCount rather than reusing the encoder's helper.
 */
function parseBmp(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'BM', 'BMP magic');

    const fileSize = view.getUint32(2, true);
    const offBits = view.getUint32(10, true);
    const infoSize = view.getUint32(14, true);
    const width = view.getInt32(18, true);
    const rawHeight = view.getInt32(22, true);
    const planes = view.getUint16(26, true);
    const bitCount = view.getUint16(28, true);
    const compression = view.getUint32(30, true);
    const sizeImage = view.getUint32(34, true);
    const clrUsed = view.getUint32(46, true);
    const clrImportant = view.getUint32(50, true);

    assert.equal(fileSize, bytes.length, 'bfSize must equal the real file length');
    assert.equal(compression, 0, 'only BI_RGB is decodable here');

    const bottomUp = rawHeight > 0;
    const height = Math.abs(rawHeight);

    // Palette: clrUsed entries (0 means the full 2^bitCount set), BGRA each.
    const paletteOffset = 14 + infoSize;
    const paletteCount = clrUsed === 0 ? 1 << bitCount : clrUsed;
    const palette = [];
    for (let i = 0; i < paletteCount; i++) {
        const o = paletteOffset + i * 4;
        palette.push({ b: bytes[o], g: bytes[o + 1], r: bytes[o + 2], reserved: bytes[o + 3] });
    }
    assert.equal(offBits, paletteOffset + paletteCount * 4, 'bfOffBits must follow the palette');

    // Every entry must be gray — checked once here, not per pixel.
    const grayForIndex = new Uint8Array(256).fill(0xff);
    for (let i = 0; i < paletteCount; i++) {
        const { r, g, b } = palette[i];
        assert.equal(r, g, `palette[${i}] must be gray`);
        assert.equal(g, b, `palette[${i}] must be gray`);
        grayForIndex[i] = r;
    }

    // Rows are ceil(bits/32) 32-bit words wide.
    const stride = Math.ceil((width * bitCount) / 32) * 4;
    assert.equal(sizeImage, stride * height, 'biSizeImage must match the padded pixel block');
    assert.equal(offBits + stride * height, fileSize, 'pixel block must fill the file');

    // Resolve indices through the palette into gray values, top-down.
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const storedRow = bottomUp ? height - 1 - y : y;
        const rowStart = offBits + storedRow * stride;
        for (let x = 0; x < width; x++) {
            const index = bytes[rowStart + x];
            if (index >= paletteCount) {
                assert.fail(`palette index ${index} out of range at (${x},${y})`);
            }
            pixels[y * width + x] = grayForIndex[index];
        }
    }

    return {
        width,
        height,
        bottomUp,
        planes,
        bitCount,
        compression,
        infoSize,
        offBits,
        fileSize,
        sizeImage,
        clrUsed,
        clrImportant,
        stride,
        palette,
        pixels,
        pixelAt(x, y) {
            return pixels[y * width + x];
        },
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build top-down RGBA from a per-pixel callback returning [r,g,b,a]. */
function makeRgba(width, height, fn) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a = 255] = fn(x, y);
            const i = (y * width + x) * 4;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = a;
        }
    }
    return rgba;
}

/** Opaque gray image from a per-pixel gray callback. */
function makeGrayRgba(width, height, fn) {
    return makeRgba(width, height, (x, y) => {
        const v = fn(x, y);
        return [v, v, v, 255];
    });
}

const NO_AC = { autocontrast: false };

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

test('header: every field of the 54-byte block is exactly as the firmware expects', () => {
    const width = WALLPAPER_LONG_SIDE_PX;
    const height = 792;
    const rgba = makeGrayRgba(width, height, (x) => x & 0xff);
    const { bmp } = encodeWallpaperBmp(rgba, width, height, NO_AC);
    const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);

    const stride = width; // 1056 % 4 === 0
    const pixelDataSize = stride * height;
    const fileSize = 1078 + pixelDataSize;

    // BITMAPFILEHEADER
    assert.equal(bmp[0], 0x42, "magic byte 0 = 'B'");
    assert.equal(bmp[1], 0x4d, "magic byte 1 = 'M'");
    assert.equal(view.getUint32(2, true), fileSize, 'bfSize');
    assert.equal(bmp.length, fileSize, 'actual byte length');
    assert.equal(view.getUint16(6, true), 0, 'bfReserved1');
    assert.equal(view.getUint16(8, true), 0, 'bfReserved2');
    assert.equal(view.getUint32(10, true), 54 + 1024, 'bfOffBits = 54 + 1024 = 1078');
    assert.equal(view.getUint32(10, true), WALLPAPER_BMP_PIXEL_OFFSET, 'bfOffBits const agrees');

    // BITMAPINFOHEADER — the 40-byte flavour only.
    assert.equal(view.getUint32(14, true), 40, 'biSize');
    assert.equal(view.getInt32(18, true), width, 'biWidth');
    assert.equal(view.getInt32(22, true), height, 'biHeight');
    assert.ok(view.getInt32(18, true) > 0, 'biWidth sign: positive');
    assert.ok(view.getInt32(22, true) > 0, 'biHeight sign: positive => bottom-up rows');
    assert.equal(view.getUint16(26, true), 1, 'biPlanes');
    assert.equal(view.getUint16(28, true), 8, 'biBitCount = 8 (palettised gray)');
    assert.equal(view.getUint32(30, true), 0, 'biCompression = BI_RGB');
    assert.equal(view.getUint32(34, true), pixelDataSize, 'biSizeImage');
    assert.equal(view.getInt32(38, true), 2835, 'biXPelsPerMeter');
    assert.equal(view.getInt32(42, true), 2835, 'biYPelsPerMeter');
    assert.equal(view.getUint32(46, true), 256, 'biClrUsed = 256');
    assert.equal(view.getUint32(50, true), 0, 'biClrImportant = 0 (all)');
});

test('header: a 24-bit BMP would be wrong — bit depth and compression are pinned', () => {
    // The legacy X4 screensaver encoder emits 24-bit BI_RGB with no palette.
    // Emitting that here makes the firmware's hasGreyscale() false and loses the
    // multi-pass gray render, so pin the two fields that distinguish them.
    const { bmp } = encodeWallpaperBmp(makeGrayRgba(8, 8, () => 128), 8, 8);
    const parsed = parseBmp(bmp);
    assert.equal(parsed.bitCount, 8);
    assert.equal(parsed.compression, 0);
    assert.equal(parsed.infoSize, 40);
    assert.equal(parsed.planes, 1);
    assert.equal(parsed.bottomUp, true);
});

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

test('palette: 1024 bytes, 256 entries, entry i = (i,i,i,0), strictly monotonic', () => {
    const { bmp } = encodeWallpaperBmp(makeGrayRgba(4, 4, () => 0), 4, 4);

    assert.equal(WALLPAPER_BMP_PALETTE_BYTES, 1024);
    const paletteStart = 54;
    const paletteEnd = paletteStart + 1024;
    assert.equal(paletteEnd, WALLPAPER_BMP_PIXEL_OFFSET, 'palette runs 54..1078');

    let previous = -1;
    for (let i = 0; i < 256; i++) {
        const o = paletteStart + i * 4;
        assert.equal(bmp[o], i, `palette[${i}].B`);
        assert.equal(bmp[o + 1], i, `palette[${i}].G`);
        assert.equal(bmp[o + 2], i, `palette[${i}].R`);
        assert.equal(bmp[o + 3], 0, `palette[${i}].reserved`);
        assert.ok(bmp[o + 2] > previous, `palette must increase monotonically at ${i}`);
        previous = bmp[o + 2];
    }
    assert.equal(previous, 255, 'palette ends at white');
});

// ---------------------------------------------------------------------------
// Row padding + size formula
// ---------------------------------------------------------------------------

test('row padding: stride rounds up to 4 bytes and pad bytes are zero', () => {
    // 1056 needs no padding (1056 % 4 === 0); the odd widths do.
    const cases = [
        { width: 1056, pad: 0 },
        { width: 1055, pad: 1 },
        { width: 1054, pad: 2 },
        { width: 1053, pad: 3 },
        { width: 1, pad: 3 },
    ];
    const height = 5;

    for (const { width, pad } of cases) {
        const stride = width + pad;
        assert.equal(stride % 4, 0, `stride for ${width} must be 4-aligned`);
        assert.equal(wallpaperRowStride(width), stride, `wallpaperRowStride(${width})`);

        // Non-zero pixel values everywhere, so a stray pixel in the pad region
        // would be visible rather than coincidentally zero.
        const rgba = makeGrayRgba(width, height, () => 200);
        const { bmp } = encodeWallpaperBmp(rgba, width, height, NO_AC);

        const expectedSize = stride * height + 1078;
        assert.equal(bmp.length, expectedSize, `file size for ${width}x${height}`);
        assert.equal(wallpaperBmpSize(width, height), expectedSize, 'wallpaperBmpSize agrees');

        for (let row = 0; row < height; row++) {
            const rowStart = 1078 + row * stride;
            for (let x = 0; x < width; x++) {
                assert.equal(bmp[rowStart + x], 200, `pixel byte row ${row} col ${x}`);
            }
            for (let p = 0; p < pad; p++) {
                assert.equal(bmp[rowStart + width + p], 0, `pad byte ${p} of row ${row}`);
            }
        }

        // The independent parser must agree on the padded geometry.
        const parsed = parseBmp(bmp);
        assert.equal(parsed.stride, stride);
        assert.equal(parsed.width, width);
        assert.equal(parsed.height, height);
    }
});

test('file size formula: (width + pad) * height + 1078 for many shapes', () => {
    for (const [width, height] of [
        [1056, 792],
        [1053, 100],
        [792, 528],
        [3, 7],
        [1, 1],
    ]) {
        const rgba = makeGrayRgba(width, height, () => 10);
        const { bmp } = encodeWallpaperBmp(rgba, width, height, NO_AC);
        const pad = (4 - (width % 4)) % 4;
        assert.equal(bmp.length, (width + pad) * height + 1078, `${width}x${height}`);
    }
});

// ---------------------------------------------------------------------------
// Row order (bottom-up) and orientation (no mirror, no rotation)
// ---------------------------------------------------------------------------

test('rows are stored bottom-up: known pixels land in the expected raw offsets', () => {
    const width = 5;
    const height = 3;
    // Unique value per pixel so nothing can alias: v = 10 + y*20 + x.
    const gray = (x, y) => 10 + y * 20 + x;
    const rgba = makeGrayRgba(width, height, gray);
    const { bmp } = encodeWallpaperBmp(rgba, width, height, NO_AC);
    const stride = 8; // 5 -> 8

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const storedRow = height - 1 - y; // bottom-up
            const offset = 1078 + storedRow * stride + x;
            assert.equal(bmp[offset], gray(x, y), `source (${x},${y}) -> BMP row ${storedRow}`);
        }
    }

    // Top-left source pixel must be in the LAST stored row, first column.
    assert.equal(bmp[1078 + (height - 1) * stride], gray(0, 0));
    // Bottom-left source pixel must be in the FIRST stored row.
    assert.equal(bmp[1078], gray(0, height - 1));
});

test('no X-mirror and no rotation: decoded pixels sit at the same coordinates', () => {
    const width = 6;
    const height = 4;
    // Asymmetric both ways, so a mirror or a 90-degree turn cannot pass.
    const gray = (x, y) => 3 + x * 7 + y * 61;
    const rgba = makeGrayRgba(width, height, gray);
    const { bmp } = encodeWallpaperBmp(rgba, width, height, NO_AC);
    const parsed = parseBmp(bmp);

    assert.equal(parsed.width, width, 'width must not swap with height');
    assert.equal(parsed.height, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            assert.equal(parsed.pixelAt(x, y), gray(x, y), `(${x},${y})`);
        }
    }
    // Explicitly reject the mirrored reading of row 0.
    assert.notEqual(parsed.pixelAt(0, 0), gray(width - 1, 0), 'row 0 must not be reversed');
});

// ---------------------------------------------------------------------------
// Round trip through the independent parser
// ---------------------------------------------------------------------------

test('round trip: a 256-step gradient survives byte-exact with autocontrast off', () => {
    const width = 256;
    const height = 64;
    const rgba = makeGrayRgba(width, height, (x) => x);
    const { bmp, previewRgba } = encodeWallpaperBmp(rgba, width, height, NO_AC);
    const parsed = parseBmp(bmp);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            assert.equal(parsed.pixelAt(x, y), x, `gradient (${x},${y})`);
        }
    }

    // previewRgba is the same plane, top-down, opaque.
    assert.equal(previewRgba.length, width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = parsed.pixels[i];
        assert.equal(previewRgba[i * 4], v, `preview R at ${i}`);
        assert.equal(previewRgba[i * 4 + 1], v, `preview G at ${i}`);
        assert.equal(previewRgba[i * 4 + 2], v, `preview B at ${i}`);
        assert.equal(previewRgba[i * 4 + 3], 255, `preview A at ${i}`);
    }
});

test('round trip: an odd-width image survives (padding does not shift columns)', () => {
    const width = 1053;
    const height = 9;
    const gray = (x, y) => (x * 3 + y * 29) & 0xff;
    const { bmp } = encodeWallpaperBmp(makeGrayRgba(width, height, gray), width, height, NO_AC);
    const parsed = parseBmp(bmp);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            assert.equal(parsed.pixelAt(x, y), gray(x, y), `(${x},${y})`);
        }
    }
});

// ---------------------------------------------------------------------------
// Grayscale conversion
// ---------------------------------------------------------------------------

test('grayscale uses Rec. 601 weights', () => {
    const cases = [
        [[255, 0, 0], 76], // round(0.299 * 255) = round(76.245)
        [[0, 255, 0], 150], // round(0.587 * 255) = round(149.685)
        [[0, 0, 255], 29], // round(0.114 * 255) = round(29.07)
        [[255, 255, 255], 255],
        [[0, 0, 0], 0],
        [[128, 128, 128], 128],
    ];
    for (const [[r, g, b], expected] of cases) {
        const rgba = makeRgba(2, 2, () => [r, g, b, 255]);
        const { bmp } = encodeWallpaperBmp(rgba, 2, 2, NO_AC);
        const parsed = parseBmp(bmp);
        assert.equal(parsed.pixelAt(0, 0), expected, `rgb(${r},${g},${b})`);
    }
});

test('translucent pixels composite over white by default, and can be left raw', () => {
    const rgba = makeRgba(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [0, 0, 0, 128]));

    const flattened = parseBmp(encodeWallpaperBmp(rgba, 2, 1, NO_AC).bmp);
    assert.equal(flattened.pixelAt(0, 0), 255, 'alpha 0 black -> white paper');
    // (0 * 128 + 255 * 127) / 255 = 127.0
    assert.equal(flattened.pixelAt(1, 0), 127, 'alpha 128 black -> mid gray');

    const raw = parseBmp(
        encodeWallpaperBmp(rgba, 2, 1, { autocontrast: false, flattenAlpha: false }).bmp
    );
    assert.equal(raw.pixelAt(0, 0), 0, 'flattenAlpha:false ignores the alpha channel');
    assert.equal(raw.pixelAt(1, 0), 0);
});

// ---------------------------------------------------------------------------
// Autocontrast
// ---------------------------------------------------------------------------

test('autocontrast is on by default and stretches a low-contrast image about its midpoint', () => {
    // 40 distinct levels 100..139, 5 px each => 200 px, clip cut = 1 px.
    // lo = 100, hi = 139, range 39, gain = min(255/39, 2.5) = 2.5, mid = 119.5.
    const width = 200;
    const rgba = makeGrayRgba(width, 1, (x) => 100 + Math.floor(x / 5));

    const stretched = parseBmp(encodeWallpaperBmp(rgba, width, 1).bmp);
    assert.equal(stretched.pixelAt(0, 0), 79, 'round((100 - 119.5) * 2.5 + 127.5)');
    assert.equal(stretched.pixelAt(width - 1, 0), 176, 'round((139 - 119.5) * 2.5 + 127.5)');

    // Midpoint preserved: because the gain is capped, a stretch that did NOT
    // recentre would push the whole image dark (100..139 * 2.5 -> 0..97).
    // Input midpoint is 119.5 by construction; the output must land on 127.5.
    const afterMid = (stretched.pixelAt(0, 0) + stretched.pixelAt(width - 1, 0)) / 2;
    assert.equal(afterMid, 127.5);

    // Disabled => untouched.
    const plain = parseBmp(encodeWallpaperBmp(rgba, width, 1, NO_AC).bmp);
    assert.equal(plain.pixelAt(0, 0), 100);
    assert.equal(plain.pixelAt(width - 1, 0), 139);
});

test('autocontrast leaves a nearly flat image alone instead of amplifying noise', () => {
    // Range 7 (120..127) is below the minimum, and a solid fill has none at all.
    const narrow = makeGrayRgba(80, 1, (x) => 120 + Math.floor(x / 10));
    const narrowOut = parseBmp(encodeWallpaperBmp(narrow, 80, 1).bmp);
    for (let x = 0; x < 80; x++) {
        assert.equal(narrowOut.pixelAt(x, 0), 120 + Math.floor(x / 10), `narrow px ${x}`);
    }

    const flat = makeGrayRgba(16, 16, () => 200);
    const flatOut = parseBmp(encodeWallpaperBmp(flat, 16, 16).bmp);
    for (let i = 0; i < flatOut.pixels.length; i++) {
        assert.equal(flatOut.pixels[i], 200, `flat px ${i}`);
    }
});

test('autocontrast on an already full-range image barely moves it', () => {
    const width = 256;
    const height = 8;
    const rgba = makeGrayRgba(width, height, (x) => x);

    // With no tail clipping, lo/hi are exactly 0/255 and the pass short-circuits
    // to a bit-exact no-op.
    const exact = encodeWallpaperBmp(rgba, width, height, { autocontrastClip: 0 }).bmp;
    const plain = encodeWallpaperBmp(rgba, width, height, NO_AC).bmp;
    assert.deepEqual(exact, plain, 'a 0..255 image has nothing to stretch');

    // With the default 0.5% clip the endpoints move inward by a pixel of value,
    // so the gain is ~1.008 — visually identity, and monotonic either way.
    const stretched = parseBmp(encodeWallpaperBmp(rgba, width, height).bmp);
    for (let x = 0; x < width; x++) {
        const out = stretched.pixelAt(x, 0);
        assert.ok(Math.abs(out - x) <= 2, `default autocontrast near-identity at ${x}: ${out}`);
        if (x > 0) {
            assert.ok(out >= stretched.pixelAt(x - 1, 0), `must stay monotonic at ${x}`);
        }
    }
    assert.equal(stretched.pixelAt(0, 0), 0, 'still reaches black');
    assert.equal(stretched.pixelAt(width - 1, 0), 255, 'still reaches white');
});

test('autocontrastMaxGain caps the stretch (and a high cap lets it go full range)', () => {
    const width = 200;
    const rgba = makeGrayRgba(width, 1, (x) => 100 + Math.floor(x / 5));

    const gentle = parseBmp(encodeWallpaperBmp(rgba, width, 1, { autocontrastMaxGain: 1 }).bmp);
    assert.equal(gentle.pixelAt(0, 0), 108, 'gain 1 only recenters: 100 - 119.5 + 127.5');
    assert.equal(gentle.pixelAt(width - 1, 0), 147);

    const hard = parseBmp(encodeWallpaperBmp(rgba, width, 1, { autocontrastMaxGain: 99 }).bmp);
    assert.equal(hard.pixelAt(0, 0), 0, 'uncapped gain reaches black');
    assert.equal(hard.pixelAt(width - 1, 0), 255, 'uncapped gain reaches white');
});

test('autocontrastClip ignores outlier tails', () => {
    // 98 mid-gray pixels plus one pure-black and one pure-white outlier.
    const width = 100;
    const rgba = makeGrayRgba(width, 1, (x) => {
        if (x === 0) return 0;
        if (x === width - 1) return 255;
        return 100 + Math.floor((x - 1) / 5);
    });

    // clip 0 keeps the outliers: lo = 0, hi = 255 => already full range, no-op.
    const unclipped = parseBmp(encodeWallpaperBmp(rgba, width, 1, { autocontrastClip: 0 }).bmp);
    assert.equal(unclipped.pixelAt(1, 0), 100, 'no clipping => no stretch at all');
    assert.equal(unclipped.pixelAt(width - 2, 0), 119);

    // clip 0.02 (2 px per tail) drops them, exposing the real 100..119 body:
    // lo = 100, hi = 119, gain = min(255/19, 2.5) = 2.5, mid = 109.5.
    const clipped = parseBmp(encodeWallpaperBmp(rgba, width, 1, { autocontrastClip: 0.02 }).bmp);
    assert.equal(clipped.pixelAt(1, 0), 104, 'round((100 - 109.5) * 2.5 + 127.5)');
    assert.equal(clipped.pixelAt(width - 2, 0), 151, 'round((119 - 109.5) * 2.5 + 127.5)');
    const bodySpread = clipped.pixelAt(width - 2, 0) - clipped.pixelAt(1, 0);
    assert.ok(bodySpread > 19, `body spread must widen from 19, got ${bodySpread}`);
    assert.equal(clipped.pixelAt(0, 0), 0, 'the black outlier stays clamped at black');
    assert.equal(clipped.pixelAt(width - 1, 0), 255, 'the white outlier stays clamped at white');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('encoding is deterministic: identical input, byte-identical output', () => {
    const width = 129;
    const height = 37;
    const rgba = makeRgba(width, height, (x, y) => [
        (x * 5 + y) & 0xff,
        (x + y * 3) & 0xff,
        (x * y) & 0xff,
        255,
    ]);

    const a = encodeWallpaperBmp(rgba, width, height);
    const b = encodeWallpaperBmp(rgba, width, height);
    assert.deepEqual(a.bmp, b.bmp, 'bmp bytes');
    assert.deepEqual(a.previewRgba, b.previewRgba, 'preview bytes');

    // And the input buffer must not have been mutated on the way through.
    const c = encodeWallpaperBmp(rgba, width, height);
    assert.deepEqual(c.bmp, a.bmp, 'encoder must not mutate the caller RGBA');
});

test('result echoes the dimensions it encoded', () => {
    const out = encodeWallpaperBmp(makeGrayRgba(7, 11, () => 0), 7, 11);
    assert.equal(out.width, 7);
    assert.equal(out.height, 11);
    assert.equal(out.previewRgba.length, 7 * 11 * 4);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('bad input is rejected loudly rather than producing a corrupt wallpaper', () => {
    const ok = makeGrayRgba(4, 4, () => 0);

    assert.throws(
        () => encodeWallpaperBmp(new Uint8Array(4 * 4 * 4 - 4), 4, 4),
        /must be 64 bytes/,
        'short RGBA buffer'
    );
    assert.throws(
        () => encodeWallpaperBmp(new Uint8Array(4 * 4 * 4 + 4), 4, 4),
        /must be 64 bytes/,
        'long RGBA buffer'
    );
    assert.throws(() => encodeWallpaperBmp(ok, 0, 4), /width must be a positive integer/);
    assert.throws(() => encodeWallpaperBmp(ok, 4, 0), /height must be a positive integer/);
    assert.throws(() => encodeWallpaperBmp(ok, -4, 4), /width must be a positive integer/);
    assert.throws(() => encodeWallpaperBmp(ok, 4.5, 4), /width must be a positive integer/);
    assert.throws(() => encodeWallpaperBmp(ok, NaN, 4), /width must be a positive integer/);
    assert.throws(() => encodeWallpaperBmp(ok, 70000, 4), /width must be <= 65535/);
    assert.throws(() => wallpaperRowStride(0), /width must be a positive integer/);
    assert.throws(() => wallpaperBmpSize(0, 4), /width must be a positive integer/);
    assert.throws(() => wallpaperBmpSize(4, 0), /height must be a positive integer/);
});

// ---------------------------------------------------------------------------
// Realistic shape
// ---------------------------------------------------------------------------

test('a 1056-long-side wallpaper lands at the expected size and decodes cleanly', () => {
    const width = WALLPAPER_LONG_SIDE_PX;
    const height = 704; // 1056x704 = 3:2 source, firmware crops to the panel
    const rgba = makeRgba(width, height, (x, y) => [
        (x >> 2) & 0xff,
        (y >> 1) & 0xff,
        ((x + y) >> 2) & 0xff,
        255,
    ]);

    const { bmp, previewRgba } = encodeWallpaperBmp(rgba, width, height);
    assert.equal(bmp.length, 1056 * 704 + 1078, 'no padding at width 1056');

    const parsed = parseBmp(bmp);
    assert.equal(parsed.width, width);
    assert.equal(parsed.height, height);
    assert.equal(parsed.bitCount, 8);
    assert.equal(parsed.clrUsed, 256);
    assert.equal(previewRgba.length, width * height * 4);

    // Preview and BMP must describe the same image, pixel for pixel.
    for (let i = 0; i < parsed.pixels.length; i += 997) {
        assert.equal(previewRgba[i * 4], parsed.pixels[i], `preview vs bmp at ${i}`);
    }
});
