/**
 * outbox — the phone's local source for the A3 peer link, and everything that
 * hangs off it.
 *
 * WHY THIS FILE IS THE ONLY PLACE THIS FEATURE IS CHECKED AT ALL
 * ---------------------------------------------------------------------------
 * The point of the outbox is delivery with NO INTERNET ANYWHERE: the reader
 * raises its own AP, the phone serves `latest.txt` / `current.frame` /
 * `books.txt` / `books/{id}` off its own disk, and nothing upstream is involved.
 * Every part of that is invisible from the app — no mailbox request to inspect,
 * no reader ack (the contract has none, §1), and the half that reads the
 * manifest is Kotlin, which is compiled in a different pass and cannot be run
 * here. So the seams that CAN be held are:
 *
 *   - the MANIFEST BYTES, which are a wire format between two halves with no
 *     shared compile step. A key rename here is a silent "the reader found
 *     nothing" on a device, and nothing else in this repo would notice;
 *   - the PRUNE POLICY, because it deletes the user's queued notes and books;
 *   - the DELIVERY RULE, because a false positive deletes a note the reader
 *     never got, and a false negative offers the same note forever;
 *   - the AUTO-ARM, because a failed send that queues nothing is a lost note and
 *     the failure looks identical to a send that queued correctly.
 *
 * Neither AsyncStorage nor expo-file-system can load under node, so both run
 * against the module's injectable seams — the same code path, a Map instead of
 * SQLite and a Map instead of a filesystem.
 *
 * Run:  node --import tsx --test scripts/outbox.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    DEFAULT_MAX_OUTBOX_ITEMS,
    MAX_OUTBOX_BODY_BYTES,
    OUTBOX_INDEX_KEY,
    OUTBOX_MANIFEST_FILENAME,
    OUTBOX_MANIFEST_VERSION,
    __setOutboxFileSystem,
    __setOutboxStore,
    clearOutbox,
    describeOutboxFilenameProblem,
    describeOutboxHandover,
    describeOutboxIdProblem,
    enqueueBook,
    enqueueNote,
    listOutbox,
    markDelivered,
    outboxManifestPath,
    planOutboxPrune,
    prepareOutboxHandover,
    pruneOutbox,
    serializeOutboxManifest,
    subscribeOutbox,
    summarizeOutbox,
    supersedeQueuedNotes,
} from '../src/services/outbox';
import {
    __setLoveNoteTransport,
    LOVE_NOTE_FRAME_BYTES,
    LOVE_NOTE_PATH_LABEL,
    sendLoveNote,
} from '../src/services/love_note_sender';
import {
    __setEpubTransport,
    resolveEpubFilename,
    routeEpubSend,
} from '../src/services/epub_sender';
import {
    __setMessageHistoryStore,
    addMessageRecord,
    listMessageRecords,
    markNoteDeliveredDirectly,
    markNoteSuperseded,
} from '../src/services/message_history';
import { describeStatus } from '../src/services/history_view';
import { buildProxyOptions } from '../src/services/reader_link';
import {
    createSyncSession,
    describeSyncMode,
    describeSyncSession,
    initialSyncSession,
    reduceSyncSession,
} from '../src/services/sync_session';

const DOC = 'file:///data/user/0/app/files/';
const DIR = `${DOC}outbox/`;
const MANIFEST = `${DIR}${OUTBOX_MANIFEST_FILENAME}`;
const BASE = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const SSID = 'CrossPoint-Reader';
const PEER_IP = '192.168.4.2';
const T0 = Date.UTC(2026, 6, 30, 9, 0, 0);

const flush = () => new Promise(resolve => setImmediate(resolve));
const frame = (fill = 0xff) => new Uint8Array(LOVE_NOTE_FRAME_BYTES).fill(fill);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A filesystem that behaves like the CONTRACT the module codes against, not like
 * a stub: `copy` fails on a missing source, `size` answers null for a file that
 * is not there, and `remove` is idempotent. A permissive mock would hide exactly
 * the case this module exists to survive — a picker cache file evicted between
 * the pick and the queue.
 */
function memoryFs({ documentDirectory = DOC } = {}) {
    const files = new Map();
    const dirs = new Set();
    return {
        documentDirectory,
        files,
        dirs,
        async makeDirectory(path) {
            dirs.add(path);
        },
        async writeText(path, text) {
            files.set(path, { text, bytes: Buffer.byteLength(text, 'utf8') });
        },
        async writeBase64(path, base64) {
            files.set(path, { bytes: Buffer.from(base64, 'base64').length });
        },
        async copy(from, to) {
            const src = files.get(from);
            if (!src) throw new Error(`copy: no such file ${from}`);
            files.set(to, { ...src });
        },
        async move(from, to) {
            const src = files.get(from);
            if (!src) throw new Error(`move: no such file ${from}`);
            files.delete(from);
            files.set(to, src);
        },
        async size(path) {
            const file = files.get(path);
            return file ? file.bytes : null;
        },
        async remove(path) {
            files.delete(path);
        },
    };
}

function memoryStore() {
    const map = new Map();
    return {
        map,
        async getItem(key) {
            return map.has(key) ? map.get(key) : null;
        },
        async setItem(key, value) {
            map.set(key, value);
        },
        async removeItem(key) {
            map.delete(key);
        },
    };
}

/** Install fresh seams and return them. Every test starts from an empty queue. */
async function freshOutbox(t, options) {
    const fs = memoryFs(options);
    const store = memoryStore();
    __setOutboxFileSystem(fs);
    __setOutboxStore(store);
    t.after(() => {
        __setOutboxFileSystem(null);
        __setOutboxStore(null);
    });
    return { fs, store };
}

function manifestOf(fs) {
    const file = fs.files.get(MANIFEST);
    return file ? JSON.parse(file.text) : null;
}

