/**
 * The reader-link WIRE CONTRACT, gated across the three places it is written down.
 *
 * WHY THIS FILE EXISTS. The A3 proxy has three halves that never compile together:
 * the app's TS (`src/services/reader_link.ts`), the app's Kotlin
 * (`modules/reader-link/android/.../*.kt`, built in a separate pass that this repo's
 * gate deliberately does not run), and the FIRMWARE, which lives in another repo
 * and is being built in parallel. A disagreement between any two of them produces
 * no error anywhere: the reader probes, does not recognise the answer, falls
 * through to "no proxy", and both sides believe they are correct. The health body
 * is the sharpest case — 11 bytes that must match byte-for-byte.
 *
 * So the authority is `docs/xteink/mailbox-books-contract.md`'s "A3 canonical wire
 * block", and this test PARSES that block out of the doc and compares it against
 * the Kotlin literals and the TS constants. The doc stops being prose and becomes
 * an artifact that can fail a build, which is the only kind of authority worth
 * having.
 *
 * IT ALSO READS THE KOTLIN — on purpose, and that is the second thing it pins.
 * `scripts/ci-remote.sh` used to rsync with an UNANCHORED `--exclude android/`,
 * which silently dropped `modules/reader-link/android/**` from the tree the CI host
 * sees. A grep-based Kotlin check under that exclude passes by seeing zero files;
 * these tests fail loudly instead (`readSource` throws rather than skipping), so the
 * exclude cannot regress without reddening a gate.
 *
 * Run:  node --import tsx --test scripts/reader-link-contract.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    PROXY_DEFAULT_PORT,
    PROXY_HEALTH_PATH,
    PROXY_SESSION_MAX_MS,
    buildProxyOptions,
    describeProxyTarget,
} from '../src/services/reader_link';
import {
    WIFI_PSK_MAX_CHARS,
    WIFI_PSK_MIN_CHARS,
    WIFI_SSID_MAX_BYTES,
    serializeWifiCredential,
} from '../src/services/wifi_share';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const KOTLIN_DIR = join(REPO, 'modules/reader-link/android/src/main/java/expo/modules/readerlink');
const CONTRACT_DOC = join(REPO, 'docs/xteink/mailbox-books-contract.md');
const MODULE_MANIFEST = join(REPO, 'modules/reader-link/android/src/main/AndroidManifest.xml');
const MODULE_INDEX = join(REPO, 'modules/reader-link/index.ts');

/**
 * Reads a file that MUST be present. A missing one is a failure, never a skip:
 * "the Kotlin was not in the tree" is exactly the silent hole this file closes.
 */
function readSource(path) {
    try {
        return readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(
            `${path} is not readable (${error.code ?? error.message}). If this is the CI host, ` +
                'check that scripts/ci-remote.sh still anchors its android/ exclude with a leading ' +
                'slash — an unanchored pattern drops modules/*/android/** from the synced tree.'
        );
    }
}

/** Kotlin (and the doc block) write escapes the same way; only these four occur. */
function unescapeLiteral(raw) {
    return raw.replace(/\\(.)/g, (_, c) => {
        if (c === 'n') return '\n';
        if (c === 'r') return '\r';
        if (c === 't') return '\t';
        return c; // \\ and \"
    });
}

/**
 * Evaluates the arithmetic Kotlin uses for millisecond constants (`30 * 60 * 1000`)
 * without handing the source to `eval`. Only digits, `*`, `+`, `_` separators and a
 * trailing `L` are accepted; anything else is a parse failure, not a guess.
 */
function evalIntExpression(text) {
    const cleaned = text.replace(/_/g, '').replace(/L\b/g, '').trim();
    if (!/^[\d\s*+]+$/.test(cleaned)) {
        throw new Error(`not a plain integer expression: ${JSON.stringify(text)}`);
    }
    return cleaned
        .split('+')
        .map(term =>
            term
                .split('*')
                .map(factor => Number.parseInt(factor.trim(), 10))
                .reduce((a, b) => a * b, 1)
        )
        .reduce((a, b) => a + b, 0);
}

const kotlin = {
    proxyContract: readSource(join(KOTLIN_DIR, 'ProxyContract.kt')),
    options: readSource(join(KOTLIN_DIR, 'Options.kt')),
    httpWire: readSource(join(KOTLIN_DIR, 'HttpWire.kt')),
    proxyServer: readSource(join(KOTLIN_DIR, 'MailboxProxyServer.kt')),
    session: readSource(join(KOTLIN_DIR, 'ReaderLinkSession.kt')),
    upstream: readSource(join(KOTLIN_DIR, 'UpstreamNetwork.kt')),
    peerLink: readSource(join(KOTLIN_DIR, 'PeerApLink.kt')),
    module: readSource(join(KOTLIN_DIR, 'ReaderLinkModule.kt')),
};

/** The TS half, as SOURCE — the event names and the field reads are not exported values. */
const READER_LINK_TS = readSource(join(REPO, 'src/services/reader_link.ts'));

