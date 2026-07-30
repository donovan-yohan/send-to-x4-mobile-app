/**
 * image_geometry — the pure crop/fit/resample arithmetic behind image_converter.
 *
 * This module is the ONLY thing standing between "whatever the native resizer
 * returned" and `encodeFrame`, which throws on a geometry mismatch. So the
 * load-bearing assertions here are:
 *   - conformRgba always yields EXACTLY dstW x dstH x 4 bytes, and
 *   - its output is accepted by the real packer at the real compose size.
 *
 * Buffers are deliberately tiny except in the two end-to-end cases, which use
 * the real 528x792 canvas because that is the contract being proved.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    buildCoverCropActions,
    buildFitActions,
    buildFrameActions,
    conformRgba,
    naturalTarget,
    panelFramingTarget,
} from '../src/services/image_geometry';
import { COMPOSE_H, COMPOSE_W, PANEL_H, PANEL_W, X3_FRAME_BYTES } from '../src/device/x3';
import { encodeFrame } from '../src/services/frame_encoder';
import { WALLPAPER_LONG_SIDE_PX } from '../src/services/wallpaper_encoder';

/** The sleep screen — 528x792 PORTRAIT. The 'panel' framing box by default. */
const SLEEP_SCREEN = { width: COMPOSE_W, height: COMPOSE_H };

/**
 * The 'panel' wallpaper framing box at its ESCAPE-HATCH size: what
 * `panelFramingTarget` returns when a caller passes an explicit long side.
 * Derived from the real function, never hard-coded — it read 1056x704
 * (LANDSCAPE) when the app still believed the sleep screen was a wide strip.
 *
 * Kept as a sweep target because it is a DIFFERENT SIZE at the portrait aspect,
 * so the crop rounding below is exercised at two scales of the same shape. The
 * DEFAULT panel box is the sleep screen itself, which is already the first sweep
 * target — see the panelFramingTarget tests.
 */
const WALLPAPER_PANEL = panelFramingTarget(SLEEP_SCREEN, WALLPAPER_LONG_SIDE_PX);
const WALLPAPER_PANEL_W = WALLPAPER_PANEL.width;
const WALLPAPER_PANEL_H = WALLPAPER_PANEL.height;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Solid-colour RGBA image. */
function solid(w, h, r, g, b, a = 255) {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px[i * 4] = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = a;
    }
    return px;
}

function pixelAt(buf, w, x, y) {
    const o = (y * w + x) * 4;
    return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
}

// ---------------------------------------------------------------------------
// naturalTarget
// ---------------------------------------------------------------------------

test('naturalTarget: long side wins, aspect preserved', () => {
    assert.deepEqual(naturalTarget({ width: 4000, height: 3000 }, 1056), {
        width: 1056,
        height: 792,
    });
    assert.deepEqual(naturalTarget({ width: 3000, height: 4000 }, 1056), {
        width: 792,
        height: 1056,
    });
    assert.deepEqual(naturalTarget({ width: 500, height: 500 }, 1056), {
        width: 1056,
        height: 1056,
    });
});

test('naturalTarget: an extreme aspect never collapses the short side to 0', () => {
    const t = naturalTarget({ width: 10000, height: 3 }, 1056);
    assert.equal(t.width, 1056);
    assert.ok(t.height >= 1, `short side must stay >= 1, got ${t.height}`);
});

// ---------------------------------------------------------------------------
// panelFramingTarget
// ---------------------------------------------------------------------------

test('panelFramingTarget: the default IS the screen, 1:1 and portrait', () => {
    // The whole point: `framing: 'panel'` must hand the firmware exactly the
    // screen, so drawBitmap's lossy nearest-neighbour scatter never runs.
    // scripts/panel-render.test.js pins the geometry consequence (scale === 1,
    // isScaled === false); this pins the box that produces it.
    assert.deepEqual(panelFramingTarget(SLEEP_SCREEN), { width: 528, height: 792 });
    assert.deepEqual(panelFramingTarget(SLEEP_SCREEN, null), { width: 528, height: 792 });
    assert.deepEqual(panelFramingTarget(SLEEP_SCREEN, undefined), { width: 528, height: 792 });

    // Taller than it is wide — a book cover, not a landscape strip. This is the
    // reported bug, in one assertion.
    const box = panelFramingTarget(SLEEP_SCREEN);
    assert.ok(box.height > box.width, 'the sleep screen is PORTRAIT');

    // A fresh object every call: callers must not be able to mutate each other's
    // geometry, and the screen it was derived from must survive untouched.
    const a = panelFramingTarget(SLEEP_SCREEN);
    a.width = 1;
    assert.deepEqual(panelFramingTarget(SLEEP_SCREEN), { width: 528, height: 792 });
    assert.deepEqual(SLEEP_SCREEN, { width: COMPOSE_W, height: COMPOSE_H });
});

