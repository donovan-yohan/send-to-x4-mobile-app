/**
 * love_note_sender — get a pre-encoded love-note frame onto the reader, by
 * whichever route the current setup actually has.
 *
 * TWO ROUTES, ONE ENTRY POINT:
 *
 *   DIRECT  ({@link sendLoveNoteFrame}) — the phone pushes the frame straight
 *           onto the reader's SD card at `/.love-notes/current.frame`, followed
 *           by its id sidecar `/.love-notes/current.id`, over the existing
 *           CrossPoint transport (mkdir over HTTP + chunked WebSocket upload).
 *           Instant, but it needs the reader AWAKE and on the same network as
 *           the phone.
 *
 *   MAILBOX ({@link mailbox_client.publishLoveNote}) — the phone leaves the
 *           frame in a mailbox the reader polls for itself at deep-sleep entry
 *           (firmware `MessageSync::syncBeforeSleep`), which then renders it at
 *           the next wake. Works from anywhere, arrives later.
 *
 * {@link sendLoveNote} is the orchestration Compose should call: it picks the
 * route from the role, and — for a host — falls back from a reader that did not
 * answer to the mailbox, so a note is not simply lost because the reader was
 * asleep. `sendLoveNoteFrame` stays exactly as it was for callers that mean
 * "the direct path, specifically".
 *
 * ---------------------------------------------------------------------------
 * DELETE BEFORE UPLOAD (DIRECT PATH) — NOT OPTIONAL, PROVEN ON HARDWARE 2026-07-28
 * ---------------------------------------------------------------------------
 * The CrossPoint firmware REFUSES to overwrite an existing path: the WS upload
 * answers `ERROR: File already exists` and writes nothing. Since this path is a
 * single fixed slot that is re-sent on every note, the SECOND note a user ever
 * sends would fail — and fail while the reader still displays the FIRST note,
 * which looks exactly like "the send worked but the picture is wrong".
 *
 * So the delete is part of the write, not a cleanup step, and it has to happen
 * BEFORE the upload. `scripts/send_frame.mjs --self-test` is the original tested
 * reference for this ordering; `scripts/love-note-sender.test.js` (with
 * `scripts/mailbox-client.test.js` for the routing half) pins it here too,
 * through the transport seam below, with a fake device that enforces the same
 * exists-rejection.
 *
 * (Newer firmware builds overwrite on upload, which makes the delete redundant
 * — NOT wrong. It stays, because a user's reader can be on either build and a
 * delete of a file that is about to be replaced costs nothing.)
 *
 * ---------------------------------------------------------------------------
 * THE ID SIDECAR — WHY A DIRECT SEND WRITES TWO FILES
 * ---------------------------------------------------------------------------
 * The frame is only half of what the firmware reads. `MessageSync` keeps a
 * one-line sidecar next to it, `/.love-notes/current.id`
 * (MessageSync.cpp:19 `CURRENT_ID`), and decides whether a note is worth showing
 * by comparing it with the last id it displayed:
 *
 *     bool MessageSync::hasUnreadNote() {            // MessageSync.cpp:114-119
 *       if (!Storage.exists(CURRENT_FRAME)) return false;
 *       const std::string id = readStagedId();
 *       if (id.empty()) return true;  // legacy / id-less frame: show (M1 behaviour)
 *       return id != APP_STATE.messageLastShownId;
 *     }
 *
 * An id-LESS frame therefore reads as "always unread": the reader re-displays it
 * on EVERY wake, forever, because `markCurrentNoteShown` has nothing to record
 * (MessageSync.cpp:121-128 returns early on an empty id). The mailbox route
 * already stages the pair — it downloads the frame, promotes it, and only then
 * writes the id (MessageSync.cpp:190-198) — so a mailbox note is shown once. A
 * direct send that wrote the frame alone was the odd one out, and its notes
 * hijacked the panel at every wake.
 *
 * ORDER IS THE WHOLE CONTRACT, and there are two rules, both taken from the
 * firmware's own staging sequence:
 *
 *   1. FRAME BEFORE ID. `current.id` must never name a note whose frame is not
 *      completely written. Uploading the id first (or in parallel) means a wake
 *      in the gap finds the OLD frame under the NEW id: the reader shows the old
 *      picture and marks the new id as shown, so the note the user actually sent
 *      is deduped away and never appears — from the app's side, a silent success.
 *      A failed frame upload therefore stages NO id at all.
 *   2. BOTH SLOTS ARE CLEARED FIRST, and `current.id` is cleared EVEN WHEN no
 *      new id is staged ({@link SendLoveNoteFrameOptions.stageId} `false`). A
 *      leftover id from the previous note is the same silent-suppression bug from
 *      the other direction: it equals `messageLastShownId`, so `hasUnreadNote`
 *      answers false and the fresh frame under it is never displayed. Deleting
 *      the id first also means no id ever outlives the frame it describes.
 *
 * The bytes are the bare id, ASCII, NO trailing newline — byte-identical to what
 * `Storage.writeFile(CURRENT_ID, String(latestId.c_str()))` (MessageSync.cpp:197)
 * leaves behind on the mailbox route, so both routes stage indistinguishable
 * pairs. A trailing newline WOULD be tolerated (`trimId`, MessageSync.cpp:36-43,
 * pops trailing \n \r space \t), but a LEADING one would not — trimId only strips
 * leading space and tab — so the writer here adds no whitespace at all.
 *
 * Ids come from {@link mintNoteId}, the SAME minter the mailbox publishes under,
 * so History rows carry one kind of id whichever route ran. Exactly one id is
 * minted per send attempt: the direct path mints only after its frame upload has
 * succeeded, which is also the only case in which the mailbox leg never runs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSPORT IS BEHIND A SEAM
 * ---------------------------------------------------------------------------
 * `crosspoint_upload.ts` statically imports `expo-file-system/legacy`, which
 * pulls in `react-native`, which esbuild/tsx cannot parse — a top-level import
 * here would make every test of the routing logic below impossible to write.
 * It is reached through the same lazy-`require` seam `wallpaper_sender.ts` and
 * `message_history.ts` use: identical behaviour in the app (Metro resolves the
 * literal `require` statically), fully drivable under node.
 *
 * NEVER THROWS. Every entry point reports failure in its return value, matching
 * `sendNoteAsTxt` / `sendWallpaperBmp` and every other sender in this repo.
 * Callers written to the repo convention (`const r = await sendLoveNote(...);
 * if (!r.success) ...`) are therefore correct without a try/catch; a mixed
 * throw/return contract would turn a wrong-sized frame into an unhandled
 * rejection (red box in dev, silently swallowed in release) instead of a
 * visible error.
 */

