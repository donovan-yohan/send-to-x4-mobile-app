/**
 * wallpaper_sender + promote — naming, destination, and the failure paths a
 * device cannot tell you about.
 *
 * WHAT IS ACTUALLY AT RISK HERE. Everything on this path is silent when it goes
 * wrong: the reader shows the OLD wallpaper, or nothing, and reports no error to
 * the phone. There is no read-back. So the things worth pinning are the ones
 * whose failure looks exactly like success:
 *
 *   - `/sleep.bmp` at the SD ROOT vs `/.sleep/<n>.bmp` in the dot-folder. Get
 *     the folder wrong and the upload SUCCEEDS into a directory the firmware
 *     never reads (R7: a stripped leading dot writes `/sleep/`, which is a
 *     different, unrelated folder from `/.sleep`).
 *   - DELETE BEFORE UPLOAD. The firmware refuses to overwrite an existing path
 *     ('ERROR: File already exists', proven on hardware 2026-07-28) and writes
 *     nothing. Both destinations are re-written under a name they have held
 *     before, so without a pre-delete the feature works exactly once per name
 *     and then fails with the OLD picture still on the panel. `fakeDevice`
 *     enforces that rejection; the plain `fakeTransport` does not, which is
 *     precisely why this defect was invisible here.
 *   - Names derived from a history-record id. If two records can produce one
 *     filename, promoting note B silently overwrites note A's wallpaper and the
 *     rotation quietly shrinks.
 *   - A '/' surviving into a name. `sanitizeDevicePath` keeps nesting, so an
 *     unchecked 'a/b' would escape `/.sleep` entirely.
 *   - Promoting a row whose picture is gone. That is EXPECTED input (text notes
 *     never had one), so it has to be a clean result, not a rejection thrown
 *     into a list render.
 *   - The FRAMING a promote asks the encoder for. A canvas note's source is the
 *     PORTRAIT compose capture; framed 'natural' it becomes a portrait bmp for a
 *     landscape panel, and the firmware crops it by a rule with no preview and
 *     no read-back.
 *   - The name a delete goes out under. `/.sleep` is shared with the firmware's
 *     own sleep-cover writer, so an entry can be reported percent-encoded; the
 *     decoded form names no file, and a delete of nothing reports success.
 *   - Whether `/sleep.bmp` is actually at the SD root afterwards. That join is
 *     the firmware's, from an EMPTY folder, and has never been observed on
 *     hardware — so the app reads the root listing back.
 *
 * The transport is reached through `__setWallpaperTransport`, and the encoder
 * through `__setWallpaperPrepare`, so all of the above runs under node against
 * the real modules. NOTHING here touches the network.
 *
 * Run:  node --import tsx --test scripts/wallpaper-sender.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    SLEEP_MODE_HINT,
    SLEEP_ROOT_FILENAME,
    SLEEP_SET_DIR,
    SLEEP_SET_FOLDER,
    deleteSleepSetEntry,
    isSafeSleepSetName,
    listSleepSet,
    resolveWallpaperTarget,
    sanitizeSleepSetName,
    sendWallpaperBmp,
    sleepSetNameForId,
    verifyPrimaryWallpaper,
    __setWallpaperTransport,
} from '../src/services/wallpaper_sender';
import {
    canPromoteRecord,
    promoteRecordToWallpaper,
    wallpaperOptionsForRecord,
    __setWallpaperPrepare,
} from '../src/services/promote';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal payload that passes the 'BM' magic check. Content is irrelevant. */
function fakeBmp(byteLength = 64) {
    const bytes = new Uint8Array(byteLength);
    bytes[0] = 0x42; // 'B'
    bytes[1] = 0x4d; // 'M'
    return bytes;
}

/**
 * Recording stand-in for crosspoint_upload.
 *
 * Captures the exact (filename, targetFolder) pair, because that pair IS the
 * destination — `uploadToCrossPoint` builds `/${targetFolder}` itself, so a test
 * that only checked a joined string could not tell '' (SD root) apart from '/'.
 */
function fakeTransport({ uploadResult = { success: true }, deleteResult = true } = {}) {
    const calls = { uploads: [], deletes: [], ops: [] };
    const transport = {
        async upload(ip, data, filename, onProgress, targetFolder) {
            calls.uploads.push({ ip, byteLength: data.byteLength, filename, targetFolder });
            calls.ops.push(`upload:/${targetFolder ? `${targetFolder}/` : ''}${filename}`);
            if (onProgress) onProgress(100);
            if (typeof uploadResult === 'function') return uploadResult();
            return uploadResult;
        },
        async deleteFile(ip, filename, targetFolder) {
            calls.deletes.push({ ip, filename, targetFolder });
            calls.ops.push(`delete:/${targetFolder ? `${targetFolder}/` : ''}${filename}`);
            if (typeof deleteResult === 'function') return deleteResult();
            return deleteResult;
        },
    };
    __setWallpaperTransport(transport);
    return calls;
}

/**
 * A transport that behaves like the CROSSPOINT FIRMWARE, not like a stub.
 *
 * THE ONE RULE THAT MATTERS: the firmware REFUSES to overwrite an existing path
 * — it answers `ERROR: File already exists` and writes NOTHING (proven on the
 * physical X3, 2026-07-28). Every other fake in this file accepts an upload
 * unconditionally, which is exactly why a missing delete was invisible here for
 * as long as it was. `scripts/send_frame.mjs --self-test`'s mock (T7/T7b/T7c)
 * enforces the same rejection for the love-note path; this is its counterpart
 * for the wallpaper path.
 *
 * `deleteFile` mirrors `deleteCrossPointFile`: true only when something was
 * actually removed, FALSE for a path that was not there — the ordinary
 * first-send case, which the sender must not treat as fatal.
 */
