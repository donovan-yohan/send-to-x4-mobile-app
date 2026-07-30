import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
    LW,
    LH,
    ROW_BYTES,
    FRAME_BYTES,
    PW,
    PH,
    VARIANTS,
    packFrame,
    unpackFrame,
    bitIndexForColumn,
    landscapeFromPortraitCW,
    landscapeFromPortraitCCW,
    makeCanvas,
    assertNoMirror,
    assertMirroredLegacy,
} from './make_test_frame.mjs';

/**
 * Regression tests for the Xteink X3 love-note frame packer and the two
 * portrait->landscape rotation maps.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * make_test_frame.mjs self-checks on every generate, but its round-trip check
 * only proves packFrame/unpackFrame are mutual INVERSES — it would pass just as
 * happily if BOTH had the column order flipped. That column order is exactly
 * what M1 was built to settle on hardware, so it needs assertions anchored to
 * hand-computed RAW BYTES, not to a round trip.
 *
 * test-frames/ is gitignored, so without this file a fresh checkout keeps
 * neither the artifacts nor any proof they were built correctly.
 *
 * DEVICE CONTRACT UNDER TEST (HARDWARE-PROVEN 2026-07-28 on a physical X3):
 *   792x528 landscape, 1bpp, 528 rows x 99 bytes = 52272 bytes, no header.
 *   Bit 1 = WHITE, 0 = BLACK. MSB-first within each byte.
 *   NO MIRROR: stored bit j IS panel x = j. Panel x=0 is the MSB of byte 0.
 *
 * The firmware raw-blits with no horizontal flip: frames packed with the old
 * `j = 791 - x` mirror rendered MIRRORED on the panel, and straight frames
 * rendered correct. `packFrame(canvas, { mirror: true })` still reproduces the
 * old behaviour behind the `--mirror` flag, for diagnosing a suspected firmware
 * change; the tests below pin BOTH orders to concrete bytes so neither can drift
 * into the other.
 */

const WHITE = 1;
const BLACK = 0;

/** All-white landscape canvas (makeCanvas already fills white; be explicit). */
function whiteCanvas() {
    const c = makeCanvas(LW, LH);
    c.data.fill(WHITE);
    return c;
}

function setPanelPx(c, x, y, v) {
    c.data[y * c.w + x] = v;
}

// ---------------------------------------------------------------------------
// Size / shape
// ---------------------------------------------------------------------------

test('frame geometry matches the device contract exactly', () => {
    assert.equal(LW, 792, 'panel width');
    assert.equal(LH, 528, 'panel height');
    assert.equal(ROW_BYTES, 99, '792 px / 8 bits');
    assert.equal(LW / 8, ROW_BYTES, 'row must pack with no slack bits');
    assert.equal(FRAME_BYTES, 52272);
    assert.equal(FRAME_BYTES, LH * ROW_BYTES);
    // The portrait compose canvas is the landscape one transposed.
    assert.equal(PW, LH);
    assert.equal(PH, LW);
});

test('packFrame always emits exactly 52272 bytes', () => {
    assert.equal(packFrame(whiteCanvas()).length, FRAME_BYTES);

    const black = makeCanvas(LW, LH);
    black.data.fill(BLACK);
    assert.equal(packFrame(black).length, FRAME_BYTES);
});

test('packFrame rejects a canvas that is not 792x528', () => {
    assert.throws(() => packFrame(makeCanvas(PW, PH)), /792x528/);
});

test('unpackFrame rejects a buffer that is not 52272 bytes', () => {
    assert.throws(() => unpackFrame(Buffer.alloc(FRAME_BYTES - 1)), /expected 52272 bytes/);
});

// ---------------------------------------------------------------------------
// Polarity
// ---------------------------------------------------------------------------

test('polarity: bit 1 = WHITE, bit 0 = BLACK', () => {
    const white = packFrame(whiteCanvas());
    assert.ok(white.every((b) => b === 0xff), 'an all-white panel must be all 0xFF');

    const blackCanvas = makeCanvas(LW, LH);
    blackCanvas.data.fill(BLACK);
    const black = packFrame(blackCanvas);
    assert.ok(black.every((b) => b === 0x00), 'an all-black panel must be all 0x00');
});

