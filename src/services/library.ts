/**
 * library — ONE books list, whether the reader is awake or not.
 *
 * The Library tab has to answer a single question — "what books does this
 * household have, and where are they?" — from two sources that fail
 * independently:
 *
 *   - the READER (`/api/files` over the LAN), which is the authority on what is
 *     actually on the SD card and is INVISIBLE whenever the X3 is asleep (deep
 *     sleep turns WiFi off, see HANDOFF.md);
 *   - the MAILBOX (`/status` over the internet), which is the authority on what
 *     is QUEUED for the reader to pull at its next sync window.
 *
 * Neither one is "the library" on its own, and neither one being down should
 * blank the screen. So this module merges them by filename and reports, per
 * source, whether what it returned is live or remembered:
 *
 *   - reader unreachable  -> rows from a small AsyncStorage snapshot of the last
 *     successful listing, `readerFresh: false`, `readerListedAt` = when that
 *     listing happened. The screen says "reader asleep — list from last
 *     connection" instead of an error, because the books ARE still on the card.
 *   - mailbox unset       -> `mailboxConfigured: false`, `mailboxOk: false`. Not
 *     a failure worth a warning; there is simply no queue.
 *   - mailbox configured but failing -> `mailboxConfigured: true`,
 *     `mailboxOk: false` + `mailboxError`. That one IS worth showing: books the
 *     user queued are unaccounted for.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 *   - It does NOT track delivery. The reader ACKs nothing (mailbox/README.md),
 *     so "in mailbox" never means "not yet read" — a book can be listed on both
 *     sides at once and that is the normal state right after a sync. `both` is a
 *     fact about two listings, never an inference about the reader's intent.
 *   - It does NOT depend on firmware BookSync existing. A mailbox row means
 *     "the mailbox is holding this"; whether the reader pulls it is the reader's
 *     business, so the wording the UI pairs with `mailbox` ("lands next sync")
 *     stays true-by-construction either way.
 *   - It does NOT delete from the reader. That is the direct path
 *     (`crosspoint_upload.deleteCrossPointFile`) and the screen already owns it.
 *   - It does NOT scan folders, subfolders or non-book files. The raw file
 *     manager keeps doing that; this is the book list.
 *
 * LEGACY '/send-to-x4' IS NOT LISTED HERE, AND THAT IS A RECORDED NARROWING
 * (HANDOFF.md's known-gaps list) rather than a settled design. Books moved to
 * '/books' with no migration, so a reader that predates the retarget can hold
 * books this list does not show. They are not stranded: the retained "All files"
 * section deep-scans the old root, so they stay visible and deletable there.
 *
 * The reason it is not just switched on: the obvious route is
 * `listCrossPointFiles` on the legacy root, and that function ensures its folder
 * exists — it would mkdir '/send-to-x4' on every migrated reader that no longer
 * has one, on every library load. That much is avoidable (a plain
 * `GET /api/files?path=/send-to-x4` creates nothing, which is exactly what
 * `DeviceScreen.fetchDirectoryItems` does), so the real cost is the OTHER half:
 * a `LibraryBook` carries no folder, and the screen's reader-side delete resolves
 * a row against the flat '/books' listing on purpose — a name that exists under
 * both roots is otherwise ambiguous and the delete picks the wrong file. Listing
 * the legacy root therefore means a per-row folder hint through the merge, the
 * cache and the delete path, not a second fetch. Until that lands, one collapsed
 * section is where legacy books live.
 *
 * Both network sides are reached through seams so `scripts/library.test.js` can
 * cover the merge, the cache and the error split under node: the reader through
 * {@link __setLibraryReader} (crosspoint_upload pulls in expo-file-system, which
 * node cannot parse — hence the same lazy `require` trick as `epub_sender`), the
 * mailbox through `globalThis.fetch`, which `mailbox_client` resolves per call.
 */

