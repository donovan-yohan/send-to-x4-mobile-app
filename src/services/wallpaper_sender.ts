/**
 * wallpaper_sender — put an 8-bit grayscale BMP on the reader as its PERMANENT
 * sleep screen.
 *
 * ---------------------------------------------------------------------------
 * TWO DESTINATIONS, ONE ENCODER
 * ---------------------------------------------------------------------------
 * `image_converter.prepareWallpaperBmp` produces the bytes; this module decides
 * WHERE they land. The firmware reads exactly two places:
 *
 *   { kind: 'primary' }        -> `/sleep.bmp` at the SD ROOT.
 *                                 Single slot, highest priority, REPLACED on
 *                                 every send (see DELETE BEFORE UPLOAD below —
 *                                 the firmware cannot overwrite in place).
 *                                 "Pin this one picture."
 *   { kind: 'set', name }      -> `/.sleep/<name>.bmp`.
 *                                 A rotating set — the firmware picks one at
 *                                 random on each sleep and excludes recently
 *                                 shown entries. "Add to the cycle."
 *
 * NO ROTATION anywhere on this path. The firmware's `drawBitmap` is
 * orientation-aware, unlike the raw-blitted love-note frame, which the app has
 * to rotate 90 degrees CCW into the landscape panel buffer itself. If you find
 * yourself reaching for `frame_encoder`'s geometry here, you are on the wrong
 * path: love notes are TEMPORARY 52272-byte 1-bit blobs at
 * `/.love-notes/current.frame` (see `love_note_sender.ts`) and share nothing
 * with this one but the transport.
 *
 * (Neither path X-mirrors. The panel is not mirrored — proven on hardware
 * 2026-07-28; see `src/device/x3.ts`.)
 *
 * ---------------------------------------------------------------------------
 * DELETE BEFORE UPLOAD — NOT OPTIONAL, PROVEN ON HARDWARE 2026-07-28
 * ---------------------------------------------------------------------------
 * The firmware REFUSES to overwrite an existing path: the WS upload answers
 * `ERROR: File already exists` and writes nothing. BOTH destinations here are
 * re-written under a name they have held before — `/sleep.bmp` is a single fixed
 * slot, and `promote.ts` mints a DETERMINISTIC `/.sleep/<name>.bmp` per history
 * row — so a sender with no delete works exactly once per name and then leaves
 * the OLD picture on the card while reporting a failure the user cannot act on.
 *
 * {@link sendWallpaperBmp} therefore deletes the resolved path first and ignores
 * the result (nothing to delete on a first send is normal). This is the same
 * rule, for the same reason, as `love_note_sender.ts`; the ordering is pinned by
 * `wallpaper-sender.test.js`, whose fake transport enforces the firmware's
 * exists-rejection exactly as `send_frame.mjs --self-test`'s mock does.
 *
 * ---------------------------------------------------------------------------
 * DEVICE PRECONDITION THE APP CANNOT SET
 * ---------------------------------------------------------------------------
 * A wallpaper only becomes visible once the reader's sleep mode is set to
 * CUSTOM, which is an ON-DEVICE toggle with no remote equivalent in the
 * firmware today. A successful upload therefore does NOT imply the user will
 * see anything. {@link SLEEP_MODE_HINT} is the one canonical wording for that;
 * surface it next to the send button rather than re-inventing the sentence.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSPORT IS BEHIND A SEAM
 * ---------------------------------------------------------------------------
 * `crosspoint_upload.ts` statically imports `expo-file-system/legacy`, which
 * pulls in `react-native`, which esbuild/tsx cannot parse — importing it at the
 * top of this module would make every test below impossible to write. It is
 * reached through the same lazy-`require` seam `message_history.ts` uses, so
 * naming, path mapping and result shaping are all covered under node while the
 * app still gets a plain static dependency through Metro.
 *
 * ---------------------------------------------------------------------------
 * THREE ROADS NOW, NOT ONE — SEE {@link routeWallpaperSend}
 * ---------------------------------------------------------------------------
 * Everything above describes the DIRECT road, which is all this module had for a
 * long time and is why WallpaperScreen was the last screen in the app that went
 * grey whenever the reader was asleep. {@link routeWallpaperSend} is the entry
 * point callers should use: it tries the reader first (when there is any point),
 * falls back to the mailbox the reader already polls, and parks a copy in the
 * outbox for a peer-link handover when neither worked. `sendWallpaperBmp` stays
 * exported and unchanged — it is the direct leg, and `promote.ts` and the
 * router both call it.
 *
 * NEVER THROWS. Every entry point reports failure in its return value
 * (`UploadResult` / `[]` / `false`), matching `sendLoveNoteFrame` and
 * `sendNoteAsTxt`. Callers written to the repo convention need no try/catch.
 */

import type { Role, UploadResult } from '../types';
import { isMailboxConfigured, MAILBOX_SETUP_HINT, isDeviceUnreachableError } from './love_note_sender';
import {
    describeMailboxUrlProblem,
    mintWallpaperId,
    publishWallpaper,
    type MailboxWallpaperTarget,
} from './mailbox_client';
import { enqueueWallpaper, supersedeQueuedPrimaryWallpapers } from './outbox';
import {
    noteReaderUnreachable,
    resolveReaderReachability,
    type ReaderReachability,
    type ReaderReachabilityHint,
    type SendPhase,
} from './reader_reachability';
import { asRole } from './role';
import { getDeviceBaseUrl, sanitizeDevicePath } from './settings';

// ---------------------------------------------------------------------------
// Device contract
// ---------------------------------------------------------------------------

