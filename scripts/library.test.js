/**
 * library — the merge, the offline cache, and the two ways a source can be down.
 *
 * This module is the whole reason the Library tab can render while the X3 is
 * asleep, so the failures worth testing are the ones that would make it lie:
 *
 *   - a book on the reader AND in the mailbox listed twice, or listed once with
 *     the wrong badge (the reader's SD card is FAT, so case is not identity);
 *   - an unreachable reader reported as an empty library — which would ALSO
 *     overwrite the offline cache with nothing and destroy the only record;
 *   - "no mailbox configured" rendered like "the mailbox is broken";
 *   - a cache blob from another build taking the tab down instead of degrading;
 *   - a mailbox delete that silently no-ops.
 *
 * Both network sides run against seams: the reader through `__setLibraryReader`
 * (crosspoint_upload imports expo-file-system, which node cannot load) and the
 * mailbox through `globalThis.fetch`, which `mailbox_client` resolves per call —
 * so the REAL `listMailboxBooks` / `deleteMailboxBook` code paths execute here,
 * including their `/status` parsing and their 404 wording.
 *
 * Run:  node --import tsx --test scripts/library.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    READER_BOOKS_CACHE_KEY,
    MAX_CACHED_READER_BOOKS,
    MAILBOX_NOT_CONFIGURED,
    loadLibrary,
    removeMailboxBook,
    __setLibraryStore,
    __setLibraryReader,
} from '../src/services/library';
import { DEFAULT_LIBRARY_FOLDER } from '../src/services/epub_sender';
import { MAILBOX_BOOKS_PATH, MAILBOX_STATUS_PATH } from '../src/services/mailbox_client';

const IP = '192.168.1.50';
const BASE = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const TOKEN = 'wr_secret_token';

/** A destination with both sides configured. */
function dest(overrides = {}) {
    return { ip: IP, mailboxUrl: BASE, mailboxWriteToken: TOKEN, ...overrides };
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** In-memory stand-in for AsyncStorage, with the raw blob inspectable. */
function memoryStore({ initial = null, failRead = false, failWrite = false } = {}) {
    const map = new Map();
    if (initial !== null) map.set(READER_BOOKS_CACHE_KEY, initial);
    const store = {
        map,
        raw: () => (map.has(READER_BOOKS_CACHE_KEY) ? map.get(READER_BOOKS_CACHE_KEY) : null),
        parsed: () => JSON.parse(map.get(READER_BOOKS_CACHE_KEY)),
        writes: 0,
        async getItem(key) {
            if (failRead) throw new Error('storage read exploded');
            return map.has(key) ? map.get(key) : null;
        },
        async setItem(key, value) {
            store.writes++;
            if (failWrite) throw new Error('storage quota exceeded');
            map.set(key, value);
        },
        async removeItem(key) {
            map.delete(key);
        },
    };
    __setLibraryStore(store);
    return store;
}

/**
 * A reader that behaves like `listCrossPointFiles` DOES, not like a stub.
 *
 * The load-bearing detail: the real function returns `[]` for an unreachable
 * reader exactly as it does for an empty folder, and never throws. A mock that
 * rejected on `up: false` would make the ambiguity — the whole reason
 * `probeReader` exists — invisible.
 */
function fakeReader({ up = true, files = [], probeError = 'Cannot reach the reader.' } = {}) {
    const calls = { probes: 0, lists: [] };
    __setLibraryReader({
        async checkConnection(ip) {
            calls.probes++;
            return up ? { success: true } : { success: false, error: probeError };
        },
        async listBooks(ip, targetFolder) {
            calls.lists.push({ ip, targetFolder });
            if (!up) return [];
            return files;
        },
    });
    return calls;
}

/** A reader whose transport must never be touched. Any call is the failure. */
function forbiddenReader() {
    __setLibraryReader({
        async checkConnection() {
            throw new Error('the reader must not be probed on this path');
        },
        async listBooks() {
            throw new Error('the reader must not be listed on this path');
        },
    });
}

/** Minimal `Response`: status plus a body the module reads with `.text()`. */
function reply(status, body = '') {
    return {
        status,
        ok: status >= 200 && status < 300,
        async text() {
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
    };
}

function fakeFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const answer = typeof responder === 'function' ? responder(url, init, calls.length) : responder;
        return await answer;
    };
    return calls;
}

