/**
 * Mailbox wire-contract tests — against `mailbox/src/core.js` DIRECTLY, no
 * server, no sockets, no Cloudflare.
 *
 * The reader firmware is the fixed side of this contract and cannot be
 * debugged from here: a wrong status code, a stray trailing newline on
 * latest.txt or a frame that is 52271 bytes shows up as "the note never
 * appeared" after a deep-sleep cycle on a device that is invisible on the
 * network while asleep. So every rule the firmware relies on
 * (crosspoint-reader `src/network/MessageSync.cpp`) is pinned here.
 *
 * Run one file:
 *   NODE_OPTIONS=--max-old-space-size=512 timeout 60 \
 *     node --import tsx --test scripts/mailbox-core.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    BOOK_FILENAME_MAX_LEN,
    BOOK_ID_MAX_LEN,
    BOX_ID_PATTERN,
    FRAME_BYTES,
    MAX_BOOKS,
    MAX_BOOK_BYTES,
    MAX_REQUEST_BODY_BYTES,
    MAX_WALLPAPERS,
    MAX_WALLPAPER_BYTES,
    MIN_WRITE_TOKEN_LEN,
    NOTE_ID_MAX_LEN,
    READER_URL_MAX_LEN,
    WALLPAPER_FILENAME_MAX_LEN,
    WALLPAPER_ID_MAX_LEN,
    WALLPAPER_NO_FILENAME,
    WALLPAPER_TARGETS,
    WALLPAPER_TARGET_PRIMARY,
    WALLPAPER_TARGET_SET,
    base64UrlEncode,
    bookKey,
    booksIndexKey,
    buildBaseUrl,
    checkReaderUrlBudget,
    createMemoryStore,
    frameKey,
    generateBoxId,
    generateWriteToken,
    handleRequest,
    headerGet,
    metaKey,
    parseByteRange,
    parsePath,
    renderBooksManifest,
    renderWallpaperManifest,
    requestBodyLimit,
    sanitizeBookFilename,
    sanitizeWallpaperFilename,
    timingSafeEqualStr,
    trimNoteId,
    validateBookId,
    validateWallpaperId,
    validateWallpaperTarget,
    wallpaperKey,
    wallpapersIndexKey,
    writeAuthPreflight,
} from '../mailbox/src/core.js';

const TOKEN = 'test-write-token-0123456789abcdef';
const BOX = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars, matches BOX_ID_PATTERN
const OTHER_BOX = 'ZzYyXxWwVvUuTtSsRrQqPp';

const DECODER = new TextDecoder();

/** Deterministic, seed-distinguishable frame of exactly the panel size. */
function frame(seed = 1) {
    const bytes = new Uint8Array(FRAME_BYTES);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
    return bytes;
}

function req(method, path, { headers = {}, body = null } = {}) {
    return { method, path, headers, body };
}

function call(store, request, config = { writeToken: TOKEN }) {
    return handleRequest(request, store, config);
}

function text(res) {
    if (res.body === null || res.body === undefined) return '';
    return typeof res.body === 'string' ? res.body : DECODER.decode(res.body);
}

function asJson(res) {
    return JSON.parse(text(res));
}

function publishRequest(id, body, { token = TOKEN, box = BOX, extraHeaders = {} } = {}) {
    return req('POST', `/m/${box}/publish`, {
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/octet-stream',
            'x-note-id': id,
            ...extraHeaders,
        },
        body,
    });
}

function publish(store, id, body, opts = {}) {
    return call(store, publishRequest(id, body, opts), { writeToken: TOKEN, now: opts.now });
}

/** Memory store that records put order and can run a hook mid-publish. */
function instrumentedStore() {
    const inner = createMemoryStore();
    const puts = [];
    const deletes = [];
    let beforePut = null;
    return {
        map: inner.map,
        puts,
        deletes,
        setBeforePut(fn) {
            beforePut = fn;
        },
        async get(key) {
            return inner.get(key);
        },
        async put(key, value) {
            if (beforePut) await beforePut(key, value);
            puts.push(key);
            return inner.put(key, value);
        },
        async delete(key) {
            deletes.push(key);
            return inner.delete(key);
        },
    };
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('publish -> latest.txt -> current.frame round-trips byte-exactly', async () => {
    const store = createMemoryStore();
    const sent = frame(3);

    const published = await publish(store, 'note-2026-07-28-abc', sent, { now: () => 1_785_196_800_000 });
    assert.equal(published.status, 200);
    const payload = asJson(published);
    assert.equal(payload.ok, true);
    assert.equal(payload.id, 'note-2026-07-28-abc');
    assert.equal(payload.bytes, FRAME_BYTES);
    assert.equal(payload.updatedAt, '2026-07-28T00:00:00.000Z');

    const latest = await call(store, req('GET', `/m/${BOX}/latest.txt`));
    assert.equal(latest.status, 200);
    assert.equal(latest.headers['content-type'], 'text/plain; charset=utf-8');
    // No trailing newline, no whitespace: the app compares this id verbatim.
    assert.equal(text(latest), 'note-2026-07-28-abc');

    const got = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'application/octet-stream');
    assert.equal(got.headers['content-length'], String(FRAME_BYTES));
    assert.ok(got.body instanceof Uint8Array);
    assert.equal(got.body.byteLength, FRAME_BYTES);
    assert.deepEqual(got.body, sent);
});

test('every response is uncacheable', async () => {
    // A cached latest.txt pins the reader on the old id forever — it is the one
    // byte that decides whether the 51 KB frame is fetched at all.
    const store = createMemoryStore();
    await publish(store, 'n1', frame(1));
    for (const path of [`/m/${BOX}/latest.txt`, `/m/${BOX}/current.frame`, `/m/${BOX}/status`]) {
        const res = await call(store, req('GET', path, { headers: { authorization: `Bearer ${TOKEN}` } }));
        assert.equal(res.status, 200, path);
        assert.match(res.headers['cache-control'], /no-store/, path);
    }
});

test('status reports the pointer, and 200s with nulls on an empty box', async () => {
    const store = createMemoryStore();
    const empty = await call(store, req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(empty.status, 200);
    // `books` and `wallpapers` are additive: an empty ARRAY, never absent, so
    // the app never has to distinguish "none" from "a mailbox that predates the
    // route".
    assert.deepEqual(asJson(empty), {
        latestId: null,
        bytes: 0,
        updatedAt: null,
        books: [],
        wallpapers: [],
    });

    await publish(store, 'n1', frame(1), { now: () => 0 });
    const full = await call(store, req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.deepEqual(asJson(full), {
        latestId: 'n1',
        bytes: FRAME_BYTES,
        updatedAt: '1970-01-01T00:00:00.000Z',
        books: [],
        wallpapers: [],
    });
});

// ---------------------------------------------------------------------------
// Empty-box semantics (the firmware's "no note" path)
// ---------------------------------------------------------------------------

test('an empty box answers latest.txt 200 with a ZERO-LENGTH body, not 404', async () => {
    // MessageSync.cpp: a non-200 is a failed sync (logged error every wake);
    // an empty body is the documented "mailbox empty" signal.
    const store = createMemoryStore();
    const res = await call(store, req('GET', `/m/${BOX}/latest.txt`));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(text(res), '');
});

test('an empty box answers current.frame 404', async () => {
    const store = createMemoryStore();
    const res = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(res.status, 404);
});

test('boxes are isolated from each other', async () => {
    const store = createMemoryStore();
    await publish(store, 'mine', frame(1), { box: BOX });
    const other = await call(store, req('GET', `/m/${OTHER_BOX}/latest.txt`));
    assert.equal(other.status, 200);
    assert.equal(text(other), '');
    const otherFrame = await call(store, req('GET', `/m/${OTHER_BOX}/current.frame`));
    assert.equal(otherFrame.status, 404);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('publish and status require the bearer token; reads never do', async () => {
    const store = createMemoryStore();
    await publish(store, 'n1', frame(1));

    for (const bad of [
        undefined,
        '',
        'Bearer',
        'Bearer ',
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`, // correct prefix, one char short
        TOKEN, // no scheme
        `Basic ${TOKEN}`,
        `Bearer ${TOKEN.toUpperCase()}`,
    ]) {
        const headers = bad === undefined ? {} : { authorization: bad };
        const pub = await call(store, req('POST', `/m/${BOX}/publish`, { headers: { ...headers, 'x-note-id': 'n2' }, body: frame(2) }));
        assert.equal(pub.status, 401, `publish with authorization=${JSON.stringify(bad)}`);
        assert.equal(pub.headers['www-authenticate'], 'Bearer');
        const st = await call(store, req('GET', `/m/${BOX}/status`, { headers }));
        assert.equal(st.status, 401, `status with authorization=${JSON.stringify(bad)}`);
    }

    // The rejected publishes must not have touched anything.
    const latest = await call(store, req('GET', `/m/${BOX}/latest.txt`));
    assert.equal(text(latest), 'n1');

    // Reads stay open — the boxId IS the read capability.
    assert.equal((await call(store, req('GET', `/m/${BOX}/latest.txt`))).status, 200);
    assert.equal((await call(store, req('GET', `/m/${BOX}/current.frame`))).status, 200);
});

test('the bearer scheme is case-insensitive but the token is not', async () => {
    const store = createMemoryStore();
    const ok = await call(store, req('POST', `/m/${BOX}/publish`, {
        headers: { authorization: `bEaReR ${TOKEN}`, 'x-note-id': 'n1' },
        body: frame(1),
    }));
    assert.equal(ok.status, 200);
});

test('header lookup is case-insensitive', async () => {
    const store = createMemoryStore();
    const res = await call(store, req('POST', `/m/${BOX}/publish`, {
        headers: { AUTHORIZATION: `Bearer ${TOKEN}`, 'X-Note-Id': 'n1' },
        body: frame(1),
    }));
    assert.equal(res.status, 200);
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'n1');
});

test('an unset or weak write token fails CLOSED with 503, never open', async () => {
    // A blank WRITE_TOKEN secret must not silently turn the box id — which
    // travels in the reader's settings in clear — into a write capability.
    const store = createMemoryStore();
    for (const writeToken of [undefined, '', 'short', 'x'.repeat(MIN_WRITE_TOKEN_LEN - 1)]) {
        const res = await handleRequest(publishRequest('n1', frame(1)), store, { writeToken });
        assert.equal(res.status, 503, `writeToken=${JSON.stringify(writeToken)}`);
        assert.equal(asJson(res).error, 'not_configured');
        const st = await handleRequest(
            req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${writeToken ?? ''}` } }),
            store,
            { writeToken }
        );
        assert.equal(st.status, 503);
    }
    assert.equal(store.map.size, 0);
});

// ---------------------------------------------------------------------------
// Frame size
// ---------------------------------------------------------------------------

test('only an exactly-52272-byte body is accepted', async () => {
    const store = createMemoryStore();

    for (const size of [0, 1, FRAME_BYTES - 1]) {
        const res = await publish(store, 'n1', new Uint8Array(size));
        assert.equal(res.status, 400, `size ${size}`);
        assert.match(asJson(res).detail, /52272/);
    }
    const missing = await call(store, req('POST', `/m/${BOX}/publish`, {
        headers: { authorization: `Bearer ${TOKEN}`, 'x-note-id': 'n1' },
        body: null,
    }));
    assert.equal(missing.status, 400);

    for (const size of [FRAME_BYTES + 1, FRAME_BYTES * 2]) {
        const res = await publish(store, 'n1', new Uint8Array(size));
        assert.equal(res.status, 413, `size ${size}`);
    }

    // Nothing partially-sized ever reached the store.
    assert.equal(store.map.size, 0);
    assert.equal((await call(store, req('GET', `/m/${BOX}/current.frame`))).status, 404);

    assert.equal((await publish(store, 'n1', frame(1))).status, 200);
});

test('a rejected publish leaves the previous note intact', async () => {
    const store = createMemoryStore();
    await publish(store, 'good', frame(1));
    assert.equal((await publish(store, 'bad', new Uint8Array(FRAME_BYTES - 1))).status, 400);
    assert.equal((await publish(store, 'bad', new Uint8Array(FRAME_BYTES + 9))).status, 413);
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'good');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(1));
});

// ---------------------------------------------------------------------------
// Note ids
// ---------------------------------------------------------------------------

test('X-Note-Id is trimmed the way the firmware trims it', async () => {
    // MessageSync.cpp trimId() strips space/tab/CR/LF, so an id published with
    // padding would round-trip to something else and break wake dedup.
    assert.equal(trimNoteId('  note-1 \r\n'), 'note-1');
    assert.equal(trimNoteId('\t\t'), '');

    const store = createMemoryStore();
    const res = await publish(store, '  note-1\n', frame(1));
    assert.equal(res.status, 200);
    assert.equal(asJson(res).id, 'note-1');
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-1');
});

test('a bad X-Note-Id is rejected, never truncated or sanitised', async () => {
    const store = createMemoryStore();
    const bad = [
        undefined, // header absent
        '',
        '   ',
        '\t\r\n',
        'a'.repeat(NOTE_ID_MAX_LEN + 1), // too long: truncating would collide ids
        'has space',
        'has/slash',
        'has\\backslash',
        'has"quote',
        'café',
        ' nul',
        'semi;colon',
        'per%cent',
    ];
    for (const id of bad) {
        const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' };
        if (id !== undefined) headers['x-note-id'] = id;
        const res = await call(store, req('POST', `/m/${BOX}/publish`, { headers, body: frame(1) }));
        assert.equal(res.status, 400, `id=${JSON.stringify(id)}`);
    }
    assert.equal(store.map.size, 0);

    // Exactly at the limit is fine.
    const atLimit = 'a'.repeat(NOTE_ID_MAX_LEN);
    const ok = await publish(store, atLimit, frame(1));
    assert.equal(ok.status, 200);
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), atLimit);
});

// ---------------------------------------------------------------------------
// Ordering / last-write-wins
// ---------------------------------------------------------------------------

test('republishing overwrites: last write wins on both the frame and the id', async () => {
    const store = createMemoryStore();
    await publish(store, 'first', frame(1));
    await publish(store, 'second', frame(2));
    await publish(store, 'third', frame(3));

    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'third');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(3));
    // Bounded, and bounded by GC rather than by overwriting: the pointer, the
    // current frame, and exactly ONE retained predecessor. 'first' is collected.
    assert.deepEqual(
        [...store.map.keys()].sort(),
        [metaKey(BOX), frameKey(BOX, 'second'), frameKey(BOX, 'third')].sort()
    );
});

test('republishing under the SAME id does not collect the frame it just wrote', async () => {
    // A retry of the same note re-POSTs the same X-Note-Id. If the GC treated
    // "the previous latestId" as collectable unconditionally it would delete the
    // frame this very publish stored, and current.frame would 404 forever.
    const store = createMemoryStore();
    await publish(store, 'same', frame(1));
    await publish(store, 'same', frame(2));

    const got = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, frame(2));
    assert.deepEqual([...store.map.keys()].sort(), [metaKey(BOX), frameKey(BOX, 'same')].sort());
});

test('the frame is committed BEFORE the id pointer moves, under its OWN id', async () => {
    const store = instrumentedStore();

    await publish(store, 'note-one', frame(1));
    assert.deepEqual(store.puts, [frameKey(BOX, 'note-one'), metaKey(BOX)]);

    // Observe the mailbox from "another request" in the window between the two
    // writes. Because the frame key is content-addressed, writing note-two's
    // frame does not disturb note-one's: an observer in that window sees the OLD
    // id AND the OLD bytes — a consistent pair, not a skew. With a single
    // mutable frame slot this is where latest.txt said note-one while
    // current.frame already served note-two's pixels.
    const observed = [];
    store.setBeforePut(async (key) => {
        if (key !== metaKey(BOX)) return;
        const latest = await call(store, req('GET', `/m/${BOX}/latest.txt`));
        const current = await call(store, req('GET', `/m/${BOX}/current.frame`));
        observed.push({ latestId: text(latest), firstByte: current.body[0], size: current.body.byteLength });
    });

    await publish(store, 'note-two', frame(2));

    assert.notEqual(frame(1)[0], frame(2)[0]);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].latestId, 'note-one');
    assert.equal(observed[0].size, FRAME_BYTES);
    assert.equal(observed[0].firstByte, frame(1)[0], 'the id and the bytes must belong together');

    // Once the publish returns, the pointer has moved.
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-two');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(2));
});

