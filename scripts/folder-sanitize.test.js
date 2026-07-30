/**
 * Folder / device-path sanitization, plus the LEGACY-KEY load-compat contract.
 *
 * Second half of the file guards the keys whose Settings UI was deleted with the
 * article pipeline and the wallpaper gallery (articleFolder, noteFolder,
 * useDateFolders, includeImagesInArticles, hideAiWallpapers,
 * hideSensitiveWallpapers). They still sit in DEFAULTS and still have coercions,
 * because the persisted blob is unversioned and has no migration hook.
 *
 * These now import the REAL functions from src/services/settings.ts. The file
 * previously re-declared `sanitizeFolderName` inline "to avoid TS import
 * issues", which meant it kept passing green against a stale copy no matter what
 * the shipped implementation did — the exact trap this suite exists to catch.
 * The tsx loader resolves the extensionless .ts import fine.
 *
 * Run:  node --import tsx --test scripts/folder-sanitize.test.js
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
    DEFAULTS,
    normalizeSettings,
    sanitizeFolderName,
    sanitizeDevicePath,
} from '../src/services/settings';

/**
 * Mirrors the `sanitizeFolderName(...) || DEFAULTS.x` shape normalizeSettings
 * applies to the two LEGACY folder keys. Settings renders no field for either
 * any more, so this is load-compat behaviour now, not live input handling —
 * which is exactly why it needs pinning: nothing in the UI would show it broken.
 */
const sanitizeOrDefault = (raw) => sanitizeFolderName(raw) || DEFAULTS.articleFolder;

test('sanitizeFolderName: user-typed folder names', () => {
    const cases = [
        ['send-to-x4', 'send-to-x4'],
        ['My Articles', 'My-Articles'],
        ['my/folder', 'myfolder'],          // flattened to one segment on purpose
        ['..', DEFAULTS.articleFolder],     // traversal -> default
        ['.', DEFAULTS.articleFolder],      // traversal -> default
        ['   ', DEFAULTS.articleFolder],    // whitespace-only -> default
        ['', DEFAULTS.articleFolder],       // empty -> default
        ['a'.repeat(80), 'a'.repeat(60)],   // capped at 60
        ['hello!@#world', 'helloworld'],
        ['  --spaced--  ', 'spaced'],
        ['my..folder', 'my..folder'],       // dots mid-name -> allowed
        ['back\\slash', 'backslash'],
    ];

    for (const [input, expected] of cases) {
        assert.equal(
            sanitizeOrDefault(input),
            expected,
            `sanitizeFolderName(${JSON.stringify(input)})`
        );
    }
});

test('sanitizeFolderName: a leading dot survives (but do not depend on it)', () => {
    // R7 in the context map claimed this function strips leading dots, which
    // would silently rewrite '.love-notes' -> 'love-notes'. It does not, and this
    // pins that. Device-reserved paths still must not route through here — this
    // function serves user input and is free to get stricter; sanitizeDevicePath
    // is the one with the dot-folder guarantee.
    assert.equal(sanitizeFolderName('.inbox'), '.inbox');
    assert.equal(sanitizeFolderName('.love-notes'), '.love-notes');
});

test('sanitizeDevicePath: firmware dot-folders survive intact', () => {
    // These two literals are what the firmware opens. A sanitizer that eats the
    // leading dot writes to a folder the reader never looks in, and the failure
    // is silent: the upload succeeds and nothing appears on screen.
    assert.equal(sanitizeDevicePath('.love-notes'), '.love-notes');
    assert.equal(sanitizeDevicePath('.sleep'), '.sleep');
});

test('sanitizeDevicePath: root-relative normalization', () => {
    // uploadToCrossPoint builds the '/${folder}' prefix itself, so the result
    // must never carry its own leading or trailing separator.
    assert.equal(sanitizeDevicePath('/.love-notes'), '.love-notes');
    assert.equal(sanitizeDevicePath('/.love-notes/'), '.love-notes');
    assert.equal(sanitizeDevicePath('//.sleep//'), '.sleep');
});

test('sanitizeDevicePath: nesting survives, traversal does not', () => {
    assert.equal(sanitizeDevicePath('.sleep/rotation'), '.sleep/rotation');
    assert.equal(sanitizeDevicePath('books\\inbox'), 'books/inbox');
    assert.equal(sanitizeDevicePath('.sleep/../secret'), '.sleep/secret');
    assert.equal(sanitizeDevicePath('../../etc'), 'etc');
    assert.equal(sanitizeDevicePath('..'), '');
    assert.equal(sanitizeDevicePath('.'), '');
});

test('sanitizeDevicePath: empty result means SD root, not failure', () => {
    // The permanent wallpaper lives at /sleep.bmp in the SD root, and
    // uploadToCrossPoint treats '' as exactly that target.
    assert.equal(sanitizeDevicePath(''), '');
    assert.equal(sanitizeDevicePath('   '), '');
    assert.equal(sanitizeDevicePath('/'), '');
});

