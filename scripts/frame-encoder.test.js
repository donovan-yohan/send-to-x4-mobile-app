/**
 * frame_encoder regression tests.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `src/services/frame_encoder.ts` is the only thing standing between a composed
 * note and a 52272-byte buffer the firmware raw-blits with no validation. Every
 * failure mode here is silent on the device: a stray mirror renders mirrored
 * text, a flipped rotation renders sideways, an off-by-one row stride renders
 * sheared, and none of them throw.
 *
 * So the geometry assertions below are anchored to HAND-COMPUTED RAW BYTES and
 * to the M1 reference packer (`scripts/make_test_frame.mjs`). Deliberately NOT
 * anchored to a pack/unpack round trip through the encoder's own code: that
 * passes just as happily with the column order inverted on both sides at once.
 *
 * CONTRACT UNDER TEST (hardware-proven 2026-07-28 on a physical X3):
 *   NO MIRROR — stored bit j IS panel x = j; panel x=0 is the MSB of byte 0.
 *   ROTATION  — portrait -> landscape is COUNTER-CLOCKWISE by default, and a
 *               LANDSCAPE-composed note maps in with the identity ('none'),
 *               which is reference variant A — also photographed on the panel.
 *   GEOMETRY  — the rotation decides the accepted canvas (528x792 vs 792x528).
 *               The two are transposes, so they are the same byte count and
 *               only the width/height check can tell them apart.
 *
 * Run:  node --import tsx --test scripts/frame-encoder.test.js
 *       npm run test:all
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import { encodeFrame, DEFAULT_THRESHOLD } from '../src/services/frame_encoder';
import {
    COMPOSE_W,
    COMPOSE_H,
    PANEL_W,
    PANEL_H,
    ROW_BYTES,
    X3_FRAME_BYTES,
    X_MIRROR,
    DEFAULT_FRAME_ROTATION,
    DEFAULT_NOTE_ORIENTATION,
    NOTE_ORIENTATIONS,
    composeDimsFor,
    isNoteOrientation,
    rotationForOrientation,
} from '../src/device/x3';

// The hardware-validated reference implementation. JS, zero-dep, untouched.
import {
    LW,
    LH,
    PW,
    PH,
    FRAME_BYTES,
    VARIANTS,
    packFrame,
    unpackFrame,
    landscapeFromPortraitCW,
    landscapeFromPortraitCCW,
    makeCanvas,
    drawPattern,
} from './make_test_frame.mjs';

const PORTRAIT_PX = COMPOSE_W * COMPOSE_H;
const WHITE = 1;
const BLACK = 0;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Opaque portrait RGBA built from a per-pixel gray function. */
function grayPortrait(fn) {
    const rgba = new Uint8Array(PORTRAIT_PX * 4);
    for (let py = 0; py < COMPOSE_H; py++) {
        for (let px = 0; px < COMPOSE_W; px++) {
            const v = fn(px, py) & 0xff;
            const o = (py * COMPOSE_W + px) * 4;
            rgba[o] = v;
            rgba[o + 1] = v;
            rgba[o + 2] = v;
            rgba[o + 3] = 255;
        }
    }
    return rgba;
}

const solidPortrait = (v) => grayPortrait(() => v);

/** Opaque portrait RGBA built from a per-pixel [r,g,b] function. */
function colorPortrait(fn) {
    const rgba = new Uint8Array(PORTRAIT_PX * 4);
    for (let py = 0; py < COMPOSE_H; py++) {
        for (let px = 0; px < COMPOSE_W; px++) {
            const [r, g, b] = fn(px, py);
            const o = (py * COMPOSE_W + px) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
        }
    }
    return rgba;
}

/**
 * A make_test_frame 1-bit canvas (1 = white, 0 = black) rendered to RGBA.
 *
 * The expected dimensions are asserted, not inferred, so a fixture built in the
 * wrong space fails here instead of silently becoming the thing under test.
 * Defaults to the portrait compose canvas; landscape fixtures pass PANEL_W/H.
 */
function rgbaFromBilevelCanvas(c, expectW = COMPOSE_W, expectH = COMPOSE_H) {
    assert.equal(c.w, expectW, 'fixture canvas width');
    assert.equal(c.h, expectH, 'fixture canvas height');
    const rgba = new Uint8Array(c.data.length * 4);
    for (let i = 0, o = 0; i < c.data.length; i++, o += 4) {
        const v = c.data[i] === WHITE ? 255 : 0;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
    }
    return rgba;
}

/** All-white portrait except a single BLACK pixel. */
function singleBlackPixel(bx, by) {
    return grayPortrait((px, py) => (px === bx && py === by ? 0 : 255));
}

/** 1 = white, 0 = black, read out of the preview buffer. */
function previewBit(preview, px, py) {
    return preview[(py * COMPOSE_W + px) * 4] === 255 ? WHITE : BLACK;
}

function countPreviewWhite(preview) {
    let n = 0;
    for (let i = 0; i < preview.length; i += 4) if (preview[i] === 255) n++;
    return n;
}

