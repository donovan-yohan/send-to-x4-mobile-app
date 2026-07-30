/**
 * Device host normalization + the default fallback that guards it.
 *
 * The failure this pins is silent and total: normalizeDeviceHost strips the
 * scheme and then takes split('/')[0], so several non-empty inputs ('/',
 * 'http://', 'https://', 'http:///') reduce to ''. When the DEFAULTS fallback
 * was applied INSIDE the call — `normalizeDeviceHost(trimmed || DEFAULT)` — it
 * only caught input that was already blank, and those four persisted an empty
 * crossPointIp. getDeviceBaseUrl then produced 'http://' and every device call
 * went to 'http:///api/files'.
 *
 * Run:  node --import tsx --test scripts/device-host.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    DEFAULTS,
    normalizeSettings,
    normalizeDeviceHost,
    getDeviceBaseUrl,
    getCurrentIp,
} from '../src/services/settings';

/** The inputs that reduce to '' — the whole point of the fallback. */
const REDUCES_TO_EMPTY = ['', '   ', '/', '//', 'http://', 'https://', 'http:///', 'HTTP://'];

test('normalizeDeviceHost: these inputs really do reduce to empty', () => {
    // Precondition for the test below. If this ever stops holding, the fallback
    // ordering stops mattering — and this assertion is where you find that out.
    for (const raw of REDUCES_TO_EMPTY) {
        assert.equal(normalizeDeviceHost(raw), '', `normalizeDeviceHost(${JSON.stringify(raw)})`);
    }
});

test('normalizeDeviceHost: real hosts survive scheme and path stripping', () => {
    assert.equal(normalizeDeviceHost('crosspoint.local'), 'crosspoint.local');
    assert.equal(normalizeDeviceHost('http://192.168.1.5'), '192.168.1.5');
    assert.equal(normalizeDeviceHost('https://192.168.1.5/api/files'), '192.168.1.5');
    assert.equal(normalizeDeviceHost('  crosspoint.local  '), 'crosspoint.local');
});

test('normalizeSettings: an empty-after-normalization host falls back to the default', () => {
    for (const raw of REDUCES_TO_EMPTY) {
        const out = normalizeSettings({ ...DEFAULTS, crossPointIp: raw });
        assert.equal(
            out.crossPointIp,
            DEFAULTS.crossPointIp,
            `normalizeSettings({ crossPointIp: ${JSON.stringify(raw)} })`
        );
    }
});

test('normalizeSettings: non-string hosts fall back rather than throwing', () => {
    // Settings are an unversioned, hand-editable AsyncStorage blob.
    for (const raw of [undefined, null, 0, 42, true, {}, []]) {
        const out = normalizeSettings({ ...DEFAULTS, crossPointIp: raw });
        assert.equal(out.crossPointIp, DEFAULTS.crossPointIp, `crossPointIp: ${JSON.stringify(raw)}`);
    }
});

test('normalizeSettings: a valid host is not replaced by the default', () => {
    assert.equal(normalizeSettings({ ...DEFAULTS, crossPointIp: '192.168.4.1' }).crossPointIp, '192.168.4.1');
    assert.equal(normalizeSettings({ ...DEFAULTS, crossPointIp: 'http://10.0.0.7/x' }).crossPointIp, '10.0.0.7');
});

test('getDeviceBaseUrl can never be the bare scheme after normalization', () => {
    // The user-visible symptom of the bug: 'http://' + '' -> requests to 'http:///api/files'.
    for (const raw of REDUCES_TO_EMPTY) {
        const s = normalizeSettings({ ...DEFAULTS, crossPointIp: raw });
        const url = getDeviceBaseUrl(getCurrentIp(s));
        assert.notEqual(url, 'http://', `getDeviceBaseUrl for ${JSON.stringify(raw)}`);
        assert.equal(url, `http://${DEFAULTS.crossPointIp}`);
    }
});