/** A mailbox that answers `/status` with these books, newest first. */
function mailboxWith(books) {
    return fakeFetch(() => reply(200, { books }));
}

/** A fetch that must never be called. */
function forbiddenFetch() {
    return fakeFetch(() => {
        throw new Error('the mailbox must not be contacted on this path');
    });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    __setLibraryStore(null);
    __setLibraryReader(null);
});

/** Silence the module's console.warn for the duration of `fn`. */
async function muted(fn) {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.map(String).join(' '));
    try {
        return await fn(lines);
    } finally {
        console.warn = original;
    }
}

function names(snapshot) {
    return snapshot.books.map(b => b.filename);
}

function byName(snapshot, filename) {
    return snapshot.books.find(b => b.filename === filename);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

test('merge: reader-only books are listed as reader, with no mailbox id', async () => {
    memoryStore();
    fakeReader({ files: [{ name: 'dune.epub', size: 900 }] });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.deepEqual(names(snapshot), ['dune.epub']);
    assert.equal(snapshot.books[0].location, 'reader');
    assert.equal(snapshot.books[0].bytes, 900);
    assert.equal(snapshot.books[0].mailboxId, undefined);
    assert.equal(snapshot.readerFresh, true);
});

test('merge: mailbox-only books are listed as mailbox, carrying the delete handle', async () => {
    memoryStore();
    fakeReader({ files: [] });
    mailboxWith([{ id: 'bk1', filename: 'ubik.epub', bytes: 1200 }]);

    const snapshot = await loadLibrary(dest());

    assert.deepEqual(names(snapshot), ['ubik.epub']);
    assert.equal(snapshot.books[0].location, 'mailbox');
    assert.equal(snapshot.books[0].mailboxId, 'bk1');
    assert.equal(snapshot.books[0].bytes, 1200);
    // A mailbox row was never seen on the reader, so it must not claim it was.
    assert.equal(snapshot.books[0].readerListedAt, undefined);
    assert.equal(snapshot.mailboxOk, true);
    assert.equal(snapshot.mailboxConfigured, true);
});

test('merge: a book on both sides is ONE row marked both, keeping the mailbox id', async () => {
    memoryStore();
    fakeReader({ files: [{ name: 'dune.epub', size: 900 }] });
    mailboxWith([{ id: 'bk1', filename: 'dune.epub', bytes: 900 }]);

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.books.length, 1, 'a synced book must not be listed twice');
    assert.equal(snapshot.books[0].location, 'both');
    assert.equal(snapshot.books[0].mailboxId, 'bk1');
    assert.ok(snapshot.books[0].readerListedAt > 0);
});

test('merge: filename collision is case-insensitive and the reader spelling wins', async () => {
    // FAT has no case identity, so 'Dune.epub' and 'dune.epub' ARE one file on
    // the card. Merging case-sensitively would show a queued book as missing
    // from a reader that already has it.
    memoryStore();
    fakeReader({ files: [{ name: 'Dune.epub', size: 900 }] });
    mailboxWith([{ id: 'bk1', filename: 'DUNE.EPUB', bytes: 901 }]);

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.books.length, 1);
    assert.equal(snapshot.books[0].filename, 'Dune.epub', 'the card name is the real one');
    assert.equal(snapshot.books[0].location, 'both');
    assert.equal(snapshot.books[0].mailboxId, 'bk1');
});

test('merge: a size the reader omitted is filled in from the mailbox', async () => {
    memoryStore();
    fakeReader({ files: [{ name: 'dune.epub' }] }); // firmware JSON may omit size
    mailboxWith([{ id: 'bk1', filename: 'dune.epub', bytes: 4242 }]);

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.books[0].bytes, 4242);
});