/** The single, top-priority wallpaper. Lives at the SD ROOT, not in a folder. */
export const SLEEP_ROOT_FILENAME = 'sleep.bmp';

/** Folder holding the rotating set. The LEADING DOT is part of the name. */
export const SLEEP_SET_DIR = '/.sleep';

/**
 * `SLEEP_SET_DIR` as `uploadToCrossPoint`/`deleteCrossPointFile` want it:
 * root-relative, no leading slash, because they build the `/${folder}` prefix
 * themselves.
 *
 * Routed through `sanitizeDevicePath` rather than a hand-written `'.sleep'`
 * literal on purpose — that function is pinned by `folder-sanitize.test.js` to
 * keep a leading dot intact, which is exactly the property this path needs and
 * exactly the property `sanitizeFolderName` is free to drop (R7: a stripped dot
 * writes to `/sleep`, an unrelated folder the firmware ignores for rotation).
 */
export const SLEEP_SET_FOLDER = sanitizeDevicePath(SLEEP_SET_DIR);

/**
 * The SD root, in `uploadToCrossPoint`'s folder vocabulary.
 *
 * `sanitizeDevicePath('')` is '' and that emptiness is MEANINGFUL, not a
 * failure: `ensureFolderExistsCrossPoint` splits it into zero segments (creates
 * nothing) and the upload targets `/`.
 *
 * UNVERIFIED ON HARDWARE — the one assumption on this path that a test cannot
 * settle. `uploadToCrossPoint` always builds `/${targetFolder}`, so the root
 * upload sends `START:sleep.bmp:<n>:/` and the firmware joins path+filename
 * itself. Every verified upload so far has used a NON-empty folder
 * (`/.love-notes`, `/send-to-x4`), so whether the join yields `/sleep.bmp` or
 * `//sleep.bmp` here has never actually been observed. FAT/SdFat normally skips
 * repeated separators, but if the primary slot ever lands in the wrong place
 * while the `/.sleep` set works, this constant is the first thing to look at —
 * the fix is in `crosspoint_upload.ts`'s path building, not in the mapping,
 * which `wallpaper-sender.test.js` pins.
 *
 * Because the assumption cannot be settled here, it is CHECKED at runtime
 * instead: {@link verifyPrimaryWallpaper} reads the root listing back after a
 * primary send, so a file that lands somewhere the firmware never looks is
 * reported to the user rather than passing as a success.
 */
const SD_ROOT_FOLDER = '';

/** Extension the firmware scans for in `/.sleep`. Lowercase on the wire. */
const BMP_EXTENSION = '.bmp';

/** NUL / C0 / DEL. Written with escapes so the source stays plain ASCII. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** BMP file magic ('BM'), the cheapest guard against a mis-routed payload. */
const BMP_MAGIC_B = 0x42;
const BMP_MAGIC_M = 0x4d;

/** Matches `listCrossPointSleepFiles`' budget for the same call shape. */
const LIST_TIMEOUT_MS = 10000;

/**
 * The one canonical wording for the precondition the app cannot satisfy.
 * Single literal so Wallpaper/Compose/History cannot drift apart on it.
 */
export const SLEEP_MODE_HINT =
    "On the reader, set Sleep Screen to 'Custom' — the app cannot change that setting remotely.";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Where a wallpaper should land.
 *
 * A discriminated union rather than a boolean so adding a third destination
 * later cannot silently re-target existing calls.
 */
export type WallpaperTarget =
    | { kind: 'primary' }
    | { kind: 'set'; name: string };

/** A {@link WallpaperTarget} resolved to what the transport actually needs. */
export interface ResolvedWallpaperTarget {
    /** Root-relative folder for `uploadToCrossPoint`. '' is the SD root. */
    folder: string;
    /** Bare filename, already safe. */
    filename: string;
    /** Absolute device path. For logs, tests and error text — never for I/O. */
    path: string;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Normalize a name WE mint into a safe `<stem>.bmp`, or '' if it cannot be.
 *
 * Two different rules, deliberately:
 *   - A path SEPARATOR is REJECTED, not flattened. Collapsing 'a/b.bmp' to
 *     'ab.bmp' would quietly change which file the user is talking about, and
 *     `sanitizeDevicePath` would happily keep 'a/b' as two nested segments —
 *     escaping `/.sleep` altogether. Neither outcome is acceptable, so the name
 *     is refused instead.
 *   - Everything else is NORMALIZED (spaces and punctuation become '-', via
 *     `sanitizeDevicePath`). That is a charset change, not an identity change.
 *
 * The `.bmp` suffix is enforced, case-insensitively and idempotently:
 * 'x', 'x.bmp' and 'x.BMP' all produce 'x.bmp', so a caller cannot create
 * 'x.bmp.bmp' by being careful.
 */
export function sanitizeSleepSetName(rawName: string): string {
    if (typeof rawName !== 'string') return '';
    const trimmed = rawName.trim();
    if (!trimmed) return '';

    // Reject rather than rewrite — see the doc comment.
    if (/[\/\\]/.test(trimmed)) return '';
    // NUL and control characters have no business in a FAT filename.
    if (CONTROL_CHARS.test(trimmed)) return '';

    const stem = trimmed.toLowerCase().endsWith(BMP_EXTENSION)
        ? trimmed.slice(0, -BMP_EXTENSION.length)
        : trimmed;

    // Single segment in, single segment out: sanitizeDevicePath drops '.'/'..',
    // caps the segment at 60 chars and collapses '-' runs.
    const safeStem = sanitizeDevicePath(stem);
    if (!safeStem || safeStem.includes('/')) return '';

    return `${safeStem}${BMP_EXTENSION}`;
}

/**
 * Is `name` safe to send to the device VERBATIM?
 *
 * Used for names that came back FROM `listSleepSet`, where normalizing would be
 * wrong: a file put in `/.sleep` by another tool ('my photo.bmp') must be
 * deletable under the name it actually has, not under a rewritten one that
 * matches nothing. So this validates and refuses; it never edits.
 */
export function isSafeSleepSetName(name: string): boolean {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed !== name) return false;
    if (trimmed === '.' || trimmed === '..') return false;
    if (/[\/\\]/.test(trimmed)) return false;
    if (CONTROL_CHARS.test(trimmed)) return false;
    return trimmed.toLowerCase().endsWith(BMP_EXTENSION) && trimmed.length > BMP_EXTENSION.length;
}

