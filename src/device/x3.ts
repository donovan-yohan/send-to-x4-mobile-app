/**
 * Xteink X3 device geometry — the single source of truth for the love-note
 * frame contract.
 *
 * ---------------------------------------------------------------------------
 * DEVICE CONTRACT (verified on hardware — see HANDOFF.md, docs/xteink/)
 * ---------------------------------------------------------------------------
 *   Panel      : 792 x 528, LANDSCAPE, 1 bit per pixel.
 *   File       : /.love-notes/current.frame — EXACTLY 52272 bytes, raw, NO header.
 *   Layout     : 528 rows x 99 bytes/row  (528 * 99 = 52272).
 *   Bit order  : MSB-first within a byte. Stored bit index j runs 0..791 across
 *                a row; j = 0 is bit 7 (the MSB) of byte 0.
 *                  byteOffset = row * ROW_BYTES + (j >> 3)
 *                  bitInByte  = 7 - (j & 7)
 *   Polarity   : bit 1 = WHITE, bit 0 = BLACK.
 *   NO MIRROR  : columns are packed LEFT-TO-RIGHT. Stored bit j IS panel pixel
 *                x = j (x = 0 is panel-LEFT, and it is the MSB of byte 0).
 *   Row order  : row 0 is panel-TOP.
 *
 * PROVEN ON HARDWARE 2026-07-28 (physical X3, current CrossPoint fork build):
 * the firmware raw-blits the frame with NO horizontal flip. Frames packed with
 * the earlier `j = 791 - x` mirror rendered MIRRORED on the panel; re-packed
 * straight, they rendered correct. Any older doc or comment claiming this panel
 * is X-mirrored is stale.
 *
 * The app COMPOSES in PORTRAIT (528 wide x 792 tall) by DEFAULT because that is
 * how the reader is held for a note. Mapping the portrait canvas into the
 * landscape buffer is a 90-degree rotation; the direction is COUNTER-CLOCKWISE,
 * also proven on hardware the same day (see FrameRotation below).
 *
 * A note can also be composed LANDSCAPE (792 wide x 528 tall), for a reader
 * turned sideways. That canvas IS the panel buffer, so its mapping is the
 * IDENTITY — rotation 'none'. See NoteOrientation / composeDimsFor below.
 *
 * Nothing in this module imports React Native — it is plain data so the packers
 * and their node tests can both consume it.
 *
 * NOTE: `love_note_sender.ts` re-declares the byte count as
 * `LOVE_NOTE_FRAME_BYTES` for its own guard. That file is an M1 artifact and is
 * deliberately left alone; the two literals must stay equal. If one changes,
 * change both.
 */

/**
 * PORTRAIT compose-canvas width, in pixels. Portrait compose space is 528 x 792.
 *
 * NOTE: this is the PORTRAIT canvas specifically, not "the compose canvas".
 * A landscape note composes at PANEL_W x PANEL_H instead — ask
 * {@link composeDimsFor}, never these two constants, when the orientation is a
 * variable.
 */
export const COMPOSE_W = 528;

/** Portrait compose-canvas height, in pixels. */
export const COMPOSE_H = 792;

/** Landscape panel width, in pixels (bits per stored row). */
export const PANEL_W = 792;

/** Landscape panel height, in pixels (== number of stored rows). */
export const PANEL_H = 528;

/** Bytes per stored row. 792 bits / 8 = 99, with no slack bits. */
export const ROW_BYTES = 99;

/** Exact on-device frame size. 528 rows * 99 bytes = 52272. */
export const X3_FRAME_BYTES = 52272;

/**
 * Whether the packer mirrors the X axis. FALSE on this hardware: stored bit j
 * carries panel pixel x = j, packed left-to-right.
 *
 * LOAD-BEARING, not decorative: `frame_encoder.packLandscape` reads this to
 * choose `j = x` over the legacy `j = 791 - x`, so the constant genuinely
 * governs the emitted bytes. It is a compile-time constant, so the branch is
 * free — but flipping it is a DIAGNOSTIC act, not a supported mode: it changes
 * the frames the app sends and turns `frame-encoder.test.js`'s hand-computed
 * byte/bit assertions red, which is the intended alarm. To produce a mirrored
 * frame on purpose, use `scripts/make_test_frame.mjs --mirror` instead — that is
 * the reference packer this one is cross-validated against byte-for-byte.
 *
 * HARDWARE-PROVEN 2026-07-28: mirrored frames rendered backwards on the panel;
 * straight frames rendered correct.
 */
export const X_MIRROR = false;

