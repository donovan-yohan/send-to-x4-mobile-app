/**
 * message_history — ordering, the store cap, the write lock, and recovery from
 * a blob written by some other build.
 *
 * The device keeps NO copy of a love note (the frame is temporary, and 1-bit
 * packed besides), so this store is the only surviving record of what was sent.
 * The failures that matter are therefore all silent ones: a concurrent send
 * dropping a row, an unbounded blob, and a single bad byte in AsyncStorage
 * taking the whole History tab down with it.
 *
 * AsyncStorage cannot load under node (it pulls in react-native), so these run
 * against the module's injectable store seam — the same code path, a Map
 * instead of SQLite.
 *
 * Run:  node --import tsx --test scripts/message-history.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    MESSAGE_HISTORY_KEY,
    MAX_MESSAGE_RECORDS,
    addMessageRecord,
    listMessageRecords,
    updateMessageRecord,
    deleteMessageRecord,
    clearMessageRecords,
    markNoteSuperseded,
    __setMessageHistoryStore,
} from '../src/services/message_history';

/**
 * In-memory stand-in for AsyncStorage.
 *
 * `delayMs > 0` puts a real timer between read and write so an unlocked
 * read-modify-write would interleave — without it, a broken implementation can
 * pass on microtask ordering alone.
 */
function memoryStore({ initial = null, delayMs = 0 } = {}) {
    const map = new Map();
    if (initial !== null) map.set(MESSAGE_HISTORY_KEY, initial);
    const tick = () => (delayMs > 0
        ? new Promise(resolve => setTimeout(resolve, delayMs))
        : Promise.resolve());

    return {
        map,
        raw: () => (map.has(MESSAGE_HISTORY_KEY) ? map.get(MESSAGE_HISTORY_KEY) : null),
        parsed: () => JSON.parse(map.get(MESSAGE_HISTORY_KEY)),
        async getItem(key) {
            await tick();
            return map.has(key) ? map.get(key) : null;
        },
        async setItem(key, value) {
            await tick();
            map.set(key, value);
        },
        async removeItem(key) {
            await tick();
            map.delete(key);
        },
    };
}

function install(options) {
    const store = memoryStore(options);
    __setMessageHistoryStore(store);
    return store;
}

/** Silence the module's console.warn for the duration of `fn`. */
async function muted(fn) {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.join(' '));
    try {
        return await fn(lines);
    } finally {
        console.warn = original;
    }
}

test('addMessageRecord round-trips through storage under the documented key', async () => {
    const store = install();

    const added = await addMessageRecord({
        kind: 'photo',
        status: 'sent',
        thumbnailPngBase64: 'AAECAw==',
        sourceUri: 'file:///tmp/note.jpg',
        text: 'miss you',
    });

    assert.equal(typeof added.id, 'string');
    assert.ok(added.id.length > 0);
    assert.equal(typeof added.createdAt, 'number');
    assert.ok(added.createdAt > 0);
    assert.equal(added.kind, 'photo');
    assert.equal(added.status, 'sent');

    // The key is part of the contract: another module reading '@messenger/history'
    // must find this blob.
    assert.equal(MESSAGE_HISTORY_KEY, '@messenger/history');
    assert.ok(store.raw(), 'nothing was persisted');
    assert.ok(Array.isArray(store.parsed()));

    const [read] = await listMessageRecords();
    assert.deepEqual(read, added);
});

test('addMessageRecord drops empty optionals instead of storing undefined', async () => {
    install();
    const added = await addMessageRecord({
        kind: 'text',
        status: 'draft',
        thumbnailPngBase64: '',
        text: 'just words',
        sourceUri: '',
    });
    assert.equal('sourceUri' in added, false);
    assert.equal('error' in added, false);
    assert.equal(added.text, 'just words');
});

test('listMessageRecords returns newest first', async () => {
    const store = install();
    for (const text of ['one', 'two', 'three']) {
        await addMessageRecord({ kind: 'text', status: 'sent', thumbnailPngBase64: '', text });
    }

    const records = await listMessageRecords();
    assert.deepEqual(records.map(r => r.text), ['three', 'two', 'one']);

    // Order is list POSITION, held in storage — not a sort applied on read.
    // Three sends inside one millisecond share a createdAt, and sorting on it
    // would shuffle them arbitrarily on every render.
    assert.deepEqual(store.parsed().map(r => r.text), ['three', 'two', 'one']);
});

test('listMessageRecords is empty on a fresh install', async () => {
    install();
    assert.deepEqual(await listMessageRecords(), []);
});