/**
 * Deterministic, collision-safe `/.sleep` filename for a history record id.
 *
 * DETERMINISTIC so promoting the same note twice REPLACES its own entry instead
 * of stacking near-duplicates into a rotation the firmware picks from at random.
 * "Replaces" only holds because {@link sendWallpaperBmp} deletes the target path
 * before uploading — the firmware cannot overwrite in place, so without that
 * delete this determinism turns the second promote into an outright failure.
 *
 * COLLISION-SAFE via a hash of the RAW id appended to the sanitized stem.
 * Sanitization is lossy (every character outside `[A-Za-z0-9._-]` becomes '-',
 * and the stem is truncated), so two distinct ids can sanitize to the same
 * text; the hash is computed before any of that, so distinct ids keep distinct
 * filenames and one note can never overwrite another's wallpaper.
 */
export function sleepSetNameForId(id: string): string {
    const raw = typeof id === 'string' ? id.trim() : '';
    const digest = fnv1a32Hex(raw);
    // Budget: 'note-' (5) + stem (<=40) + '-' (1) + digest (8) = 54, leaving the
    // whole name under sanitizeDevicePath's 60-char per-segment cap once '.bmp'
    // is appended. Without the cap the digest would be the part truncated away.
    const stem = sanitizeDevicePath(raw).replace(/\//g, '-').slice(0, 40).replace(/-+$/, '');
    const base = stem ? `note-${stem}-${digest}` : `note-${digest}`;
    return sanitizeSleepSetName(base);
}

/** 32-bit FNV-1a, as 8 lowercase hex chars. Not cryptographic — just spread. */
function fnv1a32Hex(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Map a target to the folder/filename pair the transport takes, or null when a
 * set name cannot be made safe.
 *
 * Exported because this mapping — 'primary' means the SD ROOT and NOT
 * `/sleep/sleep.bmp`, 'set' means the dot-folder — is the single most
 * consequential decision in this module and the only one worth pinning in a
 * test without a device.
 */
export function resolveWallpaperTarget(target: WallpaperTarget): ResolvedWallpaperTarget | null {
    if (!target || typeof target !== 'object') return null;

    if (target.kind === 'primary') {
        return {
            folder: SD_ROOT_FOLDER,
            filename: SLEEP_ROOT_FILENAME,
            path: `/${SLEEP_ROOT_FILENAME}`,
        };
    }

    if (target.kind === 'set') {
        const filename = sanitizeSleepSetName(target.name);
        if (!filename) return null;
        return {
            folder: SLEEP_SET_FOLDER,
            filename,
            path: `${SLEEP_SET_DIR}/${filename}`,
        };
    }

    return null;
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
export interface WallpaperTransport {
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

let transport: WallpaperTransport | null = null;
let transportResolved = false;

/**
 * Replace the transport. Pass `null` to restore the CrossPoint default.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setWallpaperTransport(next: WallpaperTransport | null): void {
    transport = next;
    transportResolved = next !== null;
}

function getTransport(): WallpaperTransport | null {
    if (!transportResolved) {
        transport = loadCrossPointTransport();
        transportResolved = true;
    }
    return transport;
}

function loadCrossPointTransport(): WallpaperTransport | null {
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
            const upload = mod.uploadToCrossPoint as WallpaperTransport['upload'];
            const deleteFile = mod.deleteCrossPointFile as WallpaperTransport['deleteFile'];
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

const NO_TRANSPORT_ERROR = 'Device transport unavailable in this runtime.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload an encoded wallpaper BMP to `/sleep.bmp` or `/.sleep/<name>.bmp`.
 *
 * The target path is DELETED first and the delete's result is ignored — see
 * DELETE BEFORE UPLOAD in the header. Without it a second send to the same name
 * (which is every primary send, and every re-promote) is refused by the firmware
 * with the old picture still on the card.
 *
 * @param bmp Output of `prepareWallpaperBmp` — an 8-bit grayscale BMP. Passing
 *            a love-note frame here is caught by the 'BM' magic check rather
 *            than silently written to the SD card as a file the firmware will
 *            try, and fail, to decode on every sleep.
 */
export async function sendWallpaperBmp(
    ip: string,
    bmp: Uint8Array,
    target: WallpaperTarget,
    onProgress?: (percent: number) => void
): Promise<UploadResult> {
    if (!bmp || bmp.byteLength < 2 || bmp[0] !== BMP_MAGIC_B || bmp[1] !== BMP_MAGIC_M) {
        // An encoder/caller bug rather than a transport failure, but still an
        // UploadResult so there is exactly one contract to handle.
        return {
            success: false,
            error:
                'Wallpaper payload is not a BMP (expected a "BM" header from prepareWallpaperBmp).',
        };
    }

    const resolved = resolveWallpaperTarget(target);
    if (!resolved) {
        return {
            success: false,
            error:
                target && (target as { kind?: string }).kind === 'set'
                    ? `Unusable wallpaper name: ${JSON.stringify((target as { name?: unknown }).name ?? '')}`
                    : 'Unknown wallpaper target.',
        };
    }

    const t = getTransport();
    if (!t) return { success: false, error: NO_TRANSPORT_ERROR };

    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log(
            `[WallpaperSender] Sending ${bmp.byteLength} bytes to ${resolved.path} (ip=${ip})`
        );
    }

    // 1. Clear the target path. The firmware REFUSES to overwrite an existing
    //    file ('ERROR: File already exists') and writes NOTHING — proven on
    //    hardware 2026-07-28, same rule `love_note_sender.ts` is written to.
    //
    //    It bites hardest on the primary slot: `{ kind: 'primary' }` is the one
    //    fixed path `/sleep.bmp`, re-written every time the user taps "Set sleep
    //    screen", so without this the SECOND send fails while the panel still
    //    shows the FIRST wallpaper — indistinguishable from "it worked but the
    //    picture is wrong". `promote.ts` has the same shape: `sleepSetNameForId`
    //    is DETERMINISTIC, so re-promoting a row re-writes its own
    //    `/.sleep/<name>.bmp` and would otherwise fail for a row that is
    //    already in the rotation.
    //
    //    A FALSE result is EXPECTED and deliberately ignored: on the first send
    //    there is nothing to delete, and `deleteCrossPointFile` reports any
    //    non-OK status — including the firmware's "no such file" — as false.
    //    Treating that as fatal would make the first-ever wallpaper the one that
    //    cannot be sent. If the file really is still there, the upload's own
    //    'File already exists' error is the accurate, user-visible report.
    //
    //    The try/catch is this function's NEVER-THROWS contract, which must not
    //    depend on the transport swallowing its own network errors.
    //
    //    ROOT-PATH NOTE: for the primary target `resolved.folder` is '', so
    //    `deleteCrossPointFile` builds `//sleep.bmp` (`/${folder}/${filename}`)
    //    while the upload sends folder and filename SEPARATELY and lets the
    //    FIRMWARE join them (see {@link SD_ROOT_FOLDER}). That is deliberate and
    //    correct under BOTH readings of the unobserved join: if SdFat collapses
    //    repeated separators the two forms are the same file, and if it does not,
    //    `//sleep.bmp` is exactly the path the upload's own '/' + 'sleep.bmp'
    //    join produced. "Normalizing" the delete would only break the second
    //    case. And unlike the upload's silent mis-landing, a delete that misses
    //    is LOUD: the next upload comes back 'ERROR: File already exists' and
    //    that string reaches the user.
    try {
        const cleared = await t.deleteFile(ip, resolved.filename, resolved.folder);
        if (typeof __DEV__ !== 'undefined' && __DEV__ && !cleared) {
            console.log(
                `[WallpaperSender] No previous ${resolved.path} to clear (first send, or the device reported none)`
            );
        }
    } catch (error) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(
                `[WallpaperSender] Pre-upload delete threw, continuing to upload: ${String(error)}`
            );
        }
    }

    try {
        // 2. uploadToCrossPoint runs ensureFolderExistsCrossPoint for us (a no-op
        // for the SD root, which has zero segments) and then streams over WS.
        //
        // KNOWN GAP, shared with love_note_sender (crosspoint_upload.ts:177):
        // uploadToCrossPoint DISCARDS the folder-creation result, so a `/.sleep`
        // that genuinely cannot be created surfaces as the firmware's raw
        // 'ERROR:<...>' string instead of "could not create /.sleep". Fixing it
        // means touching the shared transport, which the note sender also
        // depends on; tracked there, not worked around here.
        return await t.upload(ip, bmp, resolved.filename, onProgress, resolved.folder);
    } catch (error) {
        return { success: false, error: describeError(error) };
    }
}

/**
 * One file in the rotation set.
 *
 * TWO NAMES, because the firmware can report a percent-encoded one. `/.sleep`
 * is a SHARED folder — `BmpViewerActivity::doSetSleepCover` writes into it too —
 * so an entry the app never minted ('my cover.bmp', listed as
 * 'my%20cover.bmp') is realistic, and the decoded form matches no file on the
 * card. Same split, and the same reason, as `listCrossPointFiles`' `rawName`
 * (see DeviceScreen's `file.rawName || file.name` delete calls).
 */
export interface SleepSetEntry {
    /** Decoded — what the user reads in a list, and what the sort uses. */
    name: string;
    /** EXACTLY what `/api/files` reported. This is what a delete must send. */
    rawName: string;
    size: number;
}

/**
 * Contents of `/.sleep`, i.e. the current rotation.
 *
 * Never throws and never partially fails: an unreachable device, a non-existent
 * folder and a malformed response all read as an EMPTY set, because every
 * caller is a list render and none of them can do anything useful with a
 * distinction they cannot act on.
 */
export async function listSleepSet(ip: string): Promise<SleepSetEntry[]> {
    const items = await fetchListing(ip, SLEEP_SET_DIR);
    if (!items) return [];

    const entries: SleepSetEntry[] = [];
    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as { name?: unknown; size?: unknown; isDirectory?: unknown; type?: unknown };

        // Both shapes the firmware has shipped, same as listCrossPointSleepFiles.
        if (item.isDirectory === true || item.type === 'dir') continue;
        if (typeof item.name !== 'string') continue;

        const rawName = item.name;
        const name = safeDecodeURIComponent(rawName).trim();
        if (!name.toLowerCase().endsWith(BMP_EXTENSION)) continue;

        const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
            ? item.size
            : 0;
        entries.push({ name, rawName, size });
    }

    // Name order, not date order: `/api/files` does not promise a timestamp
    // for every entry, and a list that reshuffles between refreshes makes
    // "delete the third one" a hazard.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
}

