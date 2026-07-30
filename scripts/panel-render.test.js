/**
 * panel_render: what the X3 e-ink panel ACTUALLY shows for an uploaded
 * `/sleep.bmp`, replicated from the CrossPoint firmware source.
 *
 * These tests import the REAL module from src/services/panel_render.ts — never a
 * re-declared copy — so a regression in the shipped implementation fails here.
 *
 * THREE INDEPENDENT KINDS OF EVIDENCE, on purpose:
 *
 *   1. HAND-COMPUTED LITERALS. The Atkinson arithmetic below is worked out by
 *      hand from the firmware formulas (BitmapHelpers.h:124-175) in the comments
 *      and the expected level arrays are written as literals. If the module and
 *      these disagree, one of them is wrong and the comment says which numbers
 *      the firmware produces.
 *   2. AN INDEPENDENT REFERENCE. `referenceRender()` re-implements the dither,
 *      the three-pass scatter and the plane combine with a DIFFERENT structure
 *      (whole-plane dither, three separate boolean planes, literally three
 *      passes) so agreeing with it is not agreeing with a transcription.
 *   3. THE FIRMWARE RECON'S OWN GEOMETRY TABLE, pinned row by row. It was
 *      produced by a separate float32 emulation during the read-only firmware
 *      recon, so it is an outside answer, not this module's output rounded.
 *
 * Run:  NODE_OPTIONS=--max-old-space-size=512 \
 *         timeout 60 node --import tsx --test scripts/panel-render.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    ATKINSON_ERROR_SHIFT,
    ATKINSON_QUANTIZED_VALUES,
    ATKINSON_THRESHOLDS,
    DEFAULT_PANEL_SCREEN_HEIGHT,
    DEFAULT_PANEL_SCREEN_WIDTH,
    PANEL_GRAY_LEVELS,
    PANEL_LEVEL_LUMINANCE,
    PANEL_LEVEL_LUMINANCE_NOMINAL,
    computeSleepGeometry,
    levelsToRgba,
    panelLevelHistogram,
    paletteLuma,
    renderPanelLevels,
    renderPanelPreview,
} from '../src/services/panel_render';
import { conformRgba, panelFramingTarget } from '../src/services/image_geometry';
import { COMPOSE_H, COMPOSE_W } from '../src/device/x3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull one row out of a level plane, as a plain array. */
function row(levels, width, y) {
    return Array.from(levels.subarray(y * width, y * width + width));
}

/** A deterministic, non-repeating byte source. No RNG — reruns must match. */
function pseudoGray(length, seed = 1) {
    const out = new Uint8Array(length);
    let s = seed >>> 0;
    for (let i = 0; i < length; i++) {
        // xorshift32 — cheap, deterministic, and spread across the whole range
        // so every quantization band gets exercised.
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        out[i] = s & 0xff;
    }
    return out;
}

/**
 * Photo-like: smooth low-frequency structure over the full tonal range, no
 * noise. Deterministic. Noise would dither to something close to uniform and
 * hide exactly the effect the scatter test below is measuring.
 */
function photoLike(w, h) {
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const u = x / (w - 1);
            const v = y / (h - 1);
            const val =
                128 +
                70 * Math.sin(6.0 * u + 1.2) * Math.cos(4.0 * v) +
                40 * Math.sin(11.0 * v + 0.4) +
                25 * Math.cos(17.0 * u * v);
            g[y * w + x] = Math.max(0, Math.min(255, Math.round(val)));
        }
    }
    return g;
}

