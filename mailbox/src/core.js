/**
 * Xteink mailbox — PURE request-handling core.
 *
 * This module has NO platform imports (no Cloudflare, no node:*). It is the one
 * place the wire contract lives; `worker.js` (Cloudflare Workers) and
 * `scripts/mailbox_dev_server.mjs` (local node http) are thin adapters over it,
 * so a behaviour proven by `scripts/mailbox-core.test.js` holds on BOTH.
 *
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT (the reader firmware is the fixed side — do not "improve" it)
 *
 * Base URL handed to the reader: {origin}/m/{boxId}
 *
 *   FIRMWARE READS — no auth, protected only by the unguessable boxId.
 *   TLS: every shipping firmware env compiles wolfSSL (`-DFREEINK_NET_WOLFSSL=1`
 *   lives in platformio.ini's shared `[base] build_flags`, line 41, and all five
 *   `[env:*]` expand `${base.build_flags}`), and `runGetWolf` calls
 *   `http.setInsecure()` (HttpDownloader.cpp:56). So a SELF-SIGNED https origin
 *   works and there is no CA bundle to design around; the
 *   `esp_crt_bundle_attach` branch is `#if !defined(FREEINK_NET_WOLFSSL)` and is
 *   dead code. Plain http works too.
 *     GET {base}/latest.txt     -> 200 text/plain, body = note id, or a
 *                                  ZERO-LENGTH body meaning "no note".
 *                                  (crosspoint-reader MessageSync.cpp treats a
 *                                  non-200 as a failed sync and an empty body
 *                                  as "mailbox empty"; a 404 for an empty box
 *                                  would log an error every wake.)
 *     GET {base}/current.frame  -> 200 application/octet-stream, EXACTLY 52272
 *                                  bytes — always the frame belonging to the id
 *                                  latest.txt reports. 404 when the box has no
 *                                  note, or when a replica has the pointer but
 *                                  not yet that note's frame (self-healing; see
 *                                  the content-addressing note below). The
 *                                  firmware re-checks the size and discards
 *                                  anything else, so serving a short/long body
 *                                  is a silent no-op there — we reject it on
 *                                  the WRITE side instead.
 *
 *   APP WRITES — bearer auth:
 *     POST {base}/publish       Authorization: Bearer <writeToken>
 *                               Content-Type: application/octet-stream
 *                               X-Note-Id: <id>
 *                               body = exactly 52272 bytes
 *                            -> 200 {"ok":true,"id":...}
 *                               401 bad/missing token
 *                               400 bad id, or body present but wrong size
 *                               413 body larger than one frame
 *     GET  {base}/status        Authorization: Bearer <writeToken>
 *                            -> 200 {"latestId":…, "bytes":…, "updatedAt":…,
 *                                    "books":[{id,filename,bytes}]}
 *
 * ---------------------------------------------------------------------------
 * BOOKS RIDE THE SAME MAILBOX (additive — no notes key or route changes)
 * ---------------------------------------------------------------------------
 * The north star is that the reader NEVER re-enters transfer mode after
 * provisioning. Notes already pull-sync; epubs use the same box, the same
 * capability URL and the same bearer token, so nothing new has to be
 * provisioned on the device.
 *
 *   FIRMWARE READS — no auth (the boxId is the capability, as above):
 *     GET  {base}/books.txt        -> 200 text/plain, ONE LINE PER BOOK:
 *                                     "{id} {bytes} {filename}\n", NEWEST
 *                                     FIRST, and a ZERO-LENGTH body when the
 *                                     box holds none (same reasoning as
 *                                     latest.txt: an empty library is a normal
 *                                     wake, not an error to log). The reader
 *                                     diffs this against its local /books.
 *     GET  {base}/books/{id}       -> 200 application/epub+zip, full body, and
 *                                     `Accept-Ranges: bytes`.
 *                                     WITH `Range: bytes=N-` or `bytes=N-M`
 *                                     -> 206 + `Content-Range: bytes N-M/size`
 *                                     and exactly that slice. THIS IS THE
 *                                     RESUME MECHANISM: an ESP32 wake window is
 *                                     bounded (WiFi is up for seconds, on
 *                                     battery), so a 3 MB epub is fetched
 *                                     across several windows, each one asking
 *                                     for the bytes after what it already has.
 *                                     An unsatisfiable range -> 416 whose
 *                                     Content-Range is "bytes" SP star slash
 *                                     size (RFC 9110 unsatisfied-range form).
 *     HEAD {base}/books/{id}       -> the same headers, no body.
 *
 *   APP WRITES — bearer auth:
 *     POST   {base}/books          X-Book-Id: <id>   (NOTE_ID_PATTERN, <=64)
 *                                  X-Filename: <name.epub>
 *                                  Content-Type: application/octet-stream
 *                                  body = the epub, 1..MAX_BOOK_BYTES
 *                               -> 200 {"ok":true,"id","filename","bytes"}
 *                                  401 / 400 / 413 exactly as /publish
 *     DELETE {base}/books/{id}  -> 200 {"ok":true,"id","filename"} · 404
 *
 * NO SERVER-SIDE ACKS, DELIBERATELY. Nothing here records what the reader has
 * downloaded: reader-side state (what is in /books) is authoritative, and the
 * manifest is a pure statement of what the box currently holds. An ack would
 * add a write the reader has to make inside its wake window, and a state that
 * can disagree with the SD card after a card swap or a failed write.
 *
 * ORDERING, mirroring the notes path:
 *   publish  writes the BLOB first, the index second — the manifest can never
 *            advertise a book whose bytes are absent, which would cost the
 *            reader a whole wake window on a 404.
 *   delete   writes the INDEX first, drops the blob second — the mirror image,
 *            for the same reason.
 *
 * BOOK IDS ARE MEANT TO BE IMMUTABLE. Re-POSTing the same id is supported
 * (that is what a retry does) and overwrites the blob, but a reader that is
 * mid-resume across wake windows has no way to notice bytes changing underneath
 * it beyond the total size in `Content-Range`. So the reader MUST compare that
 * total against the `bytes` field it read from books.txt and restart the
 * download when they disagree; the app should mint a new id for different
 * content rather than rely on it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FRAME KEY IS CONTENT-ADDRESSED — read before "simplifying" it
 * ---------------------------------------------------------------------------
 * The reader pairs an id and a frame across TWO SEPARATE HTTP REQUESTS
 * (MessageSync.cpp: `fetchUrl(base + "/latest.txt")` then
 * `downloadToFile(base + "/current.frame")`), and it stages the downloaded
 * bytes under the id it read FIRST. So any moment at which those two routes can
 * disagree is a moment at which the reader stages note X's pixels under note
 * Y's id — and because it then sets messageLastShownId = Y, latest.txt == Y
 * forever after and the frame is NEVER re-fetched. Y's real image is lost
 * silently: the app reported success and neither side can detect it.
 *
 * A SINGLE MUTABLE `box:{id}:frame` slot makes that reachable without any race
 * at all on Workers KV. `meta` and `frame` would be two independent keys: reads
 * are per-key edge-cached (60 s floor) and writes replicate per key, so one colo
 * routinely holds a FRESH meta and a STALE frame. The write ORDER only
 * constrains the origin, not a replica. The stale frame is still exactly 52272
 * bytes, so the firmware's size gate passes and it stages the wrong picture.
 *
 * So the frame key carries the note id: `box:{id}:frame:{noteId}`. The bytes
 * `current.frame` serves are selected BY the id in the meta record read in that
 * same request, which makes a mismatched (id, bytes) pair unrepresentable
 * within one request:
 *
 *   meta fresh (Y), frame:Y not replicated yet -> 404. The firmware logs a
 *       failed download, stages nothing, and retries at the next sleep.
 *       SELF-HEALING, and 404 is a state the contract already defines.
 *   meta stale (X) -> serves frame:X, which is RETAINED (see the GC rule
 *       below). A consistent OLD pair: the "delayed by one cycle" behaviour the
 *       README documents, which is benign.
 *
 * GC RULE: publish keeps the new note's frame AND the immediately previous
 * one, and deletes anything older. Keeping the previous one is what turns a
 * stale-meta replica into a consistent old pair instead of a 404. Two frames
 * per box, ~104 KB, is the entire cost.
 *
 * PUBLISH ORDER — frame first, pointer second, always. `latest.txt` can never
 * advertise an id whose frame is not already written, and (unlike the mutable
 * slot) writing frame:{new} does not disturb frame:{old}, so there is no window
 * in which the pointer and the bytes disagree AT THE ORIGIN at all.
 *
 * RESIDUAL, AND IT CANNOT BE CLOSED HERE: if a publish lands strictly BETWEEN
 * the reader's two GETs, the reader read id X and then downloads Y's bytes.
 * It renders Y, records lastShown = X, and at the next sync sees latest.txt = Y
 * != X, re-downloads and renders Y again. Net: X is skipped, Y is shown twice.
 * The latest note always ends up displayed correctly, so this is self-
 * correcting, unlike the permanent loss above. Closing it would need the reader
 * to name the id in its frame request, and the firmware fetches a FIXED
 * `/current.frame` URL — so it is a property of the wire contract, not a bug we
 * can fix on this side. Pinned by the interleaving tests.
 * ---------------------------------------------------------------------------
 *
 * store: {
 *   get(key)           -> Promise<Uint8Array|null>,
 *   put(key, bytes)    -> Promise<void>,
 *   delete?(key)       -> Promise<void>   // OPTIONAL; absent = frames accumulate
 *   // OPTIONAL PAIR, and only useful for books. Present together or not at all.
 *   // With them a ranged book read touches only the requested window instead of
 *   // materialising the whole 24 MB value; without them (Workers KV has no
 *   // ranged read) the value is fetched once and sliced. Same bytes either way.
 *   stat?(key)                  -> Promise<{bytes: number}|null>,
 *   getRange?(key, start, len)  -> Promise<Uint8Array|null>
 * }
 * config: { writeToken: string, now?: () => number }
 */

