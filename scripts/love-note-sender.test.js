/**
 * love_note_sender — the DIRECT path's TWO-file write: the frame, and then the
 * `/.love-notes/current.id` sidecar the firmware dedups on.
 *
 * WHAT IS ACTUALLY AT RISK HERE. Every defect on this path is invisible from the
 * phone: the reader reports nothing back, so all three failure modes below look
 * exactly like a successful send.
 *
 *   - NO ID AT ALL. `MessageSync::hasUnreadNote` (crosspoint-reader
 *     src/network/MessageSync.cpp:114-119) returns true for a frame with an empty
 *     or missing id — the "legacy / id-less frame" branch — and
 *     `markCurrentNoteShown` (:121-128) returns early on an empty id, so nothing
 *     is ever recorded. An id-less note therefore hijacks the panel on EVERY
 *     wake, forever. That was the direct path's behaviour before the sidecar.
 *   - AN ID WITHOUT ITS FRAME, or ahead of it. `current.id` naming a note whose
 *     frame is not (yet) on the card makes the reader display whatever frame IS
 *     there and mark the NEW id as shown, so the note the user actually sent is
 *     deduped away and never appears at all. This is strictly worse than no id,
 *     and it is why the upload order is frame-then-id and why a failed frame
 *     upload must stage nothing.
 *   - A STALE ID SURVIVING A SEND. The previous note's id still equals
 *     `messageLastShownId`, so `hasUnreadNote` answers false and the fresh frame
 *     under it is never shown. Hence `current.id` is deleted on every send, even
 *     when no new id is being staged.
 *
 * The firmware halves of those three rules are MIRRORED below
 * (`trimIdLikeFirmware`, `hasUnreadNoteLikeFirmware`) with file:line cites, so
 * the assertions are about what the reader will actually do rather than about
 * what this app happens to write. `love_note_sender` reaches the reader through
 * `__setLoveNoteTransport`, whose fake enforces the firmware's overwrite refusal,
 * so all of this runs under node against the REAL module. NOTHING here touches
 * the network. (Routing/mailbox behaviour is pinned by
 * `scripts/mailbox-client.test.js`; only the id half of it is re-checked here.)
 *
 * Run:  node --import tsx --test scripts/love-note-sender.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    LOVE_NOTES_DIR,
    LOVE_NOTE_FILENAME,
    LOVE_NOTE_FRAME_BYTES,
    LOVE_NOTE_ID_FILENAME,
    NOTE_ID_DEVICE_MAX_CHARS,
    describeNoteIdProblem,
    encodeNoteIdFile,
    sendLoveNote,
    sendLoveNoteFrame,
    __setLoveNoteTransport,
} from '../src/services/love_note_sender';
import { mintNoteId } from '../src/services/mailbox_client';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAME_PATH = `${LOVE_NOTES_DIR}/${LOVE_NOTE_FILENAME}`;
const ID_PATH = `${LOVE_NOTES_DIR}/${LOVE_NOTE_ID_FILENAME}`;

/** The shape `mintNoteId` guarantees (mailbox_client.ts:207). */
const MINTED_ID_SHAPE = /^[0-9a-z]{9}-[0-9a-z]{11}$/;

const MAILBOX_BASE = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const MAILBOX_TOKEN = 'wr_secret_token';

/** A correctly sized frame. Content is irrelevant to every assertion here. */
function goodFrame(fill = 0xff) {
    return new Uint8Array(LOVE_NOTE_FRAME_BYTES).fill(fill);
}

/**
 * A transport that behaves like the CROSSPOINT FIRMWARE, not like a stub.
 *
 * Same rule as `mailbox-client.test.js` / `wallpaper-sender.test.js`: older
 * firmware REFUSES to overwrite an existing path ('ERROR: File already exists',
 * proven on hardware 2026-07-28) and writes NOTHING. An accept-everything mock
 * cannot see a missing pre-delete — which is exactly how that defect stayed
 * invisible once already — and it also cannot see an id written over a stale one.
 *
 * It keeps the file CONTENTS too, because for the sidecar the bytes ARE the
 * contract: a length check would not notice an id with a newline glued to it.
 *
 * @param existing   Map of path -> string contents already on the card.
 * @param failWith   Error every upload resolves with (a reader that is asleep).
 * @param failUpload (path) => error|null, to fail ONE of the two uploads.
 */