test('a fresh pointer with an unreplicated frame 404s — never someone else\'s bytes', async () => {
    // THE P1 THIS DESIGN EXISTS FOR. Workers KV caches reads and replicates
    // writes PER KEY, so a colo can hold the newest pointer next to a 60-second
    // -old frame. Simulated here by moving the pointer to an id whose frame is
    // not present. A wrong-but-52272-byte frame would pass the firmware's size
    // gate, be staged under the new id, rendered, and then deduped away forever
    // — permanent, silent loss of that note. A 404 costs one retry.
    const store = createMemoryStore();
    await publish(store, 'old-note', frame(1));
    await store.put(
        metaKey(BOX),
        new TextEncoder().encode(
            JSON.stringify({ v: 2, latestId: 'new-note', previousId: 'old-note', bytes: FRAME_BYTES, updatedAt: null })
        )
    );

    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'new-note');
    const got = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(got.status, 404, 'must not serve old-note bytes under new-note id');
});

test('the immediately previous frame is RETAINED, so a stale pointer stays consistent', async () => {
    // The other half of the same story: a replica whose pointer is stale must
    // serve the OLD id with the OLD frame — a delayed but correct pair, which is
    // the "misses by one cycle" behaviour the README documents as benign. That
    // only works if the previous note's frame is still there.
    const store = instrumentedStore();
    await publish(store, 'n1', frame(1));
    await publish(store, 'n2', frame(2));
    await publish(store, 'n3', frame(3));

    assert.equal(store.deletes.length, 1);
    assert.deepEqual(store.deletes, [frameKey(BOX, 'n1')]);
    assert.equal(await store.get(frameKey(BOX, 'n2')) !== null, true, 'previous frame must survive');

    // Rewind the pointer the way a lagging replica would present it.
    await store.put(
        metaKey(BOX),
        new TextEncoder().encode(JSON.stringify({ v: 2, latestId: 'n2', previousId: 'n1', bytes: FRAME_BYTES, updatedAt: null }))
    );
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'n2');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(2));
});

test('a store with no delete() still publishes; frames simply accumulate', async () => {
    // `delete` is optional on the store contract. GC is a cost optimisation, and
    // a store that cannot do it must never turn a delivered note into a failure.
    const inner = createMemoryStore();
    const store = { get: (k) => inner.get(k), put: (k, v) => inner.put(k, v) };
    assert.equal((await publish(store, 'n1', frame(1))).status, 200);
    assert.equal((await publish(store, 'n2', frame(2))).status, 200);
    assert.equal((await publish(store, 'n3', frame(3))).status, 200);
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(3));
    assert.equal(inner.map.size, 4); // meta + three frames, nothing collected
});

test('a publish BETWEEN the reader\'s two GETs skips one note and repeats the next', async () => {
    // THE RESIDUAL RACE, pinned so the trade-off is stated rather than implied.
    // The firmware reads latest.txt and current.frame in two requests ~1-2 s
    // apart and stages the bytes under the id it read FIRST. Nothing on this
    // side can bind them: the frame URL is a fixed /current.frame with no id in
    // it. So a publish landing inside that window is visible to the reader.
    //
    // Unlike the KV cross-key case above this is SELF-CORRECTING — the newest
    // note always ends up displayed, it is only shown twice while the note it
    // overtook is skipped.
    const store = createMemoryStore();
    await publish(store, 'X', frame(1));

    // Reader: GET latest.txt
    const seenId = text(await call(store, req('GET', `/m/${BOX}/latest.txt`)));
    assert.equal(seenId, 'X');

    // Someone publishes Y before the reader's second request.
    await publish(store, 'Y', frame(2));

    // Reader: GET current.frame -> Y's bytes, which it stages under id X.
    const downloaded = (await call(store, req('GET', `/m/${BOX}/current.frame`))).body;
    assert.deepEqual(downloaded, frame(2), 'the bytes are Y even though the id read was X');

    // Next sync: latest.txt is Y != the X it recorded as shown, so it downloads
    // and renders Y again — correctly, and for good.
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'Y');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(2));
});

test('a failed id-pointer write reports published:false and keeps the old id', async () => {
    const store = instrumentedStore();
    await publish(store, 'note-one', frame(1));
    store.setBeforePut(async (key) => {
        if (key === metaKey(BOX)) throw new Error('kv unavailable');
    });

    const res = await publish(store, 'note-two', frame(2));
    assert.equal(res.status, 503);
    assert.equal(asJson(res).published, false);
    // The reader still sees note-one and will not fetch; nothing is corrupted —
    // and because the frame key carries the id, note-two's orphaned frame cannot
    // be served under note-one's id either.
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-one');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(1));
});

// ---------------------------------------------------------------------------
// Path parsing: trailing slashes, traversal, malformed box ids
// ---------------------------------------------------------------------------

test('trailing and duplicated slashes are tolerated', async () => {
    // The app may persist the base WITH a trailing slash; the firmware only
    // strips trailing slashes from its own copy before appending the suffix.
    const store = createMemoryStore();
    await publish(store, 'n1', frame(1));
    for (const path of [
        `/m/${BOX}/latest.txt`,
        `/m/${BOX}/latest.txt/`,
        `/m/${BOX}//latest.txt`,
        `//m//${BOX}//latest.txt//`,
        `/m/${BOX}/latest.txt?cachebust=1`,
    ]) {
        const res = await call(store, req('GET', path));
        assert.equal(res.status, 200, path);
        assert.equal(text(res), 'n1', path);
    }
});

test('malformed box ids are rejected structurally', () => {
    for (const boxId of [
        'a'.repeat(21), // too short -> not enough entropy to be a capability
        'a'.repeat(65), // too long
        '..',
        '.',
        'has.dot.in.it.padded.xx',
        'has+plus+padded+xxxxxx',
        'has=equals=padded=xxxx',
        '%2e%2e%2e%2e%2e%2e%2e%2e%2e%2e%2e',
        'sp ace padded xxxxxxxxx',
    ]) {
        assert.equal(parsePath(`/m/${boxId}/latest.txt`), null, boxId);
        assert.equal(BOX_ID_PATTERN.test(boxId), false, boxId);
    }
    assert.deepEqual(parsePath(`/m/${BOX}/latest.txt`), { boxId: BOX, leaf: 'latest.txt' });
});