import type { RemoteFile } from '../types';
import { DEFAULT_LIBRARY_FOLDER } from './epub_sender';
import { deleteMailboxBook, listMailboxBooks, type MailboxBook } from './mailbox_client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * AsyncStorage key for the last reader listing. NEW — nothing else reads it.
 *
 * Namespaced under '@library/' so a future second cache (mailbox side, say) is a
 * sibling key rather than a reshaped blob.
 */
export const READER_BOOKS_CACHE_KEY = '@library/reader-books';

/**
 * Rows kept in the cache. This is a DISPLAY fallback, not a mirror of the card.
 *
 * Three fields per row (filename, bytes, timestamp) means ~100 B of JSON each,
 * so the whole blob stays well inside a single AsyncStorage value even at the
 * cap. Anything past it is dropped from the TAIL, which is the oldest end: the
 * listing arrives newest-first.
 */
export const MAX_CACHED_READER_BOOKS = 300;

/** `mailboxError` when there is no mailbox to ask. Not a failure — see below. */
export const MAILBOX_NOT_CONFIGURED = 'No mailbox is configured.';

/** `mailboxError` when the mailbox answered, but not readably. */
const MAILBOX_LIST_FAILED = 'Could not read the mailbox book list.';

/** `readerError` when there is no reader address to try. */
const READER_NO_ADDRESS = 'No reader address is set.';

/** `readerError` when the module cannot reach a transport (node, web preview). */
const READER_NO_TRANSPORT = 'No reader connection is available in this runtime.';

/** `readerError` when the probe failed without saying why. */
const READER_UNREACHABLE = 'The reader did not answer.';

/**
 * Sort rank for a book the mailbox is NOT holding.
 *
 * A finite sentinel, not `Infinity`: the comparator subtracts ranks, and
 * `Infinity - Infinity` is `NaN`, which makes `Array.prototype.sort` order
 * undefined. Ranks are listing indices, so MAX_SAFE_INTEGER is unreachable.
 */
const MAILBOX_RANK_NONE = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Where a book is, right now, as the two listings saw it.
 *
 * `both` is NOT a state to clean up: the mailbox holds a book until someone
 * deletes it, so a synced book legitimately appears twice.
 */
export type BookLocation = 'reader' | 'mailbox' | 'both';

export interface LibraryBook {
    /** As displayed. The reader's spelling wins when both sides have the book. */
    filename: string;
    /** Best-known size. 0 when neither side reported one (a listing may omit it). */
    bytes: number;
    location: BookLocation;
    /** Set for `mailbox` and `both` — the ONLY handle a mailbox delete accepts. */
    mailboxId?: string;
    /**
     * When the reader listing this row came from was captured.
     *
     * Set for `reader` and `both` only. On a fresh listing this is "just now"; on
     * a cached one it is the last time the reader was reachable, which is what
     * makes "list from last connection" say something specific.
     */
    readerListedAt?: number;
}

export interface LibrarySnapshot {
    /** Merged, de-duplicated, newest-first. Empty when both sides came up empty. */
    books: LibraryBook[];
    /** True only when the reader answered THIS call. False means cached rows. */
    readerFresh: boolean;
    /** Capture time of the listing the reader rows came from; null when never. */
    readerListedAt: number | null;
    /** True when the mailbox answered with a readable list. */
    mailboxOk: boolean;
    /** Why `mailboxOk` is false, including {@link MAILBOX_NOT_CONFIGURED}. */
    mailboxError?: string;
    /**
     * Whether a mailbox was configured at all.
     *
     * ADDITIVE to the agreed contract, and the field that keeps "there is no
     * mailbox" from being rendered like "the mailbox is broken". `mailboxOk` is
     * false in both cases; only this one separates them.
     */
    mailboxConfigured: boolean;
    /** Why the reader rows are stale. Absent when `readerFresh` is true. */
    readerError?: string;
}

/**
 * The settings a library load depends on.
 *
 * A structural SUBSET of `epub_sender.EpubDestination` (minus `role`, which
 * decides a send route and has no bearing on reading a list), so a screen can
 * hand the same object to `sendEpubsRouted` and to {@link loadLibrary}.
 */
