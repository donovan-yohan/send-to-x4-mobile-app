/**
 * outbox — the things this phone is holding FOR the reader, on disk, right now.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS: THE PROXY USED TO NEED THE PHONE TO HAVE INTERNET
 * ---------------------------------------------------------------------------
 * The A3 peer link (docs/xteink/mailbox-books-contract.md) makes the phone the
 * reader's mailbox front door: the reader joins nothing, raises its own AP, and
 * pulls `latest.txt` / `current.frame` / `books.txt` / `books/{id}` from a tiny
 * forwarder on the phone. Forwarder is the operative word — every one of those
 * reads was answered by fetching the REAL mailbox over cellular. On a phone with
 * no route at all (airplane, subway, a SIM-less phone on café Wi-Fi) the link
 * comes up, the reader probes, and every window ends in a 502.
 *
 * That is absurd, because the bytes the user wants to hand over are ALREADY ON
 * THE PHONE. This module is where they are kept so the native side can serve
 * them from local disk with no upstream at all.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY IT IS SPLIT IN THREE
 * ---------------------------------------------------------------------------
 *   - BODIES are files under `{documentDirectory}outbox/`. A 24 MiB epub must
 *     never cross the JS bridge — `crosspoint_upload` already demonstrates what
 *     that costs (HANDOFF.md's `MAX_EPUB_BYTES` note: base64 string + byte array
 *     ≈ 2.4x the book live at once, an OOM process crash with no error to show).
 *     Kotlin opens the file itself and streams it into the socket.
 *   - The INDEX is one AsyncStorage key. It is the authority for JS: ordering,
 *     the cap, the prune policy, what has been delivered.
 *   - The MANIFEST is that index mirrored to `outbox/manifest.json`, rewritten
 *     on every mutation, because the native half cannot read AsyncStorage. It is
 *     an EXPORT, never a second source of truth: if the two ever disagree the
 *     index wins and the next mutation repairs the file.
 *
 * ---------------------------------------------------------------------------
 * THE MANIFEST IS A WIRE FORMAT — `scripts/outbox.test.js` PINS IT BYTE-EXACT
 * ---------------------------------------------------------------------------
 *   {"version":1,"items":[
 *     {"id","kind","bytes","bodyPath","queuedAt"},                  // note
 *     {"id","kind","filename","bytes","bodyPath","queuedAt","deliveredAt"}, // book
 *     {"id","kind","target","filename"?,"bytes","bodyPath","queuedAt"} // wallpaper
 *   ]}
 *
 * Rules the Kotlin side is entitled to rely on, and which the golden test holds:
 *   - `items` is QUEUE ORDER, oldest first. "Newest note" is therefore the LAST
 *     item with `kind: 'note'` — that is the id `latest.txt` should answer with
 *     and the body `current.frame` should serve. `wallpaper.txt` is emitted in
 *     this same order (NEWEST LAST), because a reader applying the lines in
 *     order has to finish on the newest primary.
 *   - `bytes` is the exact body length. `books.txt` lines are
 *     `{id} {bytes} {filename}\n` and the reader compares that number against
 *     every `Content-Range` total it sees, so a wrong one strands a download.
 *     `wallpaper.txt` lines are `{id} {bytes} {target} {filename}\n` with '-' in
 *     the filename position for a primary, and the same size rule applies.
 *   - `filename` is present on books, on 'set' wallpapers, absent on notes and on
 *     'primary' wallpapers, and is already sanitized to printable ASCII with no
 *     space-free-field ambiguity: no CR/LF, no path separator,
 *     ≤ {@link OUTBOX_FILENAME_MAX_CHARS}. §2 makes the SERVER responsible for
 *     that, and here the phone is the server.
 *   - `target` is present ONLY on wallpapers and is 'primary' or 'set'. It is on
 *     the wire rather than inferred because the two mean two different files on
 *     the card (`/sleep.bmp` versus `/.sleep/<filename>`) and a reader that had
 *     to guess would put a pinned picture into the random rotation.
 *   - `deliveredAt` present means the reader has already taken this item whole.
 *     The server should leave it OUT of `latest.txt` / `books.txt` but MAY still
 *     answer `books/{id}` for it, so a reader that lost its staging can re-pull
 *     inside the retention window.
 *   - An ABSENT or UNPARSEABLE manifest means "no local items". It never means
 *     an error: A3's zero-internet mode has to answer the contract honestly
 *     (empty `latest.txt`, empty `books.txt`, `404`) so the reader shows
 *     "nothing new" instead of a failure.
 *
 * ---------------------------------------------------------------------------
 * NODE-TESTABLE BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * Neither `expo-file-system` nor AsyncStorage can be imported under node, so
 * both are reached through injectable seams ({@link __setOutboxFileSystem},
 * {@link __setOutboxStore}) resolved by the same lazy-`require` idiom as
 * `message_history` / `epub_sender` / `library`. With neither present the module
 * degrades to "nothing can be queued here" rather than throwing at import.
 */

import { createLock } from '../utils/lock';
import { uint8ArrayToBase64 } from '../utils/base64';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AsyncStorage key for the index. NEW — nothing else reads or writes it. */
export const OUTBOX_INDEX_KEY = '@messenger/outbox';

/** Directory under `documentDirectory` holding bodies + the manifest. */
export const OUTBOX_DIR_NAME = 'outbox';

/** The file Kotlin reads. Passed to `startProxy` as `outboxManifestPath`. */
export const OUTBOX_MANIFEST_FILENAME = 'manifest.json';

/**
 * Manifest schema version.
 *
 * Bumping it is a NATIVE-SIDE BREAKING CHANGE: the Kotlin reader is entitled to
 * refuse a version it does not know and fall back to "no local items", which is
 * the honest degradation. Add optional fields instead wherever possible.
 */
export const OUTBOX_MANIFEST_VERSION = 1 as const;

/** Body suffixes. The extension is cosmetic — Kotlin goes by `kind`. */
const NOTE_BODY_EXT = '.frame';
const BOOK_BODY_EXT = '.epub';
const WALLPAPER_BODY_EXT = '.bmp';

/**
 * Hard cap on stored items, delivered or not.
 *
 * 20 mirrors the mailbox's own `MAX_BOOKS` (§2): a queue that can outgrow what
 * the mailbox itself would hold is a queue the user cannot reason about. Eviction
 * prefers DELIVERED items, then the oldest.
 */
