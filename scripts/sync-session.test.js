/**
 * The 'Sync with reader' session — the reader-AP peer link and its proxy.
 *
 * This is the only test that can reach the M3 feature at all: the Kotlin half is
 * not compiled here and the screen is not renderable here, so everything that
 * decides what the user SEES and what the radio DOES has to live in
 * `services/sync_session.ts` and `services/reader_link.ts`, and this file is what
 * holds it there.
 *
 * The failures worth pinning are the ones that are invisible on a device — the
 * mailbox contract has no acks, the reader logs nothing to the phone, and the
 * radio state is not observable from the UI:
 *
 *   - the AP disappearing MID-PROXY is the NORMAL end of a successful session
 *     (the reader calls softAPdisconnect when it is done), and reporting it as an
 *     error would train the user to distrust a feature that worked;
 *   - the same event BEFORE the proxy came up is a real failure, and one reason
 *     string has to cover both;
 *   - a session that ends must GIVE THE RADIO BACK. A `NetworkRequest` left
 *     registered keeps the phone off its own WiFi indefinitely, long after this
 *     screen is out of sight, and nothing in the UI would say so;
 *   - a late native callback from a stopped session must not resurrect it, or
 *     Stop-then-Sync reports a failure the user is not having;
 *   - the write token must NEVER reach the proxy. Reads are protected by the
 *     unguessable boxId in the path; the peer interface is reachable by anything
 *     that associates with an open AP;
 *   - and on a build with no native module — every dev client until the next
 *     native rebuild — the button has to say "rebuild", not throw.
 *
 * `now` is injected everywhere, so no test depends on the wall clock, and no
 * deadline test waits for one.
 *
 * Run:  node --import tsx --test scripts/sync-session.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    NATIVE_MODULE_NAME,
    PROXY_DEFAULT_PORT,
    PROXY_HEALTH_PATH,
    READER_LINK_UNAVAILABLE,
    __setReaderLinkNative,
    buildProxyOptions,
    coerceReaderLinkEvent,
    describeProxyTarget,
    readerLink,
} from '../src/services/reader_link';
import {
    DEFAULT_SYNC_TIMEOUTS,
    NATIVE_JOIN_MARGIN_MS,
    createSyncSession,
    describeSyncMode,
    describeSyncSession,
    describeUpstreamProblem,
    initialSyncSession,
    isSyncSessionActive,
    nativeJoinTimeoutMs,
    reduceSyncSession,
    tickSyncSession,
} from '../src/services/sync_session';
import { DEFAULTS, normalizeSettings } from '../src/services/settings';

const SSID = 'CrossPoint-Reader';
const BASE = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const TOKEN = 'wr_super_secret_token';
const PEER_IP = '192.168.4.2';

/** An arbitrary fixed epoch — nothing here depends on its value. */
const T0 = Date.UTC(2026, 6, 30, 9, 0, 0);