test('the store caps at MAX_MESSAGE_RECORDS, evicting oldest', async () => {
    const store = install();
    assert.equal(MAX_MESSAGE_RECORDS, 100);

    const overflow = 5;
    for (let i = 0; i < MAX_MESSAGE_RECORDS + overflow; i++) {
        await addMessageRecord({
            kind: 'text',
            status: 'sent',
            thumbnailPngBase64: '',
            text: `note-${i}`,
        });
    }

    const records = await listMessageRecords();
    assert.equal(records.length, MAX_MESSAGE_RECORDS);
    // Newest kept...
    assert.equal(records[0].text, `note-${MAX_MESSAGE_RECORDS + overflow - 1}`);
    assert.equal(records[MAX_MESSAGE_RECORDS - 1].text, `note-${overflow}`);
    // ...oldest gone, and gone from STORAGE, not just from the returned list.
    const persisted = store.parsed();
    assert.equal(persisted.length, MAX_MESSAGE_RECORDS);
    for (let i = 0; i < overflow; i++) {
        assert.equal(persisted.some(r => r.text === `note-${i}`), false, `note-${i} survived the cap`);
    }
});

test('concurrent addMessageRecord calls do not lose records', async () => {
    // Every add is a read-modify-write on ONE key. With a 1 ms store delay an
    // unlocked implementation reads the same list N times and writes back a
    // one-record array; the lock is what makes all N survive.
    const store = install({ delayMs: 1 });

    const COUNT = 25;
    const added = await Promise.all(
        Array.from({ length: COUNT }, (_, i) =>
            addMessageRecord({
                kind: 'photo',
                status: 'sent',
                thumbnailPngBase64: '',
                text: `concurrent-${i}`,
            })
        )
    );

    const records = await listMessageRecords();
    assert.equal(records.length, COUNT, 'records were lost to a read-modify-write race');
    assert.equal(store.parsed().length, COUNT);

    const ids = new Set(records.map(r => r.id));
    assert.equal(ids.size, COUNT, 'duplicate ids handed out');
    for (const record of added) {
        assert.ok(ids.has(record.id), `${record.text} never reached storage`);
    }

    // createdAt is minted inside the lock, so it can never disagree with order.
    for (let i = 1; i < records.length; i++) {
        assert.ok(
            records[i - 1].createdAt >= records[i].createdAt,
            'createdAt runs backwards relative to list position'
        );
    }
});

test('concurrent add / update / delete stay consistent', async () => {
    const store = install({ delayMs: 1 });
    const first = await addMessageRecord({
        kind: 'photo', status: 'draft', thumbnailPngBase64: '', text: 'first',
    });

    await Promise.all([
        addMessageRecord({ kind: 'text', status: 'sent', thumbnailPngBase64: '', text: 'second' }),
        updateMessageRecord(first.id, { status: 'sent' }),
        addMessageRecord({ kind: 'doodle', status: 'sent', thumbnailPngBase64: '', text: 'third' }),
    ]);

    const records = await listMessageRecords();
    assert.equal(records.length, 3);
    assert.equal(records.find(r => r.id === first.id).status, 'sent');
    assert.equal(store.parsed().length, 3);

    await deleteMessageRecord(first.id);
    assert.equal((await listMessageRecords()).length, 2);
});

test('updateMessageRecord patches one row and leaves the rest alone', async () => {
    install();
    const a = await addMessageRecord({ kind: 'photo', status: 'draft', thumbnailPngBase64: 'AA==', text: 'a' });
    const b = await addMessageRecord({ kind: 'photo', status: 'draft', thumbnailPngBase64: 'BB==', text: 'b' });

    await updateMessageRecord(a.id, { status: 'failed', error: 'upload timed out' });

    const records = await listMessageRecords();
    const updated = records.find(r => r.id === a.id);
    assert.equal(updated.status, 'failed');
    assert.equal(updated.error, 'upload timed out');
    assert.equal(updated.text, 'a');
    assert.equal(updated.createdAt, a.createdAt);
    assert.deepEqual(records.find(r => r.id === b.id), b);

    // Position is stable: a status flip must not jump a row to the top.
    assert.equal(records[0].id, b.id);
});

test('updateMessageRecord clears an optional field passed as undefined', async () => {
    install();
    const record = await addMessageRecord({
        kind: 'photo', status: 'failed', thumbnailPngBase64: '', error: 'no route to host',
    });

    // The retry-succeeded path: stale failure text must not survive.
    await updateMessageRecord(record.id, { status: 'sent', error: undefined });

    const [read] = await listMessageRecords();
    assert.equal(read.status, 'sent');
    assert.equal('error' in read, false);
});

