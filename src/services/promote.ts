/**
 * promote — a history row -> PERMANENT sleep-screen art on the reader.
 *
 * ---------------------------------------------------------------------------
 * TWO FILES, TWO CONTRACTS — DO NOT MIX THEM UP
 * ---------------------------------------------------------------------------
 * A love note is `/.love-notes/current.frame`: exactly 52272 bytes of raw 1-bit,
 * rotated 90 degrees into the landscape panel buffer, and TEMPORARY (dismiss
 * returns the reader to its book). That path belongs to `love_note_sender.ts`
 * and nothing here touches it.
 *
 * A wallpaper is an 8-bit grayscale BMP, upright and unrotated (the firmware's
 * `drawBitmap` is orientation-aware, so it needs none of the love-note path's
 * geometry), and PERMANENT. `wallpaper_sender.ts` owns both of its
 * destinations; this module only picks one of them.
 *
 * NEITHER path mirrors the X axis — proven on hardware 2026-07-28; see
 * `src/device/x3.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A RE-DERIVATION, NOT A COPY
 * ---------------------------------------------------------------------------
 * A history row keeps the note as it was SENT: a dithered, panel-rotated 1-bit
 * frame (long gone — the device only ever held one, temporarily) and a ~64 px
 * base64 PNG thumbnail for the list. Neither can become a wallpaper.
 *
 * So promotion goes back to `record.sourceUri` — the original picture for a
 * photo note, or the canvas capture Compose persisted for a text/doodle note —
 * and re-runs the wallpaper pipeline from scratch.
 *
 * ---------------------------------------------------------------------------
 * FRAMING DEPENDS ON THE KIND, BECAUSE THE SOURCE SHAPES DIFFER
 * ---------------------------------------------------------------------------
 * A PHOTO note's source is the user's own picture, of unknown aspect. It keeps
 * `prepareWallpaperBmp`'s 'natural' framing: the whole picture at ~2x panel
 * resolution, and the firmware's own sleep-cover setting does the final
 * scale/crop. Pre-framing there would throw away pixels the firmware may want.
 *
 * A TEXT or DOODLE note's source is something else entirely: ComposeScreen's
 * capture of the compose canvas AT THE ORIENTATION THE NOTE WAS AUTHORED IN —
 * 528 x 792 for a portrait note, 792 x 528 for a landscape one (see
 * `composeDimsFor` in src/device/x3.ts). Handing that to 'natural' leaves the
 * final crop to a firmware rule this app cannot see or preview, so a promoted
 * note would not look like the note the user promoted, with no read-back to say
 * so. Those rows are framed to the sleep screen's box with `fit: 'fit'` instead:
 * the WHOLE note survives, decided here rather than guessed at by the firmware.
 *
 * WHICH BOX? THE PORTRAIT ONE. The sleep screen renders at 528 x 792 —
 * `SleepActivity.cpp:36` forces `GfxRenderer::Orientation::Portrait` — so
 * `framing: 'panel'` targets COMPOSE_W:COMPOSE_H, not the love-note frame's
 * landscape 792x528. A PORTRAIT note therefore promotes edge to edge, which is
 * the common case and used to be the broken one.
 *
 * KNOWN LIMIT — LANDSCAPE NOTES ONLY: 'fit' letterboxes a landscape capture into
 * the portrait box, so it lands as a centred horizontal strip on white. Rotating
 * the capture 90 degrees first (as `frame_encoder.rotateToLandscape` does for the
 * love-note frame) would fill the screen for that case too, but the wallpaper
 * pipeline has no rotation option today — adding one means widening
 * `prepareWallpaperBmp`, not working around it here.
 *
 * That makes ONE failure mode worth designing for: a row whose source no longer
 * resolves — a photo deleted from the gallery, a cache capture the OS
 * reclaimed, or a text note that never had a picture. `sourceUri` is optional on
 * `MessageRecord` precisely because of this, so "no usable source" is an
 * ordinary answer here, returned as `{ ok: false, error }` and never thrown.
 *
 * ---------------------------------------------------------------------------
 * ROTATION, NOT PIN
 * ---------------------------------------------------------------------------
 * Promoting ADDS to `/.sleep`, never to `/sleep.bmp`. The point of the feature
 * is "my favourite notes become the cycling lock screen"; writing the
 * single-slot file would silently replace whatever the host deliberately
 * pinned. Pinning stays an explicit, separate action —
 * `sendWallpaperBmp(ip, bmp, { kind: 'primary' })`.
 *
 * The filename comes from `sleepSetNameForId(record.id)`, which is
 * DETERMINISTIC and collision-safe, so promoting the same row twice replaces
 * its own entry instead of stacking near-duplicates into a rotation the
 * firmware picks from at random.
 *
 * REPLACE = DETERMINISTIC NAME **+ DELETE-BEFORE-UPLOAD**. The determinism alone
 * does not buy the replace: the firmware refuses to overwrite an existing path
 * (`ERROR: File already exists`, proven on hardware 2026-07-28), so a
 * `sendWallpaperBmp` that did not delete first would turn the very determinism
 * described above into a hard FAILURE on the second promote of a row — reported
 * to the user as "promote failed" for a note that is already in the rotation.
 * The delete lives in `wallpaper_sender.sendWallpaperBmp`, and
 * `wallpaper-sender.test.js` promotes the same record twice against a transport
 * that enforces the firmware's exists-rejection, so this paragraph cannot drift
 * back into fiction without a red test.
 *
 * ---------------------------------------------------------------------------
 * SEAMS
 * ---------------------------------------------------------------------------
 * `image_converter` pulls in expo-image-manipulator and react-native, which
 * esbuild/tsx cannot parse, so it is reached through the same lazy-`require`
 * seam `message_history` and `wallpaper_sender` use. `wallpaper_sender` is
 * imported normally — it is node-safe, and going through the real thing is what
 * keeps naming and the `/.sleep` path mapping under test on this path too.
 *
 * NEVER THROWS. History rows render in a list; one unhandled rejection would
 * take the whole tab down.
 */