function fakeDevice({ existing = {}, failWith = null, failUpload = null } = {}) {
    const card = new Map(
        Object.entries(existing).map(([path, text]) => [path, Buffer.from(text, 'utf8')])
    );
    const calls = { ops: [], uploads: [], deletes: [] };
    const pathFor = (folder, filename) => `/${folder ? `${folder}/` : ''}${filename}`;

    __setLoveNoteTransport({
        async upload(ip, data, filename, onProgress, targetFolder) {
            const path = pathFor(targetFolder, filename);
            const bytes = Buffer.from(data);
            calls.uploads.push({
                ip,
                path,
                filename,
                targetFolder,
                byteLength: data.byteLength,
                bytes,
                // Recorded, not just used: the sidecar must NOT drive the progress
                // bar, or a 21-byte upload re-runs 0->100 after the frame finished.
                progressKind: typeof onProgress,
            });
            calls.ops.push(`upload:${path}`);
            const forced = (failUpload ? failUpload(path) : null) ?? failWith;
            if (forced) return { success: false, error: forced };
            if (card.has(path)) return { success: false, error: 'File already exists' };
            card.set(path, bytes);
            if (onProgress) onProgress(100);
            return { success: true };
        },
        async deleteFile(ip, filename, targetFolder) {
            const path = pathFor(targetFolder, filename);
            calls.deletes.push({ ip, path, existed: card.has(path) });
            calls.ops.push(`delete:${path}`);
            return card.delete(path);
        },
    });

    return {
        calls,
        card,
        paths: () => [...card.keys()].sort(),
        /** Raw file contents as text, or null when the path is not on the card. */
        text: (path) => (card.has(path) ? card.get(path).toString('utf8') : null),
    };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    __setLoveNoteTransport(null);
});

/** A `fetch` that must never be called. Any call is the failure. */
function forbiddenFetch() {
    globalThis.fetch = async () => {
        throw new Error('the mailbox must not be touched on this path');
    };
}

// ---------------------------------------------------------------------------
// FIRMWARE MIRRORS — the assertions below are about the READER's behaviour
// ---------------------------------------------------------------------------

/**
 * Mirror of `trimId`, crosspoint-reader src/network/MessageSync.cpp:36-43:
 *
 *     std::string trimId(std::string s) {
 *       while (!s.empty() && (s.back()=='\n'||s.back()=='\r'||s.back()==' '||s.back()=='\t')) s.pop_back();
 *       size_t start = 0;
 *       while (start < s.size() && (s[start]==' '||s[start]=='\t')) ++start;
 *       if (start > 0) s.erase(0, start);
 *       if (s.size() > MAX_ID_LEN) s.resize(MAX_ID_LEN);
 *       return s;
 *     }
 *
 * NOTE THE ASYMMETRY, which is the reason this app writes the id with no
 * surrounding whitespace at all: a TRAILING newline is popped, but a LEADING one
 * is not (only space and tab are). `MAX_ID_LEN` is 128 (MessageSync.cpp:34) and
 * is applied as a silent truncation, never as a rejection.
 */
function trimIdLikeFirmware(value) {
    let out = String(value);
    while (out.length > 0 && ['\n', '\r', ' ', '\t'].includes(out[out.length - 1])) {
        out = out.slice(0, -1);
    }
    let start = 0;
    while (start < out.length && (out[start] === ' ' || out[start] === '\t')) start += 1;
    out = out.slice(start);
    if (out.length > NOTE_ID_DEVICE_MAX_CHARS) out = out.slice(0, NOTE_ID_DEVICE_MAX_CHARS);
    return out;
}