function fakeDevice({ existing = [] } = {}) {
    const card = new Map(existing.map(path => [path, 0]));
    const calls = { uploads: [], deletes: [], ops: [] };
    const pathFor = (folder, filename) => `/${folder ? `${folder}/` : ''}${filename}`;

    __setWallpaperTransport({
        async upload(ip, data, filename, onProgress, targetFolder) {
            const path = pathFor(targetFolder, filename);
            calls.uploads.push({ ip, byteLength: data.byteLength, filename, targetFolder, path });
            calls.ops.push(`upload:${path}`);
            if (card.has(path)) {
                // Byte-for-byte what the firmware sends back over the WS.
                return { success: false, error: 'ERROR: File already exists' };
            }
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

    return {
        calls,
        /** What is on the card right now, as absolute paths. */
        paths: () => [...card.keys()].sort(),
        sizeOf: path => card.get(path),
    };
}

function record(overrides = {}) {
    return {
        id: 'm4x1-2-ab12cd',
        createdAt: 1_700_000_000_000,
        kind: 'photo',
        status: 'sent',
        thumbnailPngBase64: 'AAECAw==',
        sourceUri: 'file:///tmp/note.jpg',
        ...overrides,
    };
}

/** Silence a module's console.warn for the duration of `fn`. */
async function muted(fn) {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.join(' '));
    try {
        return await fn(lines);
    } finally {
        console.warn = original;
    }
}

afterEach(() => {
    __setWallpaperTransport(null);
    __setWallpaperPrepare(null);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('the dot-folder survives into the folder argument the transport receives', () => {
    assert.equal(SLEEP_SET_DIR, '/.sleep');
    // Root-relative and dot INTACT. '/.sleep' would make uploadToCrossPoint
    // build '//.sleep', and 'sleep' would silently address a different folder.
    assert.equal(SLEEP_SET_FOLDER, '.sleep');
    assert.equal(SLEEP_ROOT_FILENAME, 'sleep.bmp');
});

test('the sleep-mode hint names the on-device setting the app cannot change', () => {
    assert.match(SLEEP_MODE_HINT, /custom/i);
    assert.ok(SLEEP_MODE_HINT.length > 0);
});

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

test('sanitizeSleepSetName enforces exactly one .bmp suffix, case-insensitively', () => {
    assert.equal(sanitizeSleepSetName('holiday'), 'holiday.bmp');
    assert.equal(sanitizeSleepSetName('holiday.bmp'), 'holiday.bmp');
    // Idempotent: a careful caller must not be able to produce 'x.bmp.bmp'.
    assert.equal(sanitizeSleepSetName(sanitizeSleepSetName('holiday')), 'holiday.bmp');
    // The firmware scans for a lowercase extension.
    assert.equal(sanitizeSleepSetName('holiday.BMP'), 'holiday.bmp');
    assert.equal(sanitizeSleepSetName('holiday.Bmp'), 'holiday.bmp');
});

test('sanitizeSleepSetName REJECTS separators instead of flattening them', () => {
    // Flattening 'a/b.bmp' to 'ab.bmp' would rename one file to another file's
    // name; keeping the nesting would escape /.sleep. Neither is acceptable.
    assert.equal(sanitizeSleepSetName('a/b.bmp'), '');
    assert.equal(sanitizeSleepSetName('a\\b.bmp'), '');
    assert.equal(sanitizeSleepSetName('../../sleep.bmp'), '');
    assert.equal(sanitizeSleepSetName('/etc/passwd'), '');
    assert.equal(sanitizeSleepSetName('sub/dir/x'), '');
});

test('sanitizeSleepSetName rejects names that reduce to nothing', () => {
    assert.equal(sanitizeSleepSetName(''), '');
    assert.equal(sanitizeSleepSetName('   '), '');
    assert.equal(sanitizeSleepSetName('.bmp'), '');
    assert.equal(sanitizeSleepSetName('.'), '');
    assert.equal(sanitizeSleepSetName('..'), '');
    assert.equal(sanitizeSleepSetName('\u0001'), '', 'control character');
    assert.equal(sanitizeSleepSetName(null), '');
    assert.equal(sanitizeSleepSetName(undefined), '');
    assert.equal(sanitizeSleepSetName(42), '');
});

test('sanitizeSleepSetName normalizes charset without changing identity', () => {
    assert.equal(sanitizeSleepSetName('my photo'), 'my-photo.bmp');
    assert.equal(sanitizeSleepSetName('café ☀'), 'caf-.bmp');
    // A dot-prefixed name stays dot-prefixed: sanitizeDevicePath is the pinned
    // dot-preserving sanitizer, which is the whole reason it is used here.
    assert.equal(sanitizeSleepSetName('.hidden'), '.hidden.bmp');
});

test('sanitizeSleepSetName output stays inside the 60-char segment cap', () => {
    const long = 'x'.repeat(500);
    const name = sanitizeSleepSetName(long);
    assert.ok(name.endsWith('.bmp'));
    // sanitizeDevicePath caps the STEM at 60; '.bmp' rides on top of that.
    assert.equal(name.length, 64);
});

// ---------------------------------------------------------------------------
// Device-supplied names (delete path)
// ---------------------------------------------------------------------------

test('isSafeSleepSetName validates without rewriting', () => {
    // A file another tool put in /.sleep must be deletable under its REAL name.
    assert.equal(isSafeSleepSetName('my photo.bmp'), true);
    assert.equal(isSafeSleepSetName('note-abc.bmp'), true);
    assert.equal(isSafeSleepSetName('UPPER.BMP'), true);

    assert.equal(isSafeSleepSetName('note.txt'), false, 'wrong extension');
    assert.equal(isSafeSleepSetName('.bmp'), false, 'no stem');
    assert.equal(isSafeSleepSetName('../x.bmp'), false, 'traversal');
    assert.equal(isSafeSleepSetName('a/b.bmp'), false, 'separator');
    assert.equal(isSafeSleepSetName('a\\b.bmp'), false, 'separator');
    assert.equal(isSafeSleepSetName(' pad.bmp'), false, 'untrimmed');
    assert.equal(isSafeSleepSetName('x\u0007.bmp'), false, 'control char');
    assert.equal(isSafeSleepSetName(''), false);
    assert.equal(isSafeSleepSetName(null), false);
});

test('every name this module mints round-trips through the delete validator', () => {
    // The property that matters operationally: list -> delete of OUR OWN files
    // must always work, or a promoted note can be created and never removed.
    for (const raw of ['holiday', 'my photo', '.hidden', 'x'.repeat(500), 'café']) {
        const minted = sanitizeSleepSetName(raw);
        assert.ok(minted, `expected a name for ${JSON.stringify(raw)}`);
        assert.equal(isSafeSleepSetName(minted), true, `not deletable: ${minted}`);
    }
});

// ---------------------------------------------------------------------------
// Id-derived names
// ---------------------------------------------------------------------------

test('sleepSetNameForId is deterministic, so re-promoting replaces its own entry', () => {
    const a = sleepSetNameForId('m4x1-2-ab12cd');
    const b = sleepSetNameForId('m4x1-2-ab12cd');
    assert.equal(a, b);
    assert.ok(a.endsWith('.bmp'));
    assert.equal(isSafeSleepSetName(a), true);
});

test('sleepSetNameForId keeps distinct ids distinct even when sanitization collides', () => {
    // Sanitization is lossy: every character outside [A-Za-z0-9._-] becomes '-'
    // and runs collapse, so these three ids share one sanitized stem. Without a
    // hash of the RAW id, promoting the second note would overwrite the first.
    const ids = ['a b', 'a@b', 'a###b'];
    const names = ids.map(sleepSetNameForId);
    assert.equal(new Set(names).size, ids.length, `collided: ${names.join(', ')}`);
});

test('sleepSetNameForId keeps distinct LONG ids distinct past the truncation point', () => {
    // The stem is truncated; two ids identical for the first 100 chars would
    // produce one filename if the hash were computed after truncation.
    const shared = 'z'.repeat(100);
    const names = [sleepSetNameForId(`${shared}-one`), sleepSetNameForId(`${shared}-two`)];
    assert.notEqual(names[0], names[1]);
    for (const name of names) {
        assert.ok(name.length <= 64, `${name} is ${name.length} chars`);
        assert.equal(isSafeSleepSetName(name), true);
    }
});

test('sleepSetNameForId still yields a usable name for an unusable id', () => {
    // A blob written by another build can carry any id at all; the History tab
    // must not end up with a row whose only action is impossible.
    for (const id of ['', '   ', '///', '☀☀', null, undefined]) {
        const name = sleepSetNameForId(id);
        assert.ok(name.endsWith('.bmp'), `no name for ${JSON.stringify(id)}`);
        assert.equal(isSafeSleepSetName(name), true);
    }
});

// ---------------------------------------------------------------------------
// Target -> path mapping
// ---------------------------------------------------------------------------

test("target 'primary' resolves to sleep.bmp at the SD ROOT, not a folder", () => {
    const resolved = resolveWallpaperTarget({ kind: 'primary' });
    assert.deepEqual(resolved, {
        folder: '', // '' is the SD root in uploadToCrossPoint's vocabulary
        filename: 'sleep.bmp',
        path: '/sleep.bmp',
    });
});

test("target 'set' resolves into the dot-folder with a sanitized name", () => {
    assert.deepEqual(resolveWallpaperTarget({ kind: 'set', name: 'my photo' }), {
        folder: '.sleep',
        filename: 'my-photo.bmp',
        path: '/.sleep/my-photo.bmp',
    });
});

test('resolveWallpaperTarget refuses an unusable set name and an unknown kind', () => {
    assert.equal(resolveWallpaperTarget({ kind: 'set', name: '../escape' }), null);
    assert.equal(resolveWallpaperTarget({ kind: 'set', name: '' }), null);
    assert.equal(resolveWallpaperTarget({ kind: 'nope' }), null);
    assert.equal(resolveWallpaperTarget(null), null);
});

// ---------------------------------------------------------------------------
// sendWallpaperBmp
// ---------------------------------------------------------------------------

test('sendWallpaperBmp hands the primary target an EMPTY folder', async () => {
    const calls = fakeTransport();
    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });

    assert.deepEqual(result, { success: true });
    assert.equal(calls.uploads.length, 1);
    assert.deepEqual(calls.uploads[0], {
        ip: '10.0.0.5',
        byteLength: 64,
        filename: 'sleep.bmp',
        // NOT 'sleep' and NOT '/': uploadToCrossPoint prefixes '/' itself, and
        // 'sleep' would create a real folder the firmware does not read.
        targetFolder: '',
    });
});

test('sendWallpaperBmp hands the set target the dot-folder', async () => {
    const calls = fakeTransport();
    await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'set', name: 'Holiday Snap.BMP' });

    assert.deepEqual(calls.uploads[0], {
        ip: '10.0.0.5',
        byteLength: 64,
        // Case is preserved in the STEM (a rotation entry is something the
        // user reads in a list); only the extension is normalized.
        filename: 'Holiday-Snap.bmp',
        targetFolder: '.sleep',
    });
});

