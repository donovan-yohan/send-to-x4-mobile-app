/**
 * epub_sender — the library-upload path, and the four ways it can fail silently.
 *
 * WHAT IS ACTUALLY AT RISK HERE:
 *
 *   - THE DESTINATION. The firmware has no `/books`: `FileBrowserActivity` walks
 *     the SD root and offers a file by EXTENSION alone, skipping any name that
 *     starts with '.' unless `showHiddenFiles` is on. So a hidden or empty target
 *     folder uploads perfectly and produces a book neither the reader's browser
 *     nor DeviceScreen's Articles scan can see. `resolveLibraryFolder` is pinned
 *     against both.
 *
 *   - THE EXTENSION. It is the ENTIRE contract with the firmware
 *     (`FsHelpers::hasEpubExtension`), and `crosspoint_upload.listCrossPointFiles`
 *     filters with a case-SENSITIVE `.endsWith('.epub')` — so a `.EPUB` upload is
 *     a real file that half the app cannot list. Every name that leaves here ends
 *     in lowercase `.epub`.
 *
 *   - DELETE BEFORE UPLOAD. Re-read on the firmware 2026-07-29: the `START:`
 *     frame is refused with `ERROR:File already exists` and NOTHING is written
 *     when the path is already on the card. Re-sending a book the reader already
 *     has is the ordinary case, so `fakeDevice` enforces that rejection exactly
 *     as `wallpaper-sender.test.js`'s does; the permissive `fakeTransport` cannot
 *     see this class of bug, which is why both exist.
 *
 *   - SANITIZATION COLLISIONS. EVERY naming step is many-to-one, not just the
 *     60-char segment cap: the `[A-Za-z0-9._-]` charset folds 'a b' and 'a-b'
 *     together, and the leading-dot strip folds '.hidden' onto 'hidden'. With a
 *     pre-delete a collision does not fail — it silently REPLACES a different
 *     book — so no two source names may resolve to one filename, and
 *     '.hidden.epub' vs 'hidden.epub' is exactly as dangerous as two long
 *     titles sharing their first 60 characters.
 *
 *   - THE ROUTE (M6). A host's reader is asleep most of the time, so a book has
 *     two ways to reach it and they do NOT mean the same thing: direct puts the
 *     bytes on the card, the mailbox queues them for a later sync. The fallback
 *     must fire for a reader that did not ANSWER and must not fire for one that
 *     answered and REFUSED; a client must never touch the reader at all; and the
 *     filename must come out identical on both routes, or a fallback silently
 *     creates a second copy of a book the user already sent.
 *
 * The transport is reached through `__setEpubTransport`, the native document
 * picker through `__setEpubPicker`, the file read through `__setEpubFileReader`
 * and the mailbox through a stubbed `globalThis.fetch`, so everything above runs
 * under node against the real module. NOTHING here touches the network or the
 * filesystem.
 *
 * Run:  node --import tsx --test scripts/epub-sender.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    ANY_FILE_TYPE,
    BOOKS_DIR,
    DEFAULT_LIBRARY_FOLDER,
    EPUB_EXTENSION,
    EPUB_MIME_TYPE,
    EPUB_PICKER_TYPES,
    EPUB_ROUTE_LABEL,
    MAILBOX_LANDING_CLAUSE,
    MAX_EPUB_BYTES,
    describeEpubBatch,
    describeEpubPickProblem,
    filterEpubPicks,
    hasEpubExtension,
    isEpubMimeType,
    normalizeEpubPick,
    pickEpubs,
    resolveEpubFilename,
    resolveLibraryFolder,
    routeEpubSend,
    sendEpubToReader,
    sendEpubViaMailbox,
    sendEpubsRouted,
    sendEpubsToReader,
    __setEpubFileReader,
    __setEpubPicker,
    __setEpubTransport,
} from '../src/services/epub_sender';
import { MAILBOX_SETUP_HINT } from '../src/services/love_note_sender';
import { MAILBOX_BOOKS_PATH } from '../src/services/mailbox_client';
import { sanitizeDevicePath } from '../src/services/settings';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IP = '192.168.4.1';

function pick(overrides = {}) {
    return {
        uri: 'file:///cache/DocumentPicker/dune.epub',
        name: 'Dune.epub',
        size: 1024,
        mimeType: EPUB_MIME_TYPE,
        ...overrides,
    };
}

/**
 * Recording stand-in for crosspoint_upload.
 *
 * Captures (filename, targetFolder) SEPARATELY, because that pair IS the
 * destination — `uploadLocalFileToCrossPoint` builds `/${targetFolder}` itself,
 * so a joined string could not tell '' (SD root) apart from a real folder.
 */
function fakeTransport({ uploadResult = { success: true }, deleteResult = true } = {}) {
    const calls = { uploads: [], deletes: [], ops: [] };
    __setEpubTransport({
        async uploadLocalFile(ip, fileUri, filename, onProgress, targetFolder) {
            calls.uploads.push({ ip, fileUri, filename, targetFolder });
            calls.ops.push(`upload:/${targetFolder ? `${targetFolder}/` : ''}${filename}`);
            if (onProgress) onProgress(100);
            if (typeof uploadResult === 'function') return uploadResult(filename);
            return uploadResult;
        },
        async deleteFile(ip, filename, targetFolder) {
            calls.deletes.push({ ip, filename, targetFolder });
            calls.ops.push(`delete:/${targetFolder ? `${targetFolder}/` : ''}${filename}`);
            if (typeof deleteResult === 'function') return deleteResult(filename);
            return deleteResult;
        },
    });
    return calls;
}

/**
 * A transport that behaves like the CROSSPOINT FIRMWARE, not like a stub.
 *
 * THE ONE RULE THAT MATTERS: an upload onto an EXISTING path is refused with
 * `ERROR:File already exists` and writes nothing. `deleteFile` mirrors
 * `deleteCrossPointFile`: true only when something was actually removed, FALSE
 * for a path that was not there — the ordinary first-upload case, which the
 * sender must not treat as fatal.
 */