const flush = () => new Promise(resolve => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A reader-link that behaves like the native module's CONTRACT, not like a stub:
 * `join` resolves when the request is submitted (never when joined), the outcome
 * arrives as an event, and `subscribe` hands back a real unsubscribe.
 */
function fakeLink(options = {}) {
    const {
        available = true,
        joinError = null,
        startProxyError = null,
        startProxyGate = null,
        // Holds stopProxy() pending until the test resolves it. Models the native
        // reality the P1 deadlock came from: every entry point is serialised onto
        // ONE ops thread, so stopProxy cannot complete while a join is parked there.
        stopProxyGate = null,
        // Throws synchronously rather than returning a rejected promise — a missing
        // native method looks like this, and it must not take the release down.
        stopProxyThrowsSync = false,
        endpoint = { ipv4: PEER_IP, port: PROXY_DEFAULT_PORT },
    } = options;

    const calls = [];
    let listener = null;

    return {
        calls,
        /** Names of the calls made, in order. */
        names: () => calls.map(c => c.fn),
        args: fn => calls.filter(c => c.fn === fn).map(c => c.options),
        hasListener: () => listener !== null,
        emit(event) {
            if (!listener) throw new Error('emit() with no subscriber');
            listener(event);
        },

        isAvailable: () => available,
        async join(opts) {
            calls.push({ fn: 'join', options: opts });
            if (joinError) throw joinError;
        },
        async leave() {
            calls.push({ fn: 'leave' });
        },
        async startProxy(opts) {
            calls.push({ fn: 'startProxy', options: opts });
            if (startProxyGate) await startProxyGate;
            if (startProxyError) throw startProxyError;
            return endpoint;
        },
        stopProxy() {
            calls.push({ fn: 'stopProxy' });
            if (stopProxyThrowsSync) throw new Error('stopProxy is not a function');
            return stopProxyGate ?? Promise.resolve();
        },
        subscribe(fn) {
            calls.push({ fn: 'subscribe' });
            listener = fn;
            return () => {
                calls.push({ fn: 'unsubscribe' });
                listener = null;
            };
        },
    };
}

/**
 * The outbox + History side of the seam, recording what a confirmed handover did.
 *
 * Both are PORTS on `createSyncSession` for exactly this reason: `services/outbox`
 * touches expo-file-system and AsyncStorage, so the only way the delivery path is
 * reachable from node is to hand it fakes.
 */
function fakePorts() {
    const markedDelivered = [];
    const historyPatched = [];
    return {
        markedDelivered,
        historyPatched,
        outbox: {
            async prepare() {
                return { manifestPath: '/data/app/files/outbox/manifest.json', pending: 2 };
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
    };
}

/** A controller with an injected clock the test moves by hand. */
function harness(linkOptions = {}, timeouts = undefined, ports = undefined) {
    const link = fakeLink(linkOptions);
    let clock = T0;
    const controller = createSyncSession({
        link,
        now: () => clock,
        ...(timeouts ? { timeouts } : {}),
        ...(ports ? { outbox: ports.outbox, history: ports.history } : {}),
    });
    return {
        link,
        controller,
        advance(ms) {
            clock += ms;
        },
        at: () => clock,
        state: () => controller.getSession().state,
        session: () => controller.getSession(),
    };
}

const link = (state, extra = {}) => ({ kind: 'link', state, ...extra });
const proxy = (state, extra = {}) => ({ kind: 'proxy', state, ...extra });
const activity = (extra = {}) => ({
    kind: 'activity',
    method: 'GET',
    path: '/m/box/latest.txt',
    status: 200,
    ...extra,
});

/** Walk a session to `proxying` through the reducer alone. */
function proxyingSession() {
    let s = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    s = reduceSyncSession(s, { type: 'link', at: T0 + 1000, event: link('joined', { ipv4: PEER_IP }) });
    return reduceSyncSession(s, {
        type: 'proxy',
        at: T0 + 1500,
        event: proxy('listening', { ipv4: PEER_IP, port: PROXY_DEFAULT_PORT }),
    });
}

// ---------------------------------------------------------------------------
// describeProxyTarget / buildProxyOptions
// ---------------------------------------------------------------------------

test('the proxy target is the mailbox ORIGIN, and the path is what gates it', () => {
    const target = describeProxyTarget(BASE);
    assert.equal(target.ok, true);
    assert.equal(target.origin, 'https://mail.example.net');
    assert.equal(target.basePath, '/m/aBcDeFgHiJkLmNoPqRsTuV');
    // A3's literal rule: the forwarder serves /m/* and forwards the path verbatim,
    // so the reader's own base path travels through unchanged.
    assert.equal(target.allowedPathPrefix, '/m/');
    assert.equal(target.readerBase, `http://{phone}:${PROXY_DEFAULT_PORT}/m/aBcDeFgHiJkLmNoPqRsTuV`);
});

test('a sub-path deployment gates on its own base, not on /m/', () => {
    // `https://host/mailbox/m/{box}` would be refused by a hardcoded '/m/' gate —
    // the reader's requests start '/mailbox/...'. The prefix is therefore derived,
    // and the result is TIGHTER than /m/*: it pins the box as well.
    const target = describeProxyTarget('https://host.example/mailbox/m/box7');
    assert.equal(target.ok, true);
    assert.equal(target.origin, 'https://host.example');
    assert.equal(target.allowedPathPrefix, '/mailbox/m/box7/');
});

test('trailing slashes and http bases survive the split', () => {
    const target = describeProxyTarget('http://10.0.0.7:8787/m/box7///');
    assert.equal(target.ok, true);
    assert.equal(target.origin, 'http://10.0.0.7:8787');
    assert.equal(target.basePath, '/m/box7');
    assert.equal(target.allowedPathPrefix, '/m/');
});

test('a mailbox at the origin root is refused, not served as an open relay', () => {
    // With no path there is nothing to gate on but '/', which would make the
    // forwarder a general-purpose GET relay to that origin for anything that
    // associates with the reader's AP.
    const target = describeProxyTarget('https://mail.example.net');
    assert.equal(target.ok, false);
    assert.match(target.error, /\/m\/<box-id>/);
});

test('every mailbox-URL defect is refused with the app-wide wording', () => {
    for (const bad of [
        '',
        '   ',
        'mail.example.net/m/box',              // no scheme
        'https://user:pw@mail.example.net/m/b', // credentials
        'https://mail.example.net/m/b?x=1',     // query
        'https://mail.example.net/m/b#frag',    // fragment
        'https://mail example.net/m/b',         // whitespace
        `https://mail.example.net/m/${'x'.repeat(200)}`, // over the reader's 127
    ]) {
        const target = describeProxyTarget(bad);
        assert.equal(target.ok, false, `should refuse ${JSON.stringify(bad)}`);
        assert.equal(typeof target.error, 'string');
        assert.ok(target.error.length > 0);
    }
});

test('buildProxyOptions carries the health path and NOTHING that could authenticate', () => {
    const built = buildProxyOptions(BASE);
    assert.equal(built.ok, true);
    // The exact key set, asserted as a set: this object crosses into native code
    // and its ABSENCES are the security property. A new key here is a review event.
    assert.deepEqual(Object.keys(built.options).sort(), [
        'allowedPathPrefix',
        'healthPath',
        'mailboxOrigin',
        'port',
        'sessionMaxMs',
    ]);
    assert.equal(built.options.healthPath, PROXY_HEALTH_PATH);
    assert.equal(built.options.port, PROXY_DEFAULT_PORT);
    // ONE cap for both halves: the native watchdog is armed from this value, so it
    // and the JS deadline expire together instead of being two numbers that drift
    // (they were 15 min here and 30 min in ProxyContract, and the native one is the
    // cap that actually fires when the screen is unmounted and nothing ticks).
    assert.equal(built.options.sessionMaxMs, DEFAULT_SYNC_TIMEOUTS.sessionMs);
    // The reader probes a boxId-FREE path (A3's security finding): probing with
    // /m/{boxId}/… would hand the whole mailbox's read capability to whichever
    // stranger took 192.168.4.2 on an open AP.
    assert.equal(PROXY_HEALTH_PATH.includes('/m/'), false);
});

test('the native join deadline is SHORTER than the JS one, and 0 stays 0', () => {
    // Both deadlines describe the same failure and the platform's account is the
    // better one: onUnavailable knows whether the SSID was absent or the user
    // refused the dialog, where a JS tick can only say "gave up waiting". So native
    // gets the shorter budget and wins the race — the module adds its own 2 s of
    // grace on top, which still lands inside this margin.
    const budget = nativeJoinTimeoutMs(DEFAULT_SYNC_TIMEOUTS.linkMs);
    assert.equal(budget, DEFAULT_SYNC_TIMEOUTS.linkMs - NATIVE_JOIN_MARGIN_MS);
    assert.ok(budget + 2000 < DEFAULT_SYNC_TIMEOUTS.linkMs, 'native grace must land inside the margin');
    // 0 is the documented watcher mode: the request stays outstanding with NO
    // platform timeout, because A3 forbids scanning for the AP. Shortening a
    // budget that does not exist would silently turn the watcher into a 5 s probe.
    assert.equal(nativeJoinTimeoutMs(0), 0);
    assert.equal(nativeJoinTimeoutMs(-1), 0);
    // Degenerate budgets clamp to native's own floor rather than going negative.
    assert.equal(nativeJoinTimeoutMs(1000), 5000);
});

test('a custom port rides through', () => {
    const built = buildProxyOptions(BASE, 9123);
    assert.equal(built.ok, true);
    assert.equal(built.options.port, 9123);
});

// ---------------------------------------------------------------------------
// Native event coercion
// ---------------------------------------------------------------------------

test('an unrecognised link/proxy state is DROPPED, never forwarded', () => {
    // The reducer branches on this string. An unknown one would fall through
    // every case and leave the session wedged in `joining` with no deadline
    // having elapsed — a spinner that never resolves.
    assert.equal(coerceReaderLinkEvent('link', { state: 'reassociating' }), null);
    assert.equal(coerceReaderLinkEvent('link', {}), null);
    assert.equal(coerceReaderLinkEvent('link', null), null);
    assert.equal(coerceReaderLinkEvent('proxy', { state: 'binding' }), null);
    assert.equal(coerceReaderLinkEvent('proxy', 'listening'), null);
});

test('link and proxy payloads are coerced, not trusted', () => {
    assert.deepEqual(coerceReaderLinkEvent('link', { state: 'joined', ipv4: PEER_IP, ssid: SSID }), {
        kind: 'link',
        state: 'joined',
        ssid: SSID,
        ipv4: PEER_IP,
        error: null,
    });
    // Wrong types become null rather than reaching the reducer as numbers.
    assert.deepEqual(coerceReaderLinkEvent('proxy', { state: 'listening', port: '8080', ipv4: 7 }), {
        kind: 'proxy',
        state: 'listening',
        ipv4: null,
        port: null,
        error: null,
    });
});

test('activity is accepted with holes — it only claims "the reader asked"', () => {
    const event = coerceReaderLinkEvent('activity', {});
    assert.equal(event.kind, 'activity');
    assert.equal(event.method, '?');
    assert.equal(event.path, '');
    assert.equal(event.status, 0);
    assert.equal(event.bytes, null);
});

test('the native module is absent under node, and isAvailable() says so', () => {
    // This is also the state of every dev client built before the Kotlin landed,
    // which is why the whole feature is feature-detected rather than assumed.
    assert.equal(readerLink.isAvailable(), false);
    assert.equal(NATIVE_MODULE_NAME, 'ReaderLink');
});

test('teardown calls are safe with no native module at all', async () => {
    // stop() runs these on every exit path; throwing here would strand the
    // session's own cleanup.
    await readerLink.leave();
    await readerLink.stopProxy();
    assert.equal(typeof readerLink.subscribe(() => {}), 'function');
});

test('join and startProxy refuse with the rebuild message, not a type error', async () => {
    await assert.rejects(() => readerLink.join({ ssid: SSID }), /Rebuild and reinstall/);
    await assert.rejects(
        () => readerLink.startProxy({ mailboxOrigin: 'https://x', allowedPathPrefix: '/m/', healthPath: PROXY_HEALTH_PATH }),
        /Rebuild and reinstall/
    );
});

test('the native surface resolves under either naming, and the origin is sent both ways', async t => {
    // The Kotlin half is compiled in a separate pass with NO shared type check, so
    // a bare-verb / `…ReaderAp` disagreement produces no error anywhere — just a
    // permanent "rebuild required" on a build that has the module, or a proxy
    // started with an empty upstream that 502s every read the reader makes.
    t.after(() => __setReaderLinkNative(null));

    const calls = [];
    __setReaderLinkNative({
        // The alternative spellings, plus a differently-named endpoint field.
        joinReaderAp: async o => calls.push(['join', o]),
        leaveReaderAp: async () => calls.push(['leave']),
        startMailboxProxy: async o => {
            calls.push(['startProxy', o]);
            return { ip: PEER_IP, port: PROXY_DEFAULT_PORT };
        },
        stopMailboxProxy: async () => calls.push(['stopProxy']),
        addListener: () => ({ remove() {} }),
    });

    assert.equal(readerLink.isAvailable(), true);
    await readerLink.join({ ssid: SSID, passphrase: '' });
    const endpoint = await readerLink.startProxy(buildProxyOptions(BASE).options);
    await readerLink.stopProxy();
    await readerLink.leave();

    assert.deepEqual(calls.map(c => c[0]), ['join', 'startProxy', 'stopProxy', 'leave']);
    // '' passphrase means OPEN — the state the firmware ships — not "empty PSK".
    assert.equal(calls[0][1].passphrase, null);
    const proxyArgs = calls[1][1];
    assert.equal(proxyArgs.mailboxOrigin, 'https://mail.example.net');
    assert.equal(proxyArgs.upstreamOrigin, 'https://mail.example.net');
    assert.deepEqual(endpoint, { ipv4: PEER_IP, port: PROXY_DEFAULT_PORT });
});

test('a native module missing ANY call is refused whole, not half-used', async t => {
    // Half-resolved would fail three awaits deep, mid-session, with the radio
    // already held — the worst place to discover a rename.
    t.after(() => __setReaderLinkNative(null));
    __setReaderLinkNative({
        join: async () => {},
        leave: async () => {},
        stopProxy: async () => {},
        addListener: () => ({ remove() {} }),
        // no startProxy under any name
    });
    assert.equal(readerLink.isAvailable(), false);
    await assert.rejects(() => readerLink.join({ ssid: SSID }), /Rebuild and reinstall/);
});

test('a proxy that reports no address is an error, not a silent success', async t => {
    t.after(() => __setReaderLinkNative(null));
    __setReaderLinkNative({
        join: async () => {},
        leave: async () => {},
        startProxy: async () => ({}),
        stopProxy: async () => {},
        addListener: () => ({ remove() {} }),
    });
    await assert.rejects(
        () => readerLink.startProxy(buildProxyOptions(BASE).options),
        /no address to listen on/
    );
});

// ---------------------------------------------------------------------------
// Reducer — the happy path and the states it promises
// ---------------------------------------------------------------------------

test('start → searching, with the counters reset', () => {
    const started = reduceSyncSession(
        { ...initialSyncSession(), requests: 9, bytes: 1234, error: 'stale' },
        { type: 'start', at: T0, ssid: SSID }
    );
    assert.equal(started.state, 'searching');
    assert.equal(started.ssid, SSID);
    assert.equal(started.startedAt, T0);
    assert.equal(started.requests, 0);
    assert.equal(started.bytes, 0);
    assert.equal(started.error, null);
    assert.equal(started.reason, null);
    assert.equal(isSyncSessionActive(started.state), true);
});

test("a 'joining' link event is progress, not a state change", () => {
    const started = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    const next = reduceSyncSession(started, { type: 'link', at: T0 + 500, event: link('joining') });
    // 'searching' already means "request outstanding, not associated" — including
    // sitting behind the system's join-approval dialog.
    assert.equal(next.state, 'searching');
    assert.equal(next.lastProgressAt, T0 + 500);
});

test('joined → joining, listening → proxying, and activity accumulates', () => {
    let s = proxyingSession();
    assert.equal(s.state, 'proxying');
    assert.equal(s.peerIpv4, PEER_IP);
    assert.equal(s.proxyPort, PROXY_DEFAULT_PORT);

    s = reduceSyncSession(s, { type: 'activity', at: T0 + 2000, event: activity({ bytes: 12 }) });
    s = reduceSyncSession(s, {
        type: 'activity',
        at: T0 + 3000,
        event: activity({ path: '/m/box/books/abc', bytes: 4096, status: 206, range: 'bytes=0-4095' }),
    });
    assert.equal(s.requests, 2);
    assert.equal(s.bytes, 4108);
    assert.equal(s.lastPath, '/m/box/books/abc');
    assert.equal(s.lastProgressAt, T0 + 3000);
});

test('a re-association mid-proxy does not walk the state backwards', () => {
    // The platform re-fires onAvailable on a re-associate. Dropping back to
    // `joining` would restart the forwarder on a port it already holds.
    const s = proxyingSession();
    const next = reduceSyncSession(s, {
        type: 'link',
        at: T0 + 9000,
        event: link('joined', { ipv4: PEER_IP }),
    });
    assert.equal(next.state, 'proxying');
    assert.equal(next.lastProgressAt, T0 + 9000);
});

test('activity outside `proxying` is ignored', () => {
    const started = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    const next = reduceSyncSession(started, { type: 'activity', at: T0 + 1, event: activity() });
    assert.equal(next.requests, 0);
});

// ---------------------------------------------------------------------------
// Reducer — the ends
// ---------------------------------------------------------------------------

test('AP LOST MID-PROXY is the ordinary end of a good session', () => {
    // The reader tears its AP down when it is finished. If this were an error the
    // user would be told that the thing that just worked had failed.
    const s = reduceSyncSession(proxyingSession(), {
        type: 'activity',
        at: T0 + 4000,
        event: activity({ bytes: 52272 }),
    });
    const ended = reduceSyncSession(s, { type: 'link', at: T0 + 5000, event: link('lost') });
    assert.equal(ended.state, 'ended');
    assert.equal(ended.reason, 'ap-lost');
    assert.equal(ended.error, null);
    assert.equal(ended.endedAt, T0 + 5000);
    assert.match(describeSyncSession(ended), /Served 1 request, 51 KB/);
});

test('AP lost BEFORE the proxy is up is a failure, under the same reason', () => {
    let s = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    s = reduceSyncSession(s, { type: 'link', at: T0 + 900, event: link('joined', { ipv4: PEER_IP }) });
    const failed = reduceSyncSession(s, { type: 'link', at: T0 + 1200, event: link('lost') });
    assert.equal(failed.state, 'error');
    assert.equal(failed.reason, 'ap-lost');
    assert.match(failed.error, /went away before the link was ready/);
});

test("onUnavailable names the SSID it couldn't find", () => {
    const s = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    const failed = reduceSyncSession(s, { type: 'link', at: T0 + 50, event: link('unavailable') });
    assert.equal(failed.state, 'error');
    assert.equal(failed.reason, 'ap-not-found');
    assert.match(failed.error, /CrossPoint-Reader/);
});

test('a proxy that cannot run is an error; a proxy that merely stops is not', () => {
    const failed = reduceSyncSession(proxyingSession(), {
        type: 'proxy',
        at: T0 + 2000,
        event: proxy('error', { error: 'Address already in use' }),
    });
    assert.equal(failed.state, 'error');
    assert.equal(failed.reason, 'proxy-failed');
    assert.equal(failed.error, 'Address already in use');

    const stopped = reduceSyncSession(proxyingSession(), {
        type: 'proxy',
        at: T0 + 2000,
        event: proxy('stopped'),
    });
    assert.equal(stopped.state, 'ended');
    // NOT reported as 'ap-lost': the socket closing and the AP going away are
    // different facts, and the AP's own 'lost' usually follows this one.
    assert.equal(stopped.reason, 'proxy-stopped');
});

test('USER STOP wins over everything that arrives after it', () => {
    const stopped = reduceSyncSession(proxyingSession(), { type: 'stop', at: T0 + 4000 });
    assert.equal(stopped.state, 'ended');
    assert.equal(stopped.reason, 'user-stop');

    // `leave()` produces `released`, and a `lost` can race a stop. The FIRST end
    // wins — otherwise the line would blame the reader for what the user did.
    for (const event of [link('released'), link('lost'), proxy('error', { error: 'boom' })]) {
        const after = reduceSyncSession(stopped, { type: 'link', at: T0 + 4500, event });
        assert.equal(after, stopped, 'a finished session must be immutable');
    }
    const afterActivity = reduceSyncSession(stopped, {
        type: 'activity',
        at: T0 + 4600,
        event: activity(),
    });
    assert.equal(afterActivity.requests, 0);
});

test('a finished session cannot be resurrected by anything but `start`', () => {
    const stopped = reduceSyncSession(proxyingSession(), { type: 'stop', at: T0 + 100 });
    for (const action of [
        { type: 'link', at: T0 + 200, event: link('joined', { ipv4: PEER_IP }) },
        { type: 'proxy', at: T0 + 200, event: proxy('listening', { port: 8080 }) },
        { type: 'tick', at: T0 + 10 * 60_000 },
        { type: 'fail', at: T0 + 200, reason: 'proxy-failed', error: 'x' },
        { type: 'stop', at: T0 + 300 },
    ]) {
        assert.equal(reduceSyncSession(stopped, action), stopped, `${action.type} must be ignored`);
    }
    const restarted = reduceSyncSession(stopped, { type: 'start', at: T0 + 400, ssid: SSID });
    assert.equal(restarted.state, 'searching');
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

test('a link that never comes up times out, and says what to do', () => {
    const s = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    assert.equal(tickSyncSession(s, T0 + DEFAULT_SYNC_TIMEOUTS.linkMs - 1), s, 'not yet');
    const timedOut = tickSyncSession(s, T0 + DEFAULT_SYNC_TIMEOUTS.linkMs);
    assert.equal(timedOut.state, 'error');
    assert.equal(timedOut.reason, 'link-timeout');
    assert.match(timedOut.error, /CrossPoint-Reader/);
});

test('the link deadline does not apply once the proxy is up', () => {
    // A book download can outlast the join budget; measuring it from `startedAt`
    // would kill a healthy transfer.
    const s = proxyingSession();
    const later = tickSyncSession(
        { ...s, lastProgressAt: T0 + DEFAULT_SYNC_TIMEOUTS.linkMs },
        T0 + DEFAULT_SYNC_TIMEOUTS.linkMs + 5000
    );
    assert.equal(later.state, 'proxying');
});

test('a quiet reader closes the link, measured from the last request', () => {
    const s = proxyingSession();
    const busy = reduceSyncSession(s, {
        type: 'activity',
        at: T0 + 60_000,
        event: activity({ bytes: 4096 }),
    });
    // Activity resets the clock: an in-flight download stays alive.
    assert.equal(
        tickSyncSession(busy, T0 + 60_000 + DEFAULT_SYNC_TIMEOUTS.idleMs - 1).state,
        'proxying'
    );
    const quiet = tickSyncSession(busy, T0 + 60_000 + DEFAULT_SYNC_TIMEOUTS.idleMs);
    assert.equal(quiet.state, 'ended');
    assert.equal(quiet.reason, 'reader-quiet');
});

test('the absolute cap wins over a session that still looks busy', () => {
    const s = proxyingSession();
    const busy = { ...s, lastProgressAt: T0 + DEFAULT_SYNC_TIMEOUTS.sessionMs };
    const capped = tickSyncSession(busy, T0 + DEFAULT_SYNC_TIMEOUTS.sessionMs);
    assert.equal(capped.state, 'ended');
    assert.equal(capped.reason, 'session-cap');
});

test('ticking an inactive session is a no-op', () => {
    const idle = initialSyncSession();
    assert.equal(tickSyncSession(idle, T0 + 10 ** 9), idle);
});

test('custom budgets are honoured', () => {
    const s = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    const timedOut = tickSyncSession(s, T0 + 1000, { linkMs: 1000, idleMs: 5000, sessionMs: 60_000 });
    assert.equal(timedOut.reason, 'link-timeout');
});

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

test('the status line says what is true right now, and never claims delivery', () => {
    assert.equal(describeSyncSession(initialSyncSession()), 'Not syncing.');

    const searching = reduceSyncSession(initialSyncSession(), {
        type: 'start',
        at: T0,
        ssid: SSID,
    });
    assert.match(describeSyncSession(searching), /Looking for CrossPoint-Reader/);

    const joining = reduceSyncSession(searching, {
        type: 'link',
        at: T0 + 1,
        event: link('joined', { ipv4: PEER_IP }),
    });
    assert.match(describeSyncSession(joining), /Joined CrossPoint-Reader/);

    const ready = proxyingSession();
    // Nothing pulled yet: "Ready", not "serving".
    assert.match(describeSyncSession(ready), /^Ready at 192\.168\.4\.2:8080/);

    const serving = reduceSyncSession(ready, {
        type: 'activity',
        at: T0 + 2000,
        event: activity({ bytes: 2 * 1024 * 1024 }),
    });
    const line = describeSyncSession(serving);
    assert.match(line, /Serving the mailbox to the reader at 192\.168\.4\.2:8080/);
    assert.match(line, /1 request, 2\.0 MB/);
    // No ack exists anywhere in this contract, so the line reports what went OUT.
    assert.equal(/deliver|received|on the reader now/i.test(line), false);
});

test('an end with nothing served explains itself rather than claiming success', () => {
    const empty = reduceSyncSession(proxyingSession(), {
        type: 'link',
        at: T0 + 2000,
        event: link('lost'),
    });
    assert.match(describeSyncSession(empty), /before it pulled anything/);

    const quiet = tickSyncSession(proxyingSession(), T0 + 1500 + DEFAULT_SYNC_TIMEOUTS.idleMs);
    assert.match(describeSyncSession(quiet), /never pulled anything/);
});

test('an error renders its own sentence', () => {
    const failed = reduceSyncSession(proxyingSession(), {
        type: 'proxy',
        at: T0 + 10,
        event: proxy('error', { error: 'Permission denied binding 8080' }),
    });
    assert.equal(describeSyncSession(failed), 'Permission denied binding 8080');
});

test('a native-only end reason reaches the user instead of the generic copy', () => {
    // The module's own session cap is the backstop that fires when this screen is
    // unmounted and NOTHING is ticking the state machine, so its message is the
    // only account of why the session ended that exists. It rides the proxy
    // `stopped` event because the dedicated onSessionEnd always arrives after it and
    // first-end-wins would discard it.
    const capped = reduceSyncSession(proxyingSession(), {
        type: 'proxy',
        at: T0 + 60_000,
        event: proxy('stopped', { error: 'the 15 minute session cap expired' }),
    });
    assert.equal(capped.state, 'ended');
    assert.equal(capped.reason, 'proxy-stopped');
    assert.equal(capped.error, 'the 15 minute session cap expired');
    const line = describeSyncSession(capped);
    // Capitalised and punctuated, not rewritten — and NOT the generic
    // "Reader finished and closed its WiFi", which would be an outright wrong story.
    assert.equal(line, 'The 15 minute session cap expired.');
    assert.equal(/finished and closed/.test(line), false);
});

test('a native end reason still reports what was served', () => {
    const served = reduceSyncSession(proxyingSession(), {
        type: 'activity',
        at: T0 + 2000,
        event: activity({ bytes: 52272 }),
    });
    const capped = reduceSyncSession(served, {
        type: 'proxy',
        at: T0 + 3000,
        event: proxy('stopped', { error: 'the reader link was lost' }),
    });
    assert.equal(describeSyncSession(capped), 'The reader link was lost. Served 1 request, 51 KB.');
});

test('an ordinary proxy stop with NO reason keeps the friendly copy', () => {
    // Native clears its stale lastError on a clean stop, so this is the normal
    // shape and it must not regress into engineer-speak.
    const stopped = reduceSyncSession(proxyingSession(), {
        type: 'proxy',
        at: T0 + 3000,
        event: proxy('stopped'),
    });
    assert.equal(stopped.error, null);
    assert.match(describeSyncSession(stopped), /before it pulled anything/);
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

test('a build with no native module says REBUILD, and touches no radio', async () => {
    const h = harness({ available: false });
    await h.controller.start({ ssid: SSID, passphrase: '', mailboxUrl: BASE });

    assert.equal(h.state(), 'error');
    assert.equal(h.session().reason, 'native-missing');
    assert.equal(h.session().error, READER_LINK_UNAVAILABLE);
    assert.match(describeSyncSession(h.session()), /Rebuild and reinstall/);
    // Not even a subscribe: nothing to subscribe to.
    assert.deepEqual(h.link.names(), []);
});

test('an unusable mailbox URL is refused BEFORE the AP is joined', async () => {
    // Joining costs the user a system dialog and their WiFi association; doing it
    // and then discovering there is nothing to forward to is the worst order.
    const h = harness();
    await h.controller.start({ ssid: SSID, mailboxUrl: '' });

    assert.equal(h.state(), 'error');
    assert.equal(h.session().reason, 'not-configured');
    assert.deepEqual(h.link.names(), []);
});

test('the happy path: join → joined → startProxy → listening → served', async () => {
    const h = harness();
    const seen = [];
    h.controller.subscribe(s => seen.push(s.state));

    await h.controller.start({ ssid: SSID, passphrase: 'hunter22', mailboxUrl: BASE });
    assert.equal(h.state(), 'searching');
    // Subscribed BEFORE join, so an immediate onAvailable cannot be missed.
    assert.deepEqual(h.link.names(), ['subscribe', 'join']);
    assert.deepEqual(h.link.args('join')[0], {
        ssid: SSID,
        passphrase: 'hunter22',
        // SHORTER than this session's own link deadline on purpose — see the
        // dedicated test below.
        timeoutMs: nativeJoinTimeoutMs(DEFAULT_SYNC_TIMEOUTS.linkMs),
    });

    h.advance(2000);
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    assert.equal(h.state(), 'joining');
    await flush();

    assert.equal(h.state(), 'proxying');
    const proxyArgs = h.link.args('startProxy')[0];
    assert.equal(proxyArgs.mailboxOrigin, 'https://mail.example.net');
    assert.equal(proxyArgs.allowedPathPrefix, '/m/');
    assert.equal(proxyArgs.healthPath, PROXY_HEALTH_PATH);

    h.advance(1000);
    h.link.emit(activity({ bytes: 99 }));
    assert.equal(h.session().requests, 1);
    assert.equal(h.session().bytes, 99);

    assert.deepEqual(seen, ['searching', 'joining', 'proxying', 'proxying']);
});

test('NOTHING handed to the native side carries the write token', async () => {
    // The peer interface is reachable by anything that associates with an open AP,
    // and the reader only ever READS (its downloader issues GET). A token here
    // would put the app's mailbox write credential on that link.
    const h = harness();
    await h.controller.start({
        ssid: SSID,
        passphrase: 'ap-secret',
        mailboxUrl: `${BASE}`,
    });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    const serialised = JSON.stringify(h.link.args('startProxy'));
    assert.equal(serialised.includes(TOKEN), false);
    assert.equal(/token|authorization|bearer|secret/i.test(serialised), false);
    // The AP passphrase goes ONLY into the join request.
    assert.equal(serialised.includes('ap-secret'), false);
});

test('a second start replaces the first rather than stacking requests', async () => {
    const h = harness();
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();
    assert.equal(h.state(), 'proxying');

    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    await flush();
    // The live session was torn down (proxy + request released) before the new one.
    const names = h.link.names();
    assert.ok(names.indexOf('stopProxy') < names.lastIndexOf('join'));
    assert.ok(names.indexOf('leave') < names.lastIndexOf('join'));
    assert.equal(h.state(), 'searching');
    assert.equal(h.link.args('startProxy').length, 1, 'no second forwarder on the same port');
});

test('USER STOP ends the session and gives the radio back', async () => {
    const h = harness();
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    h.advance(5000);
    await h.controller.stop();

    assert.equal(h.state(), 'ended');
    assert.equal(h.session().reason, 'user-stop');
    // Both teardowns, and the listener dropped — a NetworkRequest left registered
    // keeps the phone off its own WiFi with nothing on screen to say so.
    assert.ok(h.link.names().includes('stopProxy'));
    assert.ok(h.link.names().includes('leave'));
    assert.equal(h.link.hasListener(), false);
});

test('TEARDOWN KICKS BOTH NATIVE CALLS before awaiting either', async () => {
    // THE P1 THIS SHAPE EXISTS FOR. Native serialises every entry point onto one
    // ops thread, and a join parks that thread in a wait loop that only the cancel
    // flag breaks — and only `leave()` sets it (from expo's queue, not from ops).
    // So awaiting stopProxy() FIRST could never reach leave(): the release parked
    // for the whole join budget holding the WifiNetworkSpecifier request, a second
    // Sync blocked on that release sat in `searching`, and the session died with a
    // bogus link-timeout ~92 s later. In watcher mode (timeoutMs 0) it never
    // returned at all and the peer request was held indefinitely.
    let releaseStop = null;
    const gate = new Promise(resolve => {
        releaseStop = resolve;
    });
    const h = harness({ stopProxyGate: gate });
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    const stopping = h.controller.stop();
    await flush();

    // The state is already correct, and leave() has ALREADY been called even though
    // stopProxy has not resolved.
    assert.equal(h.state(), 'ended');
    assert.ok(h.link.names().includes('stopProxy'));
    assert.ok(
        h.link.names().includes('leave'),
        'leave() must not wait behind an unresolved stopProxy — that is the deadlock'
    );
    releaseStop();
    await stopping;
});

test('a native call that throws SYNCHRONOUSLY still gives the radio back', async () => {
    // A drifted/missing native method rejects like this, and stop() awaits the
    // release: an unhandled throw there would strand the panic button.
    const h = harness({ stopProxyThrowsSync: true });
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    await h.controller.stop();
    assert.equal(h.state(), 'ended');
    assert.ok(h.link.names().includes('leave'), 'the request must still be released');
    assert.equal(h.link.hasListener(), false);
});

test('AP LOST MID-PROXY releases the radio without the user doing anything', async () => {
    const h = harness();
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();
    h.link.emit(activity({ bytes: 52272 }));

    h.advance(1000);
    h.link.emit(link('lost'));
    assert.equal(h.state(), 'ended');
    assert.equal(h.session().reason, 'ap-lost');

    await flush();
    assert.ok(h.link.names().includes('leave'), 'the request must be released');
    assert.equal(h.link.hasListener(), false);
});

test('a deadline that fires also releases the radio', async () => {
    const h = harness({}, { linkMs: 1000, idleMs: 5000, sessionMs: 60_000 });
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });

    h.advance(1000);
    h.controller.tick();
    assert.equal(h.state(), 'error');
    assert.equal(h.session().reason, 'link-timeout');

    await flush();
    assert.ok(h.link.names().includes('leave'));
    assert.equal(h.link.hasListener(), false);
});

test('a restart waits out the previous session\'s teardown before joining', async () => {
    // The old session's release ends in leave(); if it landed AFTER the new join,
    // it would unregister the new request and the session would sit in `searching`
    // until the link deadline, with nothing to explain it.
    const h = harness();
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    // The reader closes its AP: the session ends and releases WITHOUT being awaited.
    h.link.emit(link('lost'));
    assert.equal(h.state(), 'ended');

    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    const names = h.link.names();
    // The second join is the LAST call: every teardown of the first session
    // happened before it.
    assert.equal(names[names.length - 1], 'join');
    assert.equal(names.lastIndexOf('leave') < names.lastIndexOf('join'), true);
    assert.equal(h.state(), 'searching');
});

test('a join that is refused outright reports itself', async () => {
    const h = harness({ joinError: new Error('User rejected the network request') });
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    assert.equal(h.state(), 'error');
    assert.equal(h.session().reason, 'join-failed');
    assert.equal(h.session().error, 'User rejected the network request');
    // A rejecting join may still have registered the request, so this path
    // releases too — unlike the pre-flight refusals above, which never asked.
    await flush();
    assert.ok(h.link.names().includes('leave'));
});

test('a join that fails because the native SURFACE drifted says rebuild, not "move closer"', async () => {
    // isAvailable() said yes, so this is the module resolving but its functions
    // not matching — a Kotlin/JS naming drift. "Couldn't join, try again nearer
    // the reader" would be advice the user can never act on.
    const drift = Object.assign(new Error(READER_LINK_UNAVAILABLE), {
        name: 'ReaderLinkUnavailableError',
    });
    const h = harness({ joinError: drift });
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    assert.equal(h.session().reason, 'native-missing');
    assert.match(describeSyncSession(h.session()), /Rebuild and reinstall/);
});

test('a proxy that cannot bind reports itself and ends the session', async () => {
    const h = harness({ startProxyError: new Error('bind failed: EADDRINUSE') });
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    assert.equal(h.state(), 'error');
    assert.equal(h.session().reason, 'proxy-failed');
    assert.equal(h.session().error, 'bind failed: EADDRINUSE');
    await flush();
    assert.ok(h.link.names().includes('leave'));
});

test('a LATE startProxy from a stopped session cannot resurrect it', async () => {
    // The Stop-then-Sync race: without an epoch check the old promise reports
    // into whatever session is current and the user is shown a failure that
    // belongs to a session they already ended.
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const h = harness({ startProxyGate: gate });

    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();
    assert.equal(h.state(), 'joining', 'startProxy is still in flight');

    await h.controller.stop();
    assert.equal(h.session().reason, 'user-stop');

    release();
    await flush();
    await flush();
    assert.equal(h.state(), 'ended');
    assert.equal(h.session().reason, 'user-stop');
});

test('stop() is safe when nothing is running, and still releases', async () => {
    const h = harness();
    await h.controller.stop();
    assert.equal(h.state(), 'idle');
    // Deliberate: this is the panic button, and "the state says idle but the
    // request is still registered" is exactly what it exists to fix.
    assert.ok(h.link.names().includes('leave'));
});

test('unsubscribing a listener stops delivery, and dispose() tears everything down', async () => {
    const h = harness();
    const seen = [];
    const off = h.controller.subscribe(s => seen.push(s.state));
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    off();
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();
    assert.deepEqual(seen, ['searching']);

    await h.controller.dispose();
    assert.equal(h.link.hasListener(), false);
});

// ---------------------------------------------------------------------------
// Settings compatibility
// ---------------------------------------------------------------------------

test('readerApPsk defaults to empty — the OPEN AP the firmware ships', () => {
    assert.equal(DEFAULTS.readerApPsk, '');
    // The SSID default has to keep matching the firmware constant, since the join
    // request matches on it exactly.
    assert.equal(DEFAULTS.apSsid, 'CrossPoint-Reader');
});

test('a blob written before readerApPsk existed still loads', () => {
    // The persisted settings blob is UNVERSIONED with no migration hook, so this
    // is the shape every existing install hands back.
    const old = { ...DEFAULTS };
    delete old.readerApPsk;
    const normalized = normalizeSettings(old);
    assert.equal(normalized.readerApPsk, '');
    // And nothing else moved.
    assert.equal(normalized.apSsid, DEFAULTS.apSsid);
    assert.equal(normalized.mailboxUrl, '');
});

test('an unreadable readerApPsk coerces instead of throwing', () => {
    // getSettings() swallows a throw into a DEFAULTS fallback, i.e. the user's
    // whole configuration silently resets. Every field with a coercion exists to
    // stop that; a hand-edited or truncated blob can hold any of these.
    for (const bad of [42, null, undefined, {}, [], true]) {
        const normalized = normalizeSettings({ ...DEFAULTS, readerApPsk: bad });
        assert.equal(normalized.readerApPsk, '', `for ${JSON.stringify(bad) ?? String(bad)}`);
    }
});

test('a pasted passphrase is trimmed, and an empty one is left empty', () => {
    // A trailing newline off a clipboard would otherwise travel into the WPA2
    // join and come back as an unexplainable "cannot connect".
    assert.equal(normalizeSettings({ ...DEFAULTS, readerApPsk: '  s3cret \n' }).readerApPsk, 's3cret');
    // '' is MEANINGFUL (open AP), so there is deliberately no default fallback.
    assert.equal(normalizeSettings({ ...DEFAULTS, readerApPsk: '   ' }).readerApPsk, '');
});

test('unknown keys from older installs still ride through untouched', () => {
    const withLegacy = { ...DEFAULTS, firmwareType: 'crosspoint', stockIp: '10.0.0.2' };
    const normalized = normalizeSettings(withLegacy);
    assert.equal(normalized.firmwareType, 'crosspoint');
    assert.equal(normalized.stockIp, '10.0.0.2');
});

// ---------------------------------------------------------------------------
// DELIVERY — the only receipt this protocol has, and the three channels it rides
//
// The mailbox contract has no acks (§1) and the reader reports nothing, so "the
// last byte of item X left this process" is as close to a confirmation as the
// system gets — and it exists ONLY on the local-serve path, where the phone owns
// both ends of the socket. It is what marks an outbox item delivered (and prunes
// its bytes off the phone) and what flips a History row to "Delivered directly".
//
// It broke exactly once and completely silently: Kotlin spelled the fields
// `localId` / `localComplete` on the activity map, this half read `itemId` /
// `complete`, both coerced to null, and NOTHING was ever marked delivered — for
// the whole life of the queue, with tsc clean and every test green, because
// every test drove this side with JS-shaped payloads. So these tests use the
// NATIVE spellings, and `scripts/reader-link-contract.test.js` greps the Kotlin
// to hold them there.
// ---------------------------------------------------------------------------

const NOTE_ID = '01jq8zk4t2-note';
const BOOK_ID = 'bk-01jq8zj9xa';

/**
 * An activity event as the NATIVE side actually produces it, put through the real
 * coercion. Reducer tests take the coerced shape, so driving them through
 * `coerceReaderLinkEvent` is what makes the field NAMES load-bearing here rather
 * than only in the coercion tests: the drift that broke delivery was invisible
 * precisely because every test hand-wrote the JS shape.
 */
const nativeActivity = (extra = {}) =>
    coerceReaderLinkEvent('activity', {
        method: 'GET',
        path: '/m/box/current.frame',
        status: 200,
        ...extra,
    });

/** Same, for the proxy channel. */
const nativeProxy = (state, extra = {}) => coerceReaderLinkEvent('proxy', { state, ...extra });

test('the activity event carries a delivery under the NATIVE field names', () => {
    // MailboxProxyServer's own map literal, verbatim.
    const event = coerceReaderLinkEvent('activity', {
        method: 'GET',
        path: '/m/box/current.frame',
        status: 200,
        bytes: 52272,
        source: 'local',
        localId: NOTE_ID,
        localComplete: true,
    });
    assert.equal(event.itemId, NOTE_ID);
    assert.equal(event.complete, true);
    assert.equal(event.source, 'local');
});

test('the JS spellings still win when a build sends both', () => {
    // Belt and braces for a future native rename that adds the canonical name
    // alongside the old one: the explicit `itemId`/`complete` are preferred.
    const event = coerceReaderLinkEvent('activity', {
        itemId: NOTE_ID,
        localId: 'stale',
        complete: true,
        localComplete: false,
    });
    assert.equal(event.itemId, NOTE_ID);
    assert.equal(event.complete, true);
});

test('onLocalDelivery becomes its own kind, not a second activity', () => {
    // Native emits BOTH for one response. Folding this into `activity` would
    // count the request twice and add the body's bytes to the session total a
    // second time, so it gets its own discriminant and its own reducer case.
    const event = coerceReaderLinkEvent('delivery', {
        id: BOOK_ID,
        kind: 'book',
        filename: 'Piranesi.epub',
        bytes: 402118,
        servedBytes: 4096,
        partial: true,
        complete: false,
    });
    assert.deepEqual(event, {
        kind: 'delivery',
        itemId: BOOK_ID,
        complete: false,
        source: 'local',
        bytes: 4096,
        filename: 'Piranesi.epub',
    });
});

test('a delivery event naming nothing is DROPPED', () => {
    // Marking delivered deletes bytes off the phone. An event with no id names
    // no item, so there is nothing it could honestly claim.
    assert.equal(coerceReaderLinkEvent('delivery', { complete: true }), null);
    assert.equal(coerceReaderLinkEvent('delivery', { id: '', complete: true }), null);
    // And `complete` is only ever an explicit boolean true — a stray 1/'true'
    // out of an untyped bridge means "no claim".
    assert.equal(coerceReaderLinkEvent('delivery', { id: NOTE_ID, complete: 1 }).complete, false);
});

test('a proxy event with no local keys is byte-identical to the old shape', () => {
    // The absences are the contract: `scripts/sync-session.test.js` asserts this
    // object key-for-key elsewhere, and a build predating local serve must
    // produce exactly what it always did.
    assert.deepEqual(coerceReaderLinkEvent('proxy', { state: 'stopped' }), {
        kind: 'proxy',
        state: 'stopped',
        ipv4: null,
        port: null,
        error: null,
    });
});

test('the stopped event carries the reconcile ids and the start counts', () => {
    const stopped = coerceReaderLinkEvent('proxy', {
        state: 'stopped',
        localDeliveredIds: [NOTE_ID, '', 7, BOOK_ID],
        localDelivered: 2,
    });
    // Junk entries are filtered rather than dropping the whole list: the list is
    // the recovery path for a delivery event lost to a reload.
    assert.deepEqual(stopped.localDeliveredIds, [NOTE_ID, BOOK_ID]);
    const listening = coerceReaderLinkEvent('proxy', {
        state: 'listening',
        localItems: 3,
        localSkipped: 1,
    });
    assert.equal(listening.localItems, 3);
    assert.equal(listening.localSkipped, 1);
});

test('a complete LOCAL activity marks the item delivered, once', () => {
    let s = proxyingSession();
    const served = nativeActivity({
        source: 'local',
        localId: NOTE_ID,
        localComplete: true,
        bytes: 52272,
    });
    s = reduceSyncSession(s, { type: 'activity', at: T0 + 2000, event: served });
    assert.deepEqual(s.delivered, [NOTE_ID]);
    assert.equal(s.localServed, 1);
    // A re-serve inside the same session (the reader re-pulled) must not record
    // it twice — the count is rendered as "handed over N items".
    s = reduceSyncSession(s, { type: 'activity', at: T0 + 3000, event: served });
    assert.deepEqual(s.delivered, [NOTE_ID]);
    assert.equal(s.requests, 2);
});

test('an UPSTREAM answer never marks anything delivered', () => {
    // Only the local path owns both ends of the socket. A forwarded 200 says
    // nothing about the reader having taken the body whole.
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'activity',
        at: T0 + 2000,
        event: nativeActivity({ source: 'upstream', localId: NOTE_ID, localComplete: true }),
    });
    assert.deepEqual(s.delivered, []);
});

test('a PARTIAL window records nothing — a book crosses several', () => {
    let s = proxyingSession();
    for (const [at, complete] of [[2000, false], [3000, false]]) {
        s = reduceSyncSession(s, {
            type: 'delivery',
            at: T0 + at,
            event: { kind: 'delivery', itemId: BOOK_ID, complete, source: 'local' },
        });
    }
    assert.deepEqual(s.delivered, []);
    s = reduceSyncSession(s, {
        type: 'delivery',
        at: T0 + 4000,
        event: { kind: 'delivery', itemId: BOOK_ID, complete: true, source: 'local' },
    });
    assert.deepEqual(s.delivered, [BOOK_ID]);
    // The receipt is NOT traffic: it must not be counted as another request or
    // another byte, because native emits it alongside the activity event.
    assert.equal(s.requests, 0);
    assert.equal(s.bytes, 0);
});

test('the stopped event RECONCILES a delivery whose event was lost', () => {
    // expo POSTS events to the JS thread, so a reload between the last byte and
    // the callback loses the per-response event. Native keeps the id set for the
    // whole session and puts it on the one event the JS session cannot miss.
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'proxy',
        at: T0 + 5000,
        event: nativeProxy('stopped', { localDeliveredIds: [NOTE_ID, BOOK_ID] }),
    });
    assert.equal(s.state, 'ended');
    assert.deepEqual(s.delivered, [NOTE_ID, BOOK_ID]);
});

test('the reconcile does not double-count what was already recorded', () => {
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'activity',
        at: T0 + 2000,
        event: nativeActivity({ source: 'local', localId: NOTE_ID, localComplete: true }),
    });
    s = reduceSyncSession(s, {
        type: 'proxy',
        at: T0 + 5000,
        event: nativeProxy('stopped', { localDeliveredIds: [NOTE_ID, BOOK_ID] }),
    });
    assert.deepEqual(s.delivered, [NOTE_ID, BOOK_ID]);
});