test('panelFramingTarget: an explicit long side keeps the aspect, and only then', () => {
    assert.deepEqual(panelFramingTarget(SLEEP_SCREEN, WALLPAPER_LONG_SIDE_PX), {
        width: 704,
        height: 1056,
    });
    assert.deepEqual(panelFramingTarget(SLEEP_SCREEN, 396), { width: 264, height: 396 });
    // Same aspect as the screen, whatever the size.
    for (const longSide of [200, 396, 792, 1056, 2112]) {
        const t = panelFramingTarget(SLEEP_SCREEN, longSide);
        assert.equal(t.height, longSide);
        assert.ok(
            Math.abs(t.width / t.height - COMPOSE_W / COMPOSE_H) < 0.005,
            `${longSide}: aspect drifted (${t.width}x${t.height})`
        );
    }

    // The screen is a parameter, not a constant baked into this module — an X4
    // (480x800) is a src/device change, not an edit here.
    assert.deepEqual(panelFramingTarget({ width: 480, height: 800 }), {
        width: 480,
        height: 800,
    });

    assert.throws(() => panelFramingTarget({ width: 0, height: 792 }), /positive integer/);
    assert.throws(() => panelFramingTarget({ width: 528, height: 1.5 }), /positive integer/);
});

// ---------------------------------------------------------------------------
// action plans
// ---------------------------------------------------------------------------

test('buildCoverCropActions: wider source resizes by height then crops width', () => {
    // 1600x900 into the 528x792 portrait canvas.
    const actions = buildCoverCropActions(COMPOSE_W, COMPOSE_H, { width: 1600, height: 900 });
    assert.deepEqual(actions[0], { resize: { height: COMPOSE_H } });

    // scale = 792/900 = 0.88 -> scaledWidth = 1408; centre crop to 528.
    assert.deepEqual(actions[1], {
        crop: { originX: Math.round((1408 - COMPOSE_W) / 2), originY: 0, width: COMPOSE_W, height: COMPOSE_H },
    });
});

test('buildCoverCropActions: taller source resizes by width then crops height', () => {
    const actions = buildCoverCropActions(COMPOSE_W, COMPOSE_H, { width: 1000, height: 2000 });
    assert.deepEqual(actions[0], { resize: { width: COMPOSE_W } });

    // scale = 528/1000 -> scaledHeight = 1056; centre crop to 792.
    assert.deepEqual(actions[1], {
        crop: { originX: 0, originY: Math.round((1056 - COMPOSE_H) / 2), width: COMPOSE_W, height: COMPOSE_H },
    });
});

test('buildCoverCropActions: unknown source falls back to an exact resize', () => {
    assert.deepEqual(buildCoverCropActions(COMPOSE_W, COMPOSE_H, null), [
        { resize: { width: COMPOSE_W, height: COMPOSE_H } },
    ]);
});

// ---------------------------------------------------------------------------
// The crop rect vs. the bitmap the NATIVE resizer actually produces.
//
// expo-image-manipulator's Android ResizeTransformer computes the unconstrained
// side as `(w / imageRatio).toInt()` — it TRUNCATES. CropTransformer then only
// checks `w <= bw && h <= bh && x <= bw && y <= bh`; it never checks
// `x + w <= bw`, so an overshooting rect sails through validation and
// Bitmap.createBitmap throws an uncaught IllegalArgumentException.
//
// So the invariant worth asserting is NOT `crop.width <= target` (true by
// construction of the Math.min, and therefore unfalsifiable) — it is
// `origin + size <= the truncated scaled dimension`.
// ---------------------------------------------------------------------------