/**
 * Assert every preview pixel matches `expected(px, py)`, reporting only the
 * first mismatch (418176 individual assert calls would dominate the run time).
 */
function assertPreviewMatches(preview, expected, label) {
    for (let py = 0; py < COMPOSE_H; py++) {
        for (let px = 0; px < COMPOSE_W; px++) {
            const got = previewBit(preview, px, py);
            const want = expected(px, py);
            if (got !== want) {
                assert.fail(
                    `${label}: pixel (${px},${py}) expected ${want ? 'WHITE' : 'BLACK'}, got ${got ? 'WHITE' : 'BLACK'}`
                );
            }
        }
    }
}

/**
 * Assert every frame byte is 0xFF except the listed exceptions.
 *
 * The type guard is load-bearing, not decoration: passing the whole
 * `{ frame, previewRgba }` result by mistake gives `frame.length === undefined`,
 * the loop below runs zero times, and the test passes while asserting NOTHING.
 * That is exactly what five call sites in this file were doing until 2026-07-28.
 */
function assertOnlyBytes(frame, exceptions, label) {
    assert.ok(
        frame instanceof Uint8Array,
        `${label}: assertOnlyBytes needs the frame bytes, not ${typeof frame} ` +
        '(did you forget to destructure `.frame`?)'
    );
    assert.equal(frame.length, X3_FRAME_BYTES, `${label}: frame length`);
    const map = new Map(exceptions);
    for (let i = 0; i < frame.length; i++) {
        const want = map.has(i) ? map.get(i) : 0xff;
        if (frame[i] !== want) {
            assert.fail(
                `${label}: byte ${i} expected 0x${want.toString(16).padStart(2, '0')}, ` +
                `got 0x${frame[i].toString(16).padStart(2, '0')}`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry contract
// ---------------------------------------------------------------------------

test('device geometry constants match the hardware contract', () => {
    assert.equal(COMPOSE_W, 528, 'portrait compose width');
    assert.equal(COMPOSE_H, 792, 'portrait compose height');
    assert.equal(PANEL_W, 792, 'landscape panel width');
    assert.equal(PANEL_H, 528, 'landscape panel height');
    assert.equal(ROW_BYTES, 99);
    assert.equal(X3_FRAME_BYTES, 52272);

    // Derived relationships — these are what actually break if someone "fixes"
    // one constant in isolation.
    assert.equal(PANEL_W / 8, ROW_BYTES, 'a row must pack with no slack bits');
    assert.equal(PANEL_H * ROW_BYTES, X3_FRAME_BYTES, 'rows x stride = file size');
    assert.equal(COMPOSE_W, PANEL_H, 'compose space is the panel transposed');
    assert.equal(COMPOSE_H, PANEL_W, 'compose space is the panel transposed');

    // HARDWARE-PROVEN 2026-07-28 on a physical X3. Both of these were the other
    // way round before that run; both were wrong on the panel.
    assert.equal(X_MIRROR, false, 'this panel is NOT X-mirrored: stored bit j IS panel x');
    assert.equal(DEFAULT_FRAME_ROTATION, 'ccw', 'ccw is the upright portrait->landscape map');
    assert.equal(DEFAULT_THRESHOLD, 128);

    // ...and they agree with the reference implementation, which is the copy
    // that was checked against a photograph of the real panel.
    assert.equal(PANEL_W, LW);
    assert.equal(PANEL_H, LH);
    assert.equal(COMPOSE_W, PW);
    assert.equal(COMPOSE_H, PH);
    assert.equal(X3_FRAME_BYTES, FRAME_BYTES);
});

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

test('encodeFrame always emits exactly 52272 frame bytes and a full preview', () => {
    const inputs = [
        ['all white', solidPortrait(255)],
        ['all black', solidPortrait(0)],
        ['mid gray', solidPortrait(128)],
        ['gradient', grayPortrait((px, py) => (px + py) & 0xff)],
    ];

    for (const [label, rgba] of inputs) {
        for (const mode of ['photo', 'graphic']) {
            for (const rotation of ['cw', 'ccw']) {
                const { frame, previewRgba } = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
                    mode,
                    rotation,
                });
                assert.equal(
                    frame.byteLength,
                    X3_FRAME_BYTES,
                    `${label}/${mode}/${rotation}: frame size`
                );
                assert.ok(frame instanceof Uint8Array, 'frame must be a Uint8Array');
                assert.equal(
                    previewRgba.byteLength,
                    PORTRAIT_PX * 4,
                    `${label}/${mode}/${rotation}: preview size`
                );
            }
        }
    }
});

test('encodeFrame rejects any canvas that is not 528x792', () => {
    const rgba = solidPortrait(255);

    assert.throws(
        () => encodeFrame(rgba, PANEL_W, PANEL_H),
        /expects a 528x792 portrait canvas, got 792x528/,
        'a landscape canvas must be rejected, not silently transposed'
    );
    assert.throws(() => encodeFrame(rgba, COMPOSE_W, COMPOSE_H - 1), /528x792/);
    assert.throws(() => encodeFrame(rgba, COMPOSE_W - 1, COMPOSE_H), /528x792/);

    // Right dimensions, wrong buffer — the case a naive length check misses.
    assert.throws(
        () => encodeFrame(new Uint8Array(PORTRAIT_PX * 3), COMPOSE_W, COMPOSE_H),
        /expects 1672704 RGBA bytes/
    );
    assert.throws(
        () => encodeFrame(new Uint8Array(0), COMPOSE_W, COMPOSE_H),
        /expects 1672704 RGBA bytes/
    );
});

test('encodeFrame does not mutate the caller RGBA buffer', () => {
    const rgba = grayPortrait((px, py) => (px * 7 + py * 13) & 0xff);
    const before = Uint8Array.from(rgba);
    encodeFrame(rgba, COMPOSE_W, COMPOSE_H, { mode: 'photo' });
    assert.deepEqual(Buffer.from(rgba), Buffer.from(before));
});

// ---------------------------------------------------------------------------
// Polarity
// ---------------------------------------------------------------------------

test('polarity: bit 1 = WHITE, bit 0 = BLACK', () => {
    for (const mode of ['photo', 'graphic']) {
        const white = encodeFrame(solidPortrait(255), COMPOSE_W, COMPOSE_H, { mode });
        assert.ok(
            white.frame.every((b) => b === 0xff),
            `${mode}: an all-white note must pack to all 0xFF`
        );

        const black = encodeFrame(solidPortrait(0), COMPOSE_W, COMPOSE_H, { mode });
        assert.ok(
            black.frame.every((b) => b === 0x00),
            `${mode}: an all-black note must pack to all 0x00`
        );
    }
});

// ---------------------------------------------------------------------------
// Luma
// ---------------------------------------------------------------------------

test('luma uses Rec.601 weights, not a flat RGB average', () => {
    // Rec.601: 0.299R + 0.587G + 0.114B.
    //   pure red   -> 76.2   -> BLACK at threshold 128
    //   pure green -> 149.7  -> WHITE
    //   pure blue  -> 29.1   -> BLACK
    // A flat (R+G+B)/3 average would make all three 85 -> all BLACK, so green
    // is the discriminating case.
    const bands = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
    ];
    const rgba = colorPortrait((_px, py) => bands[py % 3]);

    const { previewRgba } = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });

    assertPreviewMatches(
        previewRgba,
        (_px, py) => (py % 3 === 1 ? WHITE : BLACK),
        'Rec.601 bands'
    );
});