test('updateMessageRecord ignores id and createdAt in the patch', async () => {
    install();
    const record = await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '' });

    await updateMessageRecord(record.id, { id: 'hijacked', createdAt: 1, text: 'patched' });

    const [read] = await listMessageRecords();
    assert.equal(read.id, record.id);
    assert.equal(read.createdAt, record.createdAt);
    assert.equal(read.text, 'patched');
});

test('updateMessageRecord on an unknown id is a no-op, not a throw', async () => {
    const store = install();
    const record = await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '' });

    // The row can be evicted or deleted while its upload is still in flight.
    const patched = await updateMessageRecord('does-not-exist', { status: 'failed' });

    // REPORTED, not swallowed. ComposeScreen holds one record id for the whole
    // life of a note and re-sends against it; if the miss were silent, a note
    // that reached the reader would leave no trace anywhere at all.
    assert.equal(patched, false);
    assert.deepEqual(await listMessageRecords(), [record]);
    assert.equal(store.parsed().length, 1);
});

test('updateMessageRecord reports a hit so a caller can tell it apart from a miss', async () => {
    install();
    const record = await addMessageRecord({ kind: 'doodle', status: 'sent', thumbnailPngBase64: '' });

    assert.equal(await updateMessageRecord(record.id, { status: 'failed' }), true);
    // The same id after the row is gone: the exact sequence History's delete (or
    // eviction at the cap) creates while Compose still holds the id.
    await deleteMessageRecord(record.id);
    assert.equal(await updateMessageRecord(record.id, { status: 'sent' }), false);
});

test("a re-send after its row was deleted appends instead of vanishing", async () => {
    // ComposeScreen's recordAttempt, reduced to the store calls it makes.
    install();
    const attempt = { kind: 'doodle', status: 'sent', thumbnailPngBase64: 'AA==', sourceUri: 'file:///doc/note-1.png' };

    let id = (await addMessageRecord(attempt)).id;
    await deleteMessageRecord(id); // the user clears it from the History tab

    if (!(await updateMessageRecord(id, attempt))) {
        id = (await addMessageRecord(attempt)).id;
    }

    const records = await listMessageRecords();
    assert.equal(records.length, 1, 'a delivered note must still leave a row');
    assert.equal(records[0].id, id);
    // The persisted capture is re-attached, so History's removeOwnedSource can
    // still reach the file. An orphaned copy could never be cleaned up.
    assert.equal(records[0].sourceUri, 'file:///doc/note-1.png');
});

test('deleteMessageRecord removes exactly one row', async () => {
    install();
    const a = await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '', text: 'a' });
    const b = await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '', text: 'b' });

    await deleteMessageRecord(a.id);
    assert.deepEqual((await listMessageRecords()).map(r => r.id), [b.id]);

    await deleteMessageRecord('nope');
    assert.deepEqual((await listMessageRecords()).map(r => r.id), [b.id]);
});

test('clearMessageRecords empties the store', async () => {
    const store = install();
    await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '' });
    await clearMessageRecords();

    assert.equal(store.raw(), null);
    assert.deepEqual(await listMessageRecords(), []);
});

test('a corrupted blob reads as an empty list instead of throwing', async () => {
    await muted(async () => {
        for (const blob of ['not json{', '', '   ', '{"records":[]}', '"a string"', '42', 'null']) {
            install({ initial: blob });
            assert.deepEqual(await listMessageRecords(), [], `blob ${JSON.stringify(blob)}`);
        }
    });
});

test('a corrupted blob is replaced by the next write, not appended to', async () => {
    const store = await muted(async () => {
        const s = install({ initial: '[{"id":"x", truncated' });
        await addMessageRecord({ kind: 'text', status: 'sent', thumbnailPngBase64: '', text: 'after' });
        return s;
    });

    const persisted = store.parsed();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].text, 'after');
    assert.equal((await listMessageRecords()).length, 1);
});