/** What the native resizer really produces, truncation and all. */
function nativeResized(targetW, targetH, source) {
    const sourceRatio = source.width / source.height;
    const targetRatio = targetW / targetH;
    return sourceRatio > targetRatio
        ? // resize({ height: targetH }): height exact, width truncated.
        { width: Math.max(1, Math.trunc((source.width * targetH) / source.height)), height: targetH }
        : // resize({ width: targetW }): width exact, height truncated.
        { width: targetW, height: Math.max(1, Math.trunc((source.height * targetW) / source.width)) };
}

/** Throws with the native cropper's own wording if the rect overruns. */
function assertCropFitsBitmap(targetW, targetH, source) {
    const actions = buildCoverCropActions(targetW, targetH, source);
    const crop = actions[1].crop;
    const bmp = nativeResized(targetW, targetH, source);
    const label = `${source.width}x${source.height} -> ${targetW}x${targetH}`;

    assert.ok(crop.width > 0 && crop.height > 0, `${label}: empty crop`);
    assert.ok(crop.originX >= 0 && crop.originY >= 0, `${label}: negative origin`);
    assert.ok(
        crop.originX + crop.width <= bmp.width,
        `${label}: x+width (${crop.originX}+${crop.width}=${crop.originX + crop.width}) > bitmap.width (${bmp.width})`
    );
    assert.ok(
        crop.originY + crop.height <= bmp.height,
        `${label}: y+height (${crop.originY}+${crop.height}=${crop.originY + crop.height}) > bitmap.height (${bmp.height})`
    );
    // The crop must still not exceed the target it was asked for.
    assert.ok(crop.width <= targetW && crop.height <= targetH, `${label}: crop overshoots target`);
    return crop;
}

test('buildCoverCropActions: crop rect never exceeds the bitmap the native resize produces', () => {
    // Near-square-to-target aspects, where rounding is most dangerous.
    for (const [w, h] of [[529, 793], [527, 791], [1057, 1585], [3, 4], [4, 3]]) {
        assertCropFitsBitmap(COMPOSE_W, COMPOSE_H, { width: w, height: h });
    }

    // Regression fixtures: every one of these lands in the >= 0.5 fractional
    // window, where Math.round predicted one pixel MORE than the native
    // truncation delivered, and the emitted rect overran the real bitmap.
    //   217x325 -> 528.68 px wide  (rounded 529, truncated 528)
    //   2000x2996, 1000x1501, 400x267 likewise.
    for (const [w, h] of [[217, 325], [2000, 2996], [1000, 1501], [400, 267]]) {
        assertCropFitsBitmap(COMPOSE_W, COMPOSE_H, { width: w, height: h });
        assertCropFitsBitmap(PANEL_W, PANEL_H, { width: w, height: h });
        assertCropFitsBitmap(WALLPAPER_PANEL_W, WALLPAPER_PANEL_H, { width: w, height: h });
    }
});

test('buildCoverCropActions: an aspect-ratio sweep never overruns the native bitmap', () => {
    // Pure arithmetic, ~350k cheap checks: fast, and it is the only thing that
    // would have caught the truncation defect, whose failure window is narrow
    // and irregular.
    const targets = [
        [COMPOSE_W, COMPOSE_H],
        // The landscape love-note canvas is the TRANSPOSE of the portrait one,
        // so it exercises the opposite branch of buildCoverCropActions for every
        // source in the sweep — the branch a portrait-only sweep never reaches
        // for these aspect ratios.
        [PANEL_W, PANEL_H],
        [WALLPAPER_PANEL_W, WALLPAPER_PANEL_H],
    ];
    for (const [tw, th] of targets) {
        for (let w = 1; w <= 240; w++) {
            for (let h = 1; h <= 240; h++) {
                // Three scales of the same ratio so the sweep covers both small
                // sources and photo-sized ones.
                for (const k of [1, 25 / 3, 1000 / 240]) {
                    assertCropFitsBitmap(tw, th, {
                        width: Math.max(1, Math.round(w * k)),
                        height: Math.max(1, Math.round(h * k)),
                    });
                }
            }
        }
    }
});