/**
 * Direction of the portrait -> landscape rotation.
 *
 *   'ccw' (90 deg COUNTER-CLOCKWISE) forward: lx = py,       ly = 527 - px
 *                                    inverse: py = lx,       px = 527 - ly
 *         portrait TOP edge  -> landscape LEFT edge
 *         *** THE UPRIGHT MAPPING ON THIS HARDWARE ***
 *
 *   'cw'  (90 deg CLOCKWISE)         forward: lx = 791 - py, ly = px
 *                                    inverse: px = ly,       py = 791 - lx
 *         portrait TOP edge  -> landscape RIGHT edge
 *         Renders exactly 180 degrees off; kept selectable for diagnosis.
 *
 *   'none' (NO rotation)            forward: lx = cx,        ly = cy
 *         The canvas is ALREADY the 792x528 landscape panel buffer, so the map
 *         is the identity. This is exactly how `make_test_frame.mjs` variant A
 *         is built, and variant A is the frame that PROVED the panel is not
 *         X-mirrored — i.e. the identity path is hardware-validated too.
 *         Used by LANDSCAPE-composed notes (see NoteOrientation).
 *
 * HARDWARE-PROVEN 2026-07-28: the 'cw' frame rendered upside-down on the panel,
 * and the generator's own invariant CW(src) == rot180(CCW(src)) makes 'ccw' the
 * upright direction. This stays a single switchable parameter with one default,
 * so the direction is a one-line change in one place rather than a
 * re-derivation across the codebase.
 *
 * THE ROTATION FIXES THE ACCEPTED CANVAS SIZE, and `encodeFrame` enforces it:
 * 'cw'/'ccw' require 528x792, 'none' requires 792x528. There is no rotation that
 * accepts both, which is what stops an orientation toggle from ever shipping a
 * sideways frame.
 */
export type FrameRotation = 'cw' | 'ccw' | 'none';

/**
 * Default rotation FOR A PORTRAIT-COMPOSED NOTE. 'ccw' — proven upright on
 * hardware 2026-07-28. Landscape notes use 'none'; ask
 * {@link rotationForOrientation} rather than this constant when the orientation
 * is a variable.
 */
export const DEFAULT_FRAME_ROTATION: FrameRotation = 'ccw';

// ---------------------------------------------------------------------------
// Note orientation (the user-facing choice; rotation is its consequence)
// ---------------------------------------------------------------------------

/**
 * How the user authored the note — i.e. how they expect the recipient to be
 * holding the reader when it appears.
 *
 *   'portrait'  528 x 792 compose canvas, mapped in with a 90 deg CCW rotation.
 *               The default: it is how a book is held.
 *   'landscape' 792 x 528 compose canvas, which IS the panel buffer, mapped in
 *               with the identity ('none'). Full panel width; the reader is
 *               turned sideways.
 *
 * ONE choice drives four things — the compose canvas size, the encoder's
 * rotation, the on-screen preview aspect, and the crop/letterbox arithmetic —
 * so it is expressed once here and derived everywhere else via
 * {@link composeDimsFor} / {@link rotationForOrientation}. Nothing downstream
 * should branch on the orientation string itself.
 */
export type NoteOrientation = 'portrait' | 'landscape';

/** Every orientation, in UI order. Handy for a segmented control. */
export const NOTE_ORIENTATIONS: readonly NoteOrientation[] = ['portrait', 'landscape'];

/** Default orientation. Portrait — how the reader is normally held. */
export const DEFAULT_NOTE_ORIENTATION: NoteOrientation = 'portrait';

/**
 * Narrowing guard, for values that came from OUTSIDE the type system —
 * persisted settings, a share intent, JSON. `composeDimsFor` throws on anything
 * else by design, so sanitize at the boundary with this instead of letting a
 * stale stored string blow up the encode path.
 *
 * NO APP CALLER TODAY (only `scripts/frame-encoder.test.js`, which pins its
 * behaviour), and that is the correct state, not an oversight: the
 * orientation is component state that starts at {@link DEFAULT_NOTE_ORIENTATION}
 * on every mount, so no untyped value can reach `composeDimsFor` yet. The first
 * thing that PERSISTS the toggle (settings, a history row, a share payload) is
 * the first thing that must call this — on the way IN, before the string is
 * treated as a NoteOrientation.
 */
export function isNoteOrientation(value: unknown): value is NoteOrientation {
    return value === 'portrait' || value === 'landscape';
}

/**
 * Compose-canvas size for an orientation. THE ONE PLACE that knows a landscape
 * note is authored at panel size.
 *
 * Returns a fresh object each call so a caller cannot mutate the geometry other
 * callers depend on.
 *
 * THROWS on an unrecognized orientation rather than defaulting to portrait: a
 * typo'd or stale string silently producing a portrait canvas is precisely the
 * bug that renders sideways on the panel with nothing in the logs.
 */
export function composeDimsFor(orientation: NoteOrientation): { width: number; height: number } {
    if (orientation === 'portrait') return { width: COMPOSE_W, height: COMPOSE_H };
    if (orientation === 'landscape') return { width: PANEL_W, height: PANEL_H };
    throw new Error(`unknown note orientation: ${String(orientation)}`);
}

/**
 * The rotation that maps an orientation's compose canvas into the panel buffer.
 *
 * Portrait defers to {@link DEFAULT_FRAME_ROTATION} so the hardware-proven
 * direction stays a single-point change; landscape is the identity, because its
 * canvas already IS the panel buffer.
 */
export function rotationForOrientation(orientation: NoteOrientation): FrameRotation {
    if (orientation === 'portrait') return DEFAULT_FRAME_ROTATION;
    if (orientation === 'landscape') return 'none';
    throw new Error(`unknown note orientation: ${String(orientation)}`);
}