function fakeDevice({ existing = [] } = {}) {
    const card = new Map(existing.map(path => [path, 0]));
    const calls = { uploads: [], deletes: [], ops: [] };
    const pathFor = (folder, filename) => `/${folder ? `${folder}/` : ''}${filename}`;

    __setEpubTransport({
        async uploadLocalFile(ip, fileUri, filename, onProgress, targetFolder) {
            const path = pathFor(targetFolder, filename);
            calls.uploads.push({ ip, fileUri, filename, targetFolder, path });
            calls.ops.push(`upload:${path}`);
            if (card.has(path)) {
                // Byte-for-byte what the firmware sends back over the WS.
                return { success: false, error: 'ERROR:File already exists: ' + filename };
            }
            card.set(path, fileUri);
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

    return { calls, paths: () => [...card.keys()].sort(), contentOf: path => card.get(path) };
}

/** Stand-in for expo-document-picker. `results` is consumed one call at a time. */
function fakePicker(results) {
    const queue = [...results];
    const calls = [];
    __setEpubPicker({
        async getDocumentAsync(options) {
            calls.push(options);
            const next = queue.length > 0 ? queue.shift() : { canceled: true };
            if (next instanceof Error) throw next;
            if (typeof next === 'function') return next();
            return next;
        },
    });
    return calls;
}

/** A transport that must never be touched. Any call is the failure. */
function forbiddenTransport() {
    const calls = { uploads: [], deletes: [], ops: [] };
    __setEpubTransport({
        async uploadLocalFile() {
            throw new Error('direct upload must not be attempted on this route');
        },
        async deleteFile() {
            throw new Error('direct delete must not be attempted on this route');
        },
    });
    return calls;
}

// ── Mailbox fixtures ───────────────────────────────────────────────────────
// The mailbox route is `read the file` + `POST it`. Both halves are stubbed:
// the reader because expo-file-system does not exist under node, and `fetch`
// because nothing here touches the network.

const MAILBOX = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const MAILBOX_TOKEN = 'wr_secret_token';

/** Recording stand-in for `globalThis.fetch`. Captures init, so headers count. */
function fakeFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const answer = typeof responder === 'function' ? responder(url, init, calls.length) : responder;
        return await answer;
    };
    return calls;
}

/** Minimal `Response`: status plus a body the module reads with `.text()`. */
function reply(status, body = '') {
    return {
        status,
        ok: status >= 200 && status < 300,
        async text() {
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
    };
}

/** A fetch that must never happen. */
function forbiddenFetch() {
    const calls = [];
    globalThis.fetch = async url => {
        calls.push(url);
        throw new Error(`the mailbox must not be contacted on this route (${url})`);
    };
    return calls;
}

/**
 * Stand-in for `expo-file-system/legacy` + base64ToUint8Array.
 *
 * `bytes` may be a Uint8Array, a length, or a function of the uri — a THROW and a
 * ZERO-LENGTH read are both real SAF outcomes and are pinned separately.
 */
function fakeReader(bytes = 2048) {
    const reads = [];
    __setEpubFileReader({
        async readBytes(fileUri) {
            reads.push(fileUri);
            const value = typeof bytes === 'function' ? bytes(fileUri) : bytes;
            if (value instanceof Error) throw value;
            if (typeof value === 'number') {
                const out = new Uint8Array(value);
                for (let i = 0; i < value; i++) out[i] = (i * 7 + 1) & 0xff;
                return out;
            }
            return value;
        },
    });
    return reads;
}

/** The four facts a route decision is made from. */
function destination(overrides = {}) {
    return {
        role: 'host',
        ip: IP,
        mailboxUrl: MAILBOX,
        mailboxWriteToken: MAILBOX_TOKEN,
        ...overrides,
    };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    __setEpubTransport(null);
    __setEpubPicker(null);
    __setEpubFileReader(null);
    globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

test('BOOKS_DIR is the one declaration, and it survives sanitization intact', () => {
    // DeviceScreen imports BOOKS_DIR for its scan root, so this pair IS the
    // agreement between the folder written and the folder listed. A drift is a
    // book that uploads fine and never appears in the app.
    assert.equal(BOOKS_DIR, '/books');
    assert.equal(DEFAULT_LIBRARY_FOLDER, 'books');
    // Root-relative: uploadLocalFileToCrossPoint builds the '/' itself, so a
    // leading slash here would target '//books'.
    assert.equal(DEFAULT_LIBRARY_FOLDER, sanitizeDevicePath(BOOKS_DIR));
    assert.ok(!DEFAULT_LIBRARY_FOLDER.startsWith('/'));
    // Not hidden: FileBrowserActivity would skip it.
    assert.ok(!DEFAULT_LIBRARY_FOLDER.startsWith('.'));
});

test('resolveLibraryFolder: root-relative, never empty, never hidden', () => {
    assert.equal(resolveLibraryFolder(undefined), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder(null), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder(''), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder('   '), DEFAULT_LIBRARY_FOLDER);

    // A leading slash would make uploadLocalFileToCrossPoint build '//books'.
    assert.equal(resolveLibraryFolder('/books'), 'books');
    assert.equal(resolveLibraryFolder('books/'), 'books');
    assert.equal(resolveLibraryFolder('books'), 'books');
    // Nesting survives, exactly as sanitizeDevicePath promises.
    assert.equal(resolveLibraryFolder('books/inbox'), 'books/inbox');
    assert.equal(resolveLibraryFolder('my books'), 'my-books');

    // Traversal reduces to nothing, which must NOT become the SD root.
    assert.equal(resolveLibraryFolder('..'), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder('/../..'), DEFAULT_LIBRARY_FOLDER);
});

test('resolveLibraryFolder: a hidden folder is refused — the reader would not list it', () => {
    // FileBrowserActivity::loadFiles skips names starting with '.' unless the
    // on-device showHiddenFiles setting is on, so `/.books` is an upload the
    // user can never reach. Same class of bug as a STRIPPED dot on /.sleep (R7),
    // in the opposite direction.
    assert.equal(resolveLibraryFolder('.books'), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder('/.books'), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder('books/.hidden'), DEFAULT_LIBRARY_FOLDER);
    assert.equal(resolveLibraryFolder('.love-notes'), DEFAULT_LIBRARY_FOLDER);
});

test('resolveLibraryFolder: non-string input falls back rather than throwing', () => {
    for (const raw of [0, 42, true, {}, [], NaN]) {
        assert.equal(resolveLibraryFolder(raw), DEFAULT_LIBRARY_FOLDER, `folder: ${JSON.stringify(raw)}`);
    }
});

// ---------------------------------------------------------------------------
// Extension / mime validation
// ---------------------------------------------------------------------------

test('hasEpubExtension is case-insensitive, like the firmware', () => {
    // FsHelpers::checkFileExtension lowercases both sides.
    assert.equal(hasEpubExtension('Dune.epub'), true);
    assert.equal(hasEpubExtension('Dune.EPUB'), true);
    assert.equal(hasEpubExtension('Dune.Epub'), true);
    assert.equal(hasEpubExtension('  Dune.epub  '), true);
    assert.equal(hasEpubExtension('Dune.pdf'), false);
    assert.equal(hasEpubExtension('Dune'), false);
    assert.equal(hasEpubExtension('epub'), false);
    assert.equal(hasEpubExtension(undefined), false);
    assert.equal(hasEpubExtension(42), false);
});

test('isEpubMimeType accepts the variants providers actually report', () => {
    assert.equal(isEpubMimeType('application/epub+zip'), true);
    assert.equal(isEpubMimeType('APPLICATION/EPUB+ZIP'), true);
    assert.equal(isEpubMimeType('application/epub+zip; charset=binary'), true);
    assert.equal(isEpubMimeType('application/x-epub+zip'), true);
    assert.equal(isEpubMimeType('application/epub'), true);

    // Deliberately NOT epub: octet-stream is in the picker filter (some
    // providers report it for real books) but it is not proof of anything, so it
    // can never rescue a name that lacks the extension.
    assert.equal(isEpubMimeType('application/octet-stream'), false);
    assert.equal(isEpubMimeType('application/zip'), false);
    assert.equal(isEpubMimeType('application/pdf'), false);
    assert.equal(isEpubMimeType(undefined), false);
    assert.equal(isEpubMimeType(7), false);
});

test('resolveEpubFilename: the extension always ends up lowercase .epub', () => {
    // listCrossPointFiles filters with a case-SENSITIVE endsWith('.epub'), so an
    // upper-case extension is a book the app cannot list.
    assert.equal(resolveEpubFilename('Dune.epub'), 'Dune.epub');
    assert.equal(resolveEpubFilename('Dune.EPUB'), 'Dune.epub');
    assert.equal(resolveEpubFilename('Dune.Epub'), 'Dune.epub');
    assert.equal(resolveEpubFilename('  Dune.epub  '), 'Dune.epub');
    // Idempotent: no caller can produce 'Dune.epub.epub' by being careful.
    assert.equal(resolveEpubFilename(resolveEpubFilename('Dune.EPUB')), 'Dune.epub');
});

test('resolveEpubFilename: an extensionless pick is rescued only by an epub mime', () => {
    // A SAF display name without an extension is real; the mime is the only
    // thing that can vouch for it, and the firmware only needs the name.
    assert.equal(resolveEpubFilename('Dune', EPUB_MIME_TYPE), 'Dune.epub');
    assert.equal(resolveEpubFilename('Dune', 'application/x-epub+zip'), 'Dune.epub');

    // Nothing else may invent an extension.
    assert.equal(resolveEpubFilename('Dune'), '');
    assert.equal(resolveEpubFilename('Dune', 'application/octet-stream'), '');
    assert.equal(resolveEpubFilename('Dune', 'application/pdf'), '');
    assert.equal(resolveEpubFilename('notes.txt'), '');
    assert.equal(resolveEpubFilename('book.pdf', 'application/pdf'), '');
});

test('resolveEpubFilename: a .epub name is accepted whatever the mime says', () => {
    // Android providers routinely report octet-stream for a perfectly good epub.
    // The firmware keys off the extension only, so the mime cannot veto.
    assert.equal(resolveEpubFilename('Dune.epub', 'application/octet-stream'), 'Dune.epub');
    assert.equal(resolveEpubFilename('Dune.epub', 'application/pdf'), 'Dune.epub');
    assert.equal(resolveEpubFilename('Dune.epub', undefined), 'Dune.epub');
});

test('resolveEpubFilename: an epub mime keeps a foreign extension inside the stem', () => {
    // Documented consequence rather than an accident: the mime says epub, so the
    // file is uploaded openable ('Dune.pdf.epub') instead of refused. The
    // alternative — trusting a display extension over a declared mime — would
    // drop real books.
    assert.equal(resolveEpubFilename('Dune.pdf', EPUB_MIME_TYPE), 'Dune.pdf.epub');
});

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

/**
 * Assert the shape a MUTATED name must come back in: the readable part, then an
 * 8-hex disambiguator, then the extension.
 *
 * The digest itself is deliberately NOT pinned. What has to hold is "one source
 * name, one device name, and never two source names sharing one" — asserted
 * directly by the collision tests below — plus a name a human can still
 * recognise. Pinning hex here would make the hash function unchangeable without
 * testing anything the properties do not already cover.
 */
function assertDisambiguated(actual, verbatim, label = verbatim) {
    assert.match(actual, /^[A-Za-z0-9._-]+-[0-9a-f]{8}\.epub$/, `${label} -> ${actual}`);
    assert.equal(actual.replace(/-[0-9a-f]{8}\.epub$/, ''), verbatim, `${label} -> ${actual}`);
}

test('resolveEpubFilename: normalizes the charset the device (and the WS frame) can take', () => {
    // ':' is the one character that could not merely be ugly: the upload frame is
    // 'START:<filename>:<size>:<path>', parsed with indexOf(':'), so a colon in a
    // name desynchronizes the protocol rather than failing it.
    //
    // Each of these was REWRITTEN, and rewriting is many-to-one ('Dune: Two' and
    // 'Dune, Two' both want 'Dune-Two'), so each also carries the disambiguator —
    // see the collision test below for why that is not optional.
    assertDisambiguated(resolveEpubFilename('Dune: Part Two.epub'), 'Dune-Part-Two');
    assertDisambiguated(resolveEpubFilename('Herbert, Frank - Dune.epub'), 'Herbert-Frank-Dune');
    // A trailing separator is trimmed off the readable part rather than stacking
    // up against the hash ('Dune-1965--<hash>').
    assertDisambiguated(resolveEpubFilename('Dune (1965).epub'), 'Dune-1965');
    // Runs of separators collapse instead of stacking.
    assertDisambiguated(resolveEpubFilename('Dune    Two.epub'), 'Dune-Two');
    // Dots inside the stem are legal on FAT and are kept — nothing was rewritten,
    // so nothing is appended.
    assert.equal(resolveEpubFilename('vol.1.epub'), 'vol.1.epub');
});

test('resolveEpubFilename: a path separator is REJECTED, never flattened', () => {
    // sanitizeDevicePath would happily keep 'a/b' as two nested segments and
    // escape the folder the caller asked for; flattening it to 'ab.epub' would
    // change which book the user thinks they sent. Both are worse than refusing.
    assert.equal(resolveEpubFilename('a/b.epub'), '');
    assert.equal(resolveEpubFilename('a\\b.epub'), '');
    assert.equal(resolveEpubFilename('/Dune.epub'), '');
    assert.equal(resolveEpubFilename('../../Dune.epub'), '');
    assert.equal(resolveEpubFilename('sub/dir/Dune', EPUB_MIME_TYPE), '');
});

test('resolveEpubFilename: control characters and empty stems are refused', () => {
    // Written as escapes so the source stays plain ASCII: NUL, ESC and DEL.
    assert.equal(resolveEpubFilename('Du\u0000ne.epub'), '');
    assert.equal(resolveEpubFilename('Du\u001bne.epub'), '');
    assert.equal(resolveEpubFilename('Dune\u007f.epub'), '');
    // Nothing left once the extension comes off.
    assert.equal(resolveEpubFilename('.epub'), '');
    assert.equal(resolveEpubFilename('..epub'), '');
    assert.equal(resolveEpubFilename('   .epub'), '');
    assert.equal(resolveEpubFilename(''), '');
    assert.equal(resolveEpubFilename('   '), '');
    // Non-strings arrive from a native picker; they must not throw.
    for (const raw of [undefined, null, 0, 42, true, {}, []]) {
        assert.equal(resolveEpubFilename(raw), '', `name: ${JSON.stringify(raw)}`);
    }
});

test('resolveEpubFilename: a dot-leading name never reaches the card as one', () => {
    // THE OTHER HALF OF THE HIDDEN-PATH RULE. resolveLibraryFolder already
    // refuses a hidden FOLDER; this is the same firmware rule applied to the
    // FILE, and it bites harder. FileBrowserActivity::loadFiles skips any entry
    // whose first byte is '.' unless the on-device showHiddenFiles setting is on,
    // while `/api/files` (handleFileListData) does NOT filter dotfiles — so a
    // dot-leading upload gives the user a book that is in the app's Books list
    // and unopenable on the reader, with nothing anywhere saying why.
    //
    // Every one of these must come back either VISIBLE or REJECTED. '._Book' is
    // not a hypothetical: it is the AppleDouble sidecar name every book copied
    // off a Mac brings with it.
    for (const name of ['.hidden.epub', '._Book.epub', '.Calibre Export.epub', '.a.epub', '..Dune.epub']) {
        const resolved = resolveEpubFilename(name);
        assert.notEqual(resolved, '', `${name} should resolve to something visible`);
        assert.ok(!resolved.startsWith('.'), `${name} -> ${resolved} is still hidden on the device`);
        assert.ok(resolved.endsWith(EPUB_EXTENSION), resolved);
    }
    assertDisambiguated(resolveEpubFilename('.hidden.epub'), 'hidden');
    assertDisambiguated(resolveEpubFilename('._Book.epub'), '_Book');
    assertDisambiguated(resolveEpubFilename('.Calibre Export.epub'), 'Calibre-Export');

    // Nothing visible survives -> rejected outright, and describeEpubPickProblem
    // says so, because a rejection with no reason is a batch line the user can do
    // nothing with.
    assert.equal(resolveEpubFilename('....epub'), '');
    assert.match(
        describeEpubPickProblem({ uri: 'file:///cache/x', name: '....epub' }),
        /Unusable filename/
    );

    // Stripping must not cost the length guard either: two long dot-leading books
    // still get distinct names.
    const shared = '.The Extremely Long And Very Similar Title Of A Book Volume ';
    const hiddenA = resolveEpubFilename(`${shared}One - First Edition.epub`);
    const hiddenB = resolveEpubFilename(`${shared}One - Second Edition.epub`);
    assert.ok(!hiddenA.startsWith('.'), hiddenA);
    assert.ok(!hiddenB.startsWith('.'), hiddenB);
    assert.notEqual(hiddenA, hiddenB);
});

test('resolveEpubFilename: a truncated stem cannot collide with another book', () => {
    // THE SILENT ONE. sanitizeDevicePath caps a segment at 60 chars, and because
    // sendEpubToReader DELETES before uploading, two names that truncate to one
    // filename do not fail — the second book replaces the first.
    const shared = 'The Extremely Long And Very Similar Title Of A Book Volume ';
    const a = `${shared}One - First Edition.epub`;
    const b = `${shared}One - Second Edition.epub`;

    const nameA = resolveEpubFilename(a);
    const nameB = resolveEpubFilename(b);

    assert.ok(nameA.endsWith(EPUB_EXTENSION), nameA);
    assert.ok(nameB.endsWith(EPUB_EXTENSION), nameB);
    assert.notEqual(nameA, nameB);
    // Still inside sanitizeDevicePath's per-segment budget once '.epub' is on.
    assert.ok(nameA.length <= 60 + EPUB_EXTENSION.length, `too long: ${nameA}`);
    // Deterministic: the same book resolves to the same name every time, so a
    // re-send replaces its own file rather than stacking near-duplicates.
    assert.equal(resolveEpubFilename(a), nameA);
});

test('resolveEpubFilename: a REWRITTEN stem cannot collide either, at any length', () => {
    // THE ONE THE TRUNCATION GUARD MISSED. Truncation is not the only many-to-one
    // step — the leading-dot strip and the charset rewrite fold two DIFFERENT
    // source names onto one stem at ANY length — and the consequence is the same
    // as the truncation case, only quieter: sendEpubToReader deletes the target
    // path first, so the second book REPLACES the first with nothing shown.
    //
    // '._Book.epub' beside '_Book.epub' is the everyday shape of this: every book
    // copied off a Mac brings its AppleDouble sidecar along, and both used to
    // resolve to '_Book.epub'.
    const pairs = [
        // Leading-dot strip: the stripped name is also a name in its own right.
        ['.hidden.epub', 'hidden.epub'],
        ['._Book.epub', '_Book.epub'],
        ['..Dune.epub', '.Dune.epub'],
        // Charset rewrite: ' ', '_' and '-' are three different titles.
        ['a b.epub', 'a_b.epub'],
        ['a b.epub', 'a-b.epub'],
        ['Dune: Two.epub', 'Dune, Two.epub'],
        ['Dune (1965).epub', 'Dune 1965.epub'],
        // Segment-internal trim: a stray trailing space is not the same book.
        ['Dune .epub', 'Dune.epub'],
    ];

    for (const [left, right] of pairs) {
        const a = resolveEpubFilename(left);
        const b = resolveEpubFilename(right);
        assert.ok(a, `${left} should resolve to something`);
        assert.ok(b, `${right} should resolve to something`);
        assert.notEqual(a, b, `${left} and ${right} both landed on ${a}`);
        // The disambiguator is budgeted to fit, not to push the name past the cap.
        assert.ok(a.length <= 60 + EPUB_EXTENSION.length, `too long: ${a}`);
        assert.ok(b.length <= 60 + EPUB_EXTENSION.length, `too long: ${b}`);
    }
});

test('resolveEpubFilename: a name that needed no sanitizing keeps its pretty name', () => {
    // THE OTHER HALF OF THE RULE, and the reason it is keyed on "was this stem
    // changed" rather than on "is this stem risky": the hash is the price of a
    // REWRITE, not a tax on every book. A stem that survives untouched is already
    // unique among untouched stems, so it reaches the reader's file browser as the
    // name the user picked.
    for (const clean of ['MyBook.epub', 'Dune.epub', 'vol.1.epub', 'a_b.epub', 'a-b.epub', 'Dune_Part_Two.epub']) {
        assert.equal(resolveEpubFilename(clean), clean, clean);
        assert.ok(!/-[0-9a-f]{8}\.epub$/.test(resolveEpubFilename(clean)), `gratuitous hash on ${clean}`);
    }
    // Lower-casing the EXTENSION is not a rewrite of the stem, and the firmware's
    // own extension check is case-insensitive, so this stays hash-free too.
    assert.equal(resolveEpubFilename('MyBook.EPUB'), 'MyBook.epub');
});

test('resolveEpubFilename: the device name is deterministic and a fixed point', () => {
    // A name that moved between two calls would make every re-send a SECOND copy
    // on the card instead of a replacement, and would break the two places that
    // resolve the same pick twice: sendEpubsToReader (once to send, once to report
    // `filename`) and DeviceScreen's delete fallback.
    for (const name of [
        '.hidden.epub',
        'Dune: Part Two.epub',
        'a b.epub',
        'MyBook.epub',
        `${'x'.repeat(80)}.epub`,
    ]) {
        const first = resolveEpubFilename(name);
        assert.ok(first, name);
        assert.equal(resolveEpubFilename(name), first, name);
        assert.equal(resolveEpubFilename(name), first, name);
        // Feeding the OUTPUT back in changes nothing: what comes out is already
        // clean, so no second hash is ever stacked on the first.
        assert.equal(resolveEpubFilename(first), first, `${name} -> ${first} is not a fixed point`);
    }
    // The extension's case must not fork one book into two files on the card.
    assert.equal(resolveEpubFilename('Dune: Part Two.EPUB'), resolveEpubFilename('Dune: Part Two.epub'));
});

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

test('normalizeEpubPick: keeps what the picker gives and refuses what it cannot use', () => {
    assert.deepEqual(normalizeEpubPick(pick()), {
        uri: 'file:///cache/DocumentPicker/dune.epub',
        name: 'Dune.epub',
        size: 1024,
        mimeType: EPUB_MIME_TYPE,
    });

    // No URI = nothing to read. Uploading the string 'undefined' is the failure
    // this refuses.
    assert.equal(normalizeEpubPick({ name: 'Dune.epub' }), null);
    assert.equal(normalizeEpubPick({ uri: '   ', name: 'Dune.epub' }), null);
    assert.equal(normalizeEpubPick(null), null);
    assert.equal(normalizeEpubPick('Dune.epub'), null);

    // A provider that reports no display name still gives a URI; its last
    // segment is the only name available and it is better than nothing.
    assert.equal(normalizeEpubPick({ uri: 'file:///cache/My%20Book.epub' }).name, 'My Book.epub');

    // Junk sizes/mimes are dropped rather than carried into the size guard.
    assert.equal(normalizeEpubPick({ uri: 'file:///a.epub', name: 'a.epub', size: -1 }).size, undefined);
    assert.equal(normalizeEpubPick({ uri: 'file:///a.epub', name: 'a.epub', size: 'big' }).size, undefined);
    assert.equal(normalizeEpubPick({ uri: 'file:///a.epub', name: 'a.epub', mimeType: '  ' }).mimeType, undefined);
});

test('describeEpubPickProblem: one sentence per reason a pick cannot be sent', () => {
    assert.equal(describeEpubPickProblem(pick()), null);
    assert.equal(describeEpubPickProblem(pick({ name: 'Dune', mimeType: EPUB_MIME_TYPE })), null);
    assert.equal(describeEpubPickProblem(pick({ mimeType: 'application/octet-stream' })), null);

    assert.match(describeEpubPickProblem(null), /Not a file/);
    assert.match(describeEpubPickProblem(pick({ uri: '' })), /No readable location/);
    assert.match(describeEpubPickProblem(pick({ name: '' })), /No filename/);
    assert.match(describeEpubPickProblem(pick({ name: 'notes.txt', mimeType: 'text/plain' })), /Not an \.epub/);
    assert.match(describeEpubPickProblem(pick({ name: 'a/b.epub' })), /Unusable filename/);
});

test('describeEpubPickProblem: the size guard only fires on a size we were given', () => {
    // uploadLocalFileToCrossPoint reads the whole file as base64 and again as
    // bytes, so an oversized pick is an OOM crash, not an error message.
    assert.match(describeEpubPickProblem(pick({ size: MAX_EPUB_BYTES + 1 })), /Too big to send/);
    assert.equal(describeEpubPickProblem(pick({ size: MAX_EPUB_BYTES })), null);
    // Unknown size is never a rejection — most providers report one, some do not.
    assert.equal(describeEpubPickProblem(pick({ size: undefined })), null);
    assert.equal(describeEpubPickProblem(pick({ size: Number.NaN })), null);
});

test('filterEpubPicks: this is what makes a wide-open picker safe', () => {
    const { picks, rejected } = filterEpubPicks([
        pick({ name: 'Dune.epub' }),
        pick({ name: 'Holiday.pdf', mimeType: 'application/pdf' }),
        pick({ name: 'Notes', mimeType: 'application/octet-stream' }),
        pick({ name: 'Neuromancer.EPUB', mimeType: 'application/octet-stream' }),
        { name: 'no-uri.epub' },
        'not an object',
    ]);

    assert.deepEqual(picks.map(p => p.name), ['Dune.epub', 'Neuromancer.EPUB']);
    assert.deepEqual(rejected.map(r => r.name), ['Holiday.pdf', 'Notes', 'no-uri.epub', 'Unnamed file']);
    for (const r of rejected) assert.ok(r.reason && r.reason.length > 0, `no reason for ${r.name}`);
});

test('filterEpubPicks: a non-array (a picker that returned nothing) is empty, not a throw', () => {
    assert.deepEqual(filterEpubPicks(undefined), { picks: [], rejected: [] });
    assert.deepEqual(filterEpubPicks(null), { picks: [], rejected: [] });
    assert.deepEqual(filterEpubPicks({}), { picks: [], rejected: [] });
});

// ---------------------------------------------------------------------------
// Upload call shape
// ---------------------------------------------------------------------------

test('sendEpubToReader: folder and filename go to the transport SEPARATELY', () => {
    const calls = fakeTransport();
    return sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub').then(result => {
        assert.equal(result.success, true);
        assert.deepEqual(calls.uploads, [
            {
                ip: IP,
                fileUri: 'file:///cache/dune.epub',
                filename: 'Dune.epub',
                targetFolder: DEFAULT_LIBRARY_FOLDER,
            },
        ]);
    });
});

test('sendEpubToReader: DELETES the target path BEFORE uploading', async () => {
    const calls = fakeTransport();
    await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub');

    // Order is the whole point: the firmware refuses an upload onto an existing
    // path and writes nothing.
    assert.deepEqual(calls.ops, [
        'delete:/books/Dune.epub',
        'upload:/books/Dune.epub',
    ]);
    // The delete goes out under the SANITIZED name, i.e. the one the upload will
    // use — deleting the raw name would clear a path nothing is written to.
    assert.deepEqual(calls.deletes, [
        { ip: IP, filename: 'Dune.epub', targetFolder: DEFAULT_LIBRARY_FOLDER },
    ]);
});

test('sendEpubToReader: a re-send of a book already on the card SUCCEEDS (firmware-shaped device)', async () => {
    const device = fakeDevice();

    const first = await sendEpubToReader(IP, 'file:///cache/v1.epub', 'Dune.epub');
    assert.equal(first.success, true);
    assert.deepEqual(device.paths(), ['/books/Dune.epub']);

    const second = await sendEpubToReader(IP, 'file:///cache/v2.epub', 'Dune.epub');
    assert.equal(second.success, true, second.error);
    // Replaced, not duplicated, and it really is the NEW file.
    assert.deepEqual(device.paths(), ['/books/Dune.epub']);
    assert.equal(device.contentOf('/books/Dune.epub'), 'file:///cache/v2.epub');

    // Without the pre-delete the second upload is what the firmware would have
    // rejected; the recorded ops are the proof the delete was not skipped.
    assert.deepEqual(device.calls.ops, [
        'delete:/books/Dune.epub',
        'upload:/books/Dune.epub',
        'delete:/books/Dune.epub',
        'upload:/books/Dune.epub',
    ]);
});

test('sendEpubToReader: a failed delete is EXPECTED and never blocks the upload', async () => {
    // deleteCrossPointFile reports any non-OK status — including the firmware's
    // "not found" — as false, which is the ordinary case for a NEW book. Treating
    // it as fatal would make the first upload the one that cannot happen.
    const calls = fakeTransport({ deleteResult: false });
    const result = await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub');
    assert.equal(result.success, true);
    assert.equal(calls.uploads.length, 1);
});

test('sendEpubToReader: a delete that THROWS still uploads (never-throws contract)', async () => {
    const calls = { uploads: [] };
    __setEpubTransport({
        async uploadLocalFile(ip, fileUri, filename, onProgress, targetFolder) {
            calls.uploads.push({ filename, targetFolder });
            return { success: true };
        },
        async deleteFile() {
            throw new Error('socket hang up');
        },
    });

    const result = await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub');
    assert.equal(result.success, true);
    assert.equal(calls.uploads.length, 1);
});

test('sendEpubToReader: honours an explicit target folder, sanitized', async () => {
    const calls = fakeTransport();
    await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub', undefined, {
        targetFolder: '/My Books/',
    });
    assert.deepEqual(calls.ops, [
        'delete:/My-Books/Dune.epub',
        'upload:/My-Books/Dune.epub',
    ]);
});