/**
 * Remove one entry from the rotation.
 *
 * The name goes to the device VERBATIM (after validation) — see
 * {@link isSafeSleepSetName} for why this path validates instead of
 * normalizing.
 *
 * @param name    Display name, i.e. {@link SleepSetEntry.name}.
 * @param rawName {@link SleepSetEntry.rawName}, when the caller has it.
 *                PREFERRED, and validated in place of `name`: the decoded form
 *                of a percent-encoded entry names no file on the card, and
 *                `deleteCrossPointFile` returns the response's `ok` whether or
 *                not anything was removed — so deleting under the decoded name
 *                looks like it worked and the entry reappears on refresh.
 * @returns true only on a confirmed device-side delete.
 */
export async function deleteSleepSetEntry(
    ip: string,
    name: string,
    rawName?: string
): Promise<boolean> {
    const wireName =
        typeof rawName === 'string' && rawName.trim().length > 0 ? rawName : name;
    if (!isSafeSleepSetName(wireName)) return false;

    const t = getTransport();
    if (!t) return false;

    try {
        return await t.deleteFile(ip, wireName, SLEEP_SET_FOLDER);
    } catch (error) {
        console.warn('[WallpaperSender] Failed to delete from /.sleep:', error);
        return false;
    }
}

/**
 * Result of reading the SD root back after a primary send.
 *
 *   'present' `sleep.bmp` is at the root, exactly where the firmware looks.
 *   'missing' The root listing was read and `sleep.bmp` is NOT in it.
 *   'unknown' The listing could not be read at all. NOT a failure — the upload
 *             already succeeded, and a flaky listing must not cry wolf.
 */