test('a confirmed handover reaches the outbox AND History', async () => {
    // THE WHOLE POINT: without this the item is never pruned and the History row
    // never says "Delivered directly", which is what the field-name drift cost.
    const ports = fakePorts();
    const h = harness({}, undefined, ports);
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    h.link.emit(
        nativeActivity({ source: 'local', localId: NOTE_ID, localComplete: true, bytes: 52272 })
    );
    await flush();
    assert.deepEqual(ports.markedDelivered, [NOTE_ID]);
    assert.deepEqual(ports.historyPatched, [NOTE_ID]);

    // And the precise channel does the same thing for a book, without adding a
    // second request to the counters.
    const before = h.session().requests;
    h.link.emit({ kind: 'delivery', itemId: BOOK_ID, complete: true, source: 'local' });
    await flush();
    assert.deepEqual(ports.markedDelivered, [NOTE_ID, BOOK_ID]);
    assert.equal(h.session().requests, before);
});

test('a delivery reconciled at session end is still persisted', async () => {
    const ports = fakePorts();
    const h = harness({}, undefined, ports);
    await h.controller.start({ ssid: SSID, mailboxUrl: BASE });
    h.link.emit(link('joined', { ipv4: PEER_IP }));
    await flush();

    h.link.emit(nativeProxy('stopped', { localDeliveredIds: [BOOK_ID] }));
    await flush();
    assert.equal(h.state(), 'ended');
    assert.deepEqual(ports.markedDelivered, [BOOK_ID]);
});