test('sendEpubToReader: a hidden target folder falls back instead of vanishing', async () => {
    const calls = fakeTransport();
    await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub', undefined, {
        targetFolder: '.books',
    });
    assert.deepEqual(calls.uploads.map(u => u.targetFolder), [DEFAULT_LIBRARY_FOLDER]);
});

test('sendEpubToReader: progress is passed straight through', async () => {
    fakeTransport();
    const seen = [];
    await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub', p => seen.push(p));
    assert.deepEqual(seen, [100]);
});

test('sendEpubToReader: validation failures never reach the transport', async () => {
    const calls = fakeTransport();

    const cases = [
        ['', 'Dune.epub', /No file to send/],
        ['file:///cache/x', '', /No filename/],
        ['file:///cache/x', 'notes.txt', /Not an \.epub/],
        ['file:///cache/x', 'a/b.epub', /Unusable filename/],
    ];
    for (const [uri, name, pattern] of cases) {
        const result = await sendEpubToReader(IP, uri, name);
        assert.equal(result.success, false, `${uri} / ${name}`);
        assert.match(result.error, pattern);
    }

    const tooBig = await sendEpubToReader(IP, 'file:///cache/x', 'Dune.epub', undefined, {
        sizeBytes: MAX_EPUB_BYTES + 1,
    });
    assert.equal(tooBig.success, false);
    assert.match(tooBig.error, /Too big to send/);

    assert.deepEqual(calls.ops, [], 'nothing should have been sent');
});