// ---------------------------------------------------------------------------
// Column order — hand-computed raw bytes, direction-sensitive
// ---------------------------------------------------------------------------

test('NO mirror: panel-left pixel lands in the FIRST byte of the row', () => {
    // Panel pixel x=0 (LEFT edge), y=0, painted BLACK on an otherwise white row.
    //   j    = 0                      <- straight: the stored bit index IS x
    //   byte = 0 >> 3 = 0             <- first byte of the 99-byte row
    //   bit  = 7 - (0 & 7) = 7        <- the MSB
    // so byte 0 loses only its MSB: 0xFF & ~0x80 = 0x7F.
    const c = whiteCanvas();
    setPanelPx(c, 0, 0, BLACK);
    const buf = packFrame(c);

    assert.equal(buf[0], 0x7f, 'panel x=0 must clear the MSB of byte 0');
    assert.equal(buf[98], 0xff, 'byte 98 holds the panel-RIGHT pixels and must be untouched');
    for (let i = 1; i < ROW_BYTES; i++) {
        assert.equal(buf[i], 0xff, `row-0 byte ${i} should still be white`);
    }
});

test('NO mirror: panel-right pixel lands in the LAST byte of the row', () => {
    // Panel pixel x=791 (RIGHT edge), y=0.
    //   j    = 791
    //   byte = 791 >> 3 = 98, bit = 7 - (791 & 7) = 0    <- the LSB
    // so byte 98 loses its LSB: 0xFF & ~0x01 = 0xFE.
    // Together with the test above this pins the column DIRECTION: if the old
    // X-mirror were reinstated, these two expectations would swap.
    const c = whiteCanvas();
    setPanelPx(c, LW - 1, 0, BLACK);
    const buf = packFrame(c);

    assert.equal(buf[98], 0xfe, 'panel x=791 must clear the LSB of byte 98');
    assert.equal(buf[0], 0xff, 'byte 0 holds the panel-LEFT pixels and must be untouched');
});

test('NO mirror: MSB-first bit order within a byte', () => {
    // Panel x=1 -> j=1 -> byte 0, bit 7-1=6 -> 0xFF & ~0x40 = 0xBF.
    // If the packer were LSB-first this would be 0xFD.
    const c = whiteCanvas();
    setPanelPx(c, 1, 0, BLACK);
    assert.equal(packFrame(c)[0], 0xbf);
});

test('row stride: row N starts at byte N*99', () => {
    const c = whiteCanvas();
    setPanelPx(c, 0, 1, BLACK); // panel-left pixel of the SECOND row
    const buf = packFrame(c);

    assert.equal(buf[1 * ROW_BYTES], 0x7f, 'row 1 byte 0 must carry the pixel');
    for (let i = 0; i < ROW_BYTES; i++) {
        assert.equal(buf[i], 0xff, `row 0 byte ${i} must be untouched`);
    }

    // ...and the very last pixel of the buffer, to prove nothing overflows.
    const last = whiteCanvas();
    setPanelPx(last, LW - 1, LH - 1, BLACK);
    const lastBuf = packFrame(last);
    assert.equal(lastBuf[FRAME_BYTES - 1], 0xfe, 'panel (791,527) must be the final byte');
});

test('bitIndexForColumn is the identity by default and the flip under --mirror', () => {
    for (const x of [0, 1, 7, 8, 395, 790, LW - 1]) {
        assert.equal(bitIndexForColumn(x, false), x, `straight: j must equal x (${x})`);
        assert.equal(bitIndexForColumn(x, true), LW - 1 - x, `mirror: j must be 791 - x (${x})`);
    }
});

// ---------------------------------------------------------------------------
// The generator's own self-checks, run here too
// ---------------------------------------------------------------------------

test("make_test_frame's generate-time self-checks pass", () => {
    // These are what guard `node scripts/make_test_frame.mjs`; running them from
    // the suite means a broken packer fails CI, not only a manual regeneration.
    assert.doesNotThrow(() => assertNoMirror(), 'default packing must not mirror');
    assert.doesNotThrow(() => assertMirroredLegacy(), '--mirror must still mirror');
});