export const DEFAULT_MAX_OUTBOX_ITEMS = 20;

/** Age cap. A book queued a month ago is not something anyone is still waiting on. */
export const DEFAULT_MAX_OUTBOX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Disk cap. Three 24 MiB books is already more than any one handover.
 *
 * This is the ONLY bound that protects the user's storage: bodies are copies, so
 * an uncapped outbox silently doubles every book the phone has ever failed to
 * send.
 */
export const DEFAULT_MAX_OUTBOX_BYTES = 96 * 1024 * 1024;

/**
 * Largest single body the queue will accept.
 *
 * Checked AFTER the copy (it is the first point where the real size is known —
 * the picker routinely reports none on Android SAF) and the copy is undone on a
 * refusal, so an oversized book costs one wasted copy rather than a permanent
 * item that can never fit under {@link DEFAULT_MAX_OUTBOX_BYTES} and therefore
 * evicts everything else on every enqueue.
 *
 * Deliberately LARGER than the mailbox's own `MAX_BOOK_BYTES` (24 MiB): this
 * path has no Workers KV value ceiling and no upload at all — the bytes are
 * already on the phone and the reader pulls them over the peer link with `Range`
 * resume. A book too big to publish is exactly the book most worth handing over.
 */
export const MAX_OUTBOX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * How long a DELIVERED item is kept before pruning.
 *
 * Not zero, and the reason is the one thing the contract cannot tell us: the
 * proxy knows the last byte went out, not that the reader's staging survived the
 * write. A day of grace makes a re-pull free; permanent retention would just be
 * a disk leak with extra steps.
 */
export const DEFAULT_DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Filename ceiling, matching `BOOK_FILENAME_MAX_LEN` in §2.
 *
 * Same number on purpose: a name this store accepts must be a name a
 * `books.txt` line can carry, or the local and remote halves of the merged
 * manifest would disagree about what is nameable.
 */
export const OUTBOX_FILENAME_MAX_CHARS = 120;

/**
 * Id charset, matching the mailbox's (`[A-Za-z0-9._~-]{1,64}`, §2).
 *
 * The id is used THREE ways — as a URL path segment the reader requests, as a
 * key in the manifest, and as part of a filename on the phone's disk — so it has
 * to be safe in all three. `.` / `..` are refused separately below: they satisfy
 * this pattern and are a traversal in the third use.
 */
const OUTBOX_ID_ALLOWED = /^[A-Za-z0-9._~-]{1,64}$/;

/** Everything a `books.txt` line and an SD-card filename can both survive. */
const FILENAME_ILLEGAL = /[^ -~]|[\\/:*?"<>|]/;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type OutboxKind = 'note' | 'book' | 'wallpaper';

/**
 * Which sleep-screen slot a queued wallpaper is aimed at. Wallpapers only.
 *
 * Same two words, and the same meaning, as `mailbox_client`'s
 * `MailboxWallpaperTarget` and `wallpaper_sender`'s `WallpaperTarget.kind`, so
 * one send carries one target down all three roads (direct, mailbox, handover)
 * without a translation table anywhere.
 */
export type OutboxWallpaperTarget = 'primary' | 'set';

export interface OutboxItem {
    /**
     * The id the reader will see: a note's dedup id (`latest.txt`), a book's
     * manifest id (`books.txt`, `books/{id}`) or a wallpaper's
     * (`wallpaper.txt`, `wallpaper/{id}`). Minted by the caller so a queued item
     * and a published one can be the SAME item — a note that later reaches the
     * mailbox under this id is deduped by the reader, not shown twice.
     */
    id: string;
    kind: OutboxKind;
    /**
     * Wallpapers only, and REQUIRED on them.
     *
     * Absent on a wallpaper is not a defaultable field: 'primary' overwrites the
     * one slot the firmware prefers over everything else, so guessing it would
     * replace a sleep screen the user never asked to replace.
     */
    target?: OutboxWallpaperTarget;
    /**
     * Books and 'set' wallpapers. Already sanitized; see
     * {@link OUTBOX_FILENAME_MAX_CHARS}. Absent on notes and on 'primary'
     * wallpapers, whose destination is a fixed path with no name to carry.
     */
    filename?: string;
    /** Exact body length. What `books.txt` publishes and the reader checks. */
    bytes: number;
    /** Absolute path/URI of the body file. Kotlin opens this directly. */
    bodyPath: string;
    queuedAt: number;
    /** Set once the proxy reported the reader took the whole body. */
    deliveredAt?: number;
}

export interface OutboxManifest {
    version: typeof OUTBOX_MANIFEST_VERSION;
    /** Queue order, OLDEST FIRST. The newest note is the last `kind: 'note'`. */
    items: OutboxItem[];
}

export interface OutboxPrunePolicy {
    maxItems?: number;
    maxAgeMs?: number;
    maxBytes?: number;
    deliveredRetentionMs?: number;
    /** Injectable clock, so age policy is testable without waiting. */
    now?: number;
}

/** What the surfaces say, computed once so no two of them can disagree. */
export interface OutboxSummary {
    /** Items still waiting to be handed over. */
    pending: number;
    pendingNotes: number;
    pendingBooks: number;
    pendingWallpapers: number;
    /** Body bytes of the pending items. */
    pendingBytes: number;
    /** Items already handed over and still inside the retention window. */
    delivered: number;
}

/** Raised by the enqueue paths. Callers treat queuing as best-effort. */
export class OutboxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OutboxError';
    }
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of AsyncStorage this module needs. Structural, not imported — see
 * `message_history.MessageHistoryStore` for why.
 */
export interface OutboxStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * The slice of `expo-file-system` this module needs.
 *
 * `copy` rather than "read then write": a book is copied ON THE NATIVE SIDE from
 * the picker's cache file into the outbox, so the bytes never become a JS
 * string. That is the whole reason a 24 MiB book can be queued at all.
 */
