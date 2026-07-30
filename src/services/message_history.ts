/**
 * message_history — the History tab's store: one row per love note the user
 * composed, with the thumbnail it was sent as.
 *
 * WHY IT EXISTS: a love note is TEMPORARY on the device (dismiss returns the
 * reader to its book) and the frame itself is a 52272-byte 1-bit blob that
 * nothing can render back into a picture. Once a note is dismissed, the phone is
 * the ONLY place any record of it survives — so the send path writes here, and
 * the same rows drive "send that one again".
 *
 * Storage is a single AsyncStorage key holding a newest-first JSON array:
 *   - ONE key, not one per record, so a list render is one read; AsyncStorage
 *     round-trips are the cost that matters on the History tab.
 *   - Every read-modify-write goes through `createLock()`. Two sends finishing
 *     at once, or a send landing while the user deletes a row, are both
 *     read-then-write races on that one key, and the loser silently reverts the
 *     winner's record. The lock is the only thing preventing that.
 *   - Capped at `MAX_MESSAGE_RECORDS`, oldest evicted. The cap is on the STORE,
 *     not the view: thumbnails are base64 and AsyncStorage on Android is one
 *     SQLite row, so an uncapped history grows until reads visibly stall.
 *
 * Anything read back out is treated as untrusted. The blob is unversioned, is
 * written by whatever build shipped last, and can be a truncated write — so a
 * corrupt or half-written blob degrades to an EMPTY list instead of throwing
 * into the History tab's render.
 *
 * AsyncStorage is reached through an injectable seam (see
 * `__setMessageHistoryStore`) so `scripts/message-history.test.js` can cover the
 * ordering / cap / concurrency / recovery logic under node, where the React
 * Native module cannot load.
 */

import { createLock } from '../utils/lock';
import type { LoveNotePath } from './love_note_sender';

/** AsyncStorage key. NEW for the messenger — nothing else reads or writes it. */
export const MESSAGE_HISTORY_KEY = '@messenger/history';

/** Hard cap on stored rows; adding past it evicts the oldest. */
export const MAX_MESSAGE_RECORDS = 100;

export type MessageKind = 'photo' | 'text' | 'doodle';
/**
 * 'superseded' is a TERMINAL NON-DELIVERY, and it is its own value because none
 * of the other three can say it.
 *
 * The reader holds one note at a time (§1: `latest.txt` is a single id), so the
 * moment a newer note is queued or published, every older one that has not
 * already landed is not "pending", "failed" or "sent" — it is finished, and it
 * never reached the panel. Before this existed such a row kept whatever the
 * original attempt left on it, most often 'In mailbox', which is a claim that
 * the note is still coming. It is not, and nothing in the app was ever going to
 * correct it.
 */
export type MessageStatus = 'sent' | 'failed' | 'draft' | 'superseded';

export interface MessageRecord {
    id: string;
    createdAt: number;
    kind: MessageKind;
    status: MessageStatus;
    /**
     * Bare base64 PNG (NO `data:` prefix) — produced by
     * `rgbaToThumbnailBase64` in `preview_png.ts`, wrapped for display by
     * `pngBase64ToDataUri`. Kept small on purpose: see THUMBNAIL_WIDTH there.
     */
    thumbnailPngBase64: string;
    /** Original picture URI, when one exists and is still expected to resolve. */
    sourceUri?: string;
    /** Note text, for 'text' notes and for captions on the others. */
    text?: string;
    /** Failure detail for status 'failed'. */
    error?: string;
    /**
     * Which route actually delivered this note — 'direct' (pushed onto the
     * reader over the LAN, already on the panel) or 'mailbox' (left for the
     * reader to collect at its next deep-sleep entry, so it is NOT showing yet).
     *
     * Without it a 'sent' row is ambiguous in the one way that matters to
     * someone looking at History and then at a reader that shows nothing.
     * Absent on rows written before the mailbox existed, and on failures.
     */
    path?: LoveNotePath;
    /**
     * Mailbox note id, when the mailbox took it.
     *
     * This is the id the reader dedups on (`latest.txt` -> `messageLastShownId`),
     * so it is the ONLY value that can correlate a row here with what the reader
     * eventually displays — the reader reports nothing back.
     */
    noteId?: string;
    /**
     * Whether the reader also got the id the note is dismissed BY.
     *
     * `false` is a DEGRADED SUCCESS, and it is the reason this field exists: a
     * direct send whose frame landed but whose `/.love-notes/current.id` sidecar
     * did not (`sendLoveNoteFrame` -> `{ success: true, idStaged: false }`) puts
     * the note on the panel with nothing for the reader to mark shown, so it
     * re-shows on EVERY wake — precisely the bug the sidecar exists to end. The
     * realistic trigger is the reader falling asleep in the gap between the 52 KB
     * frame and the 21-byte sidecar.
     *
     * Without it a `status: 'sent'` row cannot tell "the reader will dismiss
     * this" from "the reader will re-show it forever", and the fix (re-send) is
     * one the user will never think of unaided.
     *
     * Absent on failures, on mailbox rows written before this field existed, and
     * on any row whose route did not report — never guessed.
     */
    idStaged?: boolean;
}

