/**
 * mailbox_client — publish a love-note frame to the tailnet/edge MAILBOX that
 * the reader polls, instead of pushing it at the reader over the LAN.
 *
 * ---------------------------------------------------------------------------
 * WHY A MAILBOX EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The direct path (`love_note_sender.sendLoveNoteFrame`) needs the phone and the
 * reader on the same network AND the reader AWAKE — and the reader is asleep
 * with its radio OFF almost all of the time. A client phone (the partner, off
 * the house LAN) can never use it. So the note is left in a mailbox and the
 * reader collects it on its own schedule: firmware `MessageSync::syncBeforeSleep`
 * runs at deep-sleep entry, pulls the mailbox, stages the frame, and renders it
 * at the NEXT wake.
 *
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT — THE FIRMWARE HALF IS FIXED, DO NOT "IMPROVE" IT HERE
 * ---------------------------------------------------------------------------
 * Base URL: `{origin}/m/{boxId}`, trailing slashes stripped.
 *
 *   FIRMWARE READS (no auth — see below):
 *     GET  {base}/latest.txt      -> 200 text/plain, the latest note id.
 *                                    An EMPTY body means "no note".
 *     GET  {base}/current.frame   -> 200 application/octet-stream, EXACTLY
 *                                    {@link MAILBOX_FRAME_BYTES} bytes. The
 *                                    firmware discards any other length.
 *
 *   APP WRITES (bearer auth — this module):
 *     POST {base}/publish         Authorization: Bearer <writeToken>
 *                                 Content-Type: application/octet-stream
 *                                 X-Note-Id: <id>
 *                                 body = the frame
 *                                 200 {"ok":true,"id":...} | 401 | 400/413
 *     GET  {base}/status          Authorization: Bearer <writeToken>
 *                                 -> {"latestId":…,"bytes":…,"updatedAt":…,
 *                                     "books":[{id,filename,bytes}]}
 *
 * ---------------------------------------------------------------------------
 * BOOKS RIDE THE SAME MAILBOX, THE SAME URL AND THE SAME TOKEN
 * ---------------------------------------------------------------------------
 * That is the point of putting them here rather than in a module of their own:
 * NOTHING NEW IS PROVISIONED ON THE READER for books. The capability URL the
 * reader already stores is what it fetches its library from, so a box that works
 * for notes works for books the moment the firmware half lands.
 *
 *   FIRMWARE READS (no auth, same as above):
 *     GET  {base}/books.txt       -> 200 text/plain, `{id} {bytes} {filename}\n`
 *                                    per book, newest first; EMPTY body = none.
 *     GET  {base}/books/{id}      -> 200 application/epub+zip, `Range` honoured
 *                                    (206/416) — that is how a 3 MB book crosses
 *                                    several seconds-long wake windows.
 *
 *   APP WRITES (bearer auth — this module):
 *     POST   {base}/books         Content-Type: application/octet-stream
 *                                 X-Book-Id: <id>
 *                                 X-Filename: <name.epub>
 *                                 body = the epub, 1..MAX_BOOK_BYTES
 *                                 200 {"ok":true,"id":…,"filename":…,"bytes":…}
 *                                 | 401 | 400 | 413
 *     DELETE {base}/books/{id}    -> 200 {"ok":true,"id":…,"filename":…} | 404
 *
 * A note and a book are INDEPENDENT: publishing either never touches the other's
 * keys, and the reader syncs notes on every wake whether or not the box holds
 * books. The server keeps at most 20 books per box and evicts the OLDEST beyond
 * that (`MAX_BOOKS`), so a mailbox is a delivery queue, not storage.
 *
 * ---------------------------------------------------------------------------
 * WALLPAPERS RIDE IT TOO — SAME URL, SAME TOKEN, SAME ARGUMENT
 * ---------------------------------------------------------------------------
 * A sleep screen used to be direct-LAN ONLY: `wallpaper_sender.sendWallpaperBmp`
 * pushes a BMP at the reader's own HTTP/WS API, which needs the reader AWAKE and
 * on this network. That made "change what my partner's reader shows while it
 * sleeps" the one thing a client phone could never do and a host could only do
 * in the seconds the reader happens to be up. The mailbox removes both limits:
 * the picture waits in the box and the reader collects it on its own sync
 * window, exactly as a note or a book does.
 *
 *   FIRMWARE READS (no auth, same capability URL):
 *     GET  {base}/wallpaper.txt   -> 200 text/plain,
 *                                    `{id} {bytes} {target} {filename}\n` per
 *                                    pending item, NEWEST LAST, so a reader that
 *                                    applies the lines IN ORDER finishes on the
 *                                    newest primary. `{filename}` is '-' for a
 *                                    primary. EMPTY body = nothing waiting.
 *     GET  {base}/wallpaper/{id}  -> 200 image/bmp, `Range` honoured (206/416)
 *                                    exactly as `books/{id}` is.
 *
 *   APP WRITES (bearer auth — this module):
 *     POST   {base}/wallpaper     Content-Type: application/octet-stream
 *                                 X-Wallpaper-Id: <id>
 *                                 X-Wallpaper-Target: primary | set
 *                                 X-Filename: <name.bmp>   (target=set ONLY)
 *                                 body = the BMP, 1..MAX_WALLPAPER_BYTES
 *                                 200 {"ok":true,"id","target","filename","bytes"}
 *                                 | 401 | 400 | 413
 *     DELETE {base}/wallpaper/{id} -> 200 {"ok":true,...} | 404
 *
 * READER-SIDE APPLICATION, and it is why `target` is on the wire rather than
 * inferred from the name: 'primary' lands at `/sleep.bmp` (the single top-
 * priority slot) and 'set' lands at `/.sleep/<filename>` (the rotation). Those
 * are two different files with two different meanings, and a reader that had to
 * guess would put a "pin this one picture" into the random rotation.
 *
 * RETENTION IS NOT THE BOOKS' RULE. The server keeps at most
 * {@link MAILBOX_MAX_WALLPAPERS} and evicts oldest-first like books, but a NEW
 * 'primary' also SUPERSEDES any earlier undelivered 'primary' — there is exactly
 * one `/sleep.bmp` on the card, so a queue holding three of them would spend
 * three sync windows' worth of radio to end up where one would have.
 *
 * THE READ SIDE HAS NO AUTHENTICATION. The firmware's HTTP client sends no
 * headers on reads (and accepts any TLS cert via `setInsecure`), so the ONLY
 * thing protecting a mailbox is that `{base}` is unguessable. Two consequences
 * this module is written around:
 *
 *   1. The write token is NEVER part of the URL. It is a separate settings
 *      field (`mailboxWriteToken`) and only ever travels in an Authorization
 *      header. The URL is the value that gets typed into the READER, which has
 *      no way to hold a secret separately and would leak it in its own settings
 *      UI and API responses.
 *   2. `{base}` must be <= {@link MAILBOX_URL_MAX_CHARS} characters, because
 *      that is the reader's `messageSyncUrl` field width. A base that does not
 *      fit is not "slightly wrong": the reader physically cannot store it, so
 *      every note published there is undeliverable. That is why the length is
 *      validated here on the WRITE path too, not only in the settings form —
 *      the failure it prevents is otherwise completely silent (the app reports
 *      "sent", the reader shows nothing, forever).
 *
 * A query string or fragment is rejected for the same class of reason: the
 * firmware builds its request as plain string concatenation (`base + "/latest.txt"`,
 * MessageSync.cpp), so `…/m/abc?k=1` would fetch `…/m/abc?k=1/latest.txt` and
 * never resolve. The app must not accept a base the reader cannot use.
 *
 * ---------------------------------------------------------------------------
 * NEVER THROWS
 * ---------------------------------------------------------------------------
 * Every entry point reports failure in its return value, exactly like
 * `sendLoveNoteFrame` / `sendWallpaperBmp` / `sendNoteAsTxt`. Callers written to
 * the repo convention (`const r = await publishLoveNote(...); if (!r.success)`)
 * need no try/catch, and a mixed throw/return contract can never turn a bad
 * token into an unhandled rejection.
 *
 * Nothing here imports react-native, so `scripts/mailbox-client.test.js` drives
 * the real module under node with a stubbed `globalThis.fetch`.
 */

import { X3_FRAME_BYTES } from '../device/x3';
import type { UploadResult } from '../types';
import { formatNetworkError } from './network_errors';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/**
 * Exact size of a love-note frame, re-exported from the device contract rather
 * than re-typed: the firmware compares the downloaded length against its own
 * framebuffer size and DELETES anything else (MessageSync.cpp), so a mailbox
 * that accepts a wrong-sized body is a mailbox whose notes silently never show.
 */
export const MAILBOX_FRAME_BYTES = X3_FRAME_BYTES;

/**
 * Hard ceiling on `{base}`.
 *
 * 127, NOT 128. The reader stores it in `char messageSyncUrl[128]`
 * (CrossPointSettings.h) — a C string, so 127 characters plus the NUL
 * terminator. A 128-character base is not rejected by the reader, it is
 * silently TRUNCATED, which points it at a capability URL that 404s forever
 * while every screen on both sides looks correctly configured. The mailbox
 * Worker enforces the same 127 as `READER_URL_MAX_LEN`.
 *
 * The boxId (22+ chars) plus `/m/` has to fit inside this together with the
 * origin — see the header for why exceeding it is a silent, permanent failure.
 */
export const MAILBOX_URL_MAX_CHARS = 127;

/**
 * Upper bound on a minted note id. The firmware truncates ids at 128 chars;
 * staying far under that keeps the id trivially loggable and leaves room for a
 * server that decides to decorate it.
 */
export const NOTE_ID_MAX_CHARS = 40;

/** Path suffixes. The firmware's two READ suffixes are here for documentation. */
export const MAILBOX_PUBLISH_PATH = '/publish';
export const MAILBOX_STATUS_PATH = '/status';
export const MAILBOX_LATEST_ID_PATH = '/latest.txt';
export const MAILBOX_FRAME_PATH = '/current.frame';