test('buildCoverCropActions: the crop stays centred and full-size on the bound axis', () => {
    // Predicting low must not quietly shrink the output: the axis that is NOT
    // cropped is always exactly the target, and the cropped axis is the target
    // whenever the scaled image is big enough to supply it (i.e. always, since
    // cover scales past the target by construction).
    for (const [w, h] of [[1600, 900], [1000, 2000], [217, 325], [2000, 2996], [4000, 3000]]) {
        const crop = assertCropFitsBitmap(COMPOSE_W, COMPOSE_H, { width: w, height: h });
        assert.equal(crop.width, COMPOSE_W, `${w}x${h}: lost width`);
        assert.equal(crop.height, COMPOSE_H, `${w}x${h}: lost height`);
    }
});

test('buildFitActions: constrains the binding axis only', () => {
    // Wider than the target -> width binds.
    assert.deepEqual(buildFitActions(COMPOSE_W, COMPOSE_H, { width: 1600, height: 900 }), [
        { resize: { width: COMPOSE_W } },
    ]);
    // Taller than the target -> height binds.
    assert.deepEqual(buildFitActions(COMPOSE_W, COMPOSE_H, { width: 900, height: 1600 }), [
        { resize: { height: COMPOSE_H } },
    ]);
});

test('buildFrameActions: dispatches on fit mode', () => {
    const src = { width: 1600, height: 900 };
    assert.deepEqual(
        buildFrameActions(COMPOSE_W, COMPOSE_H, 'cover', src),
        buildCoverCropActions(COMPOSE_W, COMPOSE_H, src)
    );
    assert.deepEqual(
        buildFrameActions(COMPOSE_W, COMPOSE_H, 'fit', src),
        buildFitActions(COMPOSE_W, COMPOSE_H, src)
    );
});

// ---------------------------------------------------------------------------
// conformRgba — contracts
// ---------------------------------------------------------------------------

test('conformRgba: identity is a no-copy fast path', () => {
    const src = solid(8, 6, 10, 20, 30);
    assert.equal(conformRgba(src, 8, 6, 8, 6, 'cover'), src);
    assert.equal(conformRgba(src, 8, 6, 8, 6, 'fit'), src);
});

test('conformRgba: output length is always exactly dstW*dstH*4', () => {
    const src = solid(40, 30, 128, 128, 128);
    for (const fit of ['cover', 'fit']) {
        for (const [w, h] of [[7, 5], [40, 30], [61, 97], [100, 40]]) {
            const out = conformRgba(src, 40, 30, w, h, fit);
            assert.equal(out.length, w * h * 4, `${fit} ${w}x${h}`);
        }
    }
});

test('conformRgba: rejects a buffer that does not match its declared size', () => {
    assert.throws(() => conformRgba(new Uint8Array(10), 8, 6, 4, 4, 'cover'), /RGBA bytes/);
});

test('conformRgba: rejects non-positive-integer dimensions', () => {
    const src = solid(4, 4, 0, 0, 0);
    assert.throws(() => conformRgba(src, 4, 4, 0, 4, 'cover'), /positive integer/);
    assert.throws(() => conformRgba(src, 4, 4, 4, -1, 'cover'), /positive integer/);
    assert.throws(() => conformRgba(src, 4, 4, 2.5, 4, 'cover'), /positive integer/);
});

// ---------------------------------------------------------------------------
// conformRgba — 'fit' letterboxes with WHITE bars
// ---------------------------------------------------------------------------