test('path traversal and off-contract paths are 404, never a store read', async () => {
    const store = createMemoryStore();
    await publish(store, 'n1', frame(1));
    for (const path of [
        '/',
        '',
        '/m',
        `/m/${BOX}`,
        `/m/${BOX}/`,
        `/m/${BOX}/latest.txt/extra`,
        `/m/${BOX}/../../etc/passwd`,
        `/m/${BOX}/../${OTHER_BOX}/latest.txt`,
        '/m/../../etc/passwd/latest.txt',
        '/m/%2e%2e/latest.txt',
        `/M/${BOX}/latest.txt`, // segment "m" is case-sensitive
        `/mailbox/${BOX}/latest.txt`,
        `/m/${BOX}/current.frame.bak`,
        `/m/${BOX}/index.html`,
        `/m/${BOX}/latest`,
        `/m/${BOX}/frame`,
        `/${BOX}/latest.txt`,
        `/m/${BOX}/latest.txt/../current.frame`,
    ]) {
        const res = await call(store, req('GET', path));
        assert.equal(res.status, 404, `path=${JSON.stringify(path)}`);
    }
    assert.equal(await call(store, req('GET', 'x'.repeat(600))).then((r) => r.status), 404);
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

test('methods are constrained per route', async () => {
    const store = createMemoryStore();
    await publish(store, 'n1', frame(1));

    for (const [method, leaf] of [
        ['POST', 'latest.txt'],
        ['PUT', 'latest.txt'],
        ['DELETE', 'current.frame'],
        ['POST', 'current.frame'],
        ['GET', 'publish'],
        ['PUT', 'publish'],
        ['DELETE', 'status'],
        ['OPTIONS', 'latest.txt'],
    ]) {
        const res = await call(store, req(method, `/m/${BOX}/${leaf}`, {
            headers: { authorization: `Bearer ${TOKEN}`, 'x-note-id': 'n2' },
            body: leaf === 'publish' ? frame(2) : null,
        }));
        assert.equal(res.status, 405, `${method} ${leaf}`);
        assert.ok(res.headers.allow, `${method} ${leaf} needs an Allow header`);
    }
});

test('HEAD is answered with headers and no body', async () => {
    const store = createMemoryStore();
    await publish(store, 'n1', frame(1));
    const head = await call(store, req('HEAD', `/m/${BOX}/current.frame`));
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    assert.equal(head.headers['content-length'], String(FRAME_BYTES));
});

// ---------------------------------------------------------------------------
// Corruption tolerance
// ---------------------------------------------------------------------------

test('a corrupt or unreadable id pointer degrades to "no note", not a 500', async () => {
    // A mailbox that goes quiet is a normal wake for the reader; a 500 is a
    // logged error on every wake until someone notices.
    const encoder = new TextEncoder();
    for (const junk of ['', 'not json', '{}', '{"latestId":null}', '{"latestId":"has space"}', '[1,2,3]']) {
        const store = createMemoryStore();
        await store.put(frameKey(BOX, 'n1'), frame(1));
        await store.put(metaKey(BOX), encoder.encode(junk));
        const res = await call(store, req('GET', `/m/${BOX}/latest.txt`));
        assert.equal(res.status, 200, junk);
        assert.equal(text(res), '', junk);
        // An unreadable pointer names no frame, so there is nothing to serve —
        // and 404 is the same answer as "this box never had a note".
        assert.equal((await call(store, req('GET', `/m/${BOX}/current.frame`))).status, 404, junk);
    }
});

test('a wrong-sized stored frame is refused rather than served', async () => {
    // Unreachable via publish; this guards a storage-layer corruption from
    // costing the reader a 51 KB download inside its battery-budgeted wake.
    const store = createMemoryStore();
    await store.put(frameKey(BOX, 'n1'), new Uint8Array(FRAME_BYTES - 1));
    await store.put(
        metaKey(BOX),
        new TextEncoder().encode(JSON.stringify({ v: 2, latestId: 'n1', bytes: FRAME_BYTES, updatedAt: null }))
    );
    const res = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(res.status, 500);
    assert.equal(asJson(res).error, 'corrupt_frame');
});

test('a store whose reads throw does not take the mailbox down', async () => {
    const store = {
        async get() {
            throw new Error('kv unavailable');
        },
        async put() {},
    };
    const latest = await call(store, req('GET', `/m/${BOX}/latest.txt`));
    assert.equal(latest.status, 200);
    assert.equal(text(latest), '');
    const current = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(current.status, 500);
});

// ---------------------------------------------------------------------------
// Helpers used by the dev server / provisioning
// ---------------------------------------------------------------------------

test('the reader URL budget is 127 chars, and a workers.dev base fits it', () => {
    // CrossPointSettings.h declares `char messageSyncUrl[128]` and
    // CrossPointSettings.cpp copies with `strncpy(dest, src, maxLen - 1)`, so a
    // 128th character is silently dropped and the reader polls a mangled URL.
    assert.equal(READER_URL_MAX_LEN, 127);
    assert.equal(checkReaderUrlBudget('x'.repeat(127)).ok, true);
    assert.equal(checkReaderUrlBudget('x'.repeat(128)).ok, false);
    assert.equal(checkReaderUrlBudget('').ok, false);

    const base = buildBaseUrl('https://xteink-mailbox.a-longish-account-name.workers.dev', BOX);
    assert.equal(base, `https://xteink-mailbox.a-longish-account-name.workers.dev/m/${BOX}`);
    const budget = checkReaderUrlBudget(base);
    assert.ok(budget.ok, `base URL is ${budget.length} chars, limit ${budget.limit}`);
    assert.ok(budget.remaining > 0);
});

test('buildBaseUrl strips trailing slashes from the origin', () => {
    assert.equal(buildBaseUrl('https://h.example///', BOX), `https://h.example/m/${BOX}`);
    assert.equal(buildBaseUrl('http://192.168.1.5:8790', BOX), `http://192.168.1.5:8790/m/${BOX}`);
});

test('generated ids and tokens satisfy their own validators', () => {
    const ids = new Set();
    for (let i = 0; i < 64; i++) {
        const id = generateBoxId();
        assert.equal(id.length, 22, id);
        assert.ok(BOX_ID_PATTERN.test(id), id);
        ids.add(id);
    }
    assert.equal(ids.size, 64, 'generated box ids must not repeat');

    const token = generateWriteToken();
    assert.ok(token.length >= MIN_WRITE_TOKEN_LEN);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('base64UrlEncode is url-safe and unpadded at every length mod 3', () => {
    assert.equal(base64UrlEncode(new Uint8Array(0)), '');
    assert.equal(base64UrlEncode(new Uint8Array([0x66])), 'Zg');
    assert.equal(base64UrlEncode(new Uint8Array([0x66, 0x6f])), 'Zm8');
    assert.equal(base64UrlEncode(new Uint8Array([0x66, 0x6f, 0x6f])), 'Zm9v');
    // 0xfb 0xff exercises the two chars that differ from standard base64.
    assert.equal(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
});

test('timingSafeEqualStr agrees with === and has no early exit', () => {
    assert.equal(timingSafeEqualStr('', ''), true);
    assert.equal(timingSafeEqualStr(TOKEN, TOKEN), true);
    assert.equal(timingSafeEqualStr(TOKEN, `${TOKEN}x`), false);
    assert.equal(timingSafeEqualStr(TOKEN, TOKEN.slice(0, -1)), false);
    assert.equal(timingSafeEqualStr('a', 'b'), false);
    assert.equal(timingSafeEqualStr('café', 'café'), true);
    assert.equal(timingSafeEqualStr(null, undefined), true); // both coerce to ''
});

test('headerGet reads plain objects, Maps and Headers alike', () => {
    assert.equal(headerGet({ 'X-Note-Id': 'a' }, 'x-note-id'), 'a');
    assert.equal(headerGet({ 'x-note-id': ['a', 'b'] }, 'X-Note-Id'), 'a');
    assert.equal(headerGet({}, 'x-note-id'), null);
    assert.equal(headerGet(null, 'x-note-id'), null);
    assert.equal(headerGet(new Headers({ 'x-note-id': 'h' }), 'X-Note-Id'), 'h');
});

// ===========================================================================
// BOOKS — epub delivery over the same mailbox
//
// The reader-side half of this is a FUTURE firmware milestone, which makes these
// tests the only definition of the contract it will be built against: there is
// no device to compare against yet, so a wrong manifest byte or an off-by-one
// range would be discovered months from now, in C, on a board that is asleep.
// Everything the reader has to rely on is pinned here.
// ===========================================================================

/** Deterministic, seed-distinguishable "epub". Not a real zip; the mailbox is a byte pipe. */
function epub(bytes, seed = 1) {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = (i * 17 + seed * 101) & 0xff;
    return out;
}

function bookPostRequest(id, filename, body, { token = TOKEN, box = BOX, extraHeaders = {} } = {}) {
    const headers = { 'content-type': 'application/octet-stream', ...extraHeaders };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (id !== undefined) headers['x-book-id'] = id;
    if (filename !== undefined) headers['x-filename'] = filename;
    return req('POST', `/m/${box}/books`, { headers, body });
}

function postBook(store, id, filename, body, opts = {}) {
    return call(store, bookPostRequest(id, filename, body, opts), { writeToken: TOKEN, now: opts.now });
}

function getBook(store, id, { range = null, method = 'GET', box = BOX } = {}) {
    const headers = {};
    if (range !== null) headers.range = range;
    return call(store, req(method, `/m/${box}/books/${id}`, { headers }));
}

function deleteBook(store, id, { token = TOKEN, box = BOX } = {}) {
    const headers = token === null ? {} : { authorization: `Bearer ${token}` };
    return call(store, req('DELETE', `/m/${box}/books/${id}`, { headers }));
}

function manifest(store, { box = BOX, method = 'GET' } = {}) {
    return call(store, req(method, `/m/${box}/books.txt`));
}

/**
 * Memory store PLUS the optional `stat`/`getRange` pair.
 *
 * Two code paths serve a range — slice-a-full-`get` (KV, the memory store) and
 * read-the-window (the dev server's file store) — and a reader resuming across
 * wake windows must get identical bytes from either. This store is what makes
 * the second path testable without a filesystem.
 */
function rangedStore() {
    const inner = createMemoryStore();
    return {
        map: inner.map,
        reads: [],
        get: (k) => inner.get(k),
        put: (k, v) => inner.put(k, v),
        delete: (k) => inner.delete(k),
        async stat(key) {
            const value = inner.map.get(key);
            return value ? { bytes: value.byteLength } : null;
        },
        async getRange(key, start, length) {
            const value = inner.map.get(key);
            if (!value) return null;
            this.reads.push({ key, start, length });
            return new Uint8Array(value.subarray(start, start + length));
        },
    };
}

// ---------------------------------------------------------------------------
// Manifest: the bytes the reader diffs against its SD card
// ---------------------------------------------------------------------------

test('books.txt is byte-exact: "{id} {bytes} {filename}\\n", newest first', async () => {
    const store = createMemoryStore();

    // An empty library is a ZERO-LENGTH 200, never a 404 — same rule as
    // latest.txt, and for the same reason: the firmware logs a non-200 as a
    // failed sync, so an empty box would produce an error on every wake.
    const empty = await manifest(store);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(text(empty), '');
    assert.equal(empty.headers['content-length'], '0');

    assert.equal((await postBook(store, 'bk-1', 'Dune.epub', epub(1000, 1))).status, 200);
    assert.equal((await postBook(store, 'bk-2', 'The Hobbit.epub', epub(2048, 2))).status, 200);

    const res = await manifest(store);
    assert.equal(res.status, 200);
    // Byte-exact, newest first, no header line, one LF per entry and nothing else.
    assert.equal(text(res), 'bk-2 2048 The Hobbit.epub\nbk-1 1000 Dune.epub\n');
    assert.equal(res.headers['content-length'], String(text(res).length));
    assert.match(res.headers['cache-control'], /no-store/);

    // A filename may contain a space; it is the REST of the line, so a reader
    // scans to the first two spaces and takes the remainder.
    const line = text(res).split('\n')[0];
    assert.equal(line.split(' ', 2).join(' '), 'bk-2 2048');
    assert.equal(line.slice('bk-2 2048 '.length), 'The Hobbit.epub');

    // No auth: the boxId is the read capability, exactly as for latest.txt.
    assert.equal((await manifest(store)).status, 200);
});

test('renderBooksManifest is a pure function of the entries', () => {
    assert.equal(renderBooksManifest([]), '');
    assert.equal(renderBooksManifest([{ id: 'a', bytes: 1, filename: 'x.epub' }]), 'a 1 x.epub\n');
    assert.equal(
        renderBooksManifest([
            { id: 'a', bytes: 1, filename: 'x.epub' },
            { id: 'b', bytes: 22, filename: 'y z.epub' },
        ]),
        'a 1 x.epub\nb 22 y z.epub\n'
    );
});

test('a corrupt manifest degrades to an empty library, and can never forge a line', async () => {
    // Same reasoning as the corrupt id pointer: an empty library is a normal
    // wake, a 500 is a logged error on every one. The round-trip check on each
    // stored filename is what stops a value containing an LF from turning one
    // entry into two — which would name a book whose bytes do not exist.
    const encoder = new TextEncoder();
    for (const junk of [
        '',
        'not json',
        '{}',
        '{"books":"nope"}',
        '[1,2,3]',
        '{"v":1,"books":[{"id":"ok","bytes":5,"filename":"a.epub\\nforged 9 evil.epub"}]}',
        '{"v":1,"books":[{"id":"has space","bytes":5,"filename":"a.epub"}]}',
        '{"v":1,"books":[{"id":"..","bytes":5,"filename":"a.epub"}]}',
        '{"v":1,"books":[{"id":"ok","bytes":5,"filename":"../../etc/passwd.epub"}]}',
        '{"v":1,"books":[{"id":"ok","bytes":0,"filename":"a.epub"}]}',
        '{"v":1,"books":[{"id":"ok","bytes":-1,"filename":"a.epub"}]}',
        `{"v":1,"books":[{"id":"ok","bytes":${MAX_BOOK_BYTES + 1},"filename":"a.epub"}]}`,
        '{"v":1,"books":[{"id":"ok","bytes":5,"filename":"no-extension"}]}',
    ]) {
        const store = createMemoryStore();
        await store.put(booksIndexKey(BOX), encoder.encode(junk));
        const res = await manifest(store);
        assert.equal(res.status, 200, junk);
        assert.equal(text(res), '', junk);
        // Nothing the manifest does not name is reachable.
        assert.equal((await getBook(store, 'ok')).status, 404, junk);
    }
});

test('a manifest with more than MAX_BOOKS entries is truncated on read', async () => {
    // A corrupt or hand-edited index must not make the reader download a
    // thousand-line manifest inside a battery-budgeted wake window.
    const books = [];
    for (let i = 0; i < MAX_BOOKS * 3; i++) books.push({ id: `b${i}`, bytes: 10, filename: `f${i}.epub` });
    const store = createMemoryStore();
    await store.put(booksIndexKey(BOX), new TextEncoder().encode(JSON.stringify({ v: 1, books })));
    const lines = text(await manifest(store)).split('\n').filter(Boolean);
    assert.equal(lines.length, MAX_BOOKS);
    assert.equal(lines[0], 'b0 10 f0.epub');
});

// ---------------------------------------------------------------------------
// Round trip and Range — the resume mechanism
// ---------------------------------------------------------------------------

test('a published book downloads byte-exactly, and advertises Accept-Ranges', async () => {
    const store = createMemoryStore();
    const sent = epub(4096, 7);
    const posted = await postBook(store, 'bk-1', 'Dune.epub', sent);
    assert.deepEqual(asJson(posted), { ok: true, id: 'bk-1', filename: 'Dune.epub', bytes: 4096 });

    const got = await getBook(store, 'bk-1');
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'application/epub+zip');
    assert.equal(got.headers['content-length'], '4096');
    // Advertised on the FULL response too: it is how a client discovers that
    // resuming is possible before it has anything to resume.
    assert.equal(got.headers['accept-ranges'], 'bytes');
    assert.equal(got.headers['content-disposition'], 'attachment; filename="Dune.epub"');
    assert.equal(got.headers['content-range'], undefined);
    assert.deepEqual(got.body, sent);

    // No auth on the read path.
    assert.equal((await getBook(store, 'bk-1')).status, 200);
    assert.equal((await getBook(store, 'nope')).status, 404);
});

test('a mid-file Range returns exactly that slice of the full body', async () => {
    // THE POINT OF THE WHOLE ROUTE. An ESP32 wake window is seconds long, so a
    // 3 MB epub arrives over several windows and each one asks for the bytes
    // after what the SD card already holds. A slice that is off by one, or that
    // reports the wrong Content-Range, produces a corrupt epub the reader has no
    // way to detect.
    const store = createMemoryStore();
    const sent = epub(10_000, 3);
    await postBook(store, 'bk-1', 'Dune.epub', sent);

    const res = await getBook(store, 'bk-1', { range: 'bytes=4096-8191' });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 4096-8191/10000');
    assert.equal(res.headers['content-length'], '4096');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.body.byteLength, 4096);
    assert.deepEqual(res.body, sent.subarray(4096, 8192));
});

test('an open-ended Range resumes to the end of the book, and the pieces re-assemble', async () => {
    const store = createMemoryStore();
    const sent = epub(9999, 5);
    await postBook(store, 'bk-1', 'Dune.epub', sent);

    // Three bounded windows, the way the reader will actually do it.
    const window = 4000;
    const chunks = [];
    let have = 0;
    while (have < sent.byteLength) {
        const res = await getBook(store, 'bk-1', { range: `bytes=${have}-${have + window - 1}` });
        assert.equal(res.status, 206, `at offset ${have}`);
        const [, start, end, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range']);
        assert.equal(Number(start), have);
        // The total in every Content-Range is what the reader compares against
        // the `bytes` field from books.txt to notice a book changing mid-resume.
        assert.equal(Number(total), sent.byteLength);
        assert.equal(res.body.byteLength, Number(end) - Number(start) + 1);
        chunks.push(res.body);
        have = Number(end) + 1;
    }
    assert.equal(chunks.length, 3);
    const stitched = new Uint8Array(have);
    let offset = 0;
    for (const chunk of chunks) {
        stitched.set(chunk, offset);
        offset += chunk.byteLength;
    }
    assert.deepEqual(stitched, sent, 'resumed windows must re-assemble into the original epub');

    // Open-ended from an offset: everything that is left.
    const tail = await getBook(store, 'bk-1', { range: 'bytes=9000-' });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers['content-range'], 'bytes 9000-9998/9999');
    assert.deepEqual(tail.body, sent.subarray(9000));

    // Exactly the last byte, and exactly the whole thing by explicit range.
    const last = await getBook(store, 'bk-1', { range: 'bytes=9998-9998' });
    assert.equal(last.status, 206);
    assert.equal(last.headers['content-range'], 'bytes 9998-9998/9999');
    assert.deepEqual(last.body, sent.subarray(9998));

    const whole = await getBook(store, 'bk-1', { range: 'bytes=0-9998' });
    assert.equal(whole.status, 206, 'an explicit full range is still a 206');
    assert.deepEqual(whole.body, sent);

    // A window that overshoots the end is CLAMPED, not refused — that is what
    // lets the reader use a fixed window size without knowing the length.
    const over = await getBook(store, 'bk-1', { range: 'bytes=9990-99999' });
    assert.equal(over.status, 206);
    assert.equal(over.headers['content-range'], 'bytes 9990-9998/9999');
    assert.deepEqual(over.body, sent.subarray(9990));

    // Suffix range: the last n bytes.
    const suffix = await getBook(store, 'bk-1', { range: 'bytes=-100' });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-range'], 'bytes 9899-9998/9999');
    assert.deepEqual(suffix.body, sent.subarray(9899));
});

test('an unsatisfiable Range is 416 with the total size, so a client can recover', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(500, 1));

    for (const range of ['bytes=500-', 'bytes=501-600', 'bytes=9999-', 'bytes=5-2', 'bytes=-0']) {
        const res = await getBook(store, 'bk-1', { range });
        assert.equal(res.status, 416, range);
        // Without the total the client has nothing to correct its offset to and
        // would retry the same bad range on every wake, forever.
        assert.equal(res.headers['content-range'], 'bytes */500', range);
        assert.equal(res.headers['accept-ranges'], 'bytes', range);
        assert.equal(asJson(res).error, 'range_not_satisfiable', range);
        assert.equal(asJson(res).bytes, 500, range);
    }
});

test('a Range this server does not honour is IGNORED, and answers the full body', async () => {
    // RFC 9110 lets a server ignore a Range it does not support, and ignoring is
    // the right answer: 416 for a speculative or malformed header would break a
    // client that can perfectly well take the whole file. Multi-range is ignored
    // rather than implemented because multipart/byteranges is a second body
    // format for an ESP32 to parse, and a resume needs exactly one range.
    const store = createMemoryStore();
    const sent = epub(500, 1);
    await postBook(store, 'bk-1', 'Dune.epub', sent);

    for (const range of [
        'bytes=0-1,4-5',
        'items=0-1',
        'bytes',
        'bytes=',
        'bytes=-',
        'bytes=abc-def',
        '',
        `bytes=0-${'9'.repeat(200)}`,
    ]) {
        const res = await getBook(store, 'bk-1', { range });
        assert.equal(res.status, 200, JSON.stringify(range));
        assert.equal(res.headers['content-range'], undefined, JSON.stringify(range));
        assert.deepEqual(res.body, sent, JSON.stringify(range));
    }
});

test('parseByteRange decides ignore vs 416 vs clamp', () => {
    assert.equal(parseByteRange(null, 100), null);
    assert.equal(parseByteRange(undefined, 100), null);
    assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseByteRange('bytes=10-', 100), { start: 10, end: 99 });
    assert.deepEqual(parseByteRange('BYTES=10-20', 100), { start: 10, end: 20 });
    assert.deepEqual(parseByteRange('bytes = 10 - 20 ', 100), { start: 10, end: 20 });
    assert.deepEqual(parseByteRange('bytes=0-99999', 100), { start: 0, end: 99 }, 'clamped');
    assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 }, 'suffix');
    assert.deepEqual(parseByteRange('bytes=-999', 100), { start: 0, end: 99 }, 'suffix past the start');
    assert.deepEqual(parseByteRange('bytes=99-99', 100), { start: 99, end: 99 });
    assert.deepEqual(parseByteRange('bytes=0000-0005', 100), { start: 0, end: 5 }, 'leading zeros');

    assert.deepEqual(parseByteRange('bytes=100-', 100), { unsatisfiable: true });
    assert.deepEqual(parseByteRange('bytes=20-10', 100), { unsatisfiable: true });
    assert.deepEqual(parseByteRange('bytes=-0', 100), { unsatisfiable: true });
    assert.deepEqual(parseByteRange('bytes=0-0', 0), { unsatisfiable: true }, 'any range on an empty body');

    assert.equal(parseByteRange('bytes=0-1,4-5', 100), null, 'multi-range is ignored');
    assert.equal(parseByteRange('items=0-1', 100), null, 'unknown unit is ignored');
    // 2^53 is past Number.MAX_SAFE_INTEGER: a first-byte-pos we cannot represent
    // is refused, a last-byte-pos we cannot represent is clamped.
    assert.deepEqual(parseByteRange('bytes=9007199254740993-', 100), { unsatisfiable: true });
    assert.deepEqual(parseByteRange('bytes=0-9007199254740993', 100), { start: 0, end: 99 });
});

test('HEAD reports the size and the range without a body', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(2000, 4));

    const head = await getBook(store, 'bk-1', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    assert.equal(head.headers['content-length'], '2000');
    assert.equal(head.headers['accept-ranges'], 'bytes');

    const ranged = await getBook(store, 'bk-1', { method: 'HEAD', range: 'bytes=100-199' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.body, null);
    assert.equal(ranged.headers['content-range'], 'bytes 100-199/2000');
    assert.equal(ranged.headers['content-length'], '100');

    const manifestHead = await manifest(store, { method: 'HEAD' });
    assert.equal(manifestHead.status, 200);
    assert.equal(manifestHead.body, null);
    assert.equal(manifestHead.headers['content-length'], String('bk-1 2000 Dune.epub\n'.length));
});

test('a store WITH stat+getRange serves the same bytes as one without', async () => {
    // Two code paths reach the same slice: read-the-window (the dev server's file
    // store, which is what keeps a 24 MB book from being materialised per
    // request) and slice-a-full-get (Workers KV, which has no ranged read). A
    // reader resuming across wake windows must not be able to tell them apart.
    const plain = createMemoryStore();
    const ranged = rangedStore();
    const sent = epub(8000, 9);
    for (const store of [plain, ranged]) {
        assert.equal((await postBook(store, 'bk-1', 'Dune.epub', sent)).status, 200);
    }

    for (const range of [null, 'bytes=0-99', 'bytes=4000-5999', 'bytes=7999-', 'bytes=-50']) {
        const a = await getBook(plain, 'bk-1', { range });
        const b = await getBook(ranged, 'bk-1', { range });
        assert.equal(a.status, b.status, String(range));
        assert.equal(a.headers['content-range'], b.headers['content-range'], String(range));
        assert.equal(a.headers['content-length'], b.headers['content-length'], String(range));
        assert.deepEqual(b.body, a.body, String(range));
    }
    // The ranged store really was asked for windows, not whole values.
    assert.deepEqual(
        ranged.reads.map((r) => `${r.start}+${r.length}`),
        ['0+8000', '0+100', '4000+2000', '7999+1', '7950+50']
    );

    // A HEAD on the ranged path must not read any bytes at all.
    const before = ranged.reads.length;
    assert.equal((await getBook(ranged, 'bk-1', { method: 'HEAD' })).status, 200);
    assert.equal(ranged.reads.length, before, 'HEAD must not read the body');
});