export interface LibraryDestination {
    /** Reader host for the direct listing (already normalised, e.g. getCurrentIp). */
    ip: string;
    /** Mailbox base URL. Empty/absent means "no mailbox configured". */
    mailboxUrl?: string;
    /** Mailbox bearer token. NEVER part of mailboxUrl — see mailbox_client. */
    mailboxWriteToken?: string;
}

export interface LoadLibraryOptions {
    /**
     * Ask the reader whether it is there before listing. DEFAULT TRUE.
     *
     * `listCrossPointFiles` returns `[]` for BOTH "no books" and "no reader", so
     * something has to break the tie. Probing first also fails FAST: on a
     * sleeping reader the listing path burns a 5 s folder check, up to a 10 s
     * mkdir and a 10 s list before returning that same `[]`, and the Library tab
     * would sit spinning for half a minute to learn what a 5 s probe says.
     *
     * Pass `false` when the caller already knows the reader is up (the
     * ConnectionProvider status, say) and wants to skip the extra request. An
     * EMPTY listing is still probed in that case — otherwise an unreachable
     * reader would be reported as an empty library AND would overwrite the cache
     * with nothing, silently destroying the offline list.
     */
    probeReader?: boolean;
}

/**
 * The slice of AsyncStorage this module needs.
 *
 * Declared structurally rather than imported, exactly as in `message_history`:
 * `@react-native-async-storage/async-storage` pulls in `react-native`, and a
 * top-level dependency on it would make the tests below impossible to write.
 */
export interface LibraryStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * The slice of `crosspoint_upload` this module needs.
 *
 * `listBooks` maps to `listCrossPointFiles`, NOT to a fresh `/api/files` walk:
 * that function is the one that already knows the firmware's listing shape (URL
 * encoding, `isDirectory`, the book extensions, newest-first). Re-implementing
 * it here would fork the one place that parses this listing.
 */
export interface LibraryReader {
    checkConnection(ip: string): Promise<{ success: boolean; error?: string }>;
    listBooks(ip: string, targetFolder: string): Promise<RemoteFile[]>;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

// Metro defines `require` in every module and collects `require('<literal>')`
// statically, so the lazy loads below are normal bundle dependencies. Under
// node's ESM loader the identifier does not exist — `typeof` on an undeclared
// name is safe, and the module degrades to "no store / no reader" instead of
// failing to import.
declare const require: ((id: string) => unknown) | undefined;

let store: LibraryStore | null = null;
let storeResolved = false;

/**
 * Replace the backing store. Pass `null` to restore the AsyncStorage default.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setLibraryStore(next: LibraryStore | null): void {
    store = next;
    storeResolved = next !== null;
}

function getStore(): LibraryStore | null {
    if (!storeResolved) {
        store = loadAsyncStorage();
        storeResolved = true;
    }
    return store;
}

function loadAsyncStorage(): LibraryStore | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('@react-native-async-storage/async-storage') as { default?: unknown };
        // Both interop shapes: `exports.default` under Babel's ESM interop, and
        // the module object itself if that ever stops being how it ships.
        for (const candidate of [mod?.default, mod]) {
            if (isStore(candidate)) return candidate;
        }
    } catch {
        // Not a React Native runtime (node test, web preview). Handled by callers.
    }
    return null;
}

function isStore(value: unknown): value is LibraryStore {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<LibraryStore>;
    return (
        typeof candidate.getItem === 'function' &&
        typeof candidate.setItem === 'function' &&
        typeof candidate.removeItem === 'function'
    );
}

let reader: LibraryReader | null = null;
let readerResolved = false;

/**
 * Replace the reader transport. Pass `null` to restore the CrossPoint default.
 *
 * TEST SEAM — the app never calls this. Needed because the default resolves
 * `crosspoint_upload`, whose top-level `expo-file-system/legacy` import node
 * cannot load.
 */
export function __setLibraryReader(next: LibraryReader | null): void {
    reader = next;
    readerResolved = next !== null;
}

function getReader(): LibraryReader | null {
    if (!readerResolved) {
        reader = loadCrossPointReader();
        readerResolved = true;
    }
    return reader;
}

function loadCrossPointReader(): LibraryReader | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('./crosspoint_upload') as {
            checkCrossPointConnection?: unknown;
            listCrossPointFiles?: unknown;
        };
        if (
            mod &&
            typeof mod.checkCrossPointConnection === 'function' &&
            typeof mod.listCrossPointFiles === 'function'
        ) {
            const checkConnection = mod.checkCrossPointConnection as LibraryReader['checkConnection'];
            const listBooks = mod.listCrossPointFiles as LibraryReader['listBooks'];
            return {
                checkConnection: (ip) => checkConnection(ip),
                listBooks: (ip, targetFolder) => listBooks(ip, targetFolder),
            };
        }
    } catch {
        // Not a React Native runtime. Handled by callers.
    }
    return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the merged library.
 *
 * NEVER THROWS and never returns a partial shape: every failure lands in
 * `readerFresh` / `readerError` / `mailboxOk` / `mailboxError` with whatever rows
 * could still be produced, because a Library tab that renders nothing is a worse
 * answer than a Library tab that renders what it knows.
 *
 * The two sides run CONCURRENTLY — different hosts, so the firmware's
 * one-request-at-a-time HTTP server (the reason `DeviceScreen` scans its roots
 * serially) is not a shared constraint here.
 */
