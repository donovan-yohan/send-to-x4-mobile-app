/**
 * mailbox_client + love_note_sender routing — the wire contract the reader
 * depends on, and the decision about WHICH route a note takes.
 *
 * BOOKS ARE HERE TOO, at the bottom: they ride the same mailbox, the same URL
 * and the same token, so the risks they add (the 24 MiB cap mirrored from
 * `mailbox/src/core.js`, a filename that becomes a file on the SD card, an id
 * that becomes a store key) are pinned next to the note contract rather than in
 * a second file that could disagree with it.
 *
 * WHAT IS ACTUALLY AT RISK HERE. Every failure on this path is silent from the
 * phone's point of view: the reader reports nothing back, and it only collects
 * its mail at deep-sleep entry, so "the note never arrived" surfaces hours
 * later, if at all. The things worth pinning are therefore the ones whose
 * failure looks exactly like success:
 *
 *   - THE FRAME LENGTH. Firmware `MessageSync::syncBeforeSleep` compares the
 *     downloaded size against its framebuffer and DELETES anything else. A
 *     wrong-sized frame that the server happily accepts is a note that is
 *     discarded on every sync forever, while the app said "sent".
 *   - THE HEADERS. The token must travel in `Authorization`, never in the URL —
 *     the URL is the string typed into the reader, which cannot keep a secret.
 *     `X-Note-Id` is what the firmware dedups on: a missing or duplicated id
 *     means the reader skips the note entirely.
 *   - THE URL SHAPE. The firmware builds `base + "/latest.txt"` by string
 *     concatenation, so a trailing slash, a query string or a fragment produces
 *     a URL that resolves to nothing — on the READER, never here.
 *   - THE 128-CHAR CEILING. `messageSyncUrl` is 128 chars on the device. A base
 *     that does not fit cannot be stored, so every note published to it is
 *     undeliverable, permanently, with no error anywhere.
 *   - ID UNIQUENESS. Two notes sharing an id means the second is deduped away
 *     by the firmware and never shown.
 *   - THE FALLBACK DECISION. A host's reader is ASLEEP most of the time, which
 *     must fall back to the mailbox; a reader that ANSWERED and refused must NOT
 *     be papered over with a delayed delivery the user cannot see.
 *   - CLIENT ROUTING. A client has no LAN access to the reader; touching the
 *     direct transport at all is a bug that can only show up as a long hang.
 *
 * `mailbox_client` reaches the network through `globalThis.fetch`, which is
 * stubbed per test, and `love_note_sender` reaches the reader through
 * `__setLoveNoteTransport`, so all of the above runs under node against the REAL
 * modules. NOTHING here touches the network.
 *
 * Run:  node --import tsx --test scripts/mailbox-client.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import {
    BOOK_ID_MAX_CHARS,
    BOOK_ID_PREFIX,
    MAILBOX_BOOKS_PATH,
    MAILBOX_BOOK_FILENAME_MAX_CHARS,
    MAILBOX_FRAME_BYTES,
    MAILBOX_MAX_BOOK_BYTES,
    MAILBOX_PUBLISH_PATH,
    MAILBOX_STATUS_PATH,
    MAILBOX_URL_MAX_CHARS,
    NOTE_ID_MAX_CHARS,
    checkMailboxBaseUrl,
    deleteMailboxBook,
    describeMailboxUrlProblem,
    fetchMailboxStatus,
    isMailboxUnreachableError,
    listMailboxBooks,
    mintBookId,
    mintNoteId,
    normalizeMailboxUrl,
    publishBook,
    publishLoveNote,
} from '../src/services/mailbox_client';
import {
    LOVE_NOTE_FILENAME,
    LOVE_NOTE_FRAME_BYTES,
    LOVE_NOTE_ID_FILENAME,
    MAILBOX_SETUP_HINT,
    isDeviceUnreachableError,
    isMailboxConfigured,
    sendLoveNote,
    sendLoveNoteFrame,
    __setLoveNoteTransport,
} from '../src/services/love_note_sender';
import { validateReaderSyncUrl } from '../src/services/reader_provision';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const TOKEN = 'wr_secret_token';

/** A correctly sized frame. Content is irrelevant to every assertion here. */
function goodFrame(fill = 0xff) {
    return new Uint8Array(MAILBOX_FRAME_BYTES).fill(fill);
}

/**
 * Recording stand-in for `globalThis.fetch`.
 *
 * Captures the raw init object, because the HEADERS are half of this contract:
 * a test that only checked the URL could not tell a token in the Authorization
 * header apart from a token appended to the query string.
 */
function fakeFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const answer = typeof responder === 'function' ? responder(url, init, calls.length) : responder;
        return await answer;
    };
    return calls;
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

/** A fetch that fails the way a phone with no route fails. */
function deadNetwork() {
    return fakeFetch(() => {
        throw new TypeError('Network request failed');
    });
}

/**
 * A transport that behaves like the CROSSPOINT FIRMWARE, not like a stub.
 *
 * Same rule as `wallpaper-sender.test.js`'s `fakeDevice`: older firmware
 * REFUSES to overwrite an existing path ('ERROR: File already exists', proven
 * on hardware 2026-07-28) and writes NOTHING. An accept-everything mock cannot
 * see a missing pre-delete, which is exactly how that defect stayed invisible
 * once already.
 */
function fakeDevice({ existing = [], failWith = null } = {}) {
    const card = new Map(existing.map(path => [path, 0]));
    const calls = { uploads: [], deletes: [], ops: [] };
    const pathFor = (folder, filename) => `/${folder ? `${folder}/` : ''}${filename}`;

    __setLoveNoteTransport({
        async upload(ip, data, filename, onProgress, targetFolder) {
            const path = pathFor(targetFolder, filename);
            calls.uploads.push({ ip, byteLength: data.byteLength, filename, targetFolder, path });
            calls.ops.push(`upload:${path}`);
            if (failWith) return { success: false, error: failWith };
            if (card.has(path)) return { success: false, error: 'File already exists' };
            card.set(path, data.byteLength);
            if (onProgress) onProgress(100);
            return { success: true };
        },
        async deleteFile(ip, filename, targetFolder) {
            const path = pathFor(targetFolder, filename);
            calls.deletes.push({ ip, filename, targetFolder, path });
            calls.ops.push(`delete:${path}`);
            return card.delete(path);
        },
    });

    return { calls, paths: () => [...card.keys()].sort() };
}