/** Panel framebuffer size: 528 rows x 99 bytes/row, 1-bit, MSB first. */
export const FRAME_BYTES = 52272;

/**
 * Reader-side URL budget. `CrossPointSettings.h` declares
 * `char messageSyncUrl[128]` and `CrossPointSettings.cpp:25` copies it with
 * `strncpy(dest, src, maxLen - 1)`, so 127 characters is the real ceiling and
 * a 128th character is silently TRUNCATED — which would point the reader at a
 * mangled capability URL that 404s forever. Enforce on the way in.
 */
export const READER_URL_MAX_LEN = 127;

/**
 * boxId = the read capability. `generateBoxId` draws 16 CSPRNG bytes = 128 bits
 * of entropy, encoded as 22 base64url characters. (22 base64url chars can
 * ENCODE 132 bits; only 128 of them are random. Still comfortably past the
 * 128-bit bar an unguessable capability URL needs.)
 */
export const BOX_ID_MIN_LEN = 22;
export const BOX_ID_MAX_LEN = 64;
export const BOX_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/**
 * Note id charset. Deliberately narrower than "whatever the app mints": the id
 * is echoed verbatim as the whole body of latest.txt and the firmware's
 * `trimId()` strips spaces/tabs/CR/LF, so an id containing any of those would
 * round-trip to something different from what was published and break dedup.
 */
export const NOTE_ID_MAX_LEN = 64;
export const NOTE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * Refuse to serve authenticated routes behind a trivially guessable token.
 * A misconfigured deploy must fail loudly (503), never fall open.
 */
export const MIN_WRITE_TOKEN_LEN = 16;

/**
 * Largest body any adapter should read off the socket before calling in here.
 * One frame plus slack; anything bigger is answered 413 without buffering.
 *
 * THIS IS THE NOTES CAP AND IT STAYS SMALL. `POST /books` needs three orders of
 * magnitude more, so adapters ask {@link requestBodyLimit} for the per-route
 * limit instead of reading this constant directly — raising it globally would
 * let a bogus 24 MB /publish be buffered before the size check rejects it.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Per-book hard cap — ONE constant for both adapters, so what the app is
 * allowed to send never depends on where the mailbox is deployed.
 *
 * The books brief asked for 30 MB. Workers KV caps a single VALUE at 25 MiB
 * (26214400 B), and a 30 MB epub would therefore be accepted here, answered
 * 200, and then fail its `kv.put` — the worst possible outcome, because the app
 * reports success for a book the reader can never see. 24 MiB sits inside the
 * KV ceiling with room to spare and is ~5x the largest realistic epub.
 *
 * The dev server's file store has no such limit; it is capped to the same value
 * anyway so a book that works on the LAN works on Workers unchanged.
 */
export const MAX_BOOK_BYTES = 24 * 1024 * 1024; // 25165824

/**
 * Manifest entries per box. The 21st book evicts the OLDEST (its index entry
 * and its blob both go).
 *
 * A cap is not politeness: without one the manifest grows without bound, and it
 * is fetched in full on every wake window the reader opens. 20 lines is ~2 KB.
 */
export const MAX_BOOKS = 20;

/**
 * Book ids share the note-id charset. Same reason it is narrow: the id is
 * echoed verbatim into a books.txt line and appears in a URL path segment, so
 * space, tab, CR, LF, `/` and `%` all have to be impossible rather than
 * escaped. `.` and `..` are rejected on top (see {@link validateBookId}).
 */
export const BOOK_ID_MAX_LEN = NOTE_ID_MAX_LEN;
export const BOOK_ID_PATTERN = NOTE_ID_PATTERN;

/**
 * Filename budget. Rejected, never truncated — truncation would silently drop
 * the `.epub` extension, and the reader writes this name straight to its SD
 * card. 120 is well inside a FAT/exFAT long name (255) and keeps a manifest
 * line under ~150 bytes.
 */
export const BOOK_FILENAME_MAX_LEN = 120;