/** `const val NAME = "…"` → the unescaped string. */
function kotlinString(name) {
    const match = new RegExp(`const val ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(
        kotlin.proxyContract
    );
    assert.ok(match, `ProxyContract.kt declares no string const ${name}`);
    return unescapeLiteral(match[1]);
}

/** `const val NAME = 30 * 60 * 1000` → the number. */
function kotlinInt(name) {
    const match = new RegExp(`const val ${name}\\s*=\\s*([0-9_ *+L]+)`).exec(kotlin.proxyContract);
    assert.ok(match, `ProxyContract.kt declares no numeric const ${name}`);
    return evalIntExpression(match[1]);
}

/**
 * The doc's canonical block, as `NAME = value` pairs. Quoted values are unescaped;
 * everything else is taken verbatim (the content type contains a `;` and a space).
 */
function docBlock() {
    const doc = readSource(CONTRACT_DOC);
    const fence = /```text\n([\s\S]*?)```/g;
    let block = null;
    for (const match of doc.matchAll(fence)) {
        if (match[1].includes('CP_PROXY_HEALTH_PATH')) {
            block = match[1];
            break;
        }
    }
    assert.ok(
        block,
        'docs/xteink/mailbox-books-contract.md has no ```text block containing CP_PROXY_HEALTH_PATH ' +
            '— the A3 canonical wire block is the authority for these values and must stay parseable.'
    );
    const values = new Map();
    for (const line of block.split('\n')) {
        const pair = /^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
        if (!pair) continue;
        const raw = pair[2];
        const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
        values.set(pair[1], quoted ? unescapeLiteral(quoted[1]) : raw);
    }
    return values;
}

const DOC = docBlock();

function doc(name) {
    assert.ok(DOC.has(name), `the A3 canonical wire block declares no ${name}`);
    return DOC.get(name);
}

// ---------------------------------------------------------------------------
// doc ⇄ Kotlin ⇄ TS
// ---------------------------------------------------------------------------

test('the health PATH agrees across the doc, the Kotlin and the TS', () => {
    assert.equal(kotlinString('HEALTH_PATH'), doc('CP_PROXY_HEALTH_PATH'));
    assert.equal(PROXY_HEALTH_PATH, doc('CP_PROXY_HEALTH_PATH'));
    // The reader probes this before it trusts anything, so it must carry no
    // capability: a probe of /m/{boxId}/… hands the whole mailbox's read
    // capability to whichever station took 192.168.4.2 on an open AP (A3).
    assert.equal(PROXY_HEALTH_PATH.includes('/m/'), false);
    assert.equal(buildProxyOptions('https://mail.example.net/m/box').options.healthPath, PROXY_HEALTH_PATH);
});

test('the health BODY agrees byte-for-byte, and satisfies the firmware match rule', () => {
    const body = kotlinString('HEALTH_BODY');
    assert.equal(body, doc('CP_PROXY_HEALTH_BODY'));
    // The byte count is stated in the doc because it is what the firmware author
    // reads; a mismatch here means one of the two was edited alone.
    assert.equal(
        Buffer.byteLength(body, 'utf8'),
        Number.parseInt(doc('CP_PROXY_HEALTH_BODY_BYTES'), 10)
    );
    // PINNED firmware rule (A3, PeerProbe.cpp): the first non-whitespace token is
    // `cp-proxy`, optionally `cp-proxy/<version>`. A body that fails this makes
    // discovery fail SILENTLY — the reader just decides there is no proxy.
    const firstToken = body.trim().split(/\s+/)[0];
    assert.match(firstToken, /^cp-proxy(\/\d+)?$/);
    assert.equal(kotlinString('HEALTH_CONTENT_TYPE'), doc('CP_PROXY_HEALTH_CONTENT_TYPE'));
});

test('the listening PORT and the forward PREFIX agree across all three', () => {
    const port = Number.parseInt(doc('CP_PROXY_PORT'), 10);
    assert.equal(kotlinInt('DEFAULT_PORT'), port);
    assert.equal(PROXY_DEFAULT_PORT, port);
    // Fixed, and >= 1024: the reader cannot be told a port (it composes
    // http://{peerIp}:{port} itself) and an app cannot bind a privileged one.
    assert.ok(port >= 1024 && port <= 65535);
    assert.equal(kotlinString('FORWARD_PREFIX'), doc('CP_PROXY_FORWARD_PREFIX'));
    assert.equal(kotlinString('READER_AP_SSID'), doc('CP_PROXY_READER_AP_SSID'));
});

test('the ONE session cap the app passes survives the native clamp', () => {
    // Two independent caps (a JS deadline and a native watchdog on a different
    // number) is how the backstop that actually fires — the one that runs when the
    // screen is unmounted and nothing ticks the state machine — ends up on a budget
    // the UI never knew about. The app now passes its own cap; if it fell outside
    // the clamp, native would silently use a different number instead.
    const min = kotlinInt('MIN_SESSION_MAX_MS');
    const max = kotlinInt('MAX_SESSION_MAX_MS');
    assert.ok(
        PROXY_SESSION_MAX_MS >= min && PROXY_SESSION_MAX_MS <= max,
        `PROXY_SESSION_MAX_MS=${PROXY_SESSION_MAX_MS} is outside the native clamp ${min}..${max}`
    );
    assert.equal(
        buildProxyOptions('https://mail.example.net/m/box').options.sessionMaxMs,
        PROXY_SESSION_MAX_MS
    );
});

test('the module JS entry re-declares NO wire constant', () => {
    // It is not imported by the app (src/services/reader_link.ts resolves the
    // native module by name so the JS half keeps working without the Kotlin), so a
    // constant here is a THIRD copy that no test and no compile step can hold to
    // the other two — which is how `cp-proxy 1\n` and `cp-proxy/1` came to coexist.
    const index = readSource(MODULE_INDEX);
    const declarations = [...index.matchAll(/^export const (\w+)/gm)].map(m => m[1]);
    assert.deepEqual(
        declarations,
        [],
        `modules/reader-link/index.ts exports constants again (${declarations.join(', ')}). The wire ` +
            'values belong in A3 + ProxyContract.kt + src/services/reader_link.ts, which this file gates.'
    );
});