export type PrimaryWallpaperCheck = 'present' | 'missing' | 'unknown';

/**
 * Did the primary wallpaper actually land at `/sleep.bmp`?
 *
 * THE ONE THING ON THIS PATH THAT NO TEST CAN SETTLE. `uploadToCrossPoint`
 * sends the folder and the filename SEPARATELY (`START:sleep.bmp:<n>:/`) and
 * the FIRMWARE joins them; every join verified on hardware so far used a
 * non-empty folder, so whether the root case yields `/sleep.bmp` or
 * `//sleep.bmp` has never been observed (see {@link SD_ROOT_FOLDER}). If it
 * lands wrong, the upload still reports success, `SleepActivity` still finds
 * nothing, and the panel keeps the old image — the exact silent failure this
 * whole module is written against.
 *
 * So the app reads it back. A 'missing' here is worth surfacing loudly; the fix
 * would be in `crosspoint_upload.ts`'s path building, not in the mapping.
 *
 * Never throws.
 */
export async function verifyPrimaryWallpaper(ip: string): Promise<PrimaryWallpaperCheck> {
    const items = await fetchListing(ip, '/');
    if (!items) return 'unknown';

    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as { name?: unknown; isDirectory?: unknown; type?: unknown };
        if (item.isDirectory === true || item.type === 'dir') continue;
        if (typeof item.name !== 'string') continue;

        // Tolerate a listing that reports '/sleep.bmp' instead of a bare name;
        // anything else that merely CONTAINS the name (a '//sleep.bmp' oddity
        // under some other directory, say) is not the file the firmware reads.
        const name = safeDecodeURIComponent(item.name).trim().replace(/^\/+/, '');
        if (name.toLowerCase() === SLEEP_ROOT_FILENAME) return 'present';
    }
    return 'missing';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `GET /api/files?path=<dir>` as a raw array, or null when it could not be read.
 *
 * NULL IS THE POINT: `listSleepSet` folds "unreadable" into "empty" because a
 * list render can do nothing with the difference, while `verifyPrimaryWallpaper`
 * MUST keep it — reporting "the wallpaper is not there" because the WiFi
 * dropped would be worse than saying nothing.
 */
async function fetchListing(ip: string, path: string): Promise<unknown[] | null> {
    try {
        const baseUrl = getDeviceBaseUrl(ip);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);

        let response: Response;
        try {
            response = await fetch(`${baseUrl}/api/files?path=${encodeURIComponent(path)}`, {
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) return null;

        const items: unknown = await response.json();
        return Array.isArray(items) ? items : null;
    } catch (error) {
        console.warn(`[WallpaperSender] Failed to list ${path}:`, error);
        return null;
    }
}

/** Decode without crashing on invalid escapes (a literal '%' in a filename). */
function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return 'Wallpaper upload failed.';
}

// ---------------------------------------------------------------------------
// Routing — the same three roads notes and books already had
// ---------------------------------------------------------------------------

/**
 * A wallpaper can reach the reader two ways, and {@link routeWallpaperSend} is
 * the one place that decides which.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN USED TO BE THE LAST DIRECT-ONLY ONE
 * ---------------------------------------------------------------------------
 * {@link sendWallpaperBmp} PUTs the BMP at the reader's own HTTP/WS API, so it
 * needs the reader AWAKE and on this LAN. The reader is asleep with its radio
 * off almost all of the time, and a client phone has no LAN path to it at all —
 * so "change what your partner's reader shows while it sleeps" was a button that
 * was grey nearly every time anyone looked at it, and the model behind it
 * (`useDirectConnectionRequired`) said so out loud.
 *
 * That is no longer true, and nothing about the DEVICE changed to make it true:
 * the mailbox the reader already polls for notes and books now carries
 * wallpapers too (`mailbox_client.publishWallpaper`), and the phone's own outbox
 * can hold one for a peer-link handover. So this module gained the same routing
 * `love_note_sender.routeLoveNote` and `epub_sender.routeEpubSend` have had, and
 * it is a DELIBERATE MIRROR of the book one — same role gate, same fast skip,
 * same mailbox fallback, same auto-arm — because the same asleep reader must not
 * be handled three different ways.
 */
