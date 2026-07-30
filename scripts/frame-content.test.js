/**
 * frame_content — the blank-note guard on the send path.
 *
 * The claim under test is the POLARITY ASSUMPTION: that "every byte is 0xFF"
 * really is the frame a blank canvas produces. Asserting that against a
 * hand-built buffer would only re-state the constant, so every test here goes
 * through the real `encodeFrame` — the same packer the send path uses — and
 * checks that a canvas with nothing on it is reported blank and a canvas with
 * ONE black pixel on it is not.
 *
 * That second case is the one that matters: if the guard were even slightly
 * too eager it would refuse to send a genuine note, which is worse than the
 * blank overlay it exists to prevent.
 *
 * Run:  node --import tsx --test scripts/frame-content.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import { isBlankFrame } from '../src/services/frame_content';
import { encodeFrame } from '../src/services/frame_encoder';
import { COMPOSE_H, COMPOSE_W, X3_FRAME_BYTES } from '../src/device/x3';

/** A full COMPOSE_W x COMPOSE_H opaque canvas filled with one grey level. */
function canvas(level) {
    const rgba = new Uint8Array(COMPOSE_W * COMPOSE_H * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = level;
        rgba[i + 1] = level;
        rgba[i + 2] = level;
        rgba[i + 3] = 255;
    }
    return rgba;
}

function setPixel(rgba, x, y, level) {
    const o = (y * COMPOSE_W + x) * 4;
    rgba[o] = level;
    rgba[o + 1] = level;
    rgba[o + 2] = level;
    rgba[o + 3] = 255;
}

test('a blank white canvas encodes to an all-0xFF frame', () => {
    // Pins the assumption the guard is built on, end to end: white paper ->
    // bit 1 -> byte 0xFF, through autocontrast (which no-ops on a flat image),
    // the rotation and the straight MSB-first column packing.
    const { frame } = encodeFrame(canvas(255), COMPOSE_W, COMPOSE_H, { mode: 'graphic' });
    assert.equal(frame.length, X3_FRAME_BYTES);
    assert.ok(
        frame.every(b => b === 0xff),
        'a white canvas must pack to every bit set'
    );
    assert.equal(isBlankFrame(frame), true);
});

test('the photo/dither path also reports a blank canvas as blank', () => {
    // Floyd-Steinberg has no error to diffuse on a flat white field, so the
    // dithered path must agree with the threshold path. If it ever did not,
    // the guard would silently stop firing for photo-mode notes.
    const { frame } = encodeFrame(canvas(255), COMPOSE_W, COMPOSE_H, { mode: 'photo' });
    assert.equal(isBlankFrame(frame), true);
});

test('one black pixel anywhere makes the frame non-blank', () => {
    // The corners are where a rotation or column-order bug would drop a pixel
    // off the buffer entirely and hand back an all-white frame.
    const corners = [
        [0, 0],
        [COMPOSE_W - 1, 0],
        [0, COMPOSE_H - 1],
        [COMPOSE_W - 1, COMPOSE_H - 1],
        [COMPOSE_W >> 1, COMPOSE_H >> 1],
    ];
    for (const [x, y] of corners) {
        const rgba = canvas(255);
        setPixel(rgba, x, y, 0);
        const { frame } = encodeFrame(rgba, COMPOSE_W, COMPOSE_H, { mode: 'graphic' });
        assert.equal(isBlankFrame(frame), false, `pixel ${x},${y} was not detected`);
    }
});

test('an all-black canvas is not blank', () => {
    const { frame } = encodeFrame(canvas(0), COMPOSE_W, COMPOSE_H, { mode: 'graphic' });
    assert.ok(
        frame.every(b => b === 0x00),
        'a black canvas must pack to every bit clear'
    );
    assert.equal(isBlankFrame(frame), false);
});

test('isBlankFrame reads raw buffers bit-exactly', () => {
    assert.equal(isBlankFrame(new Uint8Array(0)), true, 'nothing to display is blank');
    assert.equal(isBlankFrame(new Uint8Array([0xff, 0xff, 0xff])), true);
    // A single cleared bit in the LAST byte is the case a chunked or
    // early-exit scan is most likely to miss.
    assert.equal(isBlankFrame(new Uint8Array([0xff, 0xff, 0xfe])), false);
    assert.equal(isBlankFrame(new Uint8Array([0x7f, 0xff, 0xff])), false);
    assert.equal(isBlankFrame(new Uint8Array(X3_FRAME_BYTES).fill(0xff)), true);
});