test('junk entries are dropped, drifted fields are coerced', async () => {
    install({
        initial: JSON.stringify([
            null,
            'a string',
            [],
            { createdAt: 5 },                                   // no id -> unusable
            { id: '', kind: 'photo' },                          // empty id -> unusable
            { id: 'ok', createdAt: 12, kind: 'photo', status: 'sent', thumbnailPngBase64: 'AA==' },
            { id: 'drift', createdAt: 'yesterday', kind: 'hologram', status: 'queued' },
            { id: 'extra', createdAt: 3, kind: 'text', status: 'draft', thumbnailPngBase64: '', bogus: 1 },
        ]),
    });

    const records = await listMessageRecords();
    assert.deepEqual(records.map(r => r.id), ['ok', 'drift', 'extra']);

    const drift = records[1];
    assert.equal(drift.createdAt, 0);
    assert.equal(drift.kind, 'photo');
    // Unreadable status resolves pessimistically: a wrong 'sent' would hide a
    // note that never reached the panel.
    assert.equal(drift.status, 'failed');
    assert.equal(drift.thumbnailPngBase64, '');

    // Unknown fields do not survive the round-trip and cannot grow the blob.
    assert.equal('bogus' in records[2], false);
});

test('a blob longer than the cap is trimmed on read', async () => {
    const oversized = Array.from({ length: MAX_MESSAGE_RECORDS + 20 }, (_, i) => ({
        id: `id-${i}`, createdAt: i, kind: 'text', status: 'sent', thumbnailPngBase64: '',
    }));
    install({ initial: JSON.stringify(oversized) });

    const records = await listMessageRecords();
    assert.equal(records.length, MAX_MESSAGE_RECORDS);
    assert.equal(records[0].id, 'id-0');
});

test('duplicate ids in a stored blob collapse to the newest', async () => {
    install({
        initial: JSON.stringify([
            { id: 'dup', createdAt: 2, kind: 'photo', status: 'sent', thumbnailPngBase64: '', text: 'newer' },
            { id: 'dup', createdAt: 1, kind: 'photo', status: 'sent', thumbnailPngBase64: '', text: 'older' },
        ]),
    });

    const records = await listMessageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].text, 'newer');
});

test('a store that throws degrades instead of failing the send', async () => {
    const exploding = {
        async getItem() { throw new Error('SQLite is having a day'); },
        async setItem() { throw new Error('quota exceeded'); },
        async removeItem() { throw new Error('nope'); },
    };
    __setMessageHistoryStore(exploding);

    await muted(async () => {
        assert.deepEqual(await listMessageRecords(), []);
        // The note itself already went out; a storage failure must not surface
        // as a failed send.
        const record = await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '' });
        assert.equal(typeof record.id, 'string');
        await updateMessageRecord(record.id, { status: 'failed' });
        await deleteMessageRecord(record.id);
        await clearMessageRecords();
    });
});

test('the delivery route and mailbox id survive a round trip, and a retry can change them', async () => {
    // Without these a 'sent' row cannot say whether the note is ON the panel or
    // merely waiting in a mailbox for the reader's next wake, and there is no id
    // to correlate the row with what the reader eventually shows (the reader
    // reports nothing back — `latest.txt` -> `messageLastShownId` is the only
    // handle either side has).
    install();

    const created = await addMessageRecord({
        kind: 'photo',
        status: 'sent',
        thumbnailPngBase64: 'x',
        path: 'mailbox',
        noteId: 'k9m2-abc123',
    });
    assert.equal(created.path, 'mailbox');
    assert.equal(created.noteId, 'k9m2-abc123');

    const [reloaded] = await listMessageRecords();
    assert.equal(reloaded.path, 'mailbox');
    assert.equal(reloaded.noteId, 'k9m2-abc123');

    // A retry that reached the reader directly must not leave 'mailbox' — and
    // must not leave the stale note id — on the row it patches.
    assert.equal(await updateMessageRecord(created.id, { status: 'sent', path: 'direct', noteId: undefined }), true);
    const [patched] = await listMessageRecords();
    assert.equal(patched.path, 'direct');
    assert.equal('noteId' in patched, false);

    // An unrecognised route is dropped, never guessed: a row claiming 'direct'
    // when the note is really sitting in a mailbox is worse than a silent row.
    await updateMessageRecord(created.id, { path: 'carrier-pigeon' });
    const [coerced] = await listMessageRecords();
    assert.equal('path' in coerced, false);
});

