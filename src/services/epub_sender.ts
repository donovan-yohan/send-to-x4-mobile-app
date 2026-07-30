/**
 * epub_sender — put a book from the phone's storage onto the reader's library.
 *
 * ---------------------------------------------------------------------------
 * WHERE BOOKS ACTUALLY GO (verified against the firmware, 2026-07-29)
 * ---------------------------------------------------------------------------
 * There is NO `/books` directory in the CrossPoint firmware. `FileBrowserActivity`
 * starts at `basepath = "/"` (the SD ROOT) and lists whatever it finds one
 * directory at a time; a file is offered as openable purely by EXTENSION
 * (`FsHelpers::hasEpubExtension` -> `checkFileExtension(name, ".epub")`, which is
 * case-INSENSITIVE). So the library is "every readable file anywhere on the card
 * that is not hidden" — `loadFiles()` skips names beginning with '.' unless the
 * on-device `showHiddenFiles` setting is on.
 *
 * Two consequences this module is built around:
 *
 *   1. The destination is a NORMAL, NON-DOT folder. `/.books` would upload fine
 *      and then be invisible in the reader's own browser — the same class of
 *      silent failure as a stripped dot on `/.sleep` (R7), in the other
 *      direction. {@link resolveLibraryFolder} therefore refuses to resolve to
 *      the SD root or to anything hidden, unlike `wallpaper_sender`'s
 *      deliberately-empty `SD_ROOT_FOLDER`.
 *
 *   2. This module OWNS the path, as a constant, exactly like the other senders
 *      own theirs ({@link BOOKS_DIR}, next to `love_note_sender`'s
 *      `LOVE_NOTES_DIR` and `wallpaper_sender`'s `SLEEP_SET_DIR`). It is NOT
 *      settings-driven: `Settings.articleFolder` is a legacy key with no UI and
 *      no live reader (see `settings.ts`), and DeviceScreen imports the constant
 *      from here rather than declaring a second copy — a drift between the
 *      folder written and the folder scanned is a book that uploads fine and
 *      never appears in the app.
 *
 * ---------------------------------------------------------------------------
 * THE EXTENSION IS THE CONTRACT, NOT THE MIME TYPE
 * ---------------------------------------------------------------------------
 * The firmware never looks at content or at any metadata the phone knows: a book
 * is a book because its name ends in `.epub`. A picker's `mimeType` is therefore
 * a HINT, never a substitute — Android SAF providers routinely report
 * `application/octet-stream` for a perfectly good epub. So:
 *
 *   - a `.epub` name is accepted whatever the mime says;
 *   - a name WITHOUT the extension is accepted only when the mime positively
 *     says epub, and then the extension is APPENDED (see {@link resolveEpubFilename});
 *   - the stored extension is forced to lowercase `.epub`. The firmware would
 *     accept `.EPUB`, but `crosspoint_upload.listCrossPointFiles` filters with a
 *     case-SENSITIVE `name.endsWith('.epub')`, so an upper-case extension is a
 *     book that exists on the card and is missing from half the app's listings.
 *
 * ---------------------------------------------------------------------------
 * DELETE BEFORE UPLOAD — STILL REQUIRED (firmware re-checked 2026-07-29)
 * ---------------------------------------------------------------------------
 * `CrossPointWebServer::onWebSocketEvent` still answers
 * `ERROR:File already exists: <name>` and writes NOTHING when the target path is
 * already on the card (`Storage.exists(filePath)` guard on the `START:` frame).
 * So the same tolerant pre-delete `love_note_sender` and `wallpaper_sender` use
 * is applied here, for the same reason and in the same shape: delete, IGNORE the
 * result (a first upload has nothing to delete, and `deleteCrossPointFile`
 * reports the firmware's "not found" as `false`), then upload.
 *
 * NOTE THE SEMANTIC THIS BUYS, because it is not the same as it is for a fixed
 * slot: re-sending a book the reader already has REPLACES it, and the firmware
 * clears that book's cache for the path it just wrote, which drops the saved
 * reading position. That is the only sane reading of "send this book again", but
 * it is worth knowing before you re-send a half-read novel.
 *
 * ---------------------------------------------------------------------------
 * TWO ROUTES, ONE DESTINATION (M6)
 * ---------------------------------------------------------------------------
 * A book can reach the reader two ways, and {@link routeEpubSend} is the
 * orchestration a screen should call — the same shape as
 * `love_note_sender.sendLoveNote`, sharing its `isDeviceUnreachableError`
 * judgement so a sleeping reader is handled identically for notes and books:
 *
 *   DIRECT   ({@link sendEpubToReader}) — WS upload onto the SD card. Immediate,
 *            needs the phone on the reader's network AND the reader AWAKE.
 *   MAILBOX  ({@link sendEpubViaMailbox}) — leave the epub in the box the reader
 *            already polls. It appears in `books.txt`, and the reader pulls it
 *            over one or more wake windows (`Range` resume). Nothing new is
 *            provisioned on the device: same capability URL, same token as notes.
 *
 * A host tries DIRECT first and falls back to the mailbox only when the reader
 * DID NOT ANSWER; a reader that answered and refused is reported, never papered
 * over. A client has no LAN path at all and uses the mailbox only.
 *
 * WHAT "SUCCESS" MEANS DIFFERS BY ROUTE, and the UI must not flatten it: direct
 * means the bytes are on the card, mailbox means the book is queued and
 * {@link MAILBOX_LANDING_CLAUSE}. {@link describeEpubBatch} words both.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSPORT, THE PICKER AND THE FILE READER ARE ALL BEHIND SEAMS
 * ---------------------------------------------------------------------------
 * `crosspoint_upload.ts` statically imports `expo-file-system/legacy`,
 * `expo-document-picker` is a native module, and the mailbox route needs its own
 * read of the picked file; any of the three imported at the top of this file
 * would make every test below impossible to write. All three are reached through
 * the lazy-`require` seam `wallpaper_sender` / `love_note_sender` /
 * `message_history` already use — a plain static dependency to Metro, absent and
 * substitutable under node.
 *
 * `mailbox_client` needs NO seam: it is a pure wire module over `globalThis.fetch`
 * with no react-native import at all, which is why {@link publishBook} takes
 * BYTES and the read stays on this side of the boundary.
 *
 * NEVER THROWS. Every entry point reports failure in its return value
 * (`UploadResult` / `EpubBatchResult` / `EpubPickResult`), matching every other
 * sender in this repo, so callers need no try/catch.
 */

import type { Role, UploadResult } from '../types';
import { base64ToUint8Array } from '../utils/base64';
import { MAILBOX_SETUP_HINT, isDeviceUnreachableError, isMailboxConfigured } from './love_note_sender';
import { describeMailboxUrlProblem, mintBookId, publishBook } from './mailbox_client';
import { MAX_OUTBOX_BODY_BYTES, enqueueBook } from './outbox';
import {
    noteReaderUnreachable,
    resolveReaderReachability,
    type ReaderReachability,
    type ReaderReachabilityHint,
    type SendPhase,
} from './reader_reachability';
import { asRole } from './role';
import { sanitizeDevicePath } from './settings';

// ---------------------------------------------------------------------------
// Device contract
// ---------------------------------------------------------------------------

/** The one extension the firmware recognises as a book. Lowercase on the wire. */
export const EPUB_EXTENSION = '.epub';

/** Canonical epub mime type — what the document picker is asked for. */
export const EPUB_MIME_TYPE = 'application/epub+zip';

/**
 * Mime types that positively mean "this is an epub".
 *
 * Used ONLY to rescue a pick whose display name has no extension; a pick that
 * already ends in `.epub` never consults this list, because the firmware does
 * not either.
 */
const EPUB_MIME_TYPES = new Set([
    EPUB_MIME_TYPE,
    'application/x-epub+zip',
    'application/epub',
]);

/**
 * Mime filter for the picker's first attempt.
 *
 * `application/octet-stream` is in here deliberately: it is what a
 * DocumentsProvider hands back for a file whose extension it does not know, so a
 * filter of epub-only hides real books on some devices. The extension check runs
 * on every result regardless, so the cost of the wider filter is a rejected pick
 * with a clear reason, not a bad upload.
 */
export const EPUB_PICKER_TYPES = [EPUB_MIME_TYPE, 'application/octet-stream'];