test("conformRgba 'fit': pads with opaque white and centres the image", () => {
    // 40x30 (4:3) into 528x792 (2:3): width binds, so bars go top and bottom.
    const src = solid(40, 30, 128, 128, 128);
    const out = conformRgba(src, 40, 30, COMPOSE_W, COMPOSE_H, 'fit');

    // scale = min(528/40, 792/30) = 13.2 -> box 528 x 396, centred at y=198.
    const boxTop = Math.floor((COMPOSE_H - 396) / 2);

    // Top bar, bottom bar: white and OPAQUE (the panel is white paper).
    assert.deepEqual(pixelAt(out, COMPOSE_W, 0, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(out, COMPOSE_W, COMPOSE_W - 1, boxTop - 1), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(out, COMPOSE_W, 0, COMPOSE_H - 1), [255, 255, 255, 255]);

    // Inside the box: the source colour survived.
    assert.deepEqual(pixelAt(out, COMPOSE_W, 264, boxTop + 1), [128, 128, 128, 255]);
    assert.deepEqual(pixelAt(out, COMPOSE_W, 264, boxTop + 394), [128, 128, 128, 255]);
});

test("conformRgba 'fit': keeps edge content that 'cover' crops away", () => {
    // White image with a black left-hand strip (columns 0..9 of 40).
    const src = solid(40, 30, 255, 255, 255);
    for (let y = 0; y < 30; y++) {
        for (let x = 0; x < 10; x++) {
            const o = (y * 40 + x) * 4;
            src[o] = 0;
            src[o + 1] = 0;
            src[o + 2] = 0;
        }
    }

    const fitted = conformRgba(src, 40, 30, COMPOSE_W, COMPOSE_H, 'fit');
    const covered = conformRgba(src, 40, 30, COMPOSE_W, COMPOSE_H, 'cover');

    const hasBlack = (buf) => {
        for (let i = 0; i < buf.length; i += 4) if (buf[i] === 0) return true;
        return false;
    };

    assert.ok(hasBlack(fitted), "'fit' must keep the left strip");
    // 'cover' scales 40x30 to fill 528x792, so only the centre 20 columns
    // survive — the black strip is entirely outside them.
    assert.ok(!hasBlack(covered), "'cover' must crop the left strip away");
});

// ---------------------------------------------------------------------------
// conformRgba — resampling behaviour
// ---------------------------------------------------------------------------

test('conformRgba: averaging is alpha-weighted, so transparency carries no colour', () => {
    // Left pixel: fully transparent RED. Right pixel: opaque BLUE.
    const src = new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]);
    const out = conformRgba(src, 2, 1, 1, 1, 'fit');

    // A naive (unweighted) average would give (128, 0, 128) — visible red.
    assert.deepEqual([out[0], out[1], out[2]], [0, 0, 255]);
    assert.equal(out[3], 128); // mean coverage of the two-pixel footprint
});

test('conformRgba: a downscale averages rather than point-samples', () => {
    // 2x1 checker, black then white, collapsed to one pixel.
    const src = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const out = conformRgba(src, 2, 1, 1, 1, 'fit');
    assert.deepEqual([out[0], out[1], out[2], out[3]], [128, 128, 128, 255]);
});

test('conformRgba: a flat source survives a large downscale unchanged', () => {
    const src = solid(64, 64, 90, 90, 90);
    const out = conformRgba(src, 64, 64, 8, 8, 'cover');
    for (let i = 0; i < out.length; i += 4) {
        assert.equal(out[i], 90);
        assert.equal(out[i + 3], 255);
    }
});

// ---------------------------------------------------------------------------
// The invariant this module exists for: the packer must accept the result.
// ---------------------------------------------------------------------------

test('conformRgba output is accepted by encodeFrame at the real compose size', () => {
    // A source with no relationship to the target in size OR aspect — the case
    // where trusting the native resizer would be a coin flip.
    const src = solid(37, 91, 200, 40, 10);

    for (const fit of ['cover', 'fit']) {
        const canvas = conformRgba(src, 37, 91, COMPOSE_W, COMPOSE_H, fit);
        assert.equal(canvas.length, COMPOSE_W * COMPOSE_H * 4, `${fit}: canvas size`);

        const { frame, previewRgba } = encodeFrame(canvas, COMPOSE_W, COMPOSE_H, {
            mode: 'graphic',
        });
        assert.equal(frame.length, X3_FRAME_BYTES, `${fit}: frame size`);
        assert.equal(previewRgba.length, COMPOSE_W * COMPOSE_H * 4, `${fit}: preview size`);
    }
});

test('an oversized source also conforms and packs', () => {
    const src = solid(1200, 400, 250, 250, 250);
    const canvas = conformRgba(src, 1200, 400, COMPOSE_W, COMPOSE_H, 'cover');
    const { frame } = encodeFrame(canvas, COMPOSE_W, COMPOSE_H, { mode: 'graphic' });
    assert.equal(frame.length, X3_FRAME_BYTES);
});