/**
 * The slice of AsyncStorage this module needs.
 *
 * Declared structurally rather than imported so the module has no top-level
 * React Native dependency: `@react-native-async-storage/async-storage` pulls in
 * `react-native`, which cannot be parsed by node, which would make every test
 * below impossible to write.
 */
export interface MessageHistoryStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

// Module-local declaration: Metro defines `require` inside every module and
// collects `require('<literal>')` wherever it appears, so the lazy load below is
// a normal static dependency in the app bundle. Under node's ESM loader the
// identifier simply does not exist — `typeof` on an undeclared name is safe, and
// the module falls back to "no storage" instead of failing to import.
declare const require: ((id: string) => unknown) | undefined;

let store: MessageHistoryStore | null = null;
let storeResolved = false;

/**
 * Replace the backing store. Pass `null` to restore the AsyncStorage default.
 *
 * TEST SEAM — the app never calls this.
 */
export function __setMessageHistoryStore(next: MessageHistoryStore | null): void {
    store = next;
    storeResolved = next !== null;
}

function getStore(): MessageHistoryStore | null {
    if (!storeResolved) {
        store = loadAsyncStorage();
        storeResolved = true;
    }
    return store;
}

function loadAsyncStorage(): MessageHistoryStore | null {
    if (typeof require !== 'function') return null;
    try {
        const mod = require('@react-native-async-storage/async-storage') as { default?: unknown };
        // Both interop shapes: `exports.default` under Babel's ESM interop, and
        // the module object itself if that ever stops being how it ships.
        for (const candidate of [mod?.default, mod]) {
            if (isStore(candidate)) return candidate;
        }
    } catch {
        // Not a React Native runtime (node test, web preview). Handled below.
    }
    return null;
}