test('sendWallpaperBmp forwards progress', async () => {
    fakeTransport();
    const seen = [];
    await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' }, p => seen.push(p));
    assert.deepEqual(seen, [100]);
});

test('sendWallpaperBmp rejects a payload that is not a BMP, without uploading', async () => {
    const calls = fakeTransport();

    // The exact confusion this guard exists for: a 52272-byte love-note frame.
    const frame = new Uint8Array(52272);
    const result = await sendWallpaperBmp('10.0.0.5', frame, { kind: 'primary' });

    assert.equal(result.success, false);
    assert.match(result.error, /BM/);
    assert.equal(calls.uploads.length, 0, 'a non-BMP must never reach the device');

    assert.equal((await sendWallpaperBmp('10.0.0.5', new Uint8Array(0), { kind: 'primary' })).success, false);
    assert.equal((await sendWallpaperBmp('10.0.0.5', null, { kind: 'primary' })).success, false);
    assert.equal(calls.uploads.length, 0);
});

test('sendWallpaperBmp refuses an unusable name rather than inventing one', async () => {
    const calls = fakeTransport();
    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'set', name: '../../x' });

    assert.equal(result.success, false);
    assert.match(result.error, /name/i);
    assert.equal(calls.uploads.length, 0);
});

test('sendWallpaperBmp reports a transport failure in the repo result convention', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'Connection closed unexpectedly' } });
    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });
    assert.deepEqual(result, { success: false, error: 'Connection closed unexpectedly' });
});