// ---------------------------------------------------------------------------
// Caps and eviction
// ---------------------------------------------------------------------------

test('a book over MAX_BOOK_BYTES is 413, and exactly at the cap is accepted', async () => {
    const store = createMemoryStore();
    // Allocated once; the at-cap case is a VIEW of the same buffer, so this test
    // costs one 24 MB allocation, not two.
    const oversize = new Uint8Array(MAX_BOOK_BYTES + 1);
    const res = await postBook(store, 'bk-1', 'Huge.epub', oversize);
    assert.equal(res.status, 413);
    assert.equal(asJson(res).error, 'book_too_large');
    assert.match(asJson(res).detail, new RegExp(String(MAX_BOOK_BYTES)));
    assert.equal(store.map.size, 0, 'nothing oversized may reach the store');

    const atCap = await postBook(store, 'bk-1', 'Huge.epub', oversize.subarray(0, MAX_BOOK_BYTES));
    assert.equal(atCap.status, 200);
    assert.equal(asJson(atCap).bytes, MAX_BOOK_BYTES);
    await deleteBook(store, 'bk-1'); // release the 24 MB before the next test
});

test('the books cap is KV-safe, and the notes cap is untouched', () => {
    // Workers KV refuses a value over 25 MiB. A book this route ACCEPTS must be
    // one `kv.put` can store, or the app gets a 200 for a book that never lands.
    assert.ok(MAX_BOOK_BYTES < 25 * 1024 * 1024, 'MAX_BOOK_BYTES must fit a KV value');
    assert.equal(MAX_BOOK_BYTES, 24 * 1024 * 1024);

    // The per-route body limit is what keeps the notes routes small: a bogus
    // 24 MB /publish is refused off the socket, not buffered and then rejected.
    assert.deepEqual(requestBodyLimit('POST', `/m/${BOX}/books`), {
        bytes: MAX_BOOK_BYTES,
        error: 'book_too_large',
    });
    for (const [method, path] of [
        ['POST', `/m/${BOX}/publish`],
        ['POST', `/m/${BOX}/books.txt`],
        ['POST', `/m/${BOX}/books/bk-1`], // the item route never takes a body
        ['GET', `/m/${BOX}/books`],
        ['PUT', `/m/${BOX}/books`],
        ['POST', '/nonsense'],
    ]) {
        assert.deepEqual(
            requestBodyLimit(method, path),
            { bytes: MAX_REQUEST_BODY_BYTES, error: 'frame_too_large' },
            `${method} ${path}`
        );
    }
});

test('an empty body is 400 — a zero-byte book would 416 every range forever', async () => {
    const store = createMemoryStore();
    assert.equal((await postBook(store, 'bk-1', 'Empty.epub', new Uint8Array(0))).status, 400);
    assert.equal((await postBook(store, 'bk-1', 'Empty.epub', null)).status, 400);
    assert.equal(store.map.size, 0);
});

test('the 21st book evicts the oldest, and its bytes are really gone', async () => {
    const store = createMemoryStore();
    for (let i = 1; i <= MAX_BOOKS; i++) {
        assert.equal((await postBook(store, `bk-${i}`, `Book ${i}.epub`, epub(64, i))).status, 200);
    }
    let lines = text(await manifest(store)).split('\n').filter(Boolean);
    assert.equal(lines.length, MAX_BOOKS);
    assert.equal(lines[0], `bk-${MAX_BOOKS} 64 Book ${MAX_BOOKS}.epub`);
    assert.equal(lines[MAX_BOOKS - 1], 'bk-1 64 Book 1.epub');
    assert.equal((await getBook(store, 'bk-1')).status, 200);

    // One more than the cap.
    assert.equal((await postBook(store, 'bk-21', 'Book 21.epub', epub(64, 21))).status, 200);
    lines = text(await manifest(store)).split('\n').filter(Boolean);
    assert.equal(lines.length, MAX_BOOKS, 'the manifest stays capped');
    assert.equal(lines[0], 'bk-21 64 Book 21.epub');
    assert.ok(!lines.some((line) => line.startsWith('bk-1 ')), 'the oldest is off the manifest');

    // BOTH halves go: the index entry AND the blob. An evicted entry whose bytes
    // linger is a KV value nothing can reach and nothing will ever collect.
    assert.equal(await store.get(bookKey(BOX, 'bk-1')), null, 'the evicted blob must be deleted');
    assert.equal((await getBook(store, 'bk-1')).status, 404);
    // Exactly the manifest + MAX_BOOKS blobs, nothing accumulated.
    assert.equal(store.map.size, MAX_BOOKS + 1);
});

test('re-posting the same id replaces the bytes without collecting them', async () => {
    // A retry re-POSTs the same X-Book-Id. If the GC treated "not the newest
    // entry" as collectable it would delete the blob this very request wrote.
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));
    const second = epub(200, 2);
    assert.equal((await postBook(store, 'bk-1', 'Dune Revised.epub', second)).status, 200);

    assert.equal(text(await manifest(store)), 'bk-1 200 Dune Revised.epub\n');
    const got = await getBook(store, 'bk-1');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, second);
    assert.deepEqual([...store.map.keys()].sort(), [booksIndexKey(BOX), bookKey(BOX, 'bk-1')].sort());
});

test('a new id with an EXISTING filename replaces the old entry and drops its blob', async () => {
    // The reader diffs the manifest against the files on its SD card, so two
    // entries naming one file would make that diff unresolvable — and re-sending
    // a book under a fresh id would otherwise advertise the old copy forever.
    const store = createMemoryStore();
    await postBook(store, 'old-id', 'Dune.epub', epub(100, 1));
    const fresh = epub(300, 3);
    assert.equal((await postBook(store, 'new-id', 'dune.EPUB', fresh)).status, 200);

    // Case-insensitively, because the SD card is.
    assert.equal(text(await manifest(store)), 'new-id 300 dune.epub\n');
    assert.equal(await store.get(bookKey(BOX, 'old-id')), null);
    assert.equal((await getBook(store, 'old-id')).status, 404);
    assert.deepEqual((await getBook(store, 'new-id')).body, fresh);
});

test('a store with no delete() still publishes books; blobs simply accumulate', async () => {
    const inner = createMemoryStore();
    const store = { get: (k) => inner.get(k), put: (k, v) => inner.put(k, v) };
    await postBook(store, 'bk-1', 'A.epub', epub(50, 1));
    assert.equal((await postBook(store, 'bk-2', 'A.epub', epub(60, 2))).status, 200);
    assert.equal(text(await manifest(store)), 'bk-2 60 A.epub\n');
    assert.equal(inner.map.size, 3, 'index + both blobs — the superseded one is unreachable, not gone');
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('POST and DELETE need the bearer token; books.txt and downloads never do', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));

    for (const bad of [
        undefined, // header absent entirely
        '',
        'Bearer',
        'Bearer ',
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`, // correct prefix, one char short
        TOKEN, // no scheme
        `Basic ${TOKEN}`,
    ]) {
        // Built by hand rather than through bookPostRequest: the helper's default
        // token would overwrite the header under test.
        const headers = { 'content-type': 'application/octet-stream', 'x-book-id': 'bk-2', 'x-filename': 'Other.epub' };
        if (bad !== undefined) headers.authorization = bad;
        const post = await call(store, req('POST', `/m/${BOX}/books`, { headers, body: epub(100, 2) }));
        assert.equal(post.status, 401, `POST with authorization=${JSON.stringify(bad)}`);
        assert.equal(post.headers['www-authenticate'], 'Bearer');

        const delHeaders = bad === undefined ? {} : { authorization: bad };
        const del = await call(store, req('DELETE', `/m/${BOX}/books/bk-1`, { headers: delHeaders }));
        assert.equal(del.status, 401, `DELETE with authorization=${JSON.stringify(bad)}`);
    }

    // Nothing was written and nothing was removed.
    assert.equal(text(await manifest(store)), 'bk-1 100 Dune.epub\n');
    // Reads stay open — the boxId IS the read capability, and the firmware sends
    // no auth headers on either GET.
    assert.equal((await manifest(store)).status, 200);
    assert.equal((await getBook(store, 'bk-1')).status, 200);
    assert.equal((await getBook(store, 'bk-1', { range: 'bytes=0-9' })).status, 206);
});

test('an unset or weak write token fails CLOSED on the book write routes', async () => {
    const store = createMemoryStore();
    for (const writeToken of [undefined, '', 'short']) {
        const post = await handleRequest(bookPostRequest('bk-1', 'Dune.epub', epub(100, 1)), store, { writeToken });
        assert.equal(post.status, 503, `writeToken=${JSON.stringify(writeToken)}`);
        assert.equal(asJson(post).error, 'not_configured');
        const del = await handleRequest(
            req('DELETE', `/m/${BOX}/books/bk-1`, { headers: { authorization: `Bearer ${writeToken ?? ''}` } }),
            store,
            { writeToken }
        );
        assert.equal(del.status, 503);
    }
    assert.equal(store.map.size, 0);
});

// ---------------------------------------------------------------------------
// Ids and filenames
// ---------------------------------------------------------------------------

test('a bad X-Book-Id is rejected, never truncated or sanitised', async () => {
    const store = createMemoryStore();
    for (const id of [
        undefined, // header absent
        '',
        '   ',
        '\t\r\n',
        'a'.repeat(BOOK_ID_MAX_LEN + 1),
        'has space',
        'has/slash',
        'has\\backslash',
        'per%cent',
        'café',
        '.', // would name the store key's own directory on a file-backed store
        '..',
        '...',
    ]) {
        const res = await postBook(store, id, 'Dune.epub', epub(100, 1));
        assert.equal(res.status, 400, `id=${JSON.stringify(id)}`);
    }
    assert.equal(store.map.size, 0);

    // Exactly at the limit is fine, and so is every character in the charset.
    for (const id of ['a'.repeat(BOOK_ID_MAX_LEN), 'has.dot', 'has~tilde', 'has_under-score.1']) {
        assert.equal((await postBook(store, id, `${id.slice(0, 20)}.epub`, epub(64, 1))).status, 200, id);
    }
});

test('validateBookId rejects the two ids that are directory names', () => {
    assert.deepEqual(validateBookId('  bk-1\n'), { ok: true, id: 'bk-1' });
    assert.equal(validateBookId('.').ok, false);
    assert.equal(validateBookId('..').ok, false);
    assert.equal(validateBookId('....').ok, false);
    assert.equal(validateBookId('.a').ok, true, 'a leading dot is fine, all-dots is not');
    assert.equal(validateBookId('a'.repeat(BOOK_ID_MAX_LEN + 1)).ok, false);
    assert.equal(validateBookId('').ok, false);
});

test('a traversal or unsafe X-Filename is REJECTED, not silently rewritten', async () => {
    // These are the ones where storing something different from what was asked
    // for is worse than refusing: the caller would believe a book is on the
    // device under a name that does not exist. The store key is also a
    // filesystem path on the dev server.
    const store = createMemoryStore();
    for (const filename of [
        undefined, // header absent
        '',
        '    ',
        '../../etc/passwd.epub',
        '..\\..\\evil.epub',
        '/absolute.epub',
        'sub/dir/book.epub',
        'sub\\dir\\book.epub',
        '.epub',
        '..epub',
        '.hidden.epub',
        'book.txt',
        'book',
        'book.epub.exe',
        'forged.epub\nbk-9 5 evil.epub',
        'has\rcarriage.epub',
        'has\ttab.epub',
        'has nul.epub',
        `${'a'.repeat(BOOK_FILENAME_MAX_LEN)}.epub`, // over the cap once .epub is counted
    ]) {
        const res = await postBook(store, 'bk-1', filename, epub(100, 1));
        assert.equal(res.status, 400, `filename=${JSON.stringify(filename)}`);
    }
    assert.equal(store.map.size, 0, 'no rejected filename may reach the store');
});

test('a merely awkward X-Filename is sanitised, and the manifest stays ASCII', async () => {
    // The cosmetic half of the split: FAT-reserved punctuation and non-ASCII
    // become "_", because the name is still recognisably the one asked for. The
    // ASCII rule keeps a books.txt line one byte per character, so a firmware
    // walking a C string cannot disagree with Content-Length about where the
    // fields are.
    assert.deepEqual(sanitizeBookFilename('Dune.epub'), { ok: true, filename: 'Dune.epub' });
    assert.deepEqual(sanitizeBookFilename('  Dune.EPUB \n'), { ok: true, filename: 'Dune.epub' });
    assert.deepEqual(sanitizeBookFilename('A: Book?.epub'), { ok: true, filename: 'A_ Book_.epub' });
    assert.deepEqual(sanitizeBookFilename('Wall*E<>|".epub'), { ok: true, filename: 'Wall_E____.epub' });
    assert.deepEqual(sanitizeBookFilename('Café Frappé.epub'), { ok: true, filename: 'Caf_ Frapp_.epub' });
    assert.deepEqual(sanitizeBookFilename('Spaced    out.epub'), { ok: true, filename: 'Spaced out.epub' });
    assert.deepEqual(sanitizeBookFilename(`${'a'.repeat(BOOK_FILENAME_MAX_LEN - 5)}.epub`), {
        ok: true,
        filename: `${'a'.repeat(BOOK_FILENAME_MAX_LEN - 5)}.epub`,
    });

    const store = createMemoryStore();
    // "é" -> "_" (non-ASCII), ":" -> "_" and "*" -> "_" (FAT-reserved).
    await postBook(store, 'bk-1', 'Café: Frappé*.EPUB', epub(100, 1));
    const line = text(await manifest(store));
    assert.equal(line, 'bk-1 100 Caf__ Frapp__.epub\n');
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e\n]*$/.test(line), 'a manifest line must be printable ASCII');
    assert.equal(new TextEncoder().encode(line).byteLength, line.length);
});

test('a malformed book id in the URL is 404 and never becomes a store key', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));
    const reads = [];
    const watched = {
        get: (key) => {
            reads.push(key);
            return store.get(key);
        },
        put: (key, value) => store.put(key, value),
    };
    for (const raw of ['..', '.', 'has%20space', 'a'.repeat(BOOK_ID_MAX_LEN + 1), 'caf%C3%A9']) {
        const res = await call(watched, req('GET', `/m/${BOX}/books/${raw}`));
        assert.equal(res.status, 404, raw);
        const del = await call(watched, req('DELETE', `/m/${BOX}/books/${raw}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
        assert.equal(del.status, 404, raw);
    }
    assert.ok(
        !reads.some((key) => key.includes('..') || key.includes('%')),
        `no store key may be built from an unvalidated id: ${JSON.stringify(reads)}`
    );
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test('DELETE removes the entry and the blob; deleting twice is 404', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));
    await postBook(store, 'bk-2', 'Hobbit.epub', epub(200, 2));

    const res = await deleteBook(store, 'bk-1');
    assert.equal(res.status, 200);
    assert.deepEqual(asJson(res), { ok: true, id: 'bk-1', filename: 'Dune.epub' });
    assert.equal(text(await manifest(store)), 'bk-2 200 Hobbit.epub\n');
    assert.equal(await store.get(bookKey(BOX, 'bk-1')), null);
    assert.equal((await getBook(store, 'bk-1')).status, 404);

    assert.equal((await deleteBook(store, 'bk-1')).status, 404, 'a second delete is a 404, not a 500');
    assert.equal((await deleteBook(store, 'never-existed')).status, 404);
    // The survivor is untouched.
    assert.equal((await getBook(store, 'bk-2')).status, 200);
});

// ---------------------------------------------------------------------------
// Write ordering and storage failure
// ---------------------------------------------------------------------------

test('publish writes the BLOB first and the manifest second; delete does the reverse', async () => {
    // The manifest must never advertise a book whose bytes are absent: the reader
    // budgets a whole wake window per download, and on KV the two keys replicate
    // independently, so "index landed, blob did not" is a state a replica can
    // actually be in. Delete is the mirror image.
    const store = instrumentedStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));
    assert.deepEqual(store.puts, [bookKey(BOX, 'bk-1'), booksIndexKey(BOX)]);

    // Observed from "another request" in the window between the two writes: the
    // manifest is still empty, so the half-written book is simply invisible.
    const observed = [];
    store.setBeforePut(async (key) => {
        if (key !== booksIndexKey(BOX)) return;
        observed.push(text(await manifest(store)));
    });
    await postBook(store, 'bk-2', 'Hobbit.epub', epub(200, 2));
    assert.deepEqual(observed, ['bk-1 100 Dune.epub\n']);

    store.setBeforePut(null);
    store.puts.length = 0;
    store.deletes.length = 0;
    await deleteBook(store, 'bk-1');
    assert.deepEqual(store.puts, [booksIndexKey(BOX)], 'the manifest is rewritten first');
    assert.deepEqual(store.deletes, [bookKey(BOX, 'bk-1')], 'the blob goes second');
});

