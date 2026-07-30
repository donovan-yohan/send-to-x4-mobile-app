/**
 * reader_reachability — the FAST SKIP, and the phase narration that goes with it.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and it is a user-visible stall rather than a
 * lost note. A host send tries the reader DIRECT first, and the reader is asleep
 * almost all of the time. Asleep answers nothing, so every leg of the direct
 * attempt burns its own timeout before concluding that: a 10 s mkdir abort, then
 * a WebSocket connect, and the NOTE path does it twice (frame, then id sidecar).
 * Log-verified, that stacks to ~15-25 s of a spinner sitting at 0% before the
 * mailbox fallback fires and succeeds in under a second. The delivery was never
 * at risk; the wait was pure discovery cost.
 *
 * So the properties pinned below are, in order of how much they cost when broken:
 *
 *   1. THE SKIP MUST NEVER COST A DELIVERY. It is consulted only where a mailbox
 *      fallback exists, and "no probe in this runtime" resolves to REACHABLE
 *      (try direct, exactly as before). Two tests hold each half: a host with no
 *      usable mailbox still attempts direct even when the probe says the reader
 *      is asleep, and an unloadable probe changes nothing at all.
 *   2. THE DECISION MATRIX. fresh-reachable -> direct, fresh-unreachable ->
 *      mailbox with the reader never touched, stale -> probe first,
 *      probe-failure/timeout -> mailbox. Driven for BOTH senders, because
 *      `sendLoveNote` and `routeEpubSend` are supposed to handle the same asleep
 *      reader the same way, and a divergence there is invisible until a user
 *      notices books and notes behaving differently.
 *   3. THE PROBE IS ASKED ONCE. A seven-book add must not probe seven times, and
 *      a direct attempt that died unreachable must not be repeated per file.
 *   4. THE PHASES. `fetch` cannot report upload bytes, so the mailbox route has
 *      no percent to show at ALL; the phase string is the only honest thing on
 *      screen for the whole send. Sequences are asserted per route.
 *
 * Everything runs under node against the REAL modules, through the same seams
 * the rest of this suite uses: `__setReaderProbe` for the probe,
 * `__setLoveNoteTransport` / `__setEpubTransport` for the reader, and a stubbed
 * `globalThis.fetch` for the mailbox. NOTHING here touches the network, and no
 * test waits on a real timeout.
 *
 * Run:  node --import tsx --test scripts/reader-reachability.test.js
 */

import test, { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
    READER_PROBE_TIMEOUT_MS,
    READER_REACHABILITY_FRESH_MS,
    SEND_PHASE_LABEL,
    __resetReaderReachability,
    __setReaderProbe,
    isReachabilityFresh,
    noteReaderUnreachable,
    resolveReaderReachability,
} from '../src/services/reader_reachability';
import {
    LOVE_NOTE_FRAME_BYTES,
    __setLoveNoteTransport,
    sendLoveNote,
} from '../src/services/love_note_sender';
import {
    EPUB_MIME_TYPE,
    __setEpubFileReader,
    __setEpubTransport,
    routeEpubSend,
    sendEpubsRouted,
} from '../src/services/epub_sender';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IP = '192.168.4.1';
const MAILBOX = 'https://mail.example.net/m/aBcDeFgHiJkLmNoPqRsTuV';
const TOKEN = 'wr_secret_token';

/** The error string a reader that is simply not there produces. */
const ASLEEP = 'Network request failed (GET http://192.168.4.1/api/files?path=/)';

function goodFrame(fill = 0xff) {
    return new Uint8Array(LOVE_NOTE_FRAME_BYTES).fill(fill);
}

function pick(overrides = {}) {
    return {
        uri: 'file:///cache/DocumentPicker/dune.epub',
        name: 'Dune.epub',
        size: 1024,
        mimeType: EPUB_MIME_TYPE,
        ...overrides,
    };
}

/** The four facts a route decision is made from. */
function destination(overrides = {}) {
    return { role: 'host', ip: IP, mailboxUrl: MAILBOX, mailboxWriteToken: TOKEN, ...overrides };
}

