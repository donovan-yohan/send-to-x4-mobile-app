/**
 * wifi-share.test.js — the WiFi handover, end to end on the JS side.
 *
 * WHAT THIS FILE IS FOR. The feature's whole promise is that a passphrase typed
 * once on the phone reaches the reader over the peer link and then LEAVES THE
 * PHONE. Every step of that is invisible in normal use: the reader acks nothing
 * a user can see, the credential is never rendered, and the native half that
 * actually serves it cannot be compiled here. So the seams are what get tested:
 *
 *   1. the WIRE FORMAT, byte for byte, because a firmware in a separate repo
 *      parses it with no shared compile step,
 *   2. the STAGING round trip and the WIPE, because the wipe is the only thing
 *      standing between "handed over" and "a WPA2 passphrase sitting in
 *      AsyncStorage for ever",
 *   3. the OPTION PLUMB, because `wifiSharePath` being ABSENT is what makes the
 *      native endpoint not exist — an always-present key would quietly turn the
 *      feature on for every session,
 *   4. the EVENT COERCION, because `delivered` is what deletes the credential
 *      and it arrives across an untyped bridge,
 *   5. the DEGRADATION with no native module and no storage, because that is the
 *      state of a dev client that predates the feature.
 *
 * Run:  node --import tsx --test scripts/wifi-share.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    WIFI_PSK_MAX_CHARS,
    WIFI_PSK_MIN_CHARS,
    WIFI_SHARE_FILENAME,
    WIFI_SHARE_KEY,
    WIFI_SSID_MAX_BYTES,
    __setWifiShareFileSystem,
    __setWifiShareStore,
    clearWifiShare,
    describeWifiPasswordProblem,
    describeWifiShare,
    describeWifiSsidProblem,
    discardWifiShareHandover,
    getWifiShare,
    markWifiShareDelivered,
    parseWifiCredential,
    prepareWifiShareHandover,
    serializeWifiCredential,
    stageWifiShare,
    subscribeWifiShare,
} from '../src/services/wifi_share';

import {
    buildProxyOptions,
    coerceReaderLinkEvent,
    __setReaderLinkNative,
    readerLink,
} from '../src/services/reader_link';

import {
    createSyncSession,
    initialSyncSession,
    reduceSyncSession,
} from '../src/services/sync_session';

const BASE = 'https://mail.example.net/m/9f2c1d';
const SSID = 'Nest of Owls';
const PSK = 'correcthorse';
const DOC_DIR = 'file:///data/user/0/app/files/';
const CRED_PATH = `${DOC_DIR}wifi-share/${WIFI_SHARE_FILENAME}`;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeStore(seed = null) {
    const cells = new Map();
    if (seed !== null) cells.set(WIFI_SHARE_KEY, seed);
    return {
        cells,
        async getItem(key) {
            return cells.has(key) ? cells.get(key) : null;
        },
        async setItem(key, value) {
            cells.set(key, value);
        },
        async removeItem(key) {
            cells.delete(key);
        },
    };
}

function fakeFs(options = {}) {
    const files = new Map();
    const dirs = [];
    const removed = [];
    return {
        files,
        dirs,
        removed,
        documentDirectory: options.documentDirectory === undefined ? DOC_DIR : options.documentDirectory,
        async makeDirectory(path) {
            dirs.push(path);
        },
        async writeText(path, text) {
            if (options.writeThrows) throw new Error('disk full');
            files.set(path, text);
        },
        async remove(path) {
            removed.push(path);
            files.delete(path);
        },
    };
}

/** Fresh seams for one test, restored by the caller. */
function install(store, fs) {
    __setWifiShareStore(store);
    __setWifiShareFileSystem(fs);
}