test('alpha is composited over WHITE paper, not over black and not ignored', () => {
    // Black RGB at alpha a composites to luma 255 - a.
    //   a = 0   -> 255 -> WHITE (a fully transparent region is paper)
    //   a = 64  -> 191 -> WHITE
    //   a = 128 -> 127 -> BLACK (just under the 128 cut)
    const alphas = [0, 64, 128];
    const rgba = new Uint8Array(PORTRAIT_PX * 4);
    for (let py = 0; py < COMPOSE_H; py++) {
        const a = alphas[py % 3];
        for (let px = 0; px < COMPOSE_W; px++) {
            const o = (py * COMPOSE_W + px) * 4;
            rgba[o] = 0;
            rgba[o + 1] = 0;
            rgba[o + 2] = 0;
            rgba[o + 3] = a;
        }
    }

    const { previewRgba } = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });

    assertPreviewMatches(
        previewRgba,
        (_px, py) => (py % 3 === 2 ? BLACK : WHITE),
        'alpha over white'
    );
});

// ---------------------------------------------------------------------------
// Graphic mode: threshold
// ---------------------------------------------------------------------------

test('graphic mode: white iff luma >= threshold, default 128', () => {
    const ramp = grayPortrait((_px, py) => py % 256);

    const dflt = encodeFrame(ramp, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });
    assertPreviewMatches(
        dflt.previewRgba,
        (_px, py) => (py % 256 >= 128 ? WHITE : BLACK),
        'default threshold'
    );

    const strict = encodeFrame(ramp, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        threshold: 200,
    });
    assertPreviewMatches(
        strict.previewRgba,
        (_px, py) => (py % 256 >= 200 ? WHITE : BLACK),
        'threshold 200'
    );
});

test('graphic mode: the threshold boundary is inclusive (>=, not >)', () => {
    const atCut = encodeFrame(solidPortrait(128), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });
    assert.ok(atCut.frame.every((b) => b === 0xff), 'luma exactly 128 must be WHITE');

    const belowCut = encodeFrame(solidPortrait(127), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });
    assert.ok(belowCut.frame.every((b) => b === 0x00), 'luma 127 must be BLACK');
});

test('graphic mode produces no dither grain on a flat mid tone', () => {
    // The whole point of 'graphic' for text/doodles: a flat fill stays flat.
    const flat = encodeFrame(solidPortrait(160), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });
    assert.ok(flat.frame.every((b) => b === 0xff));
});

// ---------------------------------------------------------------------------
// Photo mode: dither
// ---------------------------------------------------------------------------