test('the status line says what was handed over, and what could not be', () => {
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'activity',
        at: T0 + 2000,
        event: nativeActivity({ source: 'local', localId: NOTE_ID, localComplete: true, bytes: 52272 }),
    });
    s = reduceSyncSession(s, { type: 'stop', at: T0 + 3000 });
    assert.match(describeSyncSession(s), /Handed over 1 item straight from this phone/);

    // A queued item native REFUSED is otherwise silent on every surface: the JS
    // queue accepted it, the manifest lists it, the user was told "ready to hand
    // over", and the reader is never offered it.
    let listening = reduceSyncSession(initialSyncSession(), { type: 'start', at: T0, ssid: SSID });
    listening = reduceSyncSession(listening, {
        type: 'link',
        at: T0 + 1,
        event: link('joined', { ipv4: PEER_IP }),
    });
    listening = reduceSyncSession(listening, {
        type: 'proxy',
        at: T0 + 2,
        event: nativeProxy('listening', {
            ipv4: PEER_IP,
            port: PROXY_DEFAULT_PORT,
            localItems: 2,
            localSkipped: 1,
        }),
    });
    assert.equal(listening.localItems, 2);
    assert.match(describeSyncSession(listening), /1 queued item can't be handed over/);
});

// ---------------------------------------------------------------------------
// AN UPSTREAM THAT IS HELD AND DEAD — the failure that had no name anywhere
//
// A whole session ran with the reader pulling happily off the phone and NOT ONE
// request reaching the mailbox, and every surface in the app said encouraging
// things throughout. Two facts crossed the bridge and were thrown away at the
// reducer (`upstreamOk`, `error` on the mode event), and a third was computed
// rather than observed on the native side (`upstreamOk = mode != 'local'`, which
// is true by definition whenever anything is queued). These tests pin the fixed
// versions of all three.
// ---------------------------------------------------------------------------