test('sendEpubToReader: an upload that throws or a missing transport is a result, not an exception', async () => {
    __setEpubTransport({
        async uploadLocalFile() {
            throw new Error('WebSocket connection failed');
        },
        async deleteFile() {
            return false;
        },
    });
    const thrown = await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub');
    assert.equal(thrown.success, false);
    assert.match(thrown.error, /WebSocket connection failed/);

    // No react-native runtime: the lazy require finds nothing.
    __setEpubTransport(null);
    const noTransport = await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub');
    assert.equal(noTransport.success, false);
    assert.match(noTransport.error, /transport unavailable/i);
});

test('sendEpubToReader: the firmware error text reaches the caller unchanged', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'ERROR:File already exists: Dune.epub' } });
    const result = await sendEpubToReader(IP, 'file:///cache/dune.epub', 'Dune.epub');
    assert.equal(result.success, false);
    // Guessing a friendlier message would replace a true report with a vaguer one.
    assert.equal(result.error, 'ERROR:File already exists: Dune.epub');
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

test('sendEpubsToReader: serial, one folder, per-file outcomes', async () => {
    const device = fakeDevice();
    const starts = [];
    const progress = [];

    const result = await sendEpubsToReader(
        IP,
        [
            pick({ uri: 'file:///c/1', name: 'Dune.epub' }),
            pick({ uri: 'file:///c/2', name: 'Neuromancer.EPUB' }),
            pick({ uri: 'file:///c/3', name: 'Holiday.pdf', mimeType: 'application/pdf' }),
        ],
        {
            onFileStart: (index, total, p) => starts.push(`${index}/${total} ${p.name}`),
            onProgress: (percent, index, total) => progress.push(`${index}/${total} ${percent}`),
        }
    );

    assert.equal(result.folder, DEFAULT_LIBRARY_FOLDER);
    assert.equal(result.succeeded, 2);
    assert.equal(result.outcomes.length, 3);
    assert.deepEqual(result.failed.map(f => f.sourceName), ['Holiday.pdf']);
    assert.match(result.failed[0].error, /Not an \.epub/);

    // The name that went to the card is reported, not just the picked one.
    assert.deepEqual(result.outcomes.map(o => o.filename), [
        'Dune.epub',
        'Neuromancer.epub',
        undefined,
    ]);

    // SERIAL: the firmware refuses a second START while one is in flight
    // ('ERROR:Upload already in progress'), so an interleaved batch would be a
    // pile of failures.
    assert.deepEqual(device.calls.ops, [
        'delete:/books/Dune.epub',
        'upload:/books/Dune.epub',
        'delete:/books/Neuromancer.epub',
        'upload:/books/Neuromancer.epub',
    ]);

    assert.deepEqual(starts, ['1/3 Dune.epub', '2/3 Neuromancer.EPUB', '3/3 Holiday.pdf']);
    assert.deepEqual(progress, ['1/3 100', '2/3 100']);
});