// ---------------------------------------------------------------------------
// THE WIFI HANDOVER — the one endpoint that serves a secret
//
// `/cp-wifi` hands the phone's own WiFi credential to a reader that has no keyboard
// worth typing a passphrase on. Everything about it is a security property that no
// compiler can hold: it must never be forwarded, never be fetched upstream, never be
// logged, and must not exist at all unless the session was explicitly asked to share a
// network. Each test below pins one of those to the code that enforces it.
// ---------------------------------------------------------------------------

const KOTLIN_WIFI_STORE = readSource(join(KOTLIN_DIR, 'WifiShareStore.kt'));

test('the WiFi wire values agree across the doc, the Kotlin and the app', () => {
    assert.equal(kotlinString('WIFI_PATH'), doc('CP_WIFI_PATH'));
    assert.equal(kotlinString('WIFI_CONTENT_TYPE'), doc('CP_WIFI_CONTENT_TYPE'));
    assert.equal(kotlinString('WIFI_ACK_BODY'), doc('CP_WIFI_ACK_BODY'));
    assert.equal(kotlinInt('WIFI_SSID_MAX_BYTES'), Number.parseInt(doc('CP_WIFI_SSID_MAX_BYTES'), 10));
    assert.equal(kotlinInt('WIFI_PSK_MIN_CHARS'), Number.parseInt(doc('CP_WIFI_PSK_MIN_CHARS'), 10));
    assert.equal(kotlinInt('WIFI_PSK_MAX_CHARS'), Number.parseInt(doc('CP_WIFI_PSK_MAX_CHARS'), 10));
    // The reader probes this at the peer ORIGIN ROOT, exactly like /cp-proxy, so it must
    // carry no capability of its own.
    assert.equal(kotlinString('WIFI_PATH').includes('/m/'), false);
    // ...and it must not be the health path, which is answered with a different body.
    assert.notEqual(kotlinString('WIFI_PATH'), kotlinString('HEALTH_PATH'));
    // The JS validators apply the SAME bounds the firmware will, so a credential the app
    // accepts is one the reader can use.
    assert.equal(WIFI_SSID_MAX_BYTES, kotlinInt('WIFI_SSID_MAX_BYTES'));
    assert.equal(WIFI_PSK_MIN_CHARS, kotlinInt('WIFI_PSK_MIN_CHARS'));
    assert.equal(WIFI_PSK_MAX_CHARS, kotlinInt('WIFI_PSK_MAX_CHARS'));
    // And the app emits exactly the two-line body the doc describes.
    assert.equal(serializeWifiCredential({ ssid: 'Home', password: 'hunter2hunter2' }), 'Home\nhunter2hunter2\n');
});

test('/cp-wifi is classified BEFORE the forward prefix, so it can never be forwarded', () => {
    // THE ORDERING IS THE GUARANTEE. Whatever `allowedPathPrefix` a session was configured
    // with — `/m/`, or a sub-path deployment's full base — an exact match on this literal
    // has already been answered locally by the time the prefix is consulted.
    const classify = /fun classifyTarget\(([\s\S]*?)\n  \}/.exec(kotlin.httpWire);
    assert.ok(classify, 'HttpWire no longer declares classifyTarget(...)');
    const body = classify[1];
    const wifiAt = body.indexOf('ProxyContract.WIFI_PATH');
    const forwardAt = body.indexOf('startsWith(forwardPrefix)');
    assert.ok(wifiAt >= 0, 'classifyTarget no longer recognises ProxyContract.WIFI_PATH');
    assert.ok(forwardAt >= 0, 'classifyTarget no longer tests the forward prefix');
    assert.ok(
        wifiAt < forwardAt,
        'the /cp-wifi test moved AFTER the forward-prefix test. A prefix that matched it would ' +
            'send the credential upstream.'
    );
    // And nothing anywhere ever asks the mailbox for it.
    for (const [name, source] of Object.entries(kotlin)) {
        if (name === 'proxyContract' || name === 'httpWire') continue;
        assert.doesNotMatch(
            source,
            /upstreamOrigin\s*\+\s*ProxyContract\.WIFI_PATH/,
            `${name}.kt builds an upstream URL from the WiFi path`
        );
    }
});

