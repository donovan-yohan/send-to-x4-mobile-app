/**
 * deliverability — the shared answer to "can this phone deliver, and how?".
 *
 * WHAT IS ACTUALLY AT RISK, and it is not a lost note: it is the app telling a
 * user something FALSE about their own setup. Every screen used to spend
 * `connectionStatus.connected` as though it meant "can we deliver", so a phone
 * with a perfectly good mailbox — the road that exists precisely because the
 * reader is asleep almost all of the time — rendered "not connected, can't
 * send". The note would have gone through. The app said it could not.
 *
 * So the properties pinned below are, in order of what they cost when broken:
 *
 *   1. A CONFIGURED ROAD IS NEVER REPORTED AS NO ROAD. Every cell with a usable
 *      mailbox resolves to a real route and a 'ready-*' summary, whatever the
 *      reader is doing.
 *   1b. AND ITS CONVERSE, which is the half that was missing and the half that
 *      broke: A REPORTED ROAD IS ALWAYS A ROAD THIS BUILD CAN DRIVE. For every
 *      cell claiming a route, the SENDER-SIDE predicate for that route must
 *      agree — `isMailboxConfigured` for 'mailbox', `isHandoverAvailable` for
 *      'handover-only' (which is also what gates DeviceScreen's Sync button and
 *      what `sync_session.start` re-checks before it touches the radio). The
 *      first version of this file pinned 'handover-only' on a saved AP
 *      passphrase, which gates NOTHING: the Sync button was not on the screen in
 *      any of those cells, the session would have refused, and anything sent
 *      landed in an outbox with no drain. A truth table with no converse can
 *      hold a model that promises roads that do not exist, and this one did.
 *   2. NO OVER-PROMISING EITHER. 'ready-direct' requires the reader to have
 *      ANSWERED, RECENTLY — one freshness window shared with
 *      `reader_reachability`, not a second copy of the number. A stale
 *      observation with a mailbox behind it reports the mailbox: the send may
 *      still upgrade itself to direct, and an upgrade is not a lie.
 *   3. ABSENCE OF INFORMATION SUBTRACTS NOTHING. With no mailbox and no
 *      evidence, the send still attempts the reader (rule 2 in
 *      `reader_reachability`'s header), so the route says 'direct' — that is
 *      what will actually happen.
 *   4. NOTES AND BOOKS AGREE. `epub_sender` mirrors `love_note_sender` leg for
 *      leg; a divergence between them is invisible until a user notices books
 *      and notes behaving differently, so the whole matrix is asserted for both.
 *
 * The matrix itself is exhaustive over (5 reader states x 2 mailbox x 2 psk) for
 * a host, plus the client rows and the token-less mailbox rows, and it is
 * written as DATA so the table can be read as the spec rather than
 * reverse-engineered from assertions. THE PSK AXIS IS KEPT DELIBERATELY even
 * though the passphrase is no longer an input: every psk=true row must equal its
 * psk=false twin, which is the regression guard against it becoming one again.
 *
 * Run:  node --import tsx --test scripts/deliverability.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import { deriveDeliverability, isHandoverAvailable } from '../src/services/deliverability';
import { READER_REACHABILITY_FRESH_MS } from '../src/services/reader_reachability';
import { isMailboxConfigured } from '../src/services/love_note_sender';
import { describeProxyTarget } from '../src/services/reader_link';

/** An arbitrary fixed "now". Nothing here depends on its actual value. */
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

const IP = 'crosspoint.local';
const MAILBOX_URL = 'https://mail.example.net/m/abc123';
const MAILBOX_TOKEN = 'tok_live_secret';
const PSK = 'reader-ap-passphrase';

/**
 * The four things the app can know about the reader.
 *
 * `stale-yes` and `stale-no` are separate INPUTS that must produce the SAME
 * output as `unknown`: past the freshness window an observation is not evidence
 * about now, whichever way it pointed. Keeping both polarities in the table is
 * what would catch a derivation that trusted a stale `true` (the expensive
 * direction — a "Connected" chip for a reader that went to sleep ten minutes
 * ago).
 */