test('photo mode actually dithers a flat mid tone (and graphic mode does not)', () => {
    const gray = solidPortrait(128);

    const photo = encodeFrame(gray, COMPOSE_W, COMPOSE_H, {
        mode: 'photo',
        autocontrast: false,
    });
    const graphic = encodeFrame(gray, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });

    assert.notDeepEqual(
        Buffer.from(photo.frame),
        Buffer.from(graphic.frame),
        'a flat mid tone must halftone differently in the two modes'
    );

    const white = countPreviewWhite(photo.previewRgba);
    assert.ok(white > 0 && white < PORTRAIT_PX, 'dither must emit both black and white');

    // Floyd-Steinberg conserves average intensity: 128/255 = 0.502 of the
    // pixels should end up white. Loose bounds — this is a sanity check on the
    // error diffusion weights summing to 1, not a golden image.
    const frac = white / PORTRAIT_PX;
    assert.ok(frac > 0.45 && frac < 0.56, `expected ~0.50 white, got ${frac.toFixed(4)}`);
});

test('photo mode is deterministic: same input, same bytes, every time', () => {
    const rgba = grayPortrait((px, py) => (px * 31 + py * 17) & 0xff);

    const a = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, { mode: 'photo' });
    const b = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, { mode: 'photo' });

    assert.deepEqual(Buffer.from(a.frame), Buffer.from(b.frame), 'frame must be reproducible');
    assert.deepEqual(
        Buffer.from(a.previewRgba),
        Buffer.from(b.previewRgba),
        'preview must be reproducible'
    );

    // Same pixels arriving in a different buffer object must also match — pins
    // that nothing leaks across calls in module scope.
    const copy = Uint8Array.from(rgba);
    const c = encodeFrame(copy, COMPOSE_W, COMPOSE_H, { mode: 'photo' });
    assert.deepEqual(Buffer.from(a.frame), Buffer.from(c.frame));
});

// ---------------------------------------------------------------------------
// Autocontrast
// ---------------------------------------------------------------------------

test('autocontrast stretches a low-contrast image, and is on by default', () => {
    // 41 vertical bands spanning luma 100..140 — the "muddy phone photo" case.
    //   value(px) = 100 + floor(px * 41 / 528)
    //
    // OFF: white iff value >= 128  <=>  floor(px*41/528) >= 28  <=>  px >= 361
    //      -> columns 361..527 = 167 of 528.
    // ON : 0.5 % clip finds lo = 100, hi = 140 (each band is ~2.4 % of the
    //      image, well above the clip), so scale = 255/40 = 6.375 and
    //      white iff (value-100)*6.375 >= 128 <=> value >= 121 <=> px >= 271
    //      -> columns 271..527 = 257 of 528.
    const bands = grayPortrait((px) => 100 + Math.floor((px * 41) / 528));

    const off = encodeFrame(bands, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
    });
    assert.equal(
        countPreviewWhite(off.previewRgba),
        167 * COMPOSE_H,
        'without autocontrast the cut sits at raw luma 128'
    );

    const on = encodeFrame(bands, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: true,
    });
    assert.equal(
        countPreviewWhite(on.previewRgba),
        257 * COMPOSE_H,
        'with autocontrast the cut sits at the middle of the actual range'
    );

    const dflt = encodeFrame(bands, COMPOSE_W, COMPOSE_H, { mode: 'graphic' });
    assert.deepEqual(
        Buffer.from(dflt.frame),
        Buffer.from(on.frame),
        'autocontrast must default to ON'
    );
});

test('autocontrast no-ops on a flat image instead of amplifying nothing', () => {
    // A blank canvas or a solid fill has a ~zero post-clip range. Dividing by it
    // would turn rounding dust into full-contrast garbage; the guard keeps the
    // identity mapping.
    for (const v of [0, 30, 200, 255]) {
        const { frame } = encodeFrame(solidPortrait(v), COMPOSE_W, COMPOSE_H, {
            mode: 'graphic',
            autocontrast: true,
        });
        const expected = v >= DEFAULT_THRESHOLD ? 0xff : 0x00;
        assert.ok(
            frame.every((b) => b === expected),
            `flat luma ${v} must stay flat under autocontrast`
        );
    }

    // Near-flat too: a 4-step range is below the stretch floor.
    const nearFlat = grayPortrait((px) => 200 + (px % 4));
    const { frame } = encodeFrame(nearFlat, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: true,
    });
    assert.ok(frame.every((b) => b === 0xff), 'a 4-step range must not be stretched');
});

// ---------------------------------------------------------------------------
// Column order and the rotation — hand-computed raw bytes
// ---------------------------------------------------------------------------