import type { Role, UploadResult } from '../types';
import {
    describeMailboxUrlProblem,
    mintNoteId,
    publishLoveNote,
} from './mailbox_client';
import { enqueueNote, supersedeQueuedNotes } from './outbox';
import { markNoteSuperseded } from './message_history';
import {
    noteReaderUnreachable,
    resolveReaderReachability,
    type ReaderReachability,
    type ReaderReachabilityHint,
    type SendPhase,
} from './reader_reachability';
import { asRole } from './role';

/**
 * Exact size of a love-note frame: 528 rows x 99 bytes/row (792 px, 1 bit/px).
 * The firmware raw-blits the file with no header and no length negotiation,
 * so anything other than this byte count renders garbage. (The mailbox half of
 * the contract enforces the same number as `MAILBOX_FRAME_BYTES`; both derive
 * from `src/device/x3.ts`.)
 */
export const LOVE_NOTE_FRAME_BYTES = 52272;

export const LOVE_NOTES_DIR = '/.love-notes';
export const LOVE_NOTE_FILENAME = 'current.frame';

/**
 * The id sidecar the firmware dedups on: `/.love-notes/current.id`
 * (MessageSync.cpp:19 `CURRENT_ID`). Fixed name, single slot, same
 * delete-before-upload rule as the frame. See the module header.
 */
export const LOVE_NOTE_ID_FILENAME = 'current.id';

// uploadToCrossPoint takes a folder relative to the SD root and builds the
// `/${folder}` target path itself, so hand it the bare (dot-prefixed) segment.
const LOVE_NOTES_FOLDER = LOVE_NOTES_DIR.replace(/^\/+/, '');

/**
 * Hard ceiling on an id, from the reader: `MAX_ID_LEN`
 * (MessageSync.cpp:34), applied by `trimId` (MessageSync.cpp:36-43) as a
 * SILENT `resize()`. A longer id is not rejected, it is truncated — and a
 * truncated id never matches the one the app recorded, so History would
 * permanently disagree with the reader about which note was shown.
 */
export const NOTE_ID_DEVICE_MAX_CHARS = 128;

/**
 * Charset an id may use on this path.
 *
 * `mintNoteId` only ever emits `[0-9a-z-]`, so this is deliberately WIDER than
 * what the app itself produces: it is the gate for an id that came from
 * somewhere else (a CLI flag, a server that rewrote ours), and it matches the
 * key charset the mailbox already round-trips (`scripts/mailbox-dev-server.test.js`).
 *
 * What it EXCLUDES is what matters. Whitespace and control bytes are rejected
 * because `trimId` strips some of them and not others (trailing \n \r space tab,
 * but only leading space and tab), so an id with whitespace in it can compare
 * equal to a DIFFERENT id on the device while comparing unequal here. `/` is
 * rejected because the sidecar is written by filename, not by path.
 */
const NOTE_ID_ALLOWED = /^[A-Za-z0-9._~-]+$/;

/**
 * Why `id` cannot be staged in `current.id`, or null when it can.
 *
 * Checked BEFORE any network call, because a rejected id must not leave the
 * device holding a frame whose sidecar was never written.
 */
export function describeNoteIdProblem(id: string | null | undefined): string | null {
    if (typeof id !== 'string' || !id) return 'Note id is empty.';
    if (id.length > NOTE_ID_DEVICE_MAX_CHARS) {
        return (
            `Note id is ${id.length} characters; the reader truncates at ` +
            `${NOTE_ID_DEVICE_MAX_CHARS} (MessageSync.cpp MAX_ID_LEN), which would ` +
            `stage an id that never matches this one.`
        );
    }
    if (!NOTE_ID_ALLOWED.test(id)) {
        return `Note id must match [A-Za-z0-9._~-] (got "${id}").`;
    }
    return null;
}

