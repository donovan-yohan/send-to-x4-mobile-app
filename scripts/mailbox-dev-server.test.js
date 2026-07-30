/**
 * Local mailbox dev-server tests — the two pieces of it that are NOT in
 * `mailbox/src/core.js` and therefore are not covered by
 * `scripts/mailbox-core.test.js`:
 *
 *   1. the request-body bound, and specifically the ORDER in which an oversize
 *      body is refused (413 first, socket teardown after) — plus, on the one
 *      route whose cap is measured in megabytes, that the bearer token is checked
 *      BEFORE a byte is buffered;
 *   2. the file-backed store, including the `delete` that publish's frame GC
 *      needs, the note-id charset its keys now carry, and the `stat`/`getRange`
 *      pair that lets a book range be read WITHOUT materialising the whole value.
 *
 * No sockets and no listening server: `mailbox_dev_server.mjs` only calls
 * `main()` when it is RUN, so importing it here is inert. Driving the functions
 * with fake req/res objects is what makes the ordering observable at all — over
 * a real socket "413" and "connection reset" are both just "the request ended".
 *
 * Run one file:
 *   NODE_OPTIONS=--max-old-space-size=512 timeout 60 \
 *     node --import tsx --test scripts/mailbox-dev-server.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore, readBoundedBody, rejectBeforeBody, rejectTooLarge } from './mailbox_dev_server.mjs';
import {
    FRAME_BYTES,
    MAX_BOOK_BYTES,
    MAX_REQUEST_BODY_BYTES,
    bookKey,
    frameKey,
    metaKey,
    requestBodyLimit,
    writeAuthPreflight,
} from '../mailbox/src/core.js';

const LIMIT = 64 * 1024;

/** Minimal stand-in for an http.IncomingMessage that is still uploading. */
function fakeRequest(headers = {}) {
    const req = new EventEmitter();
    req.headers = headers;
    req.destroyed = false;
    req.readableEnded = false;
    req.destroyCalls = 0;
    req.destroy = () => {
        req.destroyCalls += 1;
        req.destroyed = true;
    };
    return req;
}

/** Minimal stand-in for an http.ServerResponse that records what was written. */
function fakeResponse() {
    const res = new EventEmitter();
    res.written = null;
    res.writeHead = (status, headers) => {
        res.written = { status, headers, body: undefined };
    };
    res.end = (body) => {
        if (res.written) res.written.body = body;
        res.emit('finish');
    };
    return res;
}

// ---------------------------------------------------------------------------
// Body bound
// ---------------------------------------------------------------------------

test('an honest oversize Content-Length is refused before a byte is buffered', async () => {
    const req = fakeRequest({ 'content-length': String(LIMIT + 1) });
    const result = await readBoundedBody(req, LIMIT);
    assert.deepEqual(result, { tooLarge: true });
    assert.equal(req.destroyCalls, 0, 'readBoundedBody must never tear down the socket itself');
});

test('a garbage Content-Length is a 400-shaped answer, not a crash', async () => {
    for (const declared of ['not-a-number', '-1']) {
        const req = fakeRequest({ 'content-length': declared });
        assert.deepEqual(await readBoundedBody(req, LIMIT), { invalid: true }, declared);
    }
});

test('a body under the cap round-trips exactly', async () => {
    const req = fakeRequest({});
    const promise = readBoundedBody(req, LIMIT);
    req.emit('data', Buffer.from([1, 2, 3]));
    req.emit('data', Buffer.from([4, 5]));
    req.emit('end');
    const result = await promise;
    assert.deepEqual([...result.bytes], [1, 2, 3, 4, 5]);
});

test('a LYING/absent Content-Length is still capped, and does NOT reset the socket', async () => {
    // The regression this pins: `finish({tooLarge:true})` followed by
    // `req.destroy()` on the next line tore the connection down BEFORE the
    // handler's 413 could be written, because promise resolution is a
    // microtask. `curl -H 'Transfer-Encoding: chunked'` with a 200 KB body then
    // came back as `curl: (56) Recv failure`, http_code 000 — and the app's
    // describeNetworkFailure reports a reset as "could not reach the mailbox",
    // i.e. as RETRYABLE, when the note will be refused every single time.
    const req = fakeRequest({}); // chunked: no content-length at all
    const promise = readBoundedBody(req, 1024);

    for (let i = 0; i < 4; i++) req.emit('data', Buffer.alloc(512, i));
    const result = await promise;

    assert.deepEqual(result, { tooLarge: true });
    assert.equal(req.destroyCalls, 0, 'the socket must survive long enough to carry the 413');
});