test('a failed manifest write reports published:false and changes nothing visible', async () => {
    const store = instrumentedStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));
    store.setBeforePut(async (key) => {
        if (key === booksIndexKey(BOX)) throw new Error('kv unavailable');
    });

    const res = await postBook(store, 'bk-2', 'Hobbit.epub', epub(200, 2));
    assert.equal(res.status, 503);
    assert.equal(asJson(res).published, false);
    store.setBeforePut(null);
    // No reader can see bk-2: the manifest is the only thing that names a book.
    assert.equal(text(await manifest(store)), 'bk-1 100 Dune.epub\n');
    assert.equal((await getBook(store, 'bk-2')).status, 404);
    // bk-1 is intact, which is the point — a failed book write is not a failed box.
    assert.equal((await getBook(store, 'bk-1')).status, 200);
});

test('a store whose reads throw does not take the books routes down', async () => {
    const store = {
        async get() {
            throw new Error('kv unavailable');
        },
        async put() {},
    };
    // An empty library is the safe degradation, same as latest.txt.
    const res = await manifest(store);
    assert.equal(res.status, 200);
    assert.equal(text(res), '');
    // A book nothing can name is a 404, not a 500 — there is no manifest entry to
    // contradict.
    assert.equal((await getBook(store, 'bk-1')).status, 404);
});

test('a blob whose size disagrees with the manifest is refused, not served', async () => {
    // Unreachable via publish. Guards a storage-layer truncation from handing the
    // reader a slice it would stitch into a corrupt epub with no way to notice.
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(1000, 1));
    await store.put(bookKey(BOX, 'bk-1'), epub(999, 1));

    const res = await getBook(store, 'bk-1');
    assert.equal(res.status, 500);
    assert.equal(asJson(res).error, 'corrupt_book');
    assert.equal(asJson(res).bytes, 999);
    assert.equal(asJson(res).expected, 1000);

    // The manifest names it but the bytes are gone (an unreplicated blob, or one
    // a crash removed): 404, which is self-healing — the reader retries.
    await store.delete(bookKey(BOX, 'bk-1'));
    assert.equal((await getBook(store, 'bk-1')).status, 404);
    assert.equal(text(await manifest(store)), 'bk-1 1000 Dune.epub\n');
});

// ---------------------------------------------------------------------------
// Routing, methods, isolation
// ---------------------------------------------------------------------------

test('the book routes are method-constrained', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));

    for (const [method, path, allow] of [
        ['GET', `/m/${BOX}/books`, 'POST'],
        ['DELETE', `/m/${BOX}/books`, 'POST'],
        ['PUT', `/m/${BOX}/books`, 'POST'],
        ['POST', `/m/${BOX}/books/bk-1`, 'GET, HEAD, DELETE'],
        ['PUT', `/m/${BOX}/books/bk-1`, 'GET, HEAD, DELETE'],
        ['POST', `/m/${BOX}/books.txt`, 'GET, HEAD'],
        ['DELETE', `/m/${BOX}/books.txt`, 'GET, HEAD'],
    ]) {
        const res = await call(store, req(method, path, { headers: { authorization: `Bearer ${TOKEN}` } }));
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.allow, allow, `${method} ${path}`);
    }
});

test('books paths are parsed structurally; a stray segment is 404', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));

    // The fourth segment belongs to /books and nothing else.
    assert.deepEqual(parsePath(`/m/${BOX}/books/bk-1`), { boxId: BOX, leaf: 'books', sub: 'bk-1' });
    assert.deepEqual(parsePath(`/m/${BOX}/books`), { boxId: BOX, leaf: 'books' });
    assert.equal(parsePath(`/m/${BOX}/books/bk-1/extra`), null, 'five segments never parse');

    for (const path of [
        `/m/${BOX}/latest.txt/extra`, // a sub on a three-segment route
        `/m/${BOX}/current.frame/bk-1`,
        `/m/${BOX}/status/bk-1`,
        `/m/${BOX}/publish/bk-1`,
        `/m/${BOX}/books.txt/bk-1`,
        `/m/${BOX}/books/bk-1/extra`,
        `/m/${BOX}/books/../${OTHER_BOX}/books.txt`,
        `/m/${BOX}/book/bk-1`, // singular is not a route
        `/m/${BOX}/books.txt.bak`,
        `/m/${OTHER_BOX}/books/bk-1`, // another box cannot reach this blob
    ]) {
        const res = await call(store, req('GET', path, { headers: { authorization: `Bearer ${TOKEN}` } }));
        assert.equal(res.status, 404, path);
    }

    // Trailing and duplicated slashes are tolerated exactly as on the note routes.
    for (const path of [`/m/${BOX}/books/bk-1/`, `/m/${BOX}//books//bk-1`, `/m/${BOX}/books/bk-1?cachebust=1`]) {
        assert.equal((await call(store, req('GET', path))).status, 200, path);
    }
    for (const path of [`/m/${BOX}/books.txt/`, `//m//${BOX}//books.txt`, `/m/${BOX}/books.txt?x=1`]) {
        assert.equal((await call(store, req('GET', path))).status, 200, path);
    }
});

test('boxes are isolated: a book published to one is invisible from the other', async () => {
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1), { box: BOX });
    assert.equal(text(await manifest(store, { box: OTHER_BOX })), '');
    assert.equal((await getBook(store, 'bk-1', { box: OTHER_BOX })).status, 404);
    assert.equal((await deleteBook(store, 'bk-1', { box: OTHER_BOX })).status, 404);
    assert.equal((await getBook(store, 'bk-1')).status, 200, 'the real box is untouched');
});

test('every books response is uncacheable', async () => {
    // A cached books.txt pins the reader on a stale library, and a cached 206
    // could be replayed at the wrong offset by an intermediary on plain http.
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));
    for (const res of [
        await manifest(store),
        await getBook(store, 'bk-1'),
        await getBook(store, 'bk-1', { range: 'bytes=0-9' }),
        await getBook(store, 'bk-1', { range: 'bytes=999-' }),
        await postBook(store, 'bk-2', 'Hobbit.epub', epub(100, 2)),
    ]) {
        assert.match(res.headers['cache-control'], /no-store/, String(res.status));
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
});

// ---------------------------------------------------------------------------
// The notes contract is UNCHANGED — additive means additive
// ---------------------------------------------------------------------------

test('books and notes share a box without touching each other\'s keys', async () => {
    const store = createMemoryStore();

    // Notes first, then books, then notes again.
    await publish(store, 'note-1', frame(1));
    await postBook(store, 'bk-1', 'Dune.epub', epub(500, 1));
    await publish(store, 'note-2', frame(2));
    await postBook(store, 'bk-2', 'Hobbit.epub', epub(600, 2));

    // Every note assertion still holds, unchanged.
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-2');
    const gotFrame = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(gotFrame.status, 200);
    assert.equal(gotFrame.headers['content-type'], 'application/octet-stream');
    assert.equal(gotFrame.headers['content-length'], String(FRAME_BYTES));
    assert.deepEqual(gotFrame.body, frame(2));

    // And every book assertion.
    assert.equal(text(await manifest(store)), 'bk-2 600 Hobbit.epub\nbk-1 500 Dune.epub\n');
    assert.equal((await getBook(store, 'bk-1')).body.byteLength, 500);

    // The key set is exactly the notes keys PLUS the book keys — no note key
    // changed name, and no book key collides with one.
    assert.deepEqual(
        [...store.map.keys()].sort(),
        [
            metaKey(BOX),
            frameKey(BOX, 'note-1'),
            frameKey(BOX, 'note-2'),
            booksIndexKey(BOX),
            bookKey(BOX, 'bk-1'),
            bookKey(BOX, 'bk-2'),
        ].sort()
    );

    // Deleting every book leaves the notes side completely intact.
    await deleteBook(store, 'bk-1');
    await deleteBook(store, 'bk-2');
    assert.equal(text(await manifest(store)), '');
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-2');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(2));

    // Publishing a note does not disturb the (now empty) book index, and the
    // book routes do not appear in the note GC.
    await publish(store, 'note-3', frame(3));
    assert.equal(text(await manifest(store)), '');
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-3');
});

test('a books-only box still answers the note routes the way the firmware needs', async () => {
    // The reader syncs notes on EVERY wake whether or not books exist. A box that
    // has only ever held books must still look like an empty mailbox, not an error.
    const store = createMemoryStore();
    await postBook(store, 'bk-1', 'Dune.epub', epub(100, 1));

    const latest = await call(store, req('GET', `/m/${BOX}/latest.txt`));
    assert.equal(latest.status, 200);
    assert.equal(text(latest), '');
    assert.equal((await call(store, req('GET', `/m/${BOX}/current.frame`))).status, 404);

    const status = await call(store, req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.deepEqual(asJson(status), {
        latestId: null,
        bytes: 0,
        updatedAt: null,
        books: [{ id: 'bk-1', filename: 'Dune.epub', bytes: 100 }],
        // Additive: a box that has never held a wallpaper still reports the key,
        // empty. The app reads this to show "queued" state and must not have to
        // special-case its absence on an old box.
        wallpapers: [],
    });
});

test('the note body cap is still 64 KB even though books may be 24 MB', async () => {
    // The regression this guards: raising MAX_REQUEST_BODY_BYTES globally to fit
    // a book would let a 24 MB /publish be buffered before the exact-size check
    // rejects it. The cap is chosen PER ROUTE instead.
    assert.equal(MAX_REQUEST_BODY_BYTES, 64 * 1024);
    const store = createMemoryStore();
    for (const size of [FRAME_BYTES + 1, FRAME_BYTES * 2]) {
        assert.equal((await publish(store, 'n1', new Uint8Array(size))).status, 413, `size ${size}`);
    }
    assert.equal((await publish(store, 'n1', frame(1))).status, 200);
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'n1');
});

// ---------------------------------------------------------------------------
// Pre-buffering auth — the memory bound on POST /books
// ---------------------------------------------------------------------------