/** What `GET {base}/books/{id}` serves. */
export const BOOK_CONTENT_TYPE = 'application/epub+zip';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * KV/Map key for ONE note's frame bytes.
 *
 * CONTENT-ADDRESSED BY NOTE ID, deliberately — see the header. A single mutable
 * `box:{id}:frame` slot lets an eventually-consistent store hand a reader a
 * fresh id paired with a stale frame, which the firmware stages and then dedups
 * away forever.
 */
export function frameKey(boxId, noteId) {
    return `box:${boxId}:frame:${noteId}`;
}

/** KV/Map key for a box's id pointer + metadata. Exactly one per box. */
export function metaKey(boxId) {
    return `box:${boxId}:meta`;
}

/**
 * KV/Map key for a box's book manifest. Exactly one per box.
 *
 * ADDITIVE: no note key changes shape or meaning when books arrive, so a box
 * that has only ever held notes is byte-identical in the store to what it was
 * before this route existed.
 */
export function booksIndexKey(boxId) {
    return `box:${boxId}:books:index`;
}

/**
 * KV/Map key for ONE book's epub bytes.
 *
 * Content-addressed by book id for the same reason frames are: the manifest
 * names the id, and the bytes served are selected BY that id inside one request,
 * so a replica that has the manifest but not yet the blob can only 404 — never
 * hand out a different book's bytes under this book's name. (The dev server's
 * file store maps `:` to `_`, and `book:` vs `books:` keeps that mapping
 * injective: `box_X_book_s_index` is not `box_X_books_index`.)
 */
export function bookKey(boxId, bookId) {
    return `box:${boxId}:book:${bookId}`;
}

// ---------------------------------------------------------------------------
// Small helpers (exported so the tests and the dev server can reuse them)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url, unpadded. Hand-rolled rather than btoa(): `btoa` is a deprecated
 * global in node and its output still needs three replaces, so this is both
 * fewer moving parts and identical on Workers.
 */
export function base64UrlEncode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64URL_ALPHABET[b0 >> 2];
        out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
        if (i + 1 < bytes.length) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
        if (i + 2 < bytes.length) out += B64URL_ALPHABET[b2 & 0x3f];
    }
    return out;
}

function randomBytes(n) {
    const bytes = new Uint8Array(n);
    // Present on Workers and on node >= 19 as a global.
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
}

/** 22-char base64url box id (16 random bytes). This IS the read capability. */
export function generateBoxId() {
    return base64UrlEncode(randomBytes(16));
}

/** 43-char base64url write token (32 random bytes). Never goes in a URL. */
export function generateWriteToken() {
    return base64UrlEncode(randomBytes(32));
}

/** Compose the base URL the reader is provisioned with. */
export function buildBaseUrl(origin, boxId) {
    const trimmed = String(origin ?? '').replace(/\/+$/, '');
    return `${trimmed}/m/${boxId}`;
}

/**
 * Does this base URL survive the reader's 127-char settings field?
 * Returns { ok, length, limit, remaining }.
 */
export function checkReaderUrlBudget(url) {
    const length = String(url ?? '').length;
    return {
        ok: length > 0 && length <= READER_URL_MAX_LEN,
        length,
        limit: READER_URL_MAX_LEN,
        remaining: READER_URL_MAX_LEN - length,
    };
}

/** Case-insensitive header read across plain objects, Maps and Headers. */
export function headerGet(headers, name) {
    if (!headers) return null;
    const lower = String(name).toLowerCase();
    if (typeof headers.get === 'function') {
        const value = headers.get(lower);
        return value === null || value === undefined ? null : String(value);
    }
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== lower) continue;
        const value = headers[key];
        if (value === null || value === undefined) return null;
        return Array.isArray(value) ? String(value[0]) : String(value);
    }
    return null;
}

/**
 * Length-independent-ish string compare.
 *
 * Always walks max(len) positions with no early return, so a correct prefix is
 * not distinguishable by timing from a wrong first byte. The overall LENGTH is
 * still observable (loop count) — acceptable, because the token length is fixed
 * by `generateWriteToken` and public in this file anyway.
 */
export function timingSafeEqualStr(a, b) {
    const left = TEXT_ENCODER.encode(String(a ?? ''));
    const right = TEXT_ENCODER.encode(String(b ?? ''));
    const n = Math.max(left.length, right.length);
    let diff = left.length ^ right.length;
    for (let i = 0; i < n; i++) {
        const l = i < left.length ? left[i] : 0;
        const r = i < right.length ? right[i] : 0;
        diff |= l ^ r;
    }
    return diff === 0;
}

/**
 * Split a request path into { boxId, leaf }, or null when it is not a mailbox
 * path.
 *
 * Empty segments are dropped, which is what gives BOTH trailing-slash tolerance
 * (`/m/ID/latest.txt/`) and duplicate-slash tolerance (`//m/ID//latest.txt`) —
 * the app may persist the base with a trailing slash, and the firmware only
 * strips trailing slashes from ITS copy.
 *
 * Traversal is rejected structurally, not by blocklist: exactly three segments
 * must remain, the first must be `m`, and the second must match BOX_ID_PATTERN
 * (no `.`, no `%`, no `/`). So `/m/../../etc/passwd`, `/m/ID/../current.frame`
 * and `/m/%2e%2e/latest.txt` are all plain 404s. Nothing here is ever passed to
 * a filesystem, but the store keys are built from boxId, so an unvalidated
 * boxId would let a caller forge another box's key.
 */
