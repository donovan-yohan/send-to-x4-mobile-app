/**
 * WALLPAPER OVER THE MAILBOX — the third road, and the one that took the last
 * direct-only screen off its hard gate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY AT RISK, AND WHY IT NEEDS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * A sleep screen used to be a direct-LAN PUT and nothing else, so
 * WallpaperScreen greyed its buttons out whenever the reader was asleep — which
 * is almost always — and a client phone could not change one at all. Making it
 * ride the mailbox adds three seams whose failures are all SILENT from the
 * phone's side (the reader acks nothing, and it only collects at deep-sleep
 * entry):
 *
 *   - THE TARGET. 'primary' is `/sleep.bmp`, the single slot the firmware
 *     prefers over everything; 'set' is one entry of the `/.sleep` rotation. A
 *     target that is dropped, defaulted or mis-spelled on the wire puts a pinned
 *     picture into the random rotation, or overwrites a sleep screen the user
 *     never asked to replace. It is checked on the header, on the manifest line,
 *     and on the outbox item.
 *   - THE FILENAME RULE, which is NOT the books' rule: `.bmp` rather than
 *     `.epub`, and a bare '-' refused because that is the placeholder a primary
 *     writes in the filename field of a `wallpaper.txt` line.
 *   - THE 4 MiB CAP, mirrored from `mailbox/src/core.js` in a second file that
 *     cannot import it.
 *
 * And one that is not silent but is worse: the ROUTING. A wallpaper send must
 * fall back to the mailbox for an ASLEEP reader and must NOT fall back for a
 * reader that answered and refused — the same judgement notes and books already
 * make, and if the three ever disagree the same asleep reader is handled three
 * ways.
 *
 * Nothing here touches the network: `mailbox_client` goes through a stubbed
 * `globalThis.fetch`, `wallpaper_sender` through `__setWallpaperTransport`, and
 * `outbox` through its filesystem/store seams.
 *
 * Run:  node --import tsx --test scripts/wallpaper-mailbox.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import {
    MAILBOX_MAX_WALLPAPERS,
    MAILBOX_MAX_WALLPAPER_BYTES,
    MAILBOX_WALLPAPER_FILENAME_MAX_CHARS,
    MAILBOX_WALLPAPER_MANIFEST_PATH,
    MAILBOX_WALLPAPER_PATH,
    WALLPAPER_ID_PREFIX,
    deleteMailboxWallpaper,
    listMailboxWallpapers,
    mintWallpaperId,
    publishWallpaper,
} from '../src/services/mailbox_client';
import {
    WALLPAPER_HANDOVER_LANDING_CLAUSE,
    WALLPAPER_MAILBOX_LANDING_CLAUSE,
    WALLPAPER_ROUTE_LABEL,
    __setWallpaperTransport,
    routeWallpaperSend,
} from '../src/services/wallpaper_sender';
import {
    OUTBOX_MANIFEST_VERSION,
    __setOutboxFileSystem,
    __setOutboxStore,
    describeOutboxWallpaperFilenameProblem,
    enqueueWallpaper,
    listOutbox,
    summarizeOutbox,
    supersedeQueuedPrimaryWallpapers,
} from '../src/services/outbox';
import { deriveDeliverability } from '../src/services/deliverability';
import { __setWallpaperPrepare, promoteRecordToWallpaper } from '../src/services/promote';
import { __resetReaderReachability, __setReaderProbe } from '../src/services/reader_reachability';

const BASE = 'https://box.example/m/abcdefghijklmnopqrstuv';
const TOKEN = 'write-token';
const IP = '192.168.1.50';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A byte string that starts 'BM', which is the only thing either half inspects. */
function bmp(bytes = 512) {
    const out = new Uint8Array(bytes);
    out[0] = 0x42;
    out[1] = 0x4d;
    return out;
}

/**
 * A fetch stub that RECORDS and answers from a script.
 *
 * Records the header bag verbatim rather than a normalised copy: half of what
 * this file pins is that the right header names carry the right values, and a
 * helper that lower-cased keys would hide a `x-wallpaper-target` that the Worker
 * never reads.
 */
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url, init });
        return handler(url, init, calls.length);
    };
    return calls;
}

