/**
 * reader_provision — the reader-side half of the mailbox handshake.
 *
 * WHY THIS FILE IS PARANOID ABOUT THE WIRE FORMAT. Every failure on this path
 * answers HTTP 200 and looks exactly like success:
 *
 *   - WRONG CONTENT-TYPE. `handlePostSettings` reads the body out of ESP32
 *     WebServer's pseudo-arg "plain" (CrossPointWebServer.cpp:1256), and that arg
 *     is only populated when the content-type is NOT
 *     `application/x-www-form-urlencoded`. Send form encoding — the encoding this
 *     repo already uses for `POST /delete` — and the firmware answers
 *     400 "Missing JSON body" with a body that is otherwise perfect. `fakeReader`
 *     below reproduces that rejection; a mock that accepts anything cannot.
 *
 *   - SILENT TRUNCATION. `messageSyncUrl` is `char[128]` (CrossPointSettings.h:245)
 *     and the handler does `strncpy(ptr, val, stringMaxLen - 1)` then forces
 *     `[127] = '\0'` (CrossPointWebServer.cpp:1315-1316). A 128-char capability
 *     URL is accepted with "Applied 2 setting(s)" and then every sleep-time sync
 *     GETs a mangled host, forever, with no error anywhere. The 127 ceiling is
 *     therefore enforced in the app BEFORE the request goes out.
 *
 *   - A WRITE THAT DID NOT LAND. The 200 only means "the JSON parsed"; the
 *     handler applies nothing for a key it does not know (line 1274 `continue`)
 *     and still reports success. Only the read-back proves anything.
 *
 *   - FIRMWARE WITHOUT MESSAGE SYNC. An older reader has no messageSyncEnabled /
 *     messageSyncUrl in its settings list at all. POSTing them succeeds ("Applied
 *     0 setting(s)"), so without the pre-read the app would report a provisioned
 *     reader that can never sync.
 *
 *   - TOGGLE ENCODING. The firmware reads a toggle as `doc[key].as<int>() ? 1 : 0`
 *     (line 1278) and SERIALIZES it as a number (line 1190), so the request body
 *     is pinned to the numeric 1.
 *
 * Wire-format source of truth (read directly, not inferred): crosspoint-reader
 * (branch `messenger`) src/network/CrossPointWebServer.cpp:167-168 (routes),
 * :1163-1253 (GET), :1255-1330 (POST); src/SettingsList.h:316,325-326 (keys);
 * src/CrossPointSettings.h:244-245 (storage); src/network/MessageSync.cpp:52-56
 * (trailing-slash stripping) and :131-134 (both-or-nothing gate).
 *
 * Nothing here touches the network: the HTTP client is injected through
 * `__setProvisionFetch`.
 *
 * Run:  node --import tsx --test scripts/reader-provision.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    MESSAGE_SYNC_ENABLED_KEY,
    MESSAGE_SYNC_URL_KEY,
    READER_SETTINGS_PATH,
    READER_SYNC_URL_MAX_CHARS,
    buildProvisionBody,
    fetchReaderSyncSettings,
    normalizeReaderSyncUrl,
    parseAppliedCount,
    parseReaderSyncSettings,
    provisionReaderSync,
    provisionRequestHeaders,
    validateReaderSyncUrl,
    __setProvisionFetch,
} from '../src/services/reader_provision';

const READER_IP = 'crosspoint.local';
const SETTINGS_URL = `http://${READER_IP}${READER_SETTINGS_PATH}`;

/** A mailbox base of the shape the worker mints: {origin}/m/{boxId}. */
const MAILBOX_URL = 'https://xteink-mailbox.example.workers.dev/m/Ab3xQ7pLm9Zk2Rt5Vw8YcN';

afterEach(() => {
    __setProvisionFetch(null);
});

// ---------------------------------------------------------------------------
// Fake reader — mirrors the firmware handlers, including their traps
// ---------------------------------------------------------------------------

/**
 * Stand-in for the CrossPoint web server's /api/settings pair.
 *
 * Deliberately reproduces the three behaviours that make a broken client look
 * healthy: the content-type trap, the fixed-width string truncation, and the
 * "unknown keys are silently skipped" partial-apply rule.
 *
 * @param opts.urlCapacity  Characters storable in messageSyncUrl (default 127,
 *                          the real `char[128]` minus its NUL). Lower it to
 *                          simulate an older/narrower firmware buffer.
 * @param opts.hasMessageSync  false = firmware from before message sync.
 */