test('bytes arriving after the cap is hit are discarded, not buffered', async () => {
    // The memory bound is what the 64 KB cap is FOR, and it has to keep holding
    // once the answer is decided — otherwise "answer first, tear down after"
    // would just move the unbounded buffering somewhere else.
    const req = fakeRequest({});
    const promise = readBoundedBody(req, 1024);
    req.emit('data', Buffer.alloc(2048));
    assert.deepEqual(await promise, { tooLarge: true });

    // 8 MB more after the decision. If any of it were retained this would show
    // up as heap growth; the assertion is simply that it is accepted without
    // resolving again or throwing.
    for (let i = 0; i < 16; i++) req.emit('data', Buffer.alloc(512 * 1024));
    req.emit('end');
    assert.deepEqual(await promise, { tooLarge: true }, 'the promise must not re-settle');
});

test('rejectTooLarge answers 413 WITH a body, and closes rather than resets', async () => {
    const res = fakeResponse();
    rejectTooLarge(res, LIMIT);

    assert.ok(res.written, 'a response must actually be written');
    assert.equal(res.written.status, 413);
    // `Connection: close` is the mechanism: node flushes this response, dumps
    // the rest of the request and only then destroys the socket (destroySoon).
    // Doing that by hand is what produced the bare reset.
    assert.equal(res.written.headers.connection, 'close');
    assert.equal(res.written.headers['content-type'], 'application/json; charset=utf-8');

    const body = JSON.parse(res.written.body.toString('utf8'));
    assert.equal(body.error, 'frame_too_large');
    assert.match(body.detail, new RegExp(String(LIMIT)));
});

test('the 413 is written before anything touches the socket', async () => {
    // End-to-end ordering over the two functions the handler composes.
    const req = fakeRequest({});
    const promise = readBoundedBody(req, 1024);
    req.emit('data', Buffer.alloc(4096));
    const read = await promise;
    assert.equal(read.tooLarge, true);

    const res = fakeResponse();
    rejectTooLarge(res, 1024);
    assert.equal(res.written.status, 413);
    assert.equal(req.destroyCalls, 0);
});

// ---------------------------------------------------------------------------
// File store
// ---------------------------------------------------------------------------