const READER_STATES = {
    'fresh-yes': { reachable: true, checkedAt: NOW },
    'fresh-no': { reachable: false, checkedAt: NOW },
    'stale-yes': { reachable: true, checkedAt: NOW - READER_REACHABILITY_FRESH_MS - 1 },
    'stale-no': { reachable: false, checkedAt: NOW - READER_REACHABILITY_FRESH_MS - 1 },
    unknown: { reachable: null, checkedAt: null },
};

/**
 * `token` splits what used to be one boolean.
 *
 * A mailbox base and a mailbox write token are two separate configurations and
 * the app needs them for two separate things: publishing needs BOTH, while the
 * handover proxy needs the base ONLY (`buildProxyOptions` carries nothing that
 * could authenticate — that absence is asserted as a key set in
 * `sync-session.test.js`). `mailbox: true, token: false` is therefore not a
 * broken cell, it is the one that produces 'handover-only'.
 *
 * `readerApPsk` is written even though `DeliverabilitySettings` no longer
 * declares it. That is the point: the model must ignore an extra key, not route
 * on it, and a JS caller can always hand it one.
 */
function settingsFor({ role = 'host', mailbox = false, token = true, psk = false, ip = IP } = {}) {
    return {
        role,
        ip,
        mailboxUrl: mailbox ? MAILBOX_URL : '',
        mailboxWriteToken: mailbox && token ? MAILBOX_TOKEN : '',
        readerApPsk: psk ? PSK : '',
    };
}

function derive({ reader = 'fresh-yes', ...rest } = {}) {
    return deriveDeliverability({
        settings: settingsFor(rest),
        reachability: READER_STATES[reader],
        now: NOW,
    });
}

// ---------------------------------------------------------------------------
// THE TRUTH TABLE
// ---------------------------------------------------------------------------
//
// [reader state, mailbox configured, psk saved] -> [route, summary]
//
// Read the host block top to bottom and it states the whole model:
//   an awake reader wins outright; otherwise a mailbox is the floor we promise;
//   with no mailbox an unmeasured reader is still attempted; a saved passphrase
//   means the bytes wait on the phone for the next Sync; and only a phone with
//   none of the three is asked to set anything up.
const HOST_MATRIX = [
    // An awake reader wins outright — nothing else in the row can change it.
    ['fresh-yes', false, false, 'direct', 'ready-direct'],
    ['fresh-yes', false, true, 'direct', 'ready-direct'],
    ['fresh-yes', true, false, 'direct', 'ready-direct'],
    ['fresh-yes', true, true, 'direct', 'ready-direct'],

    // Measured asleep. THIS is the row that used to read "not connected".
    ['fresh-no', true, false, 'mailbox', 'ready-mailbox'],
    ['fresh-no', true, true, 'mailbox', 'ready-mailbox'],
    // A SAVED PASSPHRASE IS NOT A ROAD, and this is the cell that says so.
    // It read 'handover-only' / 'ready-handover' once. That was false in every
    // direction that matters: DeviceScreen renders no Sync button without a
    // serveable mailbox base, `sync_session.start` refuses before it touches the
    // radio, and the outbox those sends filled had no drain. Nothing about
    // `readerApPsk` changes any of that — it is handed to the platform's join
    // request once a session is ALREADY starting.
    ['fresh-no', false, true, 'none', 'setup-needed'],
    ['fresh-no', false, false, 'none', 'setup-needed'],

    // Stale in either direction, and never measured, are ONE case: unknown.
    // With a mailbox we promise the mailbox (the send may upgrade itself);
    // without one the send attempts the reader, so 'direct' is the honest answer
    // even though nothing has confirmed the reader is there.
    ['stale-yes', true, false, 'mailbox', 'ready-mailbox'],
    ['stale-yes', true, true, 'mailbox', 'ready-mailbox'],
    ['stale-yes', false, false, 'direct', 'ready-direct'],
    ['stale-yes', false, true, 'direct', 'ready-direct'],

    ['stale-no', true, false, 'mailbox', 'ready-mailbox'],
    ['stale-no', true, true, 'mailbox', 'ready-mailbox'],
    ['stale-no', false, false, 'direct', 'ready-direct'],
    ['stale-no', false, true, 'direct', 'ready-direct'],

    ['unknown', true, false, 'mailbox', 'ready-mailbox'],
    ['unknown', true, true, 'mailbox', 'ready-mailbox'],
    ['unknown', false, false, 'direct', 'ready-direct'],
    ['unknown', false, true, 'direct', 'ready-direct'],
];