/** A mode event as the NATIVE side produces it, through the real coercion. */
const nativeMode = (extra = {}) => coerceReaderLinkEvent('mode', { localItems: 2, ...extra });

test('the mode event carries upstream reachability, and the reducer KEEPS it', () => {
    // Both fields already crossed the JSI boundary before this fix; the reducer
    // destructured `mode` and `localItems` and dropped the rest on the floor.
    const event = nativeMode({
        mode: 'merged',
        upstreamOk: false,
        error: "couldn't reach the mailbox: failed to connect",
    });
    assert.equal(event.upstreamOk, false);
    assert.equal(event.error, "couldn't reach the mailbox: failed to connect");

    let s = proxyingSession();
    s = reduceSyncSession(s, { type: 'mode', at: T0 + 2000, event });
    assert.equal(s.mode, 'merged');
    assert.equal(s.upstreamOk, false);
    assert.equal(s.upstreamError, "couldn't reach the mailbox: failed to connect");
});

test('a HELD but dead upstream says so, where it used to read as healthy', () => {
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'mode',
        at: T0 + 2000,
        event: nativeMode({ mode: 'merged', upstreamOk: false, error: 'the mailbox did not answer in time' }),
    });
    // THE CASE THAT WAS 100% INVISIBLE: mode 'merged' means an upstream network
    // is held, so the old copy claimed the mailbox was being served alongside the
    // phone while every forward was dying before a byte left.
    assert.equal(describeSyncMode(s), "Couldn't reach the mailbox — handing over queued items only.");
    // And the diagnosis rides its own line: this is the difference between
    // "turn mobile data on" and "the mailbox URL is wrong", which nothing else
    // in the app can tell the user.
    assert.equal(describeUpstreamProblem(s), 'The mailbox did not answer in time.');
});