test('sendWallpaperBmp NEVER throws, even when the transport does', async () => {
    fakeTransport({
        uploadResult: () => {
            throw new Error('socket exploded');
        },
    });
    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });
    assert.equal(result.success, false);
    assert.equal(result.error, 'socket exploded');
});

test('sendWallpaperBmp degrades to a result when no transport exists at all', async () => {
    // Under node there is no crosspoint_upload to lazy-require; the module must
    // report that rather than throw at import time or on first use.
    __setWallpaperTransport(null);
    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });
    assert.equal(result.success, false);
    assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// sendWallpaperBmp — DELETE BEFORE UPLOAD
//
// The firmware refuses to overwrite an existing path. Both destinations here are
// re-written under a name they have held before (`/sleep.bmp` is one fixed slot;
// promote mints a deterministic `/.sleep/<name>.bmp` per row), so without a
// pre-delete the feature works exactly ONCE per name and then fails with the OLD
// picture still on the card.
// ---------------------------------------------------------------------------

test('sendWallpaperBmp DELETES the target path before uploading it', async () => {
    const calls = fakeTransport();
    await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });

    // Order is the whole point: a delete after the upload clears the file that
    // was just written, and a delete of the wrong path clears nothing.
    assert.deepEqual(calls.ops, ['delete:/sleep.bmp', 'upload:/sleep.bmp']);
    assert.deepEqual(calls.deletes, [
        // Same (filename, folder) pair the upload gets — '' is the SD root.
        { ip: '10.0.0.5', filename: 'sleep.bmp', targetFolder: '' },
    ]);
});

test('sendWallpaperBmp deletes the SET target inside the dot-folder', async () => {
    const calls = fakeTransport();
    await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'set', name: 'Holiday Snap.BMP' });

    // The SANITIZED name, not the raw one: deleting 'Holiday Snap.BMP' would
    // clear nothing and the upload of 'Holiday-Snap.bmp' would still be refused.
    assert.deepEqual(calls.ops, [
        'delete:/.sleep/Holiday-Snap.bmp',
        'upload:/.sleep/Holiday-Snap.bmp',
    ]);
});

test('sendWallpaperBmp never deletes anything it is not about to write', async () => {
    // A bad payload or an unusable name must not clear the wallpaper already on
    // the card — the guard runs first, so nothing is touched at all.
    const calls = fakeTransport();
    await sendWallpaperBmp('10.0.0.5', new Uint8Array(52272), { kind: 'primary' });
    await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'set', name: '../../x' });
    await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'nope' });
    assert.deepEqual(calls.ops, []);
});

test('TWO primary sends both land against a firmware that refuses overwrites', async () => {
    // THE REGRESSION. With no pre-delete the second send comes back
    // 'ERROR: File already exists', nothing is written, and the panel keeps the
    // first picture — i.e. "Set sleep screen" works once per SD card.
    const device = fakeDevice();

    const first = await sendWallpaperBmp('10.0.0.5', fakeBmp(64), { kind: 'primary' });
    const second = await sendWallpaperBmp('10.0.0.5', fakeBmp(128), { kind: 'primary' });

    assert.deepEqual(first, { success: true });
    assert.deepEqual(second, { success: true }, 'the SECOND "Set sleep screen" must also land');
    assert.deepEqual(device.paths(), ['/sleep.bmp']);
    // The bytes on the card are the SECOND picture's, not a stale first write.
    assert.equal(device.sizeOf('/sleep.bmp'), 128);
    assert.deepEqual(device.calls.ops, [
        'delete:/sleep.bmp',
        'upload:/sleep.bmp',
        'delete:/sleep.bmp',
        'upload:/sleep.bmp',
    ]);
});