/**
 * The handover cell: a serveable mailbox base, NO write token.
 *
 * Publishing is off (`isMailboxConfigured` requires the token), so 'mailbox' is
 * unavailable — but the proxy never wanted the token, so Sync-with-reader is
 * offered, starts, and drains the outbox over the reader's own AP. This is the
 * ONLY shape that produces 'handover-only', and pinning it is what stops the
 * route from quietly becoming dead code again (or, worse, being re-pointed at
 * something that cannot deliver).
 *
 * A live reader still wins outright, and an UNMEASURED one is still attempted:
 * handover is the last road tried, not a shortcut around the first two.
 */
const HOST_URL_ONLY_MATRIX = [
    ['fresh-yes', 'direct', 'ready-direct'],
    ['fresh-no', 'handover-only', 'ready-handover'],
    ['stale-yes', 'direct', 'ready-direct'],
    ['stale-no', 'direct', 'ready-direct'],
    ['unknown', 'direct', 'ready-direct'],
];

// A client has no LAN path to the reader BY DEFINITION — `routeLoveNote` and
// `routeEpubLegs` both refuse to try one — so the reader state is irrelevant to
// every row, and so is the passphrase (Sync-with-reader lives on the Device tab,
// which App.tsx renders for a host only).
const CLIENT_MATRIX = [];
for (const reader of Object.keys(READER_STATES)) {
    CLIENT_MATRIX.push([reader, true, false, 'mailbox', 'ready-mailbox']);
    CLIENT_MATRIX.push([reader, true, true, 'mailbox', 'ready-mailbox']);
    CLIENT_MATRIX.push([reader, false, false, 'none', 'setup-needed']);
    CLIENT_MATRIX.push([reader, false, true, 'none', 'setup-needed']);
}

test('host truth table: every (reader, mailbox, psk) resolves to one route', () => {
    assert.equal(HOST_MATRIX.length, Object.keys(READER_STATES).length * 4, 'matrix is exhaustive');

    for (const [reader, mailbox, psk, route, summary] of HOST_MATRIX) {
        const where = `host reader=${reader} mailbox=${mailbox} psk=${psk}`;
        const d = derive({ reader, mailbox, psk });
        assert.equal(d.noteRoute, route, `${where} noteRoute`);
        assert.equal(d.summary, summary, `${where} summary`);
    }
});

test('the psk column changes nothing, in every row of the table', () => {
    // Property 1b, as directly as it can be stated: `readerApPsk` is not an
    // input to this model, so a row with one must be indistinguishable from the
    // row without. Asserted on the WHOLE object rather than the route, so a
    // future field that starts reading the passphrase fails here too.
    for (const [reader, mailbox] of HOST_MATRIX) {
        for (const token of [true, false]) {
            const where = `reader=${reader} mailbox=${mailbox} token=${token}`;
            assert.deepEqual(
                derive({ reader, mailbox, token, psk: true }),
                derive({ reader, mailbox, token, psk: false }),
                where
            );
        }
    }
});