// ---------------------------------------------------------------------------
// LEGACY --mirror: kept working, and provably NOT the default
// ---------------------------------------------------------------------------

test('--mirror reproduces the old, wrong packing exactly', () => {
    // Panel x=0 under the legacy mirror: j = 791 -> byte 98, LSB -> 0xFE.
    const left = whiteCanvas();
    setPanelPx(left, 0, 0, BLACK);
    const mirrored = packFrame(left, { mirror: true });
    assert.equal(mirrored[98], 0xfe, 'legacy: panel x=0 lands in byte 98');
    assert.equal(mirrored[0], 0xff, 'legacy: byte 0 must be untouched');

    // ...and it is genuinely a different frame from the default packing.
    assert.notDeepEqual(mirrored, packFrame(left), 'mirror must differ from straight');
});

test('mirrored and straight packings of the same row are byte-reversed', () => {
    // Structural, not example-based: reversing the 99 bytes of a row and the bits
    // within each byte turns one packing into the other, for ANY row content.
    const c = makeCanvas(LW, LH);
    let seed = 0x9e3779b9;
    for (let x = 0; x < LW; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        c.data[x] = (seed >>> 16) & 1 ? WHITE : BLACK;
    }
    const straight = packFrame(c);
    const mirrored = packFrame(c, { mirror: true });

    const reverseBits = (b) => {
        let out = 0;
        for (let i = 0; i < 8; i++) out |= ((b >> i) & 1) << (7 - i);
        return out;
    };
    for (let i = 0; i < ROW_BYTES; i++) {
        assert.equal(
            mirrored[i],
            reverseBits(straight[ROW_BYTES - 1 - i]),
            `row 0 byte ${i} must be the bit-reverse of straight byte ${ROW_BYTES - 1 - i}`
        );
    }
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('packFrame/unpackFrame round-trip on a pseudo-random canvas', () => {
    const c = makeCanvas(LW, LH);
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x2545f491;
    for (let i = 0; i < c.data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        c.data[i] = (seed >>> 16) & 1 ? WHITE : BLACK;
    }
    for (const mirror of [false, true]) {
        const back = unpackFrame(packFrame(c, { mirror }), { mirror });
        assert.deepEqual(
            Buffer.from(back.data),
            Buffer.from(c.data),
            `round trip must hold with mirror=${mirror}`
        );
    }

    // Mismatched options must NOT round-trip — otherwise the flag would be inert
    // and a mirrored frame could be decoded straight without anyone noticing.
    const crossed = unpackFrame(packFrame(c, { mirror: true }), { mirror: false });
    assert.notDeepEqual(Buffer.from(crossed.data), Buffer.from(c.data));
});

// ---------------------------------------------------------------------------
// Rotation maps — the four corner cases from the module header, both directions
// ---------------------------------------------------------------------------

/** Portrait probe canvas with each corner uniquely tagged. */
function cornerProbe() {
    const p = makeCanvas(PW, PH);
    p.data[0 * PW + 0] = 10;                    // portrait TL
    p.data[0 * PW + (PW - 1)] = 11;             // portrait TR
    p.data[(PH - 1) * PW + 0] = 12;             // portrait BL
    p.data[(PH - 1) * PW + (PW - 1)] = 13;      // portrait BR
    return p;
}

test('90 deg CW map sends portrait TOP edge to landscape RIGHT edge', () => {
    const cw = landscapeFromPortraitCW(cornerProbe());
    const at = (x, y) => cw.data[y * LW + x];

    assert.equal(at(LW - 1, 0), 10, 'portrait TL -> landscape TOP-RIGHT');
    assert.equal(at(LW - 1, LH - 1), 11, 'portrait TR -> landscape BOTTOM-RIGHT');
    assert.equal(at(0, 0), 12, 'portrait BL -> landscape TOP-LEFT');
    assert.equal(at(0, LH - 1), 13, 'portrait BR -> landscape BOTTOM-LEFT');
});

test('90 deg CCW map sends portrait TOP edge to landscape LEFT edge', () => {
    const ccw = landscapeFromPortraitCCW(cornerProbe());
    const at = (x, y) => ccw.data[y * LW + x];

    assert.equal(at(0, LH - 1), 10, 'portrait TL -> landscape BOTTOM-LEFT');
    assert.equal(at(0, 0), 11, 'portrait TR -> landscape TOP-LEFT');
    assert.equal(at(LW - 1, LH - 1), 12, 'portrait BL -> landscape BOTTOM-RIGHT');
    assert.equal(at(LW - 1, 0), 13, 'portrait BR -> landscape TOP-RIGHT');
});

test('CW and CCW are genuinely opposite rotations, not the same map', () => {
    const probe = cornerProbe();
    const cw = landscapeFromPortraitCW(probe);
    const ccw = landscapeFromPortraitCCW(probe);
    assert.notDeepEqual(Buffer.from(cw.data), Buffer.from(ccw.data));
});

test('rotation maps are bijections: every landscape pixel is written exactly once', () => {
    // Tag every portrait pixel with a value derived from its index, then confirm
    // the landscape buffer is a permutation of the portrait buffer (no holes, no
    // double-writes, no interpolation).
    for (const [label, mapFn] of [['CW', landscapeFromPortraitCW], ['CCW', landscapeFromPortraitCCW]]) {
        const p = makeCanvas(PW, PH);
        for (let i = 0; i < p.data.length; i++) p.data[i] = i % 251; // prime -> no aliasing with PW/PH
        const l = mapFn(p);

        assert.equal(l.w, LW, `${label} width`);
        assert.equal(l.h, LH, `${label} height`);
        assert.equal(l.data.length, p.data.length, `${label} pixel count`);

        const histoSrc = new Uint32Array(251);
        const histoDst = new Uint32Array(251);
        for (let i = 0; i < p.data.length; i++) histoSrc[p.data[i]]++;
        for (let i = 0; i < l.data.length; i++) histoDst[l.data[i]]++;
        assert.deepEqual(histoDst, histoSrc, `${label} must be a permutation of the source`);
    }
});

test('rotation maps reject a canvas of the wrong shape', () => {
    assert.throws(() => landscapeFromPortraitCW(makeCanvas(LW, LH)), /528x792/);
    assert.throws(() => landscapeFromPortraitCCW(makeCanvas(LW, LH)), /528x792/);
});

// ---------------------------------------------------------------------------
// The three shipped variants
// ---------------------------------------------------------------------------

test('every A/B/C variant builds to a byte-exact 52272-byte frame', () => {
    assert.equal(VARIANTS.length, 3);
    assert.deepEqual(VARIANTS.map((v) => v.id), ['A', 'B', 'C']);

    for (const v of VARIANTS) {
        const canvas = v.build();
        assert.equal(canvas.w, LW, `${v.file} width`);
        assert.equal(canvas.h, LH, `${v.file} height`);

        const buf = packFrame(canvas);
        assert.equal(buf.length, FRAME_BYTES, `${v.file} must be exactly ${FRAME_BYTES} bytes`);

        // pack/unpack must not lose a single pixel of the artwork.
        const back = unpackFrame(buf);
        assert.deepEqual(Buffer.from(back.data), Buffer.from(canvas.data), `${v.file} round-trip`);

        // The pattern must actually contain ink; an all-white frame would pass
        // every geometry assertion above while being useless on the panel.
        const ink = canvas.data.reduce((n, px) => n + (px === BLACK ? 1 : 0), 0);
        assert.ok(ink > 1000, `${v.file} should contain real artwork (got ${ink} black px)`);
    }
});

test('the three variants are mutually distinct frames', () => {
    const [a, b, c] = VARIANTS.map((v) => packFrame(v.build()));
    assert.notDeepEqual(a, b, 'A and B must differ');
    assert.notDeepEqual(b, c, 'B and C must differ');
    assert.notDeepEqual(a, c, 'A and C must differ');
});

test('generation is deterministic (same bytes every run)', () => {
    for (const v of VARIANTS) {
        assert.deepEqual(packFrame(v.build()), packFrame(v.build()), `${v.file} must be reproducible`);
    }
});