/** Last-resort picker filter. See {@link pickEpubs}. */
export const ANY_FILE_TYPE = '*/*';

/**
 * The reader's library, as an absolute device path.
 *
 * THE ONE DECLARATION. DeviceScreen imports this for its Books scan root and its
 * delete fallback, the way it imports `LOVE_NOTES_DIR` from `love_note_sender` —
 * so "where books live" cannot be answered two different ways by the writer and
 * the reader of the same folder.
 */
export const BOOKS_DIR = '/books';

/**
 * {@link BOOKS_DIR} in `uploadToCrossPoint`'s vocabulary: root-relative, no
 * leading slash, because the transport builds the `/${folder}` prefix itself.
 *
 * Routed through `sanitizeDevicePath` rather than written as a second literal,
 * matching `wallpaper_sender.SLEEP_SET_FOLDER`.
 */
export const DEFAULT_LIBRARY_FOLDER = sanitizeDevicePath(BOOKS_DIR);

/**
 * Refuse to read a file bigger than this into memory.
 *
 * THIS IS A TRANSPORT LIMIT, NOT A FORMAT LIMIT, and it is deliberately far
 * below what an epub can be. `uploadLocalFileToCrossPoint`
 * (`crosspoint_upload.ts:191`) does not stream: it materialises the WHOLE file
 * as a base64 STRING (~4/3 of its size) and then AGAIN as a `Uint8Array`, so
 * peak footprint is roughly 2.4x the book with both copies live across an await.
 * On Hermes/Android that is an OOM CRASH — the process dies, there is no error
 * result to show — well before any cap that sounds like "a big epub".
 *
 * 8 MiB keeps that peak near 19 MiB while still covering real books by a wide
 * margin (a text novel is well under 2 MB; a heavily illustrated one a few MB).
 *
 * HONESTY ABOUT WHERE THE NUMBER COMES FROM: it is derived from the allocation
 * shape above, NOT measured on the X3-paired phone — the reader has been offline
 * for this work, so nothing here has been run against hardware. It is chosen to
 * sit far enough under any plausible failure point that it does not need to be.
 * RAISE IT ONLY AFTER `crosspoint_upload.ts` STREAMS (chunked read straight into
 * the 4 KB WS frames it already sends, so neither whole copy ever exists); that
 * is the real fix, it lives in the shared transport the note and wallpaper
 * senders also use, and it is not worked around here.
 *
 * KNOWN HOLE, unchanged and not closable from this module: the check needs a
 * size, and it is skipped entirely when the picker reports none — common for
 * Android SAF picks, which is exactly the case most likely to crash. Closing it
 * means stat-ing the copied cache file (`expo-file-system`), which belongs
 * behind the transport seam rather than in front of the picker.
 */
export const MAX_EPUB_BYTES = 8 * 1024 * 1024;

/** NUL / C0 / DEL. Written with escapes so the source stays plain ASCII. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Longest stem kept verbatim once the collision hash kicks in.
 *
 * `sanitizeDevicePath` caps a segment at 60 characters, so 50 + '-' + 8 hex = 59
 * leaves the hash inside the cap instead of being the part that gets truncated
 * away — the same budgeting as `wallpaper_sender.sleepSetNameForId`.
 */
const MAX_VERBATIM_STEM = 50;
const SEGMENT_CAP = 60;

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

/**
 * Normalize a library folder to what `uploadToCrossPoint` wants: root-relative,
 * no leading slash, never empty, never hidden.
 *
 * DIFFERENT RULE FROM `wallpaper_sender` ON PURPOSE. There, `''` means the SD
 * root and is the correct destination for `/sleep.bmp`. Here an empty or
 * dot-leading result is a silent bug: books at the root are outside the tree
 * DeviceScreen scans, and a dot-folder is skipped by the reader's own file
 * browser unless `showHiddenFiles` is on. Both fall back to
 * {@link DEFAULT_LIBRARY_FOLDER}.
 */