// ---------------------------------------------------------------------------
// The same invariant on the LANDSCAPE compose target (orientation toggle)
// ---------------------------------------------------------------------------

test('conformRgba output is accepted by encodeFrame at the landscape compose size', () => {
    // Same hostile source as the portrait case: unrelated in size AND aspect.
    const src = solid(37, 91, 200, 40, 10);

    for (const fit of ['cover', 'fit']) {
        const canvas = conformRgba(src, 37, 91, PANEL_W, PANEL_H, fit);
        assert.equal(canvas.length, PANEL_W * PANEL_H * 4, `${fit}: canvas size`);

        // rotation 'none' is the landscape orientation's mapping: the canvas IS
        // the panel buffer, so encodeFrame demands exactly this rectangle.
        const { frame, previewRgba } = encodeFrame(canvas, PANEL_W, PANEL_H, {
            mode: 'graphic',
            rotation: 'none',
        });
        assert.equal(frame.length, X3_FRAME_BYTES, `${fit}: frame size`);
        assert.equal(previewRgba.length, PANEL_W * PANEL_H * 4, `${fit}: preview size`);
    }
});

test("conformRgba 'fit' puts the landscape bars on the other axis than portrait", () => {
    // 40x30 (1.333) is NARROWER than the landscape target (792/528 = 1.5), so
    // HEIGHT binds and the bars are pillarboxes at left/right — the opposite of
    // the portrait case above, where the same source letterboxes top/bottom.
    // Getting this backwards is exactly how an orientation toggle ships white
    // bars across the wrong axis, and it is invisible in a byte count.
    const src = solid(40, 30, 128, 128, 128);
    const out = conformRgba(src, 40, 30, PANEL_W, PANEL_H, 'fit');

    // scale = min(792/40 = 19.8, 528/30 = 17.6) = 17.6 -> box 704 x 528.
    const boxLeft = Math.floor((PANEL_W - 704) / 2); // 44

    assert.deepEqual(pixelAt(out, PANEL_W, 0, 0), [255, 255, 255, 255], 'left bar');
    assert.deepEqual(
        pixelAt(out, PANEL_W, boxLeft - 1, 264),
        [255, 255, 255, 255],
        'left bar, inner edge'
    );
    assert.deepEqual(
        pixelAt(out, PANEL_W, PANEL_W - 1, 264),
        [255, 255, 255, 255],
        'right bar'
    );

    // Inside the box the source colour survives, top row to bottom row: the box
    // fills the FULL height, so there is no top/bottom bar to find.
    assert.deepEqual(pixelAt(out, PANEL_W, boxLeft + 1, 0), [128, 128, 128, 255]);
    assert.deepEqual(pixelAt(out, PANEL_W, boxLeft + 1, PANEL_H - 1), [128, 128, 128, 255]);

    // ...and 'cover' fills the whole panel instead, with no bars anywhere.
    const covered = conformRgba(src, 40, 30, PANEL_W, PANEL_H, 'cover');
    for (let i = 0; i < covered.length; i += 4) {
        if (covered[i] !== 128) {
            assert.fail(`'cover' left a non-source pixel at index ${i / 4}`);
        }
    }
});

test('buildFrameActions plans the landscape target on the transposed axis', () => {
    // A tall source against the landscape target: 600x900 (0.667) is taller than
    // 792x528 (1.5), so width binds for cover and the crop takes the middle
    // 528 rows out of the 1188 the resize produces.
    const tall = { width: 600, height: 900 };
    assert.deepEqual(buildFrameActions(PANEL_W, PANEL_H, 'cover', tall), [
        { resize: { width: PANEL_W } },
        { crop: { originX: 0, originY: 330, width: PANEL_W, height: PANEL_H } },
    ]);
    // 1188 = trunc(900 * 792 / 600); (1188 - 528) / 2 = 330, and the crop must
    // fit the bitmap the native resize really returns.
    assertCropFitsBitmap(PANEL_W, PANEL_H, tall);

    // 'fit' constrains the binding axis only — height here, not width.
    assert.deepEqual(buildFrameActions(PANEL_W, PANEL_H, 'fit', tall), [
        { resize: { height: PANEL_H } },
    ]);
});