test('host, serveable mailbox base, no write token: the handover cell', () => {
    for (const [reader, route, summary] of HOST_URL_ONLY_MATRIX) {
        const where = `host reader=${reader} url-only`;
        const d = derive({ reader, mailbox: true, token: false });
        assert.equal(d.noteRoute, route, `${where} noteRoute`);
        assert.equal(d.bookRoute, route, `${where} bookRoute`);
        assert.equal(d.summary, summary, `${where} summary`);
        // Publishing is off; the sync is on. Both halves matter: the first is
        // why 'mailbox' is unavailable, the second is why the bytes are not
        // stranded.
        assert.equal(d.mailboxReady, false, `${where} mailboxReady`);
        assert.equal(d.apHandoverReady, true, `${where} apHandoverReady`);
        assert.equal(d.anyRoute, true, `${where} anyRoute`);
    }

    // With no reader host to dial either, handover is the only road left and it
    // must still be reported — this is the cell a client-shaped host lands in.
    const noIp = deriveDeliverability({
        settings: settingsFor({ mailbox: true, token: false, ip: '' }),
        reachability: READER_STATES.unknown,
        now: NOW,
    });
    assert.equal(noIp.noteRoute, 'handover-only');
    assert.equal(noIp.summary, 'ready-handover');
});

test('client truth table: mailbox or nothing, whatever the reader is doing', () => {
    for (const [reader, mailbox, psk, route, summary] of CLIENT_MATRIX) {
        const where = `client reader=${reader} mailbox=${mailbox} psk=${psk}`;
        const d = derive({ role: 'client', reader, mailbox, psk });
        assert.equal(d.noteRoute, route, `${where} noteRoute`);
        assert.equal(d.summary, summary, `${where} summary`);
        // The reader is never dialled for a client, so a fresh "reachable" must
        // not light the direct chip on the partner's phone.
        assert.equal(d.directNow, false, `${where} directNow`);
        assert.equal(d.apHandoverReady, false, `${where} apHandoverReady`);
    }
});

test('books route exactly like notes, in every cell', () => {
    // `epub_sender` is a deliberate mirror of `love_note_sender`. If that ever
    // stops being true, this is the test that says where to put the difference.
    for (const [reader, mailbox, psk] of HOST_MATRIX) {
        const d = derive({ reader, mailbox, psk });
        assert.equal(d.bookRoute, d.noteRoute, `host reader=${reader} mailbox=${mailbox} psk=${psk}`);
    }
    for (const [reader, mailbox, psk] of CLIENT_MATRIX) {
        const d = derive({ role: 'client', reader, mailbox, psk });
        assert.equal(d.bookRoute, d.noteRoute, `client reader=${reader} mailbox=${mailbox} psk=${psk}`);
    }
});

test('anyRoute is false in exactly the cells that ask for setup', () => {
    // Asserted against the route column rather than a column of its own: the two
    // must agree by construction, and a hand-maintained expectation is the thing
    // that would drift.
    for (const [reader, mailbox, psk, route] of HOST_MATRIX) {
        const d = derive({ reader, mailbox, psk });
        assert.equal(d.anyRoute, route !== 'none', `host reader=${reader} mailbox=${mailbox} psk=${psk}`);
    }
    for (const [reader, mailbox, psk, route] of CLIENT_MATRIX) {
        const d = derive({ role: 'client', reader, mailbox, psk });
        assert.equal(d.anyRoute, route !== 'none', `client reader=${reader} mailbox=${mailbox} psk=${psk}`);
    }
});

test('summary is exactly the four tokens, one per route', () => {
    const seen = new Set();
    for (const { settings, reader } of allCells()) {
        seen.add(
            deriveDeliverability({ settings, reachability: READER_STATES[reader], now: NOW }).summary
        );
    }
    // All four states are reachable from real settings — none is dead code the
    // UI would never have to render. 'ready-handover' earns its place through
    // HOST_URL_ONLY_MATRIX and nowhere else; if that matrix goes, so must
    // RouteChip's 'Next sync' word and hint, or the chip starts describing a
    // road the model cannot produce.
    assert.deepEqual(
        [...seen].sort(),
        ['ready-direct', 'ready-handover', 'ready-mailbox', 'setup-needed']
    );
});