function jsonResponse(status, body) {
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

afterEach(() => {
    delete globalThis.fetch;
    __setWallpaperTransport(null);
    __setWallpaperPrepare(null);
    __setOutboxFileSystem(null);
    __setOutboxStore(null);
    __setReaderProbe(null);
    __resetReaderReachability();
});

// ---------------------------------------------------------------------------
// 1. The wire contract
// ---------------------------------------------------------------------------

test('publishWallpaper POSTs to /wallpaper with the id, the target and the bearer token', async () => {
    const calls = stubFetch(() =>
        jsonResponse(200, { ok: true, id: 'wp-1', target: 'set', filename: 'x.bmp', bytes: 512 })
    );

    const result = await publishWallpaper(BASE, TOKEN, bmp(), 'set', 'x.bmp', 'wp-1');

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_WALLPAPER_PATH}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers['X-Wallpaper-Id'], 'wp-1');
    assert.equal(calls[0].init.headers['X-Wallpaper-Target'], 'set');
    assert.equal(calls[0].init.headers['X-Filename'], 'x.bmp');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
    // THE TOKEN IS NEVER IN THE URL. That is the whole reason the reader can hold
    // the base and not the secret; a leak here is a leak into the reader's own
    // settings UI, which serves it back to anyone on the LAN.
    assert.ok(!calls[0].url.includes(TOKEN));
});

test('publishWallpaper sends NO X-Filename for a primary, even when one is passed', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, id: 'wp-2', target: 'primary' }));

    const result = await publishWallpaper(BASE, TOKEN, bmp(), 'primary', 'ignored.bmp', 'wp-2');

    assert.equal(result.success, true);
    assert.equal(result.target, 'primary');
    // The destination is the FIXED `/sleep.bmp`. A name on the wire would be a
    // value the reader has to know to ignore, and a reader that did not ignore
    // it would file a pinned picture into the rotation instead.
    assert.equal('X-Filename' in calls[0].init.headers, false);
});

test('publishWallpaper refuses a set target with no usable filename before the network', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));

    for (const name of ['', 'photo.png', '.hidden.bmp', 'a/b.bmp', '-']) {
        const result = await publishWallpaper(BASE, TOKEN, bmp(), 'set', name);
        assert.equal(result.success, false, `accepted ${JSON.stringify(name)}`);
    }
    // A bare '-' is refused because it IS the "no name" placeholder in a
    // wallpaper.txt line: an entry called that would be applied to /sleep.bmp.
    assert.equal(calls.length, 0, 'a rejected name must never reach the wire');
});

test('publishWallpaper refuses a non-BMP payload before the network', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    const frame = new Uint8Array(52272); // a love-note frame, not a wallpaper

    const result = await publishWallpaper(BASE, TOKEN, frame, 'primary');

    assert.equal(result.success, false);
    assert.match(result.error, /not a BMP/);
    // The same guard sendWallpaperBmp applies. Without it the mailbox would
    // happily store it and the firmware would fail to decode it on EVERY sleep,
    // for ever, while the app said "sent".
    assert.equal(calls.length, 0);
});

test('publishWallpaper refuses a body over the 4 MiB cap before spending the upload', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));

    const result = await publishWallpaper(
        BASE,
        TOKEN,
        bmp(MAILBOX_MAX_WALLPAPER_BYTES + 1),
        'primary'
    );

    assert.equal(result.success, false);
    assert.match(result.error, /4 MiB/);
    assert.equal(calls.length, 0);
});

test('publishWallpaper trusts the server echo over what it sent', async () => {
    // The server SANITIZES X-Filename (FAT punctuation and non-ASCII are
    // replaced, not rejected), so the name the reader creates can differ from
    // the one asked for. A UI reporting its own name would name a file that is
    // not on the card.
    stubFetch(() =>
        jsonResponse(200, { ok: true, id: 'wp-server', target: 'set', filename: 'tidied.bmp', bytes: 7 })
    );

    const result = await publishWallpaper(BASE, TOKEN, bmp(), 'set', 'asked.bmp', 'wp-mine');

    assert.equal(result.id, 'wp-server');
    assert.equal(result.filename, 'tidied.bmp');
    assert.equal(result.bytes, 7);
});

test('publishWallpaper words 413 as the wallpaper cap, not the book cap', async () => {
    stubFetch(() => ({ status: 413, ok: false, text: async () => 'too big' }));

    const result = await publishWallpaper(BASE, TOKEN, bmp(), 'primary');

    assert.equal(result.success, false);
    assert.equal(result.status, 413);
    assert.match(result.error, /4 MiB/);
    assert.ok(!/24 MiB/.test(result.error), 'a 413 here is not a book over 24 MiB');
});

test('publishWallpaper reports a rejected token with the setting to change', async () => {
    stubFetch(() => ({ status: 401, ok: false, text: async () => 'nope' }));

    const result = await publishWallpaper(BASE, TOKEN, bmp(), 'primary', undefined, 'wp-3');

    assert.equal(result.success, false);
    assert.match(result.error, /write token/i);
    // The id rides back on a REJECTED publish too, so a retry can reuse it and
    // the mailbox ends up with one wallpaper rather than two.
    assert.equal(result.id, 'wp-3');
});