function isStore(value: unknown): value is MessageHistoryStore {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<MessageHistoryStore>;
    return (
        typeof candidate.getItem === 'function' &&
        typeof candidate.setItem === 'function' &&
        typeof candidate.removeItem === 'function'
    );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const withLock = createLock();

/**
 * Append a record and return it, complete with its generated `id`/`createdAt`.
 *
 * The id and timestamp are minted INSIDE the lock so `createdAt` can never
 * disagree with list position when several sends resolve together.
 */
export async function addMessageRecord(
    input: Omit<MessageRecord, 'id' | 'createdAt'>
): Promise<MessageRecord> {
    return withLock(async () => {
        const record: MessageRecord = {
            ...normalizeInput(input),
            id: nextId(),
            createdAt: Date.now(),
        };
        const existing = await readAll();
        await writeAll([record, ...existing].slice(0, MAX_MESSAGE_RECORDS));
        return record;
    });
}

/** Every stored record, newest first. Never throws; a bad blob reads as `[]`. */
export async function listMessageRecords(): Promise<MessageRecord[]> {
    return withLock(readAll);
}

/**
 * Merge `patch` into one record (typically `{ status: 'sent' }` once an upload
 * lands, or `{ status: 'failed', error }` when it does not).
 *
 * `id` and `createdAt` in the patch are IGNORED — identity is assigned at
 * creation, and a patch that could rewrite it would let a retry orphan the row
 * it was meant to update. An unknown id is a no-op, not an error: the row may
 * have been deleted or evicted while the send was in flight.
 *
 * @returns true when a row was found and patched, false when the id is unknown.
 *          The MISS IS LOAD-BEARING, not a courtesy: ComposeScreen holds a
 *          record id for the whole life of a note, and History's delete /
 *          clear-all (or eviction at MAX_MESSAGE_RECORDS) can remove that row
 *          while the note is still on screen. A silent no-op there would let a
 *          note reach the reader and leave NO trace anywhere — the one invariant
 *          this store exists to hold. Callers use `false` to append instead.
 */
export async function updateMessageRecord(
    id: string,
    patch: Partial<MessageRecord>
): Promise<boolean> {
    return withLock(async () => {
        const records = await readAll();
        const index = records.findIndex(r => r.id === id);
        if (index === -1) return false;
        records[index] = applyPatch(records[index], patch);
        await writeAll(records);
        return true;
    });
}

/**
 * Record that the reader took this note STRAIGHT OFF THE PHONE, over the peer
 * link, with no mailbox and no internet involved.
 *
 * Keyed on `noteId` — the mailbox/dedup id — not on the History row id, because
 * the confirmation comes from `sync_session` hours later and by way of the
 * outbox, which knows only that id. The NEWEST matching row wins: a note re-sent
 * under the same id has one row per attempt at most, and the newest is the one
 * the user is looking at.
 *
 * The patch is `{ status: 'sent', path: 'handover' }` and it CLEARS `error`,
 * which is the whole point — the row that said "Reader unreachable; mailbox
 * failed too" is exactly the row this is about to turn into "Delivered
 * directly". `idStaged` is deliberately untouched: the peer link never stages
 * `/.love-notes/current.id` (the reader collects the id from `latest.txt` on
 * this route, same as any mailbox pull), so a `false` left by an earlier DIRECT
 * attempt is not a claim this delivery can correct either way.
 *
 * @returns true when a row was found and patched.
 */
export async function markNoteDeliveredDirectly(noteId: string): Promise<boolean> {
    if (typeof noteId !== 'string' || noteId === '') return false;
    return withLock(async () => {
        const records = await readAll();
        // Newest first in the store, so the first match IS the newest.
        const index = records.findIndex(r => r.noteId === noteId);
        if (index === -1) return false;
        records[index] = applyPatch(records[index], {
            status: 'sent',
            path: 'handover',
            error: undefined,
        });
        await writeAll(records);
        return true;
    });
}

/**
 * Record that a NEWER note has taken this one's place and it will never arrive.
 *
 * Keyed on `noteId` for the same reason {@link markNoteDeliveredDirectly} is:
 * the caller is the outbox, hours or days later, and the mailbox/dedup id is the
 * only identifier the two stores share. The NEWEST matching row wins.
 *
 * REFUSES TO OVERWRITE A DELIVERY, and that is the whole safety property here.
 * A note that actually reached the panel ('direct') or was handed over the peer
 * link ('handover') is done, and relabelling it because a later note was queued
 * would erase the one true record of a successful send. Only rows that are still
 * claiming to be on their way — 'In mailbox', a failed attempt that was parked
 * in the queue — are collapsed, and `error` goes with them: "Reader unreachable"
 * is no longer the reason this note is not on the panel.
 *
 * @returns true when a row was found and patched.
 */
export async function markNoteSuperseded(noteId: string): Promise<boolean> {
    if (typeof noteId !== 'string' || noteId === '') return false;
    return withLock(async () => {
        const records = await readAll();
        // Newest first in the store, so the first match IS the newest.
        const index = records.findIndex(r => r.noteId === noteId);
        if (index === -1) return false;
        const record = records[index];
        if (record.status === 'superseded') return false;
        // Delivered is delivered. See the note above.
        if (record.status === 'sent' && (record.path === 'direct' || record.path === 'handover')) {
            return false;
        }
        records[index] = applyPatch(record, { status: 'superseded', error: undefined });
        await writeAll(records);
        return true;
    });
}

/** Drop one record. Unknown ids are a no-op. */
export async function deleteMessageRecord(id: string): Promise<void> {
    await withLock(async () => {
        const records = await readAll();
        const kept = records.filter(r => r.id !== id);
        if (kept.length === records.length) return;
        await writeAll(kept);
    });
}

/** Drop every record (History tab's "clear all"). */
export async function clearMessageRecords(): Promise<void> {
    await withLock(async () => {
        const backing = getStore();
        if (!backing) return;
        try {
            await backing.removeItem(MESSAGE_HISTORY_KEY);
        } catch (e) {
            console.warn('[MessageHistory] Failed to clear history:', e);
        }
    });
}

// ---------------------------------------------------------------------------
// Storage I/O (callers must already hold the lock)
// ---------------------------------------------------------------------------

async function readAll(): Promise<MessageRecord[]> {
    const backing = getStore();
    if (!backing) return [];

    let raw: string | null;
    try {
        raw = await backing.getItem(MESSAGE_HISTORY_KEY);
    } catch (e) {
        console.warn('[MessageHistory] Failed to read history:', e);
        return [];
    }
    if (!raw) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn('[MessageHistory] History blob is not JSON, starting empty');
        return [];
    }
    if (!Array.isArray(parsed)) {
        console.warn('[MessageHistory] History blob is not an array, starting empty');
        return [];
    }

    const records: MessageRecord[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
        const record = asRecord(entry);
        if (!record || seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
        if (records.length === MAX_MESSAGE_RECORDS) break;
    }
    return records;
}

async function writeAll(records: MessageRecord[]): Promise<void> {
    const backing = getStore();
    if (!backing) {
        console.warn('[MessageHistory] No storage available, record not persisted');
        return;
    }
    try {
        await backing.setItem(MESSAGE_HISTORY_KEY, JSON.stringify(records));
    } catch (e) {
        // Out of quota, or the row got too large. Warn rather than throw: the
        // send itself succeeded, and failing the caller here would report a
        // delivered note as failed.
        console.warn('[MessageHistory] Failed to write history:', e);
    }
}

// ---------------------------------------------------------------------------
// Coercion — everything below treats stored/caller data as unknown
// ---------------------------------------------------------------------------

const KINDS: readonly MessageKind[] = ['photo', 'text', 'doodle'];
const STATUSES: readonly MessageStatus[] = ['sent', 'failed', 'draft', 'superseded'];
/**
 * 'handover' is ADDITIVE, and old-blob compatibility is what makes that safe:
 * `asPath` drops anything it does not recognise, so a build that predates this
 * value reads such a row as "route unknown" (the pre-mailbox wording) rather
 * than refusing the row. The reverse — this build reading an older blob — was
 * always fine, because nothing was removed.
 */
const PATHS: readonly LoveNotePath[] = ['direct', 'mailbox', 'handover'];

/** Optional-string fields, coerced identically on input, read-back and patch. */
const OPTIONAL_TEXT_FIELDS = ['sourceUri', 'text', 'error', 'noteId'] as const;

/**
 * Unrecognised route resolves to `undefined`, never to a guess: a row that
 * claimed 'direct' when it was really left in a mailbox would tell the user the
 * note is already on the panel when it is not.
 */
function asPath(value: unknown): LoveNotePath | undefined {
    return PATHS.includes(value as LoveNotePath) ? (value as LoveNotePath) : undefined;
}

function asKind(value: unknown): MessageKind {
    return KINDS.includes(value as MessageKind) ? (value as MessageKind) : 'photo';
}

/**
 * Unreadable status resolves to 'failed'.
 *
 * Deliberately the pessimistic end of the union: a row wrongly showing 'sent'
 * hides a note that never reached the panel, while a row wrongly showing
 * 'failed' costs one re-send of a temporary frame.
 */
function asStatus(value: unknown): MessageStatus {
    return STATUSES.includes(value as MessageStatus) ? (value as MessageStatus) : 'failed';
}

function asOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A stored/patched tri-state flag, with NO coercion of anything else.
 *
 * Deliberately not truthiness: `idStaged` decides whether History warns that the
 * reader will re-show this note forever, and a stray `0`/`''`/`'false'` read back
 * out of an unversioned blob must land on "unknown" (`undefined`, no claim) — not
 * on a confident `false` that invents a warning, and not on a `true` that hides
 * one.
 */
function asOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** Build a clean record from caller input, dropping unknown/empty fields. */
function normalizeInput(input: Omit<MessageRecord, 'id' | 'createdAt'>): Omit<MessageRecord, 'id' | 'createdAt'> {
    const record: Omit<MessageRecord, 'id' | 'createdAt'> = {
        kind: asKind(input?.kind),
        status: asStatus(input?.status),
        thumbnailPngBase64: typeof input?.thumbnailPngBase64 === 'string' ? input.thumbnailPngBase64 : '',
    };
    for (const key of OPTIONAL_TEXT_FIELDS) {
        const value = asOptionalString(input?.[key]);
        if (value !== undefined) record[key] = value;
    }
    const path = asPath(input?.path);
    if (path !== undefined) record.path = path;
    const idStaged = asOptionalBoolean(input?.idStaged);
    if (idStaged !== undefined) record.idStaged = idStaged;
    return record;
}

/**
 * Narrow one stored entry, or `null` if it cannot be a record at all.
 *
 * Only `id` is structurally required — without it the row cannot be updated or
 * deleted, so it is worthless. Every other field coerces to a definite value:
 * dropping a row because one field drifted would lose the only surviving trace
 * of a note.
 */
function asRecord(value: unknown): MessageRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id === '') return null;

    const record: MessageRecord = {
        id: raw.id,
        createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
        kind: asKind(raw.kind),
        status: asStatus(raw.status),
        thumbnailPngBase64: typeof raw.thumbnailPngBase64 === 'string' ? raw.thumbnailPngBase64 : '',
    };
    for (const key of OPTIONAL_TEXT_FIELDS) {
        const value = asOptionalString(raw[key]);
        if (value !== undefined) record[key] = value;
    }
    const path = asPath(raw.path);
    if (path !== undefined) record.path = path;
    const idStaged = asOptionalBoolean(raw.idStaged);
    if (idStaged !== undefined) record.idStaged = idStaged;
    return record;
}