test('merge: two mailbox rows with one name keep the NEWEST id', async () => {
    // The delete handle has to address the copy the user is looking at; removing
    // the older duplicate would leave the queue looking unchanged.
    memoryStore();
    fakeReader({ files: [] });
    mailboxWith([
        { id: 'newer', filename: 'ubik.epub', bytes: 10 },
        { id: 'older', filename: 'ubik.epub', bytes: 10 },
    ]);

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.books.length, 1);
    assert.equal(snapshot.books[0].mailboxId, 'newer');
});

test('merge: mailbox rows missing an id or filename are dropped, not rendered blank', async () => {
    memoryStore();
    fakeReader({ files: [] });
    mailboxWith([
        { id: '', filename: 'no-id.epub', bytes: 5 },
        { id: 'bk2', filename: '   ', bytes: 5 },
        { id: 'bk3', filename: 'good.epub', bytes: 5 },
    ]);

    const snapshot = await loadLibrary(dest());

    assert.deepEqual(names(snapshot), ['good.epub']);
});

test('merge: the reader listing is de-duplicated case-insensitively too', async () => {
    memoryStore();
    fakeReader({ files: [{ name: 'dune.epub', size: 1 }, { name: 'DUNE.epub', size: 2 }] });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.deepEqual(names(snapshot), ['dune.epub']);
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

test('sort: dated reader books come first newest-first, then mailbox order, then name', async () => {
    memoryStore();
    fakeReader({
        files: [
            // `listCrossPointFiles` derives `timestamp` from the filename date.
            { name: 'b - 2026-01-02 - two.epub', size: 1, timestamp: 2000 },
            { name: 'a - 2026-01-03 - three.epub', size: 1, timestamp: 3000 },
            { name: 'zz-undated.epub', size: 1, timestamp: 0 },
        ],
    });
    mailboxWith([
        { id: 'm1', filename: 'queued-newest.epub', bytes: 1 },
        { id: 'm2', filename: 'queued-older.epub', bytes: 1 },
    ]);

    const snapshot = await loadLibrary(dest());

    assert.deepEqual(names(snapshot), [
        'a - 2026-01-03 - three.epub',
        'b - 2026-01-02 - two.epub',
        'queued-newest.epub',
        'queued-older.epub',
        'zz-undated.epub',
    ]);
});

test('sort: identical inputs produce an identical order across loads (total order)', async () => {
    // Undated rows on both sides — the case where a partial comparator would
    // reshuffle and make pull-to-refresh look broken.
    const files = [
        { name: 'Beta.epub', size: 1 },
        { name: 'alpha.epub', size: 1 },
        { name: 'gamma.epub', size: 1 },
    ];
    const books = [{ id: 'm1', filename: 'delta.epub', bytes: 1 }];

    memoryStore();
    fakeReader({ files });
    mailboxWith(books);
    const first = await loadLibrary(dest());

    memoryStore();
    fakeReader({ files: [...files].reverse() });
    mailboxWith(books);
    const second = await loadLibrary(dest());

    assert.deepEqual(names(second), names(first));
    // Mailbox rows outrank same-recency rows the mailbox does not hold.
    assert.deepEqual(names(first), ['delta.epub', 'alpha.epub', 'Beta.epub', 'gamma.epub']);
});

// ---------------------------------------------------------------------------
// Reader freshness, probing, and the offline cache
// ---------------------------------------------------------------------------

test('cache: a successful listing is cached and round-trips as stale rows next time', async () => {
    const store = memoryStore();
    fakeReader({ files: [{ name: 'dune.epub', size: 900, timestamp: 5000 }] });
    forbiddenFetch();

    const live = await loadLibrary({ ip: IP });
    assert.equal(live.readerFresh, true);
    assert.ok(live.readerListedAt > 0);
    assert.deepEqual(store.parsed().books, [{ filename: 'dune.epub', bytes: 900, timestamp: 5000 }]);
    const cachedAt = store.parsed().listedAt;
    assert.equal(cachedAt, live.readerListedAt);

    // Reader now asleep: same store, no live listing available.
    fakeReader({ up: false, probeError: 'Cannot reach the reader. timeout' });
    const stale = await loadLibrary({ ip: IP });

    assert.equal(stale.readerFresh, false);
    assert.equal(stale.readerListedAt, cachedAt, 'stale rows must date themselves honestly');
    assert.deepEqual(names(stale), ['dune.epub']);
    assert.equal(stale.books[0].location, 'reader');
    assert.equal(stale.books[0].readerListedAt, cachedAt);
    assert.match(stale.readerError, /Cannot reach the reader/);
});

test('offline: an unreachable reader still lists the mailbox side and stays addable', async () => {
    memoryStore();
    fakeReader({ up: false });
    mailboxWith([{ id: 'bk1', filename: 'ubik.epub', bytes: 12 }]);

    const snapshot = await loadLibrary(dest());

    assert.deepEqual(names(snapshot), ['ubik.epub']);
    assert.equal(snapshot.books[0].location, 'mailbox');
    assert.equal(snapshot.mailboxOk, true, 'the mailbox is a separate host and answered');
    assert.equal(snapshot.readerFresh, false);
    assert.equal(snapshot.readerListedAt, null, 'never listed, so no date to show');
});

test('probe: a failed probe skips the listing entirely (no 25 s of firmware timeouts)', async () => {
    memoryStore();
    const calls = fakeReader({ up: false });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.equal(calls.probes, 1);
    assert.deepEqual(calls.lists, [], 'listing a reader that just failed to answer is dead time');
    assert.equal(snapshot.readerFresh, false);
});

test('probe: the listing targets the books folder epub_sender writes', async () => {
    memoryStore();
    const calls = fakeReader({ files: [] });
    forbiddenFetch();

    await loadLibrary({ ip: IP });

    assert.deepEqual(calls.lists, [{ ip: IP, targetFolder: DEFAULT_LIBRARY_FOLDER }]);
});

test('probe: probeReader false skips the probe when the listing is non-empty', async () => {
    memoryStore();
    const calls = fakeReader({ files: [{ name: 'dune.epub', size: 1 }] });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP }, { probeReader: false });

    assert.equal(calls.probes, 0);
    assert.equal(snapshot.readerFresh, true);
    assert.deepEqual(names(snapshot), ['dune.epub']);
});