export interface OutboxFileSystem {
    /** `file:///…/` with a trailing slash, or null when there is no sandbox. */
    documentDirectory: string | null;
    makeDirectory(path: string): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
    writeBase64(path: string, base64: string): Promise<void>;
    copy(from: string, to: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    /** Body length in bytes, or null when the file is absent/unmeasurable. */
    size(path: string): Promise<number | null>;
    /** Idempotent: removing an absent file is not an error. */
    remove(path: string): Promise<void>;
}

// Metro collects `require('<literal>')` statically, so the lazy loads below are
// ordinary bundle dependencies. Under node's ESM loader the identifier does not
// exist — `typeof` on an undeclared name is safe — and the module degrades to
// "no storage / no filesystem".
declare const require: ((id: string) => unknown) | undefined;

let store: OutboxStore | null = null;
let storeResolved = false;

/** Replace the index store. Pass `null` to restore AsyncStorage. TEST SEAM. */
export function __setOutboxStore(next: OutboxStore | null): void {
    store = next;
    storeResolved = next !== null;
}

function getStore(): OutboxStore | null {
    if (!storeResolved) {
        store = loadAsyncStorage();
        storeResolved = true;
    }
    return store;
}

function loadAsyncStorage(): OutboxStore | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('@react-native-async-storage/async-storage') as { default?: unknown };
        for (const candidate of [mod?.default, mod]) {
            if (isStore(candidate)) return candidate;
        }
    } catch {
        // Not a React Native runtime (node test, web preview).
    }
    return null;
}

function isStore(value: unknown): value is OutboxStore {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<OutboxStore>;
    return (
        typeof candidate.getItem === 'function' &&
        typeof candidate.setItem === 'function' &&
        typeof candidate.removeItem === 'function'
    );
}

let fs: OutboxFileSystem | null = null;
let fsResolved = false;

/** Replace the filesystem. Pass `null` to restore expo-file-system. TEST SEAM. */
export function __setOutboxFileSystem(next: OutboxFileSystem | null): void {
    fs = next;
    fsResolved = next !== null;
}

function getFs(): OutboxFileSystem | null {
    if (!fsResolved) {
        fs = loadExpoFileSystem();
        fsResolved = true;
    }
    return fs;
}

function loadExpoFileSystem(): OutboxFileSystem | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('expo-file-system/legacy') as {
            documentDirectory?: string | null;
            makeDirectoryAsync?: (uri: string, o?: { intermediates?: boolean }) => Promise<void>;
            writeAsStringAsync?: (uri: string, c: string, o?: { encoding?: string }) => Promise<void>;
            copyAsync?: (o: { from: string; to: string }) => Promise<void>;
            moveAsync?: (o: { from: string; to: string }) => Promise<void>;
            getInfoAsync?: (uri: string) => Promise<{ exists?: boolean; size?: number }>;
            deleteAsync?: (uri: string, o?: { idempotent?: boolean }) => Promise<void>;
            EncodingType?: { Base64?: string };
        };
        if (
            !mod ||
            typeof mod.makeDirectoryAsync !== 'function' ||
            typeof mod.writeAsStringAsync !== 'function' ||
            typeof mod.copyAsync !== 'function' ||
            typeof mod.getInfoAsync !== 'function' ||
            typeof mod.deleteAsync !== 'function'
        ) {
            return null;
        }
        const write = mod.writeAsStringAsync;
        const copyAsync = mod.copyAsync;
        const moveAsync = mod.moveAsync;
        const info = mod.getInfoAsync;
        const del = mod.deleteAsync;
        const mkdir = mod.makeDirectoryAsync;
        // The documented constant is just the string 'base64'; the literal
        // fallback keeps a write correct if the enum ever moves, rather than
        // silently storing UTF-8 text where a frame should be.
        const base64 = mod.EncodingType?.Base64 ?? 'base64';
        return {
            documentDirectory: mod.documentDirectory ?? null,
            makeDirectory: uri => mkdir(uri, { intermediates: true }),
            writeText: (uri, text) => write(uri, text),
            writeBase64: (uri, data) => write(uri, data, { encoding: base64 }),
            copy: (from, to) => copyAsync({ from, to }),
            move: async (from, to) => {
                if (typeof moveAsync !== 'function') {
                    throw new OutboxError('expo-file-system has no moveAsync');
                }
                await moveAsync({ from, to });
            },
            async size(uri) {
                const stat = await info(uri);
                if (!stat || stat.exists === false) return null;
                return typeof stat.size === 'number' && Number.isFinite(stat.size)
                    ? stat.size
                    : null;
            },
            remove: uri => del(uri, { idempotent: true }),
        };
    } catch {
        // Not a React Native runtime (node test, web preview).
    }
    return null;
}

// ---------------------------------------------------------------------------
// Change notification — the surfaces show a live count
// ---------------------------------------------------------------------------

type OutboxListener = (items: OutboxItem[]) => void;

const listeners = new Set<OutboxListener>();

/**
 * Subscribe to every mutation. Returns an unsubscribe function.
 *
 * This is the AUTO-ARM channel: a send that fails queues its item here, and the
 * Library/Compose surfaces update to "N items ready to hand over" without the
 * user doing anything. The delivery itself is armed by the item's mere presence
 * — the next peer session passes the manifest down and the proxy serves it — so
 * there is no watcher process to leak.
 */
