/**
 * wifi-ssid.test.js — the SSID prefill, everything about it that can be tested
 * without a device.
 *
 * WHAT THIS FILE IS STANDING IN FOR. The prefill is half Kotlin
 * (modules/reader-link/.../CurrentSsid.kt, which reads the platform) and half
 * TypeScript (src/services/wifi_ssid.ts, which decides what the card shows).
 * The Kotlin CANNOT BE COMPILED IN THIS WORKFLOW, so the rules it implements are
 * mirrored into `normalizeSsid` and pinned here. That mirroring is the point:
 *
 *   1. THE QUOTING RULE, because getting it backwards is silent. Android returns
 *      a decodable name in double quotes and everything else bare, so stripping
 *      quotes unconditionally makes `<unknown ssid>` look like a network and
 *      applying the hex-sentinel rule to a quoted value throws away a network
 *      genuinely named `0xCoffee`.
 *   2. THE SENTINELS, because `<unknown ssid>` is what the platform hands back
 *      to an app WITHOUT permission — i.e. the exact string this whole feature
 *      exists to stop showing to the user as if it were their network.
 *   3. THE UI STATE MAP, because it is the only thing deciding whether a user is
 *      shown a permission prompt, a note, or nothing. Every state is asserted,
 *      including the ones that must NOT offer a button (there is no permission
 *      to grant that would fix "this phone is not on WiFi").
 *   4. THE BRIDGE COERCION, because the native payload is untyped and this runs
 *      inside a settings sheet where a throw is a crash.
 *
 * Run:  node --import tsx --test scripts/wifi-ssid.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    WIFI_PREFILL_NOTE,
    coerceSsidRead,
    describeWifiPrefill,
    normalizeSsid,
    wifiPrefillButtonRequests,
    wifiPrefillHasButton,
} from '../src/services/wifi_ssid';

// ---------------------------------------------------------------------------
// normalizeSsid — quoting
// ---------------------------------------------------------------------------

test('a quoted value is the network name, with the quotes removed', () => {
    assert.equal(normalizeSsid('"Nest of Owls"'), 'Nest of Owls');
});

test('only the OUTERMOST pair of quotes is removed', () => {
    // A network whose name contains quotes is legal, and Android quotes the
    // whole thing. Stripping every quote would rename it.
    assert.equal(normalizeSsid('"say "hi""'), 'say "hi"');
});

test('whitespace AROUND the platform value is dropped', () => {
    assert.equal(normalizeSsid('  "Home"  '), 'Home');
    assert.equal(normalizeSsid('\t"Home"\n'), 'Home');
});

test('whitespace INSIDE the quotes is preserved, byte for byte', () => {
    // This value is on its way to a reader that has to match the SSID exactly to
    // join. Trimming it here would produce a name that joins nothing, and the
    // failure would present on the reader as "it will not connect to my WiFi".
    assert.equal(normalizeSsid('" Home "'), ' Home ');
    assert.equal(normalizeSsid('"Two  Spaces"'), 'Two  Spaces');
});

test('a value with no quotes at all is taken as-is', () => {
    // Not every route to getSSID() quotes on every OEM build. A bare name that
    // is not a sentinel is still a name.
    assert.equal(normalizeSsid('BareName'), 'BareName');
});

// ---------------------------------------------------------------------------
// normalizeSsid — sentinels
// ---------------------------------------------------------------------------

test('the unknown-ssid sentinel is null, in any case', () => {
    // THE WHOLE REASON THIS FEATURE EXISTS. Without location permission this is
    // literally what Android returns, and prefilling it would put the string
    // "<unknown ssid>" into a credential handed to the reader.
    assert.equal(normalizeSsid('<unknown ssid>'), null);
    assert.equal(normalizeSsid('<UNKNOWN SSID>'), null);
    assert.equal(normalizeSsid('  <unknown ssid>  '), null);
});

test('a bare hex dump is null', () => {
    // Android returns the raw bytes as hex when the SSID is not UTF-8. Unusable
    // as a prefill and meaningless to a user.
    assert.equal(normalizeSsid('0x1a2b3c'), null);
    assert.equal(normalizeSsid('0X1A2B3C'), null);
});

test('a QUOTED value is never treated as a sentinel', () => {
    // The quotes are Android saying "this decoded as UTF-8", i.e. it is a real
    // name. A network called 0xCoffee, or one perversely called <unknown ssid>,
    // survives because it arrived quoted.
    assert.equal(normalizeSsid('"0xCoffee"'), '0xCoffee');
    assert.equal(normalizeSsid('"<unknown ssid>"'), '<unknown ssid>');
});

// ---------------------------------------------------------------------------
// normalizeSsid — emptiness and non-strings
// ---------------------------------------------------------------------------

test('empty, blank and quote-only values are null', () => {
    assert.equal(normalizeSsid(''), null);
    assert.equal(normalizeSsid('   '), null);
    assert.equal(normalizeSsid('""'), null);
    assert.equal(normalizeSsid('"   "'), null);
});

test('a lone quote is not a quoted value', () => {
    // Length-1 input must not be sliced into nothing by the quote rule.
    assert.equal(normalizeSsid('"'), '"');
});

test('anything that is not a string is null, and does not throw', () => {
    assert.equal(normalizeSsid(null), null);
    assert.equal(normalizeSsid(undefined), null);
    assert.equal(normalizeSsid(42), null);
    assert.equal(normalizeSsid({}), null);
});

// ---------------------------------------------------------------------------
// coerceSsidRead — the untyped bridge
// ---------------------------------------------------------------------------

test('a well-formed native payload passes through', () => {
    assert.deepEqual(coerceSsidRead({ ssid: '"Nest of Owls"', reason: 'ok' }), {
        ssid: 'Nest of Owls',
        reason: 'ok',
    });
});

test('the reason survives when there is no ssid', () => {
    for (const reason of ['permission', 'no-wifi', 'unavailable']) {
        assert.deepEqual(coerceSsidRead({ ssid: null, reason }), { ssid: null, reason });
    }
});

test('a usable name outranks a stale reason, and a missing one outranks "ok"', () => {
    // The ssid is the fact; the reason is a label a native module one build
    // behind could get wrong. Neither half is allowed to lie about the other.
    assert.deepEqual(coerceSsidRead({ ssid: '"Home"', reason: 'unavailable' }), {
        ssid: 'Home',
        reason: 'ok',
    });
    assert.deepEqual(coerceSsidRead({ ssid: '<unknown ssid>', reason: 'ok' }), {
        ssid: null,
        reason: 'unavailable',
    });
});

test('garbage from the bridge degrades to unavailable instead of throwing', () => {
    for (const payload of [null, undefined, 'nope', 7, [], {}, { reason: 'banana' }]) {
        assert.deepEqual(coerceSsidRead(payload), { ssid: null, reason: 'unavailable' });
    }
});

// ---------------------------------------------------------------------------
// describeWifiPrefill — permission state x read reason -> what the card shows
// ---------------------------------------------------------------------------

test('a name that was read wins over every permission state', () => {
    // Including `unasked`: an OEM (or a grant made in system settings while the
    // sheet was open) can answer without this app having asked, and the card
    // must not then offer to ask for something it evidently does not need.
    for (const permission of ['granted', 'denied', 'blocked', 'unasked']) {
        assert.equal(describeWifiPrefill(permission, 'ok'), 'filled');
    }
});

test('not on WiFi is reported as such, and offers no permission', () => {
    // There is no grant that makes a phone on cellular report a network name, so
    // a button here would be a prompt that cannot change the answer.
    for (const permission of ['granted', 'denied', 'unasked']) {
        assert.equal(describeWifiPrefill(permission, 'no-wifi'), 'no-wifi');
    }
    assert.equal(wifiPrefillHasButton('no-wifi'), false);
});

test('never-asked offers the prompt', () => {
    assert.equal(describeWifiPrefill('unasked', null), 'offer');
    assert.equal(describeWifiPrefill('unasked', 'permission'), 'offer');
    assert.equal(wifiPrefillHasButton('offer'), true);
    assert.equal(wifiPrefillButtonRequests('offer'), true);
});

test('a plain denial keeps the button, because Android will ask again', () => {
    assert.equal(describeWifiPrefill('denied', null), 'denied');
    assert.equal(describeWifiPrefill('denied', 'permission'), 'denied');
    assert.equal(wifiPrefillHasButton('denied'), true);
    assert.equal(wifiPrefillButtonRequests('denied'), true);
});

test('a permanent denial removes the button', () => {
    // `PermissionsAndroid.request` resolves with NEVER_ASK_AGAIN and shows
    // nothing, so the control would visibly do nothing at all.
    assert.equal(describeWifiPrefill('blocked', null), 'blocked');
    assert.equal(describeWifiPrefill('blocked', 'permission'), 'blocked');
    assert.equal(wifiPrefillHasButton('blocked'), false);
});

test('granted with nothing read yet is a read button, NOT a permission prompt', () => {
    assert.equal(describeWifiPrefill('granted', null), 'ready');
    assert.equal(wifiPrefillHasButton('ready'), true);
    assert.equal(
        wifiPrefillButtonRequests('ready'),
        false,
        'the app must not be able to raise a system dialog for a permission it already holds'
    );
});

test('granted and still nothing readable is unavailable, not a re-prompt', () => {
    // Location services off device-wide is the real case. Re-asking for a
    // permission the app already has would be a dialog that changes nothing.
    assert.equal(describeWifiPrefill('granted', 'unavailable'), 'unavailable');
    assert.equal(
        describeWifiPrefill('granted', 'permission'),
        'unavailable',
        'a stale `permission` reason from an older native build must not loop the user through a ' +
            'prompt for a grant that is already in place'
    );
    assert.equal(wifiPrefillHasButton('unavailable'), false);
});

test('non-Android is silent: no button, no note, no explanation owed', () => {
    for (const reason of [null, 'permission', 'unavailable', 'no-wifi']) {
        assert.equal(describeWifiPrefill('unsupported', reason), 'unsupported');
    }
    assert.equal(wifiPrefillHasButton('unsupported'), false);
    assert.equal(WIFI_PREFILL_NOTE.unsupported, null);
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

test('every state has a note entry, and every dead end says you can type it', () => {
    const states = [
        'unsupported',
        'offer',
        'ready',
        'filled',
        'no-wifi',
        'denied',
        'blocked',
        'unavailable',
    ];
    for (const state of states) {
        assert.ok(state in WIFI_PREFILL_NOTE, `no note entry for ${state}`);
    }
    assert.equal(Object.keys(WIFI_PREFILL_NOTE).length, states.length);

    // THE PROMISE OF THIS FEATURE IS THAT IT IS NEVER A DEAD END. Wherever the
    // automatic path is closed, the copy has to point at the field.
    for (const state of ['no-wifi', 'denied', 'blocked', 'unavailable']) {
        assert.match(
            WIFI_PREFILL_NOTE[state],
            /type/i,
            `the ${state} note does not tell the user they can type the name instead`
        );
    }
});