test('probe: an EMPTY un-probed listing is confirmed before the cache is believed empty', async () => {
    // The trap this closes: `listCrossPointFiles` returns [] for a dead reader,
    // so trusting it would report an empty library AND overwrite the offline
    // cache with nothing — destroying the only record of what is on the card.
    const store = memoryStore({
        initial: JSON.stringify({ listedAt: 111, books: [{ filename: 'dune.epub', bytes: 900, timestamp: 0 }] }),
    });
    const calls = fakeReader({ up: false });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP }, { probeReader: false });

    assert.equal(calls.lists.length, 1);
    assert.equal(calls.probes, 1, 'an empty listing must be confirmed, not assumed');
    assert.equal(snapshot.readerFresh, false);
    assert.deepEqual(names(snapshot), ['dune.epub'], 'the cached list survived');
    assert.equal(store.writes, 0, 'the cache must not be overwritten by a phantom empty listing');
    assert.equal(store.parsed().books.length, 1);
});

test('cache: a genuinely emptied reader DOES empty the cache', async () => {
    const store = memoryStore({
        initial: JSON.stringify({ listedAt: 111, books: [{ filename: 'gone.epub', bytes: 5, timestamp: 0 }] }),
    });
    fakeReader({ up: true, files: [] });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.deepEqual(snapshot.books, []);
    assert.equal(snapshot.readerFresh, true);
    assert.deepEqual(store.parsed().books, [], 'a believed listing is the truth, empty included');
});