import type { MessageRecord } from './message_history';
import { sendWallpaperBmp, sleepSetNameForId } from './wallpaper_sender';

/**
 * Discriminated, because success carries something the caller needs — the
 * device-side filename, which is what a later `deleteSleepSetEntry` or a
 * `/.sleep` listing matches on, and which is meaningless on the failure branch.
 *
 * TWO DISCRIMINANTS, DELIBERATELY. `ok` is this module's own; `success` mirrors
 * it exactly so a promote result can be handled by the same
 * `if (r.success) … else r.error` shape as `sendWallpaperBmp`,
 * `sendLoveNoteFrame` and every other sender in this repo. They can never
 * disagree — nothing constructs a `PromoteResult` outside this file, and the
 * union makes a mismatched pair unrepresentable rather than merely discouraged.
 */
export type PromoteResult =
    | { ok: true; success: true; name: string }
    | { ok: false; success: false; error: string };

/**
 * The slice of `image_converter.PrepareWallpaperOptions` this module sets.
 *
 * Structural and deliberately narrow: promotion chooses the OUTPUT SHAPE and
 * nothing else. Autocontrast, alpha flattening and the long side stay at the
 * encoder's own defaults, which the Wallpaper tab also uses.
 */
export interface WallpaperPrepareOptions {
    /**
     * 'natural' keeps the source aspect; 'panel' pre-frames to the sleep
     * screen's 528x792 PORTRAIT box.
     */
    framing: 'natural' | 'panel';
    /** Only consulted for 'panel' framing. 'fit' letterboxes, 'cover' crops. */
    fit?: 'cover' | 'fit';
    /**
     * Skip the panel-true preview render. Promotion uploads bytes and shows no
     * preview, so paying for a full Atkinson dither pass here would be pure
     * waste. Set by {@link promoteRecordToWallpaper}, never by
     * {@link wallpaperOptionsForRecord} — that function answers "how is this row
     * framed", which is a different question and one a test pins exactly.
     */
    panelPreview?: boolean;
}

/**
 * The slice of `image_converter.prepareWallpaperBmp` this module needs.
 * Structural, so there is no top-level react-native dependency.
 */
export type WallpaperPrepare = (
    imageUri: string,
    opts: WallpaperPrepareOptions
) => Promise<{ bmp: Uint8Array }>;

/**
 * How this row's source should be framed for the panel.
 *
 * Exported because it is the whole of the decision described in the header, it
 * is pure, and it is the one thing on this path a test can pin without a device
 * (see `scripts/wallpaper-sender.test.js`).
 */
export function wallpaperOptionsForRecord(
    record: Pick<MessageRecord, 'kind'> | null | undefined
): WallpaperPrepareOptions {
    // Anything that is not a photo came off the compose canvas, in one of its
    // two orientations — 'panel' + 'fit' is right for both (it exactly fills the
    // PORTRAIT sleep screen with a portrait capture and letterboxes a landscape
    // one), which is why the record needs to carry no orientation here.
    // message_history coerces an unreadable kind to 'photo', so this is a total
    // function over what the store can actually hold.
    return record?.kind === 'photo'
        ? { framing: 'natural' }
        : { framing: 'panel', fit: 'fit' };
}