export function resolveLibraryFolder(folder?: string | null): string {
    const safe = sanitizeDevicePath(typeof folder === 'string' ? folder : '');
    if (!safe) return DEFAULT_LIBRARY_FOLDER;
    // Any hidden segment would hide the whole subtree from the reader's browser.
    if (safe.split('/').some(segment => segment.startsWith('.'))) return DEFAULT_LIBRARY_FOLDER;
    return safe;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** True when `name` already carries the extension the firmware looks for. */
export function hasEpubExtension(name: unknown): boolean {
    return typeof name === 'string' && name.trim().toLowerCase().endsWith(EPUB_EXTENSION);
}

/** Strip parameters/casing from a picker mime type ('APPLICATION/EPUB+ZIP; q=1'). */
function normalizeMimeType(mimeType: unknown): string {
    if (typeof mimeType !== 'string') return '';
    return mimeType.split(';')[0].trim().toLowerCase();
}

/** True when the picker positively claims this pick is an epub. */
export function isEpubMimeType(mimeType: unknown): boolean {
    return EPUB_MIME_TYPES.has(normalizeMimeType(mimeType));
}

/**
 * Turn a picked display name into the `<stem>.epub` that goes on the card, or
 * '' when it cannot be made safe.
 *
 * Rules, and why each one is a rule:
 *
 *   - A path SEPARATOR is REJECTED, not flattened. `sanitizeDevicePath` keeps
 *     nesting, so 'a/b.epub' would quietly become a second directory level
 *     outside the folder the caller asked for; flattening it to 'ab.epub' would
 *     just as quietly change which book the user thinks they sent. Same choice,
 *     for the same reason, as `wallpaper_sender.sanitizeSleepSetName`.
 *   - CONTROL CHARACTERS are rejected outright; they have no business in a FAT
 *     name and the WS protocol frames the name as text.
 *   - Everything else is NORMALIZED by `sanitizeDevicePath` (anything outside
 *     `[A-Za-z0-9._-]` becomes '-'). That also removes the one character the
 *     transport genuinely cannot survive: `START:<filename>:<size>:<path>` is
 *     parsed with `indexOf(':')`, so a ':' in a name would desynchronize the
 *     upload rather than fail it.
 *   - The extension is enforced lowercase and idempotently: 'x', 'x.epub' and
 *     'x.EPUB' all produce 'x.epub', so no caller can mint 'x.epub.epub'.
 *   - LEADING DOTS ARE STRIPPED off the stem, and a stem that is nothing but
 *     dots is REJECTED. This is the same rule {@link resolveLibraryFolder}
 *     applies to the destination folder, applied to the FILE — and it matters
 *     more here, not less. `FileBrowserActivity::loadFiles` skips any entry
 *     whose first byte is '.' unless the on-device `showHiddenFiles` setting is
 *     on, so '._Book.epub' (an AppleDouble sidecar name a card full of
 *     Mac-copied books is full of) or a deliberately-hidden '.hidden.epub'
 *     would upload perfectly and be unopenable on the reader. The app's own
 *     Books list would still SHOW it — `/api/files` does not filter dotfiles —
 *     so the user gets a listing that disagrees with their device and no reason
 *     why. Stripping is preferred to rejecting because the fix is unambiguous
 *     (a visible book with the same name) and costs the user nothing.
 *   - ANY stem the steps above CHANGED gets a hash of the raw stem appended.
 *     EVERY one of those steps is many-to-one, not just truncation: 'a b' and
 *     'a-b' both normalize to 'a-b', '.hidden' strips to 'hidden' which is also
 *     a name in its own right, and a long stem loses its tail. With
 *     delete-before-upload a collision does not fail — it silently REPLACES the
 *     other book — so the hash is what keeps two sources apart. A stem that
 *     survives sanitization untouched is already unique among untouched stems
 *     and stays verbatim, which is why ordinary books keep pretty names.
 *
 * @param mimeType Optional picker mime. Only consulted when `name` has no
 *                 extension: an epub mime then supplies one, anything else is a
 *                 rejection. Never used to override a `.epub` name.
 */
export function resolveEpubFilename(name: unknown, mimeType?: unknown): string {
    if (typeof name !== 'string') return '';
    const trimmed = name.trim();
    if (!trimmed) return '';

    // Reject rather than rewrite — see the doc comment.
    if (/[\/\\]/.test(trimmed)) return '';
    if (CONTROL_CHARS.test(trimmed)) return '';

    let rawStem: string;
    if (trimmed.toLowerCase().endsWith(EPUB_EXTENSION)) {
        rawStem = trimmed.slice(0, -EPUB_EXTENSION.length);
    } else if (isEpubMimeType(mimeType)) {
        // The picker vouched for the content; the firmware only needs the name.
        rawStem = trimmed;
    } else {
        return '';
    }

    const safeStem = sanitizeDevicePath(rawStem);
    // Single segment in, single segment out. sanitizeDevicePath drops '.'/'..'
    // segments, so '..epub' and '.epub' both land here as ''.
    if (!safeStem || safeStem.includes('/')) return '';

    // A DOT-LEADING NAME IS A BOOK THE READER CANNOT OPEN. FileBrowserActivity
    // skips any entry whose first byte is '.' unless showHiddenFiles is on, and
    // /api/files does NOT filter dotfiles — so without this the app lists a book
    // the device refuses to offer. Strip the dots; reject only when nothing
    // visible is left ('....epub' -> stem '...' -> '').
    const visible = safeStem.replace(/^\.+/, '');
    if (!visible) return '';

    // EVERY STEP ABOVE IS MANY-TO-ONE, SO EVERY STEP CAN MERGE TWO BOOKS INTO
    // ONE PATH — and with the pre-delete in sendEpubToReader a merge does not
    // fail, it overwrites. Truncation is only the loudest case:
    //
    //   'Dune: Two.epub' and 'Dune, Two.epub' -> 'Dune-Two'   (charset)
    //   '.hidden.epub'   and 'hidden.epub'    -> 'hidden'      (dot strip)
    //   two long titles sharing 60 characters                  (cap)
    //
    // So the hash is keyed on WHETHER SANITIZATION CHANGED ANYTHING, not on how
    // it changed it. `visible !== rawStem` covers all three in one comparison,
    // because `visible` is the end of the whole pipeline and `rawStem` its
    // input. The `safeStem.length >= SEGMENT_CAP` arm is kept as well: a stem
    // sitting exactly ON the cap lost nothing (so it is not "changed") but is
    // one character away from the budget the appended hash is sized for, and
    // hashing it keeps the emitted name inside the same length envelope as
    // before.
    //
    // The length test is on `safeStem`, NOT on `visible`: stripping a leading
    // dot shortens the string without making it any less truncated.
    //
    // The hash input is `rawStem` — the stem before every lossy step, with the
    // extension already off — NOT `trimmed`. Keying it on `trimmed` would make
    // 'Dune: Two.epub' and 'Dune: Two.EPUB' two different books on the card,
    // when the whole point of the case-insensitive extension check above is
    // that they are one.
    const changed = visible !== rawStem;
    const atCap = safeStem.length >= SEGMENT_CAP;
    const stem = changed || atCap ? disambiguatedStem(visible, rawStem) : visible;

    return `${stem}${EPUB_EXTENSION}`;
}

/**
 * `<up-to-50-chars-of-visible>-<hash of the raw stem>`, the name a MUTATED stem
 * goes to the card under.
 *
 * Trailing separators are trimmed off the verbatim part so the join reads as one
 * '-' ('Dune-1965-' + hash, not 'Dune-1965--' + hash), and a verbatim part that
 * trims away to nothing degrades to the bare hash rather than emitting a
 * '-'-leading name.
 */
function disambiguatedStem(visible: string, rawStem: string): string {
    const verbatim = visible.slice(0, MAX_VERBATIM_STEM).replace(/-+$/, '');
    const hash = fnv1a32Hex(rawStem);
    return verbatim ? `${verbatim}-${hash}` : hash;
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

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

/**
 * One file the user chose, in the shape `expo-document-picker` reports it
 * (`DocumentPickerAsset`), narrowed to the fields this module uses.
 */
export interface EpubPick {
    /** Local URI to read. A `file://` path after `copyToCacheDirectory`. */
    uri: string;
    /** Display name from the provider — the source of the device filename. */
    name: string;
    /** Bytes, when the provider reported it. Drives the size guard only. */
    size?: number;
    /** Provider mime type. A hint; see the module header. */
    mimeType?: string;
}

/** A pick that was thrown away, with the reason to show the user. */
export interface RejectedEpubPick {
    name: string;
    reason: string;
}

/**
 * Coerce one raw picker asset into an {@link EpubPick}, or null when it is not
 * even shaped like one.
 *
 * The picker is a native module returning JSON-ish values, so this validates
 * rather than trusts: a missing `uri` is the difference between a clear
 * "couldn't read that file" and an upload of the string 'undefined'.
 */
export function normalizeEpubPick(raw: unknown): EpubPick | null {
    if (!raw || typeof raw !== 'object') return null;
    const asset = raw as { uri?: unknown; name?: unknown; size?: unknown; mimeType?: unknown };
    const uri = typeof asset.uri === 'string' ? asset.uri.trim() : '';
    if (!uri) return null;

    // A provider that reports no display name still gives a URI; its last
    // segment is the only name we have, and it is better than nothing.
    const rawName = typeof asset.name === 'string' && asset.name.trim() ? asset.name.trim() : '';
    const name = rawName || lastUriSegment(uri);
    if (!name) return null;

    const pick: EpubPick = { uri, name };
    if (typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size >= 0) {
        pick.size = asset.size;
    }
    if (typeof asset.mimeType === 'string' && asset.mimeType.trim()) {
        pick.mimeType = asset.mimeType.trim();
    }
    return pick;
}

function lastUriSegment(uri: string): string {
    const withoutQuery = uri.split(/[?#]/)[0];
    const segment = withoutQuery.split('/').filter(Boolean).pop() ?? '';
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Why this pick cannot be uploaded, or null when it can.
 *
 * Returns SENTENCES, not codes: every caller of this is a user-facing list of
 * "these ones didn't go", and a per-file reason is the whole point of that list.
 */
export function describeEpubPickProblem(pick: EpubPick | null | undefined): string | null {
    if (!pick || typeof pick !== 'object') return 'Not a file the picker could return.';
    if (typeof pick.uri !== 'string' || !pick.uri.trim()) return 'No readable location for this file.';

    const name = typeof pick.name === 'string' ? pick.name.trim() : '';
    if (!name) return 'No filename.';

    if (!hasEpubExtension(name) && !isEpubMimeType(pick.mimeType)) {
        return 'Not an .epub file.';
    }
    if (!resolveEpubFilename(name, pick.mimeType)) {
        return `Unusable filename: ${JSON.stringify(name)}`;
    }
    if (typeof pick.size === 'number' && Number.isFinite(pick.size) && pick.size > MAX_EPUB_BYTES) {
        return `Too big to send (${formatMb(pick.size)}; limit ${formatMb(MAX_EPUB_BYTES)}).`;
    }
    return null;
}

function formatMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Split raw picker assets into what can be sent and what cannot.
 *
 * Exists as its own function because it is the whole of the wildcard-filter
 * story: when the picker had to be opened to every file type ({@link
 * ANY_FILE_TYPE}), THIS is what keeps a PDF out of the library, and it has to
 * behave identically whether the filter was narrow or wide.
 */
export function filterEpubPicks(rawAssets: unknown): { picks: EpubPick[]; rejected: RejectedEpubPick[] } {
    const picks: EpubPick[] = [];
    const rejected: RejectedEpubPick[] = [];
    if (!Array.isArray(rawAssets)) return { picks, rejected };

    for (const raw of rawAssets) {
        const pick = normalizeEpubPick(raw);
        if (!pick) {
            rejected.push({ name: describeUnknownAsset(raw), reason: 'Not a file the picker could return.' });
            continue;
        }
        const problem = describeEpubPickProblem(pick);
        if (problem) {
            rejected.push({ name: pick.name, reason: problem });
            continue;
        }
        picks.push(pick);
    }
    return { picks, rejected };
}

function describeUnknownAsset(raw: unknown): string {
    if (raw && typeof raw === 'object') {
        const name = (raw as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return 'Unnamed file';
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of `crosspoint_upload` this module needs.
 *
 * `uploadLocalFile` maps to `uploadLocalFileToCrossPoint`, NOT to
 * `uploadToCrossPoint`: that function is the one that already reads a local URI
 * through `expo-file-system/legacy` + `base64ToUint8Array` and streams the bytes
 * over the same WS transport. Re-implementing the read here would fork the one
 * place that knows an epub arrives as base64.
 */
export interface EpubTransport {
    uploadLocalFile(
        ip: string,
        fileUri: string,
        filename: string,
        onProgress: ((percent: number) => void) | undefined,
        targetFolder: string
    ): Promise<UploadResult>;
    deleteFile(ip: string, filename: string, targetFolder: string): Promise<boolean>;
}

/** The slice of `expo-document-picker` this module needs. */
export interface EpubPickerOptions {
    type: string | string[];
    multiple: boolean;
    copyToCacheDirectory: boolean;
}

export interface EpubPickerModule {
    getDocumentAsync(options: EpubPickerOptions): Promise<{
        canceled?: boolean;
        assets?: unknown;
    }>;
}

/**
 * Reading a picked file's BYTES — needed only by the mailbox route.
 *
 * The direct route never uses this: `uploadLocalFileToCrossPoint` takes a URI and
 * does its own read, and going through a second reader here would fork the one
 * place that knows an epub arrives as base64. The MAILBOX route needs the bytes
 * in hand, because `publishBook` deliberately has no expo/react-native
 * dependency — `mailbox_client` is a pure wire module and must stay node-testable.
 *
 * SAME MEMORY SHAPE, SAME LIMIT. The implementation below materialises the whole
 * file as a base64 STRING and again as a `Uint8Array`, exactly like the transport
 * does, so the {@link MAX_EPUB_BYTES} reasoning (peak ~2.4x the book, OOM on
 * Hermes past it) applies to this route unchanged — the mailbox's own 24 MiB cap
 * is NOT the binding constraint on a phone.
 */
export interface EpubFileReader {
    readBytes(fileUri: string): Promise<Uint8Array>;
}

// Metro defines `require` in every module and collects `require('<literal>')`
// statically, so the lazy loads below are normal bundle dependencies. Under
// node's ESM loader the identifier does not exist — `typeof` on an undeclared
// name is safe, and the module degrades to "no transport / no picker" instead of
// failing to import.
declare const require: ((id: string) => unknown) | undefined;

let transport: EpubTransport | null = null;
let transportResolved = false;

/**
 * Replace the transport. Pass `null` to restore the CrossPoint default.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setEpubTransport(next: EpubTransport | null): void {
    transport = next;
    transportResolved = next !== null;
}

function getTransport(): EpubTransport | null {
    if (!transportResolved) {
        transport = loadCrossPointTransport();
        transportResolved = true;
    }
    return transport;
}

function loadCrossPointTransport(): EpubTransport | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('./crosspoint_upload') as {
            uploadLocalFileToCrossPoint?: unknown;
            deleteCrossPointFile?: unknown;
        };
        if (
            mod &&
            typeof mod.uploadLocalFileToCrossPoint === 'function' &&
            typeof mod.deleteCrossPointFile === 'function'
        ) {
            const upload = mod.uploadLocalFileToCrossPoint as EpubTransport['uploadLocalFile'];
            const deleteFile = mod.deleteCrossPointFile as EpubTransport['deleteFile'];
            return {
                uploadLocalFile: (ip, fileUri, filename, onProgress, targetFolder) =>
                    upload(ip, fileUri, filename, onProgress, targetFolder),
                deleteFile: (ip, filename, targetFolder) => deleteFile(ip, filename, targetFolder),
            };
        }
    } catch {
        // Not a React Native runtime (node test, web preview). Handled by callers.
    }
    return null;
}

let picker: EpubPickerModule | null = null;
let pickerResolved = false;

/**
 * Replace the document picker. Pass `null` to restore `expo-document-picker`.
 *
 * TEST SEAM — the app never calls this. The picker is a native module, so this
 * is what lets the multi-select / filter / fallback logic run under node.
 */
export function __setEpubPicker(next: EpubPickerModule | null): void {
    picker = next;
    pickerResolved = next !== null;
}

function getPicker(): EpubPickerModule | null {
    if (!pickerResolved) {
        picker = loadDocumentPicker();
        pickerResolved = true;
    }
    return picker;
}

function loadDocumentPicker(): EpubPickerModule | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('expo-document-picker') as { getDocumentAsync?: unknown };
        if (mod && typeof mod.getDocumentAsync === 'function') {
            return mod as EpubPickerModule;
        }
    } catch {
        // Native module absent (node test, web preview). Handled by callers.
    }
    return null;
}

let fileReader: EpubFileReader | null = null;
let fileReaderResolved = false;

/**
 * Replace the file reader. Pass `null` to restore `expo-file-system/legacy`.
 *
 * TEST SEAM — the app never calls this. It is what lets the whole mailbox route
 * (read -> publish) run under node with no expo module present.
 */
export function __setEpubFileReader(next: EpubFileReader | null): void {
    fileReader = next;
    fileReaderResolved = next !== null;
}

function getFileReader(): EpubFileReader | null {
    if (!fileReaderResolved) {
        fileReader = loadExpoFileReader();
        fileReaderResolved = true;
    }
    return fileReader;
}

function loadExpoFileReader(): EpubFileReader | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('expo-file-system/legacy') as {
            readAsStringAsync?: (uri: string, options?: { encoding?: string }) => Promise<string>;
            EncodingType?: { Base64?: string };
        };
        if (mod && typeof mod.readAsStringAsync === 'function') {
            const read = mod.readAsStringAsync;
            // `EncodingType.Base64` is the documented constant, but it is just the
            // string 'base64'; falling back to the literal keeps the read working
            // if the enum ever moves, rather than silently reading UTF-8 text and
            // publishing a corrupted book.
            const encoding = mod.EncodingType?.Base64 ?? 'base64';
            return {
                async readBytes(fileUri: string) {
                    return base64ToUint8Array(await read(fileUri, { encoding }));
                },
            };
        }
    } catch {
        // Not a React Native runtime (node test, web preview). Handled by callers.
    }
    return null;
}

const NO_TRANSPORT_ERROR = 'Device transport unavailable in this runtime.';
const NO_PICKER_ERROR = 'File picker unavailable in this runtime.';
const NO_FILE_READER_ERROR = 'File reader unavailable in this runtime.';

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export interface EpubPickResult {
    /** True when the user dismissed the picker. Not an error. */
    canceled: boolean;
    /** Everything that survived {@link describeEpubPickProblem}. */
    picks: EpubPick[];
    /** Everything that did not, with a reason each. */
    rejected: RejectedEpubPick[];
    /** Set only when the picker itself failed. */
    error?: string;
}

/**
 * Ask the user for one or more epubs.
 *
 * TWO ATTEMPTS, and the second one is not cosmetic. The narrow mime filter is
 * what makes the picker usable, but some Android DocumentsProviders reject an
 * unknown type filter outright — and a picker that THREW is indistinguishable,
 * to the user, from a feature that does not work. So a throw (never a cancel;
 * cancelling is a decision, and re-prompting over it would be hostile) retries
 * once with {@link ANY_FILE_TYPE}, and the extension filter is what keeps that
 * wide open door honest.
 *
 * NEVER THROWS.
 */
export async function pickEpubs(): Promise<EpubPickResult> {
    const p = getPicker();
    if (!p) return { canceled: false, picks: [], rejected: [], error: NO_PICKER_ERROR };

    let result: { canceled?: boolean; assets?: unknown };
    try {
        result = await p.getDocumentAsync({
            type: EPUB_PICKER_TYPES,
            multiple: true,
            // Required, not an optimisation: a SAF `content://` URI is not
            // readable by expo-file-system's legacy readAsStringAsync. Copying
            // gives us a `file://` path in the cache.
            copyToCacheDirectory: true,
        });
    } catch (firstError) {
        try {
            result = await p.getDocumentAsync({
                type: ANY_FILE_TYPE,
                multiple: true,
                copyToCacheDirectory: true,
            });
        } catch (fallbackError) {
            return {
                canceled: false,
                picks: [],
                rejected: [],
                error: `Could not open the file picker: ${describeError(fallbackError)} (first attempt: ${describeError(firstError)})`,
            };
        }
    }

    if (!result || typeof result !== 'object') {
        return { canceled: false, picks: [], rejected: [], error: 'File picker returned nothing.' };
    }
    if (result.canceled === true) {
        return { canceled: true, picks: [], rejected: [] };
    }

    const { picks, rejected } = filterEpubPicks(result.assets);
    // An empty, non-cancelled result is the picker's other way of saying
    // "nothing chosen"; treat it as a cancel so callers have one quiet path.
    if (picks.length === 0 && rejected.length === 0) {
        return { canceled: true, picks: [], rejected: [] };
    }
    return { canceled: false, picks, rejected };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendEpubOptions {
    /** Root-relative destination. Defaults to {@link DEFAULT_LIBRARY_FOLDER}. */
    targetFolder?: string;
    /** Picker mime type, used only to rescue an extensionless name. */
    mimeType?: string;
    /** Bytes, when known. Enables the {@link MAX_EPUB_BYTES} guard. */
    sizeBytes?: number;
}

/**
 * Upload one epub from a local URI into the reader's library folder.
 *
 * The target path is DELETED first and the delete's result is IGNORED — see
 * DELETE BEFORE UPLOAD in the header. Without it, re-sending a book the reader
 * already has comes back as the firmware's raw 'File already exists' with
 * nothing written.
 *
 * NEVER THROWS. A bad extension, an unusable name and a dead socket all come
 * back as `{ success: false, error }`.
 */
export async function sendEpubToReader(
    ip: string,
    fileUri: string,
    filename: string,
    onProgress?: (percent: number) => void,
    options?: SendEpubOptions
): Promise<UploadResult> {
    if (typeof fileUri !== 'string' || !fileUri.trim()) {
        return { success: false, error: 'No file to send.' };
    }

    const problem = describeEpubPickProblem({
        uri: fileUri,
        name: typeof filename === 'string' ? filename : '',
        mimeType: options?.mimeType,
        size: options?.sizeBytes,
    });
    if (problem) return { success: false, error: problem };

    const safeName = resolveEpubFilename(filename, options?.mimeType);
    // describeEpubPickProblem already proved this resolves; the guard keeps the
    // invariant local rather than implied.
    if (!safeName) return { success: false, error: `Unusable filename: ${JSON.stringify(filename)}` };

    const folder = resolveLibraryFolder(options?.targetFolder);

    const t = getTransport();
    if (!t) return { success: false, error: NO_TRANSPORT_ERROR };

    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log(`[EpubSender] Sending ${safeName} to /${folder} (ip=${ip}, from=${fileUri})`);
    }

    // 1. Clear the target path. The firmware REFUSES to overwrite and writes
    //    nothing (CrossPointWebServer's `Storage.exists` guard on the START
    //    frame, re-read 2026-07-29), so without this a re-send of a book already
    //    on the card fails and the user is told the file exists — true, but not
    //    what they asked for.
    //
    //    A FALSE result is EXPECTED and deliberately ignored: the ordinary case
    //    is that there is nothing to delete, and `deleteCrossPointFile` reports
    //    any non-OK status — including the firmware's "not found" — as false. If
    //    the file really is still there, the upload's own 'File already exists'
    //    is the accurate, user-visible report.
    //
    //    The try/catch is this function's NEVER-THROWS contract, which must not
    //    depend on the transport swallowing its own network errors.
    try {
        const cleared = await t.deleteFile(ip, safeName, folder);
        if (typeof __DEV__ !== 'undefined' && __DEV__ && !cleared) {
            console.log(`[EpubSender] No previous /${folder}/${safeName} to clear (new book, or the device reported none)`);
        }
    } catch (error) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(`[EpubSender] Pre-upload delete threw, continuing to upload: ${String(error)}`);
        }
    }

    try {
        // 2. uploadLocalFileToCrossPoint runs ensureFolderExistsCrossPoint, reads
        // the URI as base64 and streams it over WS.
        //
        // KNOWN GAP, shared with every other sender (crosspoint_upload.ts:203):
        // the folder-creation result is logged and then discarded, so a library
        // folder that genuinely cannot be created surfaces as the firmware's raw
        // 'ERROR:<...>' rather than "could not create /<folder>". Tracked there,
        // not worked around here.
        return await t.uploadLocalFile(ip, fileUri, safeName, onProgress, folder);
    } catch (error) {
        return { success: false, error: describeError(error) };
    }
}

// ---------------------------------------------------------------------------
// Mailbox route
// ---------------------------------------------------------------------------

export interface SendEpubViaMailboxOptions {
    /** Picker mime type, used only to rescue an extensionless name. */
    mimeType?: string;
    /** Bytes, when known. Enables the {@link MAX_EPUB_BYTES} guard early. */
    sizeBytes?: number;
    /**
     * Reuse an id to RETRY the same book. Minted when absent.
     *
     * Re-POSTing an id OVERWRITES that book, which is what makes a retry after a
     * timeout safe rather than a duplicate. Never reuse an id for DIFFERENT
     * content: a reader mid-resume compares the size it read from `books.txt`
     * against every `Content-Range` and has to start over when they disagree.
     */
    bookId?: string;
}

/** `UploadResult` plus what the mailbox stored. */
export interface MailboxEpubResult extends UploadResult {
    /** The name the mailbox stored — the name the reader will create. */
    filename?: string;
    /** The mailbox's id for this book; the handle for a retry or a delete. */
    bookId?: string;
    /** Bytes the mailbox reported storing. */
    bytes?: number;
}

/**
 * Leave one epub in the mailbox for the reader to collect.
 *
 * ---------------------------------------------------------------------------
 * THE NAME IS DECIDED HERE, ONCE, FOR BOTH ROUTES
 * ---------------------------------------------------------------------------
 * This runs the SAME {@link describeEpubPickProblem} + {@link resolveEpubFilename}
 * pipeline as {@link sendEpubToReader}, deliberately, even though the mailbox
 * server sanitizes `X-Filename` too. Two reasons:
 *
 *   1. The reader creates the file from the name in `books.txt`, so every rule
 *      that exists because of the FIRMWARE — lowercase `.epub` (the app's own
 *      listing filter is case-sensitive), no leading dot (FileBrowserActivity
 *      hides it), the collision hash — has to hold on this route as well. The
 *      mailbox's sanitizer knows none of them; it only knows what is safe to
 *      store and to put in a manifest line.
 *   2. A book must arrive under the SAME name whichever route carried it.
 *      Otherwise a fallback would silently produce a second copy of a book the
 *      user already sent, under a different name, and the direct-path delete
 *      that normally replaces it would miss.
 *
 * `targetFolder` is deliberately NOT a parameter: on this route the destination
 * is the reader's own library, chosen by the firmware when it drains the
 * manifest. Accepting a folder here would imply the app can place a book
 * somewhere the mailbox contract has no way to express.
 *
 * NEVER THROWS.
 */
export async function sendEpubViaMailbox(
    mailboxUrl: string,
    writeToken: string,
    fileUri: string,
    filename: string,
    onProgress?: (percent: number) => void,
    options?: SendEpubViaMailboxOptions
): Promise<MailboxEpubResult> {
    if (typeof fileUri !== 'string' || !fileUri.trim()) {
        return { success: false, error: 'No file to send.' };
    }

    const problem = describeEpubPickProblem({
        uri: fileUri,
        name: typeof filename === 'string' ? filename : '',
        mimeType: options?.mimeType,
        size: options?.sizeBytes,
    });
    if (problem) return { success: false, error: problem };

    const safeName = resolveEpubFilename(filename, options?.mimeType);
    if (!safeName) return { success: false, error: `Unusable filename: ${JSON.stringify(filename)}` };

    const reader = getFileReader();
    if (!reader) return { success: false, error: NO_FILE_READER_ERROR };

    // 0 before the READ, not before the publish: on a multi-megabyte book the
    // read is a visible part of the wait, and a bar that only starts moving
    // afterwards looks stuck.
    onProgress?.(0);

    let bytes: Uint8Array;
    try {
        bytes = await reader.readBytes(fileUri);
    } catch (error) {
        return { success: false, error: `Could not read ${safeName}: ${describeError(error)}` };
    }
    if (!bytes || bytes.byteLength === 0) {
        // A silent empty read is the failure mode this catches: the mailbox would
        // answer 400 and the user would be told the SERVER refused their book.
        return { success: false, error: `Could not read ${safeName} (0 bytes).` };
    }

    // publishBook re-checks the length against the MAILBOX cap. That check is the
    // one that matters and it is NOT duplicated here: it is the first point where
    // the real size is known, since the picker often reports none.
    //
    // MAX_EPUB_BYTES is deliberately NOT re-applied to the read result. It exists
    // to keep the phone from allocating ~2.4x a huge book — and by here that
    // allocation has already happened and SURVIVED, so refusing the book now would
    // cost the user a delivery the mailbox can perfectly well accept while
    // preventing nothing. The guard's only useful position is in front of the
    // read, where `describeEpubPickProblem` applies it whenever a size is known.
    const published = await publishBook(
        mailboxUrl,
        writeToken,
        bytes,
        safeName,
        options?.bookId,
        onProgress
    );

    return {
        success: published.success,
        error: published.error,
        filename: published.filename || safeName,
        bookId: published.id,
        bytes: published.bytes,
    };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Which of the two routes a book actually travelled.
 *
 * Called `route`, not `path` as in `love_note_sender`: in THIS module 'path'
 * already means a device path (`BOOKS_DIR`, `targetFolder`, `resolveEpubFilename`),
 * and one word meaning both an SD-card location and a delivery mechanism is how
 * a caller ends up reading the wrong one.
 */
export type EpubRoute = 'direct' | 'mailbox';

/**
 * Human wording per route, so every surface describes a route the same way.
 *
 * The DISTINCTION is load-bearing, not flavour: 'direct' means the bytes are on
 * the card now, 'mailbox' means the reader collects them at a later sync — and a
 * big book crosses SEVERAL wake windows, so "sent" would be a promise the
 * contract cannot keep.
 */
export const EPUB_ROUTE_LABEL: Record<EpubRoute, string> = {
    direct: 'On the reader',
    mailbox: 'In the mailbox',
};

/**
 * The one wording for what a mailbox delivery means, as a constant.
 *
 * Single literal so the batch summary, DeviceScreen and any later surface cannot
 * drift into promising different things about the same book.
 */
export const MAILBOX_LANDING_CLAUSE = 'will land on the reader next sync';

/** One route attempt, in the order it was tried. */
export interface EpubRouteAttempt {
    route: EpubRoute;
    success: boolean;
    error?: string;
}

/**
 * The settings a send depends on, as a plain structure.
 *
 * Structurally identical to `love_note_sender.LoveNoteDestination` on purpose —
 * the two routes are chosen from the SAME four facts, and `isMailboxConfigured`
 * is shared across both — but declared here so a caller of this module does not
 * have to import a love-note type to send a book.
 */
export interface EpubDestination {
    role: Role;
    /** Reader host for the direct route (already normalised, e.g. getCurrentIp). */
    ip: string;
    /** Mailbox base URL. Empty/absent means "no mailbox configured". */
    mailboxUrl?: string;
    /** Mailbox bearer token. NEVER part of mailboxUrl — see mailbox_client. */
    mailboxWriteToken?: string;
}

/** `UploadResult` plus which route delivered the book. */
export interface RouteEpubResult extends UploadResult {
    /** The route that delivered it. Absent when nothing delivered it. */
    route?: EpubRoute;
    /** Every route tried, in order — so the UI can say "reader was asleep". */
    attempts: EpubRouteAttempt[];
    /** The name the book landed under. */
    filename?: string;
    /** Mailbox id, on the mailbox route only. */
    bookId?: string;
    /**
     * Outbox id, when the book was ALSO parked on this phone for handover.
     *
     * Present means a copy of the epub is on local disk and the next peer-link
     * session serves it to the reader with `Range` resume, no internet, no
     * further taps. Absent means the queue was not usable in this runtime or the
     * caller opted out.
     */
    queuedId?: string;
    /**
     * The reachability answer that made this send SKIP the direct route.
     *
     * Present ONLY on the fast skip, so a result that routed the way it always
     * has is byte-identical to what this function has always returned. Its
     * absence means "direct was tried, or there was nothing to try" — never "the
     * reader was reachable".
     */
    skippedDirect?: ReaderReachability;
}

export interface RouteEpubOptions extends SendEpubOptions {
    /** Mailbox id to reuse for a retry. See {@link SendEpubViaMailboxOptions}. */
    bookId?: string;
    /**
     * Park the book in the outbox when no route delivered it. Default TRUE.
     *
     * The auto-arm, and it matters more for books than for notes: a book is the
     * thing a user picks specifically because they are about to be somewhere
     * without internet.
     */
    queueOnFailure?: boolean;
    /** Park it even when a route DID deliver it. Default false. */
    alwaysQueue?: boolean;
    /**
     * Narration for the UI, called once per phase in the order they happen.
     *
     * SEPARATE FROM `onProgress`: a percent only exists on the direct route (WS
     * `PROGRESS:` acks), while a phase always exists and is the only honest thing
     * to show during the seconds when nothing measurable is happening. Same
     * vocabulary as the note path — see `reader_reachability.SendPhase`.
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
 * Park one epub in the outbox. Best-effort, NEVER throws, returns the id or null.
 *
 * The COPY is made natively (`enqueueBook`), so a 24 MiB book never becomes a JS
 * string — the allocation shape HANDOFF.md records as an OOM process crash.
 */
export async function queueEpubForHandover(
    fileUri: string,
    filename: string,
    bookId?: string,
    sizeBytes?: number
): Promise<string | null> {
    // The same name-resolution pipeline both routes use: a queued book must land
    // under the name the direct route would have created, or a later direct send
    // produces a SECOND copy of a book the user already has.
    const safeName = resolveEpubFilename(filename);
    if (!safeName) return null;
    // Checked before the copy WHEN A SIZE IS KNOWN, so an oversized pick costs
    // nothing. `enqueueBook` re-checks the measured size afterwards, which is the
    // check that actually holds — the picker reports no size at all for most
    // Android SAF picks.
    if (typeof sizeBytes === 'number' && sizeBytes > MAX_OUTBOX_BODY_BYTES) return null;
    try {
        const item = await enqueueBook(fileUri, safeName, bookId ?? mintBookId());
        return item.id;
    } catch (error) {
        console.warn('[Epub] Could not queue the book for handover:', error);
        return null;
    }
}

/**
 * Why this destination's mailbox cannot be used, or null when it can.
 *
 * The DECISION is `love_note_sender.isMailboxConfigured`, not re-derived here, so
 * a book and a note can never disagree about whether a mailbox is usable. Only
 * the WORDING is local: "not configured at all" gets the one canonical hint,
 * while a URL that IS set but malformed gets the specific defect — telling
 * someone who already typed a URL to "set up mailbox in Settings" tells them
 * nothing about what is wrong with it.
 */
function describeMailboxProblem(destination: EpubDestination): string | null {
    if (isMailboxConfigured(destination)) return null;
    const url = (destination?.mailboxUrl ?? '').trim();
    const token = (destination?.mailboxWriteToken ?? '').trim();
    if (!url || !token) return MAILBOX_SETUP_HINT;
    return describeMailboxUrlProblem(url) ?? MAILBOX_SETUP_HINT;
}

/**
 * Send one book by whichever route this phone has.
 *
 *   role 'client'  -> MAILBOX ONLY. A client has no LAN access to the reader by
 *                     definition, so there is nothing to fall back FROM; with no
 *                     mailbox configured the send fails with
 *                     {@link MAILBOX_SETUP_HINT} and never touches the network.
 *   role 'host'    -> DIRECT FIRST, mailbox as a fallback when the reader did
 *                     not answer and a mailbox is configured. Direct is
 *                     preferred because the book is on the card when it returns
 *                     and the host is on the same network; the fallback exists
 *                     because the reader is ASLEEP most of the time, which is
 *                     not an error worth showing a user who just wants the book
 *                     on their reader.
 *
 *                     "Direct first" means ASK first: when a mailbox fallback
 *                     exists, `reader_reachability` answers "is it awake?" from
 *                     ConnectionProvider's recent probe or a 2.5 s one of its
 *                     own, and a reader that is not answering is skipped. Trying
 *                     anyway cost ~15-25 s of stacked mkdir/WebSocket timeouts
 *                     PER BOOK. With NO usable mailbox nothing is skipped.
 *
 * MIRRORS `sendLoveNote` DELIBERATELY, down to sharing
 * `isDeviceUnreachableError`: a reader that ANSWERED and refused (a full card, a
 * rejected overwrite) must NOT be papered over with a delayed delivery the user
 * cannot see, and that judgement must be identical for notes and books or the
 * same asleep reader would be handled two different ways.
 *
 * THE NAME AND THE SIZE ARE CHECKED ONCE, up front, so an unusable pick fails
 * identically on both routes and can never trigger a pointless fallback — the
 * mailbox would reject it too, and a book that reaches the mailbox under a name
 * the reader cannot create is a silent, permanent failure.
 *
 * NEVER THROWS.
 */
export async function routeEpubSend(
    destination: EpubDestination,
    fileUri: string,
    filename: string,
    onProgress?: (percent: number) => void,
    options?: RouteEpubOptions
): Promise<RouteEpubResult> {
    const result = await routeEpubLegs(destination, fileUri, filename, onProgress, options);

    // THE HANDOVER QUEUE, and it runs last for the same reason as in
    // `sendLoveNote`: it delivers nothing by itself, so it can never make
    // `success` true or fill in `route`. It only converts a failed send from "the
    // book is lost" into "the book is on the phone and the reader takes it next
    // time they are in the same room" — with no internet on either side.
    const shouldQueue =
        options?.alwaysQueue === true || (!result.success && options?.queueOnFailure !== false);
    if (!shouldQueue) return result;

    const queuedId = await queueEpubForHandover(
        fileUri,
        filename,
        // Reuse the mailbox id when there is one, so a book that is half-published
        // and later handed over is ONE book to the reader, not two.
        result.bookId ?? options?.bookId,
        options?.sizeBytes
    );
    // Omitted rather than undefined, so a result that queued nothing is
    // byte-identical to what this function has always returned.
    return queuedId ? { ...result, queuedId } : result;
}

/** The routing decision itself — everything {@link routeEpubSend} did before the queue. */
async function routeEpubLegs(
    destination: EpubDestination,
    fileUri: string,
    filename: string,
    onProgress?: (percent: number) => void,
    options?: RouteEpubOptions
): Promise<RouteEpubResult> {
    const attempts: EpubRouteAttempt[] = [];

    if (typeof fileUri !== 'string' || !fileUri.trim()) {
        return { success: false, error: 'No file to send.', attempts };
    }

    const problem = describeEpubPickProblem({
        uri: fileUri,
        name: typeof filename === 'string' ? filename : '',
        mimeType: options?.mimeType,
        size: options?.sizeBytes,
    });
    if (problem) return { success: false, error: problem, attempts };

    const safeName = resolveEpubFilename(filename, options?.mimeType) || undefined;

    // Tolerant of a settings blob written before the role existed, exactly like
    // every other read of it (role.ts).
    const role = asRole(destination?.role);
    const mailboxProblem = describeMailboxProblem(destination);
    const onPhase = options?.onPhase;

    if (role === 'client') {
        if (mailboxProblem !== null) {
            // Nothing left the phone: a client has no direct route, and the
            // mailbox is not usable.
            return { success: false, error: mailboxProblem, attempts };
        }
        onPhase?.('mailbox');
        return sendViaMailboxLeg(destination, fileUri, filename, attempts, onProgress, options);
    }

    // ── Host ────────────────────────────────────────────────────────────────
    //
    // FAST SKIP, AND ONLY WHERE IT IS FREE — identical to `sendLoveNote`'s, and
    // deliberately so: the same asleep reader must not be handled two ways.
    // Asking costs at most READER_PROBE_TIMEOUT_MS; not asking costs ~15-25 s of
    // stacked mkdir/WS timeouts PER BOOK, and a multi-select pays it per file.
    //
    // Gated on `mailboxProblem === null`: with no usable mailbox the direct
    // attempt is the only thing that can deliver, so a wrong probe must not turn
    // a slow send into a failed one. See reader_reachability's header, rule 1.
    let reachability: ReaderReachability | null = null;
    if (mailboxProblem === null) {
        onPhase?.('looking');
        reachability = await resolveReaderReachability(destination.ip, options?.reachability);
    }

    if (reachability && !reachability.reachable) {
        // Nothing was TRIED against the reader, so no 'direct' attempt is
        // recorded — `attempts` stays a log of what actually ran.
        onPhase?.('mailbox');
        const skipped = await sendViaMailboxLeg(
            destination,
            fileUri,
            filename,
            attempts,
            onProgress,
            options
        );
        if (skipped.success) return { ...skipped, skippedDirect: reachability };
        return {
            ...skipped,
            // Same sentence shape the tried-and-failed path below produces.
            error: `Reader unreachable (${reachability.error || 'no answer'}); mailbox failed too: ${skipped.error}`,
            skippedDirect: reachability,
        };
    }

    // The reader itself, first.
    onPhase?.('direct');
    const direct = await sendEpubToReader(destination.ip, fileUri, filename, onProgress, {
        targetFolder: options?.targetFolder,
        mimeType: options?.mimeType,
        sizeBytes: options?.sizeBytes,
    });
    attempts.push({ route: 'direct', success: direct.success, error: direct.error });
    if (direct.success) {
        return { success: true, route: 'direct', filename: safeName, attempts };
    }

    const directError = direct.error || 'Reader did not answer';

    if (!isDeviceUnreachableError(direct.error)) {
        // The reader ANSWERED and refused. Re-sending through the mailbox would
        // hide a real device condition behind a delayed delivery.
        return { success: false, error: directError, filename: safeName, attempts };
    }

    // A dead upload is a stronger observation than the probe that preceded it.
    // Recorded so the NEXT book in the batch skips the stall this one just paid
    // for, instead of re-discovering it seven times.
    noteReaderUnreachable(destination.ip, directError);

    if (mailboxProblem !== null) {
        return {
            success: false,
            error:
                mailboxProblem === MAILBOX_SETUP_HINT
                    ? `Reader unreachable (${directError}). ${MAILBOX_SETUP_HINT} to send while it is asleep.`
                    : `Reader unreachable (${directError}). Mailbox unusable: ${mailboxProblem}`,
            filename: safeName,
            attempts,
        };
    }

    onPhase?.('mailbox');
    const viaMailbox = await sendViaMailboxLeg(
        destination,
        fileUri,
        filename,
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
async function sendViaMailboxLeg(
    destination: EpubDestination,
    fileUri: string,
    filename: string,
    attempts: EpubRouteAttempt[],
    onProgress?: (percent: number) => void,
    options?: RouteEpubOptions
): Promise<RouteEpubResult> {
    const published = await sendEpubViaMailbox(
        (destination.mailboxUrl ?? '').trim(),
        (destination.mailboxWriteToken ?? '').trim(),
        fileUri,
        filename,
        onProgress,
        {
            mimeType: options?.mimeType,
            sizeBytes: options?.sizeBytes,
            bookId: options?.bookId,
        }
    );
    attempts.push({ route: 'mailbox', success: published.success, error: published.error });

    if (published.success) {
        return {
            success: true,
            route: 'mailbox',
            filename: published.filename,
            bookId: published.bookId,
            attempts,
        };
    }
    return {
        success: false,
        error: published.error,
        filename: published.filename,
        bookId: published.bookId,
        attempts,
    };
}

/** What happened to one pick. */
export interface EpubUploadOutcome {
    /** The name the user saw in the picker. */
    sourceName: string;
    /** The name that went to the card. Absent when nothing was sent. */
    filename?: string;
    success: boolean;
    error?: string;
    /**
     * Which route carried it. Absent on the direct-only path
     * ({@link sendEpubsToReader}), where there is nothing to disambiguate.
     */
    route?: EpubRoute;
}

export interface EpubBatchResult {
    /** Root-relative folder everything was sent to. */
    folder: string;
    succeeded: number;
    /** Every pick, in the order it was attempted. */
    outcomes: EpubUploadOutcome[];
    /** The subset of `outcomes` that failed. Convenience for the UI. */
    failed: EpubUploadOutcome[];
}

export interface SendEpubsOptions {
    targetFolder?: string;
    /** Called before each file starts, 1-based, for a "3 of 7" label. */
    onFileStart?: (index: number, total: number, pick: EpubPick) => void;
    /** Per-file byte progress, 0-100. */
    onProgress?: (percent: number, index: number, total: number) => void;
    /**
     * Per-file route phase, 1-based, so the overlay can say what it is doing
     * during the stretches where no percent exists. Routed batches only
     * ({@link sendEpubsRouted}); the direct-only batch has one route and nothing
     * to narrate.
     */
    onPhase?: (phase: SendPhase, index: number, total: number) => void;
    /**
     * ConnectionProvider's last reachability observation, passed to every file.
     *
     * Handed to each `routeEpubSend` rather than resolved once here: routing is
     * per FILE by design (a reader that falls asleep halfway through must not
     * fail the rest), and `reader_reachability` already collapses the repeats —
     * a probe result inside the freshness window is reused, so a seven-book add
     * probes once, not seven times.
     */
    reachability?: ReaderReachabilityHint | null;
}

/**
 * Upload several epubs, one at a time, and report on each.
 *
 * SERIAL ON PURPOSE. The firmware rejects a `START:` while another upload is in
 * flight ('ERROR:Upload already in progress' — it would otherwise leak the open
 * file handle), so any concurrency here would turn a multi-select into a pile of
 * failures.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE, not an exception: one unreadable file must
 * not cost the user the other six. Nothing here throws and nothing short-circuits.
 */
export async function sendEpubsToReader(
    ip: string,
    picks: EpubPick[],
    options?: SendEpubsOptions
): Promise<EpubBatchResult> {
    return runEpubBatch(picks, options, (pick, onProgress, folder) =>
        sendEpubToReader(ip, pick.uri, pick.name, onProgress, {
            targetFolder: folder,
            mimeType: pick.mimeType,
            sizeBytes: pick.size,
        })
    );
}

/**
 * Upload several epubs BY ROUTE — direct while the reader answers, mailbox when
 * it does not (or always, for a client).
 *
 * The batch semantics are {@link sendEpubsToReader}'s, unchanged and SHARED
 * (`runEpubBatch`): serial, never short-circuiting, partial success is the
 * normal case. Only the per-file send differs, so a fallback cannot
 * accidentally introduce the concurrency the firmware refuses.
 *
 * ONE PICK, ONE ROUTE DECISION. Routing is per FILE, not per batch: a reader
 * that falls asleep halfway through a multi-select must not fail the rest, and
 * the per-file `route` is what lets the summary say which books are on the card
 * and which are still waiting.
 */
export async function sendEpubsRouted(
    destination: EpubDestination,
    picks: EpubPick[],
    options?: SendEpubsOptions
): Promise<EpubBatchResult> {
    return runEpubBatch(picks, options, (pick, onProgress, folder, index, total) =>
        routeEpubSend(destination, pick.uri, pick.name, onProgress, {
            targetFolder: folder,
            mimeType: pick.mimeType,
            sizeBytes: pick.size,
            reachability: options?.reachability,
            onPhase: options?.onPhase
                ? phase => options.onPhase!(phase, index, total)
                : undefined,
        })
    );
}

/** One file's send, with whatever route logic the caller wants around it. */
type EpubBatchSend = (
    pick: EpubPick,
    onProgress: ((percent: number) => void) | undefined,
    folder: string,
    /** 1-based position, for a per-file label the send itself has to build. */
    index: number,
    total: number
) => Promise<UploadResult & { route?: EpubRoute }>;

/**
 * THE batch loop, shared by {@link sendEpubsToReader} and
 * {@link sendEpubsRouted}.
 *
 * Extracted rather than copied because every property that makes this loop
 * correct belongs to the FIRMWARE, not to a route: uploads are SERIAL (a
 * `START:` while another upload is in flight is refused outright), nothing
 * short-circuits (one unreadable file must not cost the user the other six), and
 * every pick is re-normalised before it is trusted. A second copy of the loop
 * would be a second place for one of those to be forgotten.
 */
async function runEpubBatch(
    picks: EpubPick[],
    options: SendEpubsOptions | undefined,
    send: EpubBatchSend
): Promise<EpubBatchResult> {
    const folder = resolveLibraryFolder(options?.targetFolder);
    const list = Array.isArray(picks) ? picks : [];
    const outcomes: EpubUploadOutcome[] = [];
    const total = list.length;

    for (let i = 0; i < total; i++) {
        const pick = list[i];
        const sourceName = pick && typeof pick.name === 'string' ? pick.name : 'Unnamed file';

        const normalized = normalizeEpubPick(pick);
        if (!normalized) {
            outcomes.push({ sourceName, success: false, error: 'Not a file the picker could return.' });
            continue;
        }

        if (options?.onFileStart) options.onFileStart(i + 1, total, normalized);

        const result = await send(
            normalized,
            options?.onProgress ? percent => options.onProgress!(percent, i + 1, total) : undefined,
            folder,
            i + 1,
            total
        );

        outcomes.push({
            sourceName,
            filename: resolveEpubFilename(normalized.name, normalized.mimeType) || undefined,
            success: result.success,
            error: result.success ? undefined : result.error || 'Upload failed.',
            route: result.route,
        });
    }

    const failed = outcomes.filter(o => !o.success);
    return { folder, succeeded: outcomes.length - failed.length, outcomes, failed };
}

/**
 * One human sentence (plus per-file detail) for a finished batch.
 *
 * Lives here rather than in DeviceScreen so the wording is testable and so a
 * second caller cannot invent a different one. Names every failure: "2 of 5
 * failed" without saying WHICH two is an alert the user can do nothing with.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE IS PART OF THE RESULT, NOT A DETAIL
 * ---------------------------------------------------------------------------
 * "Added 2 books to /books" is a LIE about a book that went to the mailbox: the
 * bytes are not on the card, the reader collects them at its next sync, and a
 * large book crosses several wake windows before it is readable. So whenever a
 * mailbox route carried anything, the summary says so — and names WHICH books
 * took which route as soon as the batch used both, because that is the case
 * where a single sentence cannot be true of every file in it.
 *
 * A direct-only batch is worded EXACTLY as before. The route is only mentioned
 * when there is a distinction to draw.
 */
export function describeEpubBatch(result: EpubBatchResult, rejected: RejectedEpubPick[] = []): string {
    const lines: string[] = [];
    const total = result.outcomes.length;
    const sent = result.outcomes.filter(o => o.success);
    const viaMailbox = sent.filter(o => o.route === 'mailbox');
    const viaDirect = sent.filter(o => o.route !== 'mailbox');

    if (result.succeeded > 0) {
        const books = result.succeeded === 1 ? 'book' : 'books';
        if (viaMailbox.length > 0 && viaDirect.length === 0) {
            // EVERYTHING went to the mailbox (a client, or a sleeping reader).
            // Naming '/books' as the destination here would describe a place the
            // bytes have not reached yet.
            lines.push(
                result.succeeded === total
                    ? `Sent ${result.succeeded} ${books} to the mailbox — ${MAILBOX_LANDING_CLAUSE}.`
                    : `Sent ${result.succeeded} of ${total} to the mailbox — ${MAILBOX_LANDING_CLAUSE}.`
            );
        } else {
            lines.push(
                result.succeeded === total
                    ? `Added ${result.succeeded} ${books} to /${result.folder}.`
                    : `Added ${result.succeeded} of ${total} to /${result.folder}.`
            );
            if (viaMailbox.length > 0) {
                // MIXED: the reader answered for some files and not for others, so
                // one sentence cannot be true of all of them.
                lines.push(`• ${EPUB_ROUTE_LABEL.direct}: ${namesOf(viaDirect)}`);
                lines.push(
                    `• ${EPUB_ROUTE_LABEL.mailbox} (${MAILBOX_LANDING_CLAUSE}): ${namesOf(viaMailbox)}`
                );
            }
        }
    } else if (total > 0) {
        lines.push(`Nothing was added to /${result.folder}.`);
    }

    for (const outcome of result.failed) {
        lines.push(`• ${outcome.sourceName}: ${outcome.error ?? 'Upload failed.'}`);
    }
    for (const skip of rejected) {
        lines.push(`• ${skip.name}: ${skip.reason}`);
    }

    if (lines.length === 0) return 'No files were selected.';
    return lines.join('\n');
}

/**
 * Comma-joined book names for one route.
 *
 * The DEVICE name is preferred over the picked one: it is what the user will see
 * in the reader's file browser, and it is the only one that is true after
 * sanitization renamed the file.
 */
function namesOf(outcomes: EpubUploadOutcome[]): string {
    return outcomes.map(o => o.filename || o.sourceName).join(', ');
}

function describeError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return 'Upload failed.';
}