/** A transport that must never be touched. Any call is the failure. */
function forbiddenDevice() {
    __setLoveNoteTransport({
        async upload() {
            throw new Error('direct upload must not be attempted on this path');
        },
        async deleteFile() {
            throw new Error('direct delete must not be attempted on this path');
        },
    });
}

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    __setLoveNoteTransport(null);
});

// ---------------------------------------------------------------------------
// Note ids
// ---------------------------------------------------------------------------

test('mintNoteId: 1000 ids are unique, url-safe, and within the length budget', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
        const id = mintNoteId();
        assert.match(id, /^[a-z0-9-]+$/, `id outside [a-z0-9-]: ${id}`);
        assert.ok(id.length <= NOTE_ID_MAX_CHARS, `id too long (${id.length}): ${id}`);
        assert.ok(id.length >= 8, `id suspiciously short: ${id}`);
        seen.add(id);
    }
    // A duplicate id is INVISIBLE in production: the firmware dedups on it, so
    // the second note is simply never displayed while the app reports success.
    assert.equal(seen.size, 1000, 'minted ids collided');
});

test('mintNoteId: ids stay unique inside a single frozen millisecond', () => {
    // Pins the sequence counter, not the RNG: a burst of sends inside one tick
    // must not depend on Math.random being well seeded (RN release builds have
    // been caught seeding poorly).
    Date.now = () => 1_800_000_000_000;
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(mintNoteId());
    assert.equal(seen.size, 500);
});

test('mintNoteId: later ids sort after earlier ones', () => {
    Date.now = () => 1_700_000_000_000;
    const older = mintNoteId();
    Date.now = () => 1_800_000_000_000;
    const newer = mintNoteId();
    // Lexicographic order is what makes a mailbox listing readable and lets
    // "is this newer?" be answered without a clock.
    assert.ok(older < newer, `${older} should sort before ${newer}`);
});

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

test('normalizeMailboxUrl strips every trailing slash and trims', () => {
    // The firmware pops trailing '/' the same way before appending its suffixes;
    // a base ending in '/' would otherwise fetch '…//latest.txt'.
    assert.equal(normalizeMailboxUrl(`  ${BASE}///  `), BASE);
    assert.equal(normalizeMailboxUrl(BASE), BASE);
});

test('normalizeMailboxUrl rejects everything the reader cannot fetch', () => {
    for (const bad of [
        '',
        '   ',
        'mail.example.net/m/abc',          // no scheme
        'ftp://mail.example.net/m/abc',    // wrong scheme
        `${BASE}?k=1`,                     // firmware concatenates → '…?k=1/latest.txt'
        `${BASE}#frag`,
        'https://user:pw@mail.example.net/m/abc',
    ]) {
        assert.equal(normalizeMailboxUrl(bad), '', `should be rejected: ${JSON.stringify(bad)}`);
        assert.ok(describeMailboxUrlProblem(bad), 'a rejection must come with a reason');
    }
});

test('normalizeMailboxUrl rejects a base the reader cannot store', () => {
    const tooLong = `https://mail.example.net/m/${'a'.repeat(MAILBOX_URL_MAX_CHARS)}`;
    assert.ok(tooLong.length > MAILBOX_URL_MAX_CHARS);
    assert.equal(normalizeMailboxUrl(tooLong), '');
    // The reason has to name the ceiling: this failure is otherwise completely
    // silent (the app publishes fine, the reader can never be pointed at it).
    assert.match(describeMailboxUrlProblem(tooLong), new RegExp(String(MAILBOX_URL_MAX_CHARS)));

    const atLimit = `https://m.example/${'a'.repeat(MAILBOX_URL_MAX_CHARS - 'https://m.example/'.length)}`;
    assert.equal(atLimit.length, MAILBOX_URL_MAX_CHARS);
    assert.equal(describeMailboxUrlProblem(atLimit), null, 'exactly the limit must be accepted');

    // 127, not 128: the reader's field is `char messageSyncUrl[128]`, so the
    // 128th character is eaten by the NUL terminator rather than rejected —
    // the reader would then poll a truncated URL that 404s forever.
    assert.equal(MAILBOX_URL_MAX_CHARS, 127);
    assert.ok(describeMailboxUrlProblem(`${atLimit}a`), '128 chars must be refused');
});

test('URL validation does not depend on the URL constructor', () => {
    // React Native REPLACES global URL with a non-spec polyfill
    // (Libraries/Blob/URL.js) whose single-argument constructor NEVER throws and
    // whose `protocol` getter does not lower-case the scheme. Node's URL is
    // spec-compliant, so anything validated THROUGH `new URL()` behaves one way
    // in this test file and another way on the phone — CI structurally cannot
    // see the difference. These cases are the ones that used to diverge.
    for (const hostless of ['https://', 'http://', 'https:///m/abc', 'https:/typo', 'https:/']) {
        assert.equal(
            normalizeMailboxUrl(hostless),
            '',
            `must be rejected without relying on URL throwing: ${JSON.stringify(hostless)}`
        );
    }
    assert.equal(checkMailboxBaseUrl('https://').defect, 'host');
    assert.equal(checkMailboxBaseUrl('https:/typo').defect, 'scheme');

    // An upper-case scheme is legal (RFC 3986 §3.1) and the reader's
    // `http.begin()` accepts it, so rejecting it here would refuse a URL the
    // reader is happily polling.
    assert.equal(normalizeMailboxUrl('HTTPS://mail.example.net/m/abc'), 'HTTPS://mail.example.net/m/abc');
    assert.equal(checkMailboxBaseUrl('HttP://192.168.1.9:8790/m/abc').defect, null);

    // AS TYPED, never re-serialised: this string is a capability URL, and
    // "helpfully" lower-casing a path segment produces a different, wrong box.
    const mixedCase = 'https://Mail.Example.NET/m/AbCdEfGhIjKlMnOpQrStUv';
    assert.equal(normalizeMailboxUrl(mixedCase), mixedCase);

    // Whitespace inside is a paste accident, and RN's polyfill would keep it.
    assert.equal(normalizeMailboxUrl('https://mail.example.net/m/a bc'), '');
});