function uninstall() {
    __setWifiShareStore(null);
    __setWifiShareFileSystem(null);
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 1. The wire format
// ---------------------------------------------------------------------------

test('the wire format is exactly two LF-terminated lines', () => {
    // A FIRMWARE IN ANOTHER REPO PARSES THIS. There is no shared compile step and
    // no negotiation: the reader reads line 1 as the SSID and line 2 as the PSK.
    assert.equal(serializeWifiCredential({ ssid: SSID, password: PSK }), 'Nest of Owls\ncorrecthorse\n');
    // An OPEN network is an EMPTY second line, not an absent one — the trailing
    // LF is what tells the reader the password field was present and empty
    // rather than truncated.
    assert.equal(serializeWifiCredential({ ssid: SSID, password: '' }), 'Nest of Owls\n\n');
    // No CR anywhere: the reader trims one defensively, but the phone must not
    // be the thing that emits it.
    assert.equal(serializeWifiCredential({ ssid: SSID, password: PSK }).includes('\r'), false);
});

test('parsing tolerates exactly what the firmware tolerates, and no more', () => {
    assert.deepEqual(parseWifiCredential('Home\nhunter2hunter2\n'), {
        ssid: 'Home',
        password: 'hunter2hunter2',
    });
    // CRLF from a copy or an editor.
    assert.deepEqual(parseWifiCredential('Home\r\nhunter2hunter2\r\n'), {
        ssid: 'Home',
        password: 'hunter2hunter2',
    });
    // Open network, with and without the trailing newline.
    assert.deepEqual(parseWifiCredential('Home\n\n'), { ssid: 'Home', password: '' });
    assert.deepEqual(parseWifiCredential('Home\n'), { ssid: 'Home', password: '' });
    // Anything past the second line is ignored, so a stray byte cannot corrupt
    // a credential that is otherwise fine.
    assert.deepEqual(parseWifiCredential('Home\nhunter2hunter2\njunk\n'), {
        ssid: 'Home',
        password: 'hunter2hunter2',
    });
    // AND THE REFUSALS. A half-written file must read as "nothing staged", never
    // as a credential with an empty SSID that the reader would try to join.
    assert.equal(parseWifiCredential(''), null);
    assert.equal(parseWifiCredential('\nhunter2hunter2\n'), null);
    assert.equal(parseWifiCredential('Home\nshort\n'), null);
    assert.equal(parseWifiCredential(null), null);
});

test('validation refuses what the reader could not use, and allows the blank PSK', () => {
    assert.equal(describeWifiSsidProblem(SSID), null);
    assert.equal(typeof describeWifiSsidProblem(''), 'string');
    // A newline in an SSID would silently reshape the two-line format into
    // something else. Refused, not stripped.
    assert.equal(typeof describeWifiSsidProblem('Home\nEvil'), 'string');
    // 32 BYTES, not characters: the 802.11 cap is on the octets.
    assert.equal(describeWifiSsidProblem('x'.repeat(WIFI_SSID_MAX_BYTES)), null);
    assert.equal(typeof describeWifiSsidProblem('x'.repeat(WIFI_SSID_MAX_BYTES + 1)), 'string');
    assert.equal(typeof describeWifiSsidProblem('é'.repeat(17)), 'string', '34 bytes must be refused');

    // BLANK IS VALID and means an open network — the same convention the reader
    // AP passphrase field already uses.
    assert.equal(describeWifiPasswordProblem(''), null);
    assert.equal(describeWifiPasswordProblem('x'.repeat(WIFI_PSK_MIN_CHARS)), null);
    assert.equal(describeWifiPasswordProblem('x'.repeat(WIFI_PSK_MAX_CHARS)), null);
    assert.equal(typeof describeWifiPasswordProblem('x'.repeat(WIFI_PSK_MIN_CHARS - 1)), 'string');
    assert.equal(typeof describeWifiPasswordProblem('x'.repeat(WIFI_PSK_MAX_CHARS + 1)), 'string');
    assert.equal(typeof describeWifiPasswordProblem('has\nnewline'), 'string');
});

// ---------------------------------------------------------------------------
// 2. Staging, handover, and THE WIPE
// ---------------------------------------------------------------------------

test('a staged credential round-trips and exports the two lines for native', async () => {
    const store = fakeStore();
    const fs = fakeFs();
    install(store, fs);
    try {
        const staged = await stageWifiShare({ ssid: SSID, password: PSK });
        assert.equal(staged.ok, true);
        assert.equal(staged.record.status, 'pending');

        const read = await getWifiShare();
        assert.equal(read.ssid, SSID);
        assert.equal(read.password, PSK);

        // NOTHING IS WRITTEN TO DISK BY STAGING. The file exists only for the
        // length of a handover attempt, not from the moment the user typed it.
        assert.equal(fs.files.size, 0);

        const handover = await prepareWifiShareHandover();
        assert.equal(handover.pending, true);
        assert.equal(handover.path, CRED_PATH);
        assert.equal(fs.files.get(CRED_PATH), `${SSID}\n${PSK}\n`);
    } finally {
        uninstall();
    }
});

test('THE WIPE: a delivered handover removes the passphrase from both copies', async () => {
    const store = fakeStore();
    const fs = fakeFs();
    install(store, fs);
    try {
        await stageWifiShare({ ssid: SSID, password: PSK });
        await prepareWifiShareHandover();
        assert.equal(fs.files.has(CRED_PATH), true);

        const delivered = await markWifiShareDelivered();
        assert.equal(delivered.status, 'delivered');
        // THE PASSPHRASE IS GONE FROM THE INDEX...
        assert.equal(delivered.password, '');
        assert.equal(JSON.parse(store.cells.get(WIFI_SHARE_KEY)).password, '');
        // ...AND FROM THE FILE. Native deletes the same file on the ack; two
        // independent deletes for one secret is the point, not redundancy.
        assert.equal(fs.files.has(CRED_PATH), false);
        // The network NAME survives so the card can say which one went across.
        // It is not a secret and "handed over" with no name is a worse answer.
        assert.equal(delivered.ssid, SSID);

        // A second ack (a duplicate event, or a reconcile after a missed one) is
        // a no-op rather than a second state change.
        const again = await markWifiShareDelivered();
        assert.equal(again.status, 'delivered');
        assert.equal(again.deliveredAt, delivered.deliveredAt);
    } finally {
        uninstall();
    }
});

test('a delivered credential is never offered again', async () => {
    const store = fakeStore();
    const fs = fakeFs();
    install(store, fs);
    try {
        await stageWifiShare({ ssid: SSID, password: PSK });
        await markWifiShareDelivered();

        const handover = await prepareWifiShareHandover();
        // No path means `buildProxyOptions` omits the key, which means the native
        // endpoint does not exist for the next session. That is the mechanism
        // that stops a handed-over network being served for ever.
        assert.equal(handover.pending, false);
        assert.equal(handover.path, '');
        // And any file a previous session left behind is cleaned up on the way
        // through, so a stale copy can never be served on its own.
        assert.deepEqual(fs.removed.includes(CRED_PATH), true);
    } finally {
        uninstall();
    }
});

test('staging a second network REPLACES the first and drops the old file', async () => {
    const store = fakeStore();
    const fs = fakeFs();
    install(store, fs);
    try {
        await stageWifiShare({ ssid: SSID, password: PSK });
        await prepareWifiShareHandover();
        assert.equal(fs.files.get(CRED_PATH), `${SSID}\n${PSK}\n`);

        await stageWifiShare({ ssid: 'Cafe', password: '' });
        // The exported file named the OLD network; it goes at the moment the new
        // one is staged rather than at the next handover.
        assert.equal(fs.files.has(CRED_PATH), false);

        await prepareWifiShareHandover();
        assert.equal(fs.files.get(CRED_PATH), 'Cafe\n\n');
        const record = await getWifiShare();
        assert.equal(record.ssid, 'Cafe');
        assert.equal(record.status, 'pending');
    } finally {
        uninstall();
    }
});

test('an invalid credential is refused before anything is stored', async () => {
    const store = fakeStore();
    const fs = fakeFs();
    install(store, fs);
    try {
        const bad = await stageWifiShare({ ssid: '', password: PSK });
        assert.equal(bad.ok, false);
        assert.equal(typeof bad.error, 'string');
        assert.equal(store.cells.size, 0);

        const shortPsk = await stageWifiShare({ ssid: SSID, password: 'abc' });
        assert.equal(shortPsk.ok, false);
        assert.equal(store.cells.size, 0);
    } finally {
        uninstall();
    }
});

test('a corrupt stored blob reads as NOTHING STAGED', async () => {
    // The blob is unversioned and hand-editable. A half-parsed credential would
    // tell the user a network is queued and offer the reader something it cannot
    // join, which is strictly worse than offering nothing.
    for (const blob of ['not json', '{}', '{"ssid":""}', '{"ssid":"Home","password":"short"}']) {
        const store = fakeStore(blob);
        install(store, fakeFs());
        try {
            assert.equal(await getWifiShare(), null, `blob ${blob} should not parse`);
        } finally {
            uninstall();
        }
    }
});

test('subscribers see stage, delivery and clear', async () => {
    const store = fakeStore();
    install(store, fakeFs());
    const seen = [];
    const off = subscribeWifiShare(record => seen.push(record ? record.status : null));
    try {
        await stageWifiShare({ ssid: SSID, password: PSK });
        await markWifiShareDelivered();
        await clearWifiShare();
        assert.deepEqual(seen, ['pending', 'delivered', null]);
    } finally {
        off();
        uninstall();
    }
});

test('no filesystem and no store degrade to "nothing can be staged"', async () => {
    // The state of a node test, a web preview, and a runtime with no document
    // directory. None of it may throw: the sync session calls straight into this
    // on the critical path of a session the user is standing in front of.
    install(null, null);
    __setWifiShareStore(null);
    __setWifiShareFileSystem(null);
    // With the seams cleared, resolution falls back to the real lazy require,
    // which finds nothing under node.
    assert.equal(await getWifiShare(), null);
    const handover = await prepareWifiShareHandover();
    assert.deepEqual(handover, { path: '', pending: false, ssid: null });
    await markWifiShareDelivered();
    await clearWifiShare();

    // A store with no filesystem still stages — the credential is simply not
    // exportable until a runtime with a sandbox runs the handover.
    const store = fakeStore();
    install(store, fakeFs({ documentDirectory: null }));
    try {
        const staged = await stageWifiShare({ ssid: SSID, password: PSK });
        assert.equal(staged.ok, true);
        const withoutDir = await prepareWifiShareHandover();
        assert.equal(withoutDir.pending, true);
        assert.equal(withoutDir.path, '');
    } finally {
        uninstall();
    }
});

test('a write failure during handover is not an error the user sees', async () => {
    const store = fakeStore();
    const fs = fakeFs({ writeThrows: true });
    install(store, fs);
    try {
        await stageWifiShare({ ssid: SSID, password: PSK });
        const handover = await prepareWifiShareHandover();
        // Still pending (nothing was handed over), but no path, so the session
        // runs without the endpoint rather than failing.
        assert.equal(handover.pending, true);
        assert.equal(handover.path, '');
    } finally {
        uninstall();
    }
});

test('the status line says what is true and never shows the passphrase', async () => {
    const store = fakeStore();
    install(store, fakeFs());
    try {
        assert.equal(describeWifiShare(null), null);
        await stageWifiShare({ ssid: SSID, password: PSK });
        const pending = describeWifiShare(await getWifiShare());
        assert.match(pending, /next sync/i);
        assert.equal(pending.includes(PSK), false);
        await markWifiShareDelivered();
        const delivered = describeWifiShare(await getWifiShare());
        assert.match(delivered, /handed over/i);
        assert.equal(delivered.includes(PSK), false);
    } finally {
        uninstall();
    }
});

// ---------------------------------------------------------------------------
// 3. The option plumb — an ABSENT key is the feature being off
// ---------------------------------------------------------------------------

test('buildProxyOptions omits wifiSharePath unless there is one', () => {
    // THE ABSENCE IS THE SECURITY PROPERTY. `/cp-wifi` is the only endpoint in
    // the module that serves a secret, and the native side refuses it outright
    // when this key is missing — so "always present, sometimes empty" would turn
    // the endpoint on for every session ever started.
    const off = buildProxyOptions(BASE);
    assert.equal(off.ok, true);
    assert.equal('wifiSharePath' in off.options, false);

    const empty = buildProxyOptions(BASE, undefined, undefined, '', '');
    assert.equal('wifiSharePath' in empty.options, false);

    const on = buildProxyOptions(BASE, undefined, undefined, '', CRED_PATH);
    assert.equal(on.options.wifiSharePath, CRED_PATH);
    // And it is still an ORIGIN plus paths — nothing that could authenticate
    // against the mailbox rode in with it.
    assert.deepEqual(Object.keys(on.options).sort(), [
        'allowedPathPrefix',
        'healthPath',
        'mailboxOrigin',
        'port',
        'sessionMaxMs',
        'wifiSharePath',
    ]);
});

test('the session passes the staged PATH to native, and never the credential', async () => {
    const calls = [];
    let emit = null;
    const link = {
        isAvailable: () => true,
        async join() {},
        async leave() {},
        async startProxy(options) {
            calls.push(options);
            return { ipv4: '192.168.4.2', port: 8080 };
        },
        async stopProxy() {},
        subscribe(listener) {
            emit = listener;
            return () => {
                emit = null;
            };
        },
    };
    const wiped = [];
    const controller = createSyncSession({
        link,
        outbox: {
            async prepare() {
                return { manifestPath: '', pending: 0 };
            },
            async markDelivered() {},
        },
        history: { async markDeliveredDirectly() { return false; } },
        wifiShare: {
            async prepare() {
                return { path: CRED_PATH, pending: true };
            },
            async markDelivered() {
                wiped.push(Date.now());
            },
            async discard() {},
        },
    });

    await controller.start({ ssid: 'CrossPoint-Reader', mailboxUrl: BASE });
    emit({ kind: 'link', state: 'joined', ipv4: '192.168.4.2' });
    await flush();
    await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].wifiSharePath, CRED_PATH);
    // The PASSPHRASE never crosses this boundary — only a path inside the app's
    // own sandbox does.
    const serialised = JSON.stringify(calls);
    assert.equal(serialised.includes(PSK), false);
    assert.equal(serialised.includes(SSID), false);

    // `served` is NOT a handover: the reader has the bytes and has said nothing
    // about saving them, and the phone holds the only copy.
    emit({ kind: 'wifi', state: 'served' });
    await flush();
    assert.equal(controller.getSession().wifiOffered, true);
    assert.equal(controller.getSession().wifiHandedOver, false);
    assert.deepEqual(wiped, []);

    // The ACK is what wipes it, exactly once.
    emit({ kind: 'wifi', state: 'delivered' });
    await flush();
    assert.equal(controller.getSession().wifiHandedOver, true);
    assert.equal(wiped.length, 1);
    emit({ kind: 'wifi', state: 'delivered' });
    await flush();
    assert.equal(wiped.length, 1, 'a duplicate ack must not wipe twice');

    await controller.dispose();
});