/**
 * Recording stand-in for `checkCrossPointConnection`.
 *
 * Captures the OPTIONS as well as the ip: the abort budget is half of what makes
 * this probe a fast skip rather than a second stall, so a call that quietly
 * dropped the timeout would still pass a call-count assertion.
 */
function fakeProbe(answer) {
    const calls = [];
    __setReaderProbe(async (ip, options) => {
        calls.push({ ip, options });
        const next = typeof answer === 'function' ? answer(ip, calls.length) : answer;
        if (next instanceof Error) throw next;
        return next;
    });
    return calls;
}

/** A probe that must never run. Any call is the failure. */
function forbiddenProbe() {
    const calls = [];
    __setReaderProbe(async ip => {
        calls.push(ip);
        throw new Error(`the reader must not be probed here (${ip})`);
    });
    return calls;
}

/** Recording stand-in for the love-note half of crosspoint_upload. */
function fakeNoteDevice({ failWith = null } = {}) {
    const calls = { uploads: [], deletes: [], ops: [] };
    __setLoveNoteTransport({
        async upload(ip, data, filename, onProgress, targetFolder) {
            calls.uploads.push({ ip, filename, targetFolder, byteLength: data.byteLength });
            calls.ops.push(`upload:${filename}`);
            if (failWith) return { success: false, error: failWith };
            if (onProgress) onProgress(100);
            return { success: true };
        },
        async deleteFile(ip, filename, targetFolder) {
            calls.deletes.push({ ip, filename, targetFolder });
            calls.ops.push(`delete:${filename}`);
            return false;
        },
    });
    return calls;
}

/** Recording stand-in for the epub half of crosspoint_upload. */
function fakeBookDevice({ failWith = null } = {}) {
    const calls = { uploads: [], deletes: [], ops: [] };
    __setEpubTransport({
        async uploadLocalFile(ip, fileUri, filename, onProgress, targetFolder) {
            calls.uploads.push({ ip, fileUri, filename, targetFolder });
            calls.ops.push(`upload:${filename}`);
            if (failWith) return { success: false, error: failWith };
            if (onProgress) onProgress(100);
            return { success: true };
        },
        async deleteFile(ip, filename, targetFolder) {
            calls.deletes.push({ ip, filename, targetFolder });
            calls.ops.push(`delete:${filename}`);
            return false;
        },
    });
    return calls;
}

/**
 * A reader that must never be contacted.
 *
 * THIS is the assertion that a fast skip actually skipped: a device stub that
 * merely recorded zero calls could not tell "not called" apart from "called and
 * the recorder was reset".
 */
function forbiddenDevices() {
    __setLoveNoteTransport({
        async upload() {
            throw new Error('direct upload must not be attempted on this route');
        },
        async deleteFile() {
            throw new Error('direct delete must not be attempted on this route');
        },
    });
    __setEpubTransport({
        async uploadLocalFile() {
            throw new Error('direct upload must not be attempted on this route');
        },
        async deleteFile() {
            throw new Error('direct delete must not be attempted on this route');
        },
    });
}

function fakeFetch(responder) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return typeof responder === 'function' ? await responder(url, init, calls.length) : responder;
    };
    return calls;
}