test('local + no route names what will NOT arrive, not just what will', () => {
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'mode',
        at: T0 + 2000,
        event: nativeMode({
            mode: 'local',
            upstreamOk: false,
            error: 'no internet connection on this phone to reach the mailbox with',
        }),
    });
    assert.match(describeSyncMode(s), /^No internet through the phone/);
    assert.match(describeSyncMode(s), /mailbox will not arrive/);
});

test('the claim is made ONLY on an explicit false — a silent build says nothing new', () => {
    // A dev client whose Kotlin predates the flag sends no `upstreamOk` at all.
    // Guessing here would tell a user in airplane mode that their mailbox is
    // broken on the strength of a field nobody sent.
    let s = proxyingSession();
    s = reduceSyncSession(s, { type: 'mode', at: T0 + 2000, event: nativeMode({ mode: 'local' }) });
    assert.equal(s.upstreamOk, null);
    assert.equal(describeSyncMode(s), 'Serving from this phone — no internet needed.');
    assert.equal(describeUpstreamProblem(s), null);
});

test('a recovered upstream clears the reason it was unreachable', () => {
    // The whole point of retrying mid-session: the phone settles seconds AFTER
    // it gives up its WiFi association to join the reader's AP, so a session that
    // started with no route must be able to stop saying so.
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'mode',
        at: T0 + 2000,
        event: nativeMode({ mode: 'local', upstreamOk: false, error: 'no internet connection' }),
    });
    assert.equal(s.upstreamOk, false);
    s = reduceSyncSession(s, {
        type: 'mode',
        at: T0 + 3000,
        event: nativeMode({ mode: 'merged', upstreamOk: true, error: null }),
    });
    assert.equal(s.upstreamOk, true);
    assert.equal(s.upstreamError, null);
    assert.equal(describeSyncMode(s), 'Serving from this phone and the mailbox together.');
    assert.equal(describeUpstreamProblem(s), null);
});

test('nothing queued AND nothing reachable is narrated, not silent', () => {
    // 'upstream' is the mode a forward-only session reports and it needs no
    // narration — unless the mailbox is unreachable, in which case the session
    // can deliver nothing at all and saying nothing is the worst answer.
    let s = proxyingSession();
    s = reduceSyncSession(s, {
        type: 'mode',
        at: T0 + 2000,
        event: nativeMode({ mode: 'upstream', localItems: 0, upstreamOk: true }),
    });
    assert.equal(describeSyncMode(s), null);
    s = reduceSyncSession(s, {
        type: 'mode',
        at: T0 + 3000,
        event: nativeMode({ mode: 'upstream', localItems: 0, upstreamOk: false, error: 'no internet' }),
    });
    assert.match(describeSyncMode(s), /nothing is queued on this phone/);
});