test('nothing staged means no wifiSharePath at all', async () => {
    const calls = [];
    let emit = null;
    const link = {
        isAvailable: () => true,
        async join() {},
        async leave() {},
        async startProxy(options) {
            calls.push(options);
            return { ipv4: '192.168.4.2', port: 8080 };
        },
        async stopProxy() {},
        subscribe(listener) {
            emit = listener;
            return () => {};
        },
    };
    const controller = createSyncSession({
        link,
        outbox: {
            async prepare() {
                return { manifestPath: '', pending: 0 };
            },
            async markDelivered() {},
        },
        history: { async markDeliveredDirectly() { return false; } },
        wifiShare: {
            async prepare() {
                return { path: '', pending: false };
            },
            async markDelivered() {
                throw new Error('must not be called');
            },
            async discard() {},
        },
    });

    await controller.start({ ssid: 'CrossPoint-Reader', mailboxUrl: BASE });
    emit({ kind: 'link', state: 'joined', ipv4: '192.168.4.2' });
    await flush();
    await flush();

    assert.equal(calls.length, 1);
    assert.equal('wifiSharePath' in calls[0], false);
    await controller.dispose();
});

test('a wifiShare port that throws does not fail the session', async () => {
    let emit = null;
    const link = {
        isAvailable: () => true,
        async join() {},
        async leave() {},
        async startProxy() {
            return { ipv4: '192.168.4.2', port: 8080 };
        },
        async stopProxy() {},
        subscribe(listener) {
            emit = listener;
            return () => {};
        },
    };
    const controller = createSyncSession({
        link,
        outbox: {
            async prepare() {
                return { manifestPath: '', pending: 0 };
            },
            async markDelivered() {},
        },
        history: { async markDeliveredDirectly() { return false; } },
        wifiShare: {
            async prepare() {
                throw new Error('storage is gone');
            },
            async markDelivered() {},
            async discard() {
                throw new Error('the filesystem is gone too');
            },
        },
    });

    await controller.start({ ssid: 'CrossPoint-Reader', mailboxUrl: BASE });
    emit({ kind: 'link', state: 'joined', ipv4: '192.168.4.2' });
    await flush();
    await flush();
    // A credential that cannot be armed is a sync WITHOUT the WiFi handover, not
    // a failed sync: the books and notes still go across.
    assert.equal(controller.getSession().state, 'proxying');
    await controller.dispose();
});