function reply(status, body = '') {
    return {
        status,
        ok: status >= 200 && status < 300,
        async text() {
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
    };
}

/** A mailbox that must never be contacted. */
function forbiddenFetch() {
    const calls = [];
    globalThis.fetch = async url => {
        calls.push(url);
        throw new Error(`the mailbox must not be contacted on this route (${url})`);
    };
    return calls;
}

/** Stand-in for `expo-file-system/legacy` + base64ToUint8Array. */
function fakeReader(bytes = 2048) {
    const reads = [];
    __setEpubFileReader({
        async readBytes(fileUri) {
            reads.push(fileUri);
            return new Uint8Array(bytes);
        },
    });
    return reads;
}

/** Collects an `onPhase` sequence, and the labels a UI would render from it. */
function phaseRecorder() {
    const phases = [];
    return {
        phases,
        onPhase: phase => phases.push(phase),
        labels: () => phases.map(p => SEND_PHASE_LABEL[p]),
    };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    __setReaderProbe(null);
    __setLoveNoteTransport(null);
    __setEpubTransport(null);
    __setEpubFileReader(null);
    // The probe cache is process-wide by design (that is what collapses a
    // seven-book batch into one probe), so every test starts from empty or the
    // matrix below would be reading the previous test's answer.
    __resetReaderReachability();
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('freshness: inside the window is trusted, outside it is not, and so is a stamp from the future', () => {
    const now = 1_000_000;
    assert.equal(isReachabilityFresh(now, now), true, 'this instant');
    assert.equal(isReachabilityFresh(now - READER_REACHABILITY_FRESH_MS, now), true, 'exactly at the edge');
    assert.equal(isReachabilityFresh(now - READER_REACHABILITY_FRESH_MS - 1, now), false, 'one ms past');
    // A NEGATIVE age is not "extra fresh". A clock that jumped backwards, or a
    // caller stamping the future, produces an observation this process cannot
    // reason about — and silently trusting it would pin a wrong answer for as
    // long as the skew lasts.
    assert.equal(isReachabilityFresh(now + 1, now), false, 'stamped in the future');
    assert.equal(isReachabilityFresh(undefined, now), false, 'never measured');
    assert.equal(isReachabilityFresh(Number.NaN, now), false, 'not a time at all');
});

// ---------------------------------------------------------------------------
// THE DECISION MATRIX — resolver level
// ---------------------------------------------------------------------------

test('matrix: a FRESH REACHABLE hint answers without probing', async () => {
    const probes = forbiddenProbe();
    const now = 1_000_000;

    const answer = await resolveReaderReachability(IP, { reachable: true, checkedAt: now - 1_000 }, { now });

    assert.deepEqual(answer, { reachable: true, source: 'hint' });
    // ConnectionProvider probed this exact endpoint moments ago. Asking again
    // would be a second round trip for an answer already on screen.
    assert.equal(probes.length, 0);
});

test('matrix: a FRESH UNREACHABLE hint answers without probing', async () => {
    const probes = forbiddenProbe();
    const now = 1_000_000;

    const answer = await resolveReaderReachability(IP, { reachable: false, checkedAt: now - 1_000 }, { now });

    assert.deepEqual(answer, { reachable: false, source: 'hint' });
    assert.equal(probes.length, 0);
});

test('matrix: a STALE hint is re-probed, and the probe wins', async () => {
    const probes = fakeProbe({ success: true });
    const now = 1_000_000;

    // The reader was asleep a minute ago. A minute is several sleep/wake cycles;
    // trusting it would route to the mailbox while the reader sits awake.
    const answer = await resolveReaderReachability(
        IP,
        { reachable: false, checkedAt: now - READER_REACHABILITY_FRESH_MS - 1 },
        { now }
    );

    assert.deepEqual(answer, { reachable: true, source: 'probe' });
    assert.equal(probes.length, 1);
    assert.equal(probes[0].ip, IP);
});

test('matrix: NO hint at all probes', async () => {
    const probes = fakeProbe({ success: true });

    assert.deepEqual(await resolveReaderReachability(IP, null), { reachable: true, source: 'probe' });
    assert.equal(probes.length, 1);
});

test('matrix: a probe that TIMES OUT answers unreachable, carrying its reason', async () => {
    const probes = fakeProbe({ success: false, error: ASLEEP });

    const answer = await resolveReaderReachability(IP, null);

    assert.equal(answer.reachable, false);
    assert.equal(answer.source, 'probe');
    assert.equal(answer.error, ASLEEP);
    assert.equal(probes.length, 1);
});

test('the probe is asked with the SHORT budget and no diagnostic retry', async () => {
    const probes = fakeProbe({ success: false, error: ASLEEP });

    await resolveReaderReachability(IP, null);

    // 2.5 s, not checkCrossPointConnection's 5 s default: this runs while a user
    // watches a send.
    assert.equal(probes[0].options.timeoutMs, READER_PROBE_TIMEOUT_MS);
    // And WITHOUT the 3 s root-URL retry that enriches a failure message — that
    // would more than double the worst case of a check whose whole point is speed.
    assert.equal(probes[0].options.diagnostics, false);
});

test('a probe that THROWS is unreachable, not an exception', async () => {
    fakeProbe(new Error('boom'));

    const answer = await resolveReaderReachability(IP, null);

    assert.equal(answer.reachable, false);
    assert.equal(answer.source, 'probe');
    assert.match(answer.error, /boom/);
});

test('NO PROBE in this runtime resolves to REACHABLE, so routing is unchanged', async () => {
    __setReaderProbe(null);

    // Rule 2 of the module header, and the reason node tests and the web preview
    // route exactly as they always did: absence of information must never be
    // allowed to change a route.
    assert.deepEqual(await resolveReaderReachability(IP, null), { reachable: true, source: 'unknown' });
    // A blank host is the same "nothing to ask" case.
    assert.deepEqual(await resolveReaderReachability('', null), { reachable: true, source: 'unknown' });
});

// ---------------------------------------------------------------------------
// ASK ONCE
// ---------------------------------------------------------------------------

test('a probe result inside the window is reused, so a batch probes ONCE', async () => {
    const probes = fakeProbe({ success: false, error: ASLEEP });

    const first = await resolveReaderReachability(IP, null);
    const second = await resolveReaderReachability(IP, null);
    const third = await resolveReaderReachability(IP, null);

    assert.equal(first.source, 'probe');
    assert.equal(second.source, 'cache');
    assert.equal(third.source, 'cache');
    assert.equal(second.reachable, false);
    assert.equal(second.error, ASLEEP, 'the cached answer must carry the reason too');
    assert.equal(probes.length, 1, 'three questions, one round trip');
});

test('the cached probe is per HOST and expires with the window', async () => {
    const probes = fakeProbe({ success: true });

    await resolveReaderReachability(IP, null);
    // A different reader is a different question.
    await resolveReaderReachability('10.0.0.9', null);
    assert.equal(probes.length, 2);

    // And an answer older than the window is not evidence about now: the reader
    // drops off the network when it goes back to sleep.
    const answer = await resolveReaderReachability('10.0.0.9', null, {
        now: Date.now() + READER_REACHABILITY_FRESH_MS + 1,
    });
    assert.equal(answer.source, 'probe');
    assert.equal(probes.length, 3);
});

test('a dead direct upload downgrades the cached answer, but never invents one', async () => {
    // NOTHING CACHED YET: a runtime that never probes (every other test file in
    // this suite, and the web preview) must not start fast-skipping off the back
    // of one failed upload.
    noteReaderUnreachable(IP, 'WebSocket connection failed');
    const probes = fakeProbe({ success: true });
    assert.equal((await resolveReaderReachability(IP, null)).source, 'probe');
    assert.equal(probes.length, 1);

    // Now there IS an entry, and it says reachable. The upload that just died is
    // the stronger observation — without this, book 2 of 7 repeats the whole
    // stall book 1 already proved pointless.
    noteReaderUnreachable(IP, 'WebSocket connection failed');
    const after = await resolveReaderReachability(IP, null);
    assert.equal(after.reachable, false);
    assert.equal(after.source, 'cache');
    assert.equal(after.error, 'WebSocket connection failed');
    assert.equal(probes.length, 1, 'the downgrade must not cost another round trip');
});

// ---------------------------------------------------------------------------
// THE DECISION MATRIX — notes (sendLoveNote)
// ---------------------------------------------------------------------------

test('note: FRESH REACHABLE hint goes DIRECT, without probing or opening the mailbox', async () => {
    const device = fakeNoteDevice();
    const probes = forbiddenProbe();
    const fetches = forbiddenFetch();
    const phase = phaseRecorder();

    const result = await sendLoveNote(destination(), goodFrame(), undefined, {
        reachability: { reachable: true, checkedAt: Date.now() },
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'direct');
    assert.equal(result.skippedDirect, undefined, 'nothing was skipped');
    assert.deepEqual(device.ops, [
        'delete:current.id',
        'delete:current.frame',
        'upload:current.frame',
        'upload:current.id',
    ]);
    assert.equal(probes.length, 0);
    assert.equal(fetches.length, 0);
    assert.deepEqual(phase.phases, ['looking', 'direct']);
});

test('note: FRESH UNREACHABLE hint goes to the MAILBOX IMMEDIATELY — the reader is never touched', async () => {
    // THE WHOLE POINT. Before the skip this case spent ~15-25 s in stacked
    // mkdir/WebSocket timeouts (twice over, for the frame and the id sidecar)
    // before the mailbox leg it was always going to take.
    forbiddenDevices();
    const probes = forbiddenProbe();
    const fetches = fakeFetch(reply(200, { ok: true, id: 'note-1' }));
    const phase = phaseRecorder();

    const result = await sendLoveNote(destination(), goodFrame(), undefined, {
        reachability: { reachable: false, checkedAt: Date.now() },
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox');
    assert.equal(result.noteId, 'note-1');
    assert.equal(result.skippedDirect.reachable, false);
    assert.equal(result.skippedDirect.source, 'hint');
    // `attempts` stays a log of what actually RAN. Nothing was tried against the
    // reader, so no 'direct' row is invented.
    assert.deepEqual(result.attempts.map(a => a.path), ['mailbox']);
    assert.equal(probes.length, 0);
    assert.equal(fetches.length, 1);
    assert.deepEqual(phase.labels(), ['Looking for the reader…', 'Sending to the mailbox…']);
});

test('note: a STALE hint probes FIRST, and an awake answer still goes direct', async () => {
    const device = fakeNoteDevice();
    const probes = fakeProbe({ success: true });
    const fetches = forbiddenFetch();

    const result = await sendLoveNote(destination(), goodFrame(), undefined, {
        reachability: { reachable: false, checkedAt: Date.now() - READER_REACHABILITY_FRESH_MS - 1 },
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'direct');
    assert.equal(probes.length, 1, 'the stale hint must not have been trusted');
    assert.equal(device.uploads.length, 2);
    assert.equal(fetches.length, 0);
});

test('note: a probe that says ASLEEP routes to the mailbox with the reader untouched', async () => {
    forbiddenDevices();
    const probes = fakeProbe({ success: false, error: ASLEEP });
    const fetches = fakeFetch(reply(200, { ok: true, id: 'note-2' }));
    const phase = phaseRecorder();

    const result = await sendLoveNote(destination(), goodFrame(), undefined, {
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox');
    assert.equal(result.skippedDirect.source, 'probe');
    assert.equal(result.skippedDirect.error, ASLEEP);
    assert.equal(probes.length, 1);
    assert.equal(fetches.length, 1);
    assert.deepEqual(phase.phases, ['looking', 'mailbox']);
});

test('note: a skip whose mailbox then fails names BOTH problems, in the usual wording', async () => {
    forbiddenDevices();
    fakeProbe({ success: false, error: ASLEEP });
    fakeFetch(reply(503, 'busy'));

    const result = await sendLoveNote(destination(), goodFrame(), undefined, {
        queueOnFailure: false,
    });

    assert.equal(result.success, false);
    // Identical sentence shape to the tried-and-failed path, so a user cannot
    // tell the two apart by wording when they mean the same thing.
    assert.match(result.error, /^Reader unreachable \(.*\); mailbox failed too: /);
    assert.match(result.error, /Network request failed/);
});

test('note: with NO USABLE MAILBOX the reader is tried anyway — the skip is not a gate', async () => {
    // Rule 1 of the module header. With nothing to fall back to, the direct
    // attempt is the ONLY thing that can deliver, so a probe that is wrong (a
    // reader on its own AP, a slow first association) must not be allowed to
    // turn a slow send into a failed one.
    const device = fakeNoteDevice();
    const probes = forbiddenProbe();

    const result = await sendLoveNote(
        destination({ mailboxUrl: '', mailboxWriteToken: '' }),
        goodFrame(),
        undefined,
        { reachability: { reachable: false, checkedAt: Date.now() } }
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'direct');
    assert.equal(device.uploads.length, 2);
    // Not even asked: there is no decision the answer could change.
    assert.equal(probes.length, 0);
});

test('note: a CLIENT still goes straight to the mailbox, and never looks for a reader', async () => {
    forbiddenDevices();
    const probes = forbiddenProbe();
    const fetches = fakeFetch(reply(200, { ok: true, id: 'note-3' }));
    const phase = phaseRecorder();

    const result = await sendLoveNote(destination({ role: 'client' }), goodFrame(), undefined, {
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox');
    assert.equal(probes.length, 0);
    assert.equal(fetches.length, 1);
    // No 'looking' phase: a client has no LAN route to look for, and saying it
    // was looking would be narrating a step that does not exist.
    assert.deepEqual(phase.phases, ['mailbox']);
});

test('note: a reader that ANSWERS but fails mid-upload still falls back, phases and all', async () => {
    const device = fakeNoteDevice({ failWith: 'WebSocket upload timed out' });
    fakeProbe({ success: true });
    const fetches = fakeFetch(reply(200, { ok: true, id: 'note-4' }));
    const phase = phaseRecorder();

    const result = await sendLoveNote(destination(), goodFrame(), undefined, {
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.path, 'mailbox');
    // The probe said awake, so direct was genuinely tried — both rows are real.
    assert.deepEqual(result.attempts.map(a => [a.path, a.success]), [
        ['direct', false],
        ['mailbox', true],
    ]);
    assert.equal(device.uploads.length, 1);
    assert.equal(fetches.length, 1);
    assert.deepEqual(phase.labels(), [
        'Looking for the reader…',
        'Sending to their reader…',
        'Sending to the mailbox…',
    ]);
});

// ---------------------------------------------------------------------------
// THE DECISION MATRIX — books (routeEpubSend)
// ---------------------------------------------------------------------------

test('book: FRESH REACHABLE hint goes DIRECT, without probing or opening the mailbox', async () => {
    const device = fakeBookDevice();
    const probes = forbiddenProbe();
    const fetches = forbiddenFetch();
    const phase = phaseRecorder();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub', undefined, {
        reachability: { reachable: true, checkedAt: Date.now() },
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'direct');
    assert.equal(result.skippedDirect, undefined);
    assert.equal(device.uploads.length, 1);
    assert.equal(probes.length, 0);
    assert.equal(fetches.length, 0);
    assert.deepEqual(phase.phases, ['looking', 'direct']);
});

test('book: FRESH UNREACHABLE hint goes to the MAILBOX IMMEDIATELY — the reader is never touched', async () => {
    forbiddenDevices();
    const probes = forbiddenProbe();
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-1', filename: 'Dune.epub', bytes: 2048 }));
    fakeReader(2048);
    const phase = phaseRecorder();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub', undefined, {
        reachability: { reachable: false, checkedAt: Date.now() },
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'mailbox');
    assert.equal(result.bookId, 'bk-1');
    assert.equal(result.skippedDirect.source, 'hint');
    assert.deepEqual(result.attempts.map(a => a.route), ['mailbox']);
    assert.equal(probes.length, 0);
    assert.equal(fetches.length, 1);
    assert.deepEqual(phase.labels(), ['Looking for the reader…', 'Sending to the mailbox…']);
});

test('book: a STALE hint probes FIRST, and an awake answer still goes direct', async () => {
    const device = fakeBookDevice();
    const probes = fakeProbe({ success: true });
    const fetches = forbiddenFetch();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub', undefined, {
        reachability: { reachable: true, checkedAt: Date.now() - READER_REACHABILITY_FRESH_MS - 1 },
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'direct');
    assert.equal(probes.length, 1);
    assert.equal(device.uploads.length, 1);
    assert.equal(fetches.length, 0);
});

test('book: a probe that says ASLEEP routes to the mailbox with the reader untouched', async () => {
    forbiddenDevices();
    const probes = fakeProbe({ success: false, error: ASLEEP });
    const fetches = fakeFetch(reply(200, { ok: true, id: 'bk-2', filename: 'Dune.epub' }));
    fakeReader();
    const phase = phaseRecorder();

    const result = await routeEpubSend(destination(), pick().uri, 'Dune.epub', undefined, {
        onPhase: phase.onPhase,
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'mailbox');
    assert.equal(result.skippedDirect.error, ASLEEP);
    assert.equal(probes.length, 1);
    assert.equal(fetches.length, 1);
    assert.deepEqual(phase.phases, ['looking', 'mailbox']);
});

test('book: with NO USABLE MAILBOX the reader is tried anyway — the skip is not a gate', async () => {
    const device = fakeBookDevice();
    const probes = forbiddenProbe();

    const result = await routeEpubSend(
        destination({ mailboxUrl: '', mailboxWriteToken: '' }),
        pick().uri,
        'Dune.epub',
        undefined,
        { reachability: { reachable: false, checkedAt: Date.now() } }
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'direct');
    assert.equal(device.uploads.length, 1);
    assert.equal(probes.length, 0);
});

test('book: a CLIENT goes straight to the mailbox with no looking phase', async () => {
    forbiddenDevices();
    const probes = forbiddenProbe();
    fakeFetch(reply(200, { ok: true, id: 'bk-3', filename: 'Dune.epub' }));
    fakeReader();
    const phase = phaseRecorder();

    const result = await routeEpubSend(
        destination({ role: 'client' }),
        pick().uri,
        'Dune.epub',
        undefined,
        { onPhase: phase.onPhase }
    );

    assert.equal(result.success, true, result.error);
    assert.equal(result.route, 'mailbox');
    assert.equal(probes.length, 0);
    assert.deepEqual(phase.phases, ['mailbox']);
});

// ---------------------------------------------------------------------------
// BATCHES — the case that used to stack the stall per file
// ---------------------------------------------------------------------------

test('batch: an asleep reader is discovered ONCE, and no book touches the card', async () => {
    forbiddenDevices();
    const probes = fakeProbe({ success: false, error: ASLEEP });
    const fetches = fakeFetch((url, init, n) =>
        reply(200, { ok: true, id: `bk-${n}`, filename: `Book${n}.epub` })
    );
    fakeReader();
    const phases = [];

    const picks = [
        pick({ name: 'Book1.epub', uri: 'file:///cache/1.epub' }),
        pick({ name: 'Book2.epub', uri: 'file:///cache/2.epub' }),
        pick({ name: 'Book3.epub', uri: 'file:///cache/3.epub' }),
    ];

    const result = await sendEpubsRouted(destination(), picks, {
        onPhase: (phase, index, total) => phases.push(`${index}/${total}:${phase}`),
    });

    assert.equal(result.succeeded, 3, JSON.stringify(result.failed));
    assert.deepEqual(result.outcomes.map(o => o.route), ['mailbox', 'mailbox', 'mailbox']);
    // ONE probe for the whole batch. Three would be three round trips for an
    // answer that cannot have changed in the milliseconds between them, and the
    // pre-skip behaviour was three FULL stalls.
    assert.equal(probes.length, 1);
    assert.equal(fetches.length, 3);
    // Every file still narrates its own route, carrying its position, so the
    // overlay never loses the "2/3" context while the phase line changes.
    assert.deepEqual(phases, [
        '1/3:looking',
        '1/3:mailbox',
        '2/3:looking',
        '2/3:mailbox',
        '3/3:looking',
        '3/3:mailbox',
    ]);
});

test('batch: a reader that dies on the FIRST book is not re-tried on the rest', async () => {
    // The probe said awake, so book 1 legitimately tried direct and stalled. The
    // failure is a stronger observation than the probe, and without recording it
    // books 2 and 3 would each pay the same ~15-25 s again.
    const device = fakeBookDevice({ failWith: 'WebSocket connection failed' });
    const probes = fakeProbe({ success: true });
    const fetches = fakeFetch((url, init, n) => reply(200, { ok: true, id: `bk-${n}` }));
    fakeReader();

    const picks = [
        pick({ name: 'Book1.epub', uri: 'file:///cache/1.epub' }),
        pick({ name: 'Book2.epub', uri: 'file:///cache/2.epub' }),
        pick({ name: 'Book3.epub', uri: 'file:///cache/3.epub' }),
    ];

    const result = await sendEpubsRouted(destination(), picks, {});

    assert.equal(result.succeeded, 3, JSON.stringify(result.failed));
    assert.deepEqual(result.outcomes.map(o => o.route), ['mailbox', 'mailbox', 'mailbox']);
    assert.equal(probes.length, 1);
    assert.equal(device.uploads.length, 1, 'only the first book may hit the dead reader');
    assert.equal(fetches.length, 3);
});