/**
 * Mirror of `readStagedId`, MessageSync.cpp:45-50: an absent file and an EMPTY
 * file are the same answer (`readFileToBuffer` returning 0 -> `""`).
 */
function readStagedIdLikeFirmware(card) {
    if (!card.has(ID_PATH)) return '';
    return trimIdLikeFirmware(card.get(ID_PATH).toString('utf8'));
}

/**
 * Mirror of `MessageSync::hasUnreadNote`, MessageSync.cpp:114-119:
 *
 *     if (!Storage.exists(CURRENT_FRAME)) return false;
 *     const std::string id = readStagedId();
 *     if (id.empty()) return true;  // legacy / id-less frame: show (M1 behaviour)
 *     return id != APP_STATE.messageLastShownId;
 */
function hasUnreadNoteLikeFirmware(card, messageLastShownId) {
    if (!card.has(FRAME_PATH)) return false;
    const id = readStagedIdLikeFirmware(card);
    if (id === '') return true;
    return id !== messageLastShownId;
}

/**
 * Mirror of `MessageSync::markCurrentNoteShown`, MessageSync.cpp:121-128: an
 * empty id records NOTHING, which is what makes an id-less note re-show forever.
 * Returns the new `messageLastShownId`.
 */
function markCurrentNoteShownLikeFirmware(card, messageLastShownId) {
    const id = readStagedIdLikeFirmware(card);
    if (id === '') return messageLastShownId;
    return id;
}

// ---------------------------------------------------------------------------
// The two-file write
// ---------------------------------------------------------------------------

test('a direct send writes the frame and THEN the id sidecar', async () => {
    const device = fakeDevice();
    const progress = [];

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame(), (p) => progress.push(p));

    assert.equal(result.success, true, result.error);
    assert.equal(result.idStaged, true);
    assert.equal(result.idError, undefined);
    assert.match(result.noteId, MINTED_ID_SHAPE, `not a minted id: ${result.noteId}`);

    // BOTH slots are cleared before EITHER is written, and the id is written
    // last. Any other interleaving is one of the three silent failures in the
    // header.
    assert.deepEqual(device.calls.ops, [
        `delete:${ID_PATH}`,
        `delete:${FRAME_PATH}`,
        `upload:${FRAME_PATH}`,
        `upload:${ID_PATH}`,
    ]);

    assert.equal(device.calls.uploads[0].byteLength, LOVE_NOTE_FRAME_BYTES);
    // The bytes ARE the contract: bare id, no newline, no padding — byte-identical
    // to what the mailbox route stages (MessageSync.cpp:197).
    assert.equal(device.text(ID_PATH), result.noteId);
    assert.equal(device.calls.uploads[1].byteLength, result.noteId.length);
    assert.deepEqual(device.paths(), [FRAME_PATH, ID_PATH].sort());

    // The sidecar must not drive the progress bar the frame already finished: a
    // second 0->100 ramp for 21 bytes reads to the user as a stall and restart.
    assert.equal(device.calls.uploads[0].progressKind, 'function');
    assert.equal(device.calls.uploads[1].progressKind, 'undefined');
    assert.deepEqual(progress, [100], 'progress must come from the frame only');
});

test('a re-send over an existing pair replaces both, frame before id', async () => {
    // The real-world second note: a previous frame AND its id are on the card,
    // and the firmware refuses to overwrite either.
    const device = fakeDevice({
        existing: { [FRAME_PATH]: 'old frame bytes', [ID_PATH]: 'kzz11111-000oldnoteid' },
    });

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame(0x0f));

    assert.equal(result.success, true, result.error);
    assert.equal(result.idStaged, true);
    assert.deepEqual(device.calls.deletes.map(d => `${d.path}:${d.existed}`), [
        `${ID_PATH}:true`,
        `${FRAME_PATH}:true`,
    ]);

    const iFrame = device.calls.ops.indexOf(`upload:${FRAME_PATH}`);
    const iId = device.calls.ops.indexOf(`upload:${ID_PATH}`);
    assert.ok(iFrame >= 0 && iId > iFrame, `id uploaded before the frame: ${device.calls.ops}`);
    // Every delete happens before every upload, so no id can name a frame that
    // is only partly written.
    assert.ok(
        device.calls.ops.slice(0, 2).every(op => op.startsWith('delete:')),
        `deletes did not come first: ${device.calls.ops}`
    );
    assert.equal(device.text(ID_PATH), result.noteId);
    assert.notEqual(result.noteId, 'kzz11111-000oldnoteid');
});