/**
 * Books. `POST {base}/books` writes one; `DELETE {base}/books/{id}` removes one.
 * {@link MAILBOX_BOOKS_MANIFEST_PATH} is the FIRMWARE's read suffix and is here
 * for documentation only — nothing in this module fetches it, see
 * {@link listMailboxBooks} for why.
 */
export const MAILBOX_BOOKS_PATH = '/books';
export const MAILBOX_BOOKS_MANIFEST_PATH = '/books.txt';

/**
 * Hard ceiling on one epub, in bytes.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A MIRROR OF `mailbox/src/core.js` `MAX_BOOK_BYTES` (24 MiB).
 * ---------------------------------------------------------------------------
 * It CANNOT be imported. `core.js` is an ESM module outside `src/`, outside
 * tsconfig's roots and outside Metro's bundle; importing it here would pull the
 * whole Worker contract into the APK and break `tsc`. So the value is re-typed —
 * and because a re-typed constant is a constant that drifts, the two are pinned
 * equal by a test that reads BOTH FILES and compares the literals
 * (`scripts/mailbox-client.test.js`, "mirrors mailbox/src/core.js"). If you
 * change one, that test fails until you change the other.
 *
 * The number itself is the Workers KV single-VALUE ceiling (25 MiB) minus
 * headroom, see the note on `MAX_BOOK_BYTES` in core.js: a body over the cap is
 * answered 413 by the server, so the client-side guard exists to avoid spending
 * a multi-megabyte upload on a request that cannot succeed — not to be the only
 * enforcement.
 */
export const MAILBOX_MAX_BOOK_BYTES = 24 * 1024 * 1024; // 25165824

/**
 * Longest `X-Filename` the server accepts.
 *
 * MIRROR of `mailbox/src/core.js` `BOOK_FILENAME_MAX_LEN`, pinned by the same
 * two-file test as {@link MAILBOX_MAX_BOOK_BYTES}. Rejected, never truncated,
 * on both sides: truncation would drop the `.epub` the reader identifies a book
 * by.
 */
export const MAILBOX_BOOK_FILENAME_MAX_CHARS = 120;

/**
 * Longest book id the server accepts (`BOOK_ID_MAX_LEN` in core.js, itself
 * `NOTE_ID_MAX_LEN`). Not mirror-tested because {@link mintBookId} never comes
 * close to it; it is here to reject a caller-supplied id before the upload
 * rather than after.
 */
export const BOOK_ID_MAX_CHARS = 64;

/**
 * Charset a book id may use: `BOOK_ID_PATTERN` in core.js.
 *
 * Deliberately WIDER than what {@link mintBookId} emits (`[0-9a-z-]`), for the
 * same reason `love_note_sender`'s id gate is: this is what an id from anywhere
 * else has to survive. What it excludes is what matters — the id is echoed
 * verbatim into a `books.txt` line, becomes a URL path segment and becomes a
 * store key (a FILE PATH on the dev server), so space, `/` and `%` have to be
 * impossible rather than escaped.
 */
const BOOK_ID_ALLOWED = /^[A-Za-z0-9._~-]+$/;

/**
 * Wallpapers. `POST {base}/wallpaper` writes one; `DELETE {base}/wallpaper/{id}`
 * removes one. {@link MAILBOX_WALLPAPER_MANIFEST_PATH} is the FIRMWARE's read
 * suffix and is here for documentation only — nothing in this module fetches it,
 * for the same three reasons {@link listMailboxWallpapers} spells out.
 */
export const MAILBOX_WALLPAPER_PATH = '/wallpaper';
export const MAILBOX_WALLPAPER_MANIFEST_PATH = '/wallpaper.txt';

/**
 * Hard ceiling on one wallpaper, in bytes.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A MIRROR OF `mailbox/src/core.js` `MAX_WALLPAPER_BYTES` (4 MiB).
 * ---------------------------------------------------------------------------
 * Same rule and same enforcement as {@link MAILBOX_MAX_BOOK_BYTES}: the value
 * cannot be imported (core.js is outside tsconfig's roots and outside Metro's
 * bundle), so it is re-typed and the two literals are pinned equal by a test
 * that reads BOTH FILES (`scripts/mailbox-client.test.js`, "mirrors
 * mailbox/src/core.js").
 *
 * 4 MiB is deliberately generous rather than tight. The sleep screen is
 * 528x792 8-bit, i.e. ~419 KB of pixels, and the largest thing this app would
 * ever encode — a 1056-long-side 8bpp BMP — is ~1.1 MB. Four MiB leaves room
 * for a picture put in the box by something other than this app while staying
 * far under Workers KV's 25 MiB single-value ceiling, so the cap that bites is
 * always this one and never the platform's.
 */
export const MAILBOX_MAX_WALLPAPER_BYTES = 4 * 1024 * 1024; // 4194304

/**
 * Longest `X-Filename` the wallpaper route accepts.
 *
 * MIRROR of `mailbox/src/core.js` `WALLPAPER_FILENAME_MAX_LEN`, pinned by the
 * same two-file test. The same 120 as books, and for the same reason: the name
 * becomes a file on the reader's SD card, and truncating it would drop the
 * `.bmp` the firmware scans `/.sleep` for.
 */
export const MAILBOX_WALLPAPER_FILENAME_MAX_CHARS = 120;

/**
 * How many wallpapers a box holds before the OLDEST is evicted.
 *
 * MIRROR of `mailbox/src/core.js` `MAX_WALLPAPERS`. Smaller than `MAX_BOOKS`
 * (20) on purpose: the rotation set is a handful of pictures a user curates, not
 * a library, and every extra entry is a whole BMP the reader has to pull inside
 * its battery-budgeted wake windows before it gets to the newest one.
 */
export const MAILBOX_MAX_WALLPAPERS = 8;

/** Longest wallpaper id the server accepts (`WALLPAPER_ID_MAX_LEN` in core.js). */
export const WALLPAPER_ID_MAX_CHARS = 64;

/**
 * Charset a wallpaper id may use: `WALLPAPER_ID_PATTERN` in core.js, which is
 * `BOOK_ID_PATTERN`, which is `NOTE_ID_PATTERN`. Declared as its own binding
 * rather than reusing {@link BOOK_ID_ALLOWED} so the two can be told apart if
 * the server ever narrows one of them.
 */
const WALLPAPER_ID_ALLOWED = /^[A-Za-z0-9._~-]+$/;

/** Extension the firmware scans `/.sleep` for. Lowercase on the wire. */
const WALLPAPER_EXTENSION = '.bmp';

/** BMP file magic ('BM') — the cheapest guard against a mis-routed payload. */
const BMP_MAGIC_B = 0x42;
const BMP_MAGIC_M = 0x4d;

/**
 * Publish budget. A 52 KB body on a phone radio is quick, but a captive portal
 * or a dead tunnel can hang a fetch indefinitely, and the user is staring at a
 * spinner the whole time.
 */
const PUBLISH_TIMEOUT_MS = 20000;

/**
 * Book budget. Separate from {@link PUBLISH_TIMEOUT_MS} because the bodies are
 * three orders of magnitude apart: a book is up to
 * {@link MAILBOX_MAX_BOOK_BYTES}, and 20 s of phone uplink does not reliably
 * cover even a small one. Still BOUNDED — an unbounded upload is a spinner the
 * user cannot escape — and a timeout is recoverable: re-POSTing the same id
 * overwrites, so the retry is idempotent rather than a second copy.
 */
const BOOK_PUBLISH_TIMEOUT_MS = 120000;

/** Status is a few dozen bytes; it should never be the slow thing. */
const STATUS_TIMEOUT_MS = 10000;

/** A delete is a manifest edit plus a blob drop; it moves no user bytes. */
const BOOK_DELETE_TIMEOUT_MS = 20000;

/**
 * Wallpaper budget. Between the two: a BMP is ~1 MB rather than a book's tens,
 * but two orders of magnitude past a 52 KB frame, and the user is watching a
 * spinner either way. Bounded for the same reason every other budget here is,
 * and safe to retry — re-POSTing the same id overwrites.
 */
const WALLPAPER_PUBLISH_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * `UploadResult` plus the id the note was published under.
 *
 * Deliberately a SUPERSET of the repo's one sender contract rather than a new
 * shape: existing call sites keep working unchanged (`if (!r.success)`), and the
 * id — which History needs to correlate a row with what the reader eventually
 * displays — rides along for the callers that want it.
 */
export interface MailboxPublishResult extends UploadResult {
    /** Set on success; also set on a rejected publish so a retry can be traced. */
    noteId?: string;
    /** HTTP status, when the request reached the server. */
    status?: number;
}

/** Decoded `/status` body. Every field is optional on the wire. */
export interface MailboxStatus {
    /** Id the reader would fetch next, or null when the mailbox is empty. */
    latestId: string | null;
    /** Size of the stored frame, if the server reports one. */
    bytes: number | null;
    /** Server-reported last-publish time (epoch ms), if any. */
    updatedAt: number | null;
}

export interface MailboxStatusResult {
    success: boolean;
    error?: string;
    status?: MailboxStatus;
    /** HTTP status, when the request reached the server. */
    httpStatus?: number;
}

/**
 * One book the mailbox is holding, as `/status` reports it.
 *
 * The same three fields the reader gets from `books.txt` — and no more. There is
 * deliberately no "delivered" flag anywhere in this contract: the reader ACKS
 * NOTHING (mailbox/README.md, "no server-side acks"), because what is actually
 * on the SD card is reader-side state and a server flag that disagreed with the
 * card would be worse than no flag at all.
 */
export interface MailboxBook {
    id: string;
    filename: string;
    bytes: number;
}

/**
 * `UploadResult` plus what the server stored, for one book.
 *
 * Same superset-not-replacement choice as {@link MailboxPublishResult}: a caller
 * written to the repo convention (`if (!r.success)`) needs nothing new, and the
 * id — which is the ONLY handle for a later delete, and the value a reader's
 * `books.txt` line will carry — rides along.
 */
export interface MailboxBookResult extends UploadResult {
    /** Set on success; also set on a REJECTED publish, so a retry can reuse it. */
    id?: string;
    /** The filename the server stored, which may differ from the one sent. */
    filename?: string;
    /** Bytes the server reported storing. */
    bytes?: number;
    /** HTTP status, when the request reached the server. */
    status?: number;
}