/** A reader-link whose events a test drives by hand. */
function fakeLink() {
    const calls = [];
    let listener = null;
    return {
        calls,
        isAvailable: () => true,
        async join(options) {
            calls.push(['join', options]);
        },
        async leave() {
            calls.push(['leave']);
        },
        async startProxy(options) {
            calls.push(['startProxy', options]);
            return { ipv4: PEER_IP, port: 8080 };
        },
        async stopProxy() {
            calls.push(['stopProxy']);
        },
        subscribe(next) {
            listener = next;
            return () => {
                listener = null;
            };
        },
        emit(event) {
            if (listener) listener(event);
        },
        args(name) {
            return calls.filter(c => c[0] === name).map(c => c[1]);
        },
    };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('ids are the mailbox charset, and "." / ".." are refused by name', () => {
    // The id is a URL path segment the reader requests, a manifest key, AND part
    // of a filename on this phone's disk. `..` satisfies the charset and is a
    // traversal in the third use, which is why §2 refuses it explicitly and why
    // this does too.
    assert.equal(describeOutboxIdProblem('abc123-XYZ._~-'), null);
    assert.equal(describeOutboxIdProblem('bk-l9x8k2m01-4f7abc12de'), null);
    assert.notEqual(describeOutboxIdProblem('.'), null);
    assert.notEqual(describeOutboxIdProblem('..'), null);
    assert.notEqual(describeOutboxIdProblem('a/b'), null);
    assert.notEqual(describeOutboxIdProblem('a b'), null);
    assert.notEqual(describeOutboxIdProblem(''), null);
    assert.notEqual(describeOutboxIdProblem(null), null);
    assert.notEqual(describeOutboxIdProblem('x'.repeat(65)), null);
});

test('a filename that cannot ride a books.txt line is REFUSED, never repaired', () => {
    // `books.txt` is line-oriented and `filename` is "rest of line" (§2), so a
    // newline forges an entry. Truncating or substituting instead would produce a
    // name that differs from the one the direct route creates — a second copy of
    // a book the user already sent.
    assert.equal(describeOutboxFilenameProblem('Piranesi.epub'), null);
    assert.notEqual(describeOutboxFilenameProblem('two\nlines.epub'), null);
    assert.notEqual(describeOutboxFilenameProblem('a/b.epub'), null);
    assert.notEqual(describeOutboxFilenameProblem('.hidden.epub'), null);
    assert.notEqual(describeOutboxFilenameProblem('Ünicode.epub'), null);
    assert.notEqual(describeOutboxFilenameProblem(`${'x'.repeat(120)}.epub`), null);
    assert.notEqual(describeOutboxFilenameProblem(''), null);
});

test('the .epub tail is REQUIRED here because Kotlin refuses it silently there', () => {
    // `LocalOutbox.isValidBookFilename` will not serve a name without an `.epub`
    // tail: it DROPS the entry, counted only in `localSkipped`. So a book queued
    // through any path but `queueEpubForHandover` (the only caller that runs
    // `resolveEpubFilename`, and therefore the only one that guarantees the
    // extension) used to be accepted here, written to disk, listed in the
    // manifest, and then invisible to the reader with no error anywhere. Two
    // validators, one predicate — and the refusal happens where a caller can be
    // told about it.
    assert.notEqual(describeOutboxFilenameProblem('Piranesi'), null);
    assert.notEqual(describeOutboxFilenameProblem('Piranesi.txt'), null);
    assert.notEqual(describeOutboxFilenameProblem('Piranesi.epub.txt'), null);
    // Case is not meaningful in the extension; the reader lowercases before it
    // compares, so refusing this would refuse a name Kotlin would have served.
    assert.equal(describeOutboxFilenameProblem('Piranesi.EPUB'), null);
    assert.equal(describeOutboxFilenameProblem('Piranesi.ePub'), null);
});

// ---------------------------------------------------------------------------
// The manifest — a wire format between two halves with no shared compile step
// ---------------------------------------------------------------------------

test('MANIFEST GOLDEN: exact bytes, exact key order, notes carry no filename', () => {
    // Kotlin parses this by hand. A renamed key, a reordered field or a
    // stringified number is a silent "the reader found nothing" on a device, and
    // no other check in this repo can see it — the native half is not compiled
    // here. So the bytes are pinned literally.
    const note = {
        id: 'l9x8k2m01-4f7abc12de',
        kind: 'note',
        bytes: 52272,
        bodyPath: `${DIR}note-l9x8k2m01-4f7abc12de.frame`,
        queuedAt: 1780000000000,
    };
    const book = {
        id: 'bk-l9x8k2m02-99aabbccdd',
        kind: 'book',
        filename: 'The Left Hand of Darkness.epub',
        bytes: 1874233,
        bodyPath: `${DIR}book-bk-l9x8k2m02-99aabbccdd.epub`,
        queuedAt: 1780000000001,
        deliveredAt: 1780000009999,
    };

    assert.equal(
        serializeOutboxManifest([note, book]),
        '{"version":1,"items":[' +
            '{"id":"l9x8k2m01-4f7abc12de","kind":"note","bytes":52272,' +
            '"bodyPath":"file:///data/user/0/app/files/outbox/note-l9x8k2m01-4f7abc12de.frame",' +
            '"queuedAt":1780000000000},' +
            '{"id":"bk-l9x8k2m02-99aabbccdd","kind":"book",' +
            '"filename":"The Left Hand of Darkness.epub","bytes":1874233,' +
            '"bodyPath":"file:///data/user/0/app/files/outbox/book-bk-l9x8k2m02-99aabbccdd.epub",' +
            '"queuedAt":1780000000001,"deliveredAt":1780000009999}]}'
    );

    // The version is a number, not a string: the Kotlin side compares it as an
    // int and a quoted "1" would make every manifest look like an unknown schema.
    assert.equal(JSON.parse(serializeOutboxManifest([])).version, 1);
    assert.equal(OUTBOX_MANIFEST_VERSION, 1);
    assert.deepEqual(JSON.parse(serializeOutboxManifest([])).items, []);
});

test('an empty queue still exports a manifest — "no local items", not "no file"', async t => {
    const { fs } = await freshOutbox(t);
    const path = await outboxManifestPath();
    assert.equal(path, MANIFEST);
    assert.deepEqual(manifestOf(fs), { version: 1, items: [] });
});

test('with no filesystem the manifest path is EMPTY, and nothing throws', async t => {
    // Node, web, and any runtime without a document directory. This is on the
    // critical path of a session the user is standing in front of, so it degrades
    // to a forward-only proxy rather than failing the session.
    __setOutboxFileSystem(null);
    __setOutboxStore(memoryStore());
    t.after(() => {
        __setOutboxFileSystem(null);
        __setOutboxStore(null);
    });
    assert.equal(await outboxManifestPath(), '');
    const prepared = await prepareOutboxHandover();
    assert.equal(prepared.manifestPath, '');
    assert.equal(prepared.summary.pending, 0);
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('a note round-trips: body on disk, index, manifest, oldest-first order', async t => {
    const { fs, store } = await freshOutbox(t);

    const first = await enqueueNote(frame(0xff), 'note-one');
    const second = await enqueueNote(frame(0x00), 'note-two');

    assert.equal(first.kind, 'note');
    assert.equal(first.bytes, LOVE_NOTE_FRAME_BYTES);
    assert.equal(first.bodyPath, `${DIR}note-note-one.frame`);
    // The body is really there and really the right length — `books.txt` and the
    // reader's `Content-Range` check both live or die on this number.
    assert.equal(fs.files.get(first.bodyPath).bytes, LOVE_NOTE_FRAME_BYTES);
    assert.equal(second.bodyPath, `${DIR}note-note-two.frame`);

    const items = await listOutbox();
    // OLDEST FIRST. The whole "latest.txt = the newest note" rule the native side
    // implements is `the last item with kind note`, so this order is load-bearing.
    assert.deepEqual(items.map(i => i.id), ['note-one', 'note-two']);

    // The index and the exported manifest are the SAME serialisation, so they
    // cannot drift into disagreeing about what is queued.
    assert.equal(store.map.get(OUTBOX_INDEX_KEY), serializeOutboxManifest(items));
    assert.deepEqual(manifestOf(fs).items.map(i => i.id), ['note-one', 'note-two']);
    assert.deepEqual(Object.keys(manifestOf(fs).items[0]), [
        'id',
        'kind',
        'bytes',
        'bodyPath',
        'queuedAt',
    ]);
});

test('a book is COPIED and measured from the copy, never trusted from the picker', async t => {
    const { fs } = await freshOutbox(t);
    fs.files.set('file:///cache/pick-1.epub', { bytes: 402118 });

    const item = await enqueueBook('file:///cache/pick-1.epub', 'Piranesi.epub', 'bk-1');
    assert.equal(item.kind, 'book');
    assert.equal(item.filename, 'Piranesi.epub');
    // Measured from the COPY: the picker reports no size at all for most Android
    // SAF picks, and this number is what the reader validates every window
    // against.
    assert.equal(item.bytes, 402118);
    assert.equal(fs.files.get(item.bodyPath).bytes, 402118);

    // Copied, not referenced: the OS is free to evict the picker's cache file,
    // and a manifest entry pointing at a file that has since vanished is a 404 at
    // the exact moment the user is standing next to the reader.
    fs.files.delete('file:///cache/pick-1.epub');
    assert.equal(await fs.size(item.bodyPath), 402118);

    assert.deepEqual(Object.keys(manifestOf(fs).items[0]), [
        'id',
        'kind',
        'filename',
        'bytes',
        'bodyPath',
        'queuedAt',
    ]);
});

test('a body that cannot be measured is REFUSED and its copy cleaned up', async t => {
    const { fs } = await freshOutbox(t);
    fs.files.set('file:///cache/empty.epub', { bytes: 0 });
    await assert.rejects(
        () => enqueueBook('file:///cache/empty.epub', 'Empty.epub', 'bk-empty'),
        /Could not measure/
    );
    // No orphan body, and nothing in the queue: publishing a `books.txt` line
    // whose `bytes` disagrees with the body is the "corrupt_book" case §2 makes
    // the server refuse to serve.
    assert.deepEqual(await listOutbox(), []);
    assert.equal(fs.files.has(`${DIR}book-bk-empty.epub`), false);
});

test('a body over the single-item ceiling is refused, copy and all', async t => {
    const { fs } = await freshOutbox(t);
    fs.files.set('file:///cache/huge.epub', { bytes: MAX_OUTBOX_BODY_BYTES + 1 });
    await assert.rejects(
        () => enqueueBook('file:///cache/huge.epub', 'Huge.epub', 'bk-huge'),
        /too big to hold for handover/
    );
    assert.equal(fs.files.has(`${DIR}book-bk-huge.epub`), false);
    assert.deepEqual(await listOutbox(), []);
});

test('re-queuing an id REPLACES it — one manifest entry, never two', async t => {
    const { fs } = await freshOutbox(t);
    await enqueueNote(frame(), 'note-a');
    await enqueueNote(frame(), 'note-b');
    await enqueueNote(frame(), 'note-a');

    const items = await listOutbox();
    // A retry keeps the reader's dedup id on purpose, and two entries under one
    // id would make the merged manifest unresolvable — the exact failure §2
    // eliminates for the mailbox by replacing same-filename books.
    assert.deepEqual(items.map(i => i.id), ['note-b', 'note-a']);
    assert.equal(manifestOf(fs).items.length, 2);
});

// ---------------------------------------------------------------------------
// Prune policy
// ---------------------------------------------------------------------------

test('planOutboxPrune: delivered goes first, then oldest — never the newest', () => {
    // The item queued thirty seconds ago is the one the user is standing next to
    // the reader for. Evicting it to keep a book from last month would be exactly
    // backwards.
    const item = (id, queuedAt, extra = {}) => ({
        id,
        kind: 'note',
        bytes: 100,
        bodyPath: `/p/${id}`,
        queuedAt,
        ...extra,
    });
    const items = [
        item('old-pending', 1000),
        item('delivered-new', 4000, { deliveredAt: 4500 }),
        item('newest', 5000),
    ];
    const { kept, dropped } = planOutboxPrune(items, { maxItems: 2, now: 5000 });
    assert.deepEqual(dropped.map(i => i.id), ['delivered-new']);
    assert.deepEqual(kept.map(i => i.id), ['old-pending', 'newest']);
    // Queue order survives the eviction — the manifest's "latest is last" rule
    // depends on it.
    assert.deepEqual(kept.map(i => i.queuedAt), [1000, 5000]);
});

test('planOutboxPrune: age, delivered-retention and the byte ceiling all bite', () => {
    const base = {
        kind: 'book',
        filename: 'x.epub',
        bodyPath: '/p',
        bytes: 10,
    };
    // A REAL epoch, not a small integer: `queuedAt` is a wall-clock timestamp and
    // the age rule deliberately skips rows whose timestamp did not survive the
    // store (`queuedAt <= 0`), so a toy clock would make 'ancient' look corrupt
    // rather than old.
    const now = T0;
    const { kept } = planOutboxPrune(
        [
            { ...base, id: 'ancient', queuedAt: now - 40 * 24 * 60 * 60 * 1000 },
            { ...base, id: 'settled', queuedAt: now - 1000, deliveredAt: now - 90_000 },
            { ...base, id: 'fresh', queuedAt: now - 1000 },
        ],
        { now, maxAgeMs: 30 * 24 * 60 * 60 * 1000, deliveredRetentionMs: 60_000 }
    );
    assert.deepEqual(kept.map(i => i.id), ['fresh']);

    // The byte ceiling evicts too, and it counts only what survives.
    const big = (id, bytes, queuedAt) => ({ ...base, id, bytes, queuedAt });
    const byBytes = planOutboxPrune([big('a', 60, now - 2), big('b', 60, now - 1)], {
        now,
        maxBytes: 100,
    });
    assert.deepEqual(byBytes.kept.map(i => i.id), ['b']);
    assert.deepEqual(byBytes.dropped.map(i => i.id), ['a']);
});

test('the cap evicts bodies from disk, not just rows from the index', async t => {
    const { fs } = await freshOutbox(t);
    for (let i = 0; i < DEFAULT_MAX_OUTBOX_ITEMS + 3; i++) {
        await enqueueNote(frame(), `note-${i}`);
    }
    const items = await listOutbox();
    assert.equal(items.length, DEFAULT_MAX_OUTBOX_ITEMS);
    // The item just queued is never the one evicted.
    assert.equal(items[items.length - 1].id, `note-${DEFAULT_MAX_OUTBOX_ITEMS + 2}`);
    // A row dropped with its body left behind is a disk leak nothing ever
    // collects: no index entry names the file, so nothing can delete it later.
    assert.equal(fs.files.has(`${DIR}note-note-0.frame`), false);
    assert.equal(fs.files.has(`${DIR}note-note-1.frame`), false);
});

test('pruneOutbox reports what it dropped and leaves the rest alone', async t => {
    const { fs } = await freshOutbox(t);
    await enqueueNote(frame(), 'keep-me');
    await enqueueNote(frame(), 'drop-me');
    // Age zero prunes everything that has a timestamp at all.
    assert.equal(await pruneOutbox({ maxAgeMs: 0 }), 2);
    assert.deepEqual(await listOutbox(), []);
    assert.deepEqual(manifestOf(fs), { version: 1, items: [] });
    assert.equal(await pruneOutbox(), 0);
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test('markDelivered stamps, keeps the item inside the grace window, then prunes it', async t => {
    const { fs } = await freshOutbox(t);
    await enqueueNote(frame(), 'note-x');
    fs.files.set('file:///cache/b.epub', { bytes: 1234 });
    await enqueueBook('file:///cache/b.epub', 'B.epub', 'bk-x');

    await markDelivered(['note-x']);
    const items = await listOutbox();
    const delivered = items.find(i => i.id === 'note-x');
    assert.equal(typeof delivered.deliveredAt, 'number');
    // KEPT, not deleted on the spot. The proxy knows the last byte left the
    // socket; it does not know the reader's staging survived the write, and a day
    // of grace makes a re-pull free.
    assert.equal(fs.files.has(delivered.bodyPath), true);
    // It is out of the pending count, which is what the surfaces show.
    assert.equal(summarizeOutbox(items).pending, 1);
    assert.equal(summarizeOutbox(items).delivered, 1);

    // Past the retention window it goes, body and all.
    assert.equal(await pruneOutbox({ deliveredRetentionMs: 0 }), 1);
    assert.deepEqual((await listOutbox()).map(i => i.id), ['bk-x']);
    assert.equal(fs.files.has(`${DIR}note-note-x.frame`), false);
});

test('markDelivered ignores unknown ids and does not re-stamp a delivered item', async t => {
    await freshOutbox(t);
    await enqueueNote(frame(), 'note-y');
    await markDelivered(['note-y']);
    const first = (await listOutbox())[0].deliveredAt;
    await markDelivered(['note-y', 'never-queued']);
    assert.equal((await listOutbox())[0].deliveredAt, first);
    assert.equal((await listOutbox()).length, 1);
});

test('subscribers see every mutation — that is how a screen learns a send queued', async t => {
    await freshOutbox(t);
    const seen = [];
    const off = subscribeOutbox(items => seen.push(items.map(i => i.id)));
    t.after(off);

    await enqueueNote(frame(), 'note-1');
    await enqueueNote(frame(), 'note-2');
    await markDelivered(['note-1']);
    await clearOutbox();

    assert.deepEqual(seen[0], ['note-1']);
    assert.deepEqual(seen[1], ['note-1', 'note-2']);
    assert.deepEqual(seen[seen.length - 1], []);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('the handover line claims "no internet needed" ONLY when something is queued', () => {
    assert.equal(describeOutboxHandover(summarizeOutbox([])), null);
    const item = (id, kind) => ({ id, kind, bytes: 1, bodyPath: `/p/${id}`, queuedAt: 1 });
    assert.equal(
        describeOutboxHandover(summarizeOutbox([item('a', 'note')])),
        '1 item ready to hand over — no internet needed.'
    );
    assert.equal(
        describeOutboxHandover(summarizeOutbox([item('a', 'note'), item('b', 'book')])),
        '2 items ready to hand over — no internet needed.'
    );
    // Delivered items are not "ready": counting them would advertise a handover
    // that has already happened.
    assert.equal(
        describeOutboxHandover(
            summarizeOutbox([{ ...item('a', 'note'), deliveredAt: 2 }])
        ),
        null
    );
});

// ---------------------------------------------------------------------------
// Auto-arm: a failed send must not be a lost note
// ---------------------------------------------------------------------------

test('a love note that reaches NOTHING is parked for handover, with its id kept', async t => {
    const { fs } = await freshOutbox(t);
    // No transport and no mailbox: the reader is asleep and the phone has no
    // route. This is the exact situation the whole feature exists for.
    __setLoveNoteTransport(null);

    const result = await sendLoveNote({ role: 'host', ip: '192.168.1.50' }, frame());
    assert.equal(result.success, false);
    assert.equal(typeof result.queuedId, 'string');

    const items = await listOutbox();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, result.queuedId);
    assert.equal(items[0].kind, 'note');
    assert.equal(items[0].bytes, LOVE_NOTE_FRAME_BYTES);
    assert.equal(fs.files.get(items[0].bodyPath).bytes, LOVE_NOTE_FRAME_BYTES);
});

test('RETRYING a failed send replaces the queued copy instead of stacking one', async t => {
    // ComposeScreen mints ONE handover id per note and passes it on every attempt
    // (`handoverIdRef`), because on a total failure — a client with no mailbox, or
    // a publish that died before an id was minted — `result.noteId` is undefined
    // and the queue would otherwise mint a fresh id per attempt, which
    // `commitItem`'s replace-on-same-id can never collapse.
    //
    // This is worst exactly where the feature matters: in airplane mode EVERY
    // send fails, so each tap of "try again" costs another 52272-byte body and
    // another slot against DEFAULT_MAX_OUTBOX_ITEMS, evicting real books — and
    // once the newest copy is handed over, the next session offers the previous
    // duplicate and the reader re-displays the same note, once per session, until
    // the copies drain.
    const { fs } = await freshOutbox(t);
    __setLoveNoteTransport(null);

    const noteId = 'retry-one-id';
    const first = await sendLoveNote({ role: 'host', ip: '1.2.3.4' }, frame(), undefined, { noteId });
    const second = await sendLoveNote({ role: 'host', ip: '1.2.3.4' }, frame(), undefined, { noteId });
    assert.equal(first.success, false);
    assert.equal(second.success, false);
    assert.equal(first.queuedId, noteId);
    assert.equal(second.queuedId, noteId);

    const items = await listOutbox();
    assert.equal(items.length, 1, 'two failed attempts at one note must leave ONE queue entry');
    assert.equal(items[0].id, noteId);
    // And one body on disk, not two: the copies are what eat the disk cap.
    const bodies = [...fs.files.keys()].filter(path => path.endsWith('.frame'));
    assert.equal(bodies.length, 1);

    // Without the shared id every attempt mints a FRESH one, and `commitItem`'s
    // replace-on-same-id can never collapse them.
    //
    // The queue no longer ends up holding the pile — the reader has one note slot
    // (§1), so queuing the newest note retires every older pending one, and that
    // is now what keeps the disk cap and the item cap honest. But the ids still
    // churn, and THAT is what the shared id is for and why this test stays: the
    // reader dedups on the id, so a note that eventually arrives by both the
    // mailbox and the handover is shown once rather than twice.
    const third = await sendLoveNote({ role: 'host', ip: '1.2.3.4' }, frame());
    const fourth = await sendLoveNote({ role: 'host', ip: '1.2.3.4' }, frame());
    assert.notEqual(third.queuedId, fourth.queuedId);
    const remaining = await listOutbox();
    assert.equal(remaining.length, 1, 'only the newest note is deliverable, so only it is kept');
    assert.equal(remaining[0].id, fourth.queuedId);
    const remainingBodies = [...fs.files.keys()].filter(path => path.endsWith('.frame'));
    assert.equal(remainingBodies.length, 1, 'a retired note takes its 52 KB body with it');
});

test('queueing is opt-out, and a wrong-sized frame is never queued', async t => {
    await freshOutbox(t);
    __setLoveNoteTransport(null);

    const optedOut = await sendLoveNote({ role: 'host', ip: '1.2.3.4' }, frame(), undefined, {
        queueOnFailure: false,
    });
    assert.equal(optedOut.success, false);
    assert.equal('queuedId' in optedOut, false);
    assert.deepEqual(await listOutbox(), []);

    // A frame of the wrong size fails the same way on every route, and queuing it
    // would park bytes the reader can only ever render as garbage.
    const wrongSize = await sendLoveNote({ role: 'host', ip: '1.2.3.4' }, new Uint8Array(10));
    assert.equal(wrongSize.success, false);
    assert.equal('queuedId' in wrongSize, false);
    assert.deepEqual(await listOutbox(), []);
});

test('a book that reaches nothing is parked, copied, under the name both routes use', async t => {
    const { fs } = await freshOutbox(t);
    __setEpubTransport(null);
    fs.files.set('file:///cache/pick.epub', { bytes: 999 });

    const result = await routeEpubSend(
        { role: 'host', ip: '192.168.1.50' },
        'file:///cache/pick.epub',
        'Some Book.epub'
    );
    assert.equal(result.success, false);
    assert.equal(typeof result.queuedId, 'string');

    const items = await listOutbox();
    assert.equal(items.length, 1);
    // The SAME name-resolution pipeline both routes use, asserted against that
    // function rather than a literal — a queued book that landed under a
    // different name would become a second copy the next time the direct route
    // ran, and the firmware-driven rules (lowercase `.epub`, no leading dot, the
    // collision hash) live in exactly one place.
    assert.equal(items[0].filename, resolveEpubFilename('Some Book.epub'));
    assert.match(items[0].filename, /\.epub$/);
    assert.equal(items[0].bytes, 999);
});

// ---------------------------------------------------------------------------
// History: 'Delivered directly'
// ---------------------------------------------------------------------------

test('a handover flips the History row from failed to Delivered directly', async t => {
    __setMessageHistoryStore(memoryStore());
    t.after(() => __setMessageHistoryStore(null));

    await addMessageRecord({
        kind: 'photo',
        status: 'failed',
        thumbnailPngBase64: '',
        error: 'Reader unreachable; mailbox failed too',
        noteId: 'note-handed',
    });

    assert.equal(await markNoteDeliveredDirectly('note-handed'), true);
    const [row] = await listMessageRecords();
    assert.equal(row.status, 'sent');
    assert.equal(row.path, 'handover');
    // The stale failure text is CLEARED, not left sitting under a success pill.
    assert.equal(row.error, undefined);
    assert.equal(describeStatus(row.status, row.path, row.idStaged), 'Delivered directly');

    // Unknown ids are a no-op: the row may have been deleted or evicted while the
    // note sat in the queue.
    assert.equal(await markNoteDeliveredDirectly('never-sent'), false);
    assert.equal(await markNoteDeliveredDirectly(''), false);
});

test("old blobs still read, and 'handover' never invents the repeats warning", async t => {
    __setMessageHistoryStore(memoryStore());
    t.after(() => __setMessageHistoryStore(null));

    // Everything History said before this feature existed still says it.
    assert.equal(describeStatus('sent'), 'Sent');
    assert.equal(describeStatus('sent', 'direct'), 'Sent');
    assert.equal(describeStatus('sent', 'mailbox'), 'In mailbox');
    assert.equal(describeStatus('sent', 'direct', false), 'Sent · repeats');
    assert.equal(describeStatus('failed', 'handover'), 'Failed');
    // The peer link stages no `current.id` sidecar — the reader reads the id from
    // the manifest, exactly as it does on any mailbox pull — so a stale `false`
    // from an earlier DIRECT attempt must not turn this row into a warning about
    // a note that will repeat forever.
    assert.equal(describeStatus('sent', 'handover', false), 'Delivered directly');

    assert.equal(LOVE_NOTE_PATH_LABEL.handover, 'Delivered directly');
    assert.equal(LOVE_NOTE_PATH_LABEL.direct, 'Delivered');
    assert.equal(LOVE_NOTE_PATH_LABEL.mailbox, 'On its way');
});

// ---------------------------------------------------------------------------
// sync_session: mode, and the one delivery signal that exists
// ---------------------------------------------------------------------------

test('the session starts in "unknown" mode and never guesses', () => {
    const session = initialSyncSession();
    assert.equal(session.mode, 'unknown');
    assert.equal(session.localItems, 0);
    assert.equal(session.localServed, 0);
    assert.deepEqual(session.delivered, []);
    // A dev client whose Kotlin predates local serve emits no mode at all.
    // Rendering that as "forwarding to the mailbox" would be a claim about the
    // user's data plan that nothing checked.
    assert.equal(describeSyncMode(session), null);
});

test('mode is reported by native, and inferred from answer sources when it is not', () => {
    const start = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    const proxying = reduceSyncSession(start, {
        type: 'proxy',
        at: T0 + 1,
        event: { kind: 'proxy', state: 'listening', ipv4: PEER_IP, port: 8080 },
    });

    const told = reduceSyncSession(proxying, {
        type: 'mode',
        at: T0 + 2,
        event: { kind: 'mode', mode: 'local', localItems: 3 },
    });
    assert.equal(told.mode, 'local');
    assert.equal(told.localItems, 3);
    assert.equal(describeSyncMode(told), 'Serving from this phone — no internet needed.');

    // With no mode event, the per-request source tells the same story.
    const served = reduceSyncSession(proxying, {
        type: 'activity',
        at: T0 + 3,
        event: { kind: 'activity', method: 'GET', path: '/m/b/books.txt', status: 200, source: 'local' },
    });
    assert.equal(served.mode, 'local');
    assert.equal(served.localServed, 1);

    // Both sides in one session is 'merged', and it STAYS merged — a session that
    // forwarded a book and then served a note off disk did both, and flipping back
    // on the next request would make the line flicker between two partial truths.
    const merged = reduceSyncSession(served, {
        type: 'activity',
        at: T0 + 4,
        event: { kind: 'activity', method: 'GET', path: '/m/b/books/1', status: 206, source: 'upstream' },
    });
    assert.equal(merged.mode, 'merged');
    assert.equal(merged.localServed, 1);
    const stillMerged = reduceSyncSession(merged, {
        type: 'activity',
        at: T0 + 5,
        event: { kind: 'activity', method: 'GET', path: '/m/b/latest.txt', status: 200, source: 'local' },
    });
    assert.equal(stillMerged.mode, 'merged');
    assert.equal(describeSyncMode(stillMerged), 'Serving from this phone and the mailbox together.');
});

test("'none' is answered honestly and is NOT an error state", () => {
    const start = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    const proxying = reduceSyncSession(start, {
        type: 'proxy',
        at: T0 + 1,
        event: { kind: 'proxy', state: 'listening', ipv4: PEER_IP, port: 8080 },
    });
    const nothing = reduceSyncSession(proxying, {
        type: 'mode',
        at: T0 + 2,
        event: { kind: 'mode', mode: 'none', localItems: 0 },
    });
    // The state machine stays healthy: the contract is answered with an empty
    // latest.txt and an empty books.txt, so the reader says "nothing new" and
    // goes back to sleep. Reporting a failure would send the user hunting for a
    // problem that is not there.
    assert.equal(nothing.state, 'proxying');
    assert.match(describeSyncMode(nothing), /nothing new/);
});

test('ONLY an explicit complete+local+itemId counts as delivered', () => {
    const proxying = reduceSyncSession(
        reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID }),
        {
            type: 'proxy',
            at: T0 + 1,
            event: { kind: 'proxy', state: 'listening', ipv4: PEER_IP, port: 8080 },
        }
    );
    const act = (session, event) =>
        reduceSyncSession(session, { type: 'activity', at: T0 + 2, event: { kind: 'activity', method: 'GET', path: '/p', status: 200, ...event } });

    // A false positive DELETES a note the reader never got, so every near-miss
    // has to leave the queue untouched.
    assert.deepEqual(act(proxying, { source: 'local', itemId: 'x' }).delivered, []);
    assert.deepEqual(act(proxying, { source: 'local', itemId: 'x', complete: false }).delivered, []);
    assert.deepEqual(act(proxying, { source: 'upstream', itemId: 'x', complete: true }).delivered, []);
    assert.deepEqual(act(proxying, { source: 'local', complete: true }).delivered, []);
    assert.deepEqual(act(proxying, { source: 'local', itemId: 'x', complete: true }).delivered, ['x']);

    // And it is recorded once, however many windows report it.
    const once = act(proxying, { source: 'local', itemId: 'x', complete: true });
    assert.deepEqual(act(once, { source: 'local', itemId: 'x', complete: true }).delivered, ['x']);
});

test('a LOCAL-ONLY session: manifest handed down, item served, queue and History updated', async t => {
    const link = fakeLink();
    const markedDelivered = [];
    const historyPatched = [];
    let clock = T0;

    const controller = createSyncSession({
        link,
        now: () => clock,
        outbox: {
            async prepare() {
                return { manifestPath: MANIFEST, pending: 2 };
            },
            async markDelivered(ids) {
                markedDelivered.push(...ids);
            },
        },
        history: {
            async markDeliveredDirectly(noteId) {
                historyPatched.push(noteId);
                return true;
            },
        },
    });
    t.after(() => controller.dispose());

    await controller.start({ ssid: SSID, mailboxUrl: BASE });
    link.emit({ kind: 'link', state: 'joined', ipv4: PEER_IP });
    await flush();

    // The manifest PATH went down, not the bodies: a 24 MiB book crossing the JS
    // bridge is the OOM shape this design exists to avoid.
    const [proxyArgs] = link.args('startProxy');
    assert.equal(proxyArgs.outboxManifestPath, MANIFEST);
    assert.equal(JSON.stringify(proxyArgs).includes('bodyPath'), false);
    assert.equal(controller.getSession().localItems, 2);

    clock = T0 + 1000;
    link.emit({ kind: 'mode', mode: 'local', localItems: 2 });
    link.emit({
        kind: 'activity',
        method: 'GET',
        path: '/m/box/current.frame',
        status: 200,
        bytes: 52272,
        source: 'local',
        itemId: 'note-handed',
        complete: true,
    });
    await flush();

    const session = controller.getSession();
    assert.equal(session.mode, 'local');
    assert.equal(session.localServed, 1);
    assert.deepEqual(session.delivered, ['note-handed']);
    // The receipt reached BOTH stores: the queue prunes it, and History stops
    // calling it a failure.
    assert.deepEqual(markedDelivered, ['note-handed']);
    assert.deepEqual(historyPatched, ['note-handed']);

    // The ended line leads with the delivery, because it is the strongest true
    // statement this feature can make.
    clock = T0 + 2000;
    await controller.stop();
    assert.match(describeSyncSession(controller.getSession()), /Handed over 1 item/);
});

test('an EMPTY queue starts the proxy exactly as it did before local serve', async t => {
    const link = fakeLink();
    const controller = createSyncSession({
        link,
        now: () => T0,
        outbox: {
            async prepare() {
                return { manifestPath: '', pending: 0 };
            },
            async markDelivered() {},
        },
        history: { async markDeliveredDirectly() { return false; } },
    });
    t.after(() => controller.dispose());

    await controller.start({ ssid: SSID, mailboxUrl: BASE });
    link.emit({ kind: 'link', state: 'joined', ipv4: PEER_IP });
    await flush();

    const [proxyArgs] = link.args('startProxy');
    // The key is ABSENT, not empty. This object's absences are its security
    // property, and "always present, sometimes empty" would make a forward-only
    // session indistinguishable from a mis-wired local one on the native side.
    assert.equal('outboxManifestPath' in proxyArgs, false);
    assert.deepEqual(
        Object.keys(buildProxyOptions(BASE).options).sort(),
        ['allowedPathPrefix', 'healthPath', 'mailboxOrigin', 'port', 'sessionMaxMs']
    );
    assert.equal(controller.getSession().localItems, 0);
});

test('an outbox that cannot be read degrades to forward-only, never to a failed session', async t => {
    const link = fakeLink();
    const controller = createSyncSession({
        link,
        now: () => T0,
        outbox: {
            async prepare() {
                throw new Error('storage is on fire');
            },
            async markDelivered() {},
        },
        history: { async markDeliveredDirectly() { return false; } },
    });
    t.after(() => controller.dispose());

    await controller.start({ ssid: SSID, mailboxUrl: BASE });
    link.emit({ kind: 'link', state: 'joined', ipv4: PEER_IP });
    await flush();

    // The session came up. A queue the phone cannot read is one missed handover,
    // not a reason to refuse the reader the mailbox it CAN still reach.
    assert.equal(controller.getSession().state, 'proxying');
    assert.equal('outboxManifestPath' in link.args('startProxy')[0], false);
});

test('a native marking failure never tears down a live link', async t => {
    const link = fakeLink();
    const controller = createSyncSession({
        link,
        now: () => T0,
        outbox: {
            async prepare() {
                return { manifestPath: MANIFEST, pending: 1 };
            },
            async markDelivered() {
                throw new Error('AsyncStorage exploded');
            },
        },
        history: {
            async markDeliveredDirectly() {
                throw new Error('history exploded');
            },
        },
    });
    t.after(() => controller.dispose());

    await controller.start({ ssid: SSID, mailboxUrl: BASE });
    link.emit({ kind: 'link', state: 'joined', ipv4: PEER_IP });
    await flush();
    link.emit({
        kind: 'activity',
        method: 'GET',
        path: '/m/box/books/bk-1',
        status: 206,
        bytes: 4096,
        source: 'local',
        itemId: 'bk-1',
        complete: true,
    });
    await flush();

    // The session is what the user sees, and it is still serving. The persistence
    // failure costs one redundant re-serve next session and nothing else.
    assert.equal(controller.getSession().state, 'proxying');
    assert.deepEqual(controller.getSession().delivered, ['bk-1']);
});

test('the end-to-end wiring: the real outbox arms the real session port', async t => {
    const { fs } = await freshOutbox(t);
    await enqueueNote(frame(), 'note-live');

    const link = fakeLink();
    // NO outbox/history overrides: this is the app's own default port, which is
    // the one thing an injected fake can never prove works.
    const controller = createSyncSession({ link, now: () => T0 });
    t.after(() => controller.dispose());

    await controller.start({ ssid: SSID, mailboxUrl: BASE });
    link.emit({ kind: 'link', state: 'joined', ipv4: PEER_IP });
    await flush();

    const [proxyArgs] = link.args('startProxy');
    assert.equal(proxyArgs.outboxManifestPath, MANIFEST);
    assert.equal(controller.getSession().localItems, 1);
    // And the file the native side is being pointed at really names the item.
    assert.deepEqual(manifestOf(fs).items.map(i => i.id), ['note-live']);

    link.emit({
        kind: 'activity',
        method: 'GET',
        path: '/m/box/current.frame',
        status: 200,
        bytes: LOVE_NOTE_FRAME_BYTES,
        source: 'local',
        itemId: 'note-live',
        complete: true,
    });
    await flush();

    const [stored] = await listOutbox();
    assert.equal(typeof stored.deliveredAt, 'number');
});

// ---------------------------------------------------------------------------
// ONE NOTE SLOT — the queue used to promise deliveries it could never make
//
// §1 gives the reader a single current note: `latest.txt` is one id and
// `current.frame` is that id's body. Kotlin's local serve honours it (the LAST
// pending note wins and nothing else is ever offered), so of N queued notes
// exactly one is deliverable and the rest are not "waiting" — they are stuck,
// counted in "N items ready to hand over", exported in the manifest, holding
// 52 KB each, until the 30-day age cap eventually collects them.
// ---------------------------------------------------------------------------

test('queuing a second note retires the first, bodies and all', async t => {
    const { fs } = await freshOutbox(t);
    await enqueueNote(frame(0xff), 'note-old');
    await enqueueNote(frame(0x00), 'note-new');

    const retired = await supersedeQueuedNotes();
    assert.deepEqual(retired, ['note-old']);

    // The queue now says exactly what it can do, which is the whole point: the
    // count the user reads and the manifest the reader is offered agree.
    assert.deepEqual((await listOutbox()).map(i => i.id), ['note-new']);
    assert.deepEqual(manifestOf(fs).items.map(i => i.id), ['note-new']);
    assert.equal(summarizeOutbox(await listOutbox()).pending, 1);
    // The body is a copy and nothing can ask for it again.
    assert.equal(fs.files.has(`${DIR}note-note-old.frame`), false);
    assert.equal(fs.files.has(`${DIR}note-note-new.frame`), true);
});

test('the collapse spares BOOKS and anything already delivered', async t => {
    const { fs } = await freshOutbox(t);
    fs.files.set('file:///cache/a.epub', { bytes: 1111 });
    fs.files.set('file:///cache/b.epub', { bytes: 2222 });
    await enqueueNote(frame(), 'note-1');
    await enqueueBook('file:///cache/a.epub', 'A.epub', 'bk-1');
    await enqueueNote(frame(), 'note-2');
    await enqueueBook('file:///cache/b.epub', 'B.epub', 'bk-2');
    await enqueueNote(frame(), 'note-3');

    // Books are NOT single-slot: `books.txt` lists up to MAX_BOOKS and the reader
    // downloads every id it names, so nothing about a newer note retires one.
    assert.deepEqual(await supersedeQueuedNotes(), ['note-1', 'note-2']);
    assert.deepEqual((await listOutbox()).map(i => i.id), ['bk-1', 'bk-2', 'note-3']);

    // A delivered note is not pending, so it is neither a candidate to drop nor
    // the one that gets kept — it stays servable for its retention window.
    await markDelivered(['note-3']);
    await enqueueNote(frame(), 'note-4');
    assert.deepEqual(await supersedeQueuedNotes(), []);
    assert.ok((await listOutbox()).some(i => i.id === 'note-3'));
});

test('a single queued note is left completely alone', async t => {
    await freshOutbox(t);
    await enqueueNote(frame(), 'note-only');
    assert.deepEqual(await supersedeQueuedNotes(), []);
    assert.deepEqual(await supersedeQueuedNotes('note-only'), []);
    assert.deepEqual((await listOutbox()).map(i => i.id), ['note-only']);
});

test('keepId is honoured, and IGNORED when it names nothing in the queue', async t => {
    await freshOutbox(t);
    await enqueueNote(frame(), 'note-a');
    await enqueueNote(frame(), 'note-b');
    // The caller's choice wins...
    assert.deepEqual(await supersedeQueuedNotes('note-a'), ['note-b']);

    await enqueueNote(frame(), 'note-c');
    // ...but a keepId that is not in the queue must never drop everything. The
    // newest pending note is what the reader would have been served, so it is
    // what survives.
    assert.deepEqual(await supersedeQueuedNotes('note-ghost'), ['note-a']);
    assert.deepEqual((await listOutbox()).map(i => i.id), ['note-c']);
});

test('a retired note stops claiming in History that it is on its way', async t => {
    await freshOutbox(t);
    __setMessageHistoryStore(memoryStore());
    t.after(() => __setMessageHistoryStore(null));

    // The exact row the incident produced: a note the mailbox accepted, which the
    // reader will now never see because a newer one took the slot.
    await addMessageRecord({
        kind: 'photo',
        status: 'sent',
        path: 'mailbox',
        noteId: 'note-old',
        thumbnailPngBase64: '',
    });
    assert.equal(describeStatus('sent', 'mailbox'), 'In mailbox');

    await enqueueNote(frame(), 'note-old');
    await enqueueNote(frame(), 'note-new');
    for (const id of await supersedeQueuedNotes()) await markNoteSuperseded(id);

    const [row] = await listMessageRecords();
    assert.equal(row.status, 'superseded');
    assert.equal(describeStatus(row.status, row.path), 'Replaced by a newer note');
});

test('a note the reader actually took is NEVER relabelled', async t => {
    await freshOutbox(t);
    __setMessageHistoryStore(memoryStore());
    t.after(() => __setMessageHistoryStore(null));

    await addMessageRecord({
        kind: 'text',
        status: 'sent',
        path: 'handover',
        noteId: 'note-landed',
        thumbnailPngBase64: '',
    });
    // Delivered is delivered: relabelling it because a later note was queued
    // would erase the only record that a send ever worked.
    assert.equal(await markNoteSuperseded('note-landed'), false);
    assert.equal((await listMessageRecords())[0].status, 'sent');

    await addMessageRecord({
        kind: 'text',
        status: 'sent',
        path: 'direct',
        noteId: 'note-onpanel',
        thumbnailPngBase64: '',
    });
    assert.equal(await markNoteSuperseded('note-onpanel'), false);
    // An unknown id is a no-op rather than an error — the row may be long evicted.
    assert.equal(await markNoteSuperseded('note-never-seen'), false);
});

test('the session collapses the note queue before it arms the handover', async t => {
    const { fs } = await freshOutbox(t);
    __setMessageHistoryStore(memoryStore());
    t.after(() => __setMessageHistoryStore(null));
    await addMessageRecord({
        kind: 'photo',
        status: 'failed',
        error: 'Reader unreachable; mailbox failed too',
        path: 'mailbox',
        noteId: 'note-stale',
        thumbnailPngBase64: '',
    });
    await enqueueNote(frame(), 'note-stale');
    await enqueueNote(frame(), 'note-fresh');

    const link = fakeLink();
    // The app's OWN default outbox port, which is where the collapse lives.
    const controller = createSyncSession({ link, now: () => T0 });
    t.after(() => controller.dispose());
    await controller.start({ ssid: SSID, mailboxUrl: BASE });
    link.emit({ kind: 'link', state: 'joined', ipv4: PEER_IP });
    await flush();
    await flush();

    // What the reader is offered, and what the user is told is coming, are the
    // one note that can actually be delivered.
    assert.deepEqual(manifestOf(fs).items.map(i => i.id), ['note-fresh']);
    assert.equal(controller.getSession().localItems, 1);
    const [row] = await listMessageRecords();
    assert.equal(row.status, 'superseded');
    // And the stale failure text goes with it — that is not why this note is not
    // on the panel any more.
    assert.equal(row.error, undefined);
});