test('a failed frame upload stages NO id', async () => {
    const device = fakeDevice({ failWith: 'WebSocket connection failed' });

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame());

    assert.equal(result.success, false);
    assert.equal(result.error, 'WebSocket connection failed');
    assert.equal(result.noteId, undefined);
    // An id whose frame never landed is WORSE than no id: the reader would show
    // the frame it already has and mark this id shown, so the note the user sent
    // could never appear.
    assert.deepEqual(device.calls.ops, [
        `delete:${ID_PATH}`,
        `delete:${FRAME_PATH}`,
        `upload:${FRAME_PATH}`,
    ]);
    assert.equal(device.text(ID_PATH), null);
});

test('a failed send leaves no stale id behind for the reader to trip over', async () => {
    // The previous note's id is on the card and has already been displayed.
    const lastShown = 'kzz11111-000oldnoteid';
    const device = fakeDevice({
        existing: { [FRAME_PATH]: 'old frame bytes', [ID_PATH]: lastShown },
        failWith: 'Cannot reach X4. Network request failed',
    });

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame());

    assert.equal(result.success, false);
    assert.deepEqual(device.paths(), [], 'both slots must be empty, not half-written');
    // Nothing staged -> nothing to show. The failure is visible in the app and
    // invisible on the reader, which is the correct pairing.
    assert.equal(hasUnreadNoteLikeFirmware(device.card, lastShown), false);
});

test('an id upload failure is a DEGRADED success, not a failed send', async () => {
    const device = fakeDevice({
        failUpload: (path) => (path === ID_PATH ? 'ERROR: no space left on device' : null),
    });

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame());

    // The note IS on the reader and WILL display; reporting failure would both
    // misdescribe that and (for a host) trigger a mailbox re-delivery of a note
    // the user can already see.
    assert.equal(result.success, true, result.error);
    assert.equal(result.idStaged, false);
    assert.match(result.idError, /no space left on device/);
    assert.match(result.idError, /every wake/i, 'the consequence has to be stated');
    // NOT recorded: the id is not on the device, so History must not claim it is.
    assert.equal(result.noteId, undefined);
    assert.deepEqual(device.paths(), [FRAME_PATH]);
    // Degraded exactly to the pre-sidecar behaviour — shown, but on every wake.
    assert.equal(hasUnreadNoteLikeFirmware(device.card, 'anything'), true);
});

test('stageId:false writes the legacy id-less frame but still clears the old id', async () => {
    const lastShown = 'kzz11111-000oldnoteid';
    const device = fakeDevice({
        existing: { [FRAME_PATH]: 'old frame bytes', [ID_PATH]: lastShown },
    });

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame(), undefined, { stageId: false });

    assert.equal(result.success, true, result.error);
    assert.equal(result.idStaged, false);
    assert.equal(result.noteId, undefined);
    assert.deepEqual(device.calls.ops, [
        `delete:${ID_PATH}`,
        `delete:${FRAME_PATH}`,
        `upload:${FRAME_PATH}`,
    ]);

    // The opt-out is "no id", NEVER "the previous note's id". With the old id
    // still there the new frame would be suppressed outright...
    const ifTheIdHadSurvived = new Map(device.card).set(ID_PATH, Buffer.from(lastShown, 'utf8'));
    assert.equal(hasUnreadNoteLikeFirmware(ifTheIdHadSurvived, lastShown), false);
    // ...whereas with the id cleared it is merely re-shown, which is what the
    // legacy behaviour actually was.
    assert.equal(hasUnreadNoteLikeFirmware(device.card, lastShown), true);
});