test('a first send onto an EMPTY card is not failed by the delete finding nothing', async () => {
    // deleteCrossPointFile reports "no such file" as false. Treating that as
    // fatal would make the first-ever wallpaper the one that cannot be sent.
    const device = fakeDevice();
    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });

    assert.deepEqual(result, { success: true });
    assert.equal(device.calls.deletes.length, 1, 'the delete is still attempted');
    assert.deepEqual(device.paths(), ['/sleep.bmp']);
});

test('a send onto a card that ALREADY has the file replaces it', async () => {
    // The realistic upgrade case: a wallpaper put there by an older build of this
    // app, or by the firmware's own sleep-cover writer.
    const device = fakeDevice({ existing: ['/sleep.bmp', '/.sleep/note-x.bmp'] });

    assert.deepEqual(
        await sendWallpaperBmp('10.0.0.5', fakeBmp(256), { kind: 'primary' }),
        { success: true }
    );
    assert.equal(device.sizeOf('/sleep.bmp'), 256);
    // The rotation set is untouched: only the resolved path is cleared.
    assert.deepEqual(device.paths(), ['/.sleep/note-x.bmp', '/sleep.bmp']);
});

test('a delete that FAILS still lets the upload run and report the real error', async () => {
    // Guessing here would replace the firmware's accurate 'File already exists'
    // with a vaguer message of our own.
    fakeTransport({
        deleteResult: () => {
            throw new Error('device rebooted mid-delete');
        },
        uploadResult: { success: false, error: 'ERROR: File already exists' },
    });

    const result = await sendWallpaperBmp('10.0.0.5', fakeBmp(), { kind: 'primary' });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ERROR: File already exists');
});

// ---------------------------------------------------------------------------
// deleteSleepSetEntry
// ---------------------------------------------------------------------------

test('deleteSleepSetEntry passes the name through VERBATIM, in the dot-folder', async () => {
    const calls = fakeTransport();
    // Not a name this module would mint — but it is a name the device can hold,
    // and normalizing it here would delete the wrong file or nothing at all.
    const ok = await deleteSleepSetEntry('10.0.0.5', 'my photo.bmp');

    assert.equal(ok, true);
    assert.deepEqual(calls.deletes, [
        { ip: '10.0.0.5', filename: 'my photo.bmp', targetFolder: '.sleep' },
    ]);
});

test('deleteSleepSetEntry deletes under the RAW name when the listing gave one', async () => {
    const calls = fakeTransport();
    const f = fakeFetch(() => jsonResponse([{ name: 'my%20cover.bmp', size: 700 }]));
    let entry;
    try {
        [entry] = await listSleepSet('10.0.0.5');
    } finally {
        f.restore();
    }

    // The decoded name ('my cover.bmp') matches NO file on the card, and
    // deleteCrossPointFile reports the response's ok whether or not anything was
    // removed — so a decoded delete looks like it worked and the row comes back
    // on the next refresh.
    const ok = await deleteSleepSetEntry('10.0.0.5', entry.name, entry.rawName);

    assert.equal(ok, true);
    assert.deepEqual(calls.deletes, [
        { ip: '10.0.0.5', filename: 'my%20cover.bmp', targetFolder: '.sleep' },
    ]);
});

test('deleteSleepSetEntry falls back to the display name when there is no raw one', async () => {
    const calls = fakeTransport();
    for (const rawName of [undefined, '', '   ']) {
        assert.equal(await deleteSleepSetEntry('10.0.0.5', 'plain.bmp', rawName), true);
    }
    assert.deepEqual(calls.deletes.map(d => d.filename), ['plain.bmp', 'plain.bmp', 'plain.bmp']);
});

test('deleteSleepSetEntry validates the name it actually SENDS', async () => {
    const calls = fakeTransport();
    // A safe display name must not smuggle an unsafe raw name past the guard.
    assert.equal(await deleteSleepSetEntry('10.0.0.5', 'safe.bmp', '../../sleep.bmp'), false);
    assert.equal(await deleteSleepSetEntry('10.0.0.5', 'safe.bmp', 'a/b.bmp'), false);
    assert.equal(calls.deletes.length, 0);
});

test('deleteSleepSetEntry refuses an unsafe name without calling the transport', async () => {
    const calls = fakeTransport();
    for (const name of ['../../sleep.bmp', 'a/b.bmp', '', '.', 'note.txt', null]) {
        assert.equal(await deleteSleepSetEntry('10.0.0.5', name), false, String(name));
    }
    assert.equal(calls.deletes.length, 0);
});

test('deleteSleepSetEntry reports false rather than throwing', async () => {
    fakeTransport({ deleteResult: false });
    assert.equal(await deleteSleepSetEntry('10.0.0.5', 'x.bmp'), false);

    fakeTransport({
        deleteResult: () => {
            throw new Error('nope');
        },
    });
    await muted(async () => {
        assert.equal(await deleteSleepSetEntry('10.0.0.5', 'x.bmp'), false);
    });
});