export interface MailboxBooksResult {
    success: boolean;
    error?: string;
    /** Newest first, exactly as the server orders it. `[]` on an empty box. */
    books: MailboxBook[];
    /** HTTP status, when the request reached the server. */
    httpStatus?: number;
}

/**
 * Which sleep-screen slot a published wallpaper is aimed at.
 *
 * ON THE WIRE as `X-Wallpaper-Target` and as the third field of a
 * `wallpaper.txt` line, because the reader cannot infer it: 'primary' is the
 * single `/sleep.bmp` slot the firmware prefers over everything, 'set' is one
 * entry of the `/.sleep` rotation it picks from at random. A wallpaper that
 * arrived without this would have to be guessed into one of them, and the guess
 * is user-visible either way round.
 *
 * The strings are the SAME two words `wallpaper_sender.WallpaperTarget` uses for
 * the direct route, so one send can carry one target through both roads.
 */
export type MailboxWallpaperTarget = 'primary' | 'set';

/**
 * One wallpaper the mailbox is holding, as `/status` reports it.
 *
 * `filename` is '' for a primary — the slot is fixed (`/sleep.bmp`), so there is
 * no name to carry, and the manifest line writes '-' in that position purely so
 * the line keeps four space-separated fields for a C-string walk.
 */
export interface MailboxWallpaper {
    id: string;
    target: MailboxWallpaperTarget;
    /** '' for a primary; a `*.bmp` name for a rotation entry. */
    filename: string;
    bytes: number;
}

/** `UploadResult` plus what the server stored, for one wallpaper. */
export interface MailboxWallpaperResult extends UploadResult {
    /** Set on success; also set on a REJECTED publish, so a retry can reuse it. */
    id?: string;
    /** Echoed back by the server; the value it will publish. */
    target?: MailboxWallpaperTarget;
    /** The filename the server stored, which may differ from the one sent. */
    filename?: string;
    /** Bytes the server reported storing. */
    bytes?: number;
    /** HTTP status, when the request reached the server. */
    status?: number;
}

export interface MailboxWallpapersResult {
    success: boolean;
    error?: string;
    /** Exactly as the server orders it. `[]` on a box holding none. */
    wallpapers: MailboxWallpaper[];
    /** HTTP status, when the request reached the server. */
    httpStatus?: number;
}

// ---------------------------------------------------------------------------
// Note ids
// ---------------------------------------------------------------------------

/** Base-36 alphabet, lowercase — the whole id stays inside [a-z0-9-]. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Width of the timestamp field. 36^9 ms lands past the year 5000. */
const ID_TIME_CHARS = 9;

/** Width of the in-process sequence field (4096 values, see mintNoteId). */
const ID_SEQ_CHARS = 3;
const ID_SEQ_MASK = 0xfff;

/** Width of the random field. 36^8 ~= 2.8e12 per (ms, seq) bucket. */
const ID_RANDOM_CHARS = 8;

let idSequence = Math.floor(Math.random() * (ID_SEQ_MASK + 1));

