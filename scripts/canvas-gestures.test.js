/**
 * canvas_gestures — the drag/tap thresholds behind CanvasComposer's text tool.
 *
 * These numbers are the difference between working corner buttons and dead
 * ones. A selected text element wraps its ✕/✎ handles in the view that owns
 * the drag PanResponder, and React Native lets that ancestor take the responder
 * back on any touch move — which cancels the in-flight press. The regression
 * these tests exist to catch is `shouldGrantDrag` becoming true for the
 * pixel-scale jitter every real finger produces between touch-down and lift:
 * that is exactly the shape the bug had on device (buttons dead, drag and
 * double-tap alive).
 *
 * The other invariant pinned here is that "did not become a drag" and "counts
 * as a tap" are complements. If they are ever tuned apart there is a band of
 * gestures that is neither, and a wobbly double tap silently stops opening the
 * editor.
 *
 * Run:  node --import tsx --test scripts/canvas-gestures.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    DOUBLE_TAP_MS,
    DRAG_SLOP,
    isDoubleTap,
    isTapGesture,
    shouldGrantDrag,
} from '../src/components/canvas_gestures';

test('finger jitter never claims the drag, so a button press survives', () => {
    // Everything a stationary press realistically reports. If any of these
    // grant, the corner handles are dead again.
    const jitter = [
        [0, 0],
        [0.5, -0.25],
        [-1, 1],
        [2, 3],
        [-4, 0],
        [0, 5],
        [DRAG_SLOP, -DRAG_SLOP],
    ];
    for (const [dx, dy] of jitter) {
        assert.equal(shouldGrantDrag(dx, dy), false, `granted a drag for (${dx}, ${dy})`);
        assert.equal(isTapGesture(dx, dy), true, `(${dx}, ${dy}) should read as a tap`);
    }
});

test('a deliberate drag past the slop claims it, on either axis and either sign', () => {
    const drags = [
        [DRAG_SLOP + 0.01, 0],
        [-(DRAG_SLOP + 0.01), 0],
        [0, DRAG_SLOP + 0.01],
        [0, -(DRAG_SLOP + 0.01)],
        [40, -120],
    ];
    for (const [dx, dy] of drags) {
        assert.equal(shouldGrantDrag(dx, dy), true, `refused a drag for (${dx}, ${dy})`);
        assert.equal(isTapGesture(dx, dy), false, `(${dx}, ${dy}) should not read as a tap`);
    }
});

test('the threshold is exclusive: exactly slop is still a press', () => {
    // The boundary belongs to the press. A gesture that lands precisely on the
    // threshold is far more likely to be a firm finger than an intent to move.
    assert.equal(shouldGrantDrag(DRAG_SLOP, DRAG_SLOP), false);
    assert.equal(shouldGrantDrag(-DRAG_SLOP, -DRAG_SLOP), false);
    assert.equal(shouldGrantDrag(DRAG_SLOP + 0.001, DRAG_SLOP), true);
});

test('tap and drag are exact complements across the whole range', () => {
    for (let d = -20; d <= 20; d += 0.5) {
        assert.equal(isTapGesture(d, 0), !shouldGrantDrag(d, 0), `dx ${d}`);
        assert.equal(isTapGesture(0, d), !shouldGrantDrag(0, d), `dy ${d}`);
        assert.equal(isTapGesture(d, d), !shouldGrantDrag(d, d), `dx=dy ${d}`);
    }
});

test('the slop is tunable, and a zero slop grants on any movement', () => {
    assert.equal(shouldGrantDrag(3, 0, 10), false);
    assert.equal(shouldGrantDrag(11, 0, 10), true);
    assert.equal(shouldGrantDrag(0.5, 0, 0), true);
    assert.equal(shouldGrantDrag(0, 0, 0), false);
});

test('non-finite gesture state fails towards the press, not the drag', () => {
    // Never observed — gesture state is native-sourced — but refusing to grant
    // leaves the buttons working, which is the failure worth having.
    for (const bad of [NaN, Infinity, -Infinity]) {
        assert.equal(shouldGrantDrag(bad, 0), false);
        assert.equal(shouldGrantDrag(0, bad), false);
        assert.equal(isTapGesture(bad, bad), true);
    }
});

test('a first tap is never a double tap', () => {
    // 0 is the caller's "no previous tap" sentinel, and `now` is a real epoch
    // stamp, so the naive `now - last < 300` would be true for neither — but it
    // must stay false even if the clock is near zero.
    assert.equal(isDoubleTap(Date.now(), 0), false);
    assert.equal(isDoubleTap(10, 0), false);
    assert.equal(isDoubleTap(0, 0), false);
});

test('two taps inside the window are a double tap, outside it are not', () => {
    const t0 = 1_700_000_000_000;
    assert.equal(isDoubleTap(t0 + 1, t0), true);
    assert.equal(isDoubleTap(t0 + DOUBLE_TAP_MS - 1, t0), true);
    assert.equal(isDoubleTap(t0, t0), true);
    assert.equal(isDoubleTap(t0 + DOUBLE_TAP_MS, t0), false);
    assert.equal(isDoubleTap(t0 + DOUBLE_TAP_MS + 1, t0), false);
    assert.equal(isDoubleTap(t0 + 5_000, t0), false);
});

test('a clock that jumped backwards cannot manufacture a double tap', () => {
    const t0 = 1_700_000_000_000;
    assert.equal(isDoubleTap(t0 - 1, t0), false);
    assert.equal(isDoubleTap(t0 - 10_000, t0), false);
});

test('the double-tap window is tunable', () => {
    const t0 = 1_700_000_000_000;
    assert.equal(isDoubleTap(t0 + 400, t0, 500), true);
    assert.equal(isDoubleTap(t0 + 400, t0, 200), false);
});