/**
 * Apply a patch to an existing record.
 *
 * An optional field explicitly present as `undefined` is CLEARED — that is how
 * `{ status: 'sent', error: undefined }` drops the stale failure message off a
 * row that has since gone through.
 */
function applyPatch(record: MessageRecord, patch: Partial<MessageRecord>): MessageRecord {
    const next: MessageRecord = { ...record };
    if (!patch || typeof patch !== 'object') return next;

    if (patch.kind !== undefined) next.kind = asKind(patch.kind);
    if (patch.status !== undefined) next.status = asStatus(patch.status);
    if (typeof patch.thumbnailPngBase64 === 'string') next.thumbnailPngBase64 = patch.thumbnailPngBase64;

    for (const key of OPTIONAL_TEXT_FIELDS) {
        if (!(key in patch)) continue;
        const value = asOptionalString(patch[key]);
        if (value === undefined) delete next[key];
        else next[key] = value;
    }
    // Same present-and-undefined-clears rule: a retry that fell back to the
    // mailbox must not leave the previous attempt's 'direct' on the row.
    if ('path' in patch) {
        const value = asPath(patch.path);
        if (value === undefined) delete next.path;
        else next.path = value;
    }
    // Same rule again, and it is load-bearing for the retry case: a re-send that
    // DID stage its id must clear the previous attempt's `false`, or History goes
    // on warning about a note the reader can now dismiss.
    if ('idStaged' in patch) {
        const value = asOptionalBoolean(patch.idStaged);
        if (value === undefined) delete next.idStaged;
        else next.idStaged = value;
    }
    return next;
}

/**
 * Collision-resistant id without a uuid dependency.
 *
 * Minted under the lock, so the counter alone already separates records made in
 * the same millisecond; the timestamp and random suffix separate them across
 * app launches, where the counter restarts at zero.
 */
let sequence = 0;

function nextId(): string {
    sequence += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return `${Date.now().toString(36)}-${sequence.toString(36)}-${random}`;
}