test('sendEpubsToReader: one bad file never costs the user the others', async () => {
    // Partial success is the NORMAL case for a multi-select, not an exception.
    fakeTransport({
        uploadResult: filename =>
            filename === 'Bad.epub'
                ? { success: false, error: 'Cannot reach X4. Network request failed' }
                : { success: true },
    });

    const result = await sendEpubsToReader(IP, [
        pick({ name: 'Good.epub' }),
        pick({ name: 'Bad.epub' }),
        pick({ name: 'AlsoGood.epub' }),
    ]);

    assert.equal(result.succeeded, 2);
    assert.deepEqual(result.failed.map(f => f.sourceName), ['Bad.epub']);
    assert.deepEqual(result.outcomes.map(o => o.success), [true, false, true]);
});

test('sendEpubsToReader: garbage input is an outcome row, not a crash', async () => {
    fakeTransport();
    const result = await sendEpubsToReader(IP, [null, { name: 'no-uri.epub' }, pick()]);
    assert.equal(result.succeeded, 1);
    assert.equal(result.outcomes.length, 3);
    assert.equal(result.outcomes[0].success, false);
    assert.equal(result.outcomes[1].success, false);

    // A non-array (a picker result that was not what it claimed) is empty.
    const empty = await sendEpubsToReader(IP, undefined);
    assert.deepEqual(empty.outcomes, []);
    assert.equal(empty.succeeded, 0);
});