/**
 * Each row: a portrait corner, and the ONE frame byte it may modify under each
 * rotation. Every value below is derived BY HAND from the contract, never read
 * back out of the encoder:
 *
 *   cw  : lx = 791 - py, ly = px      ccw : lx = py, ly = 527 - px
 *   STRAIGHT pack (NO MIRROR)  : j = lx
 *   byte : ly * 99 + (j >> 3)         bit : 0x80 >> (j & 7)
 *
 * Worked examples (a single BLACK pixel on an otherwise all-white note, so the
 * one touched byte drops from 0xFF to 0xFF & ~bit):
 *
 *   portrait TL (0,0) under cw  -> landscape (791, 0)
 *     j = 791 -> byte 0*99 + 98 = 98, bit 0x80 >> 7 = 0x01 -> 0xFE.
 *   portrait TL (0,0) under ccw -> landscape (0, 527)
 *     j = 0   -> byte 527*99 + 0 = 52173, bit 0x80 -> 0x7F.
 *
 * These eight numbers ARE the packing contract. Under the pre-2026-07-28 mirror
 * (j = 791 - lx) every cw entry here was the ccw entry's byte and vice versa, so
 * a regression to the mirror cannot slip past this table. If hardware evidence
 * ever overturns the contract again, these are the numbers to change — and
 * nothing else in the suite.
 */
const CORNER_CASES = [
    { name: 'portrait TL', px: 0, py: 0, cw: [98, 0xfe], ccw: [52173, 0x7f] },
    { name: 'portrait TR', px: 527, py: 0, cw: [52271, 0xfe], ccw: [0, 0x7f] },
    { name: 'portrait BL', px: 0, py: 791, cw: [0, 0x7f], ccw: [52271, 0xfe] },
    { name: 'portrait BR', px: 527, py: 791, cw: [52173, 0x7f], ccw: [98, 0xfe] },
];

/**
 * The same contract, written once as executable arithmetic, used ONLY to check
 * the literal table above. If the table and this function ever disagree, one of
 * them was edited without re-deriving the other.
 */
function expectedByteAndBit(px, py, rotation) {
    const lx = rotation === 'cw' ? PANEL_W - 1 - py : py;
    const ly = rotation === 'cw' ? px : PANEL_H - 1 - px;
    const j = lx; // STRAIGHT: no mirror.
    return [ly * ROW_BYTES + (j >> 3), 0xff & ~(0x80 >> (j & 7))];
}

test('the hand-computed corner table matches the written-out contract', () => {
    for (const c of CORNER_CASES) {
        assert.deepEqual(expectedByteAndBit(c.px, c.py, 'cw'), c.cw, `${c.name} cw`);
        assert.deepEqual(expectedByteAndBit(c.px, c.py, 'ccw'), c.ccw, `${c.name} ccw`);
    }
});

test('corner pixels land at the hand-computed byte and bit (rotation cw)', () => {
    for (const c of CORNER_CASES) {
        const { frame } = encodeFrame(
            singleBlackPixel(c.px, c.py),
            COMPOSE_W,
            COMPOSE_H,
            { mode: 'graphic', autocontrast: false, rotation: 'cw' }
        );
        assertOnlyBytes(frame, [c.cw], `cw / ${c.name}`);
    }
});

test('corner pixels land at the hand-computed byte and bit (rotation ccw)', () => {
    for (const c of CORNER_CASES) {
        const { frame } = encodeFrame(
            singleBlackPixel(c.px, c.py),
            COMPOSE_W,
            COMPOSE_H,
            { mode: 'graphic', autocontrast: false, rotation: 'ccw' }
        );
        assertOnlyBytes(frame, [c.ccw], `ccw / ${c.name}`);
    }
});

test('cw and ccw place every corner differently (the direction is real)', () => {
    for (const c of CORNER_CASES) {
        assert.notDeepEqual(c.cw, c.ccw, `${c.name}: cw and ccw must differ`);
    }
});

test('bit order within a byte is MSB-first', () => {
    // ccw (the default): portrait (527,1) -> landscape lx = py = 1, ly = 527 - 527 = 0.
    //   j = lx = 1 -> byte 0, bit 0x80 >> 1 = 0x40 -> 0xFF & ~0x40 = 0xBF.
    // An LSB-first packer (bit 1 << (j & 7) = 0x02) would produce 0xFD here.
    const ccw = encodeFrame(singleBlackPixel(527, 1), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'ccw',
    });
    assertOnlyBytes(ccw.frame, [[0, 0xbf]], 'MSB-first (ccw)');

    // cw: portrait (0,1) -> landscape lx = 791 - 1 = 790, ly = 0.
    //   j = 790 -> byte 790 >> 3 = 98, bit 0x80 >> (790 & 7 = 6) = 0x02 -> 0xFD.
    // An LSB-first packer would produce 0xBF here — the exact swap of the ccw
    // case above, so the two together pin the bit direction, not just a value.
    const cw = encodeFrame(singleBlackPixel(0, 1), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'cw',
    });
    assertOnlyBytes(cw.frame, [[98, 0xfd]], 'MSB-first (cw)');
});