function fakeReader(opts = {}) {
    const {
        urlCapacity = READER_SYNC_URL_MAX_CHARS,
        hasMessageSync = true,
        initial = { messageSyncEnabled: 0, messageSyncUrl: '' },
    } = opts;

    const state = { ...initial };
    const calls = [];

    // Unrelated settings that must survive a partial write untouched.
    const otherSettings = [
        { key: 'sleepTimeoutMinutes', name: 'Time to sleep', category: 'System', type: 'value', value: 15 },
        { key: 'showHiddenFiles', name: 'Show hidden files', category: 'System', type: 'toggle', value: 0 },
    ];

    function settingsArray() {
        const list = [...otherSettings];
        if (hasMessageSync) {
            list.push({
                key: MESSAGE_SYNC_ENABLED_KEY,
                name: 'Message sync',
                category: 'System',
                type: 'toggle',
                value: state.messageSyncEnabled, // NUMBER — CrossPointWebServer.cpp:1190
            });
            list.push({
                key: MESSAGE_SYNC_URL_KEY,
                name: 'Message sync URL',
                category: '',
                type: 'string',
                value: state.messageSyncUrl,
            });
        }
        return list;
    }

    const jsonResponse = (status, payload) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    });

    const textResponse = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            throw new Error('not json');
        },
        text: async () => body,
    });

    const fetchImpl = async (url, init = {}) => {
        const method = (init.method ?? 'GET').toUpperCase();
        calls.push({ url, method, headers: init.headers, body: init.body });

        if (url !== SETTINGS_URL) return textResponse(404, 'Not found');

        if (method === 'GET') return jsonResponse(200, settingsArray());

        if (method !== 'POST') return textResponse(405, 'Method not allowed');

        // ---- handlePostSettings ----
        const contentType = String(
            (init.headers && (init.headers['Content-Type'] ?? init.headers['content-type'])) ?? ''
        ).toLowerCase();

        // THE TRAP: ESP32 WebServer parses a form-encoded body into named args
        // and never populates "plain", so hasArg("plain") is false -> 400.
        if (contentType.includes('application/x-www-form-urlencoded')) {
            return textResponse(400, 'Missing JSON body');
        }
        if (init.body === undefined || init.body === null || init.body === '') {
            return textResponse(400, 'Missing JSON body');
        }

        let doc;
        try {
            doc = JSON.parse(String(init.body));
        } catch (err) {
            return textResponse(400, `Invalid JSON: ${err.message}`);
        }
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
            return textResponse(400, 'Invalid JSON: not an object');
        }

        let applied = 0;
        if (hasMessageSync) {
            if (Object.prototype.hasOwnProperty.call(doc, MESSAGE_SYNC_ENABLED_KEY)) {
                // `doc[key].as<int>() ? 1 : 0`
                state.messageSyncEnabled = Number(doc[MESSAGE_SYNC_ENABLED_KEY]) ? 1 : 0;
                applied++;
            }
            if (Object.prototype.hasOwnProperty.call(doc, MESSAGE_SYNC_URL_KEY)) {
                // strncpy(ptr, val, cap) + ptr[cap] = '\0' — SILENT truncation.
                state.messageSyncUrl = String(doc[MESSAGE_SYNC_URL_KEY]).slice(0, urlCapacity);
                applied++;
            }
        }
        // Unknown keys are skipped entirely (line 1274) — still a 200.
        return textResponse(200, `Applied ${applied} setting(s)`);
    };

    return { fetchImpl, calls, state, settingsArray };
}

/** Install a fake reader and return it. */
function useReader(opts) {
    const reader = fakeReader(opts);
    __setProvisionFetch(reader.fetchImpl);
    return reader;
}

// ---------------------------------------------------------------------------
// Wire-format snapshot — pinned to the firmware source
// ---------------------------------------------------------------------------

test('POST body is the exact two-key JSON object the firmware parses', () => {
    // CrossPointWebServer.cpp:1263 deserializeJson + :1274 key lookup + :1278
    // `as<int>()`. The toggle is the NUMBER 1, matching what GET serializes
    // (:1190) — not `true`, not "1".
    assert.equal(
        buildProvisionBody('https://mb.example.com/m/abc'),
        '{"messageSyncEnabled":1,"messageSyncUrl":"https://mb.example.com/m/abc"}'
    );
    assert.equal(
        buildProvisionBody('https://mb.example.com/m/abc', false),
        '{"messageSyncEnabled":0,"messageSyncUrl":"https://mb.example.com/m/abc"}'
    );

    // Exactly two keys: anything else would be a setting we did not intend to
    // touch, and handlePostSettings writes every key it recognizes.
    const parsed = JSON.parse(buildProvisionBody('https://mb.example.com/m/abc'));
    assert.deepEqual(Object.keys(parsed).sort(), [MESSAGE_SYNC_ENABLED_KEY, MESSAGE_SYNC_URL_KEY].sort());
});