test('sendEpubsToReader: the batch folder is resolved once and reused for every file', async () => {
    const calls = fakeTransport();
    const result = await sendEpubsToReader(
        IP,
        [pick({ name: 'A.epub' }), pick({ name: 'B.epub' })],
        { targetFolder: 'My Books/2026' }
    );
    assert.equal(result.folder, 'My-Books/2026');
    assert.deepEqual(new Set(calls.uploads.map(u => u.targetFolder)), new Set(['My-Books/2026']));
});

// ---------------------------------------------------------------------------
// Summary wording
// ---------------------------------------------------------------------------

test('describeEpubBatch: names every failure, because "2 failed" is unactionable', async () => {
    fakeTransport({
        uploadResult: filename => (filename === 'Bad.epub' ? { success: false, error: 'Reader said no' } : { success: true }),
    });
    const result = await sendEpubsToReader(IP, [pick({ name: 'Good.epub' }), pick({ name: 'Bad.epub' })]);

    const text = describeEpubBatch(result, [{ name: 'Holiday.pdf', reason: 'Not an .epub file.' }]);
    assert.match(text, /Added 1 of 2 to \/books\./);
    assert.match(text, /Bad\.epub: Reader said no/);
    // Files the picker handed back but that never became an upload are listed too.
    assert.match(text, /Holiday\.pdf: Not an \.epub file\./);
});

test('describeEpubBatch: the all-good, all-bad and nothing-selected cases each read correctly', async () => {
    fakeTransport();
    const allGood = await sendEpubsToReader(IP, [pick({ name: 'A.epub' })]);
    assert.equal(describeEpubBatch(allGood), 'Added 1 book to /books.');

    const twoGood = await sendEpubsToReader(IP, [pick({ name: 'A.epub' }), pick({ name: 'B.epub' })]);
    assert.equal(describeEpubBatch(twoGood), 'Added 2 books to /books.');

    fakeTransport({ uploadResult: { success: false, error: 'Reader unreachable' } });
    const allBad = await sendEpubsToReader(IP, [pick({ name: 'A.epub' })]);
    const badText = describeEpubBatch(allBad);
    assert.match(badText, /Nothing was added to \/books\./);
    assert.match(badText, /A\.epub: Reader unreachable/);

    const nothing = await sendEpubsToReader(IP, []);
    assert.equal(describeEpubBatch(nothing), 'No files were selected.');
    // A pick that was filtered out before any upload still gets explained.
    assert.equal(
        describeEpubBatch(nothing, [{ name: 'Holiday.pdf', reason: 'Not an .epub file.' }]),
        '• Holiday.pdf: Not an .epub file.'
    );
});

// ---------------------------------------------------------------------------
// Picker seam
// ---------------------------------------------------------------------------

test('pickEpubs: asks for epubs, multi-select, copied into the cache', async () => {
    const calls = fakePicker([{ canceled: false, assets: [pick()] }]);
    const result = await pickEpubs();

    assert.equal(result.canceled, false);
    assert.deepEqual(result.picks.map(p => p.name), ['Dune.epub']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].type, EPUB_PICKER_TYPES);
    assert.equal(calls[0].multiple, true);
    // Not an optimisation: a SAF content:// URI is not readable by
    // expo-file-system's legacy readAsStringAsync, so the copy is mandatory.
    assert.equal(calls[0].copyToCacheDirectory, true);
});

test('pickEpubs: multi-select results are filtered by extension, with reasons', async () => {
    fakePicker([
        {
            canceled: false,
            assets: [pick({ name: 'Dune.epub' }), pick({ name: 'Holiday.pdf', mimeType: 'application/pdf' })],
        },
    ]);
    const result = await pickEpubs();
    assert.deepEqual(result.picks.map(p => p.name), ['Dune.epub']);
    assert.deepEqual(result.rejected, [{ name: 'Holiday.pdf', reason: 'Not an .epub file.' }]);
});

test('pickEpubs: a picker that REJECTS the mime filter retries once, wide open', async () => {
    // Some Android DocumentsProviders refuse an unfamiliar type filter outright,
    // and a picker that threw is indistinguishable — to the user — from a
    // feature that does not work.
    const calls = fakePicker([
        new Error('Unsupported type filter'),
        { canceled: false, assets: [pick({ name: 'Dune.epub' }), pick({ name: 'Holiday.pdf', mimeType: 'application/pdf' })] },
    ]);

    const result = await pickEpubs();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].type, EPUB_PICKER_TYPES);
    assert.equal(calls[1].type, ANY_FILE_TYPE);
    // The wide filter is only safe BECAUSE the extension check still runs.
    assert.deepEqual(result.picks.map(p => p.name), ['Dune.epub']);
    assert.equal(result.rejected.length, 1);
});

test('pickEpubs: cancelling is quiet, and never re-prompts', async () => {
    const calls = fakePicker([{ canceled: true, assets: null }]);
    const result = await pickEpubs();
    assert.deepEqual(result, { canceled: true, picks: [], rejected: [] });
    // Re-opening the picker over a deliberate cancel would be hostile.
    assert.equal(calls.length, 1);
});

test('pickEpubs: an empty non-cancelled result reads as a cancel', async () => {
    fakePicker([{ canceled: false, assets: [] }]);
    assert.deepEqual(await pickEpubs(), { canceled: true, picks: [], rejected: [] });

    fakePicker([{ canceled: false }]);
    assert.deepEqual(await pickEpubs(), { canceled: true, picks: [], rejected: [] });
});

test('pickEpubs: both attempts failing, and no picker at all, are results not throws', async () => {
    fakePicker([new Error('first boom'), new Error('second boom')]);
    const failed = await pickEpubs();
    assert.equal(failed.canceled, false);
    assert.deepEqual(failed.picks, []);
    assert.match(failed.error, /second boom/);
    assert.match(failed.error, /first boom/);

    __setEpubPicker(null);
    const absent = await pickEpubs();
    assert.match(absent.error, /picker unavailable/i);
    assert.deepEqual(absent.picks, []);
});

test('pickEpubs: a picker returning nonsense does not become an upload', async () => {
    fakePicker([null]);
    const result = await pickEpubs();
    assert.equal(result.picks.length, 0);
    assert.match(result.error, /returned nothing/);
});

// ---------------------------------------------------------------------------
// Routing (M6): direct first for a host, mailbox for everything else
//
// WHAT IS AT RISK, on top of everything above:
//
//   - THE FALLBACK DECISION. The reader is ASLEEP most of the time, which must
//     fall back to the mailbox; a reader that ANSWERED AND REFUSED (a full card,
//     a rejected overwrite) must NOT be papered over with a delayed delivery the
//     user cannot see, because that hides a condition only they can fix.
//   - CLIENT ROUTING. A client has no LAN access to the reader at all; touching
//     the direct transport is a bug whose only symptom is a long hang.
//   - ONE NAME, BOTH ROUTES. A book must arrive under the SAME filename whichever
//     route carried it. Otherwise a fallback silently creates a SECOND copy of a
//     book the user already sent, under a different name, and the direct path's
//     delete-before-upload no longer replaces it.
//   - WHAT "SENT" MEANS. A mailbox book is queued, not on the card; the reader
//     collects it at a later sync, over several wake windows for a big one. A
//     summary that flattens the two is a promise the contract cannot keep.
// ---------------------------------------------------------------------------

test('routeEpubSend: a host with a reachable reader goes DIRECT and never opens the mailbox', async () => {
    const device = fakeDevice();
    const fetches = forbiddenFetch();
    fakeReader();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub');

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'direct');
    assert.deepEqual(result.attempts, [{ route: 'direct', success: true, error: undefined }]);
    assert.deepEqual(device.paths(), ['/books/Dune.epub']);
    // Direct is preferred because the book is ON THE CARD when this returns.
    // Publishing as well would leave a duplicate in the mailbox for the reader to
    // download again at its next sync.
    assert.equal(fetches.length, 0);
});