// ---------------------------------------------------------------------------
// PROPERTY 1b — a reported road is always a road this build can drive
// ---------------------------------------------------------------------------
//
// The converse of "a configured road is never reported as no road", and the
// direction that actually broke. Written against the SENDER-SIDE predicates
// rather than a second expectation column, because a hand-maintained column is
// exactly what agreed with a wrong model last time.

/** Every cell the tables above describe, as (settings, reader state) data. */
function* allCells() {
    for (const [reader, mailbox, psk] of HOST_MATRIX) {
        yield { where: `host reader=${reader} mailbox=${mailbox} psk=${psk}`, reader, settings: settingsFor({ mailbox, psk }) };
    }
    for (const [reader] of HOST_URL_ONLY_MATRIX) {
        yield { where: `host reader=${reader} url-only`, reader, settings: settingsFor({ mailbox: true, token: false }) };
    }
    for (const [reader, mailbox, psk] of CLIENT_MATRIX) {
        yield {
            where: `client reader=${reader} mailbox=${mailbox} psk=${psk}`,
            reader,
            settings: settingsFor({ role: 'client', mailbox, psk }),
        };
    }
}

test('every claimed route is one the sender-side predicate agrees exists', () => {
    let sawMailbox = false;
    let sawHandover = false;

    for (const { where, reader, settings } of allCells()) {
        const d = deriveDeliverability({ settings, reachability: READER_STATES[reader], now: NOW });

        for (const [field, route] of [['noteRoute', d.noteRoute], ['bookRoute', d.bookRoute]]) {
            const at = `${where} ${field}='${route}'`;
            switch (route) {
                case 'mailbox':
                    sawMailbox = true;
                    // `love_note_sender`/`epub_sender` route on this exact call.
                    assert.equal(isMailboxConfigured(settings), true, `${at}: the send would refuse`);
                    break;
                case 'handover-only':
                    sawHandover = true;
                    // Three things must be true for this claim to be honest, and
                    // they are three different pieces of code:
                    //   the model's own field,
                    assert.equal(d.apHandoverReady, true, `${at}: model`);
                    //   DeviceScreen's `canSyncWithReader` (which IS that field),
                    assert.equal(
                        isHandoverAvailable({ role: settings.role, mailboxUrl: settings.mailboxUrl }),
                        true,
                        `${at}: no Sync button would be rendered`
                    );
                    //   and what `sync_session.start` re-checks through
                    //   `buildProxyOptions` before it touches the radio.
                    assert.equal(
                        describeProxyTarget(settings.mailboxUrl).ok,
                        true,
                        `${at}: the session would end 'not-configured'`
                    );
                    // Publishing is off in every handover cell by construction —
                    // step 2 of `deriveRoute` claims the rest.
                    assert.equal(isMailboxConfigured(settings), false, `${at}: should have been 'mailbox'`);
                    break;
                case 'direct':
                    // The send WILL dial the reader, so there has to be one.
                    assert.equal(settings.role, 'host', `${at}: a client never dials the reader`);
                    assert.notEqual(settings.ip.trim(), '', `${at}: nothing to dial`);
                    break;
                case 'none':
                    assert.equal(d.anyRoute, false, `${at}: anyRoute disagrees`);
                    break;
                default:
                    assert.fail(`${at}: unknown route`);
            }
        }
    }

    // The property is vacuous if no cell ever claims the interesting routes.
    assert.equal(sawMailbox, true, 'no cell exercised the mailbox claim');
    assert.equal(sawHandover, true, 'no cell exercised the handover claim');
});

