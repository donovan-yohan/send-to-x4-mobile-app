/**
 * Role accessor — the single gate deciding whether host-only UI (Wallpaper,
 * Device tabs) renders.
 *
 * Settings are an UNVERSIONED AsyncStorage blob loaded as
 * `{ ...DEFAULTS, ...JSON.parse(stored) }`, so a pre-role install, a truncated
 * write or a hand-edited blob can hand this module anything at all. The failure
 * that matters is a client being shown host-only surfaces, so every unreadable
 * value must resolve to a definite Role rather than leaking undefined.
 *
 * Run:  node --import tsx --test scripts/role.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import { DEFAULT_ROLE, asRole, getRole, isHost } from '../src/services/role';

test('DEFAULT_ROLE is host', () => {
    // Single-device setup this fork ships with today.
    assert.equal(DEFAULT_ROLE, 'host');
});

test('asRole passes through the two valid roles', () => {
    assert.equal(asRole('host'), 'host');
    assert.equal(asRole('client'), 'client');
});

test('asRole coerces anything else to the default', () => {
    for (const bad of [undefined, null, '', 'Host', 'HOST', 'admin', 0, 1, true, {}, []]) {
        assert.equal(asRole(bad), DEFAULT_ROLE, `asRole(${JSON.stringify(bad)})`);
    }
});

test('getRole reads Settings.role', () => {
    assert.equal(getRole({ role: 'client' }), 'client');
    assert.equal(getRole({ role: 'host' }), 'host');
});

test('getRole tolerates missing settings and pre-role blobs', () => {
    assert.equal(getRole(null), DEFAULT_ROLE);
    assert.equal(getRole(undefined), DEFAULT_ROLE);
    assert.equal(getRole({}), DEFAULT_ROLE);            // field never written
    assert.equal(getRole({ role: 'partner' }), DEFAULT_ROLE); // value outside the union
});

test('isHost gates host-only UI', () => {
    assert.equal(isHost({ role: 'host' }), true);
    assert.equal(isHost({ role: 'client' }), false);
    // Unreadable role falls back to host — matching DEFAULT_ROLE. If that
    // default is ever flipped to 'client' (fail-closed), this assertion is the
    // one that must be revisited.
    assert.equal(isHost({}), true);
    assert.equal(isHost(null), true);
});