test('cache: the stored list is capped, dropping the oldest tail', async () => {
    const store = memoryStore();
    const files = [];
    for (let i = 0; i < MAX_CACHED_READER_BOOKS + 20; i++) {
        // Newest first, as the firmware listing arrives.
        files.push({ name: `book-${String(i).padStart(4, '0')}.epub`, size: 1, timestamp: 100000 - i });
    }
    fakeReader({ files });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.equal(snapshot.books.length, files.length, 'the live list is not truncated');
    const cached = store.parsed().books;
    assert.equal(cached.length, MAX_CACHED_READER_BOOKS);
    assert.equal(cached[0].filename, 'book-0000.epub');
    assert.equal(cached[cached.length - 1].filename, `book-${String(MAX_CACHED_READER_BOOKS - 1).padStart(4, '0')}.epub`);
});

test('cache: no reader address means no network call and the cached rows', async () => {
    memoryStore({
        initial: JSON.stringify({ listedAt: 222, books: [{ filename: 'dune.epub', bytes: 1, timestamp: 0 }] }),
    });
    forbiddenReader();
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: '   ' });

    assert.deepEqual(names(snapshot), ['dune.epub']);
    assert.equal(snapshot.readerFresh, false);
    assert.equal(snapshot.readerListedAt, 222);
    assert.match(snapshot.readerError, /No reader address/);
});

// ---------------------------------------------------------------------------
// Corrupted cache
// ---------------------------------------------------------------------------

test('cache: every unreadable blob shape degrades to empty instead of throwing', async () => {
    const blobs = [
        ['not json at all', /not JSON/],
        ['', null],
        ['[]', /not an object/],
        ['null', /not an object/],
        ['"a string"', /not an object/],
        [JSON.stringify({ listedAt: 1 }), null], // no books key
        [JSON.stringify({ listedAt: 1, books: 'nope' }), null],
        // `name`/`size` is the LIVE listing's shape, not the cache's — a blob in
        // that shape is another build's blob and must not be half-read.
        [JSON.stringify({ books: [null, 7, { bytes: 3 }, { name: 'ignored-key.epub' }] }), null],
    ];

    for (const [blob, warning] of blobs) {
        memoryStore({ initial: blob });
        fakeReader({ up: false });
        forbiddenFetch();

        const snapshot = await muted(async lines => {
            const result = await loadLibrary({ ip: IP });
            if (warning) assert.match(lines.join('\n'), warning, `no warning for blob: ${blob}`);
            return result;
        });

        assert.deepEqual(snapshot.books, [], `blob should have read as empty: ${blob}`);
        assert.equal(snapshot.readerFresh, false);
        // A blob with no usable timestamp must not invent one.
        assert.equal(typeof snapshot.readerListedAt === 'number' || snapshot.readerListedAt === null, true);
        __setLibraryStore(null);
        __setLibraryReader(null);
    }
});

test('cache: rows with an unusable listedAt are still shown, just undated', async () => {
    // Rows without a date are a worse offline list than rows with one, and a far
    // better one than no list at all — so a junk timestamp costs the date only.
    memoryStore({ initial: JSON.stringify({ listedAt: 'yesterday', books: [{ filename: 'x.epub', bytes: 7 }] }) });
    fakeReader({ up: false });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.deepEqual(names(snapshot), ['x.epub']);
    assert.equal(snapshot.books[0].bytes, 7);
    assert.equal(snapshot.readerListedAt, null);
    assert.equal(snapshot.books[0].readerListedAt, undefined, 'no date is better than a wrong one');
});

test('cache: a cached row missing a name is dropped, its siblings survive', async () => {
    memoryStore({
        initial: JSON.stringify({
            listedAt: 333,
            books: [{ filename: '', bytes: 1 }, { filename: 'kept.epub', bytes: 2, timestamp: 9 }],
        }),
    });
    fakeReader({ up: false });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.deepEqual(names(snapshot), ['kept.epub']);
    assert.equal(snapshot.books[0].bytes, 2);
});