/** Every credential shape an adapter can be handed, refused or not. */
const CREDENTIALS = [
    ['no authorization header at all', {}],
    ['bearer with an empty token', { authorization: 'Bearer ' }],
    ['bearer with the wrong token', { authorization: 'Bearer wrong-token-0123456789abcd' }],
    ['the right token under the wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['a token with no scheme', { authorization: TOKEN }],
    ['a prefix of the right token', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
];

test('writeAuthPreflight returns EXACTLY what POST /books would have answered', async () => {
    // This is the whole safety property. The adapters call the preflight before
    // reading the body, so if its verdict could differ from the route's, a
    // credentialed upload could be 401'd without ever being buffered (a false
    // refusal the app would surface as "wrong token"). Pin the two together
    // response-for-response rather than status-for-status.
    for (const [label, headers] of CREDENTIALS) {
        const denied = writeAuthPreflight(headers, { writeToken: TOKEN });
        assert.ok(denied, `${label}: preflight must refuse`);
        assert.equal(denied.status, 401, label);

        const store = createMemoryStore();
        const viaRoute = await call(
            store,
            req('POST', `/m/${BOX}/books`, { headers: { ...headers, 'x-book-id': 'bk-1', 'x-filename': 'Dune.epub' }, body: epub(64) })
        );
        assert.deepEqual(denied, viaRoute, `${label}: preflight and route must be indistinguishable`);
        // And nothing was stored on the way to the refusal.
        assert.equal(store.map.size, 0, label);
    }

    // The accepting case must return null, and the same request must then be
    // accepted by the route — otherwise the preflight is just a second lock.
    assert.equal(writeAuthPreflight({ authorization: `Bearer ${TOKEN}` }, { writeToken: TOKEN }), null);
    assert.equal((await postBook(createMemoryStore(), 'bk-1', 'Dune.epub', epub(64))).status, 200);
});

test('writeAuthPreflight fails CLOSED on a missing or weak write token', async () => {
    // A blank secret must never mean "anyone may publish". 503, not 401 and
    // certainly not null — and again identical to what the route says, so an
    // adapter cannot report a different fault depending on when it checked.
    for (const writeToken of ['', 'short', 'x'.repeat(MIN_WRITE_TOKEN_LEN - 1)]) {
        const good = { authorization: `Bearer ${TOKEN}` };
        const denied = writeAuthPreflight(good, { writeToken });
        assert.ok(denied, `token ${JSON.stringify(writeToken)}`);
        assert.equal(denied.status, 503);
        assert.equal(JSON.parse(denied.body).error, 'not_configured');

        const viaRoute = await call(
            createMemoryStore(),
            req('POST', `/m/${BOX}/books`, { headers: { ...good, 'x-book-id': 'bk-1', 'x-filename': 'Dune.epub' }, body: epub(64) }),
            { writeToken }
        );
        assert.deepEqual(denied, viaRoute, `token ${JSON.stringify(writeToken)}`);
    }
    // A config-shaped surprise is still a refusal, never a pass.
    for (const config of [undefined, null, {}, { writeToken: 42 }]) {
        const denied = writeAuthPreflight({ authorization: `Bearer ${TOKEN}` }, config);
        assert.ok(denied, String(config));
        assert.equal(denied.status, 503, String(config));
    }
});

test('the preflight is required exactly where the body cap exceeds the notes cap', () => {
    // The rule both adapters implement: preflight iff
    // `requestBodyLimit(...).bytes > MAX_REQUEST_BODY_BYTES`. Pinning the
    // predicate here is what keeps that one line in two adapters honest — and
    // keeps it OFF the notes routes, where buffering 64 KB first is free and
    // where an unauthenticated oversize body must keep answering 413, not 401.
    assert.ok(requestBodyLimit('POST', `/m/${BOX}/books`).bytes > MAX_REQUEST_BODY_BYTES);
    assert.equal(requestBodyLimit('POST', `/m/${BOX}/books`).bytes, MAX_BOOK_BYTES);
    // `POST /wallpaper` is on the SAME side of the predicate, which is how it
    // inherits auth-before-buffering in both adapters without either of them
    // learning a new route name.
    assert.ok(requestBodyLimit('POST', `/m/${BOX}/wallpaper`).bytes > MAX_REQUEST_BODY_BYTES);
    assert.equal(requestBodyLimit('POST', `/m/${BOX}/wallpaper`).bytes, MAX_WALLPAPER_BYTES);
    assert.equal(requestBodyLimit('POST', `/m/${BOX}/wallpaper`).error, 'wallpaper_too_large');
    for (const path of [
        `/m/${BOX}/publish`,
        `/m/${BOX}/books/bk-1`,
        `/m/${BOX}/status`,
        `/m/${BOX}/wallpaper/wp-1`,
        `/m/${BOX}/wallpaper.txt`,
        '/nonsense',
    ]) {
        assert.equal(requestBodyLimit('POST', path).bytes, MAX_REQUEST_BODY_BYTES, path);
    }
    // Only POST raises the cap: no other method reaches either upload route,
    // so none of them may skip straight past the notes bound either.
    for (const method of ['PUT', 'PATCH', 'GET', 'DELETE']) {
        assert.equal(requestBodyLimit(method, `/m/${BOX}/books`).bytes, MAX_REQUEST_BODY_BYTES, method);
        assert.equal(requestBodyLimit(method, `/m/${BOX}/wallpaper`).bytes, MAX_REQUEST_BODY_BYTES, method);
    }
});

test('a HEAD carries the Content-Length its GET would have, on every sized route', async () => {
    // Both adapters have to pass this through by hand (there is no body for a
    // runtime to measure), so the core must supply it or neither can. §2 of
    // docs/xteink/mailbox-books-contract.md promises it.
    const store = rangedStore();
    assert.equal((await postBook(store, 'bk-1', 'Dune.epub', epub(5000))).status, 200);
    assert.equal((await publish(store, 'n1', frame(1))).status, 200);
    assert.equal((await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(3000))).status, 200);

    for (const [label, get, head] of [
        ['book', await getBook(store, 'bk-1'), await getBook(store, 'bk-1', { method: 'HEAD' })],
        ['manifest', await manifest(store), await manifest(store, { method: 'HEAD' })],
        [
            'wallpaper',
            await getWallpaper(store, 'wp-1'),
            await getWallpaper(store, 'wp-1', { method: 'HEAD' }),
        ],
        [
            'wallpaper manifest',
            await wallpaperManifest(store),
            await wallpaperManifest(store, { method: 'HEAD' }),
        ],
        [
            'frame',
            await call(store, req('GET', `/m/${BOX}/current.frame`)),
            await call(store, req('HEAD', `/m/${BOX}/current.frame`)),
        ],
    ]) {
        assert.equal(head.status, get.status, label);
        assert.equal(head.body, null, `${label}: a HEAD never carries a body`);
        assert.equal(
            head.headers['content-length'],
            get.headers['content-length'],
            `${label}: HEAD must report the size the GET would send`
        );
        assert.ok(Number(head.headers['content-length']) > 0, label);
    }

    // A ranged HEAD reports the SLICE length, which is what makes it usable as a
    // resume probe rather than just a size probe.
    const partial = await getBook(store, 'bk-1', { method: 'HEAD', range: 'bytes=1000-1999' });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-length'], '1000');
    assert.equal(partial.headers['content-range'], 'bytes 1000-1999/5000');
});

// ===========================================================================
// WALLPAPERS — sleep-screen delivery over the same mailbox
//
// Wallpaper used to be direct-LAN only: the app pushed a BMP straight at the
// reader's /sleep.bmp while both were on one network and the reader was awake.
// These routes make it travel the way notes and books already do. As with
// books, the reader-side half is a FUTURE firmware milestone, so these tests
// are the only definition of the contract it will be built against.
//
// The differences from books are exactly three, and each one has its own test
// below: an entry carries a TARGET, a primary SUPERSEDES the pending primary,
// and the manifest is rendered NEWEST LAST.
// ===========================================================================

/** Deterministic, seed-distinguishable "BMP". Not a real bitmap; this is a byte pipe. */
function bmp(bytes, seed = 1) {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = (i * 13 + seed * 37) & 0xff;
    return out;
}

function wallpaperPostRequest(id, target, filename, body, { token = TOKEN, box = BOX, extraHeaders = {} } = {}) {
    const headers = { 'content-type': 'application/octet-stream', ...extraHeaders };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (id !== undefined) headers['x-wallpaper-id'] = id;
    if (target !== undefined) headers['x-wallpaper-target'] = target;
    if (filename !== undefined) headers['x-filename'] = filename;
    return req('POST', `/m/${box}/wallpaper`, { headers, body });
}

function postWallpaper(store, id, target, filename, body, opts = {}) {
    return call(store, wallpaperPostRequest(id, target, filename, body, opts), {
        writeToken: TOKEN,
        now: opts.now,
    });
}

function getWallpaper(store, id, { range = null, method = 'GET', box = BOX } = {}) {
    const headers = {};
    if (range !== null) headers.range = range;
    return call(store, req(method, `/m/${box}/wallpaper/${id}`, { headers }));
}

function deleteWallpaper(store, id, { token = TOKEN, box = BOX } = {}) {
    const headers = token === null ? {} : { authorization: `Bearer ${token}` };
    return call(store, req('DELETE', `/m/${box}/wallpaper/${id}`, { headers }));
}

function wallpaperManifest(store, { box = BOX, method = 'GET' } = {}) {
    return call(store, req(method, `/m/${box}/wallpaper.txt`, {}));
}

/** Every line of a manifest, LF-terminated entries only. */
function lines(body) {
    return body.split('\n').filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Manifest: the bytes the reader applies, IN ORDER
// ---------------------------------------------------------------------------

test('wallpaper.txt is byte-exact: "{id} {bytes} {target} {filename}\\n", NEWEST LAST', async () => {
    const store = createMemoryStore();

    // Nothing pending is a ZERO-LENGTH 200, never a 404 — the reader syncs on
    // every wake and a non-200 would be logged as a failed sync every time.
    const empty = await wallpaperManifest(store);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(text(empty), '');
    assert.equal(empty.headers['content-length'], '0');

    assert.equal((await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', bmp(1000, 1))).status, 200);
    assert.equal((await postWallpaper(store, 'wp-2', 'set', 'Deep Sea.bmp', bmp(2048, 2))).status, 200);
    assert.equal((await postWallpaper(store, 'wp-3', 'primary', undefined, bmp(4096, 3))).status, 200);

    const res = await wallpaperManifest(store);
    assert.equal(res.status, 200);
    // NEWEST LAST — the opposite of books.txt, and the whole reason the target
    // field is usable: a reader applies these in order and the last write to
    // /sleep.bmp wins, so draining the manifest must END on the newest primary.
    // Newest-first would end on the oldest and silently show a stale screen.
    assert.equal(
        text(res),
        'wp-1 1000 set Forest.bmp\nwp-2 2048 set Deep Sea.bmp\nwp-3 4096 primary -\n'
    );
    assert.equal(res.headers['content-length'], String(text(res).length));
    assert.match(res.headers['cache-control'], /no-store/);

    // Four space-separated fields; the filename is the REST of the line, so a
    // name containing a space still round-trips.
    const setLine = lines(text(res))[1];
    assert.equal(setLine.split(' ', 3).join(' '), 'wp-2 2048 set');
    assert.equal(setLine.slice('wp-2 2048 set '.length), 'Deep Sea.bmp');

    // A primary carries the literal "-" placeholder, never an empty field —
    // an empty fourth field would move the LF into it and break a positional
    // parser walking a C string.
    const primaryLine = lines(text(res))[2];
    assert.equal(primaryLine.split(' ')[3], WALLPAPER_NO_FILENAME);
    assert.equal(primaryLine.split(' ').length, 4);

    // No auth: the boxId is the read capability, exactly as for latest.txt.
    assert.equal((await wallpaperManifest(store)).status, 200);
});

test('renderWallpaperManifest takes the stored order and emits the wire order', () => {
    // The ONE place the reversal lives. Input is newest-first (the stored
    // order, shared with the books index so eviction is the same three lines);
    // output is newest-last.
    assert.equal(renderWallpaperManifest([]), '');
    assert.equal(
        renderWallpaperManifest([{ id: 'a', bytes: 1, target: 'primary', filename: null }]),
        'a 1 primary -\n'
    );
    assert.equal(
        renderWallpaperManifest([
            { id: 'newest', bytes: 3, target: 'primary', filename: null },
            { id: 'middle', bytes: 2, target: 'set', filename: 'y z.bmp' },
            { id: 'oldest', bytes: 1, target: 'set', filename: 'x.bmp' },
        ]),
        'oldest 1 set x.bmp\nmiddle 2 set y z.bmp\nnewest 3 primary -\n'
    );
});

test('a corrupt wallpaper manifest degrades to empty, and can never forge a line', async () => {
    // Same reasoning as the books manifest: nothing pending is a normal wake, a
    // 500 is a logged error on every one. The round-trip checks are what stop a
    // stored value from emitting a line this contract would not mint.
    const encoder = new TextEncoder();
    for (const junk of [
        '',
        'not json',
        '{}',
        '{"wallpapers":"nope"}',
        '[1,2,3]',
        '{"v":1,"books":[{"id":"ok","bytes":5,"filename":"a.bmp"}]}', // wrong array name
        // An LF in a filename would turn one entry into two, naming bytes that
        // do not exist.
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"set","filename":"a.bmp\\nforged 9 set evil.bmp"}]}',
        '{"v":1,"wallpapers":[{"id":"has space","bytes":5,"target":"set","filename":"a.bmp"}]}',
        '{"v":1,"wallpapers":[{"id":"..","bytes":5,"target":"set","filename":"a.bmp"}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"set","filename":"../../etc/passwd.bmp"}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"set","filename":"no-extension"}]}',
        // A target outside the enum would tell the reader to write somewhere
        // this contract does not define.
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"root","filename":"a.bmp"}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"PRIMARY","filename":null}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"filename":"a.bmp"}]}', // no target at all
        // A `set` with no filename has nowhere to land; a `primary` WITH one has
        // two candidate destinations.
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"set","filename":null}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"primary","filename":"a.bmp"}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":5,"target":"primary","filename":"-"}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":0,"target":"primary","filename":null}]}',
        '{"v":1,"wallpapers":[{"id":"ok","bytes":-1,"target":"primary","filename":null}]}',
        `{"v":1,"wallpapers":[{"id":"ok","bytes":${MAX_WALLPAPER_BYTES + 1},"target":"primary","filename":null}]}`,
    ]) {
        const store = createMemoryStore();
        await store.put(wallpapersIndexKey(BOX), encoder.encode(junk));
        const res = await wallpaperManifest(store);
        assert.equal(res.status, 200, junk);
        assert.equal(text(res), '', junk);
        // Nothing the manifest does not name is reachable.
        assert.equal((await getWallpaper(store, 'ok')).status, 404, junk);
    }
});

test('a corrupt index cannot advertise two primaries or an unbounded manifest', async () => {
    const encoder = new TextEncoder();

    // Stored order is newest first, so the FIRST primary is the newest one and
    // any later one is a corrupted leftover. Advertising both would cost the
    // reader a wasted ~1.1 MB download inside a battery-budgeted wake window,
    // for bytes it is about to overwrite.
    const twoPrimaries = {
        v: 1,
        wallpapers: [
            { id: 'new', bytes: 10, target: 'primary', filename: null },
            { id: 'mid', bytes: 20, target: 'set', filename: 'keep.bmp' },
            { id: 'old', bytes: 30, target: 'primary', filename: null },
        ],
    };
    const store = createMemoryStore();
    await store.put(wallpapersIndexKey(BOX), encoder.encode(JSON.stringify(twoPrimaries)));
    assert.equal(text(await wallpaperManifest(store)), 'mid 20 set keep.bmp\nnew 10 primary -\n');

    // And a hand-edited or corrupted index must not make the reader download a
    // hundred-line manifest on every wake.
    const many = [];
    for (let i = 0; i < MAX_WALLPAPERS * 5; i++) {
        many.push({ id: `w${i}`, bytes: 10, target: 'set', filename: `f${i}.bmp` });
    }
    const big = createMemoryStore();
    await big.put(wallpapersIndexKey(BOX), encoder.encode(JSON.stringify({ v: 1, wallpapers: many })));
    const got = lines(text(await wallpaperManifest(big)));
    assert.equal(got.length, MAX_WALLPAPERS);
    // Newest-last on the wire: the kept slice is the head of the stored array
    // (the newest MAX_WALLPAPERS), emitted in reverse.
    assert.equal(got[got.length - 1], 'w0 10 set f0.bmp');
    assert.equal(got[0], `w${MAX_WALLPAPERS - 1} 10 set f${MAX_WALLPAPERS - 1}.bmp`);
});

// ---------------------------------------------------------------------------
// Round trip and Range — the same resume mechanism books use
// ---------------------------------------------------------------------------

test('a published wallpaper downloads byte-exactly, and advertises Accept-Ranges', async () => {
    const store = createMemoryStore();
    const sent = bmp(4096, 7);
    const posted = await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', sent);
    assert.deepEqual(asJson(posted), {
        ok: true,
        id: 'wp-1',
        target: 'set',
        filename: 'Forest.bmp',
        bytes: 4096,
    });

    const got = await getWallpaper(store, 'wp-1');
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'image/bmp');
    assert.equal(got.headers['content-length'], '4096');
    assert.equal(got.headers['accept-ranges'], 'bytes');
    assert.equal(got.headers['content-disposition'], 'attachment; filename="Forest.bmp"');
    assert.equal(got.headers['content-range'], undefined);
    assert.deepEqual(got.body, sent);

    // A primary has no filename to disclose: its destination is fixed at
    // /sleep.bmp, so naming one here would invent a name the reader must not
    // use. Omitting the header is the honest answer.
    const primary = bmp(2048, 9);
    assert.equal((await postWallpaper(store, 'wp-2', 'primary', undefined, primary)).status, 200);
    const gotPrimary = await getWallpaper(store, 'wp-2');
    assert.equal(gotPrimary.status, 200);
    assert.equal(gotPrimary.headers['content-disposition'], undefined);
    assert.deepEqual(gotPrimary.body, primary);

    // No auth on the read path; an unknown id is 404.
    assert.equal((await getWallpaper(store, 'nope')).status, 404);
});

test('a wallpaper resumes across windows exactly the way a book does', async () => {
    // A 1056-long-side 8bpp BMP is ~1.1 MB and an ESP32 wake window is seconds
    // long, so this is a multi-window download and the slices must re-assemble
    // byte-for-byte. An off-by-one produces a corrupt sleep screen the reader
    // has no way to detect.
    const store = createMemoryStore();
    const sent = bmp(9999, 5);
    await postWallpaper(store, 'wp-1', 'primary', undefined, sent);

    const mid = await getWallpaper(store, 'wp-1', { range: 'bytes=4096-8191' });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers['content-range'], 'bytes 4096-8191/9999');
    assert.equal(mid.headers['content-length'], '4096');
    assert.equal(mid.headers['accept-ranges'], 'bytes');
    assert.deepEqual(mid.body, sent.subarray(4096, 8192));

    // Three bounded windows, the way the reader will actually do it.
    const windowSize = 4000;
    const chunks = [];
    let have = 0;
    while (have < sent.byteLength) {
        const res = await getWallpaper(store, 'wp-1', { range: `bytes=${have}-${have + windowSize - 1}` });
        assert.equal(res.status, 206, `at offset ${have}`);
        // The TOTAL in Content-Range is what a reader compares against the
        // `bytes` it read from wallpaper.txt, so it can restart if the id was
        // re-published underneath it.
        assert.match(res.headers['content-range'], new RegExp(`/${sent.byteLength}$`));
        chunks.push(res.body);
        have += res.body.byteLength;
    }
    assert.equal(chunks.length, 3);
    const joined = new Uint8Array(sent.byteLength);
    let at = 0;
    for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.byteLength;
    }
    assert.deepEqual(joined, sent);

    // Open-ended and suffix ranges, which is how a client resumes without
    // knowing the total.
    const tail = await getWallpaper(store, 'wp-1', { range: 'bytes=9000-' });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers['content-range'], 'bytes 9000-9998/9999');
    assert.deepEqual(tail.body, sent.subarray(9000));

    // A last-byte-pos past the end is CLAMPED, not refused, so a fixed window
    // size needs no prior knowledge of the length.
    const clamped = await getWallpaper(store, 'wp-1', { range: 'bytes=9990-999999' });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.headers['content-range'], 'bytes 9990-9998/9999');
});

test('an unsatisfiable wallpaper Range is 416 with the total size', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(500, 1));
    for (const range of ['bytes=500-', 'bytes=9999-', 'bytes=400-300', 'bytes=-0']) {
        const res = await getWallpaper(store, 'wp-1', { range });
        assert.equal(res.status, 416, range);
        // WITHOUT the total the client has nothing to correct its offset to and
        // would retry the same bad range on every wake, forever.
        assert.equal(res.headers['content-range'], 'bytes */500', range);
        assert.equal(res.headers['accept-ranges'], 'bytes', range);
    }
    // A Range this server does not honour is IGNORED -> 200 full body, never a
    // 416, so a client that sent one speculatively still gets its bytes.
    for (const range of ['items=0-1', 'bytes=0-1,4-5', 'garbage', 'bytes=-']) {
        const res = await getWallpaper(store, 'wp-1', { range });
        assert.equal(res.status, 200, range);
        assert.equal(res.headers['content-range'], undefined, range);
        assert.equal(res.body.byteLength, 500, range);
    }
});