export async function loadLibrary(
    dest: LibraryDestination,
    opts: LoadLibraryOptions = {}
): Promise<LibrarySnapshot> {
    const probeReader = opts?.probeReader !== false;
    const [readerSide, mailboxSide] = await Promise.all([
        loadReaderSide(typeof dest?.ip === 'string' ? dest.ip.trim() : '', probeReader),
        loadMailboxSide(dest),
    ]);

    const snapshot: LibrarySnapshot = {
        books: mergeBooks(readerSide, mailboxSide.books),
        readerFresh: readerSide.fresh,
        readerListedAt: readerSide.listedAt,
        mailboxOk: mailboxSide.ok,
        mailboxConfigured: mailboxSide.configured,
    };
    if (mailboxSide.error) snapshot.mailboxError = mailboxSide.error;
    if (!readerSide.fresh && readerSide.error) snapshot.readerError = readerSide.error;
    return snapshot;
}

/**
 * Stop the mailbox advertising one book.
 *
 * Thin over `mailbox_client.deleteMailboxBook` — it exists so the screen needs
 * no mailbox credentials vocabulary beyond the {@link LibraryDestination} it
 * already holds, and so "not configured" is refused here rather than turning
 * into a confusing URL error from the wire layer.
 *
 * SNAPSHOT SEMANTICS — this deliberately does NOT mutate anything cached:
 *   - the cache is the READER side only, and this call cannot change what is on
 *     the SD card. A row that was `both` becomes `reader` on the next load and
 *     the book stays on the reader, which is the truth (mailbox_client's own doc:
 *     a reader that already pulled the book keeps it).
 *   - there is no in-memory snapshot to patch. The caller re-runs
 *     {@link loadLibrary} after an `ok: true`, so the list it renders next is a
 *     real listing rather than a local guess about one.
 *   - on `ok: false` nothing changed anywhere, so a re-run is safe too; a 404
 *     specifically means the list is stale and re-running is the FIX.
 *
 * NEVER THROWS.
 */