// ---------------------------------------------------------------------------
// listSleepSet
// ---------------------------------------------------------------------------

/** Install a stub global fetch; returns the URLs it was asked for. */
function fakeFetch(responder) {
    const urls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        urls.push(String(url));
        return responder();
    };
    return {
        urls,
        restore() {
            globalThis.fetch = original;
        },
    };
}

function jsonResponse(body, ok = true) {
    return { ok, async json() { return body; } };
}

test('listSleepSet reads /.sleep and keeps only .bmp files', async () => {
    const f = fakeFetch(() =>
        jsonResponse([
            { name: 'b.bmp', size: 200 },
            { name: 'a.BMP', size: 100 },
            { name: 'notes.txt', size: 10 },
            { name: 'nested', size: 0, isDirectory: true },
            { name: 'olddir', type: 'dir' },
            { size: 5 }, // no name at all
            'garbage',
        ])
    );
    try {
        const entries = await listSleepSet('10.0.0.5');
        // Name order, because /api/files does not promise a timestamp per entry
        // and a reshuffling list makes "delete that one" a hazard.
        assert.deepEqual(entries, [
            { name: 'a.BMP', rawName: 'a.BMP', size: 100 },
            { name: 'b.bmp', rawName: 'b.bmp', size: 200 },
        ]);
        assert.equal(f.urls.length, 1);
        assert.match(f.urls[0], /^http:\/\/10\.0\.0\.5\/api\/files\?path=/);
        // The dot must survive URL encoding: %2F.sleep, not %2Fsleep.
        assert.ok(f.urls[0].includes(encodeURIComponent('/.sleep')), f.urls[0]);
    } finally {
        f.restore();
    }
});

test('listSleepSet keeps the RAW device name alongside the decoded one', async () => {
    // /.sleep is shared: BmpViewerActivity::doSetSleepCover writes into it too,
    // so an entry this app never minted can come back percent-encoded. The
    // decoded form is for the user's eyes; only the raw one names a real file.
    const f = fakeFetch(() =>
        jsonResponse([
            { name: 'my%20cover.bmp', size: 700 },
            { name: '100%25.bmp', size: 10 },
            { name: 'bad%zz.bmp', size: 20 }, // invalid escape: decode must not throw
        ])
    );
    try {
        assert.deepEqual(await listSleepSet('10.0.0.5'), [
            { name: '100%.bmp', rawName: '100%25.bmp', size: 10 },
            { name: 'bad%zz.bmp', rawName: 'bad%zz.bmp', size: 20 },
            { name: 'my cover.bmp', rawName: 'my%20cover.bmp', size: 700 },
        ]);
    } finally {
        f.restore();
    }
});

test('listSleepSet coerces a missing or nonsense size to 0', async () => {
    const f = fakeFetch(() =>
        jsonResponse([
            { name: 'a.bmp' },
            { name: 'b.bmp', size: -1 },
            { name: 'c.bmp', size: 'big' },
            { name: 'd.bmp', size: Number.NaN },
        ])
    );
    try {
        assert.deepEqual(
            (await listSleepSet('10.0.0.5')).map(e => e.size),
            [0, 0, 0, 0]
        );
    } finally {
        f.restore();
    }
});

test('listSleepSet degrades to an empty set on every failure shape', async () => {
    const cases = [
        () => jsonResponse([], false), // HTTP error
        () => jsonResponse({ error: 'nope' }), // not an array
        () => ({ ok: true, async json() { throw new Error('bad json'); } }),
        () => {
            throw new Error('network down');
        },
    ];
    for (const responder of cases) {
        const f = fakeFetch(responder);
        try {
            await muted(async () => {
                assert.deepEqual(await listSleepSet('10.0.0.5'), []);
            });
        } finally {
            f.restore();
        }
    }
});

// ---------------------------------------------------------------------------
// verifyPrimaryWallpaper — the read-back for the one unverified destination
// ---------------------------------------------------------------------------

test('verifyPrimaryWallpaper finds sleep.bmp at the SD root', async () => {
    const f = fakeFetch(() =>
        jsonResponse([
            { name: 'books', isDirectory: true },
            { name: 'sleep.bmp', size: 700000 },
        ])
    );
    try {
        assert.equal(await verifyPrimaryWallpaper('10.0.0.5'), 'present');
        // The root, not the dot-folder.
        assert.ok(f.urls[0].endsWith(`path=${encodeURIComponent('/')}`), f.urls[0]);
    } finally {
        f.restore();
    }
});

test('verifyPrimaryWallpaper reports MISSING when the root listing has no sleep.bmp', async () => {
    // What a bad firmware-side join of ('/', 'sleep.bmp') would look like from
    // here: the upload said success, the file is not where SleepActivity looks.
    const cases = [
        [],
        [{ name: 'sleep.bmp', isDirectory: true }], // a DIRECTORY of that name
        [{ name: '.sleep', type: 'dir' }],
        [{ name: 'sub/sleep.bmp', size: 1 }], // landed under something else
        [{ name: 'sleep.bmpx', size: 1 }],
    ];
    for (const body of cases) {
        const f = fakeFetch(() => jsonResponse(body));
        try {
            assert.equal(
                await verifyPrimaryWallpaper('10.0.0.5'),
                'missing',
                JSON.stringify(body)
            );
        } finally {
            f.restore();
        }
    }
});