test('a wallpaper store WITH stat+getRange serves the same bytes as one without', async () => {
    // Two implementations of one range: slice-a-full-get (KV, the memory store)
    // and read-the-window (the dev server's file store). A reader resuming
    // across wake windows must get identical bytes from either.
    const sent = bmp(8192, 11);
    const plain = createMemoryStore();
    const ranged = rangedStore();
    for (const store of [plain, ranged]) {
        assert.equal((await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', sent)).status, 200);
    }
    for (const range of [null, 'bytes=0-1023', 'bytes=4096-', 'bytes=-256', 'bytes=8191-8191']) {
        const a = await getWallpaper(plain, 'wp-1', { range });
        const b = await getWallpaper(ranged, 'wp-1', { range });
        assert.equal(b.status, a.status, String(range));
        assert.equal(b.headers['content-range'], a.headers['content-range'], String(range));
        assert.equal(b.headers['content-length'], a.headers['content-length'], String(range));
        assert.deepEqual(b.body, a.body, String(range));
    }
    // The ranged store really did read only the window it was asked for, which
    // is the whole point: the dev server runs under MemoryMax=256M.
    assert.ok(ranged.reads.length > 0);
    assert.ok(
        ranged.reads.every((read) => read.length <= sent.byteLength),
        JSON.stringify(ranged.reads)
    );
    assert.deepEqual(
        ranged.reads.find((read) => read.start === 4096),
        { key: wallpaperKey(BOX, 'wp-1'), start: 4096, length: 4096 }
    );
});

// ---------------------------------------------------------------------------
// Retention: primary supersede, and oldest-evicted for the set
// ---------------------------------------------------------------------------

test('a new primary SUPERSEDES the pending one — index entry and blob', async () => {
    // Two pending primaries would make the reader spend a whole wake window
    // downloading ~1.1 MB it is about to overwrite, to end up exactly where the
    // newest one alone would have put it.
    const store = createMemoryStore();
    assert.equal((await postWallpaper(store, 'wp-old', 'primary', undefined, bmp(1000, 1))).status, 200);
    assert.equal((await postWallpaper(store, 'wp-new', 'primary', undefined, bmp(2000, 2))).status, 200);

    assert.equal(text(await wallpaperManifest(store)), 'wp-new 2000 primary -\n');
    // The superseded blob is really gone, not merely unadvertised.
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-old')), false);
    assert.equal((await getWallpaper(store, 'wp-old')).status, 404);
    assert.equal((await getWallpaper(store, 'wp-new')).status, 200);

    // A `set` in between is NOT disturbed: it lands in a different file under
    // /.sleep and is still wanted.
    assert.equal((await postWallpaper(store, 'wp-set', 'set', 'Forest.bmp', bmp(300, 3))).status, 200);
    assert.equal((await postWallpaper(store, 'wp-3rd', 'primary', undefined, bmp(400, 4))).status, 200);
    assert.equal(
        text(await wallpaperManifest(store)),
        'wp-set 300 set Forest.bmp\nwp-3rd 400 primary -\n'
    );
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-new')), false);
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-set')), true);
});

test('set wallpapers do NOT supersede each other, even under one filename', async () => {
    // Unlike books, a wallpaper is applied and forgotten with an id-based
    // done-state — there is no filename diff to make unresolvable, so two
    // entries naming one file are merely applied in order and the newest wins.
    // Collapsing them would silently drop an item the caller asked to queue.
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-a', 'set', 'Forest.bmp', bmp(100, 1));
    await postWallpaper(store, 'wp-b', 'set', 'Forest.bmp', bmp(200, 2));
    assert.equal(
        text(await wallpaperManifest(store)),
        'wp-a 100 set Forest.bmp\nwp-b 200 set Forest.bmp\n'
    );
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-a')), true);
});

test('the 9th wallpaper evicts the oldest, and its bytes are really gone', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < MAX_WALLPAPERS; i++) {
        assert.equal((await postWallpaper(store, `wp-${i}`, 'set', `w${i}.bmp`, bmp(64, i))).status, 200);
    }
    assert.equal(lines(text(await wallpaperManifest(store))).length, MAX_WALLPAPERS);
    assert.equal(lines(text(await wallpaperManifest(store)))[0], 'wp-0 64 set w0.bmp');

    assert.equal((await postWallpaper(store, 'wp-new', 'set', 'new.bmp', bmp(64, 99))).status, 200);
    const after = lines(text(await wallpaperManifest(store)));
    assert.equal(after.length, MAX_WALLPAPERS);
    // The oldest is gone from the front of the wire order, the newest is at the
    // back, and the evicted blob went with the entry.
    assert.equal(after[0], 'wp-1 64 set w1.bmp');
    assert.equal(after[after.length - 1], 'wp-new 64 set new.bmp');
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-0')), false);
    assert.equal((await getWallpaper(store, 'wp-0')).status, 404);
});

test('re-posting the same wallpaper id replaces the bytes without collecting them', async () => {
    // That is what a retry does. The id stays in place, the blob is overwritten.
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', bmp(100, 1));
    const replacement = bmp(250, 2);
    assert.equal((await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', replacement)).status, 200);
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 250 set Forest.bmp\n');
    assert.deepEqual((await getWallpaper(store, 'wp-1')).body, replacement);

    // Re-posting the same id with a DIFFERENT target moves it, and does not
    // leave a second entry behind.
    assert.equal((await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(300, 3))).status, 200);
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 300 primary -\n');
});

test('a store with no delete() still publishes wallpapers; blobs simply accumulate', async () => {
    // `delete` is optional on the store contract. Without it a superseded
    // primary leaks its bytes, which is a cost, never a correctness problem —
    // and it must never turn a delivered wallpaper into a reported failure.
    const inner = createMemoryStore();
    const store = { map: inner.map, get: (k) => inner.get(k), put: (k, v) => inner.put(k, v) };
    assert.equal((await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1))).status, 200);
    assert.equal((await postWallpaper(store, 'wp-2', 'primary', undefined, bmp(200, 2))).status, 200);
    assert.equal(text(await wallpaperManifest(store)), 'wp-2 200 primary -\n');
    // Orphaned but harmless: nothing the manifest does not name is reachable.
    assert.equal(inner.map.has(wallpaperKey(BOX, 'wp-1')), true);
    assert.equal((await getWallpaper(store, 'wp-1')).status, 404);
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test('a wallpaper over MAX_WALLPAPER_BYTES is 413, and exactly at the cap is accepted', async () => {
    const store = createMemoryStore();
    const over = await postWallpaper(store, 'wp-1', 'primary', undefined, new Uint8Array(MAX_WALLPAPER_BYTES + 1));
    assert.equal(over.status, 413);
    assert.equal(asJson(over).error, 'wallpaper_too_large');
    assert.equal(store.map.size, 0, 'a refused wallpaper must not reach the store');

    const at = await postWallpaper(store, 'wp-1', 'primary', undefined, new Uint8Array(MAX_WALLPAPER_BYTES));
    assert.equal(at.status, 200);
    assert.equal(asJson(at).bytes, MAX_WALLPAPER_BYTES);
});

test('the wallpaper cap is KV-safe and sized for the panel, and leaves the other caps alone', () => {
    // 4 MiB. A 1056-long-side 8bpp BMP is ~1.1 MB, so this is ~4x headroom, and
    // it is FAR under the 25 MiB Workers KV value ceiling — a body we accept is
    // a body kv.put can store, which is the rule that stops the app reporting
    // success for a wallpaper the reader can never see.
    assert.equal(MAX_WALLPAPER_BYTES, 4 * 1024 * 1024);
    assert.ok(MAX_WALLPAPER_BYTES < 25 * 1024 * 1024);
    assert.ok(MAX_WALLPAPER_BYTES > 1_115_136 + 1078, 'must fit a full-bleed 1056px 8bpp BMP with headroom');
    // And it changes neither of the caps that were already load-bearing.
    assert.equal(MAX_REQUEST_BODY_BYTES, 64 * 1024);
    assert.equal(MAX_BOOK_BYTES, 24 * 1024 * 1024);
    assert.equal(MAX_WALLPAPERS, 8);
});

test('an empty wallpaper body is 400 — a zero-byte image would 416 every range forever', async () => {
    const store = createMemoryStore();
    const res = await postWallpaper(store, 'wp-1', 'primary', undefined, new Uint8Array(0));
    assert.equal(res.status, 400);
    assert.equal(store.map.size, 0);
});

// ---------------------------------------------------------------------------
// Auth — the same matrix books answer
// ---------------------------------------------------------------------------

test('POST and DELETE need the bearer token; wallpaper.txt and downloads never do', async () => {
    const store = createMemoryStore();

    for (const [label, headers] of CREDENTIALS) {
        const res = await call(
            store,
            req('POST', `/m/${BOX}/wallpaper`, {
                headers: { ...headers, 'x-wallpaper-id': 'wp-1', 'x-wallpaper-target': 'primary' },
                body: bmp(64),
            })
        );
        assert.equal(res.status, 401, label);
        assert.equal(res.headers['www-authenticate'], 'Bearer', label);
        assert.equal(store.map.size, 0, `${label}: nothing may be stored on the way to a 401`);
    }

    assert.equal((await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(128))).status, 200);

    // Reads are open — the boxId IS the read capability, exactly as for
    // latest.txt and books.txt. The firmware sends no auth headers at all.
    assert.equal((await wallpaperManifest(store)).status, 200);
    assert.equal((await getWallpaper(store, 'wp-1')).status, 200);
    assert.equal((await getWallpaper(store, 'wp-1', { method: 'HEAD' })).status, 200);

    // DELETE is a write.
    for (const [label, headers] of CREDENTIALS) {
        const res = await call(store, req('DELETE', `/m/${BOX}/wallpaper/wp-1`, { headers }));
        assert.equal(res.status, 401, label);
    }
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 128 primary -\n');
    assert.equal((await deleteWallpaper(store, 'wp-1')).status, 200);
});

test('an unset or weak write token fails CLOSED on the wallpaper write routes', async () => {
    // A blank secret must never mean "anyone may publish": that would turn the
    // box id, which travels in the reader's settings in clear, into a write
    // capability for the sleep screen too.
    for (const writeToken of ['', 'short', 'x'.repeat(MIN_WRITE_TOKEN_LEN - 1)]) {
        const store = createMemoryStore();
        const posted = await call(
            store,
            wallpaperPostRequest('wp-1', 'primary', undefined, bmp(64)),
            { writeToken }
        );
        assert.equal(posted.status, 503, JSON.stringify(writeToken));
        assert.equal(asJson(posted).error, 'not_configured');

        const deleted = await call(
            store,
            req('DELETE', `/m/${BOX}/wallpaper/wp-1`, { headers: { authorization: `Bearer ${TOKEN}` } }),
            { writeToken }
        );
        assert.equal(deleted.status, 503, JSON.stringify(writeToken));

        // Reads still work: a misconfigured deploy must not take the reader's
        // sync down, it must refuse to accept new writes.
        assert.equal((await call(store, req('GET', `/m/${BOX}/wallpaper.txt`, {}), { writeToken })).status, 200);
    }
});

test('writeAuthPreflight is identical to what POST /wallpaper would answer', async () => {
    // The adapters call the preflight BEFORE buffering, so if its verdict could
    // differ from the route's, a credentialed 4 MiB upload could be refused
    // without ever being read.
    for (const [label, headers] of CREDENTIALS) {
        const denied = writeAuthPreflight(headers, { writeToken: TOKEN });
        assert.ok(denied, label);
        const viaRoute = await call(
            createMemoryStore(),
            req('POST', `/m/${BOX}/wallpaper`, {
                headers: { ...headers, 'x-wallpaper-id': 'wp-1', 'x-wallpaper-target': 'primary' },
                body: bmp(64),
            })
        );
        assert.deepEqual(denied, viaRoute, `${label}: preflight and route must be indistinguishable`);
    }
});

// ---------------------------------------------------------------------------
// Headers: id, target, filename
// ---------------------------------------------------------------------------

test('a bad X-Wallpaper-Id is rejected, never truncated or sanitised', async () => {
    const store = createMemoryStore();
    for (const id of [
        undefined, // header absent
        '',
        '   ',
        '\t\r\n',
        'a'.repeat(WALLPAPER_ID_MAX_LEN + 1),
        'has space',
        'has/slash',
        'has\\backslash',
        'per%cent',
        'café',
        '.', // would name the store key's own directory on a file-backed store
        '..',
        '...',
    ]) {
        const res = await postWallpaper(store, id, 'primary', undefined, bmp(100, 1));
        assert.equal(res.status, 400, `id=${JSON.stringify(id)}`);
    }
    assert.equal(store.map.size, 0);

    for (const id of ['a'.repeat(WALLPAPER_ID_MAX_LEN), 'has.dot', 'has~tilde', 'has_under-score.1']) {
        assert.equal((await postWallpaper(store, id, 'primary', undefined, bmp(64, 1))).status, 200, id);
    }

    assert.deepEqual(validateWallpaperId('  wp-1\n'), { ok: true, id: 'wp-1' });
    assert.equal(validateWallpaperId('.').ok, false);
    assert.equal(validateWallpaperId('..').ok, false);
    assert.equal(validateWallpaperId('....').ok, false);
    assert.equal(validateWallpaperId('.a').ok, true, 'a leading dot is fine, all-dots is not');
    assert.equal(validateWallpaperId('').ok, false);
});

test('X-Wallpaper-Target is a closed enum; an unknown value is 400, never a default', async () => {
    // The target decides WHERE the reader writes the bytes. Defaulting an
    // unrecognised value would overwrite a user's active sleep screen with
    // something they meant to add to the rotation.
    assert.deepEqual([...WALLPAPER_TARGETS], ['primary', 'set']);
    assert.equal(WALLPAPER_TARGET_PRIMARY, 'primary');
    assert.equal(WALLPAPER_TARGET_SET, 'set');

    const store = createMemoryStore();
    for (const target of [undefined, '', '  ', 'PRIMARY_', 'root', 'sleep', 'primary set', '0', 'null']) {
        const res = await postWallpaper(store, 'wp-1', target, 'Forest.bmp', bmp(64, 1));
        assert.equal(res.status, 400, `target=${JSON.stringify(target)}`);
    }
    assert.equal(store.map.size, 0);

    // Trimmed and case-folded to the canonical lowercase form, which is what
    // gets stored and echoed everywhere after.
    assert.deepEqual(validateWallpaperTarget('  Primary \n'), { ok: true, target: 'primary' });
    assert.deepEqual(validateWallpaperTarget('SET'), { ok: true, target: 'set' });
    const posted = await postWallpaper(store, 'wp-1', ' Primary ', undefined, bmp(64, 1));
    assert.equal(posted.status, 200);
    assert.equal(asJson(posted).target, 'primary');
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 64 primary -\n');
});

test('X-Filename is REQUIRED for set and IGNORED for primary', async () => {
    const store = createMemoryStore();

    // A `set` with no name has nowhere to land under /.sleep.
    const missing = await postWallpaper(store, 'wp-1', 'set', undefined, bmp(64, 1));
    assert.equal(missing.status, 400);
    assert.match(asJson(missing).detail, /X-Filename/);
    assert.equal(store.map.size, 0);

    // A primary has exactly one destination (/sleep.bmp), so honouring a name
    // would create a second source of truth for where the bytes land. It is
    // dropped rather than rejected — a caller that sends one is not wrong, it
    // is just sending something with no meaning on this target.
    const withName = await postWallpaper(store, 'wp-1', 'primary', 'Ignored.bmp', bmp(64, 1));
    assert.equal(withName.status, 200);
    assert.equal(asJson(withName).filename, null);
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 64 primary -\n');

    // A primary is never rejected for a filename that a `set` would refuse,
    // because the header is not read at all on that target.
    assert.equal((await postWallpaper(store, 'wp-2', 'primary', '../../etc/passwd', bmp(64, 2))).status, 200);
});