// ---------------------------------------------------------------------------
// Id validity — charset, length, and the firmware's own trim
// ---------------------------------------------------------------------------

test('an explicit id is staged verbatim', async () => {
    const device = fakeDevice();
    const id = 'note.2026-07-28_x~9';

    const result = await sendLoveNoteFrame('10.0.0.5', goodFrame(), undefined, { noteId: id });

    assert.equal(result.success, true, result.error);
    assert.equal(result.noteId, id);
    assert.equal(device.text(ID_PATH), id);
});

test('an unusable id is rejected BEFORE anything is written', async () => {
    for (const bad of [
        '',
        'has space',
        'has\nnewline',
        'has\ttab',
        'trailing ',
        'slash/es',
        'quote"s',
        'a'.repeat(NOTE_ID_DEVICE_MAX_CHARS + 1),
    ]) {
        const device = fakeDevice();
        const result = await sendLoveNoteFrame('10.0.0.5', goodFrame(), undefined, { noteId: bad });
        assert.equal(result.success, false, `accepted a bad id: ${JSON.stringify(bad)}`);
        assert.ok(describeNoteIdProblem(bad), `describeNoteIdProblem missed ${JSON.stringify(bad)}`);
        // Half-writing the frame and then discovering the id is unusable would
        // leave the reader in the id-less state this whole file exists to end.
        assert.deepEqual(device.calls.ops, [], `touched the device for ${JSON.stringify(bad)}`);
    }

    // The boundary is the reader's silent truncation point, not one off it.
    assert.equal(describeNoteIdProblem('a'.repeat(NOTE_ID_DEVICE_MAX_CHARS)), null);
    assert.match(
        describeNoteIdProblem('a'.repeat(NOTE_ID_DEVICE_MAX_CHARS + 1)),
        new RegExp(String(NOTE_ID_DEVICE_MAX_CHARS))
    );
    assert.equal(describeNoteIdProblem(mintNoteId()), null);
    assert.ok(describeNoteIdProblem(undefined));
    assert.ok(describeNoteIdProblem(null));
});

test('staged bytes survive the firmware trimId unchanged', async () => {
    // 200 real ids, not one specimen: the minter's alphabet is what has to be
    // trim-safe, and a '-' or a digit run is where a hand-picked example lies.
    for (let i = 0; i < 200; i++) {
        const id = mintNoteId();
        const text = Buffer.from(encodeNoteIdFile(id)).toString('utf8');
        assert.equal(text, id);
        assert.equal(trimIdLikeFirmware(text), id, `trimId changed ${JSON.stringify(text)}`);
        assert.ok(id.length <= NOTE_ID_DEVICE_MAX_CHARS);
        // No whitespace to trim in either direction.
        assert.equal(text.trim(), text);
    }

    const id = mintNoteId();
    // A TRAILING newline would be tolerated — which is why one is merely
    // unnecessary rather than dangerous...
    assert.equal(trimIdLikeFirmware(`${id}\n`), id);
    assert.equal(trimIdLikeFirmware(`${id}\r\n`), id);
    assert.equal(trimIdLikeFirmware(`  ${id}\t`), id);
    // ...but a LEADING newline is NOT stripped (trimId only strips leading space
    // and tab), so it would produce an id that never matches. That asymmetry is
    // the reason the writer emits no surrounding whitespace at all.
    assert.notEqual(trimIdLikeFirmware(`\n${id}`), id);
    // And an over-long id is silently truncated, never rejected — the reason
    // describeNoteIdProblem enforces the length itself.
    const long = 'x'.repeat(NOTE_ID_DEVICE_MAX_CHARS + 5);
    assert.equal(trimIdLikeFirmware(long).length, NOTE_ID_DEVICE_MAX_CHARS);
    assert.notEqual(trimIdLikeFirmware(long), long);
});