test('routeEpubSend: a host whose reader did not answer falls back to the MAILBOX', async () => {
    const calls = fakeTransport({
        uploadResult: { success: false, error: 'WebSocket connection failed' },
    });
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-1', filename: 'Dune.epub', bytes: 2048 }));
    const reads = fakeReader(2048);

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub');

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'mailbox');
    assert.equal(result.bookId, 'bk-1');
    // ORDER MATTERS: direct was genuinely tried first, and both attempts are
    // reported so a UI can say "reader was asleep" rather than a bare success.
    assert.deepEqual(result.attempts.map(a => [a.route, a.success]), [
        ['direct', false],
        ['mailbox', true],
    ]);
    assert.equal(calls.uploads.length, 1);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, `${MAILBOX}${MAILBOX_BOOKS_PATH}`);
    assert.equal(fetches[0].init.headers.Authorization, `Bearer ${MAILBOX_TOKEN}`);
    assert.equal(fetches[0].init.headers['X-Filename'], 'Dune.epub');
    assert.deepEqual(reads, [pick().uri]);
});

test('routeEpubSend: a host with NO transport in this runtime still delivers via the mailbox', async () => {
    // 'Device transport unavailable in this runtime.' is an unreachable-class
    // error, not a refusal: there is nothing the user could fix, and the mailbox
    // is exactly the path that works without the reader.
    __setEpubTransport(null);
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-2', filename: 'Dune.epub' }));
    fakeReader();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub');

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'mailbox');
    assert.equal(fetches.length, 1);
});

test('routeEpubSend: a reader that ANSWERED and refused is reported, NOT rerouted', async () => {
    // The firmware refuses an existing path and writes nothing. That is a real,
    // fixable device condition; republishing to the mailbox would hide it behind a
    // delayed delivery the user never asked for.
    const device = fakeDevice({ existing: ['/books/Dune.epub'] });
    // deleteFile is called first and REMOVES it, so force the refusal directly.
    __setEpubTransport({
        async uploadLocalFile() {
            return { success: false, error: 'ERROR:File already exists: Dune.epub' };
        },
        async deleteFile() {
            return false;
        },
    });
    const fetches = forbiddenFetch();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub');

    assert.equal(result.success, false);
    assert.match(result.error, /File already exists/);
    assert.deepEqual(result.attempts.map(a => a.route), ['direct']);
    assert.equal(fetches.length, 0);
    assert.ok(device);
});

test('routeEpubSend: a host with an unreachable reader and NO mailbox names both problems', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'WebSocket upload timed out' } });
    const fetches = forbiddenFetch();

    const result = await routeEpubSend(
        destination({ mailboxUrl: '', mailboxWriteToken: '' }),
        pick().uri,
        'Dune.epub'
    );

    assert.equal(result.success, false);
    // BOTH facts: what went wrong now, and what to set up so it works while the
    // reader is asleep. Either one alone leaves the user stuck.
    assert.match(result.error, /Reader unreachable \(WebSocket upload timed out\)/);
    assert.match(result.error, new RegExp(MAILBOX_SETUP_HINT));
    assert.match(result.error, /while it is asleep/);
    assert.equal(fetches.length, 0);
});

test('routeEpubSend: a mailbox URL that is SET but unusable gets the specific defect', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'Cannot reach X4. Network request failed' } });
    const fetches = forbiddenFetch();

    const result = await routeEpubSend(
        destination({ mailboxUrl: `${MAILBOX}?k=1` }),
        pick().uri,
        'Dune.epub'
    );

    assert.equal(result.success, false);
    // Telling someone who already typed a URL to "set up mailbox in Settings"
    // says nothing about what is wrong with the one they typed.
    assert.match(result.error, /Mailbox unusable: .*query string/);
    assert.doesNotMatch(result.error, new RegExp(MAILBOX_SETUP_HINT));
    assert.equal(fetches.length, 0);
});

test('routeEpubSend: when BOTH routes fail the error names both, and neither is lost', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'WebSocket connection failed' } });
    fakeFetch(reply(401, 'bad token'));
    fakeReader();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub');

    assert.equal(result.success, false);
    assert.match(result.error, /Reader unreachable \(WebSocket connection failed\)/);
    assert.match(result.error, /mailbox failed too: .*token rejected/i);
    assert.deepEqual(result.attempts.map(a => [a.route, a.success]), [
        ['direct', false],
        ['mailbox', false],
    ]);
});

test('routeEpubSend: a CLIENT uses the mailbox only and never touches the reader', async () => {
    forbiddenTransport();
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-3', filename: 'Dune.epub' }));
    fakeReader();

    const result = await routeEpubSend(destination({ role: 'client' }), pick().uri, 'Dune.epub');

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'mailbox');
    // A client is off the reader's LAN by definition. A direct attempt there is
    // not a harmless extra request, it is a socket that hangs until it times out.
    assert.deepEqual(result.attempts.map(a => a.route), ['mailbox']);
    assert.equal(fetches.length, 1);
});

test('routeEpubSend: a CLIENT with no mailbox fails without any network at all', async () => {
    forbiddenTransport();
    const fetches = forbiddenFetch();

    for (const dest of [
        destination({ role: 'client', mailboxUrl: '', mailboxWriteToken: '' }),
        destination({ role: 'client', mailboxWriteToken: '' }),   // URL but no token
        destination({ role: 'client', mailboxUrl: '' }),          // token but no URL
    ]) {
        const result = await routeEpubSend(dest, pick().uri, 'Dune.epub');
        assert.equal(result.success, false);
        assert.equal(result.error, MAILBOX_SETUP_HINT);
        // NOTHING was attempted: there is no route to try, and a client with no
        // mailbox has no second option to fall back to.
        assert.deepEqual(result.attempts, []);
    }
    assert.equal(fetches.length, 0);
});

test('routeEpubSend: an unknown role is treated as host, matching every other read of it', async () => {
    const device = fakeDevice();
    fakeReader();
    forbiddenFetch();

    const result = await routeEpubSend(destination({ role: 'wat' }), pick().uri, 'Dune.epub');

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'direct');
    assert.deepEqual(device.paths(), ['/books/Dune.epub']);
});

test('routeEpubSend: an unusable pick fails ONCE, before either route is attempted', async () => {
    forbiddenTransport();
    const fetches = forbiddenFetch();

    const noFile = await routeEpubSend(destination(), '   ', 'Dune.epub');
    assert.equal(noFile.success, false);
    assert.match(noFile.error, /No file to send/);
    assert.deepEqual(noFile.attempts, []);

    const notEpub = await routeEpubSend(destination(), pick().uri, 'Holiday.pdf');
    assert.equal(notEpub.success, false);
    assert.match(notEpub.error, /Not an \.epub file/);
    assert.deepEqual(notEpub.attempts, []);

    const tooBig = await routeEpubSend(destination(), pick().uri, 'Dune.epub', undefined, {
        sizeBytes: MAX_EPUB_BYTES + 1,
    });
    assert.equal(tooBig.success, false);
    assert.match(tooBig.error, /Too big to send/);
    // The size cap is a PHONE limit (the read materialises the whole book twice),
    // so it applies to the mailbox route too — a fallback here would just OOM
    // somewhere else.
    assert.deepEqual(tooBig.attempts, []);

    assert.equal(fetches.length, 0);
});

test('routeEpubSend: the book lands under the SAME name whichever route carried it', async () => {
    // Sanitization is many-to-one, so the name is decided ONCE by
    // resolveEpubFilename. If the two routes disagreed, a fallback would create a
    // second copy of the same book under a different name, and the direct path's
    // pre-delete would stop replacing it.
    const messy = 'Dune: Two.epub';
    const expected = resolveEpubFilename(messy);
    assert.match(expected, /^Dune-Two-[0-9a-f]{8}\.epub$/);

    const device = fakeDevice();
    fakeReader();
    await routeEpubSend(destination(), pick().uri, messy);
    assert.deepEqual(device.paths(), [`/books/${expected}`]);

    __setEpubTransport(null);
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-4', filename: expected }));
    const viaMailbox = await routeEpubSend(destination(), pick().uri, messy);

    assert.equal(viaMailbox.success, true, viaMailbox.error);
    assert.equal(fetches[0].init.headers['X-Filename'], expected);
    assert.equal(viaMailbox.filename, expected);
});

// ---------------------------------------------------------------------------
// sendEpubViaMailbox
// ---------------------------------------------------------------------------

