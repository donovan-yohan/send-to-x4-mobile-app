/**
 * frame_content — "is there anything on this frame?", the one question the
 * packers deliberately do not answer.
 *
 * `encodeFrame` validates GEOMETRY: a 528x792 canvas in, exactly 52272 bytes
 * out. It has no opinion about what those bytes depict, and it is right not to
 * — an all-white frame is a perfectly valid frame.
 *
 * The send path needs the other question. A love-note is an OVERLAY the reader
 * has to physically dismiss to get back to their book, so uploading a blank one
 * is not a no-op: it takes the panel away from them and gives them nothing. The
 * canvas modes make that easy to do by accident, because a freshly mounted
 * composer is a source (it can capture) long before it is a note (it has
 * anything on it).
 *
 * PURE TypeScript. No React Native imports, no I/O, no npm imports — same
 * discipline as the packers, so `scripts/frame-content.test.js` can pin the
 * polarity assumption below against the real `encodeFrame` under node.
 */

/**
 * A byte with every bit set is eight WHITE pixels.
 *
 * From the device contract in `src/device/x3.ts`: bit 1 = WHITE, 0 = BLACK, and
 * a row is 792 bits packed into exactly 99 bytes — no slack bits, so there is no
 * padding that could be white-but-unused and no mask is needed. The
 * compose->landscape mapping and the column order are both permutations of the
 * bits, so neither can change whether they are ALL set — which is why this check
 * is safe to run on the packed frame without undoing either.
 *
 * That holds for EVERY mapping, so this file needs no notion of orientation: a
 * landscape-composed note maps in with the identity ('none'), which is the
 * trivial permutation, and a portrait one with a 90-degree rotation.
 */
const WHITE_BYTE = 0xff;

/**
 * True when every pixel in the frame is white — i.e. the reader would be shown
 * an empty overlay.
 *
 * An empty buffer counts as blank: there is nothing in it to display. Length is
 * otherwise not checked, because that is `sendLoveNoteFrame`'s job and it fails
 * with a far more specific message than this function could.
 */
export function isBlankFrame(frame: Uint8Array): boolean {
    for (let i = 0; i < frame.length; i++) {
        if (frame[i] !== WHITE_BYTE) return false;
    }
    return true;
}