test('isHandoverAvailable is sync_session\'s own precondition, not a paraphrase', () => {
    // Anything `describeProxyTarget` refuses, the Sync button must refuse too —
    // it is what `buildProxyOptions` calls, and a mismatch is a button that
    // joins the reader's AP, drops the phone off its WiFi and then 502s.
    const bases = [
        MAILBOX_URL,
        'http://10.0.0.7:8787/m/box7',
        'https://host.example/mailbox/m/box7',
        'https://mail.example.net',                 // root-mounted: publishes, cannot be served
        '',                                          // nothing configured
        '   ',
        'mail.example.net/m/box',                    // no scheme
        'https://u:p@mail.example.net/m/box',        // credentials
        'https://mail.example.net/m/box?x=1',        // query
        'https://mail.example.net/m/box#f',          // fragment
    ];

    for (const mailboxUrl of bases) {
        const expected = describeProxyTarget(mailboxUrl).ok;
        assert.equal(
            isHandoverAvailable({ role: 'host', mailboxUrl }),
            expected,
            `isHandoverAvailable(${JSON.stringify(mailboxUrl)})`
        );
        assert.equal(
            deriveDeliverability({
                settings: { role: 'host', ip: IP, mailboxUrl },
                reachability: READER_STATES['fresh-no'],
                now: NOW,
            }).apHandoverReady,
            expected,
            `apHandoverReady for ${JSON.stringify(mailboxUrl)}`
        );
    }

    // A root-mounted base is the case that proves the two mailbox predicates are
    // genuinely independent rather than one being a subset of the other: it
    // PUBLISHES fine and cannot be proxied at all.
    const rootMounted = { role: 'host', ip: IP, mailboxUrl: 'https://mail.example.net', mailboxWriteToken: MAILBOX_TOKEN };
    assert.equal(isMailboxConfigured(rootMounted), true);
    assert.equal(isHandoverAvailable(rootMounted), false);

    // Host only: Sync-with-reader lives on the Device tab, which App.tsx renders
    // for a host.
    assert.equal(isHandoverAvailable({ role: 'client', mailboxUrl: MAILBOX_URL }), false);
    // And it may not throw on the degraded input the settings blob can produce.
    assert.equal(isHandoverAvailable(undefined), false);
    assert.equal(isHandoverAvailable({}), false);
    assert.equal(isHandoverAvailable({ role: 'host', mailboxUrl: null }), false);
});

// ---------------------------------------------------------------------------
// FRESHNESS — one window, shared, not a second copy of 30 s
// ---------------------------------------------------------------------------

test('the freshness boundary is reader_reachability\'s window, to the millisecond', () => {
    const call = (age) =>
        deriveDeliverability({
            settings: settingsFor({ mailbox: true }),
            reachability: { reachable: true, checkedAt: NOW - age },
            now: NOW,
        });

    // Exactly at the window: still evidence.
    assert.equal(call(READER_REACHABILITY_FRESH_MS).directNow, true);
    assert.equal(call(READER_REACHABILITY_FRESH_MS).noteRoute, 'direct');
    // One millisecond past it: not evidence, and the mailbox becomes the floor.
    assert.equal(call(READER_REACHABILITY_FRESH_MS + 1).directNow, false);
    assert.equal(call(READER_REACHABILITY_FRESH_MS + 1).noteRoute, 'mailbox');
});

test('a stamp from the future is stale, not extra-fresh', () => {
    // A clock that jumped backwards, or a caller stamping ahead. Same rule as
    // isReachabilityFresh: an observation this process cannot reason about is
    // treated as unknown rather than trusted.
    const d = deriveDeliverability({
        settings: settingsFor({ mailbox: true }),
        reachability: { reachable: true, checkedAt: NOW + 1 },
        now: NOW,
    });
    assert.equal(d.directNow, false);
    assert.equal(d.noteRoute, 'mailbox');
});