/**
 * The exact bytes of the sidecar: the bare id, ASCII, no newline, no padding.
 *
 * `describeNoteIdProblem` has already restricted the id to single-byte ASCII, so
 * a charCode-per-byte copy IS the UTF-8 encoding — no TextEncoder (absent on some
 * RN engines) and no Buffer (absent in the browser preview) required.
 */
export function encodeNoteIdFile(id: string): Uint8Array {
    const bytes = new Uint8Array(id.length);
    for (let i = 0; i < id.length; i++) bytes[i] = id.charCodeAt(i) & 0xff;
    return bytes;
}

/**
 * The one canonical wording for "this phone has no way to deliver a note yet".
 *
 * Single literal so Compose, Settings and History cannot drift apart on the
 * sentence that tells a client what to do about it.
 */
export const MAILBOX_SETUP_HINT = 'Set up mailbox in Settings';

function frameSizeError(frame: Uint8Array | null | undefined): string {
    return (
        `Love-note frame must be exactly ${LOVE_NOTE_FRAME_BYTES} bytes ` +
        `(528 rows x 99 bytes), got ${frame ? frame.byteLength : 0}`
    );
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * The slice of `crosspoint_upload` this module needs.
 *
 * Declared structurally so there is no top-level import of a module that pulls
 * in react-native. See the header.
 */
export interface LoveNoteTransport {
    upload(
        ip: string,
        data: Uint8Array,
        filename: string,
        onProgress: ((percent: number) => void) | undefined,
        targetFolder: string
    ): Promise<UploadResult>;
    deleteFile(ip: string, filename: string, targetFolder: string): Promise<boolean>;
}

// Metro defines `require` in every module and collects `require('<literal>')`
// statically, so the lazy load below is a normal bundle dependency. Under
// node's ESM loader the identifier does not exist — `typeof` on an undeclared
// name is safe, and the module degrades to "no transport" instead of failing to
// import.
declare const require: ((id: string) => unknown) | undefined;

let transport: LoveNoteTransport | null = null;
let transportResolved = false;

/**
 * Replace the transport. Pass `null` to restore the CrossPoint default.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setLoveNoteTransport(next: LoveNoteTransport | null): void {
    transport = next;
    transportResolved = next !== null;
}

function getTransport(): LoveNoteTransport | null {
    if (!transportResolved) {
        transport = loadCrossPointTransport();
        transportResolved = true;
    }
    return transport;
}

function loadCrossPointTransport(): LoveNoteTransport | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('./crosspoint_upload') as {
            uploadToCrossPoint?: unknown;
            deleteCrossPointFile?: unknown;
        };
        if (
            mod &&
            typeof mod.uploadToCrossPoint === 'function' &&
            typeof mod.deleteCrossPointFile === 'function'
        ) {
            const upload = mod.uploadToCrossPoint as LoveNoteTransport['upload'];
            const deleteFile = mod.deleteCrossPointFile as LoveNoteTransport['deleteFile'];
            return {
                upload: (ip, data, filename, onProgress, targetFolder) =>
                    upload(ip, data, filename, onProgress, targetFolder),
                deleteFile: (ip, filename, targetFolder) => deleteFile(ip, filename, targetFolder),
            };
        }
    } catch {
        // Not a React Native runtime (node test, web preview). Handled by callers.
    }
    return null;
}

/**
 * Reported when the CrossPoint transport is not loadable. Worded as a
 * reachability failure on purpose: {@link isDeviceUnreachableError} matches it,
 * so a host whose direct path cannot even start still falls back to the mailbox
 * rather than failing outright.
 */
const NO_TRANSPORT_ERROR = 'Device transport unavailable in this runtime.';

// ---------------------------------------------------------------------------
// Direct path
// ---------------------------------------------------------------------------

/** How a direct send handles the `current.id` sidecar. */
export interface SendLoveNoteFrameOptions {
    /**
     * Id to stage in `current.id`. Default: a freshly {@link mintNoteId}ed one,
     * minted only AFTER the frame upload succeeds (see the module header on why
     * exactly one id exists per send attempt).
     */
    noteId?: string;
    /**
     * `false` reproduces the pre-sidecar behaviour: the frame is written and NO
     * id is staged. Diagnostics only — `current.id` is still DELETED, because
     * leaving the previous note's id behind would suppress this frame entirely.
     *
     * STALE-CLAIM CORRECTION, and it applies to every "on every wake" phrase
     * left in this file (the `idStaged` doc below, the `stageId=false` console
     * line, and the user-facing `idError` sentence). Those describe the ROUND-1
     * firmware, where an id-less frame was always-unread and therefore held the
     * panel on every wake. Under the shipped display-once model
     * (docs/xteink/mailbox-books-contract.md §3A, "Reversion rule") an id-less
     * frame is treated as UNSEEN and gets exactly ONE turn like any other note:
     * `MessageSync::markStagedNoteDisplayed()` mints a `local-{millis}` key into
     * `/.love-notes/current.id` at the moment of the paint, so the turn is
     * consumed and the configured wallpaper returns at the next sleep. A frame
     * whose sidecar upload failed is therefore a cosmetic degradation (History
     * cannot name the id), NOT a note pinned to the panel.
     *
     * The `idError` string is not corrected here because it is asserted by
     * `scripts/love-note-sender.test.js` (`assert.match(result.idError,
     * /every wake/i)`); rewording it is a lockstep copy + test change.
     */
    stageId?: boolean;
}

/** What a direct send did, including the half the firmware dedups on. */
export interface SendLoveNoteFrameResult extends UploadResult {
    /**
     * The id staged in `current.id` — set only when the sidecar actually landed,
     * because History uses it to say which note the reader is showing.
     */
    noteId?: string;
    /**
     * True when frame AND id both landed. False after a frame-only write, which
     * is a DEGRADED success: the note displays, but on every wake.
     */
    idStaged?: boolean;
    /** Why the sidecar did not land, when the frame did. Never fatal. */
    idError?: string;
}

/**
 * Upload an encoded love-note frame to `/.love-notes/current.frame`, plus the
 * `/.love-notes/current.id` sidecar the firmware dedups on.
 *
 * Single-slot semantics for BOTH files: the previous pair is DELETED and this one
 * takes its place (last write wins). The deletes are mandatory on the firmware
 * builds this app supports, and the frame-then-id upload order is mandatory on
 * all of them — see the module header for what each rule prevents.
 *
 * A frame that lands without its id is reported as a SUCCESS with
 * `idStaged: false`: the note is on the reader and will display, and failing the
 * send would both misreport that and (for a host) trigger a mailbox re-delivery
 * of a note the user can already see.
 *
 * NEVER THROWS. Every failure mode — a bad frame size just as much as a dead
 * socket — comes back as `{ success: false, error }`.
 *
 * @param frame  Exactly LOVE_NOTE_FRAME_BYTES of packed 1-bit pixels.
 * @returns      SendLoveNoteFrameResult indicating success or failure.
 */
export async function sendLoveNoteFrame(
    ip: string,
    frame: Uint8Array,
    onProgress?: (percent: number) => void,
    options?: SendLoveNoteFrameOptions
): Promise<SendLoveNoteFrameResult> {
    if (!frame || frame.byteLength !== LOVE_NOTE_FRAME_BYTES) {
        // An encoder bug rather than a transport failure, but still reported as a
        // UploadResult so there is exactly one contract to handle.
        return { success: false, error: frameSizeError(frame) };
    }

    const stageId = options?.stageId !== false;

    // A caller-supplied id is validated BEFORE the network. Finding out that the
    // id is unusable after the frame has been written would leave the reader
    // holding an id-less frame — the exact state this sidecar exists to end.
    const requestedId = options?.noteId;
    if (requestedId !== undefined) {
        const idProblem = describeNoteIdProblem(requestedId);
        if (idProblem !== null) return { success: false, error: idProblem };
    }

    const t = getTransport();
    if (!t) return { success: false, error: NO_TRANSPORT_ERROR };

    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log(`[LoveNoteSender] Sending frame: ${frame.byteLength} bytes, ip=${ip}, path=${LOVE_NOTES_DIR}/${LOVE_NOTE_FILENAME}`);
    }

    // 1. Clear BOTH slots, id first. Older firmware answers 'ERROR: File already
    //    exists' to an upload onto an existing path, so without this every note
    //    after the first one fails on those builds.
    //
    //    ID FIRST, AND UNCONDITIONALLY: from here until the sidecar is written
    //    there is no id on the card at all, so no id can ever describe a frame
    //    other than the one actually stored. The alternative — a leftover id next
    //    to a new frame — makes `hasUnreadNote` answer false (the id still equals
    //    `messageLastShownId`) and the new note is never displayed at all.
    //
    //    A FALSE result is EXPECTED and deliberately ignored: on the very first
    //    send there is no file (and no /.love-notes folder) to delete, and
    //    deleteCrossPointFile reports any non-OK status — including the
    //    firmware's "no such file" — as false. Treating that as fatal would make
    //    the first-ever note the one that cannot be sent. If a file really is
    //    still there afterwards, the upload's own 'File already exists' error is
    //    the accurate, user-visible report; guessing here would only replace a
    //    true message with a vaguer one.
    //
    //    deleteCrossPointFile already swallows its own network errors, but this
    //    function's NEVER-THROWS contract must not depend on that staying true.
    await clearSlot(t, ip, LOVE_NOTE_ID_FILENAME);
    await clearSlot(t, ip, LOVE_NOTE_FILENAME);

    // 2. Creates the .love-notes folder if missing, then streams the frame over WS.
    //
    // M2 FOLLOW-UP (tracked, deliberately not fixed here — crosspoint_upload.ts is
    // shared with the shipping note/screensaver senders and is out of scope for M1):
    // uploadToCrossPoint (crosspoint_upload.ts:187) calls ensureFolderExistsCrossPoint
    // but DISCARDS its boolean, so if /.love-notes genuinely cannot be created the
    // WS upload still runs and the user sees the firmware's raw 'ERROR:<...>' string
    // instead of "could not create /.love-notes on the device".
    // uploadScreensaverToCrossPoint (crosspoint_upload.ts:444-450) shows the checked
    // pattern to copy: either export ensureFolderExistsCrossPoint and gate on it here,
    // or add the missing check at crosspoint_upload.ts:187.
    let frameResult: UploadResult;
    try {
        frameResult = await t.upload(ip, frame, LOVE_NOTE_FILENAME, onProgress, LOVE_NOTES_FOLDER);
    } catch (error) {
        // uploadToCrossPoint resolves rather than rejects today; this keeps the
        // NEVER-THROWS contract independent of that staying true.
        return { success: false, error: `Upload failed: ${String(error)}` };
    }

    // 3. ONLY NOW the sidecar. A frame upload that failed may have written a
    //    partial file, or nothing at all; an id pointing at either is worse than
    //    no id, because the reader would mark it shown while displaying whatever
    //    it has. So a failed frame ends the send with the card holding no id.
    if (!frameResult.success) return frameResult;

    if (!stageId) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(`[LoveNoteSender] stageId=false: no ${LOVE_NOTES_DIR}/${LOVE_NOTE_ID_FILENAME} written; the reader will re-show this note on every wake`);
        }
        return { success: true, idStaged: false };
    }

    // Minted HERE, not up front: this is the one point at which an id is
    // certainly going to be used, which is what keeps "one id per send attempt"
    // true even when the reader was asleep and the mailbox mints its own.
    const noteId = requestedId ?? mintNoteId();

    let idResult: UploadResult;
    try {
        idResult = await t.upload(
            ip,
            encodeNoteIdFile(noteId),
            LOVE_NOTE_ID_FILENAME,
            // No progress for the sidecar: the bar has already reached 100% on the
            // 52 KB frame, and a second 0->100 ramp for 21 bytes reads as a stall.
            undefined,
            LOVE_NOTES_FOLDER
        );
    } catch (error) {
        idResult = { success: false, error: String(error) };
    }

    if (!idResult.success) {
        const idError =
            `Note delivered, but its id sidecar (${LOVE_NOTES_DIR}/${LOVE_NOTE_ID_FILENAME}) ` +
            `did not: ${idResult.error || 'unknown error'}. The reader will re-show this note on every wake.`;
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(`[LoveNoteSender] ${idError}`);
        }
        // No noteId: it is not on the device, so History must not claim it is.
        return { success: true, idStaged: false, idError };
    }

    return { success: true, noteId, idStaged: true };
}