test('row stride is exactly 99 bytes', () => {
    // ccw: portrait (526,0) -> landscape lx = py = 0, ly = 527 - 526 = 1.
    //   j = 0 -> byte 1*99 + 0 = 99 exactly, bit 0x80 -> 0x7F. A stride of 98 or
    //   100 puts this byte in a different row.
    const secondRow = encodeFrame(singleBlackPixel(526, 0), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'ccw',
    });
    assertOnlyBytes(secondRow.frame, [[1 * ROW_BYTES, 0x7f]], 'row 1 start (ccw)');

    // Same row, other end: portrait (526,791) -> lx = 791, ly = 1.
    //   j = 791 -> byte 1*99 + 98 = 197, bit 0x01 -> 0xFE. Byte 197 is the LAST
    //   byte of row 1, so row 2 starts at 198 = 2*99.
    const secondRowEnd = encodeFrame(singleBlackPixel(526, 791), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'ccw',
    });
    assertOnlyBytes(secondRowEnd.frame, [[2 * ROW_BYTES - 1, 0xfe]], 'row 1 end (ccw)');

    // ...and the last byte of the buffer, proving nothing overflows the end.
    // ccw: portrait (0,791) -> lx = 791, ly = 527 -> byte 527*99 + 98 = 52271.
    const lastByte = encodeFrame(singleBlackPixel(0, 791), COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'ccw',
    });
    assertOnlyBytes(lastByte.frame, [[X3_FRAME_BYTES - 1, 0xfe]], 'final byte (ccw)');
});

// ---------------------------------------------------------------------------
// Cross-validation against the hardware-validated reference packer
// ---------------------------------------------------------------------------

test('encoder output is byte-identical to make_test_frame for both rotations', () => {
    // Author one non-symmetric artwork in the reference implementation's own
    // authoring space (1 byte/px, 1 = white), then push the SAME artwork through
    // both pipelines:
    //   reference : drawPattern -> landscapeFromPortraitXX -> packFrame
    //   encoder   : RGBA -> graphic threshold -> rotate -> straight pack
    // packFrame is called with NO options, i.e. its straight (unmirrored)
    // default — the same contract the encoder hard-codes — so this is a real
    // cross-check of two independent implementations, not of one flag.
    // A single differing byte anywhere in 52272 fails this.
    const canvas = makeCanvas(PW, PH);
    drawPattern(canvas, ['CROSS CHECK']);

    const ink = canvas.data.reduce((n, v) => n + (v === BLACK ? 1 : 0), 0);
    assert.ok(ink > 1000, `fixture must contain real artwork (got ${ink} black px)`);

    const rgba = rgbaFromBilevelCanvas(canvas);

    for (const [rotation, mapFn] of [
        ['cw', landscapeFromPortraitCW],
        ['ccw', landscapeFromPortraitCCW],
    ]) {
        const reference = packFrame(mapFn(canvas));
        assert.equal(reference.length, FRAME_BYTES);

        // graphic + no autocontrast is the identity halftone for a 0/255 input:
        // 0 -> BLACK, 255 -> WHITE. Any other setting would be testing the
        // halftone, not the geometry.
        const { frame } = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
            mode: 'graphic',
            autocontrast: false,
            rotation,
        });

        assert.deepEqual(
            Buffer.from(frame),
            Buffer.from(reference),
            `${rotation}: frame_encoder must byte-match make_test_frame`
        );
    }
});

test('the two rotations of the same artwork are different frames', () => {
    const canvas = makeCanvas(PW, PH);
    drawPattern(canvas, ['CROSS CHECK']);
    const rgba = rgbaFromBilevelCanvas(canvas);

    const cw = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'cw',
    });
    const ccw = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'ccw',
    });

    assert.notDeepEqual(Buffer.from(cw.frame), Buffer.from(ccw.frame));
    // ...but the preview is taken BEFORE rotation, so it must be identical.
    assert.deepEqual(Buffer.from(cw.previewRgba), Buffer.from(ccw.previewRgba));
});

// ---------------------------------------------------------------------------
// Landscape orientation — rotation 'none' (identity mapping)
// ---------------------------------------------------------------------------

/** All-white LANDSCAPE (792x528) RGBA except a single BLACK pixel. */
function landscapeSingleBlackPixel(bx, by) {
    const rgba = new Uint8Array(PANEL_W * PANEL_H * 4);
    rgba.fill(255);
    const o = (by * PANEL_W + bx) * 4;
    rgba[o] = 0;
    rgba[o + 1] = 0;
    rgba[o + 2] = 0;
    return rgba;
}