test('verifyPrimaryWallpaper tolerates the shapes a listing can legitimately take', async () => {
    const cases = [
        [{ name: 'SLEEP.BMP', size: 1 }], // FAT is case-insensitive
        [{ name: '/sleep.bmp', size: 1 }], // a listing that reports full paths
        [{ name: 'sleep%2Ebmp', size: 1 }], // percent-encoded, like /.sleep entries
    ];
    for (const body of cases) {
        const f = fakeFetch(() => jsonResponse(body));
        try {
            assert.equal(
                await verifyPrimaryWallpaper('10.0.0.5'),
                'present',
                JSON.stringify(body)
            );
        } finally {
            f.restore();
        }
    }
});

test('verifyPrimaryWallpaper says UNKNOWN rather than crying wolf on a bad listing', async () => {
    // A dropped socket is not evidence that the wallpaper is missing, and the
    // bytes already left the phone. Only a listing that was actually READ can
    // contradict the upload.
    const cases = [
        () => jsonResponse([], false),
        () => jsonResponse({ error: 'nope' }),
        () => ({ ok: true, async json() { throw new Error('bad json'); } }),
        () => {
            throw new Error('network down');
        },
    ];
    for (const responder of cases) {
        const f = fakeFetch(responder);
        try {
            await muted(async () => {
                assert.equal(await verifyPrimaryWallpaper('10.0.0.5'), 'unknown');
            });
        } finally {
            f.restore();
        }
    }
});

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

test('canPromoteRecord is false exactly when there is no usable source', () => {
    assert.equal(canPromoteRecord(record()), true);
    assert.equal(canPromoteRecord(record({ sourceUri: undefined })), false);
    assert.equal(canPromoteRecord(record({ sourceUri: '' })), false);
    assert.equal(canPromoteRecord(record({ sourceUri: '   ' })), false);
    assert.equal(canPromoteRecord(null), false);
    assert.equal(canPromoteRecord(undefined), false);
});

test('wallpaperOptionsForRecord frames a CANVAS note to the panel, a photo naturally', () => {
    // A text/doodle source is ComposeScreen's capture of the compose canvas.
    // 'natural' framing would leave the crop to a firmware rule this app cannot
    // preview — the promoted note would not look like the note. 'fit' keeps ALL
    // of it, decided here. The sleep screen is 528x792 PORTRAIT
    // (SleepActivity.cpp:36), so a portrait capture fills it edge to edge.
    assert.deepEqual(wallpaperOptionsForRecord({ kind: 'text' }), { framing: 'panel', fit: 'fit' });
    assert.deepEqual(wallpaperOptionsForRecord({ kind: 'doodle' }), { framing: 'panel', fit: 'fit' });

    // A photo is the user's own picture, of unknown aspect: keep every pixel at
    // ~2x panel resolution and let the firmware's sleep-cover setting frame it.
    assert.deepEqual(wallpaperOptionsForRecord({ kind: 'photo' }), { framing: 'natural' });

    // message_history coerces an unreadable kind to 'photo', but a row from
    // another build must not fall through to no framing at all.
    for (const kind of [undefined, null, 'sticker']) {
        const opts = wallpaperOptionsForRecord({ kind });
        assert.ok(opts.framing === 'panel' || opts.framing === 'natural', String(kind));
    }
    assert.deepEqual(wallpaperOptionsForRecord(null), { framing: 'panel', fit: 'fit' });
});

test('promote hands the encoder the framing its record kind requires', async () => {
    fakeTransport();
    const seen = [];
    __setWallpaperPrepare(async (uri, opts) => {
        seen.push(opts);
        return { bmp: fakeBmp() };
    });

    await promoteRecordToWallpaper('10.0.0.5', record({ kind: 'doodle' }));
    await promoteRecordToWallpaper('10.0.0.5', record({ kind: 'text' }));
    await promoteRecordToWallpaper('10.0.0.5', record({ kind: 'photo' }));

    // `panelPreview: false` rides along on every promote: nothing on this path
    // renders a preview, and the panel-true render is a full Atkinson dither
    // pass over the source. It is added by promoteRecordToWallpaper, NOT by
    // wallpaperOptionsForRecord (pinned bare in the test above).
    assert.deepEqual(seen, [
        { framing: 'panel', fit: 'fit', panelPreview: false },
        { framing: 'panel', fit: 'fit', panelPreview: false },
        { framing: 'natural', panelPreview: false },
    ]);
});

test('promote re-derives from sourceUri and uploads into the rotation', async () => {
    const calls = fakeTransport();
    const seenUris = [];
    __setWallpaperPrepare(async uri => {
        seenUris.push(uri);
        return { bmp: fakeBmp(128) };
    });

    const rec = record();
    const result = await promoteRecordToWallpaper('10.0.0.5', rec);

    assert.equal(result.ok, true);
    // Mirrored discriminant, so History can use the repo's sender convention.
    assert.equal(result.success, true);
    assert.equal(result.name, sleepSetNameForId(rec.id));

    // The ORIGINAL picture, not the stored thumbnail.
    assert.deepEqual(seenUris, ['file:///tmp/note.jpg']);
    assert.deepEqual(calls.uploads, [
        { ip: '10.0.0.5', byteLength: 128, filename: result.name, targetFolder: '.sleep' },
    ]);
});

test('promote NEVER writes the single-slot /sleep.bmp', async () => {
    const calls = fakeTransport();
    __setWallpaperPrepare(async () => ({ bmp: fakeBmp() }));

    await promoteRecordToWallpaper('10.0.0.5', record());

    // Promoting must not evict the wallpaper the host deliberately pinned.
    assert.equal(calls.uploads[0].targetFolder, '.sleep');
    assert.notEqual(calls.uploads[0].filename, SLEEP_ROOT_FILENAME);
});