test('sanitizeDevicePath: per-segment character and length rules', () => {
    assert.equal(sanitizeDevicePath('my folder'), 'my-folder');
    assert.equal(sanitizeDevicePath('weird!@#name'), 'weird-name');
    assert.equal(sanitizeDevicePath('a'.repeat(80)), 'a'.repeat(60));
});

test('DEFAULTS carries the messenger role fields', () => {
    // ConnectionProvider seeds its state from this same object; if a field is
    // missing here the first render (before getSettings resolves) sees undefined
    // and a client briefly gets host-only tabs.
    assert.equal(DEFAULTS.role, 'host');
    assert.equal(DEFAULTS.apSsid, 'CrossPoint-Reader');
    assert.equal(DEFAULTS.pairingSecret, '');
    assert.equal(DEFAULTS.mailboxUrl, '');
    assert.equal(DEFAULTS.crossPointIp, 'crosspoint.local');

    // The stock-firmware fork is gone; nothing should reintroduce these.
    assert.equal('firmwareType' in DEFAULTS, false);
    assert.equal('stockIp' in DEFAULTS, false);
});

/** The article/notes/wallpaper-filter keys whose UI was deleted but whose
 *  persisted values live on. Order matches the LEGACY block in settings.ts. */
const LEGACY_KEYS = [
    'articleFolder',
    'noteFolder',
    'useDateFolders',
    'includeImagesInArticles',
    'hideAiWallpapers',
    'hideSensitiveWallpapers',
];

test('DEFAULTS still carries the legacy keys whose UI was removed', () => {
    // R8 (PERSISTENCE CONTRACT, src/types/index.ts): the blob is unversioned
    // with no migration hook. Settings no longer renders a control for any of
    // these — the article pipeline and the wallpaper gallery they configured are
    // both gone — but an install that already wrote them hands them back on
    // every load, and normalizeSettings still coerces the two folder keys.
    // Deleting one from DEFAULTS while its `|| DEFAULTS.x` fallback survives
    // resolves that tail to undefined, so the field is persisted as undefined
    // while its type still claims `string`. Remove key and coercion together, or
    // neither — this is the only place that pairing can fail loudly.
    for (const key of LEGACY_KEYS) {
        assert.equal(key in DEFAULTS, true, `DEFAULTS.${key} (legacy load-compat)`);
    }
});

test('normalizeSettings: a legacy blob cannot throw on the folder keys', () => {
    // These are the shapes a hand-edited or older blob really produces. Before
    // the coercion existed, `.trim()` on any non-string here threw inside
    // getSettings — and getSettings swallows the error and returns DEFAULTS, so
    // the user just found their settings reset with no message.
    for (const raw of [undefined, null, 0, 42, true, {}, [], '..', '.', '   ', 'my/folder']) {
        const out = normalizeSettings({ ...DEFAULTS, articleFolder: raw, noteFolder: raw });
        assert.equal(typeof out.articleFolder, 'string', `articleFolder for ${JSON.stringify(raw)}`);
        assert.equal(typeof out.noteFolder, 'string', `noteFolder for ${JSON.stringify(raw)}`);
        // A blank result would be persisted and then joined into a device path,
        // so the fallback must land on a real name, not ''.
        assert.ok(out.articleFolder.length > 0, `articleFolder blank for ${JSON.stringify(raw)}`);
        assert.ok(out.noteFolder.length > 0, `noteFolder blank for ${JSON.stringify(raw)}`);
    }
});

test('normalizeSettings: the removed-UI keys pass through untouched', () => {
    // Settings.handleSave spreads the loaded settings, so a value an older build
    // wrote must survive a save round-trip rather than being normalized away or
    // reset — the user cannot see or re-set any of these any more.
    const legacy = {
        ...DEFAULTS,
        useDateFolders: true,
        includeImagesInArticles: true,
        hideAiWallpapers: true,
        hideSensitiveWallpapers: true,
    };
    const out = normalizeSettings(legacy);
    assert.equal(out.useDateFolders, true);
    assert.equal(out.includeImagesInArticles, true);
    assert.equal(out.hideAiWallpapers, true);
    assert.equal(out.hideSensitiveWallpapers, true);
});

test('normalizeSettings: unknown keys from an older install ride along', () => {
    // The same spread that carries the legacy keys is what lets a key removed
    // from the Settings interface (firmwareType, stockIp) stay harmless.
    const out = normalizeSettings({ ...DEFAULTS, firmwareType: 'stock', stockIp: '192.168.4.1' });
    assert.equal(out.firmwareType, 'stock');
    assert.equal(out.stockIp, '192.168.4.1');
});