test('the publisher and the reader-provisioner never disagree about a URL', () => {
    // These two used to validate independently. When they disagreed the symptom
    // was invisible from either screen: Settings would provision the reader with
    // a URL the publisher then refused on every send, and neither error
    // mentioned the other side.
    const corpus = [
        'https://mail.example.net/m/AbCdEfGhIjKlMnOpQrStUv',
        'HTTPS://mail.example.net/m/AbCdEfGhIjKlMnOpQrStUv',
        'http://192.168.1.9:8790/m/AbCdEfGhIjKlMnOpQrStUv',
        'https://mail.example.net/m/abc/',
        '  https://mail.example.net/m/abc  ',
        '',
        '   ',
        '/',
        'mail.example.net/m/abc',
        'ftp://mail.example.net/m/abc',
        'ws://mail/m/abc',
        'https://',
        'https:/typo',
        'https://user:pw@mail.example.net/m/abc',
        'https://mail.example.net/m/abc?k=1',
        'https://mail.example.net/m/abc#frag',
        'https://mail.example.net/m/a bc',
        `https://mail.example.net/m/${'a'.repeat(MAILBOX_URL_MAX_CHARS)}`,
    ];
    for (const raw of corpus) {
        const publisherOk = describeMailboxUrlProblem(raw) === null;
        const provisionerOk = validateReaderSyncUrl(raw).ok;
        assert.equal(
            publisherOk,
            provisionerOk,
            `disagreement on ${JSON.stringify(raw)}: publisher ${publisherOk}, provisioner ${provisionerOk}`
        );
        if (publisherOk) {
            // …and on the canonical form they each store.
            assert.equal(normalizeMailboxUrl(raw), validateReaderSyncUrl(raw).url, raw);
        }
    }
});

// ---------------------------------------------------------------------------
// publishLoveNote
// ---------------------------------------------------------------------------

test('publishLoveNote posts the frame with bearer auth and a note id', async () => {
    const calls = fakeFetch(reply(200, { ok: true, id: 'server-chosen-id' }));
    const progress = [];

    const result = await publishLoveNote(BASE, TOKEN, goodFrame(), p => progress.push(p));

    assert.equal(result.success, true, result.error);
    assert.equal(calls.length, 1);

    const { url, init } = calls[0];
    assert.equal(url, `${BASE}${MAILBOX_PUBLISH_PATH}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers['Content-Type'], 'application/octet-stream');
    assert.match(init.headers['X-Note-Id'], /^[a-z0-9-]+$/);
    assert.equal(init.body.byteLength, MAILBOX_FRAME_BYTES);

    // The token is the ONE secret here and the URL is public by design (the
    // reader stores it and echoes it from its own settings API).
    assert.ok(!url.includes(TOKEN), 'write token must never appear in the URL');

    // A server that rewrites ids wins: History must record what the reader sees.
    assert.equal(result.noteId, 'server-chosen-id');
    assert.deepEqual(progress, [0, 100]);
});

test('publishLoveNote strips a trailing slash before appending /publish', async () => {
    const calls = fakeFetch(reply(200, '{"ok":true}'));
    const result = await publishLoveNote(`${BASE}/`, TOKEN, goodFrame());
    assert.equal(result.success, true);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_PUBLISH_PATH}`);
    // No server id echoed → the minted id stands, and it is reported.
    assert.match(result.noteId, /^[a-z0-9-]+$/);
    assert.equal(calls[0].init.headers['X-Note-Id'], result.noteId);
});

test('publishLoveNote refuses a wrong-sized frame WITHOUT touching the network', async () => {
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    for (const bad of [new Uint8Array(0), new Uint8Array(MAILBOX_FRAME_BYTES - 1), new Uint8Array(MAILBOX_FRAME_BYTES + 1)]) {
        const result = await publishLoveNote(BASE, TOKEN, bad);
        assert.equal(result.success, false);
        assert.match(result.error, new RegExp(String(MAILBOX_FRAME_BYTES)));
    }
    // Publishing it would be WORSE than failing: the server may well accept it,
    // and the reader would then discard the download on every sync forever.
    assert.equal(calls.length, 0, 'a bad frame must never reach the network');
});

test('publishLoveNote reports a rejected token as a token problem', async () => {
    fakeFetch(reply(401, 'bad token'));
    const result = await publishLoveNote(BASE, TOKEN, goodFrame());
    assert.equal(result.success, false);
    assert.match(result.error, /token rejected/i);
    assert.match(result.error, /Settings/);
    assert.equal(result.status, 401);
    // A rejected token never fixes itself, so it must NOT read as unreachable.
    assert.equal(isMailboxUnreachableError(result.error), false);
});

test('publishLoveNote maps a size rejection back to the byte count', async () => {
    for (const status of [400, 413]) {
        fakeFetch(reply(status, 'frame must be 52272 bytes'));
        const result = await publishLoveNote(BASE, TOKEN, goodFrame());
        assert.equal(result.success, false);
        assert.match(result.error, new RegExp(String(MAILBOX_FRAME_BYTES)));
    }
});

test('publishLoveNote turns a dead network into an actionable error, never a throw', async () => {
    deadNetwork();
    const result = await publishLoveNote(BASE, TOKEN, goodFrame());
    assert.equal(result.success, false);
    assert.match(result.error, /could not reach the mailbox/i);
    assert.match(result.error, /connection/i);
    // A retry is worth offering here, unlike a 401.
    assert.equal(isMailboxUnreachableError(result.error), true);
    // The id is still reported so a retry can be correlated in logs.
    assert.match(result.noteId, /^[a-z0-9-]+$/);
});

test('publishLoveNote refuses to send without a token or with an unusable URL', async () => {
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    const noToken = await publishLoveNote(BASE, '   ', goodFrame());
    assert.equal(noToken.success, false);
    assert.match(noToken.error, /token/i);

    const badUrl = await publishLoveNote('not-a-url', TOKEN, goodFrame());
    assert.equal(badUrl.success, false);
    assert.match(badUrl.error, /URL/i);

    assert.equal(calls.length, 0);
});