test('POST content-type is application/json, NEVER form encoding', () => {
    // The rest of this repo posts to the firmware with
    // application/x-www-form-urlencoded (POST /delete). Copying that idiom here
    // makes hasArg("plain") false and the firmware answers 400.
    const headers = provisionRequestHeaders();
    assert.equal(headers['Content-Type'], 'application/json');
    assert.ok(!JSON.stringify(headers).includes('x-www-form-urlencoded'));
});

test('the settings route matches the firmware route table', () => {
    // CrossPointWebServer.cpp:167-168
    assert.equal(READER_SETTINGS_PATH, '/api/settings');
    assert.equal(MESSAGE_SYNC_ENABLED_KEY, 'messageSyncEnabled');
    assert.equal(MESSAGE_SYNC_URL_KEY, 'messageSyncUrl');
});

test('form-encoded body really is rejected by the fake reader (trap is live)', async () => {
    // Guards the guard: if fakeReader ever stops enforcing the content-type rule,
    // the happy-path test below would keep passing with a broken client.
    const reader = useReader();
    const res = await reader.fetchImpl(SETTINGS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `${MESSAGE_SYNC_URL_KEY}=${MAILBOX_URL}`,
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), 'Missing JSON body');
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

test('normalizeReaderSyncUrl strips trailing slashes the way MessageSync.cpp does', () => {
    // MessageSync.cpp:52-56 pops trailing '/' before appending /latest.txt, so
    // storing the unstripped form would make the read-back compare fail on a
    // difference the reader does not even see.
    assert.equal(normalizeReaderSyncUrl('https://mb.example.com/m/abc/'), 'https://mb.example.com/m/abc');
    assert.equal(normalizeReaderSyncUrl('https://mb.example.com/m/abc///'), 'https://mb.example.com/m/abc');
    assert.equal(normalizeReaderSyncUrl('  https://mb.example.com/m/abc  '), 'https://mb.example.com/m/abc');
    assert.equal(normalizeReaderSyncUrl(''), '');
});

test('a URL of exactly the storage ceiling is accepted; one char more is not', () => {
    const prefix = 'https://mb.example.com/m/';
    const atLimit = prefix + 'x'.repeat(READER_SYNC_URL_MAX_CHARS - prefix.length);
    const overLimit = `${atLimit}y`;

    assert.equal(atLimit.length, READER_SYNC_URL_MAX_CHARS);
    assert.equal(READER_SYNC_URL_MAX_CHARS, 127, 'char[128] minus the forced NUL');

    const ok = validateReaderSyncUrl(atLimit);
    assert.equal(ok.ok, true);
    assert.equal(ok.url, atLimit);

    const bad = validateReaderSyncUrl(overLimit);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /128 characters/);
    assert.match(bad.error, /127/);
});