test("rotation 'none' is byte-identical to make_test_frame variant A", () => {
    // Variant A is the frame that was PHOTOGRAPHED on the physical panel on
    // 2026-07-28 and proved the no-mirror finding: artwork authored directly in
    // 792x528 landscape space, mapped in with the identity. `build()` runs that
    // exact reference path (drawPattern -> landscapeFromLandscape), so this is a
    // cross-check of two independent implementations of the SAME hardware-proven
    // mapping — not of a flag.
    const variantA = VARIANTS.find((v) => v.id === 'A');
    assert.ok(variantA, 'the reference generator must still ship variant A');

    const canvas = variantA.build();
    assert.equal(canvas.w, LW, 'variant A is authored in landscape space');
    assert.equal(canvas.h, LH);

    const ink = canvas.data.reduce((n, v) => n + (v === BLACK ? 1 : 0), 0);
    assert.ok(ink > 1000, `fixture must contain real artwork (got ${ink} black px)`);

    const reference = packFrame(canvas); // straight, unmirrored — the default
    assert.equal(reference.length, FRAME_BYTES);

    // graphic + no autocontrast is the identity halftone for a 0/255 input, so
    // only the geometry is under test here.
    const rgba = rgbaFromBilevelCanvas(canvas, PANEL_W, PANEL_H);
    const { frame, previewRgba } = encodeFrame(rgba, PANEL_W, PANEL_H, {
        mode: 'graphic',
        autocontrast: false,
        rotation: 'none',
    });

    assert.deepEqual(
        Buffer.from(frame),
        Buffer.from(reference),
        "rotation 'none' must byte-match make_test_frame variant A"
    );

    // Identity in, identity out: with no rotation the preview is the canvas
    // itself, which is what makes a landscape preview true-to-panel.
    assert.deepEqual(
        Buffer.from(previewRgba),
        Buffer.from(rgba),
        "rotation 'none': the preview must be the composed canvas, unchanged"
    );
});

test("rotation 'none': panel (x,y) packs straight to byte y*99 + (x>>3), MSB-first", () => {
    // Hand-computed from the contract, exactly as the cw/ccw corner tests are.
    // A round trip could not catch a transposed identity; these four can.
    const cases = [
        // panel (0,0) -> j = 0 -> byte 0, bit 0x80 -> 0xFF & ~0x80
        [0, 0, 0, 0x7f, 'top-left'],
        // panel (1,0) -> j = 1 -> byte 0, bit 0x40. An LSB-first packer gives 0xFD.
        [1, 0, 0, 0xbf, 'second column (MSB-first)'],
        // panel (0,1) -> row 1 starts at byte 99, so a wrong stride moves this.
        [0, 1, ROW_BYTES, 0x7f, 'second row'],
        // panel (791,527) -> byte 527*99 + 98 = 52271, bit 0x01. Nothing overflows.
        [PANEL_W - 1, PANEL_H - 1, X3_FRAME_BYTES - 1, 0xfe, 'bottom-right'],
    ];

    for (const [lx, ly, byteIndex, byteValue, name] of cases) {
        const { frame } = encodeFrame(
            landscapeSingleBlackPixel(lx, ly),
            PANEL_W,
            PANEL_H,
            { mode: 'graphic', autocontrast: false, rotation: 'none' }
        );
        assertOnlyBytes(frame, [[byteIndex, byteValue]], `none / ${name}`);
    }
});

test('the canvas encodeFrame accepts is decided by the rotation, both ways', () => {
    const portrait = solidPortrait(255);
    const landscape = new Uint8Array(PANEL_W * PANEL_H * 4).fill(255);

    // The trap this guards: the two canvases are TRANSPOSES, so they are the
    // same number of bytes. A length check alone can never tell them apart.
    assert.equal(portrait.length, landscape.length);

    // A landscape canvas through a rotating mapping...
    for (const rotation of ['ccw', 'cw']) {
        assert.throws(
            () => encodeFrame(landscape, PANEL_W, PANEL_H, { rotation }),
            new RegExp(`rotation '${rotation}' expects a 528x792 portrait canvas, got 792x528`),
            `${rotation} must reject a landscape canvas`
        );
    }
    // ...and the default is a rotating mapping, so it rejects it too.
    assert.throws(
        () => encodeFrame(landscape, PANEL_W, PANEL_H),
        /expects a 528x792 portrait canvas, got 792x528/
    );

    // A portrait canvas through the identity.
    assert.throws(
        () => encodeFrame(portrait, COMPOSE_W, COMPOSE_H, { rotation: 'none' }),
        /rotation 'none' expects a 792x528 landscape canvas, got 528x792/,
        "'none' must reject a portrait canvas, not silently transpose it"
    );

    // Dimensions right for 'none', buffer wrong — the case the size check misses.
    assert.throws(
        () => encodeFrame(new Uint8Array(0), PANEL_W, PANEL_H, { rotation: 'none' }),
        /expects 1672704 RGBA bytes/
    );

    // And the matching pairs are accepted.
    assert.equal(
        encodeFrame(landscape, PANEL_W, PANEL_H, { rotation: 'none' }).frame.length,
        X3_FRAME_BYTES
    );
    assert.equal(
        encodeFrame(portrait, COMPOSE_W, COMPOSE_H).frame.length,
        X3_FRAME_BYTES
    );
});