test('sendEpubViaMailbox reads the file and publishes the bytes under the resolved name', async () => {
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-5', filename: 'Dune.epub', bytes: 3072 }));
    const reads = fakeReader(3072);

    const result = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, pick().uri, 'Dune.EPUB');

    assert.equal(result.success, true, result.error);
    // The extension is forced lowercase for the FIRMWARE's sake (the app's own
    // listing filter is case-sensitive), on this route exactly as on the direct one.
    assert.equal(fetches[0].init.headers['X-Filename'], 'Dune.epub');
    assert.equal(fetches[0].init.body.byteLength, 3072);
    assert.deepEqual(reads, [pick().uri]);
    assert.equal(result.bookId, 'bk-5');
    assert.equal(result.bytes, 3072);
});

test('sendEpubViaMailbox reports the name the SERVER stored, not the one it sent', async () => {
    // X-Filename is sanitized server-side (FAT punctuation and non-ASCII are
    // REPLACED, not rejected), so the file the reader creates can differ. A UI
    // that echoed the requested name would name a file that is not on the card.
    fakeFetch(reply(200, { ok: true, id: 'bk-6', filename: 'Caf__ Frapp__.epub' }));
    fakeReader();

    const result = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, pick().uri, 'Cafe Frappe.epub');

    assert.equal(result.success, true, result.error);
    assert.equal(result.filename, 'Caf__ Frapp__.epub');
});

test('sendEpubViaMailbox turns every read failure into a result, never a throw', async () => {
    const fetches = forbiddenFetch();

    fakeReader(new Error('EACCES: content:// gone'));
    const threw = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, pick().uri, 'Dune.epub');
    assert.equal(threw.success, false);
    // Names the FILE as well as the cause: a batch failure list is unusable
    // without knowing which book it is about.
    assert.match(threw.error, /Could not read Dune\.epub: EACCES/);

    fakeReader(0);
    const empty = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, pick().uri, 'Dune.epub');
    assert.equal(empty.success, false);
    // A silent empty read must not be published: the mailbox would answer 400 and
    // the user would be told the SERVER refused their book.
    assert.match(empty.error, /Could not read Dune\.epub \(0 bytes\)/);

    __setEpubFileReader(null);
    const absent = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, pick().uri, 'Dune.epub');
    assert.equal(absent.success, false);
    assert.match(absent.error, /reader unavailable/i);

    assert.equal(fetches.length, 0, 'nothing may be published without bytes');
});

test('sendEpubViaMailbox validates the pick before reading anything', async () => {
    const reads = fakeReader();
    const fetches = forbiddenFetch();

    for (const [name, pattern] of [
        ['', /No filename/],
        ['Holiday.pdf', /Not an \.epub file/],
        ['books/Dune.epub', /Unusable filename/],
    ]) {
        const result = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, pick().uri, name);
        assert.equal(result.success, false, `accepted ${JSON.stringify(name)}`);
        assert.match(result.error, pattern);
    }
    const noUri = await sendEpubViaMailbox(MAILBOX, MAILBOX_TOKEN, '  ', 'Dune.epub');
    assert.equal(noUri.success, false);
    assert.match(noUri.error, /No file to send/);

    // Reading a multi-megabyte file we are going to refuse is pure waste, and on
    // Hermes it is the part that can OOM.
    assert.deepEqual(reads, []);
    assert.equal(fetches.length, 0);
});

// ---------------------------------------------------------------------------
// Routed batches and how they are worded
// ---------------------------------------------------------------------------

test('sendEpubsRouted: a reader that falls asleep mid-batch does not fail the rest', async () => {
    // The reader answers for the first book and stops answering after it — the
    // ordinary case for a device that went back to sleep. Routing is per FILE, so
    // book 1 is on the card and books 2-3 are queued; nothing is lost.
    let uploads = 0;
    __setEpubTransport({
        async uploadLocalFile() {
            uploads += 1;
            return uploads === 1
                ? { success: true }
                : { success: false, error: 'WebSocket connection failed' };
        },
        async deleteFile() {
            return false;
        },
    });
    const fetches = fakeFetch((url, init) =>
        reply(200, { ok: true, id: `bk-${init.headers['X-Book-Id']}`, filename: init.headers['X-Filename'] })
    );
    fakeReader();

    const picks = [
        pick({ name: 'Dune.epub' }),
        pick({ name: 'Emma.epub' }),
        pick({ name: 'Ulysses.epub' }),
    ];
    const result = await sendEpubsRouted(destination(), picks);

    assert.equal(result.succeeded, 3);
    assert.deepEqual(result.outcomes.map(o => [o.filename, o.route]), [
        ['Dune.epub', 'direct'],
        ['Emma.epub', 'mailbox'],
        ['Ulysses.epub', 'mailbox'],
    ]);
    assert.equal(fetches.length, 2);

    const text = describeEpubBatch(result);
    // MIXED batch: one sentence cannot be true of all three books, so the routes
    // are named per file.
    assert.match(text, /Added 3 books to \/books\./);
    assert.match(text, new RegExp(`${EPUB_ROUTE_LABEL.direct}: Dune\\.epub`));
    assert.match(
        text,
        new RegExp(`${EPUB_ROUTE_LABEL.mailbox} \\(${MAILBOX_LANDING_CLAUSE}\\): Emma\\.epub, Ulysses\\.epub`)
    );
});

test('sendEpubsRouted: a client batch is worded as queued, not as added to /books', async () => {
    forbiddenTransport();
    fakeFetch((url, init) => reply(200, { ok: true, id: 'bk-x', filename: init.headers['X-Filename'] }));
    fakeReader();

    const result = await sendEpubsRouted(destination({ role: 'client' }), [
        pick({ name: 'Dune.epub' }),
        pick({ name: 'Emma.epub' }),
    ]);

    assert.equal(result.succeeded, 2);
    assert.ok(result.outcomes.every(o => o.route === 'mailbox'));

    const text = describeEpubBatch(result);
    // 'Added 2 books to /books' would be a LIE: the bytes are in the mailbox and
    // the reader has not collected them yet.
    assert.equal(text, `Sent 2 books to the mailbox — ${MAILBOX_LANDING_CLAUSE}.`);
    assert.doesNotMatch(text, /Added/);
});

test('sendEpubsRouted: failures are still named per file, and partial success is normal', async () => {
    fakeTransport({ uploadResult: { success: false, error: 'WebSocket connection failed' } });
    fakeFetch((url, init) =>
        init.headers['X-Filename'] === 'Emma.epub'
            ? reply(413, 'too big')
            : reply(200, { ok: true, id: 'bk-y', filename: init.headers['X-Filename'] })
    );
    fakeReader();

    const result = await sendEpubsRouted(destination(), [
        pick({ name: 'Dune.epub' }),
        pick({ name: 'Emma.epub' }),
    ]);

    assert.equal(result.succeeded, 1);
    assert.equal(result.failed.length, 1);
    const text = describeEpubBatch(result);
    assert.match(text, new RegExp(`Sent 1 of 2 to the mailbox — ${MAILBOX_LANDING_CLAUSE}\\.`));
    // "1 of 2 failed" without saying WHICH is an alert the user can do nothing
    // with — and the reason has to survive both legs of the fallback.
    assert.match(text, /• Emma\.epub: Reader unreachable .*mailbox failed too: .*413/);
});

test('describeEpubBatch: a direct-only batch is worded exactly as before', () => {
    // The route is mentioned ONLY when there is a distinction to draw. A host with
    // an awake reader must not start seeing mailbox language.
    const direct = {
        folder: 'books',
        succeeded: 2,
        outcomes: [
            { sourceName: 'Dune.epub', filename: 'Dune.epub', success: true, route: 'direct' },
            { sourceName: 'Emma.epub', filename: 'Emma.epub', success: true, route: 'direct' },
        ],
        failed: [],
    };
    assert.equal(describeEpubBatch(direct), 'Added 2 books to /books.');
    // And an outcome with NO route at all (sendEpubsToReader) is the same sentence.
    const legacy = {
        ...direct,
        outcomes: direct.outcomes.map(({ route, ...rest }) => rest),
    };
    assert.equal(describeEpubBatch(legacy), 'Added 2 books to /books.');
});

test('sendEpubsToReader is unchanged by routing: still direct-only, still no route', async () => {
    const device = fakeDevice();
    const fetches = forbiddenFetch();

    const result = await sendEpubsToReader(IP, [pick({ name: 'Dune.epub' })]);

    assert.equal(result.succeeded, 1);
    // The direct-only entry point exists for callers that have no mailbox story;
    // it must not acquire one silently.
    assert.equal(result.outcomes[0].route, undefined);
    assert.deepEqual(device.paths(), ['/books/Dune.epub']);
    assert.equal(fetches.length, 0);
});