test('an unstamped observation reads as never-asked, not as asleep', () => {
    // THE LAUNCH WINDOW. `connectionStatus` is seeded `connected: false` with no
    // `checkedAt`, and rendering that as a measured "the reader is asleep" is how
    // the app would flash a setup prompt at a user who has everything configured.
    const d = deriveDeliverability({
        settings: settingsFor({ mailbox: false, psk: false }),
        reachability: { reachable: false, checkedAt: null },
        now: NOW,
    });
    assert.equal(d.directNow, false);
    assert.equal(d.noteRoute, 'direct', 'the send will still attempt the reader');
    assert.equal(d.summary, 'ready-direct');
});

// ---------------------------------------------------------------------------
// THE INGREDIENTS
// ---------------------------------------------------------------------------

test('directNow requires an answer, recency, a host role and a host to dial', () => {
    assert.equal(derive({ reader: 'fresh-yes' }).directNow, true);
    assert.equal(derive({ reader: 'fresh-no' }).directNow, false);
    assert.equal(derive({ reader: 'stale-yes' }).directNow, false);
    assert.equal(derive({ reader: 'unknown' }).directNow, false);
    assert.equal(derive({ reader: 'fresh-yes', role: 'client' }).directNow, false);
    // A blank host removes the direct road entirely rather than leaving an
    // unknown the send would go on to attempt against `http:///api/files`.
    assert.equal(derive({ reader: 'fresh-yes', ip: '   ' }).directNow, false);
});

test('a blank reader host falls through to the next road, never to direct', () => {
    assert.equal(derive({ reader: 'unknown', ip: '', mailbox: true }).noteRoute, 'mailbox');
    assert.equal(
        derive({ reader: 'unknown', ip: '', mailbox: true, token: false }).noteRoute,
        'handover-only'
    );
    // A saved passphrase is NOT the next road down. It never was one.
    assert.equal(derive({ reader: 'unknown', ip: '', psk: true }).noteRoute, 'none');
    assert.equal(derive({ reader: 'unknown', ip: '' }).noteRoute, 'none');
});

test('mailboxReady is the senders own predicate, not a second opinion', () => {
    // Anything `isMailboxConfigured` refuses, this must refuse identically —
    // otherwise a screen offers a road the send then declines.
    const cases = [
        [MAILBOX_URL, MAILBOX_TOKEN],
        [MAILBOX_URL, ''],                 // token missing
        ['', MAILBOX_TOKEN],               // url missing
        ['mail.example.net', MAILBOX_TOKEN],          // no scheme
        ['https://', MAILBOX_TOKEN],                  // no host
        ['https://u:p@mail.example.net', MAILBOX_TOKEN], // credentials
        ['https://mail.example.net/m?x=1', MAILBOX_TOKEN], // query
        ['https://mail.example.net/m#f', MAILBOX_TOKEN],   // fragment
        ['https://mail.example.net/ a', MAILBOX_TOKEN],    // whitespace
        [`https://mail.example.net/${'x'.repeat(200)}`, MAILBOX_TOKEN], // too long
    ];

    for (const [mailboxUrl, mailboxWriteToken] of cases) {
        const expected = isMailboxConfigured({
            role: 'host',
            ip: IP,
            mailboxUrl,
            mailboxWriteToken,
        });
        const d = deriveDeliverability({
            settings: { role: 'host', ip: IP, mailboxUrl, mailboxWriteToken },
            reachability: READER_STATES['fresh-no'],
            now: NOW,
        });
        assert.equal(d.mailboxReady, expected, `mailboxReady for ${JSON.stringify(mailboxUrl)}`);
        // And the route agrees with the predicate rather than with the presence
        // of a non-empty string. Where publishing is off the fallback is the
        // handover road IF the base is serveable — which is precisely the
        // token-missing case in this list, and nothing else in it.
        const fallback = describeProxyTarget(mailboxUrl).ok ? 'handover-only' : 'none';
        assert.equal(
            d.noteRoute,
            expected ? 'mailbox' : fallback,
            `route for ${JSON.stringify(mailboxUrl)}`
        );
    }
});