test('idStaged distinguishes the two kinds of "sent", and never guesses', async () => {
    // THE DEGRADED SUCCESS. A direct send whose frame landed but whose
    // /.love-notes/current.id did not comes back { success: true, idStaged: false }
    // — the note displays, and the reader re-shows it on EVERY wake because it has
    // no id to mark shown. Without this field on the row, History cannot tell
    // "the reader will dismiss this" from "the reader will re-show it forever",
    // and re-sending is the only fix.
    install();

    const degraded = await addMessageRecord({
        kind: 'photo',
        status: 'sent',
        thumbnailPngBase64: 'x',
        path: 'direct',
        idStaged: false,
    });
    assert.equal(degraded.idStaged, false);

    const [reloaded] = await listMessageRecords();
    assert.equal(reloaded.idStaged, false, 'must survive the JSON round trip, not just the in-memory return');

    // A retry that DID stage its id must clear the warning, or History goes on
    // warning about a note the reader can now dismiss.
    assert.equal(await updateMessageRecord(degraded.id, { status: 'sent', idStaged: true }), true);
    assert.equal((await listMessageRecords())[0].idStaged, true);

    // Present-and-undefined clears, the same rule `path`/`error` follow: the
    // mailbox route reports no sidecar at all, so a fallback retry must not leave
    // the direct attempt's flag behind.
    await updateMessageRecord(degraded.id, { path: 'mailbox', idStaged: undefined });
    const [viaMailbox] = await listMessageRecords();
    assert.equal('idStaged' in viaMailbox, false);

    // NOT truthiness. A stray non-boolean out of an unversioned blob must land on
    // "unknown" rather than invent a warning (or hide one).
    for (const junk of [0, 1, '', 'false', 'true', null, {}]) {
        await updateMessageRecord(degraded.id, { idStaged: junk });
        assert.equal('idStaged' in (await listMessageRecords())[0], false, `idStaged: ${JSON.stringify(junk)}`);
    }
});

test('a stored row with a junk route still loads', async () => {
    const store = install({
        initial: JSON.stringify([
            { id: 'a', createdAt: 1, kind: 'photo', status: 'sent', thumbnailPngBase64: '', path: 7, noteId: 42 },
        ]),
    });
    const [record] = await listMessageRecords();
    assert.equal(record.id, 'a');
    assert.equal('path' in record, false);
    assert.equal('noteId' in record, false);
    assert.ok(store.raw());
});

test('no React Native runtime means no storage, not an import-time crash', async () => {
    // This file imported the module at all, which already proves it does not
    // pull in react-native at load. `null` restores the AsyncStorage default,
    // which under node resolves to "unavailable".
    __setMessageHistoryStore(null);

    await muted(async () => {
        assert.deepEqual(await listMessageRecords(), []);
        const record = await addMessageRecord({ kind: 'photo', status: 'sent', thumbnailPngBase64: '' });
        assert.equal(typeof record.id, 'string');
        assert.deepEqual(await listMessageRecords(), []);
    });
});

// ---------------------------------------------------------------------------
// markNoteSuperseded — the terminal state the store could not previously express
// ---------------------------------------------------------------------------

test('the NEWEST row for a noteId is the one that gets retired', async t => {
    install();
    t.after(() => __setMessageHistoryStore(null));

    // Two attempts at the same note keep one dedup id between them; the newest is
    // the row the user is looking at, and the store is newest-first.
    await addMessageRecord({ kind: 'photo', status: 'failed', noteId: 'n1', thumbnailPngBase64: '' });
    await addMessageRecord({
        kind: 'photo',
        status: 'sent',
        path: 'mailbox',
        noteId: 'n1',
        error: undefined,
        thumbnailPngBase64: '',
    });

    assert.equal(await markNoteSuperseded('n1'), true);
    const records = await listMessageRecords();
    assert.equal(records[0].status, 'superseded');
    // The older attempt is untouched: it is a different row about a different try.
    assert.equal(records[1].status, 'failed');
    // Idempotent — a second collapse of the same note is not a second patch.
    assert.equal(await markNoteSuperseded('n1'), false);
});

test('retiring a note clears the stale failure text off its row', async t => {
    install();
    t.after(() => __setMessageHistoryStore(null));
    await addMessageRecord({
        kind: 'text',
        status: 'failed',
        error: 'Reader unreachable; mailbox failed too',
        noteId: 'n2',
        thumbnailPngBase64: '',
    });
    assert.equal(await markNoteSuperseded('n2'), true);
    const [row] = await listMessageRecords();
    assert.equal(row.status, 'superseded');
    // "Reader unreachable" is no longer why this note is not on the panel.
    assert.equal(row.error, undefined);
});

test("'superseded' survives a store round trip rather than degrading to 'failed'", async t => {
    const store = install();
    t.after(() => __setMessageHistoryStore(null));
    await addMessageRecord({ kind: 'doodle', status: 'superseded', noteId: 'n3', thumbnailPngBase64: '' });
    // Straight out of the blob, through asStatus, which drops anything it does
    // not recognise onto the pessimistic end of the union.
    assert.match(await store.getItem(MESSAGE_HISTORY_KEY), /"status":"superseded"/);
    assert.equal((await listMessageRecords())[0].status, 'superseded');
});