test('publishLoveNote survives a 200 with a body that is not JSON', async () => {
    fakeFetch(reply(200, 'OK'));
    const result = await publishLoveNote(BASE, TOKEN, goodFrame());
    // The publish HAPPENED; an unparseable body is not a reason to tell the user
    // it failed and have them send the same note twice.
    assert.equal(result.success, true);
    assert.match(result.noteId, /^[a-z0-9-]+$/);
});

// ---------------------------------------------------------------------------
// fetchMailboxStatus
// ---------------------------------------------------------------------------

test('fetchMailboxStatus reads the mailbox back over bearer auth', async () => {
    const calls = fakeFetch(
        reply(200, { latestId: 'abc123', bytes: MAILBOX_FRAME_BYTES, updatedAt: 1700000000000 })
    );

    const result = await fetchMailboxStatus(`${BASE}/`, TOKEN);

    assert.equal(result.success, true, result.error);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_STATUS_PATH}`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(result.status, {
        latestId: 'abc123',
        bytes: MAILBOX_FRAME_BYTES,
        updatedAt: 1700000000000,
    });
});

test('fetchMailboxStatus reports an empty mailbox as empty, not as a failure', async () => {
    fakeFetch(reply(200, { latestId: null }));
    const result = await fetchMailboxStatus(BASE, TOKEN);
    // 'no note yet' is exactly what the firmware reads as "nothing to fetch";
    // conflating it with a parse failure would make a working mailbox look broken.
    assert.equal(result.success, true, result.error);
    assert.equal(result.status.latestId, null);
    assert.equal(result.status.bytes, null);
});

test('fetchMailboxStatus never throws on a rejected token or a junk body', async () => {
    fakeFetch(reply(403, 'nope'));
    const denied = await fetchMailboxStatus(BASE, TOKEN);
    assert.equal(denied.success, false);
    assert.match(denied.error, /token rejected/i);

    fakeFetch(reply(200, '<html>not json</html>'));
    const junk = await fetchMailboxStatus(BASE, TOKEN);
    assert.equal(junk.success, false);
    assert.match(junk.error, /JSON/i);

    deadNetwork();
    const dead = await fetchMailboxStatus(BASE, TOKEN);
    assert.equal(dead.success, false);
    assert.match(dead.error, /could not reach the mailbox/i);
});

// ---------------------------------------------------------------------------
// Direct path (now reachable under node through the transport seam)
// ---------------------------------------------------------------------------

test('sendLoveNoteFrame deletes the slot BEFORE uploading it', async () => {
    const device = fakeDevice({ existing: ['/.love-notes/current.frame'] });

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame());

    assert.equal(result.success, true, result.error);
    // Order is the whole point: older firmware answers 'ERROR: File already
    // exists' and writes NOTHING, so an upload-then-delete (or no delete) works
    // exactly once per name and then leaves the OLD note on the panel.
    //
    // A direct send writes TWO files — the frame and the `current.id` sidecar the
    // firmware dedups on — so both slots are cleared first and the id goes LAST.
    // `scripts/love-note-sender.test.js` owns the sidecar's own contract
    // (contents, failure modes, what the reader does with the pair).
    assert.deepEqual(device.calls.ops, [
        `delete:/.love-notes/${LOVE_NOTE_ID_FILENAME}`,
        `delete:/.love-notes/${LOVE_NOTE_FILENAME}`,
        `upload:/.love-notes/${LOVE_NOTE_FILENAME}`,
        `upload:/.love-notes/${LOVE_NOTE_ID_FILENAME}`,
    ]);
    assert.equal(device.calls.uploads[0].byteLength, LOVE_NOTE_FRAME_BYTES);
});

test('sendLoveNoteFrame rejects a wrong-sized frame without touching the device', async () => {
    const device = fakeDevice();
    const result = await sendLoveNoteFrame('10.0.0.5', new Uint8Array(10));
    assert.equal(result.success, false);
    assert.match(result.error, new RegExp(String(LOVE_NOTE_FRAME_BYTES)));
    assert.deepEqual(device.calls.ops, []);
});

// ---------------------------------------------------------------------------
// Routing: client
// ---------------------------------------------------------------------------

test('client routes to the mailbox and never touches the reader', async () => {
    forbiddenDevice();
    const calls = fakeFetch(reply(200, { ok: true, id: 'note-1' }));

    const result = await sendLoveNote(
        { role: 'client', ip: 'crosspoint.local', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
        goodFrame()
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox');
    assert.equal(result.noteId, 'note-1');
    assert.deepEqual(result.attempts.map(a => a.path), ['mailbox']);
    assert.equal(calls.length, 1);
});

test('client without a mailbox fails with the one canonical hint, offline', async () => {
    forbiddenDevice();
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    for (const dest of [
        { role: 'client', ip: 'crosspoint.local' },
        { role: 'client', ip: 'crosspoint.local', mailboxUrl: BASE },          // no token
        { role: 'client', ip: 'crosspoint.local', mailboxWriteToken: TOKEN },  // no url
    ]) {
        const result = await sendLoveNote(dest, goodFrame());
        assert.equal(result.success, false);
        assert.equal(result.error, MAILBOX_SETUP_HINT);
        assert.deepEqual(result.attempts, [], 'nothing should have been attempted');
        assert.equal(isMailboxConfigured(dest), false);
    }
    assert.equal(calls.length, 0);
});

test('client with a malformed mailbox URL gets the specific reason', async () => {
    forbiddenDevice();
    fakeFetch(reply(200, '{"ok":true}'));

    const result = await sendLoveNote(
        { role: 'client', ip: 'x', mailboxUrl: `${BASE}?k=1`, mailboxWriteToken: TOKEN },
        goodFrame()
    );
    assert.equal(result.success, false);
    // Telling someone who already typed a URL to "set up mailbox in Settings"
    // says nothing about what is wrong with it.
    assert.notEqual(result.error, MAILBOX_SETUP_HINT);
    assert.match(result.error, /query string/i);
});

// ---------------------------------------------------------------------------
// Routing: host
// ---------------------------------------------------------------------------

test('host prefers the reader and does not publish when it answers', async () => {
    const device = fakeDevice();
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    const result = await sendLoveNote(
        { role: 'host', ip: '10.0.0.5', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
        goodFrame()
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'direct');
    assert.deepEqual(result.attempts.map(a => a.path), ['direct']);
    // Two uploads, not one: the frame plus its `current.id` sidecar.
    assert.equal(device.calls.uploads.length, 2);
    assert.equal(calls.length, 0, 'a reachable reader must not also be mailed');
});

test('host falls back to the mailbox when the reader is asleep', async () => {
    // 'WebSocket connection failed' is verbatim what crosspoint_upload resolves
    // with when the reader is not on the network — i.e. the NORMAL state.
    const device = fakeDevice({ failWith: 'WebSocket connection failed' });
    const calls = fakeFetch(reply(200, { ok: true, id: 'note-2' }));

    const result = await sendLoveNote(
        { role: 'host', ip: '10.0.0.5', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
        goodFrame()
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox', 'the UI has to be able to say WHERE it went');
    assert.equal(result.noteId, 'note-2');
    assert.deepEqual(result.attempts.map(a => `${a.path}:${a.success}`), [
        'direct:false',
        'mailbox:true',
    ]);
    assert.equal(device.calls.uploads.length, 1);
    assert.equal(calls.length, 1);
});

test('host does NOT fall back when the reader answered and refused', async () => {
    // The firmware's overwrite refusal: the reader is right there, and the user
    // needs to see the real condition rather than a delayed delivery they never
    // asked for and cannot observe.
    const device = fakeDevice({ failWith: 'File already exists' });
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    const result = await sendLoveNote(
        { role: 'host', ip: '10.0.0.5', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
        goodFrame()
    );

    assert.equal(result.success, false);
    assert.equal(result.error, 'File already exists');
    assert.deepEqual(result.attempts.map(a => a.path), ['direct']);
    assert.equal(calls.length, 0, 'a reachable reader must not be papered over');
    assert.equal(device.calls.uploads.length, 1);
});

test('host with no mailbox reports the reader failure and points at Settings', async () => {
    fakeDevice({ failWith: 'WebSocket upload timed out' });
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    const result = await sendLoveNote({ role: 'host', ip: '10.0.0.5' }, goodFrame());

    assert.equal(result.success, false);
    assert.match(result.error, /WebSocket upload timed out/);
    assert.match(result.error, new RegExp(MAILBOX_SETUP_HINT));
    assert.deepEqual(result.attempts.map(a => a.path), ['direct']);
    assert.equal(calls.length, 0);
});

test('host reports BOTH failures when the reader is asleep and the mailbox is down', async () => {
    fakeDevice({ failWith: 'Cannot reach X4. Network request failed' });
    deadNetwork();

    const result = await sendLoveNote(
        { role: 'host', ip: '10.0.0.5', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
        goodFrame()
    );

    assert.equal(result.success, false);
    assert.equal(result.path, undefined);
    // Either half alone sends the user chasing the wrong thing.
    assert.match(result.error, /Cannot reach X4/);
    assert.match(result.error, /mailbox failed too/i);
    assert.deepEqual(result.attempts.map(a => `${a.path}:${a.success}`), [
        'direct:false',
        'mailbox:false',
    ]);
});

test('a wrong-sized frame fails once, before either route is attempted', async () => {
    forbiddenDevice();
    const calls = fakeFetch(reply(200, '{"ok":true}'));

    for (const role of ['host', 'client']) {
        const result = await sendLoveNote(
            { role, ip: '10.0.0.5', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
            new Uint8Array(MAILBOX_FRAME_BYTES - 1)
        );
        assert.equal(result.success, false);
        assert.match(result.error, new RegExp(String(LOVE_NOTE_FRAME_BYTES)));
        assert.deepEqual(result.attempts, []);
    }
    assert.equal(calls.length, 0);
});

test('an unknown role is treated as host, matching every other read of it', async () => {
    const device = fakeDevice();
    fakeFetch(reply(200, '{"ok":true}'));

    const result = await sendLoveNote(
        { role: 'wat', ip: '10.0.0.5', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
        goodFrame()
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'direct');
    assert.equal(device.calls.uploads.length, 2);   // frame + current.id sidecar
});

test('isDeviceUnreachableError separates "no answer" from "answered and refused"', () => {
    for (const unreachable of [
        'WebSocket connection failed',
        'WebSocket upload timed out',
        'Connection closed unexpectedly',
        'Cannot reach X4. Network request failed',
        'Device transport unavailable in this runtime.',
        '',
        undefined,
    ]) {
        assert.equal(isDeviceUnreachableError(unreachable), true, `unreachable: ${unreachable}`);
    }
    for (const refused of ['File already exists', 'HTTP 404: Not Found', 'Card is full']) {
        assert.equal(isDeviceUnreachableError(refused), false, `refusal: ${refused}`);
    }
});

// ---------------------------------------------------------------------------
// Books: the mailbox as a library queue
//
// WHAT IS AT RISK ON THIS ROUTE, and why each of these is pinned:
//
//   - THE HEADERS. `X-Book-Id` becomes a store key, a URL path segment and a
//     `books.txt` field; `X-Filename` becomes a FILE THE READER CREATES. The
//     token must ride in `Authorization` and never in the URL, exactly as on the
//     note route, because the URL is the string typed into the reader.
//   - THE CAP. A body over MAX_BOOK_BYTES cannot be stored (Workers KV caps one
//     value at 25 MiB). Discovering that AFTER uploading 24 MiB on a phone radio
//     is the failure worth spending a local guard on.
//   - THE SUBARRAY WINDOW. `bytes` may be a view into a larger buffer; sending
//     the whole buffer would publish a book with megabytes of somebody else's
//     data appended, and the server would accept it.
//   - THE LISTING SOURCE. `/status` is authenticated and JSON; `books.txt` is the
//     FIRMWARE's byte-exact contract and has no auth. Reading the wrong one makes
//     a broken token look like a healthy, empty library.
// ---------------------------------------------------------------------------

const EPUB = 'Dune.epub';

/** Bytes that are recognisably not zeroes, so a truncation shows up. */
function bookBytes(length = 4096) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 1) & 0xff;
    return bytes;
}

test('publishBook posts the epub with the id, the filename and the bearer token', async () => {
    const calls = fakeFetch(
        reply(200, { ok: true, id: 'bk-abc', filename: EPUB, bytes: 4096 })
    );
    const bytes = bookBytes();

    const result = await publishBook(`${BASE}/`, TOKEN, bytes, EPUB);

    assert.equal(result.success, true, result.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_BOOKS_PATH}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
    assert.equal(calls[0].init.headers['X-Filename'], EPUB);
    assert.match(calls[0].init.headers['X-Book-Id'], /^[A-Za-z0-9._~-]{1,64}$/);
    assert.equal(calls[0].init.body.byteLength, bytes.byteLength);
    // THE TOKEN IS NEVER IN THE URL: that string is what gets typed into the
    // reader, which serves its own settings to anyone on the LAN.
    assert.ok(!calls[0].url.includes(TOKEN), `token leaked into ${calls[0].url}`);
    // The SERVER's id and filename win: X-Filename is sanitized server-side, so
    // the name the reader creates can legitimately differ from the one sent.
    assert.equal(result.id, 'bk-abc');
    assert.equal(result.filename, EPUB);
    assert.equal(result.bytes, 4096);
    assert.equal(result.status, 200);
});

test('publishBook sends the SUPPLIED id when given one, so a retry overwrites', async () => {
    const calls = fakeFetch(reply(200, { ok: true, id: 'bk-retry', filename: EPUB }));

    const result = await publishBook(BASE, TOKEN, bookBytes(16), EPUB, 'bk-retry');

    assert.equal(result.success, true, result.error);
    // Re-POSTing the same id overwrites the blob — that is the ONLY thing that
    // makes a retry after a timeout safe rather than a second copy of the book.
    assert.equal(calls[0].init.headers['X-Book-Id'], 'bk-retry');
});

test('publishBook sends ONLY the view it was handed, never the whole buffer', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));
    const backing = bookBytes(4096);
    const window = backing.subarray(1024, 2048);

    const result = await publishBook(BASE, TOKEN, window, EPUB);

    assert.equal(result.success, true, result.error);
    // A book published from a subarray must carry 1024 bytes, not 4096. The
    // server would happily store the longer body, and the extra bytes would be
    // whatever else lives in that buffer.
    assert.equal(calls[0].init.body.byteLength, 1024);
    assert.deepEqual(new Uint8Array(calls[0].init.body), window);
});

test('publishBook reports a rejected token without retrying, and keeps the id', async () => {
    const calls = fakeFetch(reply(401, 'bad token'));

    const result = await publishBook(BASE, TOKEN, bookBytes(64), EPUB, 'bk-401');

    assert.equal(result.success, false);
    assert.equal(calls.length, 1, 'a rejected token must not be retried');
    assert.match(result.error, /token rejected \(401\)/i);
    assert.match(result.error, /Settings/);
    // The id comes back on a REJECTED publish too: a retry after fixing the
    // token has to be able to reuse it rather than mint a second book.
    assert.equal(result.id, 'bk-401');
    assert.equal(result.status, 401);
});

test('publishBook explains a 413 as the SIZE cap, not as a bad frame', async () => {
    fakeFetch(reply(413, 'too big'));

    const result = await publishBook(BASE, TOKEN, bookBytes(64), EPUB);

    assert.equal(result.success, false);
    assert.match(result.error, /413/);
    // The same status means something completely different on /publish (a
    // wrong-sized FRAME, an encoder bug). Here it is actionable: send a smaller
    // book. The wording must name the limit.
    assert.match(result.error, /24 MiB/);
    assert.doesNotMatch(result.error, /frame/i);
});

test('publishBook explains a 400 as a bad id, filename or empty body', async () => {
    fakeFetch(reply(400, 'X-Filename must end in .epub'));
    const result = await publishBook(BASE, TOKEN, bookBytes(64), EPUB);
    assert.equal(result.success, false);
    assert.match(result.error, /400/);
    assert.match(result.error, /X-Filename must end in \.epub/);
});

test('publishBook refuses an oversize book BEFORE spending the upload', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));
    // One allocation, used for both halves of the boundary.
    const overCap = new Uint8Array(MAILBOX_MAX_BOOK_BYTES + 1);

    const rejected = await publishBook(BASE, TOKEN, overCap, EPUB);

    assert.equal(rejected.success, false);
    // THE POINT OF THE GUARD: nothing went on the wire. Without it the phone
    // uploads 24 MiB over a mobile connection to be told 413.
    assert.equal(calls.length, 0, 'an oversize book must not be uploaded');
    assert.match(rejected.error, /24 MiB/);

    // Exactly AT the cap is legal — the server's own bound is inclusive, and an
    // off-by-one here would refuse a book the mailbox can hold.
    const atCap = overCap.subarray(0, MAILBOX_MAX_BOOK_BYTES);
    const accepted = await publishBook(BASE, TOKEN, atCap, EPUB);
    assert.equal(accepted.success, true, accepted.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.body.byteLength, MAILBOX_MAX_BOOK_BYTES);
});

test('publishBook refuses an empty body locally: a 0-byte epub is a failed read', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));

    for (const empty of [new Uint8Array(0), null, undefined]) {
        const result = await publishBook(BASE, TOKEN, empty, EPUB);
        assert.equal(result.success, false);
        assert.match(result.error, /empty/i);
    }
    // The server answers 400; reporting that would blame the mailbox for the
    // phone's failed read.
    assert.equal(calls.length, 0);
});

test('publishBook rejects every filename the mailbox would refuse, before the upload', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));

    const cases = [
        ['', /empty/i],
        ['   ', /empty/i],
        ['Dune', /\.epub/],                                  // no extension
        ['Dune.pdf', /\.epub/],
        ['books/Dune.epub', /bare name/i],                   // path, not a name
        ['books\\Dune.epub', /bare name/i],
        ['.Dune.epub', /start with/i],                       // hidden on the reader
        ['..', /start with/i],
        ['Du\nne.epub', /control characters/i],              // would forge a books.txt line
        [`${'D'.repeat(MAILBOX_BOOK_FILENAME_MAX_CHARS)}.epub`, /characters/],
    ];
    for (const [name, pattern] of cases) {
        const result = await publishBook(BASE, TOKEN, bookBytes(16), name);
        assert.equal(result.success, false, `accepted ${JSON.stringify(name)}`);
        assert.match(result.error, pattern);
    }
    assert.equal(calls.length, 0, 'a refusable filename must not be uploaded');
});

test('publishBook rejects an id that would become a bad key or a bad path', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));

    for (const id of ['..', '.', 'has space', 'has/slash', 'a'.repeat(BOOK_ID_MAX_CHARS + 1)]) {
        const result = await publishBook(BASE, TOKEN, bookBytes(16), EPUB, id);
        assert.equal(result.success, false, `accepted id ${JSON.stringify(id)}`);
    }
    // '..' matches the id charset, so the dot-only reject IS the traversal guard
    // for the dev server, whose store keys become filesystem paths.
    assert.equal(calls.length, 0);
});

test('publishBook validates the URL and the token before touching the network', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));

    const noUrl = await publishBook('', TOKEN, bookBytes(16), EPUB);
    assert.equal(noUrl.success, false);
    assert.match(noUrl.error, /Mailbox URL is empty/);

    const badUrl = await publishBook(`${BASE}?k=1`, TOKEN, bookBytes(16), EPUB);
    assert.equal(badUrl.success, false);
    assert.match(badUrl.error, /query string/);

    const noToken = await publishBook(BASE, '   ', bookBytes(16), EPUB);
    assert.equal(noToken.success, false);
    assert.match(noToken.error, /write token is not set/);

    assert.equal(calls.length, 0);
});

test('publishBook never throws on a dead network, and says the mailbox is unreachable', async () => {
    deadNetwork();

    const result = await publishBook(BASE, TOKEN, bookBytes(64), EPUB, 'bk-dead');

    assert.equal(result.success, false);
    assert.match(result.error, /could not reach the mailbox/i);
    // The caller has to be able to tell "unreachable, try later" from "refused,
    // never going to work" — a book upload is expensive to retry blindly.
    assert.equal(isMailboxUnreachableError(result.error), true);
    assert.equal(result.id, 'bk-dead');
});

test('publishBook treats a 200 with an unreadable body as a success', async () => {
    fakeFetch(reply(200, 'OK'));
    const result = await publishBook(BASE, TOKEN, bookBytes(16), EPUB);
    // The write HAPPENED. Reporting a failure here would have the user upload the
    // same book again, and the mailbox only holds 20.
    assert.equal(result.success, true);
    assert.match(result.id, /^bk-/);
    assert.equal(result.filename, EPUB);
});

// ---------------------------------------------------------------------------
// Book ids
// ---------------------------------------------------------------------------

test('mintBookId: prefixed, url-safe, unique across 1000 mints', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
        const id = mintBookId();
        assert.ok(id.startsWith(BOOK_ID_PREFIX), `missing prefix: ${id}`);
        // Inside the server's charset AND inside the app's own note-id charset,
        // so nothing downstream has to escape it.
        assert.match(id, /^[a-z0-9-]+$/, `id outside [a-z0-9-]: ${id}`);
        assert.ok(id.length <= BOOK_ID_MAX_CHARS, `id too long (${id.length}): ${id}`);
        seen.add(id);
    }
    // A duplicate id OVERWRITES the earlier book: the loss is silent and it is
    // the FIRST book, which the user already saw reported as sent.
    assert.equal(seen.size, 1000, 'minted book ids collided');
});

test('mintBookId: unique inside one frozen millisecond, and sortable across them', () => {
    Date.now = () => 1_800_000_000_000;
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(mintBookId());
    assert.equal(seen.size, 500);

    Date.now = () => 1_700_000_000_000;
    const older = mintBookId();
    Date.now = () => 1_900_000_000_000;
    assert.ok(older < mintBookId(), 'book ids must sort by mint time');
});

test('mintBookId ids are distinguishable from note ids', () => {
    // Both live in the same box and the same charset and both show up in server
    // logs; the prefix is what makes a hand trace possible.
    assert.ok(mintBookId().startsWith(BOOK_ID_PREFIX));
    assert.ok(!mintNoteId().startsWith(BOOK_ID_PREFIX));
});

// ---------------------------------------------------------------------------
// listMailboxBooks
// ---------------------------------------------------------------------------

test('listMailboxBooks reads /status over bearer auth, NOT the unauthenticated books.txt', async () => {
    const calls = fakeFetch(
        reply(200, {
            latestId: 'note-1',
            bytes: MAILBOX_FRAME_BYTES,
            books: [
                { id: 'bk-2', filename: 'Newest.epub', bytes: 2048 },
                { id: 'bk-1', filename: 'Oldest.epub', bytes: 1024 },
            ],
        })
    );

    const result = await listMailboxBooks(BASE, TOKEN);

    assert.equal(result.success, true, result.error);
    // /status, not /books.txt: the manifest is the FIRMWARE's byte-exact contract
    // and has no auth, so a listing built on it would show a healthy library on a
    // mailbox this phone cannot write to.
    assert.equal(calls[0].url, `${BASE}${MAILBOX_STATUS_PATH}`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    // Server order is preserved (newest first) — the app must not re-sort a list
    // whose order is part of what the reader does with it.
    assert.deepEqual(result.books, [
        { id: 'bk-2', filename: 'Newest.epub', bytes: 2048 },
        { id: 'bk-1', filename: 'Oldest.epub', bytes: 1024 },
    ]);
});

test('listMailboxBooks reads an empty library as empty, not as a failure', async () => {
    // A box that has only ever held notes answers WITHOUT the key at all; a box
    // whose books were all deleted answers with []. Both are a normal, empty
    // library, and neither may look like a broken mailbox.
    for (const body of [{ latestId: null }, { latestId: null, books: [] }]) {
        fakeFetch(reply(200, body));
        const result = await listMailboxBooks(BASE, TOKEN);
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.books, []);
    }
});

test('listMailboxBooks drops entries it cannot act on rather than rendering blanks', async () => {
    fakeFetch(
        reply(200, {
            books: [
                { id: 'bk-ok', filename: 'Fine.epub', bytes: 10 },
                { filename: 'No id.epub', bytes: 10 },     // no handle for delete/retry
                { id: 'bk-noname', bytes: 10 },            // nothing to show the user
                'not an object',
                { id: 'bk-nobytes', filename: 'Sizeless.epub' },
            ],
        })
    );

    const result = await listMailboxBooks(BASE, TOKEN);

    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.books, [
        { id: 'bk-ok', filename: 'Fine.epub', bytes: 10 },
        // A missing size degrades to 0 (cosmetic); a missing id or filename is
        // dropped, because every action the UI offers needs both.
        { id: 'bk-nobytes', filename: 'Sizeless.epub', bytes: 0 },
    ]);
});

test('listMailboxBooks never throws on a rejected token, a junk body or a dead network', async () => {
    fakeFetch(reply(403, 'nope'));
    const denied = await listMailboxBooks(BASE, TOKEN);
    assert.equal(denied.success, false);
    assert.match(denied.error, /token rejected/i);
    // Never a half-answer: a failed listing is an EMPTY list plus an error, so a
    // caller that renders `books` cannot show a stale or partial library.
    assert.deepEqual(denied.books, []);

    fakeFetch(reply(200, '<html>not json</html>'));
    const junk = await listMailboxBooks(BASE, TOKEN);
    assert.equal(junk.success, false);
    assert.match(junk.error, /JSON/i);

    deadNetwork();
    const dead = await listMailboxBooks(BASE, TOKEN);
    assert.equal(dead.success, false);
    assert.match(dead.error, /could not reach the mailbox/i);
    assert.deepEqual(dead.books, []);
});

// ---------------------------------------------------------------------------
// deleteMailboxBook
// ---------------------------------------------------------------------------

test('deleteMailboxBook DELETEs {base}/books/{id} with the raw id and the token', async () => {
    const calls = fakeFetch(reply(200, { ok: true, id: 'bk-1', filename: 'Dune.epub' }));

    const result = await deleteMailboxBook(`${BASE}/`, TOKEN, ' bk-1 ');

    assert.equal(result.success, true, result.error);
    // The id is charset-restricted, so it must go on the wire UNESCAPED — the
    // server compares the raw path segment against its stored id.
    assert.equal(calls[0].url, `${BASE}${MAILBOX_BOOKS_PATH}/bk-1`);
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(result.filename, 'Dune.epub');
});

test('deleteMailboxBook reports an unknown id instead of pretending it worked', async () => {
    fakeFetch(reply(404, ''));
    const result = await deleteMailboxBook(BASE, TOKEN, 'bk-gone');
    assert.equal(result.success, false);
    // Unlike the pre-delete on the direct path (where "nothing there" is the
    // ordinary first-upload case), this id came from a listing the user just
    // saw — a 404 means the two disagree and that is worth showing.
    assert.match(result.error, /no book with id "bk-gone"/);
    assert.equal(result.status, 404);
});

test('deleteMailboxBook refuses a traversal id and a missing token locally', async () => {
    const calls = fakeFetch(reply(200, { ok: true }));

    for (const id of ['', '   ', '..', 'a/b', 'x y']) {
        const result = await deleteMailboxBook(BASE, TOKEN, id);
        assert.equal(result.success, false, `accepted id ${JSON.stringify(id)}`);
    }
    const noToken = await deleteMailboxBook(BASE, '', 'bk-1');
    assert.equal(noToken.success, false);
    assert.match(noToken.error, /write token is not set/);

    assert.equal(calls.length, 0);
});

test('deleteMailboxBook never throws on a dead network', async () => {
    deadNetwork();
    const result = await deleteMailboxBook(BASE, TOKEN, 'bk-1');
    assert.equal(result.success, false);
    assert.match(result.error, /could not reach the mailbox/i);
    assert.equal(result.id, 'bk-1');
});

// ---------------------------------------------------------------------------
// The mirrored constants
//
// `mailbox/src/core.js` cannot be imported by the app: it is an ESM module
// outside tsconfig's roots and outside Metro's bundle. So the two caps are
// re-typed in mailbox_client.ts — and a re-typed constant is one that drifts.
// This reads BOTH FILES and compares the literals, so a change to either side
// fails here instead of failing on a phone: a client cap ABOVE the server's
// spends a whole upload to earn a 413, and one BELOW it refuses books the
// mailbox can hold.
// ---------------------------------------------------------------------------

/** The value of `export const <name> = <plain arithmetic>;` in a source file. */
function sourceConstant(source, name) {
    const match = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(source);
    assert.ok(match, `${name} not found in source`);
    const expr = match[1].split('//')[0].trim();
    // Deliberately NOT eval: only plain integer arithmetic is accepted, so this
    // helper can never execute whatever a source file happens to contain.
    assert.match(expr, /^[0-9*+\s]+$/, `${name} is not a plain literal: ${expr}`);
    return expr
        .split('+')
        .reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
}

test('mailbox_client mirrors mailbox/src/core.js: the book caps are the same numbers', () => {
    const core = readFileSync(new URL('../mailbox/src/core.js', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../src/services/mailbox_client.ts', import.meta.url), 'utf8');

    const serverBytes = sourceConstant(core, 'MAX_BOOK_BYTES');
    const clientBytes = sourceConstant(client, 'MAILBOX_MAX_BOOK_BYTES');
    assert.equal(clientBytes, serverBytes, 'MAILBOX_MAX_BOOK_BYTES drifted from MAX_BOOK_BYTES');
    // And the source literal is what the module actually exports — a mirror that
    // is only correct in the text would be no mirror at all.
    assert.equal(MAILBOX_MAX_BOOK_BYTES, serverBytes);
    assert.equal(serverBytes, 24 * 1024 * 1024, 'the KV ceiling moved; re-read core.js before changing this');

    const serverName = sourceConstant(core, 'BOOK_FILENAME_MAX_LEN');
    const clientName = sourceConstant(client, 'MAILBOX_BOOK_FILENAME_MAX_CHARS');
    assert.equal(clientName, serverName, 'MAILBOX_BOOK_FILENAME_MAX_CHARS drifted from BOOK_FILENAME_MAX_LEN');
    assert.equal(MAILBOX_BOOK_FILENAME_MAX_CHARS, serverName);
});