test('listMailboxWallpapers reads /status, not the unauthenticated manifest', async () => {
    const calls = stubFetch(() =>
        jsonResponse(200, {
            latestId: null,
            wallpapers: [
                { id: 'wp-a', target: 'set', filename: 'a.bmp', bytes: 10 },
                { id: 'wp-b', target: 'primary', filename: '', bytes: 20 },
            ],
        })
    );

    const result = await listMailboxWallpapers(BASE, TOKEN);

    assert.equal(result.success, true);
    assert.deepEqual(result.wallpapers, [
        { id: 'wp-a', target: 'set', filename: 'a.bmp', bytes: 10 },
        { id: 'wp-b', target: 'primary', filename: '', bytes: 20 },
    ]);
    assert.equal(calls[0].url, `${BASE}/status`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    // `wallpaper.txt` has NO auth, so listing through it would show a healthy
    // queue on a box this phone cannot publish to — the failure most likely to
    // confuse someone whose token is wrong.
    assert.ok(!calls[0].url.endsWith(MAILBOX_WALLPAPER_MANIFEST_PATH));
});

test('listMailboxWallpapers drops rows it could not describe, and keeps the rest', async () => {
    stubFetch(() =>
        jsonResponse(200, {
            wallpapers: [
                { id: '', target: 'set', filename: 'a.bmp', bytes: 1 },      // no id: no handle
                { id: 'wp-x', target: 'sideways', filename: 'b.bmp' },        // unreadable target
                { id: 'wp-y', target: 'set', filename: '' },                  // a set entry IS its name
                { id: 'wp-z', target: 'primary', filename: 'stray.bmp', bytes: 3 },
            ],
        })
    );

    const result = await listMailboxWallpapers(BASE, TOKEN);

    assert.equal(result.success, true);
    // Only the primary survives — and its stray filename is dropped, because a
    // primary has no name and showing one would describe the wrong destination.
    assert.deepEqual(result.wallpapers, [
        { id: 'wp-z', target: 'primary', filename: '', bytes: 3 },
    ]);
});

test('/status is NEWEST FIRST and wallpaper.txt is its exact reverse', async () => {
    // THE ONE ORDERING FACT THE APP KEEPS GETTING WRONG, pinned against the real
    // server rather than against a hand-written fixture.
    //
    // `wallpaper.txt` is newest LAST because the firmware APPLIES the lines in
    // order and the last primary written wins `/sleep.bmp`. `/status` is newest
    // FIRST because it serves the stored index, which publish builds as
    // `[entry, ...kept]`. Both statements are true at once and reading either as
    // the other is how a "Waiting to sync" list ends up showing the user the
    // OLDEST thing they queued at the top — which is exactly what shipped in the
    // first cut of WallpaperScreen, because a comment there asserted /status
    // carried the wire's order.
    const { handleRequest, createMemoryStore } = await import('../mailbox/src/core.js');
    const store = createMemoryStore();
    const config = { writeToken: 'w'.repeat(32) };
    const boxId = 'B'.repeat(24);
    const authed = { authorization: `Bearer ${config.writeToken}` };
    const bmp = new Uint8Array(64);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;

    // Published oldest -> newest.
    for (const [id, target, filename] of [
        ['wp-old', 'set', 'old.bmp'],
        ['wp-mid', 'set', 'mid.bmp'],
        ['wp-new', 'primary', null],
    ]) {
        const headers = { ...authed, 'x-wallpaper-id': id, 'x-wallpaper-target': target };
        if (filename) headers['x-filename'] = filename;
        const posted = await handleRequest(
            { method: 'POST', path: `/m/${boxId}/wallpaper`, headers, body: bmp },
            store,
            config
        );
        assert.equal(posted.status, 200, `publish ${id}`);
    }

    const manifest = await handleRequest(
        { method: 'GET', path: `/m/${boxId}/wallpaper.txt`, headers: {} },
        store,
        config
    );
    const wireIds = manifest.body
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(0, line.indexOf(' ')));
    assert.deepEqual(wireIds, ['wp-old', 'wp-mid', 'wp-new'], 'wallpaper.txt is NEWEST LAST');

    const status = await handleRequest(
        { method: 'GET', path: `/m/${boxId}/status`, headers: authed },
        store,
        config
    );
    const statusIds = JSON.parse(status.body).wallpapers.map(row => row.id);
    assert.deepEqual(statusIds, ['wp-new', 'wp-mid', 'wp-old'], '/status is NEWEST FIRST');
    assert.deepEqual(statusIds, [...wireIds].reverse(), 'the two orders are exact reverses');

    // And the client hands that order through untouched, so a screen can render
    // it directly. A screen that reverses this shows the oldest item first.
    stubFetch(() => jsonResponse(200, JSON.parse(status.body)));
    const listed = await listMailboxWallpapers(BASE, TOKEN);
    assert.equal(listed.success, true);
    assert.deepEqual(
        listed.wallpapers.map(row => row.id),
        statusIds,
        'listMailboxWallpapers must not re-order /status'
    );
});