export async function removeMailboxBook(
    dest: LibraryDestination,
    mailboxId: string
): Promise<{ ok: boolean; error?: string }> {
    const url = typeof dest?.mailboxUrl === 'string' ? dest.mailboxUrl.trim() : '';
    const token = typeof dest?.mailboxWriteToken === 'string' ? dest.mailboxWriteToken.trim() : '';
    if (!url || !token) return { ok: false, error: MAILBOX_NOT_CONFIGURED };

    const id = typeof mailboxId === 'string' ? mailboxId.trim() : '';
    if (!id) return { ok: false, error: 'That book has no mailbox id to remove.' };

    const result = await deleteMailboxBook(url, token, id);
    if (!result.success) {
        return { ok: false, error: result.error || 'The mailbox delete failed.' };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Reader side
// ---------------------------------------------------------------------------

/** A reader row, normalised, with the recency the sort uses. */
interface ReaderRow {
    filename: string;
    bytes: number;
    /** Filename-derived date from `listCrossPointFiles`; 0 when unknown. */
    timestamp: number;
}

interface ReaderSide {
    rows: ReaderRow[];
    fresh: boolean;
    listedAt: number | null;
    error?: string;
}

async function loadReaderSide(ip: string, probeReader: boolean): Promise<ReaderSide> {
    if (!ip) return cachedReaderSide(READER_NO_ADDRESS);

    const transport = getReader();
    if (!transport) return cachedReaderSide(READER_NO_TRANSPORT);

    if (probeReader) {
        const probe = await probeConnection(transport, ip);
        if (!probe.ok) return cachedReaderSide(probe.error);
    }

    let listed: RemoteFile[];
    try {
        listed = await transport.listBooks(ip, DEFAULT_LIBRARY_FOLDER);
    } catch (e) {
        // `listCrossPointFiles` swallows its own errors, but a seam is a seam.
        return cachedReaderSide(errorText(e) || READER_UNREACHABLE);
    }

    const rows = normalizeRows(listed, asListedRow);

    // An empty listing from an un-probed reader is ambiguous — see
    // `LoadLibraryOptions.probeReader`. Confirm before believing it, because
    // believing it would also overwrite the cache with nothing.
    if (rows.length === 0 && !probeReader) {
        const probe = await probeConnection(transport, ip);
        if (!probe.ok) return cachedReaderSide(probe.error);
    }

    const listedAt = Date.now();
    await writeReaderCache(rows, listedAt);
    return { rows, fresh: true, listedAt };
}

async function probeConnection(
    transport: LibraryReader,
    ip: string
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        const probe = await transport.checkConnection(ip);
        if (probe?.success) return { ok: true };
        return { ok: false, error: probe?.error || READER_UNREACHABLE };
    } catch (e) {
        return { ok: false, error: errorText(e) || READER_UNREACHABLE };
    }
}

/** Reader rows from the cache, flagged stale, with `error` explaining why. */
async function cachedReaderSide(error: string): Promise<ReaderSide> {
    const cached = await readReaderCache();
    return { rows: cached.rows, fresh: false, listedAt: cached.listedAt, error };
}

/**
 * Unknown entries -> `ReaderRow[]`: trimmed names, no blanks, no duplicates.
 *
 * De-duplicated case-insensitively here as well as in the merge, so the CACHE
 * cannot grow a second row for a name the merge would collapse anyway.
 *
 * TWO COERCIONS, ONE WALK. The live listing speaks `RemoteFile`
 * (`name`/`size`) and the cache speaks its own persisted shape
 * (`filename`/`bytes`); the caller picks which. They were briefly ONE function
 * reading `name`, which quietly meant every cached row was dropped on read and
 * the offline list was always empty — the round-trip test in
 * `scripts/library.test.js` exists because nothing else could see that.
 */
function normalizeRows(entries: unknown, coerce: (entry: unknown) => ReaderRow | null): ReaderRow[] {
    if (!Array.isArray(entries)) return [];
    const rows: ReaderRow[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const row = coerce(entry);
        if (!row) continue;
        const key = mergeKey(row.filename);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
    }
    return rows;
}

/** One row of a LIVE `listCrossPointFiles` result. */
function asListedRow(entry: unknown): ReaderRow | null {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as { name?: unknown; size?: unknown; timestamp?: unknown };
    const filename = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!filename) return null;
    return {
        filename,
        bytes: nonNegativeNumber(raw.size),
        timestamp: nonNegativeNumber(raw.timestamp),
    };
}