export function subscribeOutbox(listener: OutboxListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function notify(items: OutboxItem[]): void {
    // Copied: a listener may unsubscribe itself from inside the callback.
    for (const listener of [...listeners]) {
        try {
            listener(items);
        } catch (e) {
            console.warn('[Outbox] listener threw:', e);
        }
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function outboxDir(system: OutboxFileSystem): string {
    const root = system.documentDirectory;
    if (!root) throw new OutboxError('This runtime has no document directory to queue into.');
    return `${root.endsWith('/') ? root : `${root}/`}${OUTBOX_DIR_NAME}/`;
}

/** Cosmetic per-kind suffix. Kotlin routes on `kind`, never on this. */
function bodyExtFor(kind: OutboxKind): string {
    if (kind === 'note') return NOTE_BODY_EXT;
    if (kind === 'wallpaper') return WALLPAPER_BODY_EXT;
    return BOOK_BODY_EXT;
}

function bodyPathFor(system: OutboxFileSystem, kind: OutboxKind, id: string): string {
    return `${outboxDir(system)}${kind}-${id}${bodyExtFor(kind)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Why `id` cannot be an outbox id, or null when it can. */
export function describeOutboxIdProblem(id: unknown): string | null {
    if (typeof id !== 'string' || id.length === 0) return 'Queue id is empty.';
    if (!OUTBOX_ID_ALLOWED.test(id)) {
        return `Queue id must be 1..64 of [A-Za-z0-9._~-] (got ${JSON.stringify(id)}).`;
    }
    // Both satisfy the charset and both are a directory traversal once the id
    // becomes a filename — which it does, one line below the caller.
    if (id === '.' || id === '..') return 'Queue id cannot be "." or "..".';
    return null;
}

/** Why `filename` cannot ride a `books.txt` line, or null when it can. */
export function describeOutboxFilenameProblem(filename: unknown): string | null {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        return 'Book filename is empty.';
    }
    if (filename.length > OUTBOX_FILENAME_MAX_CHARS) {
        return `Book filename is longer than ${OUTBOX_FILENAME_MAX_CHARS} characters.`;
    }
    if (FILENAME_ILLEGAL.test(filename)) {
        // Rejected, never repaired: §2 refuses rather than truncates for the same
        // reason — a "fixed" name can lose its `.epub` tail, and a name that
        // differs from the one the direct route would have used produces a second
        // copy of a book the user already sent.
        return `Book filename has a character a books.txt line cannot carry: ${JSON.stringify(filename)}`;
    }
    if (filename.startsWith('.')) return 'Book filename cannot start with a dot.';
    // THE SAME PREDICATE AS KOTLIN'S `isValidBookFilename`, and it has to be.
    //
    // The native reader refuses anything without an `.epub` tail and DROPS the
    // entry — counted in `localSkipped` and otherwise silent. A book queued
    // through any path but `queueEpubForHandover` (the only caller that runs
    // `resolveEpubFilename`, and therefore the only one that guarantees the
    // extension) was accepted here, written to disk, listed in the manifest, and
    // then invisible to the reader with no error anywhere. Refusing at the point
    // where a caller can be TOLD is the whole difference.
    if (!/\.epub$/i.test(filename)) {
        return `Book filename must end in .epub: ${JSON.stringify(filename)}`;
    }
    return null;
}

/**
 * Why `filename` cannot ride a `wallpaper.txt` line, or null when it can.
 *
 * The same charset argument as {@link describeOutboxFilenameProblem} with two
 * differences that both come from the line format:
 *
 *   - `.bmp`, not `.epub`. The firmware scans `/.sleep` for that extension, so a
 *     name without it is a file the reader writes and then never looks at.
 *   - A BARE '-' IS REFUSED. `wallpaper.txt` writes '-' in the filename position
 *     for a primary, so a rotation entry literally called '-' would be
 *     indistinguishable from "this one has no name" — and would be applied to
 *     `/sleep.bmp` instead of the rotation.
 *
 * Rejected, never repaired, for the reason the book half gives: a "fixed" name
 * can lose its extension, and a name that differs from the one the direct route
 * would have used produces a SECOND copy of a picture the user already sent.
 */
export function describeOutboxWallpaperFilenameProblem(filename: unknown): string | null {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        return 'Wallpaper filename is empty.';
    }
    if (filename.length > OUTBOX_FILENAME_MAX_CHARS) {
        return `Wallpaper filename is longer than ${OUTBOX_FILENAME_MAX_CHARS} characters.`;
    }
    if (FILENAME_ILLEGAL.test(filename)) {
        return `Wallpaper filename has a character a wallpaper.txt line cannot carry: ${JSON.stringify(filename)}`;
    }
    if (filename.startsWith('.')) return 'Wallpaper filename cannot start with a dot.';
    if (filename === '-') return 'Wallpaper filename cannot be "-" (that means "no name").';
    if (!/\.bmp$/i.test(filename)) {
        return `Wallpaper filename must end in .bmp: ${JSON.stringify(filename)}`;
    }
    return null;
}

/** Coerce an unknown into a wallpaper target, or null. */
function asWallpaperTarget(value: unknown): OutboxWallpaperTarget | null {
    return value === 'primary' || value === 'set' ? value : null;
}

// ---------------------------------------------------------------------------
// Index I/O (callers must hold the lock)
// ---------------------------------------------------------------------------

const withLock = createLock();

function asItem(value: unknown): OutboxItem | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (describeOutboxIdProblem(raw.id) !== null) return null;
    const kind: OutboxKind | null =
        raw.kind === 'book' || raw.kind === 'note' || raw.kind === 'wallpaper' ? raw.kind : null;
    if (kind === null) return null;
    if (typeof raw.bodyPath !== 'string' || raw.bodyPath.length === 0) return null;
    const bytes = typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) ? raw.bytes : -1;
    // A body of unknown length cannot be published: `books.txt` carries the
    // number the reader checks every `Content-Range` against, and a wrong one
    // strands the download partway through with no way to recover.
    if (bytes < 0) return null;

    const item: OutboxItem = {
        id: raw.id as string,
        kind,
        bytes,
        bodyPath: raw.bodyPath,
        queuedAt:
            typeof raw.queuedAt === 'number' && Number.isFinite(raw.queuedAt) ? raw.queuedAt : 0,
    };
    if (kind === 'book' && describeOutboxFilenameProblem(raw.filename) === null) {
        item.filename = raw.filename as string;
    } else if (kind === 'book') {
        // A book with no usable name cannot be listed; dropping the row is the
        // honest outcome, since the reader creates the file from that name.
        return null;
    } else if (kind === 'wallpaper') {
        // NO DEFAULT FOR `target`, deliberately: 'primary' overwrites the single
        // slot the firmware prefers over everything, so a row whose target
        // cannot be read must not be guessed into it. Dropped instead, which
        // costs one handover and is self-healing on the next enqueue.
        const target = asWallpaperTarget(raw.target);
        if (target === null) return null;
        item.target = target;
        if (target === 'set') {
            if (describeOutboxWallpaperFilenameProblem(raw.filename) !== null) return null;
            item.filename = raw.filename as string;
        }
        // A 'primary' carries NO filename even if the manifest supplied one: the
        // destination is the fixed `/sleep.bmp`, and a name in the line would be
        // a value the reader has to know to ignore.
    }
    if (typeof raw.deliveredAt === 'number' && Number.isFinite(raw.deliveredAt)) {
        item.deliveredAt = raw.deliveredAt;
    }
    return item;
}

async function readIndex(): Promise<OutboxItem[]> {
    const backing = getStore();
    if (!backing) return [];
    let raw: string | null;
    try {
        raw = await backing.getItem(OUTBOX_INDEX_KEY);
    } catch (e) {
        console.warn('[Outbox] Failed to read index:', e);
        return [];
    }
    if (!raw) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn('[Outbox] Index blob is not JSON, starting empty');
        return [];
    }
    // Accepts both the bare array an older build might have written and the
    // manifest object this one writes: the index is unversioned by nature (it is
    // whatever the last build stored) and a shape mismatch must degrade to empty,
    // never throw into a send path.
    const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as OutboxManifest).items)
          ? (parsed as OutboxManifest).items
          : null;
    if (!list) {
        console.warn('[Outbox] Index blob has no items array, starting empty');
        return [];
    }

    const items: OutboxItem[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
        const item = asItem(entry);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
    }
    return items;
}

/**
 * Serialise one item with a FIXED key order.
 *
 * The order is part of the golden test, not an accident: the manifest is read by
 * a hand-rolled Kotlin parser and by a human staring at `adb shell cat`, and a
 * diff that reshuffles keys on every write is noise in both.
 */
function serializeItem(item: OutboxItem): Record<string, unknown> {
    const out: Record<string, unknown> = { id: item.id, kind: item.kind };
    // `target` sits between `kind` and `filename` because it is only ever
    // present on wallpapers: notes and books serialise BYTE-IDENTICALLY to what
    // they always have, so the golden manifest test keeps its old expectations
    // for every item shape that existed before wallpapers did.
    if (item.target !== undefined) out.target = item.target;
    if (item.filename !== undefined) out.filename = item.filename;
    out.bytes = item.bytes;
    out.bodyPath = item.bodyPath;
    out.queuedAt = item.queuedAt;
    if (item.deliveredAt !== undefined) out.deliveredAt = item.deliveredAt;
    return out;
}

/** The exact bytes written to `outbox/manifest.json`. Pinned by the tests. */
export function serializeOutboxManifest(items: OutboxItem[]): string {
    return JSON.stringify({
        version: OUTBOX_MANIFEST_VERSION,
        items: items.map(serializeItem),
    });
}

/**
 * Persist the index AND re-export the manifest.
 *
 * The manifest write is best-effort and deliberately SECOND: the index is what
 * JS reasons about, and a failed export leaves the native side seeing a slightly
 * stale queue — which is a missed handover, recoverable next session — where a
 * failed index write would lose the item entirely.
 */
async function writeIndex(items: OutboxItem[]): Promise<void> {
    const backing = getStore();
    if (backing) {
        try {
            // The SAME serialisation as the exported manifest, so a bug can never
            // make the two disagree about what is queued — which would present as
            // the reader being offered something the app does not think it has.
            await backing.setItem(OUTBOX_INDEX_KEY, serializeOutboxManifest(items));
        } catch (e) {
            console.warn('[Outbox] Failed to write index:', e);
        }
    } else {
        console.warn('[Outbox] No storage available, queue not persisted');
    }
    await exportManifest(items);
}

/** Write `outbox/manifest.json`. Never throws — see {@link writeIndex}. */
async function exportManifest(items: OutboxItem[]): Promise<string | null> {
    const system = getFs();
    if (!system || !system.documentDirectory) return null;
    const body = serializeOutboxManifest(items);
    const dir = outboxDir(system);
    const target = `${dir}${OUTBOX_MANIFEST_FILENAME}`;
    try {
        await system.makeDirectory(dir);
    } catch {
        // Already exists is the common case and expo does not distinguish it.
    }
    // TEMP-THEN-MOVE, because the native side re-reads this file at arbitrary
    // moments (session start, and on demand mid-session). A direct overwrite has
    // a window in which the file is half a JSON document, and a hand-rolled
    // parser reading that would see a corrupt manifest rather than an old one.
    const temp = `${target}.tmp`;
    try {
        await system.writeText(temp, body);
        await system.move(temp, target);
        return target;
    } catch (e) {
        console.warn('[Outbox] atomic manifest write failed, falling back:', e);
        try {
            await system.writeText(target, body);
            return target;
        } catch (fallbackError) {
            console.warn('[Outbox] Failed to export manifest:', fallbackError);
            return null;
        }
    }
}

// ---------------------------------------------------------------------------
// Prune policy
// ---------------------------------------------------------------------------

interface ResolvedPolicy {
    maxItems: number;
    maxAgeMs: number;
    maxBytes: number;
    deliveredRetentionMs: number;
    now: number;
}

function resolvePolicy(opts?: OutboxPrunePolicy): ResolvedPolicy {
    const positive = (value: number | undefined, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
    return {
        maxItems: positive(opts?.maxItems, DEFAULT_MAX_OUTBOX_ITEMS),
        maxAgeMs: positive(opts?.maxAgeMs, DEFAULT_MAX_OUTBOX_AGE_MS),
        maxBytes: positive(opts?.maxBytes, DEFAULT_MAX_OUTBOX_BYTES),
        deliveredRetentionMs: positive(
            opts?.deliveredRetentionMs,
            DEFAULT_DELIVERED_RETENTION_MS
        ),
        now: typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now(),
    };
}

/**
 * Decide what survives. PURE, so the policy can be tested without a filesystem.
 *
 * Eviction order when a cap bites: DELIVERED items first (they have already done
 * their job), then oldest-queued. Never newest-first — the item the user queued
 * thirty seconds ago is the one they are standing next to the reader for.
 */
export function planOutboxPrune(
    items: OutboxItem[],
    opts?: OutboxPrunePolicy
): { kept: OutboxItem[]; dropped: OutboxItem[] } {
    const policy = resolvePolicy(opts);
    const dropped: OutboxItem[] = [];
    let kept: OutboxItem[] = [];

    for (const item of items) {
        const age = policy.now - item.queuedAt;
        if (item.queuedAt > 0 && age >= policy.maxAgeMs) {
            dropped.push(item);
            continue;
        }
        if (
            item.deliveredAt !== undefined &&
            policy.now - item.deliveredAt >= policy.deliveredRetentionMs
        ) {
            dropped.push(item);
            continue;
        }
        kept.push(item);
    }

    // Sacrifice order: delivered before pending, and inside each group the
    // oldest first. Computed as an index list so `kept` stays in queue order.
    const sacrificeOrder = kept
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            const aDelivered = a.item.deliveredAt !== undefined ? 0 : 1;
            const bDelivered = b.item.deliveredAt !== undefined ? 0 : 1;
            if (aDelivered !== bDelivered) return aDelivered - bDelivered;
            if (a.item.queuedAt !== b.item.queuedAt) return a.item.queuedAt - b.item.queuedAt;
            return a.index - b.index;
        });

    const evicted = new Set<number>();
    let total = kept.reduce((sum, item) => sum + item.bytes, 0);
    for (const { item, index } of sacrificeOrder) {
        if (kept.length - evicted.size <= policy.maxItems && total <= policy.maxBytes) break;
        evicted.add(index);
        total -= item.bytes;
        dropped.push(item);
    }
    if (evicted.size > 0) {
        kept = kept.filter((_item, index) => !evicted.has(index));
    }

    return { kept, dropped };
}

/** Delete bodies for dropped items. Best-effort: a leftover file is not a bug worth failing on. */
async function removeBodies(items: OutboxItem[]): Promise<void> {
    const system = getFs();
    if (!system) return;
    for (const item of items) {
        try {
            await system.remove(item.bodyPath);
        } catch (e) {
            console.warn('[Outbox] Failed to remove body:', item.bodyPath, e);
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every queued item, OLDEST FIRST — the order the manifest publishes. */
export async function listOutbox(): Promise<OutboxItem[]> {
    return withLock(readIndex);
}

/** Only what is still waiting to be handed over. */
export async function listPendingOutbox(): Promise<OutboxItem[]> {
    return (await listOutbox()).filter(item => item.deliveredAt === undefined);
}

/** Counts + bytes for the surfaces. PURE. */
export function summarizeOutbox(items: OutboxItem[]): OutboxSummary {
    let pending = 0;
    let pendingNotes = 0;
    let pendingBooks = 0;
    let pendingWallpapers = 0;
    let pendingBytes = 0;
    let delivered = 0;
    for (const item of items) {
        if (item.deliveredAt !== undefined) {
            delivered += 1;
            continue;
        }
        pending += 1;
        pendingBytes += item.bytes;
        // Written as a three-way switch rather than "note or else book": with a
        // third kind, the old `else` silently counted every wallpaper as a book.
        if (item.kind === 'note') pendingNotes += 1;
        else if (item.kind === 'wallpaper') pendingWallpapers += 1;
        else pendingBooks += 1;
    }
    return { pending, pendingNotes, pendingBooks, pendingWallpapers, pendingBytes, delivered };
}

/**
 * The line the Library and Compose surfaces show, or null when there is nothing
 * to say.
 *
 * "no internet needed" is the whole point of the feature and is the part users
 * do not guess: the reader's own AP carries the bytes, so a phone in airplane
 * mode still delivers. Claimed only when it is TRUE — an empty queue says
 * nothing rather than advertising a capability with nothing behind it.
 */
export function describeOutboxHandover(summary: OutboxSummary): string | null {
    if (summary.pending <= 0) return null;
    const noun = summary.pending === 1 ? 'item' : 'items';
    return `${summary.pending} ${noun} ready to hand over — no internet needed.`;
}

/**
 * Queue one 52272-byte love-note frame under `noteId`.
 *
 * The id is the CALLER's, not minted here, and that is load-bearing: it is the
 * same id the mailbox would have published, so a note that eventually reaches
 * the reader by both routes is deduped by the reader rather than shown twice.
 */
export async function enqueueNote(frame: Uint8Array, noteId: string): Promise<OutboxItem> {
    const idProblem = describeOutboxIdProblem(noteId);
    if (idProblem) throw new OutboxError(idProblem);
    if (!frame || frame.byteLength === 0) throw new OutboxError('Note frame is empty.');

    const system = getFs();
    if (!system || !system.documentDirectory) {
        throw new OutboxError('This runtime cannot store a handover queue.');
    }

    const dir = outboxDir(system);
    try {
        await system.makeDirectory(dir);
    } catch {
        // Already exists.
    }
    const bodyPath = bodyPathFor(system, 'note', noteId);
    await system.writeBase64(bodyPath, uint8ArrayToBase64(frame));

    return commitItem({
        id: noteId,
        kind: 'note',
        bytes: frame.byteLength,
        bodyPath,
        queuedAt: Date.now(),
    });
}

/**
 * Queue one epub by COPYING it into the outbox.
 *
 * Copied, never referenced: the picker hands back a cache URI the OS is free to
 * evict, and a manifest entry pointing at a file that has since disappeared is a
 * `404` at the exact moment the user is standing next to the reader. The copy
 * happens natively, so the book never becomes a JS string.
 *
 * `bytes` comes from stat-ing the COPY, not from the picker: the picker often
 * reports no size at all (Android SAF), and the number published in `books.txt`
 * is the one the reader validates every `Content-Range` against.
 */
export async function enqueueBook(
    fileUri: string,
    filename: string,
    bookId: string
): Promise<OutboxItem> {
    const idProblem = describeOutboxIdProblem(bookId);
    if (idProblem) throw new OutboxError(idProblem);
    const nameProblem = describeOutboxFilenameProblem(filename);
    if (nameProblem) throw new OutboxError(nameProblem);
    if (typeof fileUri !== 'string' || !fileUri.trim()) throw new OutboxError('No file to queue.');

    const system = getFs();
    if (!system || !system.documentDirectory) {
        throw new OutboxError('This runtime cannot store a handover queue.');
    }

    const dir = outboxDir(system);
    try {
        await system.makeDirectory(dir);
    } catch {
        // Already exists.
    }
    const bodyPath = bodyPathFor(system, 'book', bookId);
    // A re-queue of the same id must not fail on an existing file; the reader's
    // own transport refuses overwrites, expo's copy does not, but removing first
    // keeps the two halves behaving the same way.
    try {
        await system.remove(bodyPath);
    } catch {
        // Absent is the normal case.
    }
    await system.copy(fileUri, bodyPath);

    const bytes = await system.size(bodyPath);
    if (bytes === null || bytes <= 0) {
        // Refuse rather than publish a book with a length nothing can trust: a
        // `books.txt` line whose `bytes` disagrees with the body is exactly the
        // "corrupt_book" case §2 makes the server refuse to serve.
        await system.remove(bodyPath).catch(() => undefined);
        throw new OutboxError(`Could not measure ${filename} after copying it into the queue.`);
    }
    if (bytes > MAX_OUTBOX_BODY_BYTES) {
        await system.remove(bodyPath).catch(() => undefined);
        throw new OutboxError(
            `${filename} is ${Math.round(bytes / (1024 * 1024))} MB — too big to hold for handover ` +
                `(limit ${Math.round(MAX_OUTBOX_BODY_BYTES / (1024 * 1024))} MB).`
        );
    }

    return commitItem({
        id: bookId,
        kind: 'book',
        filename,
        bytes,
        bodyPath,
        queuedAt: Date.now(),
    });
}

/**
 * Queue one wallpaper BMP under `wallpaperId`.
 *
 * ---------------------------------------------------------------------------
 * BASE64, AND WHY THAT IS ACCEPTABLE HERE AND NOT FOR A BOOK
 * ---------------------------------------------------------------------------
 * `enqueueBook` COPIES natively precisely so a 24 MiB epub never becomes a JS
 * string. A wallpaper cannot take that road: it does not exist as a file at all
 * — `prepareWallpaperBmp` hands back a `Uint8Array` the encoder just built in
 * memory — so writing it means encoding it, exactly as `enqueueNote` does for a
 * frame. The size is what makes that safe: the sleep screen is 528x792 8-bit,
 * so a BMP is ~419 KB and the base64 of it ~560 KB, an order of magnitude under
 * the allocation shape HANDOFF.md records as an OOM crash.
 *
 * `target` IS REQUIRED and is not defaultable. See {@link OutboxItem.target}.
 * A 'set' wallpaper must carry a name; a 'primary' must NOT (its destination is
 * the fixed `/sleep.bmp`, and a name would be a value the reader has to ignore).
 *
 * The id is the CALLER's, like a note's and a book's, so an item that reaches
 * the reader by both the mailbox and the handover is ONE item, not two.
 */
export async function enqueueWallpaper(
    bmp: Uint8Array,
    wallpaperId: string,
    target: OutboxWallpaperTarget,
    filename?: string
): Promise<OutboxItem> {
    const idProblem = describeOutboxIdProblem(wallpaperId);
    if (idProblem) throw new OutboxError(idProblem);
    if (asWallpaperTarget(target) === null) {
        throw new OutboxError(
            `Wallpaper target must be 'primary' or 'set' (got ${JSON.stringify(target)}).`
        );
    }
    if (!bmp || bmp.byteLength === 0) throw new OutboxError('Wallpaper is empty.');

    const name = target === 'set' ? (typeof filename === 'string' ? filename.trim() : '') : '';
    if (target === 'set') {
        const nameProblem = describeOutboxWallpaperFilenameProblem(name);
        if (nameProblem) throw new OutboxError(nameProblem);
    }

    const system = getFs();
    if (!system || !system.documentDirectory) {
        throw new OutboxError('This runtime cannot store a handover queue.');
    }

    const dir = outboxDir(system);
    try {
        await system.makeDirectory(dir);
    } catch {
        // Already exists.
    }
    const bodyPath = bodyPathFor(system, 'wallpaper', wallpaperId);
    await system.writeBase64(bodyPath, uint8ArrayToBase64(bmp));

    const item: OutboxItem = {
        id: wallpaperId,
        kind: 'wallpaper',
        target,
        bytes: bmp.byteLength,
        bodyPath,
        queuedAt: Date.now(),
    };
    if (target === 'set') item.filename = name;
    return commitItem(item);
}

/**
 * Insert (or replace) one item, prune, persist, notify.
 *
 * REPLACE, not append-twice: re-queuing an id is a RETRY of the same thing (a
 * re-sent note keeps the reader's dedup id, a re-sent book keeps the id a
 * mid-resume reader is asking for), and two manifest entries with one id would
 * make the merged manifest unresolvable.
 */
async function commitItem(item: OutboxItem): Promise<OutboxItem> {
    return withLock(async () => {
        const existing = await readIndex();
        const kept = existing.filter(entry => entry.id !== item.id);
        // Appended: queue order is oldest-first, so `latest.txt` is the LAST note.
        const { kept: pruned, dropped } = planOutboxPrune([...kept, item]);
        // Never evict the item we were just asked to queue — reporting success
        // for something already deleted is the one outcome with no recovery.
        const finalItems = pruned.some(entry => entry.id === item.id) ? pruned : [...pruned, item];
        await removeBodies(dropped.filter(entry => entry.id !== item.id));
        await writeIndex(finalItems);
        notify(finalItems);
        return item;
    });
}

/**
 * Mark items handed over, then prune under the standard policy.
 *
 * Called from `sync_session` when the proxy reports that the reader took a whole
 * body. Unknown ids are ignored: the queue may have been pruned, or the reader
 * may have pulled something a previous session queued and this one no longer
 * holds.
 */
export async function markDelivered(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const wanted = new Set(ids.filter(id => typeof id === 'string' && id.length > 0));
    if (wanted.size === 0) return;

    await withLock(async () => {
        const items = await readIndex();
        let changed = false;
        const now = Date.now();
        const stamped = items.map(item => {
            if (!wanted.has(item.id) || item.deliveredAt !== undefined) return item;
            changed = true;
            return { ...item, deliveredAt: now };
        });
        if (!changed) return;
        const { kept, dropped } = planOutboxPrune(stamped, { now });
        await removeBodies(dropped);
        await writeIndex(kept);
        notify(kept);
    });
}

/**
 * Drop every queued note but the newest, and report which ids went.
 *
 * ---------------------------------------------------------------------------
 * THE READER HAS ONE NOTE SLOT, AND THE QUEUE PRETENDED OTHERWISE
 * ---------------------------------------------------------------------------
 * Section 1 gives the reader exactly one current note: `latest.txt` is a single
 * id and `current.frame` is the body for that id. Kotlin's local serve honours
 * that — `latestNote()` is the LAST pending note in the manifest and nothing
 * else is ever offered — so a queue holding three notes can deliver one, and the
 * other two are not "waiting", they are unreachable.
 *
 * That was invisible in every direction. The count the user saw ("3 items ready
 * to hand over") included them, the manifest exported them, `books.txt` had
 * nothing to do with them, and a completed handover pruned only the one that was
 * actually taken. The other two stayed pending for the full 30-day age cap,
 * inflating every count and keeping two 52 KB bodies alive, while their History
 * rows sat on whatever the failed send had left there. There was no path by
 * which they could ever leave.
 *
 * So they are dropped, and their ids are RETURNED rather than swallowed: the
 * caller patches History (`markNoteSuperseded`) so the row says what happened
 * instead of claiming forever that the note is on its way. Bodies go with them —
 * they are copies, and nothing can ask for them again.
 *
 * `keepId` names the note to keep when the caller knows it (the one just
 * queued); with no argument the newest pending note wins, which is the same note
 * the native side would have served.
 *
 * Never throws, and returns `[]` when there is at most one pending note — the
 * overwhelmingly common case, and one read of a few hundred bytes to establish.
 */
export async function supersedeQueuedNotes(keepId?: string): Promise<string[]> {
    return withLock(async () => {
        let items: OutboxItem[];
        try {
            items = await readIndex();
        } catch (e) {
            console.warn('[Outbox] Could not read the queue to collapse notes:', e);
            return [];
        }
        const pendingNotes = items.filter(
            item => item.kind === 'note' && item.deliveredAt === undefined
        );
        if (pendingNotes.length <= 1) return [];

        // The caller's choice wins only if it is actually IN the queue; otherwise
        // the newest pending note does, because that is the one the reader would
        // have been offered and dropping it would turn this into data loss.
        const keep =
            typeof keepId === 'string' && pendingNotes.some(item => item.id === keepId)
                ? keepId
                : pendingNotes[pendingNotes.length - 1].id;

        const dropped = pendingNotes.filter(item => item.id !== keep);
        if (dropped.length === 0) return [];
        const droppedIds = new Set(dropped.map(item => item.id));
        const kept = items.filter(item => !droppedIds.has(item.id));

        await removeBodies(dropped);
        await writeIndex(kept);
        notify(kept);
        return dropped.map(item => item.id);
    });
}

/**
 * Drop every queued PRIMARY wallpaper but the newest, and report which ids went.
 *
 * ---------------------------------------------------------------------------
 * THE READER HAS ONE `/sleep.bmp`, EXACTLY AS IT HAS ONE NOTE SLOT
 * ---------------------------------------------------------------------------
 * This is {@link supersedeQueuedNotes}' argument applied to the other
 * single-slot destination, and it is the local half of the server's own
 * retention rule ("a NEW primary supersedes any earlier undelivered primary" —
 * see `mailbox_client`'s wallpaper section). Three queued primaries can only
 * ever end in one picture on the card; the other two are not "waiting", they are
 * a pair of ~419 KB bodies and two wake windows of radio spent to be overwritten.
 *
 * ROTATION ENTRIES ARE UNTOUCHED, and that is the whole reason this is a
 * separate function from the note one rather than a generalisation of it: a
 * `/.sleep` set is a BAG, every entry is a distinct file with its own name, and
 * collapsing it would delete wallpapers the user deliberately added.
 *
 * Ids are RETURNED rather than swallowed so a caller with a UI record for the
 * dropped item can patch it, exactly as the note path patches History.
 *
 * Never throws, and returns `[]` when there is at most one pending primary —
 * the overwhelmingly common case.
 */
export async function supersedeQueuedPrimaryWallpapers(keepId?: string): Promise<string[]> {
    return withLock(async () => {
        let items: OutboxItem[];
        try {
            items = await readIndex();
        } catch (e) {
            console.warn('[Outbox] Could not read the queue to collapse wallpapers:', e);
            return [];
        }
        const pendingPrimaries = items.filter(
            item =>
                item.kind === 'wallpaper' &&
                item.target === 'primary' &&
                item.deliveredAt === undefined
        );
        if (pendingPrimaries.length <= 1) return [];

        // The caller's choice wins only if it is actually IN the queue; otherwise
        // the newest pending primary does, because that is the one the reader
        // would end on and dropping it would turn this into data loss.
        const keep =
            typeof keepId === 'string' && pendingPrimaries.some(item => item.id === keepId)
                ? keepId
                : pendingPrimaries[pendingPrimaries.length - 1].id;

        const dropped = pendingPrimaries.filter(item => item.id !== keep);
        if (dropped.length === 0) return [];
        const droppedIds = new Set(dropped.map(item => item.id));
        const kept = items.filter(item => !droppedIds.has(item.id));

        await removeBodies(dropped);
        await writeIndex(kept);
        notify(kept);
        return dropped.map(item => item.id);
    });
}

/** Apply the prune policy now. Returns how many items were dropped. */
export async function pruneOutbox(opts?: OutboxPrunePolicy): Promise<number> {
    return withLock(async () => {
        const items = await readIndex();
        const { kept, dropped } = planOutboxPrune(items, opts);
        if (dropped.length === 0) return 0;
        await removeBodies(dropped);
        await writeIndex(kept);
        notify(kept);
        return dropped.length;
    });
}

/** Drop one item and its body. Unknown ids are a no-op. */
export async function removeOutboxItem(id: string): Promise<boolean> {
    return withLock(async () => {
        const items = await readIndex();
        const target = items.find(item => item.id === id);
        if (!target) return false;
        const kept = items.filter(item => item.id !== id);
        await removeBodies([target]);
        await writeIndex(kept);
        notify(kept);
        return true;
    });
}

/** Drop everything, bodies included. */
export async function clearOutbox(): Promise<void> {
    await withLock(async () => {
        const items = await readIndex();
        await removeBodies(items);
        const backing = getStore();
        if (backing) {
            try {
                await backing.removeItem(OUTBOX_INDEX_KEY);
            } catch (e) {
                console.warn('[Outbox] Failed to clear index:', e);
            }
        }
        await exportManifest([]);
        notify([]);
    });
}

/**
 * Re-export the manifest and return the path Kotlin should read.
 *
 * '' MEANS "NOTHING TO HAND OVER HERE", not an error — under node, on web, and
 * on any runtime without a document directory there is no file to point at, and
 * the caller (`sync_session`) simply starts the proxy in forward-only mode. This
 * function never throws, because it is on the path of a session the user is
 * standing in front of.
 */
export async function outboxManifestPath(): Promise<string> {
    return withLock(async () => {
        try {
            const items = await readIndex();
            return (await exportManifest(items)) ?? '';
        } catch (e) {
            console.warn('[Outbox] Could not prepare the manifest:', e);
            return '';
        }
    });
}

/**
 * Everything a session needs in one read: where the manifest is, and what is in
 * it. Never throws.
 */
export async function prepareOutboxHandover(): Promise<{
    manifestPath: string;
    summary: OutboxSummary;
}> {
    return withLock(async () => {
        let items: OutboxItem[] = [];
        let manifestPath = '';
        try {
            items = await readIndex();
            manifestPath = (await exportManifest(items)) ?? '';
        } catch (e) {
            console.warn('[Outbox] Could not prepare the handover:', e);
        }
        return { manifestPath, summary: summarizeOutbox(items) };
    });
}