test('listMailboxWallpapers treats a missing key as an empty queue, not a failure', async () => {
    stubFetch(() => jsonResponse(200, { latestId: 'n1', bytes: 52272 }));

    const result = await listMailboxWallpapers(BASE, TOKEN);

    // A box that has only ever held notes answers without the key at all.
    assert.equal(result.success, true);
    assert.deepEqual(result.wallpapers, []);
});

test('deleteMailboxWallpaper DELETEs the id path and reports 404 rather than smoothing it', async () => {
    const calls = stubFetch((url, init, n) =>
        n === 1
            ? jsonResponse(200, { ok: true, id: 'wp-a', target: 'set', filename: 'a.bmp' })
            : { status: 404, ok: false, text: async () => 'unknown' }
    );

    const gone = await deleteMailboxWallpaper(BASE, TOKEN, 'wp-a');
    assert.equal(gone.success, true);
    assert.equal(calls[0].url, `${BASE}${MAILBOX_WALLPAPER_PATH}/wp-a`);
    assert.equal(calls[0].init.method, 'DELETE');

    const missing = await deleteMailboxWallpaper(BASE, TOKEN, 'wp-nope');
    // A delete here is always driven by an id the user just saw in a listing, so
    // "unknown id" means the listing and the mailbox disagree, which is worth
    // showing rather than reporting as a success.
    assert.equal(missing.success, false);
    assert.match(missing.error, /404/);
});

test('a wallpaper id is minted inside the charset the server and the path both allow', () => {
    const id = mintWallpaperId();
    assert.ok(id.startsWith(WALLPAPER_ID_PREFIX));
    assert.match(id, /^wp-[0-9a-z]{9}-[0-9a-z]{11}$/);
    assert.ok(id.length <= 64);
    assert.notEqual(mintWallpaperId(), mintWallpaperId());
});

// ---------------------------------------------------------------------------
// 2. The two-file mirror
// ---------------------------------------------------------------------------

function sourceConstant(source, name) {
    const match = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(source);
    if (!match) return null;
    const expr = match[1].split('//')[0].trim();
    // Deliberately NOT eval: only plain integer arithmetic is accepted, so this
    // helper can never execute whatever a source file happens to contain.
    assert.match(expr, /^[0-9*+\s]+$/, `${name} is not a plain literal: ${expr}`);
    return expr
        .split('+')
        .reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
}