test('the file store round-trips, deletes, and accepts every legal note id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-store-'));
    try {
        const store = createFileStore(dir);
        const box = 'AbCdEfGhIjKlMnOpQrStUv';

        // `~` is in NOTE_ID_PATTERN, so a content-addressed frame key can
        // contain it. The store's safe-key check used to reject that, which
        // turned a legal note id into a thrown 500 on publish.
        for (const noteId of ['plain-1', 'has.dot', 'has~tilde', 'has_under-score.1']) {
            const key = frameKey(box, noteId);
            const bytes = new Uint8Array(FRAME_BYTES).fill(noteId.length & 0xff);
            await store.put(key, bytes);
            const back = await store.get(key);
            assert.equal(back.byteLength, FRAME_BYTES, noteId);
            assert.deepEqual(back, bytes, noteId);

            await store.delete(key);
            assert.equal(await store.get(key), null, `${noteId} must be gone after delete`);
        }

        // Deleting what is not there is a no-op: publish's GC runs after a
        // crash may already have removed the frame it is collecting.
        await store.delete(frameKey(box, 'never-existed'));
        assert.equal(await store.get(metaKey(box)), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the file store refuses a key that is not a safe filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-store-'));
    try {
        const store = createFileStore(dir);
        // Nothing reaches here with a slash in it — parsePath and the note-id
        // pattern both reject one — but this is the single place a store key
        // becomes a filesystem path, so it refuses rather than trusts.
        await assert.rejects(() => store.get('box:x/../../etc/passwd:frame'), /unsafe store key/);
        await assert.rejects(() => store.stat('box:x/../../etc/passwd:frame'), /unsafe store key/);
        await assert.rejects(() => store.getRange('box:x/../../etc/passwd:frame', 0, 1), /unsafe store key/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Ranged reads — the half of the store contract books need
// ---------------------------------------------------------------------------

test('the file store reads a WINDOW off the disk, not the whole value', async () => {
    // This is why `stat` + `getRange` are on the store contract at all. Without
    // them the core has to call `get`, which materialises the entire value — up to
    // MAX_BOOK_BYTES (24 MB) for every ranged request, in a process whose systemd
    // unit sets MemoryMax=256M. The reader resumes a book in small windows across
    // bounded wake cycles, so this is the exact path that has to stay bounded.
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-store-'));
    try {
        const store = createFileStore(dir);
        const key = bookKey('AbCdEfGhIjKlMnOpQrStUv', 'bk-1');
        const body = new Uint8Array(5000);
        for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 3) & 0xff;
        await store.put(key, body);

        assert.deepEqual(await store.stat(key), { bytes: 5000 });

        // Every window must equal the same slice of the full value — a reader
        // stitching these together has no way to detect an off-by-one.
        for (const [start, length] of [[0, 100], [1234, 1000], [4999, 1], [0, 5000]]) {
            const window = await store.getRange(key, start, length);
            assert.equal(window.byteLength, length, `${start}+${length}`);
            assert.deepEqual(window, body.subarray(start, start + length), `${start}+${length}`);
        }

        // A read past the end returns SHORT rather than padding with whatever
        // allocUnsafe left behind: the core compares the length it asked for and
        // refuses a short read instead of serving uninitialised memory.
        const short = await store.getRange(key, 4900, 500);
        assert.equal(short.byteLength, 100);
        assert.deepEqual(short, body.subarray(4900));
        assert.equal((await store.getRange(key, 5000, 10)).byteLength, 0);
        assert.equal((await store.getRange(key, 0, 0)).byteLength, 0);

        // Absent keys are null on BOTH, which the core turns into a self-healing
        // 404 rather than a 500.
        const missing = bookKey('AbCdEfGhIjKlMnOpQrStUv', 'never-existed');
        assert.equal(await store.stat(missing), null);
        assert.equal(await store.getRange(missing, 0, 10), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rejectTooLarge names the route that refused the body', async () => {
    // The books route has its own cap, so a 413 from it must not tell the app its
    // frame was too large.
    const res = fakeResponse();
    rejectTooLarge(res, 25165824, 'book_too_large');
    const body = JSON.parse(res.written.body.toString('utf8'));
    assert.equal(res.written.status, 413);
    assert.equal(body.error, 'book_too_large');
    assert.match(body.detail, /25165824/);
});

// ---------------------------------------------------------------------------
// Auth BEFORE the body — the 24 MiB amplification the books cap opened up
// ---------------------------------------------------------------------------

const BOX = 'AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'test-write-token-0123456789abcdef';

test('an unauthenticated POST /books is refused WITHOUT reading the body', async () => {
    // The measured bug: `readBoundedBody` ran before `handleRequest` ever reached
    // requireWriteAuth, so an anonymous 24 MiB upload was accepted in full and
    // then answered 401 — curl reported size_upload = 25165824 and RSS peaked
    // +55 MB, against a systemd unit with MemoryMax=256M. The boxId in the path
    // is a READ capability sent in cleartext, so it must not buy that allocation.
    const path = `/m/${BOX}/books`;
    const limit = requestBodyLimit('POST', path);
    assert.equal(limit.bytes, MAX_BOOK_BYTES);
    assert.ok(limit.bytes > MAX_REQUEST_BODY_BYTES, 'this route is the one that needs the preflight');

    const req = fakeRequest({ 'content-length': String(MAX_BOOK_BYTES), 'x-book-id': 'bk-1', 'x-filename': 'Dune.epub' });
    const denied = writeAuthPreflight(req.headers, { writeToken: TOKEN });
    assert.ok(denied, 'no credential must be refused before the body');
    assert.equal(denied.status, 401);

    const res = fakeResponse();
    rejectBeforeBody(res, denied);
    assert.equal(res.written.status, 401);
    assert.equal(res.written.headers['www-authenticate'], 'Bearer');
    // Same mechanism and same reason as the 413: flush, dump the rest of the
    // upload, then close. Without it node keeps the connection and dumps all
    // 24 MiB, which costs the client a body nobody will read.
    assert.equal(res.written.headers.connection, 'close');
    assert.equal(res.written.headers['content-length'], String(res.written.body.length));
    assert.equal(JSON.parse(res.written.body.toString('utf8')).error, 'unauthorized');
    assert.equal(req.destroyCalls, 0, 'the socket must survive long enough to carry the 401');

    // Nothing consumed the request, so bytes still arriving are simply nobody's
    // problem — no buffer is holding them.
    req.emit('data', Buffer.alloc(1024));
    req.emit('end');
    assert.equal(res.written.status, 401);
});

test('a credentialed POST /books passes the preflight and IS buffered', async () => {
    // The other half: the preflight must not become a second lock that a valid
    // upload has to get past. Same headers, correct bearer -> null, then the body
    // is read normally.
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-book-id': 'bk-1', 'x-filename': 'Dune.epub' };
    assert.equal(writeAuthPreflight(headers, { writeToken: TOKEN }), null);

    const req = fakeRequest(headers);
    const promise = readBoundedBody(req, MAX_BOOK_BYTES);
    req.emit('data', Buffer.from([9, 8, 7]));
    req.emit('end');
    assert.deepEqual([...(await promise).bytes], [9, 8, 7]);
});

test('the notes routes are NOT pre-authenticated, so an oversize body is still a 413', () => {
    // Deliberate asymmetry. 64 KB is cheap enough to buffer first, and pinning it
    // keeps the status code an oversize /publish gets today: 413 (the frame is
    // too big) rather than 401 (which would send the app looking for a token
    // problem it does not have).
    for (const path of [`/m/${BOX}/publish`, `/m/${BOX}/books/bk-1`]) {
        const limit = requestBodyLimit('POST', path);
        assert.equal(limit.bytes, MAX_REQUEST_BODY_BYTES, path);
        assert.ok(!(limit.bytes > MAX_REQUEST_BODY_BYTES), `${path} must not trip the preflight`);
    }
    assert.equal(requestBodyLimit('POST', `/m/${BOX}/publish`).error, 'frame_too_large');
});

// ---------------------------------------------------------------------------
// The body copy itself
// ---------------------------------------------------------------------------

test('the buffered body is a COPY, never a view onto a socket chunk', async () => {
    // node's socket chunks come out of a shared allocation pool, so returning a
    // window onto one (which `new Uint8Array(buf.buffer, ...)` over a
    // single-element Buffer.concat would do) hands the store a reference into
    // memory it does not own. The copy is the same cost and has no such question.
    const req = fakeRequest({});
    const chunk = Buffer.from([1, 2, 3, 4]);
    const promise = readBoundedBody(req, 1024);
    req.emit('data', chunk);
    req.emit('end');
    const { bytes } = await promise;

    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    chunk.fill(0xff); // whatever node does with that memory next must not matter
    assert.deepEqual([...bytes], [1, 2, 3, 4], 'the body must not alias the incoming chunk');
    assert.notEqual(bytes.buffer, chunk.buffer, 'and must not share its ArrayBuffer');
});

test('a refused oversize body allocates nothing when the request ends', async () => {
    // With the chunks released at the 413, an unguarded `end` handler would still
    // allocate `total` bytes — i.e. a 24 MiB allocation for a request that was
    // already answered. Observable as the promise keeping its tooLarge result.
    const req = fakeRequest({});
    const promise = readBoundedBody(req, 1024);
    req.emit('data', Buffer.alloc(4096));
    assert.deepEqual(await promise, { tooLarge: true });
    req.emit('end');
    assert.deepEqual(await promise, { tooLarge: true }, 'end must not re-settle with a buffer');
});