test('cache: a store that throws on read or write never fails the load', async () => {
    memoryStore({ failRead: true });
    fakeReader({ up: false });
    forbiddenFetch();
    const read = await muted(() => loadLibrary({ ip: IP }));
    assert.deepEqual(read.books, []);
    assert.equal(read.readerFresh, false);

    __setLibraryStore(null);
    __setLibraryReader(null);
    memoryStore({ failWrite: true });
    fakeReader({ files: [{ name: 'dune.epub', size: 1 }] });
    forbiddenFetch();
    const written = await muted(() => loadLibrary({ ip: IP }));
    assert.equal(written.readerFresh, true, 'a working reader must not be reported as asleep');
    assert.deepEqual(names(written), ['dune.epub']);
});

test('cache: with no store at all the reader side still lists live', async () => {
    // Node has no AsyncStorage, which is the same shape as a web preview.
    __setLibraryStore(null);
    fakeReader({ files: [{ name: 'dune.epub', size: 1 }] });
    forbiddenFetch();

    const snapshot = await loadLibrary({ ip: IP });

    assert.deepEqual(names(snapshot), ['dune.epub']);
    assert.equal(snapshot.readerFresh, true);
});

// ---------------------------------------------------------------------------
// Mailbox: unconfigured vs failed
// ---------------------------------------------------------------------------

test('mailbox: unconfigured is NOT a failure — no request, and the flag says why', async () => {
    for (const overrides of [
        { mailboxUrl: undefined, mailboxWriteToken: undefined },
        { mailboxUrl: '   ', mailboxWriteToken: TOKEN },
        { mailboxUrl: BASE, mailboxWriteToken: '' },
        { mailboxUrl: BASE, mailboxWriteToken: '   ' },
    ]) {
        memoryStore();
        fakeReader({ files: [{ name: 'dune.epub', size: 1 }] });
        const calls = forbiddenFetch();

        const snapshot = await loadLibrary(dest(overrides));

        assert.equal(snapshot.mailboxConfigured, false, JSON.stringify(overrides));
        assert.equal(snapshot.mailboxOk, false);
        assert.equal(snapshot.mailboxError, MAILBOX_NOT_CONFIGURED);
        assert.deepEqual(calls, [], 'a half-configured mailbox cannot answer /status');
        assert.deepEqual(names(snapshot), ['dune.epub'], 'reader rows still render');
        __setLibraryStore(null);
        __setLibraryReader(null);
    }
});

test('mailbox: a configured mailbox that fails is flagged configured-but-broken', async () => {
    memoryStore();
    fakeReader({ files: [{ name: 'dune.epub', size: 1 }] });
    fakeFetch(() => reply(401, 'bad token'));

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.mailboxConfigured, true, 'the user queued books here; a warning is warranted');
    assert.equal(snapshot.mailboxOk, false);
    assert.match(snapshot.mailboxError, /token rejected \(401\)/);
    assert.notEqual(snapshot.mailboxError, MAILBOX_NOT_CONFIGURED);
    assert.deepEqual(names(snapshot), ['dune.epub'], 'reader rows survive a broken mailbox');
});

test('mailbox: a dead network is reported, not thrown', async () => {
    memoryStore();
    fakeReader({ files: [] });
    fakeFetch(() => {
        throw new TypeError('Network request failed');
    });

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.mailboxConfigured, true);
    assert.equal(snapshot.mailboxOk, false);
    assert.ok(snapshot.mailboxError.length > 0);
    assert.deepEqual(snapshot.books, []);
});

test('mailbox: a 200 that is not JSON is a failure, not an empty library', async () => {
    memoryStore();
    fakeReader({ files: [] });
    fakeFetch(() => reply(200, '<html>captive portal</html>'));

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.mailboxOk, false);
    assert.match(snapshot.mailboxError, /not readable JSON/);
});