test('mailbox_client mirrors mailbox/src/core.js: the wallpaper caps are the same numbers', () => {
    const core = readFileSync(new URL('../mailbox/src/core.js', import.meta.url), 'utf8');
    const client = readFileSync(
        new URL('../src/services/mailbox_client.ts', import.meta.url),
        'utf8'
    );

    const serverBytes = sourceConstant(core, 'MAX_WALLPAPER_BYTES');

    // ---------------------------------------------------------------------
    // THE PIN ARMS ITSELF. The app half and the server half of this contract
    // land in separate passes, so this assertion cannot demand the server
    // constant exist yet — it would fail the app gate for work that is not the
    // app's. What it CAN demand, and does, is that the two halves are never both
    // present and different: the moment core.js declares the constant, the
    // literal here must match it or this test fails. And the escape hatch is
    // itself gated — a core.js that SERVES `/wallpaper` without declaring the
    // cap is a server with no cap at all, which is the one state worse than
    // drift.
    // ---------------------------------------------------------------------
    if (serverBytes === null) {
        assert.ok(
            !/['"`]\/wallpaper/.test(core),
            'core.js handles /wallpaper but declares no MAX_WALLPAPER_BYTES'
        );
        return;
    }

    const clientBytes = sourceConstant(client, 'MAILBOX_MAX_WALLPAPER_BYTES');
    assert.equal(clientBytes, serverBytes, 'MAILBOX_MAX_WALLPAPER_BYTES drifted from MAX_WALLPAPER_BYTES');
    // And the source literal is what the module actually exports — a mirror that
    // is only correct in the text would be no mirror at all.
    assert.equal(MAILBOX_MAX_WALLPAPER_BYTES, serverBytes);
    assert.equal(serverBytes, 4 * 1024 * 1024, 'the wallpaper cap moved; re-read core.js first');

    const serverName = sourceConstant(core, 'WALLPAPER_FILENAME_MAX_LEN');
    if (serverName !== null) {
        assert.equal(MAILBOX_WALLPAPER_FILENAME_MAX_CHARS, serverName);
    }
    const serverMax = sourceConstant(core, 'MAX_WALLPAPERS');
    if (serverMax !== null) {
        assert.equal(MAILBOX_MAX_WALLPAPERS, serverMax);
    }
});

test('the Kotlin proxy and the JS client agree on the wallpaper caps and the wire words', () => {
    const kotlin = readFileSync(
        new URL(
            '../modules/reader-link/android/src/main/java/expo/modules/readerlink/ProxyContract.kt',
            import.meta.url
        ),
        'utf8'
    );

    const numeric = (name) => {
        const match = new RegExp(`const val ${name}\\s*=\\s*([^\\n]+)`).exec(kotlin);
        assert.ok(match, `ProxyContract.kt declares no const ${name}`);
        const expr = match[1].split('//')[0].trim().replace(/L/g, '');
        assert.match(expr, /^[0-9*+\s]+$/, `${name} is not a plain literal: ${expr}`);
        return expr
            .split('+')
            .reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
    };
    const stringConst = (name) => {
        const match = new RegExp(`const val ${name}\\s*=\\s*"([^"]*)"`).exec(kotlin);
        assert.ok(match, `ProxyContract.kt declares no string const ${name}`);
        return match[1];
    };

    // The phone answers `wallpaper.txt` and `wallpaper/{id}` off its own disk
    // during a peer-link session, so a cap that disagrees with the client's is a
    // wallpaper this app will publish and the local serve will silently drop.
    assert.equal(numeric('MAX_WALLPAPER_BYTES'), MAILBOX_MAX_WALLPAPER_BYTES);
    assert.equal(numeric('MAX_WALLPAPERS'), MAILBOX_MAX_WALLPAPERS);
    assert.equal(numeric('WALLPAPER_FILENAME_MAX_LEN'), MAILBOX_WALLPAPER_FILENAME_MAX_CHARS);
    assert.equal(stringConst('WALLPAPER_SUFFIX'), MAILBOX_WALLPAPER_MANIFEST_PATH);
    assert.equal(stringConst('WALLPAPER_PATH_MARKER'), `${MAILBOX_WALLPAPER_PATH}/`);
    assert.equal(stringConst('WALLPAPER_TARGET_PRIMARY'), 'primary');
    assert.equal(stringConst('WALLPAPER_TARGET_SET'), 'set');
    assert.equal(stringConst('WALLPAPER_NO_FILENAME'), '-');
});

// ---------------------------------------------------------------------------
// 3. Routing
// ---------------------------------------------------------------------------

/** A direct transport whose upload result the test chooses. */
function fakeTransport(uploadResult) {
    const calls = [];
    __setWallpaperTransport({
        async upload(ip, data, filename, onProgress, folder) {
            calls.push({ ip, filename, folder, bytes: data.byteLength });
            return uploadResult;
        },
        async deleteFile(ip, filename, folder) {
            calls.push({ deleted: filename, folder });
            return true;
        },
    });
    return calls;
}

const HOST = { role: 'host', ip: IP, mailboxUrl: BASE, mailboxWriteToken: TOKEN };
const CLIENT = { role: 'client', ip: '', mailboxUrl: BASE, mailboxWriteToken: TOKEN };
const ASLEEP = { reachable: false, checkedAt: Date.now() };
const AWAKE = { reachable: true, checkedAt: Date.now() };

test('a client never touches the direct transport and goes straight to the mailbox', async () => {
    const direct = fakeTransport({ success: true });
    stubFetch(() => jsonResponse(200, { ok: true, id: 'wp-c', target: 'set', filename: 'x.bmp' }));

    const result = await routeWallpaperSend(CLIENT, bmp(), { kind: 'set', name: 'x' }, undefined, {
        queueOnFailure: false,
    });

    assert.equal(result.success, true);
    assert.equal(result.route, 'mailbox');
    assert.equal(result.target, 'set');
    // A client has no LAN path by definition; touching the reader at all is a
    // bug that can only show up as a long hang.
    assert.deepEqual(direct, []);
});

test('a client with no usable mailbox fails with the setup hint and no network at all', async () => {
    const direct = fakeTransport({ success: true });
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));

    const result = await routeWallpaperSend(
        { role: 'client', ip: '' },
        bmp(),
        { kind: 'primary' },
        undefined,
        { queueOnFailure: false }
    );

    assert.equal(result.success, false);
    assert.deepEqual(direct, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(result.attempts, []);
});

test('a host with a fresh "asleep" observation skips the reader and publishes', async () => {
    const direct = fakeTransport({ success: true });
    const calls = stubFetch(() =>
        jsonResponse(200, { ok: true, id: 'wp-p', target: 'primary', bytes: 512 })
    );

    const result = await routeWallpaperSend(HOST, bmp(), { kind: 'primary' }, undefined, {
        queueOnFailure: false,
        reachability: ASLEEP,
    });

    assert.equal(result.success, true);
    assert.equal(result.route, 'mailbox');
    assert.equal(result.skippedDirect.reachable, false);
    // Nothing was TRIED against the reader, so no 'direct' attempt is recorded:
    // `attempts` stays a log of what actually ran, not of what was considered.
    assert.deepEqual(result.attempts.map((a) => a.route), ['mailbox']);
    assert.deepEqual(direct, []);
    assert.equal(calls[0].init.headers['X-Wallpaper-Target'], 'primary');
});