/** One row of the PERSISTED cache. Same fields, the names this module wrote. */
function asCachedRow(entry: unknown): ReaderRow | null {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as { filename?: unknown; bytes?: unknown; timestamp?: unknown };
    const filename = typeof raw.filename === 'string' ? raw.filename.trim() : '';
    if (!filename) return null;
    return {
        filename,
        bytes: nonNegativeNumber(raw.bytes),
        timestamp: nonNegativeNumber(raw.timestamp),
    };
}

// ---------------------------------------------------------------------------
// Reader cache
// ---------------------------------------------------------------------------

interface CachedReader {
    rows: ReaderRow[];
    listedAt: number | null;
}

/**
 * Read the cached listing. A blob this build cannot understand reads as EMPTY.
 *
 * Every failure — no storage, a throwing store, non-JSON, wrong shape, junk
 * entries — degrades to "no cached rows" rather than propagating, because the
 * only thing worse than a Library tab with no offline list is a Library tab that
 * cannot render at all.
 */
async function readReaderCache(): Promise<CachedReader> {
    const empty: CachedReader = { rows: [], listedAt: null };
    const backing = getStore();
    if (!backing) return empty;

    let raw: string | null;
    try {
        raw = await backing.getItem(READER_BOOKS_CACHE_KEY);
    } catch (e) {
        console.warn('[Library] Failed to read the reader cache:', e);
        return empty;
    }
    if (!raw) return empty;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn('[Library] Reader cache is not JSON, treating as empty');
        return empty;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[Library] Reader cache is not an object, treating as empty');
        return empty;
    }

    const blob = parsed as { listedAt?: unknown; books?: unknown };
    const listedAt =
        typeof blob.listedAt === 'number' && Number.isFinite(blob.listedAt) && blob.listedAt > 0
            ? blob.listedAt
            : null;
    const rows = normalizeRows(blob.books, asCachedRow).slice(0, MAX_CACHED_READER_BOOKS);
    // A cache with rows but no timestamp is still usable rows; a cache with a
    // timestamp and no rows is a genuinely empty library, and both are honest.
    return { rows, listedAt };
}

/**
 * Replace the cached listing.
 *
 * Called ONLY after a listing this module believes (see `probeReader`), so an
 * empty write means the reader really has no books and the offline list should
 * empty out too.
 */
async function writeReaderCache(rows: ReaderRow[], listedAt: number): Promise<void> {
    const backing = getStore();
    if (!backing) return;
    const blob = { listedAt, books: rows.slice(0, MAX_CACHED_READER_BOOKS) };
    try {
        await backing.setItem(READER_BOOKS_CACHE_KEY, JSON.stringify(blob));
    } catch (e) {
        // Quota, or a store that is simply gone. The listing itself succeeded and
        // failing the load here would report a working reader as unreachable.
        console.warn('[Library] Failed to write the reader cache:', e);
    }
}

// ---------------------------------------------------------------------------
// Mailbox side
// ---------------------------------------------------------------------------

interface MailboxSide {
    books: MailboxBook[];
    ok: boolean;
    configured: boolean;
    error?: string;
}