test('a session that ends WITHOUT an ack still takes the passphrase off disk', async () => {
    // THE INVARIANT THE WHOLE "plaintext file" DESIGN RESTS ON. `prepare()` writes
    // the passphrase to documentDirectory in cleartext and justifies it by saying
    // the file lives for the length of a SESSION, not the length of the staging.
    // Only the reader's ack used to remove it — so a reader that never came into
    // range, a user who tapped Stop, or the watchdog left the WPA2 passphrase in
    // the sandbox indefinitely, which is exactly the window an `allowBackup` or a
    // filesystem read is measured against. This is that sentence, enforced.
    const store = fakeStore();
    const fs = fakeFs();
    install(store, fs);
    try {
        await stageWifiShare({ ssid: SSID, password: PSK });

        let emit = null;
        const link = {
            isAvailable: () => true,
            async join() {},
            async leave() {},
            async startProxy() {
                return { ipv4: '192.168.4.2', port: 8080 };
            },
            async stopProxy() {},
            subscribe(listener) {
                emit = listener;
                return () => {
                    emit = null;
                };
            },
        };
        const controller = createSyncSession({
            link,
            outbox: {
                async prepare() {
                    return { manifestPath: '', pending: 0 };
                },
                async markDelivered() {},
            },
            history: { async markDeliveredDirectly() { return false; } },
            // THE REAL MODULE FUNCTIONS, not recorders: what is being pinned is
            // the file lifecycle, and a fake port would pin only the call.
            wifiShare: {
                prepare: async () => {
                    const { path, pending } = await prepareWifiShareHandover();
                    return { path, pending };
                },
                markDelivered: async () => {
                    await markWifiShareDelivered();
                },
                discard: discardWifiShareHandover,
            },
        });

        await controller.start({ ssid: 'CrossPoint-Reader', mailboxUrl: BASE });
        emit({ kind: 'link', state: 'joined', ipv4: '192.168.4.2' });
        await flush();
        await flush();
        // Exported, as it must be — the reader cannot be handed a file that was
        // never written.
        assert.equal(fs.files.get(CRED_PATH), `${SSID}\n${PSK}\n`);

        // AND NOW THE SESSION ENDS WITH NO `delivered` EVENT AT ALL.
        await controller.stop();
        await flush();
        assert.equal(fs.files.size, 0, 'the passphrase outlived the session that exported it');
        assert.equal(fs.files.has(CRED_PATH), false);

        // THE STAGING SURVIVES. Only the exported copy went: the user staged a
        // network and the reader never took it, so the next session must offer it
        // again. Dropping it here would silently lose a handover because the
        // reader happened to be out of range once.
        const record = await getWifiShare();
        assert.equal(record.status, 'pending');
        assert.equal(record.ssid, SSID);
        assert.equal(record.password, PSK);

        // And the next session re-exports it from that surviving record.
        const again = await prepareWifiShareHandover();
        assert.equal(again.pending, true);
        assert.equal(fs.files.get(CRED_PATH), `${SSID}\n${PSK}\n`);

        await controller.dispose();
    } finally {
        uninstall();
    }
});