export type WallpaperRoute = 'direct' | 'mailbox';

/**
 * What the UI says a route MEANT, once it succeeded.
 *
 * 'In the mailbox' rather than 'Sent', and the distinction is the honest one:
 * the mailbox route puts the picture in a box the reader collects on its own
 * schedule, so the panel does not change until the reader next syncs — which can
 * be hours. Same wording, and same reason, as `EPUB_ROUTE_LABEL`.
 */
export const WALLPAPER_ROUTE_LABEL: Record<WallpaperRoute, string> = {
    direct: 'On the reader',
    mailbox: 'In the mailbox',
};

/**
 * The one wording for what a mailbox delivery means, as a constant, so no two
 * surfaces can promise different things about the same picture.
 */
export const WALLPAPER_MAILBOX_LANDING_CLAUSE = 'will land on the reader next sync';

/**
 * The one wording for what a HANDOVER-parked wallpaper means.
 *
 * Different promise from the mailbox one and it must read differently: nothing
 * is delivered until the user runs Sync-with-reader in the reader's physical
 * presence. Saying "next sync" for both would tell someone with no mailbox that
 * their picture is on its way when it is sitting on their phone waiting for
 * them to do something.
 */
export const WALLPAPER_HANDOVER_LANDING_CLAUSE =
    'is saved on this phone and hands over at the next Sync with reader';

/** One route attempt, in the order it was tried. */
export interface WallpaperRouteAttempt {
    route: WallpaperRoute;
    success: boolean;
    error?: string;
}

/**
 * The settings a send depends on, as a plain structure.
 *
 * Structurally identical to `EpubDestination` and `LoveNoteDestination` on
 * purpose — all three routes are chosen from the SAME four facts and share
 * `isMailboxConfigured` — but declared here so a caller does not have to import
 * a book type to set a sleep screen.
 */
export interface WallpaperDestination {
    role: Role;
    /** Reader host for the direct route (already normalised, e.g. getCurrentIp). */
    ip: string;
    /** Mailbox base URL. Empty/absent means "no mailbox configured". */
    mailboxUrl?: string;
    /** Mailbox bearer token. NEVER part of mailboxUrl — see mailbox_client. */
    mailboxWriteToken?: string;
}

/** `UploadResult` plus which route delivered the wallpaper. */
export interface RouteWallpaperResult extends UploadResult {
    /** The route that delivered it. Absent when nothing delivered it. */
    route?: WallpaperRoute;
    /** Every route tried, in order — so the UI can say "reader was asleep". */
    attempts: WallpaperRouteAttempt[];
    /** Which slot the send was aimed at. Always present, even on a failure. */
    target: MailboxWallpaperTarget;
    /** The name it landed under. Absent for a primary, whose path is fixed. */
    filename?: string;
    /** Mailbox id, on the mailbox route only. */
    wallpaperId?: string;
    /**
     * Outbox id, when the wallpaper was ALSO parked on this phone for handover.
     *
     * Present means a copy of the BMP is on local disk and the next peer-link
     * session serves it to the reader with no internet and no further taps.
     */
    queuedId?: string;
    /**
     * The reachability answer that made this send SKIP the direct route.
     *
     * Present ONLY on the fast skip. Its absence means "direct was tried, or
     * there was nothing to try" — never "the reader was reachable".
     */
    skippedDirect?: ReaderReachability;
}

export interface RouteWallpaperOptions {
    /** Mailbox id to reuse for a retry. A NEW id is minted when absent. */
    wallpaperId?: string;
    /**
     * Park the wallpaper in the outbox when no route delivered it. Default TRUE.
     *
     * The auto-arm. It matters here for a reason it does not for a note: a
     * wallpaper is the thing a user sets while standing next to a reader that is
     * asleep, which is exactly the case the peer link exists for.
     */
    queueOnFailure?: boolean;
    /** Park it even when a route DID deliver it. Default false. */
    alwaysQueue?: boolean;
    /** Narration for the UI, in the order the phases happen. */
    onPhase?: (phase: SendPhase) => void;
    /**
     * What the app already knows about whether the reader is answering.
     *
     * Fresh enough and this send asks nothing extra; stale or absent and the
     * fast skip runs its own short probe. Either way it only ever DECIDES
     * anything when a mailbox fallback exists. See `reader_reachability`.
     */
    reachability?: ReaderReachabilityHint | null;
}

/**
 * Park one wallpaper in the outbox. Best-effort, NEVER throws, returns the id or
 * null.
 *
 * A PRIMARY ALSO RETIRES ANY OLDER QUEUED PRIMARY. There is one `/sleep.bmp` on
 * the card, so a queue holding three of them can deliver one and the other two
 * are not "waiting" — they are two wake windows of radio spent to be
 * overwritten. Same collapse, and the same reasoning, as `sendLoveNote`'s
 * `supersedeQueuedNotes`; the ROTATION set is deliberately left alone, because
 * every entry there is a distinct file the user chose to add.
 */