export function parsePath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 512) return null;
    const cut = path.search(/[?#]/);
    const clean = cut === -1 ? path : path.slice(0, cut);
    const segments = clean.split('/').filter((s) => s.length > 0);
    if (segments.length !== 3 && segments.length !== 4) return null;
    if (segments[0] !== 'm') return null;
    const boxId = segments[1];
    if (!BOX_ID_PATTERN.test(boxId)) return null;
    const parsed = { boxId, leaf: segments[2] };
    // A FOURTH segment exists for exactly one route, `/books/{bookId}`, and is
    // reported as `sub`. It is OMITTED rather than set to null when absent, so
    // every three-segment path still parses to exactly `{boxId, leaf}` — the
    // shape the notes tests pin — and handleRequest 404s the moment a `sub`
    // turns up on any other leaf (`/latest.txt/extra`). Five segments still fail
    // structurally, which is what keeps `/m/{box}/books/{id}/../..` a plain 404.
    if (segments.length === 4) parsed.sub = segments[3];
    return parsed;
}

/**
 * Mirror of the firmware's `trimId()` (MessageSync.cpp): strip leading/trailing
 * space, tab, CR and LF. Publishing an id that does not survive this would
 * break wake dedup, so we normalise on the write path and then REJECT anything
 * still outside NOTE_ID_PATTERN rather than silently rewriting it.
 */
export function trimNoteId(raw) {
    return String(raw ?? '').replace(/^[ \t\r\n]+/, '').replace(/[ \t\r\n]+$/, '');
}

// ---------------------------------------------------------------------------
// Books: ids, filenames, byte ranges, manifest
// ---------------------------------------------------------------------------

/**
 * Validate a book id, from EITHER `X-Book-Id` or the `/books/{id}` path segment.
 *
 * One function for both on purpose: the path segment is what
 * {@link bookKey} interpolates into a store key, and the dev server turns store
 * keys into filesystem paths. `..` matches NOTE_ID_PATTERN, so the dot-only
 * reject is the structural traversal guard for that path, not decoration.
 *
 * @returns {{ok: true, id: string} | {ok: false, detail: string}}
 */
export function validateBookId(raw) {
    const id = trimNoteId(raw);
    if (id.length === 0) return { ok: false, detail: 'book id is empty after trimming' };
    if (id.length > BOOK_ID_MAX_LEN) {
        // Rejected, never truncated — same reasoning as note ids: a truncated id
        // still looks valid and collides with every id sharing its prefix.
        return { ok: false, detail: `book id longer than ${BOOK_ID_MAX_LEN} chars` };
    }
    if (!BOOK_ID_PATTERN.test(id)) return { ok: false, detail: 'book id must match [A-Za-z0-9._~-]' };
    if (/^\.+$/.test(id)) return { ok: false, detail: '"." and ".." are not book ids' };
    return { ok: true, id };
}

/** Characters FAT/exFAT reserves. Replaced, not rejected — see below. */
const FAT_RESERVED = /["*:<>?|]/g;

/**
 * Sanitize `X-Filename` into a name the reader can safely create under /books.
 *
 * REJECT vs REPLACE is a deliberate split:
 *   REJECTED  path separators, control characters, a leading `.`, a missing
 *             `.epub`, an over-long name. Every one of these means the caller
 *             asked for something structurally different from what we would
 *             store, and silently storing a different file is how a user ends up
 *             with a book they cannot find. A traversal attempt must fail loudly.
 *   REPLACED  the FAT-reserved punctuation and anything outside printable ASCII,
 *             which are cosmetic substitutions of a name that is still
 *             recognisably the one asked for.
 *
 * The non-ASCII replacement also keeps the manifest single-byte: a books.txt
 * line is `id SP bytes SP filename LF`, and the firmware will parse it by
 * scanning for those separators, so a multi-byte name would make character and
 * byte offsets disagree in a C string walk. CR and LF are rejected outright
 * (they would forge a manifest line), as is `\x7f`.
 *
 * @returns {{ok: true, filename: string} | {ok: false, detail: string}}
 */
export function sanitizeBookFilename(raw) {
    const trimmed = trimNoteId(raw); // same trim the firmware applies to ids
    if (trimmed.length === 0) return { ok: false, detail: 'X-Filename is empty after trimming' };
    if (trimmed.length > BOOK_FILENAME_MAX_LEN) {
        return { ok: false, detail: `X-Filename longer than ${BOOK_FILENAME_MAX_LEN} chars` };
    }
    if (/[/\\]/.test(trimmed)) {
        return { ok: false, detail: 'X-Filename must be a bare filename, not a path' };
    }
    // An INTERNAL CR or LF is the one that matters: trimNoteId only strips them
    // from the ends, and a filename containing one would forge an extra
    // books.txt line. Tab and the other C0 controls go the same way — none of
    // them belongs in a name written to an SD card.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
        return { ok: false, detail: 'X-Filename must not contain control characters' };
    }
    if (trimmed.startsWith('.')) {
        // Covers "." and ".." (traversal) and hidden files in one rule. The
        // reader's own dot-directories (/.love-notes, /.sleep) are ITS namespace.
        return { ok: false, detail: 'X-Filename must not start with "."' };
    }

    const cleaned = trimmed
        .replace(/ {2,}/g, ' ') // collapse internal runs so a line stays scannable
        .replace(FAT_RESERVED, '_')
        .replace(/[^\x20-\x7e]/g, '_');

    if (!/\.epub$/i.test(cleaned)) return { ok: false, detail: 'X-Filename must end in .epub' };
    // Normalise the extension's case so `Book.EPUB` and `book.epub` cannot become
    // two files on a case-insensitive SD card.
    const filename = `${cleaned.slice(0, -5)}.epub`;
    if (!/[^. ]/.test(filename.slice(0, -5))) {
        return { ok: false, detail: 'X-Filename has no usable name before .epub' };
    }
    return { ok: true, filename };
}

/**
 * Parse ONE `Range` header against a known body size. THE RESUME MECHANISM.
 *
 * Returns `null` for "serve the whole thing" (no header, or a header this server
 * does not honour), `{start, end}` inclusive for a 206, or `{unsatisfiable:true}`
 * for a 416.
 *
 * IGNORE vs 416, which is not interchangeable:
 *   - an unknown unit (`items=0-1`), plain garbage, or a MULTI-range
 *     (`bytes=0-1,5-6`) is IGNORED -> 200 full body. RFC 9110 explicitly allows
 *     a server to ignore a Range it does not support, and answering 416 there
 *     would break a client that sent a range speculatively. Multi-range is
 *     ignored rather than implemented because `multipart/byteranges` is a whole
 *     second body format for an ESP32 to parse, for no benefit: a resume needs
 *     exactly one open-ended range.
 *   - a WELL-FORMED range that cannot be met (`start >= size`, `last < first`,
 *     any range against a zero-length body) is 416, because that client's next
 *     request would otherwise loop forever on the same bad offset.
 * A last-byte-pos past the end is CLAMPED, not refused — that is what lets a
 * reader ask for a fixed-size window (`bytes=N-N+65535`) without first knowing
 * where the file ends.
 *
 * `If-Range` is not honoured: nothing here publishes an ETag or Last-Modified,
 * so there is no validator to compare. See the header note on immutable ids for
 * what the reader must check instead.
 */
export function parseByteRange(value, size) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    // A legitimate single range is ~30 chars. The cap stops a pathological
    // header from reaching the regex at all.
    if (raw.length === 0 || raw.length > 128) return null;
    const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i.exec(raw);
    if (!match) return null;
    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return null; // "bytes=-" is not a range
    if (!Number.isSafeInteger(size) || size < 0) return null;

    if (rawStart === '') {
        // Suffix range: the LAST n bytes. Cheap to support and it is how a client
        // re-checks a tail without tracking the total.
        const n = Number(rawEnd);
        if (!Number.isSafeInteger(n) || n === 0 || size === 0) return { unsatisfiable: true };
        return { start: n >= size ? 0 : size - n, end: size - 1 };
    }

    const start = Number(rawStart);
    if (!Number.isSafeInteger(start)) return { unsatisfiable: true };
    if (size === 0 || start >= size) return { unsatisfiable: true };
    if (rawEnd === '') return { start, end: size - 1 };

    const wantEnd = Number(rawEnd);
    // Not a safe integer means "absurdly large", which is a clamp, not a refusal.
    if (!Number.isSafeInteger(wantEnd)) return { start, end: size - 1 };
    if (wantEnd < start) return { unsatisfiable: true };
    return { start, end: Math.min(wantEnd, size - 1) };
}

/**
 * Render the books manifest. BYTE-EXACT CONTRACT, pinned by a test:
 *
 *   "{id} {bytes} {filename}\n" per book, newest first, no header, no trailing
 *   blank line beyond each entry's own LF, and "" for an empty box.
 *
 * Ids and byte counts contain no spaces by construction, and the filename is the
 * remainder of the line — so a reader parses a line as "up to the first space,
 * up to the second space, up to the LF" and a filename containing a space still
 * round-trips.
 */