test('empty and non-http URLs are rejected with an actionable reason', () => {
    for (const raw of ['', '   ', '/']) {
        const r = validateReaderSyncUrl(raw);
        assert.equal(r.ok, false, JSON.stringify(raw));
        assert.match(r.error, /empty/i);
    }

    for (const raw of ['mb.example.com/m/abc', 'ftp://mb.example.com/m/abc', 'ws://mb/m/abc']) {
        const r = validateReaderSyncUrl(raw);
        assert.equal(r.ok, false, raw);
        assert.match(r.error, /http:\/\/ or https:\/\//);
    }

    assert.equal(validateReaderSyncUrl('http://192.168.1.9:8787/m/abc').ok, true);
});

test('an over-long URL never reaches the network', async () => {
    // The reader would answer 200 and truncate. Catching it client-side is the
    // only place the user learns the real cause.
    const reader = useReader();
    const tooLong = `https://mb.example.com/m/${'x'.repeat(200)}`;

    const result = await provisionReaderSync(READER_IP, tooLong);

    assert.equal(result.ok, false);
    assert.match(result.error, /characters/);
    assert.equal(reader.calls.length, 0, 'no request should be issued for an unstorable URL');
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('provisionReaderSync: read -> write -> read back, in that order', async () => {
    const reader = useReader();

    const result = await provisionReaderSync(READER_IP, `${MAILBOX_URL}/`);

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.verified, {
        messageSyncEnabled: true,
        // Stored WITHOUT the trailing slash the caller passed.
        messageSyncUrl: MAILBOX_URL,
    });
    assert.deepEqual(result.previous, { messageSyncEnabled: false, messageSyncUrl: '' });
    assert.equal(result.applied, 2);

    // Ordering is the contract: a write with no read-back proves nothing, and a
    // write before the pre-read would configure firmware that cannot sync.
    assert.deepEqual(
        reader.calls.map((c) => c.method),
        ['GET', 'POST', 'GET']
    );
    for (const call of reader.calls) {
        assert.equal(call.url, SETTINGS_URL);
    }

    const post = reader.calls[1];
    assert.equal(post.headers['Content-Type'], 'application/json');
    assert.equal(post.body, buildProvisionBody(MAILBOX_URL, true));

    // Device state actually changed.
    assert.equal(reader.state.messageSyncEnabled, 1);
    assert.equal(reader.state.messageSyncUrl, MAILBOX_URL);
});

test('provisionReaderSync writes ONLY the two message-sync keys', async () => {
    const reader = useReader();
    await provisionReaderSync(READER_IP, MAILBOX_URL);

    const body = JSON.parse(reader.calls[1].body);
    assert.deepEqual(Object.keys(body).sort(), [MESSAGE_SYNC_ENABLED_KEY, MESSAGE_SYNC_URL_KEY].sort());

    // Unrelated settings are still reported unchanged — a read-modify-write of
    // the whole list could have clobbered them.
    const after = reader.settingsArray();
    assert.equal(after.find((s) => s.key === 'sleepTimeoutMinutes').value, 15);
    assert.equal(after.find((s) => s.key === 'showHiddenFiles').value, 0);
});

test('re-provisioning an already-configured reader is idempotent', async () => {
    const reader = useReader({
        initial: { messageSyncEnabled: 1, messageSyncUrl: MAILBOX_URL },
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.previous, { messageSyncEnabled: true, messageSyncUrl: MAILBOX_URL });
    assert.deepEqual(result.verified, { messageSyncEnabled: true, messageSyncUrl: MAILBOX_URL });
});

// ---------------------------------------------------------------------------
// Verify-mismatch
// ---------------------------------------------------------------------------

test('a silently truncated URL is caught by the read-back and named as truncation', async () => {
    // Firmware with a narrower buffer than we assume (or a future field shrink):
    // it answers "Applied 2 setting(s)" and stores a prefix.
    const reader = useReader({ urlCapacity: 40 });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);

    assert.equal(result.ok, false);
    assert.match(result.error, /did not keep the new settings/i);
    assert.match(result.error, /TRUNCATED/);
    assert.match(result.error, new RegExp(MAILBOX_URL.slice(0, 40)));
    // The POST reported success — only the read-back caught it.
    assert.equal(result.applied, 2);
    assert.equal(result.verified.messageSyncUrl, MAILBOX_URL.slice(0, 40));
    assert.deepEqual(
        reader.calls.map((c) => c.method),
        ['GET', 'POST', 'GET']
    );
});

test('a toggle that reads back off fails, even though the write returned 200', async () => {
    const reader = fakeReader();
    let getCount = 0;
    __setProvisionFetch(async (url, init = {}) => {
        const method = (init.method ?? 'GET').toUpperCase();
        const res = await reader.fetchImpl(url, init);
        if (method === 'GET') {
            getCount++;
            if (getCount === 2) {
                // Reader dropped the toggle (e.g. saveToFile lost the write).
                const list = (await res.json()).map((s) =>
                    s.key === MESSAGE_SYNC_ENABLED_KEY ? { ...s, value: 0 } : s
                );
                return { ok: true, status: 200, json: async () => list, text: async () => JSON.stringify(list) };
            }
        }
        return res;
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);

    assert.equal(result.ok, false);
    assert.match(result.error, /messageSyncEnabled is still off/);
    assert.equal(result.verified.messageSyncEnabled, false);
});

test('a URL that reads back as something unrelated is a plain mismatch', async () => {
    const reader = fakeReader();
    let getCount = 0;
    __setProvisionFetch(async (url, init = {}) => {
        const method = (init.method ?? 'GET').toUpperCase();
        const res = await reader.fetchImpl(url, init);
        if (method === 'GET') {
            getCount++;
            if (getCount === 2) {
                const list = (await res.json()).map((s) =>
                    s.key === MESSAGE_SYNC_URL_KEY ? { ...s, value: 'https://other.example/m/zzz' } : s
                );
                return { ok: true, status: 200, json: async () => list, text: async () => JSON.stringify(list) };
            }
        }
        return res;
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);

    assert.equal(result.ok, false);
    assert.match(result.error, /reads back as "https:\/\/other\.example\/m\/zzz"/);
    assert.ok(!/TRUNCATED/.test(result.error), 'an unrelated value is not a truncation');
});

// ---------------------------------------------------------------------------
// Unreachable / wrong mode / wrong firmware
// ---------------------------------------------------------------------------

test('an unreachable reader reports the transfer-mode cause, not a raw fetch error', async () => {
    __setProvisionFetch(async () => {
        throw new TypeError('Network request failed');
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);

    assert.equal(result.ok, false);
    assert.match(result.error, /WiFi transfer mode/i);
    assert.match(result.error, /Network request failed/);
    assert.equal(result.verified, undefined);
});

test('an aborted (timed out) request is reported, not swallowed', async () => {
    __setProvisionFetch(async () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/i);
    assert.match(result.error, /WiFi transfer mode/i);
});

test('a non-200 from the settings API mentions transfer mode', async () => {
    __setProvisionFetch(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'Not found',
    }));

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 404/);
    assert.match(result.error, /WiFi transfer mode/i);
});

test('firmware without message sync is refused BEFORE anything is written', async () => {
    // The dangerous case: POSTing unknown keys returns 200 "Applied 0 setting(s)",
    // so without the pre-read this would look provisioned and never sync.
    const reader = useReader({ hasMessageSync: false });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);

    assert.equal(result.ok, false);
    assert.match(result.error, /update the reader firmware/i);
    assert.match(result.error, /messageSyncEnabled/);
    assert.deepEqual(reader.calls.map((c) => c.method), ['GET'], 'no write on unsupported firmware');
});

test('a settings body that is not JSON is reported as such', async () => {
    __setProvisionFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
        },
        text: async () => '<html>captive portal</html>',
    }));

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);
    assert.equal(result.ok, false);
    assert.match(result.error, /not JSON/i);
});