export async function queueWallpaperForHandover(
    bmp: Uint8Array,
    target: MailboxWallpaperTarget,
    filename?: string,
    wallpaperId?: string
): Promise<string | null> {
    try {
        const item = await enqueueWallpaper(
            bmp,
            wallpaperId ?? mintWallpaperId(),
            target,
            filename
        );
        if (target === 'primary') {
            // Swallows its own failure: queuing SUCCEEDED, and that is what this
            // function reports. A stale extra primary is a wasted window, not a
            // lost picture.
            try {
                await supersedeQueuedPrimaryWallpapers(item.id);
            } catch (error) {
                console.warn('[Wallpaper] Could not retire the older queued sleep screens:', error);
            }
        }
        return item.id;
    } catch (error) {
        console.warn('[Wallpaper] Could not queue the wallpaper for handover:', error);
        return null;
    }
}

/**
 * Why this destination's mailbox cannot be used, or null when it can.
 *
 * The DECISION is `love_note_sender.isMailboxConfigured`, not re-derived, so a
 * note, a book and a wallpaper can never disagree about whether a mailbox is
 * usable. Only the WORDING is local, and it splits the same way `epub_sender`
 * does: "not set up at all" gets the canonical hint, while a URL that IS set but
 * malformed gets the specific defect — telling someone who already typed a URL
 * to go set one up tells them nothing about what is wrong with it.
 */
function describeWallpaperMailboxProblem(destination: WallpaperDestination): string | null {
    if (isMailboxConfigured(destination)) return null;
    const url = (destination?.mailboxUrl ?? '').trim();
    const token = (destination?.mailboxWriteToken ?? '').trim();
    if (!url || !token) return MAILBOX_SETUP_HINT;
    return describeMailboxUrlProblem(url) ?? MAILBOX_SETUP_HINT;
}

/**
 * Send one wallpaper by whichever route this phone has.
 *
 *   role 'client'  -> MAILBOX ONLY. A client has no LAN access to the reader by
 *                     definition, so there is nothing to fall back FROM; with no
 *                     mailbox configured the send fails with
 *                     {@link MAILBOX_SETUP_HINT} and never touches the network.
 *   role 'host'    -> DIRECT FIRST, mailbox as a fallback when the reader did not
 *                     answer and a mailbox is configured.
 *
 *                     "Direct first" means ASK first: when a mailbox fallback
 *                     exists, `reader_reachability` answers "is it awake?" from
 *                     ConnectionProvider's recent probe or a 2.5 s one of its
 *                     own, and a reader that is not answering is skipped. With
 *                     NO usable mailbox nothing is skipped — direct is the only
 *                     road there is, and a wrong probe must not turn a slow send
 *                     into a failed one.
 *
 * DIRECT IS STILL PREFERRED, and for a reason specific to this payload: only the
 * direct route can DELETE the old file first, which is what makes a re-write of
 * `/sleep.bmp` work at all (the firmware refuses to overwrite in place — see
 * DELETE BEFORE UPLOAD in the header). The mailbox route has no such problem
 * because the reader writes the file itself, but the immediate, verifiable
 * result is worth having when the reader is actually awake.
 *
 * THE TARGET AND THE NAME ARE RESOLVED ONCE, up front, so an unusable rotation
 * name fails identically on both roads and can never trigger a pointless
 * fallback — the mailbox would refuse it too, and a picture that reached the
 * mailbox under a name the reader cannot create is a silent, permanent failure.
 *
 * NEVER THROWS.
 */
export async function routeWallpaperSend(
    destination: WallpaperDestination,
    bmp: Uint8Array,
    target: WallpaperTarget,
    onProgress?: (percent: number) => void,
    options?: RouteWallpaperOptions
): Promise<RouteWallpaperResult> {
    const result = await routeWallpaperLegs(destination, bmp, target, onProgress, options);

    // THE HANDOVER QUEUE, last, for the reason `routeEpubSend` runs it last: it
    // delivers nothing by itself, so it can never make `success` true or fill in
    // `route`. It only converts a failed send from "the picture is lost" into
    // "the picture is on the phone and the reader takes it the next time the two
    // are in the same room" — with no internet on either side.
    const shouldQueue =
        options?.alwaysQueue === true || (!result.success && options?.queueOnFailure !== false);
    if (!shouldQueue) return result;

    const queuedId = await queueWallpaperForHandover(
        bmp,
        result.target,
        result.filename,
        // Reuse the mailbox id when there is one, so a wallpaper that is
        // half-published and later handed over is ONE item to the reader.
        result.wallpaperId ?? options?.wallpaperId
    );
    // Omitted rather than undefined, so a result that queued nothing is
    // byte-identical to what the routing legs returned.
    return queuedId ? { ...result, queuedId } : result;
}