test('a host with an awake reader uses the direct route and never publishes', async () => {
    const direct = fakeTransport({ success: true });
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));

    const result = await routeWallpaperSend(HOST, bmp(), { kind: 'primary' }, undefined, {
        queueOnFailure: false,
        reachability: AWAKE,
    });

    assert.equal(result.success, true);
    assert.equal(result.route, 'direct');
    assert.equal(calls.length, 0, 'the mailbox must not be written when the reader took it');
    // DELETE BEFORE UPLOAD survives the router: the firmware refuses to
    // overwrite in place, so a primary re-send without the delete leaves the OLD
    // picture on the card while reporting a failure the user cannot act on.
    assert.equal(direct[0].deleted, 'sleep.bmp');
    assert.equal(direct[1].filename, 'sleep.bmp');
});

test('a reader that ANSWERED and refused is NOT papered over with a mailbox delivery', async () => {
    fakeTransport({ success: false, error: 'ERROR: File already exists' });
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));

    const result = await routeWallpaperSend(HOST, bmp(), { kind: 'primary' }, undefined, {
        queueOnFailure: false,
        reachability: AWAKE,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /File already exists/);
    // The same judgement notes and books make. A device condition the user can
    // fix must not be hidden behind a delayed delivery they cannot see.
    assert.equal(calls.length, 0);
    assert.deepEqual(result.attempts.map((a) => a.route), ['direct']);
});

test('a reader that did not answer falls back to the mailbox and says both things', async () => {
    fakeTransport({ success: false, error: 'WebSocket connection failed' });
    stubFetch(() => ({ status: 500, ok: false, text: async () => 'boom' }));

    const result = await routeWallpaperSend(HOST, bmp(), { kind: 'primary' }, undefined, {
        queueOnFailure: false,
        reachability: AWAKE,
    });

    assert.equal(result.success, false);
    // Both legs are named, in order, so the UI can distinguish "the reader was
    // asleep" from "the mailbox is broken" without re-deriving either.
    assert.deepEqual(result.attempts.map((a) => a.route), ['direct', 'mailbox']);
    assert.match(result.error, /Reader unreachable/);
    assert.match(result.error, /mailbox failed too/);
});

test('an unusable rotation name fails once, before any route is attempted', async () => {
    const direct = fakeTransport({ success: true });
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));

    const result = await routeWallpaperSend(HOST, bmp(), { kind: 'set', name: 'a/b' }, undefined, {
        queueOnFailure: false,
        reachability: AWAKE,
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Unusable wallpaper name/);
    // The mailbox would refuse it too, and a picture that reached the mailbox
    // under a name the reader cannot create is a silent, permanent failure.
    assert.deepEqual(direct, []);
    assert.equal(calls.length, 0);
});

test('the two landing clauses say different things, because they promise different things', () => {
    assert.notEqual(WALLPAPER_MAILBOX_LANDING_CLAUSE, WALLPAPER_HANDOVER_LANDING_CLAUSE);
    // The mailbox lands on its own; a handover needs the user to run a sync in
    // the reader's physical presence. Wording them alike would tell someone with
    // no mailbox that their picture is on its way when it is waiting on them.
    assert.match(WALLPAPER_MAILBOX_LANDING_CLAUSE, /next sync/);
    assert.match(WALLPAPER_HANDOVER_LANDING_CLAUSE, /this phone/);
    assert.equal(WALLPAPER_ROUTE_LABEL.direct, 'On the reader');
    assert.equal(WALLPAPER_ROUTE_LABEL.mailbox, 'In the mailbox');
});

// ---------------------------------------------------------------------------
// 4. The outbox item, which is a wire format with the Kotlin half
// ---------------------------------------------------------------------------

const DOC = 'file:///doc/';
const MANIFEST = `${DOC}outbox/manifest.json`;