test('every NoteOrientation resolves to a canvas the encoder accepts', () => {
    // The orientation helpers in src/device/x3.ts are what the UI and
    // image_converter both size from. If they ever disagree with the encoder's
    // per-rotation validation, every send in that orientation throws — so the
    // agreement is asserted here rather than assumed.
    assert.equal(DEFAULT_NOTE_ORIENTATION, 'portrait', 'portrait is how a book is held');
    assert.deepEqual(composeDimsFor('portrait'), { width: COMPOSE_W, height: COMPOSE_H });
    assert.deepEqual(composeDimsFor('landscape'), { width: PANEL_W, height: PANEL_H });
    assert.equal(rotationForOrientation('portrait'), DEFAULT_FRAME_ROTATION);
    assert.equal(rotationForOrientation('landscape'), 'none');
    assert.deepEqual([...NOTE_ORIENTATIONS], ['portrait', 'landscape']);

    // Unknown values throw instead of quietly defaulting to portrait, and the
    // guard is the sanctioned way to sanitize a persisted string first.
    assert.ok(isNoteOrientation('landscape') && !isNoteOrientation('LANDSCAPE'));
    assert.throws(() => composeDimsFor('sideways'), /unknown note orientation/);
    assert.throws(() => rotationForOrientation(undefined), /unknown note orientation/);

    for (const orientation of NOTE_ORIENTATIONS) {
        const { width, height } = composeDimsFor(orientation);
        const rotation = rotationForOrientation(orientation);
        const { frame, previewRgba } = encodeFrame(
            new Uint8Array(width * height * 4).fill(255),
            width,
            height,
            { rotation }
        );
        assert.equal(frame.length, X3_FRAME_BYTES, `${orientation}: frame size`);
        assert.equal(
            previewRgba.length,
            width * height * 4,
            `${orientation}: the preview is in compose space, not panel space`
        );
    }
});

// ---------------------------------------------------------------------------
// Preview <-> frame consistency
// ---------------------------------------------------------------------------

test('previewRgba is strictly opaque black or white', () => {
    const { previewRgba } = encodeFrame(
        grayPortrait((px, py) => (px * 3 + py * 5) & 0xff),
        COMPOSE_W,
        COMPOSE_H,
        { mode: 'photo' }
    );

    for (let i = 0; i < previewRgba.length; i += 4) {
        const r = previewRgba[i];
        if (r !== 0 && r !== 255) assert.fail(`preview byte ${i} is ${r}, not 0 or 255`);
        if (previewRgba[i + 1] !== r || previewRgba[i + 2] !== r) {
            assert.fail(`preview pixel ${i / 4} is not neutral gray`);
        }
        if (previewRgba[i + 3] !== 255) assert.fail(`preview pixel ${i / 4} is not opaque`);
    }
});

test('the preview is exactly what got packed, inverse-mapped through the rotation', () => {
    // Unpack with the reference implementation (whose default is the same
    // straight, unmirrored column order the encoder packs with), then apply the
    // FORWARD rotation formulas written out here independently of the encoder.
    // Every one of the 418176 portrait pixels must agree with the preview.
    const rgba = grayPortrait((px, py) => (px * 11 + py * 7 + ((px * py) >> 5)) & 0xff);

    for (const rotation of ['cw', 'ccw']) {
        const { frame, previewRgba } = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
            mode: 'photo',
            rotation,
        });

        const panel = unpackFrame(frame); // 792x528, straight column order, 1 = white

        for (let py = 0; py < COMPOSE_H; py++) {
            for (let px = 0; px < COMPOSE_W; px++) {
                const lx = rotation === 'cw' ? PANEL_W - 1 - py : py;
                const ly = rotation === 'cw' ? px : PANEL_H - 1 - px;
                const onPanel = panel.data[ly * PANEL_W + lx];
                const inPreview = previewBit(previewRgba, px, py);
                if (onPanel !== inPreview) {
                    assert.fail(
                        `${rotation}: portrait (${px},${py}) -> panel (${lx},${ly}): ` +
                        `frame says ${onPanel ? 'WHITE' : 'BLACK'}, preview says ` +
                        `${inPreview ? 'WHITE' : 'BLACK'}`
                    );
                }
            }
        }
    }
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('omitting opts equals photo + ccw + autocontrast + threshold 128', () => {
    const rgba = grayPortrait((px, py) => 60 + ((px + py) % 120));

    const implicit = encodeFrame(rgba, COMPOSE_W, COMPOSE_H);
    const explicit = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
        mode: 'photo',
        rotation: 'ccw',
        autocontrast: true,
        threshold: 128,
    });

    assert.deepEqual(Buffer.from(implicit.frame), Buffer.from(explicit.frame));
    assert.deepEqual(Buffer.from(implicit.previewRgba), Buffer.from(explicit.previewRgba));

    // An empty options object must behave the same as no options at all.
    const empty = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {});
    assert.deepEqual(Buffer.from(implicit.frame), Buffer.from(empty.frame));

    // ...and the default is NOT the other direction. Without this, the two
    // assertions above still pass if someone flips the default back to 'cw' and
    // "fixes" the explicit case to match — which is exactly how this test came
    // to be asserting the wrong default in the first place.
    const wrongWay = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, {
        mode: 'photo',
        rotation: 'cw',
        autocontrast: true,
        threshold: 128,
    });
    assert.notDeepEqual(
        Buffer.from(implicit.frame),
        Buffer.from(wrongWay.frame),
        "the default rotation must be 'ccw' (hardware-proven upright), not 'cw'"
    );
});