test('apHandoverReady is a serveable mailbox base, host only — never the passphrase', () => {
    // THE REGRESSION. This assertion is the whole finding: a phone with the
    // reader's AP passphrase saved and no mailbox has NO handover road, because
    // the button that would drive one is not rendered and the session that would
    // start one refuses. It read `true` here once, and every screen downstream
    // believed it.
    assert.equal(derive({ psk: true }).apHandoverReady, false);
    assert.equal(derive({ psk: false }).apHandoverReady, false);

    // What DOES light it: a base the phone can serve. With or without a token,
    // with or without a passphrase — none of those three are the question.
    assert.equal(derive({ mailbox: true }).apHandoverReady, true);
    assert.equal(derive({ mailbox: true, token: false }).apHandoverReady, true);
    assert.equal(derive({ mailbox: true, psk: true }).apHandoverReady, true);

    const withPsk = (readerApPsk, role = 'host') =>
        deriveDeliverability({
            settings: { role, ip: IP, readerApPsk },
            reachability: READER_STATES['fresh-no'],
            now: NOW,
        }).apHandoverReady;

    // '' is the DEFAULT for every install (the open AP the firmware ships) and a
    // valid one — `JoinOptions.passphrase` accepts it. Neither '' nor a real
    // passphrase moves this field, which is the point.
    assert.equal(withPsk(''), false);
    assert.equal(withPsk('   '), false);
    assert.equal(withPsk(undefined), false);
    assert.equal(withPsk(null), false);
    assert.equal(withPsk(PSK), false);
    assert.equal(withPsk(PSK, 'client'), false);

    // Host only: Sync-with-reader is a Device-tab surface.
    assert.equal(derive({ role: 'client', mailbox: true }).apHandoverReady, false);
});

// ---------------------------------------------------------------------------
// DEGRADED INPUT — this feeds a render, so it may not throw
// ---------------------------------------------------------------------------

test('an unreadable role coerces to host, exactly like every other read of it', () => {
    for (const role of [undefined, null, '', 'Host', 'partner', 0, {}, []]) {
        const d = deriveDeliverability({
            settings: { role, ip: IP, mailboxUrl: MAILBOX_URL, mailboxWriteToken: MAILBOX_TOKEN },
            reachability: READER_STATES['fresh-yes'],
            now: NOW,
        });
        assert.equal(d.noteRoute, 'direct', `role ${JSON.stringify(role)}`);
    }
});

test('missing inputs resolve to the conservative state instead of throwing', () => {
    // A half-written settings blob, or a caller that has not loaded one yet.
    assert.doesNotThrow(() => deriveDeliverability({ settings: {}, reachability: { reachable: null, checkedAt: null } }));

    const empty = deriveDeliverability({
        settings: {},
        reachability: { reachable: null, checkedAt: null },
        now: NOW,
    });
    // No host to dial, no mailbox, no passphrase: the one state that should ask
    // the user for something.
    assert.equal(empty.noteRoute, 'none');
    assert.equal(empty.summary, 'setup-needed');
    assert.equal(empty.anyRoute, false);

    // A missing reachability object is the same as never having measured.
    const noObservation = deriveDeliverability({
        settings: settingsFor({ mailbox: true }),
        reachability: undefined,
        now: NOW,
    });
    assert.equal(noObservation.directNow, false);
    assert.equal(noObservation.noteRoute, 'mailbox');
});

test('now defaults to the wall clock without changing any answer', () => {
    // The only branch that reads `now` is freshness, and a stamp of Date.now()
    // is fresh by definition — so the default path and the injected path agree.
    const injected = deriveDeliverability({
        settings: settingsFor({ mailbox: true }),
        reachability: { reachable: true, checkedAt: NOW },
        now: NOW,
    });
    const wallClock = deriveDeliverability({
        settings: settingsFor({ mailbox: true }),
        reachability: { reachable: true, checkedAt: Date.now() },
    });
    assert.deepEqual(wallClock, injected);
});