test('DELETE is admitted for the WiFi path ONLY', () => {
    // A3's rule is GET|HEAD and nothing else, because the reader never publishes. The ack
    // is the one write in the module and it is pinned to one literal local path; the gate
    // below is what stops a DELETE reaching anything under the forward prefix.
    assert.match(kotlin.httpWire, /method != "GET" && method != "HEAD"/);
    const gate = /if \(method != "GET" && method != "HEAD"\) \{([\s\S]*?)\n    \}/.exec(kotlin.httpWire);
    assert.ok(gate, 'HttpWire no longer gates the method in a parseable block');
    assert.match(gate[1], /method == "DELETE"/);
    assert.match(gate[1], /pathOf\(target\) == ProxyContract\.WIFI_PATH/);
    assert.match(gate[1], /throw HttpProtocolException\(405/);
    // The upstream forward still only ever relays the reader's own method, and the reader
    // can only have got GET or HEAD past the gate above for a forwardable target.
    assert.match(kotlin.proxyServer, /connection\.requestMethod = request\.method/);
});

test('a /cp-wifi request produces NO activity event and moves NO counter', () => {
    // Redaction is not enough here: "a credential was asked for, and it was there" is
    // itself the fact worth withholding. Suppressing the emit also suppresses the request
    // counter, the byte counter and lastStatus, because all three live in
    // ReaderLinkSession.onProxyActivity, which is only reached through it.
    assert.match(kotlin.proxyServer, /suppressActivity = true/);
    assert.match(kotlin.proxyServer, /if \(!suppressActivity\) \{/);
    const handle = /private fun handle\(client: Socket\)([\s\S]*?)\n  \}\n/.exec(kotlin.proxyServer);
    assert.ok(handle, 'MailboxProxyServer no longer declares handle(client: Socket)');
    const wifiBranch = handle[1].indexOf('TargetKind.WIFI');
    const suppress = handle[1].indexOf('suppressActivity = true');
    assert.ok(wifiBranch >= 0 && suppress > wifiBranch, 'the WIFI branch no longer suppresses telemetry');
    assert.match(kotlin.session, /requestCount\.incrementAndGet\(\)/);
    assert.match(kotlin.session, /private fun onProxyActivity/);
});

test('the WiFi event can carry a state word and nothing else', () => {
    // The emit MailboxProxyServer is given takes a single String, so there is no shape in
    // which an SSID or a passphrase could ride the one event this endpoint produces. The
    // map is built in the session, from that word, in one place.
    assert.match(kotlin.proxyServer, /onWifiShare: \(String\) -> Unit/);
    assert.match(kotlin.session, /emit\(ReaderLinkEvents\.WIFI_SHARE, mapOf\("state" to state\)\)/);
    // Declared by the module, or the emit is swallowed and the feature reports nothing.
    const wifiEvent = readerLinkEventConstants().get('WIFI_SHARE');
    assert.ok(wifiEvent, 'ReaderLinkEvents no longer declares WIFI_SHARE');
    assert.ok(declaredEventNames().includes(wifiEvent));
    assert.ok(subscribedEventNames().includes(wifiEvent));
    // And the JS half reads only `state` off it.
    assert.ok(tsReadsField('state'));
});

test('the endpoint does not exist without the opt-in, and confines its file', () => {
    // OPT IN: no wifiSharePath, no store, and serveWifi 404s every method. A session that
    // was never asked to share a network cannot be talked into it by anything that
    // associates with the reader's AP.
    assert.match(kotlin.options, /var wifiSharePath: String\? = null/);
    assert.match(kotlin.session, /validated\.wifiSharePath\?\.let \{ WifiShareStore\(it, outboxRoots\) \}/);
    const serve = /private fun serveWifi\(([\s\S]*?)\n  \}\n/.exec(kotlin.proxyServer);
    assert.ok(serve, 'MailboxProxyServer no longer declares serveWifi(...)');
    assert.match(serve[1], /val store = wifiShare\s*\n\s*if \(store == null\) \{/);
    // SINGLE SERVE: the file is deleted BEFORE the ack is written, so a second GET in the
    // same session answers 404 whether or not JS ever hears the event.
    const consumeAt = serve[1].indexOf('store.consume()');
    const ackAt = serve[1].indexOf('WIFI_ACK_BODY');
    assert.ok(consumeAt >= 0 && ackAt > consumeAt, 'the ack is written before the credential is removed');
    // CONFINEMENT: the staged file is canonicalised and refused unless it sits inside this
    // app's own storage, exactly as an outbox body is.
    assert.match(KOTLIN_WIFI_STORE, /canonicalFile/);
    assert.match(KOTLIN_WIFI_STORE, /canonical\.path\.startsWith\(canonicalRoot\.path \+ File\.separator\)/);
    // Stricter than the outbox on purpose: this filename is fixed ASCII, so an escape can
    // only mean the path is not the one the module expects.
    assert.match(KOTLIN_WIFI_STORE, /indexOf\('%'\) >= 0\) return null/);
    // And the file is capped, so this never reads something it was not handed.
    assert.match(KOTLIN_WIFI_STORE, /ProxyContract\.WIFI_FILE_MAX_BYTES/);
});

test('/cp-wifi answers the READER and not every station on its AP', () => {
    // The listener is reachable by anything associated to the reader's soft AP. For the mailbox
    // endpoints that is the exposure the mailbox already has; for a HOME WIFI PASSPHRASE it is a
    // new capability, and a subnet test cannot help because the squatter shares the /24 by
    // construction. The reader is the AP, so the reader is the gateway.
    const serve = /private fun serveWifi\(([\s\S]*?)\n  \}\n/.exec(kotlin.proxyServer);
    assert.ok(serve, 'MailboxProxyServer no longer declares serveWifi(...)');
    // THE GATE IS FIRST — before the store is consulted, so a refusal is byte-identical to the
    // "nothing staged" 404 and cannot be used to detect that a credential exists. That also
    // closes HEAD, which would otherwise report the credential's exact length.
    const peerAt = serve[1].indexOf('if (!isPeer(remote))');
    const storeAt = serve[1].indexOf('val store = wifiShare');
    assert.ok(peerAt >= 0, 'serveWifi no longer checks the peer identity');
    assert.ok(storeAt > peerAt, 'the peer check no longer runs before the store is consulted');
    // It is the connection's own remote address, taken from the socket rather than from anything
    // the request could claim.
    assert.match(kotlin.proxyServer, /serveWifi\(request, out, includeBody, client\.inetAddress\)/);
    assert.match(kotlin.proxyServer, /private fun isPeer\(remote: InetAddress\?\): Boolean/);
    assert.match(kotlin.proxyServer, /peerGatewaySupplier\(\)/);
    assert.match(kotlin.session, /peerGatewaySupplier = \{ peer\.network\?\.let \{ peer\.gatewayIpv4\(it\) \} \}/);
    assert.match(kotlin.peerLink, /fun gatewayIpv4\(network: Network\): Inet4Address\?/);

    // SECOND LAYER: an ack that follows no answer is a FALSE RECEIPT — it consumes the file and
    // makes the app's card read "Handed over to the reader" for a credential nothing received.
    const deleteAt = serve[1].indexOf('request.method == "DELETE"');
    const armedAt = serve[1].indexOf('wifiServed.get()');
    assert.ok(deleteAt >= 0 && armedAt > deleteAt, 'DELETE no longer requires a served GET first');
    assert.ok(
        serve[1].indexOf('wifiServed.set(true)') > serve[1].indexOf('val staged = store.read()'),
        'the arming no longer happens on the GET that actually handed a body over'
    );
});

// ---------------------------------------------------------------------------
// The two origin validators, tied together
// ---------------------------------------------------------------------------

/**
 * Kotlin's `ORIGIN_PATTERN`, translated to a JS RegExp.
 *
 * Parsed rather than re-typed: a copy of the pattern here would be a fourth thing
 * to keep in sync, and the whole point is that the two validators have something
 * holding them together. The subset of regex syntax used is identical in both
 * engines.
 */
function kotlinOriginPattern() {
    const match = /ORIGIN_PATTERN\s*=\s*Regex\(\s*"((?:[^"\\]|\\.)*)"\s*(,\s*RegexOption\.(\w+)\s*)?\)/.exec(
        kotlin.options
    );
    assert.ok(match, 'Options.kt no longer declares ORIGIN_PATTERN as a parseable Regex("…") literal');
    const source = unescapeLiteral(match[1]);
    const flags = match[3] === 'IGNORE_CASE' ? 'i' : '';
    return new RegExp(source, flags);
}