test('mailbox: an empty box is ok with no error', async () => {
    memoryStore();
    fakeReader({ files: [] });
    mailboxWith([]);

    const snapshot = await loadLibrary(dest());

    assert.equal(snapshot.mailboxOk, true);
    assert.equal(snapshot.mailboxError, undefined);
    assert.deepEqual(snapshot.books, []);
});

test('mailbox: the list is read from authenticated /status, token in the header', async () => {
    memoryStore();
    fakeReader({ files: [] });
    const calls = mailboxWith([{ id: 'bk1', filename: 'ubik.epub', bytes: 1 }]);

    await loadLibrary(dest());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_STATUS_PATH}`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!calls[0].url.includes(TOKEN), 'the token must never ride in the URL');
});

// ---------------------------------------------------------------------------
// removeMailboxBook
// ---------------------------------------------------------------------------

test('remove: a successful delete hits DELETE /books/{id} with the bearer token', async () => {
    const calls = fakeFetch(() => reply(200, { id: 'bk1', filename: 'ubik.epub' }));

    const result = await removeMailboxBook(dest(), 'bk1');

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_BOOKS_PATH}/bk1`);
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('remove: a whitespace-padded id is trimmed rather than sent raw', async () => {
    const calls = fakeFetch(() => reply(200, ''));

    const result = await removeMailboxBook(dest(), '  bk1  ');

    assert.equal(result.ok, true);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_BOOKS_PATH}/bk1`);
});

test('remove: a 404 fails loudly and tells the user to refresh', async () => {
    fakeFetch(() => reply(404, 'not found'));

    const result = await removeMailboxBook(dest(), 'ghost');

    assert.equal(result.ok, false);
    assert.match(result.error, /no book with id "ghost"/);
    assert.match(result.error, /Refresh/i);
});

test('remove: an unconfigured mailbox is refused before any request', async () => {
    const calls = forbiddenFetch();

    for (const overrides of [
        { mailboxUrl: undefined },
        { mailboxWriteToken: '' },
        { mailboxUrl: '  ', mailboxWriteToken: '  ' },
    ]) {
        const result = await removeMailboxBook(dest(overrides), 'bk1');
        assert.deepEqual(result, { ok: false, error: MAILBOX_NOT_CONFIGURED }, JSON.stringify(overrides));
    }
    assert.deepEqual(calls, []);
});

test('remove: a missing id is refused before any request', async () => {
    const calls = forbiddenFetch();

    for (const id of ['', '   ', undefined, null]) {
        const result = await removeMailboxBook(dest(), id);
        assert.equal(result.ok, false);
        assert.match(result.error, /no mailbox id/i);
    }
    assert.deepEqual(calls, []);
});

test('remove: a dead network reports an error instead of throwing', async () => {
    fakeFetch(() => {
        throw new TypeError('Network request failed');
    });

    const result = await removeMailboxBook(dest(), 'bk1');

    assert.equal(result.ok, false);
    assert.ok(result.error.length > 0);
});

test('remove: it never touches the reader cache — a both row becomes reader on reload', async () => {
    // Removing a queued copy cannot change what is on the SD card, so the row
    // must survive the delete with its reader half intact.
    const store = memoryStore();
    fakeReader({ files: [{ name: 'dune.epub', size: 900 }] });
    mailboxWith([{ id: 'bk1', filename: 'dune.epub', bytes: 900 }]);

    const before = await loadLibrary(dest());
    assert.equal(before.books[0].location, 'both');
    const cachedBefore = store.raw();

    fakeFetch(() => reply(200, ''));
    const removed = await removeMailboxBook(dest(), 'bk1');
    assert.equal(removed.ok, true);
    assert.equal(store.raw(), cachedBefore, 'the reader cache is not this call to change');

    fakeReader({ files: [{ name: 'dune.epub', size: 900 }] });
    mailboxWith([]);
    const after = await loadLibrary(dest());

    assert.deepEqual(names(after), ['dune.epub']);
    assert.equal(after.books[0].location, 'reader');
    assert.equal(after.books[0].mailboxId, undefined);
});