function randomIdChars(count: number): string {
    let out = '';
    for (let i = 0; i < count; i++) {
        out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    return out;
}

/**
 * Mint an id for one published note.
 *
 * SORTABLE FIRST, RANDOM SECOND. The leading zero-padded base-36 millisecond
 * makes ids lexicographically ordered, which is what makes a mailbox's object
 * listing readable and makes "is this newer?" answerable without a clock.
 *
 * UNIQUENESS IS NOT LEFT TO Math.random ALONE. The middle field is a process
 * counter, so a burst of mints inside a single millisecond cannot collide even
 * if the RNG is degenerate (a real hazard: some RN release builds seed poorly,
 * and a duplicate id is INVISIBLE — the firmware dedups on it, so note #2 would
 * simply never be shown while the app reports a successful send).
 *
 * NOT A SECRET. Ids are readable by anyone who can read the mailbox; the
 * mailbox's protection is its unguessable base URL plus the write token.
 *
 * @returns 21 chars matching /^[0-9a-z]{9}-[0-9a-z]{11}$/, always within
 *          {@link NOTE_ID_MAX_CHARS}.
 */
export function mintNoteId(): string {
    const now = Date.now();
    const millis = Number.isFinite(now) && now > 0 ? Math.floor(now) : 0;
    // `slice(-ID_TIME_CHARS)` keeps the width fixed (and therefore sortable)
    // even if a device clock is set absurdly far into the future.
    const time = millis.toString(36).padStart(ID_TIME_CHARS, '0').slice(-ID_TIME_CHARS);
    idSequence = (idSequence + 1) & ID_SEQ_MASK;
    const seq = idSequence.toString(36).padStart(ID_SEQ_CHARS, '0');
    return `${time}-${seq}${randomIdChars(ID_RANDOM_CHARS)}`;
}

/**
 * Prefix that marks an id as a BOOK id rather than a note id.
 *
 * Both live in the same box and the same charset, and both end up in server
 * logs and in `books.txt`; a prefix is what makes "which thing is this id for?"
 * answerable from the id alone when something has to be traced by hand. Inside
 * `[a-z0-9-]`, so it cannot push the id outside {@link BOOK_ID_ALLOWED}.
 */
export const BOOK_ID_PREFIX = 'bk-';

/**
 * Mint an id for one published book.
 *
 * REUSES {@link mintNoteId} rather than re-deriving the same three fields: the
 * uniqueness argument (sortable millisecond, in-process sequence, random tail —
 * see mintNoteId) is identical and it must not be able to drift between the two
 * call sites. A duplicate book id is not as silent as a duplicate note id (a
 * re-POST overwrites the blob and the manifest entry, so the loss is the FIRST
 * book, not the second) but it is still a book the user sent and cannot find.
 *
 * @returns 24 chars matching /^bk-[0-9a-z]{9}-[0-9a-z]{11}$/ — well inside
 *          {@link BOOK_ID_MAX_CHARS} and inside {@link BOOK_ID_ALLOWED}.
 */
export function mintBookId(): string {
    return `${BOOK_ID_PREFIX}${mintNoteId()}`;
}

/**
 * Prefix that marks an id as a WALLPAPER id.
 *
 * Same argument as {@link BOOK_ID_PREFIX}: notes, books and wallpapers share one
 * box, one charset and one set of server logs, so the id alone has to answer
 * "which thing is this?" when something is traced by hand. Inside `[a-z0-9-]`,
 * so it cannot push the id outside {@link WALLPAPER_ID_ALLOWED}.
 */
export const WALLPAPER_ID_PREFIX = 'wp-';

/**
 * Mint an id for one published wallpaper.
 *
 * REUSES {@link mintNoteId} for the reason {@link mintBookId} does — the
 * uniqueness argument must not be able to drift between three call sites — and a
 * duplicate here is worse than a duplicate book: re-POSTing an id OVERWRITES,
 * and two wallpapers sharing one id means the first picture the user chose is
 * silently replaced by the second while both appear to have been sent.
 *
 * @returns 24 chars matching /^wp-[0-9a-z]{9}-[0-9a-z]{11}$/.
 */
export function mintWallpaperId(): string {
    return `${WALLPAPER_ID_PREFIX}${mintNoteId()}`;
}

/**
 * Why `id` cannot be used as a book id, or null when it can.
 *
 * Mirrors `core.js` `validateBookId`, INCLUDING the dot-only reject: `..`
 * matches the charset, and the id becomes a store key which becomes a
 * filesystem path on the dev server. Checked here so a traversal attempt or a
 * typo fails before a multi-megabyte body is put on the wire.
 */
function describeBookIdProblem(id: string): string | null {
    if (!id) return 'Book id is empty.';
    if (id.length > BOOK_ID_MAX_CHARS) {
        return `Book id is ${id.length} characters; the mailbox accepts ${BOOK_ID_MAX_CHARS}.`;
    }
    if (!BOOK_ID_ALLOWED.test(id)) return `Book id must match [A-Za-z0-9._~-] (got "${id}").`;
    if (/^\.+$/.test(id)) return '"." and ".." are not book ids.';
    return null;
}

/**
 * Why `filename` cannot be sent as `X-Filename`, or null when it can.
 *
 * REJECT-ONLY, deliberately. `core.js` `sanitizeBookFilename` both rejects
 * (separators, control chars, leading '.', missing `.epub`, over-long) and
 * REPLACES (FAT punctuation, non-ASCII) — and this half mirrors only the
 * rejects. The replacements are the SERVER's business: `epub_sender`
 * (`resolveEpubFilename`) is the one place in the app that decides what a book
 * is called, and a second normaliser here would silently disagree with it about
 * which file the user sent. So: anything the server would refuse fails before
 * the upload; anything it would merely tidy goes up and the stored name comes
 * back in {@link MailboxBookResult.filename}.
 */
function describeBookFilenameProblem(filename: string): string | null {
    if (!filename) return 'Book filename is empty.';
    if (filename.length > MAILBOX_BOOK_FILENAME_MAX_CHARS) {
        return (
            `Book filename is ${filename.length} characters; the mailbox accepts ` +
            `${MAILBOX_BOOK_FILENAME_MAX_CHARS}.`
        );
    }
    if (/[/\\]/.test(filename)) return 'Book filename must be a bare name, not a path.';
    // An internal CR/LF would forge an extra `books.txt` line; the rest have no
    // business in a name written to an SD card. Written with \u escapes so this
    // source stays plain ASCII, as in `epub_sender`'s CONTROL_CHARS.
    if (/[\u0000-\u001f\u007f]/.test(filename)) {
        return 'Book filename must not contain control characters.';
    }
    // A dot-leading name is invisible in the reader's own file browser
    // (FileBrowserActivity skips it unless showHiddenFiles is on) — and '.'/'..'
    // are traversal. Both are one rule, on both sides.
    if (filename.startsWith('.')) return 'Book filename must not start with ".".';
    if (!/\.epub$/i.test(filename)) return 'Book filename must end in .epub.';
    return null;
}

/**
 * Why `id` cannot be used as a wallpaper id, or null when it can.
 *
 * Mirrors `core.js` `validateWallpaperId`, dot-only reject included, for the
 * reason {@link describeBookIdProblem} spells out: the id is echoed verbatim
 * into a `wallpaper.txt` line, becomes a URL path segment and becomes a store
 * key (a FILE PATH on the dev server).
 */
function describeWallpaperIdProblem(id: string): string | null {
    if (!id) return 'Wallpaper id is empty.';
    if (id.length > WALLPAPER_ID_MAX_CHARS) {
        return `Wallpaper id is ${id.length} characters; the mailbox accepts ${WALLPAPER_ID_MAX_CHARS}.`;
    }
    if (!WALLPAPER_ID_ALLOWED.test(id)) {
        return `Wallpaper id must match [A-Za-z0-9._~-] (got "${id}").`;
    }
    if (/^\.+$/.test(id)) return '"." and ".." are not wallpaper ids.';
    return null;
}

/**
 * Why `filename` cannot be sent as `X-Filename` on the wallpaper route, or null
 * when it can.
 *
 * REJECT-ONLY, exactly like {@link describeBookFilenameProblem}: the server both
 * rejects and tidies, and only the rejects are mirrored here, because
 * `wallpaper_sender.sanitizeSleepSetName` is the ONE place in the app that
 * decides what a rotation entry is called and a second normaliser would disagree
 * with it about which file the user just added.
 *
 * THE SPACE RULE IS THE ONE THAT IS NOT SHARED WITH BOOKS. A `books.txt` line
 * puts the filename LAST, so a space in it is harmless; a `wallpaper.txt` line
 * is `{id} {bytes} {target} {filename}` and the filename is still last — but the
 * '-' placeholder a primary uses means a name that IS '-' would be
 * indistinguishable from "no name". Refused here rather than papered over.
 */
function describeWallpaperFilenameProblem(filename: string): string | null {
    if (!filename) return 'Wallpaper filename is empty.';
    if (filename.length > MAILBOX_WALLPAPER_FILENAME_MAX_CHARS) {
        return (
            `Wallpaper filename is ${filename.length} characters; the mailbox accepts ` +
            `${MAILBOX_WALLPAPER_FILENAME_MAX_CHARS}.`
        );
    }
    if (/[/\\]/.test(filename)) return 'Wallpaper filename must be a bare name, not a path.';
    // An internal CR/LF would forge an extra `wallpaper.txt` line; the rest have
    // no business in a name written to an SD card. Written with \u escapes so
    // this source stays plain ASCII, as in `epub_sender`'s CONTROL_CHARS.
    if (/[\u0000-\u001f\u007f]/.test(filename)) {
        return 'Wallpaper filename must not contain control characters.';
    }
    // A dot-leading name is invisible in the reader's own file browser, and
    // '.'/'..' are traversal. `/.sleep` is ALREADY a hidden folder; a hidden file
    // inside it is a picture nobody can find to delete.
    if (filename.startsWith('.')) return 'Wallpaper filename must not start with ".".';
    if (filename === '-') return 'Wallpaper filename must not be "-" (that means "no name").';
    if (!/\.bmp$/i.test(filename)) return `Wallpaper filename must end in ${WALLPAPER_EXTENSION}.`;
    return null;
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * What is wrong with a candidate mailbox base URL, as a CODE rather than a
 * sentence, so every caller can word it for its own screen without any two of
 * them disagreeing about what is legal.
 */
export type MailboxUrlDefect =
    | 'empty'
    | 'scheme'
    | 'host'
    | 'credentials'
    | 'whitespace'
    | 'query'
    | 'fragment'
    | 'too-long';

export interface MailboxUrlCheck {
    /** Canonical form: trimmed, trailing slashes stripped. '' when empty. */
    url: string;
    /** null when the URL is usable by BOTH the app and the reader. */
    defect: MailboxUrlDefect | null;
}

/**
 * THE mailbox base-URL validator. Both `mailbox_client` (which publishes to the
 * URL) and `reader_provision` (which writes it into the reader) go through this
 * one function, so the app can never provision a reader with a URL its own
 * publisher then refuses.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A REGEX AND NOT `new URL()`
 * ---------------------------------------------------------------------------
 * React Native REPLACES the global `URL` with its own non-spec polyfill
 * (`node_modules/react-native/Libraries/Blob/URL.js`, installed by
 * `Libraries/Core/setUpXHR.js`). That constructor NEVER throws on a
 * single-argument call — it just assigns `this._url = url` — so a `try/catch`
 * around it is dead code ON DEVICE, and its `protocol` getter does not
 * lower-case the scheme. The whole test suite runs on node's spec-compliant
 * `URL`, so CI structurally cannot see the difference: `https://` with no host
 * and `HTTPS://host/m/id` would behave one way here and another way on the
 * phone. Nothing in this file may depend on `URL`.
 *
 * The rules themselves come from the firmware, not from RFC 3986: the reader
 * builds its requests by plain string concatenation (`base + "/latest.txt"`,
 * MessageSync.cpp) and opens them with `http.begin(url)` (HttpDownloader.cpp),
 * so a query string, a fragment or embedded credentials produce a URL that
 * either resolves to nothing or leaks a secret into the reader's settings UI.
 */
export function checkMailboxBaseUrl(value: string): MailboxUrlCheck {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return { url: '', defect: 'empty' };

    // Case-insensitive, and `//` is required: `https:/typo` is NOT a URL the
    // reader can open, and RN's polyfill would happily report its protocol as
    // 'https:' and let it through.
    const scheme = /^(https?):\/\//i.exec(trimmed);

    // Trailing slashes come off the PATH only. Stripping back through the `//`
    // that separates scheme from authority would canonicalise `https://` into
    // `https:` and misreport a missing HOST as a bad SCHEME.
    const floor = scheme ? scheme[0].length : 0;
    let end = trimmed.length;
    while (end > floor && trimmed[end - 1] === '/') end -= 1;
    const url = trimmed.slice(0, end);

    if (!url) return { url: '', defect: 'empty' };
    if (!scheme) return { url, defect: 'scheme' };

    // Whitespace anywhere is a paste accident, never a legal base. Checked
    // before the authority split so a space cannot hide inside a host.
    if (/\s/.test(url)) return { url, defect: 'whitespace' };

    const authorityEnd = url.slice(scheme[0].length).search(/[/?#]/);
    const authority =
        authorityEnd === -1 ? url.slice(scheme[0].length) : url.slice(scheme[0].length, scheme[0].length + authorityEnd);

    // `user:pw@host` — the reader stores this URL in clear and serves it back
    // from its own /api/settings to anyone on the LAN.
    if (authority.includes('@')) return { url, defect: 'credentials' };
    // `https://` and `https:///path` have no host at all. RN's polyfill accepts
    // both, and the app would then POST to `https:/publish`.
    if (!authority) return { url, defect: 'host' };

    if (url.includes('?')) return { url, defect: 'query' };
    if (url.includes('#')) return { url, defect: 'fragment' };

    if (url.length > MAILBOX_URL_MAX_CHARS) return { url, defect: 'too-long' };

    return { url, defect: null };
}

/**
 * Explain why `value` cannot be used as a mailbox base, or null if it can.
 *
 * Returns a sentence for a user, not a code — Settings shows it under the
 * field, and {@link publishLoveNote} reports it verbatim rather than inventing
 * a second wording for the same defect.
 */
export function describeMailboxUrlProblem(value: string): string | null {
    const { url, defect } = checkMailboxBaseUrl(value);
    switch (defect) {
        case null:
            return null;
        case 'empty':
            return 'Mailbox URL is empty.';
        case 'scheme':
            return `Mailbox URL must start with http:// or https:// (got "${url}").`;
        case 'whitespace':
            return 'Mailbox URL must not contain spaces.';
        case 'credentials':
            return 'Mailbox URL must not contain a username or password.';
        case 'host':
            return `Mailbox URL has no host: "${url}".`;
        case 'query':
            // The reader concatenates "/latest.txt" onto the raw string, so a
            // query string produces a URL that resolves to nothing.
            return 'Mailbox URL must not contain a query string (the reader appends its own path).';
        case 'fragment':
            return 'Mailbox URL must not contain a #fragment (the reader appends its own path).';
        case 'too-long':
            return (
                `Mailbox URL is ${url.length} characters; the reader can only store ` +
                `${MAILBOX_URL_MAX_CHARS}. Use a shorter host or box id.`
            );
        default:
            // Exhaustiveness: a new defect must not silently become "no problem".
            return `Mailbox URL is not usable: ${url}`;
    }
}

/**
 * Canonical form of a mailbox base: trimmed, trailing slashes removed.
 *
 * Returns '' for anything {@link describeMailboxUrlProblem} rejects, so a
 * caller can treat '' as "not configured" the same way `mailboxUrl` does in
 * settings. The string is otherwise returned AS TYPED (not re-serialised
 * through `URL`) — the reader stores this exact text, and a helpful
 * normalisation such as adding a trailing slash or lower-casing a path segment
 * would change a capability URL into a different, wrong one.
 */
export function normalizeMailboxUrl(value: string): string {
    const { url, defect } = checkMailboxBaseUrl(value);
    return defect === null ? url : '';
}

/** Join a validated base and a leading-slash suffix. */
function mailboxEndpoint(base: string, suffix: string): string {
    return `${base}${suffix}`;
}

// ---------------------------------------------------------------------------
// fetch access
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<MinimalResponse>;

/** The slice of `Response` this module touches. */
interface MinimalResponse {
    status: number;
    ok?: boolean;
    text?: () => Promise<string>;
}

/**
 * Resolve `fetch` AT CALL TIME, never at module load.
 *
 * React Native installs its polyfill on the global during startup, and tests
 * swap `globalThis.fetch` per case; a module-level capture would freeze
 * whichever one happened to exist first.
 */
function getFetch(): FetchLike | null {
    const candidate = (globalThis as { fetch?: unknown }).fetch;
    return typeof candidate === 'function' ? (candidate as FetchLike) : null;
}

const NO_FETCH_ERROR = 'No HTTP client available in this runtime.';

/** Bearer header set, shared by both authenticated calls. */
function authHeaders(writeToken: string): Record<string, string> {
    return { Authorization: `Bearer ${writeToken}` };
}

/** Read a response body without ever letting a decode failure escape. */
async function readBodyText(response: MinimalResponse): Promise<string> {
    if (typeof response.text !== 'function') return '';
    try {
        return (await response.text()) ?? '';
    } catch {
        return '';
    }
}

/** First line of a server error body, clipped — enough to diagnose, not a dump. */
function bodySnippet(body: string): string {
    const line = body.trim().split('\n')[0]?.trim() ?? '';
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Publish one frame to the mailbox as the new "latest" note.
 *
 * LAST WRITE WINS, exactly like the direct path's single `current.frame` slot:
 * the server stores the frame first and moves the id pointer second, so a
 * reader polling mid-publish sees either the old note or the new one, never a
 * half-written frame under a new id.
 *
 * The frame length is checked BEFORE the network. A wrong-sized frame is an
 * encoder bug, and publishing it would be worse than failing: the server may
 * well accept it, the app would report success, and the reader would silently
 * discard the download on every sync forever.
 *
 * `onProgress` is COARSE — 0 on entry, 100 on success. `fetch` exposes no upload
 * progress in React Native, and a fake ramp would be a lie the user makes
 * decisions on ("it's at 90%, it must be nearly there").
 *
 * NEVER THROWS.
 *
 * @param mailboxUrl  `{base}` — the same string the reader stores.
 * @param writeToken  Bearer token. NEVER put this in the URL.
 * @param frame       Exactly {@link MAILBOX_FRAME_BYTES} packed 1-bit bytes.
 */
export async function publishLoveNote(
    mailboxUrl: string,
    writeToken: string,
    frame: Uint8Array,
    onProgress?: (percent: number) => void
): Promise<MailboxPublishResult> {
    if (!frame || frame.byteLength !== MAILBOX_FRAME_BYTES) {
        return {
            success: false,
            error:
                `Love-note frame must be exactly ${MAILBOX_FRAME_BYTES} bytes ` +
                `(528 rows x 99 bytes), got ${frame ? frame.byteLength : 0}`,
        };
    }

    const urlProblem = describeMailboxUrlProblem(mailboxUrl);
    if (urlProblem !== null) return { success: false, error: urlProblem };

    const token = typeof writeToken === 'string' ? writeToken.trim() : '';
    if (!token) {
        return { success: false, error: 'Mailbox write token is not set.' };
    }

    const base = checkMailboxBaseUrl(mailboxUrl).url;
    const endpoint = mailboxEndpoint(base, MAILBOX_PUBLISH_PATH);
    const noteId = mintNoteId();

    const doFetch = getFetch();
    if (!doFetch) return { success: false, error: NO_FETCH_ERROR, noteId };

    onProgress?.(0);

    // Send a plain ArrayBuffer rather than the view: React Native's fetch
    // polyfill handles both, but the copy also guarantees the request cannot
    // carry bytes outside `frame`'s window if a caller ever hands over a
    // subarray of a larger buffer.
    const body = frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength
    ) as ArrayBuffer;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
    try {
        const response = await doFetch(endpoint, {
            method: 'POST',
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/octet-stream',
                'X-Note-Id': noteId,
            },
            body,
            signal: controller.signal,
        });

        const status = response.status;
        if (status >= 200 && status < 300) {
            // The server echoes the id it stored. Trust ITS id over ours: if a
            // server ever rewrites or de-duplicates ids, History has to record
            // the value the reader will actually see.
            const serverId = parseIdFromBody(await readBodyText(response));
            onProgress?.(100);
            return { success: true, noteId: serverId || noteId, status };
        }

        return {
            success: false,
            error: describePublishStatus(status, await readBodyText(response), base),
            noteId,
            status,
        };
    } catch (error) {
        return { success: false, error: describeNetworkFailure(error, endpoint), noteId };
    } finally {
        clearTimeout(timer);
    }
}

/** Pull `id` out of a `{"ok":true,"id":"…"}` body; '' when absent or not JSON. */
function parseIdFromBody(body: string): string {
    if (!body) return '';
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
            const id = (parsed as { id?: unknown }).id;
            if (typeof id === 'string' && id.trim()) return id.trim();
        }
    } catch {
        // A non-JSON 200 is fine — the publish still happened.
    }
    return '';
}

/**
 * Turn an HTTP status into something the user can act on.
 *
 * Each branch names the SETTING to change, because that is the only lever the
 * user has: the mailbox is a server they cannot see.
 */
function describePublishStatus(status: number, body: string, base: string): string {
    const snippet = bodySnippet(body);
    const detail = snippet ? ` (${snippet})` : '';

    if (status === 401 || status === 403) {
        return `Mailbox token rejected (${status}). Check the mailbox write token in Settings.${detail}`;
    }
    if (status === 404) {
        return `Mailbox not found at ${base} (404). Check the mailbox URL in Settings.${detail}`;
    }
    if (status === 413 || status === 400) {
        return (
            `Mailbox rejected the frame (${status}): it must be exactly ` +
            `${MAILBOX_FRAME_BYTES} bytes.${detail}`
        );
    }
    if (status === 429) {
        return `Mailbox is rate-limiting (429). Wait a moment and send again.${detail}`;
    }
    if (status >= 500) {
        return `Mailbox server error (${status}). Try again in a moment.${detail}`;
    }
    return `Mailbox publish failed (${status}).${detail}`;
}

/**
 * Describe a fetch that never got an answer.
 *
 * Marked with the words `isMailboxUnreachableError` looks for, so a caller can
 * tell "the mailbox is unreachable" apart from "the mailbox said no".
 */
function describeNetworkFailure(error: unknown, endpoint: string): string {
    const isAbort =
        (error as { name?: string } | undefined)?.name === 'AbortError' ||
        String((error as { message?: string } | undefined)?.message ?? '').includes('Aborted');
    if (isAbort) {
        return (
            `Mailbox timed out after ${Math.round(PUBLISH_TIMEOUT_MS / 1000)}s — ` +
            `could not reach ${endpoint}. Check the phone's connection.`
        );
    }
    return (
        `Could not reach the mailbox — check the phone's connection and the mailbox URL. ` +
        `[${formatNetworkError(error, endpoint)}]`
    );
}

/**
 * True when `error` describes "could not talk to the mailbox" rather than "the
 * mailbox refused this note".
 *
 * The distinction decides whether a retry is worth offering: an unreachable
 * mailbox may work in a minute, a rejected token never will.
 */
export function isMailboxUnreachableError(error?: string): boolean {
    if (!error) return false;
    const text = error.toLowerCase();
    return (
        text.includes('could not reach the mailbox') ||
        text.includes('mailbox timed out') ||
        text.includes(NO_FETCH_ERROR.toLowerCase())
    );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Read the mailbox's own view of what the reader would fetch next.
 *
 * This is the ONLY read-back the app has: the reader itself reports nothing, so
 * without this a user has no way to distinguish "the note is waiting and the
 * reader hasn't woken yet" from "the publish never landed".
 *
 * NEVER THROWS.
 */
export async function fetchMailboxStatus(
    mailboxUrl: string,
    writeToken: string
): Promise<MailboxStatusResult> {
    const fetched = await fetchStatusBody(mailboxUrl, writeToken);
    if (!fetched.success) {
        return { success: false, error: fetched.error, httpStatus: fetched.httpStatus };
    }

    const body = fetched.body ?? '';
    const status = parseMailboxStatus(body);
    if (!status) {
        return {
            success: false,
            error: `Mailbox status was not readable JSON.${body ? ` (${bodySnippet(body)})` : ''}`,
            httpStatus: fetched.httpStatus,
        };
    }
    return { success: true, status, httpStatus: fetched.httpStatus };
}

/** A `/status` GET that got a 2xx, or the reason it did not. */
interface StatusBodyResult {
    success: boolean;
    error?: string;
    body?: string;
    /** Present only when the request reached the server. */
    httpStatus?: number;
}

/**
 * The single authenticated `/status` GET.
 *
 * Extracted so {@link fetchMailboxStatus} and {@link listMailboxBooks} cannot
 * end up validating the URL, spelling a 401 or bounding the timeout two
 * different ways — the note half and the book half of the same response are read
 * by the same request in the same shape.
 *
 * NEVER THROWS.
 */
async function fetchStatusBody(mailboxUrl: string, writeToken: string): Promise<StatusBodyResult> {
    const urlProblem = describeMailboxUrlProblem(mailboxUrl);
    if (urlProblem !== null) return { success: false, error: urlProblem };

    const token = typeof writeToken === 'string' ? writeToken.trim() : '';
    if (!token) return { success: false, error: 'Mailbox write token is not set.' };

    const base = checkMailboxBaseUrl(mailboxUrl).url;
    const endpoint = mailboxEndpoint(base, MAILBOX_STATUS_PATH);

    const doFetch = getFetch();
    if (!doFetch) return { success: false, error: NO_FETCH_ERROR };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
        const response = await doFetch(endpoint, {
            method: 'GET',
            headers: { ...authHeaders(token), Accept: 'application/json' },
            signal: controller.signal,
        });

        const httpStatus = response.status;
        const body = await readBodyText(response);

        if (httpStatus < 200 || httpStatus >= 300) {
            return {
                success: false,
                error: describeStatusStatus(httpStatus, body, base),
                httpStatus,
            };
        }
        return { success: true, body, httpStatus };
    } catch (error) {
        return { success: false, error: describeNetworkFailure(error, endpoint) };
    } finally {
        clearTimeout(timer);
    }
}

function describeStatusStatus(status: number, body: string, base: string): string {
    const snippet = bodySnippet(body);
    const detail = snippet ? ` (${snippet})` : '';
    if (status === 401 || status === 403) {
        return `Mailbox token rejected (${status}). Check the mailbox write token in Settings.${detail}`;
    }
    if (status === 404) {
        return `Mailbox not found at ${base} (404). Check the mailbox URL in Settings.${detail}`;
    }
    return `Could not read mailbox status (${status}).${detail}`;
}

/**
 * Decode a `/status` body, tolerating every field being absent.
 *
 * `latestId: null` is a MEANINGFUL answer ("the mailbox is empty"), which is
 * exactly the state the firmware reads as "no note", so it must not be confused
 * with a parse failure — hence null vs. a null return.
 */
function parseMailboxStatus(body: string): MailboxStatus | null {
    if (!body.trim()) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const raw = parsed as { latestId?: unknown; bytes?: unknown; updatedAt?: unknown };
    const latestId =
        typeof raw.latestId === 'string' && raw.latestId.trim() ? raw.latestId.trim() : null;
    const bytes = typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) ? raw.bytes : null;
    const updatedAt = coerceTimestamp(raw.updatedAt);
    return { latestId, bytes, updatedAt };
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

/**
 * Publish one epub to the mailbox's library.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE READER DOES WITH IT (and therefore what "success" means here)
 * ---------------------------------------------------------------------------
 * A 200 from this call means the BOOK IS IN THE MAILBOX, not that it is on the
 * reader. The reader fetches `books.txt` inside a wake window, diffs it against
 * what its SD card already holds, and pulls what is missing — over SEVERAL
 * windows for a big book, using `Range` to resume. So the honest thing to tell a
 * user after this returns is "it will land on the reader next sync", which is
 * exactly what `epub_sender` words for the UI.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A CLIENT-SIDE SIZE GUARD AT ALL
 * ---------------------------------------------------------------------------
 * The server enforces {@link MAILBOX_MAX_BOOK_BYTES} itself (413). The guard
 * here is not a second opinion, it is about WHERE the cost falls: without it the
 * phone uploads up to 24 MiB of a body that is going to be refused, on a mobile
 * connection, and the user waits for it. It also catches the case the picker
 * cannot: `epub_sender` can only apply its own limit when the DocumentsProvider
 * reported a size, and Android SAF routinely reports none — by the time the
 * bytes are here, the length is known for certain.
 *
 * `onProgress` is COARSE — 0 on entry, 100 on success. `fetch` exposes no upload
 * progress in React Native, and a fake ramp on a multi-megabyte upload would be
 * a lie the user makes decisions on.
 *
 * RE-POSTING THE SAME ID IS SUPPORTED and overwrites the blob — that is what a
 * retry after a timeout does, and it is why a timeout here is safe. Mint a NEW
 * id for DIFFERENT content ({@link mintBookId}): a reader mid-resume compares
 * the size it read from `books.txt` against every `Content-Range` and has to
 * restart when they disagree.
 *
 * NEVER THROWS.
 *
 * @param mailboxUrl  `{base}` — the same string the reader stores.
 * @param writeToken  Bearer token. NEVER put this in the URL.
 * @param bytes       The whole epub. Reading the file is the CALLER's job, so
 *                    this module keeps its zero dependency on expo/react-native.
 * @param filename    `<name>.epub`. Reject rules mirror the server; the stored
 *                    name comes back in the result.
 * @param bookId      Optional; minted when absent. Supply it only to RETRY.
 */
export async function publishBook(
    mailboxUrl: string,
    writeToken: string,
    bytes: Uint8Array,
    filename: string,
    bookId?: string,
    onProgress?: (percent: number) => void
): Promise<MailboxBookResult> {
    const byteLength = bytes ? bytes.byteLength : 0;
    if (!bytes || byteLength === 0) {
        // The server answers 400 for an empty body. An empty epub is always a
        // read that silently returned nothing, never a book.
        return { success: false, error: 'Book is empty (0 bytes) — nothing to send.' };
    }
    if (byteLength > MAILBOX_MAX_BOOK_BYTES) {
        return {
            success: false,
            error:
                `Book is ${formatMib(byteLength)}; the mailbox accepts up to ` +
                `${formatMib(MAILBOX_MAX_BOOK_BYTES)}.`,
        };
    }

    const name = typeof filename === 'string' ? filename.trim() : '';
    const nameProblem = describeBookFilenameProblem(name);
    if (nameProblem !== null) return { success: false, error: nameProblem };

    const urlProblem = describeMailboxUrlProblem(mailboxUrl);
    if (urlProblem !== null) return { success: false, error: urlProblem };

    const token = typeof writeToken === 'string' ? writeToken.trim() : '';
    if (!token) return { success: false, error: 'Mailbox write token is not set.' };

    const id = typeof bookId === 'string' && bookId.trim() ? bookId.trim() : mintBookId();
    const idProblem = describeBookIdProblem(id);
    if (idProblem !== null) return { success: false, error: idProblem };

    const base = checkMailboxBaseUrl(mailboxUrl).url;
    const endpoint = mailboxEndpoint(base, MAILBOX_BOOKS_PATH);

    const doFetch = getFetch();
    if (!doFetch) return { success: false, error: NO_FETCH_ERROR, id };

    onProgress?.(0);

    // A plain ArrayBuffer rather than the view, for the same reason
    // publishLoveNote does it: RN's fetch handles both, and the copy guarantees
    // the request cannot carry bytes outside `bytes`'s window when a caller hands
    // over a subarray of a larger buffer.
    const body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + byteLength
    ) as ArrayBuffer;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOOK_PUBLISH_TIMEOUT_MS);
    try {
        const response = await doFetch(endpoint, {
            method: 'POST',
            headers: {
                ...authHeaders(token),
                'Content-Type': 'application/octet-stream',
                'X-Book-Id': id,
                'X-Filename': name,
            },
            body,
            signal: controller.signal,
        });

        const status = response.status;
        const text = await readBodyText(response);

        if (status >= 200 && status < 300) {
            // Trust the SERVER's id and filename over ours: `X-Filename` is
            // sanitized server-side (FAT punctuation and non-ASCII are REPLACED,
            // not rejected), so the name the reader will show can legitimately
            // differ from the one sent — and a UI that reported the name it asked
            // for would name a file that is not on the card.
            const echoed = parseBookFromBody(text);
            onProgress?.(100);
            return {
                success: true,
                id: echoed.id || id,
                filename: echoed.filename || name,
                bytes: echoed.bytes ?? byteLength,
                status,
            };
        }

        return {
            success: false,
            error: describeBookPublishStatus(status, text, base),
            id,
            filename: name,
            status,
        };
    } catch (error) {
        return { success: false, error: describeNetworkFailure(error, endpoint), id, filename: name };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * List the books the mailbox is holding, newest first.
 *
 * ---------------------------------------------------------------------------
 * THIS READS `/status`, NOT `/books.txt` — deliberately.
 * ---------------------------------------------------------------------------
 * Both carry the same three fields per book. Three reasons the authenticated
 * JSON one wins for the APP:
 *
 *   1. `books.txt` is the FIRMWARE's contract, and it is byte-exact
 *      (`{id} {bytes} {filename}\n`, no header, LF, filename is the rest of the
 *      line) precisely so an ESP32 can walk it as a C string. Parsing it here
 *      would make the app a second consumer of a format whose only reason to
 *      exist is that walk — and a change made for the reader would then silently
 *      change what the app displays. `/status` is versioned JSON the app owns.
 *   2. `books.txt` has NO AUTH (the box id is the read capability). A listing
 *      that succeeds with a broken write token would show a healthy library on a
 *      mailbox this phone cannot publish to — the failure mode most likely to
 *      confuse someone whose token is wrong. Going through the bearer route
 *      means "can I see it" and "can I write it" fail together.
 *   3. It is one request for the whole picture: the same response carries the
 *      note pointer, which is what any "what is waiting for the reader?" screen
 *      wants next to the books.
 *
 * A book the server is holding whose filename does not round-trip its own
 * sanitizer is dropped SERVER-side on read, so anything listed here is a name
 * the reader can create.
 *
 * NEVER THROWS.
 */
export async function listMailboxBooks(
    mailboxUrl: string,
    writeToken: string
): Promise<MailboxBooksResult> {
    const fetched = await fetchStatusBody(mailboxUrl, writeToken);
    if (!fetched.success) {
        return { success: false, error: fetched.error, books: [], httpStatus: fetched.httpStatus };
    }

    const body = fetched.body ?? '';
    const books = parseMailboxBooks(body);
    if (!books) {
        return {
            success: false,
            error: `Mailbox status was not readable JSON.${body ? ` (${bodySnippet(body)})` : ''}`,
            books: [],
            httpStatus: fetched.httpStatus,
        };
    }
    return { success: true, books, httpStatus: fetched.httpStatus };
}

/**
 * Remove one book from the mailbox.
 *
 * WHAT THIS DOES AND DOES NOT DO: it stops the book being ADVERTISED, so a
 * reader that has not fetched it yet never will. A reader that already
 * downloaded it keeps its copy — reader-side state is authoritative and there is
 * no reverse channel, so deleting from the card is DeviceScreen's job over the
 * direct path. Saying otherwise in the UI would be a promise this contract
 * cannot keep.
 *
 * A 404 is reported as a FAILURE with its own wording rather than smoothed into
 * success: unlike the pre-delete in `epub_sender` (where "nothing there" is the
 * ordinary first-upload case), a delete here is always driven by an id the user
 * just saw in a listing, so "unknown id" means the listing and the mailbox
 * disagree and that is worth showing.
 *
 * NEVER THROWS.
 */
export async function deleteMailboxBook(
    mailboxUrl: string,
    writeToken: string,
    bookId: string
): Promise<MailboxBookResult> {
    const id = typeof bookId === 'string' ? bookId.trim() : '';
    const idProblem = describeBookIdProblem(id);
    if (idProblem !== null) return { success: false, error: idProblem };

    const urlProblem = describeMailboxUrlProblem(mailboxUrl);
    if (urlProblem !== null) return { success: false, error: urlProblem, id };

    const token = typeof writeToken === 'string' ? writeToken.trim() : '';
    if (!token) return { success: false, error: 'Mailbox write token is not set.', id };

    const base = checkMailboxBaseUrl(mailboxUrl).url;
    // The id is charset-restricted to [A-Za-z0-9._~-] above, so it needs no
    // escaping here — and MUST NOT be encoded: the server compares the raw path
    // segment against its stored id.
    const endpoint = mailboxEndpoint(base, `${MAILBOX_BOOKS_PATH}/${id}`);

    const doFetch = getFetch();
    if (!doFetch) return { success: false, error: NO_FETCH_ERROR, id };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOOK_DELETE_TIMEOUT_MS);
    try {
        const response = await doFetch(endpoint, {
            method: 'DELETE',
            headers: { ...authHeaders(token), Accept: 'application/json' },
            signal: controller.signal,
        });

        const status = response.status;
        const text = await readBodyText(response);

        if (status >= 200 && status < 300) {
            const echoed = parseBookFromBody(text);
            return { success: true, id: echoed.id || id, filename: echoed.filename, status };
        }
        if (status === 404) {
            return {
                success: false,
                error: `The mailbox has no book with id "${id}" (404). Refresh the list.`,
                id,
                status,
            };
        }
        return { success: false, error: describeBookPublishStatus(status, text, base), id, status };
    } catch (error) {
        return { success: false, error: describeNetworkFailure(error, endpoint), id };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Turn a book route's HTTP status into something the user can act on.
 *
 * Separate from {@link describePublishStatus} because the SAME codes mean
 * different things on this route: a 413 here is a book over the 24 MiB cap
 * (actionable — send a smaller one), while a 413 on `/publish` is a wrong-sized
 * frame (an encoder bug the user cannot fix).
 */
function describeBookPublishStatus(status: number, body: string, base: string): string {
    const snippet = bodySnippet(body);
    const detail = snippet ? ` (${snippet})` : '';

    if (status === 401 || status === 403) {
        return `Mailbox token rejected (${status}). Check the mailbox write token in Settings.${detail}`;
    }
    if (status === 404) {
        return `Mailbox not found at ${base} (404). Check the mailbox URL in Settings.${detail}`;
    }
    if (status === 413) {
        return (
            `Mailbox rejected the book (413): it is over the ` +
            `${formatMib(MAILBOX_MAX_BOOK_BYTES)} limit.${detail}`
        );
    }
    if (status === 400) {
        return `Mailbox rejected the book (400): bad id, filename or empty body.${detail}`;
    }
    if (status === 429) {
        return `Mailbox is rate-limiting (429). Wait a moment and send again.${detail}`;
    }
    if (status >= 500) {
        return `Mailbox server error (${status}). Try again in a moment.${detail}`;
    }
    return `Mailbox rejected the book (${status}).${detail}`;
}

/** Whole MiB where exact, one decimal otherwise: '24 MiB', '8.5 MiB'. */
function formatMib(bytes: number): string {
    const mib = bytes / (1024 * 1024);
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

/**
 * Pull `{id, filename, bytes}` out of a book route's JSON body.
 *
 * Every field is optional in the return: a 200 whose body did not parse still
 * means the write HAPPENED (same reasoning as `parseIdFromBody`), so the caller
 * falls back to what it sent rather than reporting a failure that would have the
 * user upload the same book twice.
 */
function parseBookFromBody(body: string): { id?: string; filename?: string; bytes?: number } {
    if (!body) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const raw = parsed as { id?: unknown; filename?: unknown; bytes?: unknown };
    const out: { id?: string; filename?: string; bytes?: number } = {};
    if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
    if (typeof raw.filename === 'string' && raw.filename.trim()) out.filename = raw.filename.trim();
    if (typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes >= 0) {
        out.bytes = raw.bytes;
    }
    return out;
}

/**
 * Decode the `books` array out of a `/status` body.
 *
 * `[]` and a MISSING `books` key are both "no books" — a box that has only ever
 * held notes answers without the key at all, and that is a normal, empty library
 * rather than a parse failure. `null` is returned ONLY when the body is not
 * JSON, so the caller can tell "the mailbox is empty" from "that was not a
 * mailbox".
 *
 * Entries are validated, not trusted: an entry missing an id or a filename is
 * DROPPED rather than rendered blank, because the id is the handle every
 * subsequent action (delete, retry) needs.
 */
function parseMailboxBooks(body: string): MailboxBook[] | null {
    if (!body.trim()) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const raw = (parsed as { books?: unknown }).books;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return [];

    const books: MailboxBook[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as { id?: unknown; filename?: unknown; bytes?: unknown };
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        const filename = typeof row.filename === 'string' ? row.filename.trim() : '';
        if (!id || !filename) continue;
        const bytes =
            typeof row.bytes === 'number' && Number.isFinite(row.bytes) && row.bytes >= 0
                ? row.bytes
                : 0;
        books.push({ id, filename, bytes });
    }
    return books;
}

// ---------------------------------------------------------------------------
// Wallpapers
// ---------------------------------------------------------------------------

/**
 * Publish one 8-bit grayscale BMP to the mailbox as a pending sleep screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT "SUCCESS" MEANS HERE (and it is not "the panel changed")
 * ---------------------------------------------------------------------------
 * A 200 means THE PICTURE IS IN THE MAILBOX. The reader fetches
 * `wallpaper.txt` inside a wake window, pulls what it has not applied yet, and
 * writes it to `/sleep.bmp` or `/.sleep/<filename>`. So the honest sentence for
 * a user after this returns is "it will land on the reader next sync" — the
 * same promise `publishBook` makes, and for the same reason.
 *
 * AND EVEN THEN THE PANEL MAY NOT CHANGE: the reader only shows a custom sleep
 * screen when its own Sleep Screen setting is 'Custom', which is an ON-DEVICE
 * toggle with no remote equivalent. `wallpaper_sender.SLEEP_MODE_HINT` is the
 * one canonical wording for that; this route does not change the fact.
 *
 * THE 'BM' MAGIC IS CHECKED BEFORE THE UPLOAD. Not paranoia: the direct route
 * checks it too (`sendWallpaperBmp`), and the failure it catches — a love-note
 * frame handed to a wallpaper call — would otherwise be a file the firmware
 * tries and fails to decode on every single sleep, with a cheerful "sent" in
 * the app. A guard the two roads share cannot disagree about what a wallpaper is.
 *
 * RE-POSTING THE SAME ID OVERWRITES, which is what makes a retry after a
 * timeout safe. Mint a NEW id ({@link mintWallpaperId}) for DIFFERENT content: a
 * reader mid-resume compares the size it read from `wallpaper.txt` against every
 * `Content-Range` and has to restart when they disagree.
 *
 * `onProgress` is COARSE — 0 on entry, 100 on success. `fetch` exposes no upload
 * progress in React Native and a fake ramp is a lie the user acts on.
 *
 * NEVER THROWS.
 *
 * @param mailboxUrl   `{base}` — the same string the reader stores.
 * @param writeToken   Bearer token. NEVER put this in the URL.
 * @param bmp          The whole BMP. Encoding is the CALLER's job, so this
 *                     module keeps its zero dependency on expo/react-native.
 * @param target       'primary' for `/sleep.bmp`, 'set' for the rotation.
 * @param filename     REQUIRED for 'set', IGNORED for 'primary' (the slot is
 *                     fixed, so a name would be a value the reader must discard).
 * @param wallpaperId  Optional; minted when absent. Supply it only to RETRY.
 */
export async function publishWallpaper(
    mailboxUrl: string,
    writeToken: string,
    bmp: Uint8Array,
    target: MailboxWallpaperTarget,
    filename?: string,
    wallpaperId?: string,
    onProgress?: (percent: number) => void
): Promise<MailboxWallpaperResult> {
    if (target !== 'primary' && target !== 'set') {
        return {
            success: false,
            error: `Unknown wallpaper target ${JSON.stringify(target)} (expected 'primary' or 'set').`,
        };
    }

    const byteLength = bmp ? bmp.byteLength : 0;
    if (!bmp || byteLength === 0) {
        return { success: false, error: 'Wallpaper is empty (0 bytes) — nothing to send.' };
    }
    if (bmp[0] !== BMP_MAGIC_B || bmp[1] !== BMP_MAGIC_M) {
        return {
            success: false,
            error:
                'Wallpaper payload is not a BMP (expected a "BM" header from prepareWallpaperBmp).',
        };
    }
    if (byteLength > MAILBOX_MAX_WALLPAPER_BYTES) {
        return {
            success: false,
            error:
                `Wallpaper is ${formatMib(byteLength)}; the mailbox accepts up to ` +
                `${formatMib(MAILBOX_MAX_WALLPAPER_BYTES)}.`,
        };
    }

    // 'primary' carries NO name. Dropping it here rather than sending it and
    // letting the server ignore it keeps one rule in one place: what the app
    // puts on the wire is exactly what the server will act on.
    const name = target === 'set' ? (typeof filename === 'string' ? filename.trim() : '') : '';
    if (target === 'set') {
        const nameProblem = describeWallpaperFilenameProblem(name);
        if (nameProblem !== null) return { success: false, error: nameProblem };
    }

    const urlProblem = describeMailboxUrlProblem(mailboxUrl);
    if (urlProblem !== null) return { success: false, error: urlProblem };

    const token = typeof writeToken === 'string' ? writeToken.trim() : '';
    if (!token) return { success: false, error: 'Mailbox write token is not set.' };

    const id =
        typeof wallpaperId === 'string' && wallpaperId.trim() ? wallpaperId.trim() : mintWallpaperId();
    const idProblem = describeWallpaperIdProblem(id);
    if (idProblem !== null) return { success: false, error: idProblem };

    const base = checkMailboxBaseUrl(mailboxUrl).url;
    const endpoint = mailboxEndpoint(base, MAILBOX_WALLPAPER_PATH);

    const doFetch = getFetch();
    if (!doFetch) return { success: false, error: NO_FETCH_ERROR, id, target };

    onProgress?.(0);

    // A plain ArrayBuffer rather than the view, for the reason publishLoveNote
    // and publishBook both do it: the copy guarantees the request cannot carry
    // bytes outside `bmp`'s window when a caller hands over a subarray.
    const body = bmp.buffer.slice(bmp.byteOffset, bmp.byteOffset + byteLength) as ArrayBuffer;

    const headers: Record<string, string> = {
        ...authHeaders(token),
        'Content-Type': 'application/octet-stream',
        'X-Wallpaper-Id': id,
        'X-Wallpaper-Target': target,
    };
    if (target === 'set') headers['X-Filename'] = name;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WALLPAPER_PUBLISH_TIMEOUT_MS);
    try {
        const response = await doFetch(endpoint, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
        });

        const status = response.status;
        const text = await readBodyText(response);

        if (status >= 200 && status < 300) {
            // Trust the SERVER's echo over ours, exactly as publishBook does:
            // `X-Filename` is sanitized server-side (FAT punctuation and
            // non-ASCII are REPLACED, not rejected), so the name the reader will
            // create can legitimately differ from the one sent.
            const echoed = parseWallpaperFromBody(text);
            onProgress?.(100);
            return {
                success: true,
                id: echoed.id || id,
                target: echoed.target ?? target,
                filename: echoed.filename ?? name,
                bytes: echoed.bytes ?? byteLength,
                status,
            };
        }

        return {
            success: false,
            error: describeWallpaperPublishStatus(status, text, base),
            id,
            target,
            filename: name,
            status,
        };
    } catch (error) {
        return {
            success: false,
            error: describeNetworkFailure(error, endpoint),
            id,
            target,
            filename: name,
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * List the wallpapers the mailbox is holding.
 *
 * READS `/status`, NOT `/wallpaper.txt`, for the three reasons
 * {@link listMailboxBooks} sets out and which apply here verbatim: the text
 * manifest is the FIRMWARE's byte-exact contract and the app must not become a
 * second consumer of it; it has NO AUTH, so a listing that worked with a broken
 * write token would show a healthy queue on a box this phone cannot publish to;
 * and one authenticated request already carries the note pointer, the books and
 * the wallpapers together.
 *
 * ORDER IS THE SERVER'S, AND `/status` IS NEWEST FIRST — the same order
 * {@link listMailboxBooks} returns, because both read the STORED index, which
 * core.js keeps newest-first for books and wallpapers alike (publish does
 * `[entry, ...kept]`).
 *
 * DO NOT CONFUSE THIS WITH `wallpaper.txt`, WHICH IS NEWEST LAST. That reversal
 * is applied inside `renderWallpaperManifest` and NOWHERE ELSE: it exists
 * because a reader APPLIES the lines in order and the last primary written wins
 * `/sleep.bmp`, so the firmware's wire has to end on the newest. Nothing about
 * that ordering reaches this function — `/status` is JSON for a human-facing
 * list, not a sequence anyone applies. A UI that wants newest-first (they all
 * do) renders this array as it arrives; reversing it yields OLDEST first.
 *
 * NEVER THROWS.
 */
export async function listMailboxWallpapers(
    mailboxUrl: string,
    writeToken: string
): Promise<MailboxWallpapersResult> {
    const fetched = await fetchStatusBody(mailboxUrl, writeToken);
    if (!fetched.success) {
        return {
            success: false,
            error: fetched.error,
            wallpapers: [],
            httpStatus: fetched.httpStatus,
        };
    }

    const body = fetched.body ?? '';
    const wallpapers = parseMailboxWallpapers(body);
    if (!wallpapers) {
        return {
            success: false,
            error: `Mailbox status was not readable JSON.${body ? ` (${bodySnippet(body)})` : ''}`,
            wallpapers: [],
            httpStatus: fetched.httpStatus,
        };
    }
    return { success: true, wallpapers, httpStatus: fetched.httpStatus };
}

/**
 * Remove one wallpaper from the mailbox.
 *
 * WHAT THIS DOES AND DOES NOT DO, same as {@link deleteMailboxBook}: it stops
 * the picture being ADVERTISED, so a reader that has not applied it yet never
 * will. A reader that already wrote it to the card KEEPS it — reader-side state
 * is authoritative and there is no reverse channel, so removing `/sleep.bmp`
 * from the card is the direct route's job (`deleteSleepSetEntry`, or a new
 * primary that replaces it). Saying otherwise in the UI would be a promise this
 * contract cannot keep.
 *
 * NEVER THROWS.
 */
export async function deleteMailboxWallpaper(
    mailboxUrl: string,
    writeToken: string,
    wallpaperId: string
): Promise<MailboxWallpaperResult> {
    const id = typeof wallpaperId === 'string' ? wallpaperId.trim() : '';
    const idProblem = describeWallpaperIdProblem(id);
    if (idProblem !== null) return { success: false, error: idProblem };

    const urlProblem = describeMailboxUrlProblem(mailboxUrl);
    if (urlProblem !== null) return { success: false, error: urlProblem, id };

    const token = typeof writeToken === 'string' ? writeToken.trim() : '';
    if (!token) return { success: false, error: 'Mailbox write token is not set.', id };

    const base = checkMailboxBaseUrl(mailboxUrl).url;
    // Charset-restricted to [A-Za-z0-9._~-] above, so no escaping is needed —
    // and MUST NOT be applied: the server compares the raw path segment.
    const endpoint = mailboxEndpoint(base, `${MAILBOX_WALLPAPER_PATH}/${id}`);

    const doFetch = getFetch();
    if (!doFetch) return { success: false, error: NO_FETCH_ERROR, id };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOOK_DELETE_TIMEOUT_MS);
    try {
        const response = await doFetch(endpoint, {
            method: 'DELETE',
            headers: { ...authHeaders(token), Accept: 'application/json' },
            signal: controller.signal,
        });

        const status = response.status;
        const text = await readBodyText(response);

        if (status >= 200 && status < 300) {
            const echoed = parseWallpaperFromBody(text);
            return {
                success: true,
                id: echoed.id || id,
                target: echoed.target,
                filename: echoed.filename,
                status,
            };
        }
        if (status === 404) {
            return {
                success: false,
                error: `The mailbox has no wallpaper with id "${id}" (404). Refresh the list.`,
                id,
                status,
            };
        }
        return {
            success: false,
            error: describeWallpaperPublishStatus(status, text, base),
            id,
            status,
        };
    } catch (error) {
        return { success: false, error: describeNetworkFailure(error, endpoint), id };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Turn a wallpaper route's HTTP status into something the user can act on.
 *
 * Separate from {@link describeBookPublishStatus} because the SAME codes name
 * different limits: a 413 here is a picture over 4 MiB, not a book over 24.
 */
function describeWallpaperPublishStatus(status: number, body: string, base: string): string {
    const snippet = bodySnippet(body);
    const detail = snippet ? ` (${snippet})` : '';

    if (status === 401 || status === 403) {
        return `Mailbox token rejected (${status}). Check the mailbox write token in Settings.${detail}`;
    }
    if (status === 404) {
        return `Mailbox not found at ${base} (404). Check the mailbox URL in Settings.${detail}`;
    }
    if (status === 413) {
        return (
            `Mailbox rejected the wallpaper (413): it is over the ` +
            `${formatMib(MAILBOX_MAX_WALLPAPER_BYTES)} limit.${detail}`
        );
    }
    if (status === 400) {
        return `Mailbox rejected the wallpaper (400): bad id, target, filename or empty body.${detail}`;
    }
    if (status === 429) {
        return `Mailbox is rate-limiting (429). Wait a moment and send again.${detail}`;
    }
    if (status >= 500) {
        return `Mailbox server error (${status}). Try again in a moment.${detail}`;
    }
    return `Mailbox rejected the wallpaper (${status}).${detail}`;
}

/** Coerce an unknown into a wallpaper target, or undefined. */
function asWallpaperTarget(value: unknown): MailboxWallpaperTarget | undefined {
    return value === 'primary' || value === 'set' ? value : undefined;
}

/**
 * Pull `{id, target, filename, bytes}` out of a wallpaper route's JSON body.
 *
 * Every field is optional in the return for the reason `parseBookFromBody` gives:
 * a 200 whose body did not parse still means the write HAPPENED, so the caller
 * falls back to what it sent rather than reporting a failure that would have the
 * user upload the same picture twice.
 */
function parseWallpaperFromBody(body: string): {
    id?: string;
    target?: MailboxWallpaperTarget;
    filename?: string;
    bytes?: number;
} {
    if (!body) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const raw = parsed as { id?: unknown; target?: unknown; filename?: unknown; bytes?: unknown };
    const out: { id?: string; target?: MailboxWallpaperTarget; filename?: string; bytes?: number } =
        {};
    if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
    const target = asWallpaperTarget(raw.target);
    if (target) out.target = target;
    // '' is a MEANINGFUL echo for a primary ("no name"), so an empty string is
    // kept rather than falling back to what was sent.
    if (typeof raw.filename === 'string') out.filename = raw.filename.trim();
    if (typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes >= 0) {
        out.bytes = raw.bytes;
    }
    return out;
}

/**
 * Decode the `wallpapers` array out of a `/status` body.
 *
 * `[]` and a MISSING key are both "none waiting" — a box that has only ever held
 * notes answers without the key at all. `null` is returned ONLY when the body is
 * not JSON, so a caller can tell "the queue is empty" from "that was not a
 * mailbox".
 *
 * Entries are validated, not trusted. An entry with no id, or with a target
 * that is neither word, is DROPPED: the id is the handle every subsequent action
 * needs, and a row whose target cannot be read cannot be described to the user
 * ("pinned" versus "in the rotation" is the whole difference between the two).
 * A 'set' row with no filename is dropped for the same reason — that name IS the
 * file the reader will create.
 */
function parseMailboxWallpapers(body: string): MailboxWallpaper[] | null {
    if (!body.trim()) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const raw = (parsed as { wallpapers?: unknown }).wallpapers;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return [];

    const wallpapers: MailboxWallpaper[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as {
            id?: unknown;
            target?: unknown;
            filename?: unknown;
            bytes?: unknown;
        };
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        const target = asWallpaperTarget(row.target);
        if (!id || !target) continue;
        const filename = typeof row.filename === 'string' ? row.filename.trim() : '';
        if (target === 'set' && !filename) continue;
        const bytes =
            typeof row.bytes === 'number' && Number.isFinite(row.bytes) && row.bytes >= 0
                ? row.bytes
                : 0;
        wallpapers.push({ id, target, filename: target === 'primary' ? '' : filename, bytes });
    }
    return wallpapers;
}

/** Accept an epoch number or an ISO string; anything else becomes null. */
function coerceTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}