export function renderBooksManifest(books) {
    let out = '';
    for (const book of books) out += `${book.id} ${book.bytes} ${book.filename}\n`;
    return out;
}

function asBytes(body) {
    if (!body) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    throw new TypeError('handleRequest: body must be a Uint8Array, ArrayBuffer or null');
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * `no-store` on EVERY response is load-bearing, not hygiene. Cloudflare's edge
 * (and any intermediary the reader's ISP inserts on plain http) would otherwise
 * be free to serve a cached `latest.txt`, which is exactly the byte that decides
 * whether a note is fetched at all — a cached one pins the reader on the old id.
 */
function baseHeaders(extra) {
    return {
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...extra,
    };
}

function json(status, obj, extraHeaders) {
    return {
        status,
        headers: baseHeaders({ 'content-type': 'application/json; charset=utf-8', ...extraHeaders }),
        body: JSON.stringify(obj),
    };
}

function notFound() {
    return json(404, { ok: false, error: 'not_found' });
}

function methodNotAllowed(allow) {
    return json(405, { ok: false, error: 'method_not_allowed' }, { allow });
}

function badRequest(detail) {
    return json(400, { ok: false, error: 'bad_request', detail });
}

function unauthorized() {
    return json(401, { ok: false, error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
}

// ---------------------------------------------------------------------------
// Metadata record
// ---------------------------------------------------------------------------

/** Bumped from 1 when `frame` stopped being a single mutable key. */
const META_VERSION = 2;

function encodeMeta(meta) {
    return TEXT_ENCODER.encode(JSON.stringify({ v: META_VERSION, ...meta }));
}

/** A note id read back out of storage, or '' when it is not one. */
function asStoredNoteId(value) {
    if (typeof value !== 'string') return '';
    const trimmed = trimNoteId(value);
    return NOTE_ID_PATTERN.test(trimmed) ? trimmed : '';
}

/**
 * Decode the id pointer. A record that is missing, truncated, non-JSON or the
 * wrong shape resolves to "no note" rather than throwing: the mailbox going
 * quiet is a normal wake for the reader, whereas a 500 is a logged error every
 * single wake until someone notices.
 *
 * `previousId` names the one older frame publish deliberately retains (see the
 * header's GC rule). It is '' for the first note of a box.
 */
async function readMeta(store, boxId) {
    try {
        return decodeMeta(await store.get(metaKey(boxId)));
    } catch {
        return null;
    }
}

/** The pure half of {@link readMeta}; throws nothing, returns null on junk. */
function decodeMeta(raw) {
    if (!raw || raw.byteLength === 0) return null;
    let parsed;
    try {
        parsed = JSON.parse(TEXT_DECODER.decode(raw));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const latestId = asStoredNoteId(parsed.latestId);
    if (!latestId) return null;
    return {
        latestId,
        previousId: asStoredNoteId(parsed.previousId),
        bytes: Number.isInteger(parsed.bytes) ? parsed.bytes : FRAME_BYTES,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
}

function requireWriteAuth(req, config) {
    const expected = typeof config?.writeToken === 'string' ? config.writeToken : '';
    if (expected.length < MIN_WRITE_TOKEN_LEN) {
        // Fail CLOSED and say so. A blank WRITE_TOKEN secret must never mean
        // "anyone may publish"; that would turn the box id into a write
        // capability too, and it travels in the reader's settings in clear.
        return json(503, { ok: false, error: 'not_configured', detail: 'mailbox write token is unset or too short' });
    }
    const header = headerGet(req?.headers, 'authorization');
    if (typeof header !== 'string') return unauthorized();
    const spaceAt = header.indexOf(' ');
    if (spaceAt < 0) return unauthorized();
    if (header.slice(0, spaceAt).toLowerCase() !== 'bearer') return unauthorized();
    const presented = header.slice(spaceAt + 1).trim();
    if (presented.length === 0) return unauthorized();
    if (!timingSafeEqualStr(presented, expected)) return unauthorized();
    return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleLatest(method, boxId, store) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const meta = await readMeta(store, boxId);
    const id = meta ? meta.latestId : '';
    return {
        status: 200,
        headers: baseHeaders({ 'content-type': 'text/plain; charset=utf-8' }),
        // No trailing newline: the firmware trims, but an id echoed back
        // verbatim is what makes a byte-for-byte comparison in the app possible.
        body: method === 'HEAD' ? null : id,
    };
}

async function handleFrame(method, boxId, store) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');

    // Resolve the id FIRST and derive the key from it, so the bytes served can
    // only ever be the bytes belonging to the id this same request read. See
    // the header: this is the whole reason the frame key is content-addressed.
    //
    // Unlike latest.txt, a storage failure here is reported as 500 rather than
    // degraded to "no note": the reader only asks for a frame after latest.txt
    // named one, so silence at this point is a real fault worth surfacing.
    let meta;
    try {
        meta = decodeMeta(await store.get(metaKey(boxId)));
    } catch {
        return json(500, { ok: false, error: 'storage_error' });
    }
    if (!meta) return notFound();

    let frame;
    try {
        frame = await store.get(frameKey(boxId, meta.latestId));
    } catch {
        return json(500, { ok: false, error: 'storage_error' });
    }
    // 404 means one of exactly two things, and both are states the firmware
    // already handles by logging and retrying at the next sleep: this box has
    // never had a note, or a replica has the new pointer but not yet the new
    // frame. A 404 is always self-healing; serving the WRONG frame would not be.
    if (!frame) return notFound();
    if (frame.byteLength !== FRAME_BYTES) {
        // Only reachable if the store corrupted a value — publish rejects every
        // other size. Do not serve it: the firmware would download 51 KB over
        // a battery-budgeted wake window and then discard it.
        return json(500, { ok: false, error: 'corrupt_frame', bytes: frame.byteLength });
    }
    return {
        status: 200,
        headers: baseHeaders({
            'content-type': 'application/octet-stream',
            'content-length': String(FRAME_BYTES),
        }),
        body: method === 'HEAD' ? null : frame,
    };
}

async function handlePublish(method, req, boxId, store, config) {
    if (method !== 'POST') return methodNotAllowed('POST');
    const denied = requireWriteAuth(req, config);
    if (denied) return denied;

    const rawId = headerGet(req?.headers, 'x-note-id');
    if (rawId === null) return badRequest('missing X-Note-Id header');
    const id = trimNoteId(rawId);
    if (id.length === 0) return badRequest('X-Note-Id is empty after trimming');
    if (id.length > NOTE_ID_MAX_LEN) {
        // Explicit reject, never truncate: a truncated id still LOOKS valid to
        // the reader and would collide with every other id sharing that prefix,
        // permanently deduping later notes away.
        return badRequest(`X-Note-Id longer than ${NOTE_ID_MAX_LEN} chars`);
    }
    if (!NOTE_ID_PATTERN.test(id)) {
        return badRequest('X-Note-Id must match [A-Za-z0-9._~-]');
    }

    const body = asBytes(req?.body);
    if (body.byteLength > FRAME_BYTES) {
        return json(413, {
            ok: false,
            error: 'frame_too_large',
            detail: `expected exactly ${FRAME_BYTES} bytes, got ${body.byteLength}`,
        });
    }
    if (body.byteLength !== FRAME_BYTES) {
        return badRequest(`expected exactly ${FRAME_BYTES} bytes, got ${body.byteLength}`);
    }

    const nowMs = typeof config?.now === 'function' ? config.now() : Date.now();
    const updatedAt = new Date(nowMs).toISOString();

    // Read the pointer BEFORE moving it: its `latestId` becomes the frame we
    // retain, and its `previousId` names the one we are now free to collect.
    const before = await readMeta(store, boxId);
    const priorId = before ? before.latestId : '';
    // Republishing under the SAME id is a plain overwrite of one key — there is
    // no older note to retain in that case beyond what was already retained.
    const retainId = priorId && priorId !== id ? priorId : before ? before.previousId : '';

    // ORDER IS THE CONTRACT — frame first, pointer second. See the header note.
    // Each write is caught separately so a half-completed publish reports
    // `published: false` from the ADAPTER-INDEPENDENT layer: without this the
    // Worker would surface a bare platform 500 and the dev server a caught 500,
    // and the app could not tell "retry, nothing was published" from "the note
    // is live but the response was lost".
    try {
        await store.put(frameKey(boxId, id), body);
    } catch {
        return json(503, { ok: false, error: 'storage_error', published: false, detail: 'frame write failed' });
    }
    try {
        await store.put(
            metaKey(boxId),
            encodeMeta({ latestId: id, previousId: retainId, bytes: FRAME_BYTES, updatedAt })
        );
    } catch {
        // The frame landed but the pointer did not, so the reader still sees the
        // PREVIOUS id and will not fetch. Nothing is corrupted; retry publishes.
        //
        // frame:{id} is now unreferenced and is NOT collected — deliberately. A
        // `put` that throws may still have landed, and deleting the frame of a
        // pointer that actually moved would turn a live note into a permanent
        // 404. The retry mints a new id, so the cost is one leaked 52 KB value
        // per KV write failure; `wrangler kv key list --prefix box:{id}:` finds
        // any that ever accumulate.
        return json(503, { ok: false, error: 'storage_error', published: false, detail: 'id pointer write failed' });
    }

    // GC LAST, and never fatally. The note is live the moment the pointer moves;
    // a store that cannot delete (or has no `delete` at all) must not turn a
    // delivered note into a reported failure — it only costs 52 KB of garbage.
    await collectOldFrames(store, boxId, [id, retainId], before);

    return json(200, { ok: true, id, bytes: FRAME_BYTES, updatedAt });
}

/**
 * Delete every frame the previous pointer referenced that the new one does not.
 *
 * At most two candidates, so this is bounded work on the publish path — no
 * listing, no scan. `delete` is OPTIONAL on the store contract: a store without
 * it simply accumulates frames, which is a cost, never a correctness problem.
 */
async function collectOldFrames(store, boxId, retained, before) {
    if (!before || typeof store?.delete !== 'function') return;
    const keep = new Set(retained.filter(Boolean));
    for (const candidate of [before.latestId, before.previousId]) {
        if (!candidate || keep.has(candidate)) continue;
        keep.add(candidate); // never issue the same delete twice
        try {
            await store.delete(frameKey(boxId, candidate));
        } catch {
            // Garbage, not corruption. Nothing reads a frame key that no meta
            // record names.
        }
    }
}

async function handleStatus(method, req, boxId, store, config) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const denied = requireWriteAuth(req, config);
    if (denied) return denied;
    const meta = await readMeta(store, boxId);
    const books = await readBooksIndex(store, boxId);
    return json(200, {
        latestId: meta ? meta.latestId : null,
        bytes: meta ? meta.bytes : 0,
        updatedAt: meta ? meta.updatedAt : null,
        // Summary only — never the blobs. This is what lets the app show "what
        // does the box currently hold" without parsing books.txt, and it is the
        // ONLY place the app can see the library, because there is no ack state.
        books: books.map((book) => ({ id: book.id, filename: book.filename, bytes: book.bytes })),
    });
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

/** Bumped if the manifest record ever changes shape. */
const BOOKS_INDEX_VERSION = 1;

function encodeBooksIndex(books) {
    return TEXT_ENCODER.encode(JSON.stringify({ v: BOOKS_INDEX_VERSION, books }));
}

/**
 * Decode the manifest, NEWEST FIRST, dropping anything that would not have been
 * accepted by a publish today.
 *
 * The round-trip check on the filename is the load-bearing part: a stored name
 * containing an LF would forge a books.txt line, and a name over the length cap
 * would push a line past what the reader is willing to buffer. Re-running the
 * same sanitizer and requiring an IDENTICAL result means the manifest can only
 * ever emit names this contract would mint — whatever a store hands back.
 *
 * Junk (missing, truncated, non-JSON, wrong shape) decodes to `[]`: an empty
 * library is a normal wake for the reader, a 500 is a logged error on every one.
 */
function decodeBooksIndex(raw) {
    if (!raw || raw.byteLength === 0) return [];
    let parsed;
    try {
        parsed = JSON.parse(TEXT_DECODER.decode(raw));
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.books)) return [];
    const out = [];
    for (const entry of parsed.books) {
        if (!entry || typeof entry !== 'object') continue;
        const id = validateBookId(entry.id);
        if (!id.ok || id.id !== entry.id) continue;
        const named = sanitizeBookFilename(entry.filename);
        if (!named.ok || named.filename !== entry.filename) continue;
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_BOOK_BYTES) continue;
        if (out.some((seen) => seen.id === entry.id)) continue;
        out.push({
            id: entry.id,
            filename: entry.filename,
            bytes: entry.bytes,
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
        });
        // A corrupt index must not be able to produce a 5000-line manifest that
        // the reader downloads on every wake.
        if (out.length >= MAX_BOOKS) break;
    }
    return out;
}

/** Manifest read that never throws — same contract as {@link readMeta}. */
async function readBooksIndex(store, boxId) {
    try {
        return decodeBooksIndex(await store.get(booksIndexKey(boxId)));
    } catch {
        return [];
    }
}

/**
 * Drop every blob the previous manifest referenced that the new one does not.
 *
 * Bounded by MAX_BOOKS, so this is bounded work on the write path — no listing,
 * no scan. Never fatal: a store that cannot delete (or has no `delete`) leaks a
 * blob nothing can reach, which is a cost, not a correctness problem.
 */
async function collectOrphanedBooks(store, boxId, next, before) {
    if (typeof store?.delete !== 'function') return;
    const kept = new Set(next.map((book) => book.id));
    const done = new Set();
    for (const book of before) {
        if (kept.has(book.id) || done.has(book.id)) continue;
        done.add(book.id);
        try {
            await store.delete(bookKey(boxId, book.id));
        } catch {
            // Garbage, not corruption: nothing reads a blob no manifest names.
        }
    }
}

async function handleBooksManifest(method, boxId, store) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const books = await readBooksIndex(store, boxId);
    const body = renderBooksManifest(books);
    return {
        status: 200,
        headers: baseHeaders({
            'content-type': 'text/plain; charset=utf-8',
            // Computed from BYTES, not characters. The sanitizer guarantees the
            // manifest is pure ASCII so the two agree today — measuring anyway
            // means a future widening of the charset cannot silently start
            // lying to a firmware that reads exactly Content-Length bytes.
            'content-length': String(TEXT_ENCODER.encode(body).byteLength),
        }),
        body: method === 'HEAD' ? null : body,
    };
}

async function handleBooksPublish(method, req, boxId, store, config) {
    if (method !== 'POST') return methodNotAllowed('POST');
    const denied = requireWriteAuth(req, config);
    if (denied) return denied;

    const rawId = headerGet(req?.headers, 'x-book-id');
    if (rawId === null) return badRequest('missing X-Book-Id header');
    const id = validateBookId(rawId);
    if (!id.ok) return badRequest(id.detail);

    const rawName = headerGet(req?.headers, 'x-filename');
    if (rawName === null) return badRequest('missing X-Filename header');
    const named = sanitizeBookFilename(rawName);
    if (!named.ok) return badRequest(named.detail);

    const body = asBytes(req?.body);
    if (body.byteLength > MAX_BOOK_BYTES) {
        return json(413, {
            ok: false,
            error: 'book_too_large',
            detail: `epub is ${body.byteLength} bytes, cap is ${MAX_BOOK_BYTES}`,
        });
    }
    if (body.byteLength === 0) {
        // A zero-length book would also make every Range request against it
        // unsatisfiable, i.e. a 416 loop for a reader that cannot skip it.
        return badRequest('empty body: an epub is never zero bytes');
    }

    const nowMs = typeof config?.now === 'function' ? config.now() : Date.now();
    const updatedAt = new Date(nowMs).toISOString();
    const before = await readBooksIndex(store, boxId);
    const entry = { id: id.id, filename: named.filename, bytes: body.byteLength, updatedAt };

    // BLOB FIRST, INDEX SECOND — the manifest must never advertise a book whose
    // bytes are absent. The reader budgets a whole wake window per download, so a
    // 404 mid-window is not free; and on Workers KV the two keys replicate
    // independently, so a replica holding the new index next to a missing blob is
    // a real state (it resolves to a 404 on that one book and self-heals).
    try {
        await store.put(bookKey(boxId, entry.id), body);
    } catch {
        return json(503, { ok: false, error: 'storage_error', published: false, detail: 'book write failed' });
    }

    // Newest first, and a book REPLACES any entry with the same id or the same
    // filename. Same-filename replacement matters because the reader diffs the
    // manifest against files on its SD card: two entries naming one file would
    // make that diff unresolvable, and re-sending a book under a fresh id would
    // otherwise leave the old copy advertised forever.
    const lower = entry.filename.toLowerCase();
    const kept = before.filter((book) => book.id !== entry.id && book.filename.toLowerCase() !== lower);
    // The cap is applied AFTER the new entry goes on the front, so the 21st book
    // evicts the oldest rather than being refused.
    const next = [entry, ...kept].slice(0, MAX_BOOKS);

    try {
        await store.put(booksIndexKey(boxId), encodeBooksIndex(next));
    } catch {
        // The blob landed but the manifest did not, so no reader can see it.
        // The blob is NOT collected here, for the same reason publish leaves an
        // orphaned frame: a `put` that threw may still have landed, and deleting
        // the bytes of an index that actually moved would turn a live book into a
        // permanent 404. A retry overwrites it; `wrangler kv key list --prefix
        // box:{id}:book:` finds anything that accumulates.
        return json(503, { ok: false, error: 'storage_error', published: false, detail: 'book index write failed' });
    }

    // GC LAST, and never fatally — the book is live the moment the index lands.
    await collectOrphanedBooks(store, boxId, next, before);

    return json(200, { ok: true, id: entry.id, filename: entry.filename, bytes: entry.bytes });
}

async function handleBookDelete(req, boxId, bookId, store, config) {
    const denied = requireWriteAuth(req, config);
    if (denied) return denied;
    const before = await readBooksIndex(store, boxId);
    const entry = before.find((book) => book.id === bookId);
    if (!entry) return notFound();
    const next = before.filter((book) => book.id !== bookId);

    // INDEX FIRST, BLOB SECOND — the mirror image of publish, for the mirror
    // reason: the manifest must stop advertising the book before its bytes go.
    try {
        await store.put(booksIndexKey(boxId), encodeBooksIndex(next));
    } catch {
        return json(503, { ok: false, error: 'storage_error', deleted: false, detail: 'book index write failed' });
    }
    await collectOrphanedBooks(store, boxId, next, before);
    return json(200, { ok: true, id: entry.id, filename: entry.filename });
}

/**
 * Serve one book, whole or in one range. THE RESUME PATH.
 *
 * The size comes from the MANIFEST entry and is then checked against the blob,
 * so a partially replicated or truncated value is refused (500) rather than
 * served — a reader that stitched a short slice into its file would end up with a
 * corrupt epub and no way to know.
 *
 * `store.stat` + `store.getRange` are OPTIONAL. With them a ranged read touches
 * only the requested window, which is the difference between a 64 KB and a
 * 24 MB allocation per request on the dev server (it runs under a 256 MB cgroup).
 * Without them — Workers KV has no ranged read — the value is fetched once and
 * sliced, which is what the memory store does and what the tests exercise by
 * default. Both paths must produce the same bytes; a test pins that.
 */
async function handleBookDownload(method, req, boxId, bookId, store) {
    const books = await readBooksIndex(store, boxId);
    const entry = books.find((book) => book.id === bookId);
    if (!entry) return notFound();

    const key = bookKey(boxId, bookId);
    const ranged = typeof store?.stat === 'function' && typeof store?.getRange === 'function';
    let size = null;
    let blob = null;
    try {
        if (ranged) {
            const stat = await store.stat(key);
            size = stat && Number.isSafeInteger(stat.bytes) ? stat.bytes : null;
        } else {
            blob = await store.get(key);
            size = blob ? blob.byteLength : null;
        }
    } catch {
        return json(500, { ok: false, error: 'storage_error' });
    }
    // The manifest names it but the bytes are not here: an unreplicated blob, or
    // one a crash removed. 404 is self-healing — the reader retries next window.
    if (size === null) return notFound();
    if (size !== entry.bytes) {
        return json(500, { ok: false, error: 'corrupt_book', bytes: size, expected: entry.bytes });
    }

    const range = parseByteRange(headerGet(req?.headers, 'range'), size);
    if (range && range.unsatisfiable) {
        return {
            status: 416,
            headers: baseHeaders({
                'content-type': 'application/json; charset=utf-8',
                'accept-ranges': 'bytes',
                'content-range': `bytes */${size}`,
            }),
            body: JSON.stringify({ ok: false, error: 'range_not_satisfiable', bytes: size }),
        };
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = end - start + 1;
    const headers = baseHeaders({
        'content-type': BOOK_CONTENT_TYPE,
        'content-length': String(length),
        // Advertised on the FULL response too: it is how a client discovers that
        // resuming is possible at all before it has anything to resume.
        'accept-ranges': 'bytes',
        // Safe to quote unconditionally: the sanitizer leaves no quote,
        // backslash, CR or LF in the name, so this cannot break framing.
        'content-disposition': `attachment; filename="${entry.filename}"`,
    });
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    const status = range ? 206 : 200;

    if (method === 'HEAD') return { status, headers, body: null };

    let bytes;
    if (blob) {
        bytes = start === 0 && length === size ? blob : blob.subarray(start, end + 1);
    } else {
        try {
            bytes = await store.getRange(key, start, length);
        } catch {
            return json(500, { ok: false, error: 'storage_error' });
        }
        if (bytes === null || bytes === undefined) return notFound();
        if (bytes.byteLength !== length) {
            // A short read means the blob changed under us between stat and read.
            // Serving it would hand the reader a slice it cannot place.
            return json(500, { ok: false, error: 'corrupt_book', bytes: bytes.byteLength, expected: length });
        }
    }
    return { status, headers, body: bytes };
}

/** `/books/{id}`: reads are open (the boxId is the capability), DELETE is not. */
async function handleBookItem(method, req, boxId, rawBookId, store, config) {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
        return methodNotAllowed('GET, HEAD, DELETE');
    }
    // Validate BEFORE the id reaches bookKey(): this segment is attacker-supplied
    // and the dev server turns store keys into filesystem paths. A malformed id
    // is 404 rather than 400 — it is a URL that names nothing, and answering 400
    // would tell a prober the difference between "bad shape" and "no such book".
    const bookId = validateBookId(rawBookId);
    if (!bookId.ok) return notFound();
    if (method === 'DELETE') return handleBookDelete(req, boxId, bookId.id, store, config);
    return handleBookDownload(method, req, boxId, bookId.id, store);
}

/**
 * The whole mailbox, as one function.
 *
 * @param {{method: string, path: string, headers: object, body: Uint8Array|null}} req
 * @param {{get(key: string): Promise<Uint8Array|null>, put(key: string, value: Uint8Array): Promise<void>}} store
 * @param {{writeToken: string, now?: () => number}} config
 * @returns {Promise<{status: number, headers: object, body: Uint8Array|string|null}>}
 */
export async function handleRequest(req, store, config = {}) {
    const method = String(req?.method ?? 'GET').toUpperCase();
    const parsed = parsePath(req?.path);
    if (!parsed) return notFound();
    const { boxId, leaf, sub } = parsed;

    // `/books` is the only leaf with a child segment: bare for the upload,
    // `/books/{id}` for download and delete.
    if (leaf === 'books') {
        return sub === undefined
            ? handleBooksPublish(method, req, boxId, store, config)
            : handleBookItem(method, req, boxId, sub, store, config);
    }
    // Every other route is exactly three segments, so a fourth is off-contract
    // (`/latest.txt/extra`) and must not resolve to the three-segment route.
    if (sub !== undefined) return notFound();

    switch (leaf) {
        case 'latest.txt':
            return handleLatest(method, boxId, store);
        case 'current.frame':
            return handleFrame(method, boxId, store);
        case 'publish':
            return handlePublish(method, req, boxId, store, config);
        case 'status':
            return handleStatus(method, req, boxId, store, config);
        case 'books.txt':
            return handleBooksManifest(method, boxId, store);
        default:
            return notFound();
    }
}

/**
 * How many body bytes an ADAPTER may buffer for this request, and what to call
 * it when it refuses.
 *
 * Routing decisions live here, not in the adapters — and this one has teeth: the
 * notes cap stays at 64 KB so a bogus 24 MB `/publish` is refused off the socket
 * instead of being buffered and then failing the exact-size check, while
 * `POST /books` gets the whole book cap. Raising MAX_REQUEST_BODY_BYTES globally
 * to cover books would quietly remove that protection from every route.
 *
 * @returns {{bytes: number, error: string}}
 */
export function requestBodyLimit(method, path) {
    const parsed = parsePath(path);
    const isBookUpload =
        parsed !== null &&
        parsed.leaf === 'books' &&
        parsed.sub === undefined &&
        String(method ?? '').toUpperCase() === 'POST';
    return isBookUpload
        ? { bytes: MAX_BOOK_BYTES, error: 'book_too_large' }
        : { bytes: MAX_REQUEST_BODY_BYTES, error: 'frame_too_large' };
}

/**
 * Check the write credential BEFORE the adapter buffers a body. Returns null
 * when the caller may proceed, otherwise the SAME response the route would have
 * produced (401, or 503 when the deploy has no usable token).
 *
 * WHY THIS EXISTS — memory, not access control. `handleRequest` already refuses
 * an unauthenticated `POST /books`, but by then the adapter has buffered the
 * whole body, because {@link requestBodyLimit} keys the cap off method+path and
 * cannot see credentials. The boxId in the path is a READ capability that
 * travels in cleartext over plain http by design, so it is not a secret: with
 * only the URL, an unauthenticated caller could push MAX_BOOK_BYTES into the
 * process and be answered 401 — and the dev server's systemd unit sets
 * MemoryMax=256M, i.e. a handful of concurrent 401s would OOM-kill the service
 * that also serves the hardware-proven notes path. Before books existed the
 * global cap was 64 KB and there was nothing to amplify.
 *
 * Adapters call this immediately after `requestBodyLimit`, and ONLY when the
 * route's limit exceeds MAX_REQUEST_BODY_BYTES — the notes cap is small enough
 * that buffering first costs nothing, and pre-authenticating every route would
 * change the status code an unauthenticated oversize `/publish` gets today.
 *
 * The decision is EXACTLY the route's: this delegates to the same
 * `requireWriteAuth`, which reads nothing but headers and config, so a request
 * that passes here can never be refused later for a different auth reason (and
 * one refused here would have been refused there).
 *
 * @param {object} headers request headers (object, Map or Headers)
 * @param {{writeToken: string}} config
 * @returns {{status: number, headers: object, body: string}|null}
 */
export function writeAuthPreflight(headers, config) {
    return requireWriteAuth({ headers }, config);
}

/**
 * In-memory store, used by the dev server and the tests. Kept here (not in the
 * dev server) so both adapters exercise the same shape the Workers KV adapter
 * has to satisfy: values are COPIED in and out, because KV never hands back the
 * caller's buffer and a store that aliased it would hide aliasing bugs.
 */
export function createMemoryStore() {
    const map = new Map();
    return {
        map,
        async get(key) {
            const value = map.get(key);
            return value ? new Uint8Array(value) : null;
        },
        async put(key, value) {
            map.set(key, new Uint8Array(value));
        },
        // Deleting an absent key is a no-op, matching KV and `fs.rm`'s
        // force mode: publish's GC must not care whether the frame it is
        // collecting survived a crash.
        async delete(key) {
            map.delete(key);
        },
    };
}