test('a write that 400s surfaces the firmware message verbatim', async () => {
    const reader = fakeReader();
    __setProvisionFetch(async (url, init = {}) => {
        if ((init.method ?? 'GET').toUpperCase() === 'POST') {
            return { ok: false, status: 400, json: async () => ({}), text: async () => 'Missing JSON body' };
        }
        return reader.fetchImpl(url, init);
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 400/);
    assert.match(result.error, /Missing JSON body/);
});

test('a reader that vanishes between write and read-back says exactly that', async () => {
    const reader = fakeReader();
    let getCount = 0;
    __setProvisionFetch(async (url, init = {}) => {
        if ((init.method ?? 'GET').toUpperCase() === 'GET') {
            getCount++;
            if (getCount === 2) throw new TypeError('Network request failed');
        }
        return reader.fetchImpl(url, init);
    });

    const result = await provisionReaderSync(READER_IP, MAILBOX_URL);
    assert.equal(result.ok, false);
    assert.match(result.error, /could not read them back/i);
    assert.equal(result.applied, 2);
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test('parseReaderSyncSettings decodes the firmware settings array', () => {
    const reader = fakeReader({ initial: { messageSyncEnabled: 1, messageSyncUrl: MAILBOX_URL } });
    assert.deepEqual(parseReaderSyncSettings(reader.settingsArray()), {
        messageSyncEnabled: true,
        messageSyncUrl: MAILBOX_URL,
    });

    // Missing keys are null (unsupported firmware), NOT a default-off object —
    // the two are opposite user-facing outcomes.
    assert.equal(parseReaderSyncSettings(fakeReader({ hasMessageSync: false }).settingsArray()), null);
    assert.equal(parseReaderSyncSettings(null), null);
    assert.equal(parseReaderSyncSettings({ messageSyncEnabled: 1 }), null, 'object, not the array the API returns');
    assert.equal(parseReaderSyncSettings([]), null);
});

test('parseAppliedCount reads the firmware reply', () => {
    assert.equal(parseAppliedCount('Applied 2 setting(s)'), 2);
    assert.equal(parseAppliedCount('Applied 0 setting(s)'), 0);
    assert.equal(parseAppliedCount(''), undefined);
    assert.equal(parseAppliedCount('OK'), undefined);
});

test('fetchReaderSyncSettings is usable on its own for a status read', async () => {
    useReader({ initial: { messageSyncEnabled: 1, messageSyncUrl: MAILBOX_URL } });
    const read = await fetchReaderSyncSettings(READER_IP);
    assert.equal(read.ok, true);
    assert.deepEqual(read.settings, { messageSyncEnabled: true, messageSyncUrl: MAILBOX_URL });
});