// ---------------------------------------------------------------------------
// What the reader actually does with the pair
// ---------------------------------------------------------------------------

test('the reader shows a directly-sent note exactly once, then the next one', async () => {
    let messageLastShownId = '';   // APP_STATE.messageLastShownId on a fresh device

    const device = fakeDevice();
    const first = await sendLoveNoteFrame('10.0.0.5', goodFrame(0x0f));
    assert.equal(first.success, true, first.error);

    assert.equal(hasUnreadNoteLikeFirmware(device.card, messageLastShownId), true);
    messageLastShownId = markCurrentNoteShownLikeFirmware(device.card, messageLastShownId);
    assert.equal(messageLastShownId, first.noteId);
    // THE WHOLE POINT: the second wake must not re-display it.
    assert.equal(hasUnreadNoteLikeFirmware(device.card, messageLastShownId), false);

    const second = await sendLoveNoteFrame('10.0.0.5', goodFrame(0xf0));
    assert.equal(second.success, true, second.error);
    assert.notEqual(second.noteId, first.noteId);
    assert.equal(hasUnreadNoteLikeFirmware(device.card, messageLastShownId), true);
});

test('an id-less frame is what re-shows forever (the bug the sidecar fixes)', async () => {
    let messageLastShownId = '';

    const device = fakeDevice();
    const sent = await sendLoveNoteFrame('10.0.0.5', goodFrame(), undefined, { stageId: false });
    assert.equal(sent.success, true, sent.error);

    // Three wakes, no state change: markCurrentNoteShown returns early on an
    // empty id (MessageSync.cpp:122), so hasUnreadNote never stops saying yes.
    for (let wake = 0; wake < 3; wake++) {
        assert.equal(hasUnreadNoteLikeFirmware(device.card, messageLastShownId), true);
        messageLastShownId = markCurrentNoteShownLikeFirmware(device.card, messageLastShownId);
        assert.equal(messageLastShownId, '');
    }
});

// ---------------------------------------------------------------------------
// Orchestration: one id per send attempt, whichever route ran
// ---------------------------------------------------------------------------

test('a host direct send reports the id it staged', async () => {
    const device = fakeDevice();
    forbiddenFetch();

    const result = await sendLoveNote(
        { role: 'host', ip: '10.0.0.5', mailboxUrl: MAILBOX_BASE, mailboxWriteToken: MAILBOX_TOKEN },
        goodFrame()
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'direct');
    assert.equal(result.idStaged, true);
    assert.match(result.noteId, MINTED_ID_SHAPE);
    // History records `result.noteId` (ComposeScreen.tsx:841). It has to be the
    // id that is actually on the card, or the row describes a different note.
    assert.equal(device.text(ID_PATH), result.noteId);
    assert.deepEqual(result.attempts.map(a => `${a.path}:${a.success}`), ['direct:true']);
});

test('a fallback to the mailbox stages no sidecar and reports the mailbox id', async () => {
    // The reader is asleep — the NORMAL state — so the frame upload never lands.
    const device = fakeDevice({ failWith: 'WebSocket connection failed' });
    let published = 0;
    globalThis.fetch = async () => {
        published += 1;
        return {
            status: 200,
            ok: true,
            async text() {
                return JSON.stringify({ ok: true, id: 'server-side-id' });
            },
        };
    };

    const result = await sendLoveNote(
        { role: 'host', ip: '10.0.0.5', mailboxUrl: MAILBOX_BASE, mailboxWriteToken: MAILBOX_TOKEN },
        goodFrame()
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox');
    assert.equal(published, 1);
    // ONE id is in play per send attempt: the direct leg mints only after its
    // frame lands, so a fallback leaves the mailbox's id as the only one.
    assert.equal(result.noteId, 'server-side-id');
    assert.equal(result.idStaged, undefined);
    assert.ok(
        !device.calls.ops.includes(`upload:${ID_PATH}`),
        `staged an id for a frame that never landed: ${device.calls.ops}`
    );
    assert.deepEqual(device.paths(), []);
});