// ---------------------------------------------------------------------------
// 4. The event coercion — `delivered` deletes a secret, so it is an allowlist
// ---------------------------------------------------------------------------

test('the wifi event coerces to a state word and NOTHING else', () => {
    assert.deepEqual(coerceReaderLinkEvent('wifi', { state: 'served' }), {
        kind: 'wifi',
        state: 'served',
    });
    assert.deepEqual(coerceReaderLinkEvent('wifi', { state: 'delivered' }), {
        kind: 'wifi',
        state: 'delivered',
    });
    // NOTHING ELSE ON THE PAYLOAD IS READ. Even a native build that grew an
    // `ssid` field could not get it into JS, which is what keeps the credential
    // out of every status line and crash report.
    const extra = coerceReaderLinkEvent('wifi', {
        state: 'delivered',
        ssid: SSID,
        password: PSK,
        path: '/cp-wifi',
    });
    assert.deepEqual(Object.keys(extra).sort(), ['kind', 'state']);
    assert.equal(JSON.stringify(extra).includes(PSK), false);
});

test('an unrecognised wifi state is DROPPED, not defaulted', () => {
    // `delivered` makes the app delete a passphrase the user typed. A guess here
    // would throw one away on a payload nothing recognised.
    assert.equal(coerceReaderLinkEvent('wifi', { state: 'ok' }), null);
    assert.equal(coerceReaderLinkEvent('wifi', {}), null);
    assert.equal(coerceReaderLinkEvent('wifi', { state: 1 }), null);
    assert.equal(coerceReaderLinkEvent('wifi', null), null);
});