test('promote is idempotent per record: the same row always lands on one name', async () => {
    const calls = fakeTransport();
    __setWallpaperPrepare(async () => ({ bmp: fakeBmp() }));

    const rec = record();
    await promoteRecordToWallpaper('10.0.0.5', rec);
    await promoteRecordToWallpaper('10.0.0.5', rec);

    assert.equal(calls.uploads[0].filename, calls.uploads[1].filename);
});

test('re-promoting the SAME row REPLACES its entry instead of failing', async () => {
    // promote.ts's header claims the deterministic name makes a second promote a
    // replace. That is only true because sendWallpaperBmp deletes first — against
    // a firmware that refuses overwrites, determinism alone turns the second
    // promote into 'ERROR: File already exists' for a row already in the
    // rotation. This is the test that keeps that paragraph honest.
    const device = fakeDevice();
    let size = 64;
    __setWallpaperPrepare(async () => ({ bmp: fakeBmp((size += 64)) }));

    const rec = record();
    const first = await promoteRecordToWallpaper('10.0.0.5', rec);
    const second = await promoteRecordToWallpaper('10.0.0.5', rec);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true, second.error);
    assert.equal(first.name, second.name);

    // ONE entry in the rotation, holding the SECOND encode.
    const path = `/.sleep/${first.name}`;
    assert.deepEqual(device.paths(), [path]);
    assert.equal(device.sizeOf(path), 192);
    assert.deepEqual(device.calls.ops, [
        `delete:${path}`,
        `upload:${path}`,
        `delete:${path}`,
        `upload:${path}`,
    ]);
});

test('promoting two different rows keeps BOTH in the rotation', async () => {
    // The other half of the same property: the delete must be scoped to the path
    // being written, so promoting row B cannot evict row A.
    const device = fakeDevice();
    __setWallpaperPrepare(async () => ({ bmp: fakeBmp() }));

    const a = await promoteRecordToWallpaper('10.0.0.5', record({ id: 'row-a' }));
    const b = await promoteRecordToWallpaper('10.0.0.5', record({ id: 'row-b' }));

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.deepEqual(device.paths(), [`/.sleep/${a.name}`, `/.sleep/${b.name}`].sort());
});

test('promote gives two different records two different filenames', async () => {
    const calls = fakeTransport();
    __setWallpaperPrepare(async () => ({ bmp: fakeBmp() }));

    await promoteRecordToWallpaper('10.0.0.5', record({ id: 'row a' }));
    await promoteRecordToWallpaper('10.0.0.5', record({ id: 'row@a' }));

    assert.notEqual(calls.uploads[0].filename, calls.uploads[1].filename);
});

test('promote fails cleanly when the record has no sourceUri', async () => {
    const calls = fakeTransport();
    let prepared = false;
    __setWallpaperPrepare(async () => {
        prepared = true;
        return { bmp: fakeBmp() };
    });

    for (const rec of [
        record({ sourceUri: undefined }),
        record({ sourceUri: '' }),
        record({ sourceUri: '   ' }),
        record({ kind: 'text', sourceUri: undefined, text: 'just words' }),
    ]) {
        const result = await promoteRecordToWallpaper('10.0.0.5', rec);
        assert.equal(result.ok, false);
        assert.equal(result.success, false);
        assert.ok(result.error.length > 0);
        // Actionable, not a stack trace: this is normal input.
        assert.match(result.error, /picture/i);
    }

    assert.equal(prepared, false, 'must not attempt to encode without a source');
    assert.equal(calls.uploads.length, 0);
});

test('promote turns an unreadable source into a result, not a rejection', async () => {
    const calls = fakeTransport();
    __setWallpaperPrepare(async () => {
        // What an evicted cache file actually looks like from expo-file-system.
        throw new Error('File does not exist');
    });

    await muted(async () => {
        const result = await promoteRecordToWallpaper('10.0.0.5', record());
        assert.equal(result.ok, false);
        assert.match(result.error, /File does not exist/);
    });
    assert.equal(calls.uploads.length, 0);
});

test('promote rejects an empty encode result instead of uploading zero bytes', async () => {
    const calls = fakeTransport();
    __setWallpaperPrepare(async () => ({ bmp: new Uint8Array(0) }));

    const result = await promoteRecordToWallpaper('10.0.0.5', record());
    assert.equal(result.ok, false);
    assert.equal(calls.uploads.length, 0);
});

test('promote surfaces the upload error verbatim', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'Cannot reach X4.' } });
    __setWallpaperPrepare(async () => ({ bmp: fakeBmp() }));

    const result = await promoteRecordToWallpaper('10.0.0.5', record());
    assert.equal(result.ok, false);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Cannot reach X4.');
});

test('promote handles a missing record and a missing encoder without throwing', async () => {
    fakeTransport();

    __setWallpaperPrepare(async () => ({ bmp: fakeBmp() }));
    assert.equal((await promoteRecordToWallpaper('10.0.0.5', null)).ok, false);

    // No image_converter to lazy-require (node): a result, not an import crash.
    __setWallpaperPrepare(null);
    const result = await promoteRecordToWallpaper('10.0.0.5', record());
    assert.equal(result.ok, false);
    assert.ok(result.error);
});