/** Gray plane -> opaque RGBA, so conformRgba (which only speaks RGBA) can resample it. */
function grayToRgba(gray, w, h) {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < gray.length; i++) {
        rgba[i * 4] = gray[i];
        rgba[i * 4 + 1] = gray[i];
        rgba[i * 4 + 2] = gray[i];
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

/** ...and back. */
function rgbaToGray(rgba, n) {
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = rgba[i * 4];
    return g;
}

/** Mean displayed luminance of a level plane. The panel's own average tone. */
function meanPanelLuminance(levels) {
    let sum = 0;
    for (let i = 0; i < levels.length; i++) sum += PANEL_LEVEL_LUMINANCE[levels[i]];
    return sum / levels.length;
}

/** A left-to-right 0..255 ramp, repeated down the image. */
function horizontalRamp(width, height) {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            out[y * width + x] = Math.round((x * 255) / Math.max(1, width - 1));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// The independent reference — re-derived from the firmware, NOT from the module
// ---------------------------------------------------------------------------

/**
 * Quantize one already-error-adjusted sample. BitmapHelpers.h:147-161.
 * Written as an explicit table lookup rather than the module's if-chain.
 */
function refQuantize(adjusted) {
    const bounds = [30, 50, 140];
    const values = [15, 30, 80, 210];
    let level = 3;
    for (let i = 0; i < bounds.length; i++) {
        if (adjusted < bounds[i]) {
            level = i;
            break;
        }
    }
    return { level, quantized: values[level] };
}

/**
 * Dither the WHOLE source up front, in file order, into a level plane indexed by
 * IMAGE row. Different shape from the module (which streams a row at a time), so
 * agreement is a real cross-check of the error bookkeeping.
 */
function refDitherPlane(gray, width, height, bottomUp) {
    const levels = new Uint8Array(width * height);
    let e0 = new Int16Array(width + 4);
    let e1 = new Int16Array(width + 4);
    let e2 = new Int16Array(width + 4);

    for (let step = 0; step < height; step++) {
        const imageRow = bottomUp ? height - 1 - step : step;
        for (let x = 0; x < width; x++) {
            let adjusted = gray[imageRow * width + x] + e0[x + 2];
            adjusted = Math.max(0, Math.min(255, adjusted));
            const { level, quantized } = refQuantize(adjusted);
            levels[imageRow * width + x] = level;
            const error = (adjusted - quantized) >> 3;
            e0[x + 3] += error;
            e0[x + 4] += error;
            e1[x + 1] += error;
            e1[x + 2] += error;
            e1[x + 3] += error;
            e2[x + 2] += error;
        }
        const spent = e0;
        e0 = e1;
        e1 = e2;
        e2 = spent;
        e2.fill(0);
    }
    return levels;
}

/**
 * The three firmware passes, run LITERALLY as three passes into three separate
 * boolean planes, then combined. GfxRenderer.cpp:1345-1351 +
 * SleepActivity.cpp:215-251.
 *
 * Geometry comes from the module — it is pinned separately, row by row, against
 * the firmware recon's own float32 table (see the geometry test), so there is
 * nothing to gain from a second float32 transcription here.
 *
 * Only valid for fixtures where the `screenY >= SCREEN_H` break never fires; the
 * caller asserts that.
 */
function referenceRender(gray, width, height, opts = {}) {
    const geom = computeSleepGeometry(width, height, opts);
    const screenW = geom.screenWidth;
    const screenH = geom.screenHeight;
    const bottomUp = opts.bottomUp !== false;

    const sourceLevels = refDitherPlane(gray, width, height, bottomUp);

    const planes = {
        bw: new Uint8Array(screenW * screenH),
        msb: new Uint8Array(screenW * screenH),
        lsb: new Uint8Array(screenW * screenH),
    };
    const predicate = {
        bw: v => v < 3,
        msb: v => v === 1 || v === 2,
        lsb: v => v === 1,
    };

    for (const pass of ['bw', 'lsb', 'msb']) {
        const hit = predicate[pass];
        const plane = planes[pass];
        for (let imageRow = geom.cropPixY; imageRow < height - geom.cropPixY; imageRow++) {
            let sy = imageRow - geom.cropPixY;
            if (geom.isScaled) sy = Math.floor(Math.fround(sy * geom.scale));
            sy += geom.y;
            assert.ok(sy < screenH, 'reference fixture must not trigger the row break');
            if (sy < 0) continue;
            for (let bmpX = geom.cropPixX; bmpX < width - geom.cropPixX; bmpX++) {
                let sx = bmpX - geom.cropPixX;
                if (geom.isScaled) sx = Math.floor(Math.fround(sx * geom.scale));
                sx += geom.x;
                if (sx >= screenW) break;
                if (sx < 0) continue;
                if (hit(sourceLevels[imageRow * width + bmpX])) plane[sy * screenW + sx] = 1;
            }
        }
    }

    const out = new Uint8Array(screenW * screenH);
    for (let i = 0; i < out.length; i++) {
        out[i] = planes.msb[i] ? (planes.lsb[i] ? 1 : 2) : planes.bw[i] ? 0 : 3;
    }
    return { levels: out, width: screenW, height: screenH };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('the firmware constants are the LIVE ones, not the dead branches', () => {
    // BitmapHelpers.h:147-161. The 43/128/213 + 0/85/170/255 variant sits inside
    // `if (false)` at BitmapHelpers.h:133; quantizeSimple's 45/70/140
    // (BitmapHelpers.cpp:57-67) is the un-dithered book-cover path. Neither is
    // ours, and pinning the live values is what stops a future edit "tidying"
    // them into one of the lookalikes.
    assert.deepEqual(Array.from(ATKINSON_THRESHOLDS), [30, 50, 140]);
    assert.deepEqual(Array.from(ATKINSON_QUANTIZED_VALUES), [15, 30, 80, 210]);
    assert.equal(ATKINSON_ERROR_SHIFT, 3, 'Atkinson keeps 6/8 of the error');
    assert.equal(PANEL_GRAY_LEVELS, 4);
    assert.deepEqual(Array.from(PANEL_LEVEL_LUMINANCE_NOMINAL), [0, 85, 170, 255]);

    // The PAINT map is deliberately NOT the ditherer's reconstruction table.
    // [15, 30, 80, 210] are error-diffusion constants (BitmapHelpers.h:148-160),
    // and painting with them puts levels 0 and 1 fifteen units apart out of 255
    // — one visible tone where the preview claims four — and makes panel white
    // (210) DARKER than DevicePreview's unlit paper (#e9e8e3 = 233).
    assert.deepEqual(Array.from(PANEL_LEVEL_LUMINANCE), [0, 85, 170, 255]);
    assert.equal(PANEL_LEVEL_LUMINANCE.length, PANEL_GRAY_LEVELS);
    for (let i = 1; i < PANEL_LEVEL_LUMINANCE.length; i++) {
        assert.ok(
            PANEL_LEVEL_LUMINANCE[i] - PANEL_LEVEL_LUMINANCE[i - 1] >= 32,
            `levels ${i - 1} and ${i} must be far enough apart to read as two grays`
        );
    }
    // ...and it must not be darker than the bezel's paper, or a fit-mode
    // letterbox bar reads as a stain rather than as white.
    assert.ok(PANEL_LEVEL_LUMINANCE[PANEL_GRAY_LEVELS - 1] >= 0xe9, 'panel white >= PAPER');
});

test('THE SLEEP SCREEN IS PORTRAIT — the whole point of this change', () => {
    // SleepActivity.cpp:36 forces GfxRenderer::Orientation::Portrait, where the
    // logical screen is panelHeight x panelWidth (GfxRenderer.cpp:1678-1704).
    // The bug this replaces drew the preview at 792/528 = 1.5 (landscape).
    assert.equal(DEFAULT_PANEL_SCREEN_WIDTH, COMPOSE_W);
    assert.equal(DEFAULT_PANEL_SCREEN_HEIGHT, COMPOSE_H);
    assert.ok(
        DEFAULT_PANEL_SCREEN_WIDTH < DEFAULT_PANEL_SCREEN_HEIGHT,
        'the sleep screen is TALLER than it is wide — a book cover, not a strip'
    );
    assert.equal(DEFAULT_PANEL_SCREEN_WIDTH, 528);
    assert.equal(DEFAULT_PANEL_SCREEN_HEIGHT, 792);
});

test("'panel' framing lands 1:1 — the property that makes the preview EXACT", () => {
    // This is the box `image_converter.prepareWallpaperBmp` builds for
    // `framing: 'panel'`: panelFramingTarget(<the sleep screen>, no long side).
    const target = panelFramingTarget({
        width: DEFAULT_PANEL_SCREEN_WIDTH,
        height: DEFAULT_PANEL_SCREEN_HEIGHT,
    });
    assert.deepEqual(target, { width: 528, height: 792 });

    // scale === 1 && isScaled === false means drawBitmap's nearest-neighbour
    // scatter never runs: every source pixel owns exactly one panel pixel, so
    // the app's preview is the panel's frame rather than a guess at what a
    // many-to-one OR will do to it. x === y === 0 means no letterbox and no
    // top-left crop quirk either.
    for (const coverMode of ['fit', 'crop']) {
        const g = computeSleepGeometry(target.width, target.height, { coverMode });
        assert.equal(g.scale, 1, `${coverMode}: scale`);
        assert.equal(g.isScaled, false, `${coverMode}: isScaled`);
        assert.equal(g.cropPixX, 0, `${coverMode}: cropPixX`);
        assert.equal(g.cropPixY, 0, `${coverMode}: cropPixY`);
        assert.equal(g.x, 0, `${coverMode}: x`);
        assert.equal(g.y, 0, `${coverMode}: y`);
    }

    // The reader's cover MODE lives on the device with no read-back, so the two
    // modes producing the same frame is not a nicety — it is what lets the
    // screen show one honest preview instead of asking the user to guess.
    const gray = pseudoGray(target.width * target.height, 7);
    const fitted = renderPanelLevels(gray, target.width, target.height, { coverMode: 'fit' });
    const cropped = renderPanelLevels(gray, target.width, target.height, { coverMode: 'crop' });
    assert.deepEqual(Array.from(fitted.levels), Array.from(cropped.levels));

    // And an explicit long side is still an escape hatch, not a silent default.
    assert.deepEqual(
        panelFramingTarget(
            { width: DEFAULT_PANEL_SCREEN_WIDTH, height: DEFAULT_PANEL_SCREEN_HEIGHT },
            1056
        ),
        { width: 704, height: 1056 }
    );
});

test("the firmware's scatter DARKENS a picture, which is why 'panel' framing is 1:1", () => {
    // WHY THE APP STOPPED UPLOADING 704x1056 FOR `framing: 'panel'`.
    //
    // Both paths show the SAME picture on the SAME 528x792 screen. The only
    // difference is who does the 0.75 downscale:
    //
    //   704x1056  drawBitmap's nearest-neighbour SCATTER with a per-plane OR
    //             (GfxRenderer.cpp:1330-1351). One to four dithered source
    //             pixels land on each panel pixel and their planes OR together,
    //             so ink wins.
    //   528x792   conformRgba's area-average box filter, BEFORE the dither, and
    //             then scale = 1 so the scatter never runs at all.
    //
    // The extra resolution buys nothing either way: drawBitmap NEVER upscales
    // (GfxRenderer.cpp:1283-1286), and once the app owns the crop there is no
    // information for the firmware to use.
    const big = photoLike(704, 1056);
    const small = rgbaToGray(
        conformRgba(grayToRgba(big, 704, 1056), 704, 1056, 528, 792, 'cover'),
        528 * 792
    );

    // The box filter is tone-preserving: the two SOURCES describe the same
    // picture (measured 132.8 vs 132.9 mean gray), so anything that follows is
    // the rendering chain's doing, not the resampler's.
    const meanGray = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(
        Math.abs(meanGray(big) - meanGray(small)) < 1,
        'the app resampler must not shift the tone it is being compared on'
    );

    const scattered = renderPanelLevels(big, 704, 1056, { coverMode: 'fit' });
    const direct = renderPanelLevels(small, 528, 792, { coverMode: 'fit' });

    assert.equal(scattered.geometry.scale, 0.75, 'the old path really did scatter');
    assert.equal(direct.geometry.scale, 1, 'the new path does not');

    // Measured with PANEL_LEVEL_LUMINANCE = [0, 85, 170, 255]: 189.4 scattered
    // vs 197.3 direct, and white 129572 -> 162601. The margin is asserted
    // loosely because the luminance MAP is a tunable; the DIRECTION is not.
    const scatteredMean = meanPanelLuminance(scattered.levels);
    const directMean = meanPanelLuminance(direct.levels);
    assert.ok(
        directMean - scatteredMean > 3,
        `the scatter must come out measurably darker (scattered ${scatteredMean.toFixed(1)}, ` +
            `direct ${directMean.toFixed(1)})`
    );

    const scatteredHist = panelLevelHistogram(scattered.levels);
    const directHist = panelLevelHistogram(direct.levels);
    assert.ok(
        directHist[3] > scatteredHist[3] + 10000,
        `the scatter pushes tens of thousands of pixels out of white ` +
            `(${scatteredHist[3]} vs ${directHist[3]})`
    );

    // Both are still legal panel frames — this is a tone argument, not a bug.
    for (const hist of [scatteredHist, directHist]) {
        assert.equal(
            hist.reduce((s, v) => s + v, 0),
            528 * 792
        );
    }
});

test('paletteLuma is the firmware integer formula, and identity on gray', () => {
    // Bitmap.cpp:139 — (77*R + 150*G + 29*B) >> 8. The weights sum to 256, so an
    // identity gray ramp (which is exactly what wallpaper_encoder writes) maps
    // each index to itself: paletteLum[i] == i.
    for (const v of [0, 1, 17, 128, 200, 254, 255]) {
        assert.equal(paletteLuma(v, v, v), v, `gray ${v} must survive unchanged`);
    }
    assert.equal(paletteLuma(255, 0, 0), (77 * 255) >> 8);
    assert.equal(paletteLuma(0, 255, 0), (150 * 255) >> 8);
    assert.equal(paletteLuma(0, 0, 255), (29 * 255) >> 8);
});

// ---------------------------------------------------------------------------
// Hand-computed quantization
// ---------------------------------------------------------------------------

test('one mid-gray pixel quantizes to LIGHT GRAY and lands centred', () => {
    // Source 1x1 = 100, screen 4x4.
    //   geometry: 1 <= 4 and 1 <= 4, so the "fits" branch:
    //             x = (4-1)/2 = 1, y = (4-1)/2 = 1 (C++ integer division)
    //   dither  : adjusted = 100 + 0 = 100; 50 <= 100 < 140 -> level 2, qv 80
    //             error = (100 - 80) >> 3 = 2 (spent on neighbours that do not
    //             exist, so nothing else moves)
    //   planes  : val 2 -> BW (2 < 3) and MSB (val is 1 or 2), NOT LSB
    //   combine : msb && !lsb -> level 2
    const out = renderPanelLevels(Uint8Array.from([100]), 1, 1, {
        screenWidth: 4,
        screenHeight: 4,
    });

    assert.equal(out.width, 4);
    assert.equal(out.height, 4);
    assert.deepEqual(row(out.levels, 4, 0), [3, 3, 3, 3]);
    assert.deepEqual(row(out.levels, 4, 1), [3, 2, 3, 3], 'the one drawn pixel');
    assert.deepEqual(row(out.levels, 4, 2), [3, 3, 3, 3]);
    assert.deepEqual(row(out.levels, 4, 3), [3, 3, 3, 3]);
});

test('a four-pixel row hits all four levels, with the error carried forward', () => {
    // Source 4x1 = [0, 40, 100, 200], screen 8x8.
    //   geometry: fits -> x = (8-4)/2 = 2, y = (8-1)/2 = 3, scale 1
    //   dither, left to right, error rows start at zero:
    //     x=0  adjusted =   0 +  0 =   0  -> level 0 (< 30),  qv  15
    //          error = (0 - 15) >> 3 = -15 >> 3 = -2   (arithmetic shift FLOORS)
    //          e0[3] = -2, e0[4] = -2
    //     x=1  adjusted =  40 + (-2) =  38 -> level 1 (30..49), qv  30
    //          error = (38 - 30) >> 3 = 1
    //          e0[4] = -2 + 1 = -1, e0[5] = 1
    //     x=2  adjusted = 100 + (-1) =  99 -> level 2 (50..139), qv  80
    //          error = (99 - 80) >> 3 = 2
    //          e0[5] = 1 + 2 = 3
    //     x=3  adjusted = 200 +   3  = 203 -> level 3 (>= 140), qv 210
    //          error = (203 - 210) >> 3 = -7 >> 3 = -1
    //   so the source levels are [0, 1, 2, 3] and they land at x = 2..5, y = 3.
    const out = renderPanelLevels(Uint8Array.from([0, 40, 100, 200]), 4, 1, {
        screenWidth: 8,
        screenHeight: 8,
    });

    assert.deepEqual(row(out.levels, 8, 3), [3, 3, 0, 1, 2, 3, 3, 3]);
    for (const y of [0, 1, 2, 4, 5, 6, 7]) {
        assert.deepEqual(row(out.levels, 8, y), [3, 3, 3, 3, 3, 3, 3, 3], `row ${y} is blank`);
    }
});

test('-15 >> 3 is -2, not -1: the error shift FLOORS, exactly as C++ does', () => {
    // Guard on the single arithmetic subtlety in the whole ditherer. A JS author
    // "simplifying" `(adjusted - qv) >> 3` to `Math.trunc((adjusted - qv) / 8)`
    // would round -1.875 toward zero and silently lighten every dark region.
    assert.equal((0 - 15) >> ATKINSON_ERROR_SHIFT, -2);
    assert.equal(Math.trunc((0 - 15) / 8), -1, 'the WRONG answer, pinned so it is visible');
    assert.equal((203 - 210) >> ATKINSON_ERROR_SHIFT, -1);
    assert.equal((148 - 210) >> ATKINSON_ERROR_SHIFT, -8);
    assert.equal((141 - 210) >> ATKINSON_ERROR_SHIFT, -9);
});

test('bottom-up row order changes the dither — it is not a formality', () => {
    // Source 1x2: image row 0 = 141, image row 1 = 148. Screen 4x6, so the
    // geometry is the "fits" branch: x = (4-1)/2 = 1, y = (6-2)/2 = 2, scale 1.
    // Image row 0 lands on screen row 2, image row 1 on screen row 3, either way.
    //
    // BOTTOM-UP (our BMP: wallpaper_encoder writes a positive biHeight, so file
    // row 0 IS image row 1) — the ditherer sees 148 first:
    //   148 -> level 3, qv 210, error = (148-210) >> 3 = -8, pushed one row "up"
    //   141 + (-8) = 133 -> level 2   (133 < 140)
    // TOP-DOWN — the ditherer sees 141 first:
    //   141 -> level 3, qv 210, error = (141-210) >> 3 = -9, pushed one row down
    //   148 + (-9) = 139 -> level 2   (139 < 140)
    //
    // Same two levels, OPPOSITE rows. Getting `bottomUp` wrong is invisible in a
    // histogram and obvious on glass.
    const src = Uint8Array.from([141, 148]);
    const opts = { screenWidth: 4, screenHeight: 6 };

    const up = renderPanelLevels(src, 1, 2, { ...opts, bottomUp: true });
    assert.equal(up.levels[2 * 4 + 1], 2, 'bottom-up: image row 0 goes LIGHT GRAY');
    assert.equal(up.levels[3 * 4 + 1], 3, 'bottom-up: image row 1 stays WHITE');

    const down = renderPanelLevels(src, 1, 2, { ...opts, bottomUp: false });
    assert.equal(down.levels[2 * 4 + 1], 3, 'top-down: image row 0 stays WHITE');
    assert.equal(down.levels[3 * 4 + 1], 2, 'top-down: image row 1 goes LIGHT GRAY');

    // And the default is bottom-up, because that is what the encoder writes.
    const dflt = renderPanelLevels(src, 1, 2, opts);
    assert.deepEqual(Array.from(dflt.levels), Array.from(up.levels));
});

// ---------------------------------------------------------------------------
// The scatter downscale: several source pixels, one destination
// ---------------------------------------------------------------------------

test('the downscale ORs per plane, so INK WINS: priority 1 > 2 > 0 > 3', () => {
    // Source 2x1 onto a 1x1 screen. 2 > 1 so the scaling branch runs:
    //   ratio = 2/1 = 2 > screenRatio 1 -> x = 0, y = round((1 - 1/2)/2) = 0
    //   fitScale = min(1/2, 1/1) = 0.5 -> both columns floor to screenX 0.
    const opts = { screenWidth: 1, screenHeight: 1 };

    // [255, 40] -> levels [3, 1].
    //   x=0: 255 -> level 3, qv 210, error = 45 >> 3 = 5 -> e0[3] = 5
    //   x=1:  40 + 5 = 45 -> level 1 (30..49)
    // Planes: level 3 sets nothing; level 1 sets BW, MSB and LSB.
    // Combine: msb && lsb -> 1. DARK GRAY beats white.
    const a = renderPanelLevels(Uint8Array.from([255, 40]), 2, 1, opts);
    assert.deepEqual(Array.from(a.levels), [1]);

    // [0, 102] -> levels [0, 2].
    //   x=0: 0 -> level 0, qv 15, error = -15 >> 3 = -2 -> e0[3] = -2
    //   x=1: 102 + (-2) = 100 -> level 2
    // Planes: level 0 sets BW only; level 2 sets BW and MSB.
    // Combine: msb && !lsb -> 2. LIGHT GRAY beats BLACK — the OR is per PLANE,
    // not a darkest-wins rule, and this is the case that proves it.
    const b = renderPanelLevels(Uint8Array.from([0, 102]), 2, 1, opts);
    assert.deepEqual(Array.from(b.levels), [2]);

    // [0, 0] -> both level 0 (the second sees error -2 on top of 0 -> clamped 0).
    // Nothing sets MSB, BW is set -> 0.
    const c = renderPanelLevels(Uint8Array.from([0, 0]), 2, 1, opts);
    assert.deepEqual(Array.from(c.levels), [0]);
});

// ---------------------------------------------------------------------------
// Geometry — the firmware recon's own float32 table, pinned row by row
// ---------------------------------------------------------------------------

test('the fit/crop geometry matches the firmware recon table, float32 and all', () => {
    // Produced during the read-only firmware recon by a separate float32
    // emulation of SleepActivity::renderBitmapSleepScreen +
    // GfxRenderer::drawBitmap, against the 528x792 portrait screen.
    // Columns: source w, h, mode -> cropPixX, cropPixY, scale, x, y.
    const table = [
        [528, 792, 'fit', 0, 0, 1, 0, 0],
        [528, 792, 'crop', 0, 0, 1, 0, 0],
        [1056, 792, 'fit', 0, 0, 0.5, 0, 198],
        [1056, 792, 'crop', 264, 0, 1, 0, 0],
        [792, 1056, 'fit', 0, 0, Math.fround(2 / 3), 0, 44],
        // 43, NOT 44: cropX is float32 0.11111110448, and 792 * that / 2 is
        // 43.99999... Doing this arithmetic in double gives exactly 44 and
        // crops one column too many.
        [792, 1056, 'crop', 43, 0, 0.75, 0, 0],
        [1056, 594, 'fit', 0, 0, 0.5, 0, 248],
        [1056, 594, 'crop', 330, 0, 1, 0, 0],
        [1056, 1056, 'fit', 0, 0, 0.5, 0, 132],
        [1056, 1056, 'crop', 175, 0, 0.75, 0, 0],
        [480, 800, 'fit', 0, 0, Math.fround(0.99), 26, 0],
        [480, 800, 'crop', 0, 39, 1, 0, 0],
        [1056, 704, 'fit', 0, 0, 0.5, 0, 220],
        [1056, 704, 'crop', 293, 0, 1, 0, 0],
        [900, 1056, 'fit', 0, 0, Math.fround(0.58666664), 0, 86],
        [900, 1056, 'crop', 98, 0, 0.75, 0, 0],
        // What `framing: 'panel'` USED to upload: an exact 0.75 downscale onto
        // the screen, done by the firmware's lossy scatter. The app now uploads
        // 528x792 (the first two rows) so that step does not happen at all —
        // this row stays as the proof that the geometry is still right for a
        // caller who passes an explicit `longSide`.
        [704, 1056, 'fit', 0, 0, 0.75, 0, 0],
    ];

    for (const [w, h, mode, cropPixX, cropPixY, scale, x, y] of table) {
        const g = computeSleepGeometry(w, h, { coverMode: mode });
        const where = `${w}x${h} ${mode}`;
        assert.equal(g.cropPixX, cropPixX, `${where} cropPixX`);
        assert.equal(g.cropPixY, cropPixY, `${where} cropPixY`);
        assert.equal(g.scale, scale, `${where} scale`);
        assert.equal(g.x, x, `${where} x`);
        assert.equal(g.y, y, `${where} y`);
        assert.ok(g.scale <= 1, `${where}: the firmware NEVER upscales`);
    }
});

test('float32 is load-bearing: doing the crop in double is off by a column', () => {
    // The exact case from the table above, spelled out so a future "why is this
    // wrapped in Math.fround" question answers itself.
    const f = Math.fround;
    const screenRatio32 = f(f(528) / f(792));
    const ratio32 = f(f(792) / f(1056));
    const cropX32 = f(1 - f(screenRatio32 / ratio32));
    const cropX64 = 1 - 528 / 792 / (792 / 1056);

    assert.equal(Math.floor(f(f(792 * cropX32) / 2)), 43, 'float32 -> 43');
    assert.equal(Math.floor((792 * cropX64) / 2), 44, 'double -> 44, which is wrong');
    assert.equal(computeSleepGeometry(792, 1056, { coverMode: 'crop' }).cropPixX, 43);
});

test('fit mode letterboxes with WHITE bars, even for an all-black source', () => {
    // 1056x792 FIT -> scale 0.5, y = 198: a 528x396 image centred vertically.
    // Everything outside it is clearScreen()'s white (SleepActivity.cpp:215),
    // which is level 3.
    const w = 1056;
    const h = 792;
    const out = renderPanelLevels(new Uint8Array(w * h), w, h, { coverMode: 'fit' });

    assert.equal(out.width, 528);
    assert.equal(out.height, 792);

    for (const y of [0, 100, 197, 594, 700, 791]) {
        assert.deepEqual(
            new Set(row(out.levels, 528, y)),
            new Set([3]),
            `screen row ${y} must be untouched white`
        );
    }
    for (const y of [198, 400, 593]) {
        assert.deepEqual(
            new Set(row(out.levels, 528, y)),
            new Set([0]),
            `screen row ${y} is the black image`
        );
    }
});

test('crop mode reproduces the firmware quirk: no upscale, so a top-left image', () => {
    // 1056x594 CROP: cropPixX = 330 leaves a 396x594 source. fitScale is
    // min(528/396, 792/594) = 1.333 -> >= 1, so drawBitmap refuses to scale
    // (GfxRenderer.cpp:1283) while the CROP branch already pinned x = y = 0.
    // The picture lands TOP-LEFT with white margins right and bottom. That is a
    // firmware limitation; a preview that "fixed" it would lie.
    const w = 1056;
    const h = 594;
    const out = renderPanelLevels(new Uint8Array(w * h), w, h, { coverMode: 'crop' });

    assert.equal(out.levels[0], 0, 'top-left corner is drawn');
    assert.equal(out.levels[593 * 528 + 395], 0, 'bottom-right of the drawn area');
    assert.equal(out.levels[0 * 528 + 396], 3, 'the right margin is white');
    assert.equal(out.levels[594 * 528 + 0], 3, 'the bottom margin is white');
});

test('crop mode trims rows symmetrically when the source is too TALL', () => {
    // 480x800 CROP: only the height exceeds the screen, so cropY trims 39 rows
    // off the top AND 39 off the bottom, leaving 722 rows at scale 1 pinned to
    // y = 0 — the same no-upscale quirk on the other axis.
    //
    // NOTE: the firmware recon's table lists the drawn Y range for this row as
    // 0..760, which is H - cropPixY - 1 with the `-cropPixY` term dropped. Both
    // the row loop's guard (`bmpY < cropPixY`) and the screenY expression
    // (`-cropPixY + ...`) are in the recon's own quoted source, and its X column
    // for 1056x594 CROP (0..395 = W - 2*cropPixX) applies the same subtraction —
    // so 0..721 is the self-consistent answer and that table cell is a slip in
    // the recon script, not firmware behaviour.
    const g = computeSleepGeometry(480, 800, { coverMode: 'crop' });
    assert.equal(g.cropPixY, 39);
    assert.equal(g.scale, 1);

    const out = renderPanelLevels(new Uint8Array(480 * 800), 480, 800, { coverMode: 'crop' });
    assert.equal(out.levels[0], 0, 'first drawn row');
    assert.equal(out.levels[721 * 528 + 0], 0, 'last drawn row is 800 - 2*39 - 1');
    assert.equal(out.levels[722 * 528 + 0], 3, 'and the row after it is white');
    assert.equal(out.levels[0 * 528 + 480], 3, 'the right margin is white');
});

// ---------------------------------------------------------------------------
// Legal-level and determinism invariants
// ---------------------------------------------------------------------------

test('the output contains ONLY the 4 legal panel levels', () => {
    // Three sources with very different statistics, all through the real screen
    // size, because "only 4 levels" is the claim that makes this preview
    // panel-TRUE rather than merely panel-shaped.
    const cases = [
        ['noise', pseudoGray(704 * 1056, 0x2f6e2b1)],
        ['ramp', horizontalRamp(704, 1056)],
        ['flat mid-gray', new Uint8Array(704 * 1056).fill(128)],
    ];

    for (const [label, gray] of cases) {
        for (const coverMode of ['fit', 'crop']) {
            const out = renderPanelLevels(gray, 704, 1056, { coverMode });
            const counts = panelLevelHistogram(out.levels);

            assert.equal(counts.length, PANEL_GRAY_LEVELS, label);
            assert.equal(
                counts.reduce((a, b) => a + b, 0),
                528 * 792,
                `${label}/${coverMode}: every panel pixel is accounted for`
            );
            for (let i = 0; i < out.levels.length; i++) {
                if (out.levels[i] >= PANEL_GRAY_LEVELS) {
                    assert.fail(`${label}/${coverMode}: illegal level ${out.levels[i]} at ${i}`);
                }
            }
        }
    }

    // A full 0..255 ramp must actually USE all four, or the thresholds are wrong.
    const ramp = renderPanelLevels(horizontalRamp(704, 1056), 704, 1056);
    for (const [level, count] of panelLevelHistogram(ramp.levels).entries()) {
        assert.ok(count > 0, `a 0..255 ramp must produce some level ${level}`);
    }
});

test('rendering is deterministic — identical input, identical bytes', () => {
    const gray = pseudoGray(300 * 200, 7);
    const opts = { coverMode: 'crop', screenWidth: 132, screenHeight: 198 };

    const a = renderPanelLevels(gray, 300, 200, opts);
    const b = renderPanelLevels(gray, 300, 200, opts);
    assert.deepEqual(a.levels, b.levels);

    // And nothing mutates the caller's buffer.
    const copy = gray.slice();
    renderPanelLevels(gray, 300, 200, opts);
    assert.deepEqual(gray, copy, 'the source must come back untouched');
});

test('the panel preview is ALWAYS 528x792, whatever shape went in', () => {
    // The reported bug was a LANDSCAPE preview. Whatever the source aspect, the
    // answer is the portrait sleep screen — this is the regression guard.
    for (const [w, h] of [
        [1056, 704],
        [704, 1056],
        [1056, 1056],
        [64, 64],
    ]) {
        const out = renderPanelLevels(pseudoGray(w * h, w + h), w, h);
        assert.equal(out.width, 528, `${w}x${h} width`);
        assert.equal(out.height, 792, `${w}x${h} height`);
        assert.equal(out.levels.length, 528 * 792);
        assert.ok(out.width < out.height, `${w}x${h} must render PORTRAIT`);
    }
});

// ---------------------------------------------------------------------------
// Cross-check against the independent reference
// ---------------------------------------------------------------------------

test('agrees with an independently written reference render', () => {
    const fixtures = [
        // exact 0.5 downscale, no crop, no letterbox
        { w: 264, h: 396, opts: { coverMode: 'fit', screenWidth: 132, screenHeight: 198 } },
        // wide source: 0.44 scale plus a big vertical letterbox
        { w: 300, h: 200, opts: { coverMode: 'fit', screenWidth: 132, screenHeight: 198 } },
        // crop path: cropPixX = 83 and a float32-sensitive 0.99 scale
        { w: 300, h: 200, opts: { coverMode: 'crop', screenWidth: 132, screenHeight: 198 } },
        // top-down source order, to cover the other traversal
        {
            w: 264,
            h: 396,
            opts: { coverMode: 'fit', screenWidth: 132, screenHeight: 198, bottomUp: false },
        },
        // source smaller than the screen: centred, scale 1, no crop even in CROP
        { w: 100, h: 150, opts: { coverMode: 'crop', screenWidth: 132, screenHeight: 198 } },
    ];

    for (const { w, h, opts } of fixtures) {
        const gray = pseudoGray(w * h, w * 31 + h);
        const mine = renderPanelLevels(gray, w, h, opts);
        const theirs = referenceRender(gray, w, h, opts);
        const where = `${w}x${h} ${opts.coverMode}${opts.bottomUp === false ? ' top-down' : ''}`;

        assert.equal(mine.width, theirs.width, `${where} width`);
        assert.equal(mine.height, theirs.height, `${where} height`);
        assert.deepEqual(mine.levels, theirs.levels, `${where} levels`);
    }
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('the black-and-white filter collapses to two levels, inverted mirrors it', () => {
    // SleepActivity.cpp:217-234: with a filter set, hasGreyscale is forced false
    // and only the BW base pass reaches the panel, so every level below 3 is
    // BLACK. INVERTED then flips the WHOLE framebuffer, background included —
    // which is why untouched letterbox pixels come out black rather than staying
    // white.
    const gray = horizontalRamp(300, 200);
    const opts = { screenWidth: 132, screenHeight: 198 };

    const bw = renderPanelLevels(gray, 300, 200, { ...opts, filter: 'bw' });
    const inverted = renderPanelLevels(gray, 300, 200, { ...opts, filter: 'inverted' });
    const none = renderPanelLevels(gray, 300, 200, { ...opts, filter: 'none' });

    const bwCounts = panelLevelHistogram(bw.levels);
    assert.equal(bwCounts[1], 0, 'BW never produces dark gray');
    assert.equal(bwCounts[2], 0, 'BW never produces light gray');
    assert.ok(bwCounts[0] > 0 && bwCounts[3] > 0, 'BW uses both of its levels');

    for (let i = 0; i < bw.levels.length; i++) {
        assert.equal(inverted.levels[i], bw.levels[i] === 0 ? 3 : 0, `inversion at ${i}`);
        // The gray path and the BW path share one dither, so BW's black is
        // exactly "the 4-level answer was not white".
        assert.equal(bw.levels[i], none.levels[i] === 3 ? 3 : 0, `bw vs none at ${i}`);
    }

    // This fixture letterboxes (300x200 into 132x198), so it also proves the
    // inversion reaches pixels no source pixel ever touched.
    assert.equal(none.levels[0], 3, 'letterbox bar is white in the gray path');
    assert.equal(inverted.levels[0], 0, 'and BLACK once inverted');
});

// ---------------------------------------------------------------------------
// Level -> RGBA
// ---------------------------------------------------------------------------

test('levelsToRgba paints the calibrated map, opaque, and rejects illegal levels', () => {
    const levels = Uint8Array.from([0, 1, 2, 3]);
    const rgba = levelsToRgba(levels);

    assert.equal(rgba.length, 16);
    for (let i = 0; i < 4; i++) {
        const v = PANEL_LEVEL_LUMINANCE[i];
        assert.equal(rgba[i * 4], v, `R at level ${i}`);
        assert.equal(rgba[i * 4 + 1], v, `G at level ${i}`);
        assert.equal(rgba[i * 4 + 2], v, `B at level ${i}`);
        assert.equal(rgba[i * 4 + 3], 255, `A at level ${i}`);
    }

    // The map is a parameter, not a constant baked into the render.
    const nominal = levelsToRgba(levels, PANEL_LEVEL_LUMINANCE_NOMINAL);
    assert.deepEqual([nominal[0], nominal[4], nominal[8], nominal[12]], [0, 85, 170, 255]);

    assert.throws(() => levelsToRgba(Uint8Array.from([4])), /not a legal panel level/);
    assert.throws(() => levelsToRgba(levels, [0, 255]), /needs 4 entries/);
});

test('renderPanelPreview returns levels and RGBA that describe the same picture', () => {
    const gray = pseudoGray(264 * 396, 99);
    const out = renderPanelPreview(gray, 264, 396, { screenWidth: 132, screenHeight: 198 });

    assert.equal(out.width, 132);
    assert.equal(out.height, 198);
    assert.equal(out.rgba.length, 132 * 198 * 4);
    assert.equal(out.levels.length, 132 * 198);
    assert.ok(out.geometry.scale <= 1);

    for (let i = 0; i < out.levels.length; i++) {
        assert.equal(out.rgba[i * 4], PANEL_LEVEL_LUMINANCE[out.levels[i]], `pixel ${i}`);
        assert.equal(out.rgba[i * 4 + 3], 255, `alpha ${i}`);
    }
});

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

test('RGBA input is reduced with the firmware palette weights', () => {
    const w = 40;
    const h = 24;
    const gray = pseudoGray(w * h, 5);

    // A gray plane and the RGBA that encodes exactly that plane must agree —
    // the palette weights sum to 256, so R=G=B=i round-trips (Bitmap.cpp:139).
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < gray.length; i++) {
        rgba[i * 4] = gray[i];
        rgba[i * 4 + 1] = gray[i];
        rgba[i * 4 + 2] = gray[i];
        rgba[i * 4 + 3] = 255;
    }

    const opts = { screenWidth: 20, screenHeight: 30 };
    assert.deepEqual(
        renderPanelLevels(rgba, w, h, opts).levels,
        renderPanelLevels(gray, w, h, opts).levels
    );
});

test('a buffer that is neither a gray plane nor RGBA is refused', () => {
    assert.throws(
        () => renderPanelLevels(new Uint8Array(10), 4, 4),
        /expected 16 gray bytes or 64 RGBA bytes/
    );
    assert.throws(() => renderPanelLevels(new Uint8Array(16), 0, 4), /width must be a positive/);
    assert.throws(
        () => renderPanelLevels(new Uint8Array(16), 4, 4, { screenWidth: -1 }),
        /screenWidth must be a positive/
    );
});