test('every origin describeProxyTarget can emit satisfies the Kotlin ORIGIN_PATTERN', () => {
    const pattern = kotlinOriginPattern();
    // Bases the APP accepts (mailbox_client.checkMailboxBaseUrl) and therefore
    // hands to native. Each one used to be a way to make startProxy throw
    // `upstreamOrigin must be scheme://host[:port] with no path` while publishing,
    // notes and books all kept working — a failure with no visible cause.
    const accepted = [
        'https://mail.example.net/m/box',
        'http://mail.example.net/m/box',
        // Scheme case: checkMailboxBaseUrl matches /^(https?):\/\//i and returns the
        // string AS TYPED, so this is a valid mailbox base app-wide.
        'HTTPS://mail.example.net/m/box',
        'HttpS://Mail.Example.NET/m/box',
        // Trailing-dot FQDN: legal, and accepted by the JS validator.
        'https://mail.example.net./m/box',
        // Explicit port, and a host with digits/hyphens.
        'https://mail-01.example.net:8443/m/box',
        'https://100.77.36.51:8787/m/box',
        // Sub-path deployment: the prefix becomes the whole base path.
        'https://host.example.net/mailbox/m/box',
        // Trailing slashes are stripped by the shared normaliser.
        'https://mail.example.net/m/box///',
    ];
    for (const base of accepted) {
        const target = describeProxyTarget(base);
        assert.equal(target.ok, true, `describeProxyTarget refused ${base}: ${target.error}`);
        assert.match(
            target.origin,
            pattern,
            `origin ${JSON.stringify(target.origin)} (from ${base}) would be REJECTED by ` +
                `Options.kt's ORIGIN_PATTERN ${pattern} — startProxy would throw and the session ` +
                'would end as proxy-failed with nothing else in the app looking broken.'
        );
        // And the origin must still be an origin: a path here would double up
        // against the target the reader sends.
        assert.equal(target.origin.includes(target.basePath), false);
    }
});

test('the scheme is lowercased for native, and NOTHING else is rewritten', () => {
    const target = describeProxyTarget('HTTPS://Mail.Example.NET/m/AbCdEf');
    assert.equal(target.ok, true);
    assert.equal(target.origin, 'https://Mail.Example.NET');
    // The boxId IS the read capability (§2). Recasing the path would ask the
    // mailbox for a different, wrong box.
    assert.equal(target.basePath, '/m/AbCdEf');
    assert.equal(target.allowedPathPrefix, '/m/');
});

// ---------------------------------------------------------------------------
// Kotlin invariants that are cheap to state and expensive to lose
// ---------------------------------------------------------------------------

test('the module manifest still declares CHANGE_NETWORK_STATE', () => {
    // requestNetwork() throws SecurityException without it, which the session can
    // only report as a failed join. It lives in the MODULE manifest because
    // android/ is prebuild output that `expo prebuild --clean` regenerates.
    assert.match(readSource(MODULE_MANIFEST), /android\.permission\.CHANGE_NETWORK_STATE/);
});