test('a wifi event outside `proxying` changes nothing', () => {
    // Same first-end-wins discipline as every other event: a late ack from a torn
    // down link must not be attributed to a session that is already over, and it
    // certainly must not wipe a credential the next session is about to offer.
    const idle = initialSyncSession();
    assert.equal(
        reduceSyncSession(idle, { type: 'wifi', at: 1, event: { kind: 'wifi', state: 'delivered' } }),
        idle
    );
    const searching = reduceSyncSession(idle, { type: 'start', at: 1, ssid: 'CrossPoint-Reader' });
    const stillSearching = reduceSyncSession(searching, {
        type: 'wifi',
        at: 2,
        event: { kind: 'wifi', state: 'delivered' },
    });
    assert.equal(stillSearching.wifiHandedOver, false);
});

test('a wifi ack counts as PROGRESS against the quiet deadline', () => {
    // A handover on an otherwise silent session is the reader talking to this
    // phone. Without this the quiet deadline could fire underneath one.
    let session = reduceSyncSession(initialSyncSession(), {
        type: 'start',
        at: 1_000,
        ssid: 'CrossPoint-Reader',
    });
    session = reduceSyncSession(session, {
        type: 'proxy',
        at: 2_000,
        event: { kind: 'proxy', state: 'listening', ipv4: '192.168.4.2', port: 8080 },
    });
    const after = reduceSyncSession(session, {
        type: 'wifi',
        at: 90_000,
        event: { kind: 'wifi', state: 'served' },
    });
    assert.equal(after.lastProgressAt, 90_000);
});

// ---------------------------------------------------------------------------
// 5. Degradation with no native module
// ---------------------------------------------------------------------------

test('subscribing survives a build whose Kotlin has no onWifiShare', () => {
    // A dev client older than this feature does not DECLARE the event, and expo
    // throws on `addListener` for an undeclared name. Losing the other
    // subscriptions to that would take the whole session down for the sake of one
    // optional signal.
    const seen = [];
    __setReaderLinkNative({
        addListener(name, listener) {
            if (name === 'onWifiShare') throw new Error('unsupported event');
            seen.push(name);
            return { remove() {} };
        },
        join: async () => {},
        leave: async () => {},
        startProxy: async () => ({}),
        stopProxy: async () => {},
    });
    try {
        const off = readerLink.subscribe(() => {});
        assert.ok(seen.includes('onLinkState'));
        assert.ok(seen.includes('onProxyState'));
        assert.equal(seen.includes('onWifiShare'), false);
        off();
    } finally {
        __setReaderLinkNative(null);
    }
});