/**
 * Can this row be promoted at all?
 *
 * Cheap and synchronous on purpose: a History list renders every row's action
 * buttons before any of them is pressed, and this is the check that decides
 * whether "Make wallpaper" is offered or disabled.
 */
export function canPromoteRecord(record: MessageRecord | null | undefined): boolean {
    return typeof record?.sourceUri === 'string' && record.sourceUri.trim().length > 0;
}

// See message_history.ts for why this declaration is safe under both Metro and
// node: Metro collects `require('<literal>')` statically, and node simply has
// no such binding — `typeof` on an undeclared name does not throw.
declare const require: ((id: string) => unknown) | undefined;

let prepare: WallpaperPrepare | null = null;
let prepareResolved = false;

/**
 * Replace the BMP encoder. Pass `null` to restore the image_converter default.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setWallpaperPrepare(next: WallpaperPrepare | null): void {
    prepare = next;
    prepareResolved = next !== null;
}

function getPrepare(): WallpaperPrepare | null {
    if (!prepareResolved) {
        prepare = loadImageConverter();
        prepareResolved = true;
    }
    return prepare;
}

function loadImageConverter(): WallpaperPrepare | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('./image_converter') as { prepareWallpaperBmp?: unknown };
        if (mod && typeof mod.prepareWallpaperBmp === 'function') {
            const fn = mod.prepareWallpaperBmp as (
                uri: string,
                opts: WallpaperPrepareOptions
            ) => Promise<{ bmp: Uint8Array }>;
            return (imageUri: string, opts: WallpaperPrepareOptions) => fn(imageUri, opts);
        }
    } catch {
        // Not a React Native runtime (node test, web preview).
    }
    return null;
}

/**
 * Re-encode a history row's source picture and add it to the `/.sleep` rotation.
 *
 * NOTE: `{ ok: true }` means the bytes landed. It does NOT mean the user will
 * see the picture — the reader's sleep mode still has to be CUSTOM, which no
 * remote API can set today. Pair this with `SLEEP_MODE_HINT` in the UI.
 *
 * @param ip         Reader host (settings.crossPointIp — normalised downstream).
 * @param record     The history row being promoted.
 * @param onProgress 0-100 upload progress, forwarded from the WS transport.
 */
export async function promoteRecordToWallpaper(
    ip: string,
    record: MessageRecord,
    onProgress?: (percent: number) => void
): Promise<PromoteResult> {
    if (!record || typeof record !== 'object') {
        return { ok: false, success: false, error: 'No message selected.' };
    }

    if (!canPromoteRecord(record)) {
        // Expected, not exceptional: text-only notes never had a picture, and an
        // old row's capture may have been reclaimed. The stored thumbnail is a
        // ~64 px preview and cannot stand in for one.
        return {
            ok: false,
            success: false,
            error: 'This note has no saved picture, so there is nothing to promote.',
        };
    }
    const sourceUri = (record.sourceUri as string).trim();

    const name = sleepSetNameForId(record.id);
    if (!name) {
        return { ok: false, success: false, error: 'Could not build a device filename for this note.' };
    }

    const encode = getPrepare();
    if (!encode) {
        return { ok: false, success: false, error: 'Image encoding is unavailable in this runtime.' };
    }

    let bmp: Uint8Array;
    try {
        // The only throwing call on this path: decoding a file that may have
        // been evicted from the OS cache since the note was sent.
        //
        // The options are NOT optional here: a canvas note framed 'natural'
        // leaves the crop to a firmware rule this app cannot preview. See the
        // header.
        const prepared = await encode(sourceUri, {
            ...wallpaperOptionsForRecord(record),
            panelPreview: false,
        });
        if (!prepared || !prepared.bmp || prepared.bmp.byteLength === 0) {
            return {
                ok: false,
                success: false,
                error: 'This note\'s picture could not be re-encoded.',
            };
        }
        bmp = prepared.bmp;
    } catch (error) {
        console.warn('[Promote] Could not encode wallpaper:', error);
        return {
            ok: false,
            success: false,
            error: `Could not read this note's picture: ${describeError(error)}`,
        };
    }

    const result = await sendWallpaperBmp(ip, bmp, { kind: 'set', name }, onProgress);
    if (!result.success) {
        return { ok: false, success: false, error: result.error || 'Wallpaper upload failed.' };
    }

    return { ok: true, success: true, name };
}

function describeError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return 'unknown error';
}