test('a traversal or unsafe wallpaper X-Filename is REJECTED, not silently rewritten', async () => {
    const store = createMemoryStore();
    for (const filename of [
        '',
        '    ',
        '../../etc/passwd.bmp',
        '..\\..\\evil.bmp',
        '/absolute.bmp',
        'sub/dir/wall.bmp',
        'sub\\dir\\wall.bmp',
        '.bmp',
        '..bmp',
        '.hidden.bmp', // the reader's own /.sleep is ITS namespace
        'wall.png',
        'wall',
        'wall.bmp.exe',
        'forged.bmp\nwp-9 5 set evil.bmp',
        'has\rcarriage.bmp',
        'has\ttab.bmp',
        'has\x00nul.bmp',
        `${'a'.repeat(WALLPAPER_FILENAME_MAX_LEN)}.bmp`, // over the cap once .bmp is counted
    ]) {
        const res = await postWallpaper(store, 'wp-1', 'set', filename, bmp(100, 1));
        assert.equal(res.status, 400, `filename=${JSON.stringify(filename)}`);
    }
    assert.equal(store.map.size, 0, 'no rejected filename may reach the store');
});

test('a merely awkward wallpaper X-Filename is sanitised, and the manifest stays ASCII', async () => {
    assert.deepEqual(sanitizeWallpaperFilename('Forest.bmp'), { ok: true, filename: 'Forest.bmp' });
    assert.deepEqual(sanitizeWallpaperFilename('  Forest.BMP \n'), { ok: true, filename: 'Forest.bmp' });
    assert.deepEqual(sanitizeWallpaperFilename('A: Wall?.bmp'), { ok: true, filename: 'A_ Wall_.bmp' });
    assert.deepEqual(sanitizeWallpaperFilename('Café Frappé.bmp'), { ok: true, filename: 'Caf_ Frapp_.bmp' });
    assert.deepEqual(sanitizeWallpaperFilename('Spaced    out.bmp'), { ok: true, filename: 'Spaced out.bmp' });
    assert.deepEqual(sanitizeWallpaperFilename(`${'a'.repeat(WALLPAPER_FILENAME_MAX_LEN - 4)}.bmp`), {
        ok: true,
        filename: `${'a'.repeat(WALLPAPER_FILENAME_MAX_LEN - 4)}.bmp`,
    });

    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'set', 'Café: Frappé*.BMP', bmp(100, 1));
    const line = text(await wallpaperManifest(store));
    assert.equal(line, 'wp-1 100 set Caf__ Frapp__.bmp\n');
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e\n]*$/.test(line), 'a manifest line must be printable ASCII');
    assert.equal(new TextEncoder().encode(line).byteLength, line.length);
});

test('a malformed wallpaper id in the URL is 404 and never becomes a store key', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));
    const reads = [];
    const watched = {
        get: (key) => {
            reads.push(key);
            return store.get(key);
        },
        put: (key, value) => store.put(key, value),
    };
    for (const raw of ['..', '.', 'has%20space', 'a'.repeat(WALLPAPER_ID_MAX_LEN + 1), 'caf%C3%A9']) {
        assert.equal((await call(watched, req('GET', `/m/${BOX}/wallpaper/${raw}`))).status, 404, raw);
        const del = await call(
            watched,
            req('DELETE', `/m/${BOX}/wallpaper/${raw}`, { headers: { authorization: `Bearer ${TOKEN}` } })
        );
        assert.equal(del.status, 404, raw);
    }
    assert.ok(
        !reads.some((key) => key.includes('..') || key.includes('%')),
        `no store key may be built from an unvalidated id: ${JSON.stringify(reads)}`
    );
});

// ---------------------------------------------------------------------------
// Delete, ordering, and storage faults
// ---------------------------------------------------------------------------

test('DELETE removes the wallpaper entry and the blob; deleting twice is 404', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', bmp(100, 1));
    await postWallpaper(store, 'wp-2', 'primary', undefined, bmp(200, 2));

    const res = await deleteWallpaper(store, 'wp-1');
    assert.equal(res.status, 200);
    assert.deepEqual(asJson(res), { ok: true, id: 'wp-1', target: 'set', filename: 'Forest.bmp' });
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-1')), false);
    assert.equal(text(await wallpaperManifest(store)), 'wp-2 200 primary -\n');

    assert.equal((await deleteWallpaper(store, 'wp-1')).status, 404);
    assert.equal((await deleteWallpaper(store, 'never-existed')).status, 404);

    // A deleted primary reports filename null, not "-".
    const delPrimary = await deleteWallpaper(store, 'wp-2');
    assert.deepEqual(asJson(delPrimary), { ok: true, id: 'wp-2', target: 'primary', filename: null });
    assert.equal(text(await wallpaperManifest(store)), '');
});

test('wallpaper publish writes the BLOB first and the manifest second; delete does the reverse', async () => {
    // The manifest must never advertise bytes that are absent — the reader
    // budgets a whole wake window per download, and on KV the two keys
    // replicate independently.
    const store = instrumentedStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));
    assert.deepEqual(store.puts, [wallpaperKey(BOX, 'wp-1'), wallpapersIndexKey(BOX)]);

    store.puts.length = 0;
    await deleteWallpaper(store, 'wp-1');
    assert.deepEqual(store.puts, [wallpapersIndexKey(BOX)]);
    assert.deepEqual(store.deletes, [wallpaperKey(BOX, 'wp-1')]);
});

test('a failed wallpaper manifest write reports published:false and changes nothing visible', async () => {
    const store = instrumentedStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));

    store.setBeforePut((key) => {
        if (key === wallpapersIndexKey(BOX)) throw new Error('kv down');
    });
    const res = await postWallpaper(store, 'wp-2', 'primary', undefined, bmp(200, 2));
    assert.equal(res.status, 503);
    assert.equal(asJson(res).published, false);

    store.setBeforePut(null);
    // The old primary is still the pending one, and the orphaned blob is left
    // in place DELIBERATELY: a put that threw may still have landed, and
    // deleting it would turn a live wallpaper into a permanent 404.
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 100 primary -\n');
    assert.equal(store.map.has(wallpaperKey(BOX, 'wp-2')), true);
    assert.equal((await getWallpaper(store, 'wp-2')).status, 404);
});

test('a store whose reads throw does not take the wallpaper routes down', async () => {
    const angry = {
        async get() {
            throw new Error('kv down');
        },
        async put() {},
    };
    // Nothing pending is a normal wake, so the manifest degrades rather than 500s.
    const man = await call(angry, req('GET', `/m/${BOX}/wallpaper.txt`, {}));
    assert.equal(man.status, 200);
    assert.equal(text(man), '');
    // A named download 404s: the manifest is what said it existed.
    assert.equal((await call(angry, req('GET', `/m/${BOX}/wallpaper/wp-1`))).status, 404);
    // /status still answers, with an empty list.
    const status = await call(angry, req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(status.status, 200);
    assert.deepEqual(asJson(status).wallpapers, []);
});

test('a wallpaper blob whose size disagrees with the manifest is refused, not served', async () => {
    // A reader that stitched a short slice into /sleep.bmp gets a corrupt sleep
    // screen and no way to know.
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(1000, 1));
    await store.put(wallpaperKey(BOX, 'wp-1'), bmp(999, 1));

    const res = await getWallpaper(store, 'wp-1');
    assert.equal(res.status, 500);
    assert.equal(asJson(res).error, 'corrupt_wallpaper');
    assert.equal(asJson(res).bytes, 999);
    assert.equal(asJson(res).expected, 1000);
});

test('the wallpaper routes are method-constrained', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));
    const auth = { authorization: `Bearer ${TOKEN}` };

    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const res = await call(store, req(method, `/m/${BOX}/wallpaper`, { headers: auth }));
        assert.equal(res.status, 405, `${method} /wallpaper`);
        assert.equal(res.headers.allow, 'POST', `${method} /wallpaper`);
    }
    for (const method of ['POST', 'PUT', 'PATCH']) {
        const res = await call(store, req(method, `/m/${BOX}/wallpaper.txt`, { headers: auth }));
        assert.equal(res.status, 405, `${method} /wallpaper.txt`);
        assert.equal(res.headers.allow, 'GET, HEAD', `${method} /wallpaper.txt`);
    }
    for (const method of ['POST', 'PUT', 'PATCH']) {
        const res = await call(store, req(method, `/m/${BOX}/wallpaper/wp-1`, { headers: auth }));
        assert.equal(res.status, 405, `${method} /wallpaper/{id}`);
        assert.equal(res.headers.allow, 'GET, HEAD, DELETE', `${method} /wallpaper/{id}`);
    }
});

test('wallpaper paths are parsed structurally; a stray segment is 404', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));
    for (const path of [
        `/m/${BOX}/wallpaper/wp-1/extra`,
        `/m/${BOX}/wallpaper.txt/extra`,
        `/m/${BOX}/wallpaper/wp-1/../..`,
        `/m/${BOX}/wallpapers`,
        `/m/${BOX}/wallpapers.txt`,
        `/m/${BOX}/sleep.bmp`,
    ]) {
        assert.equal((await call(store, req('GET', path))).status, 404, path);
    }
    // Trailing and duplicated slashes are still tolerated, exactly as elsewhere.
    assert.equal((await call(store, req('GET', `/m/${BOX}/wallpaper.txt/`))).status, 200);
    assert.equal((await call(store, req('GET', `//m/${BOX}//wallpaper/wp-1`))).status, 200);
});

test('boxes are isolated: a wallpaper published to one is invisible from the other', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));
    assert.equal(text(await wallpaperManifest(store, { box: OTHER_BOX })), '');
    assert.equal((await getWallpaper(store, 'wp-1', { box: OTHER_BOX })).status, 404);
    assert.equal((await deleteWallpaper(store, 'wp-1', { box: OTHER_BOX })).status, 404);
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 100 primary -\n');
});

test('every wallpaper response is uncacheable', async () => {
    // `no-store` is load-bearing, not hygiene: a cached wallpaper.txt would pin
    // the reader on a stale pending list, and a cached 404 would outlive the
    // publish that fixed it.
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));
    for (const res of [
        await wallpaperManifest(store),
        await getWallpaper(store, 'wp-1'),
        await getWallpaper(store, 'wp-1', { range: 'bytes=0-9' }),
        await getWallpaper(store, 'wp-1', { range: 'bytes=999999-' }),
        await getWallpaper(store, 'nope'),
        await postWallpaper(store, 'wp-2', 'set', 'Forest.bmp', bmp(50, 2)),
        await deleteWallpaper(store, 'wp-2'),
    ]) {
        assert.match(res.headers['cache-control'], /no-store/, String(res.status));
        assert.equal(res.headers['x-content-type-options'], 'nosniff', String(res.status));
    }
});

// ---------------------------------------------------------------------------
// REGRESSION: notes and books are untouched — additive means additive
// ---------------------------------------------------------------------------

test('wallpapers share a box with notes and books without touching their keys', async () => {
    const store = createMemoryStore();

    await publish(store, 'note-1', frame(1));
    await postBook(store, 'bk-1', 'Dune.epub', epub(500, 1));
    await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', bmp(300, 1));
    await publish(store, 'note-2', frame(2));
    await postWallpaper(store, 'wp-2', 'primary', undefined, bmp(400, 2));
    await postBook(store, 'bk-2', 'Hobbit.epub', epub(600, 2));

    // Every note assertion still holds, unchanged.
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-2');
    const gotFrame = await call(store, req('GET', `/m/${BOX}/current.frame`));
    assert.equal(gotFrame.status, 200);
    assert.equal(gotFrame.headers['content-type'], 'application/octet-stream');
    assert.equal(gotFrame.headers['content-length'], String(FRAME_BYTES));
    assert.deepEqual(gotFrame.body, frame(2));

    // Every book assertion, including the newest-FIRST manifest order that
    // wallpapers deliberately do not share.
    assert.equal(text(await manifest(store)), 'bk-2 600 Hobbit.epub\nbk-1 500 Dune.epub\n');
    assert.equal((await getBook(store, 'bk-1')).body.byteLength, 500);
    assert.equal((await getBook(store, 'bk-1')).headers['content-type'], 'application/epub+zip');

    // And the wallpaper one, newest LAST.
    assert.equal(text(await wallpaperManifest(store)), 'wp-1 300 set Forest.bmp\nwp-2 400 primary -\n');

    // The key set is exactly the notes keys PLUS the book keys PLUS the
    // wallpaper keys — no existing key changed name, and no new key collides.
    assert.deepEqual(
        [...store.map.keys()].sort(),
        [
            metaKey(BOX),
            frameKey(BOX, 'note-1'),
            frameKey(BOX, 'note-2'),
            booksIndexKey(BOX),
            bookKey(BOX, 'bk-1'),
            bookKey(BOX, 'bk-2'),
            wallpapersIndexKey(BOX),
            wallpaperKey(BOX, 'wp-1'),
            wallpaperKey(BOX, 'wp-2'),
        ].sort()
    );

    // The `:` -> `_` mapping the dev server's file store applies stays
    // injective across all four namespaces (the id charset excludes `_`, so no
    // id can spell `s_index`).
    const flat = [...store.map.keys()].map((key) => key.replace(/:/g, '_'));
    assert.equal(new Set(flat).size, flat.length);
    assert.ok(flat.every((name) => /^[A-Za-z0-9._~-]+$/.test(name)), JSON.stringify(flat));

    // Deleting every wallpaper leaves the notes and books sides intact.
    await deleteWallpaper(store, 'wp-1');
    await deleteWallpaper(store, 'wp-2');
    assert.equal(text(await wallpaperManifest(store)), '');
    assert.equal(text(await manifest(store)), 'bk-2 600 Hobbit.epub\nbk-1 500 Dune.epub\n');
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'note-2');
    assert.deepEqual((await call(store, req('GET', `/m/${BOX}/current.frame`))).body, frame(2));

    // And publishing a note still does not disturb either index.
    await publish(store, 'note-3', frame(3));
    assert.equal(text(await wallpaperManifest(store)), '');
    assert.equal(text(await manifest(store)), 'bk-2 600 Hobbit.epub\nbk-1 500 Dune.epub\n');
});

test('a wallpapers-only box still answers the note and book routes correctly', async () => {
    // The reader syncs notes on EVERY wake whether or not a wallpaper is
    // pending. A box that has only ever held wallpapers must look like an empty
    // mailbox with an empty library, not an error.
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'primary', undefined, bmp(100, 1));

    const latest = await call(store, req('GET', `/m/${BOX}/latest.txt`));
    assert.equal(latest.status, 200);
    assert.equal(text(latest), '');
    assert.equal((await call(store, req('GET', `/m/${BOX}/current.frame`))).status, 404);
    assert.equal(text(await manifest(store)), '');

    const status = await call(store, req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.deepEqual(asJson(status), {
        latestId: null,
        bytes: 0,
        updatedAt: null,
        books: [],
        wallpapers: [{ id: 'wp-1', target: 'primary', filename: null, bytes: 100 }],
    });
});

test('/status reports wallpapers newest first, with a null filename for a primary', async () => {
    const store = createMemoryStore();
    await postWallpaper(store, 'wp-1', 'set', 'Forest.bmp', bmp(100, 1));
    await postWallpaper(store, 'wp-2', 'primary', undefined, bmp(200, 2));

    const status = await call(store, req('GET', `/m/${BOX}/status`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    // JSON gets null, not the "-" placeholder: "-" is a POSITIONAL token for a
    // firmware line parser, and putting it here would invent a filename the
    // reader must not use.
    assert.deepEqual(asJson(status).wallpapers, [
        { id: 'wp-2', target: 'primary', filename: null, bytes: 200 },
        { id: 'wp-1', target: 'set', filename: 'Forest.bmp', bytes: 100 },
    ]);
    // Summary only — never the blobs.
    assert.equal(text(status).includes('updatedAt'), true);

    // And /status is a write-credentialed route, unchanged.
    assert.equal((await call(store, req('GET', `/m/${BOX}/status`, { headers: {} }))).status, 401);
});

test('the notes body cap is still 64 KB even though wallpapers may be 4 MiB', async () => {
    // The regression this guards is the one books already had: raising
    // MAX_REQUEST_BODY_BYTES globally would let a bogus oversize /publish be
    // buffered before the exact-size check rejects it.
    const store = createMemoryStore();
    assert.equal(requestBodyLimit('POST', `/m/${BOX}/publish`).bytes, MAX_REQUEST_BODY_BYTES);
    assert.equal((await publish(store, 'n1', new Uint8Array(FRAME_BYTES + 1))).status, 413);
    assert.equal((await publish(store, 'n1', frame(1))).status, 200);
    assert.equal(text(await call(store, req('GET', `/m/${BOX}/latest.txt`))), 'n1');
});