function memoryFs() {
    const files = new Map();
    return {
        documentDirectory: DOC,
        files,
        async makeDirectory() {},
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

function freshOutbox() {
    const fs = memoryFs();
    __setOutboxFileSystem(fs);
    __setOutboxStore(memoryStore());
    return fs;
}

function manifestOf(fs) {
    const file = fs.files.get(MANIFEST);
    return file ? JSON.parse(file.text) : null;
}

test('a queued wallpaper serialises with target, and a primary carries no filename', async () => {
    const fs = freshOutbox();

    await enqueueWallpaper(bmp(64), 'wp-set', 'set', 'dune.bmp');
    await enqueueWallpaper(bmp(64), 'wp-primary', 'primary');

    const manifest = manifestOf(fs);
    assert.equal(manifest.version, OUTBOX_MANIFEST_VERSION);

    // KEY ORDER IS PART OF THE FORMAT: a hand-rolled Kotlin parser and a human
    // running `adb shell cat` both read this, and a reshuffle on every write is
    // noise in both.
    assert.deepEqual(Object.keys(manifest.items[0]), [
        'id',
        'kind',
        'target',
        'filename',
        'bytes',
        'bodyPath',
        'queuedAt',
    ]);
    assert.deepEqual(Object.keys(manifest.items[1]), [
        'id',
        'kind',
        'target',
        'bytes',
        'bodyPath',
        'queuedAt',
    ]);
    assert.equal(manifest.items[0].kind, 'wallpaper');
    assert.equal(manifest.items[0].target, 'set');
    assert.equal(manifest.items[0].filename, 'dune.bmp');
    assert.equal(manifest.items[1].target, 'primary');
    assert.equal('filename' in manifest.items[1], false);
});

test('a queued note and a queued book still serialise exactly as they always did', async () => {
    const fs = freshOutbox();

    await enqueueWallpaper(bmp(64), 'wp-1', 'primary');
    const manifest = manifestOf(fs);

    // `target` sits between `kind` and `filename` PRECISELY so that adding it
    // cannot move a key on the two item shapes that shipped before it existed.
    assert.deepEqual(Object.keys(manifest.items[0]).slice(0, 3), ['id', 'kind', 'target']);
});

test('enqueueWallpaper refuses a target it cannot honour, and a set with no name', async () => {
    freshOutbox();

    await assert.rejects(() => enqueueWallpaper(bmp(64), 'wp-a', 'sideways'), /primary|set/);
    await assert.rejects(() => enqueueWallpaper(bmp(64), 'wp-b', 'set'), /empty/);
    await assert.rejects(() => enqueueWallpaper(bmp(64), 'wp-c', 'set', 'photo.png'), /\.bmp/);
    // '-' is the "no name" placeholder in a wallpaper.txt line.
    await assert.rejects(() => enqueueWallpaper(bmp(64), 'wp-d', 'set', '-'), /"-"/);
});

test('describeOutboxWallpaperFilenameProblem is the .bmp rule, not the .epub one', () => {
    assert.equal(describeOutboxWallpaperFilenameProblem('a.bmp'), null);
    assert.equal(describeOutboxWallpaperFilenameProblem('a with spaces.bmp'), null);
    assert.ok(describeOutboxWallpaperFilenameProblem('a.epub'));
    assert.ok(describeOutboxWallpaperFilenameProblem('.a.bmp'));
    assert.ok(describeOutboxWallpaperFilenameProblem('dir/a.bmp'));
    assert.ok(describeOutboxWallpaperFilenameProblem('a\nb.bmp'));
});

test('a newer queued primary retires the older ones and leaves the rotation alone', async () => {
    freshOutbox();

    await enqueueWallpaper(bmp(64), 'wp-old', 'primary');
    await enqueueWallpaper(bmp(64), 'wp-keep-1', 'set', 'one.bmp');
    await enqueueWallpaper(bmp(64), 'wp-new', 'primary');
    await enqueueWallpaper(bmp(64), 'wp-keep-2', 'set', 'two.bmp');

    const dropped = await supersedeQueuedPrimaryWallpapers('wp-new');

    // There is ONE /sleep.bmp. Three queued primaries can only ever end in one
    // picture on the card; the others are wake windows spent to be overwritten.
    assert.deepEqual(dropped, ['wp-old']);
    const ids = (await listOutbox()).map((item) => item.id);
    assert.deepEqual(ids, ['wp-keep-1', 'wp-new', 'wp-keep-2']);
    // The ROTATION is a bag: every entry is a distinct file the user chose to
    // add, so collapsing it would delete wallpapers they asked for.
    const summary = summarizeOutbox(await listOutbox());
    assert.equal(summary.pendingWallpapers, 3);
    assert.equal(summary.pendingBooks, 0);
});

test('a keepId that is not in the queue loses to the newest pending primary', async () => {
    freshOutbox();
    await enqueueWallpaper(bmp(64), 'wp-1', 'primary');
    await enqueueWallpaper(bmp(64), 'wp-2', 'primary');

    const dropped = await supersedeQueuedPrimaryWallpapers('wp-not-here');

    // Honouring a keepId that names nothing would drop the picture the reader
    // would actually have ended on, which turns this into data loss.
    assert.deepEqual(dropped, ['wp-1']);
    assert.deepEqual((await listOutbox()).map((i) => i.id), ['wp-2']);
});

test('a failed send parks the wallpaper for handover with the mailbox id', async () => {
    freshOutbox();
    fakeTransport({ success: false, error: 'WebSocket connection failed' });
    stubFetch(() => ({ status: 500, ok: false, text: async () => 'boom' }));

    const result = await routeWallpaperSend(HOST, bmp(64), { kind: 'set', name: 'dune' }, undefined, {
        reachability: AWAKE,
    });

    assert.equal(result.success, false);
    assert.ok(result.queuedId, 'a failed send must arm the handover');
    // ONE ITEM, NOT TWO: the id the half-published attempt minted is reused, so
    // a picture that eventually arrives by both roads is deduped by the reader.
    assert.equal(result.queuedId, result.wallpaperId);
    const queued = await listOutbox();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].kind, 'wallpaper');
    assert.equal(queued[0].target, 'set');
    assert.equal(queued[0].filename, 'dune.bmp');
});