async function loadMailboxSide(dest: LibraryDestination): Promise<MailboxSide> {
    const url = typeof dest?.mailboxUrl === 'string' ? dest.mailboxUrl.trim() : '';
    const token = typeof dest?.mailboxWriteToken === 'string' ? dest.mailboxWriteToken.trim() : '';
    // Both halves are required: `listMailboxBooks` reads the authenticated
    // `/status`, so a URL without a token cannot answer at all.
    if (!url || !token) {
        return { books: [], ok: false, configured: false, error: MAILBOX_NOT_CONFIGURED };
    }

    const result = await listMailboxBooks(url, token);
    if (!result.success) {
        return {
            books: [],
            ok: false,
            configured: true,
            error: result.error || MAILBOX_LIST_FAILED,
        };
    }
    return { books: Array.isArray(result.books) ? result.books : [], ok: true, configured: true };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** A merged row plus the two keys the sort needs, stripped before returning. */
interface MergedRow extends LibraryBook {
    /** Best-known recency: the reader's filename date, or 0. */
    recency: number;
    /** Index in the mailbox listing (newest-first), or MAILBOX_RANK_NONE. */
    mailboxRank: number;
}

/**
 * One list from two, keyed on the filename, case-insensitively.
 *
 * WHY CASE-INSENSITIVE: the reader's SD card is FAT, where 'Book.epub' and
 * 'book.epub' are the same file. Merging case-sensitively would show a queued
 * book as missing from a reader that already has it — the exact confusion this
 * screen exists to remove. The READER's spelling is the one displayed, since it
 * is the name the card actually carries.
 */
function mergeBooks(readerSide: ReaderSide, mailboxBooks: MailboxBook[]): LibraryBook[] {
    const merged = new Map<string, MergedRow>();

    const readerListedAt = readerSide.listedAt;
    for (const row of readerSide.rows) {
        const key = mergeKey(row.filename);
        if (merged.has(key)) continue;
        const book: MergedRow = {
            filename: row.filename,
            bytes: row.bytes,
            location: 'reader',
            recency: row.timestamp,
            mailboxRank: MAILBOX_RANK_NONE,
        };
        if (readerListedAt !== null) book.readerListedAt = readerListedAt;
        merged.set(key, book);
    }

    for (let index = 0; index < mailboxBooks.length; index++) {
        const entry = mailboxBooks[index];
        const filename = typeof entry?.filename === 'string' ? entry.filename.trim() : '';
        const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
        if (!filename || !id) continue;
        const bytes = nonNegativeNumber(entry.bytes);
        const key = mergeKey(filename);
        const existing = merged.get(key);

        if (!existing) {
            merged.set(key, {
                filename,
                bytes,
                location: 'mailbox',
                mailboxId: id,
                recency: 0,
                mailboxRank: index,
            });
            continue;
        }

        // Two mailbox rows with one name (different ids — the server allows it).
        // Keep the FIRST, which is the newest: the id must address the copy a
        // delete would remove, and deleting the older of two identical names
        // would leave the queue looking unchanged.
        if (existing.mailboxId) continue;

        existing.location = 'both';
        existing.mailboxId = id;
        existing.mailboxRank = index;
        // The reader's own listing can omit a size (`item.size` is optional in
        // the firmware's JSON); the mailbox always knows what it stored.
        if (existing.bytes === 0) existing.bytes = bytes;
    }

    return [...merged.values()].sort(compareBooks).map(stripSortKeys);
}

/** Lower-cased, trimmed filename — the merge identity. */
function mergeKey(filename: string): string {
    return filename.trim().toLowerCase();
}

/**
 * Newest-first by the best information either side gave, then by name.
 *
 * 1. `recency` descending. Only the reader listing carries a per-book date (from
 *    the filename), so dated books float to the top — that is the "best-known
 *    info" and there is nothing better to be had: the mailbox contract is three
 *    fields, none of them a timestamp.
 * 2. mailbox rank ascending. Inside a bucket with no dates, the mailbox's own
 *    newest-first order is real recency information, and rows the mailbox does
 *    not hold sort after the ones it does.
 * 3. filename, case-insensitive then raw. A TOTAL order, so the list cannot
 *    reshuffle between two loads of identical data — the thing that makes a
 *    pull-to-refresh feel broken.
 */
function compareBooks(a: MergedRow, b: MergedRow): number {
    if (a.recency !== b.recency) return b.recency - a.recency;
    if (a.mailboxRank !== b.mailboxRank) return a.mailboxRank - b.mailboxRank;
    const al = a.filename.toLowerCase();
    const bl = b.filename.toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
    return 0;
}

function stripSortKeys(row: MergedRow): LibraryBook {
    const book: LibraryBook = {
        filename: row.filename,
        bytes: row.bytes,
        location: row.location,
    };
    if (row.mailboxId !== undefined) book.mailboxId = row.mailboxId;
    if (row.readerListedAt !== undefined) book.readerListedAt = row.readerListedAt;
    return book;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function nonNegativeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function errorText(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    return '';
}