test('the forwarder is GET/HEAD only and never follows a redirect', () => {
    // A3: the reader never publishes, so the forwarder is strictly read-only, and
    // the write token has no path into the module at all.
    assert.match(kotlin.httpWire, /method != "GET" && method != "HEAD"/);
    // The EXACT set of headers the forwarder sends upstream, as a set. No
    // Authorization — the mailbox write token lives in the JS layer and has no path
    // into this module — and no inbound header is echoed, so the peer link can never
    // turn the proxy into a credential relay. A new name here is a review event.
    const sent = [...kotlin.proxyServer.matchAll(/setRequestProperty\(\s*"([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(sent.sort(), ['Accept', 'Accept-Encoding', 'Range', 'User-Agent']);
    // Following a same-scheme cross-HOST 3xx would retarget a read at an origin
    // the user never configured, with nothing on either end able to tell.
    assert.match(kotlin.proxyServer, /instanceFollowRedirects\s*=\s*false/);
    // A relayed 3xx must at least be complete.
    assert.match(kotlin.httpWire, /"Location"/);
    // Range and the 206/416 answers pass through verbatim, or the reader's resume
    // restarts the download for ever (§2/§4.3).
    for (const header of ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']) {
        assert.match(kotlin.httpWire, new RegExp(`"${header}"`));
    }
});

test('teardown cannot deadlock behind a parked join', () => {
    // Every entry point is serialised onto one ops thread and a join parks it in a
    // polling wait loop, so the cancel flag must be set by anything that tears
    // down — otherwise a stopProxy submitted before leave() waits out the whole
    // join budget (for ever in watcher mode, where timeoutMs is 0).
    const stopProxy = /fun stopProxy\(promise: Promise\) \{([\s\S]*?)\n  \}/.exec(kotlin.session);
    assert.ok(stopProxy, 'ReaderLinkSession no longer declares stopProxy(promise)');
    assert.match(stopProxy[1], /cancelJoin\.set\(true\)/);
    const leave = /fun leave\(promise: Promise\) \{([\s\S]*?)\n  \}/.exec(kotlin.session);
    assert.ok(leave, 'ReaderLinkSession no longer declares leave(promise)');
    assert.match(leave[1], /cancelJoin\.set\(true\)/);
});

// ---------------------------------------------------------------------------
// THE EVENT NAMES AND THE PAYLOAD KEYS — the drift no compiler and no other test can see
//
// Both halves are written by hand, in two languages, with no shared compile step. A renamed
// EVENT is swallowed twice over (Kotlin's emit is wrapped in a try/catch, JS's addListener throws
// into a catch that keeps the other subscriptions alive), and a renamed FIELD coerces to null.
// Either one silently disables a feature while tsc stays clean and every behavioural test keeps
// passing, because every test drives the JS side with JS-shaped payloads.
//
// This actually happened: MailboxProxyServer emitted the delivery fact as `localId` /
// `localComplete`, reader_link.ts read `itemId` / `complete`, and NOTHING was ever marked
// delivered — no History row ever said "Delivered directly", nothing was ever pruned, and a
// handed-over note masked every newer remote note for the life of the queue.
// ---------------------------------------------------------------------------

/** Kotlin line comments, removed so a `(` or a `"` inside prose cannot break the scans below. */
function stripLineComments(source) {
    return source.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The balanced `(...)` call that starts at `marker`, string-literal aware.
 *
 * Parsed rather than regexed because these argument lists span many lines and contain both
 * parentheses and quotes; a `[\s\S]*?\)` would stop at the first inner `)`.
 */
function balancedCall(source, marker) {
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `the Kotlin no longer contains ${JSON.stringify(marker)}`);
    let depth = 0;
    let inString = false;
    // Scanning from the START of the marker, so a marker may be any prefix of the call (the
    // stopped-event map is identified by its first entry, not by a unique function name).
    for (let i = at; i < source.length; i += 1) {
        const c = source[i];
        if (inString) {
            if (c === '\\') i += 1;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '(') depth += 1;
        else if (c === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(at, i + 1);
        }
    }
    throw new Error(`unbalanced parentheses after ${JSON.stringify(marker)}`);
}

/** `"key" to value` pairs of a Kotlin `mapOf(...)` literal → the key set. */
function mapKeys(callText) {
    return new Set([...callText.matchAll(/"([A-Za-z0-9_]+)"\s+to\b/g)].map(m => m[1]));
}

/** `ReaderLinkEvents.NAME = "onWhatever"` → { NAME: 'onWhatever' }. */
function readerLinkEventConstants() {
    const at = kotlin.proxyContract.indexOf('object ReaderLinkEvents');
    assert.ok(at >= 0, 'ProxyContract.kt no longer declares `object ReaderLinkEvents`');
    const body = kotlin.proxyContract.slice(at);
    const values = new Map();
    for (const match of body.matchAll(/const val (\w+)\s*=\s*"([^"]+)"/g)) {
        values.set(match[1], match[2]);
    }
    assert.ok(values.size > 0, 'ReaderLinkEvents declares no string constants');
    return values;
}

/** The wire names the module DECLARES, resolved through those constants. */
function declaredEventNames() {
    const constants = readerLinkEventConstants();
    const call = balancedCall(stripLineComments(kotlin.module), 'Events(');
    const names = [...call.matchAll(/ReaderLinkEvents\.(\w+)/g)].map(m => {
        const value = constants.get(m[1]);
        assert.ok(value, `ReaderLinkModule declares ReaderLinkEvents.${m[1]}, which ProxyContract has not`);
        return value;
    });
    assert.ok(names.length > 0, 'ReaderLinkModule.kt has no parseable Events(...) list');
    return names;
}

/** The wire names src/services/reader_link.ts SUBSCRIBES to, from its EVENT_KINDS table. */
function subscribedEventNames() {
    const names = [...READER_LINK_TS.matchAll(/\{\s*name:\s*'([^']+)',\s*kind:\s*'([^']+)'\s*\}/g)].map(
        m => m[1]
    );
    assert.ok(names.length > 0, 'reader_link.ts has no parseable EVENT_KINDS table');
    return names;
}

/** True when reader_link.ts actually reads `raw.<field>` off a native payload. */
function tsReadsField(field) {
    return new RegExp(`raw\\.${field}\\b`).test(READER_LINK_TS);
}

test('every event JS subscribes to is DECLARED by the Kotlin module', () => {
    const declared = declaredEventNames();
    const subscribed = subscribedEventNames();
    for (const name of subscribed) {
        assert.ok(
            declared.includes(name),
            `src/services/reader_link.ts subscribes to "${name}", which is not in ReaderLinkModule's ` +
                `Events(${declared.join(', ')}). expo throws on an undeclared name and reader_link.ts ` +
                'catches it to keep the other subscriptions alive, so this costs the feature silently.'
        );
    }
    // The reverse direction is deliberate-with-one-exception, and naming it here makes ADDING a
    // native event a review event: `onSessionEnd` is documented in reader_link.ts's EVENT_KINDS
    // note as never subscribed (it always arrives after the `stopped` that already ended the JS
    // session, so first-end-wins would discard it).
    const unsubscribed = declared.filter(name => !subscribed.includes(name));
    assert.deepEqual(
        unsubscribed,
        ['onSessionEnd'],
        'a native event the JS half never subscribes to reports nothing at all. Either subscribe to ' +
            'it in EVENT_KINDS or add it to this list with the reason.'
    );
});

test('the ACTIVITY payload keys Kotlin sends are the ones the TS reads', () => {
    const emitted = mapKeys(balancedCall(stripLineComments(kotlin.proxyServer), 'onActivity('));
    // One group per FACT. The two halves are allowed to spell a fact differently (Kotlin sends
    // both `note` and `error` for the same string), but the intersection must be non-empty or the
    // fact does not cross the bridge at all.
    const facts = {
        method: ['method'],
        path: ['path'],
        status: ['status'],
        bytes: ['bytes'],
        range: ['range'],
        error: ['error', 'note'],
        source: ['source'],
        // THE ONE THAT BROKE. Kotlin mirrors the delivery onto the activity stream as `localId` /
        // `localComplete`; the TS reads both spellings.
        itemId: ['itemId', 'localId'],
        complete: ['complete', 'localComplete'],
    };
    for (const [fact, spellings] of Object.entries(facts)) {
        const sent = spellings.filter(name => emitted.has(name));
        const read = spellings.filter(name => tsReadsField(name));
        assert.ok(sent.length > 0, `MailboxProxyServer's activity map sends no spelling of "${fact}"`);
        assert.ok(read.length > 0, `reader_link.ts reads no spelling of "${fact}" off the activity payload`);
        assert.ok(
            sent.some(name => read.includes(name)),
            `the two halves disagree about "${fact}": Kotlin sends [${sent}] and reader_link.ts reads ` +
                `[${read}]. Both coerce to null, so the field is dropped with no error anywhere.`
        );
    }
});

test('the DELIVERY payload keys Kotlin sends are the ones the TS reads', () => {
    const emitted = mapKeys(balancedCall(stripLineComments(kotlin.proxyServer), 'onLocalDelivery('));
    // `id` + `complete` are the whole receipt: which item, and whether its LAST byte went out.
    // Everything else on that event is advisory.
    for (const [fact, spellings] of Object.entries({ id: ['id', 'itemId'], complete: ['complete'] })) {
        const sent = spellings.filter(name => emitted.has(name));
        const read = spellings.filter(name => tsReadsField(name));
        assert.ok(sent.length > 0, `the onLocalDelivery map sends no spelling of "${fact}"`);
        assert.ok(
            sent.some(name => read.includes(name)),
            `onLocalDelivery sends [${sent}] for "${fact}" and reader_link.ts reads [${read}]`
        );
    }
});

test('the session-end RECONCILE keys survive on the stopped event', () => {
    // The per-response delivery event can be MISSED: expo posts events to the JS thread, so a
    // reload between the last byte and the callback loses it. Native therefore keeps the id set
    // for the whole session and puts it on the one event the JS session is guaranteed to see.
    const stopped = balancedCall(stripLineComments(kotlin.session), 'mapOf(\n          "state" to "stopped"');
    const keys = mapKeys(stopped);
    assert.ok(keys.has('localDeliveredIds'), 'the stopped event no longer carries localDeliveredIds');
    assert.ok(
        tsReadsField('localDeliveredIds'),
        'reader_link.ts stopped reading localDeliveredIds, so a missed delivery event is never reconciled'
    );
});

test('the listening event carries the counts the status line renders', () => {
    // `localSkipped` is the ONLY place a permanently unservable queue entry surfaces: the JS queue
    // accepted it, the manifest lists it, and native refuses it. Without this key it is silent.
    const listening = balancedCall(stripLineComments(kotlin.session), 'mapOf<String, Any?>(');
    const keys = mapKeys(listening);
    for (const key of ['mode', 'localItems', 'localPending', 'localSkipped']) {
        assert.ok(keys.has(key), `the listening proxy-state event no longer carries ${key}`);
    }
    for (const key of ['localItems', 'localSkipped']) {
        assert.ok(tsReadsField(key), `reader_link.ts no longer reads ${key} off the proxy event`);
    }
});

test('a pre-grant failure does not emit `released`', () => {
    // The JS reducer treats a `released` before the proxy is up as a hard
    // "the reader's WiFi went away" error, which ends the session with unactionable
    // advice for a denied permission or a refused specifier — and discards the real
    // reason riding the promise rejection.
    const release = /fun release\(\) \{([\s\S]*?)\n  \}/.exec(kotlin.peerLink);
    assert.ok(release, 'PeerApLink no longer declares release()');
    assert.match(release[1], /if \(hadLink\) \{[\s\S]*?"released"/);
});

// ---------------------------------------------------------------------------
// "THE MAILBOX COULD NOT BE REACHED" — the fact the app had no channel for
//
// A 'Sync with app' session ran for a minute with the reader pulling happily off
// the phone and ZERO requests arriving at the mailbox, and nothing anywhere said
// so: the native side derived `upstreamOk` from the mode (`mode != local`, i.e.
// true whenever anything is queued), hardcoded the reason to null, and the JS
// reducer destructured away the two fields that did cross the bridge. Every
// assertion below is one of the seams that silence travelled through.
// ---------------------------------------------------------------------------

test('the upstream verdict crosses BOTH seams it has to', () => {
    // Kotlin -> Kotlin. MailboxProxyServer is the only half that knows whether a
    // forward reached the mailbox; ReaderLinkSession is the only half that can
    // report it. The activity map is the wire between them, and both names have
    // to match with no compiler to say otherwise.
    const activity = mapKeys(balancedCall(stripLineComments(kotlin.proxyServer), 'onActivity('));
    for (const key of ['upstreamOk', 'upstreamError']) {
        assert.ok(activity.has(key), `MailboxProxyServer's activity map no longer carries ${key}`);
        assert.match(
            kotlin.session,
            new RegExp(`body\\["${key}"\\]`),
            `ReaderLinkSession stopped reading ${key} off the activity payload, so a dead upstream ` +
                'is invisible again.'
        );
    }

    // Kotlin -> JS. The mode event is the ONLY channel the app has for this: the
    // activity event's `error` is dropped by sync_session's reducer by design
    // (it is per-request noise), and `getStatus` is not even in NATIVE_METHODS.
    const mode = mapKeys(balancedCall(stripLineComments(kotlin.session), 'ReaderLinkEvents.PROXY_MODE,'));
    for (const key of ['mode', 'localItems', 'upstreamOk', 'error']) {
        assert.ok(mode.has(key), `the onProxyMode payload no longer carries ${key}`);
        assert.ok(
            tsReadsField(key),
            `reader_link.ts no longer reads ${key} off the mode payload — it coerces to null and ` +
                'the status line goes back to saying nothing.'
        );
    }
});

test('upstreamOk is OBSERVED, not derived from the mode', () => {
    // The original line was `"upstreamOk" to (mode != ProxyContract.MODE_LOCAL)`,
    // which is TRUE BY CONSTRUCTION in merged mode — the exact session that
    // failed all evening. Deriving it again would restore a field that cannot
    // report the failure it exists to report.
    const reportMode = /private fun reportMode\(([\s\S]*?)\n  \}/.exec(kotlin.session);
    assert.ok(reportMode, 'ReaderLinkSession no longer declares reportMode(...)');
    assert.doesNotMatch(
        reportMode[1],
        /"upstreamOk"\s+to\s+\(mode\s*!=/,
        'upstreamOk is being computed from the mode again. In `merged` mode that is true whether or ' +
            'not a single forward succeeded, which is how a session with a dead mailbox reported a ' +
            'healthy one.'
    );
    // The emitted value comes off the volatile the request path writes.
    assert.match(reportMode[1], /upstreamOk/);
});

test("the 'none' mode the TS declares is actually emitted", () => {
    // `ProxyServeMode` has carried 'none' since local serve shipped and the Kotlin
    // NEVER SENT IT: both mode computations answered `upstream` whenever the queue
    // was empty, route or no route. So the one state the user could act on —
    // nothing queued and nothing reachable — rendered as the one mode the UI shows
    // silence for.
    assert.match(kotlin.proxyContract, /const val MODE_NONE\s*=\s*"none"/);
    assert.match(kotlin.proxyServer, /ProxyContract\.MODE_NONE/);
    assert.match(kotlin.session, /ProxyContract\.MODE_NONE/);
    assert.match(READER_LINK_TS, /'none'/);
});

test('a failed acquire keeps the request outstanding, and the session retries', () => {
    // The old acquire unregistered its NetworkRequest and threw, so one 10 s miss
    // at t=0 left the session with nothing asking for a network for its entire
    // life — and a phone that has just given up its WiFi association to join the
    // reader's AP settles SECONDS after that window.
    const acquire = /fun acquire\(([\s\S]*?)\n  \}/.exec(kotlin.upstream);
    assert.ok(acquire, 'UpstreamNetwork no longer declares acquire(...)');
    assert.doesNotMatch(
        acquire[1],
        /release\(\)/,
        'acquire() tears its own request down again. Losing the outstanding request is what made a ' +
            'transient "no data yet" permanent for the whole session.'
    );
    // And something has to notice the late grant: the proxy only recomputes the
    // mode when a request arrives, so without this the UI keeps the stale story.
    assert.match(kotlin.session, /scheduleWithFixedDelay/);
    assert.match(kotlin.session, /retryUpstream/);
});

test('every upstream byte, DNS included, rides the network we acquired', () => {
    // `Network.openConnection` resolves the host ON that network. The default
    // resolver would answer from whatever the process default happens to be,
    // which is the one difference between a mailbox name that works everywhere
    // else in the app and one that can never work from the proxy.
    // Matched on the ASSIGNMENT so the class KDoc's own prose (which names
    // `network.openConnection(url)` while explaining the rule) is not scanned as
    // if it were a call site.
    const opened = [...kotlin.proxyServer.matchAll(/connection = (\w+)\.openConnection\(/g)].map(
        m => m[1]
    );
    assert.equal(opened.length, 2, 'MailboxProxyServer no longer has exactly two upstream call sites');
    for (const receiver of opened) {
        assert.equal(
            receiver,
            'upstream',
            `an upstream connection is opened on \`${receiver}\` rather than the acquired Network`
        );
    }
    for (const source of [kotlin.proxyServer, kotlin.session, kotlin.upstream]) {
        assert.doesNotMatch(
            source,
            /InetAddress\.get(All)?ByName/,
            'a default-resolver DNS lookup crept in; it does not follow the acquired network'
        );
    }
    // The one deliberate lookup is the preflight, and it is a method ON the network.
    assert.match(kotlin.upstream, /network\.getAllByName\(/);
});