test('a delivered send queues nothing unless the caller asks for it', async () => {
    freshOutbox();
    fakeTransport({ success: true });

    const result = await routeWallpaperSend(HOST, bmp(64), { kind: 'primary' }, undefined, {
        reachability: AWAKE,
    });

    assert.equal(result.success, true);
    assert.equal(result.queuedId, undefined);
    assert.deepEqual(await listOutbox(), []);
});

// ---------------------------------------------------------------------------
// 5. Promote — the History tab's road, which was direct-only too
// ---------------------------------------------------------------------------

test('promote keeps its direct-only behaviour when handed a bare ip', async () => {
    const direct = fakeTransport({ success: true });
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    __setWallpaperPrepare(async () => ({ bmp: bmp(64) }));

    const result = await promoteRecordToWallpaper(IP, {
        id: 'rec-1',
        kind: 'photo',
        sourceUri: 'file:///a.jpg',
    });

    assert.equal(result.ok, true);
    // The legacy shape must be byte-identical to what it always returned, or a
    // caller with no wording for a delayed delivery silently starts getting one.
    assert.equal(result.route, undefined);
    assert.equal(result.queued, undefined);
    assert.equal(calls.length, 0);
    assert.ok(direct.length > 0);
    __setWallpaperPrepare(null);
});

test('promote handed a destination reaches an asleep reader through the mailbox', async () => {
    const direct = fakeTransport({ success: true });
    stubFetch(() => jsonResponse(200, { ok: true, id: 'wp-h', target: 'set', filename: 'n.bmp' }));
    __setWallpaperPrepare(async () => ({ bmp: bmp(64) }));
    // promote takes no reachability hint, so the fast skip runs its own probe.
    // Seamed here rather than left to a real socket: a test that reaches the
    // network is a test that fails on the CI box's firewall, not on the code.
    __setReaderProbe(async () => false);

    const result = await promoteRecordToWallpaper(
        HOST,
        { id: 'rec-2', kind: 'photo', sourceUri: 'file:///a.jpg' },
        undefined
    );

    assert.equal(result.ok, true);
    // The History banner branches on this: "Added to /.sleep" is only true when
    // the reader took the bytes.
    assert.equal(result.route, 'mailbox');
    assert.deepEqual(direct, [], 'a reader known to be asleep is not dialled');
    __setWallpaperPrepare(null);
});

// ---------------------------------------------------------------------------
// 6. Deliverability
// ---------------------------------------------------------------------------

test('wallpaperRoute tracks noteRoute and bookRoute across the states that matter', () => {
    const cases = [
        // [label, settings, reachability, expected route]
        ['awake host', { role: 'host', ip: IP }, { reachable: true, checkedAt: Date.now() }, 'direct'],
        [
            'asleep host with a mailbox',
            { role: 'host', ip: IP, mailboxUrl: BASE, mailboxWriteToken: TOKEN },
            { reachable: false, checkedAt: Date.now() },
            'mailbox',
        ],
        [
            'client with a mailbox',
            { role: 'client', ip: '', mailboxUrl: BASE, mailboxWriteToken: TOKEN },
            { reachable: null, checkedAt: null },
            'mailbox',
        ],
        // The cell that used to make WallpaperScreen grey: a host whose reader is
        // asleep and who has no mailbox. Nothing publishes, but the phone can
        // still hand the outbox over its own AP, so the action ENQUEUES.
        [
            'asleep host, serveable base, no token',
            { role: 'host', ip: IP, mailboxUrl: BASE },
            { reachable: false, checkedAt: Date.now() },
            'handover-only',
        ],
        ['nothing at all', { role: 'client', ip: '' }, { reachable: null, checkedAt: null }, 'none'],
    ];

    for (const [label, settings, reachability, expected] of cases) {
        const d = deriveDeliverability({ settings, reachability, now: Date.now() });
        assert.equal(d.wallpaperRoute, expected, label);
        // Equal BY CONSTRUCTION today: routeWallpaperSend is a deliberate mirror
        // of routeEpubLegs. The field exists separately so the day they diverge
        // there is one obvious place for it, with this line pointing at it.
        assert.equal(d.wallpaperRoute, d.noteRoute, label);
        assert.equal(d.wallpaperRoute, d.bookRoute, label);
        assert.equal(d.anyRoute, expected !== 'none', label);
    }
});