/**
 * Delete one fixed-name slot under `/.love-notes`, tolerating "there was
 * nothing there" and never throwing. See step 1 of {@link sendLoveNoteFrame}.
 */
async function clearSlot(t: LoveNoteTransport, ip: string, filename: string): Promise<void> {
    try {
        const cleared = await t.deleteFile(ip, filename, LOVE_NOTES_FOLDER);
        if (typeof __DEV__ !== 'undefined' && __DEV__ && !cleared) {
            console.log(`[LoveNoteSender] No previous ${LOVE_NOTES_DIR}/${filename} to clear (first send, or the device reported none)`);
        }
    } catch (error) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(`[LoveNoteSender] Pre-upload delete of ${filename} threw, continuing: ${String(error)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Which route a note actually travelled.
 *
 * 'handover' is NOT produced by {@link sendLoveNote} — nothing here can produce
 * it, because it is decided minutes or hours later, when the reader pulls the
 * note off this phone's outbox over the A3 peer link and the proxy reports the
 * body complete. It lives in this union because History renders route labels
 * from it and a note delivered by hand is a third, distinct outcome: the panel
 * IS showing it, and no mailbox was involved at any point.
 */
export type LoveNotePath = 'direct' | 'mailbox' | 'handover';

/**
 * Human wording for a route, so History and Compose cannot describe it differently.
 *
 * The ROUTING DISTINCTION is load-bearing, not flavour: 'direct' means the panel
 * is showing the note now, 'mailbox' means the reader collects it at its next
 * sleep and shows it at the wake after that. Only the tone is warm here; the
 * two cases stay separable, and ComposeScreen appends the "next wake" clause to
 * the mailbox case.
 */
export const LOVE_NOTE_PATH_LABEL: Record<LoveNotePath, string> = {
    direct: 'Delivered',
    mailbox: 'On its way',
    handover: 'Delivered directly',
};

/** One route attempt, in the order it was tried. */
export interface LoveNoteAttempt {
    path: LoveNotePath;
    success: boolean;
    error?: string;
}

/**
 * The settings a send depends on, as a plain structure.
 *
 * Deliberately NOT `Settings`: `services/settings.ts` imports AsyncStorage at
 * module scope, so depending on it here would drag react-native back into a
 * module that has just been made node-testable. Compose builds this from
 * settings in one line (`{ role, ip: getCurrentIp(settings), mailboxUrl,
 * mailboxWriteToken }`).
 */
export interface LoveNoteDestination {
    role: Role;
    /** Reader host for the direct path (already normalised, e.g. getCurrentIp). */
    ip: string;
    /** Mailbox base URL. Empty/absent means "no mailbox configured". */
    mailboxUrl?: string;
    /** Mailbox bearer token. NEVER part of mailboxUrl — see mailbox_client. */
    mailboxWriteToken?: string;
}

/**
 * `SendLoveNoteFrameResult` plus the route it took.
 *
 * `noteId` is inherited on purpose: BOTH routes report the id the reader will
 * dedup on — the mailbox's published id, or the id the direct path staged in
 * `current.id` — so a History row means the same thing either way.
 */
export interface SendLoveNoteResult extends SendLoveNoteFrameResult {
    /** The route that delivered the note. Absent when nothing delivered it. */
    path?: LoveNotePath;
    /** Every route tried, in order — so the UI can say "reader was asleep". */
    attempts: LoveNoteAttempt[];
    /**
     * Outbox id, when the note was ALSO parked on this phone for handover.
     *
     * Present means: the bytes are on disk and the very next peer-link session
     * serves them to the reader with no internet involved and no further taps.
     * Absent means the queue was not usable (no filesystem in this runtime) or
     * the caller opted out — never that queuing "failed silently".
     */
    queuedId?: string;
    /**
     * The reachability answer that made this send SKIP the direct route.
     *
     * Present ONLY on the fast skip, so a result that routed the way it always
     * has is byte-identical to what this function has always returned. Its
     * absence therefore means "direct was tried, or there was nothing to try" —
     * never "the reader was reachable".
     */
    skippedDirect?: ReaderReachability;
}

/** Knobs for the handover queue. Everything defaults to the useful behaviour. */
export interface SendLoveNoteOptions {
    /**
     * Park the note in the outbox when no route delivered it. Default TRUE.
     *
     * This is the auto-arm: a send that fails because the phone has no internet
     * and the reader is asleep leaves something that WILL be delivered the next
     * time the two are in the same room, rather than an error and a lost note.
     */
    queueOnFailure?: boolean;
    /**
     * Park it even when a route DID deliver it. Default false.
     *
     * Useful for "belt and braces" sends: the mailbox has it, and so does the
     * phone, and the reader dedups on the shared id whichever arrives first.
     * Off by default because it doubles disk use for the common case where the
     * mailbox delivery is going to work.
     */
    alwaysQueue?: boolean;
    /** Reuse an id (a retry keeps the reader's dedup id). Minted when absent. */
    noteId?: string;
    /**
     * Narration for the UI, called once per phase in the order they happen.
     *
     * SEPARATE FROM `onProgress` on purpose: progress is a number that only
     * exists on the direct route (the WS `PROGRESS:` acks), while a phase always
     * exists and is the only honest thing to show during the seconds when
     * nothing measurable is happening. See `reader_reachability.SendPhase`.
     */
    onPhase?: (phase: SendPhase) => void;
    /**
     * What the app already knows about whether the reader is answering —
     * `connectionStatus` from ConnectionProvider, with the time it was measured.
     *
     * Fresh enough, and this send asks nothing extra; stale or absent, and the
     * fast skip runs its own short probe. Either way it only ever DECIDES
     * anything when a mailbox fallback exists. See `reader_reachability`.
     */
    reachability?: ReaderReachabilityHint | null;
}

/**
 * Park a note in the outbox. Best-effort, NEVER throws, returns the id or null.
 *
 * Queuing is a consolation prize, not the send: a full disk or a runtime with no
 * filesystem must not turn "the mailbox took your note" into a reported failure,
 * and must not turn a failed send into a crash.
 */
export async function queueLoveNoteForHandover(
    frame: Uint8Array,
    noteId?: string
): Promise<string | null> {
    if (!frame || frame.byteLength !== LOVE_NOTE_FRAME_BYTES) return null;
    // The SAME minter the mailbox publishes under, so a note that eventually
    // travels both ways carries one id and the reader dedups it instead of
    // showing it twice.
    const id = noteId && describeNoteIdProblem(noteId) === null ? noteId : mintNoteId();
    try {
        const item = await enqueueNote(frame, id);
        // THE READER HAS ONE NOTE SLOT, so queuing this one just retired every
        // older one. Done here as well as at handover time (`sync_session`'s
        // outbox port) because the user is looking at History NOW: the row for
        // the note they just replaced should stop saying "In mailbox" while they
        // can still see it, not at some future session they may never start.
        //
        // Every step swallows its own failure. Queuing succeeded, and that is
        // what this function reports; a History row that did not get patched is
        // a stale label, not a lost note.
        try {
            for (const superseded of await supersedeQueuedNotes(item.id)) {
                await markNoteSuperseded(superseded).catch(() => false);
            }
        } catch (error) {
            console.warn('[LoveNote] Could not retire the older queued notes:', error);
        }
        return item.id;
    } catch (error) {
        console.warn('[LoveNote] Could not queue the note for handover:', error);
        return null;
    }
}

/**
 * Fragments that mean "we never got an answer from the reader", as opposed to
 * "the reader answered and refused".
 *
 * The distinction is the whole fallback decision. A refusal ('File already
 * exists', an HTTP 4xx) is a fixable, reportable device condition and the user
 * should see it; a dead socket means the reader is simply asleep, which is the
 * NORMAL state and exactly what the mailbox exists for.
 */
const DEVICE_UNREACHABLE_MARKERS = [
    'websocket',            // 'WebSocket upload timed out', 'WebSocket connection failed'
    'connection closed',    // 'Connection closed unexpectedly'
    'connection failed',
    'cannot reach',         // handleUploadError's 'Cannot reach X4. …'
    'timed out',
    'timeout',
    'network request failed',
    'fetch failed',
    'aborted',
    'transport unavailable',
    'error sending binary data',
    'could not connect',
    'failed to connect',
    'no route to host',
    'socket',
    'econnrefused',
    'ehostunreach',
    'enetunreach',
    'etimedout',
    'enotfound',
];

/**
 * True when a direct-path failure looks like "the reader was not there".
 *
 * An EMPTY or missing message counts as unreachable. A failure that cannot say
 * why it failed is indistinguishable from a dead socket, and the two possible
 * mistakes are not symmetric: falling back needlessly costs one extra HTTP
 * request, while not falling back costs the user their note.
 */
export function isDeviceUnreachableError(error?: string): boolean {
    if (!error || !error.trim()) return true;
    const text = error.toLowerCase();
    return DEVICE_UNREACHABLE_MARKERS.some(marker => text.includes(marker));
}

/**
 * Why this destination's mailbox cannot be used, or null when it can.
 *
 * "Not configured at all" gets the single canonical hint; a URL that IS set but
 * malformed gets the specific reason, because telling someone who already typed
 * a URL to "set up mailbox in Settings" tells them nothing about what is wrong.
 */
function describeMailboxProblem(destination: LoveNoteDestination): string | null {
    const url = (destination.mailboxUrl ?? '').trim();
    const token = (destination.mailboxWriteToken ?? '').trim();
    if (!url || !token) return MAILBOX_SETUP_HINT;
    return describeMailboxUrlProblem(url);
}

/** True when the mailbox is fully usable for this destination. */
export function isMailboxConfigured(destination: LoveNoteDestination): boolean {
    return describeMailboxProblem(destination) === null;
}

/**
 * Send a love note by whichever route this phone has.
 *
 *   role 'client'  -> MAILBOX ONLY. A client has no LAN access to the reader by
 *                     definition, so there is nothing to fall back FROM; with no
 *                     mailbox configured the send fails with
 *                     {@link MAILBOX_SETUP_HINT} and never touches the network.
 *   role 'host'    -> DIRECT FIRST, mailbox as a fallback when the reader did
 *                     not answer and a mailbox is configured. Direct is
 *                     preferred because it is immediate and the host is on the
 *                     same network; the fallback exists because the reader is
 *                     ASLEEP most of the time, which is not an error worth
 *                     showing a user who just wants the note delivered.
 *
 *                     "Direct first" now means ASK first: when a mailbox
 *                     fallback exists, `reader_reachability` answers "is it
 *                     awake?" from ConnectionProvider's own recent probe or a
 *                     2.5 s one of its own, and a reader that is not answering
 *                     goes straight to the mailbox. Trying anyway cost ~15-25 s
 *                     of stacked mkdir/WebSocket timeouts before a fallback that
 *                     then succeeded in under a second. With NO usable mailbox
 *                     nothing is skipped — direct is the only route there is.
 *
 * The frame is size-checked ONCE, up front, so an encoder bug fails identically
 * on both routes and can never trigger a pointless fallback (a wrong-sized
 * frame would be rejected by the mailbox too — and if it were not, the reader
 * would discard it on every sync, forever).
 *
 * NEVER THROWS. `result.path` names the route that delivered the note and
 * `result.attempts` lists everything tried, so History can record "mailbox
 * (reader asleep)" rather than a bare success.
 */
export async function sendLoveNote(
    destination: LoveNoteDestination,
    frame: Uint8Array,
    onProgress?: (percent: number) => void,
    options?: SendLoveNoteOptions
): Promise<SendLoveNoteResult> {
    const result = await routeLoveNote(destination, frame, onProgress, options);

    // THE QUEUE IS THE LAST RESORT, AND IT RUNS AFTER EVERYTHING ELSE.
    //
    // Deliberately not a third "route": queuing delivers nothing by itself, so it
    // can never make `success` true or fill in `path`. What it does is stop a
    // failed send from being a LOST note — the bytes sit on this phone and the
    // next time the reader raises its AP the proxy hands them over with no
    // internet and no extra taps. That is the auto-arm, and it is armed by the
    // item's mere presence rather than by a watcher that could be killed.
    const shouldQueue =
        frame && frame.byteLength === LOVE_NOTE_FRAME_BYTES
            ? options?.alwaysQueue === true ||
              (!result.success && options?.queueOnFailure !== false)
            : false;
    if (!shouldQueue) return result;

    const queuedId = await queueLoveNoteForHandover(frame, options?.noteId ?? result.noteId);
    // Omitted rather than set to undefined so a result object that queued nothing
    // is byte-identical to the one this function has always returned.
    return queuedId ? { ...result, queuedId } : result;
}

/** The routing decision itself — everything {@link sendLoveNote} did before the queue. */
async function routeLoveNote(
    destination: LoveNoteDestination,
    frame: Uint8Array,
    onProgress?: (percent: number) => void,
    options?: SendLoveNoteOptions
): Promise<SendLoveNoteResult> {
    const attempts: LoveNoteAttempt[] = [];
    const onPhase = options?.onPhase;

    if (!frame || frame.byteLength !== LOVE_NOTE_FRAME_BYTES) {
        return { success: false, error: frameSizeError(frame), attempts };
    }

    // Tolerant of a settings blob written before the role existed, exactly like
    // every other read of it (role.ts).
    const role = asRole(destination?.role);
    const mailboxProblem = describeMailboxProblem(destination);

    if (role === 'client') {
        if (mailboxProblem !== null) {
            // Nothing left the phone: no direct path exists for a client, and the
            // mailbox is not usable.
            return { success: false, error: mailboxProblem, attempts };
        }
        onPhase?.('mailbox');
        return publishToMailbox(destination, frame, attempts, onProgress);
    }

    // ── Host ────────────────────────────────────────────────────────────────
    //
    // FAST SKIP, AND ONLY WHERE IT IS FREE. Asking first costs at most
    // READER_PROBE_TIMEOUT_MS; NOT asking costs ~15-25 s of stacked mkdir/WS
    // timeouts every time the reader is asleep, which is most of the time.
    //
    // The condition is `mailboxProblem === null` and it is load-bearing: with no
    // usable mailbox the direct attempt is the ONLY thing that can deliver this
    // note, so a probe that is wrong must not be allowed to turn a slow send into
    // a failed one. See reader_reachability's header, rule 1.
    let reachability: ReaderReachability | null = null;
    if (mailboxProblem === null) {
        onPhase?.('looking');
        reachability = await resolveReaderReachability(destination.ip, options?.reachability);
    }

    if (reachability && !reachability.reachable) {
        // Nothing was TRIED against the reader, so no 'direct' attempt is
        // recorded — `attempts` stays a log of what actually ran. The skip is
        // reported through `skippedDirect` instead.
        onPhase?.('mailbox');
        const skipped = await publishToMailbox(destination, frame, attempts, onProgress);
        if (skipped.success) return { ...skipped, skippedDirect: reachability };
        return {
            ...skipped,
            // Same sentence shape the tried-and-failed path below produces, so a
            // user cannot tell the two apart by the wording of an error that means
            // the same thing.
            error: `Reader unreachable (${reachability.error || 'no answer'}); mailbox failed too: ${skipped.error}`,
            skippedDirect: reachability,
        };
    }

    // The reader itself, first.
    onPhase?.('direct');
    const direct = await sendLoveNoteFrame(destination.ip, frame, onProgress);
    attempts.push({ path: 'direct', success: direct.success, error: direct.error });
    if (direct.success) {
        // The id travels back out with the same field name the mailbox leg uses,
        // so ComposeScreen records "which note the reader will show" without
        // caring which route ran. `idStaged: false` (frame landed, sidecar did
        // not) is still a success — see sendLoveNoteFrame.
        return {
            success: true,
            path: 'direct',
            noteId: direct.noteId,
            idStaged: direct.idStaged,
            idError: direct.idError,
            attempts,
        };
    }

    const directError = direct.error || 'Reader did not answer';

    if (!isDeviceUnreachableError(direct.error)) {
        // The reader ANSWERED and refused. Republishing to the mailbox would
        // hide a real device condition (a full card, a rejected overwrite)
        // behind a delayed delivery the user did not ask for.
        return { success: false, error: directError, attempts };
    }

    // A dead upload is a stronger observation than the probe that preceded it.
    // Recorded so the NEXT send (or the next book in a batch) skips the stall
    // this one just paid for, rather than re-discovering it.
    noteReaderUnreachable(destination.ip, directError);

    if (mailboxProblem !== null) {
        return {
            success: false,
            error:
                mailboxProblem === MAILBOX_SETUP_HINT
                    ? `Reader unreachable (${directError}). ${MAILBOX_SETUP_HINT} to send while it is asleep.`
                    : `Reader unreachable (${directError}). Mailbox unusable: ${mailboxProblem}`,
            attempts,
        };
    }

    onPhase?.('mailbox');
    const viaMailbox = await publishToMailbox(destination, frame, attempts, onProgress);
    if (viaMailbox.success) return viaMailbox;

    return {
        ...viaMailbox,
        error: `Reader unreachable (${directError}); mailbox failed too: ${viaMailbox.error}`,
    };
}

/** Shared mailbox leg. Appends its own attempt row. */
async function publishToMailbox(
    destination: LoveNoteDestination,
    frame: Uint8Array,
    attempts: LoveNoteAttempt[],
    onProgress?: (percent: number) => void
): Promise<SendLoveNoteResult> {
    const published = await publishLoveNote(
        (destination.mailboxUrl ?? '').trim(),
        (destination.mailboxWriteToken ?? '').trim(),
        frame,
        onProgress
    );
    attempts.push({ path: 'mailbox', success: published.success, error: published.error });

    if (published.success) {
        return { success: true, path: 'mailbox', noteId: published.noteId, attempts };
    }
    return { success: false, error: published.error, noteId: published.noteId, attempts };
}