/** The routing decision itself — everything {@link routeWallpaperSend} did before the queue. */
async function routeWallpaperLegs(
    destination: WallpaperDestination,
    bmp: Uint8Array,
    target: WallpaperTarget,
    onProgress?: (percent: number) => void,
    options?: RouteWallpaperOptions
): Promise<RouteWallpaperResult> {
    const attempts: WallpaperRouteAttempt[] = [];
    // Before anything is resolved: a caller that passed a garbage target gets a
    // result whose `target` field still has to say something, and 'primary' is
    // the one value that is never a guess about a NAME.
    const wireTarget: MailboxWallpaperTarget =
        target && (target as { kind?: string }).kind === 'set' ? 'set' : 'primary';

    if (!bmp || bmp.byteLength < 2 || bmp[0] !== BMP_MAGIC_B || bmp[1] !== BMP_MAGIC_M) {
        // The SAME guard `sendWallpaperBmp` applies, hoisted so it fires before a
        // route is chosen rather than once per road.
        return {
            success: false,
            error:
                'Wallpaper payload is not a BMP (expected a "BM" header from prepareWallpaperBmp).',
            attempts,
            target: wireTarget,
        };
    }

    const resolved = resolveWallpaperTarget(target);
    if (!resolved) {
        return {
            success: false,
            error:
                target && (target as { kind?: string }).kind === 'set'
                    ? `Unusable wallpaper name: ${JSON.stringify((target as { name?: unknown }).name ?? '')}`
                    : 'Unknown wallpaper target.',
            attempts,
            target: wireTarget,
        };
    }

    // A primary has NO name on the wire: its destination is the fixed
    // `/sleep.bmp`, and carrying `sleep.bmp` as a filename would invite a reader
    // to treat it as a rotation entry.
    const wireName = wireTarget === 'set' ? resolved.filename : undefined;

    // Tolerant of a settings blob written before the role existed, exactly like
    // every other read of it (role.ts).
    const role = asRole(destination?.role);
    const mailboxProblem = describeWallpaperMailboxProblem(destination);
    const onPhase = options?.onPhase;

    if (role === 'client') {
        if (mailboxProblem !== null) {
            // Nothing left the phone: a client has no direct route, and the
            // mailbox is not usable.
            return { success: false, error: mailboxProblem, attempts, target: wireTarget };
        }
        onPhase?.('mailbox');
        return sendWallpaperViaMailboxLeg(
            destination,
            bmp,
            wireTarget,
            wireName,
            attempts,
            onProgress,
            options
        );
    }

    // Host. Fast skip, and only where it is free — see `routeEpubLegs`.
    let reachability: ReaderReachability | null = null;
    if (mailboxProblem === null) {
        onPhase?.('looking');
        reachability = await resolveReaderReachability(destination.ip, options?.reachability);
    }

    if (reachability && !reachability.reachable) {
        // Nothing was TRIED against the reader, so no 'direct' attempt is
        // recorded — `attempts` stays a log of what actually ran.
        onPhase?.('mailbox');
        const skipped = await sendWallpaperViaMailboxLeg(
            destination,
            bmp,
            wireTarget,
            wireName,
            attempts,
            onProgress,
            options
        );
        if (skipped.success) return { ...skipped, skippedDirect: reachability };
        return {
            ...skipped,
            error: `Reader unreachable (${reachability.error || 'no answer'}); mailbox failed too: ${skipped.error}`,
            skippedDirect: reachability,
        };
    }

    onPhase?.('direct');
    const direct = await sendWallpaperBmp(destination.ip, bmp, target, onProgress);
    attempts.push({ route: 'direct', success: direct.success, error: direct.error });
    if (direct.success) {
        return {
            success: true,
            route: 'direct',
            attempts,
            target: wireTarget,
            filename: wireName,
        };
    }

    const directError = direct.error || 'Reader did not answer';

    if (!isDeviceUnreachableError(direct.error)) {
        // The reader ANSWERED and refused (a full card, a rejected overwrite).
        // Re-sending through the mailbox would hide a real device condition
        // behind a delayed delivery the user cannot see.
        return {
            success: false,
            error: directError,
            attempts,
            target: wireTarget,
            filename: wireName,
        };
    }

    // A dead upload is a stronger observation than the probe that preceded it.
    // Recorded so the next send skips the stall this one just paid for.
    noteReaderUnreachable(destination.ip, directError);

    if (mailboxProblem !== null) {
        return {
            success: false,
            error:
                mailboxProblem === MAILBOX_SETUP_HINT
                    ? `Reader unreachable (${directError}). ${MAILBOX_SETUP_HINT} to set a sleep screen while it is asleep.`
                    : `Reader unreachable (${directError}). Mailbox unusable: ${mailboxProblem}`,
            attempts,
            target: wireTarget,
            filename: wireName,
        };
    }

    onPhase?.('mailbox');
    const viaMailbox = await sendWallpaperViaMailboxLeg(
        destination,
        bmp,
        wireTarget,
        wireName,
        attempts,
        onProgress,
        options
    );
    if (viaMailbox.success) return viaMailbox;

    return {
        ...viaMailbox,
        error: `Reader unreachable (${directError}); mailbox failed too: ${viaMailbox.error}`,
    };
}

/** Shared mailbox leg. Appends its own attempt row. */
async function sendWallpaperViaMailboxLeg(
    destination: WallpaperDestination,
    bmp: Uint8Array,
    target: MailboxWallpaperTarget,
    filename: string | undefined,
    attempts: WallpaperRouteAttempt[],
    onProgress?: (percent: number) => void,
    options?: RouteWallpaperOptions
): Promise<RouteWallpaperResult> {
    const published = await publishWallpaper(
        (destination.mailboxUrl ?? '').trim(),
        (destination.mailboxWriteToken ?? '').trim(),
        bmp,
        target,
        filename,
        options?.wallpaperId,
        onProgress
    );
    attempts.push({ route: 'mailbox', success: published.success, error: published.error });

    if (published.success) {
        return {
            success: true,
            route: 'mailbox',
            attempts,
            target: published.target ?? target,
            // The SERVER's name, not ours: `X-Filename` is sanitized server-side,
            // so the name the reader will create can legitimately differ from the
            // one sent, and a UI reporting the name it asked for would name a
            // file that is not on the card. '' (a primary) stays undefined.
            filename: published.filename || filename,
            wallpaperId: published.id,
        };
    }
    return {
        success: false,
        error: published.error,
        attempts,
        target: published.target ?? target,
        filename: published.filename || filename,
        wallpaperId: published.id,
    };
}
